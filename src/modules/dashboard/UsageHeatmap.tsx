import { useCallback, useMemo, useRef, useState } from 'react'
import { buildHeatmap, dayNo, fmtMinutes, type Level } from './heatmapModel'
import { heatRange } from './summary'

/**
 * 使用热力图（2026-11-14 首页重做：半年卡 → 近一年横条）。
 *
 * 三处是这次专门解决的：
 *  ① **不横向留白**：列模板 `minmax(7px, 1fr)` —— 卡片宽，格子就宽；卡片窄，格子就窄；
 *  ② **窄卡片不出现「半格 / 半个字」**（2026-11-14 修）：先量容器宽度，放不下 52 周就把
 *     **最早的整周**收掉（不是把左边裁掉半列），刻度跟着重算，左侧文案改成实际跨度；
 *     ★ 旧实现是 `minWidth: 517` + 右对齐 + `overflow-hidden` —— 卡片窄于 517 时左缘
 *     会切在格子中间、月份标签也切掉一半，表象就是「热力图被截断」；
 *  ③ **月份刻度**：与格子共用同一份列模板，只在月份变化的那一列落标签（首列是半个月，跳过）。
 *
 * 分档阈值与日期算术在 `heatmapModel.ts`（零依赖纯函数，契约脚本直接装载验证）。
 */

/** 列间距（与样式里的 gap 保持一致；算「能放几周」时要用到） */
const GAP = 3
/** 最小列宽：再小就糊成一片，宁可少显示几周 */
const MIN_CELL = 7

const LEVEL_BG: Record<Level, string> = {
  0: 'var(--bg-tertiary)',
  1: 'color-mix(in srgb, var(--accent) 26%, var(--bg-tertiary))',
  2: 'color-mix(in srgb, var(--accent) 48%, var(--bg-tertiary))',
  3: 'color-mix(in srgb, var(--accent) 72%, var(--bg-tertiary))',
  4: 'var(--accent)',
}

interface Props {
  /** 'YYYY-MM-DD' → 分钟 */
  days: Record<string, number>
  today: string
  todayMinutes: number
  /** 矮窗档：整卡 168 → 150 */
  compact: boolean
}

