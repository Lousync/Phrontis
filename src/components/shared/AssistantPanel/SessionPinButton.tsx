import { Star } from 'lucide-react'

interface Props {
  pinned: boolean
  onToggle: () => void
  size?: number
}

export function SessionPinButton({ pinned, onToggle, size = 11 }: Props) {
  return (
    <button
      type="button"
      onPointerDown={e => e.stopPropagation()}
      onClick={e => {
        e.stopPropagation()
        onToggle()
      }}
      className={`shrink-0 rounded p-0.5 transition-opacity focus-visible:opacity-100 ${
        pinned
          ? 'text-[var(--warning)]'
          : 'text-[var(--text-disabled)] opacity-0 hover:text-[var(--warning)] group-hover:opacity-100'
      }`}
      title={pinned ? '取消收藏' : '收藏'}
      aria-label={pinned ? '取消收藏' : '收藏'}
      aria-pressed={pinned}
    >
      <Star size={size} fill={pinned ? 'currentColor' : 'none'} />
    </button>
  )
}
