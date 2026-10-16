import { useCallback, useEffect, useState } from 'react'
import { BarChart3, LineChart } from 'lucide-react'
import type { LlmProviderInfo, ProviderQuotaView, UsageDashboardView, UsageWindow } from '../../types'
import { llmGetQuota, llmListProviders, usageDashboard } from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { fmtTokens, exactTokens, fmtUsd, WIN_LABEL, type Metric } from './usageModel'
import { UsageTrend } from './UsageTrend'
import { UsageHeatmap } from './UsageHeatmap'
import { UsageBreakdown } from './UsageBreakdown'
import { QuotaCards } from './QuotaCards'

/**
 * 用量（整窗独占模块，v3.9.0 方案 §二 / §四）。
 *
 * 模块根 `h-full`（铁律 11：槽位容器是块级 div，flex-1 在里面是死属性）+ `data-wb="usage"`（探针契约）。
 *
 * 数据纪律：
 * ① **聚合在主进程**（`usage:dashboard`），渲染层只渲染 —— 价目表在主进程，渲染层拿不到；
 * ② **额度是账户级**：默认只拉激活账户（`llm:quota:get` 不传 accountIds），非激活账户懒查；
 * ③ 无余额接口的供应商由 QuotaCards 收成汇总行，**不占卡**；空数据时卡片区仍渲染。
 */

const WINS: UsageWindow[] = [30, 90, 365, 'all']
const METRICS: Array<{ k: Metric; label: string }> = [
  { k: 'tok', label: 'tokens' },
  { k: 'cost', label: '估算费用' },
  { k: 'calls', label: '调用次数' },
]

const BUCKET_LABEL: Record<UsageWindow, string> = {
  30: '按天',
  90: '按天',
  365: '按周',
  all: '按月',
}

