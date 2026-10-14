import { app, ipcMain, net } from 'electron'
import { randomUUID } from 'crypto'
import { appendAudit, countMonthLlmTokens, countMonthLlmTokensSplit, countMonthVisionTokens, countMonthVisionPages, summarizeMonthLlmUsage } from './pluginAudit'
import { encryptSecret, decryptSecret } from './secretBox'
import { scanCcSwitch, importCcSwitchIds, bindCcSwitchSaver } from './ccSwitchImport'
import {
  familyOf, userAgentString, withSessionHeaders, buildResponsesBody,
  parseResponsesWhole, mergeResponsesResult, collectResponsesToolCalls,
  REASONING_MODEL_RE,
  type ProviderType, type ModelFamily, type PureChatResult,
} from './llmProtocolPure'
import {
  migrateProvider, activeAccountOf, activeAccountKeyEnc, providerUsable,
  sanitizeAccountInfo, appendAccount, removeAccount,
  type ProviderAccount,
} from './llmAccountPure'
import {
  attachFacts, rawFailure, rawFromError, classifyFailure, friendlyReason,
  interruptionOfStopReason, interruptionDetailOf, STOP_REASON_NO_TERMINATOR,
  type Interruption, type InterruptionDetail, type InterruptCode,
} from './llmFailurePure'

/**
 * Model Gateway —— LLM API 统一接入层（方案 .claude/plans/model-gateway.md）。
 *
 * 职责：Provider 抽象（openai-compatible / ollama）、Key 加密落盘（secretBox）、
 * 连通性测试与模型发现、月度 token 预算硬限制、调用审计（不含消息正文）、tools 参数透传。
 * 边界：网关不代执行工具——tool_calls 原样回传给调用方（AgentRunner 决定执行）。
 */

// ===== 类型 =====

// 供应商类型与协议族定义在零依赖的 llmProtocolPure（契约脚本要 import 它），此处只做转出，
// 保持既有 `from './llmService'` 的调用方不受影响。
export type { ProviderType, ModelFamily } from './llmProtocolPure'
export { REASONING_MODEL_RE }

/**
 * 端点内的一个账号（2026-10-13，按原型 tmp/ai-settings-proto 的「账号列表」落地）。
 *
 * 为什么账号是**端点内部的第二层**，而不是"同一个端点再建一条供应商"：
 * Key 是加密且**不可回读**的（渲染层只拿得到 hasKey），换账号时没法把旧 Key 读出来搬过去，
 * 所以每个账号必须有自己独立的永久 Key 槽；而模型 spec 指向的是**端点 id**，
 * 于是切换当前账号时那 5 处模型槽位（对话默认 / AI 助手 / 编辑器续写 / 长对话压缩 / 视觉转写）
 * 一处都不用改，两个账号还共用同一份模型清单（不用各拉一遍 /models）。
 * 规则本体见 llmAccountPure.ts。
 */
export type { ProviderAccount } from './llmAccountPure'

export interface ProviderConfig {
  id: string
  name: string
  type: ProviderType
  baseUrl: string
  /** 'enc1:' 密文（secretBox 机制），永不出主进程。
   *  2026-10-13 起它是**当前账号** Key 的兼容镜像 —— 真正的 Key 住在 accounts[] 里，
   *  取值一律走 activeKeyOf(p)，不要再直接读这个字段。 */
  apiKeyEncrypted: string
  enabled: boolean
  models: string[]
  /** 端点内的账号（同一 baseUrl / 协议 / 请求头 / 模型清单，只有 Key 各自独立）。
   *  旧记录没有这个字段：读盘时由 migrateProvider 用 apiKeyEncrypted 生成首个账号。 */
  accounts?: ProviderAccount[]
  /** 当前生效的账号 id —— 模型 spec 不含账号，切换它不动任何模型槽位 */
  activeAccountId?: string
  /** 逐模型的协议覆盖；未列出的模型跟随 type（见 familyOf）。 */
  modelFamilies?: Record<string, ModelFamily>
  /** 自定义请求头（明文存设置，勿放 API Key 类敏感值——密钥走 apiKey 字段走 secretBox）。
   *  2026-09-08：opencode 等网关要求 x-opencode-session 之类的会话/路由头，按服务商在设置里配。
   *  2026-10-13：这里填的是**常量**，而官方要求"每个对话一个稳定 ID"——有会话上下文时由
   *  withSessionHeaders 用真实会话 ID 覆盖该值，见该函数注释。 */
  headers?: Record<string, string>
  /** 嵌入模型名（知识语义索引用，knowledge-index-design §6）；不配 = 该供应商不参与嵌入 */
  embeddingModel?: string
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  tool_calls?: unknown[]
  tool_call_id?: string
}

interface ToolCallNormalized {
  id: string
  name: string
  arguments: string // JSON 字符串（OpenAI 线格式）
}

interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools?: unknown[] // OpenAI function 格式
  maxTokens: number
  /** 外部中断信号（用户点击停止） */
  signal?: AbortSignal
  /** P3b 思考强度（§3.8 第五轮）：仅推理型模型透传 reasoning_effort，off/未设 = 不发 */
  effort?: 'off' | 'low' | 'medium' | 'high'
  /** 会话标识（x-opencode-session）。**必须每个对话稳定**：同一对话每轮同一个值（否则提示
   *  缓存全废），不同对话不同值（否则缓存互相串）。无对话的场景传固定用途名（如 'translate'）。 */
  sessionId?: string
}

/**
 * 网关归一化后的用量。cachedTokens 表示命中提示缓存的输入 token 数（观测用，
 * 已包含在 promptTokens 之内，勿重复计入预算）；不支持缓存的供应商恒为 0/undefined。
 */
type LlmUsage = { promptTokens: number; completionTokens: number; cachedTokens?: number }

interface ChatResult {
  content: string
  toolCalls: ToolCallNormalized[]
  /** OpenAI 线格式的 assistant 消息（多轮回喂时原样使用） */
  assistantMessage: ChatMessage
  usage: LlmUsage
  /** 上游停止原因（finish_reason / stop_reason / done_reason / 'no-terminator'）—— G5 = B-29 判据 */
  stopReason?: string
  rawError?: never
}

const CONNECT_TIMEOUT_MS = 30_000
const TOTAL_TIMEOUT_MS = 300_000

// ===== 流式（2026-09-10 docs/ai-streaming-design.md §5.1）=====

/** 网关归一化流事件：屏蔽三家（OpenAI 兼容 / Anthropic / Ollama）差异，上层只认这个 */
export type LlmStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number; cachedTokens?: number }
  | { type: 'done' }

const STREAM_FIRST_BYTE_MS = 60_000
const STREAM_IDLE_MS = 60_000

/**
 * 流式超时三阶段（归因方案 §4.1 —— 语义必须分明，否则三种超时又会糊成一团）：
 * ① 连接：net.fetch() → 响应头到达（`CONNECT_TIMEOUT_MS` 30s；此前它是死常数，见 G7）
 * ② 首字节：响应头到达 → 第一个数据帧（60s）
 * ③ 空闲：帧 → 帧（60s，每帧重置）
 * 不可用 AbortSignal.timeout(TOTAL_TIMEOUT_MS)——那会在第 300 秒掐断正常长流。
 * 超时归属由「fetch 是否已 resolve」+「收到几段数据」决定，**不靠耗时猜测**。
 */
export interface StreamStats {
  /** 收到几个数据段（判「零输出 vs 收了一半」的关键判据） */
  chunks: number
  /** 已产出多少字符（content.length / text.length） */
  chars: number
  /** 是否见过正常结束帧（[DONE] / message_stop / done / response.completed） */
  terminator: boolean
  /** 上游停止原因（finish_reason / stop_reason / done_reason；未见结束帧补 'no-terminator'） */
  stopReason?: string
}

interface StreamAbortHandle {
  signal: AbortSignal
  /** 响应头已到（fetch resolve）→ 连接阶段结束，转首字节计时 */
  connected: () => void
  /** 每个数据段：转空闲计时 + 记段数 */
  chunk: () => void
  timedOutKind: () => 'connect' | 'first-byte' | 'idle' | null
  /** 外部 signal 已 abort（用户点停止）—— 优先于任何超时（B-0） */
  externalAborted: () => boolean
  stats: StreamStats
  dispose: () => void
}

function createStreamAbort(external: AbortSignal | undefined): StreamAbortHandle {
  const ctrl = new AbortController()
  const stats: StreamStats = { chunks: 0, chars: 0, terminator: false }
  let timer: ReturnType<typeof setTimeout> | null = null
  let timedOutKind: 'connect' | 'first-byte' | 'idle' | null = null
  const arm = (ms: number, kind: 'connect' | 'first-byte' | 'idle'): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timedOutKind = kind; ctrl.abort() }, ms)
  }
  const onExternal = (): void => ctrl.abort()
  if (external) {
    if (external.aborted) ctrl.abort()
    else external.addEventListener('abort', onExternal, { once: true })
  }
  arm(CONNECT_TIMEOUT_MS, 'connect')
  return {
    signal: ctrl.signal,
    connected: () => arm(STREAM_FIRST_BYTE_MS, 'first-byte'),
    chunk: () => { stats.chunks++; arm(STREAM_IDLE_MS, 'idle') },
    timedOutKind: () => timedOutKind,
    externalAborted: () => !!external?.aborted,
    stats,
    dispose: () => {
      if (timer) clearTimeout(timer)
      if (external) external.removeEventListener('abort', onExternal)
    },
  }
}

// ---- 采集搬运：状态码 / 上游原话 / 段数 / 结束帧 → RawFailure（归一不读中文文案）----

/**
 * 上游错误体 → 机器可读码与原话。
 * 只认 `error.code` / `error.type` / `error.message`（**不认顶层 type**：Anthropic 的
 * `type:'error'` 是帧类型、不是错误码，认了会把所有错误帧归一成同一个码）。
 */
function upstreamFactsOf(json: any): { upstreamCode?: string; upstreamMessage?: string } {
  const e = json?.error
  const code = String(e?.code ?? e?.type ?? '').trim()
  const raw = typeof e === 'string' ? e : String(e?.message ?? json?.message ?? '')
  const message = raw.replace(/\s+/g, ' ').trim().slice(0, 300)
  return { ...(code ? { upstreamCode: code } : {}), ...(message ? { upstreamMessage: message } : {}) }
}

/** 非 200 响应：状态 + 未截断的上游原话（300）一起带走（不再只有拼好的中文串） */
function httpFailure(message: string, status: number, json: any, started: number): Error {
  return attachFacts(new Error(message), {
    layer: 'http',
    httpStatus: status,
    ...upstreamFactsOf(json),
    elapsedMs: Date.now() - started,
  })
}

/** 适配器 catch 出口：把「超时归属 + 段数 + 已产出 + 结束帧」并进采集面后原样抛出 */
function failStream(err: unknown, sa: StreamAbortHandle, started: number): never {
  const raw = rawFromError(err, {
    externalAborted: sa.externalAborted(),
    ...(sa.timedOutKind() ? { timedOut: sa.timedOutKind() as 'connect' | 'first-byte' | 'idle' } : {}),
    receivedChunks: sa.stats.chunks,
    partialChars: sa.stats.chars,
    sawTerminator: sa.stats.terminator,
    ...(sa.stats.stopReason ? { stopReason: sa.stats.stopReason } : {}),
    elapsedMs: Date.now() - started,
  })
  throw attachFacts(err, raw)
}

