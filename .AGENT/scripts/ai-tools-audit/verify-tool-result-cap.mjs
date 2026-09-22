/**
 * 验证工具结果体积治理的运行时行为（A 硬上限 + C 历史渐进压缩）。
 *
 * 做法与 verify-prompt-cache.mjs 一致：从 agentService.ts 抽出真实的常量与函数，
 * 用 node:module 的 stripTypeScriptTypes 剥掉类型标注后沙箱执行 —— 验的是**真实实现**。
 *
 * 最关键的一条断言是「纯函数性」：压缩结果必须只由输入决定。因为 agent loop 每轮
 * 都会重新对整段 convo 调压缩，一旦同一段历史在两轮里被压成不同文本，prompt cache
 * 的前缀就被打散，省下的 token 又会从缓存失效里漏回去。
 *
 * 用法：node .AGENT/scripts/ai-tools-audit/verify-tool-result-cap.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

// 默认目标推导自脚本位置（勿写死盘符：在 worktree 里跑会静默校验主仓 → 假 PASS）
const SRC = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..', 'electron/lib/agentService.ts'))
const src = fs.readFileSync(SRC, 'utf8')

/** 按大括号配平切出完整函数定义 */
function sliceBalanced(text, from) {
  const start = text.indexOf('{', from)
  if (start < 0) throw new Error('未找到函数体起始大括号')
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(from, i + 1)
    }
  }
  throw new Error('大括号未配平')
}

const startAt = src.indexOf('const MAX_TOOL_RESULT_CHARS')
if (startAt < 0) throw new Error('未找到 MAX_TOOL_RESULT_CHARS')
const fnAt = src.indexOf('function compressStaleToolResults')
if (fnAt < 0) throw new Error('未找到 compressStaleToolResults')
const code = src.slice(startAt, fnAt) + sliceBalanced(src, fnAt)

const js = stripTypeScriptTypes(
  `${code}\nexport { MAX_TOOL_RESULT_CHARS, TOOL_RESULT_PREVIEW_CHARS, KEEP_RECENT_TOOL_RESULTS, COMPRESS_TOOL_RESULT_CHARS, capToolResult, shrinkValue, compressOneToolResult, compressStaleToolResults }`,
  { mode: 'strip', sourceMap: false },
)
const mod = await import(`data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`)

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })

// ---------- A. 单条结果硬上限 ----------
const bigPayload = JSON.stringify({
  ok: true,
  data: {
    total: 127,
    returned: 200,
    items: Array.from({ length: 200 }, (_, i) => ({ id: `id-${i}`, question: '题目题干内容'.repeat(20) })),
  },
})
check('构造的样本确实超过硬上限', bigPayload.length > mod.MAX_TOOL_RESULT_CHARS,
  `${bigPayload.length} vs ${mod.MAX_TOOL_RESULT_CHARS}`)

const capped = mod.capToolResult(bigPayload, 'builtin.quiz.list')
let cappedParsed = null
try { cappedParsed = JSON.parse(capped) } catch { /* 保持 null */ }
check('截断结果是合法 JSON', cappedParsed !== null)
check('截断结果标记 truncated', cappedParsed?.truncated === true)
check('截断结果带原始长度 totalChars', cappedParsed?.totalChars === bigPayload.length,
  String(cappedParsed?.totalChars))
check('截断结果保留预览', typeof cappedParsed?.preview === 'string'
  && cappedParsed.preview.length === mod.TOOL_RESULT_PREVIEW_CHARS,
  `preview len=${cappedParsed?.preview?.length}`)
check('截断结果给出收窄指引', typeof cappedParsed?.hint === 'string' && cappedParsed.hint.includes('缩小范围'),
  String(cappedParsed?.hint ?? '').slice(0, 40))
check('截断后体积显著小于原体积', capped.length < bigPayload.length * 0.5,
  `${capped.length} vs ${bigPayload.length}`)

// 切在转义序列中间也必须仍产出合法 JSON
const escaped = JSON.stringify({ ok: true, data: { s: '中'.repeat(20000) } })
const capped2 = mod.capToolResult(escaped, 'builtin.vault.read')
let ok2 = true
try { JSON.parse(capped2) } catch { ok2 = false }
check('切在 \\u 转义中间仍是合法 JSON', ok2)

