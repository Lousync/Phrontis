import type { PomodoroSession } from '../../types'

/**
 * 番茄钟统计纯函数（渲染层使用；无 React / 无 IPC）。
 *
 * 口径：
 * - 场次按 **endedAt 的本地日期**归入区间（与 sessions.json 的 date 字段一致，跨零点不记到前一天）。
 * - 旧记录（只有 minutes/date/created_at）归一化为「无主题 / 自然完成 / 未评分」，
 *   计入时长与场次，但不参与主题分布。
 * - 主题分布最多由 UI 取前 5；这里返回全部，方便筛选与「还有 N 个」。
 */

export type PomodoroRange = 'today' | 'week' | 'month'

export interface NormalizedPomodoroSession {
  id: string
  topic: string
  minutes: number
  actualSeconds: number
  completed: boolean
  rating: number | null
  tags: string[]
  startedAt: number
  endedAt: number
}

export interface TopicBucket {
  topic: string
  minutes: number
  sessions: number
  avgRating: number | null
}

export interface DayBucket {
  date: Date
  key: string
  minutes: number
  topics: Array<{ topic: string; minutes: number }>
}

export interface MonthCell {
  blank: boolean
  day: number
  minutes: number
  level: number
  isToday: boolean
  key: string
}

export interface MonthView {
  weeks: MonthCell[][]
  recordedDays: number
  longestStreak: number
  bestDay: { day: number; minutes: number } | null
  topTopic: string | null
}

export interface PomodoroStats {
  range: PomodoroRange
  sessions: NormalizedPomodoroSession[]
  totalMinutes: number
  prevMinutes: number
  sessionCount: number
  naturalCount: number
  earlyCount: number
  ratedCount: number
  avgRating: number | null
  completionPct: number | null
  topics: TopicBucket[]
  untopicCount: number
  quality: {
    distribution: Array<{ score: number; count: number }>
    naturalAvg: number | null
    earlyAvg: number | null
    tags: Array<{ tag: string; count: number }>
  }
  days: DayBucket[]
  hourMinutes: number[]
  month: MonthView
  bestTime: { label: string; from: number; to: number; avg: number; count: number } | null
}

export interface RangeWindow {
  start: Date
  end: Date
  prevStart: Date
  prevEnd: Date
  prevLabel: string
}

export const TOPIC_COLORS = [
  '#4f6ef2',
  '#35975c',
  '#9157d6',
  '#d97a1e',
  '#c94f4f',
  '#2b8fbd',
  '#4e8f86',
  '#b0497f',
] as const

const pad2 = (n: number): string => String(n).padStart(2, '0')

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate())

const addDays = (d: Date, n: number): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

/** 本地日期键 YYYY-MM-DD */
export function localDateKey(input: Date | number): string {
  const d = typeof input === 'number' ? new Date(input) : input
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 稳定主题色：同名主题在任何设备、任何排序下都是同一色 */
export function topicColor(topic: string): string {
  let h = 0
  for (let i = 0; i < topic.length; i++) h = (h * 31 + topic.charCodeAt(i)) >>> 0
  return TOPIC_COLORS[h % TOPIC_COLORS.length]
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  // 纯日期按本地零点解析，避免 `new Date('2026-11-12')` 被当成 UTC
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (dateOnly) {
    const d = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    return Number.isNaN(d.getTime()) ? null : d.getTime()
  }
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? null : t
}

/** 旧记录只有 date（本地日）+ created_at（UTC 时刻）：用 date 锚定本地日，用 created 补时刻。 */
function combineDateAndTime(dateOnly: number | null, timeSource: number | null): number | null {
  if (dateOnly === null) return timeSource
  const d = new Date(dateOnly)
  if (timeSource !== null) {
    const t = new Date(timeSource)
    d.setHours(t.getHours(), t.getMinutes(), t.getSeconds(), t.getMilliseconds())
  } else {
    d.setHours(12, 0, 0, 0)
  }
  return d.getTime()
}

function sanitizeRating(value: unknown): number | null {
  const n = Math.round(Number(value))
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null
}

function sanitizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim().slice(0, 24)
    if (!tag || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= 3) break
  }
  return out
}

