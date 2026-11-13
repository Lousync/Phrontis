import { useCallback, useEffect, useState } from 'react'
import { Star, Timer } from 'lucide-react'
import { usePomodoro } from '../../../modules/toolbox/hooks/PomodoroContext'
import { getBlogPeriodStats } from '../../../lib/ipc'
import { localToday } from '../../../lib/date'
import { showToast } from '../../../lib/toast'
import { useDataChanged } from '../../../lib/dataChanged'

/** 环形进度几何（2026-09-17 右栏优化轮）：直径/环宽固定，周长派生。
 *  尺寸按右栏简略视图与 DayPanel 小窗的公共下限取 148——两处宿主都不出现横向挤压。 */
const RING_SIZE = 148
const RING_STROKE = 8
const RING_R = (RING_SIZE - RING_STROKE) / 2
const RING_CIRC = 2 * Math.PI * RING_R

/**
 * 番茄钟控件（v3.4.0 批次4：DayPanel「番茄」Tab 迁入 widgets，方案 §3.7）。
 * **右栏简略视图与脱离小窗共用**（不复制渲染）。
 * v3.24.0：开始前必须填写主题（输入框预填上次主题）；结束 = 落库并进入待评分，
 * 评分在完整面板完成；运行态由状态栏 / 本控件持续回看。
 */
interface PomoWidgetProps {
  /** 宿主已自带卡片容器（如右栏下段控件卡）时置 true：本组件不再画自己的卡片/内边距，
   *  只渲染内容 —— 避免「卡中卡」多层嵌套（2026-09-17 反馈：番茄钟看着套了好几层）。
   *  DayPanel 嵌入态不传（那里需要组件自带卡片外观）。 */
  frameless?: boolean
}

