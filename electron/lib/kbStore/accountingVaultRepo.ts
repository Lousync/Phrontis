import { randomUUID } from 'crypto'
import { exists, readJson, writeJsonOrThrow } from './jsonStore'
import { planRecurringSettle, recurringNextDue, monthDue } from '../../../src/lib/accountingPure'

/**
 * 记账 vault 数据仓库（v3.5.x 新模块）。
 *
 * 存储：`.knowbase/modules/accounting/{transactions.json, categories.json}`
 * 真相源与 UI / AI 工具共用；无 sql.js 旧表，故字段用 camelCase（新模块不受迁移格式约束）。
 *
 * 去重指纹：`date|type|amount.toFixed(2)|merchant|note` —— 同一段手机 JSON 重复导入时跳过。
 * 分类：内置常用播种；AI / 手写遇到新分类名走 resolveOrCreateCategory 自动建（写路径，非查询副作用）。
 */

export type AccountingType = 'expense' | 'income'
/** 交易类型：收支之外多一个「转账」（账户间移动资金，不计入收支、不影响总额） */
export type AccountingTxType = 'expense' | 'income' | 'transfer'

export interface TransactionRow {
  id: string
  /** YYYY-MM-DD（本地） */
  date: string
  /** HH:mm 或 '' */
  time: string
  type: AccountingTxType
  /** 正数，元 */
  amount: number
  /** 分类名（denormalized，重命名需回写；v1 无重命名 UI） */
  category: string
  payment: string
  /** 转账专用：转入账户（type==='transfer' 时，payment = 转出账户） */
  toPayment?: string
  merchant: string
  note: string
  /** manual | phone-json | ai | recurring */
  source: string
  /** 定期收支生成的流水：所属规则 id */
  recurringId?: string
  /** 定期收支生成的流水：本次应扣日 YYYY-MM-DD（去重键 = recurringId + recurringDue） */
  recurringDue?: string
  createdAt: string
  updatedAt: string
}

export interface CategoryRow {
  id: string
  name: string
  color: string
  kind: AccountingType | 'both'
  builtin: boolean
}

/**
 * 账户（= 支付方式）：微信 / 支付宝 / 银行卡 / 现金 + 自定义。
 * 当前余额 = initialBalance + 该账户累计收入 − 累计支出（推导，不落盘；见渲染层 computeAccountBalances）。
 * 流水的 `payment` 字段即账户名。
 */
export interface AccountRow {
  id: string
  name: string
  color: string
  initialBalance: number
  builtin: boolean
}

const MOD = 'modules/accounting'
const TX_FILE = 'transactions.json'
const CAT_FILE = 'categories.json'
const ACCT_FILE = 'accounts.json'

const PALETTE = ['#e8842c', '#4f6ef2', '#c94f9a', '#3f8ad6', '#8a7f5c', '#9157d6', '#d0552f', '#c9922e', '#35975c', '#2b9e8f', '#c5a332', '#7a7a7a']

export const DEFAULT_CATEGORIES: CategoryRow[] = [
  { id: 'canyin', name: '餐饮', color: '#e8842c', kind: 'expense', builtin: true },
  { id: 'jiaotong', name: '交通', color: '#4f6ef2', kind: 'expense', builtin: true },
  { id: 'gouwu', name: '购物', color: '#c94f9a', kind: 'expense', builtin: true },
  { id: 'xuexi', name: '学习', color: '#3f8ad6', kind: 'expense', builtin: true },
  { id: 'juzhu', name: '居住', color: '#8a7f5c', kind: 'expense', builtin: true },
  { id: 'yule', name: '娱乐', color: '#9157d6', kind: 'expense', builtin: true },
  { id: 'yiliao', name: '医疗', color: '#d0552f', kind: 'expense', builtin: true },
  { id: 'renqing', name: '人情', color: '#c9922e', kind: 'expense', builtin: true },
  { id: 'shenghuofei', name: '生活费', color: '#35975c', kind: 'income', builtin: true },
  { id: 'gongzi', name: '工资', color: '#2b9e8f', kind: 'income', builtin: true },
  { id: 'jiangjin', name: '奖金', color: '#c5a332', kind: 'income', builtin: true },
  { id: 'qita', name: '其他', color: '#7a7a7a', kind: 'both', builtin: true },
]

