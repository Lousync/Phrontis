/**
 * 开发者工具模块壳(仅 DEV)。
 *
 * App.tsx 通过 `import.meta.env.DEV` + 动态 import 挂载本模块:
 * 正式构建时 DEV 被静态替换为 false,动态导入被 tree-shaking 移除,
 * 本模块代码不会进入产物。
 *
 * 工具注册表:新增开发者工具时在 TOOLS 末尾追加一项即可,壳负责导航与挂载。
 */
import { useState } from 'react'
import { BookOpen } from 'lucide-react'
import { ResizablePanel } from '../../components/shared/ResizablePanel'
import { PANEL_CONSTRAINTS } from '../../lib/settings'
import { HelpDocEditor } from './HelpDocEditor'

interface DevTool {
  id: string
  label: string
  icon: (size: number) => React.ReactNode
  component: React.ComponentType
}

const TOOLS: DevTool[] = [
  { id: 'help-docs', label: '帮助文档', icon: s => <BookOpen size={s} />, component: HelpDocEditor },
  // 后续工具在此追加,例如:
  // { id: 'plugin-scaffold', label: '插件脚手架', icon: s => <Package size={s} />, component: PluginScaffold },
]

const CONSTRAINTS = PANEL_CONSTRAINTS.sidebarWidth_devtools

export interface DevToolsModuleProps {
  sidebarOpen?: boolean
  sidebarWidths?: Record<string, number>
  onSnapCloseSidebar?: () => void
  onSnapOpenSidebar?: () => void
}

export function DevToolsModule({ sidebarOpen = true, sidebarWidths = {} as Record<string, number>, onSnapCloseSidebar, onSnapOpenSidebar }: DevToolsModuleProps) {
  const [activeId, setActiveId] = useState(TOOLS[0]?.id)
  const active = TOOLS.find(t => t.id === activeId) ?? TOOLS[0]
  const ActiveComponent = active?.component

  return (
    <div className="flex h-full flex-col bg-[var(--bg-primary)]">
      {/* 顶部贯通行（图二骨架）已删除（2026-09-18）：左栏工具列表已标明当前工具，
          本模块 dev-only 不进正式产物。 */}
      <div className="flex min-h-0 flex-1">
      <ResizablePanel
        storageKey="sidebarWidth_devtools"
        defaultWidth={CONSTRAINTS.default}
        minWidth={CONSTRAINTS.min}
        maxWidth={CONSTRAINTS.max}
        visible={sidebarOpen}
        initialWidth={sidebarWidths.sidebarWidth_devtools}
        onSnapClose={onSnapCloseSidebar}
        onSnapOpen={onSnapOpenSidebar}
      >
        <div className="w-full h-full bg-[var(--bg-secondary)] py-2 flex flex-col overflow-y-auto">
          {TOOLS.map(t => {
            const isActive = t.id === active?.id
            return (
              <button
                key={t.id}
                onClick={() => setActiveId(t.id)}
                className={`w-full flex items-center gap-2 px-4 py-1.5 text-[13px] transition-colors ${
                  isActive
                    ? 'bg-[var(--bg-selected)] text-[var(--text-primary)] border-l-2 border-l-[var(--accent)] pl-[14px]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] border-l-2 border-l-transparent pl-[14px]'
                }`}
              >
                <span className={isActive ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}>{t.icon(14)}</span>
                {t.label}
              </button>
            )
          })}
        </div>
      </ResizablePanel>

      {/* 右侧:当前工具（切换工具重放进场，见 docs/ui-animation-plan.md A 类） */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {ActiveComponent && (
          <div key={activeId} className="kb-view-in flex min-h-0 flex-1 flex-col">
            <ActiveComponent />
          </div>
        )}
      </div>
      </div>
    </div>
  )
}
