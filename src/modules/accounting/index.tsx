import { useMemo, useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ReceiptText, BarChart3, NotebookPen, ListOrdered, CalendarDays, Eye, EyeOff, Plus } from 'lucide-react'
import type { AccountingTransaction } from '../../types'
import { accountingDelete } from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { FlowView, StatsView, ReviewView } from './views'
import { useAccountingData, monthLabel, money, sumAmount, catColor, todayStr, computeAccountBalances, requestEditTransaction, requestNewTransaction, type AccountingView } from './shared'

/**
 * 记账模块（工作台内 Tab）。
 *
 * 形态同笔记 / 日程：中央三视图（流水 / 统计 / 复盘）+ 左栏模块侧栏（月份 / 分类）portal 进 wbModSlotEl。
 * 录入与 JSON 导入在**右栏「记账」面板**（AccountingPanel），AI 录账走现成 AI 助手。
 * 复盘复用博客总结（ReviewView 派发 blog-open-summary）。
 */

interface Props {
  isActive?: boolean
  sidebarEl?: HTMLElement | null
  sidebarHosted?: boolean
}

const VIEW_BTN: Array<{ id: AccountingView; label: string; Icon: typeof ListOrdered }> = [
  { id: 'flow', label: '流水', Icon: ListOrdered },
  { id: 'stats', label: '统计', Icon: BarChart3 },
  { id: 'review', label: '复盘', Icon: NotebookPen },
]

/** 窄态阈值（px）：容器实测宽度低于此值时，工具条文字收起、只留图标 */
const NARROW_TOOLBAR_PX = 640

/** 用 ResizeObserver 量容器实宽（窗口缩窄 / 左右栏展开都算），返回是否进入窄态 */
function useNarrow(ref: { current: HTMLElement | null }, threshold: number): boolean {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth
      setNarrow(w < threshold)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, threshold])
  return narrow
}

