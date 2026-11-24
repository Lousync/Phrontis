import type { ReactElement } from 'react'
import { formatContextShare } from '../../lib/contextUsagePure'

/**
 * 上下文占用指示（正式版台账 F-12）—— AI 教学与 AI 对话共用。
 *
 * 形状按 2026-11-24 用户口径统一（参考 DeepTutor 的 ContextBudgetChip）：
 * **小圆环 + 右侧百分比**，环内不再放数字；环与文字同色，低占用跟随所在按钮的中性前景色，
 * ≥70% 转 warning、>85% 转 danger。档位与窗口大小由设置 `ctxUsageDetail` / `ctxWindow` 控制
 * （两处共用同一套口径）；未设窗口（`pct=null`）退化为紧凑数字 `≈ 1.2k`。
 */

/** 数字紧凑格式：1k / 1.2k / 10k */
export function fmtTok(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function UsageRing({ pct, used }: { pct: number | null; used: number }): ReactElement {
  if (pct == null) return <span className="tabular-nums text-[11px] text-[var(--text-secondary)]">≈ {fmtTok(used)}</span>
  const R = 6.5
  const C = 2 * Math.PI * R
  const clamped = Math.max(0, Math.min(1, pct))
  const color = pct > 0.85 ? 'var(--danger)' : pct >= 0.7 ? 'var(--warning)' : undefined
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 tabular-nums leading-none"
      style={color ? { color } : undefined}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" className="shrink-0 -rotate-90" aria-hidden>
        <circle cx="8" cy="8" r={R} fill="none" stroke="currentColor" strokeWidth="2" className="opacity-25" />
        <circle cx="8" cy="8" r={R} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          strokeDasharray={`${(clamped * C).toFixed(1)} ${C.toFixed(1)}`} className="transition-[stroke-dasharray] duration-300" />
      </svg>
      <span className="text-[11px]">{formatContextShare(clamped)}</span>
    </span>
  )
}