/**
 * 按帧切分读取响应体。
 *
 * **chunk 边界 ≠ 事件边界**（实测 Electron 33 net.fetch 单块可达 21KB、含多个 SSE 事件，
 * 也可能只有半个）——所以必须带缓冲按空行切帧，残尾留到下个 chunk。
 * 详见 docs/ai-streaming-design.md §5.1.2。
 */
async function* readFrames(res: Response): AsyncGenerator<string> {
  const body = res.body
  if (!body) return
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      if (buf.indexOf('\r') >= 0) buf = buf.replace(/\r\n/g, '\n')
      let i = buf.indexOf('\n\n')
      while (i >= 0) {
        yield buf.slice(0, i)
        buf = buf.slice(i + 2)
        i = buf.indexOf('\n\n')
      }
    }
    if (buf.trim()) yield buf
  } finally {
    try { reader.releaseLock() } catch { /* 已释放 */ }
  }
}

/** 按行切分读取（Ollama 是 NDJSON 而非 SSE，不能复用 readFrames 的空行分帧） */
async function* readLines(res: Response): AsyncGenerator<string> {
  const body = res.body
  if (!body) return
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i = buf.indexOf('\n')
      while (i >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        if (line.trim()) yield line
        i = buf.indexOf('\n')
      }
    }
    if (buf.trim()) yield buf
  } finally {
    try { reader.releaseLock() } catch { /* 已释放 */ }
  }
}

/** SSE 帧 → data 载荷（多行 data: 按规范以 \n 连接）；注释/心跳帧返回 null */
function sseData(frame: string): string | null {
  const parts: string[] = []
  for (const ln of frame.split('\n')) {
    if (ln.startsWith('data:')) parts.push(ln.slice(5).replace(/^ /, ''))
  }
  return parts.length > 0 ? parts.join('\n') : null
}

/** 是否 SSE 响应（否则视为网关忽略了 stream 参数，走非流式回退） */
function isSseResponse(res: Response): boolean {
  return String(res.headers.get('content-type') ?? '').includes('text/event-stream')
}

/** 流式响应体 → 完整 JSON（网关忽略 stream 时的回退解析）；失败返回 null */
function parseWholeJson(text: string): any {
  try { return JSON.parse(text) } catch { return null }
}

// ===== 存取 =====

/** 由 registerLlmHandlers 注入；避免与 settingsStore 循环依赖 */
let depsRef: { getSettingValue: (k: string) => unknown; setSettingValue: (k: string, v: unknown) => boolean } | null = null

function getProviders(): ProviderConfig[] {
  try {
    const raw = String(depsRef?.getSettingValue('modelProviders') ?? '')
    const arr = raw ? JSON.parse(raw) : []
    if (!Array.isArray(arr)) return []
    const list = arr as ProviderConfig[]
    // 一次性迁移到「账号」模型（旧记录只有单个 apiKeyEncrypted）；真有改动才回写，不是每次读都写盘
    if (list.some(p => migrateProvider(p, randomUUID))) saveProviders(list)
    return list
  } catch { return [] }
}

function saveProviders(list: ProviderConfig[]): void {
  depsRef?.setSettingValue('modelProviders', JSON.stringify(list))
}

// ===== 账号（端点内部的第二层）=====
// 规则本体（迁移 / 取当前账号 / 可用性 / 脱敏 / 增删）住在 llmAccountPure.ts（零依赖，
// 供契约脚本真跑）；这里只负责把它接到 node 的 uuid 与 secretBox 上。

/** 取当前账号的明文 Key（**只在主进程内存中出现**，密文与明文都不落日志）。
 *  有账号时只认当前账号那把，不回退到别的账号 —— 否则"切换"就成了摆设。 */
function activeKeyOf(p: ProviderConfig): string {
  const enc = activeAccountKeyEnc(p)
  return enc ? decryptSecret(enc) : ''
}

// ===== URL 安全校验 =====

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')
}

/** https 放行；http 仅允许本机（Ollama 场景），其余拒绝 */
export function validateProviderUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let u: URL
  try { u = new URL(raw) } catch { return { ok: false, error: `URL 不合法: ${raw}` } }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: '仅允许 http(s) 地址' }
  if (u.protocol === 'http:' && !isLocalHost(u.hostname)) {
    return { ok: false, error: '非本机地址必须使用 https（防止 API Key 明文跨网络传输）' }
  }
  return { ok: true, url: u.toString().replace(/\/+$/, '') }
}

// ===== 适配器 =====

interface Adapter {
  listModels(p: ProviderConfig): Promise<string[]>
  chat(p: ProviderConfig, req: ChatRequest): Promise<ChatResult>
  /** 流式对话：逐块回调归一化事件，返回值与非流式 chat 同构（上层逻辑无需分叉）。
   *  未实现时 invokeLlmStream 自动回退为「一次返回全部 content」——功能不受损，仅失去过程感。 */
  chatStream?(p: ProviderConfig, req: ChatRequest, onEvent: (e: LlmStreamEvent) => void): Promise<ChatResult>
  /** 文本嵌入（语义索引用）：texts 与返回向量按序一一对应。
   *  未实现（如 anthropic）= 该供应商类型不支持嵌入，resolveEmbedProvider 自动跳过。 */
  embed?(p: ProviderConfig, texts: string[], model: string): Promise<number[][]>
}

async function httpJson(url: string, init: { method: string; headers: Record<string, string>; body?: string }, externalSignal?: AbortSignal): Promise<{ status: number; json: any }> {
  const signals: AbortSignal[] = [AbortSignal.timeout(TOTAL_TIMEOUT_MS)]
  if (externalSignal) signals.push(externalSignal)
  const res = await net.fetch(url, {
    ...init,
    signal: AbortSignal.any(signals),
  })
  const text = await res.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json }
}

/**
 * 客户端标识（2026-10-13）。opencode Go 官方要求："Identify itself with its own user agent,
 * such as my-coding-agent/1.0, rather than a generic SDK or HTTP-library name."
 * 不带自定义 UA 时上游只看到通用的 Electron/Chromium 串，无法把流量归到一个正经客户端名下。
 */
function userAgent(): string {
  let v = ''
  try { v = app.getVersion() } catch { /* 无 app 上下文（纯函数被契约脚本 import）时留默认 */ }
  return userAgentString(v)
}

function authHeaders(p: ProviderConfig, sessionId?: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': userAgent() }
  const key = activeKeyOf(p)
  if (key) h['Authorization'] = `Bearer ${key}` // 解密仅在内存中进行，密文与明文都不落日志
  return { ...h, ...withSessionHeaders(p.headers, sessionId) }
}

function anthropicBase(p: ProviderConfig): string {
  return p.baseUrl.replace(/\/v1\/?$/, '') // 容忍用户粘贴带 /v1 的地址，适配器统一补版本路径
}

/** 上游错误 → 面向用户的中文提示（保留原始细节截断） */
function friendlyHttpError(status: number, json: any): string {
  const detail = String(json?.error?.message ?? json?.message ?? '').replace(/\s+/g, ' ').slice(0, 120)
  const etype = String(json?.error?.type ?? '')
  if (status === 429 || /RateLimit|FreeUsageLimit/i.test(etype + detail)) {
    return `免费模型限频中，请稍后再试或换其他模型${detail ? `（${detail}）` : ''}`
  }
  if (status === 401 || status === 403) return `鉴权失败（${status}），请检查 API Key${detail ? `：${detail}` : ''}`
  if (status === 404) return `接口路径不存在（404），请确认 Base URL 与供应商类型匹配${detail ? `：${detail}` : ''}`
  if (status >= 500) return `上游模型暂时不可用（${status}），可稍后重试或换其他模型${detail ? `：${detail}` : ''}`
  return `HTTP ${status}: ${detail || '请求失败'}`
}

function anthropicHeaders(p: ProviderConfig, sessionId?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'User-Agent': userAgent(),
  }
  const key = activeKeyOf(p)
  if (key) h['x-api-key'] = key
  return { ...h, ...withSessionHeaders(p.headers, sessionId) }
}

function normalizeOpenAiToolCalls(raw: any[]): ToolCallNormalized[] {
  return (raw ?? []).map((tc, i) => ({
    id: String(tc?.id ?? `call_${i}`),
    name: String(tc?.function?.name ?? ''),
    arguments: typeof tc?.function?.arguments === 'string'
      ? tc.function.arguments
      : JSON.stringify(tc?.function?.arguments ?? {}),
  })).filter(tc => tc.name)
}

/** OpenAI 兼容请求体（流式 / 非流式共用，避免两套参数漂移） */
function buildOpenAiBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    max_tokens: req.maxTokens,
  }
  if (stream) {
    body.stream = true
    // 末块带 usage；不支持的网关会忽略该字段，usage 退化为 0（不影响正确性）
    body.stream_options = { include_usage: true }
  }
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools
    body.tool_choice = 'auto'
  }
  // P3b：思考强度仅在模型具备能力时透传，避免不认该参数的供应商报错
  if (req.effort && req.effort !== 'off' && REASONING_MODEL_RE.test(req.model)) {
    body.reasoning_effort = req.effort
  }
  return body
}

/** OpenAI 兼容完整响应 → ChatResult（非流式解析 + 流式回退共用） */
function parseOpenAiChoice(json: any): ChatResult {
  const msg = json?.choices?.[0]?.message ?? {}
  const toolCalls = normalizeOpenAiToolCalls(msg.tool_calls)
  return {
    content: String(msg.content ?? ''),
    toolCalls,
    assistantMessage: msg as ChatMessage,
    usage: {
      promptTokens: Number(json?.usage?.prompt_tokens ?? 0),
      completionTokens: Number(json?.usage?.completion_tokens ?? 0),
      // OpenAI / DeepSeek 等的自动前缀缓存命中量（不支持的网关返回 undefined → 0）
      cachedTokens: Number(json?.usage?.prompt_tokens_details?.cached_tokens ?? 0),
    },
  }
}

