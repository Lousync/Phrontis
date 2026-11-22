#!/usr/bin/env node
/**
 * 契约验证：每条 AI 回复末尾「本轮消耗 + 缓存命中」纯函数
 * （`src/lib/messageUsagePure.ts`）+ 两处挂载点接线。
 *
 * 锁什么：
 *  1. 多轮 llm 步骤求和（含工具循环里的多条 llm step）；tool 步骤一律不计数；
 *  2. 拆分缺失时**逐条**退回 `tokens`（混合 trace 也不丢整轮）；
 *  3. 缓存命中：0% / 100% / 部分命中 / 越界夹取 / 缺 cachedTokens 字段（不显示假 0%）；
 *  4. 无 trace / 空 trace / 全是 tool / NaN / 负数 / 合计为 0 → null（界面不出 "≈0 tokens"）；
 *  5. `formatUsageToken` 的 999 / 1000 / 12345 / 非数边界，`formatUsageCost` 的小额位数；
 *  6. 挂载点：助手面不再有 TokensOf（同一份数据只出现一次），两面都挂 UsageFooter，
 *     且这一行不套 `.kb-l1`（窄宿主不许被隐掉）。
 *
 * 运行（仓库根目录）：node .AGENT/scripts/ai-teaching/verify-message-usage.mjs [仓库路径]
 * 输出纯 ASCII（禁 emoji，AGENTS.md）；期望全部 PASS 且 exit=0。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })

async function loadStripped(relPath, tmpName) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-usage-'))
  const tmpFile = path.join(tmpDir, tmpName)
  fs.writeFileSync(tmpFile, stripTypeScriptTypes(src, { mode: 'strip' }))
  const mod = await import(pathToFileURL(tmpFile).href)
  return { mod, tmpDir }
}

const { mod: pure, tmpDir: pureTmp } = await loadStripped('src/lib/messageUsagePure.ts', 'messageUsagePure.mjs')
const { summarizeMessageUsage, formatUsageToken, formatUsageCost } = pure

/** 构造一条 llm 步骤（只给需要的字段；其余按落库形状补默认值） */
const llm = (extra) => ({ kind: 'llm', ok: true, durationMs: 10, ...extra })
const tool = (extra) => ({ kind: 'tool', name: 'builtin.read', ok: true, durationMs: 5, ...extra })

// ---------------------------------------------------------------- 1. 求和
const twoRounds = summarizeMessageUsage([
  llm({ promptTokens: 1200, completionTokens: 300, tokens: 1500 }),
  tool({ tokens: 9999, promptTokens: 9999, cachedTokens: 9999 }),
  llm({ promptTokens: 800, completionTokens: 200, tokens: 1000 }),
])
check(
  '1. 多轮 llm 求和（tool 步骤不计数）：2000+500=2500',
  twoRounds && twoRounds.total === 2500 && twoRounds.prompt === 2000 && twoRounds.completion === 500 &&
    twoRounds.hasSplit === true,
  JSON.stringify(twoRounds),
)

const mix = summarizeMessageUsage([
  llm({ promptTokens: 1000, completionTokens: 500 }),
  llm({ tokens: 700 }), // 旧格式：只有合计
])
check(
  '2. 拆分缺失逐条退化：1500 + 700 = 2200',
  mix && mix.total === 2200 && mix.prompt === 1000 && mix.hasSplit === true,
  JSON.stringify(mix),
)

const onlyTotal = summarizeMessageUsage([llm({ tokens: 1500 })])
check(
  '3. 只有 tokens（无拆分）：total=1500 / hasSplit=false / prompt=0',
  onlyTotal && onlyTotal.total === 1500 && onlyTotal.hasSplit === false && onlyTotal.prompt === 0,
  JSON.stringify(onlyTotal),
)

const multiTotal = summarizeMessageUsage([llm({ tokens: 400 }), llm({ tokens: 600 })])
check('4. 多条「只有 tokens」也求和：1000', multiTotal && multiTotal.total === 1000, JSON.stringify(multiTotal))

const zeroSplit = summarizeMessageUsage([llm({ promptTokens: 0, completionTokens: 0, tokens: 0 })])
check('5. 合计为 0 → null（不出 "≈0 tokens"）', zeroSplit === null, JSON.stringify(zeroSplit))

// ---------------------------------------------------------------- 2. 缓存命中
const hit = (promptTokens, cachedTokens) => summarizeMessageUsage([llm({ promptTokens, completionTokens: 10, cachedTokens })])
const pctOf = (u) => (u ? u.cacheHitPct : 'null')
check('6. 缓存未命中 0%', pctOf(hit(1000, 0)) === 0, String(pctOf(hit(1000, 0))))
check('7. 全命中 100%', pctOf(hit(1000, 1000)) === 100, String(pctOf(hit(1000, 1000))))
check('8. 部分命中取整 68%', pctOf(hit(2500, 1700)) === 68, String(pctOf(hit(2500, 1700))))
check('9. cached > prompt 夹到 100%', pctOf(hit(100, 900)) === 100, String(pctOf(hit(100, 900))))
check('10. 缺 cachedTokens 字段 → null（不显示假 0%）', pctOf(hit(1000, undefined)) === null, String(pctOf(hit(1000, undefined))))
check('11. prompt 为 0 但有 cached → null（无分母）', pctOf(summarizeMessageUsage([llm({ completionTokens: 5, cachedTokens: 5 })])) === null, '')
const cachedSum = summarizeMessageUsage([
  llm({ promptTokens: 400, completionTokens: 10, cachedTokens: 200 }),
  llm({ promptTokens: 600, completionTokens: 10, cachedTokens: 500 }),
])
check(
  '12. 命中率按整轮 Σcached / Σprompt：700/1000 = 70%',
  cachedSum && cachedSum.cached === 700 && cachedSum.cacheHitPct === 70,
  JSON.stringify(cachedSum),
)

