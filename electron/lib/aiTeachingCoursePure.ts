/**
 * AI教学·课程模式 —— 纯函数与类型（**零依赖，专为让契约脚本 import**）
 *
 * 主进程实现（含 fs / electron / IPC）在 `aiTeachingCourse.ts`，从本文件 import 这些纯函数后复用。
 * 契约脚本 `.AGENT/scripts/ai-teaching/verify-course-mode.mjs` 直接 strip-types 后 import 本文件做用例表。
 */

export type CourseUnitStatus = 'todo' | 'learning' | 'check' | 'mastered' | 'review'

export interface CourseUnit {
  id: string
  name: string
  goal: string
  source: string
}

export interface CourseChapter {
  id: string
  name: string
  units: CourseUnit[]
}

export interface CourseOutline {
  title: string
  goal: string
  anchor: string
  chapters: CourseChapter[]
}

export interface CourseUnitProgress {
  status: CourseUnitStatus
  mastery: number
  lastCheckedAt: string | null
  /** 知识点是否已收尾（课时全结束 + 出过总结篇） */
  finished?: boolean
  /** 总结篇仓库相对路径（收尾后写入；未收尾为 null/缺省） */
  summaryRel?: string | null
}

/**
 * 交接文档标题闸门：AI 只能通过「收尾本段」生成交接，整理归档不得创建交接页。
 * 归一化去掉空白与分隔符，兼容「交接.md」「生成交接」「hand-off」等写法。
 */
export function isHandoffTitle(title: unknown): boolean {
  const s = String(title ?? '').replace(/[\s._-]+/g, '').toLowerCase()
  return s.includes('交接') || s.includes('handoff')
}

/** 收尾幂等：优先复用 handoffRel，缺失时回退标准 `{段目录}/交接.md`。 */
export function pickReusableHandoff(
  handoffRel: string | null | undefined,
  standardRel: string | null | undefined,
  exists: (rel: string) => boolean,
): string | null {
  for (const rel of [handoffRel, standardRel]) {
    if (rel && exists(rel)) return rel
  }
  return null
}

/** 字段清洗：去换行、把 `|` 换成全角，避免破坏行格式 */
export function cleanField(v: unknown): string {
  return String(v ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '／').trim()
}

/** 解析 `课程.md` → CourseOutline（宽容：缺字段回退空串） */
export function parseCourseMd(text: string): CourseOutline {
  const out: CourseOutline = { title: '', goal: '', anchor: '', chapters: [] }
  let cur: CourseChapter | null = null
  for (const raw of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const title = /^#\s*课程\s*[：:]\s*(.+)$/.exec(line)
    if (title) { out.title = title[1].trim(); continue }
    const goal = /^[-*]?\s*目标\s*[：:]\s*(.+)$/.exec(line)
    if (goal) { out.goal = goal[1].trim(); continue }
    const anchor = /^[-*]?\s*依据\s*[：:]\s*(.+)$/.exec(line)
    if (anchor) { out.anchor = anchor[1].trim(); continue }
    // 章行：`## 章名`（旧）或 `## [c3] 章名`（3.14 起稳定章 ID）
    const ch = /^#{2,6}\s+(?:\[([A-Za-z0-9_-]+)\]\s*)?(.+)$/.exec(line)
    if (ch) {
      const id = (ch[1] ?? '').trim() || `c${out.chapters.length + 1}`
      cur = { id, name: (ch[2] ?? '').trim(), units: [] }
      out.chapters.push(cur)
      continue
    }
    const unit = /^[-*]\s*(.+)$/.exec(line)
    if (unit && cur) {
      const parts = unit[1].split('|').map((s) => s.trim())
      if (parts.length >= 2 && parts[0]) {
        cur.units.push({ id: parts[0], name: parts[1] || parts[0], goal: parts[2] ?? '', source: parts[3] ?? '' })
      }
    }
  }
  return out
}

