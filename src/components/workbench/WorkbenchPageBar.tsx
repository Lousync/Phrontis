import { Fragment, useRef, useState } from 'react'
import { X, BookText, Calendar, BookOpen, BookMarked, NotebookPen, HelpCircle, History, Settings, Trash2, Wrench, Puzzle, MessageCircle, GraduationCap, PenLine, Bot, Network, FlaskConical, FileQuestion } from 'lucide-react'
import type { TabName } from '../../types'
import { labelOf } from '../../lib/appModules'
import { isToolTabId, toolIdOfTab, findTool } from './toolRegistry'

/**
 * 工作台中间栏**页面条**（v3.4.0「页面条置顶」，2026-09-18）。
 *
 * 一条行 = 模块条目 · 编辑器页签 · 知识库页签 · 尾部动作。
 * 编辑器 / 知识库两个模块的页签组由模块自己 portal 进来（主栏各自的槽），
 * 模块条目与两个模块的页面条目同排，原「子模块标签条」由这条页面条取代。
 *
 * 挂载：编辑器 / 知识库各自把页签组 portal 进**自己模块的槽** —— 模块状态
 * （openFiles / openPageIds …）仍全部留在模块内。
 *
 * 契约属性：行上 `data-wb="pagebar"` / `data-pb-tabs`；
 * 条目 `data-pb-item` / `data-pb-owner` / `data-wb-tab`；槽 `data-pb-slot="editor|knowledge"`。
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
  quiz: <FileQuestion size={14} />,
}

/** 未收录模块的兜底图标（新增 Tab 忘配图标时不出空白） */
const FALLBACK_ICON = <BookText size={14} />

/** 模块条目里不渲染的 id：编辑器 / 知识库由各自页签组代表（模块清空页面即从条内消失） */
/** 页签组代表制：这两个模块的条目不进页面条（由各自页签组代表），App 全关判定也依赖此口径 */
export const PAGE_OWNED: readonly string[] = ['editor', 'knowledge']

function tabLabel(id: string): string {
  if (isToolTabId(id)) return findTool(toolIdOfTab(id))?.name ?? '工具'
  // quiz 不是 TabName（错题本 = 知识库的错题本子视图，2026-09-19 起在页面条有专属条目）
  if (id === 'quiz') return '错题本'
  return labelOf(id as TabName)
}

function tabIcon(id: string): React.ReactNode {
  if (isToolTabId(id)) {
    const t = findTool(toolIdOfTab(id))
    if (t) return <t.Icon size={14} />
    return <Wrench size={14} />
  }
  return TAB_ICONS[id] ?? FALLBACK_ICON
}

/** 只重排「可见条目」的序，被隐藏的 id（编辑器/知识库）保持原相对位置 */
function applyReorder(all: string[], visible: string[], nextVisible: string[]): string[] {
  const set = new Set(visible)
  const out: string[] = []
  let inserted = false
  for (const t of all) {
    if (set.has(t)) {
      if (!inserted) {
        out.push(...nextVisible)
        inserted = true
      }
      continue
    }
    out.push(t)
  }
  if (!inserted) out.push(...nextVisible)
  return out
}

interface Props {
  tabs: string[]
  active: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onReorder: (tabs: string[]) => void
  /** 主栏编辑器页签组槽（模块 portal 目标） */
  editorSlotRef: (node: HTMLDivElement | null) => void
  /** 知识库页签组槽 */
  knowledgeSlotRef: (node: HTMLDivElement | null) => void
  /** 错题本专属条目（2026-09-19 反馈）：知识库的错题本子视图打开时显示；点击回知识库 + 定位错题本。
      无关闭钮——视图随知识库标签存在，关闭错题本视图后条目自动消失 */
  showQuizEntry?: boolean
  quizEntryActive?: boolean
  /** 条尾部动作 */
  trail?: React.ReactNode
  /** 条最左端前置元素（编辑器「← 返回 X」chip） */
  lead?: React.ReactNode
  /** 隐藏页签组（禅模式 Z1+） */
  hidePages?: boolean
}

