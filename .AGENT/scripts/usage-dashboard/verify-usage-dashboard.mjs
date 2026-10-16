/**
 * 契约脚本：用量模块（v3.9.0）
 *
 * 覆盖的缺陷面：
 *   ③ 防双记（统一记账）—— 网关直调（翻译/嵌入/教学/内联）必须计入 ai-usage.json，
 *      而 agentService 自行记账的那条路必须**不重复**。这是纯源码级断言：
 *      llmService 两个成功分支各调一次 accountInvokeUsage（其内部按 accounting 守卫）；
 *      agentService 两处 invokeLlmStreamInternal 都带 accounting:'caller'，
 *      且 agentService 自己的 recordAiUsage 调用点恰为 2（带 sessionTitle 的唯一来源）。
 *   ④ 令牌 —— 额度阈值配色依赖 --warning，两个主题块都必须定义。
 *
 * 用法：node --no-warnings .AGENT/scripts/usage-dashboard/verify-usage-dashboard.mjs
 * （被测的 providerQuotaPure.ts 零依赖 —— 不 import 任何依赖 electron 的模块）
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { quotaAdapterFor, deepseekAdapter, opencodeAdapter } from '../../../electron/lib/providerQuotaPure.ts'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}
function eq(got, want, label) {
  const good = got === want
  if (good) { pass++; return true }
  fails.push(`${label}  → 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)
  return false
}

/** 只剥注释、保留字符串字面量（与 workbench-shell 契约同一份状态机实现） */
function stripComments(src) {
  let out = ''
  let st = 'code'
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1]
    if (st === 'code') {
      if (c === '/' && n === '/') { st = 'line'; i++; out += '  '; continue }
      if (c === '/' && n === '*') { st = 'block'; i++; out += '  '; continue }
      if (c === "'") st = 'sq'; else if (c === '"') st = 'dq'; else if (c === '`') st = 'tpl'
      out += c; continue
    }
    if (st === 'line') { if (c === '\n') { st = 'code'; out += c } else out += ' '; continue }
    if (st === 'block') { if (c === '*' && n === '/') { st = 'code'; i++; out += '  ' } else out += c === '\n' ? '\n' : ' '; continue }
    if (st === 'sq' || st === 'dq' || st === 'tpl') {
      if (c === '\\') { out += c + (n ?? ''); i++; continue }
      if ((st === 'sq' && c === "'") || (st === 'dq' && c === '"') || (st === 'tpl' && c === '`')) st = 'code'
      out += c; continue
    }
  }
  return out
}

const count = (src, needle) => src.split(needle).length - 1

/* ================= C. 统一记账 · 防双记（源码级） ================= */
console.log('\n=== C. 统一记账 · 防双记（方案 §3） ===')
const llm = stripComments(read('electron/lib/llmService.ts'))
const agent = stripComments(read('electron/lib/agentService.ts'))
const usage = stripComments(read('electron/lib/agentUsage.ts'))

// C1 usageKeyOf 定义存在且为 `providerId:modelId`（无 providerId 退回裸 modelId）
ok(/export function usageKeyOf\s*\(/.test(usage), 'C1 usageKeyOf 已导出（agentUsage）')
ok(/return p && m \? `\$\{p\}:\$\{m\}` : m/.test(usage) || /return p && m \?/.test(usage),
  'C1b usageKeyOf 语义：`providerId:modelId`，无 providerId 退回裸 modelId')

// C2 llmService 从 agentUsage 引入记账入口
ok(/import\s*\{[^}]*recordAiUsage[^}]*usageKeyOf[^}]*\}\s*from\s*'\.\/agentUsage'/.test(llm)
  || (/from\s*'\.\/agentUsage'/.test(llm) && /recordAiUsage/.test(llm) && /usageKeyOf/.test(llm)),
  'C2 llmService 引入 recordAiUsage + usageKeyOf')

// C3 accountInvokeUsage 定义 1 次 + 调用 2 次（两个成功分支）
ok(count(llm, 'function accountInvokeUsage') === 1, 'C3a accountInvokeUsage 定义恰 1 处')
ok(count(llm, 'accountInvokeUsage(') === 3, 'C3b accountInvokeUsage 调用恰 2 处（定义 1 + 调用 2）',
  `实际出现 ${count(llm, 'accountInvokeUsage(')} 次`)

