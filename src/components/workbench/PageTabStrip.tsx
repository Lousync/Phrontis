import { useState, useCallback } from 'react'
import { X, Pin, PenLine, BookOpen } from 'lucide-react'
import { getFileTypeInfo } from '../../lib/fileTypes'

/**
 * 页面条条目（工作台中间栏「页面条置顶」共用展示组件，2026-09-18）。
 *
 * 为什么抽这一层：编辑器原来的文件标签行（圆角卡片式、与正文连体）与知识库原来的
 * `PageTabBar`（h-9 全高款 + 下边框）是两套外观，搬进同一条页面条后必须长得一样，
 * 否则「一条横排」的语义就散了。这里只保留**展示与条目级交互**，数据与业务动作
 * 仍由各自模块传入（两边状态都不上提，见 DP 方案 workbench-pagebar-design.md §4）。
 *
 * 来源标识：`owner` 决定图标与配色 —— 编辑器文件 = 青色笔，知识库页面 = 蓝色书
 * （开发负责人 2026-09-18 拍板：「为图标加页面名，不同的图标来区分是编辑区还是知识库」）。
 *
 * 属性契约：条目自带 `data-pb-item`（页面条空态提示靠 CSS `:has` 判定，不数子节点），
 * 以及 `data-tab-rel`（编辑器：激活标签自动滚入可视区依赖）或 `data-tab-id`（知识库）。
 */
export interface StripItem {
  id: string
  title: string
  /** 预览态（斜体）：浏览产生、会被下一次浏览原位替换 */
  preview?: boolean
  /** 有未保存改动：实心点 */
  dirty?: boolean
  /** 文件已在磁盘上被删除：删除线 */
  missing?: boolean
  /** 已固定（图钉常亮） */
  pinned?: boolean
  /** 类型角标（如 PAGE / MD） */
  badge?: string
}

interface Props {
  owner: 'editor' | 'knowledge'
  items: StripItem[]
  activeId: string | null
  itemAttr: 'data-tab-rel' | 'data-tab-id'
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** 组内拖拽重排；不传 = 该组条目不可拖（编辑器文件标签改前就没有重排，保持一致） */
  onReorder?: (ids: string[]) => void
  onTogglePin?: (id: string) => void
  onContextMenu?: (e: React.MouseEvent, id: string) => void
  /**
   * 该组所在栏是否为**当前栏焦点**（VS Code 式分屏焦点表达：非焦点栏的激活标签不再高亮，
   * 整条轻微淡化；不分屏时恒为 true）。默认 true。
   */
  paneActive?: boolean
}

/** 来源配色（方案 §1）：编辑器文件=青 #2a988f，知识库页面=蓝 #4f6ef2 */
const OWNER_COLOR: Record<'editor' | 'knowledge', string> = {
  editor: '#2a988f',
  knowledge: '#4f6ef2',
}

