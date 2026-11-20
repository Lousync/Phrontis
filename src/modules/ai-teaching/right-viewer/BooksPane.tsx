import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, BookOpen, Loader2, Maximize2, RefreshCw, Search } from 'lucide-react'
import { pdfReaderCoverList, pdfReaderListBooks } from '../../../lib/ipc'
import { useDataChanged } from '../../../lib/dataChanged'
import { showToast } from '../../../lib/toast'
import type { BookListItem } from '../../../types'
import { BookCover } from '../../bookshelf/BookCover'
import { bookEngineOf } from 'phrontis-core/kbStore/bookFormats'
import type { BooksPaneProps, PaneOpenRequest } from './paneContracts'
import {
  columnsForWidth, engineOfPath, filterBooks, formatBadge, progressLabel, progressOf, sortBooks,
} from './booksPanePure'

/**
 * AI 教学右侧查看器 · 书架页签（方案 `docs/ai-teaching-right-viewer-plan.md` §6.3）。
 *
 * 两个视图在组件内切换（`shelf | reader`，不新增路由、不借壳的状态）：
 *   1. 书架列表 —— 数据与 `src/modules/bookshelf/index.tsx` 同源（`pdfReaderListBooks` +
 *      `pdfReaderCoverList`），封面复用 `BookCover`（PdfCover 在它内部已经 lazy，铁律 20）；
 *   2. 阅读器宿主 —— 按 `bookEngineOf(relPath)` 挂三个现有阅读器，**一个引擎都不重写**。
 *
 * 已拍板的口径（内核文档 D2 / D3 / D5 / D7 / D8）：
 *   · D2 全格式：pdf / epub / fb2 / fbz / cbz / txt，全部落到现有三款阅读器上；
 *   · D3 不设固定工具条：阅读器外面**只**有一条 32px 返回行，翻页 / 目录 / 字号 / 书签
 *     全用阅读器自己的工具栏（窄栏下由它们自带的 `.kb-fit-pdfread` 容器查询收成图标）；
 *   · D5 切页签只隐藏不卸载：本组件不读 `active / open` 来卸载阅读器 —— 挂载/卸载只由
 *     「关闭书架页签（壳销毁本组件）」与「换书（relPath 变）」决定；
 *   · D7 进度按 (rootId, relPath) 共享：阅读器自己写 JSON，本面板靠 useDataChanged 重读清单；
 *   · D8 入口决定位置：右侧书架点开就在右侧读，「全屏阅读」把当前书交给壳（`onOpenFullscreen`）。
 *
 * 三条 Hook 纪律：所有 hook 在早退 return 之前；effect 依赖只放稳定引用；卸载时清防抖定时器。
 */

// 三个阅读器必须 lazy（铁律 20 / 契约 `.AGENT/scripts/pdf-reader/verify-epub-formats.mjs`）：
// pdfjs 与 foliate（+ zip 解包）都不许进首屏静态闭包。与 bookshelf/index.tsx 同一 specifier，
// Vite 侧共享 chunk，不会重复打一份。
const PdfReaderView = lazy(() => import('../../../components/shared/pdf/PdfReaderView').then((m) => ({ default: m.PdfReaderView })))
const TxtReaderView = lazy(() => import('../../../components/shared/txt/TxtReaderView').then((m) => ({ default: m.TxtReaderView })))
const EpubReaderView = lazy(() => import('../../../components/shared/epub/EpubReaderView').then((m) => ({ default: m.EpubReaderView })))

/** 清单重读去抖：同一次落盘往往连发 pdfReader + readerState 两个 scope，不去抖会连拉两次 */
const RELOAD_DEBOUNCE_MS = 300

/**
 * 仓库外书（D4）本批不支持：这类请求可能带 `externalToken`（壳的页签模型里有该字段，
 * `paneContracts.BooksPaneProps.request` 尚未上报），也可能直接给绝对路径。
 * **一律不猜路径、不读盘**，只回一条 Toast（§5.3 / 铁律：渲染层不接触绝对路径）。
 */
function isExternalRequest(req: PaneOpenRequest): boolean {
  const token = (req as PaneOpenRequest & { externalToken?: string }).externalToken
  if (typeof token === 'string' && token.trim()) return true
  const rel = String(req.relPath ?? '').trim()
  return rel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith('external:') || rel.startsWith('kbview:')
}