const openAiCompatibleAdapter: Adapter = {
  async listModels(p): Promise<string[]> {
    const { status, json } = await httpJson(`${p.baseUrl}/models`, { method: 'GET', headers: authHeaders(p) })
    if (status !== 200) throw new Error(`HTTP ${status}`)
    const ids = (json?.data ?? []).map((m: any) => String(m?.id)).filter(Boolean)
    return [...new Set(ids)] as string[]
  },
  async chat(p, req) {
    const started = Date.now()
    const { status, json } = await httpJson(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(p, req.sessionId),
      body: JSON.stringify(buildOpenAiBody(req, false)),
    }, req.signal)
    if (status !== 200 || !json) {
      throw Object.assign(httpFailure(friendlyHttpError(status, json), status, json, started), { latencyMs: Date.now() - started })
    }
    return parseOpenAiChoice(json)
  },
  async chatStream(p, req, onEvent) {
    const started = Date.now()
    const sa = createStreamAbort(req.signal)
    try {
      const res = await net.fetch(`${p.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: authHeaders(p, req.sessionId),
        body: JSON.stringify(buildOpenAiBody(req, true)),
        signal: sa.signal,
      })
      sa.connected() // 响应头已到：连接阶段结束，转首字节计时（超时归属靠它分辨）
      if (res.status !== 200) {
        const json = parseWholeJson(await res.text())
        throw httpFailure(friendlyHttpError(res.status, json), res.status, json, started)
      }
      // 网关忽略 stream：整体 JSON 回退（功能可用，仅失去过程感）
      if (!isSseResponse(res)) {
        const r = parseOpenAiChoice(parseWholeJson(await res.text()))
        if (r.content) onEvent({ type: 'text', delta: r.content })
        onEvent({ type: 'usage', ...r.usage })
        onEvent({ type: 'done' })
        return r
      }
      let content = ''
      const acc = new Map<number, { id: string; name: string; args: string }>()
      let usage: LlmUsage = { promptTokens: 0, completionTokens: 0 }
      for await (const frame of readFrames(res)) {
        sa.chunk()
        const data = sseData(frame)
        if (!data) continue
        if (data === '[DONE]') { sa.stats.terminator = true; break }
        const json = parseWholeJson(data)
        if (!json) continue // 心跳 / 非 JSON 帧：丢弃，绝不抛
        // G1（归因 P0）：SSE 内的 error 帧此前完全不看 —— 上游报错会被当成正常回答，内容半截
        if (json.error) {
          const up = upstreamFactsOf(json)
          throw attachFacts(new Error(up.upstreamMessage ?? '上游在流中报错'), {
            layer: 'stream-frame', ...up, elapsedMs: Date.now() - started,
          })
        }
        const choice = json?.choices?.[0] ?? {}
        // G5 = B-29：上游停止原因（'length' = 撞 max_tokens 被截断）此前没人读
        if (typeof choice.finish_reason === 'string' && choice.finish_reason) sa.stats.stopReason = choice.finish_reason
        const d = choice.delta ?? {}
        if (typeof d?.content === 'string' && d.content) {
          content += d.content
          sa.stats.chars += d.content.length
          onEvent({ type: 'text', delta: d.content })
        }
        // 思考链字段名各家不一（reasoning_content / reasoning）：见到即归一化，不做模型名预判
        const rc = typeof d?.reasoning_content === 'string' ? d.reasoning_content
          : typeof d?.reasoning === 'string' ? d.reasoning : ''
        if (rc) { sa.stats.chars += rc.length; onEvent({ type: 'reasoning', delta: rc }) }
        if (Array.isArray(d?.tool_calls)) {
          for (const tc of d.tool_calls) {
            // 流式 tool_calls 是分片：id/name 仅首片给，arguments 逐片累加
            const idx = Number(tc?.index ?? 0)
            const cur = acc.get(idx) ?? { id: '', name: '', args: '' }
            if (tc?.id) cur.id = String(tc.id)
            if (tc?.function?.name) cur.name = String(tc.function.name)
            const argDelta = typeof tc?.function?.arguments === 'string' ? tc.function.arguments : ''
            if (argDelta) { cur.args += argDelta; sa.stats.chars += argDelta.length }
            acc.set(idx, cur)
            onEvent({
              type: 'tool_call', index: idx,
              id: cur.id || undefined, name: cur.name || undefined,
              argsDelta: argDelta || undefined,
            })
          }
        }
        if (json?.usage) {
          usage = {
            promptTokens: Number(json.usage.prompt_tokens ?? 0),
            completionTokens: Number(json.usage.completion_tokens ?? 0),
            cachedTokens: Number(json.usage.prompt_tokens_details?.cached_tokens ?? 0),
          }
        }
      }
      // G4：干净 EOF 与正常结束同形 —— 未见结束帧就标出来（上层据此提示「回答被上游截断」）
      if (!sa.stats.terminator) sa.stats.stopReason = STOP_REASON_NO_TERMINATOR
      const toolCalls: ToolCallNormalized[] = [...acc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([i, t]) => ({ id: t.id || `call_${i}`, name: t.name, arguments: t.args || '{}' }))
        .filter(tc => tc.name)
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content,
        ...(toolCalls.length > 0 ? {
          tool_calls: toolCalls.map(tc => ({
            id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments },
          })),
        } : {}),
      }
      onEvent({ type: 'usage', ...usage })
      onEvent({ type: 'done' })
      return {
        content, toolCalls, assistantMessage, usage,
        ...(sa.stats.stopReason ? { stopReason: sa.stats.stopReason } : {}),
      }
    } catch (err) {
      failStream(err, sa, started) // 超时归属 + 段数 + 结束帧并进采集面后原样抛出
    } finally {
      sa.dispose()
    }
  },
  async embed(p, texts, model) {
    // OpenAI 兼容 /embeddings：input 数组一次批；返回 data[].embedding 与入参按序对应
    const { status, json } = await httpJson(`${p.baseUrl}/embeddings`, {
      method: 'POST',
      headers: authHeaders(p),
      body: JSON.stringify({ model, input: texts }),
    })
    if (status !== 200 || !json) throw new Error(friendlyHttpError(status, json))
    const vectors = (json?.data ?? []).map((d: any) => d?.embedding).filter((v: unknown) => Array.isArray(v))
    if (vectors.length !== texts.length) throw new Error(`嵌入返回数不符（请求 ${texts.length}，返回 ${vectors.length}）`)
    return vectors as number[][]
  },
}

function ollamaBase(p: ProviderConfig): string {
  return p.baseUrl || 'http://localhost:11434'
}

/** Ollama 消息 → 归一化工具调用 */
function parseOllamaToolCalls(raw: any[]): ToolCallNormalized[] {
  return (raw ?? []).map((tc: any, i: number) => ({
    id: `call_${i}`,
    name: String(tc?.function?.name ?? ''),
    arguments: typeof tc?.function?.arguments === 'string'
      ? tc.function.arguments
      : JSON.stringify(tc?.function?.arguments ?? {}),
  })).filter((tc: ToolCallNormalized) => tc.name)
}

/** Ollama 完整响应 → ChatResult（非流式解析 + 流式回退共用） */
function parseOllamaWhole(json: any): ChatResult {
  const msg = json?.message ?? {}
  const toolCalls = parseOllamaToolCalls(msg.tool_calls)
  return {
    content: String(msg.content ?? ''),
    toolCalls,
    assistantMessage: {
      role: 'assistant',
      content: String(msg.content ?? ''),
      ...(toolCalls.length > 0 ? { tool_calls: msg.tool_calls } : {}),
    },
    usage: {
      promptTokens: Number(json.prompt_eval_count ?? 0),
      completionTokens: Number(json.eval_count ?? 0),
    },
  }
}

/** Ollama 请求体装配（流式 / 非流式共用；tool_calls 回传逻辑两处一致） */
function buildOllamaBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
  const messages = req.messages.map(m => ({ role: m.role, content: m.content ?? '' }))
  const lastAssistant = [...req.messages].reverse().find(m => m.role === 'assistant')
  if (lastAssistant?.tool_calls) (messages[messages.length - 1] as any).tool_calls = lastAssistant.tool_calls
  return {
    model: req.model,
    messages,
    stream,
    tools: req.tools && req.tools.length > 0 ? req.tools : undefined,
    options: { num_predict: req.maxTokens },
  }
}

const ollamaAdapter: Adapter = {
  async listModels(p): Promise<string[]> {
    const { status, json } = await httpJson(`${ollamaBase(p)}/api/tags`, { method: 'GET', headers: {} })
    if (status !== 200) throw new Error(`HTTP ${status}（Ollama 服务未启动？）`)
    return ((json?.models ?? []).map((m: any) => String(m?.name)).filter(Boolean)) as string[]
  },
  async chat(p, req) {
    const started = Date.now()
    const { status, json } = await httpJson(`${ollamaBase(p)}/api/chat`, {
      method: 'POST',
      headers: {},
      body: JSON.stringify(buildOllamaBody(req, false)),
    }, req.signal)
    // G3（归因 P0）：非 200 此前只抛 `HTTP 404`，错误体（如 model "x" not found）整个丢掉
    if (status !== 200 || !json) {
      const detail = typeof json?.error === 'string' ? `：${json.error.replace(/\s+/g, ' ').slice(0, 200)}` : ''
      throw httpFailure(`HTTP ${status}${detail}`, status, json, started)
    }
    return parseOllamaWhole(json)
  },
  async chatStream(p, req, onEvent) {
    const started = Date.now()
    const sa = createStreamAbort(req.signal)
    try {
      const res = await net.fetch(`${ollamaBase(p)}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildOllamaBody(req, true)),
        signal: sa.signal,
      })
      sa.connected() // 响应头已到：连接阶段结束，转首字节计时
      if (res.status !== 200) {
        const json = parseWholeJson(await res.text())
        throw httpFailure(`HTTP ${res.status}`, res.status, json, started)
      }
      // 网关/服务忽略 stream 时返回 application/json（非 NDJSON）→ 整体回退
      const ctype = String(res.headers.get('content-type') ?? '')
      if (ctype.includes('application/json') && !ctype.includes('ndjson')) {
        const r = parseOllamaWhole(parseWholeJson(await res.text()))
        if (r.content) onEvent({ type: 'text', delta: r.content })
        onEvent({ type: 'usage', ...r.usage })
        onEvent({ type: 'done' })
        return r
      }
      let content = ''
      let usage = { promptTokens: 0, completionTokens: 0 }
      const toolCalls: ToolCallNormalized[] = []
      for await (const line of readLines(res)) {
        sa.chunk()
        const json = parseWholeJson(line)
        if (!json) continue
        // NDJSON 里的 error 行（如 model "x" not found）此前被忽略 → 当正常回答
        if (json.error) {
          const up = upstreamFactsOf(json)
          throw attachFacts(new Error(up.upstreamMessage ?? 'Ollama 在流中报错'), {
            layer: 'stream-frame', ...up, elapsedMs: Date.now() - started,
          })
        }
        const m = json.message ?? {}
        if (typeof m.content === 'string' && m.content) {
          content += m.content
          sa.stats.chars += m.content.length
          onEvent({ type: 'text', delta: m.content })
        }
        if (typeof m.thinking === 'string' && m.thinking) {
          sa.stats.chars += m.thinking.length
          onEvent({ type: 'reasoning', delta: m.thinking })
        }
        if (Array.isArray(m.tool_calls)) {
          const got = parseOllamaToolCalls(m.tool_calls)
          for (const tc of got) {
            toolCalls.push({ ...tc, id: `call_${toolCalls.length}` })
            sa.stats.chars += tc.arguments.length
            onEvent({ type: 'tool_call', index: toolCalls.length - 1, name: tc.name, argsDelta: tc.arguments })
          }
        }
        if (json.prompt_eval_count != null || json.eval_count != null) {
          usage = {
            promptTokens: Number(json.prompt_eval_count ?? 0),
            completionTokens: Number(json.eval_count ?? 0),
          }
        }
        // G5 = B-29：done_reason（'length' = 撞 num_predict 被截断）此前没人读
        if (json.done) {
          sa.stats.terminator = true
          if (typeof json.done_reason === 'string' && json.done_reason) sa.stats.stopReason = json.done_reason
          break
        }
      }
      if (!sa.stats.terminator) sa.stats.stopReason = STOP_REASON_NO_TERMINATOR
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content,
        ...(toolCalls.length > 0 ? {
          tool_calls: toolCalls.map(tc => ({
            id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments },
          })),
        } : {}),
      }
      onEvent({ type: 'usage', ...usage })
      onEvent({ type: 'done' })
      return {
        content, toolCalls, assistantMessage, usage,
        ...(sa.stats.stopReason ? { stopReason: sa.stats.stopReason } : {}),
      }
    } catch (err) {
      failStream(err, sa, started)
    } finally {
      sa.dispose()
    }
  },
  async embed(p, texts, model) {
    // Ollama /api/embeddings 逐条（本地无批接口兼容性顾虑；新 /api/batch-embed 未普及时保持简单）
    const out: number[][] = []
    for (const text of texts) {
      const { status, json } = await httpJson(`${ollamaBase(p)}/api/embeddings`, {
        method: 'POST',
        headers: {},
        body: JSON.stringify({ model, prompt: text }),
      })
      if (status !== 200 || !json) throw new Error(`HTTP ${status}（Ollama 服务未启动或嵌入模型未拉取？）`)
      if (!Array.isArray(json?.embedding)) throw new Error('Ollama 嵌入返回格式异常')
      out.push(json.embedding as number[])
    }
    return out
  },
}

