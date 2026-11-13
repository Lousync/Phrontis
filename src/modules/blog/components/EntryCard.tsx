import { Star } from 'lucide-react'
import { Entry } from '../../../types'
import { formatEntryDate, localToday } from '../../../lib/date'
import { getSummaryWindow, type MonthlyMode } from '../../../lib/summary'
import { useSettings } from '../../../lib/SettingsContext'

interface EntryCardProps {
  entry: Entry
  onClick: () => void
  onToggleStar: (id: string) => void
  size?: 's' | 'm' | 'l'
}

const SIZE_MAP = {
  s: { py: 'py-1', px: 'px-3', title: 'text-[12px]', meta: 'text-[10px]', gap: 'gap-2' },
  m: { py: 'py-2', px: 'px-3', title: 'text-[14px]', meta: 'text-[11px]', gap: 'gap-2' },
  l: { py: 'py-4', px: 'px-5', title: 'text-[16px]', meta: 'text-[12px]', gap: 'gap-3' },
}

export function EntryCard({ entry, onClick, onToggleStar, size = 'm' }: EntryCardProps) {
  const today = localToday()
  const isToday = entry.date === today
  const sz = SIZE_MAP[size]
  const { s, ready: settingsReady } = useSettings()

  const tags = entry.tags || []
  const states = entry.states?.split(',').filter(Boolean) || []

  // 该日期是否命中周期总结日(月总结优先,与 SummaryPanel 的面板判定同源同优先级;
  // 实时读设置,改动总结日配置后卡片标注随之更新)
  const summary = settingsReady
    ? getSummaryWindow(
        entry.date,
        Number(s.summaryWeeklyDay ?? 0),
        (s.summaryMonthlyMode as MonthlyMode) || 'last',
        Number(s.summaryMonthlyFixedDay ?? 1),
      )
    : null

  return (
    <article
      onClick={onClick}
      className={`kb-item-in group flex items-center justify-between ${sz.px} ${sz.py} bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-md cursor-pointer hover:border-[var(--accent)] transition-all`}
    >
      <div className={`flex items-center ${sz.gap} min-w-0`}>
        {/* Star */}
        <button
          onClick={e => { e.stopPropagation(); onToggleStar(entry.id) }}
          className="shrink-0 p-0.5 hover:scale-110 transition-[transform,scale]"
          data-tip={entry.isStarred ? '取消收藏' : '收藏'} aria-label={entry.isStarred ? '取消收藏' : '收藏'}
        >
          {/* key 随收藏态变化 → 图标重挂载，micro-pop 每次切换都重播（E 类状态反馈） */}
          <Star key={entry.isStarred ? 'on' : 'off'} size={14} className={`kb-micro-pop ${entry.isStarred ? 'text-[var(--warning)] fill-[var(--warning)]' : 'text-[var(--text-muted)]'}`} />
        </button>

        {/* Date */}
        <h3 className={`${sz.title} font-medium text-[var(--text-primary)] shrink-0`}>
          {formatEntryDate(entry.date)}
        </h3>

        {/* States (emojis) */}
        {states.length > 0 && (
          <span className="shrink-0 text-[16px]">{states.join('')}</span>
        )}

        {/* Today badge */}
        {isToday && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent)] text-white shrink-0">今天</span>
        )}

        {/* 周期总结日标注(月总结优先,与详情页总结面板一致) */}
        {summary?.type === 'month' && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 shrink-0" data-tip={summary.label} aria-label={summary.label}>月总结</span>
        )}
        {summary?.type === 'week' && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-400 shrink-0" data-tip={summary.label} aria-label={summary.label}>周总结</span>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {/* Tags */}
        {tags.length > 0 && (
          <div className="flex items-center gap-1">
            {tags.slice(0, 3).map(t => (
              <span key={t.id}
                className={`${sz.meta} px-1 rounded shrink-0 max-w-[80px] truncate`}
                style={{ backgroundColor: t.color + '20', color: t.color }}
              >
                {t.name}
              </span>
            ))}
            {tags.length > 3 && (
              <span className={`${sz.meta} text-[var(--text-muted)]`}>+{tags.length - 3}</span>
            )}
          </div>
        )}

        {/* Modified time */}
        <span className={`${sz.meta} text-[var(--text-muted)] shrink-0`}>{fmtShort(entry.updatedAt)}</span>
      </div>
    </article>
  )
}

function fmtShort(dateStr: string): string {
  const d = new Date(dateStr)
  const now = Date.now()
  const diff = now - d.getTime()
  if (isNaN(diff)) return ''
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins}分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}天前`
  if (days < 30) return `${Math.floor(days / 7)}周前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}月前`
  return d.toLocaleDateString('zh-CN')
}
