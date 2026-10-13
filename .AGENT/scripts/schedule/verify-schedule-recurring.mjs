#!/usr/bin/env node
/**
 * 固定日程（重复任务）契约：纯函数用例 + 全链路接线断言。
 * 跑法：node .AGENT/scripts/schedule/verify-schedule-recurring.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planScheduleRecurringSettle, recurringFreqLabel, endOfWeek, minToHm, hmToMin, parseScheduleWeekdays } from '../../../src/lib/scheduleRecurringPure.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}

const R = (o) => ({
  id: 'r1', title: 't', freq: 'weekly', weekdays: [5], day: null, intervalDays: null,
  startMin: 840, endMin: 900, taskType: 'plan', quadrant: 1, tagId: null, enabled: true,
  endDate: '', lastPostedDate: '2026-10-09', createdAt: '', updatedAt: '', ...o,
})
const dues = (plan) => plan.map((p) => p.due).sort().join(',')

// 2026-10-10 = 周六（周一为 0 的约定下，周六 = 5）
console.log('\n[时间工具] hmToMin / minToHm / endOfWeek')
check('hmToMin 14:00 → 840', hmToMin('14:00') === 840)
check('minToHm 900 → 15:00', minToHm(900) === '15:00')
check('hmToMin 非法 → fallback', hmToMin('xx', 540) === 540)
check('endOfWeek(周五 10-09) → 周日 10-11', endOfWeek('2026-10-09') === '2026-10-11')

console.log('\n[标签] recurringFreqLabel')
check('每周六', recurringFreqLabel(R({ weekdays: [5] })) === '周六')
check('每周一、三', recurringFreqLabel(R({ weekdays: [0, 2] })) === '周一、周三')
check('每天', recurringFreqLabel(R({ weekdays: [0, 1, 2, 3, 4, 5, 6] })) === '每天')
check('每月 15 号', recurringFreqLabel(R({ freq: 'monthly', day: 15, weekdays: [] })) === '每月 15 号')
check('每 7 天', recurringFreqLabel(R({ freq: 'interval', intervalDays: 7, weekdays: [] })) === '每 7 天')

console.log('\n[结算] planScheduleRecurringSettle')
check('每周六：10-09 之后 → 10-10、10-17', dues(planScheduleRecurringSettle([R({ weekdays: [5] })], [], '2026-10-09', '2026-10-18')) === '2026-10-10,2026-10-17')
check('每周一/三：→ 10-12、10-14', dues(planScheduleRecurringSettle([R({ weekdays: [0, 2] })], [], '2026-10-09', '2026-10-15')) === '2026-10-12,2026-10-14')
check('每月 15 号 → 10-15', dues(planScheduleRecurringSettle([R({ freq: 'monthly', day: 15, weekdays: [], lastPostedDate: '2026-09-20' })], [], '2026-10-20', '2026-10-20')) === '2026-10-15')
check('每 3 天 → 10-12、10-15', dues(planScheduleRecurringSettle([R({ freq: 'interval', intervalDays: 3, weekdays: [], lastPostedDate: '2026-10-09' })], [], '2026-10-15', '2026-10-15')) === '2026-10-12,2026-10-15')
check('幂等：已生成 10-10 只剩 10-17', dues(planScheduleRecurringSettle([R({ weekdays: [5] })], [{ recurringId: 'r1', recurringDue: '2026-10-10' }], '2026-10-09', '2026-10-18')) === '2026-10-17')
check('endDate 封顶 10-11 → 只到 10-10', dues(planScheduleRecurringSettle([R({ weekdays: [5], endDate: '2026-10-11' })], [], '2026-10-09', '2026-10-31')) === '2026-10-10')
check('enabled=false 不参与', planScheduleRecurringSettle([R({ enabled: false })], [], '2026-10-09', '2026-10-31').length === 0)
check('lastPostedDate 当天不重复生成', dues(planScheduleRecurringSettle([R({ weekdays: [5], lastPostedDate: '2026-10-10' })], [], '2026-10-10', '2026-10-10')) === '')

// ---------- 接线 ----------
console.log('\n[接线] 数据层 scheduleVaultRepo.ts')
const repo = read('electron/lib/kbStore/scheduleVaultRepo.ts')
check('recurring.json 存储', repo.includes("RECUR_FILE = 'recurring.json'"))
check('增删改 + 结算 + 撤销', ['vaultScheduleRecurringAll', 'vaultScheduleCreateRecurring', 'vaultScheduleUpdateRecurring', 'vaultScheduleDeleteRecurring', 'vaultScheduleSettleRecurring', 'vaultScheduleUndoSettleRecurring'].every((s) => repo.includes(s)))
check('待办带 recurringId / recurringDue', repo.includes('recurringId?: string | null') && repo.includes('recurringDue?: string | null'))
check('结算复用纯函数', repo.includes("from '../../../src/lib/scheduleRecurringPure'") && repo.includes('planScheduleRecurringSettle('))

console.log('\n[接线] IPC 三层')
check('scheduleRepo 注册 6 个 handler', ['schedule:recurringList', 'schedule:recurringCreate', 'schedule:recurringUpdate', 'schedule:recurringDelete', 'schedule:recurringSettle', 'schedule:recurringUndoSettle'].every((s) => read('electron/database/repositories/scheduleRepo.ts').includes(s)))
check('rowToTodo 透传 recurringId', read('electron/database/repositories/scheduleRepo.ts').includes('recurringId: row.recurringId ?? null'))
check('preload 暴露通道', read('electron/preload/index.ts').includes("ipcRenderer.invoke('schedule:recurringSettle')"))
check('ipc.ts 封装', read('src/lib/ipc.ts').includes('scheduleRecurringSettle = () =>'))
check('types 声明 ScheduleRecurring', read('src/types/index.ts').includes('export interface ScheduleRecurring {'))

console.log('\n[接线] 渲染层')
check('RecurringRulesPanel 存在（用户手动入口）', (() => { const s = read('src/modules/schedule/components/RecurringRulesPanel.tsx'); return s.includes('scheduleRecurringCreate') && s.includes('新增') })())
const sidx = read('src/modules/schedule/index.tsx')
check('打开模块自动结算 + 可撤销', sidx.includes('scheduleRecurringSettle()') && sidx.includes("label: '撤销'") && sidx.includes('scheduleRecurringUndoSettle'))
check('左栏挂载规则面板', sidx.includes('<RecurringRulesPanel'))
check('周日程生成块画 🔁', read('src/modules/schedule/views/TimetableView.tsx').includes('todo.recurringId'))

console.log('\n[接线] AI 工具 + 人设')
const bt = read('electron/lib/builtinTools.ts')
check('4 个 recurring 工具', ['builtin.schedule.list-recurring', 'builtin.schedule.create-recurring', 'builtin.schedule.update-recurring', 'builtin.schedule.delete-recurring'].every((s) => bt.includes(`'${s}'`)))
check('tool.request 清单补 recurring', bt.includes('schedule.create-recurring / schedule.update-recurring / schedule.delete-recurring'))
const as = read('electron/lib/agentService.ts')
check('SCHEDULE_TOOL_NAMES 含 recurring', as.includes("'builtin.schedule.create-recurring'") && as.includes("'builtin.schedule.delete-recurring'"))
check('人设讲固定日程', as.includes('固定日程（重复任务）') && as.includes('create-recurring'))

console.log('\n[手册] resources/help/日程助手与固定日程.md')
check('补「固定日程」段', read('resources/help/日程助手与固定日程.md').includes('固定日程'))

/* ==================== 2026-10-13 反馈修复（F-5 / F-6）====================
   F-6：模型说「周六」传了 6（它按 JS getDay 想事），而工具契约写的是「0=周一…6=周日」
        ⇒ 我们这边 6 = 周日，整整差一天（实机复现，模型在会话里自己承认了）。
        改法：入参改**字符串 enum**（模型不必记刻度）+ 数字按 ISO 1..7（0 也当周日）+ 非法值报错 + 返回值回显人话。
   F-5：规则与待办是两层数据，而结算原来只在"模块挂载时"跑一次（模块 Tab 保活 ⇒ 早就挂过了）
        ⇒ AI 建完规则，日程表里什么都没有（实机：recurring.json 4 条 / todos.json 是空的）。 */

