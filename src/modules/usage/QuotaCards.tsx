import { useState } from 'react'
import { ChevronDown, RefreshCw } from 'lucide-react'
import type { LlmProviderInfo, ProviderQuotaView, QuotaMoney } from '../../types'
import { QUOTA_FAIL_TEXT, fmtCountdown, isUnsupported, windowLevel } from './usageModel'

/**
 * 账户额度卡（一供应商一卡，卡内展示**激活账户**；有多账户时卡头「还有 N 个账户」→ 行内懒查）。
 *
 * 口径（用户拍板，方案 §5.2/§5.3）：
 *   · 额度是**账户级**的；默认只查激活账户，其余账户懒查（紧凑胶囊行，不给进度条）；
 *   · 无余额接口的供应商**不占卡** → 收成末行汇总「另 N 家供应商未提供余额接口」+ 行内看名单；
 *   · 阈值配色走 --warning / --danger（不硬编码 hex）；不显示计划名（上游不上报）。
 */

interface Props {
  providers: LlmProviderInfo[]
  /** 激活账户的额度视图（默认入口拉的） */
  views: ProviderQuotaView[]
  /** 懒查回来的非激活账户额度：providerId → 视图数组 */
  expanded: Record<string, ProviderQuotaView[]>
  loading: Set<string>
  onLoadAccounts: (providerId: string) => void
  onRefresh: () => void
  refreshing: boolean
  /** 首次拉激活账户额度尚未回（避免把「还没回来」显示成「未查询」） */
  initialLoading: boolean
  at: string | null
}

const LEVEL_COLOR: Record<'ok' | 'warn' | 'hot', string> = {
  ok: 'var(--accent)',
  warn: 'var(--warning)',
  hot: 'var(--danger)',
}