/** 旧行 / 新行 → 统一统计形状 */
export function normalizePomodoroSession(row: PomodoroSession): NormalizedPomodoroSession | null {
  if (!row || typeof row.id !== 'string') return null

  const minutesRaw = Number(row.minutes)
  const secondsRaw = Number(row.actual_seconds)
  const actualSeconds = Number.isFinite(secondsRaw) && secondsRaw > 0
    ? Math.max(0, Math.round(secondsRaw))
    : Math.max(0, Math.round((Number.isFinite(minutesRaw) ? minutesRaw : 0) * 60))
  const minutes = Math.max(1, Math.round(Number.isFinite(minutesRaw) && minutesRaw > 0 ? minutesRaw : actualSeconds / 60))

  const created = parseTimestamp(row.created_at)
  const started = parseTimestamp(row.started_at)
  const ended = parseTimestamp(row.ended_at)
  const dateOnly = parseTimestamp(row.date)

  // 新记录有 ended_at；旧记录只有 date + created_at —— 用 date 锚定本地日，
  // 用 created_at 补时刻，避免 created_at 的 UTC 日期在凌晨把记录归错天。
  const endedAt = ended
    ?? (started !== null ? started + actualSeconds * 1000 : combineDateAndTime(dateOnly, created))
    ?? Date.now()
  const startedAt = started ?? Math.max(0, endedAt - actualSeconds * 1000)
  const safeStartedAt = Number.isFinite(startedAt) ? Math.min(startedAt, endedAt) : endedAt

  return {
    id: row.id,
    topic: typeof row.topic === 'string' ? row.topic.trim() : '',
    minutes,
    actualSeconds,
    completed: row.completed !== false,
    rating: sanitizeRating(row.rating),
    tags: sanitizeTags(row.tags),
    startedAt: safeStartedAt,
    endedAt,
  }
}

export function normalizePomodoroSessions(rows: PomodoroSession[]): NormalizedPomodoroSession[] {
  const out: NormalizedPomodoroSession[] = []
  for (const row of rows ?? []) {
    const s = normalizePomodoroSession(row)
    if (s) out.push(s)
  }
  return out.sort((a, b) => a.endedAt - b.endedAt)
}

/** 区间边界：周从周一 00:00 起算；prev 用于环比 */
export function pomodoroRangeWindow(range: PomodoroRange, now: Date = new Date()): RangeWindow {
  if (range === 'today') {
    const start = startOfDay(now)
    const end = addDays(start, 1)
    return { start, end, prevStart: addDays(start, -1), prevEnd: start, prevLabel: '昨日' }
  }
  if (range === 'week') {
    const start = addDays(startOfDay(now), -((now.getDay() + 6) % 7))
    const end = addDays(start, 7)
    return { start, end, prevStart: addDays(start, -7), prevEnd: start, prevLabel: '上周' }
  }
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  return { start, end, prevStart, prevEnd: start, prevLabel: '上月' }
}

const inWindow = (s: NormalizedPomodoroSession, start: Date, end: Date): boolean =>
  s.endedAt >= start.getTime() && s.endedAt < end.getTime()

function buildTopics(list: NormalizedPomodoroSession[]): TopicBucket[] {
  const map = new Map<string, { minutes: number; sessions: number; ratingSum: number; ratingCount: number }>()
  for (const s of list) {
    if (!s.topic) continue
    const hit = map.get(s.topic) ?? { minutes: 0, sessions: 0, ratingSum: 0, ratingCount: 0 }
    hit.minutes += s.actualSeconds / 60
    hit.sessions += 1
    if (s.rating) {
      hit.ratingSum += s.rating
      hit.ratingCount += 1
    }
    map.set(s.topic, hit)
  }
  return [...map.entries()]
    .map(([topic, v]) => ({
      topic,
      minutes: v.minutes,
      sessions: v.sessions,
      avgRating: v.ratingCount ? v.ratingSum / v.ratingCount : null,
    }))
    .sort((a, b) => b.minutes - a.minutes || b.sessions - a.sessions)
}

function buildDays(list: NormalizedPomodoroSession[], start: Date, count: number): DayBucket[] {
  const days: DayBucket[] = []
  for (let i = 0; i < count; i++) {
    const date = addDays(start, i)
    const key = localDateKey(date)
    const items = list.filter((s) => localDateKey(s.endedAt) === key)
    const topicMap = new Map<string, number>()
    for (const s of items) {
      // 空主题也保留一个灰色段（旧记录），否则柱高会小于当日总分钟
      const key = s.topic || ''
      topicMap.set(key, (topicMap.get(key) ?? 0) + s.actualSeconds / 60)
    }
    days.push({
      date,
      key,
      minutes: items.reduce((sum, s) => sum + s.actualSeconds / 60, 0),
      topics: [...topicMap.entries()].map(([topic, minutes]) => ({ topic, minutes })),
    })
  }
  return days
}

