/**
 * AI 教学重构 · 模型能力内置表（P0 · 纯函数）
 *
 * 定位：能力三态解析链的**第二段**（`modelCatalogPure.lookupCapability`）——
 *   条目显式 yes/no  →  **本表（已知模型）**  →  名称正则兜底  →  auto（未检测）
 *
 * 口径（重要，与 `llmService.VISION_MODEL_RE` 不同）：
 * - 这里登记的是「**确定的**已知模型」，一条 = 一个可验证的模型族；
 * - **不确定的一律不写**，返回 `null` 交给下一段兜底 —— 比 `VISION_MODEL_RE` 那种
 *   「名字里带 4o / omni / multimodal 就算视觉」的宽松写法更保守；
 * - `tools: 'no'` 这类负向结论**必须写明来源**（注释），因为负向误判会让用户
 *   永远选不到能用的模型；正向误判则由真实 API 报错兜底；
 * - 正则容忍大小写、`-` / `.` / `_` / `/` / `:` 分隔，以及 `provider/model` 前缀。
 *
 * 零运行时依赖：只用 `import type` 引共享类型，可被 stripTypeScriptTypes 后直接 import
 * （契约脚本 `.AGENT/scripts/ai-teaching/verify-model-catalog.mjs`）。
 *
 * 方案：`/home/lousync/桌面/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md` §13 / §15.2、B8
 */

import type { CapabilityKey, CapabilityState } from './aiTeachingTypesPure'

/** 表版本：改登记内容就抬日期，便于排查「为什么这个模型突然变了」 */
export const CAPABILITY_TABLE_VERSION = '2026-11-19'

export interface CapabilityPattern {
  /** 正则源串（内部 `new RegExp(pattern, 'i')`；不带 g，`.test` 无状态） */
  pattern: string
  /** 登记依据 / 来源 */
  note?: string
  caps: Partial<Record<CapabilityKey, CapabilityState>>
}

/**
 * 已知模型族登记表（12 条）。
 *
 * 为什么显式写 `pattern` 字符串而不是字面量正则：契约脚本可以直接读出条目数 / 逐条核对，
 * 且避免正则字面量在 strip 模式下的转义歧义。
 *
 * **负向条目（tools: 'no'）必须带 note 写明来源**，否则不要登记。
 */
export const CAPABILITY_PATTERNS: CapabilityPattern[] = [
  // ---- 视觉（+ 工具）----
  {
    pattern: 'gpt-4o(?!.*(?:transcribe|tts|embedding|search))',
    note: 'OpenAI gpt-4o 系列（含 mini）支持图片输入与 function calling；排除 transcribe / tts / embedding / search 变体',
    caps: { vision: 'yes', tools: 'yes' },
  },
  {
    pattern: 'gpt-4(?:\\.1|\\.5|-turbo)',
    note: 'OpenAI gpt-4.1 / gpt-4.5 / gpt-4-turbo 支持图片输入与 function calling',
    caps: { vision: 'yes', tools: 'yes' },
  },
  {
    pattern: 'claude-(?:3|(?:sonnet|opus|haiku)-[45])',
    note: 'Anthropic Claude 3 及以上全系支持图片输入与 tool use',
    caps: { vision: 'yes', tools: 'yes' },
  },
  {
    pattern: 'gemini(?![-._]?embed)',
    note: 'Google Gemini 1.5 / 2.x 全系多模态；排除 gemini-embedding',
    caps: { vision: 'yes', tools: 'yes' },
  },
  {
    pattern: 'qwen[\\d.]*[-._]?vl',
    note: 'Qwen-VL 系列（qwen-vl / qwen2-vl / qwen2.5-vl）',
    caps: { vision: 'yes', tools: 'yes' },
  },
  {
    pattern: 'glm-4(?:\\.5)?v',
    note: '智谱 GLM-4V / GLM-4.5V 视觉系列',
    caps: { vision: 'yes' },
  },
  {
    pattern: '(?:llava|internvl|minicpm[-._]?v|pixtral|molmo)',
    note: '开源视觉模型：LLaVA / InternVL / MiniCPM-V / Pixtral / Molmo',
    caps: { vision: 'yes' },
  },
  {
    pattern: '(?:^|[/:_.\\-])(?:vision|vl)(?:$|[/:_.\\-])',
    note: '开源命名惯例：独立 token 的 vision / vl（如 llama-3.2-90b-vision-instruct）',
    caps: { vision: 'yes' },
  },

  // ---- 工具（负向：必须写明来源）----
  {
    pattern: 'deepseek-(?:r1|reasoner)',
    note: '负向来源：DeepSeek 官方文档 —— deepseek-reasoner / R1 不支持 function calling',
    caps: { tools: 'no' },
  },
  {
    pattern: '(?:^|[/:_.\\-])o1(?:-mini|-preview)',
    note: '负向来源：OpenAI 文档 —— o1-preview / o1-mini 不支持 function calling',
    caps: { tools: 'no' },
  },
  {
    pattern: 'deepseek-chat',
    note: 'DeepSeek-V3（deepseek-chat）支持 function calling',
    caps: { tools: 'yes' },
  },

  // ---- 生图 ----
  {
    pattern: '(?:dall-e|gpt-image|flux|stable-diffusion|seedream|imagen-[34])',
    note: '生图模型族：DALL-E / gpt-image / FLUX / Stable Diffusion / Seedream / Imagen 3-4',
    caps: { imageGeneration: 'yes' },
  },
]

const CAPABILITY_KEYS: CapabilityKey[] = ['tools', 'vision', 'json', 'imageGeneration', 'imageEdit']

const COMPILED: Array<{ re: RegExp; caps: Partial<Record<CapabilityKey, CapabilityState>> }> =
  CAPABILITY_PATTERNS.map((p) => ({ re: new RegExp(p.pattern, 'i'), caps: p.caps }))

function isCapabilityKey(k: string): k is CapabilityKey {
  return (CAPABILITY_KEYS as string[]).includes(k)
}

/**
 * 查单个能力：命中登记表返回 'yes' / 'no'；未登记返回 `null`（**不是** 'auto'，
 * 让调用方知道「这里没有依据」，继续走下一段兜底）。
 */
export function lookupCapability(modelId: string, key: CapabilityKey): CapabilityState | null {
  const raw = String(modelId ?? '').trim()
  if (!raw || !isCapabilityKey(String(key))) return null
  for (const item of COMPILED) {
    const state = item.caps[key]
    if (state && item.re.test(raw)) return state
  }
  return null
}

/** 查全部能力：按表顺序合并，同一个 key 先命中的为准（具体负向条目要排在通用正向之前） */
export function lookupAll(modelId: string): Partial<Record<CapabilityKey, CapabilityState>> {
  const out: Partial<Record<CapabilityKey, CapabilityState>> = {}
  const raw = String(modelId ?? '').trim()
  if (!raw) return out
  for (const item of COMPILED) {
    if (!item.re.test(raw)) continue
    for (const key of CAPABILITY_KEYS) {
      const state = item.caps[key]
      if (state && out[key] === undefined) out[key] = state
    }
  }
  return out
}
