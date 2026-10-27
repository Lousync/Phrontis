/**
 * 消息渲染窗口（纯函数，单一真源）。
 *
 * 长会话切对话卡顿的主因不是读盘 / IPC，而是把几百条消息一次性交给 react-markdown
 * 解析并挂 DOM（实测 217 条 / 106 条 AI 回复 ≈ 590ms）。这里只决定**挂载窗口的起点**，
 * 数据本身仍是全量 —— 大纲、跳转到旧消息、编辑重发都不受影响。
 *
 * 窗口语义：
 *  · 以「轮」为单位（一轮 = 用户提问 + 其后的 AI 回复），永远从用户消息开始，不切半轮；
 *  · 首屏取末尾 turns 轮；
 *  · 上滚加载 = 从当前起点再往前取 turns 轮；
 *  · 大纲跳转 = 取目标消息所在轮（再往前 contextTurns 轮做上下文）。
 */

export interface WindowMessage {
  id?: string
  role: 'user' | 'assistant'
}

/** 首屏挂载轮数（2026-10-27 拍板：10 轮） */
export const INITIAL_WINDOW_TURNS = 10
/** 每次上滚加载的轮数 */
export const LOAD_EARLIER_TURNS = 10
/** 大纲跳转到旧消息时，目标轮之前额外保留的轮数 */
export const REVEAL_CONTEXT_TURNS = 1

/** 消息下标 i 之前（含 i）最近的一条用户消息下标；没有则 0 */
function turnStartAtOrBefore(messages: readonly WindowMessage[], i: number): number {
  let idx = Math.max(0, Math.min(i, messages.length - 1))
  while (idx > 0 && messages[idx].role !== 'user') idx--
  return idx
}

/** 首屏窗口起点：末尾第 turns 个用户消息的下标；不足 turns 轮则 0 */
export function initialWindowStart(
  messages: readonly WindowMessage[],
  turns: number = INITIAL_WINDOW_TURNS,
): number {
  if (turns <= 0) return messages.length
  let need = turns
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    need -= 1
    if (need === 0) return i
  }
  return 0
}

/** 上滚加载：从 currentStart 往前再取 turns 个用户消息；到顶返回 0 */
export function earlierWindowStart(
  messages: readonly WindowMessage[],
  currentStart: number,
  turns: number = LOAD_EARLIER_TURNS,
): number {
  const start = Math.max(0, Math.min(currentStart, messages.length))
  if (start <= 0 || turns <= 0) return 0
  let need = turns
  for (let i = start - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    need -= 1
    if (need === 0) return i
  }
  return 0
}

/**
 * 大纲跳转：目标消息所在轮的开头，再往前 contextTurns 轮。
 * 目标不存在返回 null（调用方保持原窗口）。
 */
export function revealWindowStart(
  messages: readonly WindowMessage[],
  targetId: string,
  contextTurns: number = REVEAL_CONTEXT_TURNS,
): number | null {
  const target = messages.findIndex((m) => m.id === targetId)
  if (target < 0) return null
  let turn = turnStartAtOrBefore(messages, target)
  let need = Math.max(0, contextTurns)
  for (let i = turn - 1; i >= 0 && need > 0; i--) {
    if (messages[i].role !== 'user') continue
    need -= 1
    turn = i
  }
  return turn
}
