import type { IntelItem, IntelSection } from '../../../../src/types'
import { fetchText } from '../http'
import { parseFeed } from '../rss'
import { intelDraft } from '../draft'

/**
 * 新浪新闻 RSS（docs/intel-module-plan.md §1 v2）：focus15.xml 聚焦频道，标准 RSS 2.0。
 */

export async function fetchSinaChina(limit: number): Promise<IntelItem[]> {
  return fetchSinaFeed('https://rss.sina.com.cn/news/china/focus15.xml', 'sina_china', 'domestic', '新浪·国内', limit)
}

export async function fetchSinaWorld(limit: number): Promise<IntelItem[]> {
  return fetchSinaFeed('https://rss.sina.com.cn/news/world/focus15.xml', 'sina_world', 'world', '新浪·国际', limit)
}

async function fetchSinaFeed(feedUrl: string, source: 'sina_china' | 'sina_world', section: IntelSection, author: string, limit: number): Promise<IntelItem[]> {
  const xml = await fetchText(feedUrl, 15000, 1)
  return parseFeed(xml, 'https://rss.sina.com.cn', Math.min(Math.max(limit, 1), 50)).map((e) => intelDraft({
    source,
    section,
    kind: 'news',
    title: e.title,
    url: e.link,
    author,
    summary: e.summary,
    tags: [section === 'domestic' ? '时政' : '国际'],
    publishedAt: e.publishedAt,
  }))
}
