import type { AccountingAccount, AccountingRecurring, AccountingTransaction, AccountingType } from '../types'

/**
 * 记账口径纯函数（零运行时依赖，供渲染层与契约脚本共用）。
 *
 * 口径（与主进程 accountingVaultRepo.vaultAccountingBalances 同源）：
 *  - 账户余额 = 初始余额 + 累计收入 − 累计支出 + 累计转入 − 累计转出
 *  - 「转账」（type='transfer'）：`payment` = 转出账户、`toPayment` = 转入账户；
 *    **不计入收入/支出**（故不进本月收支/分类占比/趋势等统计），只把余额从源挪到目标；
 *    转账净额为 0，故总额不受影响。
 */

/** 按精确类型求和（transfer 不是 income/expense，天然不被计入） */
export function sumAmount(list: AccountingTransaction[], type: AccountingType): number {
  return list.filter((t) => t.type === type).reduce((a, b) => a + b.amount, 0)
}

export interface AccountBalance {
  id: string
  name: string
  color: string
  initialBalance: number
  income: number
  expense: number
  balance: number
  /** 未归户流水（payment 为空或账户已不存在） */
  loose?: boolean
}

interface Acc { income: number; expense: number; tIn: number; tOut: number }

export function computeAccountBalances(
  accounts: AccountingAccount[],
  transactions: AccountingTransaction[],
): { list: AccountBalance[]; total: number } {
  const byName = new Map<string, Acc>()
  const acc = (key: string): Acc => {
    const e = byName.get(key) ?? { income: 0, expense: 0, tIn: 0, tOut: 0 }
    byName.set(key, e)
    return e
  }
  for (const t of transactions) {
    if (t.type === 'income') acc(t.payment || '').income += t.amount
    else if (t.type === 'expense') acc(t.payment || '').expense += t.amount
    else if (t.type === 'transfer') {
      acc(t.payment || '').tOut += t.amount            // 转出账户扣
      acc(t.toPayment || '').tIn += t.amount           // 转入账户加
    }
  }
  const zero: Acc = { income: 0, expense: 0, tIn: 0, tOut: 0 }
  const balanceOf = (a: Acc, initial: number): number => initial + a.income - a.expense + a.tIn - a.tOut
  const known = new Set(accounts.map((a) => a.name))
  const list: AccountBalance[] = accounts.map((a) => {
    const e = byName.get(a.name) ?? zero
    return { id: a.id, name: a.name, color: a.color, initialBalance: a.initialBalance, income: e.income, expense: e.expense, balance: balanceOf(e, a.initialBalance) }
  })
  // 未归户（有流水但 payment / toPayment 为空或账户已不存在）单列
  let looseIncome = 0, looseExpense = 0, looseIn = 0, looseOut = 0
  for (const [k, e] of byName) {
    if (k && known.has(k)) continue
    looseIncome += e.income; looseExpense += e.expense; looseIn += e.tIn; looseOut += e.tOut
  }
  if (looseIncome || looseExpense || looseIn || looseOut) {
    list.push({ id: '__loose', name: '未指定', color: '#7a7a7a', initialBalance: 0, income: looseIncome, expense: looseExpense, balance: looseIncome - looseExpense + looseIn - looseOut, loose: true })
  }
  const total = list.reduce((a, b) => a + b.balance, 0)
  return { list, total: Math.round(total * 100) / 100 }
}

// ===== 定期收支（纯函数；渲染层 + 主进程 + 契约脚本共用） =====

