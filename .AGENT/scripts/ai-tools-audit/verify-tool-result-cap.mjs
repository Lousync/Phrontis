/**
 * 验证工具结果体积治理的运行时行为（长资料方案 §6.5/§6.6：profile 化硬上限 + 结构化截断 + 最近结果预算）。
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

const startAt = src.indexOf('const CAP_KEEP_KEYS')
if (startAt < 0) throw new Error('未找到 CAP_KEEP_KEYS（profile 化治理段起点）')
const profilesAt = src.indexOf('const TOOL_RESULT_PROFILES')
if (profilesAt < 0) throw new Error('未找到 TOOL_RESULT_PROFILES')
const fnAt = src.indexOf('function compressStaleToolResults')
if (fnAt < 0) throw new Error('未找到 compressStaleToolResults')
// TOOL_RESULT_PROFILES 与 CAP_KEEP_KEYS 都要进沙箱：取两者更早的起点
const code = src.slice(Math.min(startAt, profilesAt), fnAt) + sliceBalanced(src, fnAt)

const js = stripTypeScriptTypes(
  `${code}\nexport { TOOL_RESULT_PROFILES, CAP_KEEP_KEYS, capStructuredValue, capHint, capToolResult, shrinkValue, compressOneToolResult, compressStaleToolResults }`,
  { mode: 'strip', sourceMap: false },
)
const mod = await import(`data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`)

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const P = mod.TOOL_RESULT_PROFILES

// ---------- 0. profile 表（§7.2） ----------
check('三档 profile 齐全', !!P.normal && !!P['long-128k'] && !!P['long-1m'])
check('normal 单条 48k / 窗口 120k / 6 条', P.normal.resultChars === 48000 && P.normal.recentBudgetChars === 120000 && P.normal.recentMaxItems === 6)
check('long-1m 单条 120k / 窗口 400k / 12 条', P['long-1m'].resultChars === 120000 && P['long-1m'].recentBudgetChars === 400000 && P['long-1m'].recentMaxItems === 12)
check('long-128k 介于两档之间', P['long-128k'].resultChars === 64000 && P['long-128k'].recentBudgetChars === 200000)

// ---------- A. 单条结果硬上限（结构化截断，§6.5） ----------
const bigPayload = JSON.stringify({
  ok: true,
  data: {
    total: 127,
    returned: 400,
    items: Array.from({ length: 400 }, (_, i) => ({ id: `id-${i}`, question: '题目题干内容'.repeat(20) })),
  },
})
check('构造的样本确实超过 normal 硬上限', bigPayload.length > P.normal.resultChars,
  `${bigPayload.length} vs ${P.normal.resultChars}`)

const capped = mod.capToolResult(bigPayload, 'builtin.quiz.list', P.normal)
let cappedParsed = null
try { cappedParsed = JSON.parse(capped) } catch { /* 保持 null */ }
check('截断结果是合法 JSON', cappedParsed !== null)
check('截断结果标记 _truncated', cappedParsed?._truncated === true)
check('截断结果带原始长度 _originalChars', cappedParsed?._originalChars === bigPayload.length,
  String(cappedParsed?._originalChars))
check('截断结果给出收窄指引', typeof cappedParsed?._hint === 'string' && cappedParsed._hint.includes('缩小范围'),
  String(cappedParsed?._hint ?? '').slice(0, 40))
check('截断后体积显著小于原体积', capped.length < bigPayload.length * 0.5,
  `${capped.length} vs ${bigPayload.length}`)
check('标量 total 保留', cappedParsed?.data?.total === 127)
check('大数组保留前 maxItems 项 + 省略说明', Array.isArray(cappedParsed?.data?.items)
  && cappedParsed.data.items.length === P.normal.maxItems + 1
  && String(cappedParsed.data.items[P.normal.maxItems]).includes('项已省略'))

// 续读坐标：vault.read 分页结果被截断时，nextOffset/hasMore 原样保留且提示带 offset
const vaultReadPayload = JSON.stringify({
  ok: true,
  data: { path: '教材/操作系统.md', content: '正'.repeat(100000), offset: 0, nextOffset: 40000, hasMore: true, totalChars: 300000, mtimeMs: 1731000000000 },
})
const cappedRead = mod.capToolResult(vaultReadPayload, 'builtin.vault.read', P.normal)
let readParsed = null
try { readParsed = JSON.parse(cappedRead) } catch { /* 保持 null */ }
check('vault.read 截断后 nextOffset/hasMore 保留', readParsed?.data?.nextOffset === 40000 && readParsed?.data?.hasMore === true)
check('vault.read 截断提示带 offset 续读指令', String(readParsed?._hint ?? '').includes('offset=40000'),
  String(readParsed?._hint ?? '').slice(0, 80))
check('vault.read 截断提示带未读字符数', String(readParsed?._hint ?? '').includes('未读'))
// pdf 页码坐标
const docPayload = JSON.stringify({ ok: true, data: { path: '教材.pdf', content: '页'.repeat(100000), nextPage: 31, pageCount: 200, pagesRead: 30 } })
const cappedDoc = mod.capToolResult(docPayload, 'builtin.vault.read', P.normal)
check('pdf 截断提示带 pages 续读指令', String(JSON.parse(cappedDoc)?._hint ?? '').includes('pages="31-200"'))
// 长字符串截断但 path 等坐标字段不截
const longPathPayload = JSON.stringify({ ok: true, data: { path: 'p'.repeat(20000), content: 'x'.repeat(100000) } })
const cappedPath = JSON.parse(mod.capToolResult(longPathPayload, 'builtin.vault.list', P.normal))
check('CAP_KEEP_KEYS 字段不被截断', cappedPath?.data?.path === 'p'.repeat(20000))
check('普通长字符串被截到 maxStringChars', String(cappedPath?.data?.content).length <= P.normal.maxStringChars + 30)

