import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Puzzle, Bot, MoreHorizontal, History, FileText,
  CalendarDays, ListChecks, Timer, KeyRound, Globe, MonitorX,
} from 'lucide-react'
import type { KnowledgePage } from '../../types'
import { getKnowledgePages } from '../../lib/ipc'
import { useDataChanged } from '../../lib/dataChanged'
import { useSettings } from '../../lib/SettingsContext'
import {
  parseWorkbenchLayout, DAY_PANEL_WIDGET_IDS, WORKBENCH_WIDGET_IDS, WORKBENCH_PANEL_TAB_IDS,
  type WorkbenchLayout,
} from '../../lib/workbenchLayout'
import { ToolLauncherZone } from './ToolLauncherZone'
import { TaskWidget } from './widgets/TaskWidget'
import { HabitWidget } from './widgets/HabitWidget'
import { PomoWidget } from './widgets/PomoWidget'
import { PasswordWidget } from './widgets/PasswordWidget'
import { NavWidget } from './widgets/NavWidget'
import type { PluginTool } from '../../lib/pluginService'

/**
 * 工作台右栏（v3.4.0 批次4，方案 §2/§8 批次4/§10；原型 v16 定稿）。
 *
 * **双 Tab（🧩 小工具 / 🤖 AI）**：Tab 显隐由 ⋯ 面板 Tab 管理菜单控制（DP 条目6「无 ✕ 关闭」，
 * workbenchLayout.panelTabsHidden 持久化；隐藏激活 Tab 自动切到另一个）。插件可注册面板 Tab
 * 为后续扩展位。
 *
 * **小工具态 = 上中下三段**：
 * - 上：🧰 工具箱工具入口区（ToolLauncherZone，方案 §10）；
 * - 中：🕘 最近编辑常驻、独立滚动（近 7 天的知识页，点击直开）；
 * - 下：控件切换条（可拖拽排序 + ⋯ 逐个选显）+ 简略视图（5 控件：今日任务 / 今日打卡 /
 *   番茄钟 / 强密码生成器 / 网址导航，前三者与今日任务为 DayPanel 抽出的共用控件）。
 *
 * **脱离互斥（方案 §3.7）**：DayPanel 四控件整体脱离为独立窗口（dayPanelDetached）时，
 * 对应槽位显示「已在桌面」置灰条目，点击 = 收回悬浮回嵌右栏。
 *
 * **AI 态**：本批次只落双 Tab 骨架与占位；aiChat 标签 + ⤢ + token 面板 = 批次5（方案 §4/§8）。
 */

const REL_MS = 7 * 24 * 60 * 60 * 1000

function relTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  if (diff < 0 || diff > REL_MS) return ''
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d === 1) return '昨天'
  return `${d} 天前`
}

interface Props {
  /** 最大化/禅模式 Z2：右栏卡片方角全屏化（第四轮拍板②，与左右内容卡同条件） */
  maximized?: boolean
  /** DayPanel 整体脱离为独立窗口中（DayPanel 系控件互斥显示「已在桌面」） */
  dayPanelDetached?: boolean
  /** 收回脱离窗口回嵌右栏（互斥条目点击 / 快捷键同语义） */
  onDockDayPanel?: () => void
  /** 工具入口点击（App：pomodoro 特判派发全屏面板，其余开中间工具标签页） */
  onOpenTool: (toolId: string) => void
  /** 插件工具入口点击（App 开插件工具标签页） */
  onOpenPluginTool: (tool: PluginTool) => void
  /** 最近编辑点击（vault 读源页面 → 编辑器打开） */
  onOpenFile: (relPath: string) => void
  /** 最近编辑点击（非 vault 读源页面 → 知识库定位打开） */
  onOpenPage: (pageId: string) => void
  /** 今日任务控件「打开日程模块」 */
  onOpenSchedule: () => void
}

/** 5 控件的切换条图标与简略视图标题（id 沿用 WORKBENCH_WIDGET_IDS） */
const WIDGET_META: Record<string, { icon: typeof Timer; label: string; sub: string }> = {
  task: { icon: CalendarDays, label: '今日任务', sub: '逾期置顶' },
  habit: { icon: ListChecks, label: '今日打卡', sub: '计划内习惯' },
  pomo: { icon: Timer, label: '番茄钟', sub: '与工具箱同源' },
  password: { icon: KeyRound, label: '强密码生成器', sub: '本地生成' },
  nav: { icon: Globe, label: '网址导航', sub: '选自收藏' },
}

