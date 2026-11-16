import { CheckCircle2, Circle, CircleDot, ListChecks } from 'lucide-react'
import type { AgentTodoItem, AgentTraceStep } from '../../../types'

/** 从 trace 里取最后一条任务清单（同一次运行多次调用时，后面的快照覆盖前面的） */
export function latestTodoOf(steps?: AgentTraceStep[]): AgentTodoItem[] | null {
  if (!steps || steps.length === 0) return null
  for (let i = steps.length - 1; i >= 0; i--) {
    const todo = steps[i]?.todo
    if (Array.isArray(todo)) return todo
  }
  return null
}

/**
 * 对话框任务清单（P1-4）。数据源＝`builtin.plan.todo` 落进 trace 的完整快照，
 * 所以刷新 / 重启后仍能回看；同一运行多次更新时只展示最后一份。
 */
export function PlanTodoCard({ items, className = '' }: { items: AgentTodoItem[] | null; className?: string }) {
  if (!items || items.length === 0) return null
  const done = items.filter(i => i.status === 'done').length
  return (
    <div data-wb="aiPlanTodo"
      className={`kb-item-in mt-1.5 overflow-hidden rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] ${className}`}>
      <div className="flex items-center gap-1.5 border-b border-[var(--border-color)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
        <ListChecks size={11} className="shrink-0 text-[var(--accent)]" />
        <span className="flex-1">任务清单</span>
        <span className="tabular-nums text-[10px] text-[var(--text-muted)]">{done}/{items.length}</span>
      </div>
      <ul className="py-1">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-1.5 px-2.5 py-0.5 text-[11.5px] leading-snug">
            {it.status === 'done'
              ? <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-[var(--accent)]" />
              : it.status === 'doing'
                ? <CircleDot size={12} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                : <Circle size={12} className="mt-0.5 shrink-0 text-[var(--text-disabled)]" />}
            <span className={it.status === 'done'
              ? 'text-[var(--text-muted)] line-through'
              : it.status === 'doing'
                ? 'text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)]'}>{it.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
