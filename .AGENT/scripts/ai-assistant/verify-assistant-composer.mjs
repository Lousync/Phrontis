/**
 * AI 助手输入卡契约（v3.16.1 F-2）。
 *
 * 这一批的失败模式全是「静默漏接」：
 *  · 新宿主的输入卡不接 `/` 弹层 → 敲 `/` 毫无反应，IPC 仍是成功的；
 *  · 兼容壳不透出 `compressing` → 压缩数十秒零反馈，看起来像卡死；
 *  · 发送闸门只做在按钮上 → Enter 仍能并发发送（比警告更糟）；
 *  · Enter 不判 IME 组合态 → 中文选词回车误发。
 *
 * 所以本脚本锁：共享 hook、三宿主接线、压缩占位与闸门、IME 守卫。
 *
 * 用法：node .AGENT/scripts/ai-assistant/verify-assistant-composer.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')
let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}

const hook = read('src/components/shared/AssistantPanel/useSlashMenu.ts')
const mod = read('src/modules/ai-assistant/index.tsx')
const shell = read('src/modules/ai-assistant/useAiAssistant.ts')
const chat = read('src/components/shared/AssistantPanel/useAssistantChat.ts')
const body = read('src/components/shared/AssistantPanel/ChatBody.tsx')
const teach = read('src/modules/ai-teaching/index.tsx')

console.log('=== A. 共享斜杠 hook（单一真源，不再各写一份）===')
ok(/export function useSlashMenu/.test(hook), 'A1 导出 useSlashMenu')
ok(/buildSlashItems\(skills \?\? \[\], \[\], surface\)/.test(hook), 'A2 候选来自 buildSlashItems（指令 + 放行指令 + Skill）')
ok(/filterSlashItems\(buildSlashItems/.test(hook), 'A3 检索走 filterSlashItems')
ok(/input\.startsWith\('\/'\) && !\/\[\\s\\n\]\/\.test\(input\.slice\(1\)\)/.test(hook),
  'A4 仅当输入是「/ + 无空白词」时打开（单独 / 也打开）')
ok(/ArrowDown/.test(hook) && /ArrowUp/.test(hook), 'A5 ↑↓ 循环换高亮')
ok(/e\.key === 'Tab'/.test(hook), 'A6 Tab 补全')
ok(/e\.key === 'Enter' && !e\.shiftKey && !e\.nativeEvent\.isComposing/.test(hook), 'A7 弹层 Enter 只选中且避开 IME')
ok(/e\.key === 'Escape'/.test(hook) && /e\.stopPropagation\(\)/.test(hook), 'A8 Esc 只关弹层并阻止冒泡')

console.log('\n=== B. 工作台 AI 助手模块接线 ===')
ok(/import \{ SlashCommandMenu \}/.test(mod), 'B1 模块 import SlashCommandMenu')
ok(/import \{ useSlashMenu \}/.test(mod), 'B2 模块 import useSlashMenu')
ok(/const slash = useSlashMenu\(\{/.test(mod), 'B3 模块实例化共享 hook')
ok(/surface: 'assistant'/.test(mod), 'B4 聊天面 = assistant（候选按面过滤）')
ok(/\{slash\.open && \(/.test(mod) && /<SlashCommandMenu items=\{slash\.items\}/.test(mod), 'B5 弹层按 slash.open 渲染')
ok(/slash\.setActiveIndex\(0\)/.test(mod), 'B6 输入变化重置高亮')
ok(/slash\.onKeyDown\(e\)/.test(mod), 'B7 键序先走 slash 弹层')
ok(/!e\.defaultPrevented && e\.key === 'Enter' && !e\.shiftKey && !e\.nativeEvent\.isComposing/.test(mod),
  'B8 模块发送 Enter 判 defaultPrevented + IME 组合态')
ok(/Skill：\{api\.pickedSkill\.title\}/.test(mod) && /api\.setPickedSkill\(null\)/.test(mod), 'B9 Skill chip 可移除')
ok(/\/ 唤起指令/.test(mod), 'B10 placeholder 提示 / 唤起指令')
ok(/api\.compressing/.test(mod) && /正在压缩对话历史/.test(mod), 'B11 压缩进行中占位行')
ok(/disabled=\{api\.compressing \|\| !api\.input\.trim\(\)\}/.test(mod), 'B12 发送按钮压缩期间禁用')
ok(/if \(api\.compressing\) \{ void api\.send\(text\); return \}/.test(mod),
  'B13 压缩期间发送不清草稿（交给 send 闸门拒绝，避免吞掉用户输入）')

console.log('\n=== C. 兼容壳透出压缩态 ===')
ok(/compressing: boolean/.test(shell), 'C1 AiAssistantApi 声明 compressing')
ok(/compressing: chat\.compressing/.test(shell), 'C2 从 useAssistantChat 透传')
ok(/slashSkills: SkillInfo\[\]/.test(shell) && /slashSkills: chat\.slashSkills/.test(shell), 'C3 透出 slashSkills')
ok(/pickedSkill: SkillInfo \| null/.test(shell) && /setPickedSkill: chat\.setPickedSkill/.test(shell), 'C4 透出 pickedSkill 读写')

console.log('\n=== D. 发送闸门下沉（三宿主 + 按钮 + Enter 共用）===')
ok(/compressingRef/.test(chat), 'D1 压缩态有同步 ref（连按 Enter 不吃旧闭包）')
ok(/if \(compressingRef\.current\) \{[\s\S]{0,160}正在压缩对话历史，请稍候再发送/.test(chat),
  'D2 send 开头拦压缩中发送并 toast')
ok(/onProgress: p => \{ compressingRef\.current = p\.active; setCompressing\(p\.active\) \}/.test(chat),
  'D3 onProgress 同时更新 state 与 ref')
ok(/if \(!body\) return\n[\s\S]{0,400}compressingRef\.current/.test(chat), 'D4 闸门位于「无内容」判断之后、会话锁之前')

console.log('\n=== E. IME 守卫覆盖三处发送 Enter ===')
ok(/e\.key === 'Enter' && !e\.shiftKey && !e\.nativeEvent\.isComposing/.test(body), 'E1 右栏 ChatBody')
ok(/e\.key === 'Enter' && !e\.shiftKey && !e\.nativeEvent\.isComposing/.test(teach), 'E2 AI 教学主输入框')
ok(/e\.key === 'Enter' && !e\.shiftKey && !e\.nativeEvent\.isComposing/.test(mod), 'E3 工作台模块')

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`[OK] 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`[FAIL] ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
