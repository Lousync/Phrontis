import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Check, Trash2 } from 'lucide-react'
import type { ScheduleTodo, ScheduleTag } from '../../../types'
import { getScheduleWeekTodos, updateScheduleTodo } from '../../../lib/ipc'
import { localToday } from '../../../lib/date'
import { useSettings } from '../../../lib/SettingsContext'
import { showToast } from '../../../lib/toast'
import { isEditingInput } from '../../../lib/shortcuts'
import {
  quadrantMeta, QUADRANT_TEXT_CLASS, QuadrantIconGlyph, type QuadrantIcon,
} from '../../../lib/scheduleQuadrant'
import {
  GRANULARITY_VALUES, layoutDay, dueOfDay, MIN_DURATION, MIN_RANGE_HOURS,
  ROW_PX_DEFAULT, ROW_PX_PRESETS, ROW_PX_PRESET_LABEL, ROW_PX_STEP_KEY, ROW_PX_STEP_WHEEL, clampRowPx,
  SCHEDULE_DRAG_START, type DragStartDetail, type DragTodoSnapshot,
  clamp, dayFromMonday, dragGuard, fmtMin, mondayOfWeek, snapMin, shortDate, toDateStr,
  WEEKDAY_LABELS, type Granularity,
} from '../timetable'

/**
 * 日程表（周视图）。
 *
 * 形态：左侧「待安排」栏 ↔ 右侧 7 天时间网格，双向拖拽完成排期。
 * - 待安排 → 网格 = 排期；网格 → 待安排 = 取消排期
 * - 卡片上下边缘可拖拽改时长（最小 15 分钟，与粒度解耦）；不跨天
 * - 卡片整体拖动 = 改时间 / 改天；空白处拖框 = 新建（带时段预填）
 * - 截止类任务额外画一条虚线红线（不占时段）
 * - 未完成的排期任务自动延后：原日期让位，今天同一时段显示为虚线幽灵
 *
 * 拖拽全程用 **pointer events**（不用 HTML5 拖放）：落点判定、预览框、时长提示
 * 都由自己算，行为可控；待安排栏那边通过 `SCHEDULE_DRAG_START` 事件把任务快照交过来。
 */

interface Props {
  isActive: boolean
  tags: ScheduleTag[]
  iconSize: 'sm' | 'md' | 'lg'
  quadrantIcon: QuadrantIcon
  quadrantText: 'show' | 'hide'
  /** 外部数据变更信号（待安排栏增删、跨窗口同步等）→ 重新拉取本周 */
  refreshSignal: number
  /** 周偏移（与左栏「周任务」清单共用，翻页时两侧同步） */
  weekOffset: number
  setWeekOffset: React.Dispatch<React.SetStateAction<number>>
  onOpenTodo: (todo: ScheduleTodo) => void
  onToggleDone: (todo: ScheduleTodo) => void
  /** 空白处拖框新建：交给上层打开编辑弹窗（预填日期与时段） */
  onRequestCreate: (dateStr: string, start: number, end: number) => void
  /** 网格卡片拖回待安排栏 = 取消排期 */
  onUnschedule: (id: string) => void
  /** 网格卡片右上角删除钮（悬停显现）。本视图先播退场动效再回调 */
  onDeleteTodo: (todo: ScheduleTodo) => void
  /** 排期/改时长落盘成功后通知上层刷新（待安排栏、月历打点） */
  onChanged: () => void
}

/** 任务 → 拖拽快照（载荷自带本体，落点不回查数据集） */
function snapshotOf(todo: ScheduleTodo): DragTodoSnapshot {
  return {
    id: todo.id, title: todo.title, date: todo.date, taskType: todo.taskType,
    tagId: todo.tagId, quadrant: todo.quadrant,
    scheduledStart: todo.scheduledStart, scheduledEnd: todo.scheduledEnd,
  }
}

/** 与 `.kb-item-out` 的过渡时长一致（styles/index.css） */
const EXIT_MS = 180

