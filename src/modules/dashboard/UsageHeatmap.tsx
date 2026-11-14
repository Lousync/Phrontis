import { useMemo, useRef, useState } from 'react'
import { buildHeatmap, fmtMinutes, type Level } from './heatmapModel'
import { heatRange } from './summary'

/**
 * 使用热力图（2026-11-14 首页重做：半年卡 → 近一年横条）。
 *
 * 三处是这次专门解决的：
 *  ① **不横向留白**：52 列用 `minmax(9px, 1fr)` —— 卡片宽，格子就宽；卡片窄，格子就窄；
 *  ② **不够宽时从左边裁**：容器 `overflow-hidden` + 内层右对齐，最近的周永远贴着右边；
 *  ③ **月份刻度**：与格子共用同一份列模板，只在月份变化的那一列落标签（首列是半个月，跳过）。
 *
 * 分档阈值与日期算术在 `heatmapModel.ts`（零依赖纯函数，契约脚本直接装载验证）。
 */

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
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [tip, setTip] = useState<{ left: number; top: number; text: string } | null>(null)
  const range = useMemo(() => heatRange(today), [today])
  const model = useMemo(() => buildHeatmap(days, range.from, range.to), [days, range.from, range.to])

  if (model.weeks === 0) return null

  // 本周（最后一列）已使用天数 —— 直接数最后 7 格，和画出来的图同一份数据
  const weekUsed = model.cells.slice(-7).filter((c) => c !== null && c.level > 0).length
  const weeks = model.weeks
  const cols = `repeat(${weeks}, minmax(7px, 1fr))`
  const minWidth = weeks * 7 + (weeks - 1) * 3

  const showTip = (e: React.MouseEvent<HTMLElement>, key: string, minutes: number) => {
    const wrap = wrapRef.current?.getBoundingClientRect()
    if (!wrap) return
    const r = e.currentTarget.getBoundingClientRect()
    setTip({ left: r.left - wrap.left + r.width / 2, top: r.top - wrap.top, text: `${key} · ${fmtMinutes(minutes)}` })
  }

  return (
    <section
      className={`flex flex-none items-center gap-[18px] rounded-[16px] border border-[var(--border-color)] bg-[var(--card-bg)] px-[18px] py-3 ${compact ? 'h-[150px]' : 'h-[168px]'}`}
    >
      <div className="flex flex-none flex-col gap-[3px]">
        <b className="text-[11.5px] font-semibold text-[var(--text-primary)]">使用</b>
        <span className="text-[8.5px] uppercase tracking-[0.1em] text-[var(--text-muted)]">近一年</span>
      </div>

      <div ref={wrapRef} className="relative flex min-w-0 flex-1 justify-end overflow-hidden">
        <div className="flex w-full flex-col gap-1" style={{ minWidth }}>
          {/* 月份刻度：与格子共用列模板，永远对齐 */}
          <div className="grid text-[7.5px] tracking-[0.02em] text-[var(--text-muted)]" style={{ gridTemplateColumns: cols, gap: 3 }}>
            {model.months.filter((m) => m.start > 1).map((m, i, list) => (
              <span
                key={`${m.label}-${m.start}`}
                className={`whitespace-nowrap ${i === list.length - 1 ? 'justify-self-end text-right' : 'overflow-hidden'}`}
                style={{ gridColumn: `${m.start} / span ${m.span}` }}
              >
                {m.label}
              </span>
            ))}
          </div>

          <div className="grid" style={{ gridTemplateColumns: cols, gridTemplateRows: 'repeat(7, 12px)', gap: 3 }}>
            {model.cells.map((c, i) => c === null ? (
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

        {tip && (
          <div
            className="kb-pop pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-[118%] whitespace-nowrap rounded-[7px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] shadow-lg"
            style={{ left: tip.left, top: tip.top }}
          >
            {tip.text}
          </div>
        )}
      </div>

      <div className="ml-auto flex flex-none items-center gap-[18px]">
        <Stat value={String(todayMinutes)} label="分钟" />
        <Stat value={`${weekUsed}/7`} label="本周" />
        <Stat value={`${model.activeDays} 天`} label="近一年" />
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
