import {
  useCallback, useEffect, useMemo, useRef, useState,
  type JSX, type ReactNode,
} from 'react'
import { ArrowLeft, Check, ChevronDown, Search, Settings2, Star } from 'lucide-react'
import { AnchoredLayer } from './AnchoredLayer'
import {
  capabilityChips, entryLabel, pushRecentSpec, readRecentSpecs,
  resolveCatalogEntry, useModelCatalog,
} from '../../lib/modelCatalog'
import type { LlmModelEntry } from '../../types'
import { buildMenuSections, filterMenuEntries, menuLabel, nextIndex } from './modelMenuPure'

/**
 * 对话侧模型菜单（P3.2，按技术方案 §6.1 / 展示口径 §15.3）。
 *
 * 只做「选一个模型」这一件事：
 *   · 默认只列 **本课程默认 / 本课程精选 / 全局精选 / 最近使用**，供应商库存藏在
 *     「浏览全部模型」后面 —— 用户日常不该在几十个原始 ID 里找自己那个；
 *   · 一行的信息量按 §15.3 收口：主文本（条目名）+ 供应商小字 + 显式能力 chip + 免费星标；
 *     `auto` 能力不占位置（`capabilityChips` 已过滤），避免"看起来像有又像没有"；
 *   · 点选后**只回条目 id**：`pushRecentSpec(id)` → `onPick(id)` → 关菜单。旧 `pid:mid`
 *     只作为读入兼容（`resolveCatalogEntry` 认它），不再从菜单写出去。
 *
 * 定位走现有 `AnchoredLayer`（portal + 实测纠偏，滚动 / Esc / 点外面自动收起），
 * 不自造 fixed：这个菜单会从聊天输入区、旁问面板两处长出来，就地 absolute 会被裁。
 *
 * 数据全部来自 `useModelCatalog()`；`providers` 由父级传（组件不重复拉 IPC，
 * 也因此不重复触发 `settings` 广播刷新）。动效只用既有令牌：`.kb-pop`（浮层进场，
 * 由 AnchoredLayer 默认给）与 `.kb-chevron`（展开箭头），两者都自带 reduced-motion 兜底。
 *
 * 本文件**不接线**到现有对话界面，父级接入时只需给 `value / onPick / workspaceId`。
 */

export interface ModelMenuProps {
  /** 当前值：模型条目 id（m_xxx）或旧 providerId:modelId；空 = 跟随默认 */
  value: string
  /** 工作区 id；不传 = 只看全局 */
  workspaceId?: string
  /** 供应商名映射（父级已有 providers 数据，避免本组件重复拉） */
  providerNames?: Record<string, string>
  /** 选中回调：返回条目 id（内部保证只回条目 id，不再回旧 spec） */
  onPick: (entryId: string) => void
  /** 「管理模型」跳设置 */
  onManage?: () => void
  /** 触发器可自定义；缺省渲染一枚「模型名 + chevron」的 pill */
  renderTrigger?: (label: string) => ReactNode
  disabled?: boolean
}

