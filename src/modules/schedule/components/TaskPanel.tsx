import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, GitBranch, Plus, Trash2 } from 'lucide-react'
import type { ScheduleTag, ScheduleTodo, ScheduleWorkflow } from '../../../types'
import {
  createScheduleTodo, createScheduleWorkflow, deleteScheduleTodo, getScheduleSubtasks,
  updateScheduleTodo,
} from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'
import { useScheduleUi } from '../ScheduleUiContext'
import { buildWorkflowFromTask } from '../workflowPure'

interface Props {
  task: ScheduleTodo
  tags: ScheduleTag[]
  workflow: ScheduleWorkflow | null
  onChanged: () => void
  onDeleted: () => void
}

interface FormState {
  title: string
  description: string
  date: string
  time: string
  tagId: string
  estimateMin: string
  start: string
  end: string
}

function toMin(hm: string): number | null {
  if (!/^\d{2}:\d{2}$/.test(hm)) return null
  return Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))
}

function toHm(min: number | null): string {
  if (min == null) return ''
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

function toDatetimeLocal(value: string | null): string {
  if (!value) return ''
  return value.replace(' ', 'T').slice(0, 16)
}

function formOf(task: ScheduleTodo): FormState {
  return {
    title: task.title,
    description: task.description || '',
    date: task.date,
    time: toDatetimeLocal(task.time),
    tagId: task.tagId || '',
    estimateMin: task.estimateMin != null ? String(task.estimateMin) : '',
    start: toHm(task.scheduledStart),
    end: toHm(task.scheduledEnd),
  }
}

const FIELD = 'w-full rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]'

export function TaskPanel({ task, tags, workflow, onChanged, onDeleted }: Props) {
  const { openWorkflow } = useScheduleUi()
  const [form, setForm] = useState<FormState>(() => formOf(task))
  const [subtasks, setSubtasks] = useState<ScheduleTodo[]>([])
  const [subtaskInput, setSubtaskInput] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const dirtyRef = useRef(false)
  const taskRef = useRef(task)
  taskRef.current = task

  useEffect(() => {
    dirtyRef.current = false
    setForm(formOf(task))
  }, [task.id])

  useEffect(() => {
    if (!dirtyRef.current) setForm(formOf(task))
  }, [task.updatedAt])

  useEffect(() => {
    let cancelled = false
    void getScheduleSubtasks(task.id).then(rows => { if (!cancelled) setSubtasks(rows) }).catch(() => {})
    return () => { cancelled = true }
  }, [task.id, task.updatedAt])

  useEffect(() => {
    if (!dirtyRef.current) return
    const timer = window.setTimeout(() => {
      const current = taskRef.current
      const title = form.title.trim()
      if (!title) return
      void updateScheduleTodo(current.id, {
        title,
        description: form.description,
        date: form.date,
        time: form.time ? form.time.replace('T', ' ') : null,
        tagId: form.tagId || null,
        estimateMin: form.estimateMin ? Number(form.estimateMin) : null,
        scheduledStart: toMin(form.start),
        scheduledEnd: toMin(form.end),
        expectedUpdatedAt: current.updatedAt,
      }).then(() => {
        dirtyRef.current = false
        onChanged()
      }).catch((e) => {
        const message = e instanceof Error && e.message.includes('TASK_CONFLICT') ? '任务已被其他窗口或 AI 修改' : '保存任务失败'
        showToast({ type: 'error', message, detail: e instanceof Error ? e.message : String(e) })
      })
    }, 400)
    return () => window.clearTimeout(timer)
  }, [form, onChanged])

  function patchForm(patch: Partial<FormState>) {
    dirtyRef.current = true
    setForm(prev => ({ ...prev, ...patch }))
  }

  async function toggleSubtask(row: ScheduleTodo) {
    try {
      await updateScheduleTodo(row.id, { status: row.status === 'done' ? 'pending' : 'done' })
      onChanged()
    } catch (e) {
      showToast({ type: 'error', message: '更新子任务失败', detail: e instanceof Error ? e.message : String(e) })
    }
  }

  // 主任务完成开关（v3.13.0 反馈 F-1）：修改态原本没有任何完成入口，完成只能回列表
  // 瞄准 16px 小框。与列表勾选同语义（toggle status），patch 不带 status 以外的字段，
  // 与表单的 400ms 防抖自动保存（不含 status）互不干扰。
  async function toggleDone() {
    const next = task.status === 'done' ? 'pending' : 'done'
    try {
      await updateScheduleTodo(task.id, { status: next })
      onChanged()
    } catch (e) {
      showToast({ type: 'error', message: '更新完成状态失败', detail: e instanceof Error ? e.message : String(e) })
    }
  }

  async function addSubtask() {
    const title = subtaskInput.trim()
    if (!title) return
    try {
      await createScheduleTodo({ title, date: task.date, parentId: task.id })
      setSubtaskInput('')
      setSubtasks(await getScheduleSubtasks(task.id))
      onChanged()
    } catch (e) {
      showToast({ type: 'error', message: '添加子任务失败', detail: e instanceof Error ? e.message : String(e) })
    }
  }

  async function removeSubtask(id: string) {
    try {
      await deleteScheduleTodo(id)
      setSubtasks(prev => prev.filter(x => x.id !== id))
      onChanged()
    } catch (e) {
      showToast({ type: 'error', message: '删除子任务失败', detail: e instanceof Error ? e.message : String(e) })
    }
  }

  async function buildWorkflow() {
    const tag = tags.find(t => t.id === task.tagId) ?? null
    const built = buildWorkflowFromTask(task, tag)
    try {
      const created = await createScheduleWorkflow({
        title: task.title,
        taskId: task.id,
        tagId: task.tagId,
        color: tag?.color,
        start: built.start,
        end: built.end,
        stages: built.stages.map(s => ({ title: s.title, start: s.start, end: s.end, status: s.status, milestone: s.milestone })),
      })
      showToast({ type: 'success', message: '已建立工作流' })
      openWorkflow(created.id)
      onChanged()
    } catch (e) {
      showToast({ type: 'error', message: '建立工作流失败', detail: e instanceof Error ? e.message : String(e) })
    }
  }

  async function removeTask() {
    try {
      await deleteScheduleTodo(task.id)
      showToast({ type: 'success', message: '任务已删除' })
      onDeleted()
    } catch (e) {
      showToast({ type: 'error', message: '删除任务失败', detail: e instanceof Error ? e.message : String(e) })
    }
  }

  const doneSubtasks = useMemo(() => subtasks.filter(s => s.status === 'done').length, [subtasks])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {/* 完成状态行（F-1）：视觉与列表勾选框同款圆圈，完成 / 重新打开一步到位 */}
        <button
          onClick={() => void toggleDone()}
          className={`mb-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] transition-colors ${task.status === 'done'
            ? 'bg-[var(--bg-selected)] text-[var(--text-secondary)]'
            : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
        >
          <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors ${task.status === 'done' ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--text-disabled)] text-transparent'}`}>
            <Check size={11} strokeWidth={3} />
          </span>
          {task.status === 'done' ? '已完成 · 点击重新打开' : '标记完成'}
        </button>

        <input
          value={form.title}
          onChange={e => patchForm({ title: e.target.value })}
          className="w-full bg-transparent text-[15px] font-medium text-[var(--text-primary)] outline-none"
          placeholder="任务标题"
        />

        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="col-span-2">
            <span className="mb-1 block text-[10.5px] text-[var(--text-muted)]">日期</span>
            <input type="date" value={form.date} onChange={e => patchForm({ date: e.target.value })} className={FIELD} />
          </label>
          <label>
            <span className="mb-1 block text-[10.5px] text-[var(--text-muted)]">开始</span>
            <input type="time" value={form.start} onChange={e => patchForm({ start: e.target.value })} className={FIELD} />
          </label>
          <label>
            <span className="mb-1 block text-[10.5px] text-[var(--text-muted)]">结束</span>
            <input type="time" value={form.end} onChange={e => patchForm({ end: e.target.value })} className={FIELD} />
          </label>
          <label className="col-span-2">
            <span className="mb-1 block text-[10.5px] text-[var(--text-muted)]">截止</span>
            <input type="datetime-local" value={form.time} onChange={e => patchForm({ time: e.target.value })} className={FIELD} />
          </label>
          <label>
            <span className="mb-1 block text-[10.5px] text-[var(--text-muted)]">标签</span>
            <select value={form.tagId} onChange={e => patchForm({ tagId: e.target.value })} className={FIELD}>
              <option value="">无</option>
              {tags.map(tag => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-[10.5px] text-[var(--text-muted)]">预计分钟</span>
            <input type="number" min={1} value={form.estimateMin} onChange={e => patchForm({ estimateMin: e.target.value })} className={FIELD} placeholder="可选" />
          </label>
        </div>

        <label className="mt-3 block">
          <span className="mb-1 block text-[10.5px] text-[var(--text-muted)]">备注</span>
          <textarea value={form.description} onChange={e => patchForm({ description: e.target.value })} rows={4} className={`${FIELD} resize-none`} placeholder="补充说明" />
        </label>

        <section className="mt-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10.5px] font-medium text-[var(--text-muted)]">子任务 · {doneSubtasks}/{subtasks.length}</span>
          </div>
          <div className="space-y-1">
            {subtasks.map(sub => (
              <div key={sub.id} className="group flex items-center gap-1.5 rounded-md bg-[var(--bg-secondary)] px-2 py-1.5">
                <button onClick={() => void toggleSubtask(sub)} className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${sub.status === 'done' ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--text-disabled)] text-transparent'}`}>
                  <Check size={9} strokeWidth={3} />
                </button>
                <span className={`min-w-0 flex-1 truncate text-[11.5px] ${sub.status === 'done' ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-secondary)]'}`}>{sub.title}</span>
                <button onClick={() => void removeSubtask(sub.id)} className="text-[var(--text-disabled)] opacity-0 hover:text-[var(--danger)] group-hover:opacity-100"><Trash2 size={11} /></button>
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex gap-1">
            <input value={subtaskInput} onChange={e => setSubtaskInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void addSubtask() }} placeholder="添加子任务" className={`${FIELD} flex-1`} />
            <button onClick={() => void addSubtask()} className="rounded-md border border-[var(--border-color)] px-2 text-[var(--text-muted)] hover:text-[var(--accent)]"><Plus size={12} /></button>
          </div>
        </section>

        <section className="mt-4 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-2.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
            <GitBranch size={12} /> 工作流
          </div>
          {workflow ? (
            <button onClick={() => openWorkflow(workflow.id)} className="mt-1.5 flex w-full items-center gap-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-2 text-left hover:border-[var(--accent)]">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: workflow.color }} />
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-primary)]">{workflow.title}</span>
              <span className="text-[10px] text-[var(--text-muted)]">{workflow.stages.filter(s => s.status === 'done').length}/{workflow.stages.length}</span>
            </button>
          ) : (
            <button onClick={() => void buildWorkflow()} className="mt-1.5 w-full rounded-md border border-dashed border-[var(--border-color)] px-2 py-2 text-[11.5px] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]">
              建立工作流（自动 3 阶段）
            </button>
          )}
        </section>
      </div>

      <div className="shrink-0 border-t border-[var(--border-color)] p-2.5">
        {confirmDelete ? (
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 text-[11px] text-[var(--danger)]">删除任务并级联删除工作流？</span>
            <button onClick={() => setConfirmDelete(false)} className="rounded px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]">取消</button>
            <button onClick={() => void removeTask()} className="rounded bg-[var(--danger)] px-2 py-1 text-[11px] text-white">删除</button>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)} className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--danger)]">
            <Trash2 size={12} /> 删除任务
          </button>
        )}
      </div>
    </div>
  )
}
