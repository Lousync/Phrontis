import { statSync } from 'fs'
import { kbModulePath, deleteFile, readJson, writeJson } from './jsonStore'
import { getCurrentVault } from './vaultContext'
import { getKnowledgeIndex, type KnowledgeIndex } from './knowledgeIndex'
import type { GraphEdge, GraphIndexData, GraphNode, UnresolvedRef } from '../../../src/lib/graphTypes'

/**
 * R4-G0 GraphIndex（数据层）：把知识索引长成链接索引。
 *
 * - 链接解析只做一份，供三方消费（见 docs/graph-view-design.md §3.3）：
 *   图谱渲染（nodes/edges）、知识库反链（incoming）、编辑器 [[..]] 补全（后续）
 * - 节点 = 仓库内全部 .md 页 + 标签（默认入图，可关）；边 = [[双链]] resolved 结果
 * - 目标两级匹配：frontmatter title → 文件名（不含 .md），与 design §3.1 对齐
 * - 未解析引用聚合为 unresolved 虚节点（不算实边）
 * - 落盘 .knowbase/cache/graph.json；失效策略与 knowledgeIndex 一致：写时失效、用时懒重建
 * - 类型单源：src/lib/graphTypes.ts（渲染层复用，勿在本文件重复定义）
 */

export type { GraphEdge, GraphIndexData, GraphNode, UnresolvedRef }

/** 链接目标归一化：剥 #章节、剥 .md、trim（display 别名已在出链提取阶段剥离） */
export function normalizeLinkName(raw: string): string {
  let s = (raw || '').trim()
  const hash = s.indexOf('#')
  if (hash >= 0) s = s.slice(0, hash)
  if (s.toLowerCase().endsWith('.md')) s = s.slice(0, -3)
  return s.trim()
}

/** 名称解析表（页面标题 / 文件名基名 → 页 id）；重复名视为歧义不解析 */
export interface LinkResolver {
  normalize(raw: string): string
  resolve(name: string): string | null
}

export function createLinkResolver(idx: KnowledgeIndex): LinkResolver {
  const normalize = normalizeLinkName
  const titleMap = new Map<string, string>()
  const baseMap = new Map<string, string>()
  const add = (map: Map<string, string>, key: string, id: string): void => {
    if (!key) return
    if (map.has(key)) map.set(key, '') // 撞名歧义：置空表示不可解析
    else map.set(key, id)
  }
  for (const p of idx.pages) {
    add(titleMap, p.title, p.id)
    const slash = Math.max(p.path.lastIndexOf('/'), 0)
    const base = p.path.slice(slash + 1).replace(/\.md$/i, '')
    add(baseMap, base, p.id)
  }
  const lookup = (name: string): string | null => {
    if (!name) return null
    return titleMap.get(name) || baseMap.get(name) || null
  }
  return {
    normalize,
    resolve(name: string): string | null {
      const v = normalize(name)
      return v ? lookup(v) || null : null
    },
  }
}

