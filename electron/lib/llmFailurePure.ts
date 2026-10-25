/**
 * LLM 失败「采集 → 归一」唯一真源（2026-10-14，归因 P0）。
 * 方案：docs/agent-error-attribution-plan.md（§2.1 数据形状 / §2.2 优先级 / §2.3 码表 / §7.1 契约）。
 *
 * 零依赖（不 import electron、不 import node 内置），供
 * .AGENT/scripts/llm-adapters/verify-llm-attribution.mjs 直接用 node 跑真断言。
 *
 * 三层：
 *   ① RawFailure —— 失败那一刻**可观测的事实**（由采集点填，不含推断）
 *   ② classifyFailure(raw) → Interruption —— 码 / 证据强度 / 可续 / 可重试 / 建议动作
 *   ③ friendlyReason / suggestedActionText / buildDiagnostics —— 呈现（卡片正文 / 按钮 / 诊断块）
 *
 * 唯一真源原则：码只在本文件产生。中断卡文案、B 的重试判定（retryable）、审计统计、
 * 会话角标（resumable）全读同一处 —— 今天「文案各写各的」正是归因漂移的根源。
 */

// ===== ① 采集：失败那一刻的事实 =====

/** 失败发生在哪一层（决定「能不能写因果」的一半） */
export type FailureLayer =
  | 'transport'
  | 'http'
  | 'stream-frame'
  | 'stream-eof'
  | 'agent-loop'
  | 'tool'
  | 'renderer-ipc'

/**
 * 采集面：**全部来自可观测量**（HTTP 状态、上游错误体、传输层错误名、收到几段数据、计时）。
 * 采集点就地构造，不给推断留位置 —— 推断只在 ② 里由判据顺序决定。
 */
export interface RawFailure {
  /** 哪个环节出错 */
  layer: FailureLayer
  /** 传输层原始错误名（如 net::ERR_CONNECTION_RESET）或抛出的 Error.message */
  raw: string
  httpStatus?: number
  /** 上游错误体里的机器可读码（OpenAI error.code/type、Anthropic error.type、Ollama error 文本归一） */
  upstreamCode?: string
  /** 上游错误体原话（截 300，给「复制诊断信息」用） */
  upstreamMessage?: string
  /** 是否外部 signal 已 abort（用户点停止）。**优先级最高**，与超时同时命中仍是它 */
  externalAborted: boolean
  /** 超时：'connect'（响应头都没回来）| 'first-byte' | 'idle'（靠下面两位判定，不靠文案） */
  timedOut?: 'connect' | 'first-byte' | 'idle'
  /** ★ 关键判据：收到过几个数据段（sa.chunk() 调用次数，四家适配器各一处） */
  receivedChunks: number
  /** ★ 已产出多少字符（content.length / text.length） */
  partialChars: number
  /** 是否见过正常结束帧（[DONE] / message_stop / done / response.completed） */
  sawTerminator: boolean
  /** 上游给的停止原因（finish_reason / stop_reason / done_reason / 内部标记 'no-terminator'） */
  stopReason?: string
  /** 循环侧归属（agentService 的中断出口标注）：有值即优先于传输类判据 */
  loop?: 'round-cap' | 'token-budget' | 'summary-failed'
  /** 循环侧补充 */
  round?: number
  runTokens?: number
  attempts?: number
  providerId?: string
  model?: string
  elapsedMs: number
}

/** 采集缺省值填充（采集点只写自己知道的那几项） */
export function rawFailure(base: Partial<RawFailure> & { layer: FailureLayer; raw: string }): RawFailure {
  return {
    externalAborted: false,
    receivedChunks: 0,
    partialChars: 0,
    sawTerminator: false,
    elapsedMs: 0,
    ...base,
  }
}

// ===== ② 归一：码表与判据 =====

/**
 * 原因码（25 个，顺序即契约比对顺序）。
 * ★ 与 src/types/index.ts 的镜像**必须逐字一致**（契约脚本按源码文本比对两份清单）。
 */
