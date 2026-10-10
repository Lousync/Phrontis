import { useCallback, useEffect, useState } from 'react'
import { accountingGetAll } from '../../lib/ipc'
import { useDataChanged } from '../../lib/dataChanged'
import { sumAmount, computeAccountBalances, type AccountBalance } from '../../lib/accountingPure'
import type { AccountingTransaction, AccountingCategory, AccountingAccount } from '../../types'

// 金额求和与账户余额口径下沉到零依赖纯函数（供契约脚本 import），此处再导出保持既有引用不变
export { sumAmount, computeAccountBalances }
export type { AccountBalance }

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
