/**
 * Agent 上下文预算（上下文装配管线第一期）—— 纯函数，node 冒烟可跑。
 *
 * 现状：历史只有条数硬上限（slice(-40)），没有 token 维度——40 条长消息仍会把
 * system + 工具 schema 一起撑爆，且费用随会话长度线性上涨。
 *
 * 本模块按「轮次」裁剪（一条 user 消息开一轮，assistant 跟随其后——历史上没有
 * 独立 tool 消息，工具链只存在于单轮 assistant 正文里，轮边界即安全断点）：
 *   - 从最近一轮往回收，预算内尽量多保留（时间线连续，不跳轮）；
 *   - 最后一轮无条件保留（本轮用户消息必须在场）；
 *   - 首轮（开场上下文）放不下时单独争取：仍超预算则放弃。
 */

/** token 估算：≈2.6 字符/token（中英混合经验值，对齐 AI 教学「构成摘要」的折算口径） */
export const CHARS_PER_TOKEN = 2.6

export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export interface BudgetTrimResult<T> {
  kept: T[]
  /** 裁掉的轮数 */
  droppedTurns: number
  /** 裁剪前轮数 */
  totalTurns: number
  /** 保留内容的估算 token（不含 system/tools——调用方自行预留） */
  estimatedTokens: number
}

export interface BudgetMessage {
  role: 'user' | 'assistant'
  /** 纯文本，或 OpenAI 多模态内容数组（图片按固定值粗估） */
  content?: string | unknown[]
}

/** 多模态内容的 token 估算：文本按字折算，图片按固定值（避免每轮把图片正文当真文本算） */
export function estimateContentTokens(content?: string | unknown[]): number {
  if (typeof content === 'string') return estimateTokens(content)
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const part = raw as Record<string, unknown>
    if (part.type === 'text') n += estimateTokens(String(part.text ?? ''))
    else if (part.type === 'image_url') n += 1200
  }
  return n
}

/**
 * 按 token 预算裁剪历史。budgetTokens ≤ 0 = 关闭预算（原样返回，仅统计）。
 */
export function trimHistoryByBudget<T extends BudgetMessage>(
  history: T[],
  budgetTokens: number,
): BudgetTrimResult<T> {
  // 轮次切分：user 开新轮，其余消息归入当前轮（空历史/无 user 开头的头段也各成轮）
  const turns: T[][] = []
  for (const m of history) {
    if (m.role === 'user' || turns.length === 0) turns.push([m])
    else turns[turns.length - 1].push(m)
  }
  const turnCost = (t: T[]) => t.reduce((n, m) => n + estimateContentTokens(m.content), 0)

  if (budgetTokens <= 0 || turns.length === 0) {
    return { kept: history, droppedTurns: 0, totalTurns: turns.length, estimatedTokens: history.reduce((n, m) => n + estimateContentTokens(m.content), 0) }
  }

  // 从尾往头收连续段；最后一轮无条件保留
  const keptTurns: T[][] = []
  let used = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const cost = turnCost(turns[i])
    if (keptTurns.length > 0 && used + cost > budgetTokens) break
    keptTurns.unshift(turns[i])
    used += cost
  }
  // 首轮单独争取：不在保留段内且预算还装得下时补上（给模型开场上下文）
  if (keptTurns.length > 0 && keptTurns[0] !== turns[0] && turns.length > 1) {
    const headCost = turnCost(turns[0])
    if (used + headCost <= budgetTokens) {
      keptTurns.unshift(turns[0])
      used += headCost
    }
  }

  return {
    kept: keptTurns.flat(),
    droppedTurns: turns.length - keptTurns.length,
    totalTurns: turns.length,
    estimatedTokens: used,
  }
}