export const INTERRUPT_CODES = [
  // 用户 / 策略
  'USER_ABORTED', 'AGENT_ROUND_CAP', 'AGENT_TOKEN_BUDGET', 'AGENT_SUMMARY_FAILED', 'AGENT_WRITE_CAP',
  // 鉴权与额度
  'LLM_AUTH', 'LLM_QUOTA_EXHAUSTED', 'LLM_RATE_LIMIT', 'LLM_MODEL_NOT_FOUND', 'LLM_PROTOCOL_MISMATCH',
  // 请求本身
  'LLM_CONTEXT_OVERFLOW', 'LLM_BAD_REQUEST', 'LLM_OUTPUT_TRUNCATED',
  // 上游可用性
  'LLM_UPSTREAM_5XX', 'LLM_OVERLOADED', 'LLM_PROVIDER_ERROR_FRAME',
  // 传输
  'LLM_CONNECT_FAILED', 'LLM_CONNECT_TIMEOUT', 'LLM_NET_RESET', 'LLM_DNS_FAILED',
  'LLM_FIRST_BYTE_TIMEOUT', 'LLM_IDLE_TIMEOUT', 'LLM_STREAM_TRUNCATED', 'LLM_UNKNOWN',
  // 程序自身
  'INTERNAL_EXCEPTION',
] as const

export type InterruptCode = (typeof INTERRUPT_CODES)[number]

/** 证据强度：决定「能不能写因果」——这是「不猜」的机械保障 */
export type InterruptionEvidence =
  | 'provider-body'
  | 'http-status'
  | 'transport-error'
  | 'timing'
  | 'inferred'

/** 建议动作（UI 据此出按钮 / 文案） */
export type InterruptionAction =
  | 'resume'
  | 'retry'
  | 'switch-model'
  | 'check-key'
  | 'top-up'
  | 'wait'
  | 'shrink-context'
  | 'new-session'
  | 'report-bug'
  | 'none'

export interface Interruption {
  code: InterruptCode
  evidence: InterruptionEvidence
  /** 可续跑？（只要有现场，任何中断都能「继续」；例外只有「会话已删 / 无仓库」这类外部条件） */
  resumable: boolean
  /** 可重试？B 的重试表直接读这里，不再各写一套正则 */
  retryable: boolean
  action: InterruptionAction
  /** 归一码的判据来源，给「复制诊断信息」用 */
  matched: string
}

/** 诊断细节（「复制诊断信息」的数据源；**不含正文、不含 Key**） */
export interface InterruptionDetail {
  /** 原始错误串（截 300；诊断块 +「内部异常：<类名>」用） */
  raw: string
  httpStatus?: number
  upstreamCode?: string
  upstreamMessage?: string
  /** 收到几段数据（截断场景在入口层拿不到，故可缺省 —— **宁缺勿编**） */
  receivedChunks?: number
  partialChars: number
  sawTerminator: boolean
  stopReason?: string
  round?: number
  runTokens?: number
  attempts?: number
  providerId?: string
  model?: string
  elapsedMs: number
}

interface CodeTraits {
  resumable: boolean
  retryable: boolean
  action: InterruptionAction
}

/**
 * 三列联动（可续 / 可重试 / 建议动作）—— 与方案 §2.3 表逐行一致，契约脚本逐条比对。
 * `可续` 全 true 是刻意的（见方案 §2.3 注）。
 */