export function WorkbenchPageBar({ tabs, active, onSelect, onClose, onReorder, editorSlotRef, knowledgeSlotRef, showQuizEntry = false, quizEntryActive = false, trail = null, lead = null, hidePages = false }: Props) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const dragIdRef = useRef<string | null>(null)
  const rowRef = useRef<HTMLDivElement | null>(null)

  const visible = tabs.filter((t) => !PAGE_OWNED.includes(t))
  const reorderTo = (next: string[]) => onReorder(applyReorder(tabs, visible, next))

  const handleDragStart = (e: React.DragEvent, id: string) => {
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

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    const raw = dragIdRef.current ?? e.dataTransfer.getData('text/plain')
    setDragOverId(null)
    if (!raw || raw === targetId) return
    const next = [...visible]
    const from = next.indexOf(raw)
    const to = next.indexOf(targetId)
    if (from === -1 || to === -1) return
    next.splice(from, 1)
    next.splice(to, 0, raw)
    reorderTo(next)
  }

  return (
    <div
      ref={rowRef}
      data-wb="pagebar"
      data-pb-tabs={tabs.join(',')}
      /* Edge Fluent（2026-09-19）：行底不用 border-b（滚动槽的 overflow 会裁掉负 margin 贴边），
         改为行内 hairline 子元素——激活条目（positioned、DOM 靠后）自然盖住它形成「与内容区同体」；
         items-end 让条目沉底，overflow-x-clip 只拦首尾条目内凹弧的水平外溢、不裁垂直融合。 */
      className="relative flex h-9 shrink-0 select-none items-end overflow-x-clip bg-[var(--bg-secondary)] px-1.5"
    >
      {/* hairline：页面条与内容区的分隔线（激活条目处被同色条目盖住） */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-[var(--border-color)]" />
      {/* 模块条目 + 两个模块的页签组 + 尾部动作 */}
      <div data-pb-main className="flex min-w-0 flex-1 items-end gap-1 px-1.5 self-stretch">
        {lead && <div className="flex shrink-0 items-center self-center">{lead}</div>}
        {visible.map((id, i) => {
          const isActive = id === active
          // Edge 细分隔线：与左邻都是非激活条目时才画（悬停任一侧由 CSS :has/相邻选择器淡出）
          const prevId = i > 0 ? visible[i - 1] : null
          const showSep = prevId !== null && prevId !== active && id !== active
          return (
            <Fragment key={id}>
              {showSep && <div className="kb-edge-sep" />}
              <div
                data-pb-item
                data-pb-owner="module"
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
                title={tabLabel(id)}
                className={`kb-edge-tab group flex max-w-[200px] shrink-0 cursor-pointer items-center gap-1.5 px-2.5 text-[12.5px] transition-colors ${
                  isActive
                    ? 'kb-edge-tab-active h-[34px] text-[var(--text-primary)]'
                    : 'h-[30px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                <span className={`shrink-0 ${isActive ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}>{tabIcon(id)}</span>
                <span className="max-w-[140px] truncate">{tabLabel(id)}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); onClose(id) }}
                  onAuxClick={(e) => e.stopPropagation()}
                  title="关闭标签页"
                  className={`shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ${
                    isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                  }`}
                >
                  <X size={11} />
                </button>
              </div>
            </Fragment>
          )
        })}
        {/* 错题本专属条目（合成条目，非 openTabs 成员）：视图态随错题本开合 */}
        {showQuizEntry && (
          <div
            data-pb-item
            data-pb-owner="module"
            data-wb="tab"
            data-wb-tab="quiz"
            data-wb-active={quizEntryActive ? '1' : '0'}
            onClick={() => onSelect('quiz')}
            title="错题本 / 收藏"
            className={`kb-edge-tab group flex shrink-0 cursor-pointer items-center gap-1.5 px-2.5 text-[12.5px] transition-colors ${
              quizEntryActive
                ? 'kb-edge-tab-active h-[34px] text-[var(--text-primary)]'
                : 'h-[30px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            <span className={`shrink-0 ${quizEntryActive ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}>{TAB_ICONS.quiz}</span>
            <span>错题本</span>
            <button
              onClick={(e) => { e.stopPropagation(); onClose('quiz') }}
              onAuxClick={(e) => e.stopPropagation()}
              title="关闭错题本"
              className={`shrink-0 rounded p-0.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ${
                quizEntryActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
            >
              <X size={11} />
            </button>
          </div>
        )}
        {/* 知识库页签组槽：紧跟模块条目从左排起（2026-09-19 反馈：原排在 flex-1 编辑器槽之后，
            页签组被顶到行最右端、贴着右栏，看起来像排错位置）。 */}
        <div ref={knowledgeSlotRef} data-pb-slot="knowledge" className={`kb-edge-strip flex min-w-0 shrink-0 max-w-[50%] items-end gap-1 overflow-x-auto ${hidePages ? 'hidden' : ''}`} />
        {/* 主栏编辑器页签组槽：flex-1 让组内横向滚动（组内容器带 overflow-x-auto） */}
        <div ref={editorSlotRef} data-pb-slot="editor" className={`flex min-w-0 flex-1 items-end gap-1 ${hidePages ? 'hidden' : ''}`} />
        {trail && <div className="self-center ml-1 flex shrink-0 items-center gap-0.5">{trail}</div>}
        {/* 空态提示文字已删（2026-09-18 反馈轮）：「没有打开的页面 —— 从左侧书签或图标条打开模块」
            属冗余说明（左栏书签 / 图标条本身就是入口），按铁律 12 只收不增 → 整块去掉 */}
      </div>
    </div>
  )
}
