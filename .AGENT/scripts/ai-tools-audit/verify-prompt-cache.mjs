/**
 * 验证 Anthropic 提示缓存断点的实际请求体形状（运行时契约，非源码正则断言）。
 *
 * 做法：从 llmService.ts 中抽出 `CACHE_CONTROL` 常量与 `buildAnthropicBody` 函数体，
 * 用 node:module 的 stripTypeScriptTypes 剥掉 TS 类型标注后在沙箱里执行 ——
 * 这样验的是**真实函数**，而不是复制的副本（副本会与实现漂移，验了等于没验）。
 *
 * 断言点：
 *   1. system 必须是数组形式（字符串形式无法挂 cache_control）
 *   2. tools 只给最后一个打断点（前缀式缓存，逐个打会浪费 4 个断点配额）
 *   3. tools[0..n-2] 不得带 cache_control
 *   4. 无 tools 时 system 断点仍需存在
 *   5. 断点值是 { type: 'ephemeral' }
 *
 * 用法：node .AGENT/scripts/ai-tools-audit/verify-prompt-cache.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

// 默认目标推导自脚本位置（勿写死盘符：在 worktree 里跑会静默校验主仓 → 假 PASS）
const SRC = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..', 'electron/lib/llmService.ts'))
const src = fs.readFileSync(SRC, 'utf8')

/** 按大括号配平，从 from 处切出完整函数定义文本 */
function sliceBalanced(text, from) {
  const start = text.indexOf('{', from)
  if (start < 0) throw new Error('未找到函数体起始大括号')
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(from, i + 1)
    }
  }
  throw new Error('大括号未配平')
}

const constAt = src.indexOf('const CACHE_CONTROL')
if (constAt < 0) throw new Error('未找到 CACHE_CONTROL 定义')
const constLineEnd = src.indexOf('\n', src.indexOf('as const', constAt))
const constText = src.slice(constAt, constLineEnd)

const fnAt = src.indexOf('function buildAnthropicBody')
if (fnAt < 0) throw new Error('未找到 buildAnthropicBody')
const fnText = sliceBalanced(src, fnAt)

const js = stripTypeScriptTypes(`${constText}\n${fnText}\nexport { buildAnthropicBody }`, {
  mode: 'strip',
  sourceMap: false,
})
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`
)

const twoTools = [
  { type: 'function', function: { name: 'a', description: 'A', parameters: { type: 'object' } } },
  { type: 'function', function: { name: 'b', description: 'B', parameters: { type: 'object' } } },
]
const msgs = [
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '你好' },
]

const checks = []
const check = (name, pass, detail) => checks.push({ name, pass, detail })

const withTools = mod.buildAnthropicBody({ model: 'm', messages: msgs, tools: twoTools, maxTokens: 100 }, false)
check('system 为数组形式', Array.isArray(withTools.system), `typeof=${typeof withTools.system}`)
check('system 带 ephemeral 断点', withTools.system?.[0]?.cache_control?.type === 'ephemeral',
  JSON.stringify(withTools.system?.[0]?.cache_control))
check('system 文本未被破坏', withTools.system?.[0]?.text === '你是助手', String(withTools.system?.[0]?.text))
check('tools 数量不变', withTools.tools?.length === 2, `len=${withTools.tools?.length}`)
check('tools 末元素带断点', withTools.tools?.[1]?.cache_control?.type === 'ephemeral',
  JSON.stringify(withTools.tools?.[1]?.cache_control))
check('tools 非末元素不带断点', withTools.tools?.[0]?.cache_control === undefined,
  JSON.stringify(withTools.tools?.[0]?.cache_control))
check('tools 既有字段完整', withTools.tools?.[1]?.name === 'b' && withTools.tools?.[1]?.input_schema?.type === 'object',
  JSON.stringify({ name: withTools.tools?.[1]?.name, schema: withTools.tools?.[1]?.input_schema }))
check('messages 未被改动', withTools.messages?.length === 1 && withTools.messages?.[0]?.role === 'user',
  JSON.stringify(withTools.messages))
check('非流式不带 stream', withTools.stream === undefined, String(withTools.stream))

const noTools = mod.buildAnthropicBody({ model: 'm', messages: msgs, maxTokens: 100 }, false)
check('无 tools 时 system 断点仍在', noTools.system?.[0]?.cache_control?.type === 'ephemeral',
  JSON.stringify(noTools.system?.[0]?.cache_control))
check('无 tools 时不产出 tools 字段', noTools.tools === undefined, String(noTools.tools))

const streamed = mod.buildAnthropicBody({ model: 'm', messages: msgs, tools: twoTools, maxTokens: 100 }, true)
check('流式带 stream:true', streamed.stream === true, String(streamed.stream))
check('流式同样带断点', streamed.tools?.[1]?.cache_control?.type === 'ephemeral',
  JSON.stringify(streamed.tools?.[1]?.cache_control))

// 三家 usage 解析都必须读缓存命中量（否则无法观测是否生效）
const usageChecks = [
  ['Anthropic 非流式读 cache_read_input_tokens', /cache_read_input_tokens/.test(src)],
  ['Anthropic 流式 message_start 读 cache_read', /json\.message\?\.usage\?\.cache_read_input_tokens/.test(src)],
  ['OpenAI 兼容非流式读 prompt_tokens_details.cached_tokens', /json\?\.usage\?\.prompt_tokens_details\?\.cached_tokens/.test(src)],
  ['OpenAI 兼容流式读 prompt_tokens_details.cached_tokens', /json\.usage\.prompt_tokens_details\?\.cached_tokens/.test(src)],
]
for (const [n, p] of usageChecks) check(n, p, '')

const out = []
out.push(`源文件: ${SRC}`)
out.push('')
for (const c of checks) out.push(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : `   ← ${c.detail}`}`)
const failed = checks.filter((c) => !c.pass).length
out.push('')
out.push(`结论: ${failed === 0 ? 'PASS' : `FAIL（${failed} 项）`} —— ${checks.length} 项断言`)

const text = out.join('\n')
fs.mkdirSync(path.dirname(SRC) + '/../../.AGENT/scripts/ai-tools-audit', { recursive: true })
fs.writeFileSync(path.dirname(SRC) + '/../../.AGENT/scripts/ai-tools-audit/out-prompt-cache-verify.txt', text, 'utf8')
process.exitCode = failed === 0 ? 0 : 1
