import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  GripHorizontal, X, Check, Pencil, Trash2, CalendarClock,
  Plus, ChevronRight, ChevronDown, ExternalLink,
  PanelRightClose, PanelRightOpen,
  Timer, CalendarDays, ListChecks, Globe,
} from 'lucide-react'
import type { ScheduleTodo, Habit, HabitRecord } from '../types'
import { usePomodoro } from '../modules/toolbox/hooks/PomodoroContext'
import { localToday } from '../lib/date'
import {
  getScheduleTodos, getScheduleOverdue, getScheduleSubtasks,
  createScheduleTodo, updateScheduleTodo, deleteScheduleTodo,
  habitGetAll, toggleHabitCheck,
} from '../lib/ipc'
import { notifyDataChanged, useDataChanged } from '../lib/dataChanged'
import { showToast } from '../lib/toast'
import { parseQuickDate } from './parseQuickDate'
import { isPlannedOn, currentStreak, buildRecordIndex } from '../modules/toolbox/components/habit-tracker/dateUtils'
import { HabitPanel } from './panel/HabitPanel'
import { PomodoroPanel, PomodoroPopoutPanel } from './panel/PomodoroPanel'
import { NavPanel } from './panel/NavPanel'
import { ReminderBar, type ReminderItem } from './panel/ReminderBar'

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 'YYYY-MM-DD HH:mm' → 本地时间戳（各处理序与 ScheduleTodo.time 一致，空格视为本地时间） */
function parseLocalTime(s: string): number {
  return new Date(s.replace(' ', 'T')).getTime()
}
/** 距 now 的 +n 分钟，格式化为 'YYYY-MM-DD HH:mm'（与 ScheduleTodo.time / snoozeUntil 同口径） */
function addMinutesLocal(n: number): string {
  const d = new Date(Date.now() + n * 60 * 1000)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

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

export type PanelMode = 'floating' | 'top-dock' | 'desktop-widget'

export interface DayPanelProps {
  /** embedded：主窗口内嵌面板（高度由父容器决定，h-full）；popout：独立 BrowserWindow（h-screen） */
  mode: 'embedded' | 'popout'
  /** popout 专属：桌面互动模式（floating 自由漂浮 / top-dock 顶部停靠 / desktop-widget 桌面小组件） */
  panelMode?: PanelMode
  /** popout + top-dock 专属：收缩为触碰条 */
  collapsed?: boolean
  /** popout + desktop-widget 专属：鼠标穿透 ⇄ 可交互 */
  widgetInteractive?: boolean
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
 * 日程与打卡侧边栏组件（WeChat 模式：同一组件既渲染主窗口内嵌面板，也渲染独立脱离窗口）
 * 逾期置顶红分组 → 今日任务（子任务展开一级）→ 快速添加（轻量时间解析）→ 今日打卡
 * popout 态支持三种桌面互动模式（panelMode），交互协议见 dayPanelWindow.ts
 */
export function DayPanel({ mode, panelMode = 'floating', collapsed = false, widgetInteractive = false, onPopout, onDockBack, onClose, pomodoroStatus = null }: DayPanelProps) {
  const [todayStr, setTodayStr] = useState(() => localToday())
  const todayDate = useMemo(() => {
    const [y, m, d] = todayStr.split('-').map(Number)
    return new Date(y, m - 1, d)
  }, [todayStr])

  const [todos, setTodos] = useState<ScheduleTodo[]>([])
  const [overdue, setOverdue] = useState<ScheduleTodo[]>([])
  const [habits, setHabits] = useState<Habit[]>([])
  const [records, setRecords] = useState<HabitRecord[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const expandedRef = useRef<Set<string>>(new Set())
  const [subtasks, setSubtasks] = useState<Record<string, ScheduleTodo[]>>({})
  const [editing, setEditing] = useState<{ id: string; title: string; date: string; time: string } | null>(null)
  const [quick, setQuick] = useState('')
  const [manualTime, setManualTime] = useState<string | null>(null)
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
      const [todayList, od, habitData] = await Promise.all([
        getScheduleTodos(todayStr),
        getScheduleOverdue(todayStr),
        habitGetAll(),
      ])
      setTodos(todayList)
      setOverdue(od)
      setHabits(habitData.habits ?? [])
      setRecords(habitData.records ?? [])
      for (const pid of expandedRef.current) {
        void getScheduleSubtasks(pid).then(subs => {
          setSubtasks(m => ({ ...m, [pid]: subs }))
        }).catch(() => { /* ignore */ })
      }
    } catch (e) {
      console.error('[DayPanel] 加载失败', e)
    }
  }, [todayStr])

  useEffect(() => { void load() }, [load])
  useDataChanged('schedule', load)
  useDataChanged('habit', load)

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

  const topTodos = useMemo(() => todos.filter(t => !t.parentId), [todos])
  const pendingCount = topTodos.filter(t => t.status === 'pending').length
  const doneCount = topTodos.filter(t => t.status === 'done').length

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

  const parsed = useMemo(() => parseQuickDate(quick, todayDate), [quick, todayDate])
  // 任务栏快速添加固定为今日琐碎任务：日期强制今天，时间可用解析结果或手动填
  const finalTime = manualTime !== null ? manualTime : parsed.time

  const habitIndex = useMemo(() => buildRecordIndex(records), [records])
  const plannedHabits = useMemo(
    () => habits.filter(h => !h.archived && isPlannedOn(h, todayDate)),
    [habits, todayDate],
  )
  const checkedToday = useMemo(
    () => plannedHabits.filter(h => habitIndex.get(h.id)?.has(todayStr)).length,
    [plannedHabits, habitIndex, todayStr],
  )

  const toggleStatus = useCallback(async (t: ScheduleTodo) => {
    const next = t.status === 'done' ? 'pending' : 'done'
    setTodos(cur => cur.map(x => (x.id === t.id ? { ...x, status: next } : x)))
    setOverdue(cur => cur.map(x => (x.id === t.id ? { ...x, status: next } : x)))
    try {
      await updateScheduleTodo(t.id, { status: next })
      notifyDataChanged('schedule')
    } catch (e) {
      console.error('[DayPanel] 更新状态失败', e)
      void load()
    }
  }, [load])

  const moveToToday = useCallback(async (id: string) => {
    try {
      await updateScheduleTodo(id, { date: todayStr })
      notifyDataChanged('schedule')
      showToast({ type: 'info', message: '已改到今天' })
    } catch (e) {
      console.error('[DayPanel] 迁移失败', e)
      void load()
    }
  }, [todayStr, load])

  /** 提醒「稍后」：打盹 1 小时（写 snoozeUntil，打盹期内不再提醒该任务） */
  const snooze = useCallback(async (id: string) => {
    try {
      await updateScheduleTodo(id, { snoozeUntil: addMinutesLocal(60) })
      notifyDataChanged('schedule')
    } catch (e) {
      console.error('[DayPanel] snooze 失败', e)
    }
  }, [])

  const removeTodo = useCallback(async (t: ScheduleTodo) => {
    if (!window.confirm(`删除任务「${t.title}」？`)) return
    try {
      await deleteScheduleTodo(t.id)
      notifyDataChanged('schedule')
    } catch (e) {
      console.error('[DayPanel] 删除失败', e)
      void load()
    }
  }, [load])

  const saveEdit = useCallback(async () => {
    if (!editing) return
    const title = editing.title.trim()
    if (!title) { setEditing(null); return }
    try {
      await updateScheduleTodo(editing.id, { title, date: editing.date, time: editing.time || null })
      setEditing(null)
      notifyDataChanged('schedule')
    } catch (e) {
      console.error('[DayPanel] 保存失败', e)
      void load()
    }
  }, [editing, load])

  const toggleExpand = useCallback(async (pid: string) => {
    const next = new Set(expandedRef.current)
    if (next.has(pid)) next.delete(pid)
    else next.add(pid)
    expandedRef.current = next
    setExpanded(next)
    try {
      const subs = await getScheduleSubtasks(pid)
      setSubtasks(m => ({ ...m, [pid]: subs }))
    } catch { /* ignore */ }
  }, [])

  const addQuick = useCallback(async () => {
    const title = parsed.title.trim()
    if (!title) return
    try {
      // 任务栏快速添加 = 今日琐碎任务（daily）：日期固定今天，时间可解析/手填
      await createScheduleTodo({ title, date: todayStr, time: finalTime || undefined, taskType: 'daily' })
      setQuick('')
      setManualTime(null)
      notifyDataChanged('schedule')
      showToast({ type: 'info', message: `已添加今日琐碎：${title}` })
    } catch (e) {
      console.error('[DayPanel] 快速添加失败', e)
      showToast({ type: 'error', message: '添加失败，请重试' })
    }
  }, [parsed, finalTime, todayStr])

  const checkHabit = useCallback(async (h: Habit) => {
    const willCheck = !(habitIndex.get(h.id)?.has(todayStr) ?? false)
    setRecords(cur => willCheck
      ? [...cur, { id: `${h.id}:${todayStr}`, habitId: h.id, date: todayStr } as HabitRecord]
      : cur.filter(r => !(r.habitId === h.id && r.date === todayStr)))
    try {
      await toggleHabitCheck(h.id, todayStr)
      notifyDataChanged('habit')
    } catch (e) {
      console.error('[DayPanel] 打卡失败', e)
      void load()
    }
  }, [todayStr, habitIndex, load])

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

  // ---- 行渲染 ----
  function taskRow(t: ScheduleTodo, isOverdue: boolean) {
    const done = t.status === 'done'
    const isParent = !t.parentId
    const hasChevron = isParent
    const isEditing = editing?.id === t.id
    return (
      <div key={t.id}>
        <div className="group flex items-center gap-1.5 rounded-md px-1.5 py-1.5 hover:bg-[var(--bg-hover)]">
          {hasChevron ? (
            <button onClick={() => void toggleExpand(t.id)} className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="展开/收起子任务">
              {expanded.has(t.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <button
            onClick={() => void toggleStatus(t)}
            className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors ${
              done ? 'border-[var(--success)] bg-[var(--success)] text-white' : 'border-[var(--border-color)] hover:border-[var(--text-secondary)]'
            }`}
            title={done ? '标记未完成' : '标记完成'}
          >
            {done && <Check size={10} strokeWidth={3} />}
          </button>
          <span className={`flex-1 truncate text-xs ${done ? 'text-[var(--text-muted)] line-through' : ''} ${isOverdue && !done ? 'text-[var(--danger)]' : ''}`}>{t.title}</span>
          {isOverdue && !done && (
            <button onClick={() => void moveToToday(t.id)} className="hidden shrink-0 text-[var(--text-muted)] hover:text-[var(--accent)] group-hover:block" title="改到今天">
              <CalendarClock size={12} />
            </button>
          )}
          <button onClick={() => setEditing({ id: t.id, title: t.title, date: t.date, time: t.time ?? '' })} className="hidden shrink-0 text-[var(--text-muted)] hover:text-[var(--accent)] group-hover:block" title="编辑">
            <Pencil size={12} />
          </button>
          <button onClick={() => void removeTodo(t)} className="hidden shrink-0 text-[var(--text-muted)] hover:text-[var(--danger)] group-hover:block" title="删除">
            <Trash2 size={12} />
          </button>
          {t.time && <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{t.time}</span>}
          {t.tag && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: t.tag.color }} title={t.tag.name} />}
        </div>
        {isEditing && editing && (
          <div className="mx-1.5 mb-1 space-y-1.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] p-2">
            <input
              autoFocus
              value={editing.title}
              onChange={e => setEditing({ ...editing, title: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') void saveEdit(); if (e.key === 'Escape') setEditing(null) }}
              className="w-full rounded border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)]"
              placeholder="任务标题"
            />
            <div className="flex items-center gap-1.5">
              <input type="date" value={editing.date} onChange={e => setEditing({ ...editing, date: e.target.value })} className="min-w-0 flex-1 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] px-1.5 py-1 text-xs outline-none focus:border-[var(--accent)]" />
              <input type="time" value={editing.time} onChange={e => setEditing({ ...editing, time: e.target.value })} className="min-w-0 w-24 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] px-1.5 py-1 text-xs outline-none focus:border-[var(--accent)]" />
              <button onClick={() => void saveEdit()} className="rounded bg-[var(--accent)] px-2 py-1 text-xs text-white hover:opacity-90">保存</button>
              <button onClick={() => setEditing(null)} className="rounded border border-[var(--border-color)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">取消</button>
            </div>
          </div>
        )}
        {hasChevron && expanded.has(t.id) && (
          <div className="ml-6 border-l border-[var(--border-color)] pl-1.5">
            {(subtasks[t.id] ?? []).map(sub => (
              <div key={sub.id} className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-[var(--bg-hover)]">
                <button
                  onClick={() => void toggleStatus(sub)}
                  className={`flex h-3 w-3 shrink-0 items-center justify-center rounded border transition-colors ${
                    sub.status === 'done' ? 'border-[var(--success)] bg-[var(--success)] text-white' : 'border-[var(--border-color)]'
                  }`}
                >
                  {sub.status === 'done' && <Check size={8} strokeWidth={3} />}
                </button>
                <span className={`flex-1 truncate text-[11px] ${sub.status === 'done' ? 'text-[var(--text-muted)] line-through' : ''}`}>{sub.title}</span>
                <button onClick={() => void removeTodo(sub)} className="hidden shrink-0 text-[var(--text-muted)] hover:text-[var(--danger)] group-hover:block" title="删除">
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
            {(subtasks[t.id] ?? []).length === 0 && <p className="px-1.5 py-1 text-[11px] text-[var(--text-muted)]">无子任务</p>}
          </div>
        )}
      </div>
    )
  }

  // ---- 桌面互动模式判定 ----
  const isTopDock = mode === 'popout' && panelMode === 'top-dock'
  const isWidget = mode === 'popout' && panelMode === 'desktop-widget'
  const showTouchStrip = isTopDock && collapsed

  // 容器高度：嵌入式由外层卡片壳 flex 提供（flex-1）；独立窗口自己 h-screen。
  // top-dock 走透明窗口（无底色，圆角毛玻璃由 containerStyle 提供）；floating 保持不透明实体窗
  const containerCls = mode === 'embedded'
    ? 'relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)] select-none'
    : `relative flex h-screen flex-col overflow-hidden text-[var(--text-primary)] select-none${isTopDock ? '' : ' bg-[var(--bg-primary)]'}`
  // top-dock 展开态：透明窗口 + 底部圆角 + 毛玻璃（圆润悬浮感，顶部贴屏无圆角）
  const containerStyle = isTopDock ? {
    backgroundColor: 'color-mix(in srgb, var(--bg-primary) 88%, transparent)',
    backdropFilter: 'blur(14px)',
    boxShadow: '0 10px 36px rgb(0 0 0 / 0.28)',
    borderRadius: '0 0 20px 20px',
  } : undefined

  // top-dock：移入展开 / 移出 500ms 收回（主进程 grace）；小组件：划过激活可交互 / 移出恢复穿透
  const onRootMouseEnter = useCallback(() => {
    if (isTopDock) void window.api?.dayPanelTopdockExpand?.()
  }, [isTopDock])
  const onRootMouseLeave = useCallback(() => {
    if (isTopDock && !collapsed) void window.api?.dayPanelTopdockCollapseIntent?.()
    if (isWidget && widgetInteractive) void window.api?.dayPanelWidgetInteractive?.(false)
  }, [isTopDock, isWidget, collapsed, widgetInteractive])
  const onRootMouseMove = useCallback(() => {
    if (isWidget && !widgetInteractive) void window.api?.dayPanelWidgetInteractive?.(true)
  }, [isWidget, widgetInteractive])

  // 触碰条：收缩态占满 10px 透明窗口，半透明圆角条 + 待办红点 + 顶部高亮
  if (showTouchStrip) {
    return (
      <div
        className="relative h-full w-full cursor-pointer overflow-visible px-2"
        onMouseEnter={onRootMouseEnter}
        title="日程与打卡 · 悬停展开"
      >
        <div
          className="absolute inset-0 top-0 rounded-b-xl border-x border-b border-[var(--border-color)]"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--bg-primary) 78%, transparent)',
            boxShadow: '0 3px 12px rgb(0 0 0 / 0.18)',
          }}
        />
        <div className={`absolute inset-x-5 top-0 h-[3px] rounded-b ${overdueDdls.length > 0 ? 'bg-[var(--danger)] animate-pulse' : 'bg-[var(--accent)]/70'}`} />
        {pendingCount > 0 && (
          <div
            className="absolute right-3 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full"
            style={{ backgroundColor: 'var(--danger)' }}
            title={`${pendingCount} 个待办`}
          />
        )}
      </div>
    )
  }

  // 桌面小组件：只读展示，鼠标划过激活为可交互
  if (isWidget) {
    return (
      <div
        className={`flex h-full w-full flex-col gap-1.5 overflow-hidden rounded-2xl border p-3 text-[var(--text-primary)] ${overdueDdls.length > 0 ? 'border-[var(--danger)]' : 'border-[var(--border-color)]'}`}
        style={{
          backgroundColor: 'color-mix(in srgb, var(--bg-primary) 88%, transparent)',
          backdropFilter: 'blur(12px)',
          boxShadow: '0 6px 28px rgb(0 0 0 / 0.28)',
        }}
        onMouseMove={onRootMouseMove}
        onMouseLeave={onRootMouseLeave}
      >
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium">
            {todayDate.getMonth() + 1}月{todayDate.getDate()}日 {WEEKDAY_LABELS[todayDate.getDay()]}
          </span>
          <span className="flex items-center gap-1.5">
            {overdueDdls.length > 0 && (
              <span className="rounded-full bg-[var(--danger)] px-1.5 leading-[15px] text-[10px] font-semibold text-white" title={`${overdueDdls.length} 个逾期截止`}>
                {overdueDdls.length}
              </span>
            )}
            <span className="text-[10px] text-[var(--text-muted)]">{widgetInteractive ? '可操作' : '划过激活'}</span>
          </span>
        </div>
        <div className="flex items-baseline gap-1 text-[11px]">
          <span className="text-[var(--text-muted)]">今日待办</span>
          <span className="text-[13px] font-medium text-[var(--accent)]">{pendingCount}</span>
          <span className="text-[10px] text-[var(--text-muted)]">/ 完成 {doneCount}</span>
        </div>
        <div className="flex items-center gap-1 text-[11px]">
          <span className="text-[var(--text-muted)]">今日打卡</span>
          <span className="font-medium">{checkedToday}/{plannedHabits.length}</span>
        </div>
        <div className="mt-auto flex flex-col gap-1">
          <button
            onClick={() => { window.api?.dayPanelOpenInMain?.('schedule') }}
            className="rounded-md border border-[var(--border-color)] py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            title="在主窗口任务模块中管理"
          >
            打开任务模块
          </button>
          <button
            onClick={() => { window.api?.dayPanelSetMode?.('floating'); window.api?.dayPanelPopout?.() }}
            className="rounded-md py-0.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--accent)]"
            title="切换为自由漂浮模式"
          >
            切换自由漂浮
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={containerCls} style={containerStyle} onMouseEnter={onRootMouseEnter} onMouseLeave={onRootMouseLeave}>
      {/* 表头：嵌入式下用 WebkitAppRegion: drag 让用户能拖出脱离，独立窗口由 BrowserWindow 自身拖动；
          top-dock 展开态固定贴顶，禁拖（避免用户拖走破坏停靠位置） */}
      <div
        className="flex h-10 shrink-0 select-none items-center justify-between border-b border-[var(--border-color)] px-3"
        style={{ backgroundColor: 'color-mix(in srgb, var(--bg-tertiary) 78%, transparent)', ...(mode === 'popout' && !isTopDock ? dragRegion : undefined) }}
      >
        <div className="flex items-center gap-1.5 text-[12px]">
          {mode === 'popout' && !isTopDock && <GripHorizontal size={13} className="text-[var(--text-muted)]" />}
          {mode === 'embedded' ? '今日工作台' : '日程与打卡'}
          {isTopDock && <span className="text-[10px] font-normal text-[var(--text-muted)]">顶部停靠 · 移出自动收回</span>}
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
          {mode === 'popout' && !isTopDock && (
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

      <div className="flex-1 space-y-4 overflow-y-auto px-2.5 py-3">
        {tab === 'task' && (<>
        {/* 逾期 */}
        {overdue.length > 0 && (
          <section>
            <p className="mb-1 px-1 text-[11px] font-medium text-[var(--danger)]">⏰ 逾期（{overdue.length}）</p>
            <div className="space-y-0.5">{overdue.map(t => taskRow(t, true))}</div>
          </section>
        )}

        {/* 今日任务 */}
        <section>
          <div className="mb-1 flex items-center justify-between gap-1 px-1">
            <p className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-primary)]">
              <span className="font-medium">今天 · {todayDate.getMonth() + 1}月{todayDate.getDate()}日 {WEEKDAY_LABELS[todayDate.getDay()]}</span>
              <span className="ml-1 text-[var(--text-muted)]">（{pendingCount} 待办 / {doneCount} 完成）</span>
            </p>
            <button
              onClick={() => openInMain('schedule')}
              className="inline-flex shrink-0 items-center text-[var(--text-muted)] hover:text-[var(--accent)]"
              title="在主窗口任务模块中管理"
            >
              <ExternalLink size={11} />
            </button>
          </div>
          <div className="space-y-0.5">{topTodos.map(t => taskRow(t, false))}</div>
          {topTodos.length === 0 && (
            <p className="px-1 py-2 text-[11px] text-[var(--text-muted)]">今天暂无任务，下方快速添加一条吧</p>
          )}
          {/* 快速添加 */}
          <div className="mt-2 px-0.5">
            <div className="flex items-center gap-1.5">
              <input
                value={quick}
                onChange={e => { setQuick(e.target.value); setManualTime(null) }}
                onKeyDown={e => { if (e.key === 'Enter') void addQuick() }}
                placeholder="添加任务"
                className="min-w-0 flex-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1.5 text-[11px] outline-none focus:border-[var(--accent)]"
              />
              <button
                onClick={() => void addQuick()}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--accent)] text-white hover:opacity-90"
                title="添加（回车）"
              >
                <Plus size={14} />
              </button>
            </div>
            {quick.trim() && (
              <div className="mt-1 flex flex-wrap items-center gap-1.5 px-1 text-[11px] text-[var(--text-muted)]">
                <span className="rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[11px] text-[var(--accent)]">今天</span>
                <input
                  type="time"
                  value={finalTime ?? ''}
                  onChange={e => setManualTime(e.target.value || null)}
                  title="时间（可填写 / 修改）"
                  className="w-[74px] rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-1 py-0.5 text-[11px] text-[var(--accent)] outline-none focus:border-[var(--accent)]"
                />
                {manualTime !== null && (
                  <button
                    onClick={() => setManualTime(null)}
                    className="rounded px-1 py-0.5 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]"
                    title="恢复自动解析时间"
                  >
                    重解析
                  </button>
                )}
                <span className="min-w-0 flex-1 truncate" title={parsed.title}>{parsed.title || '（空）'}</span>
              </div>
            )}
          </div>
        </section>
        </>)}

        {/* 打卡 / 番茄 / 导航 三个工具 Tab */}
        {tab === 'habit' && (
          <HabitPanel
            habits={habits}
            habitIndex={habitIndex}
            plannedHabits={plannedHabits}
            checkedToday={checkedToday}
            onCheck={h => void checkHabit(h)}
            todayDate={todayDate}
            onOpenInMain={() => openInMain('toolbox')}
          />
        )}
        {tab === 'pomo' && (mode === 'embedded'
          ? <PomodoroPanel />
          : <PomodoroPopoutPanel status={pomodoroStatus} onOpenInMain={() => openInMain('toolbox')} />)}
        {tab === 'nav' && <NavPanel />}
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