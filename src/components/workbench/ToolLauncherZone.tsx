import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Wrench, MoreHorizontal } from 'lucide-react'
import { BUILTIN_TOOLS } from './toolRegistry'
import { getPluginTools, type PluginTool } from '../../lib/pluginService'
import { PluginIconImg } from '../shared/PluginIconImg'
import { useSettings } from '../../lib/SettingsContext'

/**
 * 右栏上部 = 工具箱工具入口区（v3.4.0 方案 §10，2026-09-17 拍板）。
 *
 * 全部 9 个内置工具入口 + 插件注册工具，**双列书签条**形态（v16 定稿：第一版 3 列图标网格
 * 被否——「把最近编辑挤成啥样」，参考 Obsidian 书签插件样式改双列横条）：
 * 左列 = 数据工具，右列 = 效率工具 + 插件工具（分组语义由列位承担，不占标题高度）；
 * 每条 = 图标 + 名称 + 右端彩色竖条。点击入口 → 中间开对应工具标签页
 *（重复点击同入口 = 激活已有标签，由 App openTabs 机制保证）。
 *
 * 选显 = ⋯ 菜单分组 checkbox，**复用工具箱既有 `toolboxHiddenTools` 键**（方案 §10.4-③：
 * 画廊退役后该键唯一消费者即入口区，沿用既有持久化逻辑，不新增键）；隐藏 ≠ 卸载，
 * 隐藏的入口从网格消失，全隐藏时该区收起只剩标题行。
 *
 * 菜单照 WorkbenchLeftPanel 🔖 手法：body portal + fixed + pointerdown 外部关闭 + Esc，
 * 菜单项点击走 menu 容器**原生事件委托**（portal 首个菜单的 React 合成事件分发实测不稳定）。
 */

interface Props {
  /** 入口点击（App 层：pomodoro 特判派发全屏面板，其余开中间工具标签页） */
  onOpenTool: (toolId: string) => void
  /** 插件工具点击（App 层开插件工具标签页） */
  onOpenPluginTool: (tool: PluginTool) => void
}

