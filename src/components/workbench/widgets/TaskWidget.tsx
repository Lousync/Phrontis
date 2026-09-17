import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check, Pencil, Trash2, CalendarClock,
  Plus, ChevronRight, ChevronDown, ExternalLink,
} from 'lucide-react'
import type { ScheduleTodo } from '../../../types'
import { localToday } from '../../../lib/date'
import {
  getScheduleTodos, getScheduleOverdue, getScheduleSubtasks,
  createScheduleTodo, updateScheduleTodo, deleteScheduleTodo,
} from '../../../lib/ipc'
import { notifyDataChanged, useDataChanged } from '../../../lib/dataChanged'
import { showToast } from '../../../lib/toast'
import { parseQuickDate } from '../../../daypanel/parseQuickDate'

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 'YYYY-MM-DD HH:mm' → 本地时间戳（各处理序与 ScheduleTodo.time 一致，空格视为本地时间） */
function parseLocalTime(s: string): number {
  return new Date(s.replace(' ', 'T')).getTime()
}
/** 距 now 的 +n 分钟，格式化为 'YYYY-MM-DD HH:mm'（与 ScheduleTodo.time / snoozeUntil 同口径） */
function addMinutesLocal(n: number): string {
  const d = new Date(Date.now() + n * 60 * 1000)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 距次日 00:00:05 的毫秒数（用于跨零点刷新定时器） */
function msUntilTomorrow(): number {
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5)
  return Math.max(1000, next.getTime() - now.getTime())
}

interface Props {
  /** 「打开日程模块」外链：主窗口语境 = 切日程标签；脱离小窗语境 = dayPanelOpenInMain */
  onOpenSchedule?: () => void
}

/**
 * 今日任务控件（v3.4.0 批次4：DayPanel「日程」Tab 抽为可嵌入控件，方案 §3.7）。
 *
 * **右栏简略视图与脱离小窗共用本组件**（不复制渲染）。自包含数据加载：
 * 逾期置顶红分组 → 今日任务（子任务展开一级）→ 快速添加（轻量时间解析）。
 * 数据与日程模块完全同源（同一组 IPC + data-changed 广播）。
 */
