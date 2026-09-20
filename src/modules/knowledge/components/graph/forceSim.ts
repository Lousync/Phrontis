/**
 * 图谱物理（R4-G1/G3/G3+）：d3-force 力导向，纯逻辑可读。
 * - G3：simOpts（linkDistance/chargeStrength/clusterForce）、社区簇检测（label propagation）
 *       与簇引力、dangling 虚节点（未解析引用，前端合成）。
 * - A8（增删动画）：mergeSimulation —— data 变化时保留旧节点坐标局部重排，
 *       新增节点出生、删除节点转 ghost（渲染层收缩淡出），不整图重排。
 * 只 import d3-force 子库（按需 tree-shake，~30KB 预算）。
 */
import {
  forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY,
  type Force, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum,
} from 'd3-force'
import type { GraphIndexData } from '../../../../lib/graphTypes'
import type { GraphNode } from '../../../../lib/graphTypes'

export type SimKind = GraphNode['kind']

export interface SimNode extends SimulationNodeDatum {
  id: string
  title: string
  path: string
  kind: SimKind
  degree: number
  r: number
  /** 社区簇 id（仅页节点；label propagation 结果） */
  cluster?: number
}

/** 初始化后 source/target 会被 d3-force 原地替换为 SimNode 对象引用 */
export interface SimEdge extends SimulationLinkDatum<SimNode> {
  tag: boolean
}

export interface SimWorld {
  sim: Simulation<SimNode, SimEdge>
  nodes: SimNode[]
  edges: SimEdge[]
  /** 邻居表（无向，页-页 + 页-标签）；hover 高亮与本地图谱复用 */
  nbr: Map<string, Set<string>>
}

export interface SimOptions {
  linkDistance?: number
  chargeStrength?: number
  /** 社区簇引力（同簇节点向簇重心收敛，主题各自成团） */
  clusterForce?: boolean
}

/** 半径：页 4 + min(10, 3.2·√deg) 封顶 14；标签 6；dangling 虚节点 7 */
export function nodeRadius(kind: SimKind, degree: number): number {
  if (kind === 'tag') return 6
  if (kind === 'dangling') return 7
  return 4 + Math.min(10, 3.2 * Math.sqrt(degree))
}

/**
 * 社区检测：标签传播（label propagation，页页边；~20 行无依赖，216 页即时）。
 * 返回页 id → 簇 id。无页页边的页不进任何簇。
 */
export function detectCommunities(data: GraphIndexData): Map<string, number> {
  const pageIds = new Set(data.nodes.filter((n) => n.kind === 'page').map((n) => n.id))
  const adj = new Map<string, Set<string>>()
  for (const e of data.edges) {
    if (!pageIds.has(e.s) || !pageIds.has(e.t)) continue
    for (const [a, b] of [[e.s, e.t], [e.t, e.s]] as const) {
      let s = adj.get(a)
      if (!s) adj.set(a, (s = new Set()))
      s.add(b)
    }
  }
  const ids = [...adj.keys()]
  const label = new Map<string, number>()
  ids.forEach((id, i) => label.set(id, i))
  for (let iter = 0; iter < 12; iter++) {
    let changed = false
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i]
      const counts = new Map<number, number>()
      let best: number | null = null
      let bestCount = -1
      for (const nb of adj.get(id)!) {
        const l = label.get(nb)!
        const c = (counts.get(l) ?? 0) + 1
        counts.set(l, c)
        if (c > bestCount) { bestCount = c; best = l }
      }
      if (best !== null && best !== label.get(id)) {
        label.set(id, best)
        changed = true
      }
    }
    if (!changed) break
  }
  return label
}

