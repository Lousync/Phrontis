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
