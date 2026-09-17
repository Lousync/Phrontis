import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Eye, Wrench } from 'lucide-react'
import { getPluginTools, type PluginTool } from '../../lib/pluginService'
import { useSettings } from '../../lib/SettingsContext'
import { SettingSwitch } from '../../components/shared/SettingSwitch'
import { PluginIconImg } from '../../components/shared/PluginIconImg'
// 工具清单与「id → 组件」映射的唯一真相源（v3.4.0 方案 §10.3 抽共享）：
// 右栏工具入口区（ToolLauncherZone）与本模块共同消费，加工具只改 toolRegistry 一处
import { BUILTIN_TOOLS, ToolHost, PluginToolHost, DEEPLINKABLE_TOOL_IDS, type ToolMeta } from '../../components/workbench/toolRegistry'

// ---- Tool registry（派生自共享注册表；icon 按 20px 画廊规格实例化） ----
interface ToolDefinition {
  id: string
  name: string
  icon: React.ReactNode
  available: boolean
}

const toDefinition = (t: ToolMeta): ToolDefinition => ({ id: t.id, name: t.name, icon: <t.Icon size={20} strokeWidth={1.5} />, available: true })

const DATA_TOOLS: ToolDefinition[] = BUILTIN_TOOLS.filter((t) => t.group === 'data').map(toDefinition)

const PRODUCTIVITY_TOOLS: ToolDefinition[] = BUILTIN_TOOLS.filter((t) => t.group === 'prod').map(toDefinition)

// 深链入口（2026-09-08）：小窗「在工具箱中管理」等外部入口 → toolbox:open-tool。
// 工具箱首访才挂载（App 保活机制），事件发出时组件可能还不存在——
// 模块级监听暂存 pending，挂载 effect 消费；已挂载则由组件内同一事件直接响应。
let pendingOpenTool: string | null = null
if (typeof window !== 'undefined') {
  window.addEventListener('toolbox:open-tool', (e) => {
    const tool = (e as CustomEvent<{ tool?: string }>).detail?.tool
    if (tool && DEEPLINKABLE_TOOL_IDS.has(tool)) pendingOpenTool = tool
  })
}

interface ToolboxModuleProps {
  /**
   * 「回主页」信号（App 层单调递增）。已在工具箱模块时点击活动栏工具箱图标 → App +1，
   * 本模块据此退出当前工具回到画廊（仅工具箱有此效果，其余模块点自身图标仍是折叠侧栏）。
   * 0 = 从未触发（首挂载不误清状态）。
   */
  homeSignal?: number
}

