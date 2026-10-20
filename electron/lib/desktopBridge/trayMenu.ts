import type { MenuItemConstructorOptions } from 'electron'
import { localToday } from '../../../src/lib/date'
import { readTodaySnapshot } from './dayService'

/** 菜单里的 `&` 在部分平台会被当作快捷键前缀，原样转义 */
function safe(s: string): string {
  return s.replace(/&/g, '&&')
}

const MAX_TODO_ITEMS = 5
const MAX_HABIT_ITEMS = 5

/**
 * 托盘菜单的「今日」区（阶段 1 · C 档）。
 *
 * 只读快照 + 两个回调；每一项点一下就走与 D-Bus 相同的写入口，
 * 所以托盘、扩展、应用内三条路的落盘与广播完全一致。
 */
export function buildTodayMenuItems(opts: {
  onToggleTodo: (id: string) => void
  onToggleHabit: (id: string) => void
}): MenuItemConstructorOptions[] {
  let day
  try {
    day = readTodaySnapshot(localToday())
  } catch (e) {
    console.warn('[desktop] 托盘菜单读取今日快照失败:', e)
    return [{ label: '今日数据暂不可用', enabled: false }]
  }

  const pending = day.todos.filter(t => !t.done).slice(0, MAX_TODO_ITEMS)
  const doneTodos = day.todos.length - day.todos.filter(t => !t.done).length
  const doneHabits = day.habits.filter(h => h.doneToday).length

  const items: MenuItemConstructorOptions[] = [
    { label: safe(`今日 ${doneTodos}/${day.todos.length} 项 · 打卡 ${doneHabits}/${day.habits.length}`), enabled: false },
  ]

  if (pending.length) {
    items.push({ type: 'separator' })
    for (const t of pending) {
      items.push({ label: safe(`○ ${t.text}`), click: () => opts.onToggleTodo(t.id) })
    }
  }

  const habits = day.habits.slice(0, MAX_HABIT_ITEMS)
  if (habits.length) {
    items.push({ type: 'separator' })
    for (const h of habits) {
      items.push({
        label: safe(`${h.doneToday ? '✓' : '○'} ${h.name}${h.streak > 0 ? ` · ${h.streak} 天` : ''}`),
        click: () => opts.onToggleHabit(h.id),
      })
    }
  }

  if (day.pomo.state !== 0) {
    items.push({ type: 'separator' })
    items.push({ label: safe(`番茄钟 · ${day.pomo.state === 1 ? '进行中' : '已暂停'}`), enabled: false })
  }

  return items
}
