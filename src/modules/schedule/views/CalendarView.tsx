import { useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import type { CalendarMode, ScheduleTag, ScheduleTodo, ScheduleWorkflow } from '../types'
import { updateScheduleWorkflowStage } from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'
import { addWorkflowDays } from '../workflowPure'

interface Props {
  mode: CalendarMode
  date: string
  tasks: ScheduleTodo[]
  workflows: ScheduleWorkflow[]
  tags: ScheduleTag[]
  onModeChange: (mode: CalendarMode) => void
  onDateChange: (date: string) => void
  onOpenTask: (task: ScheduleTodo) => void
  onOpenWorkflow: (workflowId: string) => void
  onNewWorkflow: () => void
  onChanged: () => void
}

const DAY_MS = 86400000
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
const MODES: Array<{ id: CalendarMode; label: string }> = [
  { id: 'day', label: '日' },
  { id: 'week', label: '周' },
  { id: 'month', label: '月' },
  { id: 'quarter', label: '季' },
]

function parse(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function add(date: string, days: number): string {
  return fmt(new Date(parse(date).getTime() + days * DAY_MS))
}

function monday(date: string): string {
  const d = parse(date)
  const offset = (d.getDay() + 6) % 7
  return add(date, -offset)
}

function monthStart(date: string): string {
  const d = parse(date)
  return fmt(new Date(d.getFullYear(), d.getMonth(), 1))
}

function monthEnd(date: string): string {
  const d = parse(date)
  return fmt(new Date(d.getFullYear(), d.getMonth() + 1, 0))
}

function addMonths(date: string, n: number): string {
  const d = parse(date)
  return fmt(new Date(d.getFullYear(), d.getMonth() + n, 1))
}

function diffDays(a: string, b: string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / DAY_MS)
}

function rangeLabel(mode: CalendarMode, date: string): string {
  if (mode === 'month') {
    const d = parse(date)
    return `${d.getFullYear()}年${d.getMonth() + 1}月`
  }
  if (mode === 'quarter') {
    const d = parse(date)
    return `${d.getFullYear()}年 Q${Math.floor(d.getMonth() / 3) + 1}`
  }
  if (mode === 'day') return `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`
  const start = monday(date)
  return `${start.slice(5)} – ${add(start, 6).slice(5)}`
}

function shiftDate(mode: CalendarMode, date: string, dir: number): string {
  if (mode === 'day') return add(date, dir)
  if (mode === 'week') return add(date, dir * 7)
  if (mode === 'month') return addMonths(date, dir)
  return addMonths(date, dir * 3)
}

export function CalendarView(props: Props) {
  const { mode, date, workflows, tasks, onModeChange, onDateChange, onOpenTask, onOpenWorkflow, onNewWorkflow, onChanged } = props
  const [showWorkflows, setShowWorkflows] = useState(true)
  const tagById = useMemo(() => new Map(props.tags.map(t => [t.id, t])), [props.tags])
  const taskByDate = useMemo(() => {
    const map = new Map<string, ScheduleTodo[]>()
    for (const task of tasks) {
      if (!task.date) continue
      const list = map.get(task.date) || []
      list.push(task)
      map.set(task.date, list)
    }
    return map
  }, [tasks])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-color)] px-4 py-2">
        <div className="flex items-center gap-0.5">
          <button onClick={() => onDateChange(shiftDate(mode, date, -1))} className="rounded p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"><ChevronLeft size={14} /></button>
          <button onClick={() => onDateChange(fmt(new Date()))} className="rounded px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">今天</button>
          <button onClick={() => onDateChange(shiftDate(mode, date, 1))} className="rounded p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"><ChevronRight size={14} /></button>
        </div>
        <span className="text-[13px] font-medium text-[var(--text-primary)]">{rangeLabel(mode, date)}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <label className="inline-flex items-center gap-1 text-[10.5px] text-[var(--text-muted)]"><input type="checkbox" checked={showWorkflows} onChange={e => setShowWorkflows(e.target.checked)} />工作流</label>
          <div className="flex items-center rounded-md bg-[var(--bg-secondary)] p-0.5">
            {MODES.map(m => (
              <button key={m.id} onClick={() => onModeChange(m.id)} className={`rounded px-2 py-0.5 text-[10.5px] ${mode === m.id ? 'bg-[var(--bg-primary)] font-medium text-[var(--accent)] shadow-sm' : 'text-[var(--text-muted)]'}`}>{m.label}</button>
            ))}
          </div>
          <button onClick={onNewWorkflow} className="inline-flex items-center gap-1 rounded-md border border-[var(--border-color)] px-2 py-1 text-[10.5px] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"><Plus size={11} />工作流</button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {mode === 'month' ? (
          <MonthGrid date={date} tasks={taskByDate} workflows={showWorkflows ? workflows : []} tagById={tagById} onOpenTask={onOpenTask} onOpenWorkflow={onOpenWorkflow} />
        ) : mode === 'week' ? (
          <WeekGrid date={date} tasks={taskByDate} workflows={showWorkflows ? workflows : []} onOpenTask={onOpenTask} onOpenWorkflow={onOpenWorkflow} onChanged={onChanged} />
        ) : mode === 'quarter' ? (
          <QuarterGrid date={date} workflows={showWorkflows ? workflows : []} onOpenWorkflow={onOpenWorkflow} />
        ) : (
          <DayView date={date} tasks={taskByDate.get(date) || []} workflows={showWorkflows ? workflows : []} tagById={tagById} onOpenTask={onOpenTask} onOpenWorkflow={onOpenWorkflow} />
        )}
      </div>
    </div>
  )
}