function AccountBody({ view }: { view: ProviderQuotaView }) {
  if (!view.ok) {
    return (
      <div className="mt-1 flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
        <span className="h-1.5 w-1.5 flex-none rounded-full bg-[var(--warning)]" />
        {QUOTA_FAIL_TEXT[view.reason]}
      </div>
    )
  }
  if (view.kind === 'money') {
    return (
      <div className="mt-1 space-y-1.5">
        {view.balances.map((b: QuotaMoney, i) => (
          <div key={i}>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[22px] font-semibold tabular-nums text-[var(--text-primary)]">{b.total}</span>
              <span className="text-[12px] text-[var(--text-muted)]">{b.currency}</span>
              {!view.available && <span className="ml-1 text-[11px] text-[var(--warning)]">余额不可用</span>}
            </div>
            <div className="text-[11px] text-[var(--text-muted)]">赠金 {b.granted} · 充值 {b.topped}</div>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="mt-1 space-y-2">
      {view.windows.map((w) => {
        const lv = windowLevel(w)
        const cd = fmtCountdown(w.resetsAt)
        return (
          <div key={w.key}>
            <div className="flex items-baseline justify-between text-[11.5px]">
              <span className="text-[var(--text-secondary)]">{w.label}</span>
              <span className="tabular-nums" style={{ color: lv === 'ok' ? 'var(--text-secondary)' : LEVEL_COLOR[lv] }}>
                {w.percent}%{lv === 'hot' ? ' · 限速中' : ''}
              </span>
            </div>
            <div className="mt-1 h-[6px] overflow-hidden rounded-full bg-[var(--bg-hover)]">
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, w.percent)}%`, background: LEVEL_COLOR[lv] }} />
            </div>
            {cd && <div className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">{cd}后重置</div>}
          </div>
        )
      })}
    </div>
  )
}

/** 非激活账户：紧凑胶囊行（懒查），不给进度条 */
function AccountLine({ name, view, loading }: { name: string; view?: ProviderQuotaView; loading: boolean }) {
  let summary = ''
  if (loading) summary = '查询中…'
  else if (!view) summary = '未查询'
  else if (!view.ok) summary = QUOTA_FAIL_TEXT[view.reason]
  else if (view.kind === 'money') summary = view.balances.map((b) => `${b.total} ${b.currency}`).join(' / ')
  else summary = view.windows.map((w) => `${w.percent}%`).join(' · ')
  return (
    <div className="flex items-center gap-2 rounded-[6px] bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-[12px]">
      <span className="h-1.5 w-1.5 flex-none rounded-full bg-[var(--text-disabled)]" />
      <span className="truncate text-[var(--text-primary)]">{name}</span>
      <span className="ml-auto truncate tabular-nums text-[var(--text-muted)]">{summary}</span>
    </div>
  )
}

export function QuotaCards({ providers, views, expanded, loading, onLoadAccounts, onRefresh, refreshing, initialLoading, at }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [showMore, setShowMore] = useState(false)

  const viewOf = (providerId: string, accountId: string): ProviderQuotaView | undefined =>
    views.find((v) => v.providerId === providerId && v.accountId === accountId)

  // 有接口的供应商 = 激活账户视图不是 unsupported；无接口的收进汇总
  const cards: LlmProviderInfo[] = []
  const noInterface: string[] = []
  for (const p of providers) {
    const acct = p.activeAccountId || (p.accounts[0]?.id ?? '')
    const v = viewOf(p.id, acct)
    if (v && isUnsupported(v)) noInterface.push(p.name)
    else cards.push(p)
  }

  return (
    <div className="rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5 py-3">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">账户额度</span>
        <span className="text-[11px] text-[var(--text-muted)]">来自供应商接口 · 非账单金额 · 不受上方时间窗影响</span>
        <span className="flex-1" />
        {at && <span className="text-[11px] text-[var(--text-muted)]">{new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>}
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="flex items-center gap-1 rounded-[6px] border border-[var(--border-color)] px-2 py-1 text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          刷新
        </button>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(268px,1fr))] items-start gap-2.5">
        {cards.map((p) => {
          const acct = p.activeAccountId || (p.accounts[0]?.id ?? '')
          const view = viewOf(p.id, acct)
          const others = p.accounts.filter((a) => a.id !== acct)
          const isOpen = !!open[p.id]
          const extra = expanded[p.id]
          const isLoading = loading.has(p.id)
          return (
            <div key={p.id} className="rounded-[8px] border border-[var(--border-color)] bg-[var(--bg-tertiary)]/40 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">{p.name}</span>
                <span className="text-[11px] text-[var(--text-muted)]">{p.accounts.find((a) => a.id === acct)?.name ?? ''}</span>
                <span className="flex-1" />
                {others.length > 0 && (
                  <button
                    onClick={() => {
                      setOpen((o) => ({ ...o, [p.id]: !o[p.id] }))
                      if (!isOpen && !extra) onLoadAccounts(p.id)
                    }}
                    className="flex items-center gap-0.5 text-[11px] text-[var(--accent)] hover:underline"
                  >
                    还有 {others.length} 个账户
                    <ChevronDown size={12} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                  </button>
                )}
              </div>

              {view ? <AccountBody view={view} /> : <div className="mt-1 text-[12px] text-[var(--text-muted)]">{initialLoading ? '查询中…' : '未查询'}</div>}

              {isOpen && others.length > 0 && (
                <div className="mt-2 space-y-1 border-t border-[var(--border-color)] pt-2">
                  {others.map((a) => (
                    <AccountLine
                      key={a.id}
                      name={a.name}
                      view={extra?.find((v) => v.accountId === a.id)}
                      loading={isLoading && !extra}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {cards.length === 0 && noInterface.length === 0 && (
        <div className="py-2 text-[12px] text-[var(--text-muted)]">未配置已启用的模型供应商</div>
      )}

      {noInterface.length > 0 && (
        <div className="mt-2.5 border-t border-[var(--border-color)] pt-2 text-[11.5px] text-[var(--text-muted)]">
          另 {noInterface.length} 家供应商未提供余额接口
          <button onClick={() => setShowMore((v) => !v)} className="ml-2 text-[var(--accent)] hover:underline">
            {showMore ? '收起' : '看名单'}
          </button>
          {showMore && <span className="ml-2 text-[var(--text-secondary)]">{noInterface.join(' · ')}</span>}
        </div>
      )}
    </div>
  )
}