console.log('\n[F-6] 星期几入参：不再靠"记住刻度"')
check('周一…周六 两套刻度数值相同（1..6）→ 只有周日是 7/0',
  parseScheduleWeekdays([1, 2, 3, 4, 5, 6]).ok && parseScheduleWeekdays([1, 2, 3, 4, 5, 6]).mon0.join() === '0,1,2,3,4,5')
check('ISO 7 = 周日', parseScheduleWeekdays([7]).ok && parseScheduleWeekdays([7]).mon0.join() === '6')
check('JS 0 = 周日（也收）', parseScheduleWeekdays([0]).ok && parseScheduleWeekdays([0]).mon0.join() === '6')
check('★ 模型说「周六」传 6 → 落盘是 5（周六），不再是周日',
  parseScheduleWeekdays([6]).ok && parseScheduleWeekdays([6]).mon0.join() === '5')
check('字符串「周六」→ 5', parseScheduleWeekdays(['周六']).ok && parseScheduleWeekdays(['周六']).mon0.join() === '5')
check('「星期六」「礼拜天」「sat」「sunday」都认',
  parseScheduleWeekdays(['星期六']).mon0.join() === '5' && parseScheduleWeekdays(['礼拜天']).mon0.join() === '6'
  && parseScheduleWeekdays(['sat']).mon0.join() === '5' && parseScheduleWeekdays(['sunday']).mon0.join() === '6')
