import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, ChevronDown, Folder, FileText, X } from 'lucide-react'
import type { WorkspaceEntry } from '../../types'
import { workspaceListDir } from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import {
  SCOPE_ENTRY_SOFT_CAP,
  addToScope,
  batchAdd,
  coveredBy,
  coverageOf,
  removeFromScope,
  type KidsOf,
} from './scopeSetPure'

/**
 * 作用域圈选面板（v3.9.x 起为「集合语义 + 前缀压缩」）：仓库目录树 + 三态勾选 + 名称过滤 + 一行摘要。
 *
 * 存储仍是主进程那套前缀覆盖（`'A'` 覆盖 `A` 下**一切**文件），但显示与点击都按**集合**口径：
 * 复选框反映节点的真实归属（实勾 / 半选 / 未勾），点击 = 整棵子树进或出，勾完再压回前缀。
 * 选择态只有树里这一处表达（旧 chip 行已删，计数交给下方摘要行）。
 *
 * 搜索是**已加载节点**的名称过滤（不做全库检索，避免误导）。
 */
interface Props {
  rootId: string | null
  scope: string[]
  /** true = 整个仓库（与空 scope 的「不选文件」严格区分） */
  scopeAll?: boolean
  onChange: (scope: string[]) => void
  onScopeAllChange?: (all: boolean) => void
  /**
   * 运行中锁定（2026-10-16 拍板）：本轮的工具调用已按运行开头的 scope 快照跑完，
   * 中途改勾选只会在下一轮生效 —— 与其让用户以为「换了范围却没反应」，不如直接置灰。
   * 展开/浏览仍开放（只读操作，无副作用）。摘要行动作按钮同受此约束。
   */
  disabled?: boolean
}

const MD_EXTS = ['.md', '.txt']

/** 树里显示的行（目录 + 文本页）。**只**喂给显示；炸开与全选必须用未过滤清单，见下方 childrenRaw */
function isTreeEntry(e: WorkspaceEntry): boolean {
  return e.type === 'dir' || MD_EXTS.some((x) => e.name.toLowerCase().endsWith(x))
}

function joinRel(base: string, name: string): string {
  return base ? `${base}/${name}` : name
}

function kidsOfMap(map: Record<string, WorkspaceEntry[]>): KidsOf {
  return (rel) => {
    const list = map[rel]
    return list && list.map((e) => joinRel(rel, e.name))
  }
}

/** `rel` 的全部真祖先前缀（不含自身）；炸开时要逐层确保它们列过子项 */
function ancestorChain(rel: string): string[] {
  const parts = rel.split('/').filter(Boolean)
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'))
  return out
}