export function ModelMenu({
  value, workspaceId, providerNames, onPick, onManage, renderTrigger, disabled = false,
}: ModelMenuProps): JSX.Element {
  const catalog = useModelCatalog()
  const entries = catalog.entries
  const workspace = workspaceId ? catalog.workspace(workspaceId) : {}

  const [open, setOpen] = useState(false)
  /** `grouped` = 分组精选；`all` = 浏览全部（同一浮层内切换，不另开弹窗） */
  const [view, setView] = useState<'grouped' | 'all'>('grouped')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [recentSpecs, setRecentSpecs] = useState<string[]>([])

  const triggerRef = useRef<HTMLDivElement | null>(null)

  const close = useCallback(() => {
    setOpen(false)
    setView('grouped')
    setQuery('')
  }, [])

  const toggle = useCallback(() => {
    if (disabled) return
    setOpen((prev) => {
      if (prev) return false
      // 每次打开重读最近使用：localStorage 是跨菜单实例的，状态里那份额度会过时
      setRecentSpecs(readRecentSpecs())
      setView('grouped')
      setQuery('')
      setActive(0)
      return true
    })
  }, [disabled])

  const current = useMemo(() => resolveCatalogEntry(value, entries)?.entry, [value, entries])
  const triggerLabel = current
    ? entryLabel(current, providerNames?.[current.providerId])
    : (value || '默认模型')

  /** 全局精选只认显式 `curated: true`：`useModelCatalog().curated` 在无人精选时会退回全部，那是给设置的兜底，不是菜单语义 */
  const curatedEntries = useMemo(() => entries.filter((e) => e.curated), [entries])

  const sections = useMemo(() => buildMenuSections({
    entries,
    curated: curatedEntries,
    workspaceDefaultId: workspace.modelEntryId,
    globalDefaultId: catalog.snapshot?.defaultEntryId,
    workspaceCuratedIds: workspace.curatedEntryIds,
    recentSpecs,
    resolve: (spec) => resolveCatalogEntry(spec, entries),
  }), [entries, curatedEntries, workspace.modelEntryId, workspace.curatedEntryIds, catalog.snapshot?.defaultEntryId, recentSpecs])

  const visible = useMemo(
    () => (view === 'all' ? filterMenuEntries(entries, query) : sections.flatMap((s) => s.items)),
    [view, entries, query, sections],
  )
  const indexById = useMemo(() => new Map(visible.map((e, i) => [e.id, i])), [visible])

  const pick = useCallback((entry: LlmModelEntry) => {
    pushRecentSpec(entry.id)
    onPick(entry.id)
    close()
  }, [onPick, close])

  // 键盘：↑↓ 循环移动、Enter 选中、Esc 关闭。
  // 搜索框里只认 ↑↓（Enter 要留给输入法上屏，Esc 交给 AnchoredLayer 的全局收口）。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const delta = e.key === 'ArrowDown' ? 1 : -1
        setActive((i) => nextIndex(i, delta, visible.length))
        return
      }
      if (typing) return
      if (e.key === 'Enter') {
        const target = visible[active]
        if (target) {
          e.preventDefault()
          pick(target)
        }
        return
      }
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, visible, active, pick, close])

  useEffect(() => { setActive(0) }, [open, view, query])

  const manage = onManage
    ? () => { onManage(); close() }
    : undefined

  return (
    <>
      <div ref={triggerRef} className="inline-flex min-w-0 max-w-full">
        {renderTrigger ? (
          <div
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-disabled={disabled || undefined}
            onClick={toggle}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
            className={disabled ? 'min-w-0 cursor-not-allowed opacity-55' : 'min-w-0 cursor-pointer'}
          >
            {renderTrigger(triggerLabel)}
          </div>
        ) : (
          <button
            type="button"
            disabled={disabled}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
            className="inline-flex items-center gap-1.5 h-7 max-w-[240px] px-2.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/50 hover:text-[var(--text-primary)] disabled:opacity-55 disabled:cursor-not-allowed"
          >
            <span className="min-w-0 truncate">{triggerLabel}</span>
            <ChevronDown size={12} className={`kb-chevron shrink-0 ${open ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>

      <AnchoredLayer
        anchorRef={triggerRef}
        open={open}
        onClose={close}
        align="start"
        role="menu"
        className="flex flex-col w-[300px] max-w-[calc(100vw-16px)] max-h-[360px] overflow-hidden rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-lg"
      >
        {view === 'all' && (
          <div className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--border-color)]">
            <button
              type="button"
              aria-label="返回精选"
              onClick={() => { setView('grouped'); setQuery('') }}
              className="shrink-0 p-0.5 rounded text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
            >
              <ArrowLeft size={12} />
            </button>
            <Search size={12} className="shrink-0 text-[var(--text-muted)]" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索模型"
              aria-label="搜索模型"
              className="flex-1 min-w-0 bg-transparent text-[12px] outline-none text-[var(--text-primary)] placeholder:text-[var(--text-disabled)]"
            />
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto py-1">
          {view === 'grouped' && sections.map((section) => (
            <div key={section.id}>
              <div className="px-2.5 pt-1.5 pb-0.5 text-[10.5px] text-[var(--text-muted)]">{section.title}</div>
              {section.items.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  providerName={providerNames?.[entry.providerId] ?? entry.providerId}
                  selected={!!current && current.id === entry.id}
                  active={indexById.get(entry.id) === active}
                  onHover={() => setActive(indexById.get(entry.id) ?? 0)}
                  onPick={pick}
                />
              ))}
            </div>
          ))}

          {view === 'all' && visible.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              providerName={providerNames?.[entry.providerId] ?? entry.providerId}
              selected={!!current && current.id === entry.id}
              active={indexById.get(entry.id) === active}
              onHover={() => setActive(indexById.get(entry.id) ?? 0)}
              onPick={pick}
            />
          ))}

          {visible.length === 0 && (
            <div className="px-2.5 py-3 text-[11.5px] text-[var(--text-muted)]">
              {view === 'all' && query
                ? `没有匹配「${query}」的模型`
                : entries.length === 0
                  ? (
                    <span className="inline-flex items-center gap-1 flex-wrap">
                      还没有可用模型
                      {manage && (
                        <button
                          type="button"
                          onClick={manage}
                          className="text-[var(--accent)] transition-colors hover:underline"
                        >
                          管理模型
                        </button>
                      )}
                    </span>
                  )
                  : '还没有精选模型，去「管理模型」里挑几个'}
            </div>
          )}
        </div>

        {view === 'grouped' && (
          <button
            type="button"
            onClick={() => { setView('all'); setQuery(''); setActive(0) }}
            className="shrink-0 w-full flex items-center gap-2 px-2.5 py-1.5 border-t border-[var(--border-color)] text-left text-[11.5px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            <Search size={11} className="shrink-0 text-[var(--text-muted)]" />
            <span className="min-w-0 flex-1 truncate">浏览全部模型</span>
            <span className="shrink-0 text-[10.5px] text-[var(--text-muted)]">{entries.length}</span>
          </button>
        )}

        {onManage && (
          <button
            type="button"
            onClick={manage}
            className="shrink-0 w-full flex items-center gap-2 px-2.5 py-1.5 border-t border-[var(--border-color)] text-left text-[11.5px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            <Settings2 size={11} className="shrink-0 text-[var(--text-muted)]" />
            <span className="min-w-0 flex-1 truncate">管理模型</span>
          </button>
        )}
      </AnchoredLayer>
    </>
  )
}

function EntryRow({ entry, providerName, selected, active, onHover, onPick }: {
  entry: LlmModelEntry
  providerName?: string
  selected: boolean
  active: boolean
  onHover: () => void
  onPick: (entry: LlmModelEntry) => void
}) {
  const chips = capabilityChips(entry)
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onMouseEnter={onHover}
      onClick={() => onPick(entry)}
      className={`w-full flex items-center gap-1.5 px-2.5 py-1 text-left text-[12px] transition-colors ${
        active ? 'bg-[var(--bg-hover)]' : ''
      } ${selected ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}
    >
      <span className="min-w-0 flex-1 truncate">{menuLabel(entry, providerName)}</span>
      {providerName && entry.name?.trim() && (
        <span className="shrink-0 max-w-[38%] truncate text-[10px] text-[var(--text-muted)]">{providerName}</span>
      )}
      {chips.map((chip) => (
        <span
          key={chip.key}
          className={`shrink-0 text-[10px] leading-4 px-1 rounded border ${
            chip.state === 'yes'
              ? 'border-[var(--accent)]/40 text-[var(--accent)]'
              : 'border-[var(--border-color)] text-[var(--text-disabled)]'
          }`}
        >
          {chip.label}
        </span>
      ))}
      {entry.free && (
        <Star size={10} data-tip="免费模型" aria-label="免费模型" className="shrink-0 fill-amber-400 text-amber-400" />
      )}
      <span className="shrink-0 w-3 flex items-center justify-center">
        {selected && <Check size={11} className="text-[var(--accent)]" aria-hidden />}
      </span>
    </button>
  )
}
