import { ipcMain } from 'electron'
import { vaultMonthTodos, vaultTodosForDate, type TodoRow } from 'phrontis-core/kbStore/scheduleVaultRepo'
import { vaultHabitsAll, vaultRecordsAll } from 'phrontis-core/kbStore/habitVaultRepo'
import { checkinCurrentStreak } from 'phrontis-core/kbStore/habitStats'
import { getKnowledgeIndex } from 'phrontis-core/kbStore/knowledgeIndex'
import { pomoSessionsAll } from 'phrontis-core/kbStore/pomoVaultRepo'
import { dateKeyOf } from 'phrontis-core/appUsage'
import { getUsageRange, getUsageTodayMinutes } from 'phrontis-core/appUsageStore'
import { listBooksImpl } from './pdfReaderRepo'
import { listWorkspaces } from '../../lib/aiTeachingWorkspaces'
import { getCourseState } from '../../lib/aiTeachingCourse'

/**
 * 看板数据聚合（2026-09-27）。
 *
 * 为什么要一个聚合 handler：看板是**首屏**，一次打开要十来张卡的数字。
 * 让渲染层自己去发 N 个 IPC 会在冷启动时排一队 —— 铁律 17 的「拿得少」之外
 * 还有一条：**取一次**。所以这里在主进程把数据拼好，只跨一次进程边界。
 *
 * 「拿得少」的硬上限集中在 `DASHBOARD_LIMITS`：卡片只画得下这么多，
 * 多传的字节是纯浪费（铁律 17）。
 *
 * 数据源一律**复用现有仓储/实现**，不新开存储：
 *  - 待办        scheduleVaultRepo
 *  - 打卡        habitVaultRepo + habitStats 的纯判定（连续天数；逐项见 habit.items）
 *  - 最近编辑    knowledgeIndex（**只取索引条目，不读正文** —— 取正文会把全库 markdown 拉进内存）
 *  - 在读书      pdfReaderRepo.listBooksImpl（与书架清单**同一实现**，不另判「什么算在读」）
 *  - 使用时长    appUsageStore（P1 新增的采集器）
 *
 * 错题卡已随看板方案 §5 反馈 4 移除（2026-09-27）：快照不再取 quizRecordStats（拿得少）。
 */

/** 卡片能画下的量。改这里要同步看板卡片组件，否则「多传了但没人显示」 */
export const DASHBOARD_LIMITS = {
  /** 今日时间线最多列几条（含已完成） */
  today: 20,
  /** 最近编辑最多列几条 */
  recentNotes: 5,
  /** 在读书最多列几本 */
  reading: 2,
  /** 今日打卡项最多透出几条（卡内滚动，上限只是字节护栏） */
  habitItems: 20,
  /** 使用热力图跨度（2026-11-14 看板首页重做：半年 → 近一年 52 周） */
  heatmapDays: 364,
} as const

export interface DashboardTodoDto {
  id: string
  title: string
  /** 时间 'HH:mm'：优先排期时段（scheduled_start），其次截止时刻（deadline 的 time）；都没有 = null */
  time: string | null
  /** 已完成（时间线要用它画划线态；已完成项也留在今天的列表里 —— 2026-11-14 首页重做） */
  done: boolean
}

export interface DashboardSnapshot {
  /** 本地日 'YYYY-MM-DD'，渲染层据此显示日期、不必自己算（避免两端算出不同的「今天」） */
  today: string
  todos: {
    /** 今日任务（含已完成）。跨天逾期不放进首页 —— 时间线是「今天」，逾期去日程看 */
    today: DashboardTodoDto[]
    doneToday: number
    totalToday: number
  }
  habit: {
    /** 连续打卡天数（今天还没打就从昨天起算） */
    streak: number
    /** 今日已打卡的**习惯数**（去重后） */
    doneToday: number
    /** 未归档习惯总数 */
    habits: number
    /** 今日打卡项逐条（看板方案 §5 反馈 4②，2026-09-27 拍板：卡列打卡项、可勾选）—— sort_order 序。
     *  color 随条目透出：勾选庆祝彩纸用习惯色（与打卡列表同款反馈，反馈 7）。 */
    items: Array<{ id: string; name: string; done: boolean; color: string }>
  }
  calendar: {
    /** 当月 'YYYY-MM' */
    month: string
    /** 'YYYY-MM-DD' → { total, done } */
    days: Record<string, { total: number; done: number }>
  }
  course: null | {
    wsId: string
    wsName: string
    chapterTitle: string
    unitTitle: string
    unitGoal: string
    pct: number
    chapterIndex: number
    chapterCount: number
  }
  usage: {
    todayMinutes: number
    /** `[today-182, today]` 每天分钟数，缺失日补 0 */
    days: Record<string, number>
  }
  /** 番茄钟专注分钟（与 usage 同跨度同口径，供热力图「专注时长」指标） */
  pomodoro: {
    days: Record<string, number>
  }
  recentNotes: Array<{ id: string; title: string; path: string; updatedAt: string }>
  reading: Array<{ relPath: string; displayName: string; pct: number }>
}

