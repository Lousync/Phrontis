import type { Habit, HabitRecord } from '../../../../types'

/**
 * 打卡模块日期与统计工具
 * 约定：所有日期一律使用本地时区 YYYY-MM-DD 字符串，
 * 解析用 parseLocalDate（new Date(y, m, d)），禁止 toISOString / new Date('YYYY-MM-DD')
 */

/** 本地时区日期 → 'YYYY-MM-DD' */
export function formatLocalDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 'YYYY-MM-DD' → 本地 Date */
export function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  r.setDate(r.getDate() + n)
  return r
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** 周一为一周起点的周首日 */
export function getWeekStart(d: Date): Date {
  const day = d.getDay()
  return addDays(d, day === 0 ? -6 : 1 - day)
}

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']

/** habit 在 date 是否有打卡计划（flexible 视为每天都可打卡） */
export function isPlannedOn(habit: Habit, d: Date): boolean {
  switch (habit.ruleType) {
    case 'daily': return true
    case 'weekdays': return habit.ruleDays.includes(d.getDay())
    case 'flexible': return true
    default: return true
  }
}

/** 规则摘要文本：每天 / 每周一、三 / 每周 3 次 */
export function ruleSummary(habit: Habit): string {
  if (habit.ruleType === 'daily') return '每天'
  if (habit.ruleType === 'flexible') return `每周 ${habit.weeklyTarget} 次`
  const days = [...habit.ruleDays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
  if (days.length === 0) return '未设置计划日'
  return '每周' + days.map(d => WEEKDAY_NAMES[d]).join('、')
}

/** habitId → 该习惯已打卡日期集合 */
export type RecordIndex = Map<string, Set<string>>

export function buildRecordIndex(records: HabitRecord[]): RecordIndex {
  const map: RecordIndex = new Map()
  for (const r of records) {
    let s = map.get(r.habitId)
    if (!s) { s = new Set(); map.set(r.habitId, s) }
    s.add(r.date)
  }
  return map
}

/**
 * 当前连续天数：从今天往回逐日走，跳过非计划日；计划日已打卡则 +1。
 * 今天是计划日但还没打卡不算断档（一天没结束）。
 */
export function currentStreak(habit: Habit, done: Set<string>, today = new Date()): number {
  let streak = 0
  let d = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  if (isPlannedOn(habit, d) && !done.has(formatLocalDate(d))) d = addDays(d, -1)
  for (let i = 0; i < 3650; i++) {
    const ds = formatLocalDate(d)
    if (done.has(ds)) { streak++; d = addDays(d, -1); continue }
    if (!isPlannedOn(habit, d)) { d = addDays(d, -1); continue }
    break
  }
  return streak
}

/** 最长连续天数：从最早记录日起正向扫描计划日 */
export function longestStreak(habit: Habit, done: Set<string>, today = new Date()): number {
  const dates = [...done].sort()
  if (dates.length === 0) return 0
  let longest = 0
  let cur = 0
  let d = parseLocalDate(dates[0])
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  while (d <= end) {
    const ds = formatLocalDate(d)
    if (done.has(ds)) {
      cur++
      if (cur > longest) longest = cur
    } else if (isPlannedOn(habit, d)) {
      cur = 0
    }
    d = addDays(d, 1)
  }
  return longest
}

/** 本周（周一起）已完成次数 */
export function weekDoneCount(done: Set<string>, today = new Date()): number {
  const start = formatLocalDate(getWeekStart(today))
  let n = 0
  for (const ds of done) if (ds >= start && ds <= formatLocalDate(today)) n++
  return n
}

/** 近 30 天完成率：计划日中已完成的占比（flexible 按 30 天内打卡次数 / 30 计） */
export function completionRate30d(habit: Habit, done: Set<string>, today = new Date()): number {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const start = addDays(end, -29)
  let planned = 0
  let did = 0
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const ds = formatLocalDate(d)
    if (done.has(ds)) { planned++; did++ }
    else if (habit.ruleType !== 'flexible' && isPlannedOn(habit, d)) planned++
  }
  if (planned === 0) return 0
  return Math.round((did / planned) * 100)
}

/** 累计总次数 */
export function totalCount(done: Set<string>): number {
  return done.size
}
