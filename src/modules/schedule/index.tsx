import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Maximize2, Zap, ChevronDown, RotateCcw, Trash2, Check, CalendarDays, LayoutGrid } from 'lucide-react'
import type { ScheduleTodo, ScheduleTag, CreateScheduleTodoDTO, UpdateScheduleTodoDTO } from '../../types'
import { registerAssistantContext } from '../../lib/assistantContext'
import {
  getScheduleTodos, getScheduleDates, getScheduleMonthTodos, getScheduleDeadlineCounts,
  createScheduleTodo, updateScheduleTodo, deleteScheduleTodo, getScheduleTags, getScheduleSubtasks,
  getScheduleUnscheduledTodos, getScheduleWeekTodos,
  createScheduleTag, deleteScheduleTag, getSetting, setSetting
} from '../../lib/ipc'
import { CalendarView } from './views/CalendarView'
import type { ViewMode } from './types'
import { mondayOfWeek, dayFromMonday, toDateStr } from './timetable'
import { ViewSwitcher } from './components/ViewSwitcher'
import { TaskTray } from './components/TaskTray'
import { TimetableView } from './views/TimetableView'
import { TodoItem } from './components/TodoItem'
import { TodoEditModal } from './components/TodoEditModal'
import { ResizablePanel } from '../../components/shared/ResizablePanel'
import { Collapsible } from '../../components/shared/Collapsible'
import { PluginSlotEntry } from '../../components/shared/PluginSlotEntry'
import { isEditingInput } from '../../lib/shortcuts'
import { getGlobalActiveTab } from '../../lib/activeTab'
import { QuadrantChart } from './components/QuadrantChart'
import { TagManageModal } from './components/TagManageModal'
import { useDataChanged, notifyDataChanged } from '../../lib/dataChanged'
import { useSettings } from '../../lib/SettingsContext'
import { showToast } from '../../lib/toast'
import {
  orderedQuadrants, QUADRANT_TEXT_CLASS,
  type QuadrantIcon, type QuadrantOrder,
} from '../../lib/scheduleQuadrant'
import { celebrateAllDone, playDoneSound, type TaskFeedbackLevel } from './components/TodoItem'

/**
 * 视图切换的交叉淡化：旧内容先淡出（110ms），再换上新区内容淡入。
 * 两个区域（侧栏 / 主区）共用同一个 hook 实例的结果，保证同步。
 */
function useViewTransition(value: ViewMode, delay = 110) {
  const [shown, setShown] = useState(value)
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    if (value === shown) return
    setLeaving(true)
    const t = window.setTimeout(() => { setShown(value); setLeaving(false) }, delay)
    return () => window.clearTimeout(t)
  }, [value, shown, delay])
  return { shown, leaving }
}

/** 切换过程中的内容态样式（淡出时略带上移，制造「接力」感） */
function paneStyle(leaving: boolean): React.CSSProperties {
  return {
    opacity: leaving ? 0 : 1,
    transform: leaving ? 'translateY(-5px)' : 'none',
    transition: 'opacity 140ms ease, transform 200ms cubic-bezier(.4,0,.2,1)',
  }
}

const INPUT_SZ: Record<string, { icon: number; text: string; padY: string; placeholder: string; meta: string; metaIcon: number; sectionTitle: string }> = {
  sm: { icon: 14, text: 'text-[11px]', padY: 'py-1.5', placeholder: '零碎任务...', meta: 'text-[11px]', metaIcon: 10, sectionTitle: 'text-[12px]' },
  md: { icon: 17, text: 'text-[13px]', padY: 'py-2', placeholder: '快速添加当日零碎任务...', meta: 'text-[12px]', metaIcon: 12, sectionTitle: 'text-[13px]' },
  lg: { icon: 21, text: 'text-[15px]', padY: 'py-2.5', placeholder: '快速添加当日零碎任务...', meta: 'text-[13px]', metaIcon: 14, sectionTitle: 'text-[14px]' },
}

/** 快速添加胶囊（方案 E）：闪电住圆形 warning 底座 + 胶囊外壳，聚焦 accent 描边 + 光晕 */
const PILL_SZ: Record<string, { pad: string; base: string; icon: number; add: string }> = {
  sm: { pad: 'py-1 pl-1 pr-3', base: 'w-6 h-6', icon: 12, add: 'px-2.5 py-0.5 text-[11px]' },
  md: { pad: 'py-1.5 pl-1.5 pr-4', base: 'w-7 h-7', icon: 14, add: 'px-3 py-1 text-[12px]' },
  lg: { pad: 'py-2 pl-2 pr-5', base: 'w-8 h-8', icon: 16, add: 'px-3.5 py-1 text-[13px]' },
}

function localToday(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}

