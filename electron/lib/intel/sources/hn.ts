import type { IntelItem } from '../../../../src/types'
import { fetchJson } from '../http'
import { intelDraft } from '../draft'

/**
 * Hacker News 前页（docs/intel-module-plan.md §1）：Algolia 官方 API，免 Key 大陆可达。
 */
export async function fetchHn(limit: number): Promise<IntelItem[]> {
  type Hit = {
    objectID?: string; title?: string | null; url?: string | null
    author?: string; points?: number; num_comments?: number
    story_text?: string | null; created_at?: string
  }
  const data = await fetchJson<{ hits?: Hit[] }>(
    `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${Math.min(Math.max(limit, 1), 50)}`,
  )
  return (data.hits ?? []).slice(0, limit).map((h) => {
    const id = String(h.objectID ?? '').trim()
    const title = String(h.title ?? '').trim()
    if (!id || !title) return null
    const link = /^https?:\/\//.test(String(h.url ?? '')) ? String(h.url) : `https://news.ycombinator.com/item?id=${id}`
    const comments = h.num_comments ?? 0
    return intelDraft({
      source: 'hn',
      kind: 'news',
      title,
      url: link,
      author: String(h.author ?? ''),
      // HN hit 无正文 —— 摘要给 story_text（Show HN 有）否则极简上下文（完整度分自然走低，不硬凑）
      summary: String(h.story_text ?? '') || `Hacker News 前页 · ${h.points ?? 0} points · ${comments} 条评论`,
      stars: h.points ?? 0,
      publishedAt: h.created_at ?? '',
      extra: { points: h.points ?? 0, comments },
    })
  }).filter((x): x is IntelItem => x !== null)
}
