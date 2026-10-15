/**
 * 模型网关 · 协议层纯函数（零依赖 —— 专供 `.AGENT/scripts/**` 契约脚本 import）。
 *
 * 为什么单独一个文件：`llmService.ts` 顶部 `import { app, ipcMain, net } from 'electron'`，
 * 契约脚本用裸 node 跑不起来。所以凡是「值得断言、又不需要 electron」的判定与装配逻辑
 * 都放这里（同 `ccSwitchPure.ts` 的既有做法）。
 *
 * 覆盖范围：
 *   · 协议族判定（供应商 type + 逐模型覆盖 → 实际走哪条 API）
 *   · 会话头覆盖与客户端标识（opencode Go 官方的两条客户端要求）
 *   · OpenAI Responses 协议的请求装配与响应解析
 */

// ===== 类型（结构上与 llmService 的同名类型兼容，但本文件不 import 任何东西）=====

export type ProviderType = 'openai-compatible' | 'ollama' | 'anthropic' | 'openai-responses'

/**
 * 模型级协议归属。官方口径（opencode Go 文档 "Endpoints"）：
 * **"Each model is served by one API family."** —— 同一个 baseUrl、同一把 Key 下，
 * 39 个模型里 20 个走 `/chat/completions`、6 个走 `/messages`、6 个走 `/responses`。
 */
export type ModelFamily = 'chat' | 'messages' | 'responses'

export interface PureMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: unknown
  tool_calls?: unknown[]
  tool_call_id?: string
}

export interface PureToolCall {
  id: string
  name: string
  arguments: string
}

export interface PureUsage {
  promptTokens: number
  completionTokens: number
  cachedTokens?: number
}

export interface PureChatRequest {
  model: string
  messages: PureMessage[]
  tools?: unknown[]
  maxTokens: number
  effort?: 'off' | 'low' | 'medium' | 'high'
}

export interface PureChatResult {
  content: string
  toolCalls: PureToolCall[]
  usage: PureUsage
}

// ===== 协议族判定 =====

/** 供应商 type → 默认协议族。ollama 不在此表内（走自己的原生 API，无协议族概念）。 */
export const FAMILY_BY_TYPE: Partial<Record<ProviderType, ModelFamily>> = {
  'openai-compatible': 'chat',
  'openai-responses': 'responses',
  anthropic: 'messages',
}

/**
 * 某模型实际走哪个协议族：**逐模型覆盖优先，其次跟随供应商 type**。
 * 返回 null = 该端点没有协议族概念（ollama），调用方走原生适配器。
 */
export function familyOf(
  type: ProviderType,
  modelFamilies: Record<string, ModelFamily> | undefined,
  model: string,
): ModelFamily | null {
  return modelFamilies?.[model] ?? FAMILY_BY_TYPE[type] ?? null
}

// ===== 客户端标识与会话头 =====

/** 会话头的规范名（大小写不敏感匹配用） */
export const SESSION_HEADER = 'x-opencode-session'

/**
 * 客户端标识。opencode Go 官方要求："Identify itself with its own user agent, such as
 * my-coding-agent/1.0, rather than a generic SDK or HTTP-library name."
 */
export function userAgentString(version: string): string {
  return `Phrontis/${version || '0.0.0'}`
}

/**
 * 会话/路由头覆盖。官方要求："Send a stable session ID in `x-opencode-session` for each
 * conversation so we can optimize routing and prompt caching."
 *
 * 两条硬约束（两个方向都错不得）：
 *   · 同一对话每轮必须同一个值 —— 随机值会把提示缓存全部打散；
 *   · 不同对话必须不同值 —— 常量会让所有对话共用一个会话，缓存互相串。
 * 用户手填的必然是常量，所以有真实会话 ID 时以它覆盖。
 *
 * 只在**已声明**该头时才发（声明 = 用户/预设表明这个网关需要它），不替别的网关发明头。
 * 已声明但没给 sessionId 时保留原值（宁可发常量，也不要突然少一个上游要求的头）。
 */
export function withSessionHeaders(
  headers: Record<string, string> | undefined,
  sessionId?: string,
): Record<string, string> {
  const out: Record<string, string> = { ...(headers ?? {}) }
  const declared = Object.keys(out).find(k => k.toLowerCase() === SESSION_HEADER)
  if (declared && sessionId) out[declared] = sessionId
  return out
}

// ===== 推理能力启发式（原在 llmService，随 Responses 装配逻辑一起下移）=====

/** P3b 推理/思考能力启发式：仅这些模型接受 reasoning 参数（跟随模型能力）。 */
export const REASONING_MODEL_RE = /(reasoner|r1|qwq|qwen3|o[134]-|o[134]$|thinking|research|smart|deepthink)/i

