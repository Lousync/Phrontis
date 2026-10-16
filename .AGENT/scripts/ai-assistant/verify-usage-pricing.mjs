/**
 * AI助手（v3.9.0）用量数据层 + 价目契约。
 *
 * 为什么需要它：M5 的失败模式静默 ——
 *  · 抬保留期忘了改（仪表盘 365 天永远只有 30 天）；sessions 形状被顺手改坏（右栏读数 NaN）；
 *  · 价目表单位搞错（$/1M 当成 $/1k → 费用差 1000 倍）；无价目模型返回 0 而非 null（UI 假装免费）。
 *
 * §1 import 真实纯模块 modelPricing.ts 验价目与估算；
 * §2 源码接线：agentUsage 追加 models + KEEP_DAYS=400 + sessions 形状未动 + agentService 传 model。
 *
 * 用法：node --experimental-strip-types .AGENT/scripts/ai-assistant/verify-usage-pricing.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { priceOf, estimateCost } from '../../../electron/lib/modelPricing.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}

console.log('=== A. priceOf：命中 / 大小写 / 未知 ===')
ok(priceOf('openai:gpt-4o-mini') !== null, 'A1 providerId:model 命中')
ok(priceOf('deepseek-chat')?.input === 0.27, 'A2 deepseek-chat 输入价 0.27')
ok(priceOf('OpenAI:GPT-4O')?.output === 10, 'A3 大小写不敏感')
ok(priceOf('zzz-unknown-model') === null, 'A4 未知模型返回 null')
ok(priceOf('') === null, 'A5 空键返回 null')

console.log('\n=== B. estimateCost：$/1M 口径 ===')
{
  const b = { i0: 1_000_000, ir: 0, iw: 0, out: 1_000_000, calls: 1 }
  // gpt-4o：输入 2.5/M + 输出 10/M = 12.5
  const c = estimateCost(b, 'openai:gpt-4o')
  ok(c !== null && Math.abs(c - 12.5) < 1e-9, 'B1 gpt-4o 1M+1M = $12.5', String(c))
}
{
  const b = { i0: 0, ir: 1_000_000, iw: 0, out: 0, calls: 1 }
  const c = estimateCost(b, 'claude-3-5-sonnet')
  ok(c !== null && Math.abs(c - 0.3) < 1e-9, 'B2 缓存读按 cacheRead 价 0.3', String(c))
}
{
  const b = { i0: 0, ir: 0, iw: 1_000_000, out: 0, calls: 1 }
  const c = estimateCost(b, 'claude-3-5-sonnet')
  ok(c !== null && Math.abs(c - 3.75) < 1e-9, 'B3 缓存写按 cacheWrite 价 3.75', String(c))
}
ok(estimateCost({ i0: 1e6, ir: 0, iw: 0, out: 0, calls: 1 }, 'zzz') === null, 'B4 无价目 → null（不假装 0）')
ok(estimateCost({ i0: 0, ir: 0, iw: 0, out: 0, calls: 0 }, 'unknown-x') === null, 'B5 空桶且无价目 → null')

console.log('\n=== C. agentUsage 数据层接线 ===')
const au = read('electron/lib/agentUsage.ts')
ok(/KEEP_DAYS\s*=\s*400/.test(au), 'C1 保留期抬到 400 天')
ok(/models\?:\s*Record<string,\s*AiUsageModelBucket>/.test(au), 'C2 AiUsageDay 追加 models 字段（可选）')
ok(/sessions:\s*Record<string,\s*\{\s*title:\s*string;\s*in:\s*number;\s*out:\s*number\s*\}>/.test(au), 'C3 sessions 形状未动（向后兼容）')
ok(/mb\.i0\s*\+=/.test(au) && /mb\.ir\s*\+=/.test(au) && /mb\.out\s*\+=/.test(au), 'C4 记账写入 i0/ir/iw/out 桶')
ok(/export function getAiUsageModels/.test(au), 'C5 导出按模型聚合函数')

console.log('\n=== D. agentService 记账传模型键 ===')
const svc = read('electron/lib/agentService.ts')
ok(/String\(llmOpts\?\.modelId \|\| getSettingReader\(\)\('defaultChatModel'\) \|\| ''\)/.test(svc)
  && /const usageModel = \(\(\) =>/.test(svc) && /usageKeyOf\(/.test(svc),
  'D1 usageModel 解析（覆盖优先 / 全局默认兜底 → usageKeyOf 归一为 providerId:modelId）')
const n = (svc.match(/model:\s*usageModel/g) || []).length
ok(n >= 2, 'D2 两处记账均传 model', `实得 ${n}`)
ok(/ipcMain\.handle\('agent:usage:models'/.test(svc), 'D3 注册 agent:usage:models')

console.log('\n=== E. 用量 IPC 三处同步 ===')
ok(/agentUsageModels:/.test(read('electron/preload/index.ts')), 'E1 preload 暴露')
ok(/agentUsageModels:/.test(read('src/types/index.ts')), 'E2 types 声明')
ok(/export const agentUsageModels/.test(read('src/lib/ipc.ts')), 'E3 ipc.ts 封装')

console.log(`\n${fails.length ? 'FAIL' : 'PASS'}  ${pass} passed, ${fails.length} failed`)
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1) }
