import { useState } from 'react'
import type { ScheduleTag } from '../../../types'
import { isSummaryTagName } from '../../../lib/summary'
import { X, Plus, Trash2, Lock } from 'lucide-react'
import { usePresence } from '../../../lib/usePresence'

interface Props {
  open: boolean
  tags: ScheduleTag[]
  onClose: () => void
  onCreateTag: (name: string, color: string) => Promise<ScheduleTag>
  onDeleteTag: (id: string) => Promise<void>
}

const TAG_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#6b7280']

export function TagManageModal({ open, tags, onClose, onCreateTag, onDeleteTag }: Props) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(TAG_COLORS[0])
  const [deleting, setDeleting] = useState<string | null>(null)
  // 进出场动效（docs/ui-animation-plan.md B 类）：关闭时延迟卸载以播完退场
  const { mounted, closing } = usePresence(open, 180)

  if (!mounted) return null

  async function handleCreate() {
    if (!name.trim()) return
    await onCreateTag(name.trim(), color)
    setName('')
  }

  async function handleDelete(id: string) {
    setDeleting(id)
    try { await onDeleteTag(id) } catch { /* ignore */ }
    setDeleting(null)
  }

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/50 ${closing ? 'kb-overlay-out' : 'kb-overlay'}`} onClick={onClose}>
      <div
        className={`bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg w-[420px] shadow-2xl ${closing ? 'kb-modal-out' : 'kb-modal-in'}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-color)]">
          <h3 className="text-[14px] font-medium text-[var(--text-primary)]">管理标签</h3>
          <button onClick={onClose} className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={16} /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* create new tag */}
          <div>
            <label className="block text-[11px] text-[var(--text-muted)] mb-1.5">新建标签</label>
            <div className="flex gap-2 mb-1.5">
              {TAG_COLORS.map(c => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={`w-6 h-6 rounded-full transition-all ${color === c ? 'ring-2 ring-white scale-110' : ''}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="标签名称"
                className="flex-1 px-3 py-1.5 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[13px] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none"
                onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
              />
              <button
                onClick={handleCreate}
                disabled={!name.trim()}
                className="flex items-center gap-1 px-3 py-1.5 text-[12px] bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)] disabled:opacity-40"
              >
                <Plus size={13} /> 创建
              </button>
            </div>
          </div>

          {/* existing tags list */}
          <div>
            <label className="block text-[11px] text-[var(--text-muted)] mb-1.5">
              已有标签 ({tags.filter(t => !isSummaryTagName(t.name)).length})
            </label>
            {tags.filter(t => !isSummaryTagName(t.name)).length === 0 ? (
              <p className="text-[12px] text-[var(--text-disabled)] italic">暂无标签</p>
            ) : (
              <div className="space-y-1 max-h-[200px] overflow-y-auto">
                {tags.filter(t => !isSummaryTagName(t.name)).map(t => (
                  <div key={t.id} className="flex items-center justify-between px-3 py-2 bg-[var(--bg-tertiary)] rounded">
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: t.color }} />
                      <span className="text-[13px] text-[var(--text-primary)]">{t.name}</span>
                    </div>
                    <button
                      onClick={() => handleDelete(t.id)}
                      disabled={deleting === t.id}
                      className="p-1 text-[var(--text-muted)] hover:text-[var(--danger)] disabled:opacity-40 transition-colors"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 系统来源标签（周任务/月任务）：表达任务来源而非用户分类，锁定不可删 */}
          {tags.some(t => isSummaryTagName(t.name)) && (
            <div>
              <label className="block text-[11px] text-[var(--text-muted)] mb-1.5">
                来源标签
              </label>
              <div className="space-y-1">
                {tags.filter(t => isSummaryTagName(t.name)).map(t => (
                  <div key={t.id} className="flex items-center justify-between px-3 py-2 bg-[var(--bg-tertiary)]/60 rounded opacity-80">
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: t.color }} />
                      <span className="text-[13px] text-[var(--text-secondary)]">{t.name}</span>
                    </div>
                    <span className="flex items-center gap-1 text-[11px] text-[var(--text-disabled)]" data-tip="由周/月总结功能自动维护，创建对应总结任务时自动使用" aria-label="由周/月总结功能自动维护，创建对应总结任务时自动使用">
                      <Lock size={11} /> 来源
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