export function UsageHeatmap({ days, today, todayMinutes, compact }: Props) {
  const boxRef = useRef<HTMLElement | null>(null)
  const roRef = useRef<ResizeObserver | null>(null)
  const [tip, setTip] = useState<{ left: number; top: number; text: string } | null>(null)
  const [avail, setAvail] = useState<number | null>(null)
  const range = useMemo(() => heatRange(today), [today])
  const model = useMemo(() => buildHeatmap(days, range.from, range.to), [days, range.from, range.to])

  // 容器宽度 → 能放下几整周（callback ref：挂载 / 重新挂载都会接上，不会漏测）
  const setWrap = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect()
    roRef.current = null
    if (!el) return
    const read = () => setAvail(el.clientWidth)
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    roRef.current = ro
  }, [])

  const weeks = model.weeks

  /**
   * 实际画出几周：宽度够就 52 周全画；不够就按**整周**从最早处收，
   * 保证每格都不小于 MIN_CELL —— 绝不出现半列 / 半截月份字。
   */
  const shownWeeks = useMemo(() => {
    if (weeks === 0) return 0
    if (avail === null || avail <= 0) return weeks
    const fit = Math.floor((avail + GAP) / (MIN_CELL + GAP))
    return Math.max(1, Math.min(weeks, fit))
  }, [avail, weeks])

  if (weeks === 0) return null

  const dropped = weeks - shownWeeks
  const cells = dropped > 0 ? model.cells.slice(dropped * 7) : model.cells
  // 刻度列号跟着左移；第一列若是半个某月，跳过它的标签（与原「首列不完整月」同一规则）
  const months = model.months
    .map((m) => ({ ...m, start: m.start - dropped }))
    .filter((m) => m.start > 1)

  // 本周（最后一列）已使用天数 —— 直接数最后 7 格，和画出来的图同一份数据
  const weekUsed = cells.slice(-7).filter((c) => c !== null && c.level > 0).length
  const activeDays = cells.reduce((n, c) => n + (c !== null && c.level > 0 ? 1 : 0), 0)
  // 左侧文案说清「这张图实际画了多久」——收窄时不能再写「近一年」
  const firstKey = cells.find((c) => c !== null)?.key
  const spanDays = firstKey ? dayNo(today) - dayNo(firstKey) + 1 : 0
  const spanMonths = Number.isFinite(spanDays) && spanDays > 0 ? Math.max(1, Math.round(spanDays / 30.4)) : 12
  const spanLabel = spanMonths >= 12 ? '近一年' : `近 ${spanMonths} 个月`
  const cols = `repeat(${shownWeeks}, minmax(${MIN_CELL}px, 1fr))`

  const showTip = (e: React.MouseEvent<HTMLElement>, key: string, minutes: number) => {
    const box = boxRef.current?.getBoundingClientRect()
    if (!box) return
    const r = e.currentTarget.getBoundingClientRect()
    // 提示挂在这一整块（不是格子容器）上：格子容器 overflow-hidden，挂在里面时
    // 第一行的提示会被切掉上半截。左右再夹一下，靠边的格子也不会把提示甩出卡片。
    const half = 92
    const cx = r.left - box.left + r.width / 2
    setTip({
      left: Math.min(Math.max(cx, half), Math.max(half, box.width - half)),
      top: r.top - box.top,
      text: `${key} · ${fmtMinutes(minutes)}`,
    })
  }

  return (
    <section
      ref={boxRef}
      className={`relative flex flex-none items-center gap-[18px] rounded-[16px] border border-[var(--border-color)] bg-[var(--card-bg)] px-[18px] py-3 ${compact ? 'h-[150px]' : 'h-[168px]'}`}
    >
      <div className="flex flex-none flex-col gap-[3px]">
        <b className="text-[11.5px] font-semibold text-[var(--text-primary)]">使用</b>
        <span className="text-[8.5px] uppercase tracking-[0.1em] text-[var(--text-muted)]">{spanLabel}</span>
      </div>

      <div ref={setWrap} className="relative flex min-w-0 flex-1 justify-end overflow-hidden">
        <div className="flex w-full flex-col gap-1">
          {/* 月份刻度：与格子共用列模板，永远对齐 */}
          <div className="grid text-[7.5px] tracking-[0.02em] text-[var(--text-muted)]" style={{ gridTemplateColumns: cols, gap: GAP }}>
            {months.map((m, i, list) => (
              <span
                key={`${m.label}-${m.start}`}
                className={`whitespace-nowrap ${i === list.length - 1 ? 'justify-self-end text-right' : 'overflow-hidden'}`}
                style={{ gridColumn: `${m.start} / span ${m.span}` }}
              >
                {m.label}
              </span>
            ))}
          </div>

          {/* ★ gridAutoFlow 必须是 column：cells 是按**周**排列的时间序列（每 7 天 = 一列），
              默认的 row 会把它横着铺成 7 条「时间带」—— 表象是最近几个月的颜色全挤在最下面
              一两行、月份刻度和格子对不上（2026-11-15 实机反馈）。 */}
          <div className="grid" style={{ gridTemplateColumns: cols, gridTemplateRows: 'repeat(7, 12px)', gridAutoFlow: 'column', gap: GAP }}>
            {cells.map((c, i) => c === null ? (
              <i key={`pad-${i}`} className="invisible" />
            ) : (
              <i
                key={c.key}
                className={`rounded-[2px] transition-transform duration-100 hover:scale-[1.35]${c.key === today ? ' ring-1 ring-inset ring-[var(--text-secondary)]' : ''}`}
                style={{ background: LEVEL_BG[c.level] }}
                onMouseEnter={(e) => showTip(e, c.key, c.minutes)}
                onMouseLeave={() => setTip(null)}
              />
            ))}
          </div>
        </div>
      </div>

      {tip && (
        <div
          className="kb-pop pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-[118%] whitespace-nowrap rounded-[7px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] shadow-lg"
          style={{ left: tip.left, top: tip.top }}
        >
          {tip.text}
        </div>
      )}

      <div className="ml-auto flex flex-none items-center gap-[18px]">
        <Stat value={String(todayMinutes)} label="分钟" />
        <Stat value={`${weekUsed}/7`} label="本周" />
        <Stat value={`${activeDays} 天`} label={spanLabel} />
      </div>
    </section>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <b className="text-[14px] font-bold leading-none tabular-nums text-[var(--text-primary)] min-[2000px]:text-[17px]">{value}</b>
      <em className="not-italic text-[8.5px] text-[var(--text-muted)]">{label}</em>
    </span>
  )
}