export function BooksPane(props: BooksPaneProps) {
  const { rootId, width, request, onOpenFullscreen } = props

  const [books, setBooks] = useState<BookListItem[] | null>(null)
  /** 封面缓存命中集（coverList 索引 + mtime 对账通过）—— 与书架模块同一判据 */
  const [coverHits, setCoverHits] = useState<Set<string>>(new Set())
  const [loadErr, setLoadErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  /** 当前打开的书（null = 书架视图）。换书 = 这个值变 → 旧阅读器卸载（D5 允许的卸载点之一） */
  const [openRelPath, setOpenRelPath] = useState<string | null>(null)
  const [openName, setOpenName] = useState('')
  /** 防抖定时器（防抖窗口清空必须置 null，铁律 4 的同款纪律） */
  const reloadTimer = useRef<number | null>(null)
  /** 最近一次消费过的 request.seq（同一 seq 不重复打开，seq 递增才动作） */
  const lastReqSeq = useRef(0)

  /**
   * 清单加载。`pdfReader:listBooks` 本身是**当前仓库口径**（主进程 `listBooksImpl` 读
   * `getCurrentVault()`），返回项里没有 rootId 字段 —— 所以本面板与 bookshelf/index.tsx 一样
   * **不做二次 rootId 过滤**（那会需要逐本 stat，且清单已是本仓库扫描结果）：
   * rootId 为空 = 没打开仓库 → 直接空态；有 rootId 就整份显示。
   */
  const load = useCallback(async () => {
    if (!rootId) {
      setBooks([])
      setCoverHits(new Set())
      setLoadErr('')
      return
    }
    setLoading(true)
    try {
      const [r, cv] = await Promise.all([pdfReaderListBooks(), pdfReaderCoverList()])
      if (!r.ok) throw new Error(r.error ?? 'listBooks failed')
      const next = r.books ?? []
      setBooks(next)
      const hits = new Set<string>()
      for (const b of next) {
        const entry = cv.ok ? cv.covers?.[`${rootId}/${b.relPath}`] : undefined
        if (entry && entry.mtimeMs === b.mtime) hits.add(b.relPath)
      }
      setCoverHits(hits)
      setLoadErr('')
    } catch (e) {
      setLoadErr(String((e as Error)?.message || e))
      setBooks([])
    } finally {
      setLoading(false)
    }
  }, [rootId])

  const scheduleReload = useCallback(() => {
    if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null
      void load()
    }, RELOAD_DEBOUNCE_MS)
  }, [load])

  useEffect(() => { void load() }, [load])
  useEffect(() => () => {
    if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
    reloadTimer.current = null
  }, [])

  // 阅读器自己写 JSON（pdfReader / readerState），fsWatcher 管外部变化（knowledge）——
  // 三条 scope 都只做一件事：稍后重读清单，返回书架即可看到新进度（D7）。
  useDataChanged('pdfReader', scheduleReload)
  useDataChanged('readerState', scheduleReload)
  useDataChanged('knowledge', scheduleReload)

  // 壳的一次性打开请求：seq 变化才动作（同一条书重复点也要能重新进阅读器）
  useEffect(() => {
    const req = request
    if (!req || req.seq === lastReqSeq.current) return
    lastReqSeq.current = req.seq
    const relPath = String(req.relPath ?? '').trim()
    if (!relPath) return
    if (isExternalRequest(req)) {
      showToast({ type: 'info', message: '仓库外文件下一批支持' })
      return
    }
    setOpenRelPath(relPath)
    setOpenName(String(req.name ?? '').trim())
  }, [request])

  const openBook = useCallback((b: BookListItem) => {
    setOpenRelPath(b.relPath)
    setOpenName(b.displayName)
  }, [])

  const backToShelf = useCallback(() => {
    // 只切视图，不动 books —— 进度由 scheduleReload 在后台刷新，返回即见（D7）
    setOpenRelPath(null)
    setOpenName('')
  }, [])

  /** 书名以清单为准（书市 meta 的 displayName 优先），request / 文件名只作兜底 —— 与书架同口径 */
  const openBookName = useMemo(() => {
    if (!openRelPath) return ''
    const hit = books?.find((b) => b.relPath === openRelPath)
    return hit?.displayName || openName || (openRelPath.split('/').pop() ?? '')
  }, [books, openRelPath, openName])

  const visibleBooks = useMemo(() => sortBooks(filterBooks(books ?? [], query)), [books, query])
  const cols = columnsForWidth(width)

  /* ============================ 阅读器宿主 ============================ */

  if (openRelPath && rootId) {
    const engine = bookEngineOf(openRelPath)
    return (
      <div className="flex h-full min-h-0 flex-col" role="region" aria-label="书架阅读器">
        {/* 唯一的自绘控件：32px 返回行（D3 —— 不设固定工具条，阅读器自身 toolbar 一字不动）。
            书名只在这一行出现一次（PDF 走 reader-only 不再画书名；txt/epub 工具栏里的书名
            是它们既有行为，未改）。 */}
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--border-color)] px-2">
          <button
            onClick={backToShelf}
            data-tip="返回书架"
            aria-label="返回书架"
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <ArrowLeft size={13} /><span>书架</span>
          </button>
          <div className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-[var(--text-primary)]">{openBookName}</div>
          {onOpenFullscreen && (
            <button
              onClick={() => onOpenFullscreen(openRelPath)}
              data-tip="全屏阅读"
              aria-label="全屏阅读"
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <Maximize2 size={12} />{width >= 460 && <span>全屏阅读</span>}
            </button>
          )}
        </div>
        <div key={openRelPath} className="kb-view-in min-h-0 flex-1">
          {engine === null ? (
            <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center text-[var(--text-muted)]">
              <BookOpen size={26} strokeWidth={1.5} />
              <div className="text-[12px]">这个格式还不支持阅读</div>
            </div>
          ) : (
            <Suspense
              fallback={(
                <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--text-muted)]">
                  <Loader2 size={20} className="animate-spin text-[var(--accent)]" />
                  <span className="text-[12px]">正在准备阅读器…</span>
                </div>
              )}
            >
              {engine === 'txt' ? (
                <TxtReaderView rootId={rootId} relPath={openRelPath} name={openBookName} />
              ) : engine === 'foliate' ? (
                <EpubReaderView rootId={rootId} relPath={openRelPath} name={openBookName} />
              ) : (
                <PdfReaderView rootId={rootId} relPath={openRelPath} name={openBookName} chrome="reader-only" />
              )}
            </Suspense>
          )}
        </div>
      </div>
    )
  }

  /* ============================== 书架列表 ============================== */

  const renderEmpty = () => {
    if (!rootId) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[var(--text-muted)]">
          <BookOpen size={30} strokeWidth={1.5} />
          <div className="text-[12px] leading-relaxed">还没有打开仓库。打开一个仓库后，书架会自动收拢其中的书。</div>
        </div>
      )
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-[var(--text-muted)]">
        <BookOpen size={30} strokeWidth={1.5} />
        <div className="max-w-[300px] text-[12px] leading-relaxed">
          书架还是空的。把 PDF / EPUB / TXT 放进仓库任意目录就会出现在这里。
        </div>
        <button
          onClick={() => { void load() }}
          className="flex items-center gap-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
        >
          <RefreshCw size={12} />刷新
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" role="region" aria-label="书架">
      {/* 顶部动作行 32px：搜索 + 刷新。不加任何说明文字（铁律 26） */}
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[var(--border-color)] px-2">
        <div className="relative min-w-0 flex-1">
          <Search size={12} className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索书名"
            aria-label="搜索书名"
            spellCheck={false}
            className="h-6 w-full rounded border border-[var(--border-color)] bg-[var(--bg-primary)] pl-6 pr-2 text-[11.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
          />
        </div>
        <button
          onClick={() => { void load() }}
          data-tip="刷新"
          aria-label="刷新书架"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loadErr && (
          <div className="mb-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-[11.5px] text-[var(--text-warning)]">
            书架加载失败：{loadErr}
          </div>
        )}

        {books === null && !loadErr && (
          <div className="flex h-full items-center justify-center gap-2 text-[var(--text-muted)]">
            <Loader2 size={16} className="animate-spin text-[var(--accent)]" />
            <span className="text-[11.5px]">正在扫描书架…</span>
          </div>
        )}

        {books !== null && visibleBooks.length === 0 && !loadErr && (
          /* 有书但被搜索过滤空 → 只给一行；本来就没书 → 完整空态（含刷新入口） */
          query.trim() ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-[11.5px] text-[var(--text-muted)]">
              没有匹配「{query.trim()}」的书
            </div>
          ) : renderEmpty()
        )}

        {visibleBooks.length > 0 && (
          <div className={`grid gap-2 ${cols === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {visibleBooks.map((b) => {
              const badge = formatBadge(engineOfPath(b.relPath))
              const label = progressLabel(b)
              const widthPct = Math.round(progressOf(b) * 100)
              return (
                <button
                  key={b.relPath}
                  onClick={() => openBook(b)}
                  /* 铁律 11：长列表的 content-visibility 只加在列表项上；行式卡片估 60px */
                  className="kb-item-in kb-cv-sm group flex min-w-0 items-center gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-2 text-left transition-colors hover:border-[var(--accent)]"
                  data-tip={b.relPath}
                  aria-label={`打开《${b.displayName}》`}
                >
                  <div className="relative w-[40px] shrink-0" style={{ aspectRatio: '3 / 4' }}>
                    <BookCover
                      kind={b.kind}
                      rootId={rootId}
                      relPath={b.relPath}
                      name={b.displayName}
                      coverRef={b.coverRef}
                      mtime={b.mtime}
                      cacheHit={coverHits.has(b.relPath)}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-[11.5px] font-medium leading-snug text-[var(--text-primary)]">{b.displayName}</div>
                    <div className="mt-1 flex items-center gap-1.5">
                      {badge && (
                        <span className="rounded border border-[var(--border-color)] px-1 text-[9px] leading-[14px] text-[var(--text-muted)]">
                          {badge}
                        </span>
                      )}
                      {label && <span className="truncate text-[10px] tabular-nums text-[var(--text-muted)]">{label}</span>}
                    </div>
                    <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
                      <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${widthPct}%` }} />
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
