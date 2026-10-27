/**
 * 长会话渲染窗口（2026-10-27）契约。
 *
 * 失败模式：窗口切在助手回复中间（半轮）、上滚加载丢滚动锚点、切会话继承上一个会话的
 * 滚动姿态、大纲跳到未挂载消息时静默失败、UI 仍走 500 条截断。
 *
 * 用法：node --experimental-strip-types .AGENT/scripts/ai-assistant/verify-message-window.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  initialWindowStart, earlierWindowStart, revealWindowStart,
  INITIAL_WINDOW_TURNS, LOAD_EARLIER_TURNS, REVEAL_CONTEXT_TURNS,
} from '../../../src/components/shared/AssistantPanel/messageWindow.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')
let pass = 0
const fails = []
function ok(cond, label) {
  if (cond) { pass++; return true }
  fails.push(label)
  return false
}

/** 交替消息：偶数下标 = 用户，奇数 = 助手（会话以用户消息开头） */
const msgs = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant' }))

console.log('=== A. 窗口切分纯函数 ===')
ok(INITIAL_WINDOW_TURNS === 10, 'A1 首屏 10 轮')
ok(LOAD_EARLIER_TURNS === 10, 'A2 每次上滚 10 轮')
ok(REVEAL_CONTEXT_TURNS === 1, 'A3 跳转上下文 1 轮')

const m30 = msgs(30) // 15 轮
ok(initialWindowStart(m30) === 10, 'A4 30 条 / 15 轮 → 从末尾第 10 个用户消息（下标 10）开始')
ok(m30[initialWindowStart(m30)].role === 'user', 'A5 首屏起点永远是用户消息（不切半轮）')
ok(initialWindowStart(msgs(20)) === 0, 'A6 恰好 10 轮 → 从头开始')
ok(initialWindowStart(msgs(18)) === 0, 'A7 不足 10 轮 → 从头开始')
ok(initialWindowStart([]) === 0, 'A8 空会话 → 0')
ok(initialWindowStart(m30, 0) === 30, 'A9 窗口 0 轮 = 不挂载（调用方自己保证不用这个档）')

ok(earlierWindowStart(m30, 10, 3) === 4, 'A10 从 10 再往前 3 轮 → 下标 4')
ok(earlierWindowStart(m30, 10, 10) === 0, 'A11 往前不足 10 轮 → 夹到 0')
ok(earlierWindowStart(m30, 0) === 0, 'A12 已到顶 → 0（重复调用 no-op）')
ok(m30[earlierWindowStart(m30, 10, 3)].role === 'user', 'A13 上滚起点仍是用户消息')

ok(revealWindowStart(m30, 'm20', 1) === 18, 'A14 跳到用户消息 m20 → 含上一轮上下文（18）')
ok(revealWindowStart(m30, 'm21', 1) === 18, 'A15 跳到助手回复 m21 → 回到其用户消息所在轮再退一轮（18）')
ok(revealWindowStart(m30, 'm1', 1) === 0, 'A16 跳到最早的回复 → 夹到 0')
ok(revealWindowStart(m30, 'm0', 0) === 0, 'A17 上下文 0 轮 → 目标轮开头')
ok(revealWindowStart(m30, '不存在') === null, 'A18 目标不存在 → null（保持原窗口）')
ok(m30[revealWindowStart(m30, 'm14', 1)].role === 'user', 'A19 跳转起点永远是用户消息')

// 同一轮多条助手消息（工具重试 / 多段回复）：仍从该轮的用户消息开始
const multi = [{ id: 'u0', role: 'user' }, { id: 'a1', role: 'assistant' }, { id: 'a2', role: 'assistant' }, { id: 'u3', role: 'user' }, { id: 'a4', role: 'assistant' }]
ok(revealWindowStart(multi, 'a2', 0) === 0, 'A20 同轮多条助手消息 → 回到该轮用户消息')

console.log('\n=== B. 控制器接线 ===')
const hook = read('src/components/shared/AssistantPanel/useAssistantChat.ts')
ok(/from '\.\/messageWindow'/.test(hook) && /initialWindowStart/.test(hook), 'B1 控制器引用窗口纯函数')
ok(/const \[windowStart, setWindowStart\]/.test(hook) && /const \[reveal, setReveal\]/.test(hook), 'B2 控制器持有窗口 + 跳转状态')
ok(/activeIdRef\.current = id[\s\S]{0,300}?const rows: AgentStoredMessage\[\] = await agentMessages\(id\)/.test(hook),
  'B3 切会话先同步写 activeIdRef（快速连点不被后到的 fetch 覆盖）')
ok(/if \(activeIdRef\.current !== id\) return[\s\S]{0,200}?setMessages\(ui\)[\s\S]{0,200}?setWindowStart\(initialWindowStart\(ui\)\)/.test(hook),
  'B4 载入后按末尾 10 轮设窗口')