/** 自定义簇引力：每帧把节点向同簇重心轻微收敛（异簇天然被各自重心拉开） */
export function clusterAttraction(clusterOf: (n: SimNode) => number | undefined): Force<SimNode, SimEdge> {
  let nodes: SimNode[] = []
  const force = ((alpha: number): void => {
    if (nodes.length === 0) return
    const acc = new Map<number, { x: number; y: number; n: number }>()
    for (const n of nodes) {
      const k = clusterOf(n)
      if (k === undefined) continue
      let a = acc.get(k)
      if (!a) acc.set(k, (a = { x: 0, y: 0, n: 0 }))
      a.x += n.x ?? 0
      a.y += n.y ?? 0
      a.n++
    }
    for (const n of nodes) {
      const k = clusterOf(n)
      if (k === undefined || n.x === undefined || n.y === undefined) continue
      const a = acc.get(k)
      if (!a || a.n < 2) continue
      const cx = a.x / a.n
      const cy = a.y / a.n
      n.vx = (n.vx ?? 0) + (cx - n.x) * alpha * 0.1
      n.vy = (n.vy ?? 0) + (cy - n.y) * alpha * 0.1
    }
  }) as Force<SimNode, SimEdge>
  force.initialize = (ns: SimNode[]): void => {
    nodes = ns
  }
  return force
}

/**
 * 由 GraphIndex 数据建 sim。初始坐标中心带随机散布（alpha 自然衰减即"从中心长开"）。
 */
export function buildSimulation(
  data: GraphIndexData,
  opts: SimOptions = {},
): SimWorld {
  const clusterMap = (opts.clusterForce ?? false) ? detectCommunities(data) : null
  const nodes: SimNode[] = data.nodes.map((n) => ({
    ...n,
    r: nodeRadius(n.kind, n.degree),
    x: (Math.random() - 0.5) * 900,
    y: (Math.random() - 0.5) * 600,
    cluster: clusterMap ? clusterMap.get(n.id) : undefined,
  }))
  return buildWorld(nodes, data, opts, clusterMap, 0.85)
}

/** 消失节点快照（A8：渲染层收缩淡出用，不进新 sim） */
export interface MergeGhost {
  id: string
  title: string
  path: string
  kind: SimKind
  degree: number
  /** 最后坐标（sim 停止后的位置） */
  x: number
  y: number
  r: number
}

export interface MergeResult {
  world: SimWorld
  /** 新增节点 id（渲染层做 r 0→目标 生长动画） */
  addedIds: string[]
  /** 消失节点快照（渲染层收缩后移除） */
  ghosts: MergeGhost[]
  /** 新增边（无向 key `a|b`，渲染层做淡入） */
  addedEdgeKeys: string[]
  /** 是否存在结构性变化（节点/边集合有增删）；false 时调用方跳过动画 */
  changed: boolean
}

/**
 * A8 增量 merge：data 变化（新建/删除/导入/过滤）时保留旧节点坐标局部重排，
 * 而不是整图重新散布。新增节点出生在旧图几何中心附近，删除节点输出 ghost 快照。
 */
