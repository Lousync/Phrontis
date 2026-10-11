#!/usr/bin/env node
/**
 * 日程助手（日程 AI 化 P1）契约：纯函数用例 + 全链路接线断言。
 * 跑法：node .AGENT/scripts/schedule/verify-schedule-assistant.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSchedulePreviewFence } from '../../../src/modules/schedule/previewPure.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}

// ---------- 纯函数：排期预览围栏解析 ----------
console.log('\n[纯函数] parseSchedulePreviewFence')
const okJson = JSON.stringify({ title: '本周排期', items: [{ date: '2026-10-14', start: '19:00', end: '20:30', title: '复习线性代数' }] })
const d1 = parseSchedulePreviewFence(okJson)
check('合法 JSON → 解析出 1 条 + 标题', !!d1 && d1.items.length === 1 && d1.title === '本周排期' && d1.items[0].title === '复习线性代数')
check('缺 title 字段仍可解析', (() => { const d = parseSchedulePreviewFence(JSON.stringify({ items: [{ date: '2026-10-14', title: 'x' }] })); return !!d && d.title === undefined })())
check('date 非 YYYY-MM-DD → 该条丢弃', parseSchedulePreviewFence(JSON.stringify({ items: [{ date: '10/14', title: 'x' }] })) === null)
check('title 空 → 该条丢弃', parseSchedulePreviewFence(JSON.stringify({ items: [{ date: '2026-10-14', title: '  ' }] })) === null)
check('items 空数组 → null', parseSchedulePreviewFence(JSON.stringify({ items: [] })) === null)
check('非 JSON → null（回退代码块）', parseSchedulePreviewFence('not json') === null)
check('start/end 缺省 → 空串', (() => { const d = parseSchedulePreviewFence(JSON.stringify({ items: [{ date: '2026-10-14', title: 'x' }] })); return !!d && d.items[0].start === '' && d.items[0].end === '' })())

// ---------- 接线：类型 / 指令 ----------
console.log('\n[接线] 类型 + 指令框架')
check('types: AgentSessionSource 含 schedule', read('src/types/index.ts').includes("AgentSessionSource = 'assistant' | 'aiTeaching' | 'schedule'"))
check('chatCommands: ChatSurface 含 schedule', read('src/lib/chatCommands.ts').includes("ChatSurface = 'assistant' | 'aiTeaching' | 'aiLearn' | 'schedule'"))
const cc = read('src/lib/chatCommands.ts')
check('ChatCommand 支持 prompt / surfaces', cc.includes('prompt?: string') && cc.includes('surfaces?: ChatSurface[]'))
check('ChatCommandCtx 支持 onSend', cc.includes('onSend?: (text: string) => void'))
check('提示型命令经 onSend 发出', cc.includes('ctx.onSend(cmd.prompt)'))
check('commandsForSurface 导出', cc.includes('export function commandsForSurface'))
check('日程指令集 /简报 /排这周 /拆解 /今天', ['简报', '排这周', '拆解', '今天'].every((n) => cc.includes(`name: '${n}'`)))
check('/compress 限定非日程面', cc.includes("surfaces: ['assistant', 'aiTeaching', 'aiLearn']"))
check('SlashCommandMenu 按面过滤', read('src/components/shared/SlashCommandMenu.tsx').includes('commandsForSurface(surface)'))

// ---------- 接线：后端 ----------
console.log('\n[接线] 主进程 agentService / agentSessionRepo')
const as = read('electron/lib/agentService.ts')
check('导入 vaultTodosAll', as.includes("from './kbStore/scheduleVaultRepo'"))
check('SCHEDULE_PERSONA 人设', as.includes('const SCHEDULE_PERSONA'))
check('buildScheduleInjection 摘要', as.includes('function buildScheduleInjection') && as.includes('【日程数据（本轮快照）】'))
check('SCHEDULE_TOOL_NAMES 工具白名单', as.includes('const SCHEDULE_TOOL_NAMES') && as.includes("'builtin.schedule.create-todo'"))
check('source===\'schedule\' 注入人设 + 摘要', as.includes("source === 'schedule' ? SCHEDULE_PERSONA : ''") && as.includes("source === 'schedule' ? buildScheduleInjection() : ''"))
check('工具面按 schedule 收窄', as.includes("source === 'schedule' ? SCHEDULE_TOOL_NAMES"))
check('仅白名单内 ondemand 工具可见', as.includes('!onlySet?.has(t.name) && !extraTools?.has(t.name)'))
check('newSession 支持 schedule', as.includes("source === 'schedule' ? 'schedule' : 'assistant'"))
check('缺省 source 按会话记录回推', as.includes("if (!source && sessionId) source = getAgentSession(sessionId)?.source"))
check('摘要进首条 user 消息层（缓存前缀稳定）', as.includes('const requestInjection = [scheduleHint, refInjection, perceptionInjection]'))
check('agentSessionRepo: AgentSessionSource 含 schedule', read('electron/lib/agentSessionRepo.ts').includes("AgentSessionSource = 'assistant' | 'aiTeaching' | 'schedule'"))
check('人设要求排期预览围栏 schedule-preview', as.includes('schedule-preview'))

// ---------- 接线：渲染层 ----------
console.log('\n[接线] 渲染层')
const urp = read('src/components/workbench/WorkbenchRightPanel.tsx')
check('WorkbenchRightPanel: scheduleActive prop', urp.includes('scheduleActive?: boolean') && urp.includes('scheduleActive = false'))
check('条件页签 data-wb-rp-tab="schedule"', urp.includes('data-wb-rp-tab="schedule"'))
check('渲染 ScheduleAssistantPanel', urp.includes("effectiveTab === 'schedule' ?") && urp.includes('<ScheduleAssistantPanel />'))
check('workbenchLayout: rightTab 含 schedule', read('src/lib/workbenchLayout.ts').includes("'schedule'") && read('src/lib/workbenchLayout.ts').includes('RIGHT_PANEL_TAB_IDS_ALL = '))

const uac = read('src/components/shared/AssistantPanel/useAssistantChat.ts')
check('useAssistantChat: sessionSource 选项', uac.includes('sessionSource?: AgentSessionSource'))
check('会话列表按 source 分流', uac.includes("all.filter(x => x.source === sessionSource)"))
check('新建会话带 source', uac.includes('agentNewSession(undefined, sessionSource)'))
check('发送透传 source', uac.includes('agentChat(sid, body, finalCtx ?? undefined, cid, sessionSource'))

const cb = read('src/components/shared/AssistantPanel/ChatBody.tsx')
check('ChatBody: surface 裁剪通用控件', cb.includes("const scheduleMode = surface === 'schedule'"))
check('隐藏 @ / 附件 / 模型 / 消耗', cb.includes('!scheduleMode && atPosRef.current') && cb.includes('{!scheduleMode && (<>'))
check('弹层按 surface 过滤 + 无 Skill', cb.includes('buildSlashItems(scheduleMode ? [] : slashSkills, [], surface)'))
check('会话列表按日期展示（一天一会话）', cb.includes('scheduleMode ? schedDayLabel(sess.createdAt) : sess.title'))

check('ScheduleAssistantPanel 存在且用 schedule 来源', (() => { const s = read('src/modules/schedule/ScheduleAssistantPanel.tsx'); return s.includes("surfaceOf: () => 'schedule'") && s.includes("sessionSource: 'schedule'") })())
check('排期预览卡 SchedulePreviewCard', read('src/modules/schedule/SchedulePreviewCard.tsx').includes('SchedulePreviewData') && read('src/modules/schedule/SchedulePreviewCard.tsx').includes('确认排入'))
check('MarkdownPreview 渲染 schedule-preview 围栏', read('src/components/shared/MarkdownPreview.tsx').includes('language-schedule-preview'))

const app = read('src/App.tsx')
check('App: scheduleActive={activeTab===\'schedule\'}', app.includes("scheduleActive={activeTab === 'schedule'}"))
check('App: 监听打开日程助手事件', app.includes('SCHEDULE_OPEN_ASSISTANT_EVENT'))

const sidx = read('src/modules/schedule/index.tsx')
check('日程顶栏「一句话加任务」', sidx.includes('requestScheduleAssistant') && sidx.includes('一句话加任务'))
check('日程模块切周视图事件', sidx.includes('SCHEDULE_OPEN_WEEK_EVENT'))
check('shared.ts 事件桥齐全', ['SCHEDULE_OPEN_ASSISTANT_EVENT', 'SCHEDULE_PREVIEW_CONFIRM_EVENT', 'SCHEDULE_PREVIEW_ADJUST_EVENT', 'SCHEDULE_OPEN_WEEK_EVENT'].every((e) => read('src/modules/schedule/shared.ts').includes(e)))

// ---------- 任务类型语义（截止类 / 目标类） ----------
console.log('\n[任务类型] 截止类 deadline / 目标类 plan+endCriteria')
const bt = read('electron/lib/builtinTools.ts')
check('create-todo schema 有 endCriteria', /name: 'builtin\.schedule\.create-todo'[\s\S]*?endCriteria: \{ type: 'string'/.test(bt))
check('create-todo 只在 plan 类写 end_criteria', bt.includes("end_criteria: taskType === 'plan' ? str(args.endCriteria).trim() : ''"))
check('list-todos 返回 endCriteria（能看见目标）', bt.includes('endCriteria: r.end_criteria ??'))
check('人设讲清 taskType 三类', as.includes('deadline（截止类）') && as.includes('plan（计划类 / 目标类）') && as.includes('daily（零碎）'))
check('人设：截止类用 time 且不占格', as.includes('time 用**完整时刻**') && as.includes('不要**传 scheduledStart/scheduledEnd'))
check('人设：两种时间严格分开', as.includes('两种时间语义严格分开'))
check('人设：批量排期只排非 deadline', as.includes('只排非 deadline'))

// ---------- 时间敏感 ----------
console.log('\n[时间敏感] 相对时间锚点 + 换算')
check('摘要给出当前日期 + 星期', as.includes('weekdayZh(now)') && as.includes('function weekdayZh'))
check('摘要给出当前时刻（时:分）', as.includes('const hhmm =') && as.includes('现在：${today} ${weekdayZh(now)} ${hhmm}'))
check('摘要给出本周一 / 下周一', as.includes('本周一 ${ymd(thisMon)} · 下周一 ${ymd(nextMon)}') && as.includes('function mondayOf'))
check('人设要求把相对时间换算成具体日期', as.includes('把相对时间换算成**具体日期') && as.includes('本周X / 下周X'))

// ---------- 时间工具（所有 AI 面） ----------
console.log('\n[工具] builtin.time.now（核心只读，三面可用）')
check('注册 builtin.time.now', bt.includes("name: 'builtin.time.now'"))
check('只读、无 module（处处可用）', /builtin\.time\.now'[\s\S]*?readOnly: true[\s\S]*?\}/.test(bt) && !/builtin\.time\.now'[\s\S]{0,220}?module:/.test(bt))
check('返回 日期/星期/时刻/本周', bt.includes('weekMonday:') && bt.includes("weekday: ['周日'"))
check('未标 tier（缺省 core 常驻）', !/builtin\.time\.now'[\s\S]{0,260}?tier:/.test(bt))

// ---------- 一天一个会话 ----------
console.log('\n[会话] 一天一个会话（autoResumeToday）')
check('hook 支持 autoResumeToday', uac.includes('autoResumeToday?: boolean') && uac.includes("const autoResumeToday = options.autoResumeToday === true"))
check('按 createdAt 判定今天', uac.includes("(s.createdAt ?? '').slice(0, 10) === today"))
check('没有今天的会话就新建（日期标题）', uac.includes('await newSession(todayLabel())') && uac.includes('function todayLabel'))
check('newSession 支持标题', uac.includes('newSession: (title?: string) => Promise<void>'))
check('面板开启 autoResumeToday', read('src/modules/schedule/ScheduleAssistantPanel.tsx').includes('autoResumeToday: true'))

// ---------- 手册 ----------
console.log('\n[手册] resources/help/日程与打卡小窗.md')
check('补「日程助手」段', read('resources/help/日程与打卡小窗.md').includes('日程助手'))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