function MonthGrid({ date, tasks, workflows, tagById, onOpenTask, onOpenWorkflow }: {
  date: string
  tasks: Map<string, ScheduleTodo[]>
  workflows: ScheduleWorkflow[]
  tagById: Map<string, ScheduleTag>
  onOpenTask: (task: ScheduleTodo) => void
  onOpenWorkflow: (workflowId: string) => void
}) {
  const start = monday(monthStart(date))
  const days = Array.from({ length: 42 }, (_, i) => add(start, i))
  const currentMonth = date.slice(0, 7)
  return (
    <div className="min-w-[680px] overflow-hidden rounded-lg border border-[var(--border-color)]">
      <div className="grid grid-cols-7 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]">
        {WEEKDAYS.map(d => <div key={d} className="px-2 py-1 text-center text-[10px] text-[var(--text-muted)]">{d}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {days.map(day => {
          const rows = tasks.get(day) || []
          const stageHits = workflows.flatMap(w => w.stages.filter(s => s.start <= day && s.end >= day).map(s => ({ w, s }))).slice(0, 2)
          return (
            <div key={day} className={`min-h-[92px] border-b border-r border-[var(--border-color)] p-1 ${day.slice(0, 7) === currentMonth ? 'bg-[var(--bg-primary)]' : 'bg-[var(--bg-secondary)]/40'}`}>
              <div className={`mb-1 text-right text-[10px] tabular-nums ${day === date ? 'font-semibold text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}>{Number(day.slice(8, 10))}</div>
              <div className="space-y-0.5">
                {rows.slice(0, 3).map(task => (
                  <button key={task.id} onClick={() => onOpenTask(task)} className="flex w-full items-center gap-1 rounded px-1 text-left text-[10px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
                    <span className={`h-1 w-1 shrink-0 rounded-full ${task.status === 'done' ? 'bg-[var(--text-disabled)]' : 'bg-[var(--accent)]'}`} />
                    <span className={`min-w-0 flex-1 truncate ${task.status === 'done' ? 'line-through opacity-60' : ''}`}>{task.title}</span>
                  </button>
                ))}
                {rows.length > 3 && <div className="px-1 text-[9.5px] text-[var(--text-disabled)]">+{rows.length - 3}</div>}
                {stageHits.map(({ w, s }) => (
                  <button key={`${w.id}:${s.id}`} onClick={() => onOpenWorkflow(w.id)} title={`${w.title} / ${s.title} / ${s.start} → ${s.end}`} className="block h-[2px] w-full rounded-full opacity-70 hover:opacity-100" style={{ backgroundColor: w.color }} />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function WeekGrid({ date, tasks, workflows, onOpenTask, onOpenWorkflow, onChanged }: {
  date: string
  tasks: Map<string, ScheduleTodo[]>
  workflows: ScheduleWorkflow[]
  onOpenTask: (task: ScheduleTodo) => void
  onOpenWorkflow: (workflowId: string) => void
  onChanged: () => void
}) {
  const start = monday(date)
  const days = Array.from({ length: 7 }, (_, i) => add(start, i))
  return (
    <div className="min-w-[760px] space-y-2">
      {workflows.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <div className="grid border-b border-[var(--border-color)] text-[10px] text-[var(--text-muted)]" style={{ gridTemplateColumns: '120px repeat(7, minmax(0, 1fr))' }}>
            <div className="px-2 py-1">工作流</div>
            {days.map(d => <div key={d} className="border-l border-[var(--border-color)] px-1 py-1 text-center">{d.slice(5)}</div>)}
          </div>
          {workflows.map(w => (
            <div key={w.id} className="grid border-b border-[var(--border-color)] last:border-b-0" style={{ gridTemplateColumns: '120px repeat(7, minmax(0, 1fr))' }}>
              <button onClick={() => onOpenWorkflow(w.id)} className="flex items-center gap-1 truncate px-2 py-1.5 text-left text-[10.5px] text-[var(--text-secondary)] hover:text-[var(--accent)]" title={w.title}>
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: w.color }} />
                <span className="truncate">{w.title}</span>
              </button>
              <div className="relative col-span-7 grid" style={{ gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' }}>
                {days.map(d => <div key={d} className="border-l border-[var(--border-color)]" />)}
                {w.stages.map(stage => {
                  const startIdx = Math.max(0, diffDays(start, stage.start))
                  const endIdx = Math.min(6, diffDays(start, stage.end))
                  if (endIdx < 0 || startIdx > 6) return null
                  return (
                    <StageBar
                      key={stage.id}
                      workflow={w}
                      stage={stage}
                      startIdx={startIdx}
                      endIdx={endIdx}
                      onOpen={() => onOpenWorkflow(w.id)}
                      onChanged={onChanged}
                    />
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="grid overflow-hidden rounded-lg border border-[var(--border-color)]" style={{ gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' }}>
        {days.map(day => (
          <div key={day} className="min-h-[260px] border-r border-[var(--border-color)] last:border-r-0">
            <div className={`border-b border-[var(--border-color)] px-1.5 py-1 text-center text-[10px] ${day === date ? 'bg-[var(--accent)]/10 font-semibold text-[var(--accent)]' : 'bg-[var(--bg-secondary)] text-[var(--text-muted)]'}`}>{day.slice(5)}</div>
            <div className="space-y-1 p-1">
              {(tasks.get(day) || []).map(task => (
                <button key={task.id} onClick={() => onOpenTask(task)} className="block w-full rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-1.5 py-1 text-left text-[10px] text-[var(--text-secondary)] hover:border-[var(--accent)]">
                  <span className={`block truncate ${task.status === 'done' ? 'line-through opacity-60' : ''}`}>{task.title}</span>
                  {task.scheduledStart != null && <span className="text-[9px] text-[var(--text-disabled)]">{String(Math.floor(task.scheduledStart / 60)).padStart(2, '0')}:{String(task.scheduledStart % 60).padStart(2, '0')}</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function StageBar({ workflow, stage, startIdx, endIdx, onOpen, onChanged }: {
  workflow: ScheduleWorkflow
  stage: ScheduleWorkflow['stages'][number]
  startIdx: number
  endIdx: number
  onOpen: () => void
  onChanged: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const dragRef = useRef<{ x: number; dx: number; moved: boolean } | null>(null)
  const [dx, setDx] = useState(0)
  const days = endIdx - startIdx + 1

  function finish() {
    const d = dragRef.current
    dragRef.current = null
    setDx(0)
    if (!d || !d.moved) { onOpen(); return }
    const width = ref.current?.parentElement?.clientWidth ?? 1
    const dayWidth = width / 7
    const shift = Math.round(d.dx / dayWidth)
    if (shift === 0) return
    void updateScheduleWorkflowStage(workflow.id, stage.id, {
      start: addWorkflowDays(stage.start, shift),
      end: addWorkflowDays(stage.end, shift),
    }).then(() => {
      showToast({ type: 'success', message: '阶段日期已调整' })
      onChanged()
    }).catch(e => showToast({ type: 'error', message: '调整失败', detail: e instanceof Error ? e.message : String(e) }))
  }

  return (
    <button
      ref={ref}
      onPointerDown={e => {
        e.stopPropagation()
        e.currentTarget.setPointerCapture(e.pointerId)
        dragRef.current = { x: e.clientX, dx: 0, moved: false }
      }}
      onPointerMove={e => {
        const d = dragRef.current
        if (!d) return
        const next = e.clientX - d.x
        d.dx = next
        if (Math.abs(next) > 3) d.moved = true
        setDx(next)
      }}
      onPointerUp={e => { e.stopPropagation(); finish() }}
      onPointerCancel={() => { dragRef.current = null; setDx(0) }}
      className="relative z-10 m-0.5 flex h-5 touch-none items-center overflow-hidden rounded px-1 text-left text-[9.5px] text-white/95"
      style={{ gridColumn: `${startIdx + 1} / span ${days}`, backgroundColor: workflow.color, transform: `translateX(${dx}px)`, opacity: stage.status === 'done' ? 0.55 : 1 }}
      title={`${workflow.title} / ${stage.title} / ${stage.start} → ${stage.end}`}
    >
      <span className="truncate">{stage.title}</span>
    </button>
  )
}

function QuarterGrid({ date, workflows, onOpenWorkflow }: { date: string; workflows: ScheduleWorkflow[]; onOpenWorkflow: (workflowId: string) => void }) {
  const d = parse(date)
  const qStartMonth = Math.floor(d.getMonth() / 3) * 3
  const qStart = fmt(new Date(d.getFullYear(), qStartMonth, 1))
  const start = monday(qStart)
  const weeks = Array.from({ length: 14 }, (_, i) => add(start, i * 7))
  return (
    <div className="min-w-[900px] overflow-hidden rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
      <div className="grid border-b border-[var(--border-color)] text-[9.5px] text-[var(--text-muted)]" style={{ gridTemplateColumns: `120px repeat(${weeks.length}, minmax(0, 1fr))` }}>
        <div className="px-2 py-1">工作流</div>
        {weeks.map(w => <div key={w} className="border-l border-[var(--border-color)] px-0.5 py-1 text-center">{w.slice(5)}</div>)}
      </div>
      {workflows.length === 0 ? <div className="py-8 text-center text-[11px] text-[var(--text-disabled)]">本季没有工作流</div> : workflows.map(w => (
        <div key={w.id} className="grid border-b border-[var(--border-color)] last:border-b-0" style={{ gridTemplateColumns: `120px repeat(${weeks.length}, minmax(0, 1fr))` }}>
          <button onClick={() => onOpenWorkflow(w.id)} className="flex items-center gap-1 truncate px-2 py-1.5 text-left text-[10.5px] text-[var(--text-secondary)] hover:text-[var(--accent)]"><span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: w.color }} /><span className="truncate">{w.title}</span></button>
          <div className="relative grid" style={{ gridColumn: '2 / -1', gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
            {weeks.map(wk => <div key={wk} className="border-l border-[var(--border-color)]" />)}
            {w.stages.map(stage => {
              const startIdx = Math.max(0, Math.floor(diffDays(start, stage.start) / 7))
              const endIdx = Math.min(weeks.length - 1, Math.floor(diffDays(start, stage.end) / 7))
              if (endIdx < 0 || startIdx >= weeks.length) return null
              return (
                <button key={stage.id} onClick={() => onOpenWorkflow(w.id)} title={`${stage.title} / ${stage.start} → ${stage.end}`} className="relative z-10 m-0.5 h-5 truncate rounded px-1 text-left text-[9px] text-white/95" style={{ gridColumn: `${startIdx + 1} / span ${endIdx - startIdx + 1}`, backgroundColor: w.color, opacity: stage.status === 'done' ? 0.55 : 1 }}>
                  {stage.title}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

function DayView({ date, tasks, workflows, tagById, onOpenTask, onOpenWorkflow }: {
  date: string
  tasks: ScheduleTodo[]
  workflows: ScheduleWorkflow[]
  tagById: Map<string, ScheduleTag>
  onOpenTask: (task: ScheduleTodo) => void
  onOpenWorkflow: (workflowId: string) => void
}) {
  const stages = workflows.flatMap(w => w.stages.filter(s => s.start <= date && s.end >= date).map(s => ({ w, s })))
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <section>
        <h3 className="mb-1.5 text-[11px] font-medium text-[var(--text-muted)]">当天任务 · {tasks.length}</h3>
        <div className="space-y-1.5">
          {tasks.length === 0 ? <p className="py-6 text-center text-[11.5px] text-[var(--text-disabled)]">没有任务</p> : tasks.map(task => (
            <button key={task.id} onClick={() => onOpenTask(task)} className="flex w-full items-center gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-left hover:border-[var(--accent)]">
              <span className={`h-1.5 w-1.5 rounded-full ${task.status === 'done' ? 'bg-[var(--text-disabled)]' : 'bg-[var(--accent)]'}`} />
              <span className={`min-w-0 flex-1 truncate text-[12px] ${task.status === 'done' ? 'line-through opacity-60' : 'text-[var(--text-primary)]'}`}>{task.title}</span>
              {task.tagId && tagById.get(task.tagId) && <span className="text-[10px] text-[var(--text-muted)]">{tagById.get(task.tagId)!.name}</span>}
              {task.scheduledStart != null && <span className="text-[10px] tabular-nums text-[var(--text-muted)]">{String(Math.floor(task.scheduledStart / 60)).padStart(2, '0')}:{String(task.scheduledStart % 60).padStart(2, '0')}</span>}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3 className="mb-1.5 text-[11px] font-medium text-[var(--text-muted)]">当天阶段 · {stages.length}</h3>
        <div className="space-y-1.5">
          {stages.length === 0 ? <p className="py-6 text-center text-[11.5px] text-[var(--text-disabled)]">没有工作流阶段</p> : stages.map(({ w, s }) => (
            <button key={`${w.id}:${s.id}`} onClick={() => onOpenWorkflow(w.id)} className="flex w-full items-center gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-left hover:border-[var(--accent)]">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: w.color }} />
              <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">{w.title} / {s.title}</span>
              <span className="text-[10px] text-[var(--text-muted)]">{s.start.slice(5)} → {s.end.slice(5)}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
