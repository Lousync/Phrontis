import { useEffect, useMemo, useRef } from 'react'
import { Check, Plus, PartyPopper } from 'lucide-react'
import type { Habit, HabitRecord } from '../../../../../types'
import { formatLocalDate, isPlannedOn, ruleSummary, buildRecordIndex, getWeekStart } from '../dateUtils'
import { burstConfetti, celebrateAllDone, ensureFeedbackStyles } from '../../../../../lib/confetti'

interface Props {
  habits: Habit[]
  records: HabitRecord[]
  onToggle: (habitId: string, date: string) => void
  onNew: () => void
}

const WEEK_FULL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function TodayView({ habits, records, onToggle, onNew }: Props) {
  const today = useMemo(() => new Date(), [])
  const todayStr = formatLocalDate(today)

  const planned = useMemo(
    () => habits.filter(h => !h.archived && isPlannedOn(h, today)),
    [habits, today]
  )

  const idx = useMemo(() => buildRecordIndex(records), [records])

  const doneIds = useMemo(() => {
    const s = new Set<string>()
    for (const h of planned) if (idx.get(h.id)?.has(todayStr)) s.add(h.id)
    return s
  }, [planned, idx, todayStr])

  // 本周打卡次数（flexible 进度）
  const weekCount = useMemo(() => {
    const startStr = formatLocalDate(getWeekStart(today))
    const map = new Map<string, number>()
    for (const r of records) if (r.date >= startStr && r.date <= todayStr) map.set(r.habitId, (map.get(r.habitId) ?? 0) + 1)
    return map
  }, [records, today])

  const sorted = useMemo(() => [...planned].sort((a, b) => Number(doneIds.has(a.id)) - Number(doneIds.has(b.id))), [planned, doneIds])
  const doneCount = doneIds.size

  // 全部完成 → 全屏庆祝（仅在状态切换瞬间触发一次）
  const allDoneRef = useRef(false)
  useEffect(() => {
    ensureFeedbackStyles()
    const allDone = planned.length > 0 && doneCount === planned.length
    if (allDone && !allDoneRef.current) celebrateAllDone()
    allDoneRef.current = allDone
  }, [doneCount, planned.length])

  const dateLine = `${today.getMonth() + 1}月${today.getDate()}日 · ${WEEK_FULL[today.getDay()]}`

  /** 完成打卡时在打勾圈位置炸彩带 */
  const handleCardClick = (h: Habit, e: React.MouseEvent<HTMLElement>) => {
    if (!doneIds.has(h.id)) {
      const r = e.currentTarget.getBoundingClientRect()
      burstConfetti(r.left + 26, r.top + r.height / 2, [h.color])
    }
    onToggle(h.id, todayStr)
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-5">
      {/* 头部：日期 + 进度 */}
      <div className="flex items-end justify-between mb-4">
        <div>
          <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">今天</h2>
          <p className="text-[12px] text-[var(--text-muted)] mt-0.5">{dateLine}</p>
        </div>
        {planned.length > 0 && (
          <div className="text-right">
            <span className="text-[20px] font-semibold tabular-nums" style={{ color: doneCount === planned.length ? 'var(--success)' : 'var(--accent)' }}>
              {doneCount}<span className="text-[13px] text-[var(--text-muted)] font-normal"> / {planned.length}</span>
            </span>
          </div>
        )}
      </div>

      {/* 进度条 */}
      {planned.length > 0 && (
        <div className="h-1.5 rounded-full bg-[var(--bg-hover)] overflow-hidden mb-5">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${(doneCount / planned.length) * 100}%`,
              backgroundColor: doneCount === planned.length ? 'var(--success)' : 'var(--accent)',
            }}
          />
        </div>
      )}

      {/* 空状态 */}
      {planned.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          {habits.filter(h => !h.archived).length === 0 ? (
            <>
              <CalendarPlusIcon />
              <p className="text-[13px] text-[var(--text-muted)] mt-3">还没有任何习惯</p>
              <button onClick={onNew}
                className="mt-3 px-3 py-1.5 text-[12px] rounded border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-1">
                <Plus size={13} /> 创建第一个习惯
              </button>
            </>
          ) : (
            <>
              <PartyPopper size={28} className="text-[var(--text-muted)]" />
              <p className="text-[13px] text-[var(--text-muted)] mt-3">今天没有需要打卡的习惯</p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map(h => {
            const done = doneIds.has(h.id)
            const weekN = weekCount.get(h.id) ?? 0
            return (
              <button
                key={h.id}
                onClick={e => handleCardClick(h, e)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg border text-left transition-all duration-150 ${
                  done
                    ? 'border-transparent bg-[var(--bg-hover)] opacity-60'
                    : 'border-[var(--border-color)] bg-[var(--bg-secondary)] hover:border-[var(--accent)] active:scale-[0.99]'
                }`}
              >
                {/* 打勾圈：完成瞬间弹跳 */}
                <span
                  key={done ? 'd' : 'u'}
                  className={`w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${done ? 'ck-pop' : ''}`}
                  style={done
                    ? { backgroundColor: h.color, borderColor: h.color }
                    : { borderColor: h.color }}
                >
                  {done && <Check size={14} strokeWidth={3} className="text-white" />}
                </span>
                <div className="flex-1 min-w-0">
                  <div className={`text-[14px] ${done ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
                    {h.name}
                  </div>
                  <div className="text-[11px] text-[var(--text-muted)]">{ruleSummary(h)}</div>
                </div>
                {h.ruleType === 'flexible' && (
                  <span className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full border ${
                    weekN >= h.weeklyTarget ? 'border-[var(--success)]' : 'border-[var(--border-color)] text-[var(--text-muted)]'
                  }`}>
                    本周 {weekN}/{h.weeklyTarget}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {planned.length > 0 && doneCount === planned.length && (
        <p className="ck-rise text-center text-[12px] mt-5 flex items-center justify-center gap-1.5" style={{ color: 'var(--success)' }}>
          <PartyPopper size={14} /> 今日打卡全部完成，明天见！
        </p>
      )}
    </div>
  )
}

function CalendarPlusIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-muted)] opacity-50">
      <rect x="3" y="4.5" width="18" height="17" rx="2.5" />
      <path d="M8 2.8v3.4" /><path d="M16 2.8v3.4" /><path d="M3 9.5h18" />
      <path d="M12 13v5" /><path d="M9.5 15.5h5" />
    </svg>
  )
}
