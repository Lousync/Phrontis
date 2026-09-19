import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { prefersReducedMotion } from '../../lib/usePresence'

/**
 * 命令面板 / 快速切换器共用悬浮层（R1-W2，docs/rework-workbench-design.md §3）
 *
 * - 数据源由父组件注入（command 项 / 文件项），本组件只做：过滤 + 分组 + 键盘导航 + 渲染
 * - 快捷键：↑/↓ 选择、Enter 执行、Esc 关闭（执行/关闭统一走 onClose + item.run）
 * - R7 插件命令：往 items 数组里加 group="插件" 的条目即可注册
 */
export interface PaletteItem {
  id: string
  label: string
  hint?: string
  group?: string
  run: () => void
}

interface Props {
  placeholder: string
  items: PaletteItem[]
  loading?: boolean
  emptyHint?: string
  footer?: string
  onClose: () => void
}

export function CommandPalette({ placeholder, items, loading = false, emptyHint, footer, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [idx, setIdx] = useState(0)
  // 关闭先播退场（遮罩淡出 + 面板缩回），再通知父组件卸载
  const [closing, setClosing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const closeSoon = useCallback(() => {
    setClosing(true)
    setTimeout(() => onClose(), prefersReducedMotion() ? 0 : 150)
  }, [onClose])

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((it) =>
      it.label.toLowerCase().includes(q) ||
      (it.hint ?? '').toLowerCase().includes(q) ||
      (it.group ?? '').toLowerCase().includes(q),
    )
  }, [items, query])

  useEffect(() => { setIdx(0) }, [query, filtered.length])
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-i="${idx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [idx, filtered.length])

  const pick = (it: PaletteItem) => {
    // 动作立即执行，视觉上继续播退场
    setClosing(true)
    setTimeout(() => onClose(), prefersReducedMotion() ? 0 : 150)
    it.run()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSoon(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, filtered.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      const it = filtered[idx]
      if (it) pick(it)
    }
  }

  let lastGroup: string | null = null

  return (
    <div
      data-wb="palette"
      className={`fixed inset-0 z-[80] flex items-start justify-center pt-[13vh] bg-black/25 ${closing ? 'kb-overlay-out' : 'kb-overlay'}`}
      onMouseDown={closeSoon}
    >
      <div
        className={`w-[560px] max-w-[88vw] flex flex-col overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-[0_18px_50px_rgba(0,0,0,0.35)] ${closing ? 'kb-modal-out' : 'kb-modal-in'}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 输入行 */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--border-color)]">
          <Search size={14} className="text-[var(--text-muted)] shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            className="flex-1 bg-transparent outline-none text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)]"
          />
          <span className="shrink-0 text-[10px] text-[var(--text-disabled)] border border-[var(--border-color)] rounded px-1 py-0.5">Esc</span>
        </div>

        {/* 结果列表 */}
        <div ref={listRef} className="max-h-[44vh] overflow-y-auto py-1">
          {loading && (
            <div className="px-3 py-6 text-center text-[12px] text-[var(--text-muted)]">加载中…</div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-[12px] text-[var(--text-muted)]">
              {emptyHint ?? '无匹配项'}
            </div>
          )}
          {!loading &&
            filtered.map((it, i) => {
              const showGroup = it.group && it.group !== lastGroup
              lastGroup = it.group ?? null
              const selected = i === idx
              return (
                <div key={it.id}>
                  {showGroup && (
                    <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-disabled)]">
                      {it.group}
                    </div>
                  )}
                  <button
                    data-i={i}
                    onMouseEnter={() => setIdx(i)}
                    onClick={() => pick(it)}
                    className={`w-full flex items-baseline gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors ${
                      selected ? 'bg-[var(--accent)]/12' : ''
                    }`}
                  >
                    <span className={`truncate ${selected ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>{it.label}</span>
                    {it.hint && (
                      <span className="ml-auto shrink-0 truncate max-w-[45%] text-[10.5px] text-[var(--text-disabled)]">{it.hint}</span>
                    )}
                  </button>
                </div>
              )
            })}
        </div>

        {footer && (
          <div className="border-t border-[var(--border-color)] px-3 py-1.5 text-[10.5px] text-[var(--text-muted)] bg-[var(--bg-primary)]/40">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
