/**
 * 图谱视图（R4-G1→G3）：知识模块内的全幅画布视图容器。
 * - G1：拉数据 + 浮层 + 单击卡片确认打开（kb-open-note 跳编辑器）
 * - G2：A7 本地图谱（BFS1 子图）
 * - G3：设置面板（参数持久化到 .knowbase/config.json graphView 段）、过滤（标签/孤儿页）、
 *       未解析 [[引用]] 合成 dangling 虚节点渲染、着色/簇力/文字阈值开关
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, FileText, Folder as FolderIcon, Maximize2, Minus, Plus, RotateCcw, Settings, Share2, Tag, X, Network, BookOpen } from 'lucide-react'
import type { GraphIndexData, GraphNode, GraphViewConfig } from '../../../../lib/graphTypes'
import { getKnowledgeGraph, getKnowledgePageById, getGraphViewConfig, updateGraphViewConfig } from '../../../../lib/ipc'
import { GraphCanvas, type GraphCanvasHandle } from './GraphCanvas'
import { GraphSidebar } from './GraphSidebar'
import { applyGroupFilter, excludeSoftwareFolders } from './graphGroups'

interface GraphViewProps {
  onExit: () => void
  /** 卡片「在阅读器中打开」：知识库内沉浸阅读该页（id = 页面 id） */
  onOpenInReader?: (pageId: string) => void
  /**
   * 图谱目录 scope（R4 用户需求）：仓库内相对目录前缀（如 学习空间/C++教学），
   * 任意层级。非空 = 只展示该目录（含子目录）的页 + 与它们有边的跨目录关联节点/标签；
   * 空/缺省 = 全库。与 A8 增量 merge 兼容：scope 变化走 data 引用变化 → 局部动画。
   */
  scopePath?: string
  /** scope 生效时右上角显示目录名（缺省显示 path） */
  scopeName?: string
  /** 点「返回全库」清除 scope（不清则留在当前目录） */
  onClearScope?: () => void
  /**
   * 图谱态左栏 slot（2026-09-21 用户需求：图谱态左栏不再留空）：App 传入的左栏挂载点，
   * 分区导航（GraphSidebar）portal 进去。挂载点由 KnowledgeModule 转发。
   */
  sidebarEl?: HTMLElement | null
}

const DEFAULT_GVC: GraphViewConfig = {
  linkDistance: 130, chargeStrength: -320,
  // ISS-2026-09-04-05：图谱 tag 节点（408 知识包密集）单行英文短代码用户读不懂，
  // 默认 off → 用户主动开启（密度大但带副线/学科前缀）才显示
  showTags: false, showOrphans: true, colorBySpace: false, clusterForce: false, labelThreshold: 0.6,
}

/**
 * A7 本地图谱数据：以 centerId 为中心的 1 度邻居子图（仅页节点 + 页页边）。
 * 标签节点不进本地子图（Obsidian 观感：本地图谱只看笔记关系）。
 */
function buildLocalGraph(data: GraphIndexData, centerId: string): GraphIndexData {
  const pageIds = new Set(data.nodes.filter((n) => n.kind === 'page').map((n) => n.id))
  if (!pageIds.has(centerId)) return { ...data, nodes: [], edges: [], unresolved: [] }
  const adj = new Map<string, Set<string>>()
  for (const e of data.edges) {
    if (!pageIds.has(e.s) || !pageIds.has(e.t)) continue
    for (const [a, b] of [[e.s, e.t], [e.t, e.s]] as const) {
      let s = adj.get(a)
      if (!s) adj.set(a, (s = new Set()))
      s.add(b)
    }
  }
  const keep = new Set<string>([centerId])
  for (const nb of adj.get(centerId) ?? []) keep.add(nb)
  return {
    ...data,
    nodes: data.nodes.filter((n) => keep.has(n.id)),
    edges: data.edges.filter((e) => keep.has(e.s) && keep.has(e.t) && pageIds.has(e.s) && pageIds.has(e.t)),
    unresolved: [],
  }
}

