import { useMemo } from 'react'
import type { UsageHeatCell } from '../../types'
import { exactTokens } from '../../lib/numFormat'

/**
 * 活动热力图（近 365 天，GitHub 式周列）。
 *
 * 阈值是 token 口径的**五分位近似**（相对窗口峰值四等分），**不复用**看板的分钟阈值
 * `heatmapModel.ts`（那是另一个口径）。未记账日（tokens=0 且当日无数据）与「有数据但为 0」
 * 视觉相同 —— 都是空格，不假装有记录。
 */
const LEVEL_BG = [
  'var(--bg-hover)',
  'color-mix(in srgb, var(--accent) 28%, var(--bg-hover))',
  'color-mix(in srgb, var(--accent) 50%, var(--bg-hover))',
  'color-mix(in srgb, var(--accent) 74%, var(--bg-hover))',
  'var(--accent)',
]

function levelOf(tokens: number, max: number): number {
  if (tokens <= 0) return 0
  if (max <= 0) return 1
  const r = tokens / max
  if (r < 0.25) return 1
  if (r < 0.5) return 2
  if (r < 0.75) return 3
  return 4
}

const WEEKDAY = ['一', '', '三', '', '五', '', '']

export function UsageHeatmap({ heat }: { heat: UsageHeatCell[] }) {
  const { weeks, max, monthLabels } = useMemo(() => {
    const m = Math.max(0, ...heat.map((c) => c.tokens))
    // 对齐到周一：首格前面补空格（保证每列 = 一周）
    const first = heat[0] ? new Date(`${heat[0].date}T00:00:00`) : null
    const lead = first ? (first.getDay() + 6) % 7 : 0
    const cells: (UsageHeatCell | null)[] = [...Array(lead).fill(null), ...heat]
    const weeks: (UsageHeatCell | null)[][] = []
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
    // 月份标签：每列首日的月份与上一列不同 → 标注
    const monthLabels: (string | null)[] = []
    let prevMonth = -1
    for (const w of weeks) {
      const d = w.find((c) => c !== null)
      if (!d) { monthLabels.push(null); continue }
      const mo = new Date(`${d.date}T00:00:00`).getMonth()
      if (mo !== prevMonth) { monthLabels.push(`${mo + 1} 月`); prevMonth = mo } else monthLabels.push(null)
    }
    return { weeks, max: m, monthLabels }
  }, [heat])

  return (
    <div className="flex gap-1.5">
      <div className="flex flex-col justify-between pt-[14px] text-[9px] leading-none text-[var(--text-muted)]">
        {WEEKDAY.map((d, i) => <span key={i} className="h-[11px]">{d}</span>)}
      </div>
      <div className="min-w-0 flex-1 overflow-x-auto">
        <div className="flex gap-[3px]" style={{ width: 'max-content' }}>
          {weeks.map((w, wi) => (
            <div key={wi} className="flex flex-col gap-[3px]">
              <span className="h-[11px] text-[9px] leading-[11px] text-[var(--text-muted)]">{monthLabels[wi] ?? ''}</span>
              {w.map((c, di) =>
                c === null
                  ? <span key={di} className="h-[11px] w-[11px]" />
                  : (
                    <span
                      key={di}
                      className="h-[11px] w-[11px] rounded-[2px]"
                      style={{ background: LEVEL_BG[levelOf(c.tokens, max)] }}
                      title={`${c.date} · ${exactTokens(c.tokens)} tokens`}
                    />
                  ),
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
