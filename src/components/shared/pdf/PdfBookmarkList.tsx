import { useEffect, useRef, useState } from 'react'
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

/** 用户书签列表（方案 §5.6 左栏书签区）：点击跳页、行内备注（**点备注才进入编辑**）、悬停删除 */
export function PdfBookmarkList({ bookmarks, current, duo = false, onJump, onNote, onDelete }: Props) {
  const activeSet = duo ? new Set([current, current + 1]) : new Set([current])
  /** 正在编辑备注的页号（null = 全部只读）。**默认只读是有意为之** ——
   *  开发负责人 2026-09-23 反馈：备注框太容易误焦点，「只想点书签跳页，结果点到输入框改坏了备注」。
   *  改为「点备注文本/图标才进编辑」，卡片其余处一律跳页。 */
  const [editing, setEditing] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // 进入编辑后自动聚焦（否则用户还得再点一次）
  useEffect(() => {
    if (editing !== null) inputRef.current?.focus()
  }, [editing])

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
        const isEditing = editing === b.page
        return (
          <div key={b.page}
            className={`kb-item-in group/row mb-1 rounded-md border px-2 py-1.5 ${active ? 'border-[var(--accent)] bg-[var(--bg-hover)]' : 'border-transparent hover:bg-[var(--bg-hover)]'}`}>
            {/* 整行可点 = 跳页（含备注行以外的区域），备注编辑走单独入口 */}
            <div className="flex items-center gap-1">
              <button onClick={() => onJump(b.page)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                <Bookmark size={11} className={active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]'} />
                <span className="text-[11.5px] text-[var(--text-secondary)]">第 {b.page} 页</span>
              </button>
              {/* 删除书签：hover 才出。用具名 group/row —— 与备注行同卡片，
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
              {/* 备注入口：编辑态外是个按钮（点它才进编辑）；编辑态才换成真输入框。
                  ★ 不用「一个 input 只读切换」，因为只读 input 仍会吃点击事件、焦点行为也更绕。 */}
              {isEditing ? (
                <input
                  ref={inputRef}
                  defaultValue={b.note}
                  placeholder="加个备注…"
                  onBlur={(e) => { if (e.target.value !== b.note) onNote(b.page, e.target.value); setEditing(null) }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    else if (e.key === 'Escape') { (e.target as HTMLInputElement).value = b.note; setEditing(null) }
                  }}
                  className="min-w-0 flex-1 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] px-1 py-0.5 text-[11.5px] text-[var(--text-primary)] outline-none"
                />
              ) : (
                <button
                  onClick={() => setEditing(b.page)}
                  data-wb="pdfBookmarkEdit"
                  title={b.note ? '点这里改备注' : '点这里加备注'}
                  className="flex min-w-0 flex-1 items-start gap-1 rounded px-1 py-0.5 text-left hover:bg-[var(--bg-tertiary)]"
                >
                  <StickyNote size={11} className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" />
                  <span className={`min-w-0 flex-1 truncate text-[11.5px] ${b.note ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]'}`}>
                    {b.note || '加个备注…'}
                  </span>
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
