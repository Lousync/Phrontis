import type { AccountingAccount, AccountingTransaction, AccountingType } from '../types'

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
