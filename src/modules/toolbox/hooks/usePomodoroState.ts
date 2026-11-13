import { useState, useRef, useCallback, useEffect } from 'react'
import { createPomodoroSession, listPomodoroSessions, updatePomodoroSession } from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'
import { useDataChanged } from '../../../lib/dataChanged'
import type { PomodoroSession } from '../../../types'

export interface PomodoroPresetDef { label: string; work: number; break: number }

export const BASE_PRESETS: PomodoroPresetDef[] = [
  { label: '15min', work: 15, break: 3 },
  { label: '25min', work: 25, break: 5 },
  { label: '45min', work: 45, break: 10 },
]

export type Phase = 'work' | 'break'

/** 派生展示态：idle=准备 / running / paused / rating=待评分 / break* */
export type PomodoroMode =
  | 'idle'
  | 'running'
  | 'paused'
  | 'rating'
  | 'breakReady'
  | 'breakRunning'
  | 'breakDone'

export type FinishResult = 'recorded' | 'too-short' | 'failed' | 'ignored'

export const POMODORO_TAGS = [
  '被消息打断',
  '走神',
  '环境嘈杂',
  '身体疲惫',
  '任务太难',
  '状态很好',
  '心流',
  '任务清晰',
  '环境安静',
] as const

export const RATING_LABELS: Record<number, string> = {
  1: '很难集中',
  2: '有些分心',
  3: '还算顺利',
  4: '很专注',
  5: '心流状态',
}

export interface PomodoroState {
  visible: boolean
  expanded: boolean
  presetIdx: number
  phase: Phase
  seconds: number
  running: boolean
  done: boolean
  /** 当前 / 上次主题；开始前必须非空 */
  topic: string
  lastTopic: string
  recentTopics: string[]
  /** 本场首次开始时间；null = 本阶段尚未开始 */
  startedAt: number | null
  /** 当前运行段的墙钟截止时间；暂停 / 未运行 = null（后台节流也不漂移） */
  deadlineAt: number | null
  /** 已落盘、待评分的场次 */
  pendingSession: PomodoroSession | null
  /** 落盘中（防重复提交） */
  finishing: boolean
}

