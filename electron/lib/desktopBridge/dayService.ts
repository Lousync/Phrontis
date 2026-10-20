import { localToday } from '../../../src/lib/date'
import { buildDaySnapshot, isAgendaTodo, type DaySnapshot } from '../../../src/lib/daySnapshotPure'
import { vaultTodosForDate, vaultOverdueTodos } from '../kbStore/scheduleVaultRepo'
import { vaultHabitsAll, vaultRecordsAll } from '../kbStore/habitVaultRepo'
import { checkinCurrentStreak } from '../kbStore/habitStats'
import { getPomodoroSnapshot } from '../../main/pomodoroState'

/**
 * 今日快照的**唯一读取入口**（D-Bus / 托盘 / 将来的 CLI 共用）。
 *
 * 只读：不写盘、不广播。写操作见 `../todoActions.ts` / `../habitActions.ts`。
 * 与看板 `dashboardSnapshot()` 的口径一致：待办=今日列表+逾期未完成，习惯=未归档全部。
 */
export function readTodaySnapshot(today: string = localToday()): DaySnapshot {
  const records = vaultRecordsAll()
  const doneIds = new Set(records.filter(r => r.date === today).map(r => r.habit_id))

  const habits = vaultHabitsAll()
    .filter(h => !h.archived)
    .sort((a, b) =>
      ((a.sort_order ?? 0) - (b.sort_order ?? 0))
      || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
    .map(h => ({
      id: h.id,
      name: h.name,
      doneToday: doneIds.has(h.id),
      // 连续天数：把记录先按习惯过滤，再复用打卡模块的口径（今天没打从昨天起算）
      streak: checkinCurrentStreak(records.filter(r => r.habit_id === h.id), today),
      target: h.weekly_target ?? 3,
    }))

  return buildDaySnapshot({
    date: today,
    // A 口径：今天到期 + 逾期未完成；待安排计划类与已完成不进面板（见 isAgendaTodo）
    todos: [...vaultOverdueTodos(today), ...vaultTodosForDate(today)].filter(r => isAgendaTodo(r, today)),
    habits,
    pomo: getPomodoroSnapshot(),
  })
}