export function TimetableView({
  isActive, tags, iconSize, quadrantIcon, quadrantText, refreshSignal,
  weekOffset, setWeekOffset,
  onOpenTodo, onToggleDone, onRequestCreate, onUnschedule, onDeleteTodo, onChanged,
}: Props) {
  const today = localToday()
  const { s: appSettings, update } = useSettings()

  // ---- 设置（设置页与这里双向联动）----
  const gran: Granularity = (GRANULARITY_VALUES as readonly number[]).includes(Number(appSettings.scheduleTimetableGranularity))
    ? (Number(appSettings.scheduleTimetableGranularity) as Granularity)
    : 30
  // 行高是连续数值（可 Ctrl+滚轮缩放），非法值/旧版遗留字符串由 clampRowPx 兜底
  const rowPx = clampRowPx(Number(appSettings.scheduleTimetableRowHeight))
  const startHour = clamp(Number(appSettings.scheduleTimetableStartHour) || 7, 0, 20)
  const endHour = clamp(Number(appSettings.scheduleTimetableEndHour) || 23, startHour + MIN_RANGE_HOURS, 24)
  const pxPerHour = rowPx
  const pxPerMin = pxPerHour / 60
  const dayStartMin = startHour * 60
  const dayEndMin = endHour * 60
  const totalH = (endHour - startHour) * pxPerHour

  const [rows, setRows] = useState<ScheduleTodo[]>([])
  const [rangeOpen, setRangeOpen] = useState(false)
  const [drop, setDrop] = useState<{ day: number; start: number; duration: number } | null>(null)
  const [resize, setResize] = useState<{ id: string; start: number; end: number } | null>(null)
  const [blank, setBlank] = useState<{ day: number; start: number; end: number } | null>(null)
  /** 正在退场的卡片 id（播完 `.kb-item-out` 才真正落盘删除） */
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const hintRef = useRef<HTMLDivElement>(null)
  /** 缩放后待恢复的 scrollTop（让锚点时刻留在原来的屏幕位置） */
  const pendingScrollRef = useRef<number | null>(null)

  /**
   * 缩放时间轴：改每小时像素高度，并把 scrollTop 挪到「锚点时刻仍在原来屏幕位置」。
   * 不做这一步的话缩放会围绕内容顶部进行，正在看的时间段会被甩出视口。
   */
  const zoomTo = useCallback((next: number, anchorY: number) => {
    const el = scrollRef.current
    const target = clampRowPx(next)
    if (!el || target === rowPx) return
    const hoursAtAnchor = (el.scrollTop + anchorY) / rowPx
    pendingScrollRef.current = hoursAtAnchor * target - anchorY
    update('scheduleTimetableRowHeight', target)
  }, [rowPx, update])

  // 行高变化后应用挂起的滚动位置（layout 阶段落地，避免视觉上闪一下）
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pendingScrollRef.current != null) {
      el.scrollTop = Math.max(0, pendingScrollRef.current)
      pendingScrollRef.current = null
    }
  }, [rowPx])

  // Ctrl+滚轮缩放，锚点 = 指针所在的时刻
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey && !ev.metaKey) return
      ev.preventDefault() // 拦掉 Chromium 自带的页面缩放
      const dir = ev.deltaY < 0 ? 1 : -1
      zoomTo(rowPx + dir * ROW_PX_STEP_WHEEL, ev.clientY - el.getBoundingClientRect().top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [rowPx, zoomTo])

  // Ctrl+= / Ctrl+- / Ctrl+0，锚点 = 视口中心
  useEffect(() => {
    if (!isActive) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (isEditingInput(e)) return
      const el = scrollRef.current
      const anchorY = el ? el.clientHeight / 2 : 0
      if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomTo(rowPx + ROW_PX_STEP_KEY, anchorY) }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomTo(rowPx - ROW_PX_STEP_KEY, anchorY) }
      else if (e.key === '0') { e.preventDefault(); zoomTo(ROW_PX_DEFAULT, anchorY) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isActive, rowPx, zoomTo])

  const monday = useMemo(() => mondayOfWeek(today, weekOffset), [today, weekOffset])
  const weekStart = toDateStr(monday)
  const weekEnd = toDateStr(dayFromMonday(monday, 6))
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => dayFromMonday(monday, i)), [monday])

  // ---- 取数 ----
  const load = useCallback(async () => {
    try {
      setRows(await getScheduleWeekTodos(weekStart, weekEnd))
    } catch (e) {
      console.error('[schedule] 读取本周任务失败', e)
    }
  }, [weekStart, weekEnd])

  useEffect(() => { void load() }, [load, refreshSignal])

  // 激活重读（模块保活，切回来时兜一次）
  const activatedRef = useRef(false)
  useEffect(() => {
    if (!isActive) return
    if (!activatedRef.current) { activatedRef.current = true; return }
    void load()
  }, [isActive, load])

  // 首次进入滚动到 08:30 附近
  const scrolledRef = useRef(false)
  useEffect(() => {
    if (scrolledRef.current) return
    const el = scrollRef.current
    if (!el) return
    scrolledRef.current = true
    el.scrollTop = Math.max(0, (8.5 * 60 - dayStartMin) * pxPerMin - 60)
  }, [dayStartMin, pxPerMin])

  // ---- 派生 ----
  const withTag = useMemo(
    () => rows.map(t => ({ ...t, tag: t.tagId ? tags.find(tg => tg.id === t.tagId) ?? null : null })),
    [rows, tags],
  )

  /** 已排期的任务（网格里的卡片） */
  const scheduled = useMemo(
    () => withTag.filter(t => t.scheduledStart != null && t.scheduledEnd != null),
    [withTag],
  )

  /** 未完成自动延后的候选：排期早于本周、仍未完成 —— 在今天同一时段画幽灵 */
  const isCurrentWeek = weekOffset === 0
  const deferredForToday = useMemo(() => {
    if (!isCurrentWeek) return []
    return withTag.filter(t =>
      t.status === 'pending' && t.scheduledStart != null && t.scheduledEnd != null && t.date < weekStart)
  }, [withTag, isCurrentWeek, weekStart])

  const weekStats = useMemo(() => {
    const inWeek = scheduled.filter(t => t.date >= weekStart && t.date <= weekEnd)
    const mins = inWeek.reduce((a, t) => a + ((t.scheduledEnd ?? 0) - (t.scheduledStart ?? 0)), 0)
    return { count: inWeek.length, hours: (mins / 60).toFixed(1).replace(/\.0$/, '') }
  }, [scheduled, weekStart, weekEnd])

  /**
   * 本周全部未完成任务里「带截止时间」的（与排期解耦）：红线数据源。
   * 未排期的本周 DDL 任务也在这里（之前被 scheduled 过滤掉，导致「先看线后排期」完全反了）。
   */
  const weekDdl = useMemo(
    () => rows.filter(t => t.status === 'pending' && !!t.time),
    [rows],
  )

  // ---- 提示浮标 ----
  const showHint = useCallback((x: number, y: number, text: string) => {
    const el = hintRef.current
    if (!el) return
    el.textContent = text
    el.style.display = 'block'
    el.style.left = `${x + 14}px`
    el.style.top = `${y - 28}px`
  }, [])
  const hideHint = useCallback(() => {
    const el = hintRef.current
    if (el) el.style.display = 'none'
  }, [])

  // ---- 提交排期 ----
  // 参数只要求排期相关的四个字段（而不是完整 ScheduleTodo）：落点用的是拖拽快照，
  // 待安排栏的任务可能来自任意月份，不一定存在于本视图的 rows 里
  const commitSchedule = useCallback(async (
    todo: { id: string; date: string; scheduledStart: number | null; scheduledEnd: number | null },
    dateStr: string, start: number, end: number,
  ) => {
    const patch = { date: dateStr, scheduledStart: start, scheduledEnd: end }
    const prevState = { date: todo.date, scheduledStart: todo.scheduledStart, scheduledEnd: todo.scheduledEnd }
    setRows(prev => prev.map(t => (t.id === todo.id ? { ...t, ...patch } : t)))
    try {
      await updateScheduleTodo(todo.id, patch)
      onChanged()
      void load()
    } catch (e) {
      setRows(prev => prev.map(t => (t.id === todo.id ? { ...t, ...prevState } : t)))
      showToast({ type: 'error', message: '排期保存失败，已还原' })
      console.error(e)
    }
  }, [onChanged, load])

  // ---- ① 拖拽（pointer events，不依赖 HTML5 拖放）----
  /** 拖拽会话放 ref：pointermove 里高频读，走 state 会每帧重渲染整张网格 */
  const dragRef = useRef<DragStartDetail | null>(null)
  const ghostRef = useRef<HTMLDivElement>(null)

  /** 指针位置 → 落点（某天的第几分钟 / 待安排栏 / 无效） */
  const hitTest = useCallback((x: number, y: number): { kind: 'day'; day: number; start: number } | { kind: 'tray' } | null => {
    const d = dragRef.current
    if (!d) return null

    // 待安排栏（只接受从网格拖回来的，用于取消排期）
    const trayEl = document.querySelector<HTMLElement>('[data-tray-drop]')
    if (trayEl) {
      const r = trayEl.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return d.from === 'grid' ? { kind: 'tray' } : null
      }
    }

    // 日期列
    const cols = document.querySelectorAll<HTMLElement>('[data-day-col]')
    for (let i = 0; i < cols.length; i++) {
      const r = cols[i].getBoundingClientRect()
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue
      const raw = dayStartMin + (y - r.top) / pxPerMin - d.grabOffset
      const maxStart = Math.max(dayStartMin, dayEndMin - d.duration)
      return { kind: 'day', day: i, start: clamp(snapMin(raw, gran), dayStartMin, maxStart) }
    }
    return null
  }, [dayStartMin, dayEndMin, pxPerMin, gran])

  /** 起拖：接管 window 的 pointer 事件直到松手 */
  const startDrag = useCallback((detail: DragStartDetail) => {
    dragRef.current = detail
    document.body.style.userSelect = 'none'

    const trayEl = () => document.querySelector<HTMLElement>('[data-tray-drop]')

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return

      // 跟随指针的幽灵标签（直接改 DOM，不走 state）
      const g = ghostRef.current
      if (g) {
        g.style.display = 'block'
        g.textContent = d.todo.title
        g.style.left = `${ev.clientX + 12}px`
        g.style.top = `${ev.clientY + 12}px`
      }

      const hit = hitTest(ev.clientX, ev.clientY)
      if (hit?.kind === 'day') {
        // 同值跳过：避免每帧都 setState 重渲染
        setDrop(prev => (prev && prev.day === hit.day && prev.start === hit.start && prev.duration === d.duration
          ? prev
          : { day: hit.day, start: hit.start, duration: d.duration }))
        showHint(ev.clientX, ev.clientY, `${fmtMin(hit.start)}–${fmtMin(hit.start + d.duration)} · ${d.duration} 分钟`)
      } else {
        setDrop(null)
        hideHint()
      }
      const t = trayEl()
      if (t) t.style.boxShadow = hit?.kind === 'tray' ? 'inset 0 0 0 2px var(--accent)' : ''
    }

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.style.userSelect = ''
      const d = dragRef.current
      // 注意：hitTest 依赖 dragRef，必须在清空之前算落点
      const hit = d ? hitTest(ev.clientX, ev.clientY) : null
      dragRef.current = null
      dragGuard.lastEnd = Date.now()
      const g = ghostRef.current
      if (g) g.style.display = 'none'
      setDrop(null)
      hideHint()
      const t = trayEl()
      if (t) t.style.boxShadow = ''
      if (!d || !hit) return

      if (hit.kind === 'tray') {
        if (d.from === 'grid') onUnschedule(d.todo.id)
        return
      }
      void commitSchedule(d.todo, toDateStr(days[hit.day]), hit.start, hit.start + d.duration)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [hitTest, showHint, hideHint, commitSchedule, days, onUnschedule])

  /** 网格卡片按下 → 位移超阈值后起拖（把手与完成按钮已各自 stopPropagation） */
  const onBlockPointerDown = useCallback((todo: ScheduleTodo, e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('.rz, button')) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const dur = Math.max(MIN_DURATION, (todo.scheduledEnd ?? 0) - (todo.scheduledStart ?? 0))
    const grabOffset = clamp((e.clientY - rect.top) / pxPerMin, 0, dur)
    const sx = e.clientX
    const sy = e.clientY
    let started = false

    const onMove = (ev: PointerEvent) => {
      if (started) return
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return
      started = true
      cleanup()
      startDrag({ todo: snapshotOf(todo), from: 'grid', duration: dur, grabOffset })
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', cleanup)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', cleanup)
  }, [pxPerMin, startDrag])

  // 待安排栏（另一个组件树）发起的拖拽 → 由本视图接管后续落点判定
  useEffect(() => {
    const onStart = (e: Event) => startDrag((e as CustomEvent<DragStartDetail>).detail)
    window.addEventListener(SCHEDULE_DRAG_START, onStart)
    return () => window.removeEventListener(SCHEDULE_DRAG_START, onStart)
  }, [startDrag])

  // ---- ② 边缘拉伸（pointer events）----
  const onResizeDown = useCallback((todo: ScheduleTodo, edge: 'top' | 'bot', e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const s0 = todo.scheduledStart!
    const e0 = todo.scheduledEnd!
    const colEl = (e.currentTarget as HTMLElement).closest('[data-day-col]') as HTMLElement | null
    if (!colEl) return
    const rect = colEl.getBoundingClientRect()
    let latest = { start: s0, end: e0 }
    let moved = false

    const toMin = (clientY: number) => snapMin(dayStartMin + (clientY - rect.top) / pxPerMin, gran)

    const onMove = (ev: PointerEvent) => {
      moved = true
      const m = toMin(ev.clientY)
      if (edge === 'top') {
        latest = { start: clamp(m, dayStartMin, e0 - MIN_DURATION), end: e0 }
      } else {
        latest = { start: s0, end: clamp(m, s0 + MIN_DURATION, dayEndMin) }
      }
      setResize({ id: todo.id, ...latest })
      showHint(ev.clientX, ev.clientY, `${fmtMin(latest.start)}–${fmtMin(latest.end)} · ${latest.end - latest.start} 分钟`)
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setResize(null)
      hideHint()
      // 拉伸同样是一次 pointer 手势：松手后浏览器会补发 click，
      // 不记时间戳的话卡片 onClick 会把它当成普通点击 → 顺手弹出编辑窗。
      dragGuard.lastEnd = Date.now()
      if (!moved) return
      if (latest.start === s0 && latest.end === e0) return
      void commitSchedule(todo, todo.date, latest.start, latest.end)
    }

    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [dayStartMin, dayEndMin, pxPerMin, gran, showHint, hideHint, commitSchedule])

  // ---- ③ 空白拖框新建（pointer events）----
  const onColumnPointerDown = useCallback((dayIdx: number, e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('[data-block]')) return
    const colEl = e.currentTarget as HTMLElement
    const rect = colEl.getBoundingClientRect()
    const origin = clamp(snapMin(dayStartMin + (e.clientY - rect.top) / pxPerMin, gran), dayStartMin, dayEndMin - MIN_DURATION)
    let latest = { start: origin, end: origin + 60 }
    let moved = false

    const onMove = (ev: PointerEvent) => {
      const m = clamp(snapMin(dayStartMin + (ev.clientY - rect.top) / pxPerMin, gran), dayStartMin, dayEndMin)
      if (Math.abs(m - origin) < gran) return
      moved = true
      document.body.style.userSelect = 'none'
      latest = { start: Math.min(origin, m), end: Math.max(origin, m) }
      if (latest.end - latest.start < MIN_DURATION) latest.end = latest.start + MIN_DURATION
      setBlank({ day: dayIdx, ...latest })
      showHint(ev.clientX, ev.clientY, `${fmtMin(latest.start)}–${fmtMin(latest.end)} · ${latest.end - latest.start} 分钟`)
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.userSelect = ''
      setBlank(null)
      hideHint()
      if (!moved) return
      onRequestCreate(toDateStr(days[dayIdx]), latest.start, latest.end)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [dayStartMin, dayEndMin, pxPerMin, gran, days, showHint, hideHint, onRequestCreate])

  // ---- 渲染 ----
  const todayIdx = days.findIndex(d => toDateStr(d) === today)

  /** 打开编辑前先挡掉「刚拖完补发的那次 click」 */
  const openTodoGuarded = useCallback((t: ScheduleTodo) => {
    if (Date.now() - dragGuard.lastEnd < 250) return
    onOpenTodo(t)
  }, [onOpenTodo])

  /**
   * 卡片删除：先标记退场（卡片加 `.kb-item-out` 淡出右移），动画播完再落盘。
   * 不能直接调 onDeleteTodo —— 它会立刻刷新 rows，卡片在动画播完前就被移除，动效看不见。
   */
  const deleteTodoAnimated = useCallback((t: ScheduleTodo) => {
    setDeletingId(prev => (prev ? prev : t.id))
    window.setTimeout(() => {
      setDeletingId(null)
      onDeleteTodo(t)
    }, EXIT_MS)
  }, [onDeleteTodo])

  return (
    <div className="flex h-full flex-col bg-[var(--bg-primary)]">
      {/* 工具行 */}
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-3 py-1.5 shrink-0 select-none">
        <button onClick={() => setWeekOffset(v => v - 1)} title="上一周"
          className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
          <ChevronLeft size={14} />
        </button>
        <span className="text-[12px] font-medium text-[var(--text-primary)] whitespace-nowrap">
          {monday.getFullYear()}年{monday.getMonth() + 1}月 · {monday.getDate()}–{dayFromMonday(monday, 6).getDate()}日
        </span>
        <button onClick={() => setWeekOffset(v => v + 1)} title="下一周"
          className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
          <ChevronRight size={14} />
        </button>
        <button onClick={() => setWeekOffset(0)} disabled={weekOffset === 0}
          className="px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-40 disabled:hover:bg-transparent">
          今天
        </button>

        <span className="ml-2 text-[11px] text-[var(--text-muted)] whitespace-nowrap">
          本周 {weekStats.count} 项 · 约 {weekStats.hours} h
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          {/* 粒度 */}
          <div className="flex items-center gap-0.5 rounded-md bg-[var(--bg-secondary)] p-0.5">
            {GRANULARITY_VALUES.map(g => (
              <button key={g} onClick={() => update('scheduleTimetableGranularity', String(g))}
                title={`刻度与吸附步长：${g} 分钟`}
                className={`px-1.5 py-0.5 rounded text-[11px] transition-colors ${gran === g ? 'bg-[var(--bg-primary)] text-[var(--accent)] font-semibold shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>
                {g === 60 ? '1时' : `${g}分`}
              </button>
            ))}
          </div>
          {/* 行高：显示实际 px，点击切到下一个预设；精细缩放走 Ctrl+滚轮 / Ctrl+加减号 */}
          <button onClick={() => {
            const i = (ROW_PX_PRESETS as readonly number[]).indexOf(rowPx)
            const next = i >= 0 ? ROW_PX_PRESETS[(i + 1) % ROW_PX_PRESETS.length] : ROW_PX_DEFAULT
            zoomTo(next, (scrollRef.current?.clientHeight ?? 0) / 2)
          }}
            title={`行高 ${rowPx}px（${ROW_PX_PRESET_LABEL[rowPx] ?? '自定义'}）· Ctrl+滚轮 或 Ctrl+加减号 缩放，Ctrl+0 复位`}
            className="px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors tabular-nums">
            {rowPx}px
          </button>
          {/* 显示范围 */}
          <div className="relative">
            <button onClick={() => setRangeOpen(v => !v)} title="时间轴显示范围"
              className="px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors tabular-nums">
              {fmtMin(dayStartMin)}–{fmtMin(dayEndMin)}
            </button>
            {rangeOpen && (
              <RangePop
                startHour={startHour} endHour={endHour}
                onChange={(kind, h) => {
                  if (kind === 'start') {
                    if (endHour - h < MIN_RANGE_HOURS) return
                    update('scheduleTimetableStartHour', String(h))
                  } else {
                    if (h - startHour < MIN_RANGE_HOURS) return
                    update('scheduleTimetableEndHour', String(h))
                  }
                }}
                onClose={() => setRangeOpen(false)}
              />
            )}
          </div>
        </div>
      </div>

      {/* 表头 */}
      <div className="flex shrink-0 border-b border-[var(--border-color)]">
        <div className="w-[52px] shrink-0 border-r border-[var(--border-color)]" />
        {days.map((d, i) => {
          const isToday = i === todayIdx
          const count = scheduled.filter(t => t.date === toDateStr(d)).length
          return (
            <div key={i}
              className={`flex-1 min-w-0 px-2 py-1.5 border-r border-[var(--border-color)] last:border-r-0 flex items-baseline gap-1.5 ${isToday ? 'bg-[var(--input-bg)]' : ''}`}>
              <span className={`text-[11.5px] font-semibold ${isToday ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}>
                {WEEKDAY_LABELS[i]}{isToday ? ' · 今天' : ''}
              </span>
              <span className={`text-[10.5px] ${isToday ? 'text-[var(--accent)]/70' : 'text-[var(--text-disabled)]'}`}>{shortDate(d)}</span>
              {count > 0 && <span className="ml-auto text-[10px] text-[var(--text-disabled)]">{count} 项</span>}
            </div>
          )
        })}
      </div>

      {/* 网格 */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="flex min-w-full">
          {/* 时间刻度 */}
          <div className="w-[52px] shrink-0 border-r border-[var(--border-color)] relative sticky left-0 bg-[var(--bg-primary)] z-[2]"
            style={{ height: totalH }}>
            {Array.from({ length: endHour - startHour + 1 }, (_, i) => (
              <span key={i} className="absolute right-1.5 -translate-y-1/2 text-[10px] text-[var(--text-disabled)] tabular-nums"
                style={{ top: i * pxPerHour }}>
                {fmtMin((startHour + i) * 60)}
              </span>
            ))}
          </div>

          {/* 7 天列 */}
          {days.map((d, dayIdx) => {
            const ds = toDateStr(d)
            const isToday = dayIdx === todayIdx
            const dayAll = scheduled.filter(t => t.date === ds)
            // 与显示范围完全不相交的任务不画（部分重叠的保留，由列的 overflow-hidden 裁边）
            const ordinary = dayAll.filter(t =>
              (t.scheduledEnd ?? 0) > dayStartMin && (t.scheduledStart ?? 0) < dayEndMin)
            const laid = layoutDay(ordinary)
            const dues = dueOfDay(weekDdl, ds)
            const ghosts = isToday ? deferredForToday : []
            const isDropTarget = drop?.day === dayIdx

            return (
              <div
                key={dayIdx}
                data-day-col
                onPointerDown={e => onColumnPointerDown(dayIdx, e)}
                className={`flex-1 min-w-0 relative overflow-hidden border-r border-[var(--border-color)] last:border-r-0 ${isToday ? 'bg-[var(--input-bg)]' : ''} ${isDropTarget ? 'bg-[var(--drop-bg)]' : ''}`}
                style={{ height: totalH }}
              >
                {/* 网格线 */}
                {Array.from({ length: endHour - startHour }, (_, i) => (
                  <div key={`h${i}`}>
                    <div className="absolute left-0 right-0 h-px bg-[var(--border-color)] opacity-70" style={{ top: i * pxPerHour }} />
                    {Array.from({ length: Math.max(0, 60 / gran - 1) }, (_, k) => (
                      <div key={`m${k}`} className="absolute left-0 right-0 h-px bg-[var(--border-color)] opacity-25"
                        style={{ top: i * pxPerHour + ((k + 1) * gran / 60) * pxPerHour }} />
                    ))}
                  </div>
                ))}

                {/* 截止红线（标注归属任务） */}
                {dues.map((d, i) => (
                  <div key={`due${d.id}`} className="absolute left-0 right-0 z-[4] pointer-events-none"
                    style={{ top: (d.min - dayStartMin) * pxPerMin }}>
                    <div className="border-t border-dashed border-[var(--danger)]" />
                    <span className="absolute left-1 -top-2 max-w-[calc(100%-8px)] truncate px-1 leading-[14px] rounded-[3px] text-[9.5px] font-semibold text-white bg-[var(--danger)]" title={`${d.title} · 截止 ${fmtMin(d.min)}`}>
                      截止 {fmtMin(d.min)} · {d.title}
                    </span>
                  </div>
                ))}

                {/* 当前时刻线 */}
                {isToday && (() => {
                  const now = new Date()
                  const nm = now.getHours() * 60 + now.getMinutes()
                  if (nm < dayStartMin || nm > dayEndMin) return null
                  return (
                    <div className="absolute left-0 right-0 z-[3] pointer-events-none" style={{ top: (nm - dayStartMin) * pxPerMin }}>
                      <div className="border-t-[1.5px] border-[var(--danger)]" />
                      <span className="absolute left-0.5 -top-[3px] w-1.5 h-1.5 rounded-full bg-[var(--danger)]" />
                    </div>
                  )
                })()}

                {/* 落点预览 */}
                {drop?.day === dayIdx && (
                  <div className="absolute left-0.5 right-0.5 z-[5] rounded-md pointer-events-none border-[1.5px] border-dashed border-[var(--accent)] bg-[var(--accent)]/12"
                    style={{ top: (drop.start - dayStartMin) * pxPerMin, height: Math.max(20, drop.duration * pxPerMin - 2) }} />
                )}

                {/* 空白拖框新建 */}
                {blank?.day === dayIdx && (
                  <div className="absolute left-0.5 right-0.5 z-[5] rounded-md pointer-events-none border-[1.5px] border-dashed border-[var(--accent)] bg-[var(--accent)]/16"
                    style={{ top: (blank.start - dayStartMin) * pxPerMin, height: Math.max(20, (blank.end - blank.start) * pxPerMin - 2) }} />
                )}

                {/* 延后幽灵（未完成的排期任务滚到今天） */}
                {ghosts.map(t => (
                  <Block key={`ghost-${t.id}`} todo={t} pxPerMin={pxPerMin} dayStartMin={dayStartMin}
                    lane={0} lanes={1} ghost iconSize={iconSize} quadrantIcon={quadrantIcon} quadrantText={quadrantText}
                    onOpen={openTodoGuarded} onToggleDone={onToggleDone}
                    onStartDrag={onBlockPointerDown}
                    onResizeDown={onResizeDown} resize={null} />
                ))}

                {/* 任务卡片 */}
                {laid.map(({ item, lane, lanes }) => {
                  const live = resize?.id === item.id ? resize : null
                  return (
                    <Block key={item.id} todo={item} pxPerMin={pxPerMin} dayStartMin={dayStartMin}
                      lane={lane} lanes={lanes} iconSize={iconSize} quadrantIcon={quadrantIcon} quadrantText={quadrantText}
                      onOpen={openTodoGuarded} onToggleDone={onToggleDone}
                      onStartDrag={onBlockPointerDown}
                      onDelete={deleteTodoAnimated} deleting={deletingId === item.id}
                      onResizeDown={onResizeDown} resize={live} />
                  )
                })}

                {dayAll.length === 0 && !ghosts.length && (
                  <span className="absolute left-1/2 top-2 -translate-x-1/2 text-[10.5px] text-[var(--text-disabled)] pointer-events-none whitespace-nowrap">
                    拖任务到这里
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div ref={hintRef}
        className="fixed z-[9000] hidden px-1.5 py-0.5 rounded text-[10.5px] font-semibold text-white bg-black/85 tabular-nums pointer-events-none whitespace-nowrap"
        style={{ letterSpacing: '.2px' }} />

      {/* 拖拽时跟随指针的幽灵标签（直接改 DOM，不参与渲染循环） */}
      <div ref={ghostRef}
        className="fixed z-[9500] hidden pointer-events-none px-2 py-1 rounded border border-[var(--accent)] bg-[var(--bg-primary)] shadow-lg text-[11.5px] font-medium max-w-[200px] truncate"
        style={{ left: 0, top: 0 }} />
    </div>
  )
}

/* ===================== 任务块 ===================== */

function Block({
  todo, pxPerMin, dayStartMin, lane, lanes, ghost = false, iconSize, quadrantIcon, quadrantText,
  onOpen, onToggleDone, onStartDrag, onResizeDown, onDelete, deleting = false, resize,
}: {
  todo: ScheduleTodo & { tag?: ScheduleTag | null }
  pxPerMin: number
  dayStartMin: number
  lane: number
  lanes: number
  ghost?: boolean
  iconSize: 'sm' | 'md' | 'lg'
  quadrantIcon: QuadrantIcon
  quadrantText: 'show' | 'hide'
  onOpen: (t: ScheduleTodo) => void
  onToggleDone: (t: ScheduleTodo) => void
  onStartDrag: (t: ScheduleTodo, e: React.PointerEvent) => void
  onResizeDown: (t: ScheduleTodo, edge: 'top' | 'bot', e: React.PointerEvent) => void
  /** 删除（悬停右上角显现）。ghost 卡（延后虚影）与过矮卡不提供 —— 后者走编辑弹窗删除 */
  onDelete?: (t: ScheduleTodo) => void
  /** 正在退场：加 `.kb-item-out` 淡出右移 */
  deleting?: boolean
  resize: { start: number; end: number } | null
}) {
  const start = resize ? resize.start : todo.scheduledStart!
  const end = resize ? resize.end : todo.scheduledEnd!
  const top = (start - dayStartMin) * pxPerMin
  const height = Math.max(20, (end - start) * pxPerMin - 2)
  const tiny = height < 34
  const compact = height < 52
  const tag = todo.tag ?? null
  const color = tag?.color ?? 'var(--accent)'
  const q = quadrantMeta(todo.quadrant)
  const isDone = todo.status === 'done'
  const widthPct = 100 / lanes
  const leftPct = lane * widthPct
  const fz = iconSize === 'lg' ? 12 : iconSize === 'md' ? 11.5 : 11

  return (
    <div
      data-block
      onPointerDown={ghost ? undefined : e => onStartDrag(todo, e)}
      onClick={() => onOpen(todo)}
      className={`absolute group rounded-md overflow-hidden transition-shadow z-[2] hover:z-[6] hover:shadow-[0_3px_10px_rgba(0,0,0,.16)] ${ghost ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'} ${isDone ? 'opacity-50' : ''} ${deleting ? 'kb-item-out' : ''}`}
      style={{
        top, height,
        left: `calc(${leftPct}% + 2px)`,
        width: `calc(${widthPct}% - 4px)`,
        background: ghost ? 'transparent' : `color-mix(in srgb, ${color} 11%, var(--bg-primary))`,
        border: ghost ? `1.5px dashed color-mix(in srgb, ${color} 55%, transparent)` : `1px solid color-mix(in srgb, ${color} 26%, transparent)`,
        borderLeft: ghost ? `3px dashed ${color}` : `3px solid ${color}`,
        padding: tiny ? '2px 5px' : '3px 5px 4px 6px',
      }}
      title={ghost ? `未完成，已从 ${todo.date} 延后` : '拖动改时间 · 拖上下边缘改时长 · 双击编辑'}
    >
      {/* 完成按钮 */}
      {!ghost && !tiny && (
        <button
          onClick={e => { e.stopPropagation(); onToggleDone(todo) }}
          onMouseDown={e => { e.preventDefault(); e.stopPropagation() }}
          title={isDone ? '恢复未完成' : '标记完成'}
          className={`absolute right-1 top-1 z-[3] w-[13px] h-[13px] rounded-[3px] border flex items-center justify-center transition-colors ${isDone ? 'bg-[var(--success)] border-[var(--success)]' : 'border-[var(--border-color)] bg-[var(--bg-primary)]/70 hover:border-[var(--success)]'}`}
        >
          {isDone && <Check size={9} strokeWidth={3.5} className="text-white" />}
        </button>
      )}

      {/* 删除按钮（悬停显现，与完成钮并排；tiny 卡不提供 —— 走编辑弹窗删除） */}
      {!ghost && !tiny && onDelete && (
        <button
          onClick={e => { e.stopPropagation(); onDelete(todo) }}
          onMouseDown={e => { e.preventDefault(); e.stopPropagation() }}
          title="删除任务"
          className="absolute right-[19px] top-1 z-[3] w-[13px] h-[13px] rounded-[3px] border border-[var(--border-color)] bg-[var(--bg-primary)]/70 flex items-center justify-center text-[var(--text-muted)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-[var(--danger)] hover:border-[var(--danger)] transition-all"
        >
          <Trash2 size={9} />
        </button>
      )}

      {/* 边缘拉伸把手 */}
      {!ghost && (
        <>
          <div className="absolute left-0 right-0 top-0 h-[7px] z-[3] cursor-ns-resize group/rz"
            onPointerDown={e => onResizeDown(todo, 'top', e)}
            onClick={e => e.stopPropagation()}>
            <span className="absolute left-1/2 -translate-x-1/2 top-[2px] w-4 h-[3px] rounded-full opacity-0 group-hover/rz:opacity-100 transition-opacity" style={{ background: color }} />
          </div>
          <div className="absolute left-0 right-0 bottom-0 h-[7px] z-[3] cursor-ns-resize group/rz"
            onPointerDown={e => onResizeDown(todo, 'bot', e)}
            onClick={e => e.stopPropagation()}>
            <span className="absolute left-1/2 -translate-x-1/2 bottom-[2px] w-4 h-[3px] rounded-full opacity-0 group-hover/rz:opacity-100 transition-opacity" style={{ background: color }} />
          </div>
        </>
      )}

      <div className="pointer-events-none">
        {!tiny && (
          <div className="text-[9.5px] leading-tight tabular-nums" style={{ color: `color-mix(in srgb, ${color} 70%, var(--text-primary))` }}>
            {fmtMin(start)}–{fmtMin(end)}
          </div>
        )}
        <div className={`font-semibold leading-snug text-[var(--text-primary)] ${tiny ? 'truncate' : ''} ${isDone ? 'line-through' : ''}`}
          style={{ fontSize: fz }}>
          {todo.title}
        </div>
        {!compact && (
          <div className="flex items-center gap-1 mt-0.5 text-[9.5px] text-[var(--text-muted)]">
            <span className={QUADRANT_TEXT_CLASS[todo.quadrant] ?? 'text-[var(--text-muted)]'}>
              <QuadrantIconGlyph icon={quadrantIcon} meta={q} size={11} />
            </span>
            {tag && <span className="truncate">{tag.name}</span>}
            {todo.taskType === 'deadline' && <span className="shrink-0 text-[var(--danger)]">· 截止</span>}
          </div>
        )}
      </div>

      {ghost && (
        <span className="absolute right-1 top-[3px] px-1 rounded-[3px] text-[9px] font-semibold leading-[13px]"
          style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color: `color-mix(in srgb, ${color} 80%, var(--text-primary))` }}>
          延后
        </span>
      )}
    </div>
  )
}

/* ===================== 范围弹层 ===================== */

function RangePop({ startHour, endHour, onChange, onClose }: {
  startHour: number
  endHour: number
  onChange: (kind: 'start' | 'end', h: number) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    // 延后一拍注册，避开打开这次点击本身
    const t = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => { window.clearTimeout(t); document.removeEventListener('mousedown', onDown) }
  }, [onClose])

  return (
    <div ref={ref}
      className="absolute right-0 top-full mt-1.5 z-50 w-[248px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-xl p-3">
      <div className="text-[10.5px] text-[var(--text-muted)] mb-2.5">时间轴显示范围</div>
      {(['start', 'end'] as const).map(kind => (
        <div key={kind} className="flex items-center gap-2 mb-2.5">
          <span className="w-[26px] shrink-0 text-[11px] text-[var(--text-secondary)]">{kind === 'start' ? '起始' : '终止'}</span>
          <div className="flex-1 grid grid-cols-6 gap-[3px]">
            {Array.from({ length: kind === 'start' ? 8 : 9 }, (_, i) => kind === 'start' ? i + 5 : i + 16).map(h => {
              const cur = kind === 'start' ? startHour : endHour
              const disabled = kind === 'start' ? endHour - h < MIN_RANGE_HOURS : h - startHour < MIN_RANGE_HOURS
              return (
                <button key={h} disabled={disabled}
                  onClick={() => onChange(kind, h)}
                  className={`h-5 rounded text-[10.5px] tabular-nums transition-colors ${h === cur ? 'bg-[var(--accent)] text-white font-semibold' : disabled ? 'opacity-30 cursor-not-allowed text-[var(--text-secondary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}>
                  {kind === 'start' ? String(h).padStart(2, '0') : h}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <div className="pt-2 border-t border-[var(--border-color)] text-[10px] text-[var(--text-disabled)] leading-relaxed">
        范围外的时段不占纵向空间；至少保留 {MIN_RANGE_HOURS} 小时。
      </div>
    </div>
  )
}