export function UsageModule() {
  const [win, setWin] = useState<UsageWindow>(365)
  const [metric, setMetric] = useState<Metric>('tok')
  const [chartStyle, setChartStyle] = useState<'bar' | 'line'>('bar')

  const [dash, setDash] = useState<UsageDashboardView | null>(null)
  const [providers, setProviders] = useState<LlmProviderInfo[]>([])
  const [quotaViews, setQuotaViews] = useState<ProviderQuotaView[]>([])
  const [expanded, setExpanded] = useState<Record<string, ProviderQuotaView[]>>({})
  const [quotaLoading, setQuotaLoading] = useState<Set<string>>(new Set())
  const [refreshing, setRefreshing] = useState(false)
  const [quotaAt, setQuotaAt] = useState<string | null>(null)
  const [quotaInitialLoading, setQuotaInitialLoading] = useState(true)

  // 看板：挂载 + 时间窗变化时重拉
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const d = await usageDashboard(win)
        if (alive) setDash(d)
      } catch { if (alive) setDash(null) }
    })()
    return () => { alive = false }
  }, [win])

  // 供应商清单（额度卡要账户元信息：账户数 / 名字 / 激活账户）
  const loadProviders = useCallback(async () => {
    try {
      const r = await llmListProviders()
      setProviders((r.providers ?? []).filter((p) => p.enabled))
    } catch { setProviders([]) }
  }, [])

  const loadActiveQuota = useCallback(async (force: boolean) => {
    try {
      const views = await llmGetQuota(force ? { force: true } : {})
      setQuotaViews(views)
      const t = views[0]?.at ?? new Date().toISOString()
      setQuotaAt(t)
    } catch { /* 拉不到保留旧值 */ }
    finally { setQuotaInitialLoading(false) }
  }, [])

  useEffect(() => { void loadProviders() }, [loadProviders])
  useEffect(() => { void loadActiveQuota(false) }, [loadActiveQuota])

  // 懒查非激活账户
  const onLoadAccounts = useCallback(async (providerId: string) => {
    const p = providers.find((x) => x.id === providerId)
    if (!p) return
    const activeId = p.activeAccountId || (p.accounts[0]?.id ?? '')
    const ids = p.accounts.filter((a) => a.id !== activeId).map((a) => a.id)
    if (ids.length === 0) return
    setQuotaLoading((s) => new Set(s).add(providerId))
    try {
      const views = await llmGetQuota({ providerId, accountIds: ids })
      setExpanded((e) => ({ ...e, [providerId]: views }))
    } catch { showToast({ type: 'error', message: '查询账户额度失败' }) }
    finally {
      setQuotaLoading((s) => { const n = new Set(s); n.delete(providerId); return n })
    }
  }, [providers])

  // 刷新 = 刷新已显示项（激活账户 + 已展开的非激活账户）
  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await loadActiveQuota(true)
      const next: Record<string, ProviderQuotaView[]> = {}
      for (const pid of Object.keys(expanded)) {
        const p = providers.find((x) => x.id === pid)
        if (!p) continue
        const activeId = p.activeAccountId || (p.accounts[0]?.id ?? '')
        const ids = p.accounts.filter((a) => a.id !== activeId).map((a) => a.id)
        if (ids.length) next[pid] = await llmGetQuota({ providerId: pid, accountIds: ids, force: true })
      }
      if (Object.keys(next).length) setExpanded((e) => ({ ...e, ...next }))
    } catch { showToast({ type: 'error', message: '刷新额度失败' }) }
    finally { setRefreshing(false) }
  }, [loadActiveQuota, expanded, providers])

  const t = dash?.totals
  const hasData = !!dash && (dash.models.length > 0 || (t?.calls ?? 0) > 0)
  const totalTok = t ? t.i0 + t.ir + t.iw + t.out : 0
  const totalCost = dash ? dash.models.reduce((a, r) => a + (r.cost ?? 0), 0) : 0
  const unknown = dash?.unknownModels ?? []

  return (
    <div data-wb="usage" className="h-full overflow-y-auto bg-[var(--bg-primary)]">
      <div className="mx-auto max-w-[1200px] px-6 pb-14 pt-5">
        {/* 模块头 */}
        <div className="mb-3 flex items-center gap-2">
          <span className="text-[13px] font-semibold text-[var(--text-primary)]">用量</span>
          <span className="text-[11.5px] text-[var(--text-muted)]">本机全部 AI 调用 · 只读</span>
          <span className="flex-1" />
          <span className="text-[11px] text-[var(--text-muted)]">数据源 ai-usage.json · 保留 400 天</span>
        </div>

        {/* 账户额度（与时间窗无关；空数据时仍显示） */}
        <QuotaCards
          providers={providers}
          views={quotaViews}
          expanded={expanded}
          loading={quotaLoading}
          onLoadAccounts={onLoadAccounts}
          onRefresh={onRefresh}
          refreshing={refreshing}
          initialLoading={quotaInitialLoading}
          at={quotaAt}
        />

        {/* 工具行 */}
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <div className="flex rounded-[7px] border border-[var(--border-color)] p-0.5">
            {WINS.map((w) => (
              <button
                key={String(w)}
                onClick={() => setWin(w)}
                className={`rounded-[5px] px-2.5 py-1 text-[12px] ${win === w ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
              >
                {WIN_LABEL[w]}
              </button>
            ))}
          </div>
          <div className="flex rounded-[7px] border border-[var(--border-color)] p-0.5">
            {METRICS.map((m) => (
              <button
                key={m.k}
                onClick={() => setMetric(m.k)}
                className={`rounded-[5px] px-2.5 py-1 text-[12px] ${metric === m.k ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <div className="flex rounded-[7px] border border-[var(--border-color)] p-0.5">
            <button
              onClick={() => setChartStyle('bar')}
              title="柱状"
              className={`rounded-[5px] px-2 py-1 ${chartStyle === 'bar' ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
            >
              <BarChart3 size={14} />
            </button>
            <button
              onClick={() => setChartStyle('line')}
              title="折线"
              className={`rounded-[5px] px-2 py-1 ${chartStyle === 'line' ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
            >
              <LineChart size={14} />
            </button>
          </div>
        </div>

        {!hasData ? (
          <div className="mt-6 rounded-[10px] border border-dashed border-[var(--border-color)] py-10 text-center text-[13px] text-[var(--text-muted)]">
            还没有用量记录。
            <div className="mt-1 text-[11.5px]">用 AI 聊一次或跑一个整理任务，这里就会出现数据。</div>
          </div>
        ) : (
          <>
            {/* 总览三卡 */}
            <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2.5">
              <div className="rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5 py-3">
                <div className="text-[11.5px] text-[var(--text-muted)]">总消耗 <span className="text-[var(--text-disabled)]">{WIN_LABEL[win]}</span></div>
                <div className="mt-1 text-[24px] font-semibold tabular-nums text-[var(--text-primary)]" title={exactTokens(totalTok)}>{fmtTokens(totalTok)}</div>
                <div className="mt-2 flex h-[7px] overflow-hidden rounded-full bg-[var(--bg-hover)]">
                  {([[t?.i0, 'var(--accent)'], [t?.ir, 'color-mix(in srgb, var(--accent) 62%, var(--bg-hover))'], [t?.iw, 'color-mix(in srgb, var(--accent) 34%, var(--bg-hover))'], [t?.out, 'var(--success)']] as Array<[number | undefined, string]>).map(([v, c], i) => (
                    <div key={i} style={{ width: `${totalTok > 0 ? ((v ?? 0) / totalTok) * 100 : 0}%`, background: c }} />
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
                  <span>未缓存输入 <b className="tabular-nums text-[var(--text-secondary)]">{fmtTokens(t?.i0 ?? 0)}</b></span>
                  <span>缓存读 <b className="tabular-nums text-[var(--text-secondary)]">{fmtTokens(t?.ir ?? 0)}</b></span>
                  <span>缓存写 <b className="tabular-nums text-[var(--text-secondary)]" title="上游未上报即为 0">{fmtTokens(t?.iw ?? 0)}</b></span>
                  <span>输出 <b className="tabular-nums text-[var(--text-secondary)]">{fmtTokens(t?.out ?? 0)}</b></span>
                </div>
              </div>
              <div className="rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5 py-3">
                <div className="text-[11.5px] text-[var(--text-muted)]">估算费用 <span className="text-[var(--text-disabled)]">USD · 非账单</span></div>
                <div className="mt-1 text-[24px] font-semibold tabular-nums text-[var(--accent)]">{fmtUsd(totalCost)}</div>
                <div className="mt-1 text-[11px] text-[var(--text-muted)]">按内置价目表折算</div>
                {unknown.length > 0 && <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">{unknown.length} 个模型无价目 · 实际费用为下限</div>}
              </div>
              <div className="rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5 py-3">
                <div className="text-[11.5px] text-[var(--text-muted)]">调用次数</div>
                <div className="mt-1 text-[24px] font-semibold tabular-nums text-[var(--text-primary)]">{(t?.calls ?? 0).toLocaleString('en-US')}</div>
                <div className="mt-1 text-[11px] text-[var(--text-muted)]">有记账的 {t?.days ?? 0} 天</div>
              </div>
            </div>

            {/* 趋势 */}
            <div className="mt-3 rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5 py-3">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">趋势</span>
                <span className="text-[11px] text-[var(--text-muted)]">{WIN_LABEL[win]} · {BUCKET_LABEL[win]}</span>
              </div>
              <UsageTrend series={dash?.series ?? []} metric={metric} style={chartStyle} />
            </div>

            {/* 热力图 */}
            <div className="mt-3 rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5 py-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">活动热力图 · 近 365 天</span>
                <span className="flex-1" />
                <span className="text-[11px] text-[var(--text-muted)]">少</span>
                {['var(--bg-hover)', 'color-mix(in srgb, var(--accent) 28%, var(--bg-hover))', 'color-mix(in srgb, var(--accent) 50%, var(--bg-hover))', 'color-mix(in srgb, var(--accent) 74%, var(--bg-hover))', 'var(--accent)'].map((c, i) => (
                  <span key={i} className="inline-block h-[11px] w-[11px] rounded-[2px]" style={{ background: c }} />
                ))}
                <span className="text-[11px] text-[var(--text-muted)]">多</span>
              </div>
              <UsageHeatmap heat={dash?.heat ?? []} />
            </div>

            {/* 拆分表 */}
            <div className="mt-3 rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5 py-3">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">按供应商 / 模型拆分</span>
                <span className="flex-1" />
                <span className="text-[11px] text-[var(--text-muted)]">点表头排序</span>
              </div>
              <UsageBreakdown models={dash?.models ?? []} />
            </div>

            <div className="mt-3 text-[11px] text-[var(--text-muted)]">
              覆盖全部 AI 调用（对话 / 教学 / 助手 / 翻译 / 嵌入）· 中途叫停的任务按其已发生的调用计入
            </div>
          </>
        )}
      </div>
    </div>
  )
}
