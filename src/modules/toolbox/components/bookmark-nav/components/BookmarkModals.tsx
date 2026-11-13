import { useState } from 'react'
import { X } from 'lucide-react'
import type { BookmarkCategory, BookmarkItem } from '../../../../../types'
import { createBookmarkItem, updateBookmarkItem, createBookmarkCategory, updateBookmarkCategory } from '../../../../../lib/ipc'
import { showToast } from '../../../../../lib/toast'
import { normalizeUrl, isValidUrl } from '../io'

const COLORS = [
  '#EF4444', '#F97316', '#EAB308', '#22C55E', '#14B8A6',
  '#06B6D4', '#3B82F6', '#8B5CF6', '#EC4899', '#78716C',
]

// ==================== 书签编辑弹窗 ====================

interface BookmarkModalProps {
  mode: 'create' | 'edit'
  bookmark?: BookmarkItem
  categories: BookmarkCategory[]
  /** 新建时预选的分类 */
  defaultCategoryId?: string
  onClose: () => void
  onSaved: () => void
}

export function BookmarkEditModal({ mode, bookmark, categories, defaultCategoryId, onClose, onSaved }: BookmarkModalProps) {
  const [title, setTitle] = useState(bookmark?.title ?? '')
  const [url, setUrl] = useState(bookmark?.url ?? '')
  const [categoryId, setCategoryId] = useState<string>(bookmark?.categoryId ?? defaultCategoryId ?? '')
  const [description, setDescription] = useState(bookmark?.description ?? '')
  const [saving, setSaving] = useState(false)

  const finalUrl = normalizeUrl(url)
  const canSave = title.trim().length > 0 && url.trim().length > 0 && isValidUrl(finalUrl)

  const handleSave = async () => {
    if (!canSave || saving) return
    setSaving(true)
    try {
      if (mode === 'create') {
        await createBookmarkItem({ title: title.trim(), url: finalUrl, description: description.trim(), categoryId })
        showToast({ type: 'info', message: `书签「${title.trim()}」已添加` })
      } else if (bookmark) {
        await updateBookmarkItem(bookmark.id, { title: title.trim(), url: finalUrl, description: description.trim(), categoryId })
      }
      onSaved()
    } catch (e) {
      console.error('保存书签失败', e)
      showToast({ type: 'error', message: '保存失败，请重试' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 kb-overlay" onClick={onClose}>
      <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg w-[440px] shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-color)]">
          <h3 className="text-[14px] font-medium text-[var(--text-primary)]">{mode === 'create' ? '添加书签' : '编辑书签'}</h3>
          <button onClick={onClose} className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={16} /></button>
        </div>

        <div className="px-5 py-4 space-y-3.5">
          {/* URL */}
          <div>
            <label className="block text-[12px] text-[var(--text-secondary)] mb-1.5">网址</label>
            <input autoFocus={mode === 'create'} value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="example.com 或 https://..."
              className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[13px] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none"
            />
            {url.trim() && !isValidUrl(finalUrl) && (
              <p className="mt-1 text-[11px] text-red-400">网址格式不正确</p>
            )}
          </div>

          {/* 标题 */}
          <div>
            <label className="block text-[12px] text-[var(--text-secondary)] mb-1.5">标题</label>
            <input value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void handleSave() }}
              placeholder="给这个网站起个名字"
              className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[13px] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none"
            />
          </div>

          {/* 分类 */}
          <div>
            <label className="block text-[12px] text-[var(--text-secondary)] mb-1.5">分类</label>
            <select value={categoryId}
              onChange={e => setCategoryId(e.target.value)}
              className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[13px] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none"
            >
              <option value="">未分类</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          {/* 描述 */}
          <div>
            <label className="block text-[12px] text-[var(--text-secondary)] mb-1.5">描述（可选）</label>
            <textarea value={description}
              onChange={e => setDescription(e.target.value)}
              rows={2}
              placeholder="用途备注，比如：C++ 官方文档"
              className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[13px] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none resize-none"
            />
          </div>
        </div>

        {/* 底部 */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--border-color)]">
          <button onClick={onClose}
            className="px-3 py-1.5 text-[12px] rounded border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">
            取消
          </button>
          <button onClick={() => void handleSave()} disabled={!canSave || saving}
            className="px-4 py-1.5 text-[12px] rounded bg-[var(--accent)] text-white disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity">
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ==================== 分类编辑弹窗 ====================

interface CategoryModalProps {
  mode: 'create' | 'edit'
  category?: BookmarkCategory
  onClose: () => void
  onSaved: () => void
}

export function CategoryEditModal({ mode, category, onClose, onSaved }: CategoryModalProps) {
  const [name, setName] = useState(category?.name ?? '')
  const [color, setColor] = useState(category?.color ?? COLORS[6])
  const [saving, setSaving] = useState(false)

  const canSave = name.trim().length > 0

  const handleSave = async () => {
    if (!canSave || saving) return
    setSaving(true)
    try {
      if (mode === 'create') {
        await createBookmarkCategory({ name: name.trim(), color })
      } else if (category) {
        await updateBookmarkCategory(category.id, { name: name.trim(), color })
      }
      onSaved()
    } catch (e) {
      console.error('保存分类失败', e)
      showToast({ type: 'error', message: '保存失败，请重试' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 kb-overlay" onClick={onClose}>
      <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg w-[360px] shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-color)]">
          <h3 className="text-[14px] font-medium text-[var(--text-primary)]">{mode === 'create' ? '新建分类' : '编辑分类'}</h3>
          <button onClick={onClose} className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={16} /></button>
        </div>

        <div className="px-5 py-4 space-y-3.5">
          <div>
            <label className="block text-[12px] text-[var(--text-secondary)] mb-1.5">名称</label>
            <input autoFocus value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void handleSave() }}
              placeholder="例如：C++ 文档 / 在线课程 / 工具站"
              className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[13px] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none"
            />
          </div>

          <div>
            <label className="block text-[12px] text-[var(--text-secondary)] mb-1.5">颜色</label>
            <div className="flex gap-1.5 flex-wrap">
              {COLORS.map(c => (
                <button key={c} onClick={() => setColor(c)}
                  className={`w-6 h-6 rounded-full transition-transform ${color === c ? 'ring-2 ring-offset-2 scale-110 ring-[var(--accent)]' : 'hover:scale-105'}`}
                  style={{ backgroundColor: c, ['--tw-ring-offset-color' as never]: 'var(--bg-secondary)' }}
                  data-tip={c} aria-label={c}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--border-color)]">
          <button onClick={onClose}
            className="px-3 py-1.5 text-[12px] rounded border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">
            取消
          </button>
          <button onClick={() => void handleSave()} disabled={!canSave || saving}
            className="px-4 py-1.5 text-[12px] rounded bg-[var(--accent)] text-white disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity">
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