/** 重写 `课程.md`（大纲唯一写入口径） */
export function rewriteCourseMd(o: CourseOutline): string {
  const lines: string[] = [`# 课程：${cleanField(o.title) || '未命名课程'}`]
  if (o.goal) lines.push(`- 目标: ${cleanField(o.goal)}`)
  if (o.anchor) lines.push(`- 依据: ${cleanField(o.anchor)}`)
  lines.push('')
  o.chapters.forEach((c, ci) => {
    const cid = cleanField(c.id) || `c${ci + 1}`
    lines.push(`## [${cid}] ${cleanField(c.name) || `第${ci + 1}章`}`)
    c.units.forEach((u) => {
      lines.push(`- ${cleanField(u.id)} | ${cleanField(u.name)} | ${cleanField(u.goal)} | ${cleanField(u.source)}`)
    })
    lines.push('')
  })
  return lines.join('\n')
}

/** 扫描文本里所有**配对平衡**的顶层 `{...}` 片段（跳过字符串内的大括号）。
 *  思考型模型常先输出推理文本（含零散 `{}`）再给答案，用配对扫描而非「首个 { 到末个 }」才不会跨段截断。 */
export function balancedJsonObjects(text: string): string[] {
  const s = String(text ?? '')
  const out: string[] = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') { if (depth === 0) start = i; depth += 1; continue }
    if (ch === '}') { if (depth > 0) { depth -= 1; if (depth === 0 && start >= 0) { out.push(s.slice(start, i + 1)); start = -1 } } }
  }
  return out
}

/** 把候选对象归一化成 CourseOutline（非大纲形状返回 null） */
export function normalizeOutline(raw: unknown): CourseOutline | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as { title?: unknown; goal?: unknown; anchor?: unknown; chapters?: unknown }
  // 有些模型直接给章数组（无外层对象）：把对象自身或数组都当章列表来源
  const chaptersSrc = Array.isArray(o.chapters) ? o.chapters : Array.isArray(raw) ? (raw as unknown[]) : []
  if (!chaptersSrc.length) return null
  const chapters: CourseChapter[] = []
  let n = 0
  chaptersSrc.forEach((c, ci) => {
    const cObj = (c ?? {}) as { name?: unknown; units?: unknown }
    const unitsRaw = Array.isArray(cObj.units) ? cObj.units : []
    const units: CourseUnit[] = []
    unitsRaw.forEach((u) => {
      const uObj = (u ?? {}) as { name?: unknown; goal?: unknown; source?: unknown }
      const name = String(uObj?.name ?? '').trim()
      if (!name) return
      n += 1
      units.push({ id: `u${n}`, name, goal: String(uObj?.goal ?? '').trim(), source: String(uObj?.source ?? '').trim() })
    })
    if (units.length) chapters.push({ id: `c${ci + 1}`, name: String(cObj?.name ?? `第${ci + 1}章`).trim(), units })
  })
  if (!chapters.length) return null
  return {
    title: String(o.title ?? '').trim(),
    goal: String(o.goal ?? '').trim(),
    anchor: String(o.anchor ?? '').trim(),
    chapters,
  }
}

/** 从模型返回文本中抽 JSON 大纲：优先 ```json 围栏 → 全文；候选对象**从后往前**试（思考型模型答案在后） */
export function parseOutlineJson(text: string): CourseOutline | null {
  const s = String(text ?? '')
  const bodies: string[] = []
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(s))) bodies.push(m[1])
  bodies.push(s)
  for (const body of bodies) {
    const cands = balancedJsonObjects(body)
    for (let i = cands.length - 1; i >= 0; i--) {
      try {
        const outline = normalizeOutline(JSON.parse(cands[i]))
        if (outline) return outline
      } catch { /* 该候选不是合法 JSON，试下一个 */ }
    }
  }
  return null
}

// ===== 课程增补（只增补）：SOURCE 快照 + 增补合并（纯函数，2026-10-08）=====

export interface SourceSnapshotEntry { key: string; no: number; name: string; path: string; extracted: string }

/** 快照匹配键：name + path（重编号不影响） */
export function sourceKey(name: unknown, path: unknown): string {
  return `${String(name ?? '').trim()}\u0000${String(path ?? '').trim()}`
}

/** 由当前 SOURCE 条目生成快照（写大纲时存一份）。
 *  ★ 当前**只写不读**：唯一读者是 2026-10-11 删除的「修订大纲」抽屉；保留这份快照是为了
 *  将来做「素材变更提醒」时不必重建。 */
