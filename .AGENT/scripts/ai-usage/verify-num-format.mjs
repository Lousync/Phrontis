/**
 * 契约：用量数字紧凑口径（2026-10-15 用户拍板，参照 DeepSeek「42.8M tokens」）。
 * 规则：千以下原样；千以上一位小数 K；百万以上一位小数 M；`.0` 抹平；
 *       999,999 这类「K 舍入到 1000K」的边界必须进位成 1M。
 * 跑法：node --experimental-strip-types --no-warnings .AGENT/scripts/ai-usage/verify-num-format.mjs
 * （被测的 src/lib/numFormat.ts 零依赖 —— strip-types 只能吃没有无扩展名导入的文件）
 */
import { fmtTokens, exactTokens } from '../../../src/lib/numFormat.ts'

let pass = 0, fail = 0
function eq(got, want, label) {
  const ok = got === want
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'} ${label}  → 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)
}

// 千以下原样
eq(fmtTokens(0), '0', '0 原样')
eq(fmtTokens(625), '625', '625 原样（千以下不加 K）')
eq(fmtTokens(999), '999', '999 仍是原样')
// 千以上 → K（一位小数，.0 抹平）
eq(fmtTokens(1000), '1K', '1,000 → 1K（.0 抹平）')
eq(fmtTokens(1400), '1.4K', '1,400 → 1.4K')
eq(fmtTokens(251433), '251.4K', '251,433 → 251.4K')
// 百万以上 → M
eq(fmtTokens(1000000), '1M', '1,000,000 → 1M')
eq(fmtTokens(42800000), '42.8M', '42,800,000 → 42.8M（DeepSeek 同款）')
// 进位边界：K 舍入到 1000K 必须直接进 M
eq(fmtTokens(999999), '1M', '999,999 → 1M（不得出现 1000K）')
eq(fmtTokens(999499), '999.5K', '999,499 → 999.5K（仍在 K 段）')
// 异常入参兜底
eq(fmtTokens(NaN), '0', 'NaN → 0（不往界面写 NaN）')

// 精确值（千分位）—— 缩写不丢信息，title 用
eq(exactTokens(251433), '251,433', 'exactTokens 千分位')
eq(exactTokens(undefined), '0', 'exactTokens(undefined) → 0')

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
