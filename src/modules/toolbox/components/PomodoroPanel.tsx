import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertCircle, ArrowLeft, BarChart3, Check, ChevronRight, Coffee, Minus, Pause,
  Play, RotateCcw, Sparkles, Square, Star, Target, Timer, TrendingDown, TrendingUp,
} from 'lucide-react'
import { usePomodoro } from '../hooks/PomodoroContext'
import { POMODORO_TAGS, RATING_LABELS } from '../hooks/usePomodoroState'
import {
  computePomodoroStats, formatClock, formatDayLabel, topicColor, weekdayCN,
  type NormalizedPomodoroSession, type PomodoroRange,
} from '../pomodoroStats'
import { listPomodoroSessions, updatePomodoroSession } from '../../../lib/ipc'
import type { PomodoroSession } from '../../../types'
import { showToast } from '../../../lib/toast'
import { useDataChanged } from '../../../lib/dataChanged'

const RANGE_LABEL: Record<PomodoroRange, string> = { today: '今日', week: '本周', month: '本月' }

const RING_R = 100
const RING_C = 2 * Math.PI * RING_R

function fmtElapsed(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function TimerRing({
  progress, color = 'var(--accent)', size = 230, children,
}: {
  progress: number
  color?: string
  size?: number
  children: ReactNode
}) {
  const p = Math.max(0, Math.min(1, progress))
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 240 240" className="-rotate-90 block overflow-visible">
        <circle cx="120" cy="120" r={RING_R} fill="none" stroke="var(--bg-tertiary)" strokeWidth="7" />
        <circle
          cx="120" cy="120" r={RING_R} fill="none"
          stroke={color} strokeWidth="7" strokeLinecap="round"
          strokeDasharray={RING_C} strokeDashoffset={RING_C * (1 - p)}
          className="transition-[stroke-dashoffset] duration-1000 ease-linear"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">{children}</div>
    </div>
  )
}

function Stars({ value, onChange, size = 18 }: { value: number; onChange: (n: number) => void; size?: number }) {
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label="专注评分">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          aria-label={`${n} 分：${RATING_LABELS[n]}`}
          className={`grid h-9 w-9 place-items-center rounded-lg border transition-colors ${
            value >= n
              ? 'border-[color-mix(in_srgb,var(--warning)_32%,var(--border-color))] bg-[color-mix(in_srgb,var(--warning)_12%,var(--bg-secondary))] text-[var(--warning)]'
              : 'border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--warning)]'
          }`}
        >
          <Star size={size} fill={value >= n ? 'currentColor' : 'none'} />
        </button>
      ))}
    </div>
  )
}

