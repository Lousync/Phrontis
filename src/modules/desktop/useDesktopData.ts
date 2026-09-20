/**
 * 桌面外壳 —— 数据层
 *
 * 一处集中拉取磁贴需要的真实数据，并暴露「就地办事」所需的写回函数。
 * 写回后广播 `notifyDataChanged`（铁律 1：主进程写盘后广播、各面板重拉），
 * 再从本窗口的 `useDataChanged` 收到回声重新拉取 —— 这样磁贴与模块内的
 * 数据永远同一份，不会出现「桌面上勾了、日程里还是没勾」。
 *
 * 数据源全部走既有 IPC，不新开通道（也不碰 `.knowbase` 写白名单）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getScheduleTodos, updateScheduleTodo,
  habitGetAll, toggleHabitCheck,
  getKnowledgePages, getKnowledgeCategories, getKnowledgeTags,
  getMomentsPosts, listSummaries,
} from '../../lib/ipc'
import { useDataChanged } from '../../lib/dataChanged'
import type {
  ScheduleTodo, Habit, HabitRecord, KnowledgePage, KnowledgeCategory,
  KnowledgeTag, MomentsPost, SummaryRecord,
} from '../../types'

/* ---------------- 日期小工具（全部按本地时区，不用 toISOString 免得跨时区串日） ---------------- */

export function isoDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function todayIso(): string {
  return isoDate(new Date())
}

export function shiftDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1)
  dt.setDate(dt.getDate() + delta)
  return isoDate(dt)
}

export interface DesktopData {
  today: string
  todos: ScheduleTodo[]
  habits: Habit[]
  records: HabitRecord[]
  pages: KnowledgePage[]
  categories: KnowledgeCategory[]
  tags: KnowledgeTag[]
  moments: MomentsPost[]
  /** 层级总结文件（周 / 月 / 年），供日程面板的总结入口判断是否已生成 */
  summaries: SummaryRecord[]
  loaded: boolean
  /** 桌面上的打卡/勾待办：写回后端 */
  toggleTodo: (id: string, done: boolean) => Promise<void>
  toggleHabit: (habitId: string) => Promise<void>
  /** 切换指定日期的打卡（与 toggleHabit 同源乐观更新，但允许指定日期） */
  toggleHabitOn: (habitId: string, date: string) => Promise<void>
  /** 手动重拉（「刷新」按钮 / 外部文件系统变更后） */
  refresh: () => void
}

export function useDesktopData(): DesktopData {
  const [today, setToday] = useState(todayIso)
  const [todos, setTodos] = useState<ScheduleTodo[]>([])
  const [habits, setHabits] = useState<Habit[]>([])
  const [records, setRecords] = useState<HabitRecord[]>([])
  const [pages, setPages] = useState<KnowledgePage[]>([])
  const [categories, setCategories] = useState<KnowledgeCategory[]>([])
  const [tags, setTags] = useState<KnowledgeTag[]>([])
  const [moments, setMoments] = useState<MomentsPost[]>([])
  const [summaries, setSummaries] = useState<SummaryRecord[]>([])
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    // 每个源独立 catch：仓库没打开 / 某个模块数据坏掉时，其余磁贴照常显示
    const day = todayIso()
    setToday(day)
    const [td, hb, pg, cat, tg, mo, sm] = await Promise.all([
      getScheduleTodos(day).catch(() => [] as ScheduleTodo[]),
      habitGetAll().catch(() => ({ habits: [] as Habit[], records: [] as HabitRecord[] })),
      getKnowledgePages().catch(() => [] as KnowledgePage[]),
      getKnowledgeCategories().catch(() => [] as KnowledgeCategory[]),
      getKnowledgeTags().catch(() => [] as KnowledgeTag[]),
      getMomentsPosts().catch(() => [] as MomentsPost[]),
      listSummaries().catch(() => [] as SummaryRecord[]),
    ])
    setTodos(Array.isArray(td) ? td : [])
    setHabits(Array.isArray(hb?.habits) ? hb.habits.filter((h) => !h.archived) : [])
    setRecords(Array.isArray(hb?.records) ? hb.records : [])
    setPages(Array.isArray(pg) ? pg : [])
    setCategories(Array.isArray(cat) ? cat : [])
    setTags(Array.isArray(tg) ? tg : [])
    setMoments(Array.isArray(mo) ? mo : [])
    setSummaries(Array.isArray(sm) ? sm : [])
    setLoaded(true)
  }, [])

  useEffect(() => { void load() }, [load])

  // 跨窗口 / 模块间同步：任一作用域变更都重拉（桌面横跨四个模块，索性都订阅）
  useDataChanged('schedule', () => { void load() })
  useDataChanged('habit', () => { void load() })
  useDataChanged('knowledge', () => { void load() })
  useDataChanged('blog', () => { void load() })

  // 跨天自动翻页：桌面通常长开，午夜后「今天」必须自己走到新的一天
  useEffect(() => {
    const t = window.setInterval(() => {
      if (todayIso() !== today) void load()
    }, 60_000)
    return () => window.clearInterval(t)
  }, [today, load])

  const toggleTodo = useCallback(async (id: string, done: boolean): Promise<void> => {
    // 乐观更新：桌面勾选要「立刻有反应」，失败时 load() 会把真相拉回来
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, status: done ? 'done' : 'pending' } : t)))
    try {
      await updateScheduleTodo(id, { status: done ? 'done' : 'pending' })
    } finally {
      void load()
    }
  }, [load])

  const toggleHabit = useCallback(async (habitId: string): Promise<void> => {
    const day = todayIso()
    const has = records.some((r) => r.habitId === habitId && r.date === day)
    setRecords((prev) => has
      ? prev.filter((r) => !(r.habitId === habitId && r.date === day))
      : [...prev, { id: `optimistic-${habitId}-${day}`, habitId, date: day }])
    try {
      await toggleHabitCheck(habitId, day)
    } finally {
      void load()
    }
  }, [records, load])

  const toggleHabitOn = useCallback(async (habitId: string, date: string): Promise<void> => {
    // 与 toggleHabit 同一套乐观更新，但允许指定日期（IPC 本来就支持任意日期）
    const has = records.some((r) => r.habitId === habitId && r.date === date)
    setRecords((prev) => has
      ? prev.filter((r) => !(r.habitId === habitId && r.date === date))
      : [...prev, { id: `optimistic-${habitId}-${date}`, habitId, date }])
    try {
      await toggleHabitCheck(habitId, date)
    } finally {
      void load()
    }
  }, [records, load])

  return {
    today, todos, habits, records, pages, categories, tags, moments, summaries,
    loaded, toggleTodo, toggleHabit, toggleHabitOn, refresh: () => { void load() },
  }
}