ok(/const loadEarlier = useCallback[\s\S]{0,200}?earlierWindowStart\(messages, s\)/.test(hook), 'B5 上滚加载纯内存展开')
ok(/const revealMessage = useCallback[\s\S]{0,300}?revealWindowStart\(messages, id\)[\s\S]{0,300}?setReveal\(\{ id, nonce: revealNonceRef\.current \}\)/.test(hook),
  'B6 大纲跳转先展开窗口再发 reveal 请求')
ok(/setWindowStart\(0\)[\s\S]{0,120}?setReveal\(null\)/.test(hook), 'B7 新建 / 清空会话时重置窗口')
ok(/windowStart,\s*loadEarlier,\s*reveal,\s*revealMessage,/.test(hook), 'B8 控制器导出窗口接口')

const api = read('src/modules/ai-assistant/useAiAssistant.ts')
ok(/windowStart: chat\.windowStart/.test(api) && /loadEarlier: chat\.loadEarlier/.test(api) &&
  /reveal: chat\.reveal/.test(api) && /revealMessage: chat\.revealMessage/.test(api),
  'B9 AI 助手模块壳透传窗口接口')

console.log('\n=== C. MessageList 渲染窗口 ===')
const list = read('src/components/shared/AssistantPanel/MessageList.tsx')
ok(/windowStart\?: number/.test(list) && /onLoadEarlier\?: \(\) => void/.test(list) &&
  /sessionKey\?: string \| null/.test(list) && /reveal\?: \{ id: string; nonce: number \} \| null/.test(list),
  'C1 新增窗口 / 加载 / 会话键 / 定位 props')
ok(/const winStart = Math\.max\(0, Math\.min\(windowStart, messages\.length\)\)/.test(list), 'C2 窗口起点夹在有效范围')
ok(/messages\.map\(\(m, i\) => i < winStart \? null : \(/.test(list), 'C3 窗口外的消息不挂载（保留原下标给复制/重发）')
ok(/topSentinelRef/.test(list) && /IntersectionObserver/.test(list) && /rootMargin: '200px 0px 0px 0px'/.test(list),
  'C4 顶部哨兵 + 近顶自动加载')
ok(/el\.scrollTop = anchor\.top \+ \(el\.scrollHeight - anchor\.height\)/.test(list), 'C5 上滚加载后补偿 scrollTop（画面不跳）')
ok(/prevSessionRef/.test(list) && /if \(prevSessionRef\.current === sessionKey\) return/.test(list) &&
  /stickRef\.current = true/.test(list), 'C6 切会话重置贴底姿态')
ok(/scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/.test(list) && /reveal\?\.nonce/.test(list),
  'C7 大纲定位按 nonce 触发滚动')

const chat = read('src/components/shared/AssistantPanel/ChatBody.tsx')
ok(/windowStart, loadEarlier, reveal/.test(chat) && /sessionKey=\{activeId\}/.test(chat) &&
  /windowStart=\{windowStart\}/.test(chat) && /onLoadEarlier=\{loadEarlier\}/.test(chat) && /reveal=\{reveal\}/.test(chat),
  'C8 ChatBody（右栏 / AI 对话页）接入窗口')

const mod = read('src/modules/ai-assistant/index.tsx')
ok(/sessionKey=\{api\.activeId\}/.test(mod) && /windowStart=\{api\.windowStart\}/.test(mod) &&
  /onLoadEarlier=\{api\.loadEarlier\}/.test(mod) && /reveal=\{api\.reveal\}/.test(mod),
  'C9 AI 助手模块接入窗口')
ok(/api\.revealMessage\(id\)/.test(mod) && !/document\.querySelector\('\[data-assistant-variant="aiAssistant"\]'\)/.test(mod),
  'C10 大纲跳转走控制器，不再全局查 DOM')

const side = read('src/components/shared/AssistantPanel/AiChatSidebar.tsx')
ok(/chat\.revealMessage\(id\)/.test(side) && !/document\.querySelector\(`\[data-assistant-variant="page"\]/.test(side),
  'C11 AI 对话页大纲同样走控制器')

console.log('\n=== D. UI 读全量（修 500 条截断） ===')
const store = read('electron/lib/agentMessageStore.ts')
const repo = read('electron/lib/agentSessionRepo.ts')
const svc = read('electron/lib/agentService.ts')
ok(/export function getAllMessages/.test(store), 'D1 新增全量读取（排序同 v1）')
ok(/export function getAgentMessagesAll/.test(repo), 'D2 repo 暴露 UI 全量读路径')
ok(/getAgentMessagesAll\(String\(id \?\? ''\)\)\.map\(camelRow\)/.test(svc), 'D3 agent:messages 走全量')
const handler = (svc.match(/ipcMain\.handle\('agent:messages'[\s\S]{0,300}?\)\n/) || [''])[0]
ok(!/getAgentMessages\(/.test(handler), 'D4 UI 通道不得再走 500 条截断')
ok(/export function getAgentMessages\([\s\S]{0,800}?getMessagesPage/.test(repo), 'D5 agent 上下文路径保留原分页口径')

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`[OK] 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`[FAIL] ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
