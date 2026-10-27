/**
 * AI 助手 · 会话大纲（2026-10-27）契约。
 *
 * 这次的失败模式都是「界面看起来正常、但其实坏了」：
 *  · 摘要口径复制两份 → 同一条消息在 AI 对话页与 AI 助手显示不同标题；
 *  · 跳转用全局 `[data-msg-id]` → 右栏 / AI 对话页的保活实例同 id，滚到隐藏的那个上；
 *  · 入口没接 `modActionsEl` → 按钮根本不出现；
 *  · 大纲切换用条件渲染 → 作用域树的展开状态被清空。
 *
 * 用法：node --experimental-strip-types .AGENT/scripts/ai-assistant/verify-ai-outline.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { msgSummary, OUTLINE_SUMMARY_MAX } from '../../../src/components/shared/AssistantPanel/outlineSummary.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')
let pass = 0
const fails = []
function ok(cond, label) {
  if (cond) { pass++; return true }
  fails.push(label)
  return false
}

console.log('=== A. 大纲摘要纯函数 ===')
ok(OUTLINE_SUMMARY_MAX === 64, 'A1 摘要上限是 64 字')
ok(msgSummary('# 标题\n正文') === '标题', 'A2 取首行并去掉行首 #')
ok(msgSummary('—— 落款\n正文') === '正文', 'A3 跳过 —— 落款行')
ok(msgSummary('   \n  第二行  ') === '第二行', 'A4 跳过空白行并 trim')
ok(msgSummary('x'.repeat(100)).length === 64, 'A5 超长截断到 64')
ok(msgSummary('  \n ') === '（空）', 'A6 空内容回落（空）')
ok(msgSummary('> 引用摘要') === '引用摘要', 'A7 去掉行首 >')

console.log('\n=== B. 摘要单一真源 ===')
const summary = read('src/components/shared/AssistantPanel/outlineSummary.ts')
const pageSidebar = read('src/components/shared/AssistantPanel/AiChatSidebar.tsx')
const mod = read('src/modules/ai-assistant/index.tsx')
ok(/export function msgSummary/.test(summary) && /OUTLINE_SUMMARY_MAX/.test(summary), 'B1 共享摘要模块导出函数与上限')
ok(/from '\.\/outlineSummary'/.test(pageSidebar) && !/function msgSummary/.test(pageSidebar),
  'B2 AI 对话页复用共享摘要（不再本地复制一份）')
ok(/from '\.\.\/\.\.\/components\/shared\/AssistantPanel\/outlineSummary'/.test(mod),
  'B3 AI 助手模块复用共享摘要')

console.log('\n=== C. 入口接线 ===')
const app = read('src/App.tsx')
ok(/<AiAssistantModule[^>]*modActionsEl=\{on && railModule === 'aiAssistant' \? wbModActionsEl : null\}/.test(app),
  'C1 App 只在 AI 助手模块态传头部动作槽')
ok(/modActionsEl\?: HTMLElement \| null/.test(mod), 'C2 模块 props 接收 modActionsEl')
ok(/modActionsEl && createPortal\([\s\S]{0,600}?ListTree[\s\S]{0,400}?modActionsEl/.test(mod),
  'C3 大纲按钮 portal 进头部动作槽（与 🏠/🔒 同排）')
ok(/SIDEBAR_HEADER_ICON/.test(mod), 'C4 头部按钮使用统一图标口径')
ok(/setSidebarView\(\(v\) => \(v === 'outline' \? 'sessions' : 'outline'\)\)/.test(mod),
  'C5 再点一次切回会话主体')
ok(/sidebarView === 'outline' \? 'flex' : 'hidden'/.test(mod),
  'C6 大纲替换左栏主体（显示 / 隐藏，不是浮层）')
ok(/sidebarView === 'outline' \? 'hidden' : 'flex'/.test(mod),
  'C7 会话主体只隐藏不卸载（作用域树展开状态保留）')
ok(/sidebarView !== 'outline'\) return[\s\S]{0,500}?Escape[\s\S]{0,500}?setSidebarView\('sessions'\)/.test(mod),
  'C8 大纲态 Esc 返回（输入框内不抢键）')

console.log('\n=== D. 跳转定位 ===')
ok(/data-assistant-variant="aiAssistant"/.test(mod), 'D1 模块消息容器保留作用域标记（探针 / 调试）')
ok(/api\.revealMessage\(id\)/.test(mod), 'D2 大纲跳转交给控制器（不再自己查 DOM）')
ok(/reveal=\{api\.reveal\}/.test(mod), 'D3 跳转请求通过 reveal prop 交给 MessageList')
ok(/windowStart=\{api\.windowStart\}/.test(mod) && /onLoadEarlier=\{api\.loadEarlier\}/.test(mod),
  'D4 模块接入渲染窗口（跳转前可先展开窗口）')
ok(/setTimeout\(\(\) => setSidebarView\('sessions'\), 180\)/.test(mod), 'D5 跳转后 180ms 切回会话主体')
ok(!/document\.querySelector\('\[data-assistant-variant="aiAssistant"\]'\)/.test(mod),
  'D6 不得再全局查 data-msg-id（右栏 / AI 对话页保活实例会串台）')
ok(/\.filter\(\(m\) => m\.id\)/.test(mod), 'D7 大纲只列已落库消息（乐观 / 流式草稿没有锚点）')

console.log('\n=== E. 空态 ===')
ok(/当前会话还没有消息/.test(mod) && /先选择或新建一个会话/.test(mod),
  'E1 空态区分「无消息」与「无会话」')

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`[OK] 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`[FAIL] ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
