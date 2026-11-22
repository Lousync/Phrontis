/**
 * AI 教学 · 右缘轮次导航的纯逻辑（零依赖，脚本可直接 import 跑）。
 *
 * 为什么要单独成文件：轮次抽取 / 采样 / 当前轮判定全是没有 DOM 的算术，但错起来全是
 * **静默**的 —— 采样重复会让收起态少露一条、贴底不特判会让最后一轮永远当不上「当前」。
 * 契约脚本 `.AGENT/scripts/ai-teaching/verify-turn-rail.mjs` 直接 import 真实实现跑用例。
 *
 * 方案：`tmp/ai-teach-anchor-rail/PLAN.md`（§三 / §四 / §七）。
 */

/** 一轮 = 一条用户提问（`idx` 是它在 messages 里的下标，`no` 从 1 起） */
export interface TurnItem {
  idx: number
  no: number
  title: string
  time: string
}

/** 收起态最多露几条短横（约 108px 高；它是「进度暗示 + 入口」，不是索引） */
export const DASH_MAX = 11
/** 当前轮判定阈值：滚过这条消息顶部 90px 就算「到了这一轮」（沿用旧口径） */
export const ACTIVE_THRESHOLD = 90
/** 贴底容差：滚到距底 4px 内强制算最后一轮 */
export const BOTTOM_EPS = 4

/**
 * 轮次标题 = 用户提问的**首个非空行**，剥掉行首 markdown 记号后截 40 字。
 * 只发图片（没有文字可截）退「第 N 轮（图片）」—— 行照常在，标题不空。
 */
export function turnTitle(content: string, no: number): string {
  const line = String(content ?? '').split('\n').map(s => s.trim()).find(Boolean)
  if (!line) return `第 ${no} 轮（图片）`
  const text = line.replace(/^[#>*\-\s]+/, '')
  // 整行只有图片语法（粘贴图片时模型侧可能收到 `![](rel)`）也算「没有文字」
  if (!text || /^!\[[^\]]*\]\([^)]*\)$/.test(text)) return `第 ${no} 轮（图片）`
  return text.slice(0, 40)
}

/**
 * 收起态短横对应的轮次下标：`k = min(n, 11)`，第 i 条取 `round(i * (n-1) / (k-1))`。
 * 保证：长度 ≤ 11、严格递增、首 0 尾 n-1、无重复。
 */
export function dashIndexes(n: number): number[] {
  if (!Number.isFinite(n) || n <= 0) return []
  const total = Math.floor(n)
  const k = Math.min(total, DASH_MAX)
  if (k <= 1) return [0]
  const out: number[] = []
  for (let i = 0; i < k; i++) out.push(Math.round((i * (total - 1)) / (k - 1)))
  return out
}

/** 当前轮落在哪条短横上（离它最近的那条；同距取靠前的一条，结果唯一） */
export function dashActiveIndex(dashes: number[], active: number): number {
  if (dashes.length === 0) return -1
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < dashes.length; i++) {
    const d = Math.abs(dashes[i] - active)
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

/** 下标夹在 `[0, n-1]`（消息被删 / 重发后旧下标可能越界，方案 §九） */
export function clampTurn(i: number, n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0
  if (!Number.isFinite(i)) return 0
  return Math.min(Math.floor(n) - 1, Math.max(0, Math.floor(i)))
}

/**
 * 当前轮判定：`tops` 是各轮用户消息的 `offsetTop`（升序），阈值 `scrollTop + threshold`。
 *
 * ★ 贴底特判不是优化而是**正确性**：最后一轮永远滚不到顶部（它上面的内容不够一屏），
 *   只按阈值会永远停在倒数第二轮 —— 原型复现过。
 */
export function pickTurn(tops: number[], scrollTop: number, threshold: number, maxScroll: number): number {
  const n = tops.length
  if (n === 0) return 0
  const top = Number.isFinite(scrollTop) ? scrollTop : 0
  if (maxScroll > BOTTOM_EPS && top >= maxScroll - BOTTOM_EPS) return n - 1
  const limit = top + (Number.isFinite(threshold) ? threshold : ACTIVE_THRESHOLD)
  let lo = 0
  let hi = n - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (tops[mid] <= limit) { ans = mid; lo = mid + 1 } else { hi = mid - 1 }
  }
  return ans
}

/**
 * 键盘选择：方向键只移选择不跳转（避免连按狂滚），返回新下标；
 * 不是导航键返回 `null`（调用方据此决定要不要 preventDefault）。
 */
export function moveSelection(sel: number, key: string, n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null
  let next: number
  switch (key) {
    case 'ArrowDown': next = sel + 1; break
    case 'ArrowUp': next = sel - 1; break
    case 'PageDown': next = sel + 5; break
    case 'PageUp': next = sel - 5; break
    case 'Home': next = 0; break
    case 'End': next = n - 1; break
    default: return null
  }
  return clampTurn(next, n)
}
