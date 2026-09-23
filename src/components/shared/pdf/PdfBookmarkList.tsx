import { Bookmark, StickyNote, X } from 'lucide-react'

export interface PdfBookmarkItem {
  page: number
  note: string
  at: string
}

interface Props {
  bookmarks: PdfBookmarkItem[]
  /** 当前页（duo 模式传跨页起始，p/p+1 双高亮） */
  current: number
  duo?: boolean
  onJump: (n: number) => void
  onNote: (page: number, note: string) => void
  /** 删除一条书签（页号即身份）。由 PdfRailPanel 回派给阅读器执行，本组件不直接写盘 */
  onDelete: (page: number) => void
}

/** 用户书签列表（方案 §5.6 左栏书签区）：点击跳页、行内备注（blur 提交）、悬停删除 */
export function PdfBookmarkList({ bookmarks, current, duo = false, onJump, onNote, onDelete }: Props) {
  const activeSet = duo ? new Set([current, current + 1]) : new Set([current])
  if (bookmarks.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-[var(--text-muted)]">
        <Bookmark size={26} strokeWidth={1.4} />
        <div className="text-[12px]">还没有书签</div>
        <div className="text-[11px] leading-relaxed">在要记住的页上点工具栏的书签按钮即可收藏</div>
      </div>
    )
  }
  return (
    <div className="kb-view-in min-h-0 flex-1 overflow-y-auto px-1 pb-2">
      {bookmarks.map((b) => {
        const active = activeSet.has(b.page)
        return (
          <div key={b.page}
            className={`kb-item-in group/row mb-1 rounded-md border px-2 py-1.5 ${active ? 'border-[var(--accent)] bg-[var(--bg-hover)]' : 'border-transparent hover:bg-[var(--bg-hover)]'}`}>
            <div className="flex items-center gap-1">
              <button onClick={() => onJump(b.page)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                <Bookmark size={11} className={active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]'} />
                <span className="text-[11.5px] text-[var(--text-secondary)]">第 {b.page} 页</span>
              </button>
              {/* 删除书签：hover 才出。用具名 group/row —— 备注输入框那行也在同一卡片里，
                  不具名会让 hover 卡片任意处就冒出 ✕（与右栏 readingMark 同款口径）。 */}
              <button
                onClick={() => onDelete(b.page)}
                data-wb="pdfBookmarkDel"
                title="删除书签"
                className="shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 hover:bg-[var(--bg-hover)] hover:text-[var(--danger)] group-hover/row:opacity-100"
              >
                <X size={11} />
              </button>
            </div>
            <div className="mt-1 flex items-start gap-1">
              <StickyNote size={11} className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" />
              <input
                defaultValue={b.note}
                placeholder="加个备注…"
                onBlur={(e) => { if (e.target.value !== b.note) onNote(b.page, e.target.value) }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-[11.5px] text-[var(--text-primary)] outline-none focus:border-[var(--border-color)] focus:bg-[var(--bg-primary)]"
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
