import { lazy, useCallback, useEffect, useRef, useState, Suspense } from 'react'
import { BookOpen, Loader2, Play, Trash2 } from 'lucide-react'
import {
  bookMarketDeleteBook, pdfReaderCoverList, pdfReaderListBooks, workspaceGetCurrent,
} from '../../lib/ipc'
import { useDataChanged } from '../../lib/dataChanged'
import { useContextMenuPosition } from '../../lib/useContextMenuPosition'
import { showGlobalConfirm } from '../../lib/globalConfirm'
import { showToast } from '../../lib/toast'
import { DeleteWipe } from '../../components/shared/DeleteWipe'
import type { BookKind, BookListItem } from '../../types'
import { BookCover } from './BookCover'
import { bookEngineOf } from '../../../electron/lib/kbStore/bookFormats'

// 2026-09-17 拍板「书架内自渲染」：点书在书架标签页内部打开阅读器（书架 ⇄ 阅读器），
// 不再借编辑器文档标签（编辑器 PDF 能力保留给知识库附件等既有入口）。
// PdfReaderView 内含 pdfjs —— lazy 拆 chunk（与 editor 同一模块Specifier，Vite 去重共享 chunk）。
// TxtReaderView 同口径 lazy（纯渲染层，chunk 极小，但对齐拆分惯例）。
// EpubReaderView（B 段）lazy 是**硬要求**：foliate 引擎 + zip 解包都不许进首屏静态闭包（铁律 20）。
const PdfReaderView = lazy(() => import('../../components/shared/pdf/PdfReaderView').then((m) => ({ default: m.PdfReaderView })))
const TxtReaderView = lazy(() => import('../../components/shared/txt/TxtReaderView').then((m) => ({ default: m.TxtReaderView })))
const EpubReaderView = lazy(() => import('../../components/shared/epub/EpubReaderView').then((m) => ({ default: m.EpubReaderView })))

/**
 * 书架（v3.4.0 PDF 阅读体验整包批次 2，方案 §2/§8）：
 * - 自动库 = 扫仓库顶层 `.books/` 目录的全部 .pdf（pdfReader:listBooks），清单不落盘；
 *   `.books` 为点前缀系统区，笔记区不显示；目录不存在时主进程自动创建（2026-09-19 拍板）。
 * - 封面网格（PdfCover 懒渲染 + covers 缓存）；续读条（hasProgress 按最近读排序）；
 * - 点书 = kb-open-note { relPath, from:'bookshelf' }（state+props 范式，编辑器组文档标签每书一个）。
 * 模块根节点 h-full（槽位容器是块级 div，flex-1 无效）。
 */

type SortFn = (a: BookListItem, b: BookListItem) => number

/** 排序 = 最近读优先（updatedAt desc），未读按名称（方案 §8） */
const byRecent: SortFn = (a, b) => {
  const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0
  const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0
  if (ta !== tb) return tb - ta
  // 按展示名排（书市下到的书有正式书名，按文件名排会把它塞到「作者-书名」那一堆里）
  return a.displayName.localeCompare(b.displayName, 'zh-Hans')
}

