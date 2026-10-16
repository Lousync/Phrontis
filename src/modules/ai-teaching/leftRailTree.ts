/**
 * AI教学左栏「会话」区 → 课程三层树（章 → 知识点 → 课时）。
 * 方案：`.AGENT/.claude/plans/ai-teaching-scope-layers-v390.md`（§十 R7）。
 *
 * **零 import 纯函数**——契约脚本 `.AGENT/scripts/ai-teaching/verify-left-rail-tree.mjs` 直接 import。
 *
 * 口径（2026-10-16 拍板）：
 *   · 会话翻译成课时：`lessons` 的 **key 就是 sessionId**（见 index.tsx 反查课时、aiTeachingCourse.openUnit）。
 *   · 只列**有会话**的知识点——左栏是会话导航，不是知识点清单；全量知识点在画布上。
 *   · 章末复习课排在所属章的课时之后；课程助手单独一行；其余归「零散对话」。
 *   · 已升格支线（`promoted`：lane==='main' 且带 parentSessionId）跟随父行缩进，归到父行所在的组。
 *   · 归属信息指向已消失的知识点 / 章（大纲改过）→ 不报错，退回「零散对话」。
 */

export interface RailSession {
  id: string
  title: string
}

export interface RailLesson {
  unitId: string
  order?: number
  kind?: string
}

export interface RailOutline {
  chapters: Array<{ id: string; name: string; units: Array<{ id: string; name: string }> }>
}

export interface RailReview {
  sessionId?: string | null
}

export interface RailRow {
  s: RailSession
  /** true = 已升格支线（缩进 + 「支线」徽章） */
  child: boolean
  /** 行首标签（`课时3` / `复习课` / `课程助手`）；零散对话无 */
  label?: string
  /** 悬停说明 */
  hint?: string
}

export interface RailUnitGroup {
  unitId: string
  name: string
  rows: RailRow[]
}

export interface RailChapterGroup {
  chapterId: string
  name: string
  units: RailUnitGroup[]
  /** 章末复习课会话（含其支线），无则 null */
  review: RailRow[] | null
  /** 本章挂到的会话数（含支线） */
  count: number
}

export interface RailTree {
  /** 课程助手（教学助手）会话 */
  assistant: RailRow | null
  chapters: RailChapterGroup[]
  /** 零散对话：不属于任何课时 / 复习课 / 课程助手的会话 */
  loose: RailRow[]
  /** 落到树里的顶层会话数（不含支线） */
  placed: number
}

export interface RailTreeInput {
  outline?: RailOutline | null
  lessons?: Record<string, RailLesson> | null
  reviews?: Record<string, RailReview> | null
  /** 当前工作区可见的会话（已剔除 lane==='side' 的旁问） */
  sessions: RailSession[]
  /** 已升格支线：parentSessionId → children（由主场景从全量 sessions 构建） */
  promoted?: Record<string, RailSession[]> | null
  /** 课程助手会话 id（可缺省；缺省则该会话落「零散对话」） */
  assistantSessionId?: string | null
}

export function buildRailTree(input: RailTreeInput): RailTree {
  const ls = input.lessons ?? {}
  const rv = input.reviews ?? {}
  const pr = input.promoted ?? {}
  const byId = new Map<string, RailSession>()
  for (const s of input.sessions) byId.set(s.id, s)

  const unitOf = new Map<string, string>()
  const orderOf = new Map<string, number>()
  const kindOf = new Map<string, string>()
  for (const [sid, l] of Object.entries(ls)) {
    if (!l || typeof l.unitId !== 'string' || !l.unitId) continue
    unitOf.set(sid, l.unitId)
    orderOf.set(sid, typeof l.order === 'number' && Number.isFinite(l.order) ? l.order : 0)
    if (typeof l.kind === 'string') kindOf.set(sid, l.kind)
  }
  const reviewOf = new Map<string, string>()
  for (const [cid, r] of Object.entries(rv)) {
    const sid = r?.sessionId
    if (typeof sid === 'string' && sid) reviewOf.set(sid, cid)
  }

  const used = new Set<string>()
  /** 会话行 + 紧跟其后的已升格支线 */
  const wrap = (s: RailSession, tag?: { label?: string; hint?: string }): RailRow[] => {
    const rows: RailRow[] = [{ s, child: false, ...tag }]
    for (const c of pr[s.id] ?? []) rows.push({ s: c, child: true })
    return rows
  }

  let assistant: RailRow | null = null
  const aid = input.assistantSessionId
  if (aid && byId.has(aid) && !reviewOf.has(aid) && !unitOf.has(aid)) {
    used.add(aid)
    assistant = wrap(byId.get(aid)!, { label: '课程助手', hint: '课程助手：建课 / 改大纲 / 整门课的调整' })[0]
  }

  const chapters: RailChapterGroup[] = []
  for (const c of input.outline?.chapters ?? []) {
    const units: RailUnitGroup[] = []
    const rows: RailRow[] = []
    for (const u of c.units ?? []) {
      const mine = Object.keys(ls).filter((sid) => unitOf.get(sid) === u.id && byId.has(sid))
      if (!mine.length) continue
      mine.sort((a, b) => (orderOf.get(a) ?? 0) - (orderOf.get(b) ?? 0) || a.localeCompare(b))
      const unitRows: RailRow[] = []
      for (const sid of mine) {
        const s = byId.get(sid)
        if (!s) continue
        used.add(sid)
        const n = orderOf.get(sid) ?? 0
        const k = kindOf.get(sid)
        unitRows.push(...wrap(s, { label: `课时${n}`, hint: k ? `课时 ${n} · ${k}` : `课时 ${n}` }))
      }
      units.push({ unitId: u.id, name: u.name, rows: unitRows })
      rows.push(...unitRows)
    }
    let review: RailRow[] | null = null
    for (const [sid, cid] of reviewOf) {
      if (cid !== c.id) continue
      const s = byId.get(sid)
      if (!s) continue
      used.add(sid)
      review = wrap(s, { label: '复习课', hint: '章末复习课：和课程助手讨论本章复习' })
      rows.push(...review)
    }
    if (!rows.length) continue
    chapters.push({ chapterId: c.id, name: c.name, units, review, count: rows.length })
  }

  const loose: RailRow[] = []
  /** 已升格支线 = 出现在某个父行的 children 里 → 不单独成行（由父行带出） */
  const childIds = new Set<string>()
  for (const arr of Object.values(pr)) for (const c of arr) childIds.add(c.id)
  for (const s of input.sessions) {
    if (used.has(s.id) || childIds.has(s.id)) continue
    used.add(s.id)
    loose.push(...wrap(s))
  }

  return { assistant, chapters, loose, placed: used.size }
}
