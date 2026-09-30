import { invokeLlmInternal, firstEnabledModelSpec } from './llmService'
import { FEW_SHOT, hasOperationIntent } from './manualChannelPure'

/**
 * N-1「手册通道」：一次性分类（docs/v3.4.0-feedback.md `N-1`）
 *
 * 纯函数与常量在 `manualChannelPure.ts`（零依赖，供契约脚本 import），此处只放**接 LLM 的分类调用**。
 */

export {
  MANUAL_CHANNEL_TOOL, MANUAL_MAX_ROUNDS, MANUAL_MAX_RESULT_CHARS, MANUAL_SEARCH_LIMIT,
  hasOperationIntent, buildManualSystemPrompt, FEW_SHOT,
} from './manualChannelPure'

/** 分类超时（ms）：超时即落通用通道 */
const CLASSIFY_TIMEOUT_MS = 5000

/** 解析 'pid:mid' → { providerId, modelId }；空则回退第一个启用供应商（一次性分类用） */
function resolveModel(modelSpec?: string): { providerId?: string; modelId?: string } {
  const spec = String(modelSpec ?? '').trim()
  if (spec) {
    const ci = spec.indexOf(':')
    return ci > 0 ? { providerId: spec.slice(0, ci), modelId: spec.slice(ci + 1) } : { modelId: spec }
  }
  const fb = firstEnabledModelSpec()
  return fb ? { providerId: fb.providerId, modelId: fb.modelId } : {}
}

/**
 * 首条用户消息的通道分类（仅调一次；失败/超时/不确定 → 'agent'）。
 * 命中本地操作词表时直接返回 'agent'，不发起 LLM 调用。
 */
export async function classifyManualIntent(message: string, modelSpec?: string): Promise<'manual' | 'agent'> {
  const text = String(message ?? '').trim()
  if (!text) return 'agent'
  if (hasOperationIntent(text)) return 'agent'
  const sys = '你是意图分类器。判断用户消息是「询问这个软件（Phrontis）自身怎么用 / 某功能在哪 / 为什么行为不符合预期」，还是「要 AI 去操作软件数据（创建/修改/删除/检索仓库内容等）」。只输出一个词：manual 或 agent。'
  const examples = FEW_SHOT.map(([q, a]) => `${q} => ${a}`).join('\n')
  const user = `判例：\n${examples}\n\n用户消息：${text.slice(0, 400)}\n\n只输出 manual 或 agent：`
  const { providerId, modelId } = resolveModel(modelSpec)
  try {
    const r = await invokeLlmInternal({
      providerId, modelId, effort: 'off',
      signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    })
    if (!r.ok) return 'agent'
    const out = String(r.content ?? '').toLowerCase()
    const isManual = /\bmanual\b/.test(out)
    const isAgent = /\bagent\b/.test(out)
    return isManual && !isAgent ? 'manual' : 'agent'
  } catch {
    return 'agent'
  }
}
