#!/usr/bin/env node
/**
 * 模型网关协议层契约（2026-10-13）。
 *
 * 覆盖三件本轮新增/修复的事，全部是纯函数，可离线断言：
 *   1) ③ 会话头：x-opencode-session 必须按对话稳定（常量=所有对话共用会话，随机值=打散缓存）；
 *      以及自定义 User-Agent（官方两条客户端要求）。
 *   2) ① 协议族：同一端点下模型可分属 /chat/completions、/messages、/responses，
 *      逐模型覆盖优先于供应商 type。
 *   3) ① OpenAI Responses 协议的请求装配、响应解析与流式合并兜底。
 *
 * 另附「接线断言」：纯函数写对了但没接上等于没做，所以顺带检查 llmService / 各调用点 / 渲染层。
 *
 * 跑法：node .AGENT/scripts/llm-adapters/verify-llm-protocol.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  familyOf, FAMILY_BY_TYPE, withSessionHeaders, userAgentString, SESSION_HEADER,
  buildResponsesBody, buildResponsesTools, buildResponsesInput, parseResponsesWhole,
  mergeResponsesResult, collectResponsesToolCalls, REASONING_MODEL_RE,
} from '../../../electron/lib/llmProtocolPure.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

// ===== 1. 协议族判定 =====

console.log('\n[协议族] familyOf')
eq('openai-compatible 默认 → chat', familyOf('openai-compatible', undefined, 'glm-5.3'), 'chat')
eq('openai-responses 默认 → responses', familyOf('openai-responses', undefined, 'gpt-5.6-luna'), 'responses')
eq('anthropic 默认 → messages', familyOf('anthropic', undefined, 'claude-haiku-5-5'), 'messages')
eq('ollama 无协议族概念 → null', familyOf('ollama', undefined, 'llama3'), null)
eq('逐模型覆盖优先于 type（Go 端点同一把 Key 混三条协议）',
  familyOf('openai-compatible', { 'gpt-5.6-luna': 'responses', 'qwen3.8-flash': 'messages' }, 'gpt-5.6-luna'), 'responses')
eq('未覆盖的模型仍跟随 type',
  familyOf('openai-compatible', { 'gpt-5.6-luna': 'responses' }, 'deepseek-v4.1-flash'), 'chat')
eq('覆盖表键精确匹配（不做前缀/模糊）',
  familyOf('openai-compatible', { 'gpt-5.6-luna': 'responses' }, 'gpt-5.6-luna-mini'), 'chat')
check('FAMILY_BY_TYPE 覆盖全部三种有协议族的 type', Object.keys(FAMILY_BY_TYPE).length === 3 && !('ollama' in FAMILY_BY_TYPE))

// ===== 2. 会话头与客户端标识 =====

console.log('\n[会话头] withSessionHeaders')
eq('未声明该头 → 原样返回，不替别的网关发明头',
  withSessionHeaders({ Authorization: 'Bearer x' }, 'sess-1'), { Authorization: 'Bearer x' })
eq('未声明 + 无 headers → 空对象',
  withSessionHeaders(undefined, 'sess-1'), {})
eq('已声明 + 有会话 ID → 用真实会话 ID 覆盖常量',
  withSessionHeaders({ [SESSION_HEADER]: 'knowbase' }, 'sess-1'), { [SESSION_HEADER]: 'sess-1' })
eq('已声明 + 无会话 ID → 保留原常量（宁可发常量也别少一个上游要求的头）',
  withSessionHeaders({ [SESSION_HEADER]: 'knowbase' }, undefined), { [SESSION_HEADER]: 'knowbase' })
eq('头名大小写不敏感（用户可能写成 X-OpenCode-Session）',
  withSessionHeaders({ 'X-OpenCode-Session': 'knowbase' }, 'sess-2'), { 'X-OpenCode-Session': 'sess-2' })
eq('不吞掉其它自定义头',
  withSessionHeaders({ [SESSION_HEADER]: 'k', 'x-tenant': 't' }, 'sess-3'), { [SESSION_HEADER]: 'sess-3', 'x-tenant': 't' })
check('同一对话同一个 ID 得到同一结果（缓存稳定的前提）',
  JSON.stringify(withSessionHeaders({ [SESSION_HEADER]: 'k' }, 'sess-A')) === JSON.stringify(withSessionHeaders({ [SESSION_HEADER]: 'k' }, 'sess-A')))
check('不同对话得到不同 ID（缓存不互串的前提）',
  JSON.stringify(withSessionHeaders({ [SESSION_HEADER]: 'k' }, 'sess-A')) !== JSON.stringify(withSessionHeaders({ [SESSION_HEADER]: 'k' }, 'sess-B')))

console.log('\n[客户端标识] userAgentString')
eq('带版本', userAgentString('3.5.0'), 'Phrontis/3.5.0')
eq('版本为空 → 兜底', userAgentString(''), 'Phrontis/0.0.0')
check('不是通用 SDK/HTTP 库名（官方明确要求自带 UA）', !/^(node|electron|undici|axios|curl)/i.test(userAgentString('3.5.0')))

// ===== 3. Responses 请求装配 =====

console.log('\n[Responses 请求] buildResponsesBody')
const baseReq = { model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'hi' }], maxTokens: 4096 }
const b1 = buildResponsesBody(baseReq, false)
eq('model 直传', b1.model, 'gpt-5.6-luna')
eq('max_tokens 字段名是 max_output_tokens', b1.max_output_tokens, 4096)
check('不带 OpenAI 的 max_tokens 字段（Responses 不认）', !('max_tokens' in b1))
eq('store:false（多轮回喂自己管，不靠上游留状态）', b1.store, false)
check('非流式不带 stream', !('stream' in b1))
check('流式带 stream:true', buildResponsesBody(baseReq, true).stream === true)
check('无工具时不带 tools 键', !('tools' in b1))

console.log('\n[Responses 输入装配] buildResponsesInput')
eq('user → input_text 部件',
  buildResponsesInput([{ role: 'user', content: 'hi' }]),
  [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
eq('system → input_text 部件（Responses 没有独立 system 字段）',
  buildResponsesInput([{ role: 'system', content: 'sys' }]),
  [{ role: 'system', content: [{ type: 'input_text', text: 'sys' }] }])
eq('assistant 正文 → output_text 部件',
  buildResponsesInput([{ role: 'assistant', content: 'ok' }]),
  [{ role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }])
eq('assistant 工具调用 → 与 message 平级的顶层 function_call item',
  buildResponsesInput([{ role: 'assistant', content: 'ok', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] }]),
  [
    { role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
    { type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{"a":1}' },
  ])
eq('tool 结果 → function_call_output item',
  buildResponsesInput([{ role: 'tool', tool_call_id: 'call_1', content: 'result' }]),
  [{ type: 'function_call_output', call_id: 'call_1', output: 'result' }])
eq('arguments 已是对象时序列化成字符串',
  buildResponsesInput([{ role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'f', arguments: { a: 1 } } }] }]),
  [{ type: 'function_call', call_id: 'c', name: 'f', arguments: '{"a":1}' }])

console.log('\n[Responses 工具] buildResponsesTools')
const tools = [{ type: 'function', function: { name: 'read', description: 'd', parameters: { type: 'object' } } }]
eq('工具定义是扁平的（不套 function 壳）',
  buildResponsesTools(tools),
  [{ type: 'function', name: 'read', description: 'd', parameters: { type: 'object' } }])
check('扁平化后不含 function 键', !('function' in buildResponsesTools(tools)[0]))
eq('缺 parameters 时给空 schema 兜底',
  buildResponsesTools([{ function: { name: 'x' } }])[0].parameters, { type: 'object', properties: {} })
eq('无名工具被过滤', buildResponsesTools([{ function: { description: 'no name' } }]), [])
eq('工具为空 → 空数组', buildResponsesTools(undefined), [])
check('带工具时 tools + tool_choice:auto',
  buildResponsesBody({ ...baseReq, tools }, false).tool_choice === 'auto' && buildResponsesBody({ ...baseReq, tools }, false).tools.length === 1)

console.log('\n[思考强度] reasoning.effort')
// 注意：能力判定沿用既有的 REASONING_MODEL_RE 启发式（按模型名猜），gpt-5.6-luna / grok-4.6
// 这些名字不在该正则内 —— 也就是说对它们不会透传思考强度（模型仍会按自己的默认档思考）。
// 这里只断言"该发的时候发对字段名、不该发的时候别发"，不去改既有启发式的覆盖面。
check('字段名是 reasoning.effort（不是 reasoning_effort）',
  buildResponsesBody({ ...baseReq, model: 'qwen3.8-max', effort: 'high' }, false).reasoning?.effort === 'high')
check('不发 OpenAI 兼容用的 reasoning_effort 字段',
  !('reasoning_effort' in buildResponsesBody({ ...baseReq, model: 'qwen3.8-max', effort: 'high' }, false)))
check('off 不透传', !('reasoning' in buildResponsesBody({ ...baseReq, model: 'qwen3.8-max', effort: 'off' }, false)))
check('非推理型模型不透传（避免上游不认该参数报错）',
  !('reasoning' in buildResponsesBody({ ...baseReq, model: 'glm-5.3', effort: 'high' }, false)))
check('推理型识别沿用 REASONING_MODEL_RE', REASONING_MODEL_RE.test('qwen3.8-max') && !REASONING_MODEL_RE.test('glm-5.3'))

// ===== 4. Responses 响应解析 =====

console.log('\n[Responses 响应] parseResponsesWhole')
const wholeResp = {
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello ' }, { type: 'output_text', text: 'world' }] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'read', arguments: '{"p":"a.md"}' },
  ],
  usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 64 } },
}
const p1 = parseResponsesWhole(wholeResp)
eq('多个 output_text 部件拼接', p1.content, 'hello world')
eq('function_call → toolCalls（call_id 优先于 id）', p1.toolCalls, [{ id: 'call_9', name: 'read', arguments: '{"p":"a.md"}' }])
eq('usage 映射 input/output/cached', p1.usage, { promptTokens: 120, completionTokens: 30, cachedTokens: 64 })
eq('refusal 也计入正文（不让用户看到空回复）',
  parseResponsesWhole({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }).content, 'no')
eq('无名 function_call 被过滤',
  parseResponsesWhole({ output: [{ type: 'function_call', call_id: 'c' }] }).toolCalls, [])
eq('缺 usage → 全 0（不 NaN）',
  parseResponsesWhole({ output: [] }).usage, { promptTokens: 0, completionTokens: 0, cachedTokens: 0 })
eq('空响应不抛', parseResponsesWhole({}).content, '')
eq('arguments 非字符串时序列化',
  parseResponsesWhole({ output: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: { a: 1 } }] }).toolCalls[0].arguments, '{"a":1}')

// ===== 5. 流式合并兜底 =====

console.log('\n[流式合并] mergeResponsesResult')
const streamed = [{ id: 'call_0', name: 'f', arguments: '{"a":1}' }]
const zeroUsage = { promptTokens: 0, completionTokens: 0 }
eq('完成事件有正文 → 以它为准',
  mergeResponsesResult({ content: 'full', toolCalls: [], usage: zeroUsage }, [], 'par', zeroUsage).content, 'full')
eq('完成事件正文为空 → 用分片累加兜底（上游改事件名也不丢内容）',
  mergeResponsesResult({ content: '', toolCalls: [], usage: zeroUsage }, [], 'par', zeroUsage).content, 'par')
eq('完成事件没有 toolCalls → 用分片累加的',
  mergeResponsesResult({ content: 'x', toolCalls: [], usage: zeroUsage }, streamed, '', zeroUsage).toolCalls, streamed)
eq('完成事件有 toolCalls → 以它为准',
  mergeResponsesResult({ content: 'x', toolCalls: [{ id: 'c2', name: 'g', arguments: '{}' }], usage: zeroUsage }, streamed, '', zeroUsage).toolCalls[0].id, 'c2')
eq('完成事件无 usage → 用分片 usage',
  mergeResponsesResult({ content: 'x', toolCalls: [], usage: zeroUsage }, [], '', { promptTokens: 7, completionTokens: 3 }).usage.promptTokens, 7)
eq('完成事件有 usage → 以它为准',
  mergeResponsesResult({ content: 'x', toolCalls: [], usage: { promptTokens: 9, completionTokens: 1 } }, [], '', { promptTokens: 7, completionTokens: 3 }).usage.promptTokens, 9)
eq('whole 为 null（没收到完成事件）→ 全用分片',
  mergeResponsesResult(null, streamed, 'par', zeroUsage), { content: 'par', toolCalls: streamed, usage: zeroUsage })

console.log('\n[分片归组] collectResponsesToolCalls')
const mkAcc = (pairs) => new Map(pairs)
eq('按 output_index 排序（并发分片可能乱序到达）',
  collectResponsesToolCalls(mkAcc([[2, { id: 'c2', name: 'b', args: '{}' }], [0, { id: 'c0', name: 'a', args: '{}' }]])).map(t => t.name),
  ['a', 'b'])
eq('缺 id → call_<index>',
  collectResponsesToolCalls(mkAcc([[3, { id: '', name: 'f', args: '{}' }]]))[0].id, 'call_3')
eq('缺 args → {}（保证下游 JSON.parse 不炸）',
  collectResponsesToolCalls(mkAcc([[0, { id: 'c', name: 'f', args: '' }]]))[0].arguments, '{}')
eq('无名分片被过滤',
  collectResponsesToolCalls(mkAcc([[0, { id: 'c', name: '', args: '{}' }]])), [])

// ===== 6. 接线断言 =====

console.log('\n[接线] electron/lib/llmService.ts')
const svc = read('electron/lib/llmService.ts')
check('纯逻辑已下移到零依赖模块（契约脚本能 import）', svc.includes("from './llmProtocolPure'"))
check('本文件不再重复定义 buildResponsesBody', !svc.includes('function buildResponsesBody'))
check('本文件不再重复定义 withSessionHeaders', !svc.includes('function withSessionHeaders'))
check('本文件不再重复定义 REASONING_MODEL_RE', !svc.includes('export const REASONING_MODEL_RE ='))
check('仍然对外转出 REASONING_MODEL_RE（既有调用方不受影响）', svc.includes('export { REASONING_MODEL_RE }'))
check('adapters 注册了 openai-responses', svc.includes("'openai-responses': openAiResponsesAdapter"))
check('按模型选适配器（adapterFor 用 familyOf）', /function adapterFor\(p: ProviderConfig, model: string\)[\s\S]{0,200}familyOf\(p\.type, p\.modelFamilies, model\)/.test(svc))
check('llmInvokeOnce 用 adapterFor（不再只看 provider.type）', svc.includes('const adapter = adapterFor(provider, model)'))
check('流式入口用 adapterFor', svc.includes('const adapter = adapterFor(t.provider, t.model)'))
check('模型级测试用 adapterFor（否则 responses 模型测试必 4xx）', svc.includes('adapterFor(p, model).chat(p, {'))
check('authHeaders 接受并覆盖会话 ID', svc.includes('withSessionHeaders(p.headers, sessionId)'))
check('anthropicHeaders 同样覆盖会话 ID', svc.includes('withSessionHeaders(p.headers, sessionId)'))
check('authHeaders 带自定义 User-Agent', /function authHeaders[\s\S]{0,300}'User-Agent': userAgent\(\)/.test(svc))
check('anthropicHeaders 带自定义 User-Agent', /function anthropicHeaders[\s\S]{0,300}'User-Agent': userAgent\(\)/.test(svc))
check('chat/chatStream 把 sessionId 传进适配器', (svc.match(/sessionId: req\.sessionId/g) ?? []).length >= 2)
check('LlmInvokeRequest 暴露 sessionId', /interface LlmInvokeRequest[\s\S]{0,600}sessionId\?: string/.test(svc))
check('ChatRequest 暴露 sessionId', /interface ChatRequest[\s\S]{0,600}sessionId\?: string/.test(svc))
check('visionChat 固定走 chat 线格式（不按协议族分派）', svc.includes('openAiCompatibleAdapter.chat(found.provider, {'))
check('sanitizeInfo 回传 modelFamilies', svc.includes('modelFamilies: p.modelFamilies ?? {}'))
check('saveProviderDraft 校验协议值', svc.includes("['chat', 'messages', 'responses'].includes(String(v))"))
check('未传 modelFamilies 时保留原值（编辑供应商不会清掉协议标记）',
  svc.includes('if (draft.modelFamilies !== undefined) p.modelFamilies = modelFamilies'))
check('refreshModels 会清掉已下架模型的协议残留', svc.includes('filter(([m]) => models.includes(m))'))
check('注册了 llm:setModelFamily', svc.includes("ipcMain.handle('llm:setModelFamily'"))
check('视觉转写接受 sessionId', /interface VisionChatRequest[\s\S]{0,500}sessionId\?: string/.test(svc))

console.log('\n[接线] 调用点会话 ID')
const agent = read('electron/lib/agentService.ts')
check('agentService 主循环带 sessionId', (agent.match(/sessionId \}/g) ?? []).length >= 2)
check('agentCompress 带 sessionId', read('electron/lib/agentCompress.ts').includes('sessionId,'))
check('inlineSuggest 用固定用途名（不能是随机值）', read('electron/lib/aiAssistant/inlineSuggest.ts').includes("sessionId: 'inline-suggest'"))
check('translateService 用固定用途名', read('electron/lib/translateService.ts').includes("sessionId: 'translate'"))
check('manualChannel 用固定用途名', read('electron/lib/manualChannel.ts').includes("sessionId: 'manual-classify'"))
const course = read('electron/lib/aiTeachingCourse.ts')
check('课程交接沿用会话 ID', /content: user \}\], sessionId \}\)/.test(course))
check('单元总结/出题用稳定用途名', course.includes('course:${wsId}:${unitId}:summary') && course.includes('course:${wsId}:${unitId}:quiz'))
check('视觉转写按 会话+条目 给稳定 ID', read('electron/lib/aiTeachingSources.ts').includes('sessionId: `${sessionId}:vision:${no}`'))
check('没有任何调用点传随机 sessionId', !/sessionId:\s*(randomUUID|crypto\.randomUUID|Math\.random)/.test(agent + course + svc))

console.log('\n[接线] 渲染层')
const types = read('src/types/index.ts')
check('LlmProviderType 含 openai-responses', types.includes("'openai-compatible' | 'ollama' | 'anthropic' | 'openai-responses'"))
check('LlmModelFamily 已定义', types.includes('export type LlmModelFamily'))
check('LlmProviderInfo 暴露 modelFamilies', /interface LlmProviderInfo[\s\S]{0,600}modelFamilies\?: Record<string, LlmModelFamily>/.test(types))
check('LlmProviderDraft 接受 modelFamilies', /interface LlmProviderDraft[\s\S]{0,800}modelFamilies\?: Record<string, LlmModelFamily>/.test(types))
check('ElectronAPI 暴露 llmSetModelFamily', types.includes('llmSetModelFamily:'))
const names = read('src/lib/modelNames.ts')
check('modelNames 提供协议提示表', names.includes('export const MODEL_FAMILY_HINTS'))
check('免费清单含官方 Go 两条', names.includes("'longcat-2.5-preview-free'") && names.includes("'step-5-preview-free'"))
check('不再把已下线的 ox-alpha-free 当 Go 免费模型', !names.includes("'ox-alpha-free'"))
const tab = read('src/modules/settings/views/AiModelsTab.tsx')
check('模型页有逐模型协议面板', tab.includes('function ModelFamilyPanel'))
check('模型页能一键按官方端点表标记', tab.includes('fillFromHints'))
check('模型页能识别 opencode 旧地址并给一键替换', tab.includes('function officialUrlFor') && tab.includes('switchToOfficial'))
check('类型下拉含 Responses 选项', tab.includes('value="openai-responses"'))

// ===== 7. 官方端点表与提示表一致性 =====

console.log('\n[一致性] 官方端点表 → MODEL_FAMILY_HINTS')
// 官方 https://opencode.ai/v2/docs/console/go "Endpoints" 表（2026-10-13 抄录）
const OFFICIAL = {
  responses: ['grok-4.7', 'grok-4.6', 'gpt-6-luna', 'gpt-5.6-luna', 'muse-spark-1.3-contributor', 'muse-spark-1.2-contributor'],
  messages: ['claude-haiku-5-5', 'minimax-m3', 'minimax-m2.7', 'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus'],
  chat: ['glm-5.3-flash', 'glm-5.3', 'glm-5.2', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'longcat-2.0',
    'deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp',
    'mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.5', 'mimo-v2.5-pro', 'hy4-preview', 'hy3', 'space-bunny',
    'longcat-2.5-preview-free', 'step-5-preview-free'],
}
const hintsSrc = names.slice(names.indexOf('MODEL_FAMILY_HINTS'), names.indexOf('PRETTY_OVERRIDES'))
let mismatch = []
for (const [fam, ids] of Object.entries(OFFICIAL)) {
  for (const id of ids) {
    const m = hintsSrc.match(new RegExp(`'${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*'(\\w+)'`))
    if (!m) mismatch.push(`${id} 缺失`)
    else if (m[1] !== fam) mismatch.push(`${id} 应为 ${fam}，实为 ${m[1]}`)
  }
}
check(`官方端点表 ${Object.values(OFFICIAL).flat().length} 条与提示表逐条一致`, mismatch.length === 0, mismatch.join('; '))
check('提示表不含官方端点表之外的猜测项',
  [...hintsSrc.matchAll(/'([a-z0-9.-]+)':\s*'(chat|messages|responses)'/g)].map(m => m[1])
    .every(id => Object.values(OFFICIAL).flat().includes(id)))
check('免费模型两条都标了协议（否则选成默认会打到错路径）',
  ['longcat-2.5-preview-free', 'step-5-preview-free'].every(id => hintsSrc.includes(`'${id}'`)))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