/* ---------------- 派生数据（纯计算，组件里直接调用） ---------------- */

/** 某天是否「有打卡」（当天存在任一习惯记录即算） */
export function hasCheckOn(records: HabitRecord[], date: string): boolean {
  return records.some((r) => r.date === date)
}

/** 连续打卡天数：从今天往回数；今天还没打就从昨天起算（当天没打不该把之前的连续清零） */
export function checkinStreak(records: HabitRecord[], today: string): number {
  let n = 0
  let d = hasCheckOn(records, today) ? today : shiftDays(today, -1)
  // 上限 400 天：数据异常时不至于把主线程转死
  while (n < 400 && hasCheckOn(records, d)) { n += 1; d = shiftDays(d, -1) }
  return n
}

/** 最近 n 天（含今天）的打卡热力序列，最早的在前 */
export function checkinHeat(records: HabitRecord[], today: string, n = 14): Array<{ date: string; on: boolean }> {
  const out: Array<{ date: string; on: boolean }> = []
  for (let i = n - 1; i >= 0; i--) {
    const d = shiftDays(today, -i)
    out.push({ date: d, on: hasCheckOn(records, d) })
  }
  return out
}

export interface DerivedStats {
  /** 全部页面数（不含草稿） */
  pageCount: number
  dirCount: number
  tagCount: number
  /** 附件数：汇总各页 frontmatter 的 `attachments`（仓库相对路径数组）。
   *  没有「数全部附件」的 IPC（附件按 owner 查询），就地算即可，且不产生额外往返。 */
  attachCount: number
  /** 今日待办：未完成 / 总数 */
  todoLeft: number
  todoTotal: number
  /** 今日习惯：已勾 / 计划数 */
  habitDone: number
  habitTotal: number
  streak: number
}

export function useDerived(data: DesktopData): DerivedStats {
  return useMemo(() => {
    const { today, todos, habits, records, pages, categories, tags } = data
    const list = Array.isArray(todos) ? todos : []
    return {
      pageCount: pages.length,
      dirCount: categories.filter((c) => c.categoryType === 'space').length || categories.length,
      tagCount: tags.length,
      attachCount: pages.reduce((n, p) => n + (p.attachments?.length ?? 0), 0),
      todoLeft: list.filter((t) => t.status !== 'done').length,
      todoTotal: list.length,
      habitDone: habits.filter((h) => records.some((r) => r.habitId === h.id && r.date === today)).length,
      habitTotal: habits.length,
      streak: checkinStreak(records, today),
    }
  }, [data])
}
