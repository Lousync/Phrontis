import { useState, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Globe, Plus, Search, ExternalLink, Pencil, Trash2, Copy, Download, Upload, Check } from 'lucide-react'
import type { BookmarkCategory, BookmarkItem } from '../../../../types'
import {
  bookmarkGetAll, createBookmarkItem, deleteBookmarkItem,
  deleteBookmarkCategory, openBookmarkUrl, pickBookmarkImportFile,
} from '../../../../lib/ipc'
import { showToast } from '../../../../lib/toast'
import { notifyDataChanged } from '../../../../lib/dataChanged'
import { ConfirmDialog } from '../../../../components/shared'
import { buildJsonExport, buildHtmlExport, parseJsonImport, parseHtmlImport, domainOf } from './io'
import { CategorySidebar } from './components/CategorySidebar'
import { BookmarkEditModal, CategoryEditModal } from './components/BookmarkModals'
import { localToday } from '../../../../lib/date'
import type { ToolSidebarProps } from '../../../../components/workbench/toolRegistry'

interface Props extends ToolSidebarProps { onBack: () => void }

const AVATAR_COLORS = ['#EF4444', '#EA580C', '#CA8A04', '#059669', '#0D9488', '#027A74', '#2563EB', '#7C3AED', '#C026D3', '#64748B']

