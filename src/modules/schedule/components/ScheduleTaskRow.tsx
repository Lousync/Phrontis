import { Check, Clock3, GitBranch, Timer, Trash2 } from 'lucide-react'
import type { ScheduleTag, ScheduleTodo } from '../../../types'

interface Props {
  task: ScheduleTodo
  tag?: ScheduleTag | null
  hasWorkflow?: boolean
  showDate?: boolean
  onOpen: (task: ScheduleTodo) => void
  onToggle: (task: ScheduleTodo) => void
  onDelete?: (task: ScheduleTodo) => void
  /** 退场态：勾选完成后宿主保留一拍播 .kb-item-out（划线 + 右移淡出），播完移除（F-1） */
  exiting?: boolean
}

function timeLabel(task: ScheduleTodo): string {
  if (task.scheduledStart != null) {
    const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
    return `${fmt(task.scheduledStart)}–${fmt(task.scheduledEnd ?? task.scheduledStart)}`
  }
  if (task.time) return task.time.slice(11, 16)
  return ''
}

export function ScheduleTaskRow({ task, tag, hasWorkflow = false, showDate = false, onOpen, onToggle, onDelete, exiting = false }: Props) {
  const done = task.status === 'done'
  const when = timeLabel(task)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(task)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpen(task) }}
      className={`kb-item-in group flex w-full items-start gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-left transition-colors hover:border-[var(--accent)]/50 hover:bg-[var(--bg-hover)] ${done ? 'opacity-60' : ''} ${exiting ? 'kb-item-out' : ''}`}
    >
      {/* 热区（v3.13.0 反馈 F-1）：视觉圆 16px 不变，命中区扩到 28px（h-7 w-7），
          负 margin 补偿外扩占位、行内视觉位置不变 —— 点偏一丝不再落进行体的「打开编辑」。
          原 16px 命中 + 行体整行可点 = 高频误触修改态。 */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(task) }}
        title={done ? '标记未完成' : '标记完成'}
        className="-my-1 -ml-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
      >
        <span className={`flex h-4 w-4 items-center justify-center rounded-full border transition-colors ${done ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--text-disabled)] text-transparent hover:border-[var(--accent)]'}`}>
          <Check size={11} strokeWidth={3} />
        </span>
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={`min-w-0 flex-1 truncate text-[13px] ${done ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>{task.title}</span>
          {hasWorkflow && <GitBranch size={11} className="shrink-0 text-[var(--accent)]" />}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-[var(--text-muted)]">
          {showDate && task.date && <span>{task.date.slice(5)}</span>}
          {when && <span className="inline-flex items-center gap-0.5"><Clock3 size={10} />{when}</span>}
          {task.estimateMin != null && <span className="inline-flex items-center gap-0.5"><Timer size={10} />{task.estimateMin}m</span>}
          {tag && <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tag.color }} />{tag.name}</span>}
          {hasWorkflow && <span className="text-[var(--accent)]">工作流</span>}
        </div>
      </div>

      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(task) }}
          title="删除任务"
          className="mt-0.5 rounded p-1 text-[var(--text-disabled)] opacity-0 transition-opacity hover:bg-[var(--danger)]/10 hover:text-[var(--danger)] group-hover:opacity-100"
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  )
}
