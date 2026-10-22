import { CalendarDays, CalendarRange, CheckCircle2, Clock3, GitBranch, Inbox, Plus, Settings2, Tag } from 'lucide-react'
import type { ScheduleRecurring, ScheduleTag } from '../../../types'
import type { ScheduleView } from '../types'
import { RecurringRulesPanel } from './RecurringRulesPanel'

interface Props {
  view: ScheduleView
  activeTag: string | null
  tags: ScheduleTag[]
  counts: { today: number; inbox: number; upcoming: number; workflows: number; done: number }
  recurring: ScheduleRecurring[]
  onSelect: (view: ScheduleView) => void
  onSelectTag: (tagId: string) => void
  onNewTask: () => void
  onManageTags: () => void
  onReloadRecurring: () => Promise<void>
}

const NAV: Array<{ id: ScheduleView; label: string; Icon: typeof CalendarDays; count?: keyof Props['counts'] }> = [
  { id: 'today', label: '今天', Icon: CalendarDays, count: 'today' },
  { id: 'inbox', label: '收集箱', Icon: Inbox, count: 'inbox' },
  { id: 'upcoming', label: '即将', Icon: Clock3, count: 'upcoming' },
  { id: 'calendar', label: '日历', Icon: CalendarRange },
  { id: 'workflows', label: '工作流', Icon: GitBranch, count: 'workflows' },
  { id: 'done', label: '已完成', Icon: CheckCircle2, count: 'done' },
]

export function ScheduleSidebar({ view, activeTag, tags, counts, recurring, onSelect, onSelectTag, onNewTask, onManageTags, onReloadRecurring }: Props) {
  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[var(--border-color)] px-2 text-[11.5px] text-[var(--text-muted)]">
        <CalendarDays size={12} />
        <span className="truncate @max-[120px]:hidden">日程</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        <div className="space-y-0.5">
          {NAV.map(({ id, label, Icon, count }) => {
            const active = view === id || (view === 'canvas' && id === 'workflows')
            const value = count ? counts[count] : 0
            return (
              <button
                key={id}
                onClick={() => onSelect(id)}
                title={label}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors ${active ? 'bg-[var(--accent)]/10 font-medium text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
              >
                <Icon size={14} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate @max-[120px]:hidden">{label}</span>
                {count && value > 0 && <span className="rounded-full bg-[var(--bg-tertiary)] px-1.5 text-[10px] text-[var(--text-muted)] @max-[120px]:hidden">{value}</span>}
              </button>
            )
          })}
        </div>

        <div className="mt-3 border-t border-[var(--border-color)] pt-2">
          <div className="mb-1 flex items-center justify-between px-2 @max-[120px]:hidden">
            <span className="text-[10.5px] font-medium uppercase tracking-wide text-[var(--text-disabled)]">标签</span>
            <button onClick={onManageTags} title="管理标签" className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
              <Settings2 size={12} />
            </button>
          </div>
          {tags.length === 0 ? (
            <p className="px-2 py-1 text-[11px] text-[var(--text-disabled)] @max-[120px]:hidden">暂无标签</p>
          ) : tags.map(tag => (
            <button
              key={tag.id}
              onClick={() => onSelectTag(tag.id)}
              title={tag.name}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors ${view === 'tag' && activeTag === tag.id ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
              <span className="min-w-0 flex-1 truncate @max-[120px]:hidden">{tag.name}</span>
            </button>
          ))}
        </div>

        <div className="mt-3 border-t border-[var(--border-color)] pt-1 @max-[120px]:hidden">
          <RecurringRulesPanel rules={recurring} onReload={onReloadRecurring} />
        </div>
      </div>

      <div className="shrink-0 border-t border-[var(--border-color)] p-2">
        <button
          onClick={onNewTask}
          title="新建任务"
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] px-2 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-[var(--accent-hover)]"
        >
          <Plus size={14} />
          <span className="@max-[120px]:hidden">新建任务</span>
        </button>
      </div>
    </div>
  )
}