export function WorkbenchRightPanel({ maximized = false, dayPanelDetached = false, onDockDayPanel, onOpenTool, onOpenPluginTool, onOpenFile, onOpenPage, onOpenSchedule }: Props) {
  const { s, update } = useSettings()
  const layout = useMemo(() => parseWorkbenchLayout(s.workbenchLayout), [s.workbenchLayout])
  const patch = useCallback((p: Partial<WorkbenchLayout>) => {
    update('workbenchLayout', JSON.stringify({ ...layout, ...p }))
  }, [layout, update])

  // 面板 Tab 显隐（⋯ 菜单）：隐藏激活 Tab 时自动切到另一个（原型 togglePanelTab 语义）
  const visiblePanelTabs = useMemo(
    () => WORKBENCH_PANEL_TAB_IDS.filter((id) => !layout.panelTabsHidden.includes(id)),
    [layout.panelTabsHidden],
  )
  const effectiveTab = visiblePanelTabs.includes(layout.rightTab) ? layout.rightTab : visiblePanelTabs[0]
  const setPanelTab = (id: 'widgets' | 'ai') => patch({ rightTab: id })
  const togglePanelTabVisibility = (id: (typeof WORKBENCH_PANEL_TAB_IDS)[number], show: boolean) => {
    const next = show
      ? layout.panelTabsHidden.filter((k) => k !== id)
      : [...layout.panelTabsHidden, id]
    patch({
      panelTabsHidden: next,
      rightTab: show ? id : (id === layout.rightTab ? visiblePanelTabs.find((k) => k !== id) ?? 'widgets' : layout.rightTab),
    })
  }

  // 控件区：排序（widgetOrder 拖拽）+ 选显（widgetsHidden）+ 激活控件
  const visibleWidgets = useMemo(
    () => layout.widgetOrder.filter((id) => !layout.widgetsHidden.includes(id)),
    [layout.widgetOrder, layout.widgetsHidden],
  )
  const [activeWidget, setActiveWidget] = useState<string | null>(null)
  // 激活控件缺省 = 首个可见项；被隐藏后回落（钝规则）
  const effectiveWidget = activeWidget && visibleWidgets.includes(activeWidget) ? activeWidget : visibleWidgets[0] ?? null

  // ⋯ 控件选显菜单（照 🔖 手法：portal + 原生委托 + 外部关闭）
  const [wsMenuOpen, setWsMenuOpen] = useState(false)
  const [wsMenuPos, setWsMenuPos] = useState<{ left: number; top: number } | null>(null)
  const wsMoreRef = useRef<HTMLButtonElement | null>(null)
  const wsMenuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!wsMenuOpen) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if ((wsMoreRef.current && wsMoreRef.current.contains(t)) || (wsMenuRef.current && wsMenuRef.current.contains(t))) return
      setWsMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setWsMenuOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [wsMenuOpen])
  useEffect(() => {
    if (!wsMenuOpen) return
    const menu = wsMenuRef.current
    if (!menu) return
    const onChange = (e: Event) => {
      const input = (e.target as HTMLElement | null)?.closest?.('input[data-ws-widget-id]') as HTMLInputElement | null
      const id = input?.dataset.wsWidgetId
      if (!id || !input) return
      const hidden = input.checked
        ? layout.widgetsHidden.filter((k) => k !== id)
        : [...layout.widgetsHidden, id]
      patch({ widgetsHidden: hidden })
    }
    menu.addEventListener('change', onChange)
    return () => menu.removeEventListener('change', onChange)
  }, [wsMenuOpen, layout.widgetsHidden, patch])
  const toggleWsMenu = () => {
    if (!wsMenuOpen) {
      const r = wsMoreRef.current?.getBoundingClientRect()
      if (r) setWsMenuPos({ left: Math.max(8, Math.min(r.right - 210, window.innerWidth - 218)), top: Math.max(8, r.top - 248) })
    }
    setWsMenuOpen(v => !v)
  }

  // ⋯ 面板 Tab 管理菜单（同款手法）
  const [ptMenuOpen, setPtMenuOpen] = useState(false)
  const [ptMenuPos, setPtMenuPos] = useState<{ left: number; top: number } | null>(null)
  const ptMoreRef = useRef<HTMLButtonElement | null>(null)
  const ptMenuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!ptMenuOpen) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if ((ptMoreRef.current && ptMoreRef.current.contains(t)) || (ptMenuRef.current && ptMenuRef.current.contains(t))) return
      setPtMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPtMenuOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [ptMenuOpen])
  useEffect(() => {
    if (!ptMenuOpen) return
    const menu = ptMenuRef.current
    if (!menu) return
    const onChange = (e: Event) => {
      const input = (e.target as HTMLElement | null)?.closest?.('input[data-pt-tab-id]') as HTMLInputElement | null
      const id = input?.dataset.ptTabId
      if (!id || !input) return
      if (!(WORKBENCH_PANEL_TAB_IDS as readonly string[]).includes(id)) return
      togglePanelTabVisibility(id as (typeof WORKBENCH_PANEL_TAB_IDS)[number], input.checked)
    }
    menu.addEventListener('change', onChange)
    return () => menu.removeEventListener('change', onChange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptMenuOpen, layout.panelTabsHidden, layout.rightTab, visiblePanelTabs])
  const togglePtMenu = () => {
    if (!ptMenuOpen) {
      const r = ptMoreRef.current?.getBoundingClientRect()
      if (r) setPtMenuPos({ left: Math.max(8, Math.min(r.right - 210, window.innerWidth - 218)), top: r.bottom + 6 })
    }
    setPtMenuOpen(v => !v)
  }

  // 控件切换条拖拽重排（HTML5 drag，WorkbenchTabBar 同款手法；序持久化 widgetOrder）
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const dragIdRef = useRef<string | null>(null)
  const handleWidgetDrop = (targetId: string) => {
    const src = dragIdRef.current
    setDragOverId(null)
    if (!src || src === targetId) return
    const next = [...layout.widgetOrder]
    const from = next.indexOf(src)
    const to = next.indexOf(targetId)
    if (from === -1 || to === -1) return
    next.splice(from, 1)
    next.splice(to, 0, src)
    patch({ widgetOrder: next })
  }

  return (
    <div className="flex h-full flex-col p-1.5">
      <div
        data-wb="rightPanel"
        className={`flex min-h-0 flex-1 flex-col overflow-hidden border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-sm ${maximized ? 'rounded-none border-0' : 'rounded-xl'}`}
      >
        {/* ---- 双 Tab 头（🧩 小工具 / 🤖 AI）+ ⋯ 面板 Tab 管理 ---- */}
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--border-color)] px-2">
          {visiblePanelTabs.map((id) => (
            <button
              key={id}
              data-wb="rpTab"
              data-wb-rp-tab={id}
              data-wb-rp-active={effectiveTab === id ? '1' : '0'}
              onClick={() => setPanelTab(id)}
              title={id === 'widgets' ? '小工具' : 'AI'}
              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                effectiveTab === id
                  ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                  : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
              }`}
            >
              {id === 'widgets' ? <Puzzle size={14} /> : <Bot size={14} />}
            </button>
          ))}
          <div className="ml-auto">
            <button
              ref={ptMoreRef}
              onClick={togglePtMenu}
              title="管理面板 Tab"
              className={`rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ${ptMenuOpen ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : ''}`}
            >
              <MoreHorizontal size={13} />
            </button>
          </div>
        </div>

        {/* ---- 小工具态：上（工具入口区）/ 中（最近编辑）/ 下（控件条 + 简略视图） ---- */}
        {effectiveTab === 'widgets' ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <ToolLauncherZone onOpenTool={onOpenTool} onOpenPluginTool={onOpenPluginTool} />

            <RecentEdited onOpenFile={onOpenFile} onOpenPage={onOpenPage} />

            {/* 下段：控件切换条（可拖拽排序 + ⋯ 选显）+ 简略视图 */}
            <div className="mx-2.5 mb-2.5 shrink-0 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
              <div data-wb="widgetSwitch" className="flex items-center gap-1 px-2 pt-1.5">
                {visibleWidgets.map((id) => {
                  const meta = WIDGET_META[id]
                  if (!meta) return null
                  const Icon = meta.icon
                  const isActive = effectiveWidget === id
                  return (
                    <button
                      key={id}
                      data-wb="wsBtn"
                      data-ws-widget={id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move'
                        e.dataTransfer.setData('text/plain', id)
                        dragIdRef.current = id
                        setDragId(id)
                        requestAnimationFrame(() => { (e.currentTarget as HTMLElement | null)?.style?.setProperty('opacity', '0.4') })
                      }}
                      onDragEnd={(e) => {
                        (e.currentTarget as HTMLElement | null)?.style?.setProperty('opacity', '1')
                        dragIdRef.current = null
                        setDragId(null)
                        setDragOverId(null)
                      }}
                      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragId && dragId !== id) setDragOverId(id) }}
                      onDrop={(e) => { e.preventDefault(); handleWidgetDrop(id) }}
                      onClick={() => setActiveWidget(id)}
                      title={meta.label}
                      className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                        isActive ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                      } ${dragOverId === id ? 'ring-1 ring-[var(--accent)]' : ''} ${dragId === id ? 'opacity-40' : ''}`}
                    >
                      <Icon size={14} strokeWidth={1.8} />
                    </button>
                  )
                })}
                <div className="ml-auto">
                  <button
                    ref={wsMoreRef}
                    onClick={toggleWsMenu}
                    title="显示的小控件"
                    className={`rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ${wsMenuOpen ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : ''}`}
                  >
                    <MoreHorizontal size={13} />
                  </button>
                </div>
              </div>

              {/* 简略视图（固定高、独立滚动；DayPanel 系控件脱离中 → 「已在桌面」互斥条目） */}
              <div data-wb="widgetBrief" className="kb-view-fade m-2 mt-1.5 h-[196px] overflow-y-auto rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] p-2.5">
                {effectiveWidget == null ? (
                  <div className="flex h-full items-center justify-center text-[11.5px] text-[var(--text-muted)]">小控件均已隐藏，点击上方 ⋯ 恢复</div>
                ) : dayPanelDetached && (DAY_PANEL_WIDGET_IDS as readonly string[]).includes(effectiveWidget) ? (
                  <button
                    data-wb="detachedStub"
                    onClick={onDockDayPanel}
                    className="flex h-full w-full flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-[var(--border-color)] text-[var(--text-muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                    title="该小组件已脱离为独立桌面窗口，点击收回右栏"
                  >
                    <MonitorX size={16} />
                    <span className="text-[11.5px]">已在桌面</span>
                    <span className="text-[10.5px]">点击收回右栏</span>
                  </button>
                ) : (
                  <>
                    <div className="mb-1.5 flex items-baseline justify-between px-0.5">
                      <span className="text-[11.5px] font-semibold text-[var(--text-secondary)]">{WIDGET_META[effectiveWidget]?.label}</span>
                      <span className="text-[10px] text-[var(--text-muted)]">{WIDGET_META[effectiveWidget]?.sub}</span>
                    </div>
                    {effectiveWidget === 'task' && <TaskWidget onOpenSchedule={onOpenSchedule} />}
                    {effectiveWidget === 'habit' && <HabitWidget />}
                    {effectiveWidget === 'pomo' && <PomoWidget />}
                    {effectiveWidget === 'password' && <PasswordWidget />}
                    {effectiveWidget === 'nav' && <NavWidget />}
                  </>
                )}
              </div>
            </div>
          </div>
        ) : (
          /* ---- AI 态：批次5 接入 aiChat 标签 + ⤢ + token 面板（方案 §4）；本批次落骨架占位 ---- */
          <div data-wb="aiPlaceholder" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 pb-10 text-[var(--text-muted)]">
            <Bot size={22} strokeWidth={1.4} />
            <span className="text-[12px]">AI 助手</span>
            <span className="text-[11px]">对话面板接入中</span>
          </div>
        )}
      </div>

      {/* ⋯ 面板 Tab 管理菜单（portal + 原生委托） */}
      {ptMenuOpen && ptMenuPos && createPortal(
        <div
          ref={ptMenuRef}
          data-wb="panelTabMenu"
          className="fixed z-50 w-[210px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-2xl"
          style={{ left: ptMenuPos.left, top: ptMenuPos.top }}
        >
          <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] tracking-wider text-[var(--text-muted)]">显示的面板 Tab</div>
          {WORKBENCH_PANEL_TAB_IDS.map((id) => (
            <label key={id} className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[6px] text-[12px] hover:bg-[var(--bg-hover)]">
              <input type="checkbox" data-pt-tab-id={id} defaultChecked={!layout.panelTabsHidden.includes(id)} className="accent-[var(--accent)]" />
              {id === 'widgets' ? <Puzzle size={12} className="shrink-0 text-[var(--text-muted)]" /> : <Bot size={12} className="shrink-0 text-[var(--text-muted)]" />}
              <span className="min-w-0 flex-1 truncate">{id === 'widgets' ? '小工具' : 'AI 对话 / 面板'}</span>
            </label>
          ))}
        </div>,
        document.body,
        'wb-panel-tab-menu',
      )}

      {/* ⋯ 控件选显菜单 */}
      {wsMenuOpen && wsMenuPos && createPortal(
        <div
          ref={wsMenuRef}
          data-wb="widgetMenu"
          className="fixed z-50 w-[210px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-2xl"
          style={{ left: wsMenuPos.left, top: wsMenuPos.top }}
        >
          <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] tracking-wider text-[var(--text-muted)]">显示的小控件</div>
          {WORKBENCH_WIDGET_IDS.map((id) => {
            const meta = WIDGET_META[id]
            if (!meta) return null
            const Icon = meta.icon
            return (
              <label key={id} className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[6px] text-[12px] hover:bg-[var(--bg-hover)]">
                <input type="checkbox" data-ws-widget-id={id} defaultChecked={!layout.widgetsHidden.includes(id)} className="accent-[var(--accent)]" />
                <Icon size={12} className="shrink-0 text-[var(--text-muted)]" />
                <span className="min-w-0 flex-1 truncate">{meta.label}</span>
              </label>
            )
          })}
          <div className="mt-1 border-t border-[var(--border-color)] px-2.5 pb-1 pt-1.5 text-[10px] leading-relaxed text-[var(--text-muted)]">
            排序：直接拖拽上方图标。
          </div>
        </div>,
        document.body,
        'wb-widget-menu',
      )}
    </div>
  )
}

