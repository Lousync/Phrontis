#!/usr/bin/env node
/**
 * B-45：AI 助手输入草稿按会话独立 —— 结构契约静态断言。
 *
 * 为什么静态断言：草稿槽位是纯交互状态，没有可抽的纯函数；而失败面全是静默的——
 * 切会话把上一段字带过去、新建会话偷走旧草稿、删除会话留下幽灵草稿、完整模块又
 * 自己维护一份 draft 导致和侧栏不同步。逐条钉死。
 *
 * 跑法：node .AGENT/scripts/ai-assistant/verify-assistant-drafts.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const store = read('src/lib/assistantDraftStore.ts')
const hook = read('src/components/shared/AssistantPanel/useAssistantChat.ts')
const api = read('src/modules/ai-assistant/useAiAssistant.ts')
const mod = read('src/modules/ai-assistant/index.tsx')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` —— ${detail}` : ''}`) }
}

console.log('\n[A. 草稿仓库：内存、按会话、按来源隔离]')
check('仓库是内存 Map（不落盘）',
  /const drafts = new Map<string, string>\(\)/.test(store))
check('没有 localStorage / sessionStorage / IPC / 文件读写',
  !/localStorage|sessionStorage|\bipc\b|readFile|writeFile/.test(store))
check('会话 key 带 source，跨来源不共用',
  /return `session:\$\{source\}:\$\{sessionId\}`/.test(store))
check('新会话 key 带 source，日程/情报不串进通用助手',
  /return `new:\$\{source\}`/.test(store))
check('提供 set / move / delete / subscribe 四个操作',
  /export function setDraft/.test(store) &&
  /export function moveDraft/.test(store) &&
  /export function deleteDraft/.test(store) &&
  /export function subscribeDrafts/.test(store))
check('空串 = 删除条目（不为每个会话留空壳）',
  /if \(value\) drafts\.set\(key, value\)\s*\n\s*else drafts\.delete\(key\)/.test(store))

console.log('\n[B. 控制器：输入框读当前会话槽位]')
check('从共享仓库导入关键操作',
  /draftKeyForSession, draftKeyForNew, getDraft, setDraft, moveDraft, deleteDraft, subscribeDrafts/.test(hook))
check('草稿来源缺省为 assistant',
  /const draftSource = sessionSource \?\? 'assistant'/.test(hook))
check('输入快照 key = 当前会话 / 空白页',
  /const inputKey = activeId \? draftKeyForSession\(activeId, draftSource\) : newDraftKey/.test(hook))
check('用 useSyncExternalStore 读仓库（多宿主可同步）',
  /useSyncExternalStore\(subscribeDrafts, getInputSnapshot, \(\) => ''\)/.test(hook))
check('setInput 写入当前会话槽位（不是固定一份字符串）',
  /const sid = activeIdRef\.current[\s\S]{0,160}?setDraft\(sid \? draftKeyForSession\(sid, draftSource\) : newDraftKey, v\)/.test(hook))
check('旧实现「const [input, setInput] = useState(\'\')」已删除',
  !/const \[input, setInput\] = useState\(''\)/.test(hook))
check('activeIdRef 声明在 input 快照之前（setInput 无 TDZ）',
  hook.indexOf('const activeIdRef = useRef<string | null>(null)') <
  hook.indexOf('useSyncExternalStore(subscribeDrafts'))

console.log('\n[C. 切会话 / 新建 / 删除的边界]')
check('新建会话先记下旧 activeId（用于判断是不是空白页新建）',
  /const prevSid = activeIdRef\.current[\s\S]{0,120}?const hadActive = !!prevSid/.test(hook))
check('只有从空白页新建才搬草稿；已有会话新建时新会话为空',
  /if \(prevSid === null && activeIdRef\.current === null\) moveDraft\(newDraftKey, draftKeyForSession\(sRow\.id, draftSource\)\)/.test(hook))
check('新建会话没有清空原会话草稿的副作用',
  !/newSession[\s\S]{0,2000}?deleteDraft\(draftKeyForSession\(prevSid/.test(hook))
check('两条删除路径都清掉该会话草稿（deleteSessionNow / removeSession）',
  (hook.match(/deleteDraft\(draftKeyForSession\(id, draftSource\)\)/g) ?? []).length >= 2)
check('loadSession 仍同步写 activeIdRef（快速连点不被后到 fetch 覆盖）',
  /activeIdRef\.current = id[\s\S]{0,300}?const rows: AgentStoredMessage\[\] = await agentMessages\(id\)/.test(hook))

console.log('\n[D. 完整 AI 助手模块改用共享输入]')
check('useAiAssistant 暴露 input / setInput',
  /input: string/.test(api) && /setInput: \(v: string\) => void/.test(api) &&
  /input: chat\.input/.test(api) && /setInput: chat\.setInput/.test(api))
check('模块不再自己维护 draft state',
  !/const \[draft, setDraft\] = useState\(''\)/.test(mod) && !/setDraft\(/.test(mod))
check('textarea 绑定 api.input / api.setInput',
  /value=\{api\.input\}/.test(mod) && /onChange=\{\(e\) => api\.setInput\(e\.target\.value\)\}/.test(mod))
check('发送按钮按 api.input 判空',
  /disabled=\{!api\.input\.trim\(\)\}/.test(mod))
check('handleSend 读 api.input',
  /const text = api\.input\.trim\(\)/.test(mod))
check('发送前后清的是当前会话草稿（api.setInput）',
  /if \(run\.kind === 'send'\) \{ api\.setInput\(''\); void api\.send\(run\.text\); return \}/.test(mod))

console.log('\n[E. 行为语义]')
check('草稿跟着 activeId 走：切 B 读 B 的槽位（inputKey 依赖 activeId）',
  /activeId \? draftKeyForSession\(activeId, draftSource\)/.test(hook))
check('发送清空只影响当前会话（setInput 走 activeIdRef）',
  /setDraft\(sid \? draftKeyForSession\(sid, draftSource\) : newDraftKey, v\)/.test(hook))
check('发送 / 斜杠指令清的是发送时的会话 id（await 期间切会话不误清）',
  /const draftSid = activeIdRef\.current/.test(hook) &&
  /if \(!override\) clearInputFor\(draftSid\)/.test(hook) &&
  /clearInputFor\(sid\)/.test(hook))
check('旧会话草稿不因新建被删（move 只从 newDraftKey 出发）',
  /moveDraft\(newDraftKey, draftKeyForSession\(sRow\.id, draftSource\)\)/.test(hook) &&
  !/moveDraft\(draftKeyForSession\(prevSid/.test(hook))
check('删除会话后草稿不残留',
  /await agentDeleteSession\(id\)[\s\S]{0,120}?deleteDraft\(draftKeyForSession\(id, draftSource\)\)/.test(hook))
check('跨宿主同步靠共享 store + useSyncExternalStore（完整模块与侧栏同一格）',
  /useSyncExternalStore\(subscribeDrafts/.test(hook) && /input: chat\.input/.test(api))

console.log('\n========================================')
if (fail === 0) {
  console.log(`[OK] 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`[FAIL] ${fail} 项 FAIL（另有 ${pass} 项 PASS）`)
  process.exit(1)
}