export function mergeSimulation(
  prev: SimWorld,
  nextData: GraphIndexData,
  opts: SimOptions = {},
): MergeResult {
  const prevById = new Map(prev.nodes.map((n) => [n.id, n]))
  const nextIds = new Set(nextData.nodes.map((n) => n.id))
  // prev.edges 经 forceLink 初始化后 source/target 已是节点对象；归一化为 id 对（无向排序）
  const normId = (x: SimNode | string | number): string => (typeof x === 'object' ? (x as SimNode).id : String(x))
  const undirectedKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const prevEdgeKeys = new Set(prev.edges.map((e) => undirectedKey(normId(e.source), normId(e.target))))

  // 消失节点快照（保留最后坐标）
  const ghosts: MergeGhost[] = []
  for (const n of prev.nodes) {
    if (nextIds.has(n.id)) continue
    ghosts.push({
      id: n.id, title: n.title, path: n.path, kind: n.kind, degree: n.degree,
      x: n.x ?? 0, y: n.y ?? 0, r: n.r,
    })
  }

  // 旧图几何中心（仅统计仍保留的节点），作为新增节点出生区
  let cx = 0, cy = 0, cnt = 0
  for (const n of prev.nodes) {
    if (n.x === undefined || n.y === undefined || !nextIds.has(n.id)) continue
    cx += n.x; cy += n.y; cnt++
  }
  if (cnt > 0) { cx /= cnt; cy /= cnt }

  const clusterMap = (opts.clusterForce ?? false) ? detectCommunities(nextData) : null
  const addedIds: string[] = []
  const nodes: SimNode[] = nextData.nodes.map((n) => {
    const old = prevById.get(n.id)
    if (old) {
      return {
        ...n,
        r: nodeRadius(n.kind, n.degree),
        x: old.x ?? cx, y: old.y ?? cy,
        vx: old.vx ?? 0, vy: old.vy ?? 0,
        fx: old.fx ?? null, fy: old.fy ?? null,
        cluster: clusterMap ? clusterMap.get(n.id) : undefined,
      }
    }
    addedIds.push(n.id)
    return {
      ...n,
      r: nodeRadius(n.kind, n.degree),
      x: cx + (Math.random() - 0.5) * 160,
      y: cy + (Math.random() - 0.5) * 100,
      cluster: clusterMap ? clusterMap.get(n.id) : undefined,
    }
  })

  const world = buildWorld(nodes, nextData, opts, clusterMap, 0.4)
  const addedEdgeKeys = world.edges
    .filter((e) => !prevEdgeKeys.has(undirectedKey(normId(e.source), normId(e.target))))
    .map((e) => undirectedKey(normId(e.source), normId(e.target)))
  // 节点属性变化（重命名/反链增减改 degree/标签改颜色路径）也算结构性变化 → 增量刷新
  let attrChanged = false
  if (!attrChanged) {
    for (const n of nodes) {
      const old = prevById.get(n.id)
      if (!old) continue
      if (n.title !== old.title || n.kind !== old.kind || n.path !== old.path || n.degree !== old.degree) {
        attrChanged = true
        break
      }
    }
  }
  const changed =
    ghosts.length > 0 || addedIds.length > 0 || addedEdgeKeys.length > 0 || attrChanged ||
    world.edges.length !== prev.edges.length
  return { world, addedIds, ghosts, addedEdgeKeys, changed }
}

/**
 * 公共 world 构造：由已定位的节点 + 数据建 edges/nbr/sim。
 * alpha：首载 0.85（中心带散开）；增量 merge 0.4（局部微调，避免整图晃动）。
 */
function buildWorld(
  nodes: SimNode[],
  data: GraphIndexData,
  opts: SimOptions,
  clusterMap: Map<string, number> | null,
  alpha: number,
): SimWorld {
  const linkDistance = opts.linkDistance ?? 130
  const chargeStrength = opts.chargeStrength ?? -320
  const clusterForce = opts.clusterForce ?? false
  const kindById = new Map(data.nodes.map((n) => [n.id, n.kind]))
  const rawEdges: SimEdge[] = data.edges.map((e) => {
    const sKind = kindById.get(e.s) ?? 'page'
    const tKind = kindById.get(e.t) ?? 'page'
    return { source: e.s, target: e.t, tag: sKind === 'tag' || tKind === 'tag' }
  })

  const nbr = new Map<string, Set<string>>()
  const linkBoth = (a: string, b: string): void => {
    for (const id of [a, b]) if (!nbr.has(id)) nbr.set(id, new Set())
    nbr.get(a)!.add(b)
    nbr.get(b)!.add(a)
  }
  for (const e of data.edges) linkBoth(e.s, e.t)

  const sim = forceSimulation<SimNode, SimEdge>(nodes)
    .force('link', forceLink<SimNode, SimEdge>(rawEdges)
      .id((d) => d.id)
      .distance((l) => (l.tag ? 95 : linkDistance)))
    .force('charge', forceManyBody<SimNode>().strength((d) => (d.kind === 'tag' ? -90 : chargeStrength)))
    .force('collide', forceCollide<SimNode>().radius((d) => d.r + 6))
    .force('cx', forceX<SimNode>(0).strength(0.05))
    .force('cy', forceY<SimNode>(0).strength(0.05))
    .velocityDecay(0.3)
    .alpha(alpha)
    .alphaMin(0.03)

  if (clusterForce && clusterMap) {
    sim.force('cluster', clusterAttraction((n) => n.cluster))
  }

  return { sim, nodes, edges: rawEdges, nbr }
}
