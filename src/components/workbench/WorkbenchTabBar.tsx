import { BookText, Calendar, BookOpen, BookMarked, NotebookPen, HelpCircle, History, Settings, Trash2, Wrench, Puzzle, MessageCircle, GraduationCap, PenLine, Bot, Network, FlaskConical } from 'lucide-react'
import type { TabName } from '../../types'
import { labelOf } from '../../lib/appModules'

/**
 * 工作台顶部模块切换条（v3.4.0，方案 §3.2；2026-09-16 第二轮 UI 反馈拍板修订）。
 *
 * **固定模块单选切换器**，不是停靠标签页：清单 = WORKBENCH_SWITCHER_TABS（APP_MODULES
 * 派生的固定全集，排除 aiTeaching / devtools），点击 = 单选切换（与旧版顶部一个效果——
 * 「其他模块整合进了工作台」）。没有 ✕ 关闭、没有中键关闭、没有拖拽重排。
 *
 * 样式对齐编辑器文档标签栏（editor/index.tsx）：`rounded-t-md border border-b-0` 软标签，
 * 激活态 = 底色浮起 + 边框显形，与内容区融为一体。
 *
 * 与旧 TabBar.tsx（博客模块内部页签，两者无关）。
 * aiTeaching 与 devtools 不进切换条（见 workbenchLayout.WORKBENCH_TABBAR_EXCLUDED）。
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
  tabs: readonly TabName[]
  active: TabName
  onSelect: (tab: TabName) => void
}

export function WorkbenchTabBar({ tabs, active, onSelect }: Props) {
  return (
    <div data-wb="tabbar" className="flex h-8 shrink-0 select-none items-center gap-0.5 overflow-x-auto border-b border-[var(--border-color)] bg-[color-mix(in_srgb,var(--bg-secondary)_60%,transparent)] px-1.5 pt-1">
      {tabs.map((id) => {
        const isActive = id === active
        return (
          <div
            key={id}
            data-wb="tab"
            data-wb-tab={id}
            data-wb-active={isActive ? '1' : '0'}
            onClick={() => onSelect(id)}
            title={labelOf(id)}
            className={`flex max-w-[200px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 py-1.5 text-[12.5px] transition-colors ${
              isActive
                ? 'border-[var(--border-color)] bg-[var(--bg-primary)] text-[var(--text-primary)]'
                : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            <span className={`shrink-0 ${isActive ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}>
              {TAB_ICONS[id] ?? FALLBACK_ICON}
            </span>
            <span className="max-w-[140px] truncate">{labelOf(id)}</span>
          </div>
        )
      })}
    </div>
  )
}
