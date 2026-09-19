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
  /** 左栏工具侧栏态（TOOLS_WITH_SIDEBAR 工具标签激活时的 toolId；透传左栏，见 WorkbenchLeftPanel） */
  railTool?: string | null
  /** 模块态 slot 的 ref callback（App 收集 DOM 传给模块做 sidebarEl portal 目标） */
  modSlotRef: (node: HTMLDivElement | null) => void
  /** 模块态头部动作槽的 ref callback（模块自己的标题行按钮 portal 到头部最右，2026-09-19） */
  modActionsRef?: (node: HTMLDivElement | null) => void
  onBookmarkClick: (key: RailModule) => void
  /** 🔖 书签选显菜单：切换某书签显隐（App 持久化 + 隐藏当前激活书签时退出模块态） */
  onBookmarkVisibility: (key: string) => void
  onBackToOverview: () => void
  onOpenLooseFile: (relPath: string) => void
  onPluginBookmark: (tab: TabName) => void
  /** 整窗模块形态（方案 §2）：回收站/插件市场/动态/设置/aiTeaching/devtools 激活时中间栏独占——
   *  左右栏**连折叠边条一并退场**（开合回调置空 → displayWidth=0，无残留手柄，见 sidesGone） */
  suppressSides?: boolean
  /** 最大化/禅模式 Z2：左右栏卡片随中间内容卡一起方角全屏化（第四轮拍板②） */
  maximized?: boolean
  /** 左栏搜索态（反馈轮：顶栏搜索框删除，全局搜索搬进左栏；瞬态）+ 结果动作回调打包透传 */
  leftSearch?: {
    mode: boolean
    onEnter: () => void
    onExit: () => void
    onOpenPage: (pageId: string) => void
    onLocateCategory: (categoryId: string) => void
    onRunCommand: (commandId: string) => void
  }
}

export function WorkbenchShell({ center, right, activeTab, railModule, railTool = null, modSlotRef, modActionsRef, onBookmarkClick, onBookmarkVisibility, onBackToOverview, onOpenLooseFile, onPluginBookmark, suppressSides = false, maximized = false, leftSearch }: Props) {
  const { s, update } = useSettings()
  const layout = useMemo(() => parseWorkbenchLayout(s.workbenchLayout), [s.workbenchLayout])

  const patch = (p: Partial<WorkbenchLayout>) => {
    update('workbenchLayout', JSON.stringify({ ...layout, ...p }))
  }

  /** 整窗模块（suppressSides）时左右栏**完全退场**：不仅内容不渲染（visible=false 原有语义），
   *  开合回调一并置空——ResizablePanel 对「不可见但给了 onSnapOpen」会保留 collapsedWidth 的
   *  折叠边条（悬停显蓝、可拖出展开），在整窗形态下残留成标签条旁边的「神秘手柄」（bug 修复轮）。
   *  面板仍常驻挂载（width 状态无损），回工作台时无重新挂载闪动。 */
  const sidesGone = suppressSides

  return (
    <div data-wb="shell" className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      {/* ---- 左栏 ---- */}
      <ResizablePanel
        storageKey="wb.leftWidth"
        side="left"
        defaultWidth={240}
        minWidth={180}
        maxWidth={420}
        visible={!sidesGone && !layout.leftCollapsed}
        collapsedWidth={sidesGone ? 0 : 6}
        onSnapClose={sidesGone ? undefined : () => patch({ leftCollapsed: true })}
        onSnapOpen={sidesGone ? undefined : () => patch({ leftCollapsed: false })}
        onHandleClick={sidesGone ? undefined : () => patch({ leftCollapsed: !layout.leftCollapsed })}
        className={sidesGone || maximized ? 'rounded-none border-0' : 'm-1.5 rounded-xl border border-[var(--border-color)] shadow-sm'}
      >
        <WorkbenchLeftPanel
          activeTab={activeTab}
          railModule={railModule}
          railTool={railTool}
          locked={layout.leftLocked}
          treeMode={layout.leftMode === 'tree'}
          modSlotRef={modSlotRef}
          modActionsRef={modActionsRef}
          onBookmarkClick={onBookmarkClick}
          onBookmarkVisibility={onBookmarkVisibility}
          bookmarksHidden={layout.bookmarksHidden}
          onBack={onBackToOverview}
          onToggleLock={() => patch({ leftLocked: !layout.leftLocked })}
          onToggleTreeMode={() => patch({ leftMode: layout.leftMode === 'tree' ? 'overview' : 'tree' })}
          onOpenLooseFile={onOpenLooseFile}
          onPluginBookmark={onPluginBookmark}
          searchMode={leftSearch?.mode}
          onEnterSearch={leftSearch?.onEnter}
          onExitSearch={leftSearch?.onExit}
          onSearchOpenPage={leftSearch?.onOpenPage}
          onSearchLocateCategory={leftSearch?.onLocateCategory}
          onSearchRunCommand={leftSearch?.onRunCommand}
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
        visible={!sidesGone && !layout.rightCollapsed}
        collapsedWidth={sidesGone ? 0 : 6}
        onSnapClose={sidesGone ? undefined : () => patch({ rightCollapsed: true })}
        onSnapOpen={sidesGone ? undefined : () => patch({ rightCollapsed: false })}
        onHandleClick={sidesGone ? undefined : () => patch({ rightCollapsed: !layout.rightCollapsed })}
        className={sidesGone || maximized ? 'rounded-none border-0' : 'm-1.5 rounded-xl border border-[var(--border-color)] shadow-sm'}
      >
        {right}
      </ResizablePanel>

      {/* 两栏收起后的开合 = 边缘 6px 手柄（悬停显形/单击开合，ResizablePanel 自带），不再放浮钮；
          整窗模块态（sidesGone）该手柄不渲染 —— 残留即 bug，见上方 sidesGone 注释 */}
    </div>
  )
}