export function BookshelfModule({ isActive = true, reading = null, onOpenBook, onCloseBook }: {
  isActive?: boolean
  /** 正在阅读的书（状态上收 App：书架模块消费 + 左栏大纲态跟随 + 右栏阅读入口），kind 决定阅读引擎 */
  reading?: { relPath: string; name: string; kind: BookKind } | null
  onOpenBook?: (relPath: string, name: string, kind: BookKind) => void
  onCloseBook?: () => void
}) {
  const [rootId, setRootId] = useState<string | null>(null)
  const [books, setBooks] = useState<BookListItem[] | null>(null)
  /** 封面缓存命中集（coverList 索引 + mtime 对账通过）——PdfCover 据此走 coverGet 直取 */
  const [coverHits, setCoverHits] = useState<Set<string>>(new Set())
  const [loadErr, setLoadErr] = useState('')
  /** 封面内存缓存 relPath → dataUrl（滚动往返免重复取/渲染） */
  const coverMem = useRef(new Map<string, string>())
  const [, forceTick] = useState(0)
  /** 删除动画状态（键 = relPath）：animating 播红色吞噬、done 收尾淡出 */
  const [deletingMap, setDeletingMap] = useState<Map<string, 'animating' | 'done'>>(new Map())
  /** 正在删除的书（`load()` 据此别把卡片提前抽走；用 ref 因为 load 是 useCallback） */
  const deletingRef = useRef(new Set<string>())
  /** 右键菜单锚点（书籍卡片 → 删除书籍） */
  const [ctxMenu, setCtxMenu] = useState<{ relPath: string; x: number; y: number } | null>(null)
  const { menuRef: ctxMenuRef, style: ctxMenuStyle } = useContextMenuPosition(ctxMenu)

  const load = useCallback(async () => {
    try {
      const cur = await workspaceGetCurrent()
      if (!cur?.rootId) {
        setRootId(null)
        setBooks([])
        setCoverHits(new Set())
        return
      }
      setRootId(cur.rootId)
      const [r, cv] = await Promise.all([pdfReaderListBooks(), pdfReaderCoverList()])
      if (!r.ok) throw new Error(r.error ?? 'listBooks failed')
      const nextBooks = r.books ?? []
      // 删除动画进行中的书：磁盘上已经没了，但卡片要留在 UI 上把动画播完 ——
      // 否则删除后主进程的广播会立刻触发本函数，卡片在动画播完前就被抽走（.kb-deleting 白挂）。
      // 保留 prev 的顺序，真正新增的书追加在后（网格渲染前还会 byRecent 重排）。
      setBooks((prev) => {
        if (!prev) return nextBooks
        const nextSet = new Set(nextBooks.map((b) => b.relPath))
        const kept = prev.filter((b) => nextSet.has(b.relPath) || deletingRef.current.has(b.relPath))
        const keptSet = new Set(kept.map((b) => b.relPath))
        return [...kept, ...nextBooks.filter((b) => !keptSet.has(b.relPath))]
      })
      setLoadErr('')
      // 索引命中 = 键存在 + mtime 与当前扫描一致（方案 §3：不符即失效重渲染）
      const hits = new Set<string>()
      for (const b of nextBooks) {
        const entry = cv.ok ? cv.covers?.[`${cur.rootId}/${b.relPath}`] : undefined
        if (entry && entry.mtimeMs === b.mtime) hits.add(b.relPath)
      }
      setCoverHits(hits)
    } catch (e) {
      setLoadErr(String((e as Error)?.message || e))
      setBooks([])
    }
  }, [])

  useEffect(() => { void load() }, [load])
  // 铁律 1：主进程写盘（patch/coverSave）后经 windowBus 广播 → 书架自动重拉
  useDataChanged('pdfReader', () => { void load() })
  // 外部 fs 变化（往 .books 丢/删 PDF → fsWatcher 广播 knowledge scope）→ 清单重扫（2026-09-19 反馈）
  useDataChanged('knowledge', () => { void load() })
  // 书市下载完成（downloader 写盘后广播 bookMarket）→ 新书立刻上架
  // （铁律 18：新模块的 scope 不加这一行，表象就是「AI/主进程说下好了、书架里没有」）
  useDataChanged('bookMarket', () => { void load() })

  const onCoverReady = useCallback((relPath: string, url: string) => {
    coverMem.current.set(relPath, url)
    forceTick((t) => t + 1)
  }, [])

  /**
   * 右键「删除书籍」：确认 → 播吞噬动画 → 调 IPC → 收尾淡出 → 本地移除。
   * 时序照抄 knowledge 模块的 deleteWithAnimation：动画整段走完才刷新，卡片不会半途消失。
   * 主进程那条 handler 内部已广播 pdfReader/knowledge/readerState/excerpt，finally 里的 load() 拿新清单。
   */
  const deleteBook = useCallback(async (b: BookListItem) => {
    if (!rootId || deletingRef.current.has(b.relPath)) return
    const ok = await showGlobalConfirm({
      title: '删除书籍',
      message: `《${b.displayName}》将从书库中删除：\n· 书籍文件移入系统回收站\n· 阅读进度、书签、摘录一并删除，且不可恢复\n· 已导出的「读书笔记」页面保留`,
      confirmLabel: '删除',
      cancelLabel: '取消',
      variant: 'danger',
    })
    if (ok !== true) return
    // 正常路径下书架网格与阅读器不会同屏（阅读时整块换成阅读器），此处只是防线
    if (reading?.relPath === b.relPath) onCloseBook?.()
    deletingRef.current.add(b.relPath)
    setDeletingMap((m) => new Map(m).set(b.relPath, 'animating'))
    try {
      const r = await bookMarketDeleteBook(rootId, b.relPath)
      if (r.ok) showToast({ type: 'success', message: `已删除《${b.displayName}》` })
      else showToast({ type: 'warning', message: `《${b.displayName}》已删除，但部分清理未完成`, detail: r.errors.join('；') })
      setDeletingMap((m) => new Map(m).set(b.relPath, 'done'))
      await new Promise<void>((res) => setTimeout(res, 420))
    } catch (e) {
      showToast({ type: 'error', message: '删除失败', detail: String((e as Error)?.message || e) })
    } finally {
      deletingRef.current.delete(b.relPath)
      setDeletingMap((m) => { const n = new Map(m); n.delete(b.relPath); return n })
      void load()
    }
  }, [rootId, reading?.relPath, onCloseBook, load])

  /** 删除动画卡片附加类（.kb-deleting 自带 position:relative + pointer-events:none） */
  const delCls = (relPath: string) => {
    const st = deletingMap.get(relPath)
    return st === 'animating' ? ' kb-deleting' : st === 'done' ? ' kb-deleting kb-done' : ''
  }

  // 左栏 bookshelf 模块态（批次 6）：三件套（目录/缩略图/书签）经 portal 挂进左栏 slot
  const openBook = useCallback((b: BookListItem) => {
    onOpenBook?.(b.relPath, b.displayName, b.kind)
  }, [onOpenBook])

  // 阅读视图（书架 ⇄ 阅读器，模块内切换；Hook 全部在早退之前）
  if (reading) {
    const engine = bookEngineOf(reading.relPath) ?? 'pdf'
    // 工具栏书名以**清单里的展示名为准**，`reading.name` 只作兜底（S4 收口 2026-09-22）：
    // 「摘录 → 回到原文」这条路只有 relPath、手上没有 DTO，App 那边只能拿文件名兜底，
    // 于是同一本书从书架点进去显示书名、从摘录点进去显示文件名 —— 两处不一致。
    // 书架自己就拿着清单，这里覆盖一次即可（不在渲染层重算 meta，没有第二份推导）。
    const readingName = books?.find((b) => b.relPath === reading.relPath)?.displayName ?? reading.name
    return (
      <div className="flex h-full min-h-0 flex-col bg-[var(--bg-primary)]">
        {/* 2026-09-18：原「返回书架 + 书名」独立行已并入阅读器工具栏。
            两处原因：① 书名此前在模块顶行与阅读器工具栏**各显示一次**（重复）；
            ② 这一行白占掉一整行阅读高度。返回入口不丢 —— 作阅读器工具栏最左的「← 返回书架」
            （窄容器下自动收成纯图标，见 index.css 的 .kb-fit-pdfread 容器查询）。 */}
        <div className="min-h-0 flex-1">
          {rootId ? (
            <Suspense fallback={
              <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--text-muted)]">
                <Loader2 size={22} className="animate-spin text-[var(--accent)]" />
                <span className="text-[12px]">正在准备阅读器…</span>
              </div>
            }>
              {/* 按**引擎**分发而非 kind 二值：引擎表在 bookFormats（唯一真相源），
                  阶段 2 的 fb2/fbz/cbz 落 'foliate' 后这里一行都不用改。
                  engine 由 relPath 推导而非读 state.kind —— 历史脏 state（旧版把 .epub 固定成 'txt'）
                  也能被纠正回正确引擎（与 readerStateVaultRepo 的 kindOfPath 同一原则）。 */}
              {engine === 'txt' ? (
                <TxtReaderView rootId={rootId} relPath={reading.relPath} name={readingName}
                  backLabel="返回书架" onBack={() => onCloseBook?.()} />
              ) : engine === 'foliate' ? (
                <EpubReaderView rootId={rootId} relPath={reading.relPath} name={readingName}
                  backLabel="返回书架" onBack={() => onCloseBook?.()} />
              ) : (
                <PdfReaderView rootId={rootId} relPath={reading.relPath} name={readingName}
                  backLabel="返回书架" onBack={() => onCloseBook?.()} />
              )}
            </Suspense>
          ) : null}
        </div>
      </div>
    )
  }
  // 未打开仓库
  if (rootId === null && books !== null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--bg-primary)] text-[var(--text-muted)]">
        <BookOpen size={40} strokeWidth={1.5} />
        <div className="text-[13.5px]">书架</div>
        <div className="max-w-[280px] text-center text-[11.5px] leading-relaxed">先打开一个仓库，书架会自动收拢 .books 目录里的书</div>
      </div>
    )
  }

  const list = books ?? []
  const continueList = list.filter((b) => b.hasProgress).slice(0, 6)
  const gridList = [...list].sort(byRecent)

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-primary)]">
      {/* 「书架 N 本」标题横排已删（2026-09-19 反馈：多余——页面条已有书架条目、左栏条目视图亦有头部，
          与博客主区顶部行同口径）。主区直接从续读条/封面网格开始 */}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loadErr && (
          <div className="mb-3 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-[12px] text-[var(--text-warning)]">
            书架加载失败：{loadErr}
          </div>
        )}

        {books !== null && list.length === 0 && !loadErr && (
          /* 空态只留图标（2026-09-19 反馈：不要多余的文字说明，中心区同口径） */
          <div className="flex h-full flex-col items-center justify-center text-[var(--text-muted)]">
            <BookOpen size={40} strokeWidth={1.4} />
          </div>
        )}

        {/* 续读条 */}
        {continueList.length > 0 && (
          <div className="mb-4">
            <div className="mb-2 text-[11.5px] font-medium text-[var(--text-tertiary)]">续读</div>
            <div className="flex gap-2.5 overflow-x-auto pb-1">
              {continueList.map((b) => (
                <button
                  key={`c-${b.relPath}`}
                  onClick={() => openBook(b)}
                  onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ relPath: b.relPath, x: e.clientX, y: e.clientY }) }}
                  className={`kb-item-in group flex w-[210px] shrink-0 items-center gap-2.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-2 text-left hover:border-[var(--accent)]${delCls(b.relPath)}`}
                  title={b.kind !== 'pdf' ? `已读 ${b.pct ?? 0}% · 打开继续阅读` : `第 ${b.lastPage} 页 · 打开继续阅读`}
                >
                  <div className="relative w-[44px] shrink-0" style={{ aspectRatio: '3 / 4' }}>
                    <BookCover kind={b.kind} rootId={rootId ?? ''} relPath={b.relPath} name={b.displayName} coverRef={b.coverRef} mtime={b.mtime} cacheHit={coverHits.has(b.relPath) || coverMem.current.has(b.relPath)} onReady={(u) => onCoverReady(b.relPath, u)} />
                    {deletingMap.get(b.relPath) === 'animating' && <DeleteWipe />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium text-[var(--text-primary)]">{b.displayName}</div>
                    {/* 作者行：仅书市下到的书有（本地导入的书 meta 为空，不给空行占位）
                        ★ 用 --text-muted 而非 --text-tertiary：后者**全库未定义**（只有 --bg-tertiary），
                          写它等于 color 失效回落继承色。此处按「比书名淡一档」的意图用已定义的 muted。 */}
                    {b.author && (
                      <div className="mt-0.5 truncate text-[10.5px] text-[var(--text-muted)]">{b.author}</div>
                    )}
                    <div className="mt-1 flex items-center gap-1 text-[11px] text-[var(--accent)]">
                      <Play size={10} />{b.kind !== 'pdf' ? `已读 ${b.pct ?? 0}%` : `第 ${b.lastPage} 页`}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 封面网格 */}
        {gridList.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-3">
            {gridList.map((b) => (
              <button
                key={b.relPath}
                onClick={() => openBook(b)}
                onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ relPath: b.relPath, x: e.clientX, y: e.clientY }) }}
                className={`kb-item-in group text-left${delCls(b.relPath)}`}
                title={b.relPath}
              >
                <div className="relative transition-shadow group-hover:shadow-[0_8px_22px_rgba(0,0,0,0.14)] rounded-[10px]">
                  <BookCover kind={b.kind} rootId={rootId ?? ''} relPath={b.relPath} name={b.displayName} coverRef={b.coverRef} mtime={b.mtime} cacheHit={coverHits.has(b.relPath) || coverMem.current.has(b.relPath)} onReady={(u) => onCoverReady(b.relPath, u)} />
                  {deletingMap.get(b.relPath) === 'animating' && <DeleteWipe />}
                  {b.kind === 'pdf' && b.hasProgress && (
                    <span className="absolute bottom-1.5 right-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white">P{b.lastPage}</span>
                  )}
                  {/* 判据 `!== 'pdf'`（pct 口径覆盖 txt / epub）：写成 `=== 'txt'` 新格式就丢了角标 */}
                  {b.kind !== 'pdf' && (b.pct ?? 0) > 0 && (
                    <span className="absolute bottom-1.5 right-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white">{b.pct}%</span>
                  )}
                  {b.kind === 'pdf' && b.scan === 'no' && (
                    <span className="absolute bottom-1.5 left-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white">扫描版</span>
                  )}
                </div>
                <div className="mt-1.5 truncate px-0.5 text-[11.5px] text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">{b.displayName}</div>
                {/* 作者行（S4 拍板 ②）：meta.author 非空才渲染 —— 本地导入的书不留空行
                    （颜色同续读条：--text-muted，理由见上） */}
                {b.author && (
                  <div className="truncate px-0.5 text-[10.5px] text-[var(--text-muted)]">{b.author}</div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 书籍右键菜单（删除书籍）—— 与 NotebookList 同款：全屏遮罩层捕获外部点击关闭 */}
      {ctxMenu && (
        <div className="fixed inset-0 z-[60] kb-pop-layer" onClick={() => setCtxMenu(null)}>
          <div
            ref={ctxMenuRef}
            style={ctxMenuStyle}
            className="absolute min-w-[170px] rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] py-0.5 shadow-xl"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {(() => {
              const target = list.find((b) => b.relPath === ctxMenu.relPath)
              if (!target) return null
              return (
                <button
                  onClick={() => { setCtxMenu(null); void deleteBook(target) }}
                  data-wb="bookDeleteMenu"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[var(--danger)] transition-colors hover:bg-[var(--danger)]/10"
                >
                  <Trash2 size={14} />删除书籍
                </button>
              )
            })()}
          </div>
        </div>
      )}
    </div>
  )
}