// ===== OpenAI Responses 协议装配 =====

/**
 * OpenAI 线格式 → Responses 的 input item 列表。
 * Responses 把「消息」与「工具调用 / 工具结果」摊平成一串 item：function_call 与
 * function_call_output 是与 message 平级的顶层项，不是嵌在 assistant 消息里的字段。
 */
export function buildResponsesInput(messages: PureMessage[]): unknown[] {
  const items: unknown[] = []
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'user') {
      items.push({ role: m.role, content: [{ type: 'input_text', text: String(m.content ?? '') }] })
      continue
    }
    if (m.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: m.tool_call_id ?? '', output: String(m.content ?? '') })
      continue
    }
    if (m.content) items.push({ role: 'assistant', content: [{ type: 'output_text', text: String(m.content) }] })
    for (const tc of (m.tool_calls ?? []) as Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>) {
      const args = tc?.function?.arguments
      items.push({
        type: 'function_call',
        call_id: String(tc?.id ?? ''),
        name: String(tc?.function?.name ?? ''),
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
      })
    }
  }
  return items
}

/** Responses 的工具定义是**扁平**的（name/description/parameters 直接在工具上，不套 function 壳） */
export function buildResponsesTools(tools: unknown[] | undefined): Array<{ name: string }> {
  return (tools ?? [])
    .map((t: any) => ({
      type: 'function',
      name: String(t?.function?.name ?? ''),
      description: String(t?.function?.description ?? ''),
      parameters: t?.function?.parameters ?? { type: 'object', properties: {} },
    }))
    .filter(t => t.name)
}

/** Responses 请求体（流式 / 非流式共用，避免两套参数漂移） */
export function buildResponsesBody(req: PureChatRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    input: buildResponsesInput(req.messages),
    max_output_tokens: req.maxTokens,
    // 多轮回喂由我们自己做，不需要上游留状态；store:false 同时避免服务端留存会话
    store: false,
  }
  if (stream) body.stream = true
  const tools = buildResponsesTools(req.tools)
  if (tools.length > 0) { body.tools = tools; body.tool_choice = 'auto' }
  // P3b：Responses 的字段名是 reasoning.effort（不是 reasoning_effort），且只在模型具备能力时透传
  if (req.effort && req.effort !== 'off' && REASONING_MODEL_RE.test(req.model)) {
    body.reasoning = { effort: req.effort }
  }
  return body
}

/** Responses 完整响应 → 归一化结果（非流式解析 + 流式兜底共用） */
export function parseResponsesWhole(json: any): PureChatResult {
  let text = ''
  const collected: PureToolCall[] = []
  for (const item of json?.output ?? []) {
    if (item?.type === 'message') {
      for (const part of item.content ?? []) {
        if (part?.type === 'output_text') text += String(part.text ?? '')
        else if (part?.type === 'refusal') text += String(part.refusal ?? '')
      }
    } else if (item?.type === 'function_call') {
      collected.push({
        id: String(item.call_id ?? item.id ?? `call_${collected.length}`),
        name: String(item.name ?? ''),
        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
      })
    }
  }
  return {
    content: text,
    toolCalls: collected.filter(tc => tc.name),
    usage: {
      promptTokens: Number(json?.usage?.input_tokens ?? 0),
      completionTokens: Number(json?.usage?.output_tokens ?? 0),
      cachedTokens: Number(json?.usage?.input_tokens_details?.cached_tokens ?? 0),
    },
  }
}

/**
 * 流式收尾合并。**完成事件的完整 output 优先，任一侧为空时用另一侧兜底** ——
 * 这样即使上游改了事件名（我们没认出来），只要 response.completed 到了结果就仍然正确，
 * 最多退化成"非流式体验"（一次性出现），绝不会丢内容。
 */
export function mergeResponsesResult(
  whole: PureChatResult | null,
  streamed: PureToolCall[],
  streamedText: string,
  streamedUsage: PureUsage,
): PureChatResult {
  const content = whole?.content || streamedText
  const toolCalls = whole && whole.toolCalls.length > 0 ? whole.toolCalls : streamed
  const usage = whole && (whole.usage.promptTokens || whole.usage.completionTokens) ? whole.usage : streamedUsage
  return { content, toolCalls, usage }
}

/** 流式分片累加：output_index → function_call（Responses 的 function_call 是顶层 item，靠它归组） */
export function collectResponsesToolCalls(
  acc: Map<number, { id: string; name: string; args: string }>,
): PureToolCall[] {
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, t]) => ({ id: t.id || `call_${i}`, name: t.name, arguments: t.args || '{}' }))
    .filter(tc => tc.name)
}
