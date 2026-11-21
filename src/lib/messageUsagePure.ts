/**
 * 每条 AI 回复的「本轮消耗 + 缓存命中」**渲染层纯函数**。
 *
 * 为什么单独一个零依赖文件：这条小字要同时挂在助手面（`MessageList`）与 AI 教学面
 * （`src/modules/ai-teaching/index.tsx` 中栏自己渲染消息），两处各写一份必然长歪；
 * 而契约脚本（`.AGENT/scripts/ai-teaching/verify-message-usage.mjs`）要能 strip 掉类型后
 * 直接 import 跑断言，所以这里**只允许 `import type`**，不许有运行时依赖。
 *
 * ── 口径（与 `AgentTraceStep` 字段一一对齐，见 src/types/index.ts）──
 * 1. 只看 `kind === 'llm'` 的步骤：tool 步骤没有用量，`artifact` 是产物不是消耗；
 * 2. 本轮 tokens = Σ(promptTokens + completionTokens)；个别步骤缺拆分时**逐条**退回该条
 *    `tokens`（工具循环里可能混着旧格式步骤，整轮不该因为一条缺字段就集体消失）；
 * 3. 缓存命中 = Σ cachedTokens / Σ promptTokens（cachedTokens 已含在 promptTokens 内，
 *    见 types 注释）—— 分母为 0 或整轮没有任何步骤带 cachedTokens 时不给百分比，
 *    宁可不显示也不显示一个假的 0%；
 * 4. 任何非有限数（NaN / Infinity / null）一律当没给，绝不让 NaN 漏进 JSX（会渲染成 NaN tokens）；
 * 5. 合计为 0 / 没有 llm 步骤 → 返回 null（调用方据此不渲染这一行；
 *    用户消息、旧数据、流式中的消息都没有可用的 trace）。
 */
import type { AgentTraceStep } from '../types'

/** 一条回复的本轮用量汇总 */
export interface MessageUsage {
  /** 本轮合计 tokens（拆分优先，缺拆分退回 tokens） */
  total: number
  /** Σ promptTokens（仅统计带拆分的步骤；hasSplit=false 时恒 0） */
  prompt: number
  /** Σ completionTokens */
  completion: number
  /** Σ cachedTokens（已含在 prompt 内，仅用于算命中率） */
  cached: number
  /** 缓存命中整数百分比；缺缓存字段 / 无输入时为 null */
  cacheHitPct: number | null
  /** Σ costUsd 估算费用（USD）；整轮无价目 → null */
  costUsd: number | null
  /** 是否至少有一条步骤带拆分（决定 tooltip 能否展示 ↑↓ 明细） */
  hasSplit: boolean
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** trace → 本轮用量汇总；无 llm 用量返回 null */
export function summarizeMessageUsage(trace?: AgentTraceStep[] | null): MessageUsage | null {
  if (!Array.isArray(trace) || trace.length === 0) return null
  let prompt = 0, completion = 0, cached = 0, cost = 0
  let total = 0, hasSplit = false, hasCached = false, hasCost = false
  for (const step of trace) {
    if (!step || step.kind !== 'llm') continue
    const p = isNum(step.promptTokens) ? step.promptTokens : null
    const c = isNum(step.completionTokens) ? step.completionTokens : null
    if (p !== null || c !== null) {
      hasSplit = true
      prompt += p ?? 0
      completion += c ?? 0
      total += (p ?? 0) + (c ?? 0)
    } else if (isNum(step.tokens)) {
      total += step.tokens
    }
    if (isNum(step.cachedTokens)) { cached += step.cachedTokens; hasCached = true }
    if (isNum(step.costUsd)) { cost += step.costUsd; hasCost = true }
  }
  if (total <= 0) return null
  const cacheHitPct = hasCached && prompt > 0
    ? Math.min(100, Math.max(0, Math.round((cached / prompt) * 100)))
    : null
  return { total, prompt, completion, cached, cacheHitPct, costUsd: hasCost ? cost : null, hasSplit }
}

/** 数字 → 友好 token 文本（≥1000 用 k；口径与 `MessageList` 原 `fmtTok` 一致：
 *  ≥10000 不留小数、其余留一位，这样 12345 显示 12k 而不是 12.3k） */
export function formatUsageToken(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)
}

/** 估算费用文本（USD，非账单）：小额度多留两位有效位，否则 $0.012 会全变 $0.01 */
export function formatUsageCost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}
