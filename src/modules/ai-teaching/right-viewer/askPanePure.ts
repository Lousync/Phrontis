/**
 * 旁问页签 · 纯函数层（零运行时依赖，仅可 `import type`）
 *
 * 方案：`docs/ai-teaching-right-viewer-plan.md` §6.4；内核文档 C8 / C10 / C11。
 *
 * 为什么单独一层：徽标 / 摘要 / 检索 / 排序 / 请求解析都是「静默错」高发区
 * （旧数据没有 `anchorOrdinal` 时最容易随手编一个序号），必须能被契约脚本
 * `.AGENT/scripts/ai-teaching/verify-ask-pane.mjs` 直接跑真实实现。
 */

/** 列表徽标：`整段` / `第 N 条` / `选区` */
export interface LaneBadge {
  label: string
  tone: 'conversation' | 'anchor' | 'selection'
}

type LaneScopeShape = {
  sideScope?: string
  anchorOrdinal?: number
}

/** 合法序号：正整数；非法 / 缺省一律 null（不猜） */
function ordinalOf(v?: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : null
}

/** 摘要压成单行（用于头部来源句的退化分支） */
function oneLine(s?: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 列表徽标。
 * C11 口径：旧支线一律按 `anchor` 读；**没有 `anchorOrdinal` 就只说「锚定」**，
 * 绝不猜「第几条」（猜错会把用户带到另一条回答上）。
 */
export function laneBadge(lane: LaneScopeShape): LaneBadge {
  if (lane.sideScope === 'conversation') return { label: '整段', tone: 'conversation' }
  if (lane.sideScope === 'selection') return { label: '选区', tone: 'selection' }
  const n = ordinalOf(lane.anchorOrdinal)
  return n === null
    ? { label: '锚定', tone: 'anchor' }
    : { label: `第 ${n} 条`, tone: 'anchor' }
}

/**
 * 详情头第一行（来源句）：
 *   · 整段 → `已读整段对话`
 *   · 有序号 → `锚定：第 N 条回答`
 *   · 旧数据无序号 → `锚定：一条回答`（不编序号）
 *   · 未来未知 scope → 退回首行摘要（有摘要时），仍标明「锚定」
 */
export function laneSubtitle(lane: LaneScopeShape & { excerpt?: string }): string {
  if (lane.sideScope === 'conversation') return '已读整段对话'
  if (lane.sideScope === 'selection') return '锚定：选区'
  const n = ordinalOf(lane.anchorOrdinal)
  if (n !== null) return `锚定：第 ${n} 条回答`
  if (lane.sideScope && lane.sideScope !== 'anchor') {
    const ex = oneLine(lane.excerpt)
    if (!ex) return '锚定'
    return `锚定 · ${ex.length > 28 ? `${ex.slice(0, 28)}…` : ex}`
  }
  return '锚定：一条回答'
}

/** 列表检索：标题 / 摘要 / 来源回答标题；空查询保序且不改入参 */
export function filterLanes<T extends { title?: string; excerpt?: string; anchorTitle?: string }>(
  lanes: T[],
  query: string,
): T[] {
  const list = Array.isArray(lanes) ? lanes : []
  const q = (query ?? '').trim().toLowerCase()
  if (!q) return list.slice()
  return list.filter((l) =>
    `${l.title ?? ''}\n${l.anchorTitle ?? ''}\n${l.excerpt ?? ''}`.toLowerCase().includes(q),
  )
}

/**
 * 列表排序：未读优先 → 最近一条 AI 回答（退化到 updated_at）→ 原顺序。
 * 缺时间（解析失败 / 未回答）排最后；显式带下标做 tiebreak，稳定可复现。
 * 不修改入参。
 */
export function sortLanes<T extends { lastAssistantAt?: string; updated_at?: string }>(
  lanes: T[],
): T[] {
  const list = Array.isArray(lanes) ? lanes : []
  const ms = (s?: string): number => {
    if (!s) return 0
    const t = Date.parse(s)
    return Number.isFinite(t) ? t : 0
  }
  const recency = (l: T): number => Math.max(ms(l.lastAssistantAt), ms(l.updated_at))
  const unread = (l: T): number => ((l as T & { unread?: boolean }).unread === true ? 1 : 0)
  return list
    .map((lane, i) => ({ lane, i, u: unread(lane), t: recency(lane) }))
    .sort((a, b) => b.u - a.u || b.t - a.t || a.i - b.i)
    .map((x) => x.lane)
}

/**
 * 宽松解析壳转发来的旁问请求（`PaneOpenRequest` 之外，锚点 chip 还可能是字符串）。
 * 解析不出来返回 null —— 调用方只切页签，不猜语义。
 */
export function scopeFromRequest(raw: unknown): { kind: string } | null {
  if (typeof raw === 'string') {
    const kind = raw.trim().toLowerCase()
    return kind ? { kind } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const kind = (raw as { kind?: unknown }).kind
  if (typeof kind !== 'string') return null
  const k = kind.trim().toLowerCase()
  return k ? { kind: k } : null
}

/** 该旁问当前能否「引用到主线」：run 中回答还在成形，引用会把半截话塞进主线 */
export function canQuoteFromLane(lane: { laneStatus?: string }): boolean {
  return lane.laneStatus !== 'run'
}
