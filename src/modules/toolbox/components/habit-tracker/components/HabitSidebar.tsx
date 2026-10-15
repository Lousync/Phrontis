import { useMemo, useState } from 'react'
import { Plus, Pencil, Archive, ArchiveRestore, Flame, CalendarRange } from 'lucide-react'
import type { Habit, HabitRecord } from '../../../../../types'
import { buildRecordIndex, currentStreak, weekDoneCount, ruleSummary } from '../dateUtils'
import { SIDEBAR_HEADER_ICON } from '../../../../../components/shared/sidebarHeaderIcon'

interface Props {
  habits: Habit[]
  records: HabitRecord[]
  onNew: () => void
  onEdit: (habit: Habit) => void
  onArchive: (habit: Habit) => void
}

export function HabitSidebar({ habits, records, onNew, onEdit, onArchive }: Props) {
  const [archivedOpen, setArchivedOpen] = useState(false)
  const active = habits.filter(h => !h.archived)
  const archived = habits.filter(h => h.archived)

  const streaks = useMemo(() => {
    const idx = buildRecordIndex(records)
    const map = new Map<string, number>()
    for (const h of active) map.set(h.id, currentStreak(h, idx.get(h.id) ?? new Set()))
    return map
  }, [habits, records])

  const weekly = useMemo(() => {
    const idx = buildRecordIndex(records)
    const map = new Map<string, number>()
    for (const h of active) if (h.ruleType === 'flexible') map.set(h.id, weekDoneCount(idx.get(h.id) ?? new Set()))
    return map
  }, [habits, records])

  const renderRow = (h: Habit, isArchived: boolean) => (
    <div
      key={h.id}
      className="group relative flex items-center gap-2.5 px-3 py-2 mx-2 rounded cursor-default hover:bg-[var(--bg-hover)] transition-colors"
    >
      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: h.color }} />
      <div className="flex-1 min-w-0">
        <div className={`text-[13px] truncate ${isArchived ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-primary)]'}`}>{h.name}</div>
        <div className="text-[11px] text-[var(--text-muted)] flex items-center gap-1">
          <CalendarRange size={10} className="shrink-0" />
          <span className="truncate">{ruleSummary(h)}</span>
        </div>
      </div>
      {!isArchived && (
        <div className="shrink-0 flex items-center gap-1 text-[var(--text-muted)] group-hover:opacity-0 transition-opacity">
          {h.ruleType === 'flexible'
            ? <span className="text-[11px]">{weekly.get(h.id) ?? 0}/{h.weeklyTarget}</span>
            : (streaks.get(h.id) ?? 0) > 0 && (
              <>
                <Flame size={12} style={{ color: h.color }} />
                <span className="text-[12px] tabular-nums" style={{ color: h.color }}>{streaks.get(h.id)}</span>
              </>
            )}
        </div>
      )}
      {/* 悬停操作 */}
      <div className="absolute right-1.5 hidden group-hover:flex items-center gap-0.5 bg-[var(--bg-secondary)] pl-1">
        <button onClick={() => onEdit(h)} title="编辑"
          className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-selected)] transition-colors">
          <Pencil size={13} />
        </button>
        {isArchived ? (
          <button onClick={() => onArchive({ ...h, archived: false })} title="恢复"
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-selected)] transition-colors">
            <ArchiveRestore size={13} />
          </button>
        ) : (
          <button onClick={() => onArchive({ ...h, archived: true })} title="归档"
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--warning)] hover:bg-[var(--bg-selected)] transition-colors">
            <Archive size={13} />
          </button>
        )}
      </div>
    </div>
  )

  return (
    <div className="h-full flex flex-col bg-[var(--bg-secondary)] overflow-y-auto">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-[var(--border-color)] shrink-0 sticky top-0 bg-[var(--bg-secondary)] z-10">
        <span className="flex-1 text-[12px] font-medium text-[var(--text-secondary)]">习惯</span>
        <button onClick={onNew}
          className="p-1 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          title="新建习惯">
          <Plus {...SIDEBAR_HEADER_ICON} />
        </button>
      </div>

      <div className="py-1.5 space-y-0.5">
        {active.length === 0 && (
          <div className="px-4 py-6 text-[12px] text-[var(--text-muted)] leading-relaxed">
            还没有习惯。
            <br />点击右上角 + 创建第一个打卡习惯。
          </div>
        )}
        {active.map(h => renderRow(h, false))}
      </div>

      {archived.length > 0 && (
        <div className="mt-auto pb-2">
          <button
            onClick={() => setArchivedOpen(o => !o)}
            className="w-full flex items-center gap-1 px-4 py-1.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            已归档（{archived.length}）{archivedOpen ? '▾' : '▸'}
          </button>
          {archivedOpen && <div className="space-y-0.5">{archived.map(h => renderRow(h, true))}</div>}
        </div>
      )}
    </div>
  )
}