/** 中段：🕘 最近编辑（常驻、独立滚动；近 7 天知识页按更新时间倒序） */
function RecentEdited({ onOpenFile, onOpenPage }: { onOpenFile: (relPath: string) => void; onOpenPage: (pageId: string) => void }) {
  const [pages, setPages] = useState<KnowledgePage[]>([])

  const refresh = useCallback(async () => {
    try {
      const ps = await getKnowledgePages()
      setPages(ps ?? [])
    } catch { /* 索引未就绪时保持旧数据 */ }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useDataChanged('knowledge', refresh)

  const recent = useMemo(() => {
    const now = Date.now()
    return pages
      .filter((p) => {
        const t = new Date(p.updatedAt).getTime()
        return Number.isFinite(t) && now - t <= REL_MS && now - t >= 0
      })
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 12)
  }, [pages])

  return (
    <div data-wb="recentEdited" className="mx-2.5 mt-2 flex min-h-[72px] flex-1 flex-col overflow-hidden rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
      <div className="flex shrink-0 items-center gap-1.5 px-2.5 pb-1 pt-2 text-[11.5px] font-semibold text-[var(--text-secondary)]">
        <History size={12} className="text-[var(--text-muted)]" />
        最近编辑
        <span className="ml-auto text-[10px] font-normal text-[var(--text-muted)]">近 7 天</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {recent.length === 0 ? (
          <div className="px-1.5 py-3 text-[11px] text-[var(--text-muted)]">近 7 天没有编辑记录</div>
        ) : recent.map((p) => (
          <button
            key={p.id}
            onClick={() => (p.path ? onOpenFile(p.path) : onOpenPage(p.id))}
            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-[5px] text-left transition-colors hover:bg-[var(--bg-hover)]"
            title={p.path ?? p.title}
          >
            <FileText size={11} className="shrink-0 text-[var(--text-muted)]" />
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-primary)]">{p.title || p.path}</span>
            <span className="shrink-0 text-[9.5px] text-[var(--text-muted)]">{relTime(p.updatedAt)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