export function ToolboxModule({ homeSignal = 0 }: ToolboxModuleProps) {
  const [activeTool, setActiveTool] = useState<string | null>(null)
  const [pluginTools, setPluginTools] = useState<PluginTool[]>([])
  const [activePluginTool, setActivePluginTool] = useState<PluginTool | null>(null)

  const refreshPluginTools = useCallback(async () => {
    try { setPluginTools(await getPluginTools()) } catch { /* 忽略 */ }
  }, [])

  useEffect(() => { refreshPluginTools() }, [refreshPluginTools])

  // 插件模块安装/启禁/卸载后同步刷新;切换标签页时也兜底刷新一次
  useEffect(() => {
    const refresh = () => refreshPluginTools()
    window.addEventListener('plugins-changed', refresh)
    window.addEventListener('tab-switched', refresh)
    return () => {
      window.removeEventListener('plugins-changed', refresh)
      window.removeEventListener('tab-switched', refresh)
    }
  }, [refreshPluginTools])

  // ---- UI 打磨点3：工具显隐管理（toolboxHiddenTools 持久化；隐藏 ≠ 卸载，仅画廊卡片过滤） ----
  const { s, update } = useSettings()
  const hiddenIds = useMemo(() => {
    try {
      const a = JSON.parse(String(s.toolboxHiddenTools ?? '[]'))
      return new Set<string>(Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [])
    } catch { return new Set<string>() }
  }, [s.toolboxHiddenTools])
  const [manageOpen, setManageOpen] = useState(false)
  const manageRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!manageOpen) return
    const onDown = (e: PointerEvent) => { if (!manageRef.current?.contains(e.target as Node)) setManageOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setManageOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [manageOpen])
  const setToolShown = (id: string, show: boolean) => {
    const cur = new Set(hiddenIds)
    if (show) cur.delete(id); else cur.add(id)
    update('toolboxHiddenTools', JSON.stringify([...cur]))
  }
  const manageGroups: { title: string; items: { id: string; name: string }[] }[] = [
    { title: '数据工具', items: DATA_TOOLS.map((t) => ({ id: t.id, name: t.name })) },
    { title: '效率工具', items: PRODUCTIVITY_TOOLS.map((t) => ({ id: t.id, name: t.name })) },
    ...(pluginTools.length > 0 ? [{ title: '插件工具', items: pluginTools.map((t) => ({ id: `${t.pluginId}:${t.toolId}`, name: t.name })) }] : []),
  ]

  const handleActivateTool = (toolId: string) => {
    if (toolId === 'pomodoro') {
      window.dispatchEvent(new CustomEvent('pomodoro:activate', { detail: { preset: 0 } }))
      return
    }
    setActiveTool(toolId)
  }

  // 回主页信号（2026-09-10）：值变化即退出当前工具/插件工具回到画廊。
  // 退出前若有工具在运行（如番茄钟面板由全局状态管理）不受影响，仅收起全屏工具视图
  useEffect(() => {
    if (!homeSignal) return
    setActiveTool(null)
    setActivePluginTool(null)
  }, [homeSignal])

  // 深链消费：挂载时吃掉 pending（首访场景），已挂载则实时响应 toolbox:open-tool
  useEffect(() => {
    const consume = () => {
      const t = pendingOpenTool
      if (!t) return
      pendingOpenTool = null
      handleActivateTool(t)
    }
    consume()
    window.addEventListener('toolbox:open-tool', consume)
    return () => window.removeEventListener('toolbox:open-tool', consume)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const renderTool = () => {
    // case 映射已抽到共享 ToolHost（方案 §10.3）；onBack = 回画廊
    if (activeTool) return <ToolHost toolId={activeTool} onBack={() => setActiveTool(null)} />
    return null
  }

  // 内置工具全屏
  if (activeTool) {
    return (
      <div className="kb-view-in flex flex-col h-full bg-[var(--bg-primary)]">
        {renderTool()}
      </div>
    )
  }

  // UI 插件工具全屏宿主（PluginToolHost 已迁共享 toolRegistry，与右栏入口区共用）
  if (activePluginTool) {
    return (
      <div className="kb-view-in flex min-h-0 flex-1 flex-col">
        <PluginToolHost
          tool={activePluginTool}
          onBack={() => { setActivePluginTool(null); refreshPluginTools() }}
        />
      </div>
    )
  }

  const renderCardGrid = (tools: ToolDefinition[]) => (
    <div className="grid grid-cols-3 gap-3 w-full max-w-[660px]">
      {tools.map(tool => (
        <button
          key={tool.id}
          disabled={!tool.available}
          onClick={() => tool.available && handleActivateTool(tool.id)}
          className={`
            flex flex-col items-center gap-2 p-4 rounded-lg border transition-all text-center
            ${tool.available
              ? 'border-[var(--border-color)] bg-[var(--bg-secondary)] hover:border-[var(--accent)] hover:bg-[var(--bg-tertiary)] cursor-pointer group'
              : 'border-[var(--border-color)] bg-[var(--bg-tertiary)] opacity-40 cursor-not-allowed'
            }
          `}
        >
          <div className={`${tool.available ? 'text-[var(--accent)] group-hover:text-[var(--accent-hover)]' : 'text-[var(--text-disabled)]'}`}>
            {tool.icon}
          </div>
          <div className={`text-[13px] font-medium leading-tight ${tool.available ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>
            {tool.name}
            {!tool.available && <span className="ml-1 text-[10px] text-[var(--text-disabled)]">即将推出</span>}
          </div>
        </button>
      ))}
    </div>
  )

  const renderSection = (title: string, tools: ToolDefinition[]) => (
    <div className="space-y-2.5">
      <h3 className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider px-1">{title}</h3>
      <div className="flex justify-center">
        {renderCardGrid(tools)}
      </div>
    </div>
  )

  // Gallery view
  const dataVis = DATA_TOOLS.filter((t) => !hiddenIds.has(t.id))
  const prodVis = PRODUCTIVITY_TOOLS.filter((t) => !hiddenIds.has(t.id))
  const pluginVis = pluginTools.filter((t) => !hiddenIds.has(`${t.pluginId}:${t.toolId}`))
  const sep = (
    <div className="flex items-center gap-3 max-w-[600px] mx-auto">
      <div className="flex-1 h-px bg-[var(--border-color)]" />
    </div>
  )
  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)]">
      {/* Header */}
      <div className="flex items-center gap-1 border-b border-[var(--border-color)] px-2 py-1 text-[11.5px] text-[var(--text-muted)] shrink-0 select-none">
        <Wrench size={12} />
        工具箱
        {/* UI 打磨点3：工具显隐管理入口（popover 三组开关，即时写 toolboxHiddenTools） */}
        <div className="relative ml-auto" ref={manageRef}>
          <button
            onClick={() => setManageOpen((o) => !o)}
            title="管理显示的工具"
            aria-expanded={manageOpen}
            className={`p-1 rounded-md transition-colors ${manageOpen ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
          >
            <Eye size={13} />
          </button>
          {manageOpen && (
            <div className="absolute right-2 top-full mt-1 w-[240px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl py-1.5 z-50 text-[var(--text-primary)]">
              {manageGroups.map((g) => (
                <div key={g.title} className="mb-1 last:mb-0">
                  <div className="px-3 pt-1 pb-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{g.title}</div>
                  {g.items.map((it) => (
                    <div key={it.id} className="flex items-center gap-2 px-3 py-1">
                      <span className="min-w-0 flex-1 truncate text-[12px]">{it.name}</span>
                      <SettingSwitch size="sm" checked={!hiddenIds.has(it.id)} onChange={(v) => setToolShown(it.id, v)} aria-label={`显示${it.name}`} />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Tool sections（隐藏项连同分区标题一起不渲染；全隐藏 → 空态） */}
      <div className="kb-view-in flex-1 overflow-y-auto p-6 space-y-6">
        {dataVis.length === 0 && prodVis.length === 0 && pluginVis.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12px] text-[var(--text-muted)]">所有工具均已隐藏，点击右上角 👁 管理显示</div>
        ) : (
          <>
            {dataVis.length > 0 && renderSection('数据工具', dataVis)}
            {dataVis.length > 0 && prodVis.length > 0 && sep}
            {prodVis.length > 0 && renderSection('效率工具', prodVis)}
            {(dataVis.length > 0 || prodVis.length > 0) && pluginVis.length > 0 && sep}
            {pluginVis.length > 0 && (
              <div className="space-y-2.5">
                <h3 className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider px-1">插件工具</h3>
                <div className="flex justify-center">
                  <div className="grid grid-cols-3 gap-3 w-full max-w-[660px]">
                    {pluginVis.map(t => (
                      <button
                        key={`${t.pluginId}:${t.toolId}`}
                        onClick={() => setActivePluginTool(t)}
                        className="flex flex-col items-center gap-2 p-4 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] hover:border-[var(--accent)] hover:bg-[var(--bg-tertiary)] transition-all text-center group cursor-pointer"
                      >
                        <div className="text-[var(--accent)] group-hover:text-[var(--accent-hover)] relative">
                          <PluginIconImg src={t.icon} size={20} className="group-hover:opacity-90" />
                          <span
                            className="absolute -top-0.5 -right-1 w-2 h-2 rounded-full border border-[var(--bg-secondary)]"
                            style={{ background: t.riskLevel === 'B' ? 'var(--danger)' : t.riskLevel === 'A' ? 'var(--warning)' : 'var(--success)' }}
                            title={`安全等级 ${t.riskLevel}`}
                          />
                        </div>
                        <div className="text-[13px] font-medium leading-tight text-[var(--text-primary)]">{t.name}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

