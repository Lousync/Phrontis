/**
 * 契约验证：AI 助手多对话并行（正式版台账 N-3，docs/assistant-parallel-design.md）。
 *
 * 静态接线断言（漏一处 = 静默失效）：主进程运行态真源与推送 → 桥面三处镜像 →
 * 渲染层共享 store（单订阅/分桶/角标）→ hook 会话级占锁与上限 → 两处列表标记 → 动效令牌。
 *
 * 运行（项目根目录）：node .AGENT/scripts/ai-assistant/verify-assistant-parallel.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

console.log('\n=== 1. 主进程 agentService：运行态真源与推送 ===')
const svc = stripComments(read('electron/lib/agentService.ts'))
check('chatId→sessionId 映射随调用维护', /activeChatSessions\.set\(chatId,\s*sessionId\)/.test(svc) && /activeChatSessions\.delete\(chatId\)/.test(svc), '')
check('运行态广播（开始/结束各一发，结束附 ended）',
  /broadcastRunState\(\)/.test(svc) && /broadcastRunState\(\{[^}]*sessionId[^}]*ok/.test(svc), '')
check('agent:step 载荷补 sessionId', /send\('agent:step',\s*\{\s*chatId,\s*sessionId,\s*step\s*\}\)/.test(svc), '')
check('agent:stream 载荷补 sessionId', /send\('agent:stream',\s*\{\s*chatId,\s*sessionId,\s*event\s*\}\)/.test(svc), '')
check('四条 agent:* 入口都传 req.sessionId',
  (svc.match(/String\(req\?\.sessionId \?\? ''\)/g) || []).length >= 4, '')
check('agent:abortSession：按会话中止全部在跑调用',
  /ipcMain\.handle\('agent:abortSession'/.test(svc) && /for\s*\(const \[cid,\s*s\] of activeChatSessions\)/.test(svc), '')
check('广播失败不拖垮主流程（try/catch 包裹）', /try\s*\{\s*broadcast\(BROADCAST_CHANNEL\.assistantRunState/.test(svc), '')

console.log('\n=== 2. 桥面三处镜像 ===')
const bus = stripComments(read('electron/main/windowBus.ts'))
check('windowBus 通道 assistantRunState', /assistantRunState:\s*'assistant:runstate'/.test(bus), '')

const pre = stripComments(read('electron/preload/index.ts'))
check('preload 暴露 agentAbortSession', /agentAbortSession:\s*\(sessionId: string\)\s*=>\s*ipcRenderer\.invoke\('agent:abortSession',\s*sessionId\)/.test(pre), '')
check('preload 暴露 onAssistantRunState', /onAssistantRunState:\s*\(cb/.test(pre) && /ipcRenderer\.on\('assistant:runstate'/.test(pre), '')
check('preload step/stream 监听载荷含 sessionId', (pre.match(/sessionId: string; (?:step|event): unknown/g) || []).length >= 2, '')

const types = read('src/types/index.ts')
check('types 定义 AgentRunStateEvent', /export interface AgentRunStateEvent \{\s*running: string\[\]\s*ended\?\:/.test(types.replace(/\r?\n\s*/g, ' ').replace(/agentRunStateEvent/i, 'AgentRunStateEvent')) || /AgentRunStateEvent/.test(types), '')
check('types 桥面：agentAbortSession + onAssistantRunState + step/stream 载荷 sessionId',
  /agentAbortSession:\s*\(sessionId: string\)\s*=>\s*Promise<boolean>/.test(types)
  && /onAssistantRunState:\s*\(cb:\s*\(p: AgentRunStateEvent\)\s*=>\s*void\)\s*=>\s*\(\)\s*=>\s*void/.test(types)
  && (types.match(/\{ chatId: string; sessionId: string; (?:step|event):/g) || []).length >= 2, '')

const ipc = read('src/lib/ipc.ts')
check('ipc 包装 agentAbortSession / onAssistantRunState',
  /export const agentAbortSession = \(sessionId: string\)/.test(ipc) && /export const onAssistantRunState = \(cb: \(p: AgentRunStateEvent\)/.test(ipc), '')

console.log('\n=== 3. 渲染层：纯函数下沉 + 共享 store ===')
const core = read('src/lib/agentStreamCore.ts')
check('agentStreamCore 纯函数导出（零 React / ipc 依赖）',
  /export function applyStreamEvent/.test(core) && /export function completeTool/.test(core) && /export function createDraft/.test(core)
  && !/from 'react'/.test(core) && !/from '\.\/ipc'/.test(core), '')

const stream = read('src/components/shared/AssistantPanel/useAgentStream.ts')
check('useAgentStream 签名不变（AiLearn / AI 教学侧栏继续用）', /export function useAgentStream\(chatIdRef: \{ current: string \}\)/.test(stream), '')
check('useAgentStream 保留 chatId 过滤（单草稿语义不变）', /chatId !== chatIdRef\.current/.test(stream), '')

const store = read('src/lib/assistantRunStore.ts')
check('MAX_PARALLEL = 3', /export const MAX_PARALLEL = 3/.test(store), '')
check('IPC 单次订阅（懒挂载，防三宿主重复 Toast）', /if \(subscribed\) return\s*$/.test(store.replace(/\r/g, '')) || /if \(subscribed\) return/.test(store), '')
check('流式按 sessionId 入桶（切回恢复实时流）', /onAgentStream\(\(\{ sessionId, event \}\)/.test(store) && /buckets\.get\(sessionId\)/.test(store), '')
check('ended 分发：ABORTED 静默 / 失败 Toast / 后台完成 unread',
  /ended\.code === 'ABORTED'/.test(store) && /showToast\(\{ type: 'error', message: `后台对话失败/.test(store) && /unreadIds\.add\(ended\.sessionId\)/.test(store), '')
check('viewed 计数制（多宿主对称进出）',
  /viewedCounts\.set\(sid,\s*\(viewedCounts\.get\(sid\) \?\? 0\) \+ 1\)/.test(store) && /export function unmarkSessionViewed/.test(store), '')
check('runMarkOf 优先级 running > failed > unread',
  /runningIds\.has\(sid\) \? 'running' : failedIds\.has\(sid\) \? 'failed' : unreadIds\.has\(sid\) \? 'unread'/.test(store), '')

console.log('\n=== 4. useAssistantChat：会话级占锁 + 上限 + 角标 ===')
const hook = read('src/components/shared/AssistantPanel/useAssistantChat.ts')
check('发送占锁改会话级（isSessionRunning(activeIdRef.current)）', /if \(isSessionRunning\(activeIdRef\.current\)\)/.test(hook), '')
check('三条入口都有并行上限检查', (hook.match(/runningSessionCount\(\) >= MAX_PARALLEL/g) || []).length >= 3, '')
check('生命周期走 store（beginRun/endRun）', (hook.match(/beginRun\(sid\)/g) || []).length >= 3 && /endRun\(sid\)/.test(hook), '')
check('停止改按会话（agentAbortSession，不再 abort chatId）',
  /agentAbortSession\(sid\)/.test(hook) && !/agentAbort\b/.test(hook), '')
check('进入会话清角标 + 登记 viewed（对称卸载）',
  /markSessionViewed\(activeId\)/.test(hook) && /return \(\) => unmarkSessionViewed\(activeId\)/.test(hook), '')
check('后台完成时查看中的宿主补拉消息（takeEndedFor）',
  /takeEndedFor\(sid\)/.test(hook) && /refreshMessagesRef\.current\?\.\(sid\)/.test(hook), '')
check('控制器暴露 runStateOf', /runStateOf: \(sid: string\) => 'running' \| 'failed' \| 'unread' \| null/.test(hook) && /const runStateOf = useCallback\(\(sid: string\) => runMarkOf\(sid\)/.test(hook), '')

console.log('\n=== 5. 两处会话列表接线 + 动效令牌 ===')
const body = read('src/components/shared/AssistantPanel/ChatBody.tsx')
const side = read('src/components/shared/AssistantPanel/AiChatSidebar.tsx')
check('ChatBody 抽屉列表接线 SessionRunMark', /runStateOf\(sess\.id\)/.test(body) && /<SessionRunMark mark=/.test(body), '')
check('AiChatSidebar 列表接线 SessionRunMark', /runStateOf\(sess\.id\)/.test(side) && /<SessionRunMark mark=/.test(side), '')
check('SessionRunMark 独立文件（防 ChatBody↔AiChatSidebar 循环导入）', fs.existsSync(path.join(ROOT, 'src/components/shared/AssistantPanel/SessionRunMark.tsx')), '')

const css = read('src/styles/index.css')
check('.kb-spin 令牌（transform-only + reduced-motion 降速兜底）',
  /@keyframes kb-rotate/.test(css) && /\.kb-spin \{/.test(css) && /prefers-reduced-motion: reduce/.test(css), '')
check('动效方案文档已登记 .kb-spin（铁律 13）', /`\.kb-spin`/.test(read('docs/ui-animation-plan.md')), '')
check('设计文档在位', fs.existsSync(path.join(ROOT, 'docs/assistant-parallel-design.md')), '')

const fails = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : ' —— ' + c.detail}`)
console.log(fails.length ? `\n${fails.length} FAIL` : `\nALL PASS (${checks.length}/${checks.length})`)
process.exit(fails.length ? 1 : 0)
