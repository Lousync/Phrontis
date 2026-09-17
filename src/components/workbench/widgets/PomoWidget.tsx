import { useEffect, useState } from 'react'
import { usePomodoro } from '../../../modules/toolbox/hooks/PomodoroContext'
import { getBlogPeriodStats } from '../../../lib/ipc'
import { localToday } from '../../../lib/date'

/**
 * 番茄钟控件（v3.4.0 批次4：DayPanel「番茄」Tab 迁入 widgets，方案 §3.7）。
 * **右栏简略视图与脱离小窗共用**（不复制渲染）。
 * 大数字倒计时 + 阶段徽章 + 预设分段器 + 启停控制 + 今日专注统计。
 * 与主窗口工具箱共用同一 PomodoroContext 状态机（嵌入式同窗口天然联通），
 * 脱离窗口由主进程广播快照（pomodoroStatus），PomodoroPopoutPanel 仅脱离态使用。
 */
export function PomoWidget() {
  const pom = usePomodoro()
  const { state: ps } = pom

  // 今日专注分钟（完成一次番茄后刷新）
  const [todayMinutes, setTodayMinutes] = useState<number | null>(null)
  useEffect(() => {
    const t = localToday()
    getBlogPeriodStats(t, t)
      .then(s => setTodayMinutes(s.pomodoroMinutes))
      .catch(() => { /* 统计不可用时静默 */ })
  }, [ps.done])

  const phaseLabel = ps.done
    ? (ps.phase === 'work' ? '专注完成' : '休息结束')
    : ps.running
      ? (ps.phase === 'work' ? '专注中' : '休息中')
      : ps.visible ? '已暂停' : '就绪'
  const phaseColor = ps.phase === 'work' ? 'var(--accent)' : 'var(--success)'

  // 主按钮：未激活=开始 / 完成=下一阶段 / 运行=暂停 / 暂停=继续
  const mainLabel = !ps.visible ? '开始' : ps.done ? '下一阶段' : ps.running ? '暂停' : '继续'
  const mainAction = () => {
    // 控件内启动不展开主窗口的全屏番茄钟遮罩（expanded:false）——在侧栏点开始就只在侧栏跑，
    // 否则 activate() 的 expanded:true 会让主内容区被全屏番茄钟盖住，观感像「跳转到了工具箱」
    if (!ps.visible) { pom.setState(s => ({ ...s, visible: true, expanded: false })); pom.startTimer() }
    else if (ps.done) pom.switchPhase()
    else if (ps.running) pom.pauseTimer()
    else pom.startTimer()
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col items-center gap-2.5 rounded-2xl border border-[var(--border-color)] bg-[var(--card-bg)] px-3 pb-3.5 pt-4">
        <span
          className="rounded-full px-2.5 py-0.5 text-[10.5px] tracking-[2px]"
          style={{ color: phaseColor, backgroundColor: `color-mix(in srgb, ${phaseColor} 14%, transparent)` }}
        >
          {phaseLabel}
        </span>
        <div
          className={`text-[46px] font-extralight leading-none tracking-[2px] tabular-nums ${ps.running ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}
        >
          {pom.display}
        </div>
        <div className="h-1 w-4/5 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-700 ease-linear"
            style={{ width: `${Math.max(0, Math.min(1, pom.progress)) * 100}%` }}
          />
        </div>
        {/* 预设分段器：换行网格（UI 打磨点2）——插件扩展预设后 chip 不再被压成竖排文字 */}
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
        <div className="flex gap-2">
          <button
            onClick={mainAction}
            className="rounded-lg bg-[var(--accent)] px-6 py-1.5 text-[12.5px] font-semibold text-white hover:opacity-90"
          >
            {mainLabel}
          </button>
          <button
            onClick={() => pom.resetTimer()}
            className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-1.5 text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            title="回到本阶段起点"
          >
            重置
          </button>
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
