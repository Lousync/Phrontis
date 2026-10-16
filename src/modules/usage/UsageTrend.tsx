import { useMemo } from 'react'
import type { UsageSeriesPoint } from '../../types'
import { fmtMetric, metricOf, type Metric } from './usageModel'

/**
 * 趋势图（手写 SVG，不引图表库 —— 铁律 20：避免首屏静态闭包变大）。
 * 柱状 / 折线两态共用一套坐标；纵轴按当前指标的最大值自适应，横轴稀疏标注。
 */
export function UsageTrend({ series, metric, style }: { series: UsageSeriesPoint[]; metric: Metric; style: 'bar' | 'line' }) {
  const W = 1000
  const H = 150
  const PAD_B = 18
  const PAD_T = 8

  const { max, pts } = useMemo(() => {
    const vals = series.map((p) => metricOf(p, metric))
    const m = Math.max(1, ...vals)
    const n = series.length
    const step = n > 1 ? W / n : W
    const pts = series.map((p, i) => {
      const v = metricOf(p, metric)
      const x = step * i + step / 2
      const y = H - PAD_B - (v / m) * (H - PAD_B - PAD_T)
      return { x, y, v, label: p.label }
    })
    return { max: m, pts }
  }, [series, metric])

  if (series.length === 0) {
    return <div className="grid h-[150px] place-items-center text-[12px] text-[var(--text-muted)]">这段时间没有调用</div>
  }

  // 横轴稀疏标注：最多 ~8 个
  const labelEvery = Math.max(1, Math.ceil(pts.length / 8))
  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L${pts[pts.length - 1].x.toFixed(1)} ${H - PAD_B} L${pts[0].x.toFixed(1)} ${H - PAD_B} Z`
  const barW = Math.max(2, (W / pts.length) * 0.62)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="用量趋势">
      <line x1={0} y1={H - PAD_B} x2={W} y2={H - PAD_B} stroke="var(--border-color)" strokeWidth={1} />
      {style === 'bar'
        ? pts.map((p, i) => (
            <rect
              key={i}
              x={p.x - barW / 2}
              y={p.y}
              width={barW}
              height={Math.max(0, H - PAD_B - p.y)}
              rx={2}
              fill="var(--accent)"
              opacity={0.9}
            >
              <title>{`${p.label} · ${fmtMetric(p.v, metric)}`}</title>
            </rect>
          ))
        : (
          <>
            <path d={areaPath} fill="var(--accent)" opacity={0.12} />
            <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth={1.6} />
            {pts.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={2.2} fill="var(--accent)">
                <title>{`${p.label} · ${fmtMetric(p.v, metric)}`}</title>
              </circle>
            ))}
          </>
        )}
      {pts.map((p, i) =>
        i % labelEvery === 0 ? (
          <text key={`l${i}`} x={p.x} y={H - 4} textAnchor="middle" fontSize={10} fill="var(--text-muted)">
            {p.label}
          </text>
        ) : null,
      )}
      <text x={4} y={12} fontSize={10} fill="var(--text-muted)">{fmtMetric(max, metric)}</text>
    </svg>
  )
}
