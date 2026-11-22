import type { ReactNode } from 'react'
import type { AgentTraceStep } from '../../../types'
import { formatUsageCost, formatUsageToken, summarizeMessageUsage } from '../../../lib/messageUsagePure'

/**
 * 每条 AI 回复末尾**右下角**的常显用量行：`≈ 1.2k tokens    缓存命中 68%`。
 *
 * 为什么独立成行、且不跟 hover 走：动作行（复制 / 重新生成 / 删除）是"要我做什么"，
 * 用量是"这轮花了多少"，后者是事后审计信息 —— 挂在 hover 里就等于没有。
 * 为什么不用 `.kb-l1` 退化：动作行可以按宽度隐文字，这一行隐掉就没有意义了，
 * 窄宿主改为整行 `truncate`（320px 下也不会把消息撑宽）。
 *
 * 费用与 ↑↓ 明细只进 `data-tip`：行内只保留两个数，避免每次都占一屏最贵的那行位置。
 */
export interface UsageFooterProps {
  trace?: AgentTraceStep[]
  /** 挂载处的间距（各面消息块节奏不同，由调用方给） */
  className?: string
}

export function UsageFooter({ trace, className = '' }: UsageFooterProps): ReactNode {
  const u = summarizeMessageUsage(trace)
  if (!u) return null
  const total = formatUsageToken(u.total)
  const cost = u.costUsd != null ? ` · 估算费用 ${formatUsageCost(u.costUsd)}（按内置价目表，非账单）` : ''
  const tip = u.hasSplit
    ? `本轮（含工具循环）↑输入 ${formatUsageToken(u.prompt)} ↓输出 ${formatUsageToken(u.completion)}${cost}`
    : `本轮（含工具循环）≈ ${total} tokens${cost}`
  return (
    /* 外层只管右对齐与收缩；`data-tip` 挂在文字本身上 —— 挂外层会让整条空带都成了
       悬浮热区，鼠标从消息上划过就莫名弹提示。 */
    <div className={`flex min-w-0 select-none justify-end ${className}`}>
      <span
        className="min-w-0 truncate whitespace-nowrap tabular-nums text-[10.5px] text-[var(--text-muted)]"
        data-tip={tip}
        aria-label={tip}
      >
        {`≈ ${total} tokens`}
        {u.cacheHitPct != null && <span className="ml-3">{`缓存命中 ${u.cacheHitPct}%`}</span>}
      </span>
    </div>
  )
}
