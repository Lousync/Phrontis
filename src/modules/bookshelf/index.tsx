import { lazy, useCallback, useEffect, useRef, useState, Suspense } from 'react'
import { BookOpen, Loader2, Play } from 'lucide-react'
import {
  pdfReaderCoverList, pdfReaderListBooks, workspaceGetCurrent,
} from '../../lib/ipc'
import { useDataChanged } from '../../lib/dataChanged'
import type { PdfBookListItem } from '../../types'
import { PdfCover } from './PdfCover'

// 2026-09-17 拍板「书架内自渲染」：点书在书架标签页内部打开阅读器（书架 ⇄ 阅读器），
// 不再借编辑器文档标签（编辑器 PDF 能力保留给知识库附件等既有入口）。
// PdfReaderView 内含 pdfjs —— lazy 拆 chunk（与 editor 同一模块Specifier，Vite 去重共享 chunk）。
const PdfReaderView = lazy(() => import('../../components/shared/pdf/PdfReaderView').then((m) => ({ default: m.PdfReaderView })))

/**
 * 书架（v3.4.0 PDF 阅读体验整包批次 2，方案 §2/§8）：
 * - 自动库 = 扫仓库顶层 `.books/` 目录的全部 .pdf（pdfReader:listBooks），清单不落盘；
 *   `.books` 为点前缀系统区，笔记区不显示；目录不存在时主进程自动创建（2026-09-19 拍板）。
 * - 封面网格（PdfCover 懒渲染 + covers 缓存）；续读条（hasProgress 按最近读排序）；
 * - 点书 = kb-open-note { relPath, from:'bookshelf' }（state+props 范式，编辑器组文档标签每书一个）。
 * 模块根节点 h-full（槽位容器是块级 div，flex-1 无效）。
 */

type SortFn = (a: PdfBookListItem, b: PdfBookListItem) => number

/** 排序 = 最近读优先（updatedAt desc），未读按名称（方案 §8） */
const byRecent: SortFn = (a, b) => {
  const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0
  const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0
  if (ta !== tb) return tb - ta
  return a.name.localeCompare(b.name, 'zh-Hans')
}

export function BookshelfModule({ isActive = true, reading = null, onOpenBook, onCloseBook }: {
  isActive?: boolean
  /** 正在阅读的书（状态上收 App：书架模块消费 + 左栏大纲态跟随） */
  reading?: { relPath: string; name: string } | null
  onOpenBook?: (relPath: string, name: string) => void
  onCloseBook?: () => void
}) {
  const [rootId, setRootId] = useState<string | null>(null)
  const [books, setBooks] = useState<PdfBookListItem[] | null>(null)
  /** 封面缓存命中集（coverList 索引 + mtime 对账通过）——PdfCover 据此走 coverGet 直取 */
  const [coverHits, setCoverHits] = useState<Set<string>>(new Set())
  const [loadErr, setLoadErr] = useState('')
  /** 封面内存缓存 relPath → dataUrl（滚动往返免重复取/渲染） */
  const coverMem = useRef(new Map<string, string>())
  const [, forceTick] = useState(0)

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
      setBooks(nextBooks)
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
  // 铁律 1：主进程写盘（patch/coverSave/import）后经 windowBus 广播 → 书架自动重拉
  useDataChanged('pdfReader', () => { void load() })

  const onCoverReady = useCallback((relPath: string, url: string) => {
    coverMem.current.set(relPath, url)
    forceTick((t) => t + 1)
  }, [])

  // 左栏 bookshelf 模块态（批次 6）：三件套（目录/缩略图/书签）经 portal 挂进左栏 slot
  const openBook = useCallback((b: PdfBookListItem) => {
    onOpenBook?.(b.relPath, b.name.replace(/\.pdf$/i, ''))
  }, [onOpenBook])

  // 阅读视图（书架 ⇄ 阅读器，模块内切换；Hook 全部在早退之前）
  if (reading) {
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
              <PdfReaderView rootId={rootId} relPath={reading.relPath} name={reading.name}
                backLabel="返回书架" onBack={() => onCloseBook?.()} />
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
        <div className="max-w-[280px] text-center text-[11.5px] leading-relaxed">先打开一个仓库，书架会自动收拢 .books 目录里的 PDF</div>
      </div>
    )
  }

  const list = books ?? []
  const continueList = list.filter((b) => b.hasProgress).slice(0, 6)
  const gridList = [...list].sort(byRecent)

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-primary)]">
      {/* 顶栏：标题（2026-09-19 拍板：「＋导入」按钮删除——放 .pdf 进仓库任意目录即被自动库扫到） */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-2">
        <BookOpen size={15} className="text-[var(--text-secondary)]" />
        <span className="text-[13px] font-medium text-[var(--text-primary)]">书架</span>
        <span className="text-[11.5px] text-[var(--text-tertiary)]">{list.length} 本</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loadErr && (
          <div className="mb-3 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-[12px] text-[var(--text-warning)]">
            书架加载失败：{loadErr}
          </div>
        )}

        {books !== null && list.length === 0 && !loadErr && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--text-muted)]">
            <BookOpen size={34} strokeWidth={1.4} />
            <div className="text-[12.5px]">.books 里还没有 PDF</div>
            <div className="text-[11.5px]">把 .pdf 放进仓库顶层的 .books 文件夹（目录已自动创建）</div>
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
                  className="kb-item-in group flex w-[210px] shrink-0 items-center gap-2.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-2 text-left hover:border-[var(--accent)]"
                  title={`第 ${b.lastPage} 页 · 打开继续阅读`}
                >
                  <div className="w-[44px] shrink-0" style={{ aspectRatio: '3 / 4' }}>
                    <PdfCover rootId={rootId ?? ''} relPath={b.relPath} name={b.name} mtime={b.mtime} cacheHit={coverHits.has(b.relPath) || coverMem.current.has(b.relPath)} onReady={(u) => onCoverReady(b.relPath, u)} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium text-[var(--text-primary)]">{b.name.replace(/\.pdf$/i, '')}</div>
                    <div className="mt-1 flex items-center gap-1 text-[11px] text-[var(--accent)]">
                      <Play size={10} />第 {b.lastPage} 页
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
                className="kb-item-in group text-left"
                title={b.relPath}
              >
                <div className="relative transition-shadow group-hover:shadow-[0_8px_22px_rgba(0,0,0,0.14)] rounded-[10px]">
                  <PdfCover rootId={rootId ?? ''} relPath={b.relPath} name={b.name} mtime={b.mtime} cacheHit={coverHits.has(b.relPath) || coverMem.current.has(b.relPath)} onReady={(u) => onCoverReady(b.relPath, u)} />
                  {b.hasProgress && (
                    <span className="absolute bottom-1.5 right-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white">P{b.lastPage}</span>
                  )}
                </div>
                <div className="mt-1.5 truncate px-0.5 text-[11.5px] text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">{b.name.replace(/\.pdf$/i, '')}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