/**
 * 目录 scope 裁剪：展示「某目录的图谱」。
 *  - 范围内页：path === 前缀 或 path.startsWith(前缀 + '/')（任意层级含子目录）
 *  - 跨目录关联：与范围内页有边（无向，双向）的外部页 / 标签 / dangling 也保留——外部连接可见
 *  - 其余节点剔除；degree 重算为「范围内度」（孤立判定按局部，过滤不误伤）
 */
function applyScope(data: GraphIndexData, scopePath: string): GraphIndexData {
  const prefix = scopePath.replace(/\/+$/, '')
  const inScope = (p: string): boolean => p === prefix || p.startsWith(`${prefix}/`)
  const inScopePageIds = new Set(
    data.nodes.filter((n) => n.kind === 'page' && n.path && inScope(n.path)).map((n) => n.id),
  )
  if (inScopePageIds.size === 0) return { ...data, nodes: [], edges: [], unresolved: [] }

  // 邻接扩展：范围内页 + 与它们直接相连的节点（1 度外联即可见）
  const keep = new Set<string>(inScopePageIds)
  for (const e of data.edges) {
    if (inScopePageIds.has(e.s)) keep.add(e.t)
    if (inScopePageIds.has(e.t)) keep.add(e.s)
  }
  const nodes = data.nodes.filter((n) => keep.has(n.id))
  const keptIds = new Set(nodes.map((n) => n.id))
  const edges = data.edges.filter((e) => keptIds.has(e.s) && keptIds.has(e.t))

  // 局部 degree 重算（边两端都保留才算度）
  const degree = new Map<string, number>()
  for (const e of edges) {
    degree.set(e.s, (degree.get(e.s) ?? 0) + 1)
    degree.set(e.t, (degree.get(e.t) ?? 0) + 1)
  }
  return {
    ...data,
    nodes: nodes.map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 })),
    edges,
    unresolved: [], // scope 模式下不合成全局虚节点（避免噪声；unresolved 引用在页节点出链里可见）
  }
}

/** G3 过滤 + 未解析引用合成虚节点：按设置裁剪节点/边，并把 unresolved 合成 dangling 节点入图 */function filterAndSynth(data: GraphIndexData, cfg: GraphViewConfig): GraphIndexData {
  let nodes = data.nodes
  if (!cfg.showTags) nodes = nodes.filter((n) => n.kind !== 'tag')
  if (!cfg.showOrphans) nodes = nodes.filter((n) => !(n.kind === 'page' && n.degree === 0))
  const keep = new Set(nodes.map((n) => n.id))
  const edges = data.edges.filter((e) => keep.has(e.s) && keep.has(e.t))
  if (data.unresolved.length > 0) {
    nodes = nodes.concat(data.unresolved.map((u) => ({
      id: `dangling:${u.name}`,
      title: u.name,
      path: '',
      kind: 'dangling' as const,
      degree: u.refs.length,
    })))
  }
  return { ...data, nodes, edges }
}

