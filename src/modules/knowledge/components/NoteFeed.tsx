import { memo, useMemo, useState } from 'react'
import { ChevronDown, FileText, MoreHorizontal, Star, FileArchive } from 'lucide-react'
import type { KnowledgePage } from '../../../types'
import { buildFeedGroups, dirLabelOfPath, excerptOf, formatRelTime, type FeedSort } from '../topicsPure'

/**
 * 左栏「最近」视图 = 笔记流（v3.27.0，docs/knowledge-feed-topics-plan.md §4.1）。
 *
 * 与旧文件树的分工：这里只**读**、按修改时间平铺，不表达层级；层级维护留在「结构」视图
 * （复用 VaultTree）。行是两行式：标题 + 「目录 · 摘要」，右侧悬停出 ⋯。
 *
 * 性能（铁律 11）：超过 150 行才给行加 `.kb-cv-sm`（估值 60px 接近真实行高），
 * 短列表不加 —— 估值会抬虚滚动高度、滚动条乱跳。
 */

export interface NoteFeedProps {
  pages: KnowledgePage[]
  activePageId: string | null
  sort: FeedSort
  onOpen: (page: KnowledgePage) => void
  onContextMenu: (e: React.MouseEvent, page: KnowledgePage) => void
}

const ROW_ICON = { size: 15 } as const

const NoteRow = memo(function NoteRow({ page, active, onOpen, onContextMenu }: {
  page: KnowledgePage
  active: boolean
  onOpen: (page: KnowledgePage) => void
  onContextMenu: (e: React.MouseEvent, page: KnowledgePage) => void
}) {
  const isFile = (page.entryKind ?? 'doc') === 'file'
  const excerpt = excerptOf(page)
  return (
    <div
      data-kb-note-row={page.id}
      data-wb-note-id={page.id}
      onClick={() => onOpen(page)}
      onContextMenu={(e) => onContextMenu(e, page)}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(page) }}
      tabIndex={0}
      role="button"
      aria-label={page.title}
      className={`group relative flex items-center gap-2 rounded-md px-2 py-[7px] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)] ${
        active ? 'bg-[var(--bg-selected)]/50' : 'hover:bg-[var(--bg-hover)]'
      }`}
      style={active ? { boxShadow: 'inset 2px 0 0 var(--accent)' } : undefined}
    >
      <span className={`shrink-0 ${active ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}>
        {isFile ? <FileArchive {...ROW_ICON} /> : <FileText {...ROW_ICON} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium leading-snug text-[var(--text-primary)]">{page.title || '无标题'}</span>
          {page.isStarred && <Star size={11} className="shrink-0 fill-current text-[var(--warning)] opacity-30" />}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[10.5px] leading-snug text-[var(--text-muted)]">
          <span className="max-w-[96px] shrink-0 overflow-hidden text-ellipsis text-[var(--text-disabled)]">{dirLabelOfPath(page.path)}</span>
          {excerpt && (
            <>
              <span className="shrink-0 text-[var(--text-disabled)] opacity-55">·</span>
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis text-[var(--text-secondary)] opacity-90">{excerpt}</span>
            </>
          )}
        </div>
      </div>
      <div className="relative flex h-[22px] min-w-[54px] shrink-0 items-center justify-end">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onContextMenu(e, page) }}
          data-tip="更多" aria-label="更多"
          className="absolute right-0 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--text-muted)] opacity-0 transition-opacity hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <MoreHorizontal size={14} />
        </button>
        <span className="text-[10px] tabular-nums text-[var(--text-disabled)] transition-opacity group-hover:opacity-0">
          {formatRelTime(page.updatedAt)}
        </span>
      </div>
    </div>
  )
})

export function NoteFeed({ pages, activePageId, sort, onOpen, onContextMenu }: NoteFeedProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const groups = useMemo(() => buildFeedGroups(pages, sort), [pages, sort])
  const virtualize = pages.length > 150
  const cvClass = virtualize ? 'kb-cv-sm' : ''

  if (!pages.length) {
    return <div className="px-3 py-8 text-center text-[12px] text-[var(--text-muted)]">没有匹配的笔记</div>
  }

  // 标题排序 = 单组扁平列表：不渲染分组头（原型同款）
  if (sort === 'title') {
    return (
      <div className="px-1.5 pb-3">
        {groups[0]?.pages.map((p) => (
          <div key={p.id} className={cvClass}>
            <NoteRow page={p} active={p.id === activePageId} onOpen={onOpen} onContextMenu={onContextMenu} />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="px-1.5 pb-3" data-wb="kbNoteFeed">
      {groups.map((g) => {
        const closed = collapsed.has(g.key)
        return (
          <div key={g.key}>
            <button
              type="button"
              onClick={() => setCollapsed((prev) => {
                const next = new Set(prev)
                if (next.has(g.key)) next.delete(g.key)
                else next.add(g.key)
                return next
              })}
              className="sticky top-0 z-[1] flex w-full items-center gap-2 bg-[var(--bg-secondary)]/95 px-2 pb-1.5 pt-2.5 text-left text-[11px] font-semibold tracking-wide text-[var(--text-muted)] backdrop-blur-sm hover:text-[var(--text-secondary)]"
            >
              <ChevronDown size={12} className={`shrink-0 text-[var(--text-disabled)] kb-chevron ${closed ? '-rotate-90' : ''}`} />
              <span>{g.key}</span>
              <span className="rounded-full bg-[var(--bg-tertiary)] px-1.5 text-[9.5px] font-normal leading-[15px] tabular-nums text-[var(--text-disabled)]">{g.pages.length}</span>
              <span className="ml-0.5 h-px flex-1 bg-[var(--border-color)] opacity-55" />
            </button>
            {!closed && g.pages.map((p) => (
              <div key={p.id} className={cvClass}>
                <NoteRow page={p} active={p.id === activePageId} onOpen={onOpen} onContextMenu={onContextMenu} />
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
