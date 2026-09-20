import { readFileSync } from 'fs'
import { join } from 'path'
import { ipcMain } from 'electron'
import { getVaultKbRoot } from './kbStore/vaultContext'
import { getKnowledgeIndex, getKnowledgeTextIndex, type KnowledgePageIndexEntry } from './kbStore/knowledgeIndex'
import { chunkPageText } from './kbStore/semanticChunker'
import { cosineTopK, findChunkByKey, semanticIndexExists } from './kbStore/semanticStore'
import { ensureSemanticIndex } from './kbStore/semanticIndex'
import { excerptAround, rrfFuse, scoreKeywordPages } from './kbStore/searchFusion'
import type { KnowledgeSearchFilters } from './kbStore/searchFusion'
import { llmEmbed } from './llmService'

/**
 * 知识召回统一门面（knowledge-index-design §8）—— AI 工具 / 相似笔记 / kb.metadata.* 共用。
 *
 * 双路：关键词（结构+正文索引上的加权评分）+ 语义（向量库余弦）→ RRF 融合（k=60）。
 * mode='auto'（默认）：配了 embeddingModel 走混合；否则/失败自动降级纯关键词——
 * 全链路不报错（设计红线 §3），`semantic.enabled/reason` 透传给调用方展示。
 */

export type { KnowledgeSearchFilters }

export interface KnowledgeHit {
  pageId: string
  path: string
  title: string
  updatedAt: string
  /** 语义路命中的块序（关键词路不设） */
  chunkIdx?: number
  excerpt: string
  score: number
  via: 'keyword' | 'semantic' | 'hybrid'
}

export interface KnowledgeSearchResult {
  hits: KnowledgeHit[]
  semantic: { enabled: boolean; reason?: string }
}

export type KnowledgeSearchMode = 'auto' | 'keyword' | 'semantic'

const DEFAULT_TOP_K = 8

/** 语义命中块取原文：chunk 元数据不存正文，按需单页重切块后取 idx（topK 有限次，开销可控） */
function chunkExcerpt(root: string, page: KnowledgePageIndexEntry, chunkIdx: number, title: string): string {
  try {
    const raw = readFileSync(join(root, page.path), 'utf-8')
    const chunks = chunkPageText(page.id, title, raw)
    return (chunks[chunkIdx]?.text ?? page.title).slice(0, 220)
  } catch {
    return page.title
  }
}

// ===== 门面 =====

