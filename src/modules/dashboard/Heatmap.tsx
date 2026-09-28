import { useMemo, useRef, useState } from 'react'
import { buildHeatmap, fmtMinutes, LEVEL_MIN } from './heatmapModel'

/**
 * 使用热力图（看板卡片，2026-09-27）。
 *
 * 形态照 GitHub 贡献图：**周一起排**的 7 行 × N 列。
 * 所有日期算术与分档都在 `./heatmapModel` 的零依赖纯函数里（可被契约脚本直接装载验证），
 * 本文件只管画和悬停。
 *
 * ⚠️ 左侧星期标签列必须 `leading-none`：标签行若用默认 line-height，
 * 它的 7 行会比格子的 `aspect-ratio:1` 高，flex 拉伸之下格子被拉成竖长矩形。
 * （原型里踩过这个坑。）
 *
 * 半年 ≈ 26 周，正好塞进 3 列网格里的一张卡，不必独占一行。
 */

/** 四档色：全部由 --accent 与 --bg-tertiary 混出，主题包一换整套跟着走 */
const LEVEL_BG: Record<number, string> = {
  0: 'var(--bg-tertiary)',
  1: 'color-mix(in srgb, var(--accent) 26%, var(--bg-tertiary))',
  2: 'color-mix(in srgb, var(--accent) 48%, var(--bg-tertiary))',
  3: 'color-mix(in srgb, var(--accent) 72%, var(--bg-tertiary))',
  4: 'var(--accent)',
}

export interface HeatmapProps {
  /** 'YYYY-MM-DD' → 分钟；缺失日按 0 */
  days: Record<string, number>
  fromKey: string
  toKey: string
  /** 悬停文案口径：'使用'（默认）/ '专注' */
  unit?: string
}

export function Heatmap({ days, fromKey, toKey, unit = '使用' }: HeatmapProps) {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const model = useMemo(() => buildHeatmap(days, fromKey, toKey), [days, fromKey, toKey])

  if (model.weeks === 0) {
    return <div className="py-7 text-center text-[12.5px] text-[var(--text-muted)]">这段时间还没有数据</div>
  }

  const showTip = (e: React.MouseEvent<HTMLElement>, key: string, minutes: number) => {
    const wrap = wrapRef.current?.getBoundingClientRect()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (!wrap) return
    setTip({
      x: r.left - wrap.left + r.width / 2,
      y: r.top - wrap.top,
      text: `${key} · ${fmtMinutes(minutes, unit)}`,
    })
  }

  return (
    <div className="relative" ref={wrapRef}>
      {/* 月份标签：与网格共用同一份列模板，才对得齐 */}
      <div
        className="grid gap-[3px] pb-[5px] pl-6 text-[10px] text-[var(--text-muted)]"
        style={{ gridTemplateColumns: `repeat(${model.weeks}, minmax(0, 1fr))` }}
      >
        {model.months.map((m) => (
          <span key={m.label} className="overflow-hidden whitespace-nowrap" style={{ gridColumn: `${m.start} / span ${m.span}` }}>
            {m.label}
          </span>
        ))}
      </div>

      <div className="flex gap-1.5">
        <div className="grid w-[18px] flex-none grid-rows-7 gap-[3px] text-[9.5px] leading-none text-[var(--text-muted)]">
          <span>一</span><span /><span>三</span><span /><span>五</span><span /><span>日</span>
        </div>
        <div
          className="grid flex-1 grid-flow-col grid-rows-7 gap-[3px]"
          style={{ gridTemplateColumns: `repeat(${model.weeks}, minmax(0, 1fr))` }}
        >
          {model.cells.map((c, i) => c === null ? (
            <i key={i} className="invisible" />
          ) : (
            <i
              key={i}
              className="aspect-square rounded-[2.5px] transition-transform duration-100 hover:scale-[1.35]"
              style={{ background: LEVEL_BG[c.level] }}
              onMouseEnter={(e) => showTip(e, c.key, c.minutes)}
              onMouseLeave={() => setTip(null)}
            />
          ))}
        </div>
      </div>

      {tip && (
        <div
          className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-[118%] whitespace-nowrap rounded-[7px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] shadow-lg"
          style={{ left: tip.x, top: tip.y }}
        >
          {tip.text}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-[var(--border-color)] pt-2.5 text-[11px] text-[var(--text-muted)]">
        <span>少</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <i key={l} className="h-2.5 w-2.5 rounded-[2.5px]" style={{ background: LEVEL_BG[l] }} />
        ))}
        <span>多</span>
        <span className="flex-1" />
        <span>
          近半年 <b className="font-semibold text-[var(--text-primary)]">{model.activeDays}</b> 天 · {Math.round(model.totalMinutes / 60)} 小时
        </span>
      </div>
    </div>
  )
}

/** 供契约脚本/调试对照：分档阈值（渲染层不消费，但暴露出来免得测试抄一份） */
export { LEVEL_MIN }
