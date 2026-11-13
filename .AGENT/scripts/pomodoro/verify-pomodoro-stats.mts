/**
 * 番茄钟统计纯函数契约验证（v3.24.0）
 *
 * 运行：node --experimental-strip-types --no-warnings .AGENT/scripts/pomodoro/verify-pomodoro-stats.mts
 * 只测纯函数，不碰 Electron / 真实仓库。
 */
import {
  computePomodoroStats,
  normalizePomodoroSession,
  pomodoroRangeWindow,
  localDateKey,
} from '../../../src/modules/toolbox/pomodoroStats.ts'
import type { PomodoroSession } from '../../../src/types/index.ts'

let failures = 0
function ok(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`PASS ${name}`)
  } else {
    failures += 1
    console.log(`FAIL ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
  }
}

function row(partial: Partial<PomodoroSession> & { id: string }): PomodoroSession {
  return { minutes: 0, date: '2026-11-13', ...partial }
}

// ---- 旧记录归一化 ----
const legacy = normalizePomodoroSession(row({
  id: 'legacy',
  minutes: 25,
  date: '2026-11-12',
  created_at: '2026-11-12T10:00:00',
}))
ok('legacy row normalized', !!legacy)
ok('legacy has no topic', legacy?.topic === '')
ok('legacy treated as completed', legacy?.completed === true)
ok('legacy rating null', legacy?.rating === null)
ok('legacy minutes kept', legacy?.minutes === 25)
ok('legacy date anchors local day', legacy ? localDateKey(legacy.endedAt) === '2026-11-12' : false, legacy && localDateKey(legacy.endedAt))

// ---- 新记录清洗 ----
const dirty = normalizePomodoroSession(row({
  id: 'dirty',
  minutes: 1,
  topic: '  操作系统  ',
  actual_seconds: 90,
  completed: false,
  rating: 9,
  tags: ['走神', '走神', '身体疲惫', '环境嘈杂', '状态很好'],
  started_at: '2026-11-13T10:00:00',
  ended_at: '2026-11-13T10:01:30',
}))
ok('topic trimmed', dirty?.topic === '操作系统')
ok('actual seconds kept', dirty?.actualSeconds === 90)
ok('minutes derived at least 1', dirty?.minutes === 1)
ok('early flag kept', dirty?.completed === false)
ok('invalid rating cleared', dirty?.rating === null)
ok('tags deduped and capped at 3', dirty?.tags.length === 3, dirty?.tags)

// ---- 区间边界（2026-11-13 周五；本周从 11-09 周一算） ----
const now = new Date(2026, 10, 13, 12, 0, 0)
const week = pomodoroRangeWindow('week', now)
ok('week starts Monday', week.start.getDay() === 1 && week.start.getDate() === 9, week.start.toString())
ok('week ends next Monday', week.end.getDate() === 16, week.end.toString())
ok('week prev range 7 days', week.prevStart.getDate() === 2 && week.prevEnd.getDate() === 9)
const month = pomodoroRangeWindow('month', now)
ok('month starts day 1', month.start.getDate() === 1)
ok('month ends next month day 1', month.end.getMonth() === 11 && month.end.getDate() === 1)

// ---- 统计聚合 ----
const rows: PomodoroSession[] = [
  row({ id: 'a', topic: '操作系统', minutes: 25, actual_seconds: 1500, completed: true, rating: 5, started_at: '2026-11-13T10:00:00', ended_at: '2026-11-13T10:25:00' }),
  row({ id: 'b', topic: '英语', minutes: 15, actual_seconds: 900, completed: false, rating: 3, started_at: '2026-11-13T15:00:00', ended_at: '2026-11-13T15:15:00' }),
  row({ id: 'c', topic: '操作系统', minutes: 25, actual_seconds: 1500, completed: true, rating: 4, started_at: '2026-11-12T09:00:00', ended_at: '2026-11-12T09:25:00' }),
  row({ id: 'd', minutes: 45, actual_seconds: 2700, started_at: '2026-11-10T20:00:00', ended_at: '2026-11-10T20:45:00' }),
]

const todayStats = computePomodoroStats(rows, 'today', now)
ok('today minutes', todayStats.totalMinutes === 40, todayStats.totalMinutes)
ok('today sessions', todayStats.sessionCount === 2, todayStats.sessionCount)
ok('today natural/early', todayStats.naturalCount === 1 && todayStats.earlyCount === 1)
ok('today avg rating', todayStats.avgRating === 4, todayStats.avgRating)
ok('today topics sorted', todayStats.topics.map((t) => t.topic).join(',') === '操作系统,英语', todayStats.topics)
ok('today no untopic', todayStats.untopicCount === 0)
ok('today best time needs >=2 rated in bucket', todayStats.bestTime === null, todayStats.bestTime)

const weekStats = computePomodoroStats(rows, 'week', now)
ok('week minutes', weekStats.totalMinutes === 110, weekStats.totalMinutes)
ok('week sessions', weekStats.sessionCount === 4, weekStats.sessionCount)
ok('week untopic counted', weekStats.untopicCount === 1, weekStats.untopicCount)
ok('week topics exclude untopic', weekStats.topics.length === 2, weekStats.topics)
ok('week topic top minutes', weekStats.topics[0]?.topic === '操作系统' && weekStats.topics[0]?.minutes === 50, weekStats.topics[0])
ok('week best time morning', weekStats.bestTime?.label === '上午', weekStats.bestTime)
ok('week days length 7', weekStats.days.length === 7)
ok('week no-topic segment kept in day', weekStats.days[1]?.topics.some((t) => t.topic === ''), weekStats.days[1])

const monthStats = computePomodoroStats(rows, 'month', now)
ok('month weeks have 7 cells', monthStats.month.weeks.every((w) => w.length === 7))
ok('month recorded days', monthStats.month.recordedDays === 3, monthStats.month.recordedDays)
ok('month longest streak', monthStats.month.longestStreak === 2, monthStats.month.longestStreak)
ok('month top topic', monthStats.month.topTopic === '操作系统', monthStats.month.topTopic)

// ---- 评分分布 ----
ok('rating distribution 5/4/3', monthStats.quality.distribution.find((d) => d.score === 5)?.count === 1
  && monthStats.quality.distribution.find((d) => d.score === 4)?.count === 1
  && monthStats.quality.distribution.find((d) => d.score === 3)?.count === 1)
ok('natural vs early average', monthStats.quality.naturalAvg === 4.5 && monthStats.quality.earlyAvg === 3, monthStats.quality)

if (failures) {
  console.log(`\n[FAIL] ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n[OK] pomodoro stats contract passed')
