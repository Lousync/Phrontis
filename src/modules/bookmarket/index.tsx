import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Info, Plus } from 'lucide-react'
import {
  bookMarketDownload, bookMarketDownloadControl, bookMarketListQueue, bookMarketListSources,
  bookMarketProbeSource, bookMarketRemoveSource, bookMarketSearch, bookMarketSetSourceEnabled,
  onBookMarketDownloadProgress, pdfReaderListBooks, workspaceGetCurrent,
} from '../../lib/ipc'
import { useDataChanged } from '../../lib/dataChanged'
import { showToast } from '../../lib/toast'
import { Collapsible } from '../../components/shared/Collapsible'
import type {
  BookDownloadAction, BookDownloadRequest, BookDownloadTask, BookMarketItem, BookSearchFailure,
  BookSourceConnectivity, BookSourceInfo,
} from '../../types'
import { DetailDrawer } from './DetailDrawer'
import { DiscoverView } from './DiscoverView'
import { DeleteSourceSheet, DuplicateSheet, type DuplicatePending } from './DuplicateSheet'
import { DownloadQueue } from './DownloadQueue'
import { CredentialSheet } from './CredentialSheet'
import { SourceFormSheet } from './SourceFormSheet'
import { SourcesView } from './SourcesView'
import { bookRelPathFor, itemKey, readHintDismissed, writeHintDismissed } from './shared'

/**
 * 书市（整窗独占模块，方案 §1.2 / §11.3）。
 *
 * 模块根 `h-full`（铁律 11：槽位容器是块级 div，flex-1 在里面是死属性）+ `data-wb="bookMarket"`（探针契约）。
 *
 * **状态全在这一层**：检索结果与滚动位置都不能因为切到「书源」页而丢（原型 `render(keepScroll)` 的语义），
 * 所以子视图是纯展示组件、连滚动容器都在这里。四个弹层同理，开合与载荷都收在这里 ——
 * 子组件自己管 state 的话，切视图 / 换选中项时的残留没法统一清。
 *
 * 三条数据纪律：
 * ① **队列不自己推演**：`bookMarketListQueue` 拉一次快照 + `onBookMarketDownloadProgress` 订阅，
 *   载荷就是整份 tasks，直接整体替换（拍板：不做增量合并）。
 * ② **已上架判定用的是下载器同一套命名函数**（`bookRelPathFor` → `safeBookFileName`），
 *   与 `pdfReaderListBooks` 的 relPath 集合比对。不另写一份命名规则，否则表象是「下好了还显示未上架」。
 * ③ **写盘后靠广播刷新**：书源增删改、下载完成都发 `bookMarket` scope，这一层挂 `useDataChanged('bookMarket')`
 *   重拉源清单 / 队列 / 已上架集合（铁律 18：漏挂的表象是「操作成功了、界面没反应」）。
 */

/** 视图态（与原型 `S.view` 同构） */
type View = 'discover' | 'sources'