export function GraphView({ onExit, scopePath, scopeName, onClearScope, onOpenInReader, sidebarEl = null }: GraphViewProps) {
  const [data, setData] = useState<GraphIndexData | null>(null)
  const [error, setError] = useState('')
  const [cfg, setCfg] = useState<GraphViewConfig>(DEFAULT_GVC)
  const [sel, setSel] = useState<Pick<GraphNode, 'id' | 'title' | 'path' | 'kind' | 'degree'> | null>(null)
  // 选中页面节点时异步取正文首段，hover/卡片上让用户识别「这页讲什么」
  const [pageExcerpt, setPageExcerpt] = useState<string>('')
  const excerptOf = (md: string): string => {
    const body = md.replace(/^---[\s\S]*?---\s*/m, '').trim()
    const stripped = body
      .replace(/```[\s\S]*?```/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#+\s*/gm,'').replace(/[*_~`>|]/g,' ').replace(/\n+/g,' ').trim()
    return stripped.slice(0, 90)
  }
  /** A7 本地图谱：中心页 id；null=全图 */
  const [centerId, setCenterId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  /**
   * 左栏分区（2026-09-21）：进群 = 画布只画该群（applyGroupFilter 数据级裁剪，非变灰）。
   * null = 全库；'all' 与 null 等价（保留 'all' key 是给侧栏「全库」行做高亮判断用）。
   */
  const [activeGroup, setActiveGroup] = useState<string | null>(null)
  const canvasRef = useRef<GraphCanvasHandle | null>(null)
  const exitRef = useRef(onExit)
  exitRef.current = onExit

  // A8：数据刷新——进入时拉一次 + 仓库文件变化（编辑器保存/删除/重命名/导入）后重拉。
  // GraphCanvas 对 data 做 diff 增量 merge，重复拉取相同数据不会整图重建。
  useEffect(() => {
    let alive = true
    const load = (): void => {
      getKnowledgeGraph()
        .then((g) => { if (alive) setData(excludeSoftwareFolders(g)) })
        .catch((e) => { if (alive) setError(String(e?.message ?? e)) })
    }
    load()
    getGraphViewConfig()
      .then((c) => { if (alive) setCfg(c) })
      .catch(() => { /* 保留默认 */ })
    const onRefresh = (): void => { load() }
    window.addEventListener('data-imported', onRefresh)
    window.addEventListener('kb-graph-refresh', onRefresh)
    return () => {
      alive = false
      window.removeEventListener('data-imported', onRefresh)
      window.removeEventListener('kb-graph-refresh', onRefresh)
    }
  }, [])

  /** 本地改设置 + 异步持久化（fire & forget；以返回的合并配置刷新本地） */
  const applyCfg = useCallback((patch: Partial<GraphViewConfig>) => {
    setCfg((prev) => {
      const next = { ...prev, ...patch }
      void updateGraphViewConfig(next).then((merged) => setCfg(merged)).catch(() => { /* 写失败保留本地 */ })
      return next
    })
  }, [])

  // 左栏分区（先裁剪）→ 目录 scope → 过滤（标签/孤儿）+ unresolved 虚节点 → 本地图谱（可选）
  const groupFiltered = useMemo(
    () => (data && activeGroup && activeGroup !== 'all' ? applyGroupFilter(data, activeGroup) : data),
    [data, activeGroup],
  )
  const scoped = useMemo(
    // 侧栏分区激活时覆盖目录 scope（叠加裁剪会把 unresolved 群清空，语义也混乱）：
    // 用户在左栏明确点了群 = 显式意图优先
    () => (groupFiltered && scopePath && !activeGroup ? applyScope(groupFiltered, scopePath) : groupFiltered),
    [groupFiltered, scopePath, activeGroup],
  )
  // 孤立群特例：用户设置关掉「显示孤立页」时，进孤立群必须强制含孤点（否则群内永远空）
  const cfgEff = activeGroup === 'orphan' && !cfg.showOrphans ? { ...cfg, showOrphans: true } : cfg
  const display = useMemo(
    () => (scoped ? filterAndSynth(scoped, cfgEff) : null),
    [scoped, cfgEff],
  )
  const displayData = useMemo(
    () => (display && centerId ? buildLocalGraph(display, centerId) : display),
    [display, centerId],
  )
  const simOpts = useMemo(
    () => ({
      linkDistance: cfg.linkDistance,
      chargeStrength: cfg.chargeStrength,
      clusterForce: cfg.clusterForce,
    }),
    [cfg.linkDistance, cfg.chargeStrength, cfg.clusterForce],
  )

  // Esc：有选中卡片先关卡片，否则退出图谱
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (sel) setSel(null)
      else if (showSettings) setShowSettings(false)
      else exitRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [sel, showSettings])

  // A7 本地图谱：centerId 变化（进入/返回全图）→ data 增量 merge 完成后 fit 新子图；
  // 普通文件增删（data 刷新但 centerId 不变）不做视角适配（A8 局部更新不打扰阅读位置）
  useEffect(() => {
    if (centerId === null) return
    const id = requestAnimationFrame(() => canvasRef.current?.fit())
    return () => cancelAnimationFrame(id)
  }, [centerId])

  // 左栏分区（2026-09-21）：进群/退群 → 适屏（同本地图谱口径；增量 merge 已保留成员坐标）
  useEffect(() => {
    const id = requestAnimationFrame(() => canvasRef.current?.fit())
    return () => cancelAnimationFrame(id)
  }, [activeGroup])

  const openInEditor = useCallback(() => {
    if (!sel || sel.kind !== 'page') return
    window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: sel.path, from: 'knowledge' } })) // 条目6：带来源
  }, [sel])

  const openInReader = useCallback(() => {
    if (!sel || sel.kind !== 'page') return
    onOpenInReader?.(sel.id)
  }, [sel, onOpenInReader])

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)] h-full relative">
        <p className="text-sm">图谱加载失败：{error}</p>
      </div>
    )
  }
  if (!displayData || !display) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)] h-full relative">
        <Share2 size={40} className="mb-4 opacity-25" />
        <p className="text-sm">图谱构建中…</p>
      </div>
    )
  }
  if (displayData.nodes.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)] h-full relative">
        <Share2 size={40} className="mb-4 opacity-25" />
        <p className="text-sm">暂无页面可展示（需要仓库内存在带 frontmatter 的知识页）</p>
      </div>
    )
  }

  const pageCount = displayData.nodes.filter((n) => n.kind === 'page').length
  const tagCount = displayData.nodes.filter((n) => n.kind === 'tag').length
  const danglingCount = displayData.nodes.filter((n) => n.kind === 'dangling').length
  const links = displayData.edges.length
  const centerNode = centerId ? display.nodes.find((n) => n.id === centerId) : null
  const pageIdsSet = new Set(displayData.nodes.filter((n) => n.kind === 'page').map((n) => n.id))
  const pageNbr = new Map<string, number>()
  for (const e of displayData.edges) {
    if (!pageIdsSet.has(e.s) || !pageIdsSet.has(e.t)) continue
    pageNbr.set(e.s, (pageNbr.get(e.s) ?? 0) + 1)
    pageNbr.set(e.t, (pageNbr.get(e.t) ?? 0) + 1)
  }

  const kindLabel = (k: string): string => (k === 'tag' ? '标签' : k === 'dangling' ? '未解析引用' : '页面')

  return (
    <div className="kb-view-fade flex-1 flex flex-col overflow-hidden h-full relative bg-[var(--bg-primary)]">
      {/* 图谱态左栏：分区导航 portal 进 App 左栏 slot（挂载点由 KnowledgeModule 转发） */}
      {sidebarEl && data && createPortal(
        <GraphSidebar
          data={data}
          activeKey={activeGroup}
          onSelect={setActiveGroup}
          onOpenPage={(n) => window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: n.path, from: 'knowledge' } }))} // 条目6：带来源
        />,
        sidebarEl,
      )}

      <GraphCanvas
        ref={canvasRef}
        data={displayData}
        simOpts={simOpts}
        colorBySpaceEnabled={cfg.colorBySpace}
        labelThreshold={cfg.labelThreshold}
        selectedId={sel?.id ?? null}
        onSelect={async (n) => {
          if (!n) { setSel(null); setPageExcerpt(''); return }
          setSel(n)
          if (n.kind === 'page') {
            setPageExcerpt('')
            try {
              const p = await getKnowledgePageById(n.id)
              if (p && p.contentMd) setPageExcerpt(excerptOf(p.contentMd))
            } catch { /* 静默 */ }
          } else {
            setPageExcerpt('')
          }
        }}
      />

      {/* 左上：模式 + 统计 */}
      <div className="absolute top-3 left-3 flex items-center gap-2 pointer-events-none select-none">
        <span className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--bg-secondary)]/80 text-[11px] text-[var(--text-secondary)] border border-[var(--border-color)]">
          <Share2 size={12} />
          图谱
        </span>
        {scopePath && (
          <span className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--bg-secondary)]/80 text-[11px] text-[var(--accent)] border border-[var(--border-color)] max-w-[180px]">
            <FolderIcon size={11} className="shrink-0" />
            <span className="truncate">{scopeName || scopePath}</span>
            {onClearScope && (
              <button
                onClick={onClearScope}
                title="返回全库图谱"
                className="pointer-events-auto shrink-0 ml-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                <X size={11} />
              </button>
            )}
          </span>
        )}
        {centerId ? (
          <button
            onClick={() => { setCenterId(null); setSel(null) }}
            title="返回全图"
            className="pointer-events-auto flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--bg-secondary)]/80 border border-[var(--border-color)] text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <Network size={12} />
            <span className="text-[10.5px]">本地图谱 · {centerNode?.title ?? ''}（点此回全图）</span>
          </button>
        ) : (
          <span className="px-2 py-1 rounded-md bg-[var(--bg-secondary)]/60 text-[10.5px] text-[var(--text-muted)]">
            {pageCount} 页面 · {tagCount} 标签{danglingCount ? ` · ${danglingCount} 未解析` : ''} · {links} 关联
          </span>
        )}
      </div>

      {/* 右上：设置 + 退出 */}
      <div className="absolute top-3 right-3 flex items-center gap-1.5">
        <button
          onClick={() => setShowSettings((v) => !v)}
          title="图谱设置"
          className={`flex items-center gap-1 px-2 py-1 rounded-md border transition-colors ${showSettings ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] border-[var(--accent)]' : 'bg-[var(--bg-secondary)]/80 border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'}`}
        >
          <Settings size={14} />
          <span className="text-[11px]">设置</span>
        </button>
        <button
          onClick={onExit}
          title="退出图谱 (Esc)"
          className="flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--bg-secondary)]/80 border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
        >
          <X size={14} />
          <span className="text-[11px]">返回</span>
        </button>
      </div>

      {/* 右下：缩放/适应 */}
      <div className="absolute bottom-3 right-3 flex items-center gap-1 select-none">
        <button onClick={() => canvasRef.current?.zoomOut()} title="缩小"
          className="w-7 h-7 flex items-center justify-center rounded-md bg-[var(--bg-secondary)]/80 border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
          <Minus size={14} />
        </button>
        <button onClick={() => canvasRef.current?.fit()} title="适应全图"
          className="w-7 h-7 flex items-center justify-center rounded-md bg-[var(--bg-secondary)]/80 border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
          <Maximize2 size={13} />
        </button>
        <button onClick={() => canvasRef.current?.zoomIn()} title="放大"
          className="w-7 h-7 flex items-center justify-center rounded-md bg-[var(--bg-secondary)]/80 border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
          <Plus size={14} />
        </button>
      </div>

      {/* 设置面板（参数即调即生效并持久化到仓库 .knowbase/config.json） */}
      {showSettings && (
        <div className="absolute top-11 right-3 w-72 rounded-lg bg-[var(--bg-secondary)]/98 border border-[var(--border-color)] shadow-xl p-3 flex flex-col gap-2.5 text-[12px]">
          <div className="flex items-center justify-between">
            <span className="font-medium text-[var(--text-secondary)]">图谱设置</span>
            <button
              onClick={() => { applyCfg(DEFAULT_GVC); setShowSettings(false) }}
              className="flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              <RotateCcw size={12} />
              重置默认
            </button>
          </div>

          {([
            ['showTags', '显示标签节点'],
            ['showOrphans', '显示孤立页'],
            ['colorBySpace', '按一级目录着色'],
            ['clusterForce', '主题自动成团（簇力）'],
          ] as [keyof GraphViewConfig, string][]).map(([key, label]) => (
            <label key={key} className="flex items-center justify-between cursor-pointer select-none">
              <span className="text-[var(--text-secondary)]">{label}</span>
              <input
                type="checkbox"
                checked={Boolean(cfg[key])}
                onChange={(e) => applyCfg({ [key]: e.target.checked } as Partial<GraphViewConfig>)}
                className="accent-[var(--accent)] w-3.5 h-3.5"
              />
            </label>
          ))}

          <div className="flex flex-col gap-1">
            <div className="flex justify-between">
              <span className="text-[var(--text-secondary)]">连线长度</span>
              <span className="text-[var(--text-muted)] text-[11px]">{cfg.linkDistance}</span>
            </div>
            <input type="range" min={80} max={220} step={5} value={cfg.linkDistance}
              onChange={(e) => applyCfg({ linkDistance: Number(e.target.value) })}
              className="w-full accent-[var(--accent)]" />
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex justify-between">
              <span className="text-[var(--text-secondary)]">节点斥力</span>
              <span className="text-[var(--text-muted)] text-[11px]">{Math.abs(cfg.chargeStrength)}</span>
            </div>
            <input type="range" min={100} max={800} step={20} value={Math.abs(cfg.chargeStrength)}
              onChange={(e) => applyCfg({ chargeStrength: -Number(e.target.value) })}
              className="w-full accent-[var(--accent)]" />
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex justify-between">
              <span className="text-[var(--text-secondary)]">页面标签显示缩放</span>
              <span className="text-[var(--text-muted)] text-[11px]">{cfg.labelThreshold.toFixed(2)}</span>
            </div>
            <input type="range" min={0.2} max={1} step={0.05} value={cfg.labelThreshold}
              onChange={(e) => applyCfg({ labelThreshold: Number(e.target.value) })}
              className="w-full accent-[var(--accent)]" />
          </div>
          <p className="text-[10.5px] text-[var(--text-muted)] leading-snug">
            设置随仓库保存（.knowbase/config.json），换机器也跟随你的仓库。
          </p>
        </div>
      )}

      {/* 选中卡片：单击节点后出现（聚焦 + 确认打开，防误触） */}
      {sel && (
        <div className="absolute top-12 right-3 w-60 rounded-lg bg-[var(--bg-secondary)]/95 border border-[var(--border-color)] shadow-xl p-3 flex flex-col gap-2">
          <div className="flex items-start gap-2">
            {sel.kind === 'tag' ? <Tag size={14} className="mt-0.5 shrink-0 text-[var(--text-muted)]" /> : <FileText size={14} className="mt-0.5 shrink-0 text-[var(--accent)]" />}
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-[var(--text-primary)] truncate flex items-center gap-1.5">
                {sel.title}
              </div>
              <div className="text-[10.5px] text-[var(--text-muted)] mt-0.5 truncate">
                {kindLabel(sel.kind)}{sel.kind === 'page' && sel.path ? ` · ${sel.path}` : ''}
              </div>
            </div>
            <button onClick={() => setSel(null)} className="shrink-0 text-[var(--text-disabled)] hover:text-[var(--text-primary)] transition-colors">
              <X size={13} />
            </button>
          </div>
          <div className="text-[10.5px] text-[var(--text-muted)]">
            关联 {sel.degree} 个节点
          {pageExcerpt && (
            <div className="text-[11.5px] text-[var(--text-secondary)] leading-snug border-t border-[var(--border-color)] pt-1.5 line-clamp-3" title={pageExcerpt}>
              {pageExcerpt}{pageExcerpt.length >= 90 ? '…' : ''}
            </div>
          )}
          </div>
          {sel.kind === 'page' ? (
            <>
              <button
                onClick={openInReader}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded bg-[var(--accent)] text-white text-[12px] hover:opacity-90 transition-opacity"
              >
                <BookOpen size={12} />
                在阅读器中打开
              </button>
              <button
                onClick={openInEditor}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] text-[12px] transition-colors"
              >
                <ExternalLink size={12} />
                在编辑器中打开
              </button>
              {(pageNbr.get(sel.id) ?? 0) > 0 && (
                <button
                  onClick={() => setCenterId(sel.id)}
                  className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] text-[12px] transition-colors"
                >
                  <Network size={12} />
                  {centerId === sel.id ? '查看本地图谱' : '查看它周围的页面'}
                </button>
              )}
            </>
          ) : (
            <div className="text-[11px] text-[var(--text-muted)] text-center py-0.5">
              {sel.kind === 'dangling' ? '未解析引用 · 创建同名页面后自动连上' : '标签节点 · 点击其它位置继续浏览'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
