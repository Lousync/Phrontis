import { shouldShowExtBadge } from '../../lib/fileName'

/** 文件条目右侧的大写扩展名徽标（有扩展名即显示，含 md；无扩展名 / 点开头文件不显示）。 */
export function FileExtBadge({ ext }: { ext: string }) {
  if (!shouldShowExtBadge(ext)) return null
  return (
    <span className="ml-auto shrink-0 pl-2 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{ext}</span>
  )
}