// ---------- C. 历史渐进压缩 ----------
const bigResult = JSON.stringify({
  ok: true,
  data: {
    total: 100,
    returned: 20,
    items: Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, question: '题'.repeat(200) })),
    tags: ['数据结构', '栈'],
    source: '408 学习空间 / 历年真题 / 2009 年',
  },
})
const smallResult = JSON.stringify({ ok: true, data: { ok: true, recordId: 'r1' } })
check('构造的大结果确实超压缩阈值', bigResult.length > mod.COMPRESS_TOOL_RESULT_CHARS,
  `${bigResult.length} vs ${mod.COMPRESS_TOOL_RESULT_CHARS}`)

const mkConvo = () => ([
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'u1' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
  { role: 'tool', tool_call_id: 'c1', content: bigResult },      // 老 + 大 → 压
  { role: 'assistant', content: '', tool_calls: [{ id: 'c2' }] },
  { role: 'tool', tool_call_id: 'c2', content: smallResult },    // 老 + 小 → 不压
  { role: 'assistant', content: '', tool_calls: [{ id: 'c3' }] },
  { role: 'tool', tool_call_id: 'c3', content: bigResult },      // 最近 3 条内 → 完整
  { role: 'assistant', content: '', tool_calls: [{ id: 'c4' }] },
  { role: 'tool', tool_call_id: 'c4', content: bigResult },      // 最近 3 条内 → 完整
  { role: 'user', content: 'u2' },
])

const out1 = mod.compressStaleToolResults(mkConvo())
check('老的大结果被压缩', String(out1[3].content).includes('_compressed'),
  String(out1[3].content).slice(0, 60))
check('老的小结果保持原样', out1[5].content === smallResult)
check('最近窗口内的结果保持完整', out1[7].content === bigResult && out1[9].content === bigResult)
check('非 tool 消息未被改动',
  out1[0].content === 'sys' && out1[1].content === 'u1' && out1[10].content === 'u2')
check('tool_call_id 被保留', out1[3].tool_call_id === 'c1')

const shrunk = JSON.parse(String(out1[3].content))
check('压缩后保留标量 total', shrunk?.data?.total === 100, String(shrunk?.data?.total))
check('压缩后保留标量 returned', shrunk?.data?.returned === 20, String(shrunk?.data?.returned))
check('大数组降级为占位说明', typeof shrunk?.data?.items === 'string' && shrunk.data.items.includes('20 项已省略'),
  String(shrunk?.data?.items))
check('小数组 tags 保留', Array.isArray(shrunk?.data?.tags), JSON.stringify(shrunk?.data?.tags))
check('短字符串 source 保留', typeof shrunk?.data?.source === 'string' && shrunk.data.source.includes('408'),
  String(shrunk?.data?.source))
check('压缩结果体积大幅下降', String(out1[3].content).length < bigResult.length * 0.2,
  `${String(out1[3].content).length} vs ${bigResult.length}`)

// ---- 纯函数性：cache 前缀稳定的前提 ----
const out2 = mod.compressStaleToolResults(mkConvo())
check('纯函数：同一输入两次调用逐字节相同',
  JSON.stringify(out1) === JSON.stringify(out2))

// ---- 轮次推进后，老消息的压缩结果必须保持不变 ----
const grown = mkConvo()
grown.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c5' }] })
grown.push({ role: 'tool', tool_call_id: 'c5', content: bigResult })
const out3 = mod.compressStaleToolResults(grown)
check('轮次推进后旧消息的压缩结果不变（前缀稳定）', out3[3].content === out1[3].content,
  `${String(out3[3].content).length} vs ${String(out1[3].content).length}`)
check('轮次推进后窗口内消息仍完整', out3[7].content === bigResult && out3[9].content === bigResult)
check('轮次推进后新消息未被误压', out3[12].content === bigResult,
  `idx12 role=${out3[12]?.role} len=${String(out3[12]?.content ?? '').length}`)

// ---- 幂等：压缩过的结果再压缩不再变化 ----
const twice = mod.compressOneToolResult(String(out1[3].content))
check('压缩结果再次压缩不再变化', twice === String(out1[3].content),
  `${twice.length} vs ${String(out1[3].content).length}`)

const out = []
out.push(`源文件: ${SRC}`)
out.push('')
for (const c of checks) out.push(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : `   ← ${c.detail}`}`)
const failed = checks.filter((c) => !c.pass).length
out.push('')
out.push(`结论: ${failed === 0 ? 'PASS' : `FAIL（${failed} 项）`} —— ${checks.length} 项断言`)

const text = out.join('\n')
const dst = path.resolve('.AGENT/scripts/ai-tools-audit/out-tool-result-cap-verify.txt')
fs.mkdirSync(path.dirname(dst), { recursive: true })
fs.writeFileSync(dst, text, 'utf8')
console.log(text)
process.exitCode = failed === 0 ? 0 : 1
