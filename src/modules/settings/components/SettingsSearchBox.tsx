import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Search, CornerDownLeft, ArrowUp, ArrowDown, X, Flame } from 'lucide-react'
import { SECTION_MAP, type SettingItem } from '../sections'
import { Highlight, highlightTokens } from './Highlight'

interface Props {
  query: string
  onQueryChange: (q: string) => void
  /** 下拉候选（有输入=搜索结果，无输入=热门推荐） */
  suggestions: SettingItem[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (item: SettingItem) => void
  /** 可补齐到输入框尾部的文本 */
  completion: string
  /** 搜索结果总数（用于下拉底部提示） */
  total: number
}

const MAX_VISIBLE = 8

export function SettingsSearchBox({
  query, onQueryChange, suggestions, open, onOpenChange, onPick, completion, total,
}: Props) {
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([])

  const rows = suggestions.slice(0, MAX_VISIBLE)
  const tokens = highlightTokens(query)
  const showDropdown = open && rows.length > 0
  const isRecommending = query.trim().length === 0

  useEffect(() => { setActiveIdx(0) }, [query])

  useLayoutEffect(() => {
    if (!showDropdown) return
    rowRefs.current[activeIdx]?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, showDropdown])

  const pick = (item: SettingItem) => {
    onPick(item)
    onOpenChange(false)
    inputRef.current?.blur()
  }

  const acceptCompletion = () => {
    if (!completion) return false
    onQueryChange(query + completion)
    return true
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) { onOpenChange(true); return }
      setActiveIdx(i => Math.min(i + 1, rows.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(i - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      if (showDropdown && rows[activeIdx]) { e.preventDefault(); pick(rows[activeIdx]) }
      return
    }
    if (e.key === 'Tab') {
      if (acceptCompletion()) e.preventDefault()
      return
    }
    if (e.key === 'ArrowRight') {
      const el = e.currentTarget
      if (el.selectionStart === el.value.length && acceptCompletion()) e.preventDefault()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      if (open) { onOpenChange(false); return }
      if (query) onQueryChange('')
      else e.currentTarget.blur()
    }
  }

  return (
    <div className="relative group">
      <div className="relative">
        {/* 背景层单独放，input 与幽灵文本都透明叠在它上面 */}
        <div className="absolute inset-0 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] group-focus-within:border-[var(--accent)] pointer-events-none transition-colors" />
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] z-10" />

        {/* 补齐幽灵文本：与 input 同框同字号，已输入部分透明，补余部分置灰 */}
        {completion && (
          <div
            aria-hidden
            className="absolute inset-0 flex items-center pl-9 pr-9 border border-transparent rounded-md text-[13px] leading-5 whitespace-pre overflow-hidden pointer-events-none"
          >
            <span className="invisible">{query}</span>
            <span className="text-[var(--text-disabled)]">{completion}</span>
          </div>
        )}

        <input
          ref={inputRef}
          value={query}
          onChange={e => { onQueryChange(e.target.value); onOpenChange(true) }}
          onFocus={() => onOpenChange(true)}
          onBlur={() => onOpenChange(false)}
          onKeyDown={onKeyDown}
          placeholder="搜索设置项，如：字体、行号、提醒时间、MCP…"
          spellCheck={false}
          className={`relative w-full pl-9 ${query ? 'pr-9' : 'pr-4'} py-2 bg-transparent border border-transparent rounded-md text-[13px] leading-5 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]`}
        />

        {query && (
          <button
            onMouseDown={e => e.preventDefault()}
            onClick={() => { onQueryChange(''); onOpenChange(true); inputRef.current?.focus() }}
            data-tip="清除" aria-label="清除"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {showDropdown && (
        <div
          ref={listRef}
          onMouseDown={e => e.preventDefault()}
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 overflow-hidden rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-lg"
        >
          {isRecommending && (
            <div className="flex items-center gap-1.5 px-3 pt-2 pb-1.5 text-[11px] text-[var(--text-muted)]">
              <Flame size={11} /> 热门设置
            </div>
          )}

          <div className="max-h-[320px] overflow-y-auto py-1">
            {rows.map((item, i) => {
              const sec = SECTION_MAP[item.section]
              return (
                <button
                  key={item.id}
                  ref={el => { rowRefs.current[i] = el }}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => pick(item)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                    i === activeIdx ? 'bg-[var(--bg-selected)]' : 'hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  <span className={`shrink-0 ${i === activeIdx ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}>
                    {sec.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5 min-w-0">
                      <span className="text-[10px] text-[var(--text-muted)] shrink-0">
                        <Highlight text={sec.label} tokens={tokens} /> › <Highlight text={item.group} tokens={tokens} />
                      </span>
                    </span>
                    <span className="block text-[13px] text-[var(--text-primary)] truncate">
                      <Highlight text={item.label} tokens={tokens} />
                    </span>
                    {item.desc && (
                      <span className="block text-[11px] text-[var(--text-muted)] truncate">
                        <Highlight text={item.desc} tokens={tokens} />
                      </span>
                    )}
                  </span>
                  {i === activeIdx && <CornerDownLeft size={12} className="shrink-0 text-[var(--text-muted)]" />}
                </button>
              )
            })}
          </div>

          <div className="flex items-center gap-3 px-3 py-1.5 border-t border-[var(--border-color)] text-[10px] text-[var(--text-muted)]">
            <span className="flex items-center gap-1"><ArrowUp size={10} /><ArrowDown size={10} /> 选择</span>
            <span className="flex items-center gap-1"><CornerDownLeft size={10} /> 跳转</span>
            {completion && <span>Tab 补全</span>}
            <span className="ml-auto">共 {total} 项</span>
          </div>
        </div>
      )}
    </div>
  )
}