check('去重 + 升序', parseScheduleWeekdays(['周三', 3, '周一']).mon0.join() === '0,2')
check('回显人话（供工具 return 用）', parseScheduleWeekdays(['周六']).text === '周六' && parseScheduleWeekdays(['周一', '周三']).text === '周一、周三')
check('★ 越界不再静默夹成周一（原来 clampInt(n,0,6,0) 会把 9 变成周一）', parseScheduleWeekdays([9]).ok === false)
check('负向：认不出的字符串报错而不是猜', parseScheduleWeekdays(['周末']).ok === false)
check('负向：非数字非字符串报错', parseScheduleWeekdays([{}]).ok === false)

console.log('\n[F-6] 工具接线')
check('create-recurring 的 weekdays 是**字符串 enum**（模型从清单里挑）',
  /weekdays: \{ type: 'array', items: \{ type: 'string', enum: \['周一'/.test(bt))
/* ★ 负向判据按**形状**卡，不按文案卡：第一版写成 `!bt.includes('0=周一…6=周日')`，
   结果被我**自己写的解释注释**判红（注释里正是那句话）—— 同 page-menu 契约 §12 踩过的坑。
   真正要守的不变量是「schema 里 weekdays 不再是数字形态」。 */
check('负向：weekdays 的 schema 不再是「数字 + 0=周一」那套',
  !/weekdays: \{ type: 'array', items: \{ type: 'number' \}/.test(bt))
check('handler 用纯函数解析（不再 map(num(n, 0))）',
  bt.includes('const wd = parseScheduleWeekdays(args.weekdays)') && !bt.includes('args.weekdays.map((n) => num(n, 0))'))
check('★ 空 weekdays 报错（空数组 = 一条永远不生效的规则）', bt.includes('freq=weekly 必须给 weekdays'))
check('★ 返回值回显人话（原来只回 id/title/freq/start/end，模型写错自己也不知道）',
  bt.includes('repeat: recurringFreqLabel(row)'))
check('update-recurring 同样解析 + 回显',
  bt.includes('if (args.weekdays !== undefined) {') && bt.includes('patch.weekdays = wd.mon0')
  && (bt.split('repeat: recurringFreqLabel(row)').length - 1) === 2)

console.log('\n[F-5] 写侧结算 + 广播（建完就看得见）')
check('★ repo 层有写侧结算（谁写谁负责，不依赖 UI 挂载）',
  repo.includes('function settleAfterWrite(') && repo.includes('settleAfterWrite(row)') && repo.includes('settleAfterWrite(next)'))
check('★ 上界照顾"下一次在周日之后"（周日建「每周一」也要立刻生成）',
  repo.includes('const horizon = first && first > endOfWeek(today) ? first : endOfWeek(today)'))
check('结算上界复用纯函数取首次应生成日（不另写一套迭代）',
  repo.includes('planScheduleRecurringSettle([rule], vaultTodosAll(), today, addDaysTo(today, 400))'))
check('★ IPC 层写盘后广播（铁律 1：主进程写盘后唯一刷新通道）',
  ['schedule:recurringCreate', 'schedule:recurringUpdate', 'schedule:recurringDelete'].every((h) => {
    const i = read('electron/database/repositories/scheduleRepo.ts').indexOf(`'${h}'`)
    return i >= 0 && read('electron/database/repositories/scheduleRepo.ts').slice(i, i + 320).includes('broadcastDataChanged')
  }))
check('★ 日程模块收到 schedule 广播时**推进周网格取数代次**（原来只刷列表，网格要切 Tab 才更新）',
  /useDataChanged\('schedule', \(\) => \{[\s\S]{0,300}setWeekRefresh\(v => v \+ 1\)/.test(sidx))
check('负向：周网格不再只靠"切 Tab 重取"（isActive 那条仍在，但不再是唯一出路）',
  read('src/modules/schedule/views/TimetableView.tsx').includes('refreshSignal'))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