export function PomoWidget({ frameless = false }: PomoWidgetProps) {
  const pom = usePomodoro()
  const { state: ps, mode } = pom
  const [draftTopic, setDraftTopic] = useState(ps.topic)
  const [endArmed, setEndArmed] = useState(false)

  const [todayMinutes, setTodayMinutes] = useState<number | null>(null)
  const refreshToday = useCallback(() => {
    const t = localToday()
    getBlogPeriodStats(t, t)
      .then((s) => setTodayMinutes(s.pomodoroMinutes))
      .catch(() => { /* 统计不可用时静默 */ })
  }, [])

  // 今日专注分钟（落库 / 补评分 / 其它窗口写入后刷新）
  useEffect(() => { refreshToday() }, [refreshToday, ps.pendingSession?.id, ps.phase])
  useDataChanged('pomodoro', refreshToday)

  // 准备态同步当前 / 上次主题；处于暂停或运行态时不要覆盖用户正在看的值
  useEffect(() => {
    if (mode === 'idle') setDraftTopic(ps.topic)
  }, [ps.topic, mode])

  useEffect(() => {
    if (mode !== 'running' && mode !== 'paused') setEndArmed(false)
  }, [mode])

  useEffect(() => {
    if (!endArmed) return
    const t = window.setTimeout(() => setEndArmed(false), 3000)
    return () => window.clearTimeout(t)
  }, [endArmed])

  const phaseLabel = mode === 'rating'
    ? '待评分'
    : mode === 'breakReady'
      ? '准备休息'
      : mode === 'breakRunning'
        ? '休息中'
        : mode === 'breakDone'
          ? '休息结束'
          : mode === 'running'
            ? '专注中'
            : mode === 'paused'
              ? '已暂停'
              : '就绪'
  const phaseColor = mode === 'rating' || mode === 'paused'
    ? 'var(--warning)'
    : ps.phase === 'work' ? 'var(--accent)' : 'var(--success)'

  const mainLabel = mode === 'rating'
    ? '去评分'
    : mode === 'breakReady'
      ? '开始休息'
      : mode === 'breakRunning'
        ? '跳过休息'
        : mode === 'breakDone'
          ? '下一轮'
          : mode === 'running'
            ? '暂停'
            : mode === 'paused' ? '继续' : '开始'

  const mainAction = () => {
    if (mode === 'idle') {
      const topic = draftTopic.trim()
      if (!topic) {
        pom.expand()
        showToast({ type: 'warning', message: '先在面板里填写这次专注的主题' })
        return
      }
      pom.startTimer(topic)
      return
    }
    if (mode === 'rating') { pom.expand(); return }
    if (mode === 'breakReady') { pom.startBreak(); return }
    if (mode === 'breakRunning') { pom.skipBreak(); return }
    if (mode === 'breakDone') {
      if (!pom.startNextRound()) {
        pom.resetTimer()
        showToast({ type: 'info', message: '主题为空，已回到准备页' })
      }
      return
    }
    if (mode === 'running') pom.pauseTimer()
    else pom.startTimer()
  }

  const secondaryLabel = mode === 'rating'
    ? '稍后'
    : mode.startsWith('break')
      ? (mode === 'breakDone' ? '回到准备' : '跳过')
      : endArmed ? '确认结束' : '结束'

  const secondaryAction = () => {
    if (mode === 'idle') return
    if (mode === 'rating') { pom.skipRating(); return }
    if (mode.startsWith('break')) { pom.skipBreak(); return }
    if (mode === 'running' || mode === 'paused') {
      if (!endArmed) { setEndArmed(true); return }
      setEndArmed(false)
      void pom.finishWork()
    }
  }

  const progress = Math.max(0, Math.min(1, pom.progress))
  // 环形态 = 工作阶段已开始（运行 / 暂停）；待评分用专用块，就绪与休息保持横条
  const ringMode = ps.phase === 'work' && mode !== 'idle' && mode !== 'rating'
  const showSecondary = mode === 'running' || mode === 'paused' || mode === 'rating' || mode === 'breakReady' || mode === 'breakDone'

  return (
    <div className="w-full space-y-3">
      <div
        className={
          frameless
            ? 'flex flex-col items-center gap-2.5'
            : 'flex flex-col items-center gap-2.5 rounded-2xl border border-[var(--border-color)] bg-[var(--card-bg)] px-3 pb-3.5 pt-4'
        }
      >
        <span
          className="rounded-full px-2.5 py-0.5 text-[10.5px] tracking-[2px]"
          style={{ color: phaseColor, backgroundColor: `color-mix(in srgb, ${phaseColor} 14%, transparent)` }}
        >
          {phaseLabel}
        </span>

        {mode === 'idle' && (
          <div className="flex h-8 w-full items-center gap-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2">
            <Timer size={12} className="shrink-0 text-[var(--text-muted)]" />
            <input
              value={draftTopic}
              onChange={(e) => { setDraftTopic(e.target.value); pom.setTopic(e.target.value) }}
              onKeyDown={(e) => { if (e.key === 'Enter') mainAction() }}
              maxLength={30}
              autoComplete="off"
              placeholder="这次专注什么？"
              aria-label="专注主题"
              style={{ background: 'transparent', border: 0, boxShadow: 'none' }}
              className="min-w-0 flex-1 text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
            />
            <span className="text-[8.5px] tabular-nums text-[var(--text-muted)]">{draftTopic.length}/30</span>
          </div>
        )}

        {mode === 'rating' ? (
          <div className="flex flex-col items-center gap-1.5 py-2">
            <Star size={26} className="text-[var(--warning)]" fill="currentColor" />
            <div className="text-[13px] font-semibold text-[var(--text-primary)]">给这次专注打分</div>
            <div className="text-[10.5px] text-[var(--text-muted)]">
              {ps.pendingSession ? `${ps.pendingSession.minutes} 分钟 · ${ps.pendingSession.completed ? '自然完成' : '提前结束'}` : '这场专注已结束'}
            </div>
          </div>
        ) : ringMode ? (
          /* 专注态：环围着倒计时。kb-view-fade = 形态切换淡入（与横条互斥；见 docs/ui-animation-plan.md）。
             stroke-dashoffset 过渡是进度环的唯一可行实现（小 SVG 重绘，非布局/合成开销，
             与横条 width 过渡同节奏 700ms linear 对齐秒级 tick）。 */
          <div data-wb="pomoRing" className="kb-view-fade relative" style={{ width: RING_SIZE, height: RING_SIZE }}>
            <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} className="block">
              <circle cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={RING_R} fill="none" stroke="var(--bg-tertiary)" strokeWidth={RING_STROKE} />
              <circle
                cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={RING_R} fill="none"
                stroke={phaseColor} strokeWidth={RING_STROKE} strokeLinecap="round"
                strokeDasharray={RING_CIRC} strokeDashoffset={RING_CIRC * (1 - progress)}
                transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
                style={{ transition: 'stroke-dashoffset 700ms linear' }}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <div className={`text-[34px] font-extralight leading-none tracking-[1px] tabular-nums ${ps.running ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>
                {pom.display}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div
              className={`text-[46px] font-extralight leading-none tracking-[2px] tabular-nums ${ps.running ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}
            >
              {pom.display}
            </div>
            <div className="h-1 w-4/5 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-700 ease-linear"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          </>
        )}

        {mode !== 'idle' && ps.topic && (
          <div className="max-w-full truncate text-[10.5px] text-[var(--text-secondary)]" title={ps.topic}>{ps.topic}</div>
        )}

        {/* 预设分段器：换行网格（UI 打磨点2）——插件扩展预设后 chip 不再被压成竖排文字 */}
        {mode === 'idle' && (
          <div className="flex flex-wrap justify-center gap-1 rounded-lg bg-[var(--bg-tertiary)] p-1">
            {pom.presets.map((p, i) => (
              <button
                key={`${p.label}-${i}`}
                onClick={() => pom.setPresetIdx(i)}
                className={`whitespace-nowrap truncate max-w-full rounded-md px-2.5 py-0.5 text-[11px] transition-colors ${
                  ps.presetIdx === i
                    ? 'bg-[var(--bg-primary)] font-semibold text-[var(--accent)] shadow-sm'
                    : 'text-[var(--text-secondary)]'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}

        {/* 控制钮：等宽两列；就绪态「开始」跨两列（单钮不偏列） */}
        <div data-wb="pomoControls" className="grid w-full grid-cols-2 gap-2">
          <button
            data-wb="pomoMain"
            onClick={mainAction}
            className={`rounded-lg bg-[var(--accent)] py-1.5 text-[12.5px] font-semibold text-white hover:opacity-90 ${showSecondary ? '' : 'col-span-2'}`}
          >
            {mainLabel}
          </button>
          {showSecondary && (
            <button
              data-wb="pomoReset"
              onClick={secondaryAction}
              className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1.5 text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              title={mode === 'running' || mode === 'paused' ? '结束本场并记录（再点一次确认）' : secondaryLabel}
            >
              {secondaryLabel}
            </button>
          )}
        </div>
        <div className="text-[11px] text-[var(--text-muted)]">
          {todayMinutes !== null && todayMinutes > 0 ? `今日专注 ${todayMinutes} 分钟` : '今日暂无专注记录'}
        </div>
      </div>
    </div>
  )
}

/** 脱离窗口版番茄控件：独立窗口不持有计时器，只读展示主进程广播的快照，控制跳转主窗口 */
export function PomodoroPopoutPanel({ status, onOpenInMain }: {
  status: { visible?: boolean; display: string; running: boolean; phase: string; done: boolean; progress: number } | null
  onOpenInMain: () => void
}) {
  const active = !!status && status.visible !== false && (status.running || status.done || status.progress > 0)
  const phaseLabel = !status
    ? '就绪'
    : status.done
      ? (status.phase === 'work' ? '专注完成' : '休息结束')
      : status.running
        ? (status.phase === 'work' ? '专注中' : '休息中')
        : '已暂停'
  const phaseColor = status?.phase === 'work' ? 'var(--accent)' : 'var(--success)'

  return (
    <div className="space-y-3">
      <div className="flex flex-col items-center gap-2.5 rounded-2xl border border-[var(--border-color)] bg-[var(--card-bg)] px-3 pb-3.5 pt-4">
        <span
          className="rounded-full px-2.5 py-0.5 text-[10.5px] tracking-[2px]"
          style={{ color: phaseColor, backgroundColor: `color-mix(in srgb, ${phaseColor} 14%, transparent)` }}
        >
          {phaseLabel}
        </span>
        <div className={`text-[46px] font-extralight leading-none tracking-[2px] tabular-nums ${status?.running ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>
          {status?.display ?? '00:00'}
        </div>
        <div className="h-1 w-4/5 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-700 ease-linear"
            style={{ width: `${Math.max(0, Math.min(1, status?.progress ?? 0)) * 100}%` }}
          />
        </div>
        {active ? (
          <button
            onClick={onOpenInMain}
            className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            title="在主窗口控制番茄钟"
          >
            在主窗口控制 ↗
          </button>
        ) : (
          <button
            onClick={onOpenInMain}
            className="rounded-lg bg-[var(--accent)] px-6 py-1.5 text-[12.5px] font-semibold text-white hover:opacity-90"
          >
            去主窗口开始番茄钟
          </button>
        )}
      </div>
      <p className="px-1 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
        脱离窗口实时同步主窗口番茄钟进度；计时控制在主窗口进行。
      </p>
    </div>
  )
}