export function AccountingModule({ isActive = true, sidebarEl = null, sidebarHosted = false }: Props) {
  const { transactions, categories, accounts, reload } = useAccountingData()
  const [view, setView] = useState<AccountingView>('flow')
  const [month, setMonth] = useState<string>(() => todayStr().slice(0, 7))
  const [typeFilter, setTypeFilter] = useState<'all' | 'expense' | 'income'>('all')
  const [catFilter, setCatFilter] = useState<string | null>(null)
  // 余额隐私：默认不可见（每次启动重置），眼睛按钮才显示
  const [balanceVisible, setBalanceVisible] = useState(false)
  const monthInitRef = useRef(false)

  const balances = useMemo(() => computeAccountBalances(accounts, transactions), [accounts, transactions])
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const narrow = useNarrow(toolbarRef, NARROW_TOOLBAR_PX)

  // 月份初值：当前月；若当前月无流水且有历史，落最近有数据的月份（只初始化一次，不覆盖用户选择）
  useEffect(() => {
    if (monthInitRef.current || transactions.length === 0) return
    monthInitRef.current = true
    const cur = todayStr().slice(0, 7)
    if (transactions.some((t) => t.date.slice(0, 7) === cur)) { setMonth(cur); return }
    const latest = transactions.map((t) => t.date.slice(0, 7)).sort().reverse()[0]
    setMonth(latest || cur)
  }, [transactions])

  const allMonths = useMemo(() => {
    const set = new Set<string>(transactions.map((t) => t.date.slice(0, 7)))
    set.add(todayStr().slice(0, 7))
    return [...set].sort((a, b) => b.localeCompare(a))
  }, [transactions])

  const monthTx = useMemo(() => transactions.filter((t) => t.date.slice(0, 7) === month), [transactions, month])
  const filtered = useMemo(() => monthTx
    .filter((t) => typeFilter === 'all' || t.type === typeFilter)
    .filter((t) => !catFilter || t.category === catFilter)
    .sort((a, b) => (a.date === b.date ? (b.time || '').localeCompare(a.time || '') : b.date.localeCompare(a.date))), [monthTx, typeFilter, catFilter])

  const catCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of monthTx) m.set(t.category, (m.get(t.category) ?? 0) + 1)
    return m
  }, [monthTx])

  const handleDelete = async (id: string): Promise<void> => {
    try {
      const ok = await accountingDelete(id)
      if (ok) { showToast({ type: 'info', message: '已删除这一笔' }); await reload() }
    } catch (e) { showToast({ type: 'error', message: '删除失败', detail: String(e) }) }
  }

  const sidebarInner = (
    <div className="flex h-full flex-col overflow-y-auto px-2 pb-3">
      <div className="flex items-center gap-1.5 px-1 py-2 text-[11.5px] font-semibold text-[var(--text-secondary)]">
        <ReceiptText size={12} className="text-[var(--text-muted)]" /> 记账
      </div>

      <div className="mt-1 flex items-center gap-1 px-2 text-[11px] uppercase tracking-wide text-[var(--text-muted)]"><CalendarDays size={12} /> 月份</div>
      <div className="mt-1 flex flex-col gap-0.5">
        {allMonths.map((m) => {
          const out = sumAmount(transactions.filter((t) => t.date.slice(0, 7) === m), 'expense')
          const active = m === month
          return (
            <button
              key={m}
              onClick={() => { setMonth(m); setCatFilter(null) }}
              className={'flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors ' + (active ? 'bg-[var(--bg-hover)] font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}
            >
              <span>{monthLabel(m)}</span>
              <span className="text-[11px] tabular-nums text-[var(--text-muted)]">-{money(out).replace('¥', '')}</span>
            </button>
          )
        })}
      </div>

      <div className="mt-3 px-2 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">分类</div>
      <div className="mt-1 flex flex-col gap-0.5">
        {[...catCounts.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => (
          <button
            key={name}
            onClick={() => setCatFilter((c) => c === name ? null : name)}
            className={'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors ' + (catFilter === name ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}
          >
            <span className="h-2 w-2 rounded-full" style={{ background: catColor(categories, name) }} />
            <span className="flex-1 truncate">{name}</span>
            <span className="text-[11px] tabular-nums text-[var(--text-muted)]">{n}</span>
          </button>
        ))}
        {catCounts.size === 0 && <div className="px-2.5 py-1 text-[11.5px] text-[var(--text-muted)]">本月还没有分类数据</div>}
      </div>
    </div>
  )

  const sidebarNode = sidebarEl
    ? createPortal(sidebarInner, sidebarEl)
    : sidebarHosted
      ? null
      : <div className="w-[236px] shrink-0 border-r border-[var(--border-color)]">{sidebarInner}</div>

  return (
    <div className="kb-theme-surface flex h-full min-h-0">
      {sidebarNode}
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={toolbarRef} className="flex h-11 shrink-0 items-center gap-2 whitespace-nowrap border-b border-[var(--border-color)] px-3">
          <span className="shrink-0 text-[14px] font-semibold text-[var(--text-primary)]">记账</span>
          {!narrow && <span className="shrink-0 text-[11.5px] text-[var(--text-muted)]">{monthLabel(month)} · {filtered.length} 笔</span>}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* 总余额（默认打码，眼睛按钮显示；窄态整块省略） */}
            {!narrow && (
              <div className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-1">
                <span className="text-[11.5px] text-[var(--text-muted)]">总余额</span>
                <span className={'text-[12.5px] font-semibold tabular-nums ' + (balances.total >= 0 ? 'text-[var(--money-in,#2b9e8f)]' : 'text-[var(--money-out,#e06c4f)]')}>
                  {balanceVisible ? money(balances.total) : '••••••'}
                </span>
                <button
                  onClick={() => setBalanceVisible((v) => !v)}
                  title={balanceVisible ? '隐藏余额' : '显示余额'}
                  className="rounded p-0.5 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                >
                  {balanceVisible ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            )}
            <div className="inline-flex shrink-0 overflow-hidden rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)]">
              {VIEW_BTN.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  onClick={() => setView(id)}
                  title={label}
                  className={'flex h-7 shrink-0 items-center gap-1.5 text-[12px] transition-colors ' + (narrow ? 'px-2' : 'px-3') + ' ' + (view === id ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}
                >
                  <Icon size={14} />{!narrow && <span>{label}</span>}
                </button>
              ))}
            </div>
            <button
              onClick={() => requestNewTransaction()}
              title="记一笔"
              className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-[var(--accent)] bg-[var(--accent)] px-3 text-[12px] text-white transition-colors hover:bg-[var(--accent-hover)]"
            >
              <Plus size={14} />{!narrow && <span>记一笔</span>}
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" data-acc-active={isActive ? '1' : '0'}>
          {view === 'flow' && <FlowView transactions={filtered} categories={categories} onEdit={(id) => requestEditTransaction(id)} onDelete={(id) => { void handleDelete(id) }} />}
          {view === 'stats' && <StatsView transactions={transactions} categories={categories} accounts={accounts} month={month} balanceVisible={balanceVisible} onToggleBalance={() => setBalanceVisible((v) => !v)} />}
          {view === 'review' && <ReviewView transactions={transactions as AccountingTransaction[]} month={month} />}
        </div>
      </div>
    </div>
  )
}
