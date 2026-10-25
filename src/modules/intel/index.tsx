import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, Heart, List, Newspaper, RefreshCw, Settings2, FileText } from 'lucide-react'
import type { IntelCustomSource, IntelItem, IntelMeta, IntelSection, IntelSourceKey } from '../../types'
import { intelGetItems, intelRefresh, intelToggleFav, intelSetFilter, intelClearAiRec, intelTranslate, intelListCustomSources } from '../../lib/ipc'
import { useDataChanged } from '../../lib/dataChanged'
import { useSettings } from '../../lib/SettingsContext'
import { showToast } from '../../lib/toast'
import { filterIntelItems, SOURCE_META, INTEL_SOURCE_KEYS, SECTIONS, SECTION_META, sectionOf, isEnglishText } from '../../lib/intelPure'
import { IntelSidebar, type IntelFeedFilter } from './IntelSidebar'

/**
 * 情报主页（v3.13.0 报纸化，docs/intel-module-plan.md §6.3 + D13）。
 *
 * topbar：统计 chip ｜ 上次更新 ｜ 简报（disabled 占位）｜ 刷新 ｜ ⚙ ｜ 🤖
 * 筛选 pill 行：当前筛选 + AI 筛选 pill + 右端「头条 / 时间流」视图切换（会话内记忆，默认时间流）。
 * 头条视图 = 报纸头版：按版面分区，每区 score top 3（首条大卡带摘要，其余紧凑行）。
 * 时间流 = 单列卡片列表 + .kb-cv（content-visibility）+ .kb-item-in（动效令牌，铁律 13）。
 * 模块根节点 h-full（铁律 11，禁 flex-1）。
 */

function relTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

export interface IntelModuleProps {
  isActive: boolean
  sidebarEl?: HTMLElement | null
  sidebarHosted?: boolean
  /** feed 卡片点击 → App 开 / 激活文章页签（去重在 App 侧） */
  onOpenArticle: (id: string, title: string) => void
  /** ⚙ → 设置模块「模块 › 情报」分区 */
  onOpenSettings: () => void
  /** 🤖 → 展开右栏并落 📡 情报助手 Tab */
  onExpandAssistant: () => void
}