export function rebuildGraphIndex(): GraphIndexData {
  const current = getCurrentVault()
  if (!current) {
    return { schemaVersion: 1, builtAt: new Date().toISOString(), nodes: [], edges: [], unresolved: [], incoming: {} }
  }
  const idx = getKnowledgeIndex()
  const resolver = createLinkResolver(idx)

  // 有向引用（页→页 resolved），自环跳过
  // 非 md 归档文件（entryKind==='file'）无正文无出链，不进图谱（docs/vault-archive-all-files-design.md §6）
  const graphPages = idx.pages.filter((e) => e.entryKind !== 'file')
  const srcToDst = new Map<string, Set<string>>() // src -> resolved targets
  const tagPages = new Map<string, Set<string>>() // tagName -> pageIds
  const unresolvedMap = new Map<string, Set<string>>() // name -> source pageIds

  for (const entry of graphPages) {
    for (const out of entry.outgoingTitles) {
      const name = resolver.normalize(out)
      if (!name) continue
      const dst = resolver.resolve(out)
      if (!dst) {
        let s = unresolvedMap.get(name)
        if (!s) unresolvedMap.set(name, (s = new Set()))
        s.add(entry.id)
        continue
      }
      if (dst === entry.id) continue // 自环不入图
      let set = srcToDst.get(entry.id)
      if (!set) srcToDst.set(entry.id, (set = new Set()))
      set.add(dst)
    }
    for (const tag of entry.tags) {
      let s = tagPages.get(tag)
      if (!s) tagPages.set(tag, (s = new Set()))
      s.add(entry.id)
    }
  }

  // 无向邻接（页页 + 页标签）用于 degree 与去重边
  const adj = new Map<string, Set<string>>()
  const linkBoth = (a: string, b: string): void => {
    if (a === b) return
    for (const [x, y] of [[a, b], [b, a]] as const) {
      let s = adj.get(x)
      if (!s) adj.set(x, (s = new Set()))
      s.add(y)
    }
  }

  const edges: GraphEdge[] = []
  const edgeKeys = new Set<string>()
  const addEdge = (a: string, b: string): void => {
    const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push(a < b ? { s: a, t: b } : { s: b, t: a })
  }

  const nodes: GraphNode[] = []
  for (const entry of graphPages) {
    for (const dst of srcToDst.get(entry.id) ?? []) {
      linkBoth(entry.id, dst)
      addEdge(entry.id, dst)
    }
    for (const tagName of entry.tags) {
      const tagId = `tag:${tagName}`
      linkBoth(entry.id, tagId)
      addEdge(entry.id, tagId)
    }
    nodes.push({
      id: entry.id,
      title: entry.title,
      path: entry.path,
      kind: 'page',
      degree: adj.get(entry.id)?.size ?? 0,
    })
  }
  for (const [tagName, pages] of tagPages) {
    // ISS-2026-09-04-05：给 tag 节点注入 parentCtx（关联 page 中出现最多的父目录段），
    // 渲染层副线逻辑（GraphCanvas.tsx:274）据此复用同一段绘制代码
    const parentCounts = new Map<string, number>()
    for (const pid of pages) {
      const p = idx.byId[pid]?.path ?? ''
      // page path 形如 "408 学习空间/数据结构/绪论/kb-ds-1-1-1.md"，
      // 取倒数第二段作为「学科/章节」副线；缺时退到首段（最顶目录）
      const segs = p.replace(/\.md$/i, '').split('/').filter(Boolean)
      const parent = segs.length >= 2 ? segs[segs.length - 2] : (segs[0] || '')
      if (!parent) continue
      parentCounts.set(parent, (parentCounts.get(parent) ?? 0) + 1)
    }
    let parentCtx = ''
    let bestN = 0
    for (const [name, n] of parentCounts) {
      if (n > bestN) { parentCtx = name; bestN = n }
    }
    nodes.push({
      id: `tag:${tagName}`,
      title: tagName,
      path: '',
      kind: 'tag',
      degree: pages.size,
      parentCtx,
    })
  }

  const incoming: Record<string, string[]> = {}
  for (const [srcId, dsts] of srcToDst) {
    for (const dstId of dsts) {
      let list = incoming[dstId]
      if (!list) incoming[dstId] = list = []
      list.push(srcId)
    }
  }
  for (const key of Object.keys(incoming)) incoming[key].sort((a, b) => a.localeCompare(b))

  const unresolved: UnresolvedRef[] = []
  for (const [name, refs] of unresolvedMap) {
    unresolved.push({ name, refs: [...refs].sort((a, b) => a.localeCompare(b)) })
  }
  unresolved.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans'))

  nodes.sort((a, b) => (a.kind === b.kind ? a.title.localeCompare(b.title, 'zh-Hans') : a.kind === 'page' ? -1 : 1))
  return {
    schemaVersion: 1,
    builtAt: new Date().toISOString(),
    nodes,
    edges,
    unresolved,
    incoming,
  }
}

/**
 * graph.json 落后于 knowledge-index.json → 过期（兜底：任何漏 invalidateGraphIndex 的写路径，
 * 如 2026-09-03 前知识包导入只刷知识索引不刷图谱，导致图谱读到旧缓存为空）
 */
function graphCacheStale(): boolean {
  try {
    const g = kbModulePath('cache', 'graph.json')
    const k = kbModulePath('cache', 'knowledge-index.json')
    if (!g || !k) return false
    return statSync(k).mtimeMs > statSync(g).mtimeMs + 100
  } catch {
    return false
  }
}

/** 读取缓存；不存在 / schema 不匹配 / 落后于知识索引时自动重建并落盘（与 knowledgeIndex 同模式） */
export function getGraphIndex(forceRebuild = false): GraphIndexData {
  if (!forceRebuild && !graphCacheStale()) {
    const cached = readJson<GraphIndexData | null>('cache', 'graph.json', null)
    if (cached && cached.schemaVersion === 1 && Array.isArray(cached.nodes) && Array.isArray(cached.edges)) return cached
  }
  const fresh = rebuildGraphIndex()
  writeJson('cache', 'graph.json', fresh)
  return fresh
}

/** 仓库内容变化时调用：只删缓存，下次 getGraphIndex 懒重建 */
export function invalidateGraphIndex(): void {
  const current = getCurrentVault()
  if (!current) return
  deleteFile('cache', 'graph.json')
}
