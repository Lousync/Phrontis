import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  GripHorizontal, X, PanelRightClose, PanelRightOpen, Timer,
  CalendarDays, ListChecks, Globe,
} from 'lucide-react'
import type { ScheduleTodo } from '../types'
import { usePomodoro } from '../modules/toolbox/hooks/PomodoroContext'
import { localToday } from '../lib/date'
import {
  getScheduleTodos, getScheduleOverdue, updateScheduleTodo,
} from '../lib/ipc'
import { useDataChanged } from '../lib/dataChanged'
import { TaskWidget, addMinutesLocal, parseLocalTime } from '../components/workbench/widgets/TaskWidget'
import { HabitWidget } from '../components/workbench/widgets/HabitWidget'
import { PomoWidget, PomodoroPopoutPanel } from '../components/workbench/widgets/PomoWidget'
import { NavWidget } from '../components/workbench/widgets/NavWidget'
import { ReminderBar, type ReminderItem } from './panel/ReminderBar'

/** 「今日工作台」四 Tab：日程 / 打卡 / 番茄 / 导航（嵌入式在表头下方，脱离态在底部） */
const DAY_TABS = [
  { id: 'task', icon: CalendarDays, label: '日程' },
  { id: 'habit', icon: ListChecks, label: '打卡' },
  { id: 'pomo', icon: Timer, label: '番茄' },
  { id: 'nav', icon: Globe, label: '导航' },
] as const

/** 距次日 00:00:05 的毫秒数（用于跨零点刷新定时器） */
function msUntilTomorrow(): number {
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5)
  return Math.max(1000, next.getTime() - now.getTime())
}

const dragRegion = { WebkitAppRegion: 'drag' } as React.CSSProperties
const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

export interface DayPanelProps {
  /** embedded：主窗口内嵌面板（高度由父容器决定，h-full）；popout：独立 BrowserWindow（h-screen） */
  mode: 'embedded' | 'popout'
  /** 嵌入→脱离（内嵌模式顶部按钮触发）；主进程负责创建独立窗口 */
  onPopout?: () => void
  /** 脱离→嵌入（独立窗口顶部按钮触发 / Esc）；主进程负责销毁独立窗口 */
  onDockBack?: () => void
  /** 关闭（嵌入模式隐藏面板；脱离模式等同 dockBack） */
  onClose?: () => void
  /** popout 专属：番茄钟状态快照（主进程广播，popout 不持有计时器；embedded 态忽略此 prop） */
  pomodoroStatus?: {
    visible: boolean; display: string; running: boolean; phase: string; done: boolean; expanded: boolean; progress: number
  } | null
}

/**
 * 日程与打卡侧边栏组件（WeChat 模式：同一组件既渲染主窗口内嵌面板，也渲染独立脱离窗口）。
 * v3.4.0 批次4 起：内嵌态由右栏小工具接管的职责（任务/打卡/番茄/导航的渲染与数据加载）
 * 全部下沉到 widgets 控件；本组件保留**宿主职责**——表头、四 Tab 切换、逾期截止提醒条、
 * 全局番茄条与脱离窗口（自由漂浮）。
 */
