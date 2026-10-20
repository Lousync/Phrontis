/**
 * 今日快照（纯函数、零依赖）。
 *
 * 桌面集成（D-Bus `GetToday` / 托盘菜单）与契约脚本共用这一份映射，
 * 避免「托盘看到的数字」和「扩展面板看到的数字」各写一套口径。
 *
 * 字段名与 D-Bus 签名严格对应（见 `electron/lib/desktopBridge/dbusService.ts`）：
 *   Todo  = (s id, s text, b done, s due, i quadrant)   → `(ssbsi)`
 *   Habit = (s id, s name, b doneToday, i streak, i target) → `(ssbii)`
 *   Pomo  = (i state, i leftSeconds, i totalSeconds)    → `(iii)`
 *   Day   = (s date, a(Todo), a(Habit), Pomo)
 */

export interface DayTodoSource {
  id: string
  title: string
  status: string
  date: string
  time?: string | null
  quadrant?: number
  sort_order?: number
  created_at?: string
}

export interface DayHabitSource {
  id: string
  name: string
  doneToday: boolean
  streak: number
  target: number
}

export interface PomoSource {
  visible: boolean
  running: boolean
  /** 渲染层当前显示串：`mm:ss` 或 `h:mm:ss` */
  display: string
  /** 0→1；未知时为 0 */
  progress: number
}

export interface DayTodo {
  id: string
  text: string
  done: boolean
  due: string
  quadrant: number
}

export interface DayHabit {
  id: string
  name: string
  doneToday: boolean
  streak: number
  target: number
}

export interface DayPomo {
  state: number // 0 idle / 1 running / 2 paused
  leftSeconds: number
  totalSeconds: number
}

export interface DaySnapshot {
  date: string
  todos: DayTodo[]
  habits: DayHabit[]
  pomo: DayPomo
}

/** `12:34` / `1:02:03` → 秒；坏输入按 0（面板宁可不显示倒计时，也不要显示 NaN） */
export function parseClockSeconds(display: string): number {
  const parts = String(display ?? '').trim().split(':')
  if (parts.length === 0 || parts.length > 3) return 0
  let total = 0
  for (const p of parts) {
    const n = Number(p)
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return 0
    total = total * 60 + n
  }
  return total
}

/**
 * 番茄钟快照 → 对外三字段。
 *
 * 渲染层只上报 `display` + `progress`（权威状态机仍在渲染层，见 `main/pomodoroState.ts`），
 * 所以 `totalSeconds` 只能反推：`left / (1 - progress)`。progress 为 0 或 1 时反推不可靠，
 * 给 0 并在阶段 2 让渲染层直接上报精确值（届时本函数改成优先读精确字段）。
 */
export function pomoFromSource(src: PomoSource): DayPomo {
  const left = src.visible ? parseClockSeconds(src.display) : 0
  const total = left > 0 && src.progress > 0 && src.progress < 1
    ? Math.round(left / (1 - src.progress))
    : 0
  const state = !src.visible ? 0 : src.running ? 1 : left > 0 ? 2 : 0
  return { state, leftSeconds: left, totalSeconds: total }
}

/** 待办排序：未完成在前 → sort_order → created_at → id（与 UI 的稳定序一致） */
function compareTodo(a: DayTodoSource, b: DayTodoSource): number {
  const ad = a.status === 'done' ? 1 : 0
  const bd = b.status === 'done' ? 1 : 0
  if (ad !== bd) return ad - bd
  const ao = a.sort_order ?? 0
  const bo = b.sort_order ?? 0
  if (ao !== bo) return ao - bo
  const ac = a.created_at ?? ''
  const bc = b.created_at ?? ''
  if (ac !== bc) return ac < bc ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * 组装今日快照。
 *
 * `todos` 里可能有重复 id（今日列表 + 逾期列表的合并由调用方完成，那两段在语义上互斥，
 * 但浮动的计划类待办可能两边都命中）—— 这里按 id 去重，先到先得。
 */
export function buildDaySnapshot(input: {
  date: string
  todos: DayTodoSource[]
  habits: DayHabitSource[]
  pomo: PomoSource
}): DaySnapshot {
  const seen = new Set<string>()
  const todos: DayTodo[] = []
  for (const t of [...input.todos].sort(compareTodo)) {
    if (seen.has(t.id)) continue
    seen.add(t.id)
    todos.push({
      id: t.id,
      text: t.title,
      done: t.status === 'done',
      due: t.date,
      quadrant: typeof t.quadrant === 'number' ? t.quadrant : 1,
    })
  }
  return {
    date: input.date,
    todos,
    habits: input.habits.map(h => ({
      id: h.id,
      name: h.name,
      doneToday: !!h.doneToday,
      streak: Math.max(0, Math.trunc(h.streak)),
      target: Math.max(0, Math.trunc(h.target)),
    })),
    pomo: pomoFromSource(input.pomo),
  }
}
