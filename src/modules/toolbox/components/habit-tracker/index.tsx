import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, CalendarCheck2, CalendarDays, BarChart3 } from 'lucide-react'
import type { Habit, HabitRecord } from '../../../../types'
import { deleteHabit, updateHabit, toggleHabitCheck } from '../../../../lib/ipc'
import { showToast } from '../../../../lib/toast'
import { buildRecordIndex, currentStreak } from './dateUtils'
import { useDataChanged, notifyDataChanged } from '../../../../lib/dataChanged'
import type { ToolSidebarProps } from '../../../../components/workbench/toolRegistry'
import { HabitSidebar } from './components/HabitSidebar'
import { TodayView } from './components/TodayView'
import { CalendarView } from './components/CalendarView'
import { StatsView } from './components/StatsView'
import { HabitEditorModal } from './components/HabitEditorModal'

interface Props extends ToolSidebarProps { onBack: () => void }

type ViewTab = 'today' | 'calendar' | 'stats'

const VIEW_TABS: { id: ViewTab; label: string; icon: React.ReactNode }[] = [
  { id: 'today', label: '今天', icon: <CalendarCheck2 size={14} /> },
  { id: 'calendar', label: '日历', icon: <CalendarDays size={14} /> },
  { id: 'stats', label: '统计', icon: <BarChart3 size={14} /> },
]

/** 连续天数里程碑：达成时弹提示 */
const MILESTONES = [3, 7, 14, 21, 30, 50, 100, 150, 200, 250, 300, 365]

export function HabitTracker({ onBack, sidebarEl, sidebarHosted }: Props) {
  const [habits, setHabits] = useState<Habit[]>([])
  const [records, setRecords] = useState<HabitRecord[]>([])
  const [view, setView] = useState<ViewTab>('today')
  const [editor, setEditor] = useState<{ mode: 'create' } | { mode: 'edit'; habit: Habit } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const data = await window.api.habitGetAll()
      setHabits(data.habits)
      setRecords(data.records)
    } catch (e) {
      console.error('加载打卡数据失败', e)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // 监听跨窗口数据变更 — 日程打卡小窗内的打卡/新增习惯实时同步到本视图
  useDataChanged('habit', refresh)

  const handleToggle = useCallback(async (habitId: string, date: string) => {
    try {
      const res = await toggleHabitCheck(habitId, date)
      const next = res.checked
        ? [...records, { id: `${habitId}:${date}`, habitId, date }]
        : records.filter(r => !(r.habitId === habitId && r.date === date))
      setRecords(next)
      notifyDataChanged('habit')
      // 正向反馈：里程碑连续天数
      if (res.checked) {
        const habit = habits.find(h => h.id === habitId)
        if (habit && !habit.archived) {
          const idx = buildRecordIndex(next)
          const streak = currentStreak(habit, idx.get(habitId) ?? new Set())
          if (MILESTONES.includes(streak)) {
            showToast({ type: 'info', message: `🔥 厉害！「${habit.name}」已连续打卡 ${streak} 天，保持住！`, duration: 6000 })
          }
        }
      }
    } catch (e) {
      console.error('打卡失败', e)
    }
  }, [records, habits])

  const handleArchive = useCallback(async (h: Habit) => {
    try {
      const updated = await updateHabit(h.id, { archived: h.archived })
      setHabits(cur => cur.map(x => (x.id === updated.id ? updated : x)))
      notifyDataChanged('habit')
    } catch (e) {
      console.error('归档失败', e)
    }
  }, [])

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)]">
      {/* 头部 */}
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-2 py-1 shrink-0">
        <button
          onClick={onBack}
          className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          title="返回"
        >
          <ArrowLeft size={12} />
        </button>
        <span className="text-[11.5px] font-medium text-[var(--text-muted)]">习惯打卡</span>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* 左栏：习惯列表（固定宽）。2026-09-17 右栏优化轮：标签页语境 sidebarEl 非空时
            portal 进工作台左栏模块态 slot（挂载点迁移，状态留在本组件）；槽未就绪渲染 null 等槽。 */}
        {(() => {
          const sidebarInner = (
            <HabitSidebar
              habits={habits}
              records={records}
              onNew={() => setEditor({ mode: 'create' })}
              onEdit={h => setEditor({ mode: 'edit', habit: h })}
              onArchive={handleArchive}
            />
          )
          return sidebarEl
            ? createPortal(<div className="h-full w-full min-h-0">{sidebarInner}</div>, sidebarEl)
            : sidebarHosted
              ? null
              : <div className="w-56 shrink-0 border-r border-[var(--border-color)] min-h-0">{sidebarInner}</div>
        })()}

        {/* 主区 */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="h-10 shrink-0 border-b border-[var(--border-color)] flex items-center px-4 gap-1">
            {VIEW_TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setView(t.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] transition-colors ${
                  view === t.id
                    ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                {t.icon}{t.label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto">
            {view === 'today' && (
              <TodayView
                habits={habits}
                records={records}
                onToggle={handleToggle}
                onNew={() => setEditor({ mode: 'create' })}
              />
            )}
            {view === 'calendar' && (
              <CalendarView
                habits={habits.filter(h => !h.archived)}
                records={records}
                onToggle={handleToggle}
              />
            )}
            {view === 'stats' && (
              <StatsView habits={habits} records={records} />
            )}
          </div>
        </div>
      </div>

      {/* 新建 / 编辑弹窗 */}
      {editor && (
        <HabitEditorModal
          mode={editor.mode}
          habit={editor.mode === 'edit' ? editor.habit : undefined}
          onClose={() => setEditor(null)}
          onSaved={() => { setEditor(null); notifyDataChanged('habit'); void refresh() }}
        />
      )}
    </div>
  )
}
