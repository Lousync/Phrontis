import { useEffect, useState } from 'react'
import { BookMarked, BookOpen, Highlighter } from 'lucide-react'
import { pdfReaderGet, readerStateGet, workspaceGetCurrent } from '../../lib/ipc'
import { useDataChanged } from '../../lib/dataChanged'
import { KB_PDF_PAGE_CHANGED, KB_READER_STATE_CHANGED } from '../shared/pdf/pdfEvents'
import type { BookKind, PdfBookState } from '../../types'

/**
 * 右栏「阅读」侧栏（书架升级全格式阅读器一期，方案 §S6.3）。
 *
 * - 头部：书名 + kind 角标 + 实时进度——初值拉一次 pdfReaderGet / readerStateGet，
 *   之后订阅 `kb-pdf-page-changed`（pdf 页码）与 `kb-reader-state-changed`（txt pct）跟随。
 * - 段「书签」（仅 pdf，useDataChanged('pdfReader') 刷新）：条目 = 第 N 页 + 备注，
 *   点击 → onLocatePdfPage(page)（App 负责切回书架标签并派发跳页）。
 * - 段「摘录」：一期空态占位（划选摘录归二期），口径按 docs/help-disclosure-pattern.md 只收不删。
 * - 左栏三件套（目录/缩略图/书签）不动——本侧栏是右栏的阅读陪伴视图，二者并存。
 */

interface Props {
  reading: { relPath: string; name: string; kind: BookKind }
  onLocatePdfPage?: (page: number) => void
}

export function ReadingSidePanel({ reading, onLocatePdfPage }: Props) {
  const [rootId, setRootId] = useState('')
  const [pdfState, setPdfState] = useState<PdfBookState | null>(null)
  const [txtPct, setTxtPct] = useState(0)
  const [bookmarks, setBookmarks] = useState<PdfBookState['bookmarks']>([])

  // 当前仓库 rootId（书签/进度请求必带）
  useEffect(() => {
    let alive = true
    void workspaceGetCurrent().then((cur) => {
      if (alive) setRootId(cur?.rootId ?? '')
    }).catch(() => { /* 忽略 */ })
    return () => { alive = false }
  }, [])

  // 初值：按 kind 拉一次状态（书切换 / 首挂时重跑）
  useEffect(() => {
    let alive = true
    if (!rootId) return
    if (reading.kind === 'pdf') {
      void pdfReaderGet(rootId, reading.relPath).then((r) => {
        if (!alive) return
        const st = r.ok ? r.state ?? null : null
        setPdfState(st)
        setBookmarks(st?.bookmarks ?? [])
      }).catch(() => { /* 状态读取失败不阻塞侧栏 */ })
    } else {
      void readerStateGet(rootId, reading.relPath).then((r) => {
        if (!alive) return
        setTxtPct(r.ok ? r.state?.pct ?? 0 : 0)
      }).catch(() => { /* 同上 */ })
    }
    return () => { alive = false }
  }, [rootId, reading.kind, reading.relPath])

  // 实时跟随：阅读器在书的阅读过程中派发页码/进度广播
  useEffect(() => {
    const onPage = (e: Event) => {
      const d = (e as CustomEvent).detail as { relPath?: string; page?: number }
      if (d?.relPath === reading.relPath && typeof d.page === 'number') setPdfState((prev) => (prev ? { ...prev, lastPage: d.page! } : prev))
    }
    const onPct = (e: Event) => {
      const d = (e as CustomEvent).detail as { relPath?: string; kind?: string; pct?: number }
      if (d?.relPath === reading.relPath && d.kind === 'txt' && typeof d.pct === 'number') setTxtPct(d.pct)
    }
    window.addEventListener(KB_PDF_PAGE_CHANGED, onPage)
    window.addEventListener(KB_READER_STATE_CHANGED, onPct)
    return () => {
      window.removeEventListener(KB_PDF_PAGE_CHANGED, onPage)
      window.removeEventListener(KB_READER_STATE_CHANGED, onPct)
    }
  }, [reading.relPath])

  // 书签集刷新（仅 pdf）：阅读器内增删书签后广播 pdfReader scope
  const refreshBookmarks = () => {
    if (reading.kind !== 'pdf' || !rootId) return
    void pdfReaderGet(rootId, reading.relPath).then((r) => {
      const st = r.ok ? r.state ?? null : null
      setPdfState(st)
      setBookmarks(st?.bookmarks ?? [])
    }).catch(() => { /* 忽略 */ })
  }
  useDataChanged('pdfReader', refreshBookmarks)

  const isPdf = reading.kind === 'pdf'
  const progressLabel = isPdf
    ? (pdfState && pdfState.totalPages > 0 ? `第 ${pdfState.lastPage} / ${pdfState.totalPages} 页` : '未开始')
    : `${txtPct}%`

  return (
    <div data-wb="readingPanel" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 头部：书名 + kind 角标 + 进度 */}
      <div className="shrink-0 border-b border-[var(--border-color)] px-3 py-2">
        <div className="flex items-center gap-1.5">
          <BookOpen size={12} className="shrink-0 text-[var(--text-tertiary)]" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--text-primary)]">{reading.name}</span>
          <span className="shrink-0 rounded bg-[var(--bg-hover)] px-1 py-0.5 text-[9.5px] text-[var(--text-tertiary)]">{isPdf ? 'PDF' : 'TXT'}</span>
        </div>
        <div className="mt-1 text-[11px] text-[var(--text-tertiary)]">{progressLabel}</div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {/* 书签（仅 pdf） */}
        {isPdf && (
          <div className="mb-2">
            <div className="flex items-center gap-1 px-1.5 py-1 text-[11px] text-[var(--text-muted)]">
              <BookMarked size={11} />
              书签
              {bookmarks.length > 0 && <span className="text-[var(--text-tertiary)]">{bookmarks.length}</span>}
            </div>
            {bookmarks.length === 0 ? (
              <div className="px-2 py-1.5 text-[11px] leading-relaxed text-[var(--text-tertiary)]">在阅读器工具栏加书签后，这里可以快速跳页</div>
            ) : (
              bookmarks.map((b, i) => (
                <button
                  key={`${b.page}-${i}`}
                  onClick={() => onLocatePdfPage?.(b.page)}
                  className="kb-item-in group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                  title={b.note ? `第 ${b.page} 页 · ${b.note}` : `第 ${b.page} 页`}
                >
                  <span className="shrink-0 rounded bg-[var(--bg-hover)] px-1 py-0.5 text-[10px] text-[var(--text-secondary)]">P{b.page}</span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">{b.note || ' '}</span>
                </button>
              ))
            )}
          </div>
        )}

        {/* 摘录（二期）：空态占位，口径按 help-disclosure-pattern（只收不删、不醒目标签） */}
        <div>
          <div className="flex items-center gap-1 px-1.5 py-1 text-[11px] text-[var(--text-muted)]">
            <Highlighter size={11} />
            摘录
          </div>
          <div className="px-2 py-1.5 text-[11px] leading-relaxed text-[var(--text-tertiary)]">划选正文即可创建摘录 · 即将支持</div>
        </div>
      </div>
    </div>
  )
}

