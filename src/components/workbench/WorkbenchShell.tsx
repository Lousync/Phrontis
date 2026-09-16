import { useMemo } from 'react'
import { PanelLeftClose, PanelRightClose, Info } from 'lucide-react'
import { ResizablePanel } from '../shared/ResizablePanel'
import { useSettings } from '../../lib/SettingsContext'
import { parseWorkbenchLayout, type WorkbenchLayout } from '../../lib/workbenchLayout'
import { STARTABLE_MODULE_IDS, labelOf } from '../../lib/appModules'
import type { TabName } from '../../types'

/**
 * 工作台三栏外壳（v3.4.0 批次2，方案 §2/§5）。
 *
 * 结构：图标条（ActivityBar，App 层渲染）+ [左栏 | 中间栏 | 右栏]。
 * - 左栏：批次2 为**临时模块入口列表**（保住切换能力），批次3 换成书签双态；
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
  /** 模块切换（临时左栏列表用；批次3 书签接管后由书签动作替代） */
  onSwitchTab: (tab: TabName) => void
  /** AI教学整窗形态（方案 §2）：左右栏与唤起浮钮一并隐藏，中间栏独占 */
  suppressSides?: boolean
}

export function WorkbenchShell({ center, right, onSwitchTab, suppressSides = false }: Props) {
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
      >
        <div className="flex h-full flex-col bg-[var(--bg-secondary)]">
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--border-color)] px-3">
            <span className="text-[12px] font-medium text-[var(--text-secondary)]">模块</span>
            <span className="flex items-center gap-1 text-[10.5px] text-[var(--text-muted)]">
              <Info size={11} />
              书签区 · 批次3
            </span>
          </div>
          {/* 临时模块入口（批次2 保切换能力；批次3 换 6 书签双态） */}
          <div data-wb="leftTemp" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
            {STARTABLE_MODULE_IDS.map((id) => (
              <button
                key={id}
                onClick={() => onSwitchTab(id)}
                className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                {labelOf(id)}
              </button>
            ))}
          </div>
        </div>
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

      {/* 两栏收起时的边缘唤起浮钮（收起态下 ResizablePanel 只剩 6px 边条，点击手柄也能开，这里给显式按钮） */}
      {!suppressSides && layout.leftCollapsed && (
        <button
          onClick={() => patch({ leftCollapsed: false })}
          title="展开左栏 (Ctrl+B)"
          className="kb-pop absolute left-1.5 top-1/2 z-20 -translate-y-1/2 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] p-1 text-[var(--text-muted)] shadow-sm transition-colors hover:text-[var(--text-primary)]"
        >
          <PanelLeftClose size={14} className="rotate-180" />
        </button>
      )}
      {!suppressSides && layout.rightCollapsed && (
        <button
          onClick={() => patch({ rightCollapsed: false })}
          title="展开右栏 (Ctrl+Alt+B)"
          className="kb-pop absolute right-1.5 top-1/2 z-20 -translate-y-1/2 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] p-1 text-[var(--text-muted)] shadow-sm transition-colors hover:text-[var(--text-primary)]"
        >
          <PanelRightClose size={14} className="rotate-180" />
        </button>
      )}
    </div>
  )
}