function avatarColor(domain: string): string {
  let h = 0
  for (const ch of domain) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

export function BookmarkNav({ onBack, sidebarEl, sidebarHosted }: Props) {
  const [categories, setCategories] = useState<BookmarkCategory[]>([])
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([])
  const [selected, setSelected] = useState('all')
  const [search, setSearch] = useState('')
  const [exportMenuOpen, setExportMenuOpen] = useState(false)

  const [bookmarkEditor, setBookmarkEditor] = useState<
    { mode: 'create'; categoryId: string } | { mode: 'edit'; bookmark: BookmarkItem } | null
  >(null)
  const [categoryEditor, setCategoryEditor] = useState<
    { mode: 'create' } | { mode: 'edit'; category: BookmarkCategory } | null
  >(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const data = await window.api.bookmarkGetAll()
      setCategories(data.categories)
      setBookmarks(data.bookmarks)
    } catch (e) {
      console.error('加载书签失败', e)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // ---- 过滤 ----
  const filtered = useMemo(() => {
    let list = bookmarks
    if (selected === 'none') list = list.filter(b => b.categoryId === '')
    else if (selected !== 'all') list = list.filter(b => b.categoryId === selected)
    const q = search.trim().toLowerCase()
    if (q) {
      list = list.filter(b =>
        b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q) || b.description.toLowerCase().includes(q)
      )
    }
    return list
  }, [bookmarks, selected, search])

  const catName = useMemo(() => new Map(categories.map(c => [c.id, c])), [categories])

  // ---- 操作 ----
  const handleOpen = useCallback(async (b: BookmarkItem) => {
    try { await openBookmarkUrl(b.url) } catch (e) { console.error('打开链接失败', e) }
  }, [])

  const handleCopyLink = useCallback((b: BookmarkItem) => {
    navigator.clipboard.writeText(b.url).then(() => {
      setCopiedId(b.id)
      window.setTimeout(() => setCopiedId(null), 1500)
    }).catch(() => {})
  }, [])

  // 删除确认(应用内 ConfirmDialog — Electron 原生 confirm 会破坏键盘焦点,禁止使用)
  const [confirmDelete, setConfirmDelete] = useState<
    { kind: 'bookmark'; item: BookmarkItem } | { kind: 'category'; item: BookmarkCategory; count: number } | null
  >(null)

  const handleDeleteBookmark = useCallback((b: BookmarkItem) => {
    setConfirmDelete({ kind: 'bookmark', item: b })
  }, [])

  const handleDeleteCategory = useCallback((c: BookmarkCategory) => {
    const n = bookmarks.filter(b => b.categoryId === c.id).length
    setConfirmDelete({ kind: 'category', item: c, count: n })
  }, [bookmarks])

  const performConfirmedDelete = useCallback(async () => {
    if (!confirmDelete) return
    try {
      if (confirmDelete.kind === 'bookmark') {
        await deleteBookmarkItem(confirmDelete.item.id)
        setBookmarks(cur => cur.filter(x => x.id !== confirmDelete.item.id))
        notifyDataChanged('bookmark')
      } else {
        const c = confirmDelete.item
        await deleteBookmarkCategory(c.id)
        setCategories(cur => cur.filter(x => x.id !== c.id))
        setBookmarks(cur => cur.map(b => (b.categoryId === c.id ? { ...b, categoryId: '' } : b)))
        if (selected === c.id) setSelected('all')
        notifyDataChanged('bookmark')
      }
    } catch (e) { console.error('删除失败', e) } finally {
      setConfirmDelete(null)
    }
  }, [confirmDelete, selected])

  // ---- 导出 ----
  const dateTag = () => localToday()

  const handleExportJson = useCallback(async () => {
    setExportMenuOpen(false)
    try {
      const res = await window.api.showExportSaveDialog({
        defaultName: `knowbase-bookmarks-${dateTag()}.json`,
        filters: [{ name: 'JSON 文件', extensions: ['json'] }],
      })
      if (!res.filePath) return
      await window.api.writeExportTextFile(res.filePath, buildJsonExport(categories, bookmarks), 'utf-8')
      showToast({ type: 'info', message: `已导出 ${bookmarks.length} 个书签（JSON）` })
    } catch (e) {
      console.error('导出失败', e)
      showToast({ type: 'error', message: '导出失败，请重试' })
    }
  }, [categories, bookmarks])

  const handleExportHtml = useCallback(async () => {
    setExportMenuOpen(false)
    try {
      const res = await window.api.showExportSaveDialog({
        defaultName: `knowbase-bookmarks-${dateTag()}.html`,
        filters: [{ name: 'HTML 书签文件', extensions: ['html'] }],
      })
      if (!res.filePath) return
      await window.api.writeExportTextFile(res.filePath, buildHtmlExport(categories, bookmarks), 'utf-8')
      showToast({ type: 'info', message: `已导出 ${bookmarks.length} 个书签（HTML，可导入浏览器）` })
    } catch (e) {
      console.error('导出失败', e)
      showToast({ type: 'error', message: '导出失败，请重试' })
    }
  }, [categories, bookmarks])

  // ---- 导入 ----
  const handleImport = useCallback(async () => {
    try {
      const path = await pickBookmarkImportFile()
      if (!path) return
      const text = await window.api.readImportFile(path)
      if (!text) throw new Error('无法读取文件')
      // JSON = 本应用完整备份；HTML = 浏览器导出的收藏夹（Chrome / Edge / Firefox）
      const { payload } = /\.json$/i.test(path) ? parseJsonImport(text) : parseHtmlImport(text)

      // 分类按名合并
      const catByName = new Map(categories.map(c => [c.name, c]))
      let addedCats = 0
      for (const c of payload.categories) {
        if (!catByName.has(c.name)) {
          const created = await window.api.createBookmarkCategory({ name: c.name, color: c.color })
          catByName.set(created.name, created)
          addedCats++
        }
      }

      // 书签按 URL 去重后追加
      const urlSet = new Set(bookmarks.map(b => b.url.trim().toLowerCase()))
      let added = 0
      let skipped = 0
      for (const b of payload.bookmarks) {
        const key = b.url.toLowerCase()
        if (urlSet.has(key)) { skipped++; continue }
        const cat = b.category ? catByName.get(b.category) : undefined
        await createBookmarkItem({ title: b.title, url: b.url, description: b.description || '', categoryId: cat?.id ?? '' })
        urlSet.add(key)
        added++
      }

      const parts = [`新增 ${added} 个书签`]
      if (addedCats > 0) parts.push(`${addedCats} 个分类`)
      if (skipped > 0) parts.push(`跳过重复 ${skipped} 个`)
      showToast({ type: 'info', message: `导入完成：${parts.join('，')}` })
      if (added > 0 || addedCats > 0) notifyDataChanged('bookmark')
      void refresh()
    } catch (e) {
      console.error('导入失败', e)
      showToast({ type: 'error', message: e instanceof Error ? e.message : '导入失败，请检查文件格式' })
    }
  }, [categories, bookmarks, refresh])

  const selectedLabel =
    selected === 'all' ? '全部书签' :
    selected === 'none' ? '未分类' :
    (catName.get(selected)?.name ?? '全部书签')

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)]">
      {/* 头部 */}
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-2 py-1 shrink-0">
        <button
          onClick={onBack}
          className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          title="返回"
        >
          <ArrowLeft size={12} />
        </button>
        <span className="text-[11.5px] font-medium text-[var(--text-muted)]">网址导航</span>
        <span className="text-[11px] text-[var(--text-muted)]">{bookmarks.length} 个书签</span>

        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => void handleImport()}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
            <Upload size={12} /> 导入
          </button>
          <div className="relative">
            <button onClick={() => setExportMenuOpen(o => !o)}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] transition-colors ${
                exportMenuOpen ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
              }`}
              disabled={bookmarks.length === 0}>
              <Download size={12} /> 导出
            </button>
            {exportMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setExportMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 w-44 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded shadow-lg py-1 ck-rise">
                  <button onClick={() => void handleExportJson()}
                    className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-left">
                    <Download size={13} className="text-[var(--text-muted)]" />
                    导出 JSON<div className="flex-1" /><span className="text-[10px] text-[var(--text-muted)]">备份 / 再导入</span>
                  </button>
                  <button onClick={() => void handleExportHtml()}
                    className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-left">
                    <Globe size={13} className="text-[var(--text-muted)]" />
                    导出 HTML<div className="flex-1" /><span className="text-[10px] text-[var(--text-muted)]">导入浏览器</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* 左栏分类。2026-09-17 右栏优化轮：标签页语境 sidebarEl 非空时 portal 进
            工作台左栏模块态 slot（挂载点迁移，状态留在本组件）；槽未就绪渲染 null 等槽。 */}
        {(() => {
          const sidebarInner = (
            <CategorySidebar
              categories={categories}
              bookmarks={bookmarks}
              selected={selected}
              onSelect={setSelected}
              onNew={() => setCategoryEditor({ mode: 'create' })}
              onEdit={c => setCategoryEditor({ mode: 'edit', category: c })}
              onDelete={c => void handleDeleteCategory(c)}
            />
          )
          return sidebarEl
            ? createPortal(<div className="h-full w-full min-h-0">{sidebarInner}</div>, sidebarEl)
            : sidebarHosted
              ? null
              : <div className="w-52 shrink-0 border-r border-[var(--border-color)] min-h-0">{sidebarInner}</div>
        })()}

        {/* 主区 */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* 搜索栏 */}
          <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-[var(--border-color)] shrink-0">
            <div className="relative flex-1 max-w-sm">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder={`在${selectedLabel}中搜索…`}
                className="w-full pl-8 pr-3 py-1.5 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none"
              />
            </div>
            <span className="text-[11px] text-[var(--text-muted)]">{filtered.length} 个</span>
            <button onClick={() => setBookmarkEditor({ mode: 'create', categoryId: selected === 'all' ? '' : selected })}
              className="ml-auto flex items-center gap-1 px-2.5 py-1.5 text-[12px] rounded bg-[var(--accent)] text-white hover:opacity-90 transition-opacity">
              <Plus size={13} /> 添加书签
            </button>
          </div>

          {/* 卡片网格 */}
          <div className="flex-1 overflow-y-auto p-4">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                {bookmarks.length === 0 ? (
                  <>
                    <Globe size={34} className="text-[var(--text-muted)] opacity-40" />
                    <p className="text-[13px] text-[var(--text-muted)] mt-3">还没有保存任何网址</p>
                    <button onClick={() => setBookmarkEditor({ mode: 'create', categoryId: '' })}
                      className="mt-3 flex items-center gap-1 px-3 py-1.5 text-[12px] rounded border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">
                      <Plus size={13} /> 添加第一个书签
                    </button>
                  </>
                ) : (
                  <p className="text-[13px] text-[var(--text-muted)]">没有匹配「{search}」的书签</p>
                )}
              </div>
            ) : (
              <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
                {filtered.map(b => {
                  const domain = domainOf(b.url)
                  return (
                    <div key={b.id}
                      onClick={() => void handleOpen(b)}
                      title={`${b.title}\n${b.url}`}
                      className="group relative flex flex-col gap-1.5 p-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] cursor-pointer hover:border-[var(--accent)] hover:bg-[var(--bg-tertiary)] active:scale-[0.99] transition-all"
                    >
                      <div className="flex items-center gap-2.5">
                        <span className="w-8 h-8 rounded flex items-center justify-center text-[15px] font-bold text-white shrink-0"
                          style={{ backgroundColor: avatarColor(domain) }}>
                          {(domain[0] ?? '#').toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <div className="text-[13px] font-medium text-[var(--text-primary)] truncate">{b.title}</div>
                          <div className="text-[11px] text-[var(--text-muted)] truncate">{domain}</div>
                        </div>
                      </div>
                      {b.description && (
                        <p className="text-[11px] text-[var(--text-secondary)] line-clamp-2 leading-snug">{b.description}</p>
                      )}
                      {/* 悬停操作 */}
                      <div className="absolute right-1.5 top-1.5 hidden group-hover:flex items-center gap-0.5 bg-[var(--bg-secondary)] rounded p-0.5 border border-[var(--border-color)]"
                        onClick={e => e.stopPropagation()}>
                        <button onClick={() => void handleOpen(b)} title="打开网页"
                          className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-selected)] transition-colors">
                          <ExternalLink size={13} />
                        </button>
                        <button onClick={() => handleCopyLink(b)} title="复制链接"
                          className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-selected)] transition-colors">
                          {copiedId === b.id ? <Check size={13} style={{ color: 'var(--success)' }} /> : <Copy size={13} />}
                        </button>
                        <button onClick={() => setBookmarkEditor({ mode: 'edit', bookmark: b })} title="编辑"
                          className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-selected)] transition-colors">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => void handleDeleteBookmark(b)} title="删除"
                          className="p-1 rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-[var(--bg-selected)] transition-colors">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 弹窗 */}
      {bookmarkEditor && (
        <BookmarkEditModal
          mode={bookmarkEditor.mode}
          bookmark={bookmarkEditor.mode === 'edit' ? bookmarkEditor.bookmark : undefined}
          categories={categories}
          defaultCategoryId={bookmarkEditor.mode === 'create' ? bookmarkEditor.categoryId : undefined}
          onClose={() => setBookmarkEditor(null)}
          onSaved={() => { setBookmarkEditor(null); notifyDataChanged('bookmark'); void refresh() }}
        />
      )}
      {categoryEditor && (
        <CategoryEditModal
          mode={categoryEditor.mode}
          category={categoryEditor.mode === 'edit' ? categoryEditor.category : undefined}
          onClose={() => setCategoryEditor(null)}
          onSaved={() => { setCategoryEditor(null); void refresh() }}
        />
      )}
      <ConfirmDialog
        open={confirmDelete !== null}
        title={confirmDelete?.kind === 'category' ? '删除分类' : '删除书签'}
        message={
          confirmDelete?.kind === 'category'
            ? `确定删除分类「${confirmDelete.item.name}」？${confirmDelete.count > 0 ? `其中 ${confirmDelete.count} 个书签将移入未分类。` : ''}`
            : `确定删除书签「${confirmDelete?.item.title ?? ''}」？`
        }
        confirmLabel="删除"
        showCheckbox={false}
        onConfirm={() => void performConfirmedDelete()}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  )
}
