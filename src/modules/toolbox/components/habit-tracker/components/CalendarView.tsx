import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Check } from 'lucide-react'
import type { Habit, HabitRecord } from '../../../../../types'
import { formatLocalDate, isPlannedOn, ruleSummary, buildRecordIndex, isSameDay } from '../dateUtils'
import { burstConfetti } from '../../../../../lib/confetti'

interface Props {
  habits: Habit[]
  records: HabitRecord[]
  onToggle: (habitId: string, date: string) => void
}

const CELL_HEADERS = ['一', '二', '三', '四', '五', '六', '日']
const MAX_DOTS = 4

export function CalendarView({ habits, records, onToggle }: Props) {
  const today = useMemo(() => new Date(), [])
  const [cursor, setCursor] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1))
  const [selected, setSelected] = useState<string | null>(null)

  const idx = useMemo(() => buildRecordIndex(records), [records])
  const active = habits.filter(h => !h.archived)

  // 月历格子（周一起始）
  const cells = useMemo(() => {
    const y = cursor.getFullYear(), m = cursor.getMonth()
    const first = new Date(y, m, 1)
    const daysInMonth = new Date(y, m + 1, 0).getDate()
    const lead = (first.getDay() + 6) % 7
    const arr: ({ date: Date; str: string } | null)[] = []
    for (let i = 0; i < lead; i++) arr.push(null)
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(y, m, d)
      arr.push({ date, str: formatLocalDate(date) })
    }
    return arr
  }, [cursor])

  const monthTitle = `${cursor.getFullYear()} 年 ${cursor.getMonth() + 1} 月`

  const moveMonth = (delta: number) => {
    setCursor(c => new Date(c.getFullYear(), c.getMonth() + delta, 1))
    setSelected(null)
  }

  /** 某天有计划的习惯 */
  const plannedOn = (d: Date): Habit[] => active.filter(h => isPlannedOn(h, d))

  const selectedDate = selected
    ? (() => { const [y, m, dd] = selected.split('-').map(Number); return new Date(y, m - 1, dd) })()
    : null

  /** 补卡也来点反馈 */
  const handleRetroToggle = (h: Habit, wasDone: boolean, e: React.MouseEvent<HTMLElement>) => {
    if (!wasDone) {
      const r = e.currentTarget.getBoundingClientRect()
      burstConfetti(r.left + 20, r.top + r.height / 2, [h.color])
    }
    onToggle(h.id, selected!)
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-5">
      {/* 头部导航 */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">{monthTitle}</h2>
        <div className="flex items-center gap-1">
          <button onClick={() => setCursor(new Date(today.getFullYear(), today.getMonth(), 1))}
            className="px-2 py-1 text-[12px] rounded border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors mr-1">
            今天
          </button>
          <button onClick={() => moveMonth(-1)}
            className="p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors"><ChevronLeft size={16} /></button>
          <button onClick={() => moveMonth(1)}
            className="p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors"><ChevronRight size={16} /></button>
        </div>
      </div>

      {/* 星期表头 */}
      <div className="grid grid-cols-7 mb-1">
        {CELL_HEADERS.map(w => (
          <div key={w} className="text-center text-[11px] text-[var(--text-muted)] py-1">{w}</div>
        ))}
      </div>

      {/* 日历格子 */}
      <div className="grid grid-cols-7 gap-y-1">
        {cells.map((cell, i) => {
          if (!cell) return <div key={`b${i}`} />
          const doneHabits = active.filter(h => idx.get(h.id)?.has(cell.str))
          const isToday = isSameDay(cell.date, today)
          const isSelected = selected === cell.str
          return (
            <button
              key={cell.str}
              onClick={() => setSelected(isSelected ? null : cell.str)}
              className={`relative flex flex-col items-center gap-1 py-1.5 rounded-lg transition-colors ${
                isSelected ? 'bg-[var(--bg-selected)]' : 'hover:bg-[var(--bg-hover)]'
              }`}
            >
              <span className={`w-7 h-7 flex items-center justify-center rounded-full text-[12px] tabular-nums ${
                isToday ? 'font-semibold' : 'text-[var(--text-primary)]'
              }`}
                style={isToday ? { backgroundColor: 'var(--accent)', color: '#fff' } : undefined}
              >
                {cell.date.getDate()}
              </span>
              <span className="flex items-center gap-[3px] h-[5px]">
                {doneHabits.slice(0, MAX_DOTS).map(h => (
                  <span key={h.id} className="w-[5px] h-[5px] rounded-full" style={{ backgroundColor: h.color }} />
                ))}
                {doneHabits.length > MAX_DOTS && (
                  <span className="text-[9px] leading-none text-[var(--text-muted)]">+{doneHabits.length - MAX_DOTS}</span>
                )}
              </span>
            </button>
          )
        })}
      </div>

      {/* 当日明细 */}
      {selected && selectedDate && (
        <div className="ck-rise mt-4 border border-[var(--border-color)] rounded-lg bg-[var(--bg-secondary)] p-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-[12px] font-medium text-[var(--text-secondary)]">{selected.slice(5)} 打卡明细</h3>
            <span className="text-[11px] text-[var(--text-muted)]">点击可补卡 / 撤销</span>
          </div>
          <div className="space-y-1.5">
            {plannedOn(selectedDate).length === 0 && (
              <p className="text-[12px] text-[var(--text-muted)] py-1">这天没有计划中的习惯</p>
            )}
            {plannedOn(selectedDate).map(h => {
              const done = idx.get(h.id)?.has(selected) ?? false
              return (
                <button
                  key={h.id}
                  onClick={e => handleRetroToggle(h, done, e)}
                  className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded hover:bg-[var(--bg-hover)] transition-colors text-left"
                >
                  <span key={done ? 'd' : 'u'}
                    className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${done ? 'ck-pop' : ''}`}
                    style={done ? { backgroundColor: h.color, borderColor: h.color } : { borderColor: h.color }}>
                    {done && <Check size={12} strokeWidth={3} className="text-white" />}
                  </span>
                  <span className={`flex-1 text-[13px] ${done ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>{h.name}</span>
                  <span className="text-[11px] text-[var(--text-muted)]">{ruleSummary(h)}</span>
                </button>
              )
            })}
            {/* 已归档但当天打过卡的也展示（只读） */}
            {habits.filter(h => h.archived && idx.get(h.id)?.has(selected)).map(h => (
              <div key={h.id} className="flex items-center gap-2.5 px-2.5 py-1.5 opacity-50">
                <span className="w-5 h-5 rounded-full shrink-0 flex items-center justify-center" style={{ backgroundColor: h.color }}>
                  <Check size={12} strokeWidth={3} className="text-white" />
                </span>
                <span className="flex-1 text-[13px] line-through">{h.name}</span>
                <span className="text-[11px]">已归档</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
