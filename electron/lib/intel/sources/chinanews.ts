import type { IntelItem } from '../../../../src/types'
import { fetchText } from '../http'
import { parseFeed } from '../rss'
import { intelDraft } from '../draft'

/**
 * 中新网滚动新闻（docs/intel-module-plan.md §1 v2）：标准 RSS 2.0，滚动混装各条线，
 * 版面归「时政 · 国内」（滚动流以国内要闻为主）。
 */
export async function fetchChinanews(limit: number): Promise<IntelItem[]> {
  const xml = await fetchText('https://www.chinanews.com/rss/scroll-news.xml', 15000, 1)
  return parseFeed(xml, 'https://www.chinanews.com', Math.min(Math.max(limit, 1), 50)).map((e) => intelDraft({
    source: 'chinanews',
    section: 'domestic',
    kind: 'news',
    title: e.title,
    url: e.link,
    author: '中新网',
    summary: e.summary,
    tags: ['时政'],
    publishedAt: e.publishedAt,
  }))
}
