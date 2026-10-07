import { useCallback, useEffect, useState } from 'react'
import { accountingGetAll } from '../../lib/ipc'
import { useDataChanged } from '../../lib/dataChanged'
import type { AccountingTransaction, AccountingCategory, AccountingAccount, AccountingType } from '../../types'

/**
 * 记账模块共享工具：格式化、窗口口径、跨组件事件、数据加载 hook。
 * 模块（中央三视图 + 左栏侧栏）与右栏面板共用本文件。
 */

export type AccountingView = 'flow' | 'stats' | 'review'

// ===== 日期 / 金额 =====
const pad2 = (n: number): string => String(n).padStart(2, '0')

export function todayStr(): string {
  const n = new Date()
  return `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`
}
export function monthLabel(m: string): string {
  const [y, mm] = m.split('-')
  return `${y}年${Number(mm)}月`
}
export function money(n: number): string {
  return `${n < 0 ? '-' : ''}¥${Math.abs(n).toLocaleString('zh-CN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`
}
export function sumAmount(list: AccountingTransaction[], type: AccountingType): number {
  return list.filter((t) => t.type === type).reduce((a, b) => a + b.amount, 0)
}
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
export function dayLabel(date: string): { d: string; w: string } {
  const t = todayStr()
  const d = new Date(`${date}T00:00:00`)
  const w = Number.isNaN(d.getTime()) ? '' : WD[d.getDay()]
  if (date === t) return { d: '今天', w }
  const y = new Date(); y.setDate(y.getDate() - 1)
  const ys = `${y.getFullYear()}-${pad2(y.getMonth() + 1)}-${pad2(y.getDate())}`
  if (date === ys) return { d: '昨天', w }
  return { d: `${date.slice(5, 7)}月${date.slice(8, 10)}日`, w }
}

/** 分类色：按名取，找不到回退灰 */
export function catColor(categories: AccountingCategory[], name: string): string {
  return categories.find((c) => c.name === name)?.color ?? '#7a7a7a'
}

// ===== 跨组件事件：中央「编辑某笔」→ 右栏记账面板 =====
export const ACCOUNTING_EDIT_EVENT = 'kb-accounting-edit-tx'
export function requestEditTransaction(id: string): void {
  window.dispatchEvent(new CustomEvent(ACCOUNTING_EDIT_EVENT, { detail: { id } }))
}

/** 中央「记一笔」→ 右栏记账面板：清空表单并展开右栏记账 Tab */
export const ACCOUNTING_NEW_EVENT = 'kb-accounting-new-tx'
export function requestNewTransaction(): void {
  window.dispatchEvent(new CustomEvent(ACCOUNTING_NEW_EVENT))
}

// ===== 数据加载 =====
export function useAccountingData(): {
  transactions: AccountingTransaction[]
  categories: AccountingCategory[]
  accounts: AccountingAccount[]
  reload: () => Promise<void>
} {
  const [transactions, setTransactions] = useState<AccountingTransaction[]>([])
  const [categories, setCategories] = useState<AccountingCategory[]>([])
  const [accounts, setAccounts] = useState<AccountingAccount[]>([])
  const reload = useCallback(async (): Promise<void> => {
    try {
      const res = await accountingGetAll()
      setTransactions(res?.transactions ?? [])
      setCategories(res?.categories ?? [])
      setAccounts(res?.accounts ?? [])
    } catch { /* 仓库未打开时静默 */ }
  }, [])
  useEffect(() => { void reload() }, [reload])
  useDataChanged('accounting', () => { void reload() })
  return { transactions, categories, accounts, reload }
}

// ===== 账户余额（推导：初始余额 + 累计收入 − 累计支出） =====
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

export function computeAccountBalances(
  accounts: AccountingAccount[],
  transactions: AccountingTransaction[],
): { list: AccountBalance[]; total: number } {
  const byName = new Map<string, { income: number; expense: number }>()
  for (const t of transactions) {
    const key = t.payment || ''
    const e = byName.get(key) ?? { income: 0, expense: 0 }
    if (t.type === 'income') e.income += t.amount; else e.expense += t.amount
    byName.set(key, e)
  }
  const known = new Set(accounts.map((a) => a.name))
  const list: AccountBalance[] = accounts.map((a) => {
    const e = byName.get(a.name) ?? { income: 0, expense: 0 }
    return { id: a.id, name: a.name, color: a.color, initialBalance: a.initialBalance, income: e.income, expense: e.expense, balance: a.initialBalance + e.income - e.expense }
  })
  // 未归户（有流水但 payment 为空 / 账户不存在）单列
  let looseIncome = 0, looseExpense = 0
  for (const [k, e] of byName) {
    if (k && known.has(k)) continue
    looseIncome += e.income; looseExpense += e.expense
  }
  if (looseIncome || looseExpense) {
    list.push({ id: '__loose', name: '未指定', color: '#7a7a7a', initialBalance: 0, income: looseIncome, expense: looseExpense, balance: looseIncome - looseExpense, loose: true })
  }
  const total = list.reduce((a, b) => a + b.balance, 0)
  return { list, total: Math.round(total * 100) / 100 }
}