export function ToolLauncherZone({ onOpenTool, onOpenPluginTool }: Props) {
  const { s, update } = useSettings()
  const [pluginTools, setPluginTools] = useState<PluginTool[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)
  const moreBtnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const refreshPluginTools = useCallback(async () => {
    try { setPluginTools(await getPluginTools()) } catch { /* 忽略 */ }
  }, [])
  useEffect(() => { void refreshPluginTools() }, [refreshPluginTools])
  // 插件安装/启禁/卸载后同步刷新；切换标签页时兜底刷新（toolbox 同款）
  useEffect(() => {
    const refresh = () => { void refreshPluginTools() }
    window.addEventListener('plugins-changed', refresh)
    window.addEventListener('tab-switched', refresh)
    return () => {
      window.removeEventListener('plugins-changed', refresh)
      window.removeEventListener('tab-switched', refresh)
    }
  }, [refreshPluginTools])

  // toolboxHiddenTools 钝解析（与工具箱原实现同口径：字符串数组）
  const hiddenIds = useMemo(() => {
    try {
      const a = JSON.parse(String(s.toolboxHiddenTools ?? '[]'))
      return new Set<string>(Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [])
    } catch { return new Set<string>() }
  }, [s.toolboxHiddenTools])

  const setToolShown = useCallback((id: string, show: boolean) => {
    try {
      const a = JSON.parse(String(s.toolboxHiddenTools ?? '[]'))
      const cur = new Set<string>(Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [])
      if (show) cur.delete(id); else cur.add(id)
      update('toolboxHiddenTools', JSON.stringify([...cur]))
    } catch { /* 坏 JSON 不写回 */ }
  }, [s.toolboxHiddenTools, update])

  // 菜单外部关闭 + Esc
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if ((moreBtnRef.current && moreBtnRef.current.contains(t)) || (menuRef.current && menuRef.current.contains(t))) return
      setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [menuOpen])

  // 菜单项（checkbox change）走 menu 容器原生事件委托，不依赖 React 合成事件（同 🔖 菜单手法）
  useEffect(() => {
    if (!menuOpen) return
    const menu = menuRef.current
    if (!menu) return
    const onChange = (e: Event) => {
      const input = (e.target as HTMLElement | null)?.closest?.('input[data-tl-tool-id]') as HTMLInputElement | null
      if (input?.dataset.tlToolId) setToolShown(input.dataset.tlToolId, input.checked)
    }
    menu.addEventListener('change', onChange)
    return () => menu.removeEventListener('change', onChange)
  }, [menuOpen, setToolShown])

  const toggleMenu = () => {
    if (!menuOpen) {
      const r = moreBtnRef.current?.getBoundingClientRect()
      if (r) setMenuPos({ left: Math.max(8, Math.min(r.right - 210, window.innerWidth - 218)), top: r.bottom + 6 })
    }
    setMenuOpen(v => !v)
  }

  // 可见工具分列：左 = 数据工具；右 = 效率工具 + 插件工具
  const leftTools = BUILTIN_TOOLS.filter((t) => t.group === 'data' && !hiddenIds.has(t.id))
  const rightTools = BUILTIN_TOOLS.filter((t) => t.group === 'prod' && !hiddenIds.has(t.id))
  const pluginVis = pluginTools.filter((t) => !hiddenIds.has(`${t.pluginId}:${t.toolId}`))
  const zoneEmpty = leftTools.length === 0 && rightTools.length === 0 && pluginVis.length === 0

  const rowCls = 'group flex min-w-0 items-center gap-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-[5px] text-left text-[11.5px] text-[var(--text-primary)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-hover)]'

  const renderPluginRow = (t: PluginTool) => {
    const id = `${t.pluginId}:${t.toolId}`
    if (hiddenIds.has(id)) return null
    return (
      <button key={id} className={rowCls} title={`打开「${t.name}」标签页`} onClick={() => onOpenPluginTool(t)}>
        <span className="shrink-0 text-[var(--accent)]"><PluginIconImg src={t.icon} size={13} /></span>
        <span className="min-w-0 flex-1 truncate">{t.name}</span>
        <span className="h-[13px] w-1 shrink-0 rounded-[2px]" style={{ backgroundColor: '#e8b23c' }} title="插件工具" />
      </button>
    )
  }

  return (
    <div data-wb="toolsZone" className="mx-2.5 mt-2.5 shrink-0 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-2">
      {/* 标题行 */}
      <div className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[11.5px] font-semibold text-[var(--text-secondary)]">
        <Wrench size={12} className="text-[var(--text-muted)]" />
        工具箱
        <div className="ml-auto">
          <button
            ref={moreBtnRef}
            onClick={toggleMenu}
            title="管理工具入口（显示 / 隐藏）"
            aria-expanded={menuOpen}
            className={`rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ${menuOpen ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : ''}`}
          >
            <MoreHorizontal size={13} />
          </button>
        </div>
      </div>

      {/* 双列书签条（全隐藏 → 只剩标题行） */}
      {!zoneEmpty && (
        <div className="grid grid-cols-2 items-start gap-x-1.5 gap-y-1">
          <div className="flex min-w-0 flex-col gap-1">
            {leftTools.map((t) => (
              <button key={t.id} className={rowCls} title={`打开「${t.name}」标签页`} onClick={() => onOpenTool(t.id)}>
                <span className="shrink-0 text-[var(--text-secondary)] group-hover:text-[var(--accent)]"><t.Icon size={13} strokeWidth={1.8} /></span>
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                <span className="h-[13px] w-1 shrink-0 rounded-[2px]" style={{ backgroundColor: t.color }} />
              </button>
            ))}
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            {rightTools.map((t) => (
              <button key={t.id} className={rowCls} title={`打开「${t.name}」标签页`} onClick={() => onOpenTool(t.id)}>
                <span className="shrink-0 text-[var(--text-secondary)] group-hover:text-[var(--accent)]"><t.Icon size={13} strokeWidth={1.8} /></span>
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                <span className="h-[13px] w-1 shrink-0 rounded-[2px]" style={{ backgroundColor: t.color }} />
              </button>
            ))}
            {pluginVis.map(renderPluginRow)}
          </div>
        </div>
      )}

      {/* ⋯ 选显菜单：分组 checkbox（复用 toolboxHiddenTools） */}
      {menuOpen && menuPos && createPortal(
        <div
          ref={menuRef}
          data-wb="toolsMenu"
          className="fixed z-50 w-[210px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-2xl"
          style={{ left: menuPos.left, top: menuPos.top }}
        >
          <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] tracking-wider text-[var(--text-muted)]">入口区显示哪些工具</div>
          {([['data', '数据工具'], ['prod', '效率工具']] as const).map(([g, title]) => (
            <div key={g} className="mb-0.5">
              <div className="px-2.5 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{title}</div>
              {BUILTIN_TOOLS.filter((t) => t.group === g).map((t) => (
                <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[5px] text-[12px] hover:bg-[var(--bg-hover)]" data-tl-row={t.id}>
                  <input
                    type="checkbox"
                    data-tl-tool-id={t.id}
                    defaultChecked={!hiddenIds.has(t.id)}
                    className="accent-[var(--accent)]"
                  />
                  <t.Icon size={12} className="shrink-0 text-[var(--text-muted)]" />
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                </label>
              ))}
            </div>
          ))}
          {pluginTools.length > 0 && (
            <div className="mb-0.5">
              <div className="px-2.5 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">插件工具</div>
              {pluginTools.map((t) => {
                const id = `${t.pluginId}:${t.toolId}`
                return (
                  <label key={id} className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[5px] text-[12px] hover:bg-[var(--bg-hover)]">
                    <input type="checkbox" data-tl-tool-id={id} defaultChecked={!hiddenIds.has(id)} className="accent-[var(--accent)]" />
                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  </label>
                )
              })}
            </div>
          )}
          <div className="mt-1 border-t border-[var(--border-color)] px-2.5 pb-1 pt-1.5 text-[10px] leading-relaxed text-[var(--text-muted)]">
            勾选 = 显示在上方入口区；隐藏 ≠ 卸载，随时可再开。
          </div>
        </div>,
        document.body,
        'wb-tools-menu',
      )}
    </div>
  )
}
