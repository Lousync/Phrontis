import { useRef, useState } from 'react'
import { X, BookText, Calendar, BookOpen, BookMarked, NotebookPen, HelpCircle, History, Settings, Trash2, Wrench, Puzzle, MessageCircle, GraduationCap, PenLine, Bot, Network, FlaskConical } from 'lucide-react'
import type { TabName } from '../../types'
import { labelOf } from '../../lib/appModules'

/**
 * 工作台中间栏标签条（v3.4.0 方案 §3.2；2026-09-17 第三轮 UI 反馈拍板定稿）。
 *
 * **文档标签式动态标签条**：显示 openTabs（已打开的 Tab，只能由入口产生，没有「＋新建」
 * 按钮，入口永远幂等）。模块按钮不上标签栏——模块 = 与工作台同级的成员，由左栏书签 /
 * 图标条等入口打开，打开效果与旧版一致（中间主体整个显示该模块）。
 * 支持：激活 / 关闭（✕ 悬停显形 + 中键）/ 拖拽重排 / **全部关闭出空态**（2026-09-17 拍板③）。
 * 样式对齐编辑器文档标签栏：激活标签与内容区**连体**（rounded-t + border，底边与内容区
 * 同色盖住标签条底线），消除旧版「标签与内容区之间隔着一条线」的分离感。
 * aiTeaching（整窗形态，标签条本身隐藏）与 devtools 不画成标签（WORKBENCH_TABBAR_EXCLUDED，
 * 由 App 侧过滤 openTabs 后传入）。
 *
 * 与旧 TabBar.tsx（博客模块内部页签，两者无关）。
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
  active: TabName | null
  onSelect: (tab: TabName) => void
  onClose: (tab: TabName) => void
  onReorder: (tabs: TabName[]) => void
}

export function WorkbenchTabBar({ tabs, active, onSelect, onClose, onReorder }: Props) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const dragIdRef = useRef<string | null>(null)

  if (tabs.length === 0) {
    // 全关空态（2026-09-17 拍板③：允许全部关闭）；中间内容区由 App 渲染空态页
    return (
      <div data-wb="tabbar" className="flex h-8 shrink-0 select-none items-center border-b border-[var(--border-color)] bg-[color-mix(in_srgb,var(--bg-secondary)_60%,transparent)] px-3">
        <span className="text-[12px] italic text-[var(--text-muted)]">没有打开的标签页 —— 从左侧书签或图标条打开模块</span>
      </div>
    )
  }

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
    <div data-wb="tabbar" className="flex h-8 shrink-0 select-none items-stretch overflow-x-auto border-b border-[var(--border-color)] bg-[color-mix(in_srgb,var(--bg-secondary)_60%,transparent)] px-1.5">
      {tabs.map((id) => {
        const isActive = id === active
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
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(id) } }}
            title={labelOf(id)}
            className={`group relative flex max-w-[200px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border px-2.5 text-[12.5px] transition-colors ${
              isActive
                // 连体：激活标签底边与内容区同色，盖住标签条底线（消除分离感）
                ? 'border-[var(--border-color)] border-b-[var(--bg-primary)] bg-[var(--bg-primary)] text-[var(--text-primary)]'
                : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
            } ${dragOverId === id ? 'after:absolute after:inset-y-0 after:left-0 after:w-[2px] after:bg-[var(--accent)]' : ''}`}
          >
            <span className={`shrink-0 ${isActive ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}>
              {TAB_ICONS[id] ?? FALLBACK_ICON}
            </span>
            <span className="max-w-[140px] truncate">{labelOf(id)}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onClose(id) }}
              onAuxClick={(e) => e.stopPropagation()}
              title="关闭标签页"
              className="ml-0.5 shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 transition-opacity hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] group-hover:opacity-100"
            >
              <X size={11} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