export function sourceSnapshot(entries: ReadonlyArray<{ no: number; name: string; path: string; extracted: string }>): SourceSnapshotEntry[] {
  return (entries ?? []).map((e) => ({
    key: sourceKey(e.name, e.path),
    no: Number(e.no) || 0,
    name: String(e.name ?? ''),
    path: String(e.path ?? ''),
    extracted: String(e.extracted ?? ''),
  }))
}

export interface OutlineUnitAdd { chapterId?: string; chapterName?: string; name: string; goal?: string; source?: string; why?: string }
export interface OutlineChapterAdd { name: string; units: Array<{ name: string; goal?: string; source?: string; why?: string }> }
export interface OutlineAdditions { toExisting: OutlineUnitAdd[]; newChapters: OutlineChapterAdd[] }

/**
 * 只增补合并：**现有章节/知识点 id 一律保留**；新条目取递增 id；同名同章去重。
 * 定位不到的现有章（chapterId/chapterName 都对不上）→ 丢弃该项（不新建、不改动现有）。
 */
export function mergeOutlineAdditions(outline: CourseOutline, additions: OutlineAdditions): { outline: CourseOutline; added: number } {
  const chapters: CourseChapter[] = (outline?.chapters ?? []).map((c) => ({ ...c, units: c.units.map((u) => ({ ...u })) }))
  let maxUnit = 0
  let maxChap = 0
  chapters.forEach((c, ci) => {
    maxChap = Math.max(maxChap, parseInt(/\d+/.exec(c.id)?.[0] ?? String(ci + 1), 10) || ci + 1)
    c.units.forEach((u) => { maxUnit = Math.max(maxUnit, parseInt(/\d+/.exec(u.id)?.[0] ?? '0', 10) || 0) })
  })
  let added = 0
  const namesIn = (c: CourseChapter): Set<string> => new Set(c.units.map((u) => cleanField(u.name)))
  for (const a of additions?.toExisting ?? []) {
    if (!a?.name) continue
    let ch = a.chapterId ? chapters.find((c) => c.id === a.chapterId) : undefined
    if (!ch && a.chapterName) ch = chapters.find((c) => cleanField(c.name) === cleanField(a.chapterName))
    if (!ch) continue
    if (namesIn(ch).has(cleanField(a.name))) continue
    ch.units.push({ id: `u${++maxUnit}`, name: cleanField(a.name), goal: cleanField(a.goal ?? ''), source: cleanField(a.source ?? '') || 'AI 增补' })
    added += 1
  }
  for (const nc of additions?.newChapters ?? []) {
    if (!nc?.units?.length) continue
    const ch: CourseChapter = { id: `c${++maxChap}`, name: cleanField(nc.name), units: [] }
    for (const u of nc.units) {
      if (!cleanField(u.name) || namesIn(ch).has(cleanField(u.name))) continue
      ch.units.push({ id: `u${++maxUnit}`, name: cleanField(u.name), goal: cleanField(u.goal ?? ''), source: cleanField(u.source ?? '') || 'AI 增补' })
      added += 1
    }
    if (ch.units.length) chapters.push(ch)
  }
  return { outline: { ...outline, chapters }, added }
}

/**
 * 画布拖拽重排（纯）：把 `unitId` 移到 `targetChapterId` 的 `beforeUnitId` 之前；`beforeUnitId` 为空=追加到章末。
 * ★ 原位搬移，**id 与顺序以外的字段一律不动** —— progress.json 以 unit id 为键，重排不得重编号。
 * 不改动入参；失败时返回原 outline 引用。
 */