export function IntelModule({ isActive, sidebarEl = null, sidebarHosted = false, onOpenArticle, onOpenSettings, onExpandAssistant }: IntelModuleProps) {
  const [items, setItems] = useState<IntelItem[]>([])
  const [meta, setMeta] = useState<IntelMeta | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState<IntelFeedFilter>('all')
  const [favPopId, setFavPopId] = useState<string | null>(null)
  const [customSources, setCustomSources] = useState<IntelCustomSource[]>([])
  /** 头条 / 时间流（D13：会话内记忆，不持久化；模块 Tab 首挂保活 → useState 即可） */
  const [view, setView] = useState<'timeline' | 'headline'>('timeline')
  const mountedRef = useRef(false)
  const { s } = useSettings()

  const reload = useCallback(async () => {
    try {
      const r = await intelGetItems()
      setItems(r.items)
      setMeta(r.meta)
    } catch { /* 仓库未就绪时保持旧数据 */ }
    try { setCustomSources(await intelListCustomSources()) } catch { /* 无仓库时保持空 */ }
    if (!mountedRef.current) { mountedRef.current = true; setLoaded(true) }
  }, [])

  useEffect(() => { void reload() }, [reload])
  useDataChanged('intel', reload)

  const refresh = useCallback(async () => {
    if (refreshing) return
    // 刷新语义（2026-10-25 拍板）：左栏停在具体源（含 custom:*）= 只刷该源；版面/全部/收藏/AI 推荐 = 全部源
    const scope = INTEL_SOURCE_KEYS.includes(filter as IntelSourceKey) || filter.startsWith('custom:')
      ? filter
      : undefined
    setRefreshing(true)
    try {
      const r = await intelRefresh(scope)
      if (scope) {
        const label = scope.startsWith('custom:')
          ? customSources.find((c) => `custom:${c.id}` === scope)?.name ?? scope
          : SOURCE_META[scope as IntelSourceKey]?.label ?? scope
        if (r.failedSources.includes(scope)) {
          showToast({ type: 'info', message: `已刷新 ${label} · 该源本轮失败`, detail: '限流或网络抖动，稍后再试（GitHub 匿名接口限 10 次/分钟）' })
        } else {
          showToast({ type: 'success', message: `已刷新 ${label} · 新增 ${r.added} 条`, detail: '左栏停在「全部」时刷新 = 全部内置源 + 自定义源并行' })
        }
      } else {
        const failed = r.failedSources.length
        showToast({
          type: failed > 0 ? 'info' : 'success',
          message: `刷新完成 · 新增 ${r.added} 条`,
          detail: failed > 0 ? `${failed} 个源本轮失败（限流 / 网络抖动，下轮自动重试）` : undefined,
        })
      }
    } catch (err) {
      showToast({ type: 'error', message: String((err as Error)?.message ?? err).slice(0, 120) })
    } finally {
      setRefreshing(false)
    }
  }, [refreshing, filter, customSources])

  const toggleFav = useCallback(async (it: IntelItem) => {
    // 乐观更新（卡片 ♥ 即时反馈；主进程广播后 reload 对齐）
    setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, fav: !x.fav } : x)))
    if (!it.fav) {
      setFavPopId(it.id)
      window.setTimeout(() => setFavPopId((cur) => (cur === it.id ? null : cur)), 400)
      showToast({ type: 'success', message: '已收藏', detail: it.title })
    }
    try { await intelToggleFav(it.id) } catch { void reload() }
  }, [reload])

  const clearAiFilter = useCallback(async () => {
    try { await intelSetFilter({ kind: '', kw: '' }) } catch { /* store 广播后 reload 对齐 */ }
  }, [])

  const aiRec = meta?.aiRec ?? null
  const aiFilter = meta?.aiFilter

  const visible = useMemo(() => {
    let base: IntelItem[]
    if (filter === 'airec') {
      const ids = aiRec?.ids ?? []
      const set = new Set(ids)
      base = items.filter((it) => set.has(it.id))
    } else if (filter === 'fav') {
      base = items.filter((it) => it.fav)
    } else if (filter === 'all') {
      base = items
    } else if ((SECTIONS as readonly string[]).includes(filter)) {
      base = items.filter((it) => (it.section ?? sectionOf(it.source)) === filter)
    } else {
      base = items.filter((it) => it.source === filter) // 内置源或 custom:<id>
    }
    return filterIntelItems(base, { kind: aiFilter?.kind, kw: aiFilter?.kw })
  }, [items, filter, aiRec, aiFilter])

  const counts = useMemo(() => {
    const perSource: Record<string, number> = {}
    const perSection: Record<string, number> = {}
    let fav = 0
    for (const it of items) {
      perSource[it.source] = (perSource[it.source] ?? 0) + 1
      const sec = it.section ?? sectionOf(it.source)
      perSection[sec] = (perSection[sec] ?? 0) + 1
      if (it.fav) fav++
    }
    return { perSource, perSection, all: items.length, fav, airec: aiRec?.ids.length ?? 0 }
  }, [items, aiRec])

  /** custom:<id> → 用户命名（FeedCard 徽标 / 刷新 toast 用） */
  const customNames = useMemo(() => {
    const m: Record<string, string> = {}
    for (const c of customSources) m[`custom:${c.id}`] = c.name
    return m
  }, [customSources])

  // ===== 卡片英文自动翻译（docs/intel-translate-plan.md §4.2/§5）：悬停即译 =====
  // 2026-10-25 用户拍板：可见即译 → 悬停即译（鼠标移上卡片才译，更省也更贴合阅读动线）；
  // 预热兜底首屏译题。占位「译…」预留高度防跳动 → 译文经主进程广播 → reload 合并 titleZh 后 .kb-view-in 淡入。
  // zhRequestedRef（本会话已请求）/ zhOffRef（熔断：LLM 未配置 / 预算耗尽）都不随渲染重置。
  const listRef = useRef<HTMLDivElement>(null)
  const zhRequestedRef = useRef<Set<string>>(new Set())
  const zhOffRef = useRef(false)
  const zhToastedRef = useRef(false)
  const [pendingZh, setPendingZh] = useState<ReadonlySet<string>>(() => new Set())
  const translateOn = s['intel.translateOn'] !== false

  useEffect(() => {
    if (!translateOn || zhOffRef.current || !loaded) return
    const root = listRef.current
    if (!root) return
    let timer: number | undefined
    const seen = new Set<string>()
    // pointerover 冒泡委托：卡片内子元素间移动会对同一 id 反复触发，seen/requested 双去重兜住；
    // [data-en] 门控 = 渲染层同款 isEnglishText 预判（与主进程同一实现），中文卡悬停零请求零占位
    const onOver = (e: PointerEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-intel-id][data-en]:not([data-zh])') as HTMLElement | null
      const id = el?.dataset.intelId
      if (!id || zhRequestedRef.current.has(id) || seen.has(id)) return
      seen.add(id)
      if (timer !== undefined) return
      // 400ms 防抖合并快速划过：顺列表扫一遍不应每卡一发
      timer = window.setTimeout(() => {
        const ids = [...seen]
        seen.clear()
        timer = undefined
        ids.forEach((x) => zhRequestedRef.current.add(x))
        setPendingZh((prev) => {
          const n = new Set(prev)
          ids.forEach((x) => n.add(x))
          return n
        })
        intelTranslate(ids).then((res) => {
          setPendingZh((prev) => {
            const n = new Set(prev)
            ids.forEach((x) => n.delete(x))
            return n
          })
          if (res.disabled && !zhOffRef.current) {
            zhOffRef.current = true
            if (!zhToastedRef.current) {
              zhToastedRef.current = true
              const why = res.reason === 'budget'
                ? '会话翻译量已达上限（设置 › 模块 › 情报 › 卡片翻译会话上限）'
                : res.reason === 'off'
                  ? '卡片翻译已在设置中关闭'
                  : '未配置可用的模型（设置 › AI › 模型）'
              showToast({ type: 'info', message: '卡片英文翻译已停用', detail: why })
            }
          }
        }).catch(() => {
          setPendingZh((prev) => {
            const n = new Set(prev)
            ids.forEach((x) => n.delete(x))
            return n
          })
        })
      }, 400)
    }
    root.addEventListener('pointerover', onOver)
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      root.removeEventListener('pointerover', onOver)
    }
  }, [translateOn, loaded])

  const sidebarInner = (
    <IntelSidebar
      active={filter}
      counts={counts}
      aiRec={aiRec}
      customSources={customSources}
      onSelect={setFilter}
      onClearAiRec={async () => {
        try {
          await intelClearAiRec()
          if (filter === 'airec') setFilter('all')
        } catch { /* ignore */ }
      }}
    />
  )
  const sidebar = sidebarEl
    ? createPortal(sidebarInner, sidebarEl)
    : sidebarHosted
      ? null
      : (
        <aside className="hidden w-[220px] shrink-0 border-r border-[var(--border-color)] md:block">
          {sidebarInner}
        </aside>
      )

  const statText = `共 ${counts.all} 条 · 收藏 ${counts.fav}`

  return (
    <div className="kb-theme-surface flex h-full min-h-0">
      {sidebar}
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {/* topbar：@container 供窄宽度下隐藏按钮文字（2026-10-25 反馈：窄列不折行，文字隐去只留图标） */}
        <div className="@container flex h-[42px] shrink-0 items-center gap-2.5 border-b border-[var(--border-color)] px-3.5">
          <span className="shrink-0 whitespace-nowrap text-[13.5px] font-semibold text-[var(--text-primary)]">情报</span>
          <span className="min-w-0 max-w-[190px] shrink truncate rounded-full border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2.5 py-[3px] text-[11px] text-[var(--text-secondary)]" title={statText}>
            {statText}
          </span>
          {meta?.lastFetchAt && (
            <span className="min-w-0 shrink truncate text-[11px] text-[var(--text-muted)]" title={meta.lastFetchAt}>上次更新 {relTime(meta.lastFetchAt)}</span>
          )}
          {meta?.lastFetchStats && meta.lastFetchStats.failed.length > 0 && (
            <span className="min-w-0 shrink truncate text-[11px] text-[var(--warning)]" title={meta.lastFetchStats.failed.join('、')}>
              {meta.lastFetchStats.failed.length} 源失败
            </span>
          )}
          <span className="flex-1" />
          <button
            disabled
            title="每日简报将在 3.12.x 提供"
            className="flex h-7 cursor-default items-center gap-1.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2.5 text-[12px] text-[var(--text-muted)] opacity-50"
          >
            <FileText size={12} className="shrink-0" />
            <span className="whitespace-nowrap @max-[560px]:hidden">简报</span>
          </button>
          <button
            onClick={() => { void refresh() }}
            disabled={refreshing}
            title={INTEL_SOURCE_KEYS.includes(filter as IntelSourceKey) || filter.startsWith('custom:')
              ? `只刷新该源；左栏停在「全部」或版面时刷新 = 全部内置源 + 自定义源并行`
              : '抓取一轮（全部内置源 + 自定义源并行，单源失败不影响其余）；左栏停在某个源时只刷该源'}
            className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2.5 text-[12px] text-[var(--text-primary)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-hover)] disabled:cursor-default disabled:opacity-50"
          >
            <RefreshCw size={12} className={`shrink-0 ${refreshing ? 'animate-spin' : ''}`} />
            <span className="whitespace-nowrap @max-[560px]:hidden">刷新</span>
          </button>
          <button
            onClick={onOpenSettings}
            title="抓取设置（设置 › 模块 › 情报）"
            className="flex size-7 items-center justify-center rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
          >
            <Settings2 size={13} />
          </button>
          <button
            onClick={onExpandAssistant}
            title="情报助手（推荐 / 查找 / 筛选）"
            className="flex size-7 items-center justify-center rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
          >
            <Bot size={13} />
          </button>
        </div>

        {/* 筛选 pill 行 */}
        <div className="flex h-[34px] shrink-0 items-center gap-2 overflow-x-auto border-b border-[var(--border-color)] px-4 text-[12px] text-[var(--text-secondary)]">
          <span>{filterLabelOf(filter, customNames)}</span>
          {filter === 'airec' && aiRec?.query && (
            <span className="shrink-0 rounded-full border border-[var(--accent)] px-2 py-[1.5px] text-[11px] text-[var(--accent)]">
              来自询问：「{aiRec.query.slice(0, 40)}」
            </span>
          )}
          {aiFilter?.kind === 'paper' && (
            <FilterPill label="仅论文" onClick={() => { void clearAiFilter() }} />
          )}
          {aiFilter?.kind === 'chinese' && (
            <FilterPill label="仅中文" onClick={() => { void clearAiFilter() }} />
          )}
          {aiFilter?.kw && (
            <FilterPill label={`关键词：${aiFilter.kw}`} onClick={() => { void clearAiFilter() }} />
          )}
          <span className="ml-auto" />
          {/* 头条 / 时间流 视图切换（D13：默认时间流，会话内记忆） */}
          <div className="flex shrink-0 items-center rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-[2px]">
            <button
              onClick={() => setView('headline')}
              title="头条视图：报纸头版式，按版面分区各取质量分 top 3"
              className={`flex h-[22px] items-center gap-1 rounded-[4px] px-2 text-[11px] transition-colors ${view === 'headline' ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
            >
              <Newspaper size={11} />
              头条
            </button>
            <button
              onClick={() => setView('timeline')}
              title="时间流视图：单列卡片，按质量分排序"
              className={`flex h-[22px] items-center gap-1 rounded-[4px] px-2 text-[11px] transition-colors ${view === 'timeline' ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
            >
              <List size={11} />
              时间流
            </button>
          </div>
        </div>

        {/* 列表 */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-3">
          {!loaded ? (
            <ListSkeleton />
          ) : visible.length === 0 ? (
            <div className="mx-auto mt-20 max-w-sm text-center text-[12.5px] leading-[2.1] text-[var(--text-muted)]">
              <span className="mb-2 block text-[30px]">🕊</span>
              {counts.all === 0 ? (
                INTEL_SOURCE_KEYS.includes(filter as IntelSourceKey) || filter.startsWith('custom:')
                  ? <>这里还没有该源的内容<br />点右上角「刷新」只抓这一源</>
                  : <>这里还没有内容<br />点右上角「刷新」抓取一轮（全部内置源 + 自定义源并行）</>
              ) : filter === 'fav' ? (
                <>收藏夹是空的<br />点击卡片右下角的 ♡ 收藏感兴趣的内容</>
              ) : filter === 'airec' ? (
                <>当前没有 AI 推荐<br />在 📡 情报助手里问一次就有了</>
              ) : (
                <>该筛选下暂无条目<br />换个来源，或等下一轮抓取</>
              )}
            </div>
          ) : view === 'headline' ? (
            <HeadlineView
              visible={visible}
              customNames={customNames}
              onOpen={(it) => onOpenArticle(it.id, it.title)}
              onFilterSection={(sec) => setFilter(sec)}
            />
          ) : (
            <div>
              {visible.map((it, i) => (
                <FeedCard
                  key={it.id}
                  item={it}
                  index={i}
                  pop={favPopId === it.id}
                  pendingZh={pendingZh.has(it.id)}
                  customNames={customNames}
                  onOpen={() => onOpenArticle(it.id, it.title)}
                  onFav={() => { void toggleFav(it) }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function filterLabelOf(f: IntelFeedFilter, customNames: Record<string, string>): string {
  if (f === 'all') return '全部来源'
  if (f === 'fav') return '收藏夹'
  if (f === 'airec') return 'AI 推荐'
  if ((SECTIONS as readonly string[]).includes(f)) return `${SECTION_META[f as IntelSection].label} 版面`
  return SOURCE_META[f as IntelSourceKey]?.label ?? customNames[f] ?? f
}

/** 头条视图（D13）：报纸头版——按版面分区，每区质量分 top 3（首条大卡带摘要，其余紧凑行） */
function HeadlineView({ visible, customNames, onOpen, onFilterSection }: {
  visible: IntelItem[]
  customNames: Record<string, string>
  onOpen: (it: IntelItem) => void
  onFilterSection: (sec: IntelSection) => void
}) {
  const groups = SECTIONS
    .map((sec) => ({ sec, list: visible.filter((it) => (it.section ?? sectionOf(it.source)) === sec) }))
    .filter((g) => g.list.length > 0)
  return (
    <div className="mx-auto max-w-[720px] space-y-7">
      {groups.map(({ sec, list }) => (
        <section key={sec}>
          <div
            onClick={() => onFilterSection(sec)}
            title={`点版面名筛选「${SECTION_META[sec].label}」全部条目`}
            className="mb-2 flex cursor-pointer select-none items-baseline gap-2 border-b border-[var(--border-color)] pb-1"
          >
            <span className="text-[14px] font-semibold text-[var(--text-primary)]">{SECTION_META[sec].label}</span>
            <span className="text-[11px] text-[var(--text-muted)]">共 {list.length} 条</span>
          </div>
          {list.slice(0, 3).map((it, i) => (i === 0
            ? (
              <div
                key={it.id}
                onClick={() => onOpen(it)}
                data-intel-id={it.id}
                data-zh={it.titleZh ? '1' : undefined}
                data-en={isEnglishText(it.title) || (it.summary ? isEnglishText(it.summary) : false) ? '1' : undefined}
                className="kb-item-in mb-2 cursor-pointer rounded-[10px] border border-[var(--border-color)] bg-[var(--card-bg)] px-4 py-3.5 transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-hover)]"
                title={it.url}
              >
                <div className="mb-1.5 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                  <SourceBadge item={it} customNames={customNames} />
                  <span>{relTime(it.publishedAt || it.fetchedAt)}</span>
                  <span className="ml-auto font-mono">{it.score}</span>
                </div>
                <div className="mb-1 text-[15.5px] font-semibold leading-[1.45] text-[var(--text-primary)]">{it.title}</div>
                {it.titleZh && <div className="kb-view-in mb-1.5 line-clamp-2 text-[12.5px] leading-[1.6] text-[var(--text-muted)]">{it.titleZh}</div>}
                {it.summary && <div className="line-clamp-3 text-[12.5px] leading-[1.6] text-[var(--text-secondary)]">{it.summary}</div>}
                {it.summaryZh && <div className="kb-view-in mt-1 line-clamp-2 text-[12px] leading-[1.6] text-[var(--text-muted)]">{it.summaryZh}</div>}
              </div>
            )
            : (
              <div
                key={it.id}
                onClick={() => onOpen(it)}
                data-intel-id={it.id}
                data-zh={it.titleZh ? '1' : undefined}
                data-en={isEnglishText(it.title) ? '1' : undefined}
                className="kb-item-in flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 transition-colors hover:bg-[var(--bg-hover)]"
                title={it.url}
              >
                <span className="shrink-0 font-mono text-[10.5px] text-[var(--text-muted)]">{it.score}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)]">{it.title}</span>
                {it.titleZh && <span className="hidden min-w-0 max-w-[45%] truncate text-[11.5px] text-[var(--text-muted)] md:inline">{it.titleZh}</span>}
                <span className="shrink-0 text-[10.5px] text-[var(--text-muted)]">{relTime(it.publishedAt || it.fetchedAt)}</span>
              </div>
            )))}
        </section>
      ))}
    </div>
  )
}

/** 源徽标：内置源查 SOURCE_META，自定义源用用户命名 + 📰 绿 */
function SourceBadge({ item, customNames }: { item: IntelItem; customNames: Record<string, string> }) {
  const meta = SOURCE_META[item.source as IntelSourceKey]
  const label = meta?.label ?? customNames[item.source] ?? item.source
  const isCustom = !meta
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-2 py-[1.5px] text-[10.5px] font-semibold text-white"
      style={{ background: isCustom ? '#4f8f6a' : (meta?.fg ?? 'var(--text-muted)') }}
    >
      {isCustom && '📰'}{label}
    </span>
  )
}

function FilterPill({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="点掉该筛选"
      className="shrink-0 rounded-full border border-[var(--accent)] px-2 py-[1.5px] text-[11px] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10"
    >
      {label} ✕
    </button>
  )
}

/** 质量分档位色：≥80 绿 / ≥65 橙 / 其余主题色（对齐原型） */
function scoreColorCls(score: number): string {
  if (score >= 80) return 'bg-[var(--success)]'
  if (score >= 65) return 'bg-[var(--warning)]'
  return 'bg-[var(--accent)]'
}

function FeedCard({ item, index, pop, pendingZh, customNames, onOpen, onFav }: {
  item: IntelItem
  index: number
  pop: boolean
  /** 翻译已请求未返回（占位「译…」行，预留高度防卡片跳动） */
  pendingZh: boolean
  customNames: Record<string, string>
  onOpen: () => void
  onFav: () => void
}) {
  const meta = SOURCE_META[item.source as IntelSourceKey]
  const stars = item.stars
  const footExtra = item.kind === 'repo' && typeof item.extra?.forks === 'number'
    ? `🍴 ${item.extra.forks}`
    : item.kind === 'paper' && typeof item.extra?.citedBy === 'number'
      ? `被引 ${item.extra.citedBy}`
      : item.kind === 'news' && typeof item.extra?.comments === 'number'
        ? `💬 ${item.extra.comments}`
        : ''
  return (
    <div
      onClick={onOpen}
      data-intel-id={item.id}
      data-zh={item.titleZh ? '1' : undefined}
      data-en={isEnglishText(item.title) || (item.summary ? isEnglishText(item.summary) : false) ? '1' : undefined}
      className="kb-cv kb-item-in mb-2.5 cursor-pointer rounded-[10px] border border-[var(--border-color)] bg-[var(--card-bg)] px-3.5 py-3 transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-hover)]"
      style={{ animationDelay: `${Math.min(index * 30, 360)}ms` }}
      title={item.url}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className="inline-flex items-center gap-1 rounded px-2 py-[1.5px] text-[10.5px] font-semibold text-white"
          style={{ background: meta?.fg ?? '#4f8f6a' }}
        >
          {!meta && '📰'}{meta?.label ?? customNames[item.source] ?? item.source}
        </span>
        <span className="text-[11px] text-[var(--text-muted)]">{relTime(item.publishedAt || item.fetchedAt)}</span>
        <div className="ml-auto flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <div className="h-1 w-[52px] overflow-hidden rounded-full bg-[var(--border-color)]">
            <div className={`h-full rounded-full ${scoreColorCls(item.score)}`} style={{ width: `${Math.round(item.score)}%` }} />
          </div>
          <span className="min-w-[34px] text-right font-mono text-[11px] text-[var(--text-secondary)]">{item.score}</span>
        </div>
      </div>
      <div className="mb-1 text-[13.5px] font-semibold leading-[1.45] text-[var(--text-primary)]">{item.title}</div>
      {item.titleZh ? (
        <div className="kb-view-in mb-1 line-clamp-2 text-[12px] leading-[1.55] text-[var(--text-muted)]">{item.titleZh}</div>
      ) : pendingZh ? (
        <div className="mb-1 text-[12px] leading-[1.55] text-[var(--text-muted)] opacity-60">译…</div>
      ) : null}
      {item.summary && (
        <div className="line-clamp-2 text-[12px] leading-[1.55] text-[var(--text-secondary)]">{item.summary}</div>
      )}
      {item.summaryZh && (
        <div className="kb-view-in line-clamp-2 text-[12px] leading-[1.55] text-[var(--text-muted)]">{item.summaryZh}</div>
      )}
      <div className="mt-2 flex items-center gap-3.5">
        {typeof stars === 'number' && stars > 0 && (
          <span className="text-[11.5px] text-[var(--text-secondary)]">
            {item.kind === 'repo' ? `★ ${formatCount(stars)}` : `▲ ${formatCount(stars)}`}
          </span>
        )}
        {footExtra && <span className="text-[11.5px] text-[var(--text-secondary)]">{footExtra}</span>}
        {item.tags.length > 0 && (
          <span className="truncate text-[11px] text-[var(--text-muted)]">{item.tags.slice(0, 3).join(' · ')}</span>
        )}
        <span className="flex-1" />
        <button
          onClick={(e) => { e.stopPropagation(); onFav() }}
          title={item.fav ? '取消收藏' : '收藏'}
          className={`kb-micro-pop flex size-[26px] items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-tertiary)] ${
            item.fav ? 'text-[var(--danger)]' : 'text-[var(--text-muted)] hover:text-[var(--danger)]'
          }`}
        >
          <Heart size={14} className={pop ? 'kb-micro-pop' : ''} fill={item.fav ? 'currentColor' : 'none'} />
        </button>
      </div>
    </div>
  )
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function ListSkeleton() {
  return (
    <div className="animate-pulse">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="mb-2.5 h-[104px] rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-tertiary)]/60" />
      ))}
    </div>
  )
}
