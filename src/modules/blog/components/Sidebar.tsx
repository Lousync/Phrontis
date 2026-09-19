import { useState, useMemo, useEffect, useRef } from 'react'
import { Entry, Tag } from '../../../types'
import { ChevronRight, ChevronDown, FileText, Search, Star, Hash } from 'lucide-react'
import { showToast } from '../../../lib/toast'
import { formatEntryDate, localToday } from '../../../lib/date'

interface SidebarProps {
  entries: Entry[]
  starredEntries: Entry[]
  selectedDate: string | null
  onSelectDate: (date: string | null) => void
  allTags?: Tag[]
}

type DayNode = { date: string; hasContent: boolean }
type MonthMap = Record<string, DayNode[]>
type YearMap = Record<string, MonthMap>

const MONTH_NAMES: Record<string, string> = {
  '01': '一月', '02': '二月', '03': '三月', '04': '四月',
  '05': '五月', '06': '六月', '07': '七月', '08': '八月',
  '09': '九月', '10': '十月', '11': '十一月', '12': '十二月'
}

const EARLIEST_DATE = '2005-12-21'

function buildTree(entries: Entry[], today: string, thisYear: string, thisMonth: string): YearMap {
  const tree: YearMap = {}
  const seen = new Set<string>()

  for (const e of entries) {
    if (seen.has(e.date)) continue
    seen.add(e.date)
    const [y, m] = e.date.split('-')
    if (!tree[y]) tree[y] = {}
    if (!tree[y][m]) tree[y][m] = []
    tree[y][m].push({ date: e.date, hasContent: e.contentMd.length > 0 })
  }

  // Fill empty days for current month (1 .. today)
  const todayDay = parseInt(today.slice(-2), 10)
  for (let d = 1; d <= todayDay; d++) {
    const date = `${thisYear}-${thisMonth}-${String(d).padStart(2, '0')}`
    if (seen.has(date)) continue
    if (!tree[thisYear]) tree[thisYear] = {}
    if (!tree[thisYear][thisMonth]) tree[thisYear][thisMonth] = []
    tree[thisYear][thisMonth].push({ date, hasContent: false })
  }

  for (const y of Object.values(tree)) {
    for (const m of Object.values(y)) m.sort((a, b) => b.date.localeCompare(a.date))
  }
  return tree
}

/** Parse search input — supports xxxx/xx/xx, xxxx-xx-xx, or partial */
function parseSearchDate(raw: string): { year?: string; month?: string; day?: string } | null {
  const s = raw.trim()
  if (!s) return null

  // Full date: 2025/06/17 or 2025-06-17
  const full = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/)
  if (full) return { year: full[1], month: full[2].padStart(2, '0'), day: full[3].padStart(2, '0') }

  // Year-Month: 2025/06 or 2025-06
  const ym = s.match(/^(\d{4})[\/\-](\d{1,2})$/)
  if (ym) return { year: ym[1], month: ym[2].padStart(2, '0') }

  // Year only: 2025
  const y = s.match(/^(\d{4})$/)
  if (y) return { year: y[1] }

  // Month-Day: 06/17 or 6/17
  const md = s.match(/^(\d{1,2})[\/\-](\d{1,2})$/)
  if (md) return { month: md[1].padStart(2, '0'), day: md[2].padStart(2, '0') }

  // Just digits — substring match
  if (/^\d+$/.test(s)) return {}

  return {}
}

