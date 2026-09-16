import { useRef, useState } from 'react'
import { X, BookText, Calendar, BookOpen, BookMarked, NotebookPen, HelpCircle, History, Settings, Trash2, Wrench, Puzzle, MessageCircle, GraduationCap, PenLine, Bot, Network, FlaskConical } from 'lucide-react'
import type { TabName } from '../../types'
import { labelOf } from '../../lib/appModules'

/**
 * 工作台中间栏标签条（v3.4.0，方案 §3.2）。
 *
 * 与旧 TabBar.tsx（博客模块内部页签，两者无关）的区别：这是**全局 Tab 标签条**——
 * 显示 openTabs（已打开的 Tab，只能由入口产生，没有「＋新建」按钮，入口永远幂等）。
 * 支持：激活 / 关闭（✕ 与中键）/ 拖拽重排 / 最后一个标签不可关。
 * aiTeaching 与 devtools 不进标签条（见 workbenchLayout.WORKBENCH_TABBAR_EXCLUDED）。
 */

const TAB_ICONS: Record<string, React.ReactNode> = {
  editor: <PenLine size={14} />,
  knowledge: <BookOpen size={14} />,
  blog: <NotebookPen size={14} />,
  schedule: <Calendar size={14} />,
  moments: <MessageCircle size={14} />,
  aiTeaching: <GraduationCap size={14} />,
  toolbox: <Wrench size={14} />,
  plugins: <Puzzle size={14} />,
  recycle: <Trash2 size={14} />,
  help: <HelpCircle size={14} />,
  settings: <Settings size={14} />,
  releaseNotes: <History size={14} />,
  bookshelf: <BookMarked size={14} />,
  aiChat: <Bot size={14} />,
  graph: <Network size={14} />,
  devtools: <FlaskConical size={14} />,
}

/** 未收录模块的兜底图标（新增 Tab 忘配图标时不出空白） */
const FALLBACK_ICON = <BookText size={14} />

interface Props {
  tabs: TabName[]
  active: TabName
  onSelect: (tab: TabName) => void
  onClose: (tab: TabName) => void
  onReorder: (tabs: TabName[]) => void
}

export function WorkbenchTabBar({ tabs, active, onSelect, onClose, onReorder }: Props) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const dragIdRef = useRef<string | null>(null)

  if (tabs.length === 0) return null

  const handleDragStart = (e: React.DragEvent, id: TabName) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
    dragIdRef.current = id
    setDragId(id)
    requestAnimationFrame(() => {
      (e.currentTarget as HTMLElement | null)?.style?.setProperty('opacity', '0.4')
    })
  }

  const handleDragEnd = (e: React.DragEvent) => {
    (e.currentTarget as HTMLElement | null)?.style?.setProperty('opacity', '1')
    dragIdRef.current = null
    setDragId(null)
    setDragOverId(null)
  }

  const handleDrop = (e: React.DragEvent, targetId: TabName) => {
    e.preventDefault()
    // 拖拽源优先取 ref（TabName），兜底 dataTransfer（text/plain 是 string，需窄化）
    const raw = dragIdRef.current ?? e.dataTransfer.getData('text/plain')
    setDragOverId(null)
    if (!raw || raw === targetId) return
    const srcId = raw as TabName
    const next = [...tabs]
    const from = next.indexOf(srcId)
    const to = next.indexOf(targetId)
    if (from === -1 || to === -1) return
    next.splice(from, 1)
    next.splice(to, 0, srcId)
    onReorder(next)
  }

  return (
    <div data-wb="tabbar" className="flex h-8 shrink-0 select-none items-stretch border-b border-[var(--border-color)] bg-[color-mix(in_srgb,var(--bg-secondary)_60%,transparent)]">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((id) => {
          const isActive = id === active
          const canClose = tabs.length > 1
          return (
            <div
              key={id}
              data-wb="tab"
              data-wb-tab={id}
              data-wb-active={isActive ? '1' : '0'}
              draggable
              onDragStart={(e) => handleDragStart(e, id)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragId && dragId !== id) setDragOverId(id) }}
              onDrop={(e) => handleDrop(e, id)}
              onClick={() => onSelect(id)}
              onAuxClick={(e) => { if (e.button === 1 && canClose) { e.preventDefault(); onClose(id) } }}
              title={labelOf(id)}
              className={`
                group relative flex min-w-0 shrink-0 cursor-pointer items-center gap-1.5 px-2.5 text-[12px] transition-colors duration-100
                ${isActive
                  ? 'bg-[var(--bg-primary)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]/60 hover:text-[var(--text-primary)]'}
                ${dragOverId === id ? 'after:absolute after:inset-y-0 after:left-0 after:w-[2px] after:bg-[var(--accent)]' : ''}
              `}
            >
              {isActive && <div className="absolute inset-x-0 top-0 h-[2px] bg-[var(--accent)]" />}
              <span className={`shrink-0 ${isActive ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}>
                {TAB_ICONS[id] ?? FALLBACK_ICON}
              </span>
              <span className="max-w-[140px] truncate">{labelOf(id)}</span>
              {canClose && (
                <button
                  onClick={(e) => { e.stopPropagation(); onClose(id) }}
                  title="关闭"
                  className="ml-0.5 shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 transition-opacity hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] group-hover:opacity-100"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