export function DayPanel({ mode, onPopout, onDockBack, onClose, pomodoroStatus = null }: DayPanelProps) {
  const [todayStr, setTodayStr] = useState(() => localToday())

  // 数据：仅保留宿主级消费——逾期截止（提醒条/红点角标）
  const [todos, setTodos] = useState<ScheduleTodo[]>([])
  const [overdue, setOverdue] = useState<ScheduleTodo[]>([])
  // 嵌入式「今日工作台」当前 Tab（脱离态忽略）
  const [tab, setTab] = useState<'task' | 'habit' | 'pomo' | 'nav'>('task')

  // 番茄钟状态（从 PomodoroContext 取；嵌入式与脱离态都由 Provider 包裹）
  const pom = usePomodoro()
  const { state: ps } = pom

  // 跨零点自动翻页
  useEffect(() => {
    let timer: number | undefined
    const tick = () => {
      timer = window.setTimeout(() => { setTodayStr(localToday()); tick() }, msUntilTomorrow())
    }
    tick()
    return () => { if (timer) window.clearTimeout(timer) }
  }, [])

  const load = useCallback(async () => {
    try {
      const [todayList, od] = await Promise.all([
        getScheduleTodos(todayStr),
        getScheduleOverdue(todayStr),
      ])
      setTodos(todayList)
      setOverdue(od)
    } catch (e) {
      console.error('[DayPanel] 加载失败', e)
    }
  }, [todayStr])

  useEffect(() => { void load() }, [load])
  useDataChanged('schedule', load)

  // Esc：嵌入式关闭内嵌面板；脱离式吸附回内嵌
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const el = document.activeElement
      if (el instanceof HTMLInputElement) { el.blur(); return }
      if (mode === 'popout') onDockBack?.()
      else onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, onClose, onDockBack])

  /** 已逾期的 DDL（角标口径）：deadline 类、带 time、未完成、且未处于打盹期内 */
  const overdueDdls = useMemo<ReminderItem[]>(() => {
    const now = Date.now()
    return [...overdue, ...todos]
      .filter(t => t.taskType === 'deadline' && t.time && t.status === 'pending'
        && parseLocalTime(t.time) < now
        && (!t.snoozeUntil || parseLocalTime(t.snoozeUntil) < now))
      .sort((a, b) => parseLocalTime(a.time!) - parseLocalTime(b.time!))
      .map(t => ({ id: t.id, title: t.title, time: t.time! }))
  }, [overdue, todos])

  /** 提醒「稍后」：打盹 1 小时（写 snoozeUntil，打盹期内不再提醒该任务） */
  const snooze = useCallback(async (id: string) => {
    try {
      await updateScheduleTodo(id, { snoozeUntil: addMinutesLocal(60) })
    } catch (e) {
      console.error('[DayPanel] snooze 失败', e)
    }
  }, [])

  const openInMain = useCallback((tab: string) => {
    window.api?.dayPanelOpenInMain?.(tab)
  }, [])

  // 四工具 Tab 按钮组：嵌入式渲染在表头下方，脱离态渲染在底部（替代原模块导航栏）
  const renderTabButtons = () => DAY_TABS.map(t => (
    <button
      key={t.id}
      onClick={() => setTab(t.id)}
      className={`relative flex flex-1 flex-col items-center gap-px rounded-lg py-1 text-[10.5px] transition-colors ${
        tab === t.id ? 'bg-[var(--accent)]/10 font-semibold text-[var(--accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
      }`}
      title={t.label}
    >
      <t.icon size={14} strokeWidth={1.8} />
      {t.label}
      {t.id === 'task' && overdueDdls.length > 0 && (
        <span className="absolute right-[26%] top-1 h-1.5 w-1.5 rounded-full bg-[var(--danger)]" title={`${overdueDdls.length} 个逾期截止`} />
      )}
    </button>
  ))

  // 容器高度：嵌入式由外层卡片壳 flex 提供（flex-1）；独立窗口自己 h-screen。
  const containerCls = mode === 'embedded'
    ? 'relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)] select-none'
    : 'relative flex h-screen flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)] select-none'

  // 主窗口全屏弹窗遮罩 → 本 dock 窗跟随压暗（独立窗口时；内嵌态在主窗内已被遮罩盖住，无需自绘）
  const [mainDim, setMainDim] = useState(false)
  useEffect(() => {
    if (mode !== 'popout') return
    const off = window.api?.onMainModalDim?.(setMainDim)
    return () => { off?.() }
  }, [mode])

  return (
    <div className={containerCls}>
      {/* 主窗弹窗跟随压暗层：在圆角容器内（根 overflow-hidden 裁掉方角），
          pointer-events-none 保持遮挡期不可交互；opacity 过渡只动透明度（动效铁律） */}
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-0 z-[70] transition-opacity duration-200 ${mainDim ? 'bg-black/35 opacity-100' : 'bg-black/0 opacity-0'}`}
      />
      {/* 表头：嵌入式下用 WebkitAppRegion: drag 让用户能拖出脱离，独立窗口由 BrowserWindow 自身拖动 */}
      <div
        className="flex h-10 shrink-0 select-none items-center justify-between border-b border-[var(--border-color)] px-3"
        style={{ backgroundColor: 'color-mix(in srgb, var(--bg-tertiary) 78%, transparent)', ...(mode === 'popout' ? dragRegion : undefined) }}
      >
        <div className="flex items-center gap-1.5 text-[12px]">
          {mode === 'popout' && <GripHorizontal size={13} className="text-[var(--text-muted)]" />}
          {mode === 'embedded' ? '今日工作台' : '日程与打卡'}
        </div>
        <div className="flex items-center gap-0.5" style={mode === 'popout' ? noDrag : undefined}>
          {mode === 'embedded' && (
            <button
              onClick={onPopout}
              className="rounded p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              title="脱离为独立窗口（拖到主窗口外任意位置摆放）"
            >
              <PanelRightClose size={14} strokeWidth={1.5} />
            </button>
          )}
          {mode === 'popout' && (
            <button
              onClick={onDockBack}
              className="rounded p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              title="回到主窗口内嵌"
            >
              <PanelRightOpen size={14} strokeWidth={1.5} />
            </button>
          )}
          <button
            onClick={mode === 'popout' ? onDockBack : onClose}
            className="rounded p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            title={mode === 'popout' ? '回到主窗口内嵌' : '关闭面板（Ctrl+Alt+S 重新打开）'}
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* 嵌入式四 Tab 栏（表头下方） */}
      {mode === 'embedded' && (
        <div
          className="flex shrink-0 gap-1 border-b border-[var(--border-color)] px-2 py-1.5"
          style={{ backgroundColor: 'color-mix(in srgb, var(--bg-secondary) 60%, transparent)' }}
        >
          {renderTabButtons()}
        </div>
      )}

      <div className="kb-view-fade flex-1 space-y-4 overflow-y-auto px-2.5 py-3">
        {/* 四 Tab 内容 = 共享 widgets（右栏简略视图同一份实现，不复制渲染） */}
        {tab === 'task' && <TaskWidget onOpenSchedule={() => openInMain('schedule')} />}
        {tab === 'habit' && <HabitWidget onManage={() => openInMain('toolbox')} />}
        {tab === 'pomo' && (mode === 'embedded'
          ? <PomoWidget />
          : <PomodoroPopoutPanel status={pomodoroStatus} onOpenInMain={() => openInMain('toolbox')} />)}
        {tab === 'nav' && <NavWidget onManage={() => openInMain('toolbox')} />}
      </div>

      {/* 逾期截止提醒条：贴内容之下、Tab 栏之上，四个 Tab 下都可见，不与内容滚动冲突 */}
      <ReminderBar items={overdueDdls} onSnooze={snooze} />

      {/* 嵌入式全局番茄条：仅运行中显示（暂停/结束即消失），任意 Tab 可见，点击直达番茄 Tab */}
      {mode === 'embedded' && ps.visible && ps.running && (
        <button
          onClick={() => setTab('pomo')}
          className="relative mx-2 mb-2 flex shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-lg border border-[var(--border-color)] py-1.5 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          title="番茄钟运行中，点击查看"
        >
          <div
            className="absolute inset-y-0 left-0 bg-[var(--accent)]/15 transition-[width] duration-700 ease-linear"
            style={{ width: `${Math.max(0, Math.min(1, pom.progress)) * 100}%` }}
          />
          <Timer size={12} className="relative text-[var(--accent)]" />
          <span className="relative font-mono">{pom.display}</span>
          <span className="relative opacity-80">{ps.phase === 'work' ? '专注中' : '休息中'}</span>
        </button>
      )}

      {/* 脱离态全局番茄条：仅运行中显示，点击直达番茄 Tab（快照来自主进程广播） */}
      {mode === 'popout' && pomodoroStatus?.running && (
        <button
          onClick={() => setTab('pomo')}
          className="relative mx-2 mb-2 flex shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-lg border border-[var(--border-color)] py-1.5 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          title="番茄钟运行中，点击查看"
        >
          <div
            className="absolute inset-y-0 left-0 bg-[var(--accent)]/15 transition-[width] duration-700 ease-linear"
            style={{ width: `${Math.max(0, Math.min(1, pomodoroStatus.progress)) * 100}%` }}
          />
          <Timer size={12} className="relative text-[var(--accent)]" />
          <span className="relative font-mono">{pomodoroStatus.display}</span>
          <span className="relative opacity-80">{pomodoroStatus.phase === 'work' ? '专注中' : '休息中'}</span>
        </button>
      )}

      {/* 脱离态底部四工具 Tab（替代原模块导航栏，与侧边栏同款） */}
      {mode === 'popout' && (
        <div
          className="flex shrink-0 gap-1 border-t border-[var(--border-color)] px-2 py-1.5"
          style={{ backgroundColor: 'color-mix(in srgb, var(--bg-secondary) 60%, transparent)' }}
        >
          {renderTabButtons()}
        </div>
      )}
    </div>
  )
}
