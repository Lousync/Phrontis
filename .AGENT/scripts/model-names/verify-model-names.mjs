#!/usr/bin/env node
/**
 * 契约验证：模型 ID → 友好名称（src/lib/modelNames.ts 的 prettyModelName）。
 *
 * 为什么值得钉：这段字符串**直接出现在模型选择器、默认模型下拉、场景分配表**里 ——
 * 一个大小写问题就让整个列表看起来像没做完。2026-10-13 修掉的那条正是这样：
 * 原先对品牌词之后的每一段都 toUpperCase，于是
 *   deepseek-chat   → "DeepSeek CHAT"（应为 DeepSeek Chat）
 *   kimi-k2-turbo   → "Kimi K2 TURBO"（应为 Kimi K2 Turbo）
 * 口径以原型（tmp/ai-settings-proto，按修好的样子渲染）为准：
 * **只有纯版本号段全大写**（5.2 / v4 / k2 / m2.5），普通单词只首字母大写。
 *
 * 跑法（任意目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/model-names/verify-model-names.mjs
 */
import { prettyModelName } from '../../../src/lib/modelNames.ts'

let failures = 0
const pass = (m) => console.log(`  [OK]   ${m}`)
const fail = (m) => { failures++; console.error(`  [FAIL] ${m}`) }
const eq = (id, want) => {
  const got = prettyModelName(id)
  if (got === want) pass(`${id} → ${got}`)
  else fail(`${id} → 得到「${got}」，应为「${want}」`)
}

console.log('\n§1 品牌前缀：普通单词只首字母大写（本次修的那条）')
eq('deepseek-chat', 'DeepSeek Chat')
eq('deepseek-reasoner', 'DeepSeek Reasoner')
eq('deepseek-v4-flash', 'DeepSeek V4 Flash')
eq('kimi-k2-turbo', 'Kimi K2 Turbo')
eq('grok-4.6', 'Grok 4.6')

console.log('\n§2 纯版本号段仍全大写')
eq('deepseek-v4-pro', 'DeepSeek V4 Pro')
eq('minimax-m3', 'MiniMax M3')
eq('minimax-m2.7', 'MiniMax M2.7')
eq('mimo-v2.6-flash', 'MiMo V2.6 Flash')
eq('longcat-2.5-preview-free', 'LongCat 2.5 Preview Free')

console.log('\n§3 无品牌前缀的走机械美化（品牌大小写表照旧生效）')
eq('glm-5.3-flash', 'GLM 5.3 Flash')
eq('glm-5.2', 'GLM 5.2')
eq('qwen3.8-max', 'Qwen3.8 Max')

console.log('\n§4 手工覆盖表优先（PRETTY_OVERRIDES）')
eq('gpt-5.6-luna', 'GPT-5.6 Luna')

console.log('\n§5 负向：不得再出现"品牌词之后全大写"的老样子')
for (const [id, bad] of [['deepseek-chat', 'DeepSeek CHAT'], ['deepseek-reasoner', 'DeepSeek REASONER'],
  ['kimi-k2-turbo', 'Kimi K2 TURBO'], ['deepseek-v4-flash', 'DeepSeek V4 FLASH']]) {
  const got = prettyModelName(id)
  if (got === bad) fail(`负向失败：${id} 仍是旧口径「${got}」`)
  else pass(`负向通过：${id} 不再是「${bad}」`)
}

console.log('\n§6 健壮性')
eq('', '')
check2(prettyModelName('singleword') === 'Singleword', '单词 id 不炸')
check2(prettyModelName('a') === 'A', '单字符 id 不炸')
function check2(cond, msg) { if (cond) pass(msg); else fail(msg) }

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} —— 模型名契约 ${failures} 处失败`)
process.exit(failures === 0 ? 0 : 1)
