/**
 * 模型价目与费用估算（v3.9.0，方案 §3.4）。
 *
 * 零依赖纯模块：`estimateCost(buckets, modelKey)` 把用量桶按价目表折算成美元。
 * 价目单位统一为 **USD / 1M tokens**。表内缺失的桶（如部分 provider 不存在缓存写）
 * 一律按 0 计，不硬造价格；整模型不在表内 → 返回 null（UI 显示「无价目」而非 0）。
 *
 * 维护口径：价目会变，改这里即可；不做网络拉取（本地优先）。
 */

export interface UsageBuckets {
  /** 未缓存输入 */
  i0: number
  /** 缓存读 */
  ir: number
  /** 缓存写 */
  iw: number
  /** 输出 */
  out: number
  calls: number
}

export interface ModelPricing {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/** 价目表：按 modelKey 的小写子串匹配（`providerId:modelId` 取冒号后段也命中） */
const PRICING: Array<{ match: RegExp; price: ModelPricing }> = [
  { match: /gpt-4o-mini/, price: { input: 0.15, output: 0.6, cacheRead: 0.075 } },
  { match: /gpt-4o/, price: { input: 2.5, output: 10, cacheRead: 1.25 } },
  { match: /gpt-4\.1-mini/, price: { input: 0.4, output: 1.6, cacheRead: 0.1 } },
  { match: /gpt-4\.1/, price: { input: 2, output: 8, cacheRead: 0.5 } },
  { match: /deepseek-reasoner/, price: { input: 0.55, output: 2.19, cacheRead: 0.14 } },
  { match: /deepseek-chat/, price: { input: 0.27, output: 1.1, cacheRead: 0.07 } },
  { match: /claude-3-5-sonnet/, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: /claude-3-7-sonnet/, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: /claude-sonnet-4/, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: /claude-haiku/, price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  { match: /qwen/, price: { input: 0.4, output: 1.2 } },
  { match: /gemini-1\.5-flash/, price: { input: 0.075, output: 0.3 } },
  { match: /gemini-1\.5-pro/, price: { input: 1.25, output: 5 } },
]

/** 取模型价目（无则 null） */
export function priceOf(modelKey: string): ModelPricing | null {
  const m = String(modelKey ?? '').toLowerCase()
  if (!m) return null
  for (const { match, price } of PRICING) if (match.test(m)) return price
  return null
}

/** 估算单模型费用（USD）；模型无价目 → null */
export function estimateCost(b: UsageBuckets, modelKey: string): number | null {
  const p = priceOf(modelKey)
  if (!p) return null
  const perM = (tokens: number, rate: number | undefined): number => (rate ? (tokens / 1_000_000) * rate : 0)
  return (
    perM(b.i0, p.input) +
    perM(b.ir, p.cacheRead ?? p.input) +
    perM(b.iw, p.cacheWrite) +
    perM(b.out, p.output)
  )
}