// ---------------------------------------------------------------- 3. 费用
const cost = summarizeMessageUsage([
  llm({ promptTokens: 100, completionTokens: 10, costUsd: 0.012 }),
  llm({ promptTokens: 100, completionTokens: 10, costUsd: null }),
])
check('13. 费用求和且忽略 null：0.012', cost && Math.abs(cost.costUsd - 0.012) < 1e-9, JSON.stringify(cost))
const noCost = summarizeMessageUsage([llm({ promptTokens: 100, completionTokens: 10 })])
check('14. 全无价目 → costUsd=null', noCost && noCost.costUsd === null, JSON.stringify(noCost))

// ---------------------------------------------------------------- 4. 退化输入
const badCases = [
  ['无 trace', summarizeMessageUsage(undefined)],
  ['null trace', summarizeMessageUsage(null)],
  ['空 trace', summarizeMessageUsage([])],
  ['全是 tool 步骤', summarizeMessageUsage([tool({ tokens: 500 })])],
  ['NaN 字段', summarizeMessageUsage([llm({ promptTokens: Number.NaN, completionTokens: Number.NaN })])],
  ['Infinity 字段', summarizeMessageUsage([llm({ tokens: Number.POSITIVE_INFINITY })])],
  ['负数 tokens', summarizeMessageUsage([llm({ tokens: -100 })])],
  ['字符串字段', summarizeMessageUsage([llm({ tokens: '500', promptTokens: '400' })])],
]
const badFailed = badCases.filter(([, v]) => v !== null).map(([n, v]) => `${n} => ${JSON.stringify(v)}`)
check('15. 无用量 / 坏输入一律 null 且不崩', badFailed.length === 0, badFailed.join(' | '))

const withBad = summarizeMessageUsage([
  llm({ promptTokens: 500, completionTokens: 100 }),
  llm({ promptTokens: Number.NaN, completionTokens: Number.NaN }),
])
check(
  '16. 坏步骤被跳过、好步骤照算（600）',
  withBad && withBad.total === 600 && Number.isFinite(withBad.total),
  JSON.stringify(withBad),
)

// ---------------------------------------------------------------- 5. 格式化
const fmtCases = [[999, '999'], [1000, '1.0k'], [12345, '12k'], [1500, '1.5k'], [0, '0'], [-5, '0'], [Number.NaN, '0'], [Number.POSITIVE_INFINITY, '0']]
const fmtBad = fmtCases.filter(([n, want]) => formatUsageToken(n) !== want).map(([n, want]) => `${n} => ${formatUsageToken(n)} != ${want}`)
check('17. formatUsageToken 边界：999 / 1000 / 12345 / 0 / 负数 / NaN', fmtBad.length === 0, fmtBad.join(' | '))

const costCases = [[0, '$0'], [0.0034, '$0.0034'], [0.125, '$0.125'], [1.5, '$1.50'], [Number.NaN, '$0']]
const costBad = costCases.filter(([n, want]) => formatUsageCost(n) !== want).map(([n, want]) => `${n} => ${formatUsageCost(n)} != ${want}`)
check('18. formatUsageCost 小额位数 / 0 / NaN', costBad.length === 0, costBad.join(' | '))

// ---------------------------------------------------------------- 6. 挂载点
const messageListSrc = fs.readFileSync(path.join(ROOT, 'src/components/shared/AssistantPanel/MessageList.tsx'), 'utf8')
const teachSrc = fs.readFileSync(path.join(ROOT, 'src/modules/ai-teaching/index.tsx'), 'utf8')
const footerSrc = fs.readFileSync(path.join(ROOT, 'src/components/shared/AssistantPanel/UsageFooter.tsx'), 'utf8')

check('19. 助手面动作行不再挂 TokensOf（同一份数据只说一次）',
  !messageListSrc.includes('TokensOf'), '')
check('20. 助手面挂 UsageFooter（assistant 消息块末尾）',
  messageListSrc.includes("from './UsageFooter'") && messageListSrc.includes('<UsageFooter trace={m.trace}'), '')
check('21. AI 教学中栏挂同一个 UsageFooter',
  teachSrc.includes("from '../../components/shared/AssistantPanel/UsageFooter'") && teachSrc.includes('<UsageFooter trace={m.trace}'), '')
const footerClassLines = footerSrc.split('\n').filter((l) => l.includes('className'))
check('22. 用量行不套 .kb-l1（窄宿主不许被容器查询隐掉）',
  footerSrc.includes('className') && footerClassLines.every((l) => !l.includes('kb-l1') && !l.includes('kb-l2')), '')
check('23. 窄宿主可收缩：min-w-0 + truncate + whitespace-nowrap',
  footerSrc.includes('min-w-0 truncate whitespace-nowrap'), '')
check('24. data-tip / aria-label 同义且含「本轮（含工具循环）」与估算费用口径',
  footerSrc.includes('data-tip={tip}') && footerSrc.includes('aria-label={tip}') &&
    footerSrc.includes('本轮（含工具循环）') && footerSrc.includes('估算费用'), '')

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)

try { fs.rmSync(pureTmp, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
process.exit(failed.length === 0 ? 0 : 1)
