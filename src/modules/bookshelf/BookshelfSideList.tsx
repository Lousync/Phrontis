import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen } from 'lucide-react'
import { pdfReaderCoverList, pdfReaderListBooks, workspaceGetCurrent } from '../../lib/ipc'
import { useDataChanged } from '../../lib/dataChanged'
import type { PdfBookListItem } from '../../types'
import { PdfCover } from './PdfCover'

type SortFn = (a: PdfBookListItem, b: PdfBookListItem) => number

/** 排序与书架主区同口径：最近读优先，未读按名称 */
const byRecent: SortFn = (a, b) => {
  const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0
  const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0
  if (ta !== tb) return tb - ta
  return a.name.localeCompare(b.name, 'zh-Hans')
}

/**
 * 书架左栏书目条目视图（2026-09-19 反馈：进入书架后左栏不再空置，放书条目列表）。
 * 条目 = 封面 + 书名 + 细进度条（百分比 = lastPage/totalPages，totalPages 由阅读器
 * 首读登记进 pdfReader.json；未登记/未读的书进度条为空）。点击条目 = 打开阅读，
 * 与主区封面网格同一落点（App 的 setBookshelfReading）。阅读态（有 railReaderDoc）
 * 时左栏仍走 PdfRailPanel 三件套，本组件只在「未在读任何书」时渲染。
 */
export function BookshelfSideList({ onOpenBook }: {
  onOpenBook: (relPath: string, name: string) => void
}) {
  const [rootId, setRootId] = useState<string | null>(null)
  const [books, setBooks] = useState<PdfBookListItem[] | null>(null)
  const [coverHits, setCoverHits] = useState<Set<string>>(new Set())
  const [loadErr, setLoadErr] = useState('')
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
  // 铁律 1：主进程写盘（patch/coverSave/import）后经 windowBus 广播 → 列表与进度自动重拉
  useDataChanged('pdfReader', () => { void load() })

  const onCoverReady = useCallback((relPath: string, url: string) => {
    coverMem.current.set(relPath, url)
    forceTick((t) => t + 1)
  }, [])

  const list = books ? [...books].sort(byRecent) : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 标题行：与其他模块左栏标题行同款（书架 + 本数） */}
      <div className="flex items-center gap-1 border-b border-[var(--border-color)] px-2 py-1 text-[11.5px] text-[var(--text-muted)] shrink-0 select-none">
        <BookOpen size={12} />
        书架
        {list && list.length > 0 && <span className="text-[var(--text-tertiary)]">{list.length} 本</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {loadErr && (
          <div className="mb-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-[11.5px] text-[var(--text-warning)]">
            书架加载失败：{loadErr}
          </div>
        )}
        {list !== null && list.length === 0 && !loadErr && (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-3 text-center text-[var(--text-muted)]">
            <BookOpen size={24} strokeWidth={1.4} />
            <div className="text-[12px]">仓库里还没有 PDF</div>
            <div className="text-[11px]">把 .pdf 放进仓库任意目录，或在主区「导入 PDF」</div>
          </div>
        )}
        {list && list.map((b) => {
          const title = b.name.replace(/\.pdf$/i, '')
          const pct = b.hasProgress && b.totalPages > 0 ? Math.min(100, Math.round((b.lastPage / b.totalPages) * 100)) : 0
          return (
            <button
              key={b.relPath}
              onClick={() => onOpenBook(b.relPath, title)}
              className="kb-item-in group flex w-full items-center gap-2 rounded-md p-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
              title={b.hasProgress && b.totalPages > 0 ? `第 ${b.lastPage} / ${b.totalPages} 页 · ${pct}%` : title}
            >
              <div className="w-[34px] shrink-0">
                <PdfCover rootId={rootId ?? ''} relPath={b.relPath} name={b.name} mtime={b.mtime} cacheHit={coverHits.has(b.relPath) || coverMem.current.has(b.relPath)} onReady={(u) => onCoverReady(b.relPath, u)} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-[var(--text-primary)] group-hover:text-[var(--text-primary)]">{title}</div>
                {/* 进度条：未读/总页数未登记为空条；h-[3px] 与全局细进度条口径一致 */}
                <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-[var(--bg-hover)]">
                  <div
                    className="h-full rounded-full bg-[var(--accent)]"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
