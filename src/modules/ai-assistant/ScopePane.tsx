import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, ChevronDown, Folder, FileText, X } from 'lucide-react'
import type { WorkspaceEntry } from '../../types'
import { workspaceListDir } from '../../lib/ipc'

/**
 * 作用域圈选面板（v3.9.0）：仓库目录树 + 勾选 + 名称过滤。
 *
 * scope 语义与主进程 `aiAssistantScope` 一致：勾中的节点 rel 即为一个前缀条目
 * （目录覆盖其下全部，文件即其自身）。搜索是**已加载节点**的名称过滤（不做全库检索，避免误导）。
 */
interface Props {
  rootId: string | null
  scope: string[]
  onChange: (scope: string[]) => void
  /**
   * 运行中锁定（2026-10-16 拍板）：本轮的工具调用已按运行开头的 scope 快照跑完，
   * 中途改勾选只会在下一轮生效 —— 与其让用户以为「换了范围却没反应」，不如直接置灰。
   * 展开/浏览仍开放（只读操作，无副作用）。
   */
  disabled?: boolean
}

const MD_EXTS = ['.md', '.txt']

function joinRel(base: string, name: string): string {
  return base ? `${base}/${name}` : name
}

export function ScopePane({ rootId, scope, onChange, disabled = false }: Props) {
  const [children, setChildren] = useState<Record<string, WorkspaceEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))
  const [filter, setFilter] = useState('')

  const load = useCallback(async (rel: string) => {
    if (!rootId) return
    try {
      const r = await workspaceListDir(rootId, rel || undefined)
      setChildren((prev) => ({ ...prev, [rel]: (r.entries ?? []).filter((e) => e.type === 'dir' || MD_EXTS.some((x) => e.name.toLowerCase().endsWith(x))) }))
    } catch {
      setChildren((prev) => ({ ...prev, [rel]: [] }))
    }
  }, [rootId])

  useEffect(() => { setChildren({}); setExpanded(new Set([''])); if (rootId) void load('') }, [rootId, load])

  const toggleExpand = useCallback((rel: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else { next.add(rel); if (!children[rel]) void load(rel) }
      return next
    })
  }, [children, load])

  const toggleCheck = useCallback((rel: string) => {
    if (disabled) return
    if (scope.includes(rel)) { onChange(scope.filter((s) => s !== rel)); return }
    // 已被某个祖先目录覆盖 → 无需重复添加
    if (scope.some((s) => rel.startsWith(s + '/'))) return
    // 勾中目录/文件后，去掉落在它内部的冗余条目
    onChange([...scope.filter((s) => !s.startsWith(rel + '/')), rel])
  }, [scope, onChange, disabled])

  const scopeSet = useMemo(() => new Set(scope), [scope])

  const rowAllowed = useCallback((rel: string): boolean => {
    if (!filter.trim()) return true
    return rel.toLowerCase().includes(filter.trim().toLowerCase())
  }, [filter])

  const renderLevel = (base: string, depth: number): React.ReactNode => {
    const list = children[base]
    if (!list) return null
    return list.map((e) => {
      const rel = joinRel(base, e.name)
      const isDir = e.type === 'dir'
      const matches = rowAllowed(rel)
      const childMatches = isDir && (children[rel] ?? []).some((c) => rowAllowed(joinRel(rel, c.name)))
      if (filter.trim() && !matches && !childMatches) return null
      const open = expanded.has(rel)
      const checked = scopeSet.has(rel)
      return (
        <div key={rel}>
          <div className="group flex items-center gap-1 rounded-md py-0.5 pr-1 hover:bg-[var(--bg-hover)]" style={{ paddingLeft: depth * 12 }}>
            <button
              type="button"
              onClick={() => (isDir ? toggleExpand(rel) : toggleCheck(rel))}
              className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-muted)]"
            >
              {isDir ? (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : <FileText size={12} />}
            </button>
            <label className={`flex min-w-0 flex-1 items-center gap-1.5 ${disabled ? 'cursor-default' : 'cursor-pointer'}`}>
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => toggleCheck(rel)}
                className="h-3.5 w-3.5 shrink-0 accent-[var(--accent)] disabled:opacity-50"
              />
              {isDir && <Folder size={12} className="shrink-0 text-[var(--text-muted)]" />}
              <span className="truncate text-[12px] text-[var(--text-secondary)]">{e.name}</span>
            </label>
          </div>
          {isDir && open ? <div>{renderLevel(rel, depth + 1)}</div> : null}
        </div>
      )
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pb-1.5">
        <div className="flex items-center gap-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 focus-within:border-[var(--accent)]">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索文件名…"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
          {filter && (
            <button
              type="button"
              onClick={() => setFilter('')}
              className="kb-micro-pop shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              title="清除"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>
      {scope.length > 0 && (
        <div className="mx-2 mb-1.5 flex flex-wrap gap-1">
          {scope.map((s) => (
            <span key={s} className="kb-item-in inline-flex max-w-full items-center gap-1 rounded-md bg-[var(--bg-selected)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)]">
              <span className="truncate">{s}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(scope.filter((x) => x !== s))}
                className="shrink-0 text-[var(--text-muted)] hover:text-[var(--danger)] disabled:opacity-40 disabled:hover:text-[var(--text-muted)]"
                title={disabled ? '运行中已锁定，跑完可改' : '移除'}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
        {!rootId ? (
          <p className="px-2 py-4 text-center text-[12px] text-[var(--text-muted)]">尚未打开仓库</p>
        ) : (children[''] ?? []).length === 0 ? (
          <p className="px-2 py-4 text-center text-[12px] text-[var(--text-muted)]">仓库为空</p>
        ) : (
          renderLevel('', 0)
        )}
      </div>
    </div>
  )
}
