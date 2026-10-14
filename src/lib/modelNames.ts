/**
 * OpenCode 模型目录 —— 友好名称、免费标记与协议归属的静态映射。
 * 背景：上游 /models 只返回 {id, object, created, owned_by}，既无免费元数据也无协议元数据。
 * 维护约定：上游改名/上新时更新此表；未知 ID 回退到机械美化，不会显示错误信息。
 * 官方来源：https://opencode.ai/v2/docs/console/go （2026-10-13 抄录）
 */
import type { LlmModelFamily } from '../types'

/**
 * 官方 Go 端点的免费模型（2026-10-13 官方定价表：这两条 Free / 月额度 Unlimited）。
 *
 * 注意：本表只是**补充**——`isFreeModel` 的 `free` 字样正则已经覆盖了绝大多数情况
 * （Zen 端点的 `*-free` 族全部命中），这里放的是"官方免费但 id 看不出"的兜底位。
 * 反例警示：`space-bunny` 在 Go 上是**付费**模型（$0.15/$0.60），不要标免费。
 */
const KNOWN_FREE = new Set([
  'longcat-2.5-preview-free',
  'step-5-preview-free',
])

/**
 * 模型 → 协议族（官方 Go 端点表原文抄录）。
 *
 * 官方口径：**"Each model is served by one API family."** 同一个 baseUrl、同一把 Key 下，
 * 模型分属三条路径：`/chat/completions`（20 个）· `/messages`（6 个）· `/responses`（6 个）。
 * 用途：新建 opencode Go 供应商时据此预填 `modelFamilies`，用户不必手工逐条标协议；
 * 不在表内的模型不预填（跟随端点默认协议），可在模型页单独覆盖。
 */
export const MODEL_FAMILY_HINTS: Record<string, LlmModelFamily> = {
  // /v1/responses（OpenAI Responses 协议）
  'grok-4.7': 'responses',
  'grok-4.6': 'responses',
  'gpt-6-luna': 'responses',
  'gpt-5.6-luna': 'responses',
  'muse-spark-1.3-contributor': 'responses',
  'muse-spark-1.2-contributor': 'responses',
  // /v1/messages（Anthropic Messages 协议）
  'claude-haiku-5-5': 'messages',
  'minimax-m3': 'messages',
  'minimax-m2.7': 'messages',
  'qwen3.8-max': 'messages',
  'qwen3.8-flash': 'messages',
  'qwen3.7-plus': 'messages',
  // /v1/chat/completions（OpenAI 兼容）
  'glm-5.3-flash': 'chat',
  'glm-5.3': 'chat',
  'glm-5.2': 'chat',
  'kimi-k3': 'chat',
  'kimi-k2.7-code': 'chat',
  'kimi-k2.6': 'chat',
  'longcat-2.0': 'chat',
  'deepseek-v4.1-flash': 'chat',
  'deepseek-v4-pro': 'chat',
  'deepseek-v4-flash': 'chat',
  'deepseek-v4-flash-vision-exp': 'chat',
  'mimo-v2.6-flash': 'chat',
  'mimo-v2.6-pro': 'chat',
  'mimo-v2.5': 'chat',
  'mimo-v2.5-pro': 'chat',
  'hy4-preview': 'chat',
  'hy3': 'chat',
  'space-bunny': 'chat',
  'longcat-2.5-preview-free': 'chat',
  'step-5-preview-free': 'chat',
}

/** 取模型的官方协议提示；不在表内返回 null（= 跟随端点默认协议） */
export function familyHintOf(id: string): LlmModelFamily | null {
  return MODEL_FAMILY_HINTS[id] ?? null
}

/** 手工维护的美化名（仅放无法机械推导或官方写法特殊的条目） */
const PRETTY_OVERRIDES: Record<string, string> = {
  // Zen 免费族
  'hy3-free': 'Hy3 Free',
  'mimo-v2.5-free': 'MiMo V2.5 Free',
  'muse-spark-1.2-contributor-free': 'Muse Spark 1.2 Free',
  'nemotron-3.5-lightning-free': 'Nemotron 3.5 Lightning Free',
  'nemotron-3-ultra-free': 'Nemotron 3 Ultra Free',
  'deepseek-v4-flash-free': 'DeepSeek V4 Flash Free',
  'laguna-s-2.1-free': 'Laguna S 2.1 Free',
  'x-preview-f-free': 'X Preview F Free',
  // Go 端点（注意：不带 -free 后缀的是付费版，勿标免费）
  'hy3': 'Hy3',
  'hy3-preview': 'Hy3 Preview',
  'mimo-v2.5': 'MiMo V2.5',
  'mimo-v2.5-pro': 'MiMo V2.5 Pro',
  'mimo-v2.5-omni': 'MiMo V2.5 Omni',
  'muse-spark-1.2-contributor': 'Muse Spark 1.2 Contributor',
  'muse-spark-1.2': 'Muse Spark 1.2',
  'longcat-2.0': 'LongCat 2.0',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
}

/** 品牌词大小写表（机械美化用） */
const BRAND_CASE: Record<string, string> = {
  glm: 'GLM', gpt: 'GPT', ai: 'AI', llm: 'LLM', ocr: 'OCR',
}

/** 品牌前缀 → 展示名（首段匹配即整组替换） */
const BRAND_PREFIX: Record<string, string> = {
  kimi: 'Kimi', deepseek: 'DeepSeek', qwen: 'Qwen', grok: 'Grok',
  minimax: 'MiniMax', mimo: 'MiMo', nemotron: 'Nemotron', longcat: 'LongCat',
}

/**
 * 版本号段（`5.2` / `v4` / `k2` / `1.6`）→ 全大写；其余段只把首字母大写。
 *
 * ★ 2026-10-13 修：这里原先对品牌词**之后的每一段都 toUpperCase**，
 *   于是 `deepseek-chat` 显示成 “DeepSeek CHAT”、`kimi-k2-turbo` 显示成 “Kimi K2 TURBO”。
 *   这段字符串直接出现在模型选择器与下拉里，一个大小写问题就让整个列表看起来像没做完。
 *   口径来自原型（tmp/ai-settings-proto 里按修好的样子渲染）：
 *   只有纯版本号段才全大写，普通单词只首字母大写。
 */
function capTail(part: string): string {
  if (/^\d/.test(part)) return part.toUpperCase()          // 5.2 / 1.6
  if (/^[a-z]\d+(\.\d+)?$/i.test(part)) return part.toUpperCase() // v4 / k2 / m2.5
  return part.charAt(0).toUpperCase() + part.slice(1)
}

/** 模型 ID → 友好名称（未知 ID 机械美化：分段+品牌大小写） */
export function prettyModelName(id: string): string {
  if (PRETTY_OVERRIDES[id]) return PRETTY_OVERRIDES[id]
  const parts = id.split('-')
  const first = parts[0]?.toLowerCase() ?? ''
  if (BRAND_PREFIX[first]) {
    const rest = parts.slice(1).map(capTail).join(' ')
    return `${BRAND_PREFIX[first]} ${rest}`.trim()
  }
  return parts.map(p => {
    const lower = p.toLowerCase()
    if (BRAND_CASE[lower]) return BRAND_CASE[lower]
    return p.charAt(0).toUpperCase() + p.slice(1)
  }).join(' ')
}

/** 是否目录内已知的免费模型 */
export function isOpenCodeFree(id: string): boolean {
  return KNOWN_FREE.has(id.toLowerCase())
}