/** presets 可传入插件贡献的扩展预设(合并到内置之后),计时数学全部基于传入列表 */
export function usePomodoroState(presets: PomodoroPresetDef[] = BASE_PRESETS) {
  const [state, setState] = useState<PomodoroState>({
    visible: false,
    expanded: false,
    presetIdx: 0,
    phase: 'work',
    seconds: presets[0].work * 60,
    running: false,
    done: false,
    topic: '',
    lastTopic: '',
    recentTopics: [],
    startedAt: null,
    deadlineAt: null,
    pendingSession: null,
    finishing: false,
  })
  const stateRef = useRef(state)
  stateRef.current = state

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const presetAt = useCallback(
    (idx: number) => presets[Math.min(Math.max(idx, 0), presets.length - 1)] ?? presets[0],
    [presets],
  )

  const clearTimer = useCallback(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
  }, [])

  const startInterval = useCallback(() => {
    clearTimer()
    intervalRef.current = setInterval(() => {
      setState((s) => {
        if (!s.running || s.deadlineAt === null) return s
        // 以墙钟为准：窗口被后台节流时，下一次 tick 直接跳到真实剩余时间，不会越走越慢
        const remaining = Math.max(0, (s.deadlineAt - Date.now()) / 1000)
        if (remaining <= 0.05) return { ...s, seconds: 0, running: false, done: true, deadlineAt: null }
        return { ...s, seconds: Math.ceil(remaining) }
      })
    }, 1000)
  }, [clearTimer])

  // 自然归零 / 外部把 running 置 false 后停掉 interval（避免完成态每秒空转）
  useEffect(() => {
    if (!state.running) clearTimer()
  }, [state.running, clearTimer])

  /** 开始 / 继续。工作阶段必须有主题；topicOverride 用于右栏输入框同一拍提交 */
  const startTimer = useCallback((topicOverride?: string): boolean => {
    const s = stateRef.current
    if (s.finishing) return false
    if (s.pendingSession) {
      setState((p) => ({ ...p, visible: true, expanded: true }))
      return false
    }

    if (s.phase === 'break') {
      if (s.running) return true
      const preset = presetAt(s.presetIdx)
      const nextSeconds = s.startedAt !== null && s.seconds > 0 ? s.seconds : preset.break * 60
      setState((p) => ({
        ...p,
        visible: true,
        running: true,
        done: false,
        seconds: nextSeconds,
        startedAt: p.startedAt ?? Date.now(),
        deadlineAt: Date.now() + nextSeconds * 1000,
      }))
      startInterval()
      return true
    }

    const topic = (topicOverride ?? s.topic).trim().slice(0, 30)
    if (!topic) return false

    const preset = presetAt(s.presetIdx)
    const resuming = s.startedAt !== null && s.seconds > 0 && s.seconds < preset.work * 60
    const nextSeconds = resuming ? s.seconds : preset.work * 60
    setState((p) => ({
      ...p,
      visible: true,
      running: true,
      done: false,
      topic,
      lastTopic: topic,
      seconds: nextSeconds,
      startedAt: resuming ? p.startedAt : Date.now(),
      deadlineAt: Date.now() + nextSeconds * 1000,
    }))
    startInterval()
    return true
  }, [presetAt, startInterval])

  const pauseTimer = useCallback(() => {
    clearTimer()
    setState((s) => {
      const remaining = s.running && s.deadlineAt !== null
        ? Math.max(0, (s.deadlineAt - Date.now()) / 1000)
        : s.seconds
      return { ...s, running: false, seconds: Math.max(0, Math.round(remaining * 10) / 10), deadlineAt: null }
    })
  }, [clearTimer])

  const resetTimer = useCallback(() => {
    clearTimer()
    setState((s) => {
      const preset = presetAt(s.presetIdx)
      return {
        ...s,
        running: false,
        done: false,
        phase: 'work',
        seconds: preset.work * 60,
        startedAt: null,
        deadlineAt: null,
        pendingSession: null,
        finishing: false,
        visible: true,
      }
    })
  }, [clearTimer, presetAt])

  const setPresetIdx = useCallback((idx: number) => {
    const s = stateRef.current
    if (s.running || s.pendingSession || s.startedAt !== null) return
    clearTimer()
    const preset = presetAt(idx)
    setState((p) => ({
      ...p,
      presetIdx: idx,
      phase: 'work',
      seconds: preset.work * 60,
      running: false,
      done: false,
      startedAt: null,
      deadlineAt: null,
    }))
  }, [clearTimer, presetAt])

  const setTopic = useCallback((topic: string) => {
    setState((s) => ({ ...s, topic: String(topic).slice(0, 30) }))
  }, [])

  /** 打开面板（不重置任何进行中的计时） */
  const activate = useCallback((preset?: number) => {
    const s = stateRef.current
    if (s.pendingSession || s.startedAt !== null || s.running || s.phase === 'break') {
      setState((p) => ({ ...p, visible: true, expanded: true }))
      return
    }
    const idx = preset ?? s.presetIdx
    const p = presetAt(idx)
    setState((prev) => ({
      ...prev,
      visible: true,
      expanded: true,
      presetIdx: idx,
      phase: 'work',
      seconds: p.work * 60,
      running: false,
      done: false,
      startedAt: null,
      deadlineAt: null,
      topic: prev.topic || prev.lastTopic,
    }))
  }, [presetAt])

  const expand = useCallback(() => {
    setState((s) => ({ ...s, visible: true, expanded: true }))
  }, [])

  const collapse = useCallback(() => {
    setState((s) => ({ ...s, expanded: false }))
  }, [])

  const hide = useCallback(() => {
    // 只收起界面，不丢弃进行中的计时（运行态由状态栏 / 右栏控件兜底）
    setState((s) => ({ ...s, expanded: false }))
  }, [])

  // Cleanup on unmount
  useEffect(() => () => clearTimer(), [clearTimer])

  // 最近主题（主题输入框预填 + chips）：启动时载入；其它窗口 / AI 写入后同步刷新
  const loadRecentTopics = useCallback(async () => {
    try {
      const rows = await listPomodoroSessions()
      const sorted = [...rows]
        .filter((r) => typeof r.topic === 'string' && r.topic.trim())
        .sort((a, b) => {
          const ta = Date.parse(String(a.ended_at || a.created_at || a.date || '')) || 0
          const tb = Date.parse(String(b.ended_at || b.created_at || b.date || '')) || 0
          return tb - ta
        })
      const recent: string[] = []
      for (const row of sorted) {
        const topic = String(row.topic).trim()
        if (topic && !recent.includes(topic)) recent.push(topic)
        if (recent.length >= 5) break
      }
      const last = recent[0] ?? ''
      setState((s) => ({
        ...s,
        recentTopics: recent.length ? recent : s.recentTopics,
        lastTopic: last || s.lastTopic,
        topic: s.topic || last,
      }))
    } catch { /* 无仓库 / 读取失败时保持空 */ }
  }, [])
  useEffect(() => { void loadRecentTopics() }, [loadRecentTopics])
  useDataChanged('pomodoro', loadRecentTopics)

  /** 落库一场专注；自然完成与提前结束共用。 */
  const saveSession = useCallback(async (completed: boolean): Promise<FinishResult> => {
    const s = stateRef.current
    if (s.phase !== 'work' || s.pendingSession || s.finishing) return 'ignored'

    const preset = presetAt(s.presetIdx)
    const total = preset.work * 60
    const liveRemaining = s.running && s.deadlineAt !== null
      ? Math.max(0, (s.deadlineAt - Date.now()) / 1000)
      : s.seconds
    const elapsed = completed ? total : Math.max(0, total - liveRemaining)
    if (elapsed < 60) {
      clearTimer()
      setState((p) => ({
        ...p,
        running: false,
        done: false,
        startedAt: null,
        deadlineAt: null,
        seconds: preset.work * 60,
        finishing: false,
        visible: true,
      }))
      return 'too-short'
    }

    setState((p) => ({ ...p, running: false, done: true, finishing: true, seconds: 0, deadlineAt: null, visible: true }))
    try {
      const endedAt = new Date()
      const startedAt = new Date(endedAt.getTime() - Math.round(elapsed) * 1000)
      const topic = s.topic.trim().slice(0, 30)
      const row = await createPomodoroSession({
        topic,
        planned_minutes: preset.work,
        actual_seconds: Math.round(elapsed),
        completed,
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
      })
      if (!row) throw new Error('createPomodoroSession returned null')

      setState((p) => ({
        ...p,
        finishing: false,
        done: true,
        pendingSession: row,
        visible: true,
        topic: topic || p.topic,
        lastTopic: topic || p.lastTopic,
        recentTopics: topic
          ? [topic, ...p.recentTopics.filter((t) => t !== topic)].slice(0, 5)
          : p.recentTopics,
      }))
      return 'recorded'
    } catch {
      clearTimer()
      setState((p) => ({
        ...p,
        running: false,
        done: false,
        finishing: false,
        startedAt: null,
        deadlineAt: null,
        seconds: preset.work * 60,
      }))
      showToast({ type: 'error', message: '专注记录保存失败', detail: '请检查仓库是否可写' })
      return 'failed'
    }
  }, [clearTimer, presetAt])

  const naturalRef = useRef(false)
  useEffect(() => {
    if (state.phase !== 'work' || !state.done || state.pendingSession || state.finishing) {
      if (!state.done) naturalRef.current = false
      return
    }
    if (naturalRef.current) return
    naturalRef.current = true
    void saveSession(true)
  }, [state.phase, state.done, state.pendingSession, state.finishing, saveSession])

  /** 提前结束：实际时长 <1 分钟不记录 */
  const finishWork = useCallback(async (): Promise<FinishResult> => {
    naturalRef.current = true
    const result = await saveSession(false)
    if (result === 'too-short') {
      showToast({ type: 'info', message: '本次不足 1 分钟，未记录' })
    }
    return result
  }, [saveSession])

  const enterBreak = useCallback(() => {
    clearTimer()
    const preset = presetAt(stateRef.current.presetIdx)
    setState((p) => ({
      ...p,
      phase: 'break',
      seconds: preset.break * 60,
      running: false,
      done: false,
      startedAt: null,
      deadlineAt: null,
      pendingSession: null,
      finishing: false,
      visible: true,
    }))
  }, [clearTimer, presetAt])

  const saveRating = useCallback(async (rating: number, tags: string[]): Promise<boolean> => {
    const pending = stateRef.current.pendingSession
    if (!pending) return false
    try {
      if (pending.id) {
        const row = await updatePomodoroSession(pending.id, { rating, tags })
        if (!row) throw new Error('update returned null')
      }
      enterBreak()
      showToast({ type: 'success', message: '已记录这次专注' })
      return true
    } catch {
      showToast({ type: 'error', message: '评分保存失败', detail: '可稍后在统计里补评' })
      return false
    }
  }, [enterBreak])

  const skipRating = useCallback(() => {
    enterBreak()
  }, [enterBreak])

  const startBreak = useCallback(() => {
    const s = stateRef.current
    if (s.phase !== 'break' || s.running) return
    const preset = presetAt(s.presetIdx)
    const nextSeconds = s.startedAt !== null && s.seconds > 0 ? s.seconds : preset.break * 60
    setState((p) => ({
      ...p,
      running: true,
      done: false,
      seconds: nextSeconds,
      startedAt: p.startedAt ?? Date.now(),
      deadlineAt: Date.now() + nextSeconds * 1000,
    }))
    startInterval()
  }, [presetAt, startInterval])

  /** 跳过 / 结束休息 → 回准备态（保留主题） */
  const skipBreak = useCallback(() => {
    clearTimer()
    const preset = presetAt(stateRef.current.presetIdx)
    setState((p) => ({
      ...p,
      phase: 'work',
      seconds: preset.work * 60,
      running: false,
      done: false,
      startedAt: null,
      deadlineAt: null,
      pendingSession: null,
      finishing: false,
      visible: true,
    }))
  }, [clearTimer, presetAt])

  /** 休息结束后直接开下一轮（沿用当前主题） */
  const startNextRound = useCallback((): boolean => {
    const s = stateRef.current
    const topic = s.topic.trim().slice(0, 30)
    if (!topic) return false
    clearTimer()
    const preset = presetAt(s.presetIdx)
    setState((p) => ({
      ...p,
      phase: 'work',
      seconds: preset.work * 60,
      running: true,
      done: false,
      startedAt: Date.now(),
      deadlineAt: Date.now() + preset.work * 60 * 1000,
      pendingSession: null,
      finishing: false,
      visible: true,
      lastTopic: topic,
    }))
    startInterval()
    return true
  }, [clearTimer, presetAt, startInterval])

  const preset = presetAt(state.presetIdx)
  const totalSeconds = state.phase === 'work' ? preset.work * 60 : preset.break * 60
  const progress = totalSeconds > 0
    ? Math.max(0, Math.min(1, state.pendingSession ? 1 : 1 - state.seconds / totalSeconds))
    : 0

  const mode: PomodoroMode = state.pendingSession
    ? 'rating'
    : state.phase === 'break'
      ? state.running ? 'breakRunning' : state.done ? 'breakDone' : 'breakReady'
      : state.running
        ? 'running'
        : state.startedAt !== null
          ? 'paused'
          : 'idle'

  const wholeSeconds = Math.max(0, Math.ceil(state.seconds))
  const mins = Math.floor(wholeSeconds / 60)
  const secs = wholeSeconds % 60
  const display = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`

  return {
    state, setState, mode,
    presets, preset, totalSeconds, progress, display,
    startTimer, pauseTimer, resetTimer, setPresetIdx, setTopic,
    finishWork, saveRating, skipRating,
    startBreak, skipBreak, startNextRound,
    activate, expand, collapse, hide,
    isActive: mode !== 'idle',
  }
}