export function TaskWidget({ onOpenSchedule }: Props) {
  const [todayStr, setTodayStr] = useState(() => localToday())
  const todayDate = useMemo(() => {
    const [y, m, d] = todayStr.split('-').map(Number)
    return new Date(y, m - 1, d)
  }, [todayStr])

  const [todos, setTodos] = useState<ScheduleTodo[]>([])
  const [overdue, setOverdue] = useState<ScheduleTodo[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const expandedRef = useRef<Set<string>>(new Set())
  const [subtasks, setSubtasks] = useState<Record<string, ScheduleTodo[]>>({})
  const [editing, setEditing] = useState<{ id: string; title: string; date: string; time: string } | null>(null)
  const [quick, setQuick] = useState('')
  const [manualTime, setManualTime] = useState<string | null>(null)

  // 跨零点自动翻页
  useEffect(() => {
    let timer: number | undefined
    const tick = () => {
      timer = window.setTimeout(() => { setTodayStr(localToday()); tick() }, msUntilTomorrow())
    }
    tick()
    return () => { if (timer) window.clearTimeout(timer) }
  }, [])

  const load = useCallback(async () => {
    try {
      const [todayList, od] = await Promise.all([
        getScheduleTodos(todayStr),
        getScheduleOverdue(todayStr),
      ])
      setTodos(todayList)
      setOverdue(od)
      for (const pid of expandedRef.current) {
        void getScheduleSubtasks(pid).then(subs => {
          setSubtasks(m => ({ ...m, [pid]: subs }))
        }).catch(() => { /* ignore */ })
      }
    } catch (e) {
      console.error('[TaskWidget] 加载失败', e)
    }
  }, [todayStr])

  useEffect(() => { void load() }, [load])
  useDataChanged('schedule', load)

  const topTodos = useMemo(() => todos.filter(t => !t.parentId), [todos])
  const pendingCount = topTodos.filter(t => t.status === 'pending').length
  const doneCount = topTodos.filter(t => t.status === 'done').length

  const parsed = useMemo(() => parseQuickDate(quick, todayDate), [quick, todayDate])
  // 快速添加固定为今日琐碎任务：日期强制今天，时间可用解析结果或手动填
  const finalTime = manualTime !== null ? manualTime : parsed.time

  const toggleStatus = useCallback(async (t: ScheduleTodo) => {
    const next = t.status === 'done' ? 'pending' : 'done'
    setTodos(cur => cur.map(x => (x.id === t.id ? { ...x, status: next } : x)))
    setOverdue(cur => cur.map(x => (x.id === t.id ? { ...x, status: next } : x)))
    try {
      await updateScheduleTodo(t.id, { status: next })
      notifyDataChanged('schedule')
    } catch (e) {
      console.error('[TaskWidget] 更新状态失败', e)
      void load()
    }
  }, [load])

  const moveToToday = useCallback(async (id: string) => {
    try {
      await updateScheduleTodo(id, { date: todayStr })
      notifyDataChanged('schedule')
      showToast({ type: 'info', message: '已改到今天' })
    } catch (e) {
      console.error('[TaskWidget] 迁移失败', e)
      void load()
    }
  }, [todayStr, load])

  const removeTodo = useCallback(async (t: ScheduleTodo) => {
    if (!window.confirm(`删除任务「${t.title}」？`)) return
    try {
      await deleteScheduleTodo(t.id)
      notifyDataChanged('schedule')
    } catch (e) {
      console.error('[TaskWidget] 删除失败', e)
      void load()
    }
  }, [load])

  const saveEdit = useCallback(async () => {
    if (!editing) return
    const title = editing.title.trim()
    if (!title) { setEditing(null); return }
    try {
      await updateScheduleTodo(editing.id, { title, date: editing.date, time: editing.time || null })
      setEditing(null)
      notifyDataChanged('schedule')
    } catch (e) {
      console.error('[TaskWidget] 保存失败', e)
      void load()
    }
  }, [editing, load])

  const toggleExpand = useCallback(async (pid: string) => {
    const next = new Set(expandedRef.current)
    if (next.has(pid)) next.delete(pid)
    else next.add(pid)
    expandedRef.current = next
    setExpanded(next)
    try {
      const subs = await getScheduleSubtasks(pid)
      setSubtasks(m => ({ ...m, [pid]: subs }))
    } catch { /* ignore */ }
  }, [])

  const addQuick = useCallback(async () => {
    const title = parsed.title.trim()
    if (!title) return
    try {
      // 快速添加 = 今日琐碎任务（daily）：日期固定今天，时间可解析/手填
      await createScheduleTodo({ title, date: todayStr, time: finalTime || undefined, taskType: 'daily' })
      setQuick('')
      setManualTime(null)
      notifyDataChanged('schedule')
      showToast({ type: 'info', message: `已添加今日琐碎：${title}` })
    } catch (e) {
      console.error('[TaskWidget] 快速添加失败', e)
      showToast({ type: 'error', message: '添加失败，请重试' })
    }
  }, [parsed, finalTime, todayStr])

  // ---- 行渲染 ----
  function taskRow(t: ScheduleTodo, isOverdue: boolean) {
    const done = t.status === 'done'
    const isParent = !t.parentId
    const hasChevron = isParent
    const isEditing = editing?.id === t.id
    return (
      <div key={t.id}>
        <div className="group flex items-center gap-1.5 rounded-md px-1.5 py-1.5 hover:bg-[var(--bg-hover)]">
          {hasChevron ? (
            <button onClick={() => void toggleExpand(t.id)} className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="展开/收起子任务">
              {expanded.has(t.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <button
            onClick={() => void toggleStatus(t)}
            className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors ${
              done ? 'border-[var(--success)] bg-[var(--success)] text-white' : 'border-[var(--border-color)] hover:border-[var(--text-secondary)]'
            }`}
            title={done ? '标记未完成' : '标记完成'}
          >
            {done && <Check size={10} strokeWidth={3} />}
          </button>
          <span className={`flex-1 truncate text-xs ${done ? 'text-[var(--text-muted)] line-through' : ''} ${isOverdue && !done ? 'text-[var(--danger)]' : ''}`}>{t.title}</span>
          {isOverdue && !done && (
            <button onClick={() => void moveToToday(t.id)} className="hidden shrink-0 text-[var(--text-muted)] hover:text-[var(--accent)] group-hover:block" title="改到今天">
              <CalendarClock size={12} />
            </button>
          )}
          <button onClick={() => setEditing({ id: t.id, title: t.title, date: t.date, time: t.time ?? '' })} className="hidden shrink-0 text-[var(--text-muted)] hover:text-[var(--accent)] group-hover:block" title="编辑">
            <Pencil size={12} />
          </button>
          <button onClick={() => void removeTodo(t)} className="hidden shrink-0 text-[var(--text-muted)] hover:text-[var(--danger)] group-hover:block" title="删除">
            <Trash2 size={12} />
          </button>
          {t.time && <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{t.time}</span>}
          {t.tag && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: t.tag.color }} title={t.tag.name} />}
        </div>
        {isEditing && editing && (
          <div className="mx-1.5 mb-1 space-y-1.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] p-2">
            <input
              autoFocus
              value={editing.title}
              onChange={e => setEditing({ ...editing, title: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') void saveEdit(); if (e.key === 'Escape') setEditing(null) }}
              className="w-full rounded border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)]"
              placeholder="任务标题"
            />
            <div className="flex items-center gap-1.5">
              <input type="date" value={editing.date} onChange={e => setEditing({ ...editing, date: e.target.value })} className="min-w-0 flex-1 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] px-1.5 py-1 text-xs outline-none focus:border-[var(--accent)]" />
              <input type="time" value={editing.time} onChange={e => setEditing({ ...editing, time: e.target.value })} className="min-w-0 w-24 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] px-1.5 py-1 text-xs outline-none focus:border-[var(--accent)]" />
              <button onClick={() => void saveEdit()} className="rounded bg-[var(--accent)] px-2 py-1 text-xs text-white hover:opacity-90">保存</button>
              <button onClick={() => setEditing(null)} className="rounded border border-[var(--border-color)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">取消</button>
            </div>
          </div>
        )}
        {hasChevron && expanded.has(t.id) && (
          <div className="ml-6 border-l border-[var(--border-color)] pl-1.5">
            {(subtasks[t.id] ?? []).map(sub => (
              <div key={sub.id} className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-[var(--bg-hover)]">
                <button
                  onClick={() => void toggleStatus(sub)}
                  className={`flex h-3 w-3 shrink-0 items-center justify-center rounded border transition-colors ${
                    sub.status === 'done' ? 'border-[var(--success)] bg-[var(--success)] text-white' : 'border-[var(--border-color)]'
                  }`}
                >
                  {sub.status === 'done' && <Check size={8} strokeWidth={3} />}
                </button>
                <span className={`flex-1 truncate text-[11px] ${sub.status === 'done' ? 'text-[var(--text-muted)] line-through' : ''}`}>{sub.title}</span>
                <button onClick={() => void removeTodo(sub)} className="hidden shrink-0 text-[var(--text-muted)] hover:text-[var(--danger)] group-hover:block" title="删除">
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
            {(subtasks[t.id] ?? []).length === 0 && <p className="px-1.5 py-1 text-[11px] text-[var(--text-muted)]">无子任务</p>}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* 逾期 */}
      {overdue.length > 0 && (
        <section>
          <p className="mb-1 px-1 text-[11px] font-medium text-[var(--danger)]">⏰ 逾期（{overdue.length}）</p>
          <div className="space-y-0.5">{overdue.map(t => taskRow(t, true))}</div>
        </section>
      )}

      {/* 今日任务 */}
      <section>
        <div className="mb-1 flex items-center justify-between gap-1 px-1">
          <p className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-primary)]">
            <span className="font-medium">今天 · {todayDate.getMonth() + 1}月{todayDate.getDate()}日 {WEEKDAY_LABELS[todayDate.getDay()]}</span>
            <span className="ml-1 text-[var(--text-muted)]">（{pendingCount} 待办 / {doneCount} 完成）</span>
          </p>
          {onOpenSchedule && (
            <button
              onClick={onOpenSchedule}
              className="inline-flex shrink-0 items-center text-[var(--text-muted)] hover:text-[var(--accent)]"
              title="打开日程模块管理"
            >
              <ExternalLink size={11} />
            </button>
          )}
        </div>
        <div className="space-y-0.5">{topTodos.map(t => taskRow(t, false))}</div>
        {topTodos.length === 0 && (
          <p className="px-1 py-2 text-[11px] text-[var(--text-muted)]">今天暂无任务，下方快速添加一条吧</p>
        )}
        {/* 快速添加 */}
        <div className="mt-2 px-0.5">
          <div className="flex items-center gap-1.5">
            <input
              value={quick}
              onChange={e => { setQuick(e.target.value); setManualTime(null) }}
              onKeyDown={e => { if (e.key === 'Enter') void addQuick() }}
              placeholder="添加任务"
              className="min-w-0 flex-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1.5 text-[11px] outline-none focus:border-[var(--accent)]"
            />
            <button
              onClick={() => void addQuick()}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--accent)] text-white hover:opacity-90"
              title="添加（回车）"
            >
              <Plus size={14} />
            </button>
          </div>
          {quick.trim() && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 px-1 text-[11px] text-[var(--text-muted)]">
              <span className="rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[11px] text-[var(--accent)]">今天</span>
              <input
                type="time"
                value={finalTime ?? ''}
                onChange={e => setManualTime(e.target.value || null)}
                title="时间（可填写 / 修改）"
                className="w-[74px] rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-1 py-0.5 text-[11px] text-[var(--accent)] outline-none focus:border-[var(--accent)]"
              />
              {manualTime !== null && (
                <button
                  onClick={() => setManualTime(null)}
                  className="rounded px-1 py-0.5 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]"
                  title="恢复自动解析时间"
                >
                  重解析
                </button>
              )}
              <span className="min-w-0 flex-1 truncate" title={parsed.title}>{parsed.title || '（空）'}</span>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

/** 导出给 DayPanel 脱离窗口复用（「稍后」打盹的同口径时间工具） */
export { addMinutesLocal, parseLocalTime }
