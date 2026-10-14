#!/usr/bin/env node
/**
 * 中断归因契约（归因 P0，2026-10-14）。
 * 方案：docs/agent-error-attribution-plan.md §7.1。
 *
 * 两层断言：
 *   1) 纯函数离线断言（fixture 用本机审计里的**真实错误串**原文）：
 *      每条 → 期望码 + 证据强度；码表三列；「不猜」负向词表；诊断块不含密钥。
 *   2) 源码级接线断言：纯函数写对了但没接上等于没做（四处适配器的结束帧/error 帧、
 *      连接超时、审计带码、withAbort 有 catch、渲染层三入口有 catch）。
 *
 * 跑法：node .AGENT/scripts/llm-adapters/verify-llm-attribution.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  INTERRUPT_CODES, INTERRUPT_CODE_TABLE, CAUSAL_WORDS,
  classifyFailure, rawFailure, friendlyReason, suggestedActionText, buildDiagnostics,
  buildInterruptNotice, interruptionDetailOf, interruptionOfStopReason, configInterruptionOf,
  hasCausalWord, attachFacts, rawFromError, factsOf,
} from '../../../electron/lib/llmFailurePure.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

const raw = (extra) => rawFailure({ layer: 'transport', raw: '', elapsedMs: 1, ...extra })

// ===== 1. 实测错误串逐条（本机 plugin-audit.json 原文）=====

console.log('\n[fixture] 真实错误串 → 码 / 证据')
const CASES = [
  // 同一原始串，靠「收到几段数据」分流（G6：首字节 vs 空闲，修法完全不同）
  ['流式响应超时（60 秒无数据）', { receivedChunks: 0 }, 'LLM_FIRST_BYTE_TIMEOUT', 'timing'],
  ['流式响应超时（60 秒无数据）', { receivedChunks: 5, partialChars: 120 }, 'LLM_IDLE_TIMEOUT', 'timing'],
  ['net::ERR_CONNECTION_RESET', {}, 'LLM_NET_RESET', 'transport-error'],
  ['net::ERR_HTTP2_PROTOCOL_ERROR', {}, 'LLM_NET_RESET', 'transport-error'],
  ['net::ERR_NAME_NOT_RESOLVED', {}, 'LLM_DNS_FAILED', 'transport-error'],
  ['The operation was aborted', { externalAborted: true }, 'USER_ABORTED', 'transport-error'],
  ['HTTP 429: 免费模型限频中，请稍后再试或换其他模型', { httpStatus: 429 }, 'LLM_RATE_LIMIT', 'http-status'],
  ['免费模型限频中，请稍后再试或换其他模型', {}, 'LLM_RATE_LIMIT', 'provider-body'],
  ['上游模型暂时不可用（503），可稍后重试或换其他模型', {}, 'LLM_UPSTREAM_5XX', 'provider-body'],
  ['鉴权失败（401），请检查 API Key', {}, 'LLM_AUTH', 'provider-body'],
  ['HTTP 404: 接口路径不存在（404），请确认 Base URL 与供应商类型匹配', { httpStatus: 404 }, 'LLM_PROTOCOL_MISMATCH', 'http-status'],
  ['HTTP 400: maximum context length is 32768 tokens', { httpStatus: 400 }, 'LLM_CONTEXT_OVERFLOW', 'provider-body'],
]
for (const [str, extra, code, evidence] of CASES) {
  const it = classifyFailure(raw({ raw: str, ...extra }))
  check(`${code}  ←  ${str.slice(0, 34)}${extra.receivedChunks ? ' (chunks=' + extra.receivedChunks + ')' : ''}`,
    it.code === code && it.evidence === evidence, `got ${it.code}/${it.evidence}`)
}

// ===== 2. 跨协议原生形状（§3 映射表）=====

console.log('\n[fixture] 四家原生形状 → 同一个码')
const SHAPES = [
  ['SSE 内 error 帧 + context_length_exceeded', { layer: 'stream-frame', raw: 'maximum context length', upstreamCode: 'context_length_exceeded', upstreamMessage: 'maximum context length is 32768 tokens' }, 'LLM_CONTEXT_OVERFLOW', 'provider-body'],
  ['Anthropic error 帧 + overloaded_error', { layer: 'stream-frame', raw: 'Overloaded', upstreamCode: 'overloaded_error', upstreamMessage: 'Overloaded' }, 'LLM_OVERLOADED', 'provider-body'],
  ['Anthropic 529', { layer: 'http', raw: 'HTTP 529', httpStatus: 529 }, 'LLM_OVERLOADED', 'provider-body'],
  ['HTTP 402 + insufficient_quota', { layer: 'http', raw: 'HTTP 402', httpStatus: 402, upstreamCode: 'insufficient_quota' }, 'LLM_QUOTA_EXHAUSTED', 'http-status'],
  ['HTTP 401', { layer: 'http', raw: 'HTTP 401', httpStatus: 401 }, 'LLM_AUTH', 'http-status'],
  ['HTTP 404 + 模型名', { layer: 'http', raw: 'HTTP 404', httpStatus: 404, upstreamMessage: 'The model `gpt-x` does not exist' }, 'LLM_MODEL_NOT_FOUND', 'http-status'],
  ['Ollama 404 model not found（错误体不再丢）', { layer: 'http', raw: 'HTTP 404：model "qwen" not found', httpStatus: 404, upstreamMessage: 'model "qwen" not found' }, 'LLM_MODEL_NOT_FOUND', 'http-status'],
  ['HTTP 503', { layer: 'http', raw: 'HTTP 503', httpStatus: 503 }, 'LLM_UPSTREAM_5XX', 'http-status'],
  ['连接被拒 + 零段', { raw: 'net::ERR_CONNECTION_REFUSED', receivedChunks: 0 }, 'LLM_CONNECT_FAILED', 'transport-error'],
  ['连接阶段超时（响应头未到）', { raw: 'connect hang', timedOut: 'connect' }, 'LLM_CONNECT_TIMEOUT', 'timing'],
  ['其余 4xx 兜底', { layer: 'http', raw: 'HTTP 422', httpStatus: 422 }, 'LLM_BAD_REQUEST', 'http-status'],
  ['干净 EOF（未见结束帧）', { layer: 'stream-eof', raw: 'stream closed' }, 'LLM_STREAM_TRUNCATED', 'transport-error'],
  ['内部异常（非网络串）', { layer: 'agent-loop', raw: "Cannot read properties of undefined (reading 'x')" }, 'INTERNAL_EXCEPTION', 'transport-error'],
  ['渲染层 IPC 异常', { layer: 'renderer-ipc', raw: 'Error invoking remote method' }, 'INTERNAL_EXCEPTION', 'transport-error'],
  ['循环侧：轮数用尽', { layer: 'agent-loop', raw: '轮数用尽', loop: 'round-cap', round: 64 }, 'AGENT_ROUND_CAP', 'inferred'],
  ['循环侧：token 触顶', { layer: 'agent-loop', raw: 'token 预算触顶', loop: 'token-budget', runTokens: 4000000 }, 'AGENT_TOKEN_BUDGET', 'inferred'],
  ['循环侧：总结失败', { layer: 'agent-loop', raw: '总结失败', loop: 'summary-failed' }, 'AGENT_SUMMARY_FAILED', 'inferred'],
]
for (const [name, extra, code, evidence] of SHAPES) {
  const it = classifyFailure(raw(extra))
  check(`${code}  ←  ${name}`, it.code === code && it.evidence === evidence, `got ${it.code}/${it.evidence}`)
}

// ===== 3. 优先级与「不猜」=====

console.log('\n[优先级] 停止 > 一切')
const both = classifyFailure(raw({ raw: '流式响应超时（60 秒无数据）', receivedChunks: 0, externalAborted: true, timedOut: 'first-byte' }))
eq('用户停止 + 同时超时 → USER_ABORTED', both.code, 'USER_ABORTED')
eq('用户停止永不重试（B 的 shouldRetry 直接复用）', both.retryable, false)
eq('用户停止可续（A 的「继续」入口据它出）', both.resumable, true)

console.log('\n[不猜] 证据不足只写观测事实')
const unk = classifyFailure(raw({ raw: '', receivedChunks: 0 }))
eq('无任何判据 → LLM_UNKNOWN', unk.code, 'LLM_UNKNOWN')
eq('LLM_UNKNOWN 证据强度 = inferred', unk.evidence, 'inferred')
check('LLM_UNKNOWN 首行不含因果词', !hasCausalWord(friendlyReason(unk, interruptionDetailOf(raw({ raw: '' })))), friendlyReason(unk))
check('因果词表本身非空（负向断言不是空转）', CAUSAL_WORDS.length >= 4)
eq('完全无输出且未超时 → 不当成「被截断」硬猜', classifyFailure(raw({ raw: '', receivedChunks: 0, partialChars: 0 })).code, 'LLM_UNKNOWN')

console.log('\n[截断] 结束帧与 stopReason（G5 = B-29）')
eq('finish_reason=length → LLM_OUTPUT_TRUNCATED', interruptionOfStopReason('length')?.code, 'LLM_OUTPUT_TRUNCATED')
eq('Anthropic stop_reason=max_tokens → LLM_OUTPUT_TRUNCATED', interruptionOfStopReason('max_tokens')?.code, 'LLM_OUTPUT_TRUNCATED')
eq('Responses incomplete → LLM_OUTPUT_TRUNCATED', interruptionOfStopReason('incomplete')?.code, 'LLM_OUTPUT_TRUNCATED')
eq('未见结束帧 → LLM_STREAM_TRUNCATED', interruptionOfStopReason('no-terminator')?.code, 'LLM_STREAM_TRUNCATED')
eq('finish_reason=stop 不是截断', interruptionOfStopReason('stop'), null)
eq('无 stopReason 不是截断', interruptionOfStopReason(undefined), null)

console.log('\n[配置类] 调用前失败也有码')
eq('PROVIDER_DISABLED → 换模型', configInterruptionOf('PROVIDER_DISABLED').code, 'LLM_MODEL_NOT_FOUND')
eq('NO_DEFAULT_MODEL → 换模型', configInterruptionOf('NO_DEFAULT_MODEL').action, 'switch-model')

// ===== 4. 码表三列（与方案 §2.3 逐行一致）=====

console.log('\n[码表] 25 个码 + 三列联动')
eq('码数与方案一致', INTERRUPT_CODES.length, 25)
eq('码表覆盖全部码（漏一个就红）', Object.keys(INTERRUPT_CODE_TABLE).sort().join(','), [...INTERRUPT_CODES].sort().join(','))
const ACTIONS = ['resume', 'retry', 'switch-model', 'check-key', 'top-up', 'wait', 'shrink-context', 'new-session', 'report-bug', 'none']
const badTrait = INTERRUPT_CODES.filter(c => {
  const t = INTERRUPT_CODE_TABLE[c]
  return typeof t.resumable !== 'boolean' || typeof t.retryable !== 'boolean' || !ACTIONS.includes(t.action)
})
eq('三列取值合法', badTrait, [])
eq('可续全为 true（有现场就能续，见方案 §2.3 注）', INTERRUPT_CODES.filter(c => !INTERRUPT_CODE_TABLE[c].resumable), [])
eq('USER_ABORTED 不可重试', INTERRUPT_CODE_TABLE.USER_ABORTED.retryable, false)
eq('限频可重试', INTERRUPT_CODE_TABLE.LLM_RATE_LIMIT.retryable, true)
eq('鉴权/额度/模型不存在不可重试（换供应商也没用）',
  ['LLM_AUTH', 'LLM_QUOTA_EXHAUSTED', 'LLM_MODEL_NOT_FOUND', 'LLM_PROTOCOL_MISMATCH', 'LLM_CONTEXT_OVERFLOW', 'LLM_OUTPUT_TRUNCATED', 'INTERNAL_EXCEPTION']
    .filter(c => INTERRUPT_CODE_TABLE[c].retryable), [])

console.log('\n[文案] 25 个码都有白话 + 建议动作，且 timing/inferred 禁因果词')
const detail = interruptionDetailOf(raw({ raw: 'x', receivedChunks: 3, partialChars: 10, round: 2, runTokens: 100 }))
const silent = []
for (const code of INTERRUPT_CODES) {
  const it = { code, evidence: 'inferred', resumable: true, retryable: false, action: INTERRUPT_CODE_TABLE[code].action, matched: 'contract' }
  const line = friendlyReason(it, detail)
  if (!line || line.length < 4) silent.push(`${code}:empty`)
  if (hasCausalWord(line)) silent.push(`${code}:causal`)
  if (hasCausalWord(suggestedActionText(it))) silent.push(`${code}:causal-advice`)
}
eq('无空文案、无因果词', silent, [])

// ===== 5. 诊断块（可一键复制，且不含密钥）=====

console.log('\n[诊断块] 能带走事实、带不走隐私')
const diagRaw = raw({
  raw: 'net::ERR_CONNECTION_RESET', httpStatus: 502, upstreamCode: 'bad_gateway',
  upstreamMessage: 'upstream said no', receivedChunks: 2, partialChars: 40,
  round: 7, runTokens: 123456, providerId: 'p1', model: 'm1', attempts: 2, elapsedMs: 60004,
})
const diagIt = classifyFailure(diagRaw)
const diag = buildDiagnostics(diagIt, interruptionDetailOf(diagRaw))
check(`含原因码（${diagIt.code}）`, diag.includes(`原因码：${diagIt.code}`), diag.split('\n')[0])
eq('有 http 状态时 5xx 优先于传输层复位（判据顺序即正确性）', diagIt.code, 'LLM_UPSTREAM_5XX')
check('含上游状态与上游码', diag.includes('上游状态：502') && diag.includes('上游码：bad_gateway'))
check('含段数 / 轮次 / 模型 / 耗时', diag.includes('收到数据段：2') && diag.includes('轮次：7') && diag.includes('m1') && diag.includes('60004ms'))
eq('不含密钥与鉴权头', /apiKey|Authorization|Bearer|sk-/i.test(diag), false)
check('长度受控', diag.length <= 820, `len=${diag.length}`)
const longRaw = raw({ raw: 'y'.repeat(4000), upstreamMessage: 'z'.repeat(4000), upstreamCode: 'q'.repeat(4000) })
const longDiag = buildDiagnostics(classifyFailure(longRaw), interruptionDetailOf(longRaw), 120)
check('超长诊断按上限截断（不会把卡片撑爆）', longDiag.length <= 140 && longDiag.includes('诊断信息已截断'), `len=${longDiag.length}`)
check('段数未知时不写假值（宁缺勿编）', !buildDiagnostics(unk, { raw: 'stopReason=length', partialChars: 10, sawTerminator: true, elapsedMs: 1 }).includes('收到数据段'))

const notice = buildInterruptNotice(classifyFailure(raw({ raw: 'net::ERR_CONNECTION_RESET' })), interruptionDetailOf(raw({ raw: 'net::ERR_CONNECTION_RESET' })))
check('中断卡正文首行就是原因', notice.split('\n')[0].includes('连接被中断'), notice.split('\n')[0])
check('中断卡正文含诊断围栏（现有「复制」按钮即可带走）', notice.includes('```诊断'))
const abortNotice = buildInterruptNotice(both, interruptionDetailOf(raw({ raw: 'The operation was aborted', externalAborted: true })))
check('用户停止不塞诊断块（原因自明，别当噪音）', !abortNotice.includes('```诊断'), abortNotice)

// ===== 6. 采集搬运（跨 catch 点不丢事实）=====

console.log('\n[采集] attachFacts / rawFromError')
const src = attachFacts(new Error('boom'), { layer: 'http', httpStatus: 429, upstreamCode: 'rate_limit_exceeded' })
const round = rawFromError(src, { elapsedMs: 12, providerId: 'p', model: 'm' })
eq('message 不被改写', round.raw, 'boom')
eq('facts 跨 catch 保留', [round.layer, round.httpStatus, round.upstreamCode], ['http', 429, 'rate_limit_exceeded'])
eq('超时/段数由调用方补齐', [round.receivedChunks, round.partialChars, round.sawTerminator], [0, 0, false])
check('非 Error 抛出（字符串）也能采', factsOf(attachFacts('plain string', { layer: 'tool' }))?.layer === 'tool')

// ===== 7. 接线断言（写对了但没接上等于没做）=====

console.log('\n[接线] electron/lib/llmService.ts')
const svc = read('electron/lib/llmService.ts')
check('纯函数已下移到零依赖模块', svc.includes("from './llmFailurePure'"))
check('码只在 classifyFailure 产生（失败出口唯一）', (svc.match(/classifyFailure\(/g) ?? []).length >= 2)
check('文案只在 friendlyReason 产生', (svc.match(/friendlyReason\(/g) ?? []).length >= 2)
eq('四家适配器都接了连接阶段（G7）', (svc.match(/sa\.connected\(\)/g) ?? []).length, 4)
check('连接超时用的是 CONNECT_TIMEOUT_MS（死常数接上了）', svc.includes('arm(CONNECT_TIMEOUT_MS,'))
check('超时归属可判（不靠耗时猜）', svc.includes('timedOutKind'))
check('旧的中文超时串已消失（首字节/空闲分开说）', !svc.includes('流式响应超时（60 秒无数据）'))
check('OpenAI 兼容认 SSE 内 error 帧（G1）', svc.includes('if (json.error) {'))
check('Anthropic 认 type=error（G2）', svc.includes("if (type === 'error')"))
check('Ollama 非 200 不再丢错误体（G3）', svc.includes('json.error.replace'))
check('Ollama 流内 error 行也认', svc.includes("upstreamFactsOf(json)"))
check('Responses 的 response.failed 仍在（样板）', svc.includes("type === 'response.failed' || type === 'error'"))
check('incomplete 不再当正常完成（G5）', svc.includes("type === 'response.incomplete'") && svc.includes('incomplete_details'))
check('OpenAI 读 finish_reason', svc.includes('choice.finish_reason'))
check('Anthropic 读 stop_reason', svc.includes('json.delta?.stop_reason'))
check('Ollama 读 done_reason', svc.includes('json.done_reason'))
check('四处结束帧都置 terminator', (svc.match(/stats\.terminator = true/g) ?? []).length >= 4)
check('未见结束帧被标出来（G4）', (svc.match(/STOP_REASON_NO_TERMINATOR/g) ?? []).length >= 4)
check('审计带归因码（G10）', svc.includes('code: it.code'))
check('故障转移判据改用 retryable（G9）', svc.includes('if (!r.interruption?.retryable) return r'))
check('旧的 isProviderLevelError 已删除', !/function isProviderLevelError/.test(svc))
check('非 200 采集了状态码与上游原话', svc.includes('function httpFailure(') && svc.includes('function upstreamFactsOf('))

console.log('\n[接线] electron/lib/agentService.ts')
const agent = read('electron/lib/agentService.ts')
check('withAbort 有 catch（G8 核心）', /const withAbort[\s\S]{0,2600}catch \(err\)[\s\S]{0,600}任务异常逃逸/.test(agent))
check('异常逃逸落 console.error（留完整日志）', agent.includes("console.error('[agent] 任务异常逃逸（withAbort 兜底）', err)"))
check('中断出口收口在 interruptResult', (agent.match(/interruptResult\(/g) ?? []).length >= 5)
check('落库失败也不静默', agent.includes('中断记录落库失败'))
check('没有裸 ABORTED 码（统一 USER_ABORTED）', !/'ABORTED'/.test(agent))
check('轮内失败带 code + interruption', agent.includes('r.interruption ?? configInterruptionOf(r.code)'))
check('截断追加提示（B-29）', agent.includes('withTruncationNotice'))
check('预算触顶区分轮数/token', agent.includes("capKind === 'token-budget'") && agent.includes("loop: capKind"))

console.log('\n[接线] 渲染层四入口 catch（G8；批次 2 起多了续跑入口 resume）')
const chat = read('src/components/shared/AssistantPanel/useAssistantChat.ts')
eq('send / regenerate / resume / editSubmit 都兜住了', (chat.match(/未捕获异常/g) ?? []).length, 4)
eq('没有裸 ABORTED 码', (chat.match(/=== 'ABORTED'/g) ?? []).length, 0)
eq('四处都按 USER_ABORTED 走「已停止」', (chat.match(/=== 'USER_ABORTED'/g) ?? []).length, 4)
check('assistantRunStore 按 USER_ABORTED 静默', read('src/lib/assistantRunStore.ts').includes("ended.code === 'USER_ABORTED'"))
check('aiActivity 按 USER_ABORTED 不报错', read('src/lib/aiActivity.ts').includes("e.code !== 'USER_ABORTED'"))

console.log('\n[一致性] 真源码表 ↔ 渲染层镜像（挨着抄会漂移，所以按源码文本比）')
const coreSeg = read('electron/lib/llmFailurePure.ts')
const coreBlock = coreSeg.slice(coreSeg.indexOf('export const INTERRUPT_CODES = ['), coreSeg.indexOf('] as const'))
const types = read('src/types/index.ts')
const mirrorBlock = types.slice(types.indexOf('export type InterruptCode ='), types.indexOf('export type InterruptionEvidence'))
const pick = (s) => [...s.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map(m => m[1])
eq('两份清单逐字一致且顺序相同', pick(mirrorBlock).join(','), pick(coreBlock).join(','))
check('镜像里也有 Interruption / InterruptionDetail', types.includes('export interface Interruption {') && types.includes('export interface InterruptionDetail {'))
check('AgentChatResult 回传归因（G12 的接口面）', /interface AgentChatResult[\s\S]{0,900}interruption\?: Interruption/.test(types))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
