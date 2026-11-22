import { Entry } from '../../../types'
import { EntryCard } from '../components/EntryCard'
import { localToday } from '../../../lib/date'
import { Plus } from 'lucide-react'

interface EntryListProps {
  entries: Entry[]
  loading: boolean
  onEntryClick: (entry: Entry) => void
  onToggleStar: (id: string) => void
  onNewEntry: () => void
  cardSize?: 's' | 'm' | 'l'
}

export function EntryList({ entries, loading, onEntryClick, onToggleStar, onNewEntry, cardSize = 'm' }: EntryListProps) {
  const today = localToday()
  const hasToday = entries.some(e => e.date === today)

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center kb-theme-surface">
        <div className="flex flex-col items-center gap-3 text-[var(--text-muted)]">
          <div className="w-8 h-8 border-2 border-[var(--border-color)] border-t-[var(--accent)] rounded-full animate-spin" />
          <span className="text-sm">加载中...</span>
        </div>
      </div>
    )
  }

  const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date))

  return (
    <div className="flex-1 overflow-y-auto kb-theme-surface">
      <div className="flex h-full flex-col max-w-3xl mx-auto px-6 py-6">
        {!hasToday && (
          <div className="flex justify-end mb-4">
            <button onClick={onNewEntry} className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
              <Plus size={12} /> 新建
            </button>
          </div>
        )}

        {sorted.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-[12px] text-[var(--text-muted)]">暂无文章</p>
          </div>
        ) : (
          <div className="space-y-2">
            {sorted.map(entry => (
              <EntryCard key={entry.id} entry={entry} onClick={() => onEntryClick(entry)} onToggleStar={onToggleStar} size={cardSize} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