export const INTERRUPT_CODE_TABLE: Record<InterruptCode, CodeTraits> = {
  USER_ABORTED: { resumable: true, retryable: false, action: 'resume' },
  AGENT_ROUND_CAP: { resumable: true, retryable: false, action: 'resume' },
  AGENT_TOKEN_BUDGET: { resumable: true, retryable: false, action: 'resume' },
  AGENT_SUMMARY_FAILED: { resumable: true, retryable: false, action: 'resume' },
  AGENT_WRITE_CAP: { resumable: true, retryable: false, action: 'none' },
  LLM_AUTH: { resumable: true, retryable: false, action: 'check-key' },
  LLM_QUOTA_EXHAUSTED: { resumable: true, retryable: false, action: 'top-up' },
  LLM_RATE_LIMIT: { resumable: true, retryable: true, action: 'wait' },
  LLM_MODEL_NOT_FOUND: { resumable: true, retryable: false, action: 'switch-model' },
  LLM_PROTOCOL_MISMATCH: { resumable: true, retryable: false, action: 'switch-model' },
  LLM_CONTEXT_OVERFLOW: { resumable: true, retryable: false, action: 'shrink-context' },
  LLM_BAD_REQUEST: { resumable: true, retryable: false, action: 'switch-model' },
  LLM_OUTPUT_TRUNCATED: { resumable: true, retryable: false, action: 'resume' },
  LLM_UPSTREAM_5XX: { resumable: true, retryable: true, action: 'retry' },
  LLM_OVERLOADED: { resumable: true, retryable: true, action: 'retry' },
  LLM_PROVIDER_ERROR_FRAME: { resumable: true, retryable: true, action: 'retry' },
  LLM_CONNECT_FAILED: { resumable: true, retryable: true, action: 'retry' },
  LLM_CONNECT_TIMEOUT: { resumable: true, retryable: true, action: 'retry' },
  LLM_NET_RESET: { resumable: true, retryable: true, action: 'retry' },
  LLM_DNS_FAILED: { resumable: true, retryable: true, action: 'retry' },
  LLM_FIRST_BYTE_TIMEOUT: { resumable: true, retryable: true, action: 'retry' },
  LLM_IDLE_TIMEOUT: { resumable: true, retryable: true, action: 'resume' },
  LLM_STREAM_TRUNCATED: { resumable: true, retryable: true, action: 'retry' },
  LLM_UNKNOWN: { resumable: true, retryable: true, action: 'retry' },
  INTERNAL_EXCEPTION: { resumable: true, retryable: false, action: 'report-bug' },
}

// ---- 判据词表（只认「码 + status」为主、文本特征为辅；未知一律落 LLM_UNKNOWN 并保留原话） ----

