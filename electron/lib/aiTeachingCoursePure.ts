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

export interface GenerateOutlineInput {
  goal: string
  mode: 'anchor' | 'materials' | 'mixed' | 'free'
  anchorText?: string
  anchorLabel?: string
  /** 当前工作区 id（materials/mixed 模式据此读取已登记素材） */
  wsId?: string
  /** 勾选的登记素材键（`sourceKey(name,path)`）；缺省 = 全部已登记素材 */
  sourceKeys?: string[]
  /** 'providerId:modelId'；缺省 = 主进程 defaultChatModel */
  modelSpec?: string
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
    const ch = /^#{2,6}\s+(.+)$/.exec(line)
    if (ch) { cur = { id: `c${out.chapters.length + 1}`, name: ch[1].trim(), units: [] }; out.chapters.push(cur); continue }
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
    lines.push(`## ${cleanField(c.name) || `第${ci + 1}章`}`)
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

// ===== 课程修订（只增补）：SOURCE 快照 diff + 增补合并（纯函数，2026-10-08）=====

export interface SourceSnapshotEntry { key: string; no: number; name: string; path: string; extracted: string }

/** 快照匹配键：name + path（重编号不影响） */
export function sourceKey(name: unknown, path: unknown): string {
  return `${String(name ?? '').trim()}\u0000${String(path ?? '').trim()}`
}

/** 由当前 SOURCE 条目生成快照（写大纲时存一份，供下次比对） */
export function sourceSnapshot(entries: ReadonlyArray<{ no: number; name: string; path: string; extracted: string }>): SourceSnapshotEntry[] {
  return (entries ?? []).map((e) => ({
    key: sourceKey(e.name, e.path),
    no: Number(e.no) || 0,
    name: String(e.name ?? ''),
    path: String(e.path ?? ''),
    extracted: String(e.extracted ?? ''),
  }))
}

/** 当前条目 vs 快照：键不存在=新增；extracted 变=已更新；否则 null */
export function diffSources<T extends { no: number; name: string; path: string; extracted: string }>(
  baseline: ReadonlyArray<SourceSnapshotEntry>, current: ReadonlyArray<T>,
): Array<T & { change: 'new' | 'updated' | null }> {
  const base = new Map((baseline ?? []).map((b) => [b.key, b]))
  return (current ?? []).map((e) => {
    const b = base.get(sourceKey(e.name, e.path))
    const change: 'new' | 'updated' | null = !b ? 'new' : (b.extracted !== String(e.extracted ?? '') ? 'updated' : null)
    return { ...e, change }
  })
}

export interface OutlineUnitAdd { chapterId?: string; chapterName?: string; name: string; goal?: string; source?: string; why?: string }
export interface OutlineChapterAdd { name: string; units: Array<{ name: string; goal?: string; source?: string; why?: string }> }
export interface OutlineAdditions { toExisting: OutlineUnitAdd[]; newChapters: OutlineChapterAdd[] }

function s(v: unknown): string { return String(v ?? '').trim() }

function coerceAdditions(obj: unknown): OutlineAdditions | null {
  if (!obj || typeof obj !== 'object') return null
  const o = obj as { toExisting?: unknown; newChapters?: unknown }
  // ★ 形状判定（2026-10-09 修）：只要出现 toExisting / newChapters 任一**数组**键，即视为「增补响应」；
  //   两个数组都为空（模型对「无需增补 / 只想删除」的正确回答）也是合法结果，交上层提示「无增补」。
  //   二者都不是数组（任意 JSON、非增补对象）才判为不可解析 → null。
  if (!Array.isArray(o.toExisting) && !Array.isArray(o.newChapters)) return null
  const toExisting: OutlineUnitAdd[] = []
  if (Array.isArray(o.toExisting)) {
    for (const it of o.toExisting) {
      const u = (it ?? {}) as Record<string, unknown>
      const name = s(u.name)
      if (!name) continue
      toExisting.push({
        chapterId: s(u.chapterId) || undefined,
        chapterName: s(u.chapterName ?? u.chapter) || undefined,
        name, goal: s(u.goal) || undefined, source: s(u.source) || undefined, why: s(u.why) || undefined,
      })
    }
  }
  const newChapters: OutlineChapterAdd[] = []
  if (Array.isArray(o.newChapters)) {
    for (const ch of o.newChapters) {
      const c = (ch ?? {}) as { name?: unknown; units?: unknown }
      const cname = s(c.name)
      const units: OutlineChapterAdd['units'] = []
      if (Array.isArray(c.units)) {
        for (const it of c.units) {
          const u = (it ?? {}) as Record<string, unknown>
          const name = s(u.name)
          if (!name) continue
          units.push({ name, goal: s(u.goal) || undefined, source: s(u.source) || undefined, why: s(u.why) || undefined })
        }
      }
      if (cname && units.length) newChapters.push({ name: cname, units })
    }
  }
  return { toExisting, newChapters }
}

/** 从模型返回抽「增补」JSON（```json 围栏 → 全文；配对扫描 + 从后往前取） */
export function normalizeAdditions(rawText: string): OutlineAdditions | null {
  const text = String(rawText ?? '')
  const bodies: string[] = []
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(text))) bodies.push(m[1])
  bodies.push(text)
  for (const body of bodies) {
    const cands = balancedJsonObjects(body)
    for (let i = cands.length - 1; i >= 0; i--) {
      let obj: unknown
      try { obj = JSON.parse(cands[i]) } catch { continue }
      const out = coerceAdditions(obj)
      if (out) return out
    }
  }
  return null
}

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
