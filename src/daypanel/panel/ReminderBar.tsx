import { CalendarClock } from 'lucide-react'

export interface ReminderItem {
  id: string
  title: string
  /** 截止时刻，'YYYY-MM-DD HH:mm' */
  time: string
}

/**
 * 逾期截止提醒条（贴面板底部，四个 Tab 下都可见）。
 * 多条折叠为「最近一条 + 还有 N 条」；「稍后」写入 snoozeUntil（打盹期内不再提醒该任务）。
 */
export function ReminderBar({ items, onSnooze }: { items: ReminderItem[]; onSnooze: (id: string) => void }) {
  if (items.length === 0) return null
  // 按截止时刻升序，逾期最久的（时刻最早）置顶
  const top = items[0]

  return (
    <div className="kb-view-fade mx-2 mb-2 shrink-0 rounded-lg border border-[var(--danger)]/45 bg-[color-mix(in_srgb,var(--danger)_13%,transparent)] px-2.5 py-2">
      <div className="flex items-start gap-2">
        <CalendarClock size={14} className="mt-0.5 shrink-0 text-[var(--danger)]" />
        <div className="min-w-0 flex-1">
          <div className="text-[10.5px] font-semibold text-[var(--danger)]">逾期截止提醒</div>
          <div className="truncate text-[12px] font-medium text-[var(--text-primary)]" data-tip={top.title} aria-label={top.title}>{top.title}</div>
          <div className="text-[10.5px] text-[var(--text-muted)]">
            {top.time.slice(5)}
            {items.length > 1 && <span className="ml-1">· 还有 {items.length - 1} 条</span>}
          </div>
        </div>
        <button
          onClick={() => onSnooze(top.id)}
          className="shrink-0 rounded-md border border-[var(--border-color)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          data-tip="打盹 1 小时，期间不再提醒" aria-label="打盹 1 小时，期间不再提醒"
        >
          稍后
        </button>
      </div>
    </div>
  )
}
