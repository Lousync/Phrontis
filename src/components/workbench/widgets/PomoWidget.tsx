import { useEffect, useState } from 'react'
import { usePomodoro } from '../../../modules/toolbox/hooks/PomodoroContext'
import { getBlogPeriodStats } from '../../../lib/ipc'
import { localToday } from '../../../lib/date'

/** 环形进度几何（2026-09-17 右栏优化轮）：直径/环宽固定，周长派生。
 *  尺寸按右栏简略视图与 DayPanel 小窗的公共下限取 148——两处宿主都不出现横向挤压。 */
const RING_SIZE = 148
const RING_STROKE = 8
const RING_R = (RING_SIZE - RING_STROKE) / 2
const RING_CIRC = 2 * Math.PI * RING_R

/**
 * 番茄钟控件（v3.4.0 批次4：DayPanel「番茄」Tab 迁入 widgets，方案 §3.7）。
 * **右栏简略视图与脱离小窗共用**（不复制渲染）。
 * 2026-09-17 右栏优化轮改造：
 * - 专注阶段（已开始且 phase==='work'，含运行/暂停/完成）进度 = **环围着倒计时**（SVG 环，
 *   stroke-dashoffset 过渡同横条 700ms linear）；就绪与休息阶段保持横条（拍板：仅专注时变环）；
 * - 按钮随状态变且等宽居中（就绪=单个「开始」跨两列；运行/暂停/完成=主钮 + 「重置」两列等宽）；
 * - 副说明文字（「与工具箱同源」等）在宿主标题行移除 —— 见 WorkbenchRightPanel WIDGET_META。
 * 与主窗口工具箱共用同一 PomodoroContext 状态机（嵌入式同窗口天然联通），
 * 脱离窗口由主进程广播快照（pomodoroStatus），PomodoroPopoutPanel 仅脱离态使用。
 */
interface PomoWidgetProps {
  /** 宿主已自带卡片容器（如右栏下段控件卡）时置 true：本组件不再画自己的卡片/内边距，
   *  只渲染内容 —— 避免「卡中卡」多层嵌套（2026-09-17 反馈：番茄钟看着套了好几层）。
   *  DayPanel 嵌入态不传（那里需要组件自带卡片外观）。 */
  frameless?: boolean
}

export function PomoWidget({ frameless = false }: PomoWidgetProps) {
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

  const progress = Math.max(0, Math.min(1, pom.progress))
  // 环形态 = 专注阶段（拍板：仅专注时变环）；就绪/休息保持横条
  const ringMode = ps.visible && ps.phase === 'work'
  // 「重置」只在已开始后有意义（就绪态回本阶段起点 = 无操作）
  const showReset = ps.visible

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
        {ringMode ? (
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
        {/* 控制钮：等宽两列；就绪态「开始」跨两列（单钮不偏列） */}
        <div data-wb="pomoControls" className="grid w-full grid-cols-2 gap-2">
          <button
            data-wb="pomoMain"
            onClick={mainAction}
            className={`rounded-lg bg-[var(--accent)] py-1.5 text-[12.5px] font-semibold text-white hover:opacity-90 ${showReset ? '' : 'col-span-2'}`}
          >
            {mainLabel}
          </button>
          {showReset && (
            <button
              data-wb="pomoReset"
              onClick={() => pom.resetTimer()}
              className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1.5 text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              title="回到本阶段起点"
            >
              重置
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