export const DEFAULT_ACCOUNTS: AccountRow[] = [
  { id: 'acct-wechat', name: '微信', color: '#3fae6a', initialBalance: 0, builtin: true },
  { id: 'acct-alipay', name: '支付宝', color: '#2b8fd6', initialBalance: 0, builtin: true },
  { id: 'acct-bank', name: '银行卡', color: '#c9922e', initialBalance: 0, builtin: true },
  { id: 'acct-cash', name: '现金', color: '#8a7f5c', initialBalance: 0, builtin: true },
]

// ===== 低层存取 =====


export function vaultAccountingTransactionsAll(): TransactionRow[] {
  const rows = readJson<unknown>(MOD, TX_FILE, [])
  return Array.isArray(rows) ? (rows as TransactionRow[]) : []
}

export function vaultAccountingTransactionsSave(rows: TransactionRow[]): void {
  // 必须落盘：写失败抛错，避免 AI 写工具把失败当成功上报
  writeJsonOrThrow(MOD, TX_FILE, rows)
}

/** 分类读：文件缺失/空 → 内置默认（不改盘）；一旦有自定义写入才落盘 */
export function vaultAccountingCategoriesAll(): CategoryRow[] {
  const rows = readJson<unknown>(MOD, CAT_FILE, [])
  if (!Array.isArray(rows) || rows.length === 0) return DEFAULT_CATEGORIES.slice()
  return rows as CategoryRow[]
}

function saveCategories(rows: CategoryRow[]): void {
  writeJsonOrThrow(MOD, CAT_FILE, rows)
}