function toTodoDto(t: TodoRow): DashboardTodoDto {
  // 排期时段优先（日程表里排到几点），其次截止时刻 time（'YYYY-MM-DDTHH:mm'）
  const sched = typeof t.scheduled_start === 'number'
    ? `${String(Math.floor(t.scheduled_start / 60)).padStart(2, '0')}:${String(t.scheduled_start % 60).padStart(2, '0')}`
    : null
  const m = typeof t.time === 'string' ? /T(\d{2}:\d{2})/.exec(t.time) : null
  return { id: t.id, title: t.title, time: sched ?? (m ? m[1] : null), done: t.status === 'done' }
}

/** 本地「今天 - n 天」的日期键（用本地日期加减，别拿时间戳硬减，夏令时会偏一天） */
function localDayKey(offsetDays: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return dateKeyOf(d.getTime())
}

/** 全部卡片数据。任何一张卡取数失败都不该让整个看板打不开 —— 逐块 try，失败给空值。 */
export function dashboardSnapshot(getSetting: (key: string) => unknown = () => undefined): DashboardSnapshot {
  const today = localDayKey(0)

  // --- 待办 ---
  let todos: DashboardSnapshot['todos'] = { today: [], doneToday: 0, totalToday: 0 }
  try {
    // 已取消的既不画也不计数 —— 与列表同一口径（早先 doneToday = 总数 - 未完成，
    // 会把 canceled 也算成「已完成」，分母也被抬高；2026-11-14 数据核对时修正）
    const rows = vaultTodosForDate(today).filter((t) => t.status !== 'canceled')
    todos = {
      // 时间线要画「已完成」的划线态，所以这里**不再只留未完成**（2026-11-14）
      today: rows.slice(0, DASHBOARD_LIMITS.today).map(toTodoDto),
      doneToday: rows.filter((t) => t.status === 'done').length,
      totalToday: rows.length,
    }
  } catch (e) { console.warn('[dashboard] todos failed:', e) }

  // --- 打卡 ---
  let habit: DashboardSnapshot['habit'] = { streak: 0, doneToday: 0, habits: 0, items: [] }
  try {
    const records = vaultRecordsAll()
    const active = vaultHabitsAll()
      .filter((h) => !h.archived)
      .sort((a, b) => a.sort_order - b.sort_order)
    // 今日已打卡的习惯 id 集合（一个习惯一天可能有多条来源记录，去重）
    const doneIds = new Set(records.filter((r) => r.date === today).map((r) => r.habit_id))
    habit = {
      streak: checkinCurrentStreak(records, today),
      doneToday: doneIds.size,
      habits: active.length,
      items: active.slice(0, DASHBOARD_LIMITS.habitItems).map((h) => ({ id: h.id, name: h.name, done: doneIds.has(h.id), color: h.color })),
    }
  } catch (e) { console.warn('[dashboard] habit failed:', e) }

  // --- 本月日历（2026-11-14 首页重做）：只数「这天几件、做完几件」 ---
  let calendar: DashboardSnapshot['calendar'] = { month: today.slice(0, 7), days: {} }
  try {
    calendar = calendarOfMonth(today)
  } catch (e) { console.warn('[dashboard] calendar failed:', e) }

  // --- AI 教学当前这一段（取最近工作区的课程大纲） ---
  let course: DashboardSnapshot['course'] = null
  try {
    course = courseSnapshot(getSetting)
  } catch (e) { console.warn('[dashboard] course failed:', e) }

  // --- 使用时长 ---
  let usage: DashboardSnapshot['usage'] = { todayMinutes: getUsageTodayMinutes(), days: {} }
  try {
    usage = {
      todayMinutes: getUsageTodayMinutes(),
      days: getUsageRange(localDayKey(-(DASHBOARD_LIMITS.heatmapDays - 1)), today),
    }
  } catch (e) { console.warn('[dashboard] usage failed:', e) }

  // --- 番茄钟专注（与 usage 同跨度；聚合自 modules/pomodoro/sessions.json） ---
  let pomodoro: DashboardSnapshot['pomodoro'] = { days: {} }
  try {
    const from = localDayKey(-(DASHBOARD_LIMITS.heatmapDays - 1))
    const days: Record<string, number> = {}
    for (const s of pomoSessionsAll()) {
      if (s.date >= from && s.date <= today) days[s.date] = (days[s.date] ?? 0) + (s.minutes ?? 0)
    }
    pomodoro = { days }
  } catch (e) { console.warn('[dashboard] pomodoro failed:', e) }

  // --- 最近编辑（只取索引条目，不读正文） ---
  let recentNotes: DashboardSnapshot['recentNotes'] = []
  try {
    recentNotes = [...getKnowledgeIndex().pages]
      .filter((p) => (p.entryKind ?? 'doc') === 'doc' && !!p.updatedAt)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .slice(0, DASHBOARD_LIMITS.recentNotes)
      .map((p) => ({ id: p.id, title: p.title, path: p.path, updatedAt: p.updatedAt }))
  } catch (e) { console.warn('[dashboard] recentNotes failed:', e) }

  // --- 在读的书 ---
  let reading: DashboardSnapshot['reading'] = []
  try {
    const r = listBooksImpl()
    reading = (r.books ?? [])
      // 「在读」= 有进度且没读完。不另设标记位 —— 与书架清单同一实现，避免两个「在读」口径
      .filter((b) => b.hasProgress && (b.pct ?? 0) < 100)
      .sort((a, b) => ((a.updatedAt ?? '') < (b.updatedAt ?? '') ? 1 : -1))
      .slice(0, DASHBOARD_LIMITS.reading)
      .map((b) => ({ relPath: b.relPath, displayName: b.displayName, pct: b.pct ?? 0 }))
  } catch (e) { console.warn('[dashboard] reading failed:', e) }

  return { today, todos, habit, calendar, course, usage, pomodoro, recentNotes, reading }
}

