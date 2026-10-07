import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { PluginIcon } from './ModuleIcons'
import { pluginListViews } from '../../lib/ipc'
import { peekPendingViewActivation, clearPendingViewActivation } from '../../lib/pluginCommandBus'
import type { PluginViewContribution } from '../../types'
import { PluginFrame } from './PluginFrame'

/**
 * 插件插槽入口（plugin-phase1-design C2）——宿主侧消费面的统一组件。
 *
 * 拉取某插槽（如 editor.sidebar / blog.sidebar / schedule.sidebar）的已启用贡献视图：
 * - 无贡献 → 零渲染（宿主界面零侵入，权限面不变——iframe 内能力仍由 capabilities 决定）；
 * - 有贡献 → 「插件」小节按钮列表，点击弹全屏覆盖层（沙箱 iframe + 数据桥，与知识库侧栏同构）。
 *
 * 需挂在 position 非 static 的容器内（覆盖层为 absolute inset-0）；放在侧栏 flex 列末尾即可。
 */
export function PluginSlotEntry({ slot, title = '插件' }: { slot: string; title?: string }) {
  const [views, setViews] = useState<PluginViewContribution[]>([])
  const [active, setActive] = useState<PluginViewContribution | null>(null)

  useEffect(() => {
    let alive = true
    pluginListViews(slot).then(v => { if (alive) setViews(v) }).catch(() => { /* 插件线不可用则视为无贡献 */ })
    return () => { alive = false }
  }, [slot])

  // 命令面板跨模块激活（plugin-phase1-design C3）：监听广播 + 消费暂存（模块首挂晚于广播时兜底）
  const viewsRef = useRef(views)
  viewsRef.current = views
  useEffect(() => {
    const tryActivate = (pluginId: string, slotName: string) => {
      if (slotName !== slot) return
      const v = viewsRef.current.find(x => x.pluginId === pluginId)
      if (v) {
        setActive(v)
        clearPendingViewActivation()
      }
    }
    const onActivate = (e: Event) => {
      const d = (e as CustomEvent<{ pluginId: string; slot: string }>).detail
      if (d) tryActivate(d.pluginId, d.slot)
    }
    window.addEventListener('plugin:activate-view', onActivate)
    const pending = peekPendingViewActivation()
    if (pending) tryActivate(pending.pluginId, pending.slot)
    return () => window.removeEventListener('plugin:activate-view', onActivate)
  }, [slot, views.length])

  if (views.length === 0) return null

  return (
    <>
      <div className="border-t border-[var(--border-color)] pt-1 mt-1 shrink-0">
        <div className="px-2 pb-0.5 text-[10px] uppercase tracking-wide text-[var(--text-disabled)] select-none">{title}</div>
        {views.map(v => (
          <button
            key={`${v.pluginId}:${v.slot}`}
            onClick={() => setActive(v)}
            title={`${v.name}（插件）`}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <PluginIcon size={14} />
            <span className="truncate">{v.title}</span>
            <span className="ml-auto text-[10px] text-[var(--text-disabled)] shrink-0">插件</span>
          </button>
        ))}
      </div>

      {active && (
        <div className="absolute inset-0 z-50 bg-[var(--bg-primary)] flex flex-col" role="dialog" aria-label={`${active.title}（插件）`}>
          <div className="shrink-0 flex items-center gap-2 px-2 py-1 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] select-none">
            <PluginIcon size={12} className="text-[var(--text-muted)]" />
            <span className="text-[11.5px] font-medium text-[var(--text-muted)]">{active.title}</span>
            <span className="text-[10px] text-[var(--text-disabled)]">{active.name} · 插件</span>
            <div className="flex-1" />
            <button
              onClick={() => setActive(null)}
              title="关闭"
              className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
            >
              <X size={14} />
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <PluginFrame
              pluginId={active.pluginId}
              entry={active.entry}
              grantedCapabilities={active.granted}
            />
          </div>
        </div>
      )}
    </>
  )
}
