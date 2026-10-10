#!/usr/bin/env node
/**
 * 记账「定期收支」契约：纯函数用例 + 全链路接线断言。
 * 跑法：node .AGENT/scripts/accounting/verify-recurring.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  clampDay, monthDue, recurringNextDue, recurringStatus, planRecurringSettle, recurringMonthlyTotal,
} from '../../../src/lib/accountingPure.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}

const R = (o) => ({
  id: 'r1', name: 'n', type: 'expense', amount: 0, category: '', payment: '', merchant: '', note: '',
  mode: 'monthly', day: null, intervalDays: null, lastPostedDate: '2026-01-01', endDate: '',
  enabled: true, autoPost: true, createdAt: '', updatedAt: '', ...o,
})
const T = (o) => ({
  id: 't1', date: '2026-01-01', time: '', type: 'expense', amount: 1, category: '', payment: '',
  merchant: '', note: '', createdAt: '', updatedAt: '', ...o,
})
const duesOf = (plan) => plan.map((p) => p.due).sort().join(',')

// ---------- 纯函数 ----------
console.log('\n[日期] clampDay / monthDue')
check('clampDay 平年 2 月 31 → 28', clampDay(2026, 2, 31) === 28)
check('clampDay 闰年 2 月 31 → 29', clampDay(2024, 2, 31) === 29)
check('clampDay 4 月 31 → 30', clampDay(2026, 4, 31) === 30)
check('monthDue 2026-02 31 → 2026-02-28', monthDue(2026, 2, 31) === '2026-02-28')

console.log('\n[下次应扣] recurringNextDue')
check('monthly 15 号：09-15 → 10-15', recurringNextDue(R({ mode: 'monthly', day: 15, lastPostedDate: '2026-09-15' })) === '2026-10-15')
check('monthly 31 号：01-31 → 02-28（短月落月末）', recurringNextDue(R({ mode: 'monthly', day: 31, lastPostedDate: '2026-01-31' })) === '2026-02-28')
check('interval 31 天：10-06 → 11-06', recurringNextDue(R({ mode: 'interval', intervalDays: 31, lastPostedDate: '2026-10-06' })) === '2026-11-06')

console.log('\n[状态] recurringStatus')
check('暂停 → paused', recurringStatus(R({ enabled: false }), [], '2026-10-10').kind === 'paused')
check('本月已记 → done', recurringStatus(R({ id: 'r1', mode: 'monthly', day: 1 }), [T({ recurringId: 'r1', recurringDue: '2026-10-01' })], '2026-10-10').kind === 'done')
check('本月已过未记 → due', recurringStatus(R({ mode: 'monthly', day: 5 }), [], '2026-10-10').kind === 'due')
check('本月未到 → future', recurringStatus(R({ mode: 'monthly', day: 15 }), [], '2026-10-10').kind === 'future')
check('interval 已到未记 → due', recurringStatus(R({ mode: 'interval', intervalDays: 31, lastPostedDate: '2026-08-30' }), [], '2026-10-10').kind === 'due')

console.log('\n[结算] planRecurringSettle')
check('monthly 补记 3 个月', duesOf(planRecurringSettle([R({ id: 'r1', mode: 'monthly', day: 1, lastPostedDate: '2026-07-01' })], [], '2026-10-10')) === '2026-08-01,2026-09-01,2026-10-01')
check('幂等：已记 09-01 只剩 2 笔', duesOf(planRecurringSettle([R({ id: 'r1', mode: 'monthly', day: 1, lastPostedDate: '2026-07-01' })], [T({ recurringId: 'r1', recurringDue: '2026-09-01' })], '2026-10-10')) === '2026-08-01,2026-10-01')
check('interval 补记 09-06 / 10-07', duesOf(planRecurringSettle([R({ id: 'r2', mode: 'interval', intervalDays: 31, lastPostedDate: '2026-08-06' })], [], '2026-10-10')) === '2026-09-06,2026-10-07')
check('到期日封顶：endDate 09-01 → 只到 09-01', duesOf(planRecurringSettle([R({ id: 'r3', mode: 'monthly', day: 1, lastPostedDate: '2026-07-01', endDate: '2026-09-01' })], [], '2026-10-10')) === '2026-08-01,2026-09-01')
check('autoPost=false 不参与', planRecurringSettle([R({ autoPost: false })], [], '2026-10-10').length === 0)
check('enabled=false 不参与', planRecurringSettle([R({ enabled: false })], [], '2026-10-10').length === 0)

console.log('\n[合计] recurringMonthlyTotal')
check('只算启用中的支出', recurringMonthlyTotal([
  R({ type: 'expense', amount: 25, enabled: true }),
  R({ type: 'expense', amount: 800, enabled: true }),
  R({ type: 'expense', amount: 199, enabled: false }),
  R({ type: 'income', amount: 2000, enabled: true }),
]) === 825)

// ---------- 接线 ----------
console.log('\n[接线] 数据层 accountingVaultRepo.ts')
const repo = read('electron/lib/kbStore/accountingVaultRepo.ts')
check('recurring.json 存储', repo.includes("RECUR_FILE = 'recurring.json'"))
check('结算 / 记入 / 增删改', ['vaultAccountingSettleRecurring', 'vaultAccountingPostRecurring', 'vaultAccountingCreateRecurring', 'vaultAccountingUpdateRecurring', 'vaultAccountingDeleteRecurring'].every((s) => repo.includes(s)))
check('流水带 recurringId / recurringDue', repo.includes('recurringId?: string') && repo.includes('recurringDue?: string'))
check('结算复用纯函数 planRecurringSettle', repo.includes("from '../../../src/lib/accountingPure'") && repo.includes('planRecurringSettle('))

console.log('\n[接线] IPC 三层')
check('accountingRepo 注册 5 个 handler', ['accounting:recurringCreate', 'accounting:recurringUpdate', 'accounting:recurringDelete', 'accounting:recurringPost', 'accounting:recurringSettle'].every((s) => read('electron/database/repositories/accountingRepo.ts').includes(s)))
check('getAll 返回 recurring', read('electron/database/repositories/accountingRepo.ts').includes('recurring: vaultAccountingRecurringAll()'))
check('preload 暴露通道', read('electron/preload/index.ts').includes("ipcRenderer.invoke('accounting:recurringSettle')"))
check('ipc.ts 封装', read('src/lib/ipc.ts').includes('accountingRecurringSettle = (): Promise<AccountingRecurringSettleResult>'))
check('types 声明 AccountingRecurring', read('src/types/index.ts').includes('export interface AccountingRecurring {'))

console.log('\n[接线] 渲染层')
const idx = read('src/modules/accounting/index.tsx')
check('左栏「定期收支」分区', idx.includes('定期收支') && idx.includes('recurringMonthlyTotal(recurring)'))
check('打开模块自动结算 + 可撤销', idx.includes('accountingRecurringSettle()') && idx.includes("label: '撤销'"))
const panel = read('src/modules/accounting/AccountingPanel.tsx')
check('记一笔「设为定期」开关', panel.includes('设为') && panel.includes('accountingRecurringCreate'))
check('规则表单：App 展开右栏 + prop 投递（右栏折叠卸载也能收到）', read('src/App.tsx').includes('ACCOUNTING_RECUR_NEW_EVENT') && panel.includes('openRule(pendingRule === '))
check('流水带 🔁 定期 标记', read('src/modules/accounting/views.tsx').includes('🔁 定期'))
check('Toast 支持 action（撤销按钮）', read('src/lib/toast.ts').includes('action?:') && read('src/components/shared/Toast.tsx').includes('t.action!'))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
