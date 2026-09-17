import { useMemo } from 'react'
import { ResizablePanel } from '../shared/ResizablePanel'
import { useSettings } from '../../lib/SettingsContext'
import { parseWorkbenchLayout, type WorkbenchLayout, type RailModule } from '../../lib/workbenchLayout'
import { WorkbenchLeftPanel } from './WorkbenchLeftPanel'
import type { TabName } from '../../types'

/**
 * 工作台三栏外壳（v3.4.0 批次2/3，方案 §2/§5）。
 *
 * 结构：图标条（ActivityBar，App 层渲染）+ [左栏 | 中间栏 | 右栏]。
 * - 左栏：WorkbenchLeftPanel（批次3 落地：书签 6 项 / 总览-模块双态 / 锁定 / 树模式 / 仓库切换）；
 * - 中间栏：标签条 + 内容区（App 层填）；
 * - 右栏：批次2 为占位收起，批次4 填小工具/AI。
 * - 左右栏复用 ResizablePanel：拖拽调宽 + snap 开合 + **单击手柄开合**（原型 v15 行为）；
 *   宽度各自持久化（wb.leftWidth / wb.rightWidth），开合状态走全局设置 workbenchLayout 键。
 */

interface Props {
  /** 中间栏内容（标签条 + 内容区，由 App 组装） */
  center: React.ReactNode
  /** 右栏内容（批次4 前为占位） */
  right: React.ReactNode
  /** 当前激活标签（左栏书签高亮 / 跟随展示） */
  activeTab: TabName | null
  /** 左栏模块态（null = 总览态） */
  railModule: RailModule | null
  /** 模块态 slot 的 ref callback（App 收集 DOM 传给模块做 sidebarEl portal 目标） */
  modSlotRef: (node: HTMLDivElement | null) => void
  onBookmarkClick: (key: RailModule) => void
  /** 🔖 书签选显菜单：切换某书签显隐（App 持久化 + 隐藏当前激活书签时退出模块态） */
  onBookmarkVisibility: (key: string) => void
  onBackToOverview: () => void
  onOpenLooseFile: (relPath: string) => void
  onPluginBookmark: (tab: TabName) => void
  /** AI教学整窗形态（方案 §2）：左右栏与唤起浮钮一并隐藏，中间栏独占 */
  suppressSides?: boolean
  /** 最大化/禅模式 Z2：左右栏卡片随中间内容卡一起方角全屏化（第四轮拍板②） */
  maximized?: boolean
}

export function WorkbenchShell({ center, right, activeTab, railModule, modSlotRef, onBookmarkClick, onBookmarkVisibility, onBackToOverview, onOpenLooseFile, onPluginBookmark, suppressSides = false, maximized = false }: Props) {
  const { s, update } = useSettings()
  const layout = useMemo(() => parseWorkbenchLayout(s.workbenchLayout), [s.workbenchLayout])

  const patch = (p: Partial<WorkbenchLayout>) => {
    update('workbenchLayout', JSON.stringify({ ...layout, ...p }))
  }

  return (
    <div data-wb="shell" className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      {/* ---- 左栏 ---- */}
      <ResizablePanel
        storageKey="wb.leftWidth"
        side="left"
        defaultWidth={240}
        minWidth={180}
        maxWidth={420}
        visible={!suppressSides && !layout.leftCollapsed}
        collapsedWidth={6}
        onSnapClose={() => patch({ leftCollapsed: true })}
        onSnapOpen={() => patch({ leftCollapsed: false })}
        onHandleClick={() => patch({ leftCollapsed: !layout.leftCollapsed })}
        className={maximized ? 'rounded-none border-0' : 'm-1.5 rounded-xl border border-[var(--border-color)] shadow-sm'}
      >
        <WorkbenchLeftPanel
          activeTab={activeTab}
          railModule={railModule}
          locked={layout.leftLocked}
          treeMode={layout.leftMode === 'tree'}
          modSlotRef={modSlotRef}
          onBookmarkClick={onBookmarkClick}
          onBookmarkVisibility={onBookmarkVisibility}
          bookmarksHidden={layout.bookmarksHidden}
          onBack={onBackToOverview}
          onToggleLock={() => patch({ leftLocked: !layout.leftLocked })}
          onToggleTreeMode={() => patch({ leftMode: layout.leftMode === 'tree' ? 'overview' : 'tree' })}
          onOpenLooseFile={onOpenLooseFile}
          onPluginBookmark={onPluginBookmark}
        />
      </ResizablePanel>

      {/* ---- 中间栏 ---- */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">{center}</div>

      {/* ---- 右栏 ---- */}
      <ResizablePanel
        storageKey="wb.rightWidth"
        side="right"
        defaultWidth={300}
        minWidth={240}
        maxWidth={420}
        visible={!suppressSides && !layout.rightCollapsed}
        collapsedWidth={6}
        onSnapClose={() => patch({ rightCollapsed: true })}
        onSnapOpen={() => patch({ rightCollapsed: false })}
        onHandleClick={() => patch({ rightCollapsed: !layout.rightCollapsed })}
      >
        {right}
      </ResizablePanel>

      {/* 两栏收起后的开合 = 边缘 6px 手柄（悬停显形/单击开合，ResizablePanel 自带），不再放浮钮 */}
    </div>
  )
}
