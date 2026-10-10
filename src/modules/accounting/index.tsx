import { useMemo, useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ReceiptText, BarChart3, NotebookPen, ListOrdered, CalendarDays, Eye, EyeOff, Plus, Repeat, Pencil, Trash2 } from 'lucide-react'
import type { AccountingTransaction, AccountingRecurring } from '../../types'
import { accountingDelete, accountingRecurringPost, accountingRecurringDelete, accountingRecurringSettle, accountingRecurringUpdate } from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { FlowView, StatsView, ReviewView } from './views'
import { useAccountingData, monthLabel, money, sumAmount, catColor, todayStr, computeAccountBalances, recurringStatus, recurringMonthlyTotal, requestEditTransaction, requestNewTransaction, requestNewRecurring, requestEditRecurring, type AccountingView } from './shared'

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
  const { transactions, categories, accounts, recurring, reload } = useAccountingData()
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
    for (const t of monthTx) { if (t.type === 'transfer') continue; m.set(t.category, (m.get(t.category) ?? 0) + 1) }  // 转账无分类，不进分类侧栏
    return m
  }, [monthTx])

  const handleDelete = async (id: string): Promise<void> => {
    try {
      const ok = await accountingDelete(id)
      if (ok) { showToast({ type: 'info', message: '已删除这一笔' }); await reload() }
    } catch (e) { showToast({ type: 'error', message: '删除失败', detail: String(e) }) }
  }

  // 定期收支：打开模块时结算一次（幂等，自动补齐漏掉的应扣），可撤销
  const settledRef = useRef(false)
  useEffect(() => {
    if (settledRef.current) return
    settledRef.current = true
    void (async () => {
      try {
        const res = await accountingRecurringSettle()
        if (res.added > 0) {
          const ids = res.items.map((i) => i.id)
          showToast({
            type: 'success', duration: 9000,
            message: `已自动记入定期收支 ${res.added} 笔（${money(res.total)}）`,
            action: { label: '撤销', onClick: () => { void (async () => { for (const id of ids) await accountingDelete(id).catch(() => { }); await reload() })() } },
          })
          await reload()
        }
      } catch { /* 仓库未打开等，忽略 */ }
    })()
  }, [reload])

  const handlePostRecurring = async (id: string): Promise<void> => {
    try {
      const res = await accountingRecurringPost(id)
      if (!res.ok) { showToast({ type: 'warning', message: res.error ?? '记入失败' }); return }
      showToast({ type: 'success', message: '已记入这一笔' })
      await reload()
    } catch (e) { showToast({ type: 'error', message: '记入失败', detail: String(e) }) }
  }
  const handleDeleteRecurring = async (id: string): Promise<void> => {
    try {
      const ok = await accountingRecurringDelete(id)
      if (ok) { showToast({ type: 'info', message: '已删除规则（已生成的流水保留）' }); await reload() }
    } catch (e) { showToast({ type: 'error', message: '删除失败', detail: String(e) }) }
  }
  const handleToggleRecurring = async (r: AccountingRecurring): Promise<void> => {
    try { await accountingRecurringUpdate(r.id, { enabled: !r.enabled }); await reload() }
    catch (e) { showToast({ type: 'error', message: '操作失败', detail: String(e) }) }
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

      {/* 定期收支（每月几号 / 每 N 天）*/}
      <div className="mt-3 border-t border-[var(--border-color)] pt-2">
        <div className="flex items-center gap-1.5 px-2 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
          <Repeat size={12} /> 定期收支
          <span className="ml-auto tabular-nums">{recurring.length}</span>
          <button onClick={() => requestNewRecurring()} title="新增定期收支"
            className="rounded p-0.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]"><Plus size={13} /></button>
        </div>
        {recurring.length > 0 && (
          <div className="mx-2 mt-1 flex items-baseline gap-1.5 rounded-md border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-2.5 py-1.5">
            <span className="text-[11px] text-[var(--text-secondary)]">每月固定支出</span>
            <span className="ml-auto text-[14px] font-bold tabular-nums text-[var(--accent)]">{money(recurringMonthlyTotal(recurring))}</span>
          </div>
        )}
        <div className="mt-1 flex flex-col gap-1">
          {recurring.map((r) => {
            const st = recurringStatus(r, transactions, todayStr())
            const badge = st.kind === 'paused' ? { t: '已暂停', c: 'text-[var(--text-muted)] bg-[var(--bg-hover)]' }
              : st.kind === 'done' ? { t: '本月已记', c: 'text-[var(--money-in,#2b9e8f)] bg-[color-mix(in_srgb,var(--money-in,#2b9e8f)_16%,transparent)]' }
                : st.kind === 'due' ? { t: `待记 ${st.due.slice(5)}`, c: 'text-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_18%,transparent)]' }
                  : { t: `待扣 ${st.due.slice(5)}`, c: 'text-[var(--text-muted)] bg-[var(--bg-hover)]' }
            const cyc = r.mode === 'monthly' ? `每月 ${r.day} 号` : `每 ${r.intervalDays} 天`
            return (
              <div key={r.id} className={'rounded-md border border-transparent bg-[var(--bg-tertiary)] px-2 py-1.5 ' + (r.enabled ? '' : 'opacity-55')}>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => void handleToggleRecurring(r)} title={r.enabled ? '暂停' : '启用'}
                    className={'relative h-4 w-7 shrink-0 rounded-full transition-colors ' + (r.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--border-color)]')}>
                    <span className="absolute top-0.5 h-3 w-3 rounded-full bg-white transition-[left] duration-150" style={{ left: r.enabled ? 14 : 2 }} />
                  </button>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text-primary)]" title={r.name}>{r.name}</span>
                  <span className={'shrink-0 text-[12px] font-semibold tabular-nums ' + (r.type === 'income' ? 'text-[var(--money-in,#2b9e8f)]' : 'text-[var(--money-out,#e06c4f)]')}>{r.type === 'expense' ? '-' : '+'}{money(r.amount).replace('¥', '')}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px]">
                  <span className="truncate text-[var(--text-muted)]">{cyc}{r.payment ? ` · ${r.payment}` : ''}</span>
                  <span className={'ml-auto shrink-0 rounded-full px-1.5 py-px ' + badge.c}>{badge.t}</span>
                </div>
                <div className="mt-1 flex items-center gap-1">
                  {r.enabled && st.kind === 'due' && (
                    <button onClick={() => void handlePostRecurring(r.id)} className="rounded border border-[var(--accent)]/50 px-1.5 py-px text-[10.5px] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10">记入</button>
                  )}
                  <span className="ml-auto" />
                  <button onClick={() => requestEditRecurring(r.id)} title="编辑" className="rounded p-0.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Pencil size={11} /></button>
                  <button onClick={() => void handleDeleteRecurring(r.id)} title="删除" className="rounded p-0.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--danger)]"><Trash2 size={11} /></button>
                </div>
              </div>
            )
          })}
          {recurring.length === 0 && (
            <div className="px-2.5 py-1 text-[11.5px] text-[var(--text-muted)]">还没有定期收支，点右上 ＋ 新增（如会员、房租、每月生活费）。</div>
          )}
        </div>
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
