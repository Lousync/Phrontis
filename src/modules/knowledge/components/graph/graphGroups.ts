/**
 * 图谱左栏「分区」的数据与裁剪（2026-09-21 用户需求：点进某个图谱群 = 画布只画该群，
 * 其他点不是变灰而是不出现；再点退出回全库）。
 *
 * 群的切法由真实数据决定（本仓库页页无边，按连通性切「群」不存在——1034 条边全为 页↔标签）：
 *  - 目录（一级 + 二级）：唯一覆盖全部页（含无标签页）的切法
 *  - 标签：页↔标签边反查成员页（与目录切法等价的重叠视图）
 *  - 待处理：无标签页（degree=0，画布里的孤点）+ 未解析 [[引用]]
 *
 * 标签节点 id 不依赖 `tag:` 前缀约定，按 kind+title 反查（数据契约只保证 kind/title）。
 */
import type { GraphEdge, GraphIndexData, GraphNode } from '../../../../lib/graphTypes'

export type GraphGroupKind = 'all' | 'dir' | 'tag' | 'orphan' | 'unresolved'

export interface GraphGroupInfo {
  key: string
  kind: GraphGroupKind
  /** 展示名（目录段名 / 标签名 / 固定文案） */
  name: string
  /** 成员页数（unresolved = 引用它的源页数） */
  n: number
  /** 目录二级行 */
  sub?: boolean
  /** 二级目录的父 key（dir:<一级段>） */
  parent?: string
}

function tagNodeId(data: GraphIndexData, name: string): string | null {
  const t = data.nodes.find((n) => n.kind === 'tag' && n.title === name)
  return t ? t.id : null
}

/**
 * 软件文件夹不进图谱（2026-09-21 用户指定）：AI教学 等软件自动生成的目录 + 点前缀
 * 系统目录（.knowbase/.books…）。在数据入口（GraphView 拉取后）整体剔除 —— 侧栏分组、
 * 计数、画布三处自动一致，无需各自排除。
 */
const EXCLUDED_TOP_DIRS = new Set(['AI教学'])

function isExcludedPage(n: GraphNode): boolean {
  if (n.kind !== 'page') return false
  const top = (n.path || '').split('/')[0]
  return top.startsWith('.') || EXCLUDED_TOP_DIRS.has(top)
}

export function excludeSoftwareFolders(data: GraphIndexData): GraphIndexData {
  const byId = new Map(data.nodes.map((n) => [n.id, n]))
  const keep = new Set(data.nodes.filter((n) => !isExcludedPage(n)).map((n) => n.id))
  const edges1 = data.edges.filter((e) => keep.has(e.s) && keep.has(e.t))
  // 局部 degree 重算（剔除后 tag 可能失去全部成员页 → 孤悬标签一并移除）
  const deg = new Map<string, number>()
  for (const e of edges1) {
    deg.set(e.s, (deg.get(e.s) ?? 0) + 1)
    deg.set(e.t, (deg.get(e.t) ?? 0) + 1)
  }
  const keep2 = new Set(
    [...keep].filter((id) => {
      const n = byId.get(id)
      return n && (n.kind !== 'tag' || (deg.get(id) ?? 0) > 0)
    }),
  )
  return {
    ...data,
    nodes: data.nodes
      .filter((n) => keep2.has(n.id))
      .map((n) => (n.kind === 'dangling' ? n : { ...n, degree: deg.get(n.id) ?? 0 })),
    edges: edges1.filter((e) => keep2.has(e.s) && keep2.has(e.t)),
  }
}

function edgesAmong(data: GraphIndexData, ids: Set<string>): GraphEdge[] {
  return data.edges.filter((e) => ids.has(e.s) && ids.has(e.t))
}

/** 群 → 成员页节点（unresolved 无成员页，返回 []；侧栏清单与画布裁剪共用同一判定） */
export function groupMemberPages(data: GraphIndexData, key: string): GraphNode[] {
  const pages = data.nodes.filter((n) => n.kind === 'page')
  if (key === 'all') return pages
  if (key === 'orphan') return pages.filter((n) => n.degree === 0)
  if (key.startsWith('dir:')) {
    const prefix = key.slice(4)
    // '(根)' 是合成目录：成员 = path 无 '/' 的根散文件（与 buildGraphGroups 的聚合口径一致）
    if (prefix === '(根)') return pages.filter((n) => !(n.path || '').includes('/'))
    return pages.filter((n) => n.path === prefix || n.path.startsWith(`${prefix}/`))
  }
  if (key.startsWith('tag:')) {
    const tagId = tagNodeId(data, key.slice(4))
    if (!tagId) return []
    const member = new Set<string>()
    for (const e of data.edges) {
      if (e.s === tagId) member.add(e.t)
      if (e.t === tagId) member.add(e.s)
    }
    return pages.filter((n) => member.has(n.id))
  }
  return []
}