const pad2 = (n: number): string => String(n).padStart(2, '0')
function parseDate(s: string): Date {
  const [y, m, d] = String(s).split('-').map(Number)
  return new Date(y || 1970, (m || 1) - 1, d || 1)
}
function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
function addDays(s: string, n: number): string {
  const d = parseDate(s); d.setDate(d.getDate() + n); return fmtDate(d)
}
/** 每月 day 号在指定年月的实际日期（短月落到月末，如 31 → 2 月 28/29） */
export function clampDay(year: number, month: number, day: number): number {
  const last = new Date(year, month, 0).getDate()
  return Math.max(1, Math.min(day || 1, last))
}
/** 指定年月的应扣日 YYYY-MM-DD（month 1–12） */
export function monthDue(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(clampDay(year, month, day))}`
}
function shiftMonth(y: number, m: number, k: number): { y: number; m: number } {
  const d = new Date(y, m - 1 + k, 1)
  return { y: d.getFullYear(), m: d.getMonth() + 1 }
}

/** 下次应扣日 = lastPostedDate 之后一个周期（monthly：下月同日；interval：+N 天） */
export function recurringNextDue(rule: AccountingRecurring): string {
  if (rule.mode === 'interval') return addDays(rule.lastPostedDate, rule.intervalDays || 1)
  const d = parseDate(rule.lastPostedDate)
  const n = shiftMonth(d.getFullYear(), d.getMonth() + 1, 1)
  return monthDue(n.y, n.m, rule.day || 1)
}

export type RecurringStatusKind = 'paused' | 'done' | 'due' | 'future'
export interface RecurringStatus { kind: RecurringStatusKind; due: string }

/**
 * 规则状态：已暂停 / 本月已记 ✓ / 待记（该扣已过还没记）/ 待扣（还没到日子）。
 * monthly 用「本月应扣日」判断是否已记；interval 用「下次应扣日」判断。
 */
export function recurringStatus(rule: AccountingRecurring, transactions: AccountingTransaction[], today: string): RecurringStatus {
  if (!rule.enabled) return { kind: 'paused', due: '' }
  const posted = new Set(transactions.filter((t) => t.recurringId === rule.id).map((t) => t.recurringDue))
  if (rule.mode === 'monthly') {
    const t = parseDate(today)
    const due = monthDue(t.getFullYear(), t.getMonth() + 1, rule.day || 1)
    if (posted.has(due)) return { kind: 'done', due }
    return parseDate(due) <= parseDate(today) ? { kind: 'due', due } : { kind: 'future', due }
  }
  const due = recurringNextDue(rule)
  return parseDate(due) <= parseDate(today) ? { kind: 'due', due } : { kind: 'future', due }
}

export interface RecurringDue { ruleId: string; due: string }

/**
 * 结算计划（纯函数）：列出「应记但还没记」的 (规则, 应扣日)。
 * 幂等——已有同 (recurringId, recurringDue) 的流水即跳过；只在 `enabled && autoPost` 时参与。
 * 起点 = 规则的 lastPostedDate（monthly 从其次月起、interval 从 +N 起）；跳过 > endDate 的应扣日。
 */
export function planRecurringSettle(rules: AccountingRecurring[], transactions: AccountingTransaction[], today: string): RecurringDue[] {
  const out: RecurringDue[] = []
  const existing = new Set(
    transactions.filter((t) => t.recurringId && t.recurringDue).map((t) => `${t.recurringId}@${t.recurringDue}`),
  )
  const todayD = parseDate(today)
  for (const rule of rules) {
    if (!rule.enabled || !rule.autoPost) continue
    const endD = rule.endDate ? parseDate(rule.endDate) : null
    if (rule.mode === 'monthly') {
      const start = parseDate(rule.lastPostedDate)
      let { y, m } = shiftMonth(start.getFullYear(), start.getMonth() + 1, 1)
      const tY = todayD.getFullYear(), tM = todayD.getMonth() + 1
      let guard = 0
      while ((y < tY || (y === tY && m <= tM)) && guard++ < 600) {
        const due = monthDue(y, m, rule.day || 1)
        const dueD = parseDate(due)
        if (dueD > start && dueD <= todayD && (!endD || dueD <= endD) && !existing.has(`${rule.id}@${due}`)) {
          out.push({ ruleId: rule.id, due })
        }
        ;({ y, m } = shiftMonth(y, m, 1))
      }
    } else {
      const step = rule.intervalDays || 1
      let d = parseDate(addDays(rule.lastPostedDate, step))
      let guard = 0
      while (d <= todayD && guard++ < 600) {
        const ds = fmtDate(d)
        if ((!endD || d <= endD) && !existing.has(`${rule.id}@${ds}`)) out.push({ ruleId: rule.id, due: ds })
        d = parseDate(addDays(ds, step))
      }
    }
  }
  return out
}

/** 规则金额合计（指定类型；默认只算启用中的支出） */
export function recurringMonthlyTotal(rules: AccountingRecurring[], type: AccountingType = 'expense'): number {
  const sum = rules.filter((r) => r.enabled && r.type === type).reduce((a, b) => a + b.amount, 0)
  return Math.round(sum * 100) / 100
}
