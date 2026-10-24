import type { IntelItem, IntelSection } from '../../../../src/types'
import { fetchText } from '../http'
import { parseFeed } from '../rss'
import { intelDraft } from '../draft'

/**
 * 人民网 RSS（docs/intel-module-plan.md §1 v2）：标准 RSS 2.0，全文输出（382KB 级），
 * description 走 stripHtml + 截断（intelDraft 里统一 600 字）。两个频道各一个适配器函数。
 */

export async function fetchPeoplePolitics(limit: number): Promise<IntelItem[]> {
  return fetchPeopleFeed('http://www.people.com.cn/rss/politics.xml', 'people_politics', 'domestic', '人民网·时政', limit)
}

export async function fetchPeopleWorld(limit: number): Promise<IntelItem[]> {
  return fetchPeopleFeed('http://www.people.com.cn/rss/world.xml', 'people_world', 'world', '人民网·国际', limit)
}

async function fetchPeopleFeed(feedUrl: string, source: 'people_politics' | 'people_world', section: IntelSection, author: string, limit: number): Promise<IntelItem[]> {
  const xml = await fetchText(feedUrl, 15000, 1)
  return parseFeed(xml, 'http://www.people.com.cn', Math.min(Math.max(limit, 1), 50)).map((e) => intelDraft({
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