function TagChips({ value, onToggle }: { value: string[]; onToggle: (tag: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {POMODORO_TAGS.map((tag) => {
        const on = value.includes(tag)
        return (
          <button
            key={tag}
            type="button"
            onClick={() => onToggle(tag)}
            className={`rounded-full border px-2.5 py-1 text-[10.5px] transition-colors ${
              on
                ? 'border-[color-mix(in_srgb,var(--accent)_34%,var(--border-color))] bg-[var(--accent)]/10 text-[var(--accent)]'
                : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--border-color)] hover:text-[var(--text-primary)]'
            }`}
          >
            {tag}
          </button>
        )
      })}
    </div>
  )
}

function TodayStrip({ minutes, sessions, avg, onStats }: { minutes: number; sessions: number; avg: number | null; onStats: () => void }) {
  return (
    <div className="mt-5 flex flex-wrap items-center justify-center gap-2 border-t border-[var(--border-color)] pt-3 text-[10px] text-[var(--text-muted)]">
      <span>今日 <b className="font-medium text-[var(--text-secondary)]">{minutes} 分钟</b></span>
      <span className="opacity-50">·</span>
      <span><b className="font-medium text-[var(--text-secondary)]">{sessions} 场</b>专注</span>
      <span className="opacity-50">·</span>
      <span>平均 <b className="font-medium text-[var(--text-secondary)]">{avg ? `${avg.toFixed(1)} 分` : '—'}</b></span>
      <button type="button" onClick={onStats} className="text-[var(--accent)] hover:underline">查看统计 →</button>
    </div>
  )
}

export function PomodoroPanel() {
  const pom = usePomodoro()
  const { state: ps, mode } = pom

  const [tab, setTab] = useState<'timer' | 'stats'>('timer')
  const [range, setRange] = useState<PomodoroRange>('week')
  const [rows, setRows] = useState<PomodoroSession[]>([])
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null)
  const [rating, setRating] = useState(0)
  const [ratingTags, setRatingTags] = useState<string[]>([])
  const [endConfirm, setEndConfirm] = useState(false)
  const [topicError, setTopicError] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editRating, setEditRating] = useState(0)
  const [editTags, setEditTags] = useState<string[]>([])
  const topicRef = useRef<HTMLInputElement | null>(null)

  const loadSessions = useCallback(async () => {
    try {
      setRows(await listPomodoroSessions())
    } catch {
      setRows([])
    }
  }, [])

  useEffect(() => { void loadSessions() }, [loadSessions])
  useDataChanged('pomodoro', loadSessions)

  // 切换标签页时收起面板（计时继续；运行态由状态栏 / 右栏控件兜底）
  useEffect(() => {
    const handler = () => pom.collapse()
    window.addEventListener('tab-switched', handler)
    return () => window.removeEventListener('tab-switched', handler)
  }, [pom.collapse])

  // 新的一场待评分 → 回到计时 Tab 并清空草稿
  useEffect(() => {
    if (!ps.pendingSession) return
    setTab('timer')
    setRating(0)
    setRatingTags([])
    setEndConfirm(false)
  }, [ps.pendingSession?.id])

  useEffect(() => {
    if (!ps.expanded) return
    if (tab !== 'timer' || mode !== 'idle') return
    const t = window.setTimeout(() => topicRef.current?.focus(), 120)
    return () => window.clearTimeout(t)
  }, [ps.expanded, tab, mode])

  useEffect(() => {
    if (mode !== 'running' && mode !== 'paused') setEndConfirm(false)
  }, [mode])

  // 每次从收起态重新打开都回到计时页（统计页只作为当前停留视图，不变成下次默认）
  const wasExpanded = useRef(false)
  useEffect(() => {
    if (ps.expanded && !wasExpanded.current) {
      setTab('timer')
      setEndConfirm(false)
      setTopicError(false)
    }
    wasExpanded.current = ps.expanded
  }, [ps.expanded])

  const today = useMemo(() => computePomodoroStats(rows, 'today'), [rows])
  const stats = useMemo(() => computePomodoroStats(rows, range), [rows, range])
  const filteredSessions = useMemo(() => {
    const list = selectedTopic
      ? stats.sessions.filter((s) => s.topic === selectedTopic)
      : stats.sessions
    return [...list].sort((a, b) => b.endedAt - a.endedAt).slice(0, 8)
  }, [stats.sessions, selectedTopic])

  if (!ps.expanded) return null

  const openStats = () => {
    setTab('stats')
    void loadSessions()
  }

  const handleStart = () => {
    if (!ps.topic.trim()) {
      setTopicError(true)
      topicRef.current?.focus()
      return
    }
    setTopicError(false)
    if (!pom.startTimer()) {
      showToast({ type: 'warning', message: '先写下这次专注的主题' })
      topicRef.current?.focus()
    }
  }

  const handleFinish = async () => {
    setEndConfirm(false)
    await pom.finishWork()
  }

  const handleSaveRating = async () => {
    if (!rating) return
    const ok = await pom.saveRating(rating, ratingTags)
    if (ok) {
      setRating(0)
      setRatingTags([])
    }
  }

  const toggleRatingTag = (tag: string) => {
    setRatingTags((cur) => {
      if (cur.includes(tag)) return cur.filter((t) => t !== tag)
      if (cur.length >= 3) {
        showToast({ type: 'info', message: '最多选 3 个状态标签' })
        return cur
      }
      return [...cur, tag]
    })
  }

  const toggleEditTag = (tag: string) => {
    setEditTags((cur) => {
      if (cur.includes(tag)) return cur.filter((t) => t !== tag)
      if (cur.length >= 3) {
        showToast({ type: 'info', message: '最多选 3 个状态标签' })
        return cur
      }
      return [...cur, tag]
    })
  }

  const startEditSession = (s: NormalizedPomodoroSession) => {
    if (editingId === s.id) {
      setEditingId(null)
      return
    }
    setEditingId(s.id)
    setEditRating(s.rating ?? 0)
    setEditTags(s.tags)
  }

  const saveSessionEdit = async () => {
    if (!editingId) return
    try {
      const row = await updatePomodoroSession(editingId, {
        rating: editRating || null,
        tags: editRating ? editTags : [],
      })
      if (!row) throw new Error('update failed')
      setRows((cur) => cur.map((r) => (r.id === row.id ? row : r)))
      setEditingId(null)
      showToast({ type: 'success', message: '记录已更新' })
    } catch {
      showToast({ type: 'error', message: '记录更新失败' })
    }
  }

  const avgToday = today.avgRating
  const pending = ps.pendingSession
  const breakMin = pom.preset.break

  return (
    <div data-pomo-panel data-pomo-mode={mode} className="absolute inset-0 z-30 flex flex-col bg-[var(--bg-primary)] kb-view-in">
      {/* Header */}
      <div className="flex h-[38px] shrink-0 items-center gap-2 border-b border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5">
        <button
          type="button"
          onClick={pom.collapse}
          className="grid h-7 w-7 place-items-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          title="返回工作台（计时继续）"
        >
          <ArrowLeft size={14} />
        </button>
        <span className="text-[11.5px] font-semibold tracking-[0.2px] text-[var(--text-secondary)]">番茄钟</span>
        <span className="hidden text-[10px] text-[var(--text-muted)] sm:inline">专注主题 · 结束评分</span>
        <div className="ml-auto flex items-center gap-0.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-0.5">
          <button
            type="button"
            data-pomo-action="tab-timer"
            onClick={() => setTab('timer')}
            className={`flex h-6 items-center gap-1 rounded-md px-2.5 text-[10.5px] transition-colors ${
              tab === 'timer' ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Timer size={12} />计时
          </button>
          <button
            type="button"
            data-pomo-action="tab-stats"
            onClick={openStats}
            className={`relative flex h-6 items-center gap-1 rounded-md px-2.5 text-[10.5px] transition-colors ${
              tab === 'stats' ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <BarChart3 size={12} />统计
            {pending && <span className="h-1.5 w-1.5 rounded-full bg-[var(--warning)]" />}
          </button>
        </div>
      </div>

      {tab === 'stats' ? (
        <StatsView
          stats={stats}
          range={range}
          setRange={setRange}
          selectedTopic={selectedTopic}
          setSelectedTopic={setSelectedTopic}
          filteredSessions={filteredSessions}
          editingId={editingId}
          editRating={editRating}
          editTags={editTags}
          setEditRating={setEditRating}
          toggleEditTag={toggleEditTag}
          startEditSession={startEditSession}
          saveSessionEdit={saveSessionEdit}
          cancelEdit={() => setEditingId(null)}
        />
      ) : (
        <div className="flex-1 overflow-y-auto px-6 pb-8 pt-6 kb-view-in">
          {mode === 'rating' && pending ? (
            <div className="mx-auto flex min-h-full w-full max-w-[620px] flex-col justify-center kb-view-in">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[1.8px] text-[var(--text-muted)]">
                    {pending.completed ? '专注完成' : '本次专注已结束'}
                  </div>
                  <h1 className="mt-1 text-[22px] font-semibold leading-tight tracking-[-0.3px] text-[var(--text-primary)]">
                    {pending.completed ? '给这次专注打个分' : '记下真实的节奏'}
                  </h1>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                    {pending.completed
                      ? '这段专注完整走完，给这次状态留个记录吧。'
                      : '提前结束也没关系，记录真实的专注时长比追求完整更重要。'}
                  </p>
                </div>
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[color-mix(in_srgb,var(--success)_22%,var(--border-color))] bg-[var(--success)]/10 text-[var(--success)]">
                  <Check size={20} />
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5">
                <span className="flex min-w-0 items-center gap-2 text-[12.5px] font-semibold text-[var(--text-primary)]">
                  <i className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: topicColor(pending.topic || '') }} />
                  <span className="truncate">{pending.topic || '未命名专注'}</span>
                </span>
                <span className="ml-auto text-[10.5px] text-[var(--text-muted)]">
                  {pending.minutes} 分钟 · {pending.completed ? '自然完成' : `提前结束 · 计划 ${pending.planned_minutes ?? '—'} 分钟`}
                </span>
              </div>

              <div className="mt-5">
                <div className="text-[11.5px] font-semibold text-[var(--text-secondary)]">这次专注的状态如何？</div>
                <div className="mt-2"><Stars value={rating} onChange={setRating} /></div>
                <div className="mt-1.5 min-h-[18px] text-[11px] text-[var(--text-secondary)]">
                  {rating ? <><b className="text-[var(--text-primary)]">{rating} 分</b> · {RATING_LABELS[rating]}</> : '点击星星评分'}
                </div>
              </div>

              <div className="mt-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[10.5px] font-semibold text-[var(--text-secondary)]">什么影响了状态？</span>
                  <span className="text-[9.5px] text-[var(--text-muted)]">可选 · 最多 3 个</span>
                </div>
                <TagChips value={ratingTags} onToggle={toggleRatingTag} />
              </div>

              <div className="mt-5 flex max-w-[340px] flex-col gap-1.5">
                <button
                  type="button"
                  data-pomo-action="save-rating"
                  onClick={() => void handleSaveRating()}
                  disabled={!rating}
                  className="flex h-11 items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] text-[12.5px] font-semibold text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
                >
                  <Check size={15} />保存记录
                </button>
                <button
                  type="button"
                  data-pomo-action="skip-rating"
                  onClick={pom.skipRating}
                  className="py-1 text-center text-[10.5px] text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
                >
                  稍后评分，先休息
                </button>
              </div>

              <TodayStrip minutes={today.totalMinutes} sessions={today.sessionCount} avg={avgToday} onStats={openStats} />
            </div>
          ) : mode === 'breakReady' || mode === 'breakRunning' || mode === 'breakDone' ? (
            <div className="mx-auto flex min-h-full w-full max-w-[440px] flex-col items-center justify-center text-center kb-view-in">
              <div className="mb-2.5 grid h-11 w-11 place-items-center rounded-xl bg-[var(--success)]/10 text-[var(--success)]">
                <Coffee size={22} />
              </div>
              <div className="text-[10px] font-semibold uppercase tracking-[1.8px] text-[var(--text-muted)]">
                {mode === 'breakDone' ? '休息结束' : mode === 'breakReady' ? '休息' : '休息中'}
              </div>
              <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.3px] text-[var(--text-primary)]">
                {mode === 'breakDone' ? '准备好下一轮了吗？' : mode === 'breakReady' ? '休息一下' : '正在休息'}
              </h1>
              <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                {mode === 'breakDone'
                  ? '刚才的专注已经记录。可以再来一轮，或者回到准备页。'
                  : mode === 'breakReady'
                    ? `建议休息 ${breakMin} 分钟：站起来走走，看看远处，下一轮会更专注。`
                    : '让眼睛离开屏幕一会儿，别急着开始下一轮。'}
              </p>
              <div className="mt-2">
                <TimerRing
                  progress={mode === 'breakReady' ? 0 : pom.progress}
                  color="var(--success)"
                >
                  <div className="font-mono text-[44px] font-light leading-none tracking-[0.5px] tabular-nums text-[var(--text-primary)]">
                    {mode === 'breakReady' ? `${String(breakMin).padStart(2, '0')}:00` : pom.display}
                  </div>
                  <div className="text-[10.5px] tracking-[1.4px] text-[var(--text-muted)]">
                    {mode === 'breakDone' ? '休息结束' : '休息时间'}
                  </div>
                </TimerRing>
              </div>
              <div className="mt-3 flex w-full max-w-[310px] flex-col gap-1.5">
                {mode === 'breakReady' && (
                  <>
                    <button type="button" data-pomo-action="start-break" onClick={pom.startBreak} className="flex h-11 items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] text-[12.5px] font-semibold text-white transition-colors hover:bg-[var(--accent-hover)]">
                      <Coffee size={15} />开始休息 {breakMin} 分钟
                    </button>
                    <button type="button" data-pomo-action="skip-break" onClick={pom.skipBreak} className="h-9 rounded-lg border border-[var(--border-color)] text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)]">跳过休息</button>
                  </>
                )}
                {mode === 'breakRunning' && (
                  <button type="button" data-pomo-action="skip-break" onClick={pom.skipBreak} className="h-9 rounded-lg border border-[var(--border-color)] text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)]">跳过休息</button>
                )}
                {mode === 'breakDone' && (
                  <>
                    <button type="button" data-pomo-action="next-round" onClick={() => { if (!pom.startNextRound()) showToast({ type: 'warning', message: '主题为空，先回到准备页填写' }) }} className="flex h-11 items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] text-[12.5px] font-semibold text-white transition-colors hover:bg-[var(--accent-hover)]">
                      <Play size={15} />再来一轮
                    </button>
                    <button type="button" data-pomo-action="back-to-setup" onClick={pom.resetTimer} className="h-9 rounded-lg border border-[var(--border-color)] text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)]">回到准备</button>
                  </>
                )}
              </div>
            </div>
          ) : mode === 'running' || mode === 'paused' ? (
            <div className="mx-auto flex min-h-full w-full max-w-[620px] flex-col items-center justify-center kb-view-in">
              <div className="flex min-h-[46px] flex-col items-center gap-1.5">
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] tracking-[0.7px] ${
                  mode === 'paused' ? 'bg-[var(--warning)]/10 text-[var(--warning)]' : 'bg-[var(--accent)]/10 text-[var(--accent)]'
                }`}>
                  <i className={`h-1.5 w-1.5 rounded-full ${mode === 'paused' ? '' : 'animate-pulse'} bg-current`} />
                  {mode === 'paused' ? '已暂停' : '正在专注'}
                </span>
                <div className="max-w-[90%] truncate text-[13.5px] font-semibold text-[var(--text-primary)]">{ps.topic}</div>
              </div>

              <div className="mt-1.5">
                <TimerRing progress={pom.progress} color={mode === 'paused' ? 'var(--warning)' : 'var(--accent)'}>
                  <div className="font-mono text-[44px] font-light leading-none tracking-[0.5px] tabular-nums text-[var(--text-primary)]">{pom.display}</div>
                  <div className="text-[10.5px] tracking-[1.4px] text-[var(--text-muted)]">{mode === 'paused' ? '计时已暂停' : '保持专注'}</div>
                </TimerRing>
              </div>

              <div className="mt-2 flex items-center justify-center gap-2">
                <button
                  type="button"
                  data-pomo-action="toggle"
                  onClick={() => { if (mode === 'paused') pom.startTimer(); else pom.pauseTimer() }}
                  className="flex min-w-[108px] items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-[12.5px] font-semibold text-white transition-colors hover:bg-[var(--accent-hover)]"
                >
                  {mode === 'paused' ? <><Play size={15} />继续</> : <><Pause size={15} />暂停</>}
                </button>
                <button
                  type="button"
                  data-pomo-action="end"
                  onClick={() => setEndConfirm(true)}
                  className="flex min-w-[108px] items-center justify-center gap-1.5 rounded-lg border border-[var(--border-color)] px-4 py-2 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
                >
                  <Square size={13} />结束
                </button>
              </div>

              {endConfirm && (
                <div className="mt-3 w-full max-w-[380px] rounded-lg border border-[color-mix(in_srgb,var(--warning)_28%,var(--border-color))] bg-[var(--warning)]/10 px-3.5 py-3 kb-item-in">
                  <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
                    现在结束？已专注 <b className="text-[var(--text-primary)]">{fmtElapsed(pom.totalSeconds - ps.seconds)}</b>，会记录为提前结束。
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button type="button" data-pomo-action="cancel-end" onClick={() => setEndConfirm(false)} className="h-8 flex-1 rounded-md border border-[var(--border-color)] text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]">继续专注</button>
                    <button type="button" data-pomo-action="confirm-end" onClick={() => void handleFinish()} className="h-8 flex-1 rounded-md bg-[var(--accent)] text-[10.5px] font-semibold text-white hover:bg-[var(--accent-hover)]">确认结束</button>
                  </div>
                </div>
              )}

              <p className="mt-3 text-center text-[10px] leading-relaxed text-[var(--text-muted)]">提前结束会记录实际专注时长，不会丢掉这一场。</p>
              <TodayStrip minutes={today.totalMinutes} sessions={today.sessionCount} avg={avgToday} onStats={openStats} />
            </div>
          ) : (
            <div className="mx-auto w-full max-w-[620px] kb-view-in">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[1.8px] text-[var(--text-muted)]">准备专注</div>
                  <h1 className="mt-1 text-[24px] font-semibold leading-tight tracking-[-0.3px] text-[var(--text-primary)]">这次要专注什么？</h1>
                </div>
                <div className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-1 text-[10.5px] text-[var(--text-secondary)]">
                  <Timer size={12} />今日 <b className="font-semibold text-[var(--text-primary)]">{today.totalMinutes} 分钟</b>
                </div>
              </div>

              <div className="mt-5">
                <div className="mb-1.5 flex items-center justify-between">
                  <label htmlFor="pomo-topic" className="text-[11.5px] font-semibold text-[var(--text-secondary)]">专注主题</label>
                  <span className="text-[10px] text-[var(--text-muted)]">必填 · 用于统计</span>
                </div>
                <div className={`flex h-11 items-center gap-2 rounded-[10px] border bg-[var(--bg-secondary)] px-3 transition-colors focus-within:border-[var(--accent)] focus-within:bg-[var(--bg-primary)] ${
                  topicError ? 'border-[var(--danger)]' : 'border-[var(--border-color)]'
                }`}>
                  <Target size={16} className="shrink-0 text-[var(--text-muted)]" />
                  <input
                    id="pomo-topic"
                    ref={topicRef}
                    value={ps.topic}
                    onChange={(e) => { pom.setTopic(e.target.value); setTopicError(false) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleStart() }}
                    maxLength={30}
                    autoComplete="off"
                    placeholder="例如：操作系统学习"
                    style={{ background: 'transparent', border: 0, boxShadow: 'none' }}
                    className="min-w-0 flex-1 text-[13.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                  />
                  <span className="text-[9.5px] tabular-nums text-[var(--text-muted)]">{ps.topic.length}/30</span>
                </div>
                {topicError && (
                  <div className="mt-1.5 flex items-center gap-1 text-[10.5px] text-[var(--danger)]">
                    <AlertCircle size={12} />先写下这次专注的主题，再开始。
                  </div>
                )}
              </div>

              <div className="mt-2.5 flex min-h-[22px] flex-wrap items-center gap-1.5">
                <span className="mr-0.5 text-[10px] text-[var(--text-muted)]">最近</span>
                {ps.recentTopics.length ? ps.recentTopics.map((topic) => (
                  <button
                    key={topic}
                    type="button"
                    onClick={() => { pom.setTopic(topic); setTopicError(false); topicRef.current?.focus() }}
                    className="rounded-full border border-[var(--border-color)] px-2 py-1 text-[10px] text-[var(--text-secondary)] transition-colors hover:border-[color-mix(in_srgb,var(--accent)_32%,var(--border-color))] hover:bg-[var(--accent)]/10 hover:text-[var(--accent)]"
                  >
                    {topic}
                  </button>
                )) : <span className="text-[10px] text-[var(--text-muted)]">完成第一场后会出现最近主题</span>}
              </div>

              <div className="mt-2 flex justify-center">
                <TimerRing progress={0}>
                  <div className="font-mono text-[44px] font-light leading-none tracking-[0.5px] tabular-nums text-[var(--text-primary)]">
                    {String(pom.preset.work).padStart(2, '0')}:00
                  </div>
                  <div className="text-[10.5px] tracking-[1.4px] text-[var(--text-muted)]">准备开始</div>
                </TimerRing>
              </div>

              <div className="mx-auto flex w-fit items-center gap-0.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-0.5">
                {pom.presets.map((p, i) => (
                  <button
                    key={`${p.label}-${i}`}
                    type="button"
                    onClick={() => pom.setPresetIdx(i)}
                    className={`rounded-md px-3 py-1.5 text-[10.5px] font-medium transition-colors ${
                      ps.presetIdx === i ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {p.work} <b className={ps.presetIdx === i ? 'text-[var(--accent)]' : ''}>分钟</b>
                  </button>
                ))}
              </div>

              <div className="mx-auto mt-3 flex max-w-[330px] flex-col gap-1.5">
                <button
                  type="button"
                  data-pomo-action="start"
                  onClick={handleStart}
                  className="flex h-11 items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] text-[12.5px] font-semibold text-white shadow-[0_5px_16px_color-mix(in_srgb,var(--accent)_25%,transparent)] transition-colors hover:bg-[var(--accent-hover)]"
                >
                  <Play size={15} />开始专注
                </button>
                <p className="text-center text-[10px] leading-relaxed text-[var(--text-muted)]">结束后记录实际时长，并给这次状态打分。</p>
              </div>

              <TodayStrip minutes={today.totalMinutes} sessions={today.sessionCount} avg={avgToday} onStats={openStats} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ================= 统计视图 ================= */

function StatsView({
  stats, range, setRange, selectedTopic, setSelectedTopic, filteredSessions,
  editingId, editRating, editTags, setEditRating, toggleEditTag, startEditSession, saveSessionEdit, cancelEdit,
}: {
  stats: ReturnType<typeof computePomodoroStats>
  range: PomodoroRange
  setRange: (r: PomodoroRange) => void
  selectedTopic: string | null
  setSelectedTopic: (t: string | null) => void
  filteredSessions: NormalizedPomodoroSession[]
  editingId: string | null
  editRating: number
  editTags: string[]
  setEditRating: (n: number) => void
  toggleEditTag: (tag: string) => void
  startEditSession: (s: NormalizedPomodoroSession) => void
  saveSessionEdit: () => Promise<void>
  cancelEdit: () => void
}) {
  const delta = stats.prevMinutes > 0
    ? Math.round(((stats.totalMinutes - stats.prevMinutes) / stats.prevMinutes) * 100)
    : null
  const deltaLabel = range === 'today' ? '昨日' : range === 'week' ? '上周' : '上月'
  const avg = stats.avgRating
  const topTopics = stats.topics.slice(0, 5)
  const hiddenTopics = stats.topics.length - topTopics.length
  const topicMax = Math.max(...topTopics.map((t) => t.minutes), 1)
  const filteredTotal = selectedTopic ? stats.sessions.filter((s) => s.topic === selectedTopic).length : stats.sessionCount

  const insight = stats.bestTime && stats.ratedCount >= 3
    ? {
      title: `你在${stats.bestTime.label}的专注评分最高（${stats.bestTime.avg.toFixed(1)} 分）`,
      sub: `把最难的任务放在 ${String(stats.bestTime.from).padStart(2, '0')}:00–${String(stats.bestTime.to).padStart(2, '0')}:00，可能更容易进入状态。`,
    }
    : avg
      ? { title: `当前平均专注评分 ${avg.toFixed(1)} 分`, sub: '完成更多场次后，这里会显示你的高效时段。' }
      : { title: '完成几场专注后，这里会出现你的节奏洞察', sub: '评分、完成率和主题分布会一起帮你找到更好的专注节奏。' }

  return (
    <div className="flex-1 overflow-y-auto px-6 pb-8 pt-5 kb-view-in">
      <div className="mb-3.5 flex items-end justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[1.8px] text-[var(--text-muted)]">专注统计</div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.3px] text-[var(--text-primary)]">把注意力花在哪里</h1>
        </div>
        <div className="flex items-center gap-0.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-0.5">
          {(Object.keys(RANGE_LABEL) as PomodoroRange[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`rounded-md px-2.5 py-1 text-[10.5px] transition-colors ${
                range === r ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>

      <div
        className="mb-3 flex items-start gap-2.5 rounded-[10px] border border-[color-mix(in_srgb,var(--accent)_20%,var(--border-color))] px-3.5 py-3"
        style={{ background: 'linear-gradient(105deg, color-mix(in srgb, var(--accent) 8%, transparent), transparent 74%), var(--card-bg)' }}
      >
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--accent)]/10 text-[var(--accent)]"><Sparkles size={15} /></div>
        <div>
          <div className="text-[11.5px] font-semibold leading-relaxed text-[var(--text-primary)]">{insight.title}</div>
          <div className="mt-0.5 text-[10px] leading-relaxed text-[var(--text-muted)]">{insight.sub}</div>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        <MetricCard label="专注时长" icon={<Timer size={12} />} value={`${stats.totalMinutes}`} unit="分钟">
          {delta === null ? (
            <span className="text-[var(--text-muted)]">{deltaLabel}无记录</span>
          ) : (
            <span className={delta > 0 ? 'text-[var(--success)]' : delta < 0 ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'}>
              {delta > 0 ? <TrendingUp size={11} /> : delta < 0 ? <TrendingDown size={11} /> : <Minus size={11} />}
              {delta > 0 ? '+' : ''}{delta}% <span className="text-[var(--text-muted)]">较{deltaLabel}</span>
            </span>
          )}
        </MetricCard>
        <MetricCard label="完成场次" icon={<Check size={12} />} value={`${stats.sessionCount}`} unit="场">
          <span>自然完成 {stats.naturalCount} 场{stats.earlyCount ? ` · 提前 ${stats.earlyCount} 场` : ''}</span>
        </MetricCard>
        <MetricCard label="平均评分" icon={<Star size={12} />} value={avg ? avg.toFixed(1) : '—'} unit={avg ? '/ 5' : ''}>
          <span className="flex items-center gap-0.5 text-[var(--warning)]">
            {avg ? [1, 2, 3, 4, 5].map((n) => (
              <Star key={n} size={10} fill={n <= Math.round(avg) ? 'currentColor' : 'none'} className={n <= Math.round(avg) ? '' : 'text-[var(--bg-tertiary)]'} />
            )) : null}
            <span className="ml-1 text-[var(--text-muted)]">{stats.ratedCount ? `${stats.ratedCount} 场已评分` : '还没有评分'}</span>
          </span>
        </MetricCard>
        <MetricCard label="自然完成率" icon={<Sparkles size={12} />} value={stats.completionPct === null ? '—' : `${stats.completionPct}`} unit={stats.completionPct === null ? '' : '%'}>
          <span>{stats.sessionCount ? `${stats.naturalCount} 场走完 · ${stats.earlyCount} 场提前` : '还没有记录'}</span>
        </MetricCard>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-[11px] border border-[var(--border-color)] bg-[var(--card-bg)] px-4 py-3.5 md:col-span-2">
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[12.5px] font-semibold text-[var(--text-primary)]">
              {range === 'week' ? '本周专注趋势' : range === 'month' ? '本月专注热力' : '今日专注节奏'}
            </h2>
            {range === 'week' && (
              <div className="flex flex-wrap justify-end gap-2">
                {topTopics.map((t) => (
                  <span key={t.topic} className="flex items-center gap-1 text-[9px] text-[var(--text-muted)]">
                    <i className="h-1.5 w-1.5 rounded-full" style={{ background: topicColor(t.topic) }} />{t.topic}
                  </span>
                ))}
                {stats.untopicCount > 0 && (
                  <span className="flex items-center gap-1 text-[9px] text-[var(--text-muted)]">
                    <i className="h-1.5 w-1.5 rounded-full bg-[var(--text-muted)]" />未命名
                  </span>
                )}
              </div>
            )}
            {range === 'today' && (
              <span className="flex items-center gap-1 text-[9px] text-[var(--text-muted)]">
                <i className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />专注分钟
              </span>
            )}
          </div>
          {range === 'week' && <WeekChart days={stats.days} />}
          {range === 'today' && <TodayChart hourMinutes={stats.hourMinutes} />}
          {range === 'month' && <MonthChart stats={stats} />}
        </div>

        <div className="flex flex-col rounded-[11px] border border-[var(--border-color)] bg-[var(--card-bg)] px-4 py-3.5">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <h2 className="text-[12.5px] font-semibold text-[var(--text-primary)]">专注质量</h2>
            <span className="text-[9.5px] text-[var(--text-muted)]">{stats.ratedCount ? `${stats.ratedCount} 场已评分` : '等待第一场评分'}</span>
          </div>
          {stats.ratedCount === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1.5 py-8 text-center text-[10.5px] leading-relaxed text-[var(--text-muted)]">
              <Star size={22} className="opacity-50" />还没有评分<br />结束专注后给这次状态打个分
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <div className="text-[32px] font-light leading-none tracking-[-1px] tabular-nums text-[var(--text-primary)]">
                  {avg?.toFixed(1)}<span className="ml-1 text-[10px] tracking-normal text-[var(--text-muted)]">/ 5</span>
                </div>
                <div>
                  <div className="flex items-center gap-0.5 text-[var(--warning)]">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Star key={n} size={12} fill={n <= Math.round(avg ?? 0) ? 'currentColor' : 'none'} className={n <= Math.round(avg ?? 0) ? '' : 'text-[var(--bg-tertiary)]'} />
                    ))}
                  </div>
                  <div className="mt-0.5 text-[9.5px] text-[var(--text-muted)]">{stats.ratedCount} 场已评分</div>
                </div>
              </div>
              {stats.quality.naturalAvg !== null && stats.quality.earlyAvg !== null && (
                <div className="mt-3 grid grid-cols-2 gap-1.5">
                  <div className="rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1.5">
                    <span className="block text-[9px] text-[var(--text-muted)]">自然完成</span>
                    <b className="mt-0.5 block text-[13px] font-semibold text-[var(--text-primary)]">{stats.quality.naturalAvg.toFixed(1)} 分</b>
                  </div>
                  <div className="rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1.5">
                    <span className="block text-[9px] text-[var(--text-muted)]">提前结束</span>
                    <b className="mt-0.5 block text-[13px] font-semibold text-[var(--text-primary)]">{stats.quality.earlyAvg.toFixed(1)} 分</b>
                  </div>
                </div>
              )}
              <div className="mt-3 flex flex-col gap-1">
                {stats.quality.distribution.map((d) => {
                  const max = Math.max(...stats.quality.distribution.map((x) => x.count), 1)
                  return (
                    <div key={d.score} className="grid grid-cols-[10px_1fr_20px] items-center gap-1.5 text-[9px] text-[var(--text-muted)]">
                      <span>{d.score}</span>
                      <span className="h-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
                        <span className="block h-full rounded-full bg-[var(--warning)] opacity-80" style={{ width: `${(d.count / max) * 100}%` }} />
                      </span>
                      <span>{d.count}</span>
                    </div>
                  )
                })}
              </div>
              {stats.quality.tags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1 border-t border-[var(--border-color)] pt-2.5">
                  {stats.quality.tags.map((t) => (
                    <span key={t.tag} className="inline-flex items-center gap-1 rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[9px] text-[var(--text-secondary)]">
                      {t.tag}<b className="font-semibold text-[var(--text-muted)]">{t.count}</b>
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex flex-col rounded-[11px] border border-[var(--border-color)] bg-[var(--card-bg)] px-4 py-3.5">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <h2 className="text-[12.5px] font-semibold text-[var(--text-primary)]">主题分布</h2>
            <span className="text-[9.5px] text-[var(--text-muted)]">
              {stats.topics.length ? `${stats.topics.length} 个主题${hiddenTopics > 0 ? ` · 显示前 5 个` : ''}` : '按专注时长排序'}
            </span>
          </div>
          {!topTopics.length ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 py-8 text-center text-[10.5px] leading-relaxed text-[var(--text-muted)]">
              还没有主题数据{stats.untopicCount ? <><br />{stats.untopicCount} 场旧记录未填写主题</> : null}
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-0.5">
                {topTopics.map((t) => (
                  <button
                    key={t.topic}
                    type="button"
                    onClick={() => setSelectedTopic(selectedTopic === t.topic ? null : t.topic)}
                    className={`rounded-md px-1.5 py-1.5 text-left transition-colors ${selectedTopic === t.topic ? 'bg-[var(--accent)]/10' : 'hover:bg-[var(--bg-secondary)]'}`}
                  >
                    <span className="flex items-center gap-1.5">
                      <i className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: topicColor(t.topic) }} />
                      <span className="min-w-0 truncate text-[10.5px] text-[var(--text-primary)]">{t.topic}</span>
                      <span className="ml-auto whitespace-nowrap text-[9px] text-[var(--text-muted)]">{Math.round(t.minutes)} 分钟 · {t.sessions} 场</span>
                      <span className="w-7 shrink-0 text-right text-[9px] text-[var(--warning)]">{t.avgRating ? t.avgRating.toFixed(1) : '—'}</span>
                    </span>
                    <span className="mt-1 block h-[3px] overflow-hidden rounded-full bg-[var(--bg-tertiary)] pl-3">
                      <span className="block h-full rounded-full opacity-80" style={{ width: `${(t.minutes / topicMax) * 100}%`, background: topicColor(t.topic) }} />
                    </span>
                  </button>
                ))}
              </div>
              {hiddenTopics > 0 && (
                <div className="mt-2 border-t border-[var(--border-color)] pt-2 text-center text-[9px] text-[var(--text-muted)]">
                  还有 {hiddenTopics} 个主题 · 按专注时长取前 5 个
                </div>
              )}
              {stats.untopicCount > 0 && (
                <div className="mt-1.5 text-center text-[9px] text-[var(--text-muted)]">另有 {stats.untopicCount} 场旧记录未填写主题</div>
              )}
            </>
          )}
        </div>

        <div className="rounded-[11px] border border-[var(--border-color)] bg-[var(--card-bg)] px-4 py-3.5 md:col-span-2">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-[12.5px] font-semibold text-[var(--text-primary)]">最近记录</h2>
            {selectedTopic && (
              <button type="button" onClick={() => setSelectedTopic(null)} className="text-[10px] text-[var(--accent)] hover:underline">
                清除「{selectedTopic}」筛选
              </button>
            )}
          </div>
          {!filteredSessions.length ? (
            <div className="py-7 text-center text-[10.5px] text-[var(--text-muted)]">
              {selectedTopic ? '这个主题在所选时间段没有记录' : '这个时间段还没有专注记录'}
            </div>
          ) : (
            <div className="flex flex-col">
              {filteredSessions.map((s) => (
                <div key={s.id}>
                  <button
                    type="button"
                    onClick={() => startEditSession(s)}
                    className="grid w-full grid-cols-[86px_minmax(0,1fr)_104px_58px_14px] items-center gap-2 rounded-md px-1.5 py-2 text-left transition-colors hover:bg-[var(--bg-secondary)]"
                  >
                    <span className="flex flex-col">
                      <b className="font-mono text-[9.5px] font-medium text-[var(--text-secondary)]">{formatClock(s.startedAt)}</b>
                      <span className="text-[8px] text-[var(--text-muted)]">{formatDayLabel(s.endedAt)}</span>
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-[var(--text-primary)]">
                      <i className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: s.topic ? topicColor(s.topic) : 'var(--text-muted)' }} />
                      <span className="truncate">{s.topic || '未命名专注（旧记录）'}</span>
                    </span>
                    <span className="whitespace-nowrap text-[9.5px] text-[var(--text-muted)]">
                      {s.minutes} 分钟{s.completed ? '' : <span className="text-[var(--warning)]"> · 提前</span>}
                    </span>
                    <span className={`whitespace-nowrap text-[9.5px] ${s.rating ? 'text-[var(--warning)]' : 'text-[var(--warning)]'}`}>
                      {s.rating ? `${'★'.repeat(s.rating)}${'☆'.repeat(5 - s.rating)}` : '待评分'}
                    </span>
                    <span className="grid place-items-center text-[var(--text-muted)]"><ChevronRight size={12} /></span>
                  </button>
                  {editingId === s.id && (
                    <div className="mb-1 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5 kb-item-in">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10.5px] font-semibold text-[var(--text-secondary)]">补评分</span>
                        <Stars value={editRating} onChange={setEditRating} size={14} />
                        <span className="text-[10px] text-[var(--text-muted)]">{editRating ? RATING_LABELS[editRating] : '未评分'}</span>
                      </div>
                      <div className="mt-2"><TagChips value={editTags} onToggle={toggleEditTag} /></div>
                      <div className="mt-2.5 flex justify-end gap-1.5">
                        <button type="button" onClick={cancelEdit} className="h-7 rounded-md border border-[var(--border-color)] px-2.5 text-[10px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">取消</button>
                        <button type="button" onClick={() => void saveSessionEdit()} className="h-7 rounded-md bg-[var(--accent)] px-2.5 text-[10px] font-semibold text-white hover:bg-[var(--accent-hover)]">保存</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="mt-1 border-t border-[var(--border-color)] pt-1.5 text-center text-[9px] text-[var(--text-muted)]">
            仅显示最近 8 条 · 共 {filteredTotal} 条
          </div>
        </div>
      </div>

      <div className="mt-4 text-center text-[9px] leading-relaxed text-[var(--text-muted)]">
        统计来自本地 .knowbase/modules/pomodoro/sessions.json · 旧记录无主题，只计入时长与场次
      </div>
    </div>
  )
}

function MetricCard({ label, icon, value, unit, children }: { label: string; icon: ReactNode; value: string; unit: string; children: ReactNode }) {
  return (
    <div className="rounded-[10px] border border-[var(--border-color)] bg-[var(--card-bg)] px-3 py-3">
      <div className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">{icon}{label}</div>
      <div className="mt-1.5 text-[22px] font-semibold leading-none tracking-[-0.6px] tabular-nums text-[var(--text-primary)]">
        {value}<span className="ml-1 text-[10px] font-medium tracking-normal text-[var(--text-muted)]">{unit}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-1 text-[9.5px] text-[var(--text-muted)]">{children}</div>
    </div>
  )
}

function WeekChart({ days }: { days: ReturnType<typeof computePomodoroStats>['days'] }) {
  const max = Math.max(...days.map((d) => d.minutes), 1)
  if (!days.some((d) => d.minutes > 0)) {
    return <div className="grid h-[210px] place-items-center text-center text-[10.5px] leading-relaxed text-[var(--text-muted)]">本周还没有专注记录<br />完成一场后，这里会出现趋势</div>
  }
  return (
    <div className="flex h-[210px] items-end gap-2 px-1">
      {days.map((d) => {
        const isToday = new Date().toDateString() === d.date.toDateString()
        return (
          <div key={d.key} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${d.date.getMonth() + 1}月${d.date.getDate()}日 · ${Math.round(d.minutes)} 分钟`}>
            <div className="h-[10px] text-[8px] text-[var(--text-muted)]">{d.minutes ? Math.round(d.minutes) : ''}</div>
            <div className="flex w-full max-w-[38px] flex-1 items-end justify-center">
              {d.minutes > 0 ? (
                <div className="flex w-full flex-col-reverse overflow-hidden rounded-t-[4px]" style={{ height: `${Math.max(2, (d.minutes / max) * 100)}%` }}>
                  {d.topics.map((t) => (
                    <span key={t.topic || '__none'} style={{ height: `${(t.minutes / d.minutes) * 100}%`, background: t.topic ? topicColor(t.topic) : 'var(--text-muted)' }} />
                  ))}
                </div>
              ) : (
                <div className="h-[2px] w-full rounded-full bg-[var(--bg-tertiary)]" />
              )}
            </div>
            <div className={`text-[9px] ${isToday ? 'font-bold text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}>周{weekdayCN(d.date)}</div>
            <div className="font-mono text-[8px] text-[var(--text-muted)]">{String(d.date.getMonth() + 1).padStart(2, '0')}/{String(d.date.getDate()).padStart(2, '0')}</div>
          </div>
        )
      })}
    </div>
  )
}

function TodayChart({ hourMinutes }: { hourMinutes: number[] }) {
  const max = Math.max(...hourMinutes, 1)
  if (!hourMinutes.some((m) => m > 0)) {
    return <div className="grid h-[210px] place-items-center text-center text-[10.5px] leading-relaxed text-[var(--text-muted)]">今天还没有专注记录<br />完成一场后，这里会出现节奏</div>
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-[172px] items-end gap-[3px] px-0.5">
        {hourMinutes.map((m, h) => (
          <span
            key={h}
            title={`${String(h).padStart(2, '0')}:00 · ${Math.round(m)} 分钟`}
            className={`flex-1 rounded-t-[2px] ${m ? 'bg-[var(--accent)] opacity-90' : 'bg-[var(--bg-tertiary)] opacity-60'}`}
            style={{ height: m ? `${Math.max(3, (m / max) * 100)}%` : '2px' }}
          />
        ))}
      </div>
      <div className="flex justify-between px-0.5 font-mono text-[8px] text-[var(--text-muted)]">
        {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => <span key={h}>{String(h).padStart(2, '0')}:00</span>)}
      </div>
    </div>
  )
}

function MonthChart({ stats }: { stats: ReturnType<typeof computePomodoroStats> }) {
  const month = stats.month
  if (!month.recordedDays) {
    return <div className="grid h-[210px] place-items-center text-center text-[10.5px] leading-relaxed text-[var(--text-muted)]">本月还没有专注记录<br />完成一场后，这里会出现热力图</div>
  }
  const levelClass = (level: number) =>
    level === 0 ? 'border-[var(--border-color)] bg-[var(--bg-secondary)]'
      : level === 1 ? 'border-transparent bg-[color-mix(in_srgb,var(--accent)_18%,var(--bg-secondary))]'
        : level === 2 ? 'border-transparent bg-[color-mix(in_srgb,var(--accent)_34%,var(--bg-secondary))]'
          : level === 3 ? 'border-transparent bg-[color-mix(in_srgb,var(--accent)_55%,var(--bg-secondary))]'
            : 'border-transparent bg-[color-mix(in_srgb,var(--accent)_78%,var(--bg-secondary))]'

  return (
    <div className="flex flex-wrap items-start justify-center gap-5 py-1.5">
      <div className="grid grid-rows-7 gap-1.5 pr-0.5 text-[8.5px] text-[var(--text-muted)]">
        {['一', '二', '三', '四', '五', '六', '日'].map((d) => <span key={d} className="flex h-5 items-center justify-end">{d}</span>)}
      </div>
      <div>
        <div className="flex gap-1.5">
          {month.weeks.map((col, ci) => (
            <div key={ci} className="grid grid-rows-7 gap-1.5">
              {col.map((cell, ri) => cell.blank ? (
                <span key={ri} className="h-5 w-5" />
              ) : (
                <span
                  key={ri}
                  title={`${cell.key} · ${Math.round(cell.minutes)} 分钟`}
                  className={`h-5 w-5 rounded-[4px] border transition-transform hover:scale-110 ${levelClass(cell.level)} ${cell.isToday ? 'ring-2 ring-[var(--accent)]' : ''}`}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-end gap-1 text-[8.5px] text-[var(--text-muted)]">
          <span>少</span>
          {[0, 1, 2, 3, 4].map((l) => <i key={l} className={`h-2.5 w-2.5 rounded-[2px] ${levelClass(l)}`} />)}
          <span>多</span>
        </div>
      </div>
      <div className="min-w-[165px]">
        <h3 className="mb-1.5 text-[9.5px] font-semibold tracking-[0.4px] text-[var(--text-muted)]">本月概览</h3>
        <div className="flex items-baseline justify-between gap-2 border-b border-[var(--border-color)] py-1.5 text-[9.5px] text-[var(--text-secondary)]">
          <span>有记录的天数</span><b className="text-[10.5px] font-semibold text-[var(--text-primary)]">{month.recordedDays} 天</b>
        </div>
        <div className="flex items-baseline justify-between gap-2 border-b border-[var(--border-color)] py-1.5 text-[9.5px] text-[var(--text-secondary)]">
          <span>最长连续</span><b className="text-[10.5px] font-semibold text-[var(--text-primary)]">{month.longestStreak} 天</b>
        </div>
        <div className="flex items-baseline justify-between gap-2 border-b border-[var(--border-color)] py-1.5 text-[9.5px] text-[var(--text-secondary)]">
          <span>最专注的一天</span><b className="whitespace-nowrap text-[10.5px] font-semibold text-[var(--text-primary)]">{month.bestDay ? `${month.bestDay.day} 日 · ${Math.round(month.bestDay.minutes)} 分钟` : '—'}</b>
        </div>
        <div className="flex items-baseline justify-between gap-2 py-1.5 text-[9.5px] text-[var(--text-secondary)]">
          <span>主力主题</span><b className="max-w-[110px] truncate text-[10.5px] font-semibold text-[var(--text-primary)]">{month.topTopic || '—'}</b>
        </div>
      </div>
    </div>
  )
}
