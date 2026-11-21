import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
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

/**
 * 设置页全局搜索（2026-11-20 按原型重画）。
 *
 * 形态严格走 `docs/input-field-pattern.md` §3 的 B 形态：`.kb-field` 外壳画**唯一一道**框、
 * `.kb-field-control` 把全局 input 的边框/背景归零，焦点只在外壳（`:focus-within`）。
 * 框线颜色用 `--field-border`（`.kb-field-strong`）：深色下 `--input-bg` 与 `--border-color`
 * 同为 #3c3c3c，直接用 `--border-color` 等于没有框。
 *
 * 补齐幽灵文本仍在：它是「按 Tab 补全」的唯一视觉线索，删掉等于把能力藏起来。
 */
export function SettingsSearchBox({
  query, onQueryChange, suggestions, open, onOpenChange, onPick, completion, total,
}: Props) {
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([])
  const listId = useId()

  const rows = suggestions.slice(0, MAX_VISIBLE)
  const tokens = highlightTokens(query)
  const showDropdown = open && rows.length > 0
  const showPanel = open && (rows.length > 0 || query.trim().length > 0)
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

  const clear = () => {
    onQueryChange('')
    onOpenChange(true)
    inputRef.current?.focus()
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
      // 有文字 = 清空（需求口径）；空文字 = 关下拉；再按才失焦
      if (query) { onQueryChange(''); return }
      if (open) { onOpenChange(false); return }
      e.currentTarget.blur()
    }
  }

  return (
    <div className="relative group">
      <div className="kb-field kb-field-strong flex h-9 items-center gap-[7px] rounded-lg px-2.5">
        <Search size={14} className="shrink-0 text-[var(--text-muted)]" />

        <div className="relative min-w-0 flex-1 self-stretch">
          {/* 补齐幽灵文本：与 input 同框同字号，已输入部分透明，补余部分置灰 */}
          {completion && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre text-[13px] leading-5"
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
            role="combobox"
            aria-label="搜索设置"
            aria-autocomplete="list"
            aria-expanded={showPanel}
            aria-controls={rows.length > 0 ? listId : undefined}
            className="kb-field-control relative h-full w-full min-w-0 text-[13px] leading-5 text-[var(--text-primary)] placeholder:text-[var(--text-disabled)]"
          />
        </div>

        {query && (
          <button
            type="button"
            onMouseDown={e => e.preventDefault()}
            onClick={clear}
            data-tip="清除搜索"
            aria-label="清除搜索"
            className="shrink-0 grid place-items-center w-[22px] h-[22px] rounded-[5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {showPanel && (
        <div
          ref={listRef}
          onMouseDown={e => e.preventDefault()}
          className="absolute left-0 right-0 top-[calc(100%+5px)] z-50 overflow-hidden rounded-[9px] border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-lg kb-pop"
        >
          <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10.5px] text-[var(--text-muted)]">
            {isRecommending
              ? <Flame size={11} className="shrink-0 text-[var(--warning)]" />
              : <Search size={11} className="shrink-0" />}
            <span>{isRecommending ? '热门设置' : '搜索结果'}</span>
            <span className="ml-auto tabular-nums text-[var(--text-disabled)]">共 {total} 项</span>
          </div>

          {rows.length === 0 ? (
            <p className="px-3 py-4 text-center text-[11.5px] text-[var(--text-muted)]">
              未找到匹配「<span className="text-[var(--text-secondary)]">{query.trim()}</span>」的设置项
            </p>
          ) : (
            <div id={listId} role="listbox" aria-label="设置搜索建议" className="max-h-[320px] overflow-y-auto py-1">
            {rows.map((item, i) => {
              const sec = SECTION_MAP[item.section]
              return (
                <button
                  key={item.id}
                  ref={el => { rowRefs.current[i] = el }}
                  type="button"
                  role="option"
                  aria-selected={i === activeIdx}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => pick(item)}
                  className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
                    i === activeIdx ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]' : 'hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  <span className={`shrink-0 ${i === activeIdx ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}>
                    {sec.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5 min-w-0">
                      <span className="text-[10px] text-[var(--text-muted)] shrink-0 truncate">
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
          )}

          {rows.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 border-t border-[var(--border-color)] text-[10px] text-[var(--text-muted)]">
              <span className="flex items-center gap-1"><ArrowUp size={10} /><ArrowDown size={10} /> 选择</span>
              <span className="flex items-center gap-1"><CornerDownLeft size={10} /> 跳转</span>
              {completion && <span>Tab 补全</span>}
              <span className="ml-auto">Esc 关闭</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
