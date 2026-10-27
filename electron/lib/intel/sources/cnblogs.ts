import type { IntelItem } from '../../../../src/types'
import { fetchText } from '../http'
import { parseFeed } from '../rss'
import { intelDraft } from '../draft'

/**
 * 博客园首页最新文章：官方 Atom（https://www.cnblogs.com/rss）。
 * 站点改版风险低；与 RSS/Atom 公共解析层共用 CDATA / 实体处理。
 */
export async function fetchCnblogs(limit: number): Promise<IntelItem[]> {
  const xml = await fetchText('https://www.cnblogs.com/rss', 15000, 1)
  return parseFeed(xml, 'https://www.cnblogs.com', Math.min(Math.max(limit, 1), 50)).map((e) => intelDraft({
    source: 'cnblogs',
    section: 'tech',
    kind: 'blog',
    title: e.title,
    url: e.link,
    author: '博客园',
    summary: e.summary,
    tags: ['中文', '社区'],
    publishedAt: e.publishedAt,
  }))
}
