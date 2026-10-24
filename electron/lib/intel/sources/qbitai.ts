import type { IntelItem } from '../../../../src/types'
import { fetchText } from '../http'
import { parseFeed, rssDateIso } from '../rss'
import { intelDraft } from '../draft'

/**
 * 量子位（docs/intel-module-plan.md §1）：WordPress RSS，偶发 502 —— 重试 1 次（fetchText retries）。
 */
export async function fetchQbitai(limit: number): Promise<IntelItem[]> {
  const xml = await fetchText('https://www.qbitai.com/feed', 12000, 1)
  return parseFeed(xml, 'https://www.qbitai.com', Math.min(Math.max(limit, 1), 50)).map((e) => intelDraft({
    source: 'qbitai',
    kind: 'news',
    title: e.title,
    url: e.link,
    author: '量子位',
    summary: e.summary,
    tags: ['中文'],
    publishedAt: e.publishedAt || rssDateIso(''),
  }))
}
