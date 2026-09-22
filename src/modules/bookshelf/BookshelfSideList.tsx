import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen } from 'lucide-react'
import { pdfReaderCoverList, pdfReaderListBooks, workspaceGetCurrent } from '../../lib/ipc'
import { useDataChanged } from '../../lib/dataChanged'
import type { BookListItem } from '../../types'
import { BookCover } from './BookCover'

type SortFn = (a: BookListItem, b: BookListItem) => number

/** 排序与书架主区同口径：最近读优先，未读按名称（展示名，上游拼好的 `displayName`） */
const byRecent: SortFn = (a, b) => {
  const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0
  const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0
  if (ta !== tb) return tb - ta
  return a.displayName.localeCompare(b.displayName, 'zh-Hans')
}

/**
 * 书架左栏书目条目视图（2026-09-19 反馈：进入书架后左栏不再空置，放书条目列表）。
 * 书源 = 仓库顶层 `.books/`（点前缀系统区，笔记区不显示；目录不存在时主进程自动创建）。
 * 条目 = 封面 + 书名 + 细进度条（百分比 = lastPage/totalPages，totalPages 由阅读器
 * 首读登记进 pdfReader.json；txt / epub 用 pct）。点击条目 = 打开阅读，与主区封面网格同一落点
 * （App 的 setBookshelfReading）。
 *
 * 渲染时机（2026-09-21 修，B 段扩展）：① 未在读任何书；② **在读非 PDF** 时
 * （PdfRailPanel 只认 PDF，对 .txt / .epub 解析必失败 → 静默降级成空壳三件套，
 * 故这两种阅读态回落本列表并高亮当前书）。
 * 仅「在读 PDF」时左栏才走 PdfRailPanel —— 分发点是 App.tsx 的左栏 portal。
 */
export function BookshelfSideList({ onOpenBook, activeRelPath = null }: {
  onOpenBook: (relPath: string, name: string, kind: BookListItem['kind']) => void
  /** 当前正在阅读的书（TXT 阅读态由 App 传入）；命中则高亮该行 */
  activeRelPath?: string | null
}) {
  const [rootId, setRootId] = useState<string | null>(null)
  const [books, setBooks] = useState<BookListItem[] | null>(null)
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
  // 实时刷新：pdfReader 广播（阅读进度/封面）+ knowledge 广播（外部往 .books 增删 PDF）都重拉
  useDataChanged('pdfReader', () => { void load() })
  useDataChanged('knowledge', () => { void load() })

  const onCoverReady = useCallback((relPath: string, url: string) => {
    coverMem.current.set(relPath, url)
    forceTick((t) => t + 1)
  }, [])

  const list = books ? [...books].sort(byRecent) : null

  return (
    <div data-wb="bookshelfSideList" className="flex h-full min-h-0 flex-col">
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
          /* 空态只留图标（2026-09-19 反馈：不要多余的文字说明） */
          <div className="flex h-full flex-col items-center justify-center text-[var(--text-muted)]">
            <BookOpen size={28} strokeWidth={1.4} />
          </div>
        )}
        {list && list.map((b) => {
          // 展示名直接用上游的（S4 收口）：这里不再 `bookDisplayName(relPath)`
          const title = b.displayName
          const active = activeRelPath === b.relPath
          // 判据写 `!== 'pdf'`（pct 口径覆盖 txt / epub）—— 写成 `=== 'txt'` 会让新格式落进
          // 页码口径、进度条恒 0（B 段踩点）。
          const pct = b.kind !== 'pdf'
            ? (b.pct ?? 0)
            : (b.hasProgress && b.totalPages > 0 ? Math.min(100, Math.round((b.lastPage / b.totalPages) * 100)) : 0)
          return (
            <button
              key={b.relPath}
              onClick={() => onOpenBook(b.relPath, title, b.kind)}
              data-wb-active={active ? '1' : undefined}
              className={`kb-item-in group relative flex w-full items-center gap-2 rounded-md p-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] ${active ? 'bg-[var(--bg-hover)]' : ''}`}
              title={b.kind !== 'pdf' ? (pct > 0 ? `已读 ${pct}%` : title) : (b.hasProgress && b.totalPages > 0 ? `第 ${b.lastPage} / ${b.totalPages} 页 · ${pct}%` : title)}
            >
              {/* 在读标记：左侧细竖条（只改底色 + 竖条，不加文字标签） */}
              {active && <span className="absolute left-0.5 top-2 bottom-2 w-[2px] rounded-full bg-[var(--accent)]" />}
              <div className="w-[34px] shrink-0">
                <BookCover kind={b.kind} rootId={rootId ?? ''} relPath={b.relPath} name={title} coverRef={b.coverRef} mtime={b.mtime} cacheHit={coverHits.has(b.relPath) || coverMem.current.has(b.relPath)} onReady={(u) => onCoverReady(b.relPath, u)} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-[var(--text-primary)] group-hover:text-[var(--text-primary)]">{title}</div>
                {/* 作者行：书市下到的书才有（meta.author 空则整行不渲染，与主区同口径）
                    ★ --text-muted 而不是 --text-tertiary：后者全库**未定义**（只有 --bg-tertiary） */}
                {b.author && (
                  <div className="truncate text-[10.5px] text-[var(--text-muted)]">{b.author}</div>
                )}
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
