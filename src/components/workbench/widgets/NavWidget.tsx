import { useCallback, useEffect, useMemo, useState } from 'react'
import { Search, ExternalLink } from 'lucide-react'
import type { BookmarkCategory, BookmarkItem } from '../../../types'
import { bookmarkGetAll, openBookmarkUrl } from '../../../lib/ipc'
import { useDataChanged } from '../../../lib/dataChanged'
import { domainOf } from '../../../modules/toolbox/components/bookmark-nav/io'

const AVATAR_COLORS = ['#EF4444', '#EA580C', '#CA8A04', '#059669', '#0D9488', '#027A74', '#2563EB', '#7C3AED', '#C026D3', '#64748B']

function avatarColor(domain: string): string {
  let h = 0
  for (const ch of domain) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

interface Props {
  /** 「管理」按钮回调：主窗口语境 = 打开网址导航工具标签；脱离小窗语境 = dayPanelOpenInMain */
  onManage?: () => void
}

/**
 * 网址导航控件（v3.4.0 批次4：DayPanel「导航」Tab 迁入 widgets，方案 §3.7）。
 * **右栏简略视图与脱离小窗共用**（不复制渲染）。自包含数据加载：
 * 搜索 + 分类 chips + 双列书签卡片，点击直达系统浏览器。
 * 数据与工具箱网址导航同源（同一 bookmarkGetAll IPC）；工具箱的增删改会广播
 * 'bookmark' data-changed，此处监听后自动刷新，保证双侧联通。
 */
export function NavWidget({ onManage }: Props) {
  const [categories, setCategories] = useState<BookmarkCategory[]>([])
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([])
  const [selected, setSelected] = useState('all')
  const [search, setSearch] = useState('')

  const refresh = useCallback(async () => {
    try {
      const data = await bookmarkGetAll()
      setCategories(data.categories ?? [])
      setBookmarks(data.bookmarks ?? [])
    } catch (e) {
      console.error('[NavWidget] 加载书签失败', e)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useDataChanged('bookmark', refresh)

  const filtered = useMemo(() => {
    let list = bookmarks
    if (selected === 'none') list = list.filter(b => b.categoryId === '')
    else if (selected !== 'all') list = list.filter(b => b.categoryId === selected)
    const q = search.trim().toLowerCase()
    if (q) {
      list = list.filter(b =>
        b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q) || b.description.toLowerCase().includes(q))
    }
    return list
  }, [bookmarks, selected, search])

  const catChips = useMemo(() => [
    { id: 'all', name: '全部' },
    { id: 'none', name: '未分类' },
    ...categories,
  ], [categories])

  const open = useCallback(async (b: BookmarkItem) => {
    try { await openBookmarkUrl(b.url) } catch (e) { console.error('[NavWidget] 打开链接失败', e) }
  }, [])

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1.5">
        <Search size={12} className="shrink-0 text-[var(--text-muted)]" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="搜索书签"
          className="min-w-0 flex-1 bg-transparent text-[11.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        />
      </div>

      <div className="flex flex-wrap gap-1">
        {catChips.map(c => (
          <button
            key={c.id}
            onClick={() => setSelected(c.id)}
            className={`rounded-full border px-2.5 py-[3px] text-[10.5px] transition-colors ${
              selected === c.id
                ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                : 'border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]'
            }`}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        {filtered.map(b => {
          const domain = domainOf(b.url)
          return (
            <button
              key={b.id}
              onClick={() => void open(b)}
              className="flex min-w-0 items-center gap-1.5 rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-hover)]"
              title={`${b.title}${b.description ? `\n${b.description}` : ''}`}
            >
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white"
                style={{ backgroundColor: avatarColor(domain) }}
              >
                {(b.title.trim()[0] || domain[0] || '?').toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] leading-tight text-[var(--text-primary)]">{b.title}</span>
                <span className="block truncate text-[9.5px] leading-tight text-[var(--text-muted)]">{domain}</span>
              </span>
            </button>
          )
        })}
      </div>
      {filtered.length === 0 && (
        <p className="px-1 py-3 text-center text-xs text-[var(--text-muted)]">
          {bookmarks.length === 0 ? '还没有书签，去工具箱添加' : '没有匹配的书签'}
        </p>
      )}

      {onManage && (
        <button
          onClick={onManage}
          className="mx-auto flex items-center gap-1 rounded-lg border border-dashed border-[var(--border-color)] px-3.5 py-1 text-[11px] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
          title="打开网址导航工具添加 / 编辑"
        >
          <ExternalLink size={10} /> 管理书签
        </button>
      )}
    </div>
  )
}
