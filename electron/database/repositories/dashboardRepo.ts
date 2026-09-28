import { ipcMain } from 'electron'
import { vaultTodosForDate, vaultOverdueTodos, type TodoRow } from '../../lib/kbStore/scheduleVaultRepo'
import { vaultHabitsAll, vaultRecordsAll } from '../../lib/kbStore/habitVaultRepo'
import { checkinCurrentStreak } from '../../lib/kbStore/habitStats'
import { getKnowledgeIndex } from '../../lib/kbStore/knowledgeIndex'
import { pomoSessionsAll } from '../../lib/kbStore/pomoVaultRepo'
import { dateKeyOf } from '../../lib/appUsage'
import { getUsageRange, getUsageTodayMinutes } from '../../lib/appUsageStore'
import { listBooksImpl } from './pdfReaderRepo'

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
  /** 逾期最多列几条 */
  overdue: 3,
  /** 今日待办最多列几条 */
  today: 4,
  /** 最近编辑最多列几条 */
  recentNotes: 5,
  /** 在读书最多列几本 */
  reading: 2,
  /** 今日打卡项最多透出几条（卡内滚动，上限只是字节护栏） */
  habitItems: 20,
  /** 使用热力图跨度（半年） */
  heatmapDays: 183,
} as const

export interface DashboardTodoDto {
  id: string
  title: string
  /** 截止时刻 'HH:mm'（无则 null） */
  time: string | null
}

export interface DashboardSnapshot {
  /** 本地日 'YYYY-MM-DD'，渲染层据此显示日期、不必自己算（避免两端算出不同的「今天」） */
  today: string
  todos: {
    overdue: DashboardTodoDto[]
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

const NOT_DONE = (t: TodoRow): boolean => t.status !== 'done' && t.status !== 'canceled'

function toTodoDto(t: TodoRow): DashboardTodoDto {
  // time 形如 'YYYY-MM-DDTHH:mm'，卡片只要 'HH:mm'
  const m = typeof t.time === 'string' ? /T(\d{2}:\d{2})/.exec(t.time) : null
  return { id: t.id, title: t.title, time: m ? m[1] : null }
}

/** 本地「今天 - n 天」的日期键（用本地日期加减，别拿时间戳硬减，夏令时会偏一天） */
function localDayKey(offsetDays: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return dateKeyOf(d.getTime())
}

/** 全部卡片数据。任何一张卡取数失败都不该让整个看板打不开 —— 逐块 try，失败给空值。 */
export function dashboardSnapshot(): DashboardSnapshot {
  const today = localDayKey(0)

  // --- 待办 ---
  let todos: DashboardSnapshot['todos'] = { overdue: [], today: [], doneToday: 0, totalToday: 0 }
  try {
    const todays = vaultTodosForDate(today)
    const open = todays.filter(NOT_DONE)
    todos = {
      overdue: vaultOverdueTodos(today).filter(NOT_DONE).slice(0, DASHBOARD_LIMITS.overdue).map(toTodoDto),
      today: open.slice(0, DASHBOARD_LIMITS.today).map(toTodoDto),
      doneToday: todays.length - open.length,
      totalToday: todays.length,
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

  return { today, todos, habit, usage, pomodoro, recentNotes, reading }
}

export function registerDashboardHandlers(): void {
  ipcMain.handle('dashboard:getSnapshot', () => dashboardSnapshot())
}