/** Given a partial search result and the tree, expand what's needed and build display items */
function computeSearchResults(
  tree: YearMap,
  parsed: ReturnType<typeof parseSearchDate>,
  existingYears: string[],
  searchRaw: string,
) {
  if (!parsed) return null

  const { year, month, day } = parsed

  // If we have a full date, show that specific day
  if (year && month && day) {
    const date = `${year}-${month}-${day}`
    return {
      years: [year],
      months: { [year]: [month] },
      days: { [`${year}-${month}`]: [{ date, hasContent: !!(tree[year]?.[month]?.find(d => d.date === date)) }] },
    }
  }

  // Year-Month: only if the year exists in tree
  if (year && month) {
    // Always show this year-month, even if tree doesn't have it yet
    const mk = `${year}-${month}`
    const days = tree[year]?.[month] ? [...tree[year][month]] : [{ date: mk, hasContent: false }]
    return { years: [year], months: { [year]: [month] }, days: { [mk]: days } }
  }

  // Year only: always show
  if (year) {
    const existingMonths = tree[year]
      ? Object.keys(tree[year]).sort((a, b) => b.localeCompare(a))
      : []
    const months = existingMonths.length > 0 ? existingMonths : ['01']
    const days: Record<string, DayNode[]> = {}
    for (const m of months) {
      days[`${year}-${m}`] = tree[year]?.[m] ?? [{ date: `${year}-${m}`, hasContent: false }]
    }
    return { years: [year], months: { [year]: months }, days }
  }

  // Just a substring — filter all dates in tree
  if (parsed && Object.keys(parsed).length === 0) {
    const matchedYears = new Set<string>()
    const monthsByYear: Record<string, string[]> = {}
    const daysByMonth: Record<string, DayNode[]> = {}

    for (const y of existingYears) {
      const ms = Object.keys(tree[y] || {})
      for (const m of ms) {
        const filtered = (tree[y]?.[m] || []).filter(d => d.date.includes(searchRaw))
        if (filtered.length > 0) {
          matchedYears.add(y)
          if (!monthsByYear[y]) monthsByYear[y] = []
          monthsByYear[y].push(m)
          daysByMonth[`${y}-${m}`] = filtered
        }
      }
    }
    if (matchedYears.size === 0) return null
    return {
      years: [...matchedYears].sort((a, b) => b.localeCompare(a)),
      months: monthsByYear,
      days: daysByMonth,
    }
  }

  return null
}

