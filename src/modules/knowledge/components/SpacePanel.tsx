import { useState } from 'react'
import { ArrowLeft, Layers, Pencil, LogOut } from 'lucide-react'
import type { KnowledgeCategory } from '../../../types'

interface Props {
  space: KnowledgeCategory
  onCollapse: () => void
  onRename?: (id: string, name: string) => void
  /** 2026-09-07：目录拖到空间头 = 移出学习空间（移到仓库根级作中转，可再拖入其它空间） */
  onMoveOut?: (categoryId: string) => void
  /** 右侧扩展动作槽（目录聚焦开关等），停靠行尾 */
  extraAction?: React.ReactNode
}

/**
 * 空间沉浸视图的顶部返回栏 — 打开某个空间后显示。
 * 注意：NotebookList 始终挂载（保留展开状态），此组件只是在其上方叠加返回头。
 *
 * 拖出手势：拖动空间内的笔记本/文件夹到本栏时整栏高亮并提示「松开移出学习空间」，
 * 松开即把该目录移到仓库根级（dataTransfer 类型 application/x-kb-category，由 NotebookList dragStart 写入）。
 */
export function SpacePanel({ space, onCollapse, onRename, onMoveOut, extraAction }: Props) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(space.name)
  const [dragOver, setDragOver] = useState(false)

  const commit = () => {
    setEditing(false)
    const trimmed = name.trim()
    if (trimmed && trimmed !== space.name) onRename?.(space.id, trimmed)
    else setName(space.name)
  }

  return (
    <div
      className={`relative flex items-center gap-1.5 px-2 py-1.5 border-b shrink-0 transition-colors ${
        dragOver
          ? 'border-[var(--accent)] bg-[var(--accent)]/15 ring-1 ring-inset ring-[var(--accent)]'
          : 'border-[var(--border-color)]'
      }`}
      onDragOver={e => {
        if (!e.dataTransfer.types.includes('application/x-kb-category')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDragOver(true)
      }}
      onDragLeave={e => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return
        setDragOver(false)
      }}
      onDrop={e => {
        setDragOver(false)
        if (!onMoveOut) return
        const id = e.dataTransfer.getData('application/x-kb-category')
        if (id) { e.preventDefault(); e.stopPropagation(); onMoveOut(id) }
      }}
    >
      <button
        onClick={onCollapse}
        className="p-0.5 rounded hover:bg-[var(--input-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        data-tip="返回空间列表" aria-label="返回空间列表"
      >
        <ArrowLeft size={18} />
      </button>
      <Layers size={15} className="shrink-0 text-[var(--info)]" />
      {editing ? (
        <input
          className="flex-1 min-w-0 bg-[var(--input-bg)] border border-[var(--accent)] rounded px-1.5 py-0.5 text-[12px] outline-none text-[var(--text-primary)]"
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setName(space.name); setEditing(false) } }}
          autoFocus
        />
      ) : (
        <>
          <span className="text-[12px] font-medium text-[var(--text-secondary)] truncate">{space.name}</span>
          {onRename && (
            <button
              onClick={() => { setName(space.name); setEditing(true) }}
              className="p-0.5 rounded hover:bg-[var(--input-bg)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              data-tip="重命名空间" aria-label="重命名空间"
            >
              <Pencil size={12} />
            </button>
          )}
        </>
      )}
      {/* 右侧扩展动作（目录聚焦开关等）；拖出提示出现时让位隐藏 */}
      {extraAction && !dragOver && (
        <div className="ml-auto flex items-center shrink-0">{extraAction}</div>
      )}
      {/* 拖出提示：拖动目录悬停本栏时浮现 */}
      {dragOver && (
        <span className="ml-auto flex items-center gap-1 text-[11px] text-[var(--accent)] shrink-0">
          <LogOut size={12} />
          松开移出学习空间
        </span>
      )}
    </div>
  )
}
