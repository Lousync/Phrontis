import { Plus, Pencil, Trash2, Inbox, Globe } from 'lucide-react'
import type { BookmarkCategory, BookmarkItem } from '../../../../../types'
import { SIDEBAR_HEADER_ICON } from '../../../../../components/shared/sidebarHeaderIcon'

interface Props {
  categories: BookmarkCategory[]
  bookmarks: BookmarkItem[]
  /** 当前选中：'all' | 'none'(未分类) | 分类 id */
  selected: string
  onSelect: (id: string) => void
  onNew: () => void
  onEdit: (c: BookmarkCategory) => void
  onDelete: (c: BookmarkCategory) => void
}

export function CategorySidebar({ categories, bookmarks, selected, onSelect, onNew, onEdit, onDelete }: Props) {
  const countOf = (id: string) => bookmarks.filter(b => b.categoryId === id).length

  const renderRow = (id: string, label: string, color: string | null, count: number,
    actions?: React.ReactNode) => (
    <div
      onClick={() => onSelect(id)}
      className={`group relative flex items-center gap-2 px-3 py-1.5 mx-2 rounded cursor-pointer transition-colors ${
        selected === id ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
      }`}
    >
      {color
        ? <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
        : id === 'all'
          ? <Inbox size={13} className="shrink-0 opacity-70" />
          : <Globe size={13} className="shrink-0 opacity-70" />}
      <span className="flex-1 truncate text-[13px]">{label}</span>
      <span className={`text-[11px] tabular-nums group-hover:opacity-0 transition-opacity ${selected === id ? 'opacity-80' : 'text-[var(--text-muted)]'}`}>{count}</span>
      {actions && (
        <div className="absolute right-1 hidden group-hover:flex items-center gap-0.5 bg-[var(--bg-secondary)] pl-0.5">
          {actions}
        </div>
      )}
    </div>
  )

  return (
    <div className="h-full flex flex-col bg-[var(--bg-secondary)] overflow-y-auto">
      <div className="flex items-center gap-1.5 px-3 py-2 shrink-0 sticky top-0 bg-[var(--bg-secondary)] z-10 kb-scroll-edge kb-scroll-edge--on kb-scroll-edge--secondary">
        <span className="flex-1 text-[12px] font-medium text-[var(--text-secondary)]">分类</span>
        <button onClick={onNew}
          className="p-1 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          title="新建分类">
          <Plus {...SIDEBAR_HEADER_ICON} />
        </button>
      </div>

      <div className="py-1.5 space-y-0.5">
        {renderRow('all', '全部书签', null, bookmarks.length)}
        {renderRow('none', '未分类', null, countOf(''))}
        {categories.map(c => renderRow(
          c.id, c.name, c.color, countOf(c.id),
          <>
            <button onClick={e => { e.stopPropagation(); onEdit(c) }} title="编辑分类"
              className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-selected)] transition-colors">
              <Pencil size={12} />
            </button>
            <button onClick={e => { e.stopPropagation(); onDelete(c) }} title="删除分类（书签移入未分类）"
              className="p-1 rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-[var(--bg-selected)] transition-colors">
              <Trash2 size={12} />
            </button>
          </>
        ))}
      </div>

      {categories.length === 0 && (
        <div className="px-4 pb-4 pt-1 text-[11px] text-[var(--text-muted)] leading-relaxed">
          还没有自定义分类，点击右上角 + 创建。
        </div>
      )}
    </div>
  )
}