/**
 * 当月每天的待办计数（看板月历用）。
 *
 * 用 `vaultMonthTodos`（月视图同一实现）：它会顺带捞「未完成的计划类任务」——
 * 那些没有日期的行在这里按 `date.slice(0,7)` 过滤掉，不会落进任何一天。
 */
function calendarOfMonth(today: string): DashboardSnapshot['calendar'] {
  const month = today.slice(0, 7)
  const days: Record<string, { total: number; done: number }> = {}
  for (const t of vaultMonthTodos(month)) {
    const date = typeof t.date === 'string' ? t.date : ''
    if (date.slice(0, 7) !== month) continue
    // 与「今天」那一栏同一口径：已取消的不画、不计数（否则月历点数比纸上的件数多）
    if (t.status === 'canceled') continue
    const slot = (days[date] ??= { total: 0, done: 0 })
    slot.total++
    if (t.status === 'done') slot.done++
  }
  return { month, days }
}

/**
 * AI 教学「当前这一段」：最近工作区 → 课程大纲 → 第一个没收尾的知识点。
 *
 * 为什么在这里聚合：看板是首屏，课程窗口只是「一句话 + 一个继续按钮」，
 * 为它单开一条 IPC 会让冷启动多排一队（与快照聚合同一条理由）。
 */
function courseSnapshot(getSetting: (key: string) => unknown): DashboardSnapshot['course'] {
  const { workspaces, lastWorkspaceId } = listWorkspaces(getSetting)
  if (workspaces.length === 0) return null
  const ws = workspaces.find((w) => w.id === lastWorkspaceId)
    ?? [...workspaces].sort((a, b) => (b.lastActive ?? '').localeCompare(a.lastActive ?? ''))[0]
  if (!ws) return null

  const state = getCourseState(ws.id, getSetting)
  const outline = state.outline
  if (!outline || outline.chapters.length === 0) return null
  const total = outline.chapters.reduce((n, c) => n + c.units.length, 0)
  if (total === 0) return null

  let done = 0
  let pick: { chapterTitle: string; unitTitle: string; unitGoal: string; chapterIndex: number } | null = null
  for (let ci = 0; ci < outline.chapters.length; ci++) {
    const ch = outline.chapters[ci]
    for (const u of ch.units) {
      const p = state.progress[u.id]
      const finished = p?.status === 'mastered' || !!p?.finished
      if (finished) { done++; continue }
      if (!pick) pick = { chapterTitle: ch.name, unitTitle: u.name, unitGoal: u.goal ?? '', chapterIndex: ci + 1 }
    }
  }
  if (!pick) {
    // 全部收尾：窗口停在最后一章最后一个知识点，进度 100%
    const lastCh = outline.chapters[outline.chapters.length - 1]
    const lastUnit = lastCh?.units[lastCh.units.length - 1]
    pick = {
      chapterTitle: lastCh?.name ?? '',
      unitTitle: lastUnit?.name ?? '',
      unitGoal: lastUnit?.goal ?? '',
      chapterIndex: outline.chapters.length,
    }
  }
  return {
    wsId: ws.id,
    wsName: ws.name,
    ...pick,
    pct: Math.round((done / total) * 100),
    chapterCount: outline.chapters.length,
  }
}

export function registerDashboardHandlers(deps: { getSettingValue: (key: string) => unknown }): void {
  ipcMain.handle('dashboard:getSnapshot', () => dashboardSnapshot(deps.getSettingValue))
}