function colorForName(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

/**
 * 分类「解析或创建」命名桥：写路径专用。存在则返回原名，不存在则新建并落盘。
 * 查询工具**不得**调用本函数（避免只读查询产生副作用）。
 */
export function vaultAccountingResolveOrCreateCategory(rawName: string, kind: AccountingType): string {
  const name = String(rawName || '').trim()
  if (!name) return '其他'
  const cats = vaultAccountingCategoriesAll()
  const hit = cats.find((c) => c.name === name)
  if (hit) return hit.name
  const next: CategoryRow = { id: randomUUID(), name, color: colorForName(name), kind, builtin: false }
  saveCategories([...cats, next])
  return name
}

// ===== 账户（支付方式） =====

/** 账户读：文件缺失/空 → 内置默认（不改盘）；一旦有自定义/余额写入才落盘 */
export function vaultAccountingAccountsAll(): AccountRow[] {
  const rows = readJson<unknown>(MOD, ACCT_FILE, [])
  if (!Array.isArray(rows) || rows.length === 0) return DEFAULT_ACCOUNTS.slice()
  return rows as AccountRow[]
}

function saveAccounts(rows: AccountRow[]): void {
  writeJsonOrThrow(MOD, ACCT_FILE, rows)
}

/** 账户「解析或创建」命名桥：写路径专用（空名返回 ''，不建账户） */
export function vaultAccountingResolveOrCreateAccount(rawName: string): string {
  const name = String(rawName || '').trim()
  if (!name) return ''
  const accts = vaultAccountingAccountsAll()
  if (accts.some((a) => a.name === name)) return name
  saveAccounts([...accts, { id: randomUUID(), name, color: colorForName(name), initialBalance: 0, builtin: false }])
  return name
}

/** 设置账户初始余额（当前余额 = 初始余额 + 累计收支，推导） */
export function vaultAccountingSetAccountBalance(id: string, initialBalance: number): AccountRow | null {
  const value = Number(initialBalance)
  if (!Number.isFinite(value)) throw new Error('余额必须是数字')
  const accts = vaultAccountingAccountsAll()
  const idx = accts.findIndex((a) => a.id === id)
  if (idx < 0) return null
  accts[idx] = { ...accts[idx], initialBalance: Math.round(value * 100) / 100 }
  saveAccounts(accts)
  return accts[idx]
}

/** 新建自定义账户 */
export function vaultAccountingCreateAccount(rawName: string, initialBalance = 0): AccountRow {
  const name = String(rawName || '').trim()
  if (!name) throw new Error('账户名不能为空')
  const accts = vaultAccountingAccountsAll()
  if (accts.some((a) => a.name === name)) throw new Error('该账户已存在')
  const bal = Number(initialBalance)
  const row: AccountRow = {
    id: randomUUID(), name, color: colorForName(name),
    initialBalance: Number.isFinite(bal) ? Math.round(bal * 100) / 100 : 0, builtin: false,
  }
  saveAccounts([...accts, row])
  return row
}

// ===== 通用小工具 =====

function pad(n: number): string { return String(n).padStart(2, '0') }

export function todayLocal(): string {
  const n = new Date()
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`
}

function normalizeAmount(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return NaN
  return Math.round(Math.abs(n) * 100) / 100
}

function fingerprint(t: { date: string; type: AccountingTxType; amount: number; merchant: string; note: string }): string {
  return [t.date, t.type, Number(t.amount).toFixed(2), t.merchant || '', t.note || ''].join('|')
}

// ===== 解析 / 导入（AI 工具与渲染层共用同一实现） =====

export interface ParsedItem {
  invalid: boolean
  reason?: string
  dup: boolean
  date: string
  time: string
  type: AccountingTxType
  amount: number
  category: string
  payment: string
  toPayment?: string
  merchant: string
  note: string
}

export interface ParseOutcome {
  error?: string
  items: ParsedItem[]
  /** 可导入条数（去重后） */
  ok: number
  dup: number
  bad: number
}

/** 解析手机 AI 输出的 JSON（纯函数 + 与当前已有流水做去重标记，不写盘） */
export function vaultAccountingParseJson(text: string): ParseOutcome {
  let obj: unknown
  try { obj = JSON.parse(String(text || '')) } catch (err) {
    return { error: `JSON 解析失败：${(err as Error)?.message ?? err}`, items: [], ok: 0, dup: 0, bad: 0 }
  }
  const raw = obj as Record<string, unknown> | unknown[]
  const arr = Array.isArray(raw) ? raw : (raw && Array.isArray((raw as Record<string, unknown>).transactions) ? (raw as Record<string, unknown>).transactions as unknown[] : null)
  if (!arr) return { error: '没有找到 transactions 数组', items: [], ok: 0, dup: 0, bad: 0 }
  if (arr.length === 0) return { error: 'transactions 是空的', items: [], ok: 0, dup: 0, bad: 0 }

  const existing = new Set(vaultAccountingTransactionsAll().map((t) => fingerprint(t)))
  const seen = new Set<string>()
  const items: ParsedItem[] = []
  let ok = 0, dup = 0, bad = 0
  arr.forEach((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>
    const amount = normalizeAmount(o.amount)
    const type: AccountingTxType | null = o.type === 'income' ? 'income' : o.type === 'expense' ? 'expense' : o.type === 'transfer' ? 'transfer' : null
    const toPaymentRaw = String(o.toPayment ?? o.to ?? '').trim()
    if (!Number.isFinite(amount) || amount <= 0 || !type || (type === 'transfer' && !toPaymentRaw)) {
      const reason = type === 'transfer' && !toPaymentRaw ? `第 ${i + 1} 条转账缺转入账户` : `第 ${i + 1} 条缺 amount 或 type`
      items.push({ invalid: true, reason, dup: false, date: '', time: '', type: 'expense', amount: 0, category: '', payment: '', merchant: '', note: '' })
      bad++
      return
    }
    const dateRaw = typeof o.date === 'string' ? o.date : ''
    const date = /^\d{4}-\d{2}-\d{2}/.test(dateRaw) ? dateRaw.slice(0, 10) : todayLocal()
    const timeRaw = typeof o.time === 'string' ? o.time : ''
    const item: ParsedItem = {
      invalid: false, dup: false, date,
      time: /^\d{1,2}:\d{2}/.test(timeRaw) ? timeRaw.slice(0, 5) : '',
      type,
      amount,
      category: type === 'transfer' ? '' : (String(o.category ?? '').trim() || '其他'),
      payment: String(o.payment ?? '').trim(),
      toPayment: type === 'transfer' ? toPaymentRaw : undefined,
      merchant: String(o.merchant ?? '').trim(),
      note: String(o.note ?? '').trim(),
    }
    const fp = fingerprint(item)
    if (existing.has(fp) || seen.has(fp)) { item.dup = true; dup++ } else { seen.add(fp); ok++ }
    items.push(item)
  })
  return { items, ok, dup, bad }
}

export interface ImportOutcome { error?: string; added: number; skipped: number; invalid: number }

/** 导入（写盘）：仅写入既非无效、也非重复的条目；新分类自动建 */
export function vaultAccountingImport(text: string, source = 'phone-json'): ImportOutcome {
  const parsed = vaultAccountingParseJson(text)
  if (parsed.error) return { error: parsed.error, added: 0, skipped: 0, invalid: 0 }
  const now = new Date().toISOString()
  const rows = vaultAccountingTransactionsAll()
  const added: TransactionRow[] = []
  let skipped = 0, invalid = 0
  for (const it of parsed.items) {
    if (it.invalid) { invalid++; continue }
    if (it.dup) { skipped++; continue }
    added.push({
      id: randomUUID(),       date: it.date, time: it.time, type: it.type, amount: it.amount,
      category: it.type === 'transfer' ? '' : vaultAccountingResolveOrCreateCategory(it.category, it.type),
      payment: vaultAccountingResolveOrCreateAccount(it.payment),
      toPayment: it.type === 'transfer' ? vaultAccountingResolveOrCreateAccount(it.toPayment || '') : undefined,
      merchant: it.merchant, note: it.note,
      source, createdAt: now, updatedAt: now,
    })
  }
  if (added.length > 0) vaultAccountingTransactionsSave([...rows, ...added])
  return { added: added.length, skipped, invalid }
}

// ===== 单条增删改（渲染层表单 / AI） =====

export interface CreateTransactionInput {
  date?: string
  time?: string
  type: AccountingTxType
  amount: number
  category?: string
  payment?: string
  /** 转账专用：转入账户 */
  toPayment?: string
  merchant?: string
  note?: string
  source?: string
}

export function vaultAccountingCreate(input: CreateTransactionInput): TransactionRow {
  const amount = normalizeAmount(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('金额必须大于 0')
  if (input.type !== 'expense' && input.type !== 'income' && input.type !== 'transfer') throw new Error('type 必须是 expense / income / transfer')
  const now = new Date().toISOString()
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date)) ? String(input.date) : todayLocal()
  const isTransfer = input.type === 'transfer'
  const payment = vaultAccountingResolveOrCreateAccount(input.payment || '')
  const toPayment = isTransfer ? vaultAccountingResolveOrCreateAccount(input.toPayment || '') : ''
  if (isTransfer && (!payment || !toPayment)) throw new Error('转账需要转出与转入账户')
  if (isTransfer && payment === toPayment) throw new Error('转出与转入账户不能相同')
  const row: TransactionRow = {
    id: randomUUID(), date, time: input.time || '', type: input.type, amount,
    category: input.type === 'transfer' ? '' : vaultAccountingResolveOrCreateCategory(input.category || '其他', input.type),
    payment, toPayment: isTransfer ? toPayment : undefined,
    merchant: input.merchant || '', note: input.note || '',
    source: input.source || 'manual', createdAt: now, updatedAt: now,
  }
  vaultAccountingTransactionsSave([...vaultAccountingTransactionsAll(), row])
  return row
}

export function vaultAccountingUpdate(id: string, patch: Partial<TransactionRow>): TransactionRow | null {
  const rows = vaultAccountingTransactionsAll()
  const idx = rows.findIndex((r) => r.id === id)
  if (idx < 0) return null
  const cur = rows[idx]
  const next: TransactionRow = { ...cur }
  if (typeof patch.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(patch.date)) next.date = patch.date
  if (typeof patch.time === 'string') next.time = patch.time
  if (patch.type === 'expense' || patch.type === 'income' || patch.type === 'transfer') next.type = patch.type
  if (patch.amount !== undefined) {
    const a = normalizeAmount(patch.amount)
    if (!Number.isFinite(a) || a <= 0) throw new Error('金额必须大于 0')
    next.amount = a
  }
  if (next.type === 'transfer') {
    if (typeof patch.payment === 'string') next.payment = vaultAccountingResolveOrCreateAccount(patch.payment)
    if (typeof patch.toPayment === 'string') next.toPayment = vaultAccountingResolveOrCreateAccount(patch.toPayment)
    next.category = ''
    if (!next.payment || !next.toPayment) throw new Error('转账需要转出与转入账户')
    if (next.payment === next.toPayment) throw new Error('转出与转入账户不能相同')
  } else {
    const kind: AccountingType = next.type === 'income' ? 'income' : 'expense'
    if (typeof patch.category === 'string') next.category = vaultAccountingResolveOrCreateCategory(patch.category, kind)
    if (typeof patch.payment === 'string') next.payment = vaultAccountingResolveOrCreateAccount(patch.payment)
    next.toPayment = undefined  // 非转账不留转入账户（类型从 transfer 切回收支时清掉）
  }
  if (typeof patch.merchant === 'string') next.merchant = patch.merchant
  if (typeof patch.note === 'string') next.note = patch.note
  next.updatedAt = new Date().toISOString()
  rows[idx] = next
  vaultAccountingTransactionsSave(rows)
  return next
}

export function vaultAccountingDelete(id: string): boolean {
  const rows = vaultAccountingTransactionsAll()
  const next = rows.filter((r) => r.id !== id)
  if (next.length === rows.length) return false
  vaultAccountingTransactionsSave(next)
  return true
}

// ===== 查询 / 统计 =====

export interface QueryInput { start?: string; end?: string; type?: AccountingTxType; category?: string }

export function vaultAccountingQuery(input: QueryInput = {}): {
  count: number
  totalIncome: number
  totalExpense: number
  items: TransactionRow[]
} {
  const { start, end, type, category } = input
  const items = vaultAccountingTransactionsAll().filter((t) =>
    (!start || t.date >= start) &&
    (!end || t.date <= end) &&
    (!type || t.type === type) &&
    (!category || t.category === category),
  ).sort((a, b) => (a.date === b.date ? (b.time || '').localeCompare(a.time || '') : b.date.localeCompare(a.date)))
  let totalIncome = 0, totalExpense = 0
  for (const t of items) { if (t.type === 'income') totalIncome += t.amount; else if (t.type === 'expense') totalExpense += t.amount }  // 转账不计收支
  return { count: items.length, totalIncome: Math.round(totalIncome * 100) / 100, totalExpense: Math.round(totalExpense * 100) / 100, items }
}

/**
 * 各账户当前余额（推导：initialBalance + 累计收入 − 累计支出 + 累计转入 − 累计转出）+ 总额。
 * 供 AI 工具读账；与渲染层 computeAccountBalances（src/lib/accountingPure.ts）同口径。
 * 转账（type='transfer'）在账户间移动：payment 转出、toPayment 转入，不计收支、不影响总额。
 */
export function vaultAccountingBalances(): {
  total: number
  accounts: Array<{ name: string; initialBalance: number; income: number; expense: number; balance: number }>
} {
  const accounts = vaultAccountingAccountsAll()
  type Acc = { income: number; expense: number; tIn: number; tOut: number }
  const byName = new Map<string, Acc>()
  const acc = (key: string): Acc => {
    const e = byName.get(key) ?? { income: 0, expense: 0, tIn: 0, tOut: 0 }
    byName.set(key, e)
    return e
  }
  for (const t of vaultAccountingTransactionsAll()) {
    if (t.type === 'income') acc(t.payment || '').income += t.amount
    else if (t.type === 'expense') acc(t.payment || '').expense += t.amount
    else if (t.type === 'transfer') { acc(t.payment || '').tOut += t.amount; acc(t.toPayment || '').tIn += t.amount }
  }
  const known = new Set(accounts.map((a) => a.name))
  const list = accounts.map((a) => {
    const e = byName.get(a.name) ?? { income: 0, expense: 0, tIn: 0, tOut: 0 }
    return {
      name: a.name, initialBalance: a.initialBalance,
      income: Math.round(e.income * 100) / 100, expense: Math.round(e.expense * 100) / 100,
      balance: Math.round((a.initialBalance + e.income - e.expense + e.tIn - e.tOut) * 100) / 100,
    }
  })
  let looseIncome = 0, looseExpense = 0, looseIn = 0, looseOut = 0
  for (const [k, e] of byName) { if (k && known.has(k)) continue; looseIncome += e.income; looseExpense += e.expense; looseIn += e.tIn; looseOut += e.tOut }
  if (looseIncome || looseExpense || looseIn || looseOut) {
    list.push({ name: '未指定', initialBalance: 0, income: Math.round(looseIncome * 100) / 100, expense: Math.round(looseExpense * 100) / 100, balance: Math.round((looseIncome - looseExpense + looseIn - looseOut) * 100) / 100 })
  }
  const total = Math.round(list.reduce((a, b) => a + b.balance, 0) * 100) / 100
  return { total, accounts: list }
}

/** 区间收支（复盘统计块用） */
export function vaultAccountingPeriodStats(start: string, end: string): { income: number; expense: number } {
  let income = 0, expense = 0
  for (const t of vaultAccountingTransactionsAll()) {
    if (t.date < start || t.date > end) continue
    if (t.type === 'income') income += t.amount
    else if (t.type === 'expense') expense += t.amount  // 转账不计收支
  }
  return { income: Math.round(income * 100) / 100, expense: Math.round(expense * 100) / 100 }
}

// ===== 定期收支（recurring） =====
// 存储：.knowbase/modules/accounting/recurring.json；生成的流水 = 普通 TransactionRow + recurringId/recurringDue。
// 结算计划走零依赖纯函数 planRecurringSettle（src/lib/accountingPure.ts，渲染层/契约共用）。

const RECUR_FILE = 'recurring.json'

/** 定期收支规则（与渲染层 src/types AccountingRecurring 同形状，跨线各声明一次） */
export interface RecurringRow {
  id: string
  name: string
  type: AccountingType
  amount: number
  category: string
  payment: string
  merchant: string
  note: string
  /** monthly：每月 day 号；interval：每 intervalDays 天 */
  mode: 'monthly' | 'interval'
  day: number | null
  intervalDays: number | null
  /** 上次扣费日 YYYY-MM-DD（幂等去重 + 追赶起点） */
  lastPostedDate: string
  /** 到期日 YYYY-MM-DD（空 = 不过期） */
  endDate: string
  enabled: boolean
  autoPost: boolean
  createdAt: string
  updatedAt: string
}

export function vaultAccountingRecurringAll(): RecurringRow[] {
  const rows = readJson<unknown>(MOD, RECUR_FILE, [])
  return Array.isArray(rows) ? (rows as RecurringRow[]) : []
}

function saveRecurring(rows: RecurringRow[]): void {
  writeJsonOrThrow(MOD, RECUR_FILE, rows)
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, n))
}

function isDate(s: unknown): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)) }

export interface CreateRecurringInput {
  name: string
  type: AccountingType
  amount: number
  category?: string
  payment?: string
  merchant?: string
  note?: string
  mode: 'monthly' | 'interval'
  day?: number | null
  intervalDays?: number | null
  lastPostedDate: string
  endDate?: string
  enabled?: boolean
  autoPost?: boolean
}

export function vaultAccountingCreateRecurring(input: CreateRecurringInput): RecurringRow {
  const name = String(input.name || '').trim()
  if (!name) throw new Error('名称不能为空')
  const amount = normalizeAmount(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('金额必须大于 0')
  const type: AccountingType = input.type === 'income' ? 'income' : 'expense'
  const mode = input.mode === 'interval' ? 'interval' : 'monthly'
  const now = new Date().toISOString()
  const row: RecurringRow = {
    id: randomUUID(), name, type, amount,
    category: vaultAccountingResolveOrCreateCategory(input.category || '其他', type),
    payment: vaultAccountingResolveOrCreateAccount(input.payment || ''),
    merchant: String(input.merchant || '').trim(), note: String(input.note || '').trim(),
    mode,
    day: mode === 'monthly' ? clampInt(input.day, 1, 31, 1) : null,
    intervalDays: mode === 'interval' ? clampInt(input.intervalDays, 1, 3660, 30) : null,
    lastPostedDate: isDate(input.lastPostedDate) ? String(input.lastPostedDate) : todayLocal(),
    endDate: isDate(input.endDate) ? String(input.endDate) : '',
    enabled: input.enabled !== false, autoPost: input.autoPost !== false,
    createdAt: now, updatedAt: now,
  }
  saveRecurring([...vaultAccountingRecurringAll(), row])
  return row
}

export function vaultAccountingUpdateRecurring(id: string, patch: Partial<RecurringRow>): RecurringRow | null {
  const rows = vaultAccountingRecurringAll()
  const idx = rows.findIndex((r) => r.id === id)
  if (idx < 0) return null
  const cur = rows[idx]
  const next: RecurringRow = { ...cur }
  if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim()
  if (patch.type === 'expense' || patch.type === 'income') next.type = patch.type
  if (patch.amount !== undefined) {
    const a = normalizeAmount(patch.amount)
    if (!Number.isFinite(a) || a <= 0) throw new Error('金额必须大于 0')
    next.amount = a
  }
  const kind: AccountingType = next.type === 'income' ? 'income' : 'expense'
  if (typeof patch.category === 'string') next.category = vaultAccountingResolveOrCreateCategory(patch.category || '其他', kind)
  if (typeof patch.payment === 'string') next.payment = vaultAccountingResolveOrCreateAccount(patch.payment)
  if (typeof patch.merchant === 'string') next.merchant = patch.merchant.trim()
  if (typeof patch.note === 'string') next.note = patch.note.trim()
  if (patch.mode === 'monthly' || patch.mode === 'interval') next.mode = patch.mode
  if (next.mode === 'monthly') {
    if (patch.day !== undefined) next.day = clampInt(patch.day, 1, 31, 1)
    next.intervalDays = null
  } else {
    if (patch.intervalDays !== undefined) next.intervalDays = clampInt(patch.intervalDays, 1, 3660, 30)
    next.day = null
  }
  if (isDate(patch.lastPostedDate)) next.lastPostedDate = String(patch.lastPostedDate)
  if (typeof patch.endDate === 'string') next.endDate = isDate(patch.endDate) ? patch.endDate : ''
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
  if (typeof patch.autoPost === 'boolean') next.autoPost = patch.autoPost
  next.updatedAt = new Date().toISOString()
  rows[idx] = next
  saveRecurring(rows)
  return next
}

export function vaultAccountingDeleteRecurring(id: string): boolean {
  const rows = vaultAccountingRecurringAll()
  const next = rows.filter((r) => r.id !== id)
  if (next.length === rows.length) return false
  saveRecurring(next)
  return true
}

export interface RecurringSettleResult {
  added: number
  total: number
  items: Array<{ id: string; ruleId: string; name: string; amount: number; due: string }>
}

/** 结算（幂等，写盘）：把「应记但没记」的应扣日补成普通流水，并推进各规则 lastPostedDate */
export function vaultAccountingSettleRecurring(today = todayLocal()): RecurringSettleResult {
  const rules = vaultAccountingRecurringAll()
  const txs = vaultAccountingTransactionsAll()
  const plan = planRecurringSettle(rules, txs, today)
  if (plan.length === 0) return { added: 0, total: 0, items: [] }
  const now = new Date().toISOString()
  const ruleMap = new Map(rules.map((r) => [r.id, r]))
  const added: TransactionRow[] = []
  const items: RecurringSettleResult['items'] = []
  for (const p of plan) {
    const r = ruleMap.get(p.ruleId)
    if (!r) continue
    const tx: TransactionRow = {
      id: randomUUID(), date: p.due, time: '', type: r.type, amount: r.amount,
      category: vaultAccountingResolveOrCreateCategory(r.category || '其他', r.type),
      payment: vaultAccountingResolveOrCreateAccount(r.payment),
      merchant: r.merchant, note: r.note || '定期收支自动记入', source: 'recurring',
      recurringId: r.id, recurringDue: p.due, createdAt: now, updatedAt: now,
    }
    added.push(tx)
    items.push({ id: tx.id, ruleId: r.id, name: r.name, amount: r.amount, due: p.due })
  }
  if (added.length === 0) return { added: 0, total: 0, items: [] }
  vaultAccountingTransactionsSave([...txs, ...added])
  const nextRules = rules.map((r) => {
    const dues = plan.filter((p) => p.ruleId === r.id).map((p) => p.due).sort()
    if (dues.length === 0) return r
    return { ...r, lastPostedDate: dues[dues.length - 1], updatedAt: now }
  })
  saveRecurring(nextRules)
  const total = Math.round(added.filter((t) => t.type === 'expense').reduce((a, b) => a + b.amount, 0) * 100) / 100
  return { added: added.length, total, items }
}

/** 手动记入当前周期（左栏「记入」按钮）：本月应扣日 / 下次应扣日，且必须 ≤ 今天 */
export function vaultAccountingPostRecurring(id: string, today = todayLocal()): { ok: boolean; error?: string; due?: string } {
  const rules = vaultAccountingRecurringAll()
  const r = rules.find((x) => x.id === id)
  if (!r) return { ok: false, error: '规则不存在' }
  const t = new Date(`${today}T00:00:00`)
  const due = r.mode === 'monthly' ? monthDue(t.getFullYear(), t.getMonth() + 1, r.day || 1) : recurringNextDue(r)
  if (due > today) return { ok: false, error: '还没到扣费日' }
  const txs = vaultAccountingTransactionsAll()
  if (txs.some((x) => x.recurringId === r.id && x.recurringDue === due)) return { ok: false, error: '该周期已记入' }
  const now = new Date().toISOString()
  const tx: TransactionRow = {
    id: randomUUID(), date: due, time: '', type: r.type, amount: r.amount,
    category: vaultAccountingResolveOrCreateCategory(r.category || '其他', r.type),
    payment: vaultAccountingResolveOrCreateAccount(r.payment),
    merchant: r.merchant, note: r.note || '定期收支手动记入', source: 'recurring',
    recurringId: r.id, recurringDue: due, createdAt: now, updatedAt: now,
  }
  vaultAccountingTransactionsSave([...txs, tx])
  if (due > r.lastPostedDate) saveRecurring(rules.map((x) => (x.id === r.id ? { ...x, lastPostedDate: due, updatedAt: now } : x)))
  return { ok: true, due }
}
