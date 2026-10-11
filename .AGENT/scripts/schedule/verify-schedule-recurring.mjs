#!/usr/bin/env node
/**
 * 固定日程（重复任务）契约：纯函数用例 + 全链路接线断言。
 * 跑法：node .AGENT/scripts/schedule/verify-schedule-recurring.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planScheduleRecurringSettle, recurringFreqLabel, endOfWeek, minToHm, hmToMin } from '../../../src/lib/scheduleRecurringPure.ts'

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

console.log('\n[手册] resources/help/日程与打卡小窗.md')
check('补「固定日程」段', read('resources/help/日程与打卡小窗.md').includes('固定日程'))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