// C4 守卫：accounting==='caller' 时不记
ok(/if\s*\(\s*req\.accounting\s*===\s*'caller'\s*\)\s*return/.test(llm),
  'C4 accountInvokeUsage 按 accounting==="caller" 提前返回（防双记）')

// C5 LlmInvokeRequest.accounting 字段
ok(/accounting\?:\s*'auto'\s*\|\s*'caller'/.test(llm), 'C5 LlmInvokeRequest.accounting 字段（auto|caller）')

// C6 agentService 两处 invokeLlmStreamInternal 都带 accounting:'caller'
const streamCalls = agent.match(/invokeLlmStreamInternal\(\s*\{[^}]*\}/g) ?? []
ok(streamCalls.length === 2, 'C6a agentService invokeLlmStreamInternal 恰 2 处', `实际 ${streamCalls.length}`)
ok(streamCalls.length === 2 && streamCalls.every((s) => /accounting:\s*'caller'/.test(s)),
  'C6b 两处都带 accounting:"caller"')

// C7 agentService 自己的 recordAiUsage 调用点恰 2（唯一 sessionTitle 来源）
ok(count(agent, 'recordAiUsage(') === 2, 'C7 agentService recordAiUsage 调用点恰 2', `实际 ${count(agent, 'recordAiUsage(')}`)