export function PageTabStrip({ owner, items, activeId, itemAttr, onSelect, onClose, onReorder, onTogglePin, onContextMenu, paneActive = true }: Props) {
  const [draggedId, setDraggedId] = useState<string | null>(null)

  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
    setDraggedId(id)
    ;(e.currentTarget as HTMLElement).style.opacity = '0.4'
  }, [])

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    ;(e.currentTarget as HTMLElement).style.opacity = '1'
    setDraggedId(null)
    document.querySelectorAll('[data-tab-id],[data-tab-rel]').forEach((el) => {
      ;(el as HTMLElement).style.boxShadow = ''
    })
  }, [])

  // 条目自身也接受落点：按左右半区决定插前 / 插后
  const handleDragOver = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const srcId = e.dataTransfer.getData('text/plain')
    if (!srcId || srcId === targetId) {
      ;(e.currentTarget as HTMLElement).style.boxShadow = ''
      return
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const side = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right'
    ;(e.currentTarget as HTMLElement).style.boxShadow =
      side === 'left' ? 'inset 2px 0 0 var(--accent)' : 'inset -2px 0 0 var(--accent)'
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    ;(e.currentTarget as HTMLElement).style.boxShadow = ''
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).style.boxShadow = ''
    if (!onReorder) return
    const srcId = e.dataTransfer.getData('text/plain')
    if (!srcId || srcId === targetId) return
    const ids = items.map((it) => it.id)
    const srcIdx = ids.indexOf(srcId)
    const dstIdx = ids.indexOf(targetId)
    if (srcIdx === -1 || dstIdx === -1) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const side = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right'
    ids.splice(srcIdx, 1)
    const insertIdx = side === 'right' ? ids.indexOf(targetId) + 1 : ids.indexOf(targetId)
    ids.splice(insertIdx, 0, srcId)
    onReorder(ids)
  }, [items, onReorder])

  // hooks 一律在早退之前（React #310：早退后再声明 hook 会整屏崩）
  if (items.length === 0) return null

  return (
    <div
      data-pb-group={owner}
      data-pane-active={paneActive ? '1' : '0'}
      className={`flex min-w-0 items-center gap-1 ${paneActive ? '' : 'opacity-75'}`}
    >
      {items.map((it) => {
        const isActive = it.id === activeId
        const isDragged = it.id === draggedId
        const tip = [
          it.title,
          it.preview ? '预览标签（双击固定）' : '',
          it.missing ? '文件已在磁盘上被删除，保存将重新创建' : '',
        ].filter(Boolean).join(' · ')
        const fi = it.badge ? getFileTypeInfo(it.badge) : null
        return (
          <div
            key={it.id}
            data-pb-item
            data-pb-owner={owner}
            {...{ [itemAttr]: it.id }}
            draggable={!!onReorder}
            onClick={() => onSelect(it.id)}
            onDoubleClick={onTogglePin ? () => onTogglePin(it.id) : undefined}
            onMouseDown={(e) => { if (e.button === 1) e.preventDefault() }}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(it.id) } }}
            onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e, it.id) } : undefined}
            onDragStart={onReorder ? (e) => handleDragStart(e, it.id) : undefined}
            onDragEnd={onReorder ? handleDragEnd : undefined}
            onDragOver={onReorder ? (e) => handleDragOver(e, it.id) : undefined}
            onDragLeave={onReorder ? handleDragLeave : undefined}
            onDrop={onReorder ? (e) => handleDrop(e, it.id) : undefined}
            title={tip}
            className={`group flex h-7 max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12.5px] transition-colors ${
              isDragged ? 'opacity-40' : ''
            } ${
              isActive
                ? (paneActive
                    ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                    /* 非焦点栏：激活标签不再给底色（VS Code 的不焦点组观感），只保留主文本色 */
                    : 'bg-transparent text-[var(--text-secondary)]')
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            <span className="shrink-0" style={{ color: OWNER_COLOR[owner] }}>
              {owner === 'editor' ? <PenLine size={13} /> : <BookOpen size={13} />}
            </span>
            <span className={`truncate ${it.preview ? 'italic' : ''} ${it.missing ? 'line-through' : ''}`}>{it.title}</span>
            {it.dirty && <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" />}
            {fi && (
              <span className="shrink-0 rounded px-1 text-[8px] font-medium" style={{ backgroundColor: fi.color + '20', color: fi.color }}>
                {fi.badge}
              </span>
            )}
            {onTogglePin && (
              <button
                onClick={(e) => { e.stopPropagation(); onTogglePin(it.id) }}
                onDoubleClick={(e) => e.stopPropagation()}
                className={`shrink-0 rounded p-0.5 hover:bg-[var(--bg-hover)] ${
                  it.pinned
                    ? 'opacity-100 text-[var(--accent)]'
                    : 'opacity-0 text-[var(--text-muted)] group-hover:opacity-100 hover:text-[var(--text-primary)]'
                }`}
                title={it.pinned ? '取消固定' : '固定标签（双击标签也可）'}
              >
                <Pin size={11} className={it.pinned ? 'fill-current' : undefined} />
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); onClose(it.id) }}
              onDoubleClick={(e) => e.stopPropagation()}
              className={`shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ${
                isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
              title="关闭（中键点击也可）"
            >
              <X size={13} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
