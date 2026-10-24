import type { IntelItem } from '../../../../src/types'
import { ARXIV_TIMEOUT_MS, fetchText } from '../http'
import { intelDraft } from '../draft'

/**
 * arXiv cs 类目最新论文（docs/intel-module-plan.md §1）：Atom 输出轻量正则解析。
 * 响应慢（§12 风险表）→ 超时放宽 20s，失败降级空数组。
 */
export async function fetchArxiv(limit: number): Promise<IntelItem[]> {
  const xml = await fetchText(
    `https://export.arxiv.org/api/query?search_query=cat:cs.*&sortBy=submittedDate&sortOrder=desc&max_results=${Math.min(Math.max(limit, 1), 50)}`,
    ARXIV_TIMEOUT_MS,
  )
  const out: IntelItem[] = []
  for (const block of xml.split(/<entry[\s>]/i).slice(1)) {
    const b = block.split(/<\/entry>/i)[0]
    const pick = (tag: string): string => (b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] ?? '').trim()
    const absUrl = pick('id')
    const rawTitle = pick('title').replace(/\s+/g, ' ').trim()
    if (!absUrl || !rawTitle) continue
    const m = absUrl.match(/abs\/([^\s?]+)$/)
    const arxivId = m ? m[1] : ''
    const authors = [...b.matchAll(/<name>([\s\S]*?)<\/name>/gi)].map((x) => x[1].trim()).filter(Boolean)
    const cats = [...b.matchAll(/<category[^>]*term=["']([^"']+)["']/gi)].map((x) => x[1]).filter(Boolean)
    const published = pick('published')
    try {
      const t = new Date(published)
      out.push(intelDraft({
        source: 'arxiv',
    section: 'tech',
        kind: 'paper',
        title: rawTitle,
        url: `https://arxiv.org/abs/${arxivId}`,
        author: authors.slice(0, 3).join(', '),
        summary: pick('summary').replace(/\s+/g, ' ').trim(),
        tags: cats.slice(0, 4),
        publishedAt: Number.isFinite(t.getTime()) ? t.toISOString() : '',
        extra: { arxivId },
      }))
    } catch { /* 单条坏数据跳过 */ }
    if (out.length >= limit) break
  }
  return out
}