export function moveUnitInOutline(
  outline: CourseOutline,
  unitId: string,
  targetChapterId: string,
  beforeUnitId: string | null,
): { outline: CourseOutline; ok: boolean; error?: string } {
  const uid = String(unitId ?? '').trim()
  if (!uid) return { outline, ok: false, error: '缺少知识点' }
  const bid = beforeUnitId ? String(beforeUnitId) : ''
  if (bid && bid === uid) return { outline, ok: true } // 拖到自己前面 = 无操作
  const chapters: CourseChapter[] = (outline?.chapters ?? []).map((c) => ({ ...c, units: c.units.map((u) => ({ ...u })) }))
  let moved: CourseUnit | null = null
  for (const c of chapters) {
    const i = c.units.findIndex((u) => u.id === uid)
    if (i >= 0) { moved = c.units.splice(i, 1)[0]; break }
  }
  if (!moved) return { outline, ok: false, error: `找不到知识点「${uid}」` }
  const target = chapters.find((c) => c.id === String(targetChapterId ?? ''))
  if (!target) return { outline, ok: false, error: '目标章不存在' }
  const found = bid ? target.units.findIndex((u) => u.id === bid) : -1
  if (bid && found < 0) return { outline, ok: false, error: '目标位置不存在' }
  target.units.splice(found < 0 ? target.units.length : found, 0, moved)
  return { outline: { ...outline, chapters }, ok: true }
}

// ===== 3.14.0：段模型 + progress v1→v2 归一化（纯函数，契约脚本直接跑） =====

export interface CourseSegmentSourceV2 {
  sourceId: string
  label: string
  /** 预检收窄后的区间；具体形状由 aiTeachingSourcesPure.SourceAnchor 定义 */
  anchor: unknown
  mode: 'exact' | 'narrow' | 'fallback'
}

/** 段（历史键名 lessons 保留；语义 = 一段覆盖同章多个知识点） */
export interface CourseLessonInfoV2 {
  unitIds: string[]
  activeUnitId?: string
  /** 本章内的顺序（1..N） */
  order: number
  status: 'open' | 'ended'
  sources: CourseSegmentSourceV2[]
  handoffRel: string | null
  startedAt?: string
  endedAt?: string | null
}

export interface CourseUnitProgressV2 {
  status: CourseUnitStatus
  mastery: number
  lastCheckedAt: string | null
  finished?: boolean
  summaryRel?: string | null
}

export interface CourseReviewV2 {
  sessionId: string
  rel: string | null
}

export interface CourseWsV2 {
  lessons: Record<string, CourseLessonInfoV2>
  units: Record<string, CourseUnitProgressV2>
  reviews: Record<string, CourseReviewV2>
  assistantSessionId?: string
}

export interface ProgressFileV2 {
  v: 2
  workspaces: Record<string, CourseWsV2>
}

const V2_STATUSES: CourseUnitStatus[] = ['todo', 'learning', 'check', 'mastered', 'review']

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    const s = String(x ?? '').trim()
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

function normalizeLesson(raw: unknown, fallbackOrder: number): CourseLessonInfoV2 | null {
  if (!isRecord(raw)) return null
  const unitIds = asStringArray(raw.unitIds)
  if (!unitIds.length) {
    const single = String(raw.unitId ?? '').trim()
    if (single) unitIds.push(single)
  }
  if (!unitIds.length) return null
  const active = String(raw.activeUnitId ?? '').trim()
  const order = Number(raw.order)
  const status = raw.status === 'ended' ? 'ended' : 'open'
  const sources = Array.isArray(raw.sources) ? (raw.sources as CourseSegmentSourceV2[]) : []
  const handoffRel = typeof raw.handoffRel === 'string' && raw.handoffRel.trim() ? raw.handoffRel : null
  const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : undefined
  const endedAt = typeof raw.endedAt === 'string' ? raw.endedAt : null
  return {
    unitIds,
    activeUnitId: unitIds.includes(active) ? active : unitIds[0],
    order: Number.isFinite(order) && order > 0 ? Math.floor(order) : fallbackOrder,
    status,
    sources,
    handoffRel,
    ...(startedAt ? { startedAt } : {}),
    endedAt,
  }
}

function normalizeUnit(raw: unknown): CourseUnitProgressV2 {
  const o = isRecord(raw) ? raw : {}
  const status = V2_STATUSES.includes(o.status as CourseUnitStatus) ? (o.status as CourseUnitStatus) : 'todo'
  const masteryRaw = Number(o.mastery)
  const mastery = Number.isFinite(masteryRaw) ? Math.max(0, Math.min(1, masteryRaw)) : 0
  const lastCheckedAt = typeof o.lastCheckedAt === 'string' ? o.lastCheckedAt : null
  const out: CourseUnitProgressV2 = { status, mastery, lastCheckedAt }
  if (typeof o.finished === 'boolean') out.finished = o.finished
  if (typeof o.summaryRel === 'string' || o.summaryRel === null) out.summaryRel = o.summaryRel
  return out
}