// 切在转义序列中间也必须仍产出合法 JSON
const escaped = JSON.stringify({ ok: true, data: { s: '中'.repeat(20000) } })
const capped2 = mod.capToolResult(escaped, 'builtin.vault.read', P.normal)
let ok2 = true
try { JSON.parse(capped2) } catch { ok2 = false }
check('切在 \\u 转义中间仍是合法 JSON', ok2)

// 非结构化回退：解析失败走 preview
const capped3 = JSON.parse(mod.capToolResult('不是 JSON 的工具结果'.repeat(5000), 'builtin.some.tool', P.normal))
check('非 JSON 回退 preview 且标注 totalChars', capped3?.preview?.length === P.normal.previewChars && capped3?.totalChars > P.normal.resultChars,
  `${capped3?.preview?.length} / ${capped3?.totalChars}`)

// ---------- C. 历史渐进压缩（最近结果预算，§6.6） ----------
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
check('构造的大结果确实超压缩阈值', bigResult.length > P.normal.compressThreshold,
  `${bigResult.length} vs ${P.normal.compressThreshold}`)

// §2.2 G5 场景：并行读 4 个文件，4 条结果必须都在最近窗口内（不再「第 1 条立即被压」）
const fourParallel = (n) => {
  const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u1' }]
  for (let i = 0; i < n; i++) {
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}` }] })
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: bigResult })
  }
  msgs.push({ role: 'user', content: 'u2' })
  return msgs
}
const out4 = mod.compressStaleToolResults(fourParallel(4), P.normal)
check('G5：4 条并行结果全部完整保留（不再保留 3 压 1）',
  [3, 5, 7, 9].every((i) => out4[i].content === bigResult), JSON.stringify([3, 5, 7, 9].map((i) => out4[i].content === bigResult)))

const mkConvo = () => fourParallel(8) // 8 条大结果：窗口留最新 6，最老 2 条被压
const out1 = mod.compressStaleToolResults(mkConvo(), P.normal)
check('窗外的大结果被压缩', String(out1[3].content).includes('_compressed') && String(out1[5].content).includes('_compressed'))
check('窗口内（最新 maxItems 条）保持完整', out1[7].content === bigResult && out1[9].content === bigResult && out1[15].content === bigResult)
check('非 tool 消息未被改动', out1[0].content === 'sys' && out1[1].content === 'u1' && out1[18].content === 'u2')
check('tool_call_id 被保留', out1[3].tool_call_id === 'c0')

const shrunk = JSON.parse(String(out1[3].content))
check('压缩后保留标量 total', shrunk?.data?.total === 100, String(shrunk?.data?.total))
check('大数组降级为占位说明', typeof shrunk?.data?.items === 'string' && shrunk.data.items.includes('20 项已省略'))
check('小数组 tags 保留', Array.isArray(shrunk?.data?.tags), JSON.stringify(shrunk?.data?.tags))
check('压缩结果体积大幅下降', String(out1[3].content).length < bigResult.length * 0.2,
  `${String(out1[3].content).length} vs ${bigResult.length}`)

// 小结果不压缩（阈值内）
const mixed = fourParallel(8).map((m, i) => i === 3 ? { ...m, content: smallResult } : m)
const outM = mod.compressStaleToolResults(mixed, P.normal)
check('窗外的小结果保持原样（不值得动）', outM[3].content === smallResult)

// ---- 纯函数性：cache 前缀稳定的前提 ----
const out2 = mod.compressStaleToolResults(mkConvo(), P.normal)
check('纯函数：同一输入两次调用逐字节相同', JSON.stringify(out1) === JSON.stringify(out2))
// profile 只由参数决定输出：long-1m 窗口更大 → 同样 8 条大结果全保留；normal 仍压最老 2 条
const outBig = mod.compressStaleToolResults(mkConvo(), P['long-1m'])
check('profile 放大窗口：long-1m 下 8 条全保留',
  [3, 5, 7, 9, 11, 13, 15, 17].every((i) => outBig[i].content === bigResult))
check('profile 放大不改变 normal 的结论', String(out1[3].content).includes('_compressed'))

// ---- 轮次推进后，老消息的压缩结果必须保持不变 ----
const grown = mkConvo()
grown.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c99' }] })
grown.push({ role: 'tool', tool_call_id: 'c99', content: bigResult })
const out3 = mod.compressStaleToolResults(grown, P.normal)
check('轮次推进后旧消息的压缩结果不变（前缀稳定）', out3[3].content === out1[3].content,
  `${String(out3[3].content).length} vs ${String(out1[3].content).length}`)
check('轮次推进后新消息未被误压', out3[20].content === bigResult,
  `idx20 len=${String(out3[20]?.content ?? '').length}`)

// ---- 幂等：压缩过的结果再压缩不再变化 ----
const twice = mod.compressOneToolResult(String(out1[3].content))
check('压缩结果再次压缩不再变化', twice === String(out1[3].content),
  `${twice.length} vs ${String(out1[3].content).length}`)

// ---- 窗口开窗算法：至少保留 minItems ----
const tinyOnly = (() => {
  const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u1' }]
  for (let i = 0; i < 3; i++) {
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: `t${i}` }] })
    msgs.push({ role: 'tool', tool_call_id: `t${i}`, content: JSON.stringify({ ok: true, data: { n: 'x'.repeat(200000) } }) })
  }
  return msgs
})()
check('窗口：minItems 兜底（单条超预算也至少留 2 条完整）', (() => {
  const out = mod.compressStaleToolResults(tinyOnly, P.normal)
  return out[5].content === tinyOnly[5].content && out[7].content === tinyOnly[7].content
    && String(out[3].content).includes('_compressed')
})())

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
