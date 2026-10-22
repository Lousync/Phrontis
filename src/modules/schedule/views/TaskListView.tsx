import { useMemo, useState } from 'react'
import { Inbox, Plus } from 'lucide-react'
import type { ScheduleTag, ScheduleTodo, ScheduleWorkflow } from '../../../types'
import type { ScheduleView } from '../types'
import { createScheduleTodo } from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'
import { ScheduleTaskRow } from '../components/ScheduleTaskRow'

interface Props {
  view: ScheduleView
  activeTag: string | null
  today: string
  tasks: ScheduleTodo[]
  tags: ScheduleTag[]
  workflows: ScheduleWorkflow[]
  onOpenTask: (task: ScheduleTodo) => void
  onToggle: (task: ScheduleTodo) => void
  onDelete: (task: ScheduleTodo) => void
  onChanged: () => void
}

const TITLE: Partial<Record<ScheduleView, string>> = {
  inbox: '收集箱',
  upcoming: '即将',
  done: '已完成',
  tag: '标签',
}

export function TaskListView({ view, activeTag, today, tasks, tags, workflows, onOpenTask, onToggle, onDelete, onChanged }: Props) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const tagById = useMemo(() => new Map(tags.map(t => [t.id, t])), [tags])
  const workflowTaskIds = useMemo(() => new Set(workflows.map(w => w.taskId).filter(Boolean) as string[]), [workflows])
  const activeTagRow = activeTag ? tagById.get(activeTag) : null

  const rows = useMemo(() => {
    if (view === 'inbox') return tasks.filter(t => t.status !== 'done' && t.date === '')
    if (view === 'upcoming') return tasks.filter(t => t.status !== 'done' && !!t.date && t.date > today)
    if (view === 'done') return tasks.filter(t => t.status === 'done')
    if (view === 'tag') return tasks.filter(t => t.status !== 'done' && t.tagId === activeTag)
    return []
  }, [view, tasks, today, activeTag])

  const grouped = useMemo(() => {
    const map = new Map<string, ScheduleTodo[]>()
    for (const task of rows) {
      const key = view === 'inbox' ? '未安排' : (task.date || '未安排')
      const list = map.get(key) || []
      list.push(task)
      map.set(key, list)
    }
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === '未安排') return -1
      if (b === '未安排') return 1
      return a.localeCompare(b)
    })
  }, [rows, view])

  async function addTask() {
    const title = input.trim()
    if (!title || busy) return
    setBusy(true)
    try {
      await createScheduleTodo({
        title,
        date: view === 'inbox' ? '' : today,
        tagId: view === 'tag' && activeTag ? activeTag : undefined,
      })
      setInput('')
      onChanged()
    } catch (e) {
      showToast({ type: 'error', message: '添加任务失败', detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const title = view === 'tag' ? (activeTagRow?.name || '标签') : (TITLE[view] || '任务')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-5 pb-3 pt-4">
        <div className="flex items-center gap-2">
          <h1 className="text-[19px] font-semibold text-[var(--text-primary)]">{title}</h1>
          {activeTagRow && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: activeTagRow.color }} />}
          <span className="rounded-full bg-[var(--bg-secondary)] px-2 py-0.5 text-[10.5px] text-[var(--text-muted)]">{rows.length}</span>
        </div>
        {view !== 'done' && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 focus-within:border-[var(--accent)]">
            <Plus size={14} className="shrink-0 text-[var(--accent)]" />
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void addTask() }}
              placeholder={view === 'inbox' ? '添加到收集箱' : '添加任务'}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
            />
            {input.trim() && <button onClick={() => void addTask()} disabled={busy} className="rounded bg-[var(--accent)] px-2 py-0.5 text-[11px] text-white disabled:opacity-40">添加</button>}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {rows.length === 0 ? (
          <div className="flex h-56 flex-col items-center justify-center gap-2 text-center text-[var(--text-disabled)]">
            <Inbox size={22} strokeWidth={1.5} />
            <p className="text-[12px]">{view === 'done' ? '还没有已完成任务' : '这里还是空的'}</p>
          </div>
        ) : (
          <div className="space-y-4">
            {grouped.map(([date, items]) => (
              <section key={date}>
                <h3 className="mb-1.5 text-[11px] font-medium text-[var(--text-muted)]">{date === '未安排' ? '未安排' : `${date.slice(5)} · ${items.length}`}</h3>
                <div className="space-y-1.5">
                  {items.map(task => (
                    <ScheduleTaskRow
                      key={task.id}
                      task={task}
                      tag={task.tagId ? tagById.get(task.tagId) : null}
                      hasWorkflow={workflowTaskIds.has(task.id)}
                      showDate={view === 'done' || view === 'tag'}
                      onOpen={onOpenTask}
                      onToggle={onToggle}
                      onDelete={onDelete}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
