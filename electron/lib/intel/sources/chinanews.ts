import type { IntelItem } from '../../../../src/types'
import { fetchText } from '../http'
import { parseFeed } from '../rss'
import { intelDraft } from '../draft'

/**
 * 中新网 RSS（docs/intel-module-plan.md §1 v2，2026-10-25 实测鲜活）：
 *   scroll-news.xml 滚动要闻（国内向）→ 时政·国内版面
 *   world.xml 国际频道 → 国际版面（v2.1 替换掉冻结的人民网/新浪 feed）
 * title/description 均为 CDATA 包裹——CDATA 解包在 rss.ts pick() 里统一处理。
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

export async function fetchChinanewsWorld(limit: number): Promise<IntelItem[]> {
  const xml = await fetchText('https://www.chinanews.com/rss/world.xml', 15000, 1)
  return parseFeed(xml, 'https://www.chinanews.com', Math.min(Math.max(limit, 1), 50)).map((e) => intelDraft({
    source: 'chinanews_world',
    section: 'world',
    kind: 'news',
    title: e.title,
    url: e.link,
    author: '中新网',
    summary: e.summary,
    tags: ['国际'],
    publishedAt: e.publishedAt,
  }))
}