// ---- Anthropic Messages API 适配器（非流式） ----

/**
 * 提示缓存断点（P0，2026-09-12）。Anthropic 是**唯一需要显式标记**的 provider ——
 * OpenAI / DeepSeek 等对 ≥1024 token 的前缀自动缓存，Ollama 本地无此机制。
 *
 * 缓存按「前缀」生效，Anthropic 的固定顺序是 tools → system → messages，断点语义是
 * "到此为止的前缀可缓存"，所以打在 tools 末元素与 system 末尾，正好覆盖 agent loop
 * 每轮重发且恒定不变的那一段（内置工具 schema ~7.4k tok + 系统提示）。
 * 命中后按约 10% 计价（写入 1.25x，TTL 5 分钟）；messages 每轮增长，不打断点。
 */
const CACHE_CONTROL = { type: 'ephemeral' } as const

/** OpenAI 线格式 → Anthropic 请求体（流式 / 非流式共用） */
function buildAnthropicBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
  // system 抽离；tool 结果合并为 tool_result 块
  const systemParts: string[] = []
  const turns: { role: 'user' | 'assistant'; content: unknown[] }[] = []
  const pushTurn = (role: 'user' | 'assistant', block: unknown): void => {
    const last = turns[turns.length - 1]
    if (last && last.role === role) last.content.push(block)
    else turns.push({ role, content: [block] })
  }
  for (const m of req.messages) {
    if (m.role === 'system') { systemParts.push(m.content ?? ''); continue }
    if (m.role === 'user') { pushTurn('user', { type: 'text', text: m.content ?? '' }); continue }
    if (m.role === 'tool') {
      pushTurn('user', { type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: m.content ?? '' })
      continue
    }
    // assistant：文本块 + tool_use 块
    const blocks: unknown[] = []
    if (m.content) blocks.push({ type: 'text', text: m.content })
    for (const tc of (m.tool_calls ?? []) as any[]) {
      let input: unknown = {}
      try { input = JSON.parse(String(tc?.function?.arguments ?? '{}')) } catch { /* 空对象 */ }
      blocks.push({ type: 'tool_use', id: String(tc?.id ?? ''), name: String(tc?.function?.name ?? ''), input })
    }
    if (blocks.length > 0) pushTurn('assistant', blocks.length === 1 ? blocks[0] : blocks)
  }
  const tools = (req.tools ?? []).map((t: any, i: number) => ({
    name: String(t?.function?.name ?? ''),
    description: String(t?.function?.description ?? ''),
    input_schema: t?.function?.parameters ?? { type: 'object' },
    // 只给最后一个工具打断点（断点 = 到此为止的前缀全可缓存，逐个打是浪费断点配额，上限 4 个）
    ...(req.tools && i === req.tools.length - 1 ? { cache_control: CACHE_CONTROL } : {}),
  }))
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    messages: turns,
    ...(stream ? { stream: true } : {}),
    // system 必须用数组形式才能带 cache_control（字符串形式无法附加标记）
    ...(systemParts.length > 0
      ? { system: [{ type: 'text', text: systemParts.join('\n\n'), cache_control: CACHE_CONTROL }] }
      : {}),
    ...(tools.length > 0 ? { tools } : {}),
  }
}

/** 结果 → assistant 消息（OpenAI 线格式，多轮回喂用）。供应商中立：anthropic 与 responses 共用。 */
function buildAssistantMessage(text: string, toolCalls: ToolCallNormalized[]): ChatMessage {
  return {
    role: 'assistant',
    content: text,
    ...(toolCalls.length > 0 ? {
      tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })),
    } : {}),
  }
}

