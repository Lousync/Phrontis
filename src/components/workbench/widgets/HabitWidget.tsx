import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ExternalLink } from 'lucide-react'
import type { Habit, HabitRecord } from '../../../types'
import { habitGetAll, toggleHabitCheck } from '../../../lib/ipc'
import { notifyDataChanged, useDataChanged } from '../../../lib/dataChanged'
import { localToday } from '../../../lib/date'
import {
  currentStreak, longestStreak, totalCount, completionRate30d, weekDoneCount,
  formatLocalDate, buildRecordIndex, isPlannedOn, type RecordIndex,
} from '../../../modules/toolbox/components/habit-tracker/dateUtils'

interface Props {
  /** 「管理」按钮回调：主窗口语境 = 打开习惯打卡工具标签；脱离小窗语境 = dayPanelOpenInMain */
  onManage?: () => void
}

/**
 * 今日打卡控件（v3.4.0 批次4：DayPanel「打卡」Tab 抽为可嵌入控件，方案 §3.7）。
 *
 * **右栏简略视图与脱离小窗共用本组件**（不复制渲染）。自包含数据加载：
 * 完成度圆环 + 今日勾选列表（近 7 日迷你条 + 连续天数）+ 统计子视图。
 * 数据与工具箱习惯打卡完全同源（同一 habitGetAll / toggleHabitCheck IPC + data-changed 广播）。
 */