function buildMonth(list: NormalizedPomodoroSession[], start: Date): MonthView {
  const y = start.getFullYear()
  const m = start.getMonth()
  const daysInMonth = new Date(y, m + 1, 0).getDate()
  const firstDow = (new Date(y, m, 1).getDay() + 6) % 7

  const byDay = new Map<number, number>()
  for (const s of list) {
    const d = new Date(s.endedAt)
    if (d.getFullYear() !== y || d.getMonth() !== m) continue
    byDay.set(d.getDate(), (byDay.get(d.getDate()) ?? 0) + s.actualSeconds / 60)
  }
  const max = Math.max(...byDay.values(), 1)
  const today = new Date()
  const isToday = (day: number) =>
    today.getFullYear() === y && today.getMonth() === m && today.getDate() === day

  const weeks: MonthCell[][] = []
  const totalCells = firstDow + daysInMonth
  const weekCount = Math.ceil(totalCells / 7)
  for (let w = 0; w < weekCount; w++) {
    const col: MonthCell[] = []
    for (let dow = 0; dow < 7; dow++) {
      const day = w * 7 + dow - firstDow + 1
      if (day < 1 || day > daysInMonth) {
        col.push({ blank: true, day: 0, minutes: 0, level: 0, isToday: false, key: '' })
        continue
      }
      const minutes = byDay.get(day) ?? 0
      col.push({
        blank: false,
        day,
        minutes,
        level: minutes <= 0 ? 0 : Math.min(4, Math.ceil((minutes / max) * 4)),
        isToday: isToday(day),
        key: `${y}-${pad2(m + 1)}-${pad2(day)}`,
      })
    }
    weeks.push(col)
  }

  let longestStreak = 0
  let run = 0
  for (let day = 1; day <= daysInMonth; day++) {
    if ((byDay.get(day) ?? 0) > 0) {
      run += 1
      longestStreak = Math.max(longestStreak, run)
    } else run = 0
  }

  let bestDay: { day: number; minutes: number } | null = null
  for (const [day, minutes] of byDay.entries()) {
    if (!bestDay || minutes > bestDay.minutes) bestDay = { day, minutes }
  }

  return {
    weeks,
    recordedDays: byDay.size,
    longestStreak,
    bestDay,
    topTopic: buildTopics(list)[0]?.topic ?? null,
  }
}

function avgOf(list: NormalizedPomodoroSession[]): number | null {
  const rated = list.filter((s) => s.rating !== null)
  if (!rated.length) return null
  return rated.reduce((sum, s) => sum + (s.rating ?? 0), 0) / rated.length
}

export function computePomodoroStats(
  rows: PomodoroSession[],
  range: PomodoroRange,
  now: Date = new Date(),
): PomodoroStats {
  const all = normalizePomodoroSessions(rows)
  const win = pomodoroRangeWindow(range, now)
  const current = all.filter((s) => inWindow(s, win.start, win.end))
  const prev = all.filter((s) => inWindow(s, win.prevStart, win.prevEnd))

  const totalMinutes = Math.round(current.reduce((sum, s) => sum + s.actualSeconds / 60, 0))
  const prevMinutes = Math.round(prev.reduce((sum, s) => sum + s.actualSeconds / 60, 0))
  const naturalCount = current.filter((s) => s.completed).length
  const earlyCount = current.length - naturalCount
  const rated = current.filter((s) => s.rating !== null)
  const avgRating = rated.length
    ? rated.reduce((sum, s) => sum + (s.rating ?? 0), 0) / rated.length
    : null

  const hourMinutes = Array(24).fill(0) as number[]
  for (const s of current) {
    const h = new Date(s.startedAt).getHours()
    hourMinutes[h] += s.actualSeconds / 60
  }

  const naturalAvg = avgOf(current.filter((s) => s.completed))
  const earlyAvg = avgOf(current.filter((s) => !s.completed))

  const tagMap = new Map<string, number>()
  for (const s of rated) {
    for (const tag of s.tags) tagMap.set(tag, (tagMap.get(tag) ?? 0) + 1)
  }

  const timeBuckets = [
    { label: '早晨', from: 5, to: 9 },
    { label: '上午', from: 9, to: 12 },
    { label: '下午', from: 12, to: 18 },
    { label: '晚上', from: 18, to: 24 },
  ].map((b) => {
    const items = rated.filter((s) => {
      const h = new Date(s.startedAt).getHours()
      return h >= b.from && h < b.to
    })
    return {
      ...b,
      count: items.length,
      avg: items.length ? items.reduce((sum, s) => sum + (s.rating ?? 0), 0) / items.length : 0,
    }
  }).filter((b) => b.count >= 2)

  const bestTime = timeBuckets.length
    ? [...timeBuckets].sort((a, b) => b.avg - a.avg || b.count - a.count)[0]
    : null

  const dayCount = range === 'week' ? 7 : range === 'today' ? 1 : new Date(win.start.getFullYear(), win.start.getMonth() + 1, 0).getDate()

  return {
    range,
    sessions: current,
    totalMinutes,
    prevMinutes,
    sessionCount: current.length,
    naturalCount,
    earlyCount,
    ratedCount: rated.length,
    avgRating,
    completionPct: current.length ? Math.round((naturalCount / current.length) * 100) : null,
    topics: buildTopics(current),
    untopicCount: current.filter((s) => !s.topic).length,
    quality: {
      distribution: [5, 4, 3, 2, 1].map((score) => ({
        score,
        count: rated.filter((s) => s.rating === score).length,
      })),
      naturalAvg,
      earlyAvg,
      tags: [...tagMap.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 4),
    },
    days: buildDays(current, win.start, dayCount),
    hourMinutes,
    month: buildMonth(current, win.start),
    bestTime,
  }
}

export function formatClock(ts: number): string {
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function formatDayLabel(ts: number, now: Date = new Date()): string {
  const d = new Date(ts)
  const today = startOfDay(now).getTime()
  const day = startOfDay(d).getTime()
  if (day === today) return '今天'
  if (day === addDays(startOfDay(now), -1).getTime()) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function weekdayCN(d: Date): string {
  return ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
}
