import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, ChevronDown, Clock3, Plus, Timer } from 'lucide-react'
import type { ScheduleTag, ScheduleTodo, ScheduleWorkflow } from '../../../types'
import { createScheduleTag, createScheduleTodo } from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'
import { Collapsible } from '../../../components/shared/Collapsible'
import { ScheduleTaskRow } from '../components/ScheduleTaskRow'
import { parseQuickAdd } from '../quickAddPure'

interface Props {
  today: string
  tasks: ScheduleTodo[]
  tags: ScheduleTag[]
  workflows: ScheduleWorkflow[]
  focusSignal: number
  onOpenTask: (task: ScheduleTodo) => void
  onToggle: (task: ScheduleTodo) => void
  onDelete: (task: ScheduleTodo) => void
  onChanged: () => void
}

function weekday(date: string): string {
  const d = new Date(date + 'T00:00:00')
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()] || ''
}

function minuteLabel(min: number | null, fallback: string | null): string {
  if (min != null) return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
  return fallback ? fallback.slice(11, 16) : ''
}

export function TodayView({ today, tasks, tags, workflows, focusSignal, onOpenTask, onToggle, onDelete, onChanged }: Props) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [timelineOpen, setTimelineOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const workflowTaskIds = useMemo(() => new Set(workflows.map(w => w.taskId).filter(Boolean) as string[]), [workflows])
  const tagById = useMemo(() => new Map(tags.map(t => [t.id, t])), [tags])

  useEffect(() => {
    if (focusSignal > 0) {
      inputRef.current?.focus()
      inputRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [focusSignal])

  const pending = tasks.filter(t => t.status !== 'done')
  const overdue = pending.filter(t => !!t.date && t.date < today).sort((a, b) => a.date.localeCompare(b.date))
  const todayTasks = pending.filter(t => t.date === today)
  const inbox = pending.filter(t => t.date === '')
  const doneToday = tasks.filter(t => t.status === 'done' && t.date === today)
  const scheduled = todayTasks.filter(t => t.scheduledStart != null || t.time)
  const estimate = todayTasks.reduce((sum, t) => sum + (t.estimateMin ?? 0), 0)

  // 退场（v3.13.0 反馈 F-1）：勾选完成的条目在本视图原位保留一拍，播 .kb-item-out
  // （划线 + 右移淡出，约 180ms）后移除 —— 「完成」要看得见，而不是无声消失。
  // 检测 = 上次渲染仍在 pending、本次消失且已 done 的条目；这里故意不用 effect cleanup
  // 撤定时器：广播刷新会让本 effect 频繁重跑，cleanup 会把进行中的退场计时清掉，
  // 幽灵行就永远留住了。定时器自会到期自摘。
  const [exiting, setExiting] = useState<Map<string, ScheduleTodo>>(new Map())
  const prevPendingRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const currentIds = new Set(pending.map(t => t.id))
    const justDone: ScheduleTodo[] = []
    prevPendingRef.current.forEach(id => {
      if (!currentIds.has(id)) {
        const t = tasks.find(x => x.id === id)
        if (t && t.status === 'done') justDone.push(t)
      }
    })
    prevPendingRef.current = currentIds
    if (justDone.length === 0) return
    setExiting(prev => {
      const next = new Map(prev)
      justDone.forEach(t => next.set(t.id, t))
      return next
    })
    window.setTimeout(() => {
      setExiting(prev => {
        const next = new Map(prev)
        justDone.forEach(t => next.delete(t.id))
        return next
      })
    }, 300)
  }, [tasks, pending])
  const exitRows = [...exiting.values()]
  const exitOverdue = exitRows.filter(t => !!t.date && t.date < today)
  const exitToday = exitRows.filter(t => t.date === today)
  const exitInbox = exitRows.filter(t => !t.date)

  async function addTask() {
    const raw = input.trim()
    if (!raw || busy) return
    setBusy(true)
    try {
      const parsed = parseQuickAdd(raw, tags)
      let tagId = parsed.tagId
      if (!tagId && parsed.tagName) {
        try {
          const tag = await createScheduleTag(parsed.tagName)
          tagId = tag.id
        } catch { /* tag creation is best effort */ }
      }
      await createScheduleTodo({
        title: parsed.title,
        date: parsed.date || today,
        time: parsed.deadline || undefined,
        taskType: parsed.deadline ? 'deadline' : 'plan',
        tagId: tagId || undefined,
        estimateMin: parsed.estimateMin,
      })
      setInput('')
      onChanged()
    } catch (e) {
      showToast({ type: 'error', message: '添加任务失败', detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  function timelineItems() {
    if (scheduled.length === 0) {
      return <p className="px-2 py-6 text-center text-[11.5px] text-[var(--text-disabled)]">今天还没有排定时段</p>
    }
    return (
      <div className="space-y-1.5">
        {scheduled.slice().sort((a, b) => (a.scheduledStart ?? 0) - (b.scheduledStart ?? 0)).map(t => (
          <button
            key={t.id}
            onClick={() => onOpenTask(t)}
            className="flex w-full items-start gap-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-2 text-left transition-colors hover:border-[var(--accent)]/50"
          >
            <span className="w-10 shrink-0 pt-0.5 text-[10.5px] tabular-nums text-[var(--text-muted)]">{minuteLabel(t.scheduledStart, t.time)}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">{t.title}</span>
          </button>
        ))}
      </div>
    )
  }

  function group(title: string, rows: ScheduleTodo[], tone = 'text-[var(--text-muted)]', exitRows: ScheduleTodo[] = []) {
    if (rows.length === 0 && exitRows.length === 0) return null
    return (
      <section>
        <h3 className={`mb-1.5 text-[11px] font-medium ${tone}`}>{title} · {rows.length}</h3>
        <div className="space-y-1.5">
          {rows.map(t => (
            <ScheduleTaskRow
              key={t.id}
              task={t}
              tag={t.tagId ? tagById.get(t.tagId) : null}
              hasWorkflow={workflowTaskIds.has(t.id)}
              onOpen={onOpenTask}
              onToggle={onToggle}
              onDelete={onDelete}
            />
          ))}
          {exitRows.map(t => (
            <ScheduleTaskRow
              key={t.id}
              task={t}
              tag={t.tagId ? tagById.get(t.tagId) : null}
              hasWorkflow={workflowTaskIds.has(t.id)}
              onOpen={onOpenTask}
              onToggle={onToggle}
              exiting
            />
          ))}
        </div>
      </section>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-5 pb-3 pt-4">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight text-[var(--text-primary)]">今天</h1>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">{today} · {weekday(today)}</p>
          </div>
          <div className="flex flex-wrap gap-2 text-[10.5px] text-[var(--text-muted)]">
            <span className="rounded-full bg-[var(--bg-secondary)] px-2 py-1">待办 {todayTasks.length}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-secondary)] px-2 py-1"><Clock3 size={10} />已排 {scheduled.length}</span>
            {estimate > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-secondary)] px-2 py-1"><Timer size={10} />{Math.round(estimate / 60 * 10) / 10}h</span>}
            <span className="rounded-full bg-[var(--bg-secondary)] px-2 py-1">完成 {doneToday.length}</span>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 focus-within:border-[var(--accent)]">
          <Plus size={14} className="shrink-0 text-[var(--accent)]" />
          <input
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void addTask() }}
            placeholder="添加任务，支持 #标签、1h、截止 18:00"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
          />
          {input.trim() && (
            <button onClick={() => void addTask()} disabled={busy} className="shrink-0 rounded bg-[var(--accent)] px-2 py-0.5 text-[11px] text-white disabled:opacity-40">
              添加
            </button>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden px-5 pb-4 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-h-0 overflow-y-auto pr-1">
          <div className="space-y-4">
            {group('逾期', overdue, 'text-[var(--danger)]', exitOverdue)}
            {group('今天', todayTasks, 'text-[var(--accent)]', exitToday)}
            {group('收集箱', inbox, 'text-[var(--text-muted)]', exitInbox)}
            {overdue.length + todayTasks.length + inbox.length + exitRows.length === 0 && (
              <div className="flex h-48 flex-col items-center justify-center gap-1.5 text-center text-[var(--text-disabled)]">
                <CalendarDays size={22} strokeWidth={1.5} />
                <p className="text-[12px]">今天没有待办</p>
              </div>
            )}
          </div>
        </div>

        <aside className="hidden min-h-0 overflow-y-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)]/40 p-2.5 xl:block">
          <h3 className="mb-2 px-1 text-[11px] font-medium text-[var(--text-muted)]">今日时间线</h3>
          {timelineItems()}
        </aside>

        <div className="xl:hidden">
          <button onClick={() => setTimelineOpen(v => !v)} className="flex w-full items-center justify-between rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-[11.5px] text-[var(--text-secondary)]">
            <span>今日时间线 · {scheduled.length}</span>
            <ChevronDown size={13} className={`kb-chevron ${timelineOpen ? 'rotate-180' : ''}`} />
          </button>
          <Collapsible open={timelineOpen}>
            {() => <div className="pt-2">{timelineItems()}</div>}
          </Collapsible>
        </div>
      </div>
    </div>
  )
}
