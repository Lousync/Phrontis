import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, GitBranch, ListTodo } from 'lucide-react'
import type { ScheduleTag, ScheduleTodo, ScheduleWorkflow } from '../../types'
import { getAllScheduleTodos, getScheduleTags, listScheduleWorkflows } from '../../lib/ipc'
import { useDataChanged } from '../../lib/dataChanged'
import { claimToastRight } from '../../lib/toastAvoid'
import { useScheduleUi, type SchedulePanelTab } from './ScheduleUiContext'
import { ScheduleAssistantPanel } from './ScheduleAssistantPanel'
import { TaskPanel } from './components/TaskPanel'
import { WorkflowPanel } from './components/WorkflowPanel'

const TABS: Array<{ id: SchedulePanelTab; label: string; Icon: typeof ListTodo }> = [
  { id: 'task', label: '任务', Icon: ListTodo },
  { id: 'workflow', label: '工作流', Icon: GitBranch },
  { id: 'ai', label: 'AI', Icon: Bot },
]

export function ScheduleRightPanel() {
  const { state, setPanelTab, clearSelection } = useScheduleUi()
  const rootRef = useRef<HTMLDivElement>(null)
  const [tasks, setTasks] = useState<ScheduleTodo[]>([])
  const [workflows, setWorkflows] = useState<ScheduleWorkflow[]>([])
  const [tags, setTags] = useState<ScheduleTag[]>([])

  const reload = useCallback(() => {
    void Promise.all([getAllScheduleTodos(), listScheduleWorkflows(), getScheduleTags()])
      .then(([nextTasks, nextWorkflows, nextTags]) => {
        setTasks(nextTasks)
        setWorkflows(nextWorkflows)
        setTags(nextTags)
      })
      .catch(() => {})
  }, [])

  useEffect(() => { reload() }, [reload])
  useDataChanged('schedule', reload)

  // Toast 避让：右栏盖住的右下角不属于 DOM（固定定位的 Toast 会被整块压住）。
  // 宽度用实测；面板随模块 Tab 被 `display:none` 隐藏时 IntersectionObserver 会再报一次，
  // 那次量到 0 宽 → 撤销登记，切到别的模块不会留下一个凭空偏左的 Toast（2026-11-24 收口）。
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const apply = () => {
      const width = el.getBoundingClientRect().width
      claimToastRight('schedule-right-panel', width > 0 ? width + 16 : null)
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    const io = new IntersectionObserver(apply, { threshold: 0 })
    io.observe(el)
    return () => {
      ro.disconnect()
      io.disconnect()
      claimToastRight('schedule-right-panel', null)
    }
  }, [])

  const task = useMemo(() => state.taskId ? tasks.find(t => t.id === state.taskId) ?? null : null, [tasks, state.taskId])
  const workflow = useMemo(() => state.workflowId ? workflows.find(w => w.id === state.workflowId) ?? null : null, [workflows, state.workflowId])
  const taskWorkflow = useMemo(() => task ? workflows.find(w => w.taskId === task.id) ?? null : null, [workflows, task])

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border-color)] px-2 py-1.5">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setPanelTab(id)}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${state.panelTab === id ? 'bg-[var(--accent)]/10 font-medium text-[var(--accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
          >
            <Icon size={11} />{label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1">
        {state.panelTab === 'ai' ? (
          <ScheduleAssistantPanel />
        ) : state.panelTab === 'task' ? (
          task ? (
            <TaskPanel
              task={task}
              tags={tags}
              workflow={taskWorkflow}
              onChanged={reload}
              onDeleted={() => { clearSelection(); reload() }}
            />
          ) : (
            <EmptyPanel text="选择一个任务查看详情" />
          )
        ) : workflow || state.newWorkflow ? (
          <WorkflowPanel
            workflow={workflow}
            newWorkflow={state.newWorkflow}
            tags={tags}
            onChanged={reload}
            onDeleted={() => { clearSelection(); reload() }}
          />
        ) : (
          <EmptyPanel text="选择一个工作流查看详情" />
        )}
      </div>
    </div>
  )
}

function EmptyPanel({ text }: { text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center text-[var(--text-disabled)]">
      <ListTodo size={20} strokeWidth={1.5} />
      <span className="text-[11.5px]">{text}</span>
    </div>
  )
}
