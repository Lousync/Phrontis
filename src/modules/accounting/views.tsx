import { useMemo, useState } from 'react'
import { Pencil, Trash2, CalendarDays, BarChart3, NotebookPen, Eye, EyeOff, Plus } from 'lucide-react'
import type { AccountingTransaction, AccountingCategory, AccountingAccount } from '../../types'
import { accountingSetAccountBalance, accountingCreateAccount } from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { catColor, dayLabel, money, monthLabel, sumAmount, todayStr, computeAccountBalances } from './shared'
import { monthRangeOf, weekRangeOf, yearRangeOf } from '../../lib/summary'

/**
 * 记账中央三视图：流水 / 统计 / 复盘。
 * 纯展示 + 回调；数据与筛选状态由模块根（index.tsx）持有。
 */

// ==================== 流水 ====================
export function FlowView({ transactions, categories, onEdit, onDelete }: {
  transactions: AccountingTransaction[]
  categories: AccountingCategory[]
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}) {
  if (transactions.length === 0) {
    return (
      <div className="kb-view-in flex flex-col items-center justify-center gap-2 py-24 text-[13px] text-[var(--text-muted)]">
        <p>本月还没有记账</p>
        <p className="text-[12px]">在右侧「记账」面板记一笔，或把手机 AI 的 JSON 粘给 AI 助手</p>
      </div>
    )
  }
  const out = sumAmount(transactions, 'expense')
  const inc = sumAmount(transactions, 'income')
  const byDay = new Map<string, AccountingTransaction[]>()
  for (const t of transactions) {
    const arr = byDay.get(t.date)
    if (arr) arr.push(t); else byDay.set(t.date, [t])
  }
  const days = [...byDay.keys()].sort((a, b) => b.localeCompare(a))

  return (
    <div className="kb-view-in mx-auto w-full max-w-[820px] px-6 py-4">
      <div className="mb-4 flex gap-2.5">
        <div className="flex-1 rounded-[10px] border border-[var(--border-color)] bg-[var(--card-bg)] px-3.5 py-3">
          <div className="text-[11.5px] text-[var(--text-secondary)]">本月支出</div>
          <div className="mt-1 text-[20px] font-semibold tabular-nums text-[var(--money-out,#e06c4f)]">-{money(out).replace('¥', '')}</div>
        </div>
        <div className="flex-1 rounded-[10px] border border-[var(--border-color)] bg-[var(--card-bg)] px-3.5 py-3">
          <div className="text-[11.5px] text-[var(--text-secondary)]">本月收入</div>
          <div className="mt-1 text-[20px] font-semibold tabular-nums text-[var(--money-in,#2b9e8f)]">+{money(inc).replace('¥', '')}</div>
        </div>
        <div className="flex-1 rounded-[10px] border border-[var(--border-color)] bg-[var(--card-bg)] px-3.5 py-3">
          <div className="text-[11.5px] text-[var(--text-secondary)]">结余</div>
          <div className={'mt-1 text-[20px] font-semibold tabular-nums ' + (inc - out >= 0 ? 'text-[var(--money-in,#2b9e8f)]' : 'text-[var(--money-out,#e06c4f)]')}>{money(inc - out)}</div>
        </div>
      </div>

      {days.map((date) => {
        const rows = byDay.get(date)!
        const dOut = sumAmount(rows, 'expense')
        const dIn = sumAmount(rows, 'income')
        const lab = dayLabel(date)
        return (
          <div key={date}>
            <div className="mb-1.5 mt-4 flex items-baseline gap-2.5 px-0.5">
              <span className="text-[13px] font-semibold text-[var(--text-primary)]">{lab.d}</span>
              <span className="text-[11.5px] text-[var(--text-muted)]">{lab.w}</span>
              <span className="ml-auto text-[11.5px] tabular-nums text-[var(--text-muted)]">
                {dOut ? `支出 ${money(dOut)}` : ''}{dOut && dIn ? ' · ' : ''}{dIn ? `收入 ${money(dIn)}` : ''}
              </span>
            </div>
            {rows.map((t) => {
              const isOut = t.type === 'expense'
              return (
                <div key={t.id} className="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-[var(--bg-hover)]">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: catColor(categories, t.category) }} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-[var(--text-primary)]">{t.merchant || t.category || '未分类'}</div>
                    <div className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
                      {t.category || '未分类'}{t.note ? ` · ${t.note}` : ''}{t.time ? ` · ${t.time}` : ''}
                    </div>
                  </div>
                  {t.payment && <span className="shrink-0 rounded-[10px] border border-[var(--border-color)] px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)]">{t.payment}</span>}
                  <span className={'min-w-[84px] shrink-0 text-right text-[13.5px] font-semibold tabular-nums ' + (isOut ? 'text-[var(--money-out,#e06c4f)]' : 'text-[var(--money-in,#2b9e8f)]')}>
                    {isOut ? '-' : '+'}{money(t.amount).replace('¥', '')}
                  </span>
                  <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <button onClick={() => onEdit(t.id)} title="编辑" className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"><Pencil size={14} /></button>
                    <button onClick={() => onDelete(t.id)} title="删除" className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--danger)]"><Trash2 size={14} /></button>
                  </span>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

// ==================== 账户余额块（统计页用；默认打码，眼睛显示） ====================
function AccountsBalanceBlock({ accounts, transactions, balanceVisible, onToggleBalance }: {
  accounts: AccountingAccount[]
  transactions: AccountingTransaction[]
  balanceVisible: boolean
  onToggleBalance: () => void
}) {
  const { list, total } = computeAccountBalances(accounts, transactions)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newBal, setNewBal] = useState('')

  const saveInitial = async (id: string, raw: string): Promise<void> => {
    const v = Number(raw)
    if (!Number.isFinite(v)) return
    try { await accountingSetAccountBalance(id, v) } catch (e) { showToast({ type: 'error', message: '余额保存失败', detail: String(e) }) }
  }
  const addAccount = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) return
    try {
      await accountingCreateAccount(name, Number(newBal) || 0)
      setNewName(''); setNewBal(''); setAdding(false)
      showToast({ type: 'success', message: `已添加账户「${name}」` })
    } catch (e) { showToast({ type: 'error', message: '添加失败', detail: String(e) }) }
  }

  return (
    <div className="mt-8">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">账户余额</h3>
        <button onClick={onToggleBalance} title={balanceVisible ? '隐藏余额' : '显示余额'} className="rounded p-0.5 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]">
          {balanceVisible ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
        <span className="ml-auto text-[12px] tabular-nums text-[var(--text-secondary)]">总额 {balanceVisible ? money(total) : '••••••'}</span>
      </div>

      <div className="divide-y divide-[var(--border-color)] border-y border-[var(--border-color)]">
        {list.map((a) => (
          <div key={a.id} className="flex items-center gap-2.5 py-2.5">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: a.color }} />
            <span className="w-14 shrink-0 truncate text-[13px] text-[var(--text-primary)]">{a.name}</span>
            {a.loose ? (
              <span className="flex-1 text-[11px] text-[var(--text-muted)]">未选支付方式的流水</span>
            ) : balanceVisible ? (
              <label className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                初始
                <input
                  type="number" step="0.01" defaultValue={a.initialBalance}
                  onBlur={(e) => { if (e.target.value !== String(a.initialBalance)) void saveInitial(a.id, e.target.value) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                  className="h-6 w-24 rounded border border-[var(--border-color)] bg-[var(--input-bg)] px-1.5 text-[11.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
              </label>
            ) : (
              <span className="flex-1 text-[11px] text-[var(--text-muted)]">初始 ••••</span>
            )}
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">收 {balanceVisible ? money(a.income) : '••••'} · 支 {balanceVisible ? money(a.expense) : '••••'}</span>
            <span className={'w-24 shrink-0 text-right text-[13.5px] font-semibold tabular-nums ' + (a.balance >= 0 ? 'text-[var(--money-in,#2b9e8f)]' : 'text-[var(--money-out,#e06c4f)]')}>
              {balanceVisible ? money(a.balance) : '••••••'}
            </span>
          </div>
        ))}
      </div>

      {adding ? (
        <div className="mt-2.5 flex items-center gap-2">
          <input
            autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="账户名，如 校园卡"
            className="h-7 w-32 rounded border border-[var(--border-color)] bg-[var(--input-bg)] px-2 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          {balanceVisible && (
            <input
              type="number" step="0.01" value={newBal} onChange={(e) => setNewBal(e.target.value)} placeholder="初始余额"
              className="h-7 w-24 rounded border border-[var(--border-color)] bg-[var(--input-bg)] px-2 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          )}
          <button onClick={() => { void addAccount() }} className="h-7 rounded bg-[var(--accent)] px-2.5 text-[12px] text-white transition-colors hover:bg-[var(--accent-hover)]">添加</button>
          <button onClick={() => { setAdding(false); setNewName(''); setNewBal('') }} className="h-7 rounded px-2 text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]">取消</button>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="mt-2.5 flex items-center gap-1 text-[12px] text-[var(--accent)] hover:underline"><Plus size={12} /> 添加账户</button>
      )}
    </div>
  )
}

// ==================== 统计 ====================
export function StatsView({ transactions, categories, accounts, month, balanceVisible, onToggleBalance }: {
  transactions: AccountingTransaction[]
  categories: AccountingCategory[]
  accounts: AccountingAccount[]
  month: string
  balanceVisible: boolean
  onToggleBalance: () => void
}) {
  const monthList = transactions.filter((t) => t.date.slice(0, 7) === month)
  const out = sumAmount(monthList, 'expense')
  const inc = sumAmount(monthList, 'income')
  const daysWithOut = new Set(monthList.filter((t) => t.type === 'expense').map((t) => t.date)).size || 1
  const byCat = new Map<string, number>()
  for (const t of monthList) if (t.type === 'expense') byCat.set(t.category, (byCat.get(t.category) ?? 0) + t.amount)
  const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1])
  const maxCat = cats.length ? cats[0][1] : 1

  // 近 6 月趋势（需要全量流水，调用方已传全量）
  const months: string[] = []
  const [by, bm] = month.split('-').map(Number)
  for (let i = 5; i >= 0; i--) {
    const d = new Date(by, bm - 1 - i, 1)
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  const trend = months.map((m) => {
    const list = transactions.filter((t) => t.date.slice(0, 7) === m)
    return { m, out: sumAmount(list, 'expense'), inc: sumAmount(list, 'income') }
  })
  const maxv = Math.max(1, ...trend.map((d) => Math.max(d.out, d.inc)))

  return (
    <div className="kb-view-in mx-auto w-full max-w-[860px] px-6 py-4">
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-[10px] border border-[var(--border-color)] bg-[var(--card-bg)] px-4 py-3.5">
          <div className="text-[11.5px] text-[var(--text-secondary)]">本月支出</div>
          <div className="mt-1.5 text-[24px] font-bold tabular-nums text-[var(--money-out,#e06c4f)]">{money(out)}</div>
          <div className="mt-1 text-[11px] text-[var(--text-muted)]">日均 {money(out / daysWithOut)}</div>
        </div>
        <div className="rounded-[10px] border border-[var(--border-color)] bg-[var(--card-bg)] px-4 py-3.5">
          <div className="text-[11.5px] text-[var(--text-secondary)]">本月收入</div>
          <div className="mt-1.5 text-[24px] font-bold tabular-nums text-[var(--money-in,#2b9e8f)]">{money(inc)}</div>
          <div className="mt-1 text-[11px] text-[var(--text-muted)]">{monthList.filter((t) => t.type === 'income').length} 笔</div>
        </div>
        <div className="rounded-[10px] border border-[var(--border-color)] bg-[var(--card-bg)] px-4 py-3.5">
          <div className="text-[11.5px] text-[var(--text-secondary)]">结余</div>
          <div className={'mt-1.5 text-[24px] font-bold tabular-nums ' + (inc - out >= 0 ? 'text-[var(--money-in,#2b9e8f)]' : 'text-[var(--money-out,#e06c4f)]')}>{money(inc - out)}</div>
          <div className="mt-1 text-[11px] text-[var(--text-muted)]">结余率 {inc ? Math.round((inc - out) / inc * 100) : 0}%</div>
        </div>
      </div>

      <AccountsBalanceBlock
        accounts={accounts}
        transactions={transactions}
        balanceVisible={balanceVisible}
        onToggleBalance={onToggleBalance}
      />

      <h3 className="mb-3 mt-6 text-[14px] font-semibold text-[var(--text-primary)]">支出分类占比</h3>
      {cats.length === 0 && <div className="text-[12px] text-[var(--text-muted)]">本月还没有支出</div>}
      {cats.map(([name, amt]) => (
        <div key={name} className="flex items-center gap-2.5 py-1.5">
          <span className="w-16 shrink-0 text-[12.5px] text-[var(--text-secondary)]">{name}</span>
          <span className="h-2.5 flex-1 overflow-hidden rounded-[5px] bg-[var(--bg-tertiary)]">
            <span className="block h-full rounded-[5px]" style={{ width: `${Math.round(amt / maxCat * 100)}%`, background: catColor(categories, name) }} />
          </span>
          <span className="w-24 shrink-0 text-right text-[12px] tabular-nums text-[var(--text-secondary)]"><b className="font-semibold text-[var(--text-primary)]">{money(amt)}</b> · {Math.round(amt / out * 100)}%</span>
        </div>
      ))}

      <h3 className="mb-3 mt-6 text-[14px] font-semibold text-[var(--text-primary)]">近 6 月收支</h3>
      <div className="flex h-[180px] items-end gap-4 px-1 pt-2">
        {trend.map((d) => (
          <div key={d.m} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
            <div className="flex h-full w-full items-end justify-center gap-1">
              <div className="w-4 rounded-t" style={{ height: `${Math.round(d.out / maxv * 100)}%`, background: 'var(--money-out,#e06c4f)' }} title={`支出 ${money(d.out)}`} />
              <div className="w-4 rounded-t" style={{ height: `${Math.round(d.inc / maxv * 100)}%`, background: 'var(--money-in,#2b9e8f)' }} title={`收入 ${money(d.inc)}`} />
            </div>
            <div className="text-[11px] text-[var(--text-muted)]">{Number(d.m.slice(5))}月</div>
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex gap-4 text-[11.5px] text-[var(--text-secondary)]">
        <span><i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: 'var(--money-out,#e06c4f)' }} />支出</span>
        <span><i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: 'var(--money-in,#2b9e8f)' }} />收入</span>
      </div>
    </div>
  )
}

// ==================== 复盘（跳博客总结） ====================
export function ReviewView({ transactions, month }: { transactions: AccountingTransaction[]; month: string }) {
  const [y] = month.split('-').map(Number)
  const windows = useMemo(() => {
    const w = weekRangeOf(todayStr())
    const mo = monthRangeOf(y, Number(month.slice(5)))
    const yr = yearRangeOf(y)
    return [
      { kind: 'week' as const, label: '周总结', start: w.start, end: w.end },
      { kind: 'month' as const, label: '月总结', start: mo.start, end: mo.end },
      { kind: 'year' as const, label: '年度总结', start: yr.start, end: yr.end },
    ]
  }, [y, month])

  const list = transactions.filter((t) => t.date.slice(0, 7) === month)
  const out = sumAmount(list, 'expense')
  const inc = sumAmount(list, 'income')

  const open = (kind: string, start: string, end: string) => {
    window.dispatchEvent(new CustomEvent('blog-open-summary', { detail: { kind, start, end } }))
  }

  return (
    <div className="kb-view-in mx-auto w-full max-w-[720px] px-6 py-5">
      <h2 className="text-[22px] font-bold text-[var(--text-primary)]">{monthLabel(month)} · 复盘</h2>

      <div className="mt-4 flex gap-2.5">
        <div className="flex-1 rounded-[10px] border border-[var(--border-color)] bg-[var(--card-bg)] px-3.5 py-3">
          <div className="text-[11.5px] text-[var(--text-secondary)]">本月支出</div>
          <div className="mt-1 text-[20px] font-semibold tabular-nums text-[var(--money-out,#e06c4f)]">{money(out)}</div>
        </div>
        <div className="flex-1 rounded-[10px] border border-[var(--border-color)] bg-[var(--card-bg)] px-3.5 py-3">
          <div className="text-[11.5px] text-[var(--text-secondary)]">本月收入</div>
          <div className="mt-1 text-[20px] font-semibold tabular-nums text-[var(--money-in,#2b9e8f)]">{money(inc)}</div>
        </div>
      </div>

      <div className="mt-6 border-y border-[var(--border-color)] divide-y divide-[var(--border-color)]">
        {windows.map((w) => {
          const Icon = w.kind === 'week' ? CalendarDays : w.kind === 'month' ? BarChart3 : NotebookPen
          return (
            <div key={w.kind} className="flex items-center gap-3 py-3 text-[14px]">
              <Icon size={15} className="shrink-0 text-[var(--text-muted)]" />
              <span className="text-[var(--text-secondary)]">{w.label}</span>
              <span className="text-[11.5px] tabular-nums text-[var(--text-muted)]">{w.start} ~ {w.end}</span>
              <button
                onClick={() => open(w.kind, w.start, w.end)}
                className="ml-auto shrink-0 rounded border border-[var(--border-color)] px-2.5 py-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                打开总结
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