const anthropicAdapter: Adapter = {
  async listModels(p): Promise<string[]> {
    const { status, json } = await httpJson(`${anthropicBase(p)}/v1/models`, {
      method: 'GET',
      headers: anthropicHeaders(p),
    })
    if (status !== 200) throw new Error(`HTTP ${status}`)
    return ((json?.data ?? []).map((m: any) => String(m?.id)).filter(Boolean)) as string[]
  },
  async chat(p, req) {
    const started = Date.now()
    const { status, json } = await httpJson(`${anthropicBase(p)}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(p, req.sessionId),
      body: JSON.stringify(buildAnthropicBody(req, false)),
    })
    if (status !== 200 || !json) {
      throw httpFailure(`HTTP ${status}: ${String(json?.error?.message ?? '').slice(0, 200) || '响应解析失败'}`, status, json, started)
    }
    let text = ''
    const toolCalls: ToolCallNormalized[] = []
    for (const block of json.content ?? []) {
      if (block?.type === 'text') text += String(block.text ?? '')
      if (block?.type === 'tool_use') {
        toolCalls.push({
          id: String(block.id ?? `call_${toolCalls.length}`),
          name: String(block.name ?? ''),
          arguments: JSON.stringify(block.input ?? {}),
        })
      }
    }
    return {
      content: text,
      toolCalls,
      assistantMessage: buildAssistantMessage(text, toolCalls),
      usage: {
        promptTokens: Number(json.usage?.input_tokens ?? 0),
        completionTokens: Number(json.usage?.output_tokens ?? 0),
        // 缓存命中量（读取价）。cache_creation_input_tokens 是写入量，不计入此处
        cachedTokens: Number(json.usage?.cache_read_input_tokens ?? 0),
      },
    }
  },
  async chatStream(p, req, onEvent) {
    const started = Date.now()
    const sa = createStreamAbort(req.signal)
    try {
      const res = await net.fetch(`${anthropicBase(p)}/v1/messages`, {
        method: 'POST',
        headers: anthropicHeaders(p, req.sessionId),
        body: JSON.stringify(buildAnthropicBody(req, true)),
        signal: sa.signal,
      })
      sa.connected() // 响应头已到：连接阶段结束，转首字节计时
      if (res.status !== 200) {
        const json = parseWholeJson(await res.text())
        throw httpFailure(`HTTP ${res.status}: ${String(json?.error?.message ?? '').slice(0, 200) || '响应解析失败'}`, res.status, json, started)
      }
      let text = ''
      let usage: LlmUsage = { promptTokens: 0, completionTokens: 0 }
      /** 按 content block index 收集 tool_use（入参是 input_json_delta 分片拼接） */
      const blocks = new Map<number, { id: string; name: string; json: string }>()
      for await (const frame of readFrames(res)) {
        sa.chunk()
        const data = sseData(frame)
        if (!data) continue
        const json = parseWholeJson(data)
        if (!json) continue
        const type = String(json.type ?? '')
        // G2（归因 P0）：此前只认 5 种 type、不认 error —— Anthropic 最常见的失败
        // （overloaded_error 529）就此消失，用户看到「正常回答、内容半截」
        if (type === 'error') {
          const up = upstreamFactsOf(json)
          throw attachFacts(new Error(up.upstreamMessage ?? 'Anthropic 在流中报错'), {
            layer: 'stream-frame', ...up, elapsedMs: Date.now() - started,
          })
        }
        if (type === 'message_start') {
          // message_start 里就带完整的输入侧用量（含缓存命中量），一次取齐
          usage = {
            ...usage,
            promptTokens: Number(json.message?.usage?.input_tokens ?? 0),
            cachedTokens: Number(json.message?.usage?.cache_read_input_tokens ?? 0),
          }
        } else if (type === 'content_block_start') {
          const cb = json.content_block ?? {}
          if (cb.type === 'tool_use') {
            blocks.set(Number(json.index ?? 0), { id: String(cb.id ?? ''), name: String(cb.name ?? ''), json: '' })
          }
        } else if (type === 'content_block_delta') {
          const d = json.delta ?? {}
          if (d.type === 'text_delta' && d.text) {
            text += String(d.text)
            sa.stats.chars += String(d.text).length
            onEvent({ type: 'text', delta: String(d.text) })
          } else if (d.type === 'thinking_delta' && d.thinking) {
            sa.stats.chars += String(d.thinking).length
            onEvent({ type: 'reasoning', delta: String(d.thinking) })
          } else if (d.type === 'input_json_delta') {
            const idx = Number(json.index ?? 0)
            const cur = blocks.get(idx)
            if (cur) {
              cur.json += String(d.partial_json ?? '')
              sa.stats.chars += String(d.partial_json ?? '').length
              onEvent({ type: 'tool_call', index: idx, name: cur.name || undefined, argsDelta: String(d.partial_json ?? '') })
            }
          }
        } else if (type === 'message_delta') {
          usage = { ...usage, completionTokens: Number(json.usage?.output_tokens ?? 0) }
          // G5 = B-29：stop_reason（'max_tokens' = 被截断）此前只取 usage、不看它
          if (typeof json.delta?.stop_reason === 'string' && json.delta.stop_reason) sa.stats.stopReason = json.delta.stop_reason
        } else if (type === 'message_stop') {
          sa.stats.terminator = true
          break
        }
      }
      if (!sa.stats.terminator) sa.stats.stopReason = STOP_REASON_NO_TERMINATOR
      const toolCalls: ToolCallNormalized[] = [...blocks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([i, b]) => ({ id: b.id || `call_${i}`, name: b.name, arguments: b.json || '{}' }))
        .filter(tc => tc.name)
      onEvent({ type: 'usage', ...usage })
      onEvent({ type: 'done' })
      return {
        content: text,
        toolCalls,
        assistantMessage: buildAssistantMessage(text, toolCalls),
        usage,
        ...(sa.stats.stopReason ? { stopReason: sa.stats.stopReason } : {}),
      }
    } catch (err) {
      failStream(err, sa, started)
    } finally {
      sa.dispose()
    }
  },
}

// ---- OpenAI Responses API 适配器（2026-10-13） ----
//
// 为什么需要它：opencode Go 官方端点表把 grok-4.7 / grok-4.6 / gpt-6-luna / gpt-5.6-luna /
// muse-spark-1.3-contributor / muse-spark-1.2-contributor 归到 `/v1/responses`，而同一个
// baseUrl、同一把 Key 下还有走 `/chat/completions`（20 个）与 `/messages`（6 个）的模型。
// 网关原先只有 chat / messages / ollama 三条适配器 → 这批模型必然被打到 /chat/completions
// 拿 4xx，等于接不进来。
//
// 请求装配 / 响应解析 / 分片合并这些纯逻辑都在 llmProtocolPure.ts（契约脚本可断言），
// 本适配器只负责网络与事件转发。

/** 纯函数结果 → 本文件的 ChatResult（补上 OpenAI 线格式的 assistantMessage） */
function toChatResult(r: PureChatResult): ChatResult {
  return { ...r, assistantMessage: buildAssistantMessage(r.content, r.toolCalls) }
}

const openAiResponsesAdapter: Adapter = {
  async listModels(p): Promise<string[]> {
    // 模型清单是端点级资源，与协议族无关（同一 baseUrl 的 /models 返回该端点的全部模型）
    const { status, json } = await httpJson(`${p.baseUrl}/models`, { method: 'GET', headers: authHeaders(p) })
    if (status !== 200) throw new Error(`HTTP ${status}`)
    const ids = (json?.data ?? []).map((m: any) => String(m?.id)).filter(Boolean)
    return [...new Set(ids)] as string[]
  },
  async chat(p, req) {
    const started = Date.now()
    const { status, json } = await httpJson(`${p.baseUrl}/responses`, {
      method: 'POST',
      headers: authHeaders(p, req.sessionId),
      body: JSON.stringify(buildResponsesBody(req, false)),
    }, req.signal)
    if (status !== 200 || !json) {
      throw Object.assign(httpFailure(friendlyHttpError(status, json), status, json, started), { latencyMs: Date.now() - started })
    }
    return toChatResult(parseResponsesWhole(json))
  },
  async chatStream(p, req, onEvent) {
    const started = Date.now()
    const sa = createStreamAbort(req.signal)
    try {
      const res = await net.fetch(`${p.baseUrl}/responses`, {
        method: 'POST',
        headers: authHeaders(p, req.sessionId),
        body: JSON.stringify(buildResponsesBody(req, true)),
        signal: sa.signal,
      })
      sa.connected() // 响应头已到：连接阶段结束，转首字节计时
      if (res.status !== 200) {
        const json = parseWholeJson(await res.text())
        throw httpFailure(friendlyHttpError(res.status, json), res.status, json, started)
      }
      // 网关忽略 stream：整体 JSON 回退（功能可用，仅失去过程感）
      if (!isSseResponse(res)) {
        const r = toChatResult(parseResponsesWhole(parseWholeJson(await res.text())))
        if (r.content) onEvent({ type: 'text', delta: r.content })
        onEvent({ type: 'usage', ...r.usage })
        onEvent({ type: 'done' })
        return r
      }
      let text = ''
      let usage: LlmUsage = { promptTokens: 0, completionTokens: 0 }
      /** output_index → function_call 分片累加（function_call 是顶层 item，靠 output_index 归组） */
      const acc = new Map<number, { id: string; name: string; args: string }>()
      /** response.completed 里的完整 output 是权威结果；拿到就以它为准（见 mergeResponsesResult） */
      let whole: PureChatResult | null = null
      for await (const frame of readFrames(res)) {
        sa.chunk()
        const data = sseData(frame)
        if (!data) continue
        if (data === '[DONE]') { sa.stats.terminator = true; continue }
        const json = parseWholeJson(data)
        if (!json) continue // 心跳 / 非 JSON 帧：丢弃，绝不抛
        const u = json.usage ?? json.response?.usage
        if (u) {
          usage = {
            promptTokens: Number(u.input_tokens ?? 0),
            completionTokens: Number(u.output_tokens ?? 0),
            cachedTokens: Number(u.input_tokens_details?.cached_tokens ?? 0),
          }
        }
        const type = String(json.type ?? '')
        if (type === 'response.output_text.delta') {
          const d = String(json.delta ?? '')
          if (d) { text += d; sa.stats.chars += d.length; onEvent({ type: 'text', delta: d }) }
        } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
          // 思考链走独立事件（与另两条适配器同口径：只发事件，不落库）
          const d = String(json.delta ?? '')
          if (d) { sa.stats.chars += d.length; onEvent({ type: 'reasoning', delta: d }) }
        } else if (type === 'response.output_item.added') {
          const it = json.item ?? {}
          if (it.type === 'function_call') {
            const idx = Number(json.output_index ?? 0)
            const cur = acc.get(idx) ?? { id: '', name: '', args: '' }
            if (it.call_id) cur.id = String(it.call_id)
            if (it.name) cur.name = String(it.name)
            if (typeof it.arguments === 'string' && it.arguments) { cur.args += it.arguments; sa.stats.chars += it.arguments.length }
            acc.set(idx, cur)
            onEvent({ type: 'tool_call', index: idx, id: cur.id || undefined, name: cur.name || undefined })
          }
        } else if (type === 'response.function_call_arguments.delta') {
          const idx = Number(json.output_index ?? 0)
          const d = String(json.delta ?? '')
          const cur = acc.get(idx) ?? { id: '', name: '', args: '' }
          if (d) { cur.args += d; sa.stats.chars += d.length; onEvent({ type: 'tool_call', index: idx, argsDelta: d }) }
          acc.set(idx, cur)
        } else if (type === 'response.completed' || type === 'response.incomplete') {
          whole = parseResponsesWhole(json.response ?? {})
          sa.stats.terminator = true
          // G5 = B-29：此前 `incomplete` 当正常完成 —— 撞 max_output_tokens 被截断却毫无提示
          if (type === 'response.incomplete' || String(json.response?.status ?? '') === 'incomplete') {
            sa.stats.stopReason = String(json?.response?.incomplete_details?.reason ?? 'incomplete')
          }
          break
        } else if (type === 'response.failed' || type === 'error') {
          // 这条适配器原本就有（当样板）；本轮把上游码/原话一起采下来，不再只留一句中文
          const errObj = json?.response?.error ?? json?.error ?? json
          const up = upstreamFactsOf({ error: errObj })
          throw attachFacts(new Error(up.upstreamMessage ?? 'Responses 接口返回失败事件'), {
            layer: 'stream-frame', ...up, elapsedMs: Date.now() - started,
          })
        }
      }
      if (!sa.stats.terminator) sa.stats.stopReason = STOP_REASON_NO_TERMINATOR
      // 合并：完成事件的完整 output 优先，任一侧为空时用另一侧兜底 —— 这样即使上游改了事件名
      // （我们没认出来），只要 response.completed 到了，结果仍然正确，最多退化成非流式体验。
      const merged = mergeResponsesResult(whole, collectResponsesToolCalls(acc), text, usage)
      onEvent({ type: 'usage', ...merged.usage })
      onEvent({ type: 'done' })
      return { ...toChatResult(merged), ...(sa.stats.stopReason ? { stopReason: sa.stats.stopReason } : {}) }
    } catch (err) {
      failStream(err, sa, started)
    } finally {
      sa.dispose()
    }
  },
}

const adapters: Record<ProviderType, Adapter> = {
  'openai-compatible': openAiCompatibleAdapter,
  ollama: ollamaAdapter,
  anthropic: anthropicAdapter,
  'openai-responses': openAiResponsesAdapter,
}

const FAMILY_ADAPTER: Record<ModelFamily, Adapter> = {
  chat: openAiCompatibleAdapter,
  messages: anthropicAdapter,
  responses: openAiResponsesAdapter,
}

/** 按「模型」而不是「端点」选适配器 —— 一个端点下的模型可以分属不同 API 族 */
function adapterFor(p: ProviderConfig, model: string): Adapter {
  const fam = familyOf(p.type, p.modelFamilies, model)
  return fam ? FAMILY_ADAPTER[fam] : getAdapter(p.type)
}

function getAdapter(type: ProviderType): Adapter {
  const a = adapters[type]
  if (!a) throw new Error(`不支持的供应商类型: ${type}`)
  return a
}

// ===== 嵌入通道（knowledge-index-design §6）=====

/** 取第一个「已启用 + 配了 embeddingModel + 适配器支持嵌入」的供应商；无则 null（语义层降级） */
export function resolveEmbedProvider(): { provider: ProviderConfig; model: string } | null {
  for (const p of getProviders()) {
    if (!p.enabled || !p.embeddingModel?.trim()) continue
    if (!getAdapter(p.type).embed) continue
    return { provider: p, model: p.embeddingModel.trim() }
  }
  return null
}

export type LlmEmbedResult =
  | { ok: true; vectors: number[][]; model: string; providerName: string }
  | { ok: false; error: string }

/** 批量嵌入入口（语义索引管线用）：批 ≤64，失败直接上抛错误信息由调用方降级 */
export async function llmEmbed(texts: string[]): Promise<LlmEmbedResult> {
  const resolved = resolveEmbedProvider()
  if (!resolved) return { ok: false, error: '未配置嵌入模型（设置 → 模型 → 供应商的 embeddingModel）' }
  const adapter = getAdapter(resolved.provider.type).embed
  if (!adapter) return { ok: false, error: '该供应商类型不支持嵌入' }
  const vectors: number[][] = []
  try {
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64)
      vectors.push(...await adapter(resolved.provider, batch, resolved.model))
    }
  } catch (err) {
    appendAudit(resolved.provider.id, 'llm.embed', { ok: false, count: texts.length })
    return { ok: false, error: String((err as Error)?.message || err) }
  }
  appendAudit(resolved.provider.id, 'llm.embed', { ok: true, count: texts.length })
  return { ok: true, vectors, model: resolved.model, providerName: resolved.provider.name }
}

// ===== invoke 主流程 =====

export interface LlmInvokeRequest {
  providerId?: string
  modelId?: string
  messages: ChatMessage[]
  tools?: unknown[]
  /** 外部中断信号（用户点击停止） */
  signal?: AbortSignal
  /** P3b：思考强度（本对话生效，由调用方透传） */
  effort?: 'off' | 'low' | 'medium' | 'high'
  /** 会话标识（2026-10-13，供 x-opencode-session 路由/提示缓存）。
   *  同一对话的每一轮必须是同一个值；无对话的场景传固定用途名（如 'translate' / 'vision'）。 */
  sessionId?: string
}

/** 网关失败码 = 归因码 ∪ 配置类码（配置类在发请求前就知道，没有采集面） */
export type LlmInvokeFailCode =
  | InterruptCode
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_DISABLED'
  | 'NO_DEFAULT_MODEL'

export type LlmInvokeResponse = {
  ok: true
  content: string
  toolCalls: ToolCallNormalized[]
  assistantMessage: ChatMessage
  model: string
  tokens: number
  promptTokens: number
  completionTokens: number
  /** 命中提示缓存的输入 token 数（观测用，已含在 promptTokens 内） */
  cachedTokens?: number
  /** 故障转移：本次实际应答的供应商 ≠ 默认供应商时，记录被接管的默认供应商名（网关补强） */
  fallbackFrom?: string
  /** 上游停止原因（G5 = B-29 判据） */
  stopReason?: string
  /** ok=true 但输出被截断（LLM_OUTPUT_TRUNCATED / LLM_STREAM_TRUNCATED）：正文追加提示且可续写 */
  interruption?: Interruption
  /** 归因诊断细节（截断时也有；不含正文与 Key） */
  detail?: InterruptionDetail
} | {
  ok: false
  error: string
  code?: LlmInvokeFailCode
  /** 归因结果（归因 P0 的唯一真源）—— 上层只读它，不再各自解析错误文案 */
  interruption?: Interruption
  /** 归因诊断细节（不含正文与 Key） */
  detail?: InterruptionDetail
}

type LlmTarget =
  | { ok: true; provider: ProviderConfig; model: string; maxTokens: number }
  | { ok: false; error: string; code?: 'PROVIDER_NOT_FOUND' | 'PROVIDER_DISABLED' | 'NO_DEFAULT_MODEL' }

/** 供应商 / 模型 / 上限解析（llmInvoke 与流式入口共用，避免两套参数漂移） */
function resolveLlmTarget(req: LlmInvokeRequest): LlmTarget {
  const providers = getProviders()
  let provider: ProviderConfig | undefined
  let modelId = req.modelId ?? ''

  if (req.providerId) {
    provider = providers.find(x => x.id === req.providerId)
  } else if (!req.modelId && depsRef?.getSettingValue('defaultChatModel')) {
    const def = String(depsRef.getSettingValue('defaultChatModel'))
    const [pid, mid] = def.split(':')
    provider = providers.find(x => x.id === pid)
    modelId = mid ?? ''
  }
  if (!provider) return { ok: false, error: '未找到可用的模型供应商', code: req.providerId ? 'PROVIDER_NOT_FOUND' : 'NO_DEFAULT_MODEL' }
  if (!provider.enabled) return { ok: false, error: `供应商「${provider.name}」已禁用`, code: 'PROVIDER_DISABLED' }

  const maxTokensRaw = Math.floor(Number(depsRef?.getSettingValue('llmMaxTokens') ?? 4096))
  const maxTokens = Math.max(256, Math.min(32768, Number.isFinite(maxTokensRaw) ? maxTokensRaw : 4096))
  const finalModel = modelId || provider.models[0] || ''
  if (!finalModel) return { ok: false, error: '供应商未配置可用模型，请先刷新模型列表' }
  return { ok: true, provider, model: finalModel, maxTokens }
}

/**
 * B4 内联建议的默认模型解析（2026-09-20 反馈：默认跟随对话主模型，思考型会先思考一大段，
 * 「续写一句」等到天荒地老且白烧 token）。跟随默认链，但默认链命中思考型时降级到
 * 同供应商的**第一个非思考模型**；用户在设置 aiAssistantInlineSuggestModelId 钉死模型时
 * 本函数不会被调用（钉死优先级最高，不做任何替换）。全部模型都是思考型 → 保持原样，
 * 由 inlineSuggest 的思考早停兜底延迟。
 */
export function resolveInlineSuggestFallback(): { providerId: string; modelId: string } | null {
  const def = String(depsRef?.getSettingValue('defaultChatModel') ?? '').trim()
  if (!def) return null
  const [pid, mid = ''] = def.split(':')
  const provider = getProviders().find(x => x.id === pid && x.enabled)
  if (!provider) return null
  const target = mid || provider.models[0] || ''
  if (!target) return null
  if (!REASONING_MODEL_RE.test(target)) return { providerId: provider.id, modelId: target }
  const nonThinking = provider.models.find(m => !REASONING_MODEL_RE.test(m))
  return { providerId: provider.id, modelId: nonThinking ?? target }
}

/** 流式开关（设置项 aiStreamEnabled，缺省开）：关闭后退回非流式，功能不受损 */
function streamEnabled(): boolean {
  return depsRef?.getSettingValue('aiStreamEnabled') !== false
}

async function llmInvokeOnce(provider: ProviderConfig, model: string, req: LlmInvokeRequest, maxTokens: number): Promise<LlmInvokeResponse> {
  const adapter = adapterFor(provider, model)
  const started = Date.now()
  try {
    const r = await adapter.chat(provider, {
      model,
      messages: req.messages,
      tools: req.tools,
      maxTokens,
      effort: req.effort,
      signal: req.signal,
      sessionId: req.sessionId,
    })
    const trunc = interruptionOfStopReason(r.stopReason)
    appendAudit(provider.id, 'llm.invoke', {
      provider: provider.name,
      model,
      tokens: r.usage.promptTokens + r.usage.completionTokens,
      promptTokens: r.usage.promptTokens,
      completionTokens: r.usage.completionTokens,
      ...(r.usage.cachedTokens ? { cachedTokens: r.usage.cachedTokens } : {}),
      ...(trunc ? { code: trunc.code, stopReason: r.stopReason } : {}),
      durationMs: Date.now() - started,
      ok: true,
    })
    return {
      ok: true,
      content: r.content,
      toolCalls: r.toolCalls,
      assistantMessage: r.assistantMessage,
      model,
      tokens: r.usage.promptTokens + r.usage.completionTokens,
      promptTokens: r.usage.promptTokens,
      completionTokens: r.usage.completionTokens,
      ...(r.usage.cachedTokens ? { cachedTokens: r.usage.cachedTokens } : {}),
      ...(r.stopReason ? { stopReason: r.stopReason } : {}),
      ...(trunc ? { interruption: trunc } : {}),
    }
  } catch (err) {
    const raw = rawFromError(err, {
      externalAborted: req.signal?.aborted === true,
      providerId: provider.id, model, attempts: 1, elapsedMs: Date.now() - started,
    })
    const it = classifyFailure(raw)
    const detail = interruptionDetailOf(raw)
    // G10：审计不再只存 error 文本 —— 带上归因码才能按原因统计、才能度量「归因准不准」
    appendAudit(provider.id, 'llm.invoke', {
      provider: provider.name,
      model,
      durationMs: Date.now() - started,
      ok: false,
      code: it.code,
      matched: it.matched,
      ...(raw.httpStatus !== undefined ? { httpStatus: raw.httpStatus } : {}),
      ...(raw.upstreamCode ? { upstreamCode: raw.upstreamCode } : {}),
      error: String((err as Error)?.message ?? err).slice(0, 300),
    })
    return { ok: false, error: friendlyReason(it, detail), code: it.code, interruption: it, detail }
  }
}

async function llmInvoke(req: LlmInvokeRequest): Promise<LlmInvokeResponse> {
  const t = resolveLlmTarget(req)
  if (!t.ok) return { ok: false, error: t.error, code: t.code }

  const r = await llmInvokeOnce(t.provider, t.model, req, t.maxTokens)
  if (r.ok) return r
  // 故障转移（网关补强）：仅「默认模型路径」（用户未钉死供应商/模型）且**可重试**时，
  // 换一个可用供应商重试一次。流式路径不做（中途切换会造成内容拼接错乱）。
  // G9（归因 P0）：判据改用归因码的 retryable（唯一真源）—— 原 isProviderLevelError 正则漏了
  // net::ERR_NAME_NOT_RESOLVED / ERR_HTTP2_PROTOCOL_ERROR / 中文「流式响应超时」三类。
  if (req.providerId || req.modelId) return r
  if (!r.interruption?.retryable) return r
  const fallback = getProviders().find(p => p.enabled && p.id !== t.provider.id && p.models.length > 0)
  if (!fallback) return r
  const r2 = await llmInvokeOnce(fallback, fallback.models[0], req, t.maxTokens)
  if (!r2.ok) return r // 仍返回原始错误（fallback 失败细节已在审计）
  appendAudit(fallback.id, 'llm.fallback', { from: t.provider.name, to: fallback.name })
  return { ...r2, fallbackFrom: t.provider.name }
}

/**
 * 流式调用（docs/ai-streaming-design.md §5.1.5）。
 *
 * **返回值与 llmInvoke 完全同构** —— 调用方（AgentRunner）的回喂 / 审计 / trace / 落库
 * 逻辑一律不分叉；流式只是"在生成过程中额外发事件"。
 * 适配器未实现 chatStream、或设置里关闭了流式 → 自动回退非流式（content 一次性作为 text 事件发出）。
 */
export async function invokeLlmStreamInternal(
  req: LlmInvokeRequest,
  onEvent: (e: LlmStreamEvent) => void,
): Promise<LlmInvokeResponse> {
  const t = resolveLlmTarget(req)
  if (!t.ok) return { ok: false, error: t.error, code: t.code }
  const adapter = adapterFor(t.provider, t.model)

  if (!streamEnabled() || !adapter.chatStream) {
    const r = await llmInvoke(req)
    if (r.ok) {
      if (r.content) onEvent({ type: 'text', delta: r.content })
      onEvent({ type: 'usage', promptTokens: r.promptTokens, completionTokens: r.completionTokens, ...(r.cachedTokens ? { cachedTokens: r.cachedTokens } : {}) })
    }
    onEvent({ type: 'done' })
    return r
  }

  const started = Date.now()
  try {
    const r = await adapter.chatStream(t.provider, {
      model: t.model,
      messages: req.messages,
      tools: req.tools,
      maxTokens: t.maxTokens,
      effort: req.effort,
      signal: req.signal,
      sessionId: req.sessionId,
    }, onEvent)
    // G5 = B-29：上游停止原因是截断型（撞单次输出上限 / 未见结束帧）时，成功返回也要带提示与归因
    const trunc = interruptionOfStopReason(r.stopReason)
    const truncDetail = trunc
      ? interruptionDetailOf(rawFailure({
          layer: 'stream-eof',
          raw: `stopReason=${r.stopReason}`,
          partialChars: r.content.length,
          sawTerminator: r.stopReason !== STOP_REASON_NO_TERMINATOR,
          ...(r.stopReason ? { stopReason: r.stopReason } : {}),
          providerId: t.provider.id, model: t.model, attempts: 1, elapsedMs: Date.now() - started,
        }))
      : undefined
    appendAudit(t.provider.id, 'llm.invoke', {
      provider: t.provider.name,
      model: t.model,
      stream: true,
      tokens: r.usage.promptTokens + r.usage.completionTokens,
      promptTokens: r.usage.promptTokens,
      completionTokens: r.usage.completionTokens,
      ...(r.usage.cachedTokens ? { cachedTokens: r.usage.cachedTokens } : {}),
      ...(trunc ? { code: trunc.code, stopReason: r.stopReason } : {}),
      durationMs: Date.now() - started,
      ok: true,
    })
    return {
      ok: true,
      content: r.content,
      toolCalls: r.toolCalls,
      assistantMessage: r.assistantMessage,
      model: t.model,
      tokens: r.usage.promptTokens + r.usage.completionTokens,
      promptTokens: r.usage.promptTokens,
      completionTokens: r.usage.completionTokens,
      ...(r.usage.cachedTokens ? { cachedTokens: r.usage.cachedTokens } : {}),
      ...(r.stopReason ? { stopReason: r.stopReason } : {}),
      ...(trunc ? { interruption: trunc } : {}),
      ...(truncDetail ? { detail: truncDetail } : {}),
    }
  } catch (err) {
    // 归因 P0：**唯一**的失败归一入口 —— 四家适配器只负责「原生形状 → RawFailure」的翻译，
    // 码由 classifyFailure 产生、文案由 friendlyReason 产生（卡片 / 审计 / 重试判定读同一个码）。
    const raw = rawFromError(err, {
      externalAborted: req.signal?.aborted === true,
      providerId: t.provider.id, model: t.model, attempts: 1, elapsedMs: Date.now() - started,
    })
    const it = classifyFailure(raw)
    const detail = interruptionDetailOf(raw)
    appendAudit(t.provider.id, 'llm.invoke', {
      provider: t.provider.name,
      model: t.model,
      stream: true,
      durationMs: Date.now() - started,
      ok: false,
      code: it.code,
      matched: it.matched,
      receivedChunks: raw.receivedChunks,
      partialChars: raw.partialChars,
      sawTerminator: raw.sawTerminator,
      ...(raw.timedOut ? { timedOut: raw.timedOut } : {}),
      ...(raw.httpStatus !== undefined ? { httpStatus: raw.httpStatus } : {}),
      ...(raw.upstreamCode ? { upstreamCode: raw.upstreamCode } : {}),
      error: String((err as Error)?.message ?? err).slice(0, 300),
    })
    return { ok: false, error: friendlyReason(it, detail), code: it.code, interruption: it, detail }
  }
}

// ===== IPC =====

/** 账号信息的对外形状：**永不含密文**，渲染层只拿得到 hasKey（负向断言见 llm-accounts 契约） */
const sanitizeAccount = sanitizeAccountInfo

function sanitizeInfo(p: ProviderConfig, defaultChatModel: string) {
  const acct = activeAccountOf(p)
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    baseUrl: p.baseUrl,
    enabled: p.enabled,
    hasKey: !!acct?.keyEncrypted || (!p.accounts?.length && !!p.apiKeyEncrypted),
    models: p.models,
    /** 账号列表（端点内部的第二层）；切换当前账号不改任何模型 spec */
    accounts: (p.accounts ?? []).map(sanitizeAccount),
    activeAccountId: acct?.id ?? '',
    /** 端点整体可用（端点启用 且 至少一个账号可用）—— 模型选择器据此收候选 */
    usable: providerUsable(p),
    /** 逐模型协议覆盖（渲染层据此显示协议标记；未列出的跟随 type） */
    modelFamilies: p.modelFamilies ?? {},
    headers: p.headers ?? {},
    embeddingModel: p.embeddingModel ?? '',
    isDefault: defaultChatModel.startsWith(`${p.id}:`),
  }
}

/** 保存供应商（校验 + Key 即时加密落盘）；IPC 与 CC Switch 导入共用 */
function saveProviderDraft(draft: {
  id?: string; name: string; type: ProviderType; baseUrl: string; apiKey?: string; enabled?: boolean
  headers?: Record<string, string>
  modelFamilies?: Record<string, ModelFamily>
  embeddingModel?: string
}): { ok: boolean; id?: string; error?: string } {
  if (!draft || typeof draft.name !== 'string' || !draft.name.trim()) return { ok: false, error: '名称不能为空' }
  if (!['openai-compatible', 'ollama', 'anthropic', 'openai-responses'].includes(draft.type)) return { ok: false, error: '不支持的类型' }
  const urlCheck = validateProviderUrl(String(draft.baseUrl ?? ''))
  if (!urlCheck.ok) return { ok: false, error: urlCheck.error }
  // 自定义请求头校验：扁平 string→string 对象（opencode 网关的 x-opencode-session 等路由头）
  let headers: Record<string, string> | undefined
  if (draft.headers != null) {
    if (typeof draft.headers !== 'object' || Array.isArray(draft.headers)) return { ok: false, error: '自定义请求头必须是 JSON 对象（{"头名":"值"}）' }
    const bad = Object.entries(draft.headers).find(([k, v]) => !k.trim() || typeof v !== 'string')
    if (bad) return { ok: false, error: '自定义请求头格式非法（键值需为非空字符串）' }
    headers = Object.fromEntries(Object.entries(draft.headers).map(([k, v]) => [k.trim(), v]))
  }
  // 逐模型协议覆盖校验：只收 chat / messages / responses 三值（其余视为非法，不静默吞掉）
  let modelFamilies: Record<string, ModelFamily> | undefined
  if (draft.modelFamilies != null) {
    if (typeof draft.modelFamilies !== 'object' || Array.isArray(draft.modelFamilies)) {
      return { ok: false, error: '模型协议映射必须是 JSON 对象（{"模型ID":"chat|messages|responses"}）' }
    }
    const entries = Object.entries(draft.modelFamilies)
    const badKey = entries.find(([k]) => !k.trim())
    if (badKey) return { ok: false, error: '模型协议映射的键不能为空' }
    const badVal = entries.find(([, v]) => !['chat', 'messages', 'responses'].includes(String(v)))
    if (badVal) return { ok: false, error: `模型「${badVal[0]}」的协议只能是 chat / messages / responses` }
    modelFamilies = entries.length > 0
      ? Object.fromEntries(entries.map(([k, v]) => [k.trim(), v as ModelFamily]))
      : undefined
  }

  const list = getProviders()
  let p = draft.id ? list.find(x => x.id === draft.id) : undefined
  if (!p) {
    p = { id: randomUUID(), name: '', type: draft.type, baseUrl: '', apiKeyEncrypted: '', enabled: true, models: [] }
    list.push(p)
  }
  p.name = draft.name.trim()
  p.type = draft.type
  p.baseUrl = urlCheck.url
  p.headers = headers
  // 未传 modelFamilies（= undefined）时保留原值：设置页编辑名称/地址/Key 不会顺手清掉协议标记。
  // 要清空就显式传 {}（渲染层「清除全部协议标记」走这条）。
  if (draft.modelFamilies !== undefined) p.modelFamilies = modelFamilies
  p.embeddingModel = typeof draft.embeddingModel === 'string' && draft.embeddingModel.trim() ? draft.embeddingModel.trim() : undefined
  if (typeof draft.apiKey === 'string' && draft.apiKey.length > 0) {
    const enc = encryptSecret(draft.apiKey) // 明文只在此瞬间存在，随即加密
    p.apiKeyEncrypted = enc // 兼容镜像：旧读法仍能拿到当前账号的 Key
    const acct = activeAccountOf(p)
    if (acct) acct.keyEncrypted = enc
    else {
      const id = randomUUID()
      p.accounts = [{ id, name: '默认', keyEncrypted: enc, enabled: true }]
      p.activeAccountId = id
    }
  }
  depsRef?.setSettingValue('modelProviders', JSON.stringify(list))
  return { ok: true, id: p.id }
}

export function registerLlmHandlers(deps: {
  getSettingValue: (key: string) => unknown
  setSettingValue: (key: string, value: unknown) => boolean
}): void {
  depsRef = deps
  bindCcSwitchSaver(d => saveProviderDraft(d))

  ipcMain.handle('llm:listProviders', () => {
    const d = String(deps.getSettingValue('defaultChatModel') ?? '')
    return { providers: getProviders().map(p => sanitizeInfo(p, d)), defaultChatModel: d }
  })

  ipcMain.handle('llm:saveProvider', (_e, draft: {
    id?: string; name: string; type: ProviderType; baseUrl: string; apiKey?: string; enabled?: boolean
    headers?: Record<string, string>
    modelFamilies?: Record<string, ModelFamily>
    embeddingModel?: string
  }) => saveProviderDraft(draft))

  ipcMain.handle('llm:ccswitch:list', () => scanCcSwitch())

  ipcMain.handle('llm:ccswitch:import', (_e, ids: string[]) => {
    if (!Array.isArray(ids)) return { imported: 0, skipped: 0, errors: ['参数非法'] }
    return importCcSwitchIds(ids.map(String))
  })

  ipcMain.handle('llm:removeProvider', (_e, id: string) => {
    const list = getProviders().filter(x => x.id !== id)
    deps.setSettingValue('modelProviders', JSON.stringify(list))
    const def = String(deps.getSettingValue('defaultChatModel') ?? '')
    if (def.startsWith(`${id}:`)) deps.setSettingValue('defaultChatModel', '')
    return { ok: true }
  })

  ipcMain.handle('llm:toggleProvider', (_e, id: string, enabled: boolean) => {
    const list = getProviders()
    const p = list.find(x => x.id === id)
    if (!p) return { ok: false, error: '供应商不存在' }
    p.enabled = Boolean(enabled)
    deps.setSettingValue('modelProviders', JSON.stringify(list))
    return { ok: true }
  })

  // ===== 账号（端点内部的第二层，2026-10-13 按原型落地）=====

  /** 加一个账号：同一端点换一把 Key（地址 / 协议 / 请求头 / 模型清单全部复用） */
  ipcMain.handle('llm:addAccount', (_e, payload: { providerId: string; name?: string; apiKey?: string }) => {
    const list = getProviders()
    const p = list.find(x => x.id === payload?.providerId)
    if (!p) return { ok: false, error: '供应商不存在' }
    const key = String(payload?.apiKey ?? '').trim()
    if (!key && p.type !== 'ollama') return { ok: false, error: '请粘贴这个账号的 API Key' }
    const name = String(payload?.name ?? '').trim()
    const acct = appendAccount(p, { name, keyEncrypted: key ? encryptSecret(key) : '' }, randomUUID)
    saveProviders(list)
    return { ok: true, id: acct.id, accounts: (p.accounts ?? []).map(sanitizeAccount), activeAccountId: acct.id }
  })

  /**
   * 切换当前账号。**只改 activeAccountId** —— 模型 spec 指向端点 id，所以 5 处模型槽位
   * 一处都不用改（这正是"账号做成端点内部第二层"的全部理由，契约里有负向断言锁）。
   */
  ipcMain.handle('llm:setActiveAccount', (_e, providerId: string, accountId: string) => {
    const list = getProviders()
    const p = list.find(x => x.id === providerId)
    if (!p) return { ok: false, error: '供应商不存在' }
    const acct = (p.accounts ?? []).find(a => a.id === accountId)
    if (!acct) return { ok: false, error: '账号不存在' }
    p.activeAccountId = acct.id
    p.apiKeyEncrypted = acct.keyEncrypted // 兼容镜像
    saveProviders(list)
    return { ok: true, activeAccountId: acct.id }
  })

  /** 改账号：重命名 / 换 Key（重输）/ 启用停用。只传要改的字段。 */
  ipcMain.handle('llm:updateAccount', (_e, payload: { providerId: string; accountId: string; name?: string; apiKey?: string; enabled?: boolean }) => {
    const list = getProviders()
    const p = list.find(x => x.id === payload?.providerId)
    if (!p) return { ok: false, error: '供应商不存在' }
    const acct = (p.accounts ?? []).find(a => a.id === payload?.accountId)
    if (!acct) return { ok: false, error: '账号不存在' }
    if (typeof payload.name === 'string' && payload.name.trim()) acct.name = payload.name.trim()
    if (typeof payload.enabled === 'boolean') acct.enabled = payload.enabled
    if (typeof payload.apiKey === 'string' && payload.apiKey.length > 0) {
      acct.keyEncrypted = encryptSecret(payload.apiKey)
    }
    if (acct.id === p.activeAccountId) p.apiKeyEncrypted = acct.keyEncrypted
    saveProviders(list)
    return { ok: true, accounts: (p.accounts ?? []).map(sanitizeAccount) }
  })

  /** 删账号与它的 Key；删掉的若是当前账号，自动切到剩下的第一个 */
  ipcMain.handle('llm:removeAccount', (_e, providerId: string, accountId: string) => {
    const list = getProviders()
    const p = list.find(x => x.id === providerId)
    if (!p) return { ok: false, error: '供应商不存在' }
    if (!removeAccount(p, accountId)) return { ok: false, error: '账号不存在' }
    saveProviders(list)
    return { ok: true, accounts: (p.accounts ?? []).map(sanitizeAccount), activeAccountId: p.activeAccountId ?? '' }
  })

  /** 测试指定账号（用它的 Key 真拉一次 /models），结果记回账号行供界面显示 */
  ipcMain.handle('llm:testAccount', async (_e, providerId: string, accountId: string) => {
    const list = getProviders()
    const p = list.find(x => x.id === providerId)
    if (!p) return { ok: false, error: '供应商不存在', latencyMs: 0 }
    const acct = (p.accounts ?? []).find(a => a.id === accountId)
    if (!acct) return { ok: false, error: '账号不存在', latencyMs: 0 }
    // 只把这一把 Key 交给适配器：accounts 收成单元素 + 它的 id 设为当前
    const scoped: ProviderConfig = { ...p, accounts: [acct], activeAccountId: acct.id }
    const started = Date.now()
    try {
      const models = await getAdapter(scoped.type).listModels(scoped)
      acct.lastLatencyMs = Date.now() - started
      acct.lastTestedAt = new Date().toISOString()
      saveProviders(list)
      return { ok: true, latencyMs: acct.lastLatencyMs, models }
    } catch (err) {
      acct.lastLatencyMs = Date.now() - started
      acct.lastTestedAt = new Date().toISOString()
      saveProviders(list)
      return { ok: false, latencyMs: acct.lastLatencyMs, error: String((err as Error)?.message ?? err) }
    }
  })

  ipcMain.handle('llm:testConnection', async (_e, draft: { type: ProviderType; baseUrl: string; apiKey?: string; id?: string; headers?: Record<string, string>; accountId?: string }) => {
    const urlCheck = validateProviderUrl(String(draft?.baseUrl ?? ''))
    if (!urlCheck.ok) return { ok: false, error: urlCheck.error, latencyMs: 0 }
    // 传 id（服务商卡片测试）= 用存档 Key 与自定义头测——裸测不带鉴权，对要求鉴权的
    // 网关必然 401（2026-09-08 用户实锤）。添加表单无 id，用表单明文 apiKey/headers。
    // 传 accountId（2026-10-13）= 测**指定账号**那把 Key，而不是当前账号。
    const saved = draft?.id ? getProviders().find(x => x.id === draft.id) : undefined
    let scoped = saved
    if (saved && draft.accountId) {
      const a = (saved.accounts ?? []).find(x => x.id === draft.accountId)
      if (a) scoped = { ...saved, accounts: [a], activeAccountId: a.id }
    }
    const temp: ProviderConfig = scoped
      ? { ...scoped, headers: { ...(scoped.headers ?? {}), ...(draft.headers ?? {}) } }
      : {
          id: '__test__', name: 'test', type: draft.type, baseUrl: urlCheck.url,
          apiKeyEncrypted: typeof draft.apiKey === 'string' && draft.apiKey ? encryptSecret(draft.apiKey) : '',
          enabled: true, models: [], headers: draft.headers,
        }
    const started = Date.now()
    try {
      const models = await getAdapter(temp.type).listModels(temp)
      return { ok: true, latencyMs: Date.now() - started, models }
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: String((err as Error)?.message ?? err) }
    }
  })

  // 模型级可用性测试:与 testConnection 的「列表接口探活」不同——模型可能未开通/无权限/
  // ID 拼写错误,只有对指定模型真实完成一次最小补全(max_tokens=1)才算可用
  ipcMain.handle('llm:testModel', async (_e, payload: { providerId: string; model: string }) => {
    const p = getProviders().find(x => x.id === payload?.providerId)
    if (!p) return { ok: false, error: '供应商不存在', latencyMs: 0 }
    const model = String(payload?.model ?? '').trim()
    if (!model) return { ok: false, error: '模型 ID 不能为空', latencyMs: 0 }
    if (!p.enabled) return { ok: false, error: '供应商已禁用', latencyMs: 0 }
    const started = Date.now()
    try {
      const res = await adapterFor(p, model).chat(p, {
        model,
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 1,
      })
      return { ok: true, latencyMs: Date.now() - started, replyPreview: String(res.content ?? '').replace(/\s+/g, ' ').slice(0, 40) }
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: String((err as Error)?.message ?? err) }
    }
  })

  // P3b：模型思考强度能力探测（正则单一真相源在主进程，渲染层据此置灰菜单）
  ipcMain.handle('llm:reasoningCapable', (_e, model: string) => REASONING_MODEL_RE.test(String(model ?? '')))

  ipcMain.handle('llm:visionCapable', (_e, model: string) => VISION_MODEL_RE.test(String(model ?? '')))

  // 视觉模型清单（2026-09-08）：按 VISION_MODEL_RE 过滤出能胜任图片输入的模型——
  // 视觉转写模型选择列表只显示这些，非视觉模型不再出现
  ipcMain.handle('llm:visionModels', () => {
    const models: Array<{ spec: string; providerName: string; model: string }> = []
    for (const p of getProviders().filter(p => providerUsable(p) && p.type === 'openai-compatible')) {
      for (const m of p.models) {
        if (VISION_MODEL_RE.test(m)) models.push({ spec: `${p.id}:${m}`, providerName: p.name, model: m })
      }
    }
    return { models }
  })

  ipcMain.handle('llm:refreshModels', async (_e, id: string) => {
    const list = getProviders()
    const p = list.find(x => x.id === id)
    if (!p) return { ok: false, error: '供应商不存在', models: [] }
    try {
      const models = await getAdapter(p.type).listModels(p)
      p.models = models
      // 顺手清掉已不在清单里的协议覆盖（模型下架后残留的映射会让 familyOf 永远查不到）
      if (p.modelFamilies) {
        const keep = Object.fromEntries(Object.entries(p.modelFamilies).filter(([m]) => models.includes(m)))
        p.modelFamilies = Object.keys(keep).length > 0 ? keep : undefined
      }
      deps.setSettingValue('modelProviders', JSON.stringify(list))
      return { ok: true, models }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err), models: [] }
    }
  })

  /** 逐模型协议覆盖（设置页的协议标记）。family 传空 = 清除覆盖，跟随供应商默认协议。 */
  ipcMain.handle('llm:setModelFamily', (_e, id: string, model: string, family: string) => {
    const list = getProviders()
    const p = list.find(x => x.id === id)
    if (!p) return { ok: false, error: '供应商不存在' }
    const m = String(model ?? '').trim()
    if (!m) return { ok: false, error: '模型 ID 不能为空' }
    if (family && !['chat', 'messages', 'responses'].includes(family)) return { ok: false, error: '协议值非法' }
    const next: Record<string, ModelFamily> = { ...(p.modelFamilies ?? {}) }
    if (family) next[m] = family as ModelFamily
    else delete next[m]
    p.modelFamilies = Object.keys(next).length > 0 ? next : undefined
    deps.setSettingValue('modelProviders', JSON.stringify(list))
    return { ok: true, modelFamilies: p.modelFamilies ?? {} }
  })

  ipcMain.handle('llm:addModel', (_e, id: string, model: string) => {
    const list = getProviders()
    const p = list.find(x => x.id === id)
    if (!p) return { ok: false, error: '供应商不存在', models: [] }
    const m = String(model ?? '').trim()
    if (!m) return { ok: false, error: '模型 ID 不能为空', models: [] }
    if (!p.models.includes(m)) p.models.push(m)
    deps.setSettingValue('modelProviders', JSON.stringify(list))
    return { ok: true, models: p.models }
  })

  ipcMain.handle('llm:setDefaultModel', (_e, value: string) => {
    if (typeof value !== 'string') return { ok: false, error: '参数非法' }
    deps.setSettingValue('defaultChatModel', value)
    return { ok: true }
  })

  ipcMain.handle('llm:invoke', (_e, req: LlmInvokeRequest) => llmInvoke(req))

  ipcMain.handle('llm:getUsage', () => {
    const split = countMonthLlmTokensSplit()
    return {
      monthTokens: countMonthLlmTokens(),
      monthPromptTokens: split.promptTokens,
      monthCompletionTokens: split.completionTokens,
      visionMonthTokens: countMonthVisionTokens(),
      visionPages: countMonthVisionPages(),
    }
  })
  // 用量细分（网关补强）：本月按供应商/模型聚合（审计数据源，只读）
  ipcMain.handle('llm:usageBreakdown', () => summarizeMonthLlmUsage())
}

/** 供 agentService 复用（不经 IPC） */
export function invokeLlmInternal(req: LlmInvokeRequest): Promise<LlmInvokeResponse> {
  return llmInvoke(req)
}

/** 兜底模型：第一个启用供应商的第一个模型（当既无本对话模型、也无全局 defaultChatModel 时给一次性调用用） */
export function firstEnabledModelSpec(): { providerId: string; modelId: string } | null {
  for (const p of getProviders()) {
    if (!p.enabled) continue
    const m = p.models.find(Boolean)
    if (m) return { providerId: p.id, modelId: m }
  }
  return null
}

// ===== 视觉转写（AI教学 3-21）：多模态一次性调用，不经过会话消息管线 =====

/** 视觉能力启发式（同 reasoningCapable 哲学：名字猜测，真不支持由 API 报错兜底） */
export const VISION_MODEL_RE = /(vision|\bvl\b|-vl[-._]|vl[-._]?\d|4o|omni|multimodal|glm-4v|gemini|claude-(|\d)|kimi.*vision)/i

export interface VisionChatRequest {
  /** 'providerId:modelId'；缺省 = 自动在启用的 openai-compatible 供应商里找视觉模型 */
  modelSpec?: string
  system: string
  prompt: string
  /** 页面位图（dataURL, image/jpeg|png） */
  images: string[]
  maxTokens?: number
  signal?: AbortSignal
  /** 会话标识（x-opencode-session）：同一次素材转写传同一个值，保持路由/缓存稳定 */
  sessionId?: string
}

export interface VisionChatResponse { ok: boolean; text?: string; model?: string; providerName?: string; tokens?: number; error?: string }

/** 找一个疑似支持图片的模型（仅 openai-compatible——visionChat 的线格式为 OpenAI 多模态） */
export function findVisionModel(preferredSpec?: string): { provider: ProviderConfig; model: string } | null {
  const providers = getProviders().filter(p => p.enabled && p.type === 'openai-compatible')
  if (preferredSpec) {
    const [pid, mid] = preferredSpec.split(':')
    const p = providers.find(x => x.id === pid)
    if (p && mid) return { provider: p, model: mid }
  }
  for (const p of providers) {
    const m = p.models.find(x => VISION_MODEL_RE.test(x))
    if (m) return { provider: p, model: m }
  }
  return null
}

/** 视觉转写主进程入口（AI教学素材库）：OpenAI 多模态 content 数组直通 adapter */export async function visionChat(req: VisionChatRequest): Promise<VisionChatResponse> {
  const found = findVisionModel(req.modelSpec)
  if (!found) return { ok: false, error: '未找到可用的视觉模型：请在设置→模型供应商 配置支持图片的模型（如 qwen-vl / glm-4v / gpt-4o / kimi-latest，openai-compatible 类型）' }
  const content: unknown[] = [
    { type: 'text', text: `${req.prompt}\n（共 ${req.images.length} 页图片，按给出顺序对应页码列表）` },
    ...req.images.map(u => ({ type: 'image_url', image_url: { url: u } })),
  ]
  const messages: { role: 'system' | 'user'; content: unknown }[] = [
    { role: 'system', content: req.system },
    { role: 'user', content },
  ]
  try {
    // 视觉转写固定走 OpenAI 多模态线格式（chat/completions 的 content 数组），
    // 因此**不**按模型协议族分派 —— 即便该模型被标成 responses，这里也只认 chat 线格式
    const r = await openAiCompatibleAdapter.chat(found.provider, {
      model: found.model,
      // OpenAI 多模态 content 数组（image_url 部件）：adapter 原样透传线上格式，类型面在此收口
      messages: messages as unknown as ChatMessage[],
      maxTokens: Math.max(1024, Math.min(16384, Math.floor(req.maxTokens ?? 8192))),
      signal: req.signal,
      sessionId: req.sessionId,
    })
    const totalTokens = (r.usage?.promptTokens ?? 0) + (r.usage?.completionTokens ?? 0)
    return { ok: true, text: String(r.content ?? ''), model: found.model, providerName: found.provider.name, tokens: totalTokens }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e), model: found.model }
  }
}
