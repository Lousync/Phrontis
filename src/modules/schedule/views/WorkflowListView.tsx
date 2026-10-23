import { useMemo } from 'react'
import { GitBranch, Plus } from 'lucide-react'
import type { ScheduleTag, ScheduleTodo, ScheduleWorkflow } from '../../../types'
import { useScheduleUi } from '../ScheduleUiContext'
import { workflowProgress } from '../workflowPure'

interface Props {
  workflows: ScheduleWorkflow[]
  tasks: ScheduleTodo[]
  tags: ScheduleTag[]
  today: string
  onOpen: (workflowId: string) => void
}

type Group = 'active' | 'upcoming' | 'done'

function groupOf(flow: ScheduleWorkflow, today: string): Group {
  const p = workflowProgress(flow)
  if (p.total > 0 && p.done === p.total) return 'done'
  if (p.total === 0) return 'upcoming'
  if (flow.stages.some(s => s.status === 'doing') || flow.start <= today) return 'active'
  return 'upcoming'
}

const GROUP_LABEL: Record<Group, string> = { active: '进行中', upcoming: '未开始', done: '已完成' }

export function WorkflowListView({ workflows, tasks, tags, today, onOpen }: Props) {
  const { openNewWorkflow } = useScheduleUi()
  const taskById = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks])
  const tagById = useMemo(() => new Map(tags.map(t => [t.id, t])), [tags])
  const groups = useMemo(() => {
    const map: Record<Group, ScheduleWorkflow[]> = { active: [], upcoming: [], done: [] }
    for (const flow of workflows) map[groupOf(flow, today)].push(flow)
    for (const key of Object.keys(map) as Group[]) map[key].sort((a, b) => a.start.localeCompare(b.start))
    return map
  }, [workflows, today])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-[19px] font-semibold text-[var(--text-primary)]">工作流</h1>
          <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">{workflows.length} 个工作流 · 阶段顺序与日期自动保持一致</p>
        </div>
        <button onClick={openNewWorkflow} className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1.5 text-[11.5px] font-medium text-white transition-colors hover:bg-[var(--accent-hover)]">
          <Plus size={13} /> 新建工作流
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {workflows.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2 text-center text-[var(--text-disabled)]">
            <GitBranch size={24} strokeWidth={1.5} />
            <p className="text-[12px]">还没有工作流</p>
            <button onClick={openNewWorkflow} className="text-[11.5px] text-[var(--accent)] hover:underline">创建第一个工作流</button>
          </div>
        ) : (
          <div className="space-y-5">
            {(Object.keys(groups) as Group[]).map(group => {
              const rows = groups[group]
              if (rows.length === 0) return null
              return (
                <section key={group}>
                  <h2 className="mb-1.5 text-[11px] font-medium text-[var(--text-muted)]">{GROUP_LABEL[group]} · {rows.length}</h2>
                  <div className="space-y-1.5">
                    {rows.map(flow => {
                      const p = workflowProgress(flow)
                      const tag = flow.tagId ? tagById.get(flow.tagId) : null
                      const task = flow.taskId ? taskById.get(flow.taskId) : null
                      const current = flow.stages.find(s => s.status === 'doing') ?? flow.stages.find(s => s.status !== 'done')
                      return (
                        <button
                          key={flow.id}
                          onClick={() => onOpen(flow.id)}
                          className="kb-item-in flex w-full items-center gap-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5 text-left transition-colors hover:border-[var(--accent)]/50 hover:bg-[var(--bg-hover)]"
                        >
                          <span className="h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: flow.color }} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)]">{flow.title}</span>
                              {tag && <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] text-[var(--text-muted)]"><span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tag.color }} />{tag.name}</span>}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-[var(--text-muted)]">
                              <span>{flow.start.slice(5)} → {flow.end.slice(5)}</span>
                              <span>{task ? `任务：${task.title}` : '独立工作流'}</span>
                              {current && <span className="text-[var(--text-secondary)]">当前：{current.title}</span>}
                            </div>
                            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
                              <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${p.pct}%` }} />
                            </div>
                          </div>
                          <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{p.total === 0 ? '待规划' : `${p.done}/${p.total}`}</span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
