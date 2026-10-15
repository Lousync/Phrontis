/**
 * `[[` 双链候选数据层 —— 两档共用（源码档 Monaco 补全 / 即时渲染档 CM6 补全）。
 *
 * 从 `src/components/shared/MonacoPane.tsx` 的 `installWikiCompletion` 里把「取候选」这段
 * **纯逻辑**抽出来（缓存 / 匹配 / 排序 / 截断），Monaco 侧改为调用本模块 —— 行为逐条等价，
 * 只是不再内嵌在某个引擎的 provider 里。抽取的目的只有一个：同一套候选规则不能有两份实现。
 */

import { getKnowledgePages } from './ipc'
import type { KnowledgePage } from '../types/index'

/** 候选缓存时长（30s：够挡住连打十几个 `[[` 的重复 IPC，又不至于让新建页迟迟不出现） */
export const WIKI_CACHE_TTL = 30_000
/** 单次最多给几条候选 */
export const WIKI_MAX_ITEMS = 10

let pageCache: { at: number; pages: KnowledgePage[] } | null = null

/** 失效缓存（换文档 / 换仓库 / 新建页后调用） */
export function invalidateWikiCache(): void {
  pageCache = null
}

/** 带缓存取仓库全部知识页 */
export async function getWikiPages(): Promise<KnowledgePage[]> {
  const now = Date.now()
  if (pageCache && now - pageCache.at < WIKI_CACHE_TTL) return pageCache.pages
  try {
    const pages = await getKnowledgePages()
    pageCache = { at: now, pages }
    return pages
  } catch {
    return pageCache?.pages ?? []
  }
}

export interface WikiCandidate {
  title: string
  path: string
  updatedAt: string
}

/**
 * 候选计算（纯函数）：查询串为空 → 最近更新；否则标题子串匹配（大小写不敏感）。
 * 一律按 `updatedAt` 倒序，保证候选顺序稳定可预期（不依赖索引内部顺序）。
 */
export function suggestWikiTargets(query: string, pages: KnowledgePage[], limit: number = WIKI_MAX_ITEMS): WikiCandidate[] {
  const lower = query.trim().toLowerCase()
  return pages
    .filter((p) => !lower || p.title.toLowerCase().includes(lower))
    .slice()
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, limit)
    .map((p) => ({ title: p.title, path: p.path ?? '', updatedAt: p.updatedAt ?? '' }))
}

/** 便捷入口：带缓存取候选（两档补全 provider 都走它） */
export async function loadWikiTargets(query: string, limit?: number): Promise<WikiCandidate[]> {
  const pages = await getWikiPages()
  return suggestWikiTargets(query, pages, limit)
}