const RE_DNS = /ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ENOTFOUND|EAI_AGAIN/i
const RE_RESET = /ERR_CONNECTION_RESET|ERR_HTTP2_PROTOCOL_ERROR|ERR_HTTP2|ECONNRESET|ECONNABORTED|EPIPE|socket hang up/i
const RE_CONNECT_TIMEOUT = /ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ETIMEDOUT/i
const RE_REFUSED = /ERR_CONNECTION_REFUSED|ERR_CONNECTION_CLOSED|ECONNREFUSED|ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ENETUNREACH|EHOSTUNREACH/i
const RE_TIMEOUT_TEXT = /流式响应超时|timed?\s*out|超时|timeout/i
const RE_TRANSPORTISH = /net::|ERR_[A-Z_]+|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|socket hang up|The operation was aborted|网络|连接/i
const RE_CONTEXT_OVERFLOW = /context_length_exceeded|maximum context length|too many tokens|prompt is too long|reduce the length|上下文.{0,6}超|超.{0,6}上下文/i
const RE_AUTH = /invalid_api_key|authentication_error|invalid_token|unauthorized|鉴权失败/i
const RE_QUOTA = /insufficient_quota|billing_hard_limit_reached|exceeded your current quota|额度|欠费/i
const RE_RATE = /rate_limit_exceeded|rate.?limit|too many requests|限频|429/i
const RE_OVERLOAD = /overloaded_error|overloaded|过载/i
// 模型不存在：模型名可以夹在中间（实测上游原话 The model `gpt-x` does not exist），也认 Ollama 的 model "x" not found
const RE_MODEL_NOT_FOUND = /model[^\n]{0,60}?(not found|does not exist|doesn't exist)|(model|模型)[^\n]{0,10}?(不存在|未拉取|未找到)|no such model|unknown model/i
const RE_ENDPOINT_MISMATCH = /接口路径|路径不存在|base ?url|endpoint|供应商类型|protocol/i

/** 「不猜」词表：timing / inferred 的证据禁用因果词（契约负向断言逐条锁） */
export const CAUSAL_WORDS = ['网络不通', '服务繁忙', '你的网络', '服务器崩了']

export function hasCausalWord(text: string): boolean {
  return CAUSAL_WORDS.some(w => text.includes(w))
}

function mk(code: InterruptCode, evidence: InterruptionEvidence, matched: string): Interruption {
  const t = INTERRUPT_CODE_TABLE[code]
  return { code, evidence, resumable: t.resumable, retryable: t.retryable, action: t.action, matched }
}

/** 上游原话（status 之外的一切可读文本） */
function upstreamText(raw: RawFailure): string {
  return `${raw.upstreamMessage ?? ''} ${raw.raw ?? ''}`
}

/**
 * ② 唯一入口：**从上往下第一条命中即为结果**。
 * 顺序本身就是正确性 —— 例：用户停止即使同时超时也必须判 USER_ABORTED。
 * 纯函数、无副作用、无 IO。
 */
export function classifyFailure(raw: RawFailure): Interruption {
  const msg = upstreamText(raw)
  const status = typeof raw.httpStatus === 'number' ? raw.httpStatus : undefined
  const ucode = String(raw.upstreamCode ?? '').toLowerCase()

  // 1. 用户停止（优先级最高；B 的 shouldRetry 直接复用 → 永不重试）
  if (raw.externalAborted) return mk('USER_ABORTED', 'transport-error', 'externalAborted=true')

  // 2. 循环侧（轮数 / token 预算 / 收场总结失败）
  if (raw.loop === 'round-cap') return mk('AGENT_ROUND_CAP', 'inferred', 'loop=round-cap')
  if (raw.loop === 'token-budget') return mk('AGENT_TOKEN_BUDGET', 'inferred', 'loop=token-budget')
  if (raw.loop === 'summary-failed') return mk('AGENT_SUMMARY_FAILED', 'inferred', 'loop=summary-failed')

  // 3. 程序自身异常（渲染层 IPC / 工具执行器 / 非网络串的循环异常）
  if (raw.layer === 'renderer-ipc' || raw.layer === 'tool') {
    return mk('INTERNAL_EXCEPTION', 'transport-error', `layer=${raw.layer}`)
  }
  if (raw.layer === 'agent-loop' && !RE_TRANSPORTISH.test(raw.raw ?? '')) {
    return mk('INTERNAL_EXCEPTION', 'transport-error', 'layer=agent-loop & 非传输类串')
  }

  // 4. 鉴权
  if (status === 401 || status === 403 || ['invalid_api_key', 'authentication_error', 'invalid_token', 'unauthorized'].includes(ucode)) {
    return mk('LLM_AUTH', 'http-status', `httpStatus=${status ?? '-'} upstreamCode=${ucode || '-'}`)
  }
  if (RE_AUTH.test(msg)) return mk('LLM_AUTH', 'provider-body', '上游原话命中鉴权词')

  // 5. 额度
  if (status === 402 || ['insufficient_quota', 'billing_hard_limit_reached'].includes(ucode)) {
    return mk('LLM_QUOTA_EXHAUSTED', 'http-status', `httpStatus=${status ?? '-'} upstreamCode=${ucode || '-'}`)
  }
  if (RE_QUOTA.test(msg)) return mk('LLM_QUOTA_EXHAUSTED', 'provider-body', '上游原话命中额度词')

  // 6. 上下文超窗（可判据：上游给码或给原话，不靠猜）
  if (ucode === 'context_length_exceeded' || RE_CONTEXT_OVERFLOW.test(msg)) {
    return mk('LLM_CONTEXT_OVERFLOW', 'provider-body', `upstreamCode=${ucode || '-'} / 原话命中上下文超限词`)
  }

  // 7. 模型不存在 / 端点协议族不符（都是 404 家族，按上游原话分流）
  if (status === 404 || RE_MODEL_NOT_FOUND.test(`${ucode} ${raw.upstreamMessage ?? ''}`)) {
    if (RE_MODEL_NOT_FOUND.test(`${ucode} ${raw.upstreamMessage ?? ''}`)) {
      return mk('LLM_MODEL_NOT_FOUND', status === 404 ? 'http-status' : 'provider-body', '404 家族 + 模型不存在词')
    }
    if (RE_ENDPOINT_MISMATCH.test(msg)) {
      return mk('LLM_PROTOCOL_MISMATCH', 'http-status', `httpStatus=${status} + 路径/协议词`)
    }
    if (raw.model && msg.includes(raw.model)) {
      return mk('LLM_MODEL_NOT_FOUND', 'http-status', `httpStatus=404 + 原话含模型名 ${raw.model}`)
    }
    return mk('LLM_PROTOCOL_MISMATCH', 'http-status', 'httpStatus=404 兜底（地址/协议写错比模型名写错更常见）')
  }

  // 8. 限频
  if (status === 429 || ucode === 'rate_limit_exceeded' || RE_RATE.test(msg)) {
    return mk('LLM_RATE_LIMIT', status === 429 ? 'http-status' : 'provider-body', `httpStatus=${status ?? '-'} upstreamCode=${ucode || '-'}`)
  }

  // 9. 过载（Anthropic 最常见失败之一，529/overloaded_error）
  if (status === 529 || ucode === 'overloaded_error' || RE_OVERLOAD.test(msg)) {
    return mk('LLM_OVERLOADED', 'provider-body', `httpStatus=${status ?? '-'} upstreamCode=${ucode || '-'}`)
  }

  // 10. 上游 5xx
  if (status !== undefined && status >= 500) return mk('LLM_UPSTREAM_5XX', 'http-status', `httpStatus=${status}`)
  if (/HTTP 5\d\d|上游模型暂时不可用/.test(msg)) return mk('LLM_UPSTREAM_5XX', 'provider-body', '原话命中 5xx 词')

  // 11. 流内 error 帧（G1/G2 补上后）且无 http 状态：上游在流中报错
  if (raw.layer === 'stream-frame') {
    return mk('LLM_PROVIDER_ERROR_FRAME', 'provider-body', `layer=stream-frame upstreamCode=${ucode || '-'}`)
  }

  // 12. DNS
  if (RE_DNS.test(raw.raw ?? '')) return mk('LLM_DNS_FAILED', 'transport-error', '传输层串命中 DNS 族')

  // 13. 连接被中断（重置 / HTTP2 抖动）
  if (RE_RESET.test(raw.raw ?? '')) return mk('LLM_NET_RESET', 'transport-error', '传输层串命中重置族')

  // 14. 连接建立失败 / 连接超时
  if (RE_CONNECT_TIMEOUT.test(raw.raw ?? '') || raw.timedOut === 'connect') {
    return mk('LLM_CONNECT_TIMEOUT', raw.timedOut === 'connect' ? 'timing' : 'transport-error', raw.timedOut === 'connect' ? 'timedOut=connect（响应头未到）' : '传输层串命中连接超时族')
  }
  if (RE_REFUSED.test(raw.raw ?? '') && raw.receivedChunks === 0) {
    return mk('LLM_CONNECT_FAILED', 'transport-error', '传输层串命中连接失败族 + 零数据段')
  }

  // 15/16. 超时：**只按「收到几段数据」判定**（同一原始串不同码，契约锁）
  if (raw.timedOut === 'first-byte' || (RE_TIMEOUT_TEXT.test(raw.raw ?? '') && raw.receivedChunks === 0)) {
    return mk('LLM_FIRST_BYTE_TIMEOUT', 'timing', `${raw.timedOut ? 'timedOut=first-byte' : '原话含超时词'} + receivedChunks=0`)
  }
  if (raw.timedOut === 'idle' || (RE_TIMEOUT_TEXT.test(raw.raw ?? '') && raw.receivedChunks > 0)) {
    return mk('LLM_IDLE_TIMEOUT', 'timing', `${raw.timedOut ? 'timedOut=idle' : '原话含超时词'} + receivedChunks=${raw.receivedChunks}`)
  }

  // 17. 干净 EOF（未见结束帧）：显式 stream-eof 标记，或「有产出但没结束帧」
  if (raw.layer === 'stream-eof' || (!raw.sawTerminator && raw.partialChars > 0)) {
    return mk('LLM_STREAM_TRUNCATED', 'transport-error', raw.layer === 'stream-eof' ? 'layer=stream-eof（未见结束帧）' : 'sawTerminator=false 且已有产出')
  }

  // 18. 请求本身被拒（4xx 家族兜底）
  if (status !== undefined && status >= 400 && status < 500) {
    return mk('LLM_BAD_REQUEST', 'http-status', `httpStatus=${status} 兜底`)
  }

  // 19. 程序自身异常（循环侧兜底）—— 有异常就必须有名有姓，别混进 LLM_UNKNOWN
  if (raw.layer === 'agent-loop') return mk('INTERNAL_EXCEPTION', 'transport-error', 'layer=agent-loop 兜底')

  // 20. 以上全不命中：只写观测事实，不给因果
  return mk('LLM_UNKNOWN', 'inferred', '无任何可判据')
}

/** 诊断细节（从采集面截取；**不含正文、不含 Key**） */
export function interruptionDetailOf(raw: RawFailure): InterruptionDetail {
  const detail: InterruptionDetail = {
    raw: String(raw.raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    receivedChunks: raw.receivedChunks,
    partialChars: raw.partialChars,
    sawTerminator: raw.sawTerminator,
    elapsedMs: raw.elapsedMs,
  }
  if (raw.httpStatus !== undefined) detail.httpStatus = raw.httpStatus
  if (raw.upstreamCode) detail.upstreamCode = raw.upstreamCode
  if (raw.upstreamMessage) detail.upstreamMessage = String(raw.upstreamMessage).replace(/\s+/g, ' ').slice(0, 300)
  if (raw.stopReason) detail.stopReason = raw.stopReason
  if (raw.round !== undefined) detail.round = raw.round
  if (raw.runTokens !== undefined) detail.runTokens = raw.runTokens
  if (raw.attempts !== undefined) detail.attempts = raw.attempts
  if (raw.providerId) detail.providerId = raw.providerId
  if (raw.model) detail.model = raw.model
  return detail
}

// ===== 结束帧与截断（G5 = B-29 本体）=====

/** 上游停止原因 → 截断类中断（非截断返回 null） */
export function interruptionOfStopReason(stopReason: string | undefined): Interruption | null {
  const s = String(stopReason ?? '')
  if (!s) return null
  if (s === 'length' || s === 'max_tokens' || s === 'max_output_tokens' || s === 'incomplete') {
    return mk('LLM_OUTPUT_TRUNCATED', 'provider-body', `stopReason=${s}`)
  }
  if (s === 'no-terminator') {
    return mk('LLM_STREAM_TRUNCATED', 'transport-error', '未见结束帧（[DONE]/message_stop/done/response.completed）')
  }
  return null
}

/** 正常结束帧的内部标记值（适配器读不到上游 stopReason 时用它表达「未见结束帧」） */
export const STOP_REASON_NO_TERMINATOR = 'no-terminator'

/**
 * 网关配置类失败（PROVIDER_NOT_FOUND / PROVIDER_DISABLED / NO_DEFAULT_MODEL）→ 归因。
 * 三者对用户的动作完全一致（去设置里换一个可用模型），故统一落 LLM_MODEL_NOT_FOUND；
 * 具体原因保留在 matched 与诊断块的「原始错误」里（不猜、也不丢信息）。
 */
export function configInterruptionOf(code?: string): Interruption {
  return mk('LLM_MODEL_NOT_FOUND', 'inferred', `配置类：${code ?? '未知'}`)
}

// ===== ③ 呈现 =====

/** 错误类名（内部异常用）：取第一个 *Error 标识符，取不到就给消息头 */
function errorNameOf(raw: string): string {
  const s = String(raw ?? '')
  const m = s.match(/([A-Za-z_$][\w$]*Error)\b/)
  if (m) return m[1]
  const head = s.trim().split(/[\n:：]/)[0].trim()
  return head ? head.slice(0, 40) : '未知异常'
}

/** 卡片首行白话（同一 code 必须逐字相同 —— 契约锁；evidence=timing/inferred 禁用因果词） */
export function friendlyReason(it: Interruption, detail?: InterruptionDetail): string {
  const r = detail
  const status = r?.httpStatus !== undefined ? String(r.httpStatus) : ''
  const upstream = String(r?.upstreamMessage ?? '').replace(/\s+/g, ' ').trim()
  switch (it.code) {
    case 'USER_ABORTED': return '你点了「停止」，本次任务停在这里'
    case 'AGENT_ROUND_CAP': return `达到本次任务轮数上限（${r?.round ?? '?'} 轮），已就地总结`
    case 'AGENT_TOKEN_BUDGET': return `达到本次任务 token 上限（${r?.runTokens ?? '?'}），已就地总结`
    case 'AGENT_SUMMARY_FAILED': return '预算已耗尽，收场总结也没跑成'
    case 'AGENT_WRITE_CAP': return '已达本条消息的写入上限，新的写入被拦下（下一条消息重新计数）'
    case 'LLM_AUTH': return 'API Key 无效或已过期'
    case 'LLM_QUOTA_EXHAUSTED': return '账号额度已用尽'
    case 'LLM_RATE_LIMIT': return '模型服务限频，稍后或换模型'
    case 'LLM_MODEL_NOT_FOUND': return '模型不存在（检查模型列表）'
    case 'LLM_PROTOCOL_MISMATCH': return '端点协议族不符（该模型不走这条 API）'
    case 'LLM_CONTEXT_OVERFLOW': return `这轮上下文超出模型窗口（本次任务已用 ${r?.runTokens ?? '?'} token）`
    case 'LLM_BAD_REQUEST': return `上游拒绝了这次请求${status ? `（${status}）` : ''}${upstream ? `：${upstream.slice(0, 120)}` : ''}`
    case 'LLM_OUTPUT_TRUNCATED': return '达到单次输出上限，回答被截断'
    case 'LLM_UPSTREAM_5XX': return `模型服务返回 ${status || '5xx'}，暂时不可用`
    case 'LLM_OVERLOADED': return `模型服务过载（${upstream ? upstream.slice(0, 120) : '上游未给原话'}）`
    case 'LLM_PROVIDER_ERROR_FRAME': return `上游在流中报错${upstream ? `：${upstream.slice(0, 120)}` : '（未给原话）'}`
    case 'LLM_CONNECT_FAILED': return '连不上模型服务（未建立连接）'
    case 'LLM_CONNECT_TIMEOUT': return '连接模型服务超时（30 秒内没建立连接/没拿到响应头）'
    case 'LLM_NET_RESET': return '与模型服务的连接被中断'
    case 'LLM_DNS_FAILED': return '域名解析失败（检查网络或代理）'
    case 'LLM_FIRST_BYTE_TIMEOUT': return '等待模型响应超时（60 秒内一点数据都没回来）'
    case 'LLM_IDLE_TIMEOUT': return `模型输出到一半卡住了（已收到 ${r?.receivedChunks ?? 0} 段后 60 秒无新数据）`
    case 'LLM_STREAM_TRUNCATED': return '回答被上游中途截断（没收到结束帧）'
    case 'INTERNAL_EXCEPTION': return `内部异常：${errorNameOf(r?.raw ?? '')}（已留完整日志）`
    case 'LLM_UNKNOWN': return '本次任务被中断，未收到任何错误说明'
  }
}

/** 建议动作白话（卡片上的第二行；具体按钮出现后只作为补充说明） */
export function suggestedActionText(it: Interruption): string {
  switch (it.action) {
    // 批次 2 起「继续」按钮就挂在中断卡上，指引由卡片尾句（agentInterruptPure.RESUMABLE_NOTE）承担 ——
    // 两处都说一遍就是重复文案（铁律 12），所以这里留空
    case 'resume': return ''
    case 'retry': return '可点「重新生成」再试，或直接再发一次'
    case 'switch-model': return '换一个模型再试'
    case 'check-key': return '去「设置 → AI → 模型」检查这个账号的 Key'
    case 'top-up': return '去账号后台充值，或切换到别的账号'
    case 'wait': return '稍等一会儿再试，或换一个模型'
    case 'shrink-context': return '新开一个对话，或减少本轮上下文后重试'
    case 'new-session': return '新开一个对话再试'
    case 'report-bug': return '可复制下面的诊断信息反馈'
    case 'none': return ''
  }
}

/**
 * 诊断块（「复制诊断信息」的数据源）。
 * 硬约束：**只含码 / 状态 / 上游原话 / 段数 / 轮次 / 模型**，不含正文、不含 Key
 * （契约负向断言：不得出现 apiKey / Authorization / Bearer）。
 */
export function buildDiagnostics(it: Interruption, detail: InterruptionDetail, maxChars = 800): string {
  const clean = (s: string, n = 300): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
  const lines: string[] = [
    `原因码：${it.code}`,
    `证据：${it.evidence}`,
    `判据：${it.matched}`,
  ]
  if (detail.httpStatus !== undefined) lines.push(`上游状态：${detail.httpStatus}`)
  if (detail.upstreamCode) lines.push(`上游码：${clean(detail.upstreamCode, 80)}`)
  if (detail.upstreamMessage) lines.push(`上游原话：${clean(detail.upstreamMessage)}`)
  if (detail.receivedChunks !== undefined) lines.push(`收到数据段：${detail.receivedChunks}`)
  lines.push(`已产出字符：${detail.partialChars}`)
  lines.push(`结束帧：${detail.sawTerminator ? '收到' : '未收到'}`)
  if (detail.stopReason) lines.push(`停止原因：${clean(detail.stopReason, 60)}`)
  if (detail.round !== undefined) lines.push(`轮次：${detail.round}`)
  if (detail.runTokens !== undefined) lines.push(`本次任务已用 token：${detail.runTokens}`)
  if (detail.attempts !== undefined) lines.push(`已尝试次数：${detail.attempts}`)
  lines.push(`耗时：${detail.elapsedMs}ms`)
  if (detail.providerId || detail.model) lines.push(`模型：${clean(detail.providerId ?? '-', 60)} / ${clean(detail.model ?? '-', 80)}`)
  lines.push(`原始错误：${clean(detail.raw)}`)
  if (it.action !== 'none') lines.push(`建议动作：${it.action}`)
  const text = lines.join('\n')
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（诊断信息已截断）` : text
}

/**
 * 中断卡正文（A 方案的「中断 assistant 消息」内容；B-29 截断时作为追加段落）。
 * 结构：首行原因 → 建议动作 → ```诊断 围栏（现有「复制」按钮复制正文全文即可带走诊断块）。
 */
export function buildInterruptNotice(
  it: Interruption,
  detail: InterruptionDetail,
  opts?: { separator?: boolean; diagnostics?: boolean },
): string {
  const advice = suggestedActionText(it)
  const withDiag = opts?.diagnostics !== false && it.code !== 'USER_ABORTED'
  const parts: string[] = []
  if (opts?.separator) parts.push('')
  parts.push(friendlyReason(it, detail))
  if (advice) parts.push(advice)
  if (withDiag) parts.push('', '```诊断', buildDiagnostics(it, detail), '```')
  return parts.join('\n')
}

// ===== 采集搬运：把事实挂在错误对象上（跨 catch 点不丢）=====

const FACTS_KEY = Symbol.for('kb.llm.failure.facts')

/** 把采集到的事实挂在错误上（不改 message，供上层归一） */
export function attachFacts(err: unknown, facts: Partial<RawFailure>): Error {
  const e = err instanceof Error ? err : new Error(String(err))
  const prev = factsOf(e)
  ;(e as unknown as Record<symbol, unknown>)[FACTS_KEY] = { ...(prev ?? {}), ...facts }
  return e
}

export function factsOf(err: unknown): Partial<RawFailure> | null {
  if (!err || typeof err !== 'object') return null
  const v = (err as Record<symbol, unknown>)[FACTS_KEY]
  return v && typeof v === 'object' ? (v as Partial<RawFailure>) : null
}

/** 从错误对象还原采集面（缺的按缺省值补；上层再补 provider/model/耗时等循环侧事实） */
export function rawFromError(err: unknown, base: Partial<RawFailure> & { layer?: FailureLayer }): RawFailure {
  const facts = factsOf(err) ?? {}
  const message = err instanceof Error ? err.message : String(err)
  return rawFailure({
    ...facts,
    ...base,
    layer: (base.layer ?? facts.layer ?? 'transport') as FailureLayer,
    raw: String(base.raw ?? facts.raw ?? message ?? ''),
  })
}
