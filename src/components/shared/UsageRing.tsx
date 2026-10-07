import type { ReactElement } from 'react'

/**
 * 上下文占用指示（正式版台账 F-12）—— AI 教学与 AI 对话共用。
 *
 * 从 `ai-teaching/index.tsx` 抽出（原 UI 优化条目9②）：纯 SVG、无新依赖；
 * pct=null → 退化为紧凑数字；分档口径 <70% 常态（accent）/ 70~85% 警示（warning）/ >85% 红（danger）。
 * 档位与窗口大小由设置 `ctxUsageDetail` / `ctxWindow` 控制（两处共用同一套口径）。
 */

/** 数字紧凑格式：1k / 1.2k / 10k */
export function fmtTok(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function UsageRing({ pct, used }: { pct: number | null; used: number }): ReactElement {
  if (pct == null) return <span className="tabular-nums text-[11px] text-[var(--text-secondary)]">≈ {fmtTok(used)}</span>
  const R = 8
  const C = 2 * Math.PI * R
  const clamped = Math.max(0, Math.min(1, pct))
  const color = pct > 0.85 ? 'var(--danger)' : pct >= 0.7 ? 'var(--warning)' : 'var(--accent)'
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" className="shrink-0 -rotate-90" aria-hidden>
      <circle cx="11" cy="11" r={R} fill="none" stroke="var(--border-color)" strokeWidth="2.5" />
      <circle cx="11" cy="11" r={R} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round"
        strokeDasharray={`${(clamped * C).toFixed(1)} ${C.toFixed(1)}`} className="transition-[stroke-dasharray] duration-300" />
      <text x="11" y="11" transform="rotate(90 11 11)" textAnchor="middle" dominantBaseline="central"
        fontSize="6.5" fill={color} className="tabular-nums">{Math.round(clamped * 100)}</text>
    </svg>
  )
}