/**
 * 群裁剪：进群后画布的数据 = 仅该群成员（页）+ 它们之间的边。
 * unresolved 群特殊：nodes 清空、unresolved 只留同名条目 —— 交由上层 filterAndSynth
 * 合成 dangling 虚节点（合成逻辑单源在 GraphView，这里不重复）。
 * 成员节点的 degree 保持全库口径（半径稳定，切换群不跳变）。
 */
export function applyGroupFilter(data: GraphIndexData, key: string): GraphIndexData {
  if (key === 'all' || !key) return data
  if (key.startsWith('unresolved:')) {
    const name = key.slice('unresolved:'.length)
    return { ...data, nodes: [], edges: [], unresolved: data.unresolved.filter((u) => u.name === name) }
  }
  const members = groupMemberPages(data, key)
  const ids = new Set(members.map((n) => n.id))
  return { ...data, nodes: members, edges: edgesAmong(data, ids), unresolved: [] }
}

export interface GraphGroups {
  pageTotal: number
  tagTotal: number
  /** 一级目录（按页数降序） */
  dirs: GraphGroupInfo[]
  /** parentKey → 二级目录（按页数降序；只在有子目录时存在） */
  subDirs: Map<string, GraphGroupInfo[]>
  /** 标签（按成员页数降序；只含有 ≥1 条页边的标签） */
  tags: GraphGroupInfo[]
  orphan: GraphGroupInfo
  unresolved: GraphGroupInfo[]
}

/** 知识包短码启发式：全小写连字符（kb-…）或全大写下划线（DATA_STRUCTURES）——与中文标签区分 */
export function isPackTag(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name) || /^[A-Z0-9_]+$/.test(name)
}

export function buildGraphGroups(data: GraphIndexData): GraphGroups {
  const pages = data.nodes.filter((n) => n.kind === 'page')
  const tagTotal = data.nodes.filter((n) => n.kind === 'tag').length

  // 目录两级聚合。根目录散文件（path 无 '/'，如 测试.md）归入单一 '(根)' 行 ——
  // 否则每个散文件都成了独立「目录」行，把左栏刷成文件清单
  const l1 = new Map<string, number>()
  const l2 = new Map<string, number>()
  for (const p of pages) {
    const segs = (p.path || '').split('/').filter(Boolean)
    const a = segs.length > 1 ? segs[0] : '(根)'
    l1.set(a, (l1.get(a) ?? 0) + 1)
    if (segs.length > 1) {
      const b = `${a}/${segs[1]}`
      l2.set(b, (l2.get(b) ?? 0) + 1)
    }
  }
  const dirs: GraphGroupInfo[] = []
  const subDirs = new Map<string, GraphGroupInfo[]>()
  for (const [name, n] of [...l1.entries()].sort((x, y) => y[1] - x[1])) {
    const key = `dir:${name}`
    dirs.push({ key, kind: 'dir', name, n })
    const kids = [...l2.entries()]
      .filter(([k]) => k.startsWith(`${name}/`))
      .sort((x, y) => y[1] - x[1])
      .map(([k, n2]) => ({ key: `dir:${k}`, kind: 'dir' as const, name: k.split('/').pop() ?? k, n: n2, sub: true, parent: key }))
    if (kids.length) subDirs.set(key, kids)
  }

  // 标签成员计数：页↔标签边反查（一次遍历，Map 反查避免 O(边×节点)）
  const byId = new Map(data.nodes.map((n) => [n.id, n]))
  const tagCount = new Map<string, number>()
  for (const e of data.edges) {
    const a = byId.get(e.s)
    const b = byId.get(e.t)
    if (!a || !b) continue
    const tag = a.kind === 'tag' ? a : b.kind === 'tag' ? b : null
    const page = a.kind === 'page' ? a : b.kind === 'page' ? b : null
    if (tag && page) tagCount.set(tag.title, (tagCount.get(tag.title) ?? 0) + 1)
  }
  const tags: GraphGroupInfo[] = [...tagCount.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([name, n]) => ({ key: `tag:${name}`, kind: 'tag', name, n }))

  const orphan: GraphGroupInfo = {
    key: 'orphan', kind: 'orphan', name: '无标签页',
    n: pages.filter((p) => p.degree === 0).length,
  }
  const unresolved: GraphGroupInfo[] = data.unresolved.map((u) => ({
    key: `unresolved:${u.name}`, kind: 'unresolved', name: u.name, n: u.refs.length,
  }))

  return { pageTotal: pages.length, tagTotal, dirs, subDirs, tags, orphan, unresolved }
}