export function ScopePane({ rootId, scope, scopeAll = false, onChange, onScopeAllChange, disabled = false }: Props) {
  const [children, setChildren] = useState<Record<string, WorkspaceEntry[]>>({})
  const [childrenRaw, setChildrenRaw] = useState<Record<string, WorkspaceEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))
  const [filter, setFilter] = useState('')
  /**
   * raw 清单的同步镜像。取消勾选是「边往下炸边补列子项」的异步过程，
   * 而这一轮闭包里的 state 还是旧的 —— 只读 state 会炸到一半判不出子项。
   */
  const rawRef = useRef<Record<string, WorkspaceEntry[]>>({})

  const fetchDir = useCallback(async (rel: string): Promise<WorkspaceEntry[]> => {
    if (!rootId) return []
    let raw: WorkspaceEntry[]
    try {
      raw = (await workspaceListDir(rootId, rel || undefined)).entries ?? []
    } catch {
      // 列不出来时只置显示用的过滤清单，raw 缓存**留空不写**：
      // 炸开路径靠「raw 里没有这一层」判定子项未知，写进空数组会把整条上层前缀静默摘掉
      setChildren((prev) => ({ ...prev, [rel]: [] }))
      return []
    }
    rawRef.current[rel] = raw
    setChildrenRaw((prev) => ({ ...prev, [rel]: raw }))
    setChildren((prev) => ({ ...prev, [rel]: raw.filter(isTreeEntry) }))
    return raw
  }, [rootId])

  useEffect(() => {
    rawRef.current = {}
    setChildren({})
    setChildrenRaw({})
    setExpanded(new Set(['']))
    if (rootId) void fetchDir('')
  }, [rootId, fetchDir])

  const toggleExpand = useCallback((rel: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else { next.add(rel); if (!children[rel]) void fetchDir(rel) }
      return next
    })
  }, [children, fetchDir])

  const refuse = useCallback((reason: 'remove' | 'add') => {
    showToast(reason === 'remove'
      ? {
        type: 'info',
        message: '单独取消这一项，得先把上层目录拆成一条条前缀',
        detail: `子项没列出来，或拆完会超过 ${SCOPE_ENTRY_SOFT_CAP} 项上限。建议直接调整上层目录，或给不收的文件加 .ignore`,
      }
      : {
        type: 'info',
        message: `已选条目已到上限 ${SCOPE_ENTRY_SOFT_CAP} 项`,
        detail: '勾上层目录（一条前缀盖一片）比逐个勾省力；再往上涨落库会在 500 条处截断',
      })
  }, [])

  /**
   * 集合语义开关：整棵已选 → 移出；半选或未选 → 加入。
   * 移出可能要把盖住它的前缀炸开成兄弟，那一层的子项还没列过就先补列再试一次。
   */
  const toggleCheck = useCallback(async (rel: string) => {
    if (disabled) return
    const live = () => kidsOfMap(rawRef.current)
    if (coverageOf(scope, rel, live()) === 'all') {
      let next = removeFromScope(scope, rel, live())
      if (next === null) {
        for (const anc of ancestorChain(rel)) { if (!rawRef.current[anc]) await fetchDir(anc) }
        next = removeFromScope(scope, rel, live())
      }
      if (next === null) { refuse('remove'); return }
      onChange(next)
      return
    }
    const next = addToScope(scope, rel)
    if (next.length > SCOPE_ENTRY_SOFT_CAP) { refuse('add'); return }
    onChange(next)
  }, [scope, onChange, disabled, fetchDir, refuse])

  const rowAllowed = useCallback((rel: string): boolean => {
    if (!filter.trim()) return true
    return rel.toLowerCase().includes(filter.trim().toLowerCase())
  }, [filter])

  const kidsRender = kidsOfMap(childrenRaw)
  const filtering = filter.trim().length > 0
  /** 本轮真正渲染出来、且自身名称命中过滤的节点：摘要行的「命中 M」与「全选可见」都取这个口径 */
  const visible: string[] = []

  const renderLevel = (base: string, depth: number): React.ReactNode => {
    const list = children[base]
    if (!list) return null
    return list.map((e) => {
      const rel = joinRel(base, e.name)
      const isDir = e.type === 'dir'
      const matches = rowAllowed(rel)
      const childMatches = isDir && (children[rel] ?? []).some((c) => rowAllowed(joinRel(rel, c.name)))
      if (filtering && !matches && !childMatches) return null
      if (matches) visible.push(rel)
      const open = expanded.has(rel)
      const cov = coveredBy(scope, rel)
      const coveredByAncestor = !!cov && cov !== rel
      const mode = coverageOf(scope, rel, kidsRender)
      return (
        <div key={rel}>
          <div className="group flex items-center gap-1 rounded-md py-0.5 pr-1 hover:bg-[var(--bg-hover)]" style={{ paddingLeft: depth * 12 }}>
            <button
              type="button"
              onClick={() => (isDir ? toggleExpand(rel) : void toggleCheck(rel))}
              className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-muted)]"
            >
              {isDir ? (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : <FileText size={12} />}
            </button>
            <label className={`flex min-w-0 flex-1 items-center gap-1.5 ${disabled ? 'cursor-default' : 'cursor-pointer'}`}>
              <input
                type="checkbox"
                checked={mode === 'all'}
                ref={(el) => { if (el) el.indeterminate = mode === 'partial' }}
                disabled={disabled}
                onChange={() => void toggleCheck(rel)}
                className="h-3.5 w-3.5 shrink-0 accent-[var(--accent)] disabled:opacity-50"
              />
              {isDir && <Folder size={12} className="shrink-0 text-[var(--text-muted)]" />}
              <span className={`truncate text-[12px] ${coveredByAncestor ? 'text-[var(--text-muted)]' : 'text-[var(--text-secondary)]'}`}>{e.name}</span>
            </label>
            {coveredByAncestor && (
              <span
                className="shrink-0 text-[10px] text-[var(--text-disabled)]"
                title={`已由前缀「${cov}」整体覆盖，取消这一项要把「${cov}」拆成子项`}
              >
                来自 {cov!.split('/').pop()}
              </span>
            )}
          </div>
          {isDir && open ? <div>{renderLevel(rel, depth + 1)}</div> : null}
        </div>
      )
    })
  }

  /** 先建树再算摘要：renderLevel 会顺手收集「本轮真正渲染出来且自身命中的节点」，摘要行与全选可见都读它 */
  const tree = renderLevel('', 0)

  const batchMode: 'visible' | 'top' | 'clear' | 'files' = filtering && visible.length > 0
    ? 'visible'
    : scopeAll ? 'files' : scope.length === 0 ? 'top' : 'clear'
  const batchLabel = batchMode === 'visible'
    ? `全选可见(${visible.length})`
    : batchMode === 'files' ? '改为选择文件' : batchMode === 'top' ? '全选顶层' : '全部取消'

  const runBatch = () => {
    if (disabled) return
    if (batchMode === 'files') { onScopeAllChange?.(false); return }
    if (batchMode === 'clear') { onChange([]); return }
    const rels = batchMode === 'visible' ? visible : (childrenRaw[''] ?? []).map((e) => joinRel('', e.name))
    const next = batchAdd(scope, rels)
    if (next.length > SCOPE_ENTRY_SOFT_CAP) { refuse('add'); return }
    onChange(next)
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
      {/* 整仓 / 文件级二选一：整仓时树仍可点，点任意文件即缩窄（并自动切先预览） */}
      <label className={`mx-2 mb-1.5 flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1.5 text-[11.5px] ${disabled ? 'cursor-default opacity-60' : ''}`}>
        <input
          type="checkbox"
          checked={scopeAll}
          disabled={disabled}
          onChange={() => onScopeAllChange?.(!scopeAll)}
          className="h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
        />
        <span className="text-[var(--text-secondary)]">整个仓库</span>
        <span className="ml-auto text-[10.5px] text-[var(--text-muted)]">
          {scopeAll ? '读写不按文件限制' : '点选文件可缩窄'}
        </span>
      </label>
      {/* 摘要行（F-5 = 只报数 / F-3 = 同位单按钮）：高度恒定，选择态不在这里逐条铺开 */}
      <div className="flex shrink-0 items-center justify-between gap-2 px-2 pb-1.5">
        <span className="min-w-0 truncate text-[11px] text-[var(--text-muted)]" title={disabled ? '运行中已锁定，跑完可改' : undefined}>
          {scopeAll
            ? '整个仓库'
            : scope.length === 0
              ? <span className="text-[var(--warning)]">未选择文件</span>
              : `已选 ${scope.length} 项`}
          {filtering && visible.length > 0 ? ` · 命中 ${visible.length}` : ''}
        </span>
        <button
          type="button"
          onClick={runBatch}
          disabled={disabled}
          title={batchMode === 'visible'
            ? '把当前过滤命中的已加载节点全部加入作用域（清空搜索框可回到「全部取消」）'
            : batchMode === 'files' ? '改为按文件/目录选择（空选 = 不读取仓库文件）'
              : batchMode === 'top' ? '选中仓库最上层的每一项' : '清空本任务的作用域（不读取仓库文件）'}
          className="kb-micro-pop shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--text-muted)]"
        >
          {batchLabel}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
        {!rootId ? (
          <p className="px-2 py-4 text-center text-[12px] text-[var(--text-muted)]">尚未打开仓库</p>
        ) : (children[''] ?? []).length === 0 ? (
          <p className="px-2 py-4 text-center text-[12px] text-[var(--text-muted)]">仓库为空</p>
        ) : (
          tree
        )}
      </div>
    </div>
  )
}