export function BookMarketModule({ onOpenShelf }: { onOpenShelf?: () => void }) {
  const [rootId, setRootId] = useState<string | null>(null)
  const [view, setView] = useState<View>('discover')

  // —— 检索态 ——
  const [q, setQ] = useState('')
  const [srcFilter, setSrcFilter] = useState('all')
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [items, setItems] = useState<BookMarketItem[]>([])
  const [failed, setFailed] = useState<BookSearchFailure[]>([])
  const [searchErr, setSearchErr] = useState('')
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [stuck, setStuck] = useState(false)
  const [selKey, setSelKey] = useState<string | null>(null)
  /** 已出现过的条目键（分页去重 + 「本页没带来新条目就收掉加载更多」的判据，见 runSearch） */
  const seenKeys = useRef<Set<string>>(new Set())
  /** 同一时刻只发一轮检索（连点「加载更多」不能并发出两轮，否则分页会互相覆盖） */
  const searching = useRef(false)

  // —— 书源态 ——
  const [sources, setSources] = useState<BookSourceInfo[]>([])
  const [conn, setConn] = useState<Record<string, BookSourceConnectivity>>({})
  const [testing, setTesting] = useState<string | null>(null)

  // —— 下载态 ——
  const [tasks, setTasks] = useState<BookDownloadTask[]>([])
  const [queueOpen, setQueueOpen] = useState(false)
  /** `.books/` 里已有的文件 relPath 集合（已上架判定） */
  const [installed, setInstalled] = useState<Set<string>>(new Set())

  // —— 弹层态 ——
  const [hintOpen, setHintOpen] = useState(() => !readHintDismissed())
  const [credSource, setCredSource] = useState<BookSourceInfo | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [formSource, setFormSource] = useState<BookSourceInfo | null>(null)
  const [dupe, setDupe] = useState<DuplicatePending | null>(null)
  const [delSource, setDelSource] = useState<BookSourceInfo | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const selItem = selKey ? (items.find((it) => itemKey(it) === selKey) ?? null) : null

  // ── 装载 ──
  const loadSources = useCallback(async (rid: string) => {
    const r = await bookMarketListSources(rid)
    if (r.ok) setSources(r.sources ?? [])
    else showToast({ type: 'warning', message: `书源清单读取失败${r.error ? `：${r.error}` : ''}` })
  }, [])

  const loadQueue = useCallback(async (rid: string) => {
    const r = await bookMarketListQueue(rid)
    if (r.ok) setTasks(r.tasks ?? [])
  }, [])

  const loadInstalled = useCallback(async () => {
    const r = await pdfReaderListBooks()
    setInstalled(new Set((r.books ?? []).map((b) => b.relPath)))
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      const cur = await workspaceGetCurrent()
      if (!alive) return
      if (!cur?.rootId) { setRootId(null); return }
      setRootId(cur.rootId)
      await Promise.all([loadSources(cur.rootId), loadQueue(cur.rootId), loadInstalled()])
    })()
    return () => { alive = false }
  }, [loadSources, loadQueue, loadInstalled])

  // 队列快照推送：载荷 = 整份队列，整体替换（不合并）
  useEffect(() => {
    const off = onBookMarketDownloadProgress((p) => {
      if (p.rootId && rootId && p.rootId !== rootId) return
      setTasks(p.tasks)
      // 有活干的时候把面板亮出来（用户点了下载 → 得看见它动了）；不自动收起
      if (p.tasks.some((t) => t.state === 'down' || t.state === 'queued')) setQueueOpen(true)
    })
    return off
  }, [rootId])

  // 铁律 1/18：主进程写完盘发 bookMarket（源增删改 / 下载完成 / 元数据自愈）→ 这里重拉
  useDataChanged('bookMarket', () => {
    if (!rootId) return
    void loadSources(rootId)
    void loadQueue(rootId)
    void loadInstalled()
  })
  // 往 .books/ 丢文件或从外面删文件（fsWatcher 发 knowledge scope）→ 已上架集合跟着变
  useDataChanged('knowledge', () => { void loadInstalled() })

  // ── 检索 ──
  const runSearch = useCallback(async (toPage: number, append: boolean) => {
    if (!rootId || searching.current) return
    const kw = q.trim()
    if (!kw) {
      // 清空关键词 = 回到初始态（不保留上一次的结果，免得「搜了 A、框里是空的」）
      searching.current = false
      seenKeys.current = new Set()
      setSearched(false); setItems([]); setFailed([]); setSearchErr('')
      setPage(1); setHasMore(false); setSelKey(null)
      return
    }
    searching.current = true
    setLoading(true)
    setSearchErr('')
    try {
      const opts: { sourceIds?: string[]; page?: number } = { page: toPage }
      if (srcFilter !== 'all') opts.sourceIds = [srcFilter]
      const r = await bookMarketSearch(rootId, kw, opts)
      if (!r.ok) {
        setSearchErr(r.error ?? '未知错误')
        if (!append) { setItems([]); setFailed([]); setSearched(true); setHasMore(false) }
        return
      }
      const got = r.items ?? []
      setFailed(r.failed ?? [])
      // 检索**顺手**带回每个源的连通性 —— 不必再为书源页单独发一轮探测
      if (r.connectivity) setConn((prev) => ({ ...prev, ...r.connectivity }))
      if (append) {
        const fresh = got.filter((it) => !seenKeys.current.has(itemKey(it)))
        for (const it of fresh) seenKeys.current.add(itemKey(it))
        if (fresh.length) setItems((prev) => [...prev, ...fresh])
        // ★ 本页一条**新**条目都没带来（源不认 page 参数、或无更多结果）⇒ 立刻收掉「加载更多」。
        //   留着它 = 一个点了没反应的按钮，比没有按钮更糟。
        setHasMore(fresh.length > 0)
      } else {
        seenKeys.current = new Set(got.map(itemKey))
        setItems(got)
        setHasMore(got.length > 0)
        setSelKey(null)
      }
      setPage(toPage)
      setSearched(true)
    } finally {
      searching.current = false
      setLoading(false)
    }
  }, [rootId, q, srcFilter])

  const search = useCallback(() => { void runSearch(1, false) }, [runSearch])
  const loadMore = useCallback(() => { void runSearch(page + 1, true) }, [runSearch, page])

  // ── 下载 ──
  const startDownload = useCallback(async (it: BookMarketItem, conflict?: 'overwrite' | 'copy') => {
    if (!rootId) return
    const payload: BookDownloadRequest = {
      sourceId: it.sourceId,
      sourceName: it.sourceName,
      title: it.title,
      author: it.author,
      downloadUrl: it.downloadUrl,
      coverUrl: it.coverUrl,
      ext: it.ext,
      sizeBytes: it.sizeBytes ?? 0,
    }
    const r = await bookMarketDownload(rootId, payload, conflict)
    if (r.ok) {
      setDupe(null)
      setQueueOpen(true)
      if (conflict) showToast({ type: 'info', message: conflict === 'overwrite' ? '已按覆盖重新入队' : '已按另存副本重新入队' })
      return
    }
    if ('conflict' in r && r.conflict) {
      // 同名文件：主进程**不静默决定**，把回执交回界面问一句，然后带 conflict 重调（见 DuplicateSheet）
      setDupe({ item: it, payload, relPath: r.relPath, fileName: r.fileName, title: it.title, ext: it.ext })
      return
    }
    showToast({ type: 'error', message: `下载失败${'error' in r && r.error ? `：${r.error}` : ''}` })
  }, [rootId])

  const controlQueue = useCallback(async (id: string, action: BookDownloadAction) => {
    if (!rootId) return
    const r = await bookMarketDownloadControl(rootId, id, action)
    if (!r.ok) showToast({ type: 'warning', message: `队列操作没生效${r.error ? `：${r.error}` : ''}` })
    // 成功不自己改本地数组：主进程会把新快照推回来（快照是唯一真相）
  }, [rootId])

  // ── 书源 ──
  const testSource = useCallback(async (s: BookSourceInfo) => {
    if (!rootId) return
    setTesting(s.id)
    const r = await bookMarketProbeSource(rootId, s.id)
    setTesting(null)
    setConn((prev) => ({ ...prev, [s.id]: r.state }))
    showToast({
      type: r.state === 'ok' ? 'success' : 'warning',
      message: `${s.name}：${r.state === 'ok' ? '连接正常' : r.state === 'need-credential' ? '需要凭据' : '连接失败'}`,
    })
  }, [rootId])

  const toggleSource = useCallback(async (s: BookSourceInfo) => {
    if (!rootId) return
    const r = await bookMarketSetSourceEnabled(rootId, s.id, !s.enabled)
    if (!r.ok) { showToast({ type: 'warning', message: `没能改状态${r.error ? `：${r.error}` : ''}` }); return }
    setSources((prev) => prev.map((x) => (x.id === s.id ? (r.source ?? { ...x, enabled: !x.enabled }) : x)))
    if (!s.enabled) return
    // 停用后它不再参与检索 —— 提示一句，免得用户以为还能搜到
    showToast({ type: 'info', message: `${s.name} 已停用 · 不再参与检索` })
  }, [rootId])

  const deleteSource = useCallback(async (s: BookSourceInfo) => {
    if (!rootId) return
    const r = await bookMarketRemoveSource(rootId, s.id)
    if (!r.ok) { showToast({ type: 'error', message: `删除失败${r.error ? `：${r.error}` : ''}` }); return }
    setSources((prev) => prev.filter((x) => x.id !== s.id))
    setConn((prev) => { const next = { ...prev }; delete next[s.id]; return next })
    setDelSource(null)
    showToast({ type: 'success', message: `${s.name} 已删除（已下载的书不受影响）` })
  }, [rootId])

  /** 弹层保存后的统一回收：可能的**新源**要进清单，连通性直接用探测结果，别让用户再点一次「测试」 */
  const onSheetSaved = useCallback((id: string | null, state: BookSourceConnectivity | null) => {
    if (rootId) void loadSources(rootId)
    if (id && state) setConn((prev) => ({ ...prev, [id]: state }))
  }, [rootId, loadSources])

  const installedOf = useCallback((it: BookMarketItem) => installed.has(bookRelPathFor(it)), [installed])
  // 任务按下载地址配（条目身份就是源 + 地址）；地址缺失时退回落盘路径比对
  const taskOf = useCallback((it: BookMarketItem) => (
    tasks.find((t) => (t.url && it.downloadUrl ? t.url === it.downloadUrl : t.relPath === bookRelPathFor(it)))
  ), [tasks])

  const activeCount = tasks.filter((t) => t.state === 'down' || t.state === 'queued' || t.state === 'paused').length
  const goShelf = useCallback(() => { onOpenShelf?.() }, [onOpenShelf])

  const SEG = 'rounded-[6px] px-3 py-1 text-[12px] transition-colors'
  const segOn = 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
  const pill = 'flex h-7 items-center gap-1.5 rounded-[8px] border border-[var(--border-color)] px-2.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'

  return (
    <div data-wb="bookMarket" className="relative flex h-full flex-col bg-[var(--bg-primary)]">
      {/* 模块栏：视图分段 + 两个 pill（新增书源 / 下载） */}
      <div className="flex h-[46px] flex-none items-center gap-2.5 border-b border-[var(--border-color)] px-3.5">
        <div className="flex gap-[2px] rounded-[8px] bg-[var(--bg-tertiary)] p-[2px]">
          <button type="button" className={`${SEG} ${view === 'discover' ? segOn : 'text-[var(--text-secondary)]'}`} onClick={() => setView('discover')}>发现</button>
          <button type="button" className={`${SEG} ${view === 'sources' ? segOn : 'text-[var(--text-secondary)]'}`} onClick={() => setView('sources')}>书源</button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className={pill} onClick={() => { setFormSource(null); setFormOpen(true) }}>
            <Plus size={13} strokeWidth={1.9} />
            新增书源
          </button>
          <button type="button" className={pill} onClick={() => setQueueOpen((v) => !v)} title="下载队列">
            <Download size={13} strokeWidth={1.8} />
            下载
            {activeCount > 0 && (
              <span className="grid h-4 min-w-4 place-items-center rounded-full bg-[var(--accent)] px-1 text-[10px] text-white tabular-nums">{activeCount}</span>
            )}
          </button>
        </div>
      </div>

      {/* 首启提示条（help-disclosure C 形态：默认可见 + 「知道了」+ localStorage 记忆）。
          收起走 .kb-collapse（外层 grid 常驻，不是条件渲染）—— 铁律 13：一切开合都要有动效。
          文案是 2026-09-22 §九 ④ 订正过的口径：不可读的格式标「暂不支持」，
          而**不是**旧的「EPUB 依赖二期引擎」（epub 引擎早已落地，旧文案是错的）。 */}
      <Collapsible open={hintOpen} className="flex-none" innerClassName="">{() => (
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] bg-[var(--warning-bg)] px-3.5 py-2 text-[12px] text-[var(--text-secondary)]">
          <Info size={14} strokeWidth={1.7} className="flex-none" />
          <span>
            <b className="font-medium text-[var(--text-primary)]">只下载书架打得开的格式（epub / pdf / txt / fb2 / fbz / cbz）。</b>
            源里其余格式会标「暂不支持」并禁用下载 —— 扫描时会被跳过，下了也看不见。
          </span>
          <button
            type="button"
            className="ml-auto flex-none rounded-md px-1.5 py-0.5 text-[var(--accent)] transition-colors hover:bg-[var(--bg-hover)]"
            onClick={() => { writeHintDismissed(); setHintOpen(false) }}
          >
            知道了
          </button>
        </div>
      )}</Collapsible>

      {/* 舞台：滚动容器与详情抽屉是兄弟 —— 抽屉 absolute 覆盖在舞台上，不随内容滚走 */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="h-full overflow-y-auto"
          onScroll={(e) => {
            const s = e.currentTarget.scrollTop > 4
            setStuck((prev) => (prev === s ? prev : s))
          }}
        >
          {view === 'discover' ? (
            <DiscoverView
              q={q} setQ={setQ}
              srcFilter={srcFilter} setSrcFilter={setSrcFilter}
              sources={sources}
              loading={loading} searched={searched}
              items={items} failed={failed} searchErr={searchErr}
              hasMore={hasMore} stuck={stuck} selKey={selKey}
              onSearch={search} onLoadMore={loadMore}
              onSelect={(k) => setSelKey((prev) => (prev === k ? null : k))}
              onGoSources={() => setView('sources')}
              installedOf={installedOf} taskOf={taskOf}
            />
          ) : (
            <SourcesView
              sources={sources} conn={conn} testing={testing}
              onTest={(s) => { void testSource(s) }}
              onToggle={(s) => { void toggleSource(s) }}
              onCredentials={(s) => setCredSource(s)}
              onEdit={(s) => { setFormSource(s); setFormOpen(true) }}
              onDelete={(s) => setDelSource(s)}
            />
          )}
        </div>

        <DetailDrawer
          item={selItem}
          task={selItem ? taskOf(selItem) : undefined}
          installed={selItem ? installedOf(selItem) : false}
          onClose={() => setSelKey(null)}
          onDownload={() => selItem && void startDownload(selItem)}
          onRetry={() => selItem && void startDownload(selItem)}
          onShowQueue={() => setQueueOpen(true)}
          onOpenShelf={goShelf}
        />
      </div>

      <DownloadQueue
        open={queueOpen}
        tasks={tasks}
        onClose={() => setQueueOpen(false)}
        onControl={(id, action) => { void controlQueue(id, action) }}
        onOpenShelf={goShelf}
      />

      {/* 四个弹层：开合与载荷都由这一层持有（子组件不管自己的可见性） */}
      <CredentialSheet
        source={credSource}
        rootId={rootId ?? ''}
        onClose={() => setCredSource(null)}
        onSaved={(id, state) => { onSheetSaved(id, state) }}
      />
      <SourceFormSheet
        open={formOpen}
        source={formSource}
        rootId={rootId ?? ''}
        onClose={() => setFormOpen(false)}
        onSaved={(id, state) => { onSheetSaved(id, state) }}
      />
      <DuplicateSheet
        pending={dupe}
        onClose={() => setDupe(null)}
        onGo={(how) => { if (dupe) void startDownload(dupe.item, how) }}
      />
      <DeleteSourceSheet
        source={delSource}
        onClose={() => setDelSource(null)}
        onConfirm={(s) => { void deleteSource(s) }}
      />
    </div>
  )
}