export async function searchKnowledge(opts: {
  query: string
  topK?: number
  mode?: KnowledgeSearchMode
  filters?: KnowledgeSearchFilters
}): Promise<KnowledgeSearchResult> {
  const topK = Math.max(1, Math.floor(opts.topK ?? DEFAULT_TOP_K))
  const mode = opts.mode ?? 'auto'
  const idx = getKnowledgeIndex()
  const textById = getKnowledgeTextIndex()
  const pages = idx.pages.filter((p) => p.entryKind !== 'file')
  const terms = opts.query.trim().toLowerCase().split(/\s+/).filter(Boolean)

  // ---- 关键词路（始终可用；semantic 模式下仅作融合底座，仍需计算） ----
  const keywordHits = mode === 'semantic'
    ? []
    : scoreKeywordPages(opts.query, pages, textById, opts.filters)
  const keywordRanked = keywordHits.slice(0, topK * 4).map((h) => h.page.id)

  // ---- 语义路 ----
  const root = getVaultKbRoot()
  let semanticEnabled = false
  let semanticReason: string | undefined
  const semanticChunkHits: { pageId: string; chunkIdx: number; score: number }[] = []

  if (mode !== 'keyword' && root && opts.query.trim()) {
    const built = await ensureSemanticIndex()
    semanticEnabled = built.enabled
    semanticReason = built.reason ?? (built.enabled ? undefined : 'embedFailed')
    if (built.enabled && semanticIndexExists(root)) {
      const emb = await llmEmbed([opts.query])
      if (emb.ok && emb.vectors[0]) {
        for (const hit of cosineTopK(root, new Float32Array(emb.vectors[0]), topK * 4)) {
          const found = findChunkByKey(root, hit.key)
          if (!found) continue
          if (opts.filters?.excludePageIds?.includes(found.pageId)) continue
          if (opts.filters?.categoryId != null && idx.byId[found.pageId]?.categoryId !== opts.filters.categoryId) continue
          if ((opts.filters?.tags ?? []).length > 0) {
            const pageTags = (idx.byId[found.pageId]?.tags ?? []).map((t) => t.toLowerCase())
            const need = (opts.filters?.tags ?? []).map((t) => t.toLowerCase())
            if (!need.every((t) => pageTags.some((pt) => pt.includes(t)))) continue
          }
          semanticChunkHits.push({ pageId: found.pageId, chunkIdx: found.meta.idx, score: hit.score })
        }
      } else if (!emb.ok) {
        semanticReason = 'embedFailed'
      }
    }
  } else if (mode === 'keyword') {
    semanticReason = 'modeKeyword'
  } else if (!root) {
    semanticReason = 'novault'
  }

  // 语义路按页聚合（取页内最高分块），分数降序
  const bestByPage = new Map<string, { chunkIdx: number; score: number }>()
  for (const h of semanticChunkHits) {
    const cur = bestByPage.get(h.pageId)
    if (!cur || h.score > cur.score) bestByPage.set(h.pageId, { chunkIdx: h.chunkIdx, score: h.score })
  }
  const semanticRanked = [...bestByPage.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .map(([id]) => id)

  // ---- 融合与输出 ----
  const kwById = new Map(keywordHits.map((h) => [h.page.id, h]))
  const fused = rrfFuse(keywordRanked, semanticRanked)
  const ordered = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, topK)

  const hits: KnowledgeHit[] = []
  for (const [pageId, info] of ordered) {
    const page = idx.byId[pageId]
    if (!page) continue
    const semanticChunk = bestByPage.get(pageId)
    const via = info.via
    let excerpt = ''
    if (via === 'semantic' && root && semanticChunk) {
      excerpt = chunkExcerpt(root, page, semanticChunk.chunkIdx, page.title)
    } else {
      excerpt = excerptAround(textById[pageId] ?? '', terms)
    }
    hits.push({
      pageId,
      path: page.path,
      title: page.title,
      updatedAt: page.updatedAt,
      ...(via !== 'keyword' && semanticChunk ? { chunkIdx: semanticChunk.chunkIdx } : {}),
      excerpt,
      score: Number(info.score.toFixed(4)),
      via,
    })
  }

  return { hits, semantic: { enabled: semanticEnabled, reason: semanticReason } }
}

// ===== 相似笔记 IPC（A3-3：编辑器右栏「相关笔记」数据源）=====

/** 相似笔记条目（渲染层展示用精简 DTO） */
export interface SimilarPageHit {
  pageId: string
  title: string
  path: string
  excerpt: string
  via: 'keyword' | 'semantic' | 'hybrid'
  score: number
}

export function registerKnowledgeSearchHandlers(): void {
  ipcMain.handle('knowledge:similarPages', async (_e, pageId: unknown) => {
    const idx = getKnowledgeIndex()
    const page = typeof pageId === 'string' ? idx.byId[pageId] : null
    if (!page || page.entryKind === 'file') return { hits: [] as SimilarPageHit[] }
    // 查询向量 = 标题 + 正文前 500 字（标题给主题，正文给内容特征）
    const body = (getKnowledgeTextIndex()[page.id] ?? '').replace(/\s+/g, ' ').slice(0, 500)
    const r = await searchKnowledge({
      query: `${page.title} ${body}`.trim(),
      topK: 6,
      filters: { excludePageIds: [page.id] },
    })
    return {
      hits: r.hits.map<SimilarPageHit>((h) => ({
        pageId: h.pageId,
        title: h.title,
        path: h.path,
        excerpt: h.excerpt.slice(0, 120),
        via: h.via,
        score: h.score,
      })),
      semantic: r.semantic,
    }
  })
}
