/**
 * 契约验证：AI 对话面的会话隔离（v3.15.3）。
 *
 * 背景：AI 教学主对话仍用 `useAgentStream(chatIdRef)` 单槽草稿 + 全局 pending，
 * 课程助手输出中切到知识点段时，旧 run 的「思考中 / 工具步骤 / 正文」串到新会话；
 * 旧 run 收尾还会用 `refreshMessages(旧 sid)` 覆盖新会话消息。
 *
 * 本脚本锁三件事：
 *  1. AI 教学主对话接入 N-3 的 assistantRunStore（按 sessionId 分桶、会话级 pending）；
 *  2. 旧 run 的晚到刷新 / 工件事件不能写进当前会话；
 *  3. 其他 AI 对话面（AI 助手三宿主 / 日程 / 情报 / AI 学堂 / 支线）都走同一套会话隔离。
 *
 * 用法（仓库根）：node .AGENT/scripts/ai-teaching/verify-session-isolation.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const teach = read('src/modules/ai-teaching/index.tsx')
const hook = read('src/components/shared/AssistantPanel/useAssistantChat.ts')
const store = read('src/lib/assistantRunStore.ts')

console.log('\n=== A. AI 教学主对话：运行态接入会话桶 ===')
check('不再使用 useAgentStream 单槽', !/useAgentStream\(/.test(teach) && !/from '[^']*useAgentStream'/.test(teach))
check('pending 按 activeId 现读', /const pending = isSessionRunning\(activeId\)/.test(teach))
check('draft / liveSteps 来自 activeId 的桶',
  /getRunBucket\(activeId\)/.test(teach) && /runBucket\?\.draft/.test(teach) && /runBucket\?\.liveSteps/.test(teach))
check('发送 / 继续走 beginRun + endRun',
  /beginRun\(sid\)/.test(teach) && /endRun\(sid\)/.test(teach), '')
check('订阅 store 并在后台完成时补拉消息',
  /subscribeAssistantRunState/.test(teach) && /takeEndedFor\(sid\)/.test(teach), '')
check('查看登记按 activeId + isActive（切模块后不吞角标）',
  /markSessionViewed\(activeId\)/.test(teach) && /unmarkSessionViewed\(activeId\)/.test(teach)
  && /!activeId \|\| !isActive/.test(teach), '')

console.log('\n=== B. 旧 run 晚到不污染新会话 ===')
check('refreshMessages 前后都校验 desiredSid',
  (teach.match(/activeIdRef\.current !== sid/g) || []).length >= 2, '')
check('openSession 同步写 activeIdRef（避免 effect 时序误杀首载）',
  /const openSession[\s\S]{0,500}activeIdRef\.current = sid/.test(teach), '')
check('onAgentStep 按 sessionId 过滤（不再按 chatId）',
  /onAgentStep\(\(\{ sessionId, step \}\)/.test(teach) && /sessionId !== activeIdRef\.current/.test(teach), '')
check('停止按 sessionId（agentAbortSession，不再 abort chatId）',
  /agentAbortSession\(sid\)/.test(teach) && !/agentAbort\(chatIdRef/.test(teach), '')
check('浮层支线切换按 laneId 重挂载',
  /<SideLanePanel[\s\S]{0,160}key=\{floatLane\.laneId\}/.test(teach), '')
check('侧栏支线详情按 activeId / create 重挂载',
  /<SideLanePanel[\s\S]{0,120}key=\{activeId\}/.test(read('src/modules/ai-teaching/SideLaneCenter.tsx'))
  && /key=\{`create:\$\{creatingAnchor\}`\}/.test(read('src/modules/ai-teaching/SideLaneCenter.tsx')), '')

console.log('\n=== C. 其他 AI 对话面：共用会话级控制器 ===')
const hosts = [
  ['AI 助手模块', 'src/modules/ai-assistant/useAiAssistant.ts'],
  ['AI 对话整页', 'src/components/shared/AssistantPanel/ChatBody.tsx'],
  ['工作台右栏', 'src/components/workbench/WorkbenchRightPanel.tsx'],
  ['悬浮侧栏', 'src/components/shared/AssistantPanel/index.tsx'],
  ['日程助手', 'src/modules/schedule/ScheduleAssistantPanel.tsx'],
  ['情报助手', 'src/modules/intel/IntelAssistantPanel.tsx'],
]
for (const [label, file] of hosts) {
  check(`${label} 走 useAssistantChat`, /useAssistantChat/.test(read(file)), file)
}
check('AI 学堂只消费 ChatBridge，不自建流式草稿',
  !/useAgentStream\(/.test(read('src/components/shared/AiLearn/index.tsx')), '')
check('useAssistantChat pending / draft 按会话桶',
  /const pending = isSessionRunning\(activeId\)/.test(hook)
  && /getRunBucket\(activeId\)/.test(hook), '')
check('useAssistantChat 生命周期走 beginRun / endRun',
  /beginRun\(sid\)/.test(hook) && /endRun\(sid\)/.test(hook), '')
check('useAssistantChat refreshMessages 前后校验 activeId',
  (hook.match(/activeIdRef\.current === sid/g) || []).length >= 2, '')
check('regenerate / resume / editSubmit 不再把旧 changes 写进新会话',
  (hook.match(/activeIdRef\.current === sid && r\.changes/g) || []).length >= 3, '')
check('停止按会话（agentAbortSession）', /agentAbortSession\(sid\)/.test(hook), '')

console.log('\n=== D. 单槽 hook 已退役 ===')
check('useAgentStream.ts 已删除',
  !fs.existsSync(path.join(ROOT, 'src/components/shared/AssistantPanel/useAgentStream.ts')), '')
const side = read('src/modules/ai-teaching/SideLanePanel.tsx')
check('支线面板也按 laneId 接入会话桶',
  /isSessionRunning\(laneId\)/.test(side) && /getRunBucket\(laneId\)/.test(side)
  && /beginRun\(laneId\)/.test(side) && /endRun\(laneId\)/.test(side), '')
check('支线停止按 laneId（agentAbortSession）', /agentAbortSession\(laneId\)/.test(side), '')

console.log('\n=== E. store 的会话分桶能力仍在 ===')
check('流式按 sessionId 入桶', /onAgentStream\(\(\{ sessionId, event \}\)/.test(store), '')
check('运行态按 sessionId 集合', /runningIds\.add|runningIds\.has/.test(store), '')
check('ended 时删桶并按 viewed 分发角标', /buckets\.delete\(ended\.sessionId\)/.test(store) && /unreadIds\.add\(ended\.sessionId\)/.test(store), '')

const fails = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : ' —— ' + c.detail}`)
console.log(fails.length ? `\n${fails.length} FAIL` : `\nALL PASS (${checks.length}/${checks.length})`)
process.exit(fails.length ? 1 : 0)
