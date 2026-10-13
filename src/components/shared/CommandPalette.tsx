import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { prefersReducedMotion } from '../../lib/usePresence'
import { filterAndRank } from '../../lib/fuzzy'

/**
 * 命令面板 / 快速切换器共用悬浮层（R1-W2，docs/rework-workbench-design.md §3）
 *
 * - 数据源由父组件注入（command 项 / 文件项），本组件只做：过滤排序 + 分组 + 键盘导航 + 渲染
 * - 快捷键：↑/↓ 选择、Enter 执行、Esc 关闭（执行/关闭统一走 onClose + item.run）
 * - R7 插件命令：往 items 数组里加 group="插件" 的条目即可注册
 *
 * ★ 2026-10-13（L2，docs/command-registry-plan.md 的 P3）三处增强：
 *   ① 过滤从「label / hint / group 三处 includes」换成 src/lib/fuzzy.ts 的 filterAndRank：
 *      多词是 AND、键位文本可搜、子序列兜底；排序规则由 .AGENT/scripts/commands/verify-palette-fuzzy.mjs
 *      逐条锁着（含「不丢召回」——旧口径能搜到的，新口径必须也搜得到）；
 *   ② 显示键帽：键位来自真源 commandRegistry（此前面板根本不知道快捷键）；
 *   ③ 「最近使用」：执行过的命令落 localStorage，空查询时置顶成一组。
 */
export interface PaletteItem {
  id: string
  label: string
  hint?: string
  group?: string
  /** 键位（多组同效），来自真源。面板只显示**第一组** —— 行很窄，完整清单在设置页的指令表里 */
  keys?: string[][]
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

/** 最近使用的落盘键。渲染层私有状态、不跨进程，故走 localStorage 而不是 SETTINGS（那是配置真源） */
const RECENTS_KEY = 'kb.palette.recents'
const RECENTS_MAX = 8

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY)
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string').slice(0, RECENTS_MAX) : []
  } catch { return [] }
}
function writeRecents(ids: string[]): void {
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(ids.slice(0, RECENTS_MAX))) } catch { /* 隐私模式等：静默放弃，不影响执行 */ }
}

export function CommandPalette({ placeholder, items, loading = false, emptyHint, footer, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [idx, setIdx] = useState(0)
  // 关闭先播退场（遮罩淡出 + 面板缩回），再通知父组件卸载
  const [closing, setClosing] = useState(false)
  const [recents, setRecents] = useState<string[]>(readRecents)
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

  /**
   * 渲染条目 = { 条目, 该行的分组标签 }。空查询时把「最近使用」置顶成一组，
   * 并把它们从原位置摘掉（否则同一条会出现在两个分组里）。
   */
  const entries = useMemo(() => {
    const q = query.trim()
    if (q) return filterAndRank(items, q).map((it) => ({ it, group: it.group }))
    const recentSet = new Set(recents)
    const recent = recents
      .map((id) => items.find((i) => i.id === id))
      .filter((x): x is PaletteItem => !!x)
    return [
      ...recent.map((it) => ({ it, group: '最近使用' })),
      ...items.filter((i) => !recentSet.has(i.id)).map((it) => ({ it, group: it.group })),
    ]
  }, [items, query, recents])

  useEffect(() => { setIdx(0) }, [query, entries.length])
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-i="${idx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [idx, entries.length])

  const pick = (it: PaletteItem) => {
    setRecents((prev) => {
      const next = [it.id, ...prev.filter((x) => x !== it.id)].slice(0, RECENTS_MAX)
      writeRecents(next)
      return next
    })
    // 动作立即执行，视觉上继续播退场
    setClosing(true)
    setTimeout(() => onClose(), prefersReducedMotion() ? 0 : 150)
    it.run()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSoon(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, entries.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      const it = entries[idx]?.it
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
          {!loading && entries.length === 0 && (
            <div className="px-3 py-6 text-center text-[12px] text-[var(--text-muted)]">
              {emptyHint ?? '无匹配项'}
            </div>
          )}
          {!loading &&
            entries.map(({ it, group }, i) => {
              const showGroup = group && group !== lastGroup
              lastGroup = group ?? null
              const selected = i === idx
              const chord = it.keys?.[0]
              return (
                <div key={it.id}>
                  {showGroup && (
                    <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-disabled)]">
                      {group}
                    </div>
                  )}
                  <button
                    data-i={i}
                    onMouseEnter={() => setIdx(i)}
                    onClick={() => pick(it)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors ${
                      selected ? 'bg-[var(--accent)]/12' : ''
                    }`}
                  >
                    <span className={`flex-1 truncate ${selected ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>{it.label}</span>
                    {it.hint && (
                      <span className="shrink-0 truncate max-w-[38%] text-[10.5px] text-[var(--text-disabled)]">{it.hint}</span>
                    )}
                    {/* 键帽：只显示第一组同效键（行窄）；完整清单在 设置 → 快捷键 的指令表里 */}
                    {chord && (
                      <span className="shrink-0 flex items-center gap-0.5">
                        {chord.map((k, ki) => (
                          <span
                            key={ki}
                            className="inline-flex items-center px-1 py-0.5 text-[10px] font-mono bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[var(--text-disabled)]"
                          >
                            {k}
                          </span>
                        ))}
                      </span>
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