/**
 * progress.json v1 → v2 归一化。
 *
 * - 只加字段 / 搬字段，不删知识点与段；
 * - `unitId` → `unitIds:[unitId]`，`kind` 丢弃；
 * - 旧 `sessions`（sessionId→unitId）并入 lessons；
 * - 段里没有 `sources` 的补空数组（旧课时没有段级快照）；
 * - `finished` 缺省时按「有已结束段覆盖」或「mastered/review 且不在 open 段」补；
 * - `enabled` / `sourceBaseline` 丢弃；
 * - 幂等：v2 输入再跑一次结果不变。
 */
export function normalizeProgressFile(raw: unknown): { file: ProgressFileV2; migrated: boolean } {
  const src = isRecord(raw) ? raw : {}
  let migrated = src.v !== 2
  const workspacesRaw = isRecord(src.workspaces) ? src.workspaces : {}
  const workspaces: Record<string, CourseWsV2> = {}
  for (const [wsId, wsRaw] of Object.entries(workspacesRaw)) {
    const w = isRecord(wsRaw) ? wsRaw : {}
    if (w.enabled !== undefined || w.sourceBaseline !== undefined || w.sessions !== undefined) migrated = true

    const lessons: Record<string, CourseLessonInfoV2> = {}
    const lessonsRaw = isRecord(w.lessons) ? w.lessons : {}
    for (const [sid, lRaw] of Object.entries(lessonsRaw)) {
      const l = normalizeLesson(lRaw, Object.keys(lessons).length + 1)
      if (!l) continue
      if (isRecord(lRaw) && (lRaw.unitId !== undefined || lRaw.kind !== undefined)) migrated = true
      lessons[sid] = l
    }
    // 旧 sessions 只在 lessons 缺该会话时补；order 按知识点内出现次序
    if (isRecord(w.sessions)) {
      const perUnit: Record<string, number> = {}
      for (const [sid, uidRaw] of Object.entries(w.sessions)) {
        const uid = String(uidRaw ?? '').trim()
        if (!uid || lessons[sid]) continue
        const n = (perUnit[uid] = (perUnit[uid] ?? 0) + 1)
        lessons[sid] = {
          unitIds: [uid],
          activeUnitId: uid,
          order: n,
          status: 'open',
          sources: [],
          handoffRel: null,
          endedAt: null,
        }
        migrated = true
      }
    }

    const units: Record<string, CourseUnitProgressV2> = {}
    const unitsRaw = isRecord(w.units) ? w.units : {}
    for (const [uid, uRaw] of Object.entries(unitsRaw)) {
      units[uid] = normalizeUnit(uRaw)
    }
    for (const [uid, u] of Object.entries(units)) {
      if (typeof u.finished === 'boolean') continue
      const inOpen = Object.values(lessons).some((l) => l.status === 'open' && l.unitIds.includes(uid))
      const inEnded = Object.values(lessons).some((l) => l.status === 'ended' && l.unitIds.includes(uid))
      if (!inOpen && (u.status === 'mastered' || u.status === 'review' || inEnded)) u.finished = true
    }

    const reviews: Record<string, CourseReviewV2> = {}
    if (isRecord(w.reviews)) {
      for (const [cid, rRaw] of Object.entries(w.reviews)) {
        if (!isRecord(rRaw)) continue
        const sessionId = String(rRaw.sessionId ?? '').trim()
        if (!sessionId) continue
        reviews[cid] = { sessionId, rel: typeof rRaw.rel === 'string' ? rRaw.rel : null }
      }
    }

    const assistantSessionId = String(w.assistantSessionId ?? '').trim()
    workspaces[wsId] = {
      lessons,
      units,
      reviews,
      ...(assistantSessionId ? { assistantSessionId } : {}),
    }
  }
  return { file: { v: 2, workspaces }, migrated }
}
