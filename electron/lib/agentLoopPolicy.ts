/**
 * Agent 循环策略（第 0-2 层优化：优雅收场 / 单轮并行密度 / 预算策略化）—— 纯函数，node 冒烟可跑。
 *
 * - 轮数与 token 预算从硬编码常数变为可配置（settings: agentMaxRounds / agentRunTokenBudget）；
 * - 一轮内的工具调用按「可并行的只读连续段 / 必须串行件」分批——研究型任务单轮多干活；
 * - 预算将尽注入收场提示，耗尽后做一次无工具的强制总结（替代原来的直接报错丢弃全部进展）。
 */

export const DEFAULT_MAX_ROUNDS = 16
export const DEFAULT_RUN_TOKEN_BUDGET = 500000

/** agentMaxRounds 收敛：2-64，非法/缺省回落 16 */
export function clampMaxRounds(v: unknown): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return DEFAULT_MAX_ROUNDS
  return Math.max(2, Math.min(64, n))
}

/** agentRunTokenBudget 收敛：≥0；0 = 不启用 token 预算（只按轮数封顶）；非法回落默认 */
export function clampRunTokenBudget(v: unknown): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RUN_TOKEN_BUDGET
  return n
}

/**
 * 并行安全判定：注册声明确认只读，且不是有会话级副作用的特殊工具
 * （tool.request 会重建工具 payload；visual.html / mindmap 有专门的时序事件/工件处理——都保持串行）。
 */
export function isParallelSafe(realName: string, readOnly: boolean): boolean {
  return readOnly && realName !== 'builtin.tool.request' && realName !== 'visual.html' && realName !== 'mindmap'
}

export interface ToolBatch<T> {
  parallel: boolean
  items: T[]
}

/**
 * 一轮内的工具调用 → 批次序列：连续的并行安全段合为一批，写/特殊工具自成分批并打断连续段。
 * 结果回填/trace/改动收集保持原顺序（由调用方按 items 顺序做收尾记账）。
 */
export function partitionToolBatches<T>(calls: T[], isSafe: (t: T) => boolean): ToolBatch<T>[] {
  const out: ToolBatch<T>[] = []
  for (const c of calls) {
    const safe = isSafe(c)
    const last = out[out.length - 1]
    if (safe && last?.parallel) last.items.push(c)
    else out.push({ parallel: safe, items: [c] })
  }
  return out
}

/** 并行段单块并发上限（本地 IPC/文件读为主，防止一次开太多句柄） */
export const PARALLEL_CHUNK = 4

/** 注入 system 的批量调用引导（第 1 层：单轮密度） */
export const PARALLEL_HINT =
  '\n\n【工具批量调用】同一轮内可以同时发出多个**互相独立**的工具调用（例如并行读取多个文件、同时搜索多个关键词），它们会被并发执行、结果按序回填；' +
  '只有后一步需要前一步结果时才分轮进行。合理批量能显著减少推理轮数消耗，复杂任务请优先规划好一批独立操作后一次发出。'

/** 预算将尽（最后一轮 / token 预算触顶）注入的收场提示（第 0 层） */
export const FINAL_ROUND_NOTICE =
  '（系统提示：这是本次请求的最后一次工具调用机会。收到本轮工具结果后，请立即基于已获取的全部信息给出最终总结回答，不要规划更多工具调用。' +
  '若有未完成的部分，在回答中如实说明即可。）'

/** 轮数/token 耗尽后的强制总结提示（不再直接报错丢弃进展） */
export const FORCED_SUMMARY_NOTICE =
  '（系统提示：工具调用预算已耗尽。请立即基于以上所有已获取的信息与已完成的分析，给出一份尽可能完整的最终回答；' +
  '未能覆盖的部分明确列出，不要虚构。）'