export function ScheduleModule({ isActive = true, sidebarOpen = true, sidebarWidths = {} as Record<string, number>, onSnapCloseSidebar, onSnapOpenSidebar, sidebarEl = null, sidebarHosted = false }: { isActive?: boolean; sidebarOpen?: boolean; sidebarWidths?: Record<string, number>; onSnapCloseSidebar?: () => void; onSnapOpenSidebar?: () => void; sidebarEl?: HTMLElement | null; sidebarHosted?: boolean }) {
  const now = new Date()
  const today = localToday()

  // 周偏移：左栏「周任务」清单与右侧网格共用，翻页时两侧同步（须先于 weekMon 计算声明）
  const [weekOffset, setWeekOffset] = useState(0)
  /** 左栏双态：待办任务（未排期）/ 周任务（本周，含已完成） */
  const [trayMode, setTrayMode] = useState<'unscheduled' | 'week'>('unscheduled')
  /** 周任务清单原始数据（关联标签在渲染层再做，避免 tags 变动时重拉取） */
  const [weekTasks, setWeekTasks] = useState<ScheduleTodo[]>([])

  // 本周（自然周，与网格 mondayOf 同源）起止：左栏「周任务」清单与网格共用 weekOffset 翻页
  const weekMon = useMemo(() => mondayOfWeek(today, weekOffset), [today, weekOffset])
  const weekStart = toDateStr(weekMon)
  const weekEnd = toDateStr(dayFromMonday(weekMon, 6))
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [selectedDate, setSelectedDate] = useState(today)
  const [dotDates, setDotDates] = useState<Set<string>>(new Set())
  const [deadlineCounts, setDeadlineCounts] = useState<Map<string, number>>(new Map())
  const [tags, setTags] = useState<ScheduleTag[]>([])

  // ---- 日程任务设置（设置 → 模块设置 → 日程任务）----
  const { s: appSettings } = useSettings()
  /** 完成反馈强度：light / medium / heavy */
  const feedbackLevel: TaskFeedbackLevel =
    appSettings.scheduleFeedbackLevel === 'light' || appSettings.scheduleFeedbackLevel === 'heavy'
      ? appSettings.scheduleFeedbackLevel
      : 'medium'
  const quadrantIcon = (appSettings.scheduleQuadrantIcon || 'bars') as QuadrantIcon
  const quadrantOrder = (appSettings.scheduleQuadrantOrder || 'ladder') as QuadrantOrder
  const quadrantText: 'show' | 'hide' = appSettings.scheduleQuadrantText === 'hide' ? 'hide' : 'show'
  /** 四象限视图的分组展示顺序（跟随排序设置） */
  const quadrantList = useMemo(() => orderedQuadrants(quadrantOrder), [quadrantOrder])

  const [viewMode, setViewMode] = useState<ViewMode>('week')
  /** 交叉淡化用：shown = 当前上屏的视图，leaving = 旧内容正在淡出 */
  const { shown: shownMode, leaving: viewLeaving } = useViewTransition(viewMode)
  const [monthTodos, setMonthTodos] = useState<ScheduleTodo[]>([])
  const [subtasksMap, setSubtasksMap] = useState<Record<string, ScheduleTodo[]>>({})
  /** 日程表「待安排」栏：全部未排期的顶层未完成任务（三类任务都可进） */
  const [unscheduled, setUnscheduled] = useState<ScheduleTodo[]>([])
  /** 递增信号：排期变化后通知 TimetableView 重取本周数据 */
  const [weekRefresh, setWeekRefresh] = useState(0)

  // AI 助手上下文：当前选中的日期及其待办
  useEffect(() => {
    return registerAssistantContext(() => {
      if (!selectedDate) return null
      const todos = monthTodos.filter(t => t.date === selectedDate)
      return {
        type: 'schedule.day',
        label: `日程 ${selectedDate}（${todos.length} 条待办）`,
        data: {
          date: selectedDate,
          todos: todos.slice(0, 30).map(t => ({ id: t.id, title: t.title, status: t.status, time: t.time ?? null })),
        },
      }
    })
  }, [selectedDate, monthTodos])

  const [modalOpen, setModalOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<ScheduleTodo | null>(null)
  const [quadrantOpen, setQuadrantOpen] = useState(false)
  const [tagManageOpen, setTagManageOpen] = useState(false)
  const [iconSize, setIconSize] = useState<'sm' | 'md' | 'lg'>('sm')
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false)
  const sizeMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    getSetting('scheduleIconSize').then(v => {
      if (v === 'sm' || v === 'md' || v === 'lg') setIconSize(v)
    })
    // 视图选择持久化：本次停在哪个视图，下次进来还停在那儿
    getSetting('scheduleViewMode').then(v => {
      if (v === 'week' || v === 'date' || v === 'deadline' || v === 'quadrant') setViewMode(v)
    })
  }, [])

  const setSize = (s: 'sm' | 'md' | 'lg') => {
    setIconSize(s)
    setSetting('scheduleIconSize', s)
    setSizeMenuOpen(false)
  }

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (sizeMenuRef.current && !sizeMenuRef.current.contains(e.target as Node)) setSizeMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const iconSizeLabel = iconSize === 'sm' ? '小' : iconSize === 'md' ? '中' : '大'

  const ym = `${year}-${String(month).padStart(2, '0')}`

  // ---- data loading ----
  async function refreshDotDates() {
    try {
      const dates = await getScheduleDates(ym)
      setDotDates(new Set(dates))
      const counts = await getScheduleDeadlineCounts(ym)
      setDeadlineCounts(new Map(Object.entries(counts)))
    } catch (e) { console.error(e) }
  }

  async function refreshMonthTodos() {
    try {
      const todos = await getScheduleMonthTodos(ym)
      setMonthTodos(todos)
      // Load subtasks for plan & deadline tasks (daily has no subtasks)
      const tasksWithSubs = todos.filter(t => t.taskType !== 'daily')
      if (tasksWithSubs.length > 0) {
        const map: Record<string, ScheduleTodo[]> = {}
        await Promise.all(tasksWithSubs.map(async t => {
          map[t.id] = await getScheduleSubtasks(t.id)
        }))
        setSubtasksMap(map)
      } else {
        setSubtasksMap({})
      }
    } catch (e) { console.error(e) }
  }

  async function refreshUnscheduled() {
    try {
      setUnscheduled(await getScheduleUnscheduledTodos())
    } catch (e) { console.error(e) }
  }

  /** 左栏「周任务」清单：本周（自然周）全部任务，含已完成。复用 vaultTodosForWeek（已按周取数） */
  // 必须是稳定引用：下方 `useEffect(..., [trayMode, weekStart, weekEnd, refreshWeekTasks])` 把它列进依赖，
  // 而它内部又 setWeekTasks（filter 出来的新数组 = 新引用）触发重渲染 —— 引用一旦不稳定，
  // 这条 effect 就每次渲染都跑一轮 IPC，形成「拉取 → 重渲染 → 再拉取」的空转；
  // 在「本周」档位下会一直转，顺带不断重渲染本模块，把弹窗里正在输入的内容冲掉。
  const refreshWeekTasks = useCallback(async () => {
    try {
      const list = await getScheduleWeekTodos(weekStart, weekEnd)
      // 只留自然周区间内的任务（排除「延后候选」），含已完成
      setWeekTasks(list.filter(t => t.date >= weekStart && t.date <= weekEnd))
    } catch (e) { console.error(e) }
  }, [weekStart, weekEnd])

  async function refreshAll() { await Promise.all([refreshDotDates(), refreshMonthTodos(), refreshUnscheduled()]) }

  const loadTags = useCallback(async () => {
    try {
      // 只读取用户实际的标签列表。周任务/月任务由周/月总结面板按需创建（SummaryPanel），
      // 不在这里兜底重建 —— 否则用户删除后又会自动回来，表现为「默认标签无法取消」。
      setTags(await getScheduleTags())
    } catch (e) { console.error(e) }
  }, [])

  useEffect(() => { refreshAll() }, [ym])
  useEffect(() => { loadTags() }, [loadTags])

  // 监听数据导入事件 — 导入完成后刷新日程数据
  const refreshAllRef = useRef(refreshAll)
  const loadTagsRef = useRef(loadTags)
  useEffect(() => { refreshAllRef.current = refreshAll }, [refreshAll])
  useEffect(() => { loadTagsRef.current = loadTags }, [loadTags])
  useEffect(() => {
    const handler = () => { refreshAllRef.current(); loadTagsRef.current() }
    window.addEventListener('data-imported', handler)
    return () => window.removeEventListener('data-imported', handler)
  }, [])

  // 监听跨窗口数据变更 — 日程打卡小窗内的增删改/勾选实时同步到本模块
  const trayModeRef = useRef(trayMode)
  useEffect(() => { trayModeRef.current = trayMode }, [trayMode])
  const refreshWeekRef = useRef(refreshWeekTasks)
  useEffect(() => { refreshWeekRef.current = refreshWeekTasks }, [refreshWeekTasks])
  useDataChanged('schedule', () => { refreshAllRef.current(); loadTagsRef.current(); if (trayModeRef.current === 'week') void refreshWeekRef.current() })

  // 周任务清单跟随 trayMode / weekOffset（翻页看历史周）拉取
  useEffect(() => { if (trayMode === 'week') void refreshWeekTasks() }, [trayMode, weekStart, weekEnd, refreshWeekTasks])

  // 激活重读（2026-09-10）：本模块保活（切 Tab 不卸载），而主进程侧的写操作（AI 工具等）
  // 即便已有广播兜底，切回时也主动重取一次，确保界面与磁盘一致。
  // 首次挂载不重取（交给上面 [ym] 的 effect），避免重复请求。
  const activatedOnce = useRef(false)
  useEffect(() => {
    if (!isActive) return
    if (!activatedOnce.current) { activatedOnce.current = true; return }
    refreshAllRef.current()
    loadTagsRef.current()
  }, [isActive])

  // ---- calendar navigation ----
  function goToPrevMonth() {
    if (month === 1) { setYear(y => y - 1); setMonth(12) } else setMonth(m => m - 1)
  }
  function goToNextMonth() {
    if (month === 12) { setYear(y => y + 1); setMonth(1) } else setMonth(m => m + 1)
  }
  function goToToday() {
    const n = new Date()
    setYear(n.getFullYear()); setMonth(n.getMonth() + 1); setSelectedDate(today)
  }

  function handleViewModeChange(mode: ViewMode) {
    setViewMode(mode)
    setSetting('scheduleViewMode', mode)
  }

  async function openQuadrantChart() { await refreshMonthTodos(); setQuadrantOpen(true) }

  // ---- tag management ----
  async function handleCreateTag(name: string, color: string): Promise<ScheduleTag> {
    const tag = await createScheduleTag(name, color); await loadTags(); return tag
  }
  async function handleDeleteTag(id: string) { await deleteScheduleTag(id); await loadTags() }

  // ---- CRUD ----
  /** 新建任务时预填的排期时段（日程表空白拖框创建时带上） */
  const [pendingSlot, setPendingSlot] = useState<{ date: string; start: number; end: number } | null>(null)

  function openEdit(todo: ScheduleTodo) { setPendingSlot(null); setEditTarget(todo); setModalOpen(true) }
  /** 打开「新建任务」：slot 非空时预填日期与排期时段（拖框创建的路径） */
  function openCreate(slot: { date: string; start: number; end: number } | null = null) {
    setEditTarget(null); setPendingSlot(slot); setModalOpen(true)
  }

  async function handleSave(form: { title: string; description: string; time: string; quadrant: number; taskType: 'deadline' | 'plan' | 'daily'; tagId: string; endCriteria: string }) {
    // 排期时段不在这里编辑（由日程表拖拽产生），保存时原样带回：
    // 编辑 = 沿用目标任务的时段；新建 = 用拖框产生的预填时段（普通新建则为空）
    const slotStart = editTarget ? editTarget.scheduledStart : (pendingSlot?.start ?? null)
    const slotEnd = editTarget ? editTarget.scheduledEnd : (pendingSlot?.end ?? null)
    const dto: CreateScheduleTodoDTO = {
      title: form.title, description: form.description,
      date: editTarget ? editTarget.date : (pendingSlot?.date ?? today),
      time: form.taskType === 'deadline' ? form.time : undefined,
      quadrant: form.quadrant, taskType: form.taskType,
      tagId: form.tagId || undefined,
      endCriteria: form.taskType === 'plan' ? form.endCriteria : undefined,
      scheduledStart: slotStart, scheduledEnd: slotEnd
    }
    try {
      if (editTarget) {
        await updateScheduleTodo(editTarget.id, {
          title: form.title, description: form.description,
          time: form.taskType === 'deadline' ? form.time : null,
          quadrant: form.quadrant, taskType: form.taskType,
          tagId: form.tagId || null,
          endCriteria: form.taskType === 'plan' ? form.endCriteria : ''
        })
      } else { await createScheduleTodo(dto) }
      setModalOpen(false); setEditTarget(null); setPendingSlot(null)
      notifyDataChanged('schedule')
      await refreshAll()
      setWeekRefresh(v => v + 1)
    } catch (e) { console.error(e) }
  }

  /**
   * 任务状态变更 —— 乐观更新。
   * TodoItem 已在完成动效播完后才回调（见其 SETTLE_MS），所以这里立即改本地状态上屏、
   * 落盘放后台跑、失败回滚；不再是「await IPC 再 refreshAll」那种点完等一拍的手感。
   */
  async function applyTodoStatus(id: string, next: 'done' | 'pending', prev: 'done' | 'pending') {
    setMonthTodos(prevList => prevList.map(t => (t.id === id ? { ...t, status: next } : t)))
    try {
      await updateScheduleTodo(id, { status: next })
      notifyDataChanged('schedule')
      // 完成/恢复会改变「待安排」栏与「延后幽灵」的构成，通知日程表重取
      setWeekRefresh(v => v + 1)
      void refreshUnscheduled()
    } catch (e) {
      setMonthTodos(prevList => prevList.map(t => (t.id === id ? { ...t, status: prev } : t)))
      showToast({ type: 'error', message: '任务状态更新失败' })
      console.error(e)
    }
  }

  async function handleToggleDone(todo: ScheduleTodo) {
    const next: 'done' | 'pending' = todo.status === 'done' ? 'pending' : 'done'
    // heavy 档：这是最后一条待办时，放一次全清庆祝（上行三音 + 彩纸）
    if (next === 'done' && feedbackLevel === 'heavy') {
      const rest = monthTodos.filter(t =>
        t.status === 'pending' && t.id !== todo.id && (t.taskType === 'daily' ? t.date === todo.date : true))
      if (rest.length === 0) { playDoneSound(true); celebrateAllDone() }
    }
    await applyTodoStatus(todo.id, next, todo.status as 'done' | 'pending')
  }

  async function handleRestoreDone(id: string) {
    const prev = (monthTodos.find(t => t.id === id)?.status ?? 'done') as 'done' | 'pending'
    await applyTodoStatus(id, 'pending', prev)
  }

  const [showDone, setShowDone] = useState(false)

  /**
   * 删除任务（级联删子任务、无回收站）。
   * 删除前先数一次子任务 —— 级联是静默的，一条「已删除（含 n 条子任务）」
   * 是用户唯一能察觉「连带删了子任务」的反馈。
   */
  async function handleDelete(id: string) {
    let subCount = 0
    try { subCount = (await getScheduleSubtasks(id)).length } catch { /* 计数失败不阻断删除 */ }
    await deleteScheduleTodo(id)
    notifyDataChanged('schedule')
    await refreshAll()
    setWeekRefresh(v => v + 1)
    showToast({ type: 'info', message: subCount > 0 ? `已删除（含 ${subCount} 条子任务）` : '已删除' })
  }

  /** 日程表：卡片拖回「待安排」栏 = 取消排期（清空时段、保留日期） */
  async function handleUnschedule(id: string) {
    try {
      await updateScheduleTodo(id, { scheduledStart: null, scheduledEnd: null })
      notifyDataChanged('schedule')
      await refreshAll()
      setWeekRefresh(v => v + 1)
    } catch (e) {
      showToast({ type: 'error', message: '取消排期失败' })
      console.error(e)
    }
  }

  /** 日程表：排期 / 改时长落盘成功后，刷新侧栏与月历并广播给其他窗口 */
  function handleScheduleChanged() {
    notifyDataChanged('schedule')
    void refreshAll()
  }

  async function handleClearDone() {
    if (doneTodos.length === 0) return
    await Promise.all(doneTodos.map(t => deleteScheduleTodo(t.id)))
    await refreshAll()
  }

  // ---- 当日任务 ----
  const [dailyInput, setDailyInput] = useState('')

  async function handleAddDaily() {
    if (!dailyInput.trim()) return
    try {
      await createScheduleTodo({ title: dailyInput.trim(), date: today, taskType: 'daily' })
      setDailyInput('')
      await refreshAll()
    } catch (e) { console.error(e) }
  }

  async function handleToggleSubtaskAny(id: string) {
    // Find subtask in subtasksMap
    for (const subs of Object.values(subtasksMap)) {
      const st = subs.find(s => s.id === id)
      if (st) {
        await updateScheduleTodo(id, { status: st.status === 'done' ? 'pending' : 'done' })
        notifyDataChanged('schedule')
        await refreshAll()
        return
      }
    }
  }

  async function handleDeleteSubtaskAny(id: string) {
    await deleteScheduleTodo(id)
    notifyDataChanged('schedule')
    await refreshAll()
  }

  async function handleMigrateDaily(id: string) { await updateScheduleTodo(id, { date: today }); notifyDataChanged('schedule'); await refreshAll() }

  // ---- derived data (ALL tasks, including done) ----
  const allWithTags = useMemo(() =>
    monthTodos.map(t => ({
      ...t,
      tag: t.tagId ? tags.find(tg => tg.id === t.tagId) ?? null : null,
      subtasks: subtasksMap[t.id] || undefined,
    })),
    [monthTodos, tags, subtasksMap]
  )

  const pendingTodos = useMemo(() => allWithTags.filter(t => t.status === 'pending'), [allWithTags])
  const doneTodos = useMemo(() => allWithTags.filter(t => t.status === 'done'), [allWithTags])

  // 已完成按日期分组
  const doneByDate = useMemo(() => {
    const groups: Record<string, typeof doneTodos> = {}
    for (const t of doneTodos) (groups[t.date] ??= []).push(t)
    return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a))
  }, [doneTodos])

  /** 待安排列表（关联标签，供侧栏渲染色条与标签名） */
  const unscheduledWithTag = useMemo(() =>
    unscheduled.map(t => ({
      ...t,
      tag: t.tagId ? tags.find(tg => tg.id === t.tagId) ?? null : null,
    })),
    [unscheduled, tags])

  /** 周任务清单（关联标签；含已完成，删除线由 TaskTray 渲染） */
  const weekTasksWithTag = useMemo(() =>
    weekTasks.map(t => ({
      ...t,
      tag: t.tagId ? tags.find(tg => tg.id === t.tagId) ?? null : null,
    })),
    [weekTasks, tags])

  // Today's date string
  const todayDateStr = localToday()

  // 当日任务
  const dailyTasks = useMemo(() => pendingTodos.filter(t => t.taskType === 'daily'), [pendingTodos])
  const dailyToday = useMemo(() => dailyTasks.filter(t => t.date === todayDateStr), [dailyTasks, todayDateStr])
  const dailyExpired = useMemo(() => dailyTasks.filter(t => t.date < todayDateStr), [dailyTasks, todayDateStr])

  // deadline mode: split pending deadline tasks into overdue vs upcoming
  const deadlineUpcoming = useMemo(() =>
    pendingTodos
      .filter(t => t.taskType === 'deadline' && t.time)
      .filter(t => (t.time || '').slice(0, 10) >= todayDateStr)
      .sort((a, b) => (a.time || '').localeCompare(b.time || '')),
    [pendingTodos, todayDateStr]
  )

  const deadlineOverdue = useMemo(() =>
    pendingTodos
      .filter(t => t.taskType === 'deadline' && t.time)
      .filter(t => (t.time || '').slice(0, 10) < todayDateStr)
      .sort((a, b) => (a.time || '').localeCompare(b.time || '')),
    [pendingTodos, todayDateStr]
  )

  // deadline mode: done deadline tasks
  const deadlineDone = useMemo(() =>
    doneTodos
      .filter(t => t.taskType === 'deadline' && t.time)
      .sort((a, b) => (a.time || '').localeCompare(b.time || '')),
    [doneTodos]
  )

  // quadrant mode: pending only, grouped — exclude daily (琐碎不参与四象限)
  const quadrantGrouped = useMemo(() => {
    const groups: Record<number, typeof pendingTodos> = { 0: [], 1: [], 2: [], 3: [] }
    for (const t of pendingTodos) {
      if (t.taskType === 'daily') continue
      groups[t.quadrant].push(t)
    }
    return groups
  }, [pendingTodos])

  // date mode: pending tasks visible on selected date
  // - daily: only on its own date
  // - deadline: creation date + every day from today to deadline
  // - plan: 无截止日期、不逾期 —— 未完成则任何日期都常驻显示（跨月由 getMonthTodos 兜底）
  const dateTodos = useMemo(() =>
    pendingTodos.filter(t => {
      if (t.date === selectedDate) return true
      if (t.taskType === 'daily') return false
      if (t.taskType === 'plan') return true
      // deadline
      if (selectedDate < todayDateStr) return false
      const deadlineDate = (t.time || '').slice(0, 10)
      return !!deadlineDate && selectedDate <= deadlineDate
    }),
    [pendingTodos, selectedDate, todayDateStr]
  )
  const dateRegular = useMemo(() => dateTodos.filter(t => t.taskType !== 'daily'), [dateTodos])
  const dateDaily = useMemo(() => dateTodos.filter(t => t.taskType === 'daily'), [dateTodos])

  const editSubtasks = editTarget ? (subtasksMap[editTarget.id] || []) : []

  // ---- helpers ----
  const modalInitial = editTarget
    ? { title: editTarget.title, description: editTarget.description,
        time: editTarget.time || '', quadrant: editTarget.quadrant,
        taskType: editTarget.taskType, tagId: editTarget.tagId || '',
        endCriteria: editTarget.endCriteria || '' }
    : { title: '', description: '', time: '', quadrant: 1, taskType: 'plan' as const, tagId: '', endCriteria: '' }

  // ---- subtask handlers ----
  async function handleToggleSubtask(id: string) {
    const st = editSubtasks.find(s => s.id === id)
    if (!st) return
    await updateScheduleTodo(id, { status: st.status === 'done' ? 'pending' : 'done' })
    notifyDataChanged('schedule')
    await refreshAll()
  }

  async function handleDeleteSubtask(id: string) {
    await deleteScheduleTodo(id)
    notifyDataChanged('schedule')
    await refreshAll()
  }

  async function handleCreateSubtask(data: { title: string; date: string; taskType: 'daily' }) {
    if (!editTarget) return
    const dto: CreateScheduleTodoDTO = {
      title: data.title, date: data.date, taskType: 'daily',
      parentId: editTarget.id,
    }
    await createScheduleTodo(dto)
    notifyDataChanged('schedule')
    await refreshAll()
  }

  const viewTitle =
    viewMode === 'deadline' ? '截至时间线' :
    viewMode === 'quadrant' ? '四象限排列' :
    `${selectedDate === today ? `${selectedDate} 今天` : selectedDate}`

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (getGlobalActiveTab() !== 'schedule') return
      if (isEditingInput(e)) return
      // Ctrl+N — open new task modal
      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault()
        openCreate()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-full flex-col bg-[var(--bg-primary)]">
      {/* 顶部贯通行：视图切换条 + 视图专属操作 */}
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-2 py-1 shrink-0 select-none">
        <CalendarDays size={12} className="text-[var(--text-muted)]" />
        <ViewSwitcher value={viewMode} onChange={handleViewModeChange} />
        {viewMode !== 'week' && (
          <span className="text-[11.5px] font-medium text-[var(--text-muted)] truncate">{viewTitle}</span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {viewMode === 'quadrant' && (
            <button onClick={openQuadrantChart} title="打开象限图"
              className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
              <LayoutGrid size={13} />
            </button>
          )}
          <div className="relative" ref={sizeMenuRef}>
            <button onClick={() => setSizeMenuOpen(v => !v)}
              className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
              title={`卡片大小（当前：${iconSizeLabel}）`}>
              <Maximize2 size={13} />
            </button>
            {sizeMenuOpen && (
              <div className="absolute right-0 top-full mt-1 w-24 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded shadow-xl py-1 z-50" onClick={e => e.stopPropagation()}>
                {(['sm', 'md', 'lg'] as const).map(s => (
                  <button key={s} onClick={() => setSize(s)}
                    className={`w-full text-left px-2 py-1 text-[11.5px] hover:bg-[var(--bg-hover)] ${iconSize === s ? 'text-[var(--text-primary)] bg-[var(--bg-selected)]' : 'text-[var(--text-secondary)]'}`}>
                    {s === 'sm' ? '小' : s === 'md' ? '中' : '大'}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button onClick={() => setTagManageOpen(true)}
            className="px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
            管理标签
          </button>
          <button onClick={() => openCreate()}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors">
            <Plus size={12} /> 添加
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
      {/* v3.4.0 批次3：左栏模块态（sidebarEl）时侧栏内容 portal 进左栏 slot（挂载点迁移），
          否则回落原位 ResizablePanel；portal 传 null ⇔ visible=false 不渲染 children，显隐一致 */}
      {(() => {
        const sidebarInner = (
        <div className="h-full flex flex-col" style={paneStyle(viewLeaving)}>
          {/* 头部：与编辑器「资源管理器」同款紧凑标题行 */}
          <div className="flex items-center gap-1 border-b border-[var(--border-color)] px-2 py-1 text-[11.5px] text-[var(--text-muted)] shrink-0 select-none">
            {shownMode === 'week' ? (
              <>
                <CalendarDays size={12} className="shrink-0" />
                <div className="flex items-center rounded-md bg-[var(--bg-secondary)] p-0.5 text-[10.5px]">
                  <button
                    onClick={() => setTrayMode('unscheduled')}
                    className={`rounded px-1.5 py-0.5 transition-colors ${trayMode === 'unscheduled' ? 'bg-[var(--bg-primary)] font-semibold text-[var(--accent)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                  >待办任务</button>
                  <button
                    onClick={() => setTrayMode('week')}
                    className={`rounded px-1.5 py-0.5 transition-colors ${trayMode === 'week' ? 'bg-[var(--bg-primary)] font-semibold text-[var(--accent)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                  >周任务</button>
                </div>
                <span className="ml-auto rounded-full bg-[var(--bg-tertiary)] px-1.5 leading-[15px] text-[10.5px] font-semibold text-[var(--text-secondary)]">
                  {trayMode === 'week' ? weekTasks.length : unscheduled.length}
                </span>
              </>
            ) : (
              <>
                <CalendarDays size={12} />
                <span>日程</span>
              </>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            {shownMode === 'week' ? (
              <TaskTray
                todos={trayMode === 'week' ? weekTasksWithTag : unscheduledWithTag}
                iconSize={iconSize}
                quadrantIcon={quadrantIcon}
                quadrantText={quadrantText}
                onOpen={openEdit}
                onDelete={todo => { void handleDelete(todo.id) }}
                emptyHint={trayMode === 'week' ? <>本周暂无任务<br />在右侧网格排期或勾选完成</> : undefined}
              />
            ) : (
              <div className="h-full overflow-y-auto">
                <CalendarView
                  year={year} month={month} selectedDate={selectedDate}
                  dotDates={dotDates} deadlineCounts={deadlineCounts}
                  onSelectDate={setSelectedDate}
                  onPrevMonth={goToPrevMonth} onNextMonth={goToNextMonth}
                  onToday={goToToday}
                />
              </div>
            )}
          </div>
          <PluginSlotEntry slot="schedule.sidebar" />
        </div>
        )
        return sidebarEl
          ? createPortal(sidebarOpen ? sidebarInner : null, sidebarEl)
          : sidebarHosted
            ? null // Workbench 托管但槽未就绪（左栏收起/翻转瞬间）：渲染 null 等槽重挂后 portal，绝不回落内嵌列（同 editor 口径）
            : (
              <ResizablePanel storageKey="sidebarWidth_schedule" defaultWidth={280} minWidth={220} maxWidth={450} visible={sidebarOpen} initialWidth={sidebarWidths.sidebarWidth_schedule} onSnapClose={onSnapCloseSidebar} onSnapOpen={onSnapOpenSidebar}>
                {sidebarInner}
              </ResizablePanel>
            )
      })()}

      <div className="flex-1 flex flex-col overflow-hidden">
        {shownMode === 'week' ? (
          /* ===== 日程表（周视图）===== */
          <div className="flex-1 min-h-0 flex flex-col" style={paneStyle(viewLeaving)}>
            <TimetableView
              isActive={isActive}
              tags={tags}
              iconSize={iconSize}
              quadrantIcon={quadrantIcon}
              quadrantText={quadrantText}
              refreshSignal={weekRefresh}
              weekOffset={weekOffset}
              setWeekOffset={setWeekOffset}
              onOpenTodo={openEdit}
              onToggleDone={handleToggleDone}
              onRequestCreate={(dateStr, start, end) => openCreate({ date: dateStr, start, end })}
              onUnschedule={handleUnschedule}
              onDeleteTodo={todo => { void handleDelete(todo.id) }}
              onChanged={handleScheduleChanged}
            />
          </div>
        ) : (
        <div className="flex-1 min-h-0 flex flex-col" style={paneStyle(viewLeaving)}>
        {/* 当日任务快速添加条（方案 E 胶囊：无框灰底 + 圆形 warning 底座；仅按日期视图提供——零碎任务当天创建当天完成） */}
        {viewMode === 'date' && (
        <div className="px-6 pt-4 pb-1 shrink-0">
          <div
            className={`flex items-center gap-2.5 rounded-full bg-[var(--bg-secondary)] ${PILL_SZ[iconSize].pad}`}
          >
            <span className={`flex items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)] shrink-0 ${PILL_SZ[iconSize].base}`}>
              <Zap size={PILL_SZ[iconSize].icon} />
            </span>
            <input
              value={dailyInput}
              onChange={e => setDailyInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAddDaily() }}
              placeholder={INPUT_SZ[iconSize].placeholder}
              className={`flex-1 min-w-0 bg-transparent ${INPUT_SZ[iconSize].text} text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]`}
            />
            {dailyInput && (
              <button onClick={handleAddDaily} className={`shrink-0 rounded-full bg-[var(--warning)] text-[var(--bg-primary)] font-medium ${PILL_SZ[iconSize].add}`}>
                添加
              </button>
            )}
          </div>
        </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {/* ===== EXPIRED DAILY TASKS ===== */}
          {dailyExpired.length > 0 && (selectedDate === today || viewMode !== 'date') && (
            <div className="mb-4 p-3 bg-[var(--warning-bg)] border border-[var(--border-color)] rounded">
              <p className={`${INPUT_SZ[iconSize].meta} text-[var(--warning)] mb-2`}>📌 {dailyExpired.length} 项过期当日任务</p>
              <div className="space-y-1.5 max-h-[120px] overflow-y-auto">
                {dailyExpired.map(t => (
                  <div key={t.id} className={`flex items-center gap-2 ${INPUT_SZ[iconSize].meta} text-[var(--text-secondary)]`}>
                    <span className="flex-1 truncate line-through">{t.title}</span>
                    <span className={`${INPUT_SZ[iconSize].meta} text-[var(--text-disabled)]`}>{t.date.slice(5)}</span>
                    <button onClick={() => handleMigrateDaily(t.id)}
                      className={`px-1.5 py-0.5 ${INPUT_SZ[iconSize].meta} text-[var(--accent)] hover:bg-[var(--accent)]/10 rounded flex items-center gap-0.5`}>
                      <RotateCcw size={INPUT_SZ[iconSize].metaIcon} /> 迁移
                    </button>
                    <button onClick={() => handleDelete(t.id)}
                      className={`px-1.5 py-0.5 ${INPUT_SZ[iconSize].meta} text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--danger)]/10 rounded flex items-center gap-0.5`}>
                      <Trash2 size={INPUT_SZ[iconSize].metaIcon} /> 丢弃
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ===== DATE MODE ===== */}
          {viewMode === 'date' && (
            (dateRegular.length === 0 && dateDaily.length === 0) ? <EmptyHint /> : (
              <div className="space-y-4">
                {dateDaily.length > 0 && (
                  <div>
                    <h4 className={`${INPUT_SZ[iconSize].meta} font-medium text-[var(--warning)] mb-2 flex items-center gap-1.5`}>
                      <Zap size={INPUT_SZ[iconSize].metaIcon + 3} /> {selectedDate === today ? '今日零碎任务' : '当日任务'} · {dateDaily.length}
                    </h4>
                    <div className="space-y-1.5">
                      {dateDaily.map(todo => (
                        <TodoItem key={todo.id} todo={todo} tag={todo.tag} iconSize={iconSize} feedbackLevel={feedbackLevel} quadrantIcon={quadrantIcon} quadrantText={quadrantText}
                          onClick={() => openEdit(todo)} onToggleDone={() => handleToggleDone(todo)} onDelete={() => handleDelete(todo.id)} onToggleSubtask={handleToggleSubtaskAny} onDeleteSubtask={handleDeleteSubtaskAny} />
                      ))}
                    </div>
                  </div>
                )}
                {dateRegular.length > 0 && (
                  <div>
                    {dateDaily.length > 0 && <h4 className={`${INPUT_SZ[iconSize].meta} font-medium text-[var(--accent)] mb-2`}>📋 正式任务 · {dateRegular.length}</h4>}
                    <div className="space-y-2">
                      {dateRegular.map(todo => (
                        <TodoItem key={todo.id} todo={todo} tag={todo.tag} iconSize={iconSize} feedbackLevel={feedbackLevel} quadrantIcon={quadrantIcon} quadrantText={quadrantText}
                          onClick={() => openEdit(todo)} onToggleDone={() => handleToggleDone(todo)} onDelete={() => handleDelete(todo.id)} onToggleSubtask={handleToggleSubtaskAny} onDeleteSubtask={handleDeleteSubtaskAny} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          )}

          {/* ===== DEADLINE MODE ===== */}
          {viewMode === 'deadline' && (deadlineOverdue.length === 0 && deadlineUpcoming.length === 0 && deadlineDone.length === 0 ? (
            <EmptyHint text="本月无截止类任务" />
          ) : (
            <div className="space-y-4">
              {deadlineOverdue.length > 0 && (
                <div>
                  <h4 className={`${INPUT_SZ[iconSize].meta} font-medium text-[var(--danger)] mb-2`}>⚠ 超期未完成 ({deadlineOverdue.length})</h4>
                  <div className="space-y-2">
                    {deadlineOverdue.map(todo => (
                      <TodoItem key={todo.id} todo={todo} tag={todo.tag} iconSize={iconSize} feedbackLevel={feedbackLevel} quadrantIcon={quadrantIcon} quadrantText={quadrantText} showRemaining
                        onClick={() => openEdit(todo)} onToggleDone={() => handleToggleDone(todo)} onDelete={() => handleDelete(todo.id)} onToggleSubtask={handleToggleSubtaskAny} onDeleteSubtask={handleDeleteSubtaskAny} />
                    ))}
                  </div>
                </div>
              )}

              {/* 即将截止 */}
              {deadlineUpcoming.length > 0 && (
                <div>
                  <h4 className={`${INPUT_SZ[iconSize].meta} font-medium text-[var(--accent)] mb-2`}>⏰ 即将截止 ({deadlineUpcoming.length})</h4>
                  <div className="space-y-2">
                    {deadlineUpcoming.map(todo => (
                      <TodoItem key={todo.id} todo={todo} tag={todo.tag} iconSize={iconSize} feedbackLevel={feedbackLevel} quadrantIcon={quadrantIcon} quadrantText={quadrantText} showRemaining
                        onClick={() => openEdit(todo)} onToggleDone={() => handleToggleDone(todo)} onDelete={() => handleDelete(todo.id)} onToggleSubtask={handleToggleSubtaskAny} onDeleteSubtask={handleDeleteSubtaskAny} />
                    ))}
                  </div>
                </div>
              )}

              {/* 已完成 */}
              {deadlineDone.length > 0 && (
                <div>
                  <h4 className={`${INPUT_SZ[iconSize].meta} font-medium text-[var(--text-muted)] mb-2`}>✅ 已完成 ({deadlineDone.length})</h4>
                  <div className="space-y-2">
                    {deadlineDone.map(todo => (
                      <TodoItem key={todo.id} todo={todo} tag={todo.tag} iconSize={iconSize} feedbackLevel={feedbackLevel} quadrantIcon={quadrantIcon} quadrantText={quadrantText} showRemaining
                        onClick={() => openEdit(todo)} onToggleDone={() => handleToggleDone(todo)} onDelete={() => handleDelete(todo.id)} onToggleSubtask={handleToggleSubtaskAny} onDeleteSubtask={handleDeleteSubtaskAny} />
                    ))}
                  </div>
                </div>
              )}

            </div>
          ))}

          {/* ===== QUADRANT MODE ===== */}
          {viewMode === 'quadrant' && (
            <div className="space-y-4">
              {quadrantList.map(q => {
                const items = quadrantGrouped[q.value]
                return (
                  <div key={q.value}>
                    <h4 className={`${INPUT_SZ[iconSize].meta} font-medium ${QUADRANT_TEXT_CLASS[q.value]} mb-2`}>{q.label} ({items.length})</h4>
                    {items.length === 0 ? <p className={`${INPUT_SZ[iconSize].meta} text-[var(--text-disabled)] italic ml-1`}>暂无</p> : (
                      <div className="space-y-2">
                        {items.map(todo => (
                          <TodoItem key={todo.id} todo={todo} tag={todo.tag} iconSize={iconSize} feedbackLevel={feedbackLevel} quadrantIcon={quadrantIcon} quadrantText={quadrantText}
                            onClick={() => openEdit(todo)} onToggleDone={() => handleToggleDone(todo)} onDelete={() => handleDelete(todo.id)} onToggleSubtask={handleToggleSubtaskAny} onDeleteSubtask={handleDeleteSubtaskAny} />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* ===== COMPLETED TASKS ===== */}
        {doneTodos.length > 0 && (
          <div className="border-t border-[var(--border-color)] shrink-0">
            {/* 行容器改用 div：内部含「全部清除」按钮，按钮不能嵌套按钮（否则 React 报 validateDOMNesting） */}
            <div className={`flex items-center justify-between w-full px-6 py-2.5 ${INPUT_SZ[iconSize].meta} text-[var(--text-muted)] hover:bg-[var(--bg-hover)] transition-colors`}>
              <button
                onClick={() => setShowDone(v => !v)}
                className="flex items-center gap-2 flex-1 text-left"
                aria-expanded={showDone}
              >
                <Check size={INPUT_SZ[iconSize].metaIcon + 4} />
                已完成 · {doneTodos.length} 项
              </button>
              <span className="flex items-center gap-2">
                <button
                  onClick={handleClearDone}
                  className={`px-2 py-1 ${INPUT_SZ[iconSize].meta} text-[var(--danger)] hover:bg-[var(--danger)]/10 rounded transition-colors`}
                  title="已完成任务 7 天后自动清空"
                >
                  <Trash2 size={INPUT_SZ[iconSize].metaIcon + 4} className="inline mr-0.5" />全部清除
                </button>
                <button
                  onClick={() => setShowDone(v => !v)}
                  className="p-1 rounded hover:bg-[var(--bg-tertiary)] transition-colors"
                  title={showDone ? '收起已完成' : '展开已完成'}
                >
                  <ChevronDown size={INPUT_SZ[iconSize].metaIcon + 4} className={`kb-chevron ${showDone ? 'rotate-180' : ''}`} />
                </button>
              </span>
            </div>
            {/* 已完成折叠（docs/ui-animation-plan.md C 类） */}
            <Collapsible open={showDone} innerClassName="">{() => (
              <div className="px-6 py-3 max-h-[260px] overflow-y-auto space-y-3">
                {doneByDate.map(([date, items]) => (
                  <div key={date}>
                    <h4 className={`${INPUT_SZ[iconSize].meta} font-medium text-[var(--text-disabled)] mb-1.5`}>{date} · {items.length} 项</h4>
                    <div className="space-y-1.5">
                      {items.map(todo => (
                        <TodoItem key={todo.id} todo={todo} tag={todo.tag} iconSize={iconSize} feedbackLevel={feedbackLevel} quadrantIcon={quadrantIcon} quadrantText={quadrantText}
                          onClick={() => openEdit(todo)}
                          onToggleDone={() => handleToggleDone(todo)}
                          onRestore={() => handleRestoreDone(todo.id)}
                          onDelete={() => handleDelete(todo.id)} onToggleSubtask={handleToggleSubtaskAny} onDeleteSubtask={handleDeleteSubtaskAny} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}</Collapsible>
          </div>
        )}
        </div>
        )}
      </div>
      </div>

      <TodoEditModal
        open={modalOpen} initial={modalInitial} tags={tags} onSave={handleSave}
        onClose={() => { setModalOpen(false); setEditTarget(null) }}
        onDelete={editTarget ? () => { void handleDelete(editTarget.id) } : undefined}
        subtasks={editSubtasks}
        onToggleSubtask={handleToggleSubtask}
        onDeleteSubtask={handleDeleteSubtask}
        onCreateSubtask={handleCreateSubtask}
        quadrantIcon={quadrantIcon} quadrantOrder={quadrantOrder} quadrantText={quadrantText}
        allowDaily={viewMode !== 'deadline' && viewMode !== 'quadrant'}
      />
      <QuadrantChart open={quadrantOpen} todos={pendingTodos.filter(t => t.taskType !== 'daily')} tags={tags} onClose={() => setQuadrantOpen(false)} />
      <TagManageModal open={tagManageOpen} tags={tags} onClose={() => setTagManageOpen(false)} onCreateTag={handleCreateTag} onDeleteTag={handleDeleteTag} />
    </div>
  )
}

function EmptyHint({ text = '暂无任务' }: { text?: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-[12px] text-[var(--text-muted)]">{text}</p>
    </div>
  )
}