export function HabitWidget({ onManage }: Props) {
  const [habits, setHabits] = useState<Habit[]>([])
  const [records, setRecords] = useState<HabitRecord[]>([])
  const [sub, setSub] = useState<'today' | 'stats'>('today')

  const todayStr = localToday()
  const todayDate = useMemo(() => {
    const [y, m, d] = todayStr.split('-').map(Number)
    return new Date(y, m - 1, d)
  }, [todayStr])

  const load = useCallback(async () => {
    try {
      const data = await habitGetAll()
      setHabits(data.habits ?? [])
      setRecords(data.records ?? [])
    } catch (e) {
      console.error('[HabitWidget] 加载失败', e)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useDataChanged('habit', load)

  const habitIndex = useMemo(() => buildRecordIndex(records), [records])
  const plannedHabits = useMemo(
    () => habits.filter(h => !h.archived && isPlannedOn(h, todayDate)),
    [habits, todayDate],
  )
  const checkedToday = useMemo(
    () => plannedHabits.filter(h => habitIndex.get(h.id)?.has(todayStr)).length,
    [plannedHabits, habitIndex, todayStr],
  )

  const checkHabit = useCallback(async (h: Habit) => {
    const willCheck = !(habitIndex.get(h.id)?.has(todayStr) ?? false)
    setRecords(cur => willCheck
      ? [...cur, { id: `${h.id}:${todayStr}`, habitId: h.id, date: todayStr } as HabitRecord]
      : cur.filter(r => !(r.habitId === h.id && r.date === todayStr)))
    try {
      await toggleHabitCheck(h.id, todayStr)
      notifyDataChanged('habit')
    } catch (e) {
      console.error('[HabitWidget] 打卡失败', e)
      void load()
    }
  }, [todayStr, habitIndex, load])

  const active = habits.filter(h => !h.archived)
  const plannedCount = plannedHabits.length
  const pct = plannedCount > 0 ? Math.round((checkedToday / plannedCount) * 100) : 100
  const bestStreak = active.reduce((m, h) => Math.max(m, longestStreak(h, habitIndex.get(h.id) ?? new Set(), todayDate)), 0)

  // 近 7 日（含今日）打卡迷你条
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(todayDate)
    d.setDate(d.getDate() - (6 - i))
    return formatLocalDate(d)
  })

  return (
    <div className="space-y-3">
      {/* 完成度圆环 */}
      <div className="flex items-center gap-3 rounded-xl border border-[var(--border-color)] bg-[var(--card-bg)] p-2.5">
        <div
          className="relative flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full"
          style={{ background: `conic-gradient(var(--success) ${pct}%, var(--bg-tertiary) 0)` }}
        >
          <div className="absolute inset-[5px] rounded-full bg-[var(--bg-primary)]" />
          <span className="relative text-[12px] font-bold text-[var(--success)]">{checkedToday}/{plannedCount}</span>
        </div>
        <div className="text-[11px] leading-[1.7] text-[var(--text-muted)]">
          <b className="text-[12px] text-[var(--text-primary)]">今日打卡 {checkedToday} / {plannedCount}</b>
          <br />
          {plannedCount > 0 && checkedToday < plannedCount
            ? <>全勤再坚持 {plannedCount - checkedToday} 项{bestStreak > 0 && <> · 最佳连续 {bestStreak} 天 🔥</>}</>
            : <>今日打卡已完成{bestStreak > 0 && <> · 最佳连续 {bestStreak} 天 🔥</>}</>}
        </div>
      </div>

      {/* 今日 / 统计 子切换 */}
      <div>
        <div className="flex items-center justify-between gap-1 px-0.5">
          <div className="flex gap-0.5 rounded-lg bg-[var(--bg-tertiary)] p-0.5">
            {(['today', 'stats'] as const).map(s => (
              <button
                key={s}
                onClick={() => setSub(s)}
                className={`rounded-md px-2.5 py-0.5 text-[10.5px] transition-colors ${
                  sub === s ? 'bg-[var(--bg-primary)] font-semibold text-[var(--accent)] shadow-sm' : 'text-[var(--text-secondary)]'
                }`}
              >
                {s === 'today' ? '今日' : '统计'}
              </button>
            ))}
          </div>
          {onManage && (
            <button onClick={onManage} className="inline-flex items-center gap-0.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--accent)]" title="打开习惯打卡工具管理">
              管理 <ExternalLink size={10} />
            </button>
          )}
        </div>

        {/* 今日：勾选列表 */}
        {sub === 'today' && (
          <div className="mt-1.5 space-y-0.5">
            {plannedHabits.map(h => {
              const done = habitIndex.get(h.id)?.has(formatLocalDate(todayDate)) ?? false
              const streak = currentStreak(h, habitIndex.get(h.id) ?? new Set(), todayDate)
              return (
                <div key={h.id} className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-[var(--bg-hover)]">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: h.color }} />
                  <span className="min-w-0 flex-1 truncate text-xs">{h.name}</span>
                  {/* 近 7 日迷你条 */}
                  <span className="flex shrink-0 gap-[2.5px]">
                    {weekDays.map(d => (
                      <i
                        key={d}
                        className={`h-3 w-[5px] rounded-sm ${habitIndex.get(h.id)?.has(d) ? 'opacity-75' : ''}`}
                        style={{ backgroundColor: habitIndex.get(h.id)?.has(d) ? 'var(--success)' : 'var(--bg-tertiary)' }}
                      />
                    ))}
                  </span>
                  {streak > 0 && <span className="shrink-0 text-[10.5px] text-[var(--text-muted)]">{streak}天</span>}
                  <button
                    onClick={() => void checkHabit(h)}
                    className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border transition-colors ${
                      done ? 'border-[var(--success)] bg-[var(--success)] text-white' : 'border-[var(--border-color)] hover:border-[var(--success)]'
                    }`}
                    title={done ? '取消打卡' : '打卡'}
                  >
                    {done && <Check size={12} strokeWidth={3} />}
                  </button>
                </div>
              )
            })}
            {plannedHabits.length === 0 && (
              <p className="px-1 py-2 text-xs text-[var(--text-muted)]">今天没有计划中的习惯</p>
            )}
          </div>
        )}

        {/* 统计：每习惯 2×2 指标卡（与工具箱 StatsView 同指标） */}
        {sub === 'stats' && (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {active.map(h => {
              const done = habitIndex.get(h.id) ?? new Set<string>()
              const rate30 = completionRate30d(h, done, todayDate)
              const rateColor = rate30 >= 80 ? 'var(--success)' : rate30 < 40 ? 'var(--warning)' : 'var(--text-primary)'
              return (
                <div key={h.id} className="rounded-xl border border-[var(--border-color)] bg-[var(--card-bg)] p-2">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold">
                    <i className="h-2 w-2 rounded-full" style={{ backgroundColor: h.color }} />
                    {h.name}
                    {h.ruleType === 'flexible' && (
                      <span className="text-[9.5px] font-normal text-[var(--text-muted)]">弹性 · 每周{h.weeklyTarget}次</span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    {h.ruleType === 'flexible' ? (
                      <StatCell label="🔥 本周" value={`${weekDoneCount(done, todayDate)}/${h.weeklyTarget}`}
                        color={weekDoneCount(done, todayDate) >= h.weeklyTarget ? 'var(--success)' : undefined} />
                    ) : (
                      <StatCell label="🔥 当前连续" value={`${currentStreak(h, done, todayDate)} 天`} color={currentStreak(h, done, todayDate) > 0 ? 'var(--accent)' : undefined} />
                    )}
                    <StatCell label="🏆 最长连续" value={`${longestStreak(h, done, todayDate)} 天`} />
                    <StatCell label="# 累计" value={`${totalCount(done)} 次`} />
                    <StatCell label="📈 近30天" value={`${rate30}%`} color={rateColor}
                      bar={rate30} barColor={h.color} />
                  </div>
                </div>
              )
            })}
            {active.length === 0 && (
              <p className="px-1 py-2 text-xs text-[var(--text-muted)]">创建习惯后这里会显示打卡统计</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function StatCell({ label, value, color, bar, barColor }: {
  label: string; value: string; color?: string; bar?: number; barColor?: string
}) {
  return (
    <div className="rounded-lg bg-[var(--bg-primary)] px-2 py-1">
      <div className="text-[9.5px] text-[var(--text-muted)]">{label}</div>
      <div className="text-[12.5px] font-bold tabular-nums" style={{ color: color ?? 'var(--text-primary)' }}>{value}</div>
      {bar !== undefined && (
        <div className="mt-0.5 h-[3px] overflow-hidden rounded-full bg-[var(--bg-hover)]">
          <div className="h-full rounded-full" style={{ width: `${bar}%`, backgroundColor: barColor }} />
        </div>
      )}
    </div>
  )
}

/** 打卡记录索引类型再导出（DayPanel 脱离窗口角标复用同口径） */
export type { RecordIndex }