export function Sidebar({ entries, starredEntries, selectedDate, onSelectDate, allTags }: SidebarProps) {
  const today = localToday()
  const thisYear = new Date().getFullYear().toString()
  const thisMonth = (new Date().getMonth() + 1).toString().padStart(2, '0')

  const [searchQuery, setSearchQuery] = useState('')
  const activeSearch = searchQuery.trim().length > 0

  const tree = useMemo(() => buildTree(entries, today, thisYear, thisMonth), [entries, today])

  const existingYears = Object.keys(tree).sort((a, b) => b.localeCompare(a))

  const parsed = useMemo(() => parseSearchDate(searchQuery.trim()), [searchQuery])
  const searchResults = useMemo(
    () => activeSearch ? computeSearchResults(tree, parsed, existingYears, searchQuery.trim()) : null,
    [activeSearch, tree, parsed, existingYears, searchQuery],
  )

  // Tag & title search (non-date queries)
  const tagSearchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q || !activeSearch) return null
    // Only do tag/title search for non-date queries (needs at least some non-digit content)
    if (/^\d+[\/\-]?\d*[\/\-]?\d*$/.test(q)) return null

    // Match by tag name
    const matchingTags = (allTags || []).filter(t => t.name.toLowerCase().includes(q))
    // Match by entry title
    const titleMatches = entries.filter(e => e.title && e.title.toLowerCase().includes(q))

    const tagEntries: { tag: Tag; entries: Entry[] }[] = []
    for (const tag of matchingTags) {
      const tagged = entries.filter(e => (e.tags || []).some(t => t.id === tag.id))
      if (tagged.length > 0) tagEntries.push({ tag, entries: tagged })
    }

    if (tagEntries.length === 0 && titleMatches.length === 0) return null
    return { tagEntries, titleMatches }
  }, [activeSearch, searchQuery, allTags, entries])

  const tagSearchRef = useRef(tagSearchResults)
  useEffect(() => { tagSearchRef.current = tagSearchResults }, [tagSearchResults])

  const effectiveYears = searchResults ? searchResults.years : existingYears

  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>()
    s.add(thisYear)
    s.add(`${thisYear}-${thisMonth}`)
    return s
  })

  const toggle = (key: string) => {
    setExpanded(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  }

  const autoExpandedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!activeSearch) {
      autoExpandedRef.current = new Set()
      return
    }
    if (!searchResults) return
    setExpanded(prev => {
      const n = new Set(prev)
      for (const y of searchResults.years) {
        if (!autoExpandedRef.current.has(y)) {
          n.add(y)
          autoExpandedRef.current.add(y)
        }
        const ms = searchResults.months[y] || []
        for (const m of ms) {
          const key = `${y}-${m}`
          if (!autoExpandedRef.current.has(key)) {
            n.add(key)
            autoExpandedRef.current.add(key)
          }
        }
      }
      return n
    })
  }, [activeSearch, searchResults])

  const handleSelectDateSafe = (date: string) => {
    if (date < EARLIEST_DATE) {
      showToast({
        type: 'warning',
        message: '日期太早，暂不支持此日期之前的日志补写。',
      })
      return
    }
    // Allow future dates that already have an entry (even if empty),
    // only block empty future dates that would trigger auto-creation.
    const exists = entries.some(e => e.date === date)
    if (date > today && !exists) {
      showToast({
        type: 'warning',
        message: '不能创建未来日期的日志。',
      })
      return
    }
    onSelectDate(date === selectedDate ? null : date)
  }

  return (
    <aside className="w-full bg-[var(--bg-secondary)] flex flex-col h-full shrink-0 overflow-x-hidden">
      {/* 「文章」标题行已删（2026-09-19 反馈）：写作/全部文章两钮上移到左栏模块态头部最右
          （blog/index.tsx portal 到 modActionsEl），侧栏直接从收藏/归档开始 */}

      {/* 收藏 */}
      {starredEntries.length > 0 && (
        <div className="px-2 py-1">
          <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-[var(--text-muted)]">
            <Star size={11} className="text-[var(--warning)] fill-[var(--warning)]" />
            收藏
            <span className="text-[var(--text-disabled)]">{starredEntries.length}</span>
          </div>
          <div className="space-y-0.5">
            {starredEntries.map(e => (
              <button
                key={e.id}
                onClick={() => handleSelectDateSafe(e.date)}
                className={`w-full flex items-center gap-1.5 pl-6 pr-2 py-0.5 text-[12px] rounded transition-colors text-left ${
                  selectedDate === e.date
                    ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]'
                    : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                <Star size={10} className="shrink-0 text-[var(--warning)] fill-[var(--warning)]" />
                <span className="truncate flex-1">{formatEntryDate(e.date)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 树状归档 */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-1 py-1 flex flex-col">
        <div className="px-2 py-1 flex items-center justify-between">
          <span className="text-[11px] text-[var(--text-muted)]">
            文章归档
          </span>
          {activeSearch && (
            <button
              onClick={() => setSearchQuery('')}
              className="text-[10px] text-[var(--accent)] hover:text-[var(--accent-hover)]"
            >清除</button>
          )}
        </div>

        {/* 日期搜索 */}
        <div className="px-2 pb-2">
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key !== 'Enter') return
                const q = searchQuery.trim()
                if (!q) return
                const p = parseSearchDate(q)
                if (!p) return
                // Full date → navigate immediately
                if (p.year && p.month && p.day) {
                  setSearchQuery('')
                  handleSelectDateSafe(`${p.year}-${p.month}-${p.day}`)
                  return
                }
                // Partial (year / year-month) → expand tree nodes, keep search active
                if (p.year) {
                  setExpanded(prev => {
                    const n = new Set(prev)
                    n.add(p.year!)
                    if (p.month) n.add(`${p.year}-${p.month}`)
                    return n
                  })
                  return
                }
                // Substring fallback → find first date containing the query
                let target: string | null = null
                for (const y of existingYears) {
                  for (const m of Object.keys(tree[y] || {})) {
                    const found = (tree[y]?.[m] || []).find(d => d.date.includes(q))
                    if (found) { target = found.date; break }
                  }
                  if (target) break
                }
                if (target) {
                  setSearchQuery('')
                  handleSelectDateSafe(target)
                  return
                }
                // Fallback: navigate to first tag/title match
                const tsr = tagSearchRef.current
                if (tsr) {
                  setSearchQuery('')
                  if (tsr.titleMatches.length > 0) {
                    handleSelectDateSafe(tsr.titleMatches[0].date)
                  } else if (tsr.tagEntries.length > 0 && tsr.tagEntries[0].entries.length > 0) {
                    handleSelectDateSafe(tsr.tagEntries[0].entries[0].date)
                  }
                }
              }}
              placeholder="搜索日期 / 标签 / 标题"
              className="w-full pl-7 pr-2 py-1 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)]"
            />
          </div>
        </div>

        {effectiveYears.length === 0 && !activeSearch && (
          <p className="px-3 py-4 text-[12px] text-[var(--text-muted)] text-center">暂无文章</p>
        )}
        {activeSearch && searchResults === null && tagSearchResults === null && (
          <p className="px-3 py-4 text-[12px] text-[var(--text-muted)] text-center">未找到匹配的日期或标签</p>
        )}

        {/* Tag & title search results */}
        {tagSearchResults && (
          <div className="border-t border-[var(--border-color)] mt-1 pt-1">
            {/* Title matches */}
            {tagSearchResults.titleMatches.length > 0 && (
              <div className="mb-1">
                <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-[var(--text-muted)]">
                  <FileText size={11} />
                  标题匹配
                  <span className="text-[var(--text-disabled)]">{tagSearchResults.titleMatches.length}</span>
                </div>
                {tagSearchResults.titleMatches.map(e => (
                  <button
                    key={e.id}
                    onClick={() => { setSearchQuery(''); handleSelectDateSafe(e.date) }}
                    className="w-full flex items-center gap-1.5 pl-6 pr-2 py-0.5 text-[12px] rounded transition-colors text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                  >
                    <FileText size={11} className="shrink-0 text-[var(--text-muted)]" />
                    <span className="truncate flex-1">{e.title}</span>
                    <span className="shrink-0 text-[10px] text-[var(--text-disabled)]">{formatEntryDate(e.date)}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Tag matches */}
            {tagSearchResults.tagEntries.map(({ tag, entries: tagged }) => (
              <div key={tag.id} className="mb-1">
                <div className="flex items-center gap-1.5 px-2 py-1 text-[11px]"
                  style={{ color: tag.color }}>
                  <Hash size={11} />
                  标签: {tag.name}
                  <span style={{ opacity: 0.6 }}>{tagged.length}</span>
                </div>
                {tagged.map(e => (
                  <button
                    key={e.id}
                    onClick={() => { setSearchQuery(''); handleSelectDateSafe(e.date) }}
                    className="w-full flex items-center gap-1.5 pl-6 pr-2 py-0.5 text-[12px] rounded transition-colors text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                  >
                    <FileText size={11} className="shrink-0 text-[var(--text-muted)]" />
                    <span className="truncate flex-1">{e.title}</span>
                    <span className="shrink-0 text-[10px] text-[var(--text-disabled)]">{formatEntryDate(e.date)}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}

        {effectiveYears.map(year => {
          const yearOpen = expanded.has(year)
          const months =
            searchResults?.months[year]
            ?? Object.keys(tree[year] || {}).sort((a, b) => b.localeCompare(a))

          if (!months || months.length === 0) return null

          return (
            <div key={year}>
              <button onClick={() => toggle(year)}
                className="w-full flex items-center gap-1 px-2 py-1.5 text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded transition-colors">
                {yearOpen
                  ? <ChevronDown size={15} className="text-[var(--text-muted)] shrink-0" />
                  : <ChevronRight size={15} className="text-[var(--text-muted)] shrink-0" />}
                <span className="font-semibold">{year} 年</span>
                <span className="text-[10px] text-[var(--text-disabled)] ml-1">
                  {searchResults ? '搜索' : ''}
                </span>
              </button>

              {yearOpen && months.map(month => {
                const mk = `${year}-${month}`
                const mOpen = expanded.has(mk)
                const days = searchResults?.days[mk] ?? tree[year]?.[month] ?? []

                return (
                  <div key={mk} className="ml-3">
                    <button onClick={() => toggle(mk)}
                      className="w-full flex items-center gap-1 px-2 py-1 text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded transition-colors">
                      {mOpen
                        ? <ChevronDown size={15} className="text-[var(--text-muted)] shrink-0" />
                        : <ChevronRight size={15} className="text-[var(--text-muted)] shrink-0" />}
                      <span>{MONTH_NAMES[month] || `${month}月`}</span>
                      <span className="text-[10px] text-[var(--text-muted)] ml-1">
                        {days.filter(d => d.hasContent).length || ''}
                      </span>
                    </button>

                    {mOpen && days.map(day => (
                      <button key={day.date}
                        onClick={() => handleSelectDateSafe(day.date)}
                        className={`w-full flex items-center gap-2 ml-5 px-2 py-1 text-[13px] rounded transition-colors ${
                          selectedDate === day.date
                            ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]'
                            : day.hasContent
                              ? 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                              : 'text-[var(--text-disabled)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]'
                        }`}>
                        <FileText size={14} className={`shrink-0 ${day.hasContent ? 'text-[var(--text-secondary)]' : 'text-[var(--text-disabled)]'}`} />
                        <span>{day.date.slice(-2)} 日</span>
                        {!day.hasContent && (
                          <span className="text-[9px] text-[var(--text-disabled)] ml-auto">+</span>
                        )}
                      </button>
                    ))}
                  </div>
                )
              })}
            </div>
          )
        })}
      </nav>
    </aside>
  )
}
