import { useEffect, useRef, useState } from 'react'
import { X, BookText, Calendar, BookOpen, BookMarked, NotebookPen, HelpCircle, History, Settings, Trash2, Wrench, Puzzle, MessageCircle, GraduationCap, PenLine, Bot, Network, FlaskConical } from 'lucide-react'
import type { TabName } from '../../types'
import { labelOf } from '../../lib/appModules'
import { isToolTabId, toolIdOfTab, findTool } from './toolRegistry'

/**
 * 工作台中间栏**页面条**（v3.4.0「页面条置顶」+ 分屏改版，2026-09-18）。
 *
 * 一条行容纳两段（分屏时）：
 *   主段（flex-1）= 模块条目 · 编辑器页签 · 知识库页签 · [未分屏时的分屏开关]
 *   副段（宽度 = 副栏实测宽度）= 副栏模块名 ⌄ · 副栏页签 · ✕
 *
 * **为什么是「一条行两段」而不是「各栏各一条」**（开发负责人 2026-09-18 拍板）：
 * 各栏各一条时，主栏页签在**全宽**的条里、副栏页签却在副栏自己的一行里 —— 那一行只占右半边，
 * 于是两条横向底线不在同一 y、分界处断成两段，视觉上就是「右边矮了一节」。
 * 合成一条后：底线连续一条，分界竖线（副段 border-l）与下面的分屏手柄对齐
 * （副段宽度由 App 从 ResizablePanel 的 onWidthChange 实测值传入）。
 *
 * 挂载：编辑器 / 知识库各自把页签组 portal 进**自己栏对应的槽** —— 主栏 → editor / knowledge 槽，
 * 副栏 → `secondarySlotRef`。模块状态（openFiles / openPageIds …）仍全部留在模块内。
 *
 * 契约属性：行上 `data-wb="pagebar"` / `data-pb-tabs` / `data-pb-split`；
 * 条目 `data-pb-item` / `data-pb-owner` / `data-wb-tab`；槽 `data-pb-slot="editor|knowledge|secondary"`。
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

/** 模块条目里不渲染的 id：编辑器 / 知识库由各自页签组代表（模块清空页面即从条内消失） */
const PAGE_OWNED: readonly string[] = ['editor', 'knowledge']

function tabLabel(id: string): string {
  if (isToolTabId(id)) return findTool(toolIdOfTab(id))?.name ?? '工具'
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
  /** 主栏知识库页签组槽 */
  knowledgeSlotRef: (node: HTMLDivElement | null) => void
  /** 副栏页签组槽（分屏时模块 portal 目标） */
  secondarySlotRef: (node: HTMLDivElement | null) => void
  /** 主段尾部（未分屏时的分屏开关；分屏后由副段 ✕ 关闭，不再出这个按钮） */
  trail?: React.ReactNode
  /** 条最左端前置元素（编辑器「← 返回 X」chip） */
  lead?: React.ReactNode
  /** 隐藏页签组（禅模式 Z1+） */
  hidePages?: boolean
  /** 分屏副段：null = 未分屏（主段占满整条） */
  secondary?: {
    /** 副栏模块名 chip（**纯标识，非菜单** —— 由 App 渲染，见 App 的 paneChipNode） */
    lead: React.ReactNode
    /** 右端关闭 ✕ */
    trail: React.ReactNode
    /**
     * 副栏**实际占宽**（px，已解析兜底）→ 副段宽度，保证分界竖线与分屏手柄左缘对齐。
     *
     * ⚠️ 必须由 App 传入**解析后**的值（`splitSecondaryWidth`），本组件**不自带兜底** ——
     * 曾经这里写的是 `secondary.width > 0 ? secondary.width : '46%'`，与 App 的 `380px` 兜底
     * 基准不同（百分比 vs 像素），分屏首帧副段比副栏窄/宽 → 分界竖线错位
     * （2026-09-18 实机探针 S2e：secWrap=663 / pane=582，Δ=81px）。兜底只该有一处。
     */
    width: number
  } | null
}

export function WorkbenchPageBar({ tabs, active, onSelect, onClose, onReorder, editorSlotRef, knowledgeSlotRef, secondarySlotRef, trail = null, lead = null, hidePages = false, secondary = null }: Props) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const dragIdRef = useRef<string | null>(null)
  const rowRef = useRef<HTMLDivElement | null>(null)
  /** 页签组是否有条目由**模块侧渲染决定**（portal 进来才有），外壳拿不到 → 观察 DOM */
  const [hasAnyItem, setHasAnyItem] = useState(false)

  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    const check = () => setHasAnyItem(!!el.querySelector('[data-pb-item]'))
    check()
    const mo = new MutationObserver(check)
    mo.observe(el, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [])

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
      data-pb-split={secondary ? '1' : '0'}
      className="flex h-9 shrink-0 select-none items-stretch overflow-hidden border-b border-[var(--border-color)] bg-[var(--bg-primary)]"
    >
      {/* 主段：模块条目 + 主栏两个页签组 + 未分屏时的分屏开关 */}
      <div data-pb-main className="flex min-w-0 flex-1 items-center gap-1 px-1.5">
        {lead}
        {visible.map((id) => {
          const isActive = id === active
          return (
            <div
              key={id}
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
              className={`group flex h-7 max-w-[200px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12.5px] transition-colors ${
                isActive
                  ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
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
          )
        })}
        {/* 主栏编辑器页签组槽：flex-1 让组内横向滚动（组内容器带 overflow-x-auto） */}
        <div ref={editorSlotRef} data-pb-slot="editor" className={`flex min-w-0 flex-1 items-center gap-1 ${hidePages ? 'hidden' : ''}`} />
        {/* 主栏知识库页签组槽 */}
        <div ref={knowledgeSlotRef} data-pb-slot="knowledge" className={`flex min-w-0 shrink-0 max-w-[50%] items-center gap-1 overflow-x-auto ${hidePages ? 'hidden' : ''}`} />
        {!secondary && trail && <div className="ml-1 flex shrink-0 items-center gap-0.5">{trail}</div>}
        {!hasAnyItem && !secondary && (
          <span className="pointer-events-none px-1.5 text-[12px] italic text-[var(--text-muted)]">
            没有打开的页面 —— 从左侧书签或图标条打开模块
          </span>
        )}
      </div>

      {/* 副段（分屏时）：模块名 ⌄ + 副栏页签组 + ✕；宽度 = 副栏实测宽度，border-l 与分屏手柄对齐 */}
      {secondary && (
        <div
          data-pb-slot-wrap="secondary"
          style={{ width: secondary.width }}
          className="flex min-w-0 shrink-0 items-center gap-1 border-l border-[var(--border-color)] pl-1.5 pr-1"
        >
          {secondary.lead}
          <div ref={secondarySlotRef} data-pb-slot="secondary" className={`flex min-w-0 flex-1 items-center gap-1 overflow-x-auto ${hidePages ? 'hidden' : ''}`} />
          {secondary.trail}
        </div>
      )}
    </div>
  )
}