// C8 agentService usageModel 经 usageKeyOf 归一
ok(/usageKeyOf\(/.test(agent) && /usageKeyOf\(raw\.slice/.test(agent), 'C8 usageModel 经 usageKeyOf 归一')

/* ================= D. 令牌（额度阈值配色） ================= */
console.log('\n=== D. 令牌 ===')
const css = read('src/styles/index.css')
ok(count(css, '--warning:') === 2, 'D1 --warning 在两个主题块都有定义', `实际 ${count(css, '--warning:')} 处`)

/* ================= E. 额度适配器（零依赖纯函数，真跑） ================= */
console.log('\n=== E. 额度适配器（方案 §五 / §七.5） ===')

// E1/E2 地址推导（origin + 固定路径；不看用户粘贴的版本路径）
eq(deepseekAdapter.url('https://api.deepseek.com/v1'), 'https://api.deepseek.com/user/balance', 'E1 deepseek 由 /v1 推出 /user/balance')
eq(opencodeAdapter.url('https://opencode.ai/zen/go/v1'), 'https://opencode.ai/zen/go/v1/usage', 'E2a opencode 由 /zen/go/v1 推出 /zen/go/v1/usage')
eq(opencodeAdapter.url('https://opencode.ai/inference/go/v1'), 'https://opencode.ai/zen/go/v1/usage', 'E2b opencode 由 /inference/go/v1 也推出 /zen/go/v1/usage')

// E3 匹配（含未知 base → unsupported）
eq(quotaAdapterFor('https://api.deepseek.com/v1')?.key, 'deepseek', 'E3a 匹配 deepseek')
eq(quotaAdapterFor('https://opencode.ai/zen/go/v1')?.key, 'opencode', 'E3b 匹配 opencode')
eq(quotaAdapterFor('https://my-relay.example.com/v1'), null, 'E3c 中转站 / 未知 base → null（unsupported）')

// E4 喂 OpenCode Go **实测真返回** → 三条窗口，取值原样
const realGo = { usage: {
  rolling: { status: 'ok', percent: 0, resetsAt: '2026-10-16T06:14:39.000Z' },
  weekly: { status: 'ok', percent: 58, resetsAt: '2026-10-19T00:00:00.000Z' },
  monthly: { status: 'ok', percent: 70, resetsAt: '2026-10-23T02:47:18.000Z' },
} }
const goParsed = opencodeAdapter.parse(realGo)
ok(goParsed.ok === true && goParsed.kind === 'windows', 'E4a 实测真返回 → windows')
eq(goParsed.ok ? goParsed.windows.length : -1, 3, 'E4b 解析出三条窗口')
eq(goParsed.ok ? goParsed.windows.map((w) => w.percent).join(',') : '', '0,58,70', 'E4c percent 原样（含 0 边界）')
eq(goParsed.ok ? goParsed.windows.map((w) => w.label).join('|') : '', '5 小时（滚动）|本周|本月', 'E4d 窗口命名固定（不给计划名）')
eq(goParsed.ok ? goParsed.windows[0].status : '', 'ok', 'E4e status ok')

// E5 rate-limited 与 percent ≥100 边界
const goHot = { usage: { rolling: { status: 'rate-limited', percent: 100 }, weekly: { status: 'ok', percent: 103 } } }
const hotParsed = opencodeAdapter.parse(goHot)
eq(hotParsed.ok ? hotParsed.windows[0].status : '', 'rate-limited', 'E5a rate-limited 原样透出')
eq(hotParsed.ok ? hotParsed.windows[1].percent : -1, 103, 'E5b percent 不夹断上界（≥100 由界面处理）')

// E6 无 Go 套餐（usage 缺失）→ not-subscribed
eq(opencodeAdapter.parse({}).reason, 'not-subscribed', 'E6a usage 缺失 → not-subscribed')
eq(opencodeAdapter.parse({ usage: null }).reason, 'not-subscribed', 'E6b usage 为 null → not-subscribed')
eq(opencodeAdapter.parse({ usage: {} }).reason, 'not-subscribed', 'E6c 三窗口全缺 → not-subscribed')

// E7 半截 / 缺字段 → shape
eq(opencodeAdapter.parse(null).reason, 'shape', 'E7a 非 JSON（null）→ shape')
eq(opencodeAdapter.parse({ usage: { rolling: { status: 'ok' } } }).reason, 'shape', 'E7b 窗口缺 percent → shape')

// E8 DeepSeek 余额（金额字符串精确保留；多币种逐条）
const dsParsed = deepseekAdapter.parse({
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' },
    { currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
  ],
})
ok(dsParsed.ok === true && dsParsed.kind === 'money', 'E8a DeepSeek → money')
eq(dsParsed.ok ? dsParsed.balances.length : -1, 2, 'E8b 多币种逐条')
eq(dsParsed.ok ? dsParsed.balances[0].total : '', '12.34', 'E8c 金额原样字符串（不经浮点）')
eq(dsParsed.ok ? dsParsed.available : false, true, 'E8d is_available 透出')

// E9 DeepSeek 缺字段 → shape
eq(deepseekAdapter.parse({ is_available: true }).reason, 'shape', 'E9 DeepSeek 缺 balance_infos → shape')

/* ================= F. 对话内「本轮消耗」费用（A1：主进程算好写进 trace） ================= */
console.log('\n=== F. 轮末消耗 · 费用来源（方案 §6.2 / A1） ===')
const ml = stripComments(read('src/components/shared/AssistantPanel/MessageList.tsx'))
const types = stripComments(read('src/types/index.ts'))

// F1 agentService 引入 modelPricing 并有拆桶 helper（i0 = prompt − cached，与 recordAiUsage 同口径）
ok(/import\s*\{[^}]*estimateCost[^}]*\}\s*from\s*'\.\/modelPricing'/.test(agent),
  'F1a agentService 引入 estimateCost')
ok(/function roundCostUsd\s*\(/.test(agent) && /estimateCost\(\s*\{\s*i0:/.test(agent),
  'F1b roundCostUsd 拆四桶后走 estimateCost（i0 = prompt − cached）')

// F2 两个 llm step（主循环 + 预算耗尽总结轮）都写 costUsd
ok(count(agent, 'costUsd:') === 2, 'F2 agentService 两处 llm step 都写 costUsd', `实际 ${count(agent, 'costUsd:')}`)

// F3 渲染层类型与主进程类型同步（跨线共享汇点）
ok(/costUsd\?:\s*number\s*\|\s*null/.test(types), 'F3 src/types AgentTraceStep.costUsd 与主进程同步')

// F4 MessageList 累加 costUsd 并渲染「估算」
ok(/s\.costUsd/.test(ml) && /估算/.test(ml), 'F4 TokensOf 读 costUsd 且渲染「估算」小字')

console.log(`\n断言: ${pass} PASS, ${fails.length} FAIL`)
if (fails.length) { console.log('\n失败项：'); for (const f of fails) console.log('  ✗ ' + f) }
process.exit(fails.length > 0 ? 1 : 0)
