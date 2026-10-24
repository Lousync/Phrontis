import type { IntelCustomSource, IntelItem } from '../../../../src/types'
import { fetchText } from '../http'
import { parseFeed } from '../rss'
import { intelDraft } from '../draft'

/**
 * 自定义 RSS 源抓取（v2，docs/intel-module-plan.md D12）：
 * 与内置 RSS 源走同一条 parseFeed 通道（RSS/Atom 自动识别）；
 * 源权重 18 由 intelPure.sourceWeightOf 对 custom: 键统一兜底，低于全部内置源。
 */
export async function fetchCustomSource(cs: IntelCustomSource, limit: number): Promise<IntelItem[]> {
  const xml = await fetchText(cs.url, 15000, 1)
  let base = cs.url
  try { base = new URL(cs.url).origin } catch { /* keep raw */ }
  return parseFeed(xml, base, Math.min(Math.max(limit, 1), 50)).map((e) => intelDraft({
    source: `custom:${cs.id}`,
    section: cs.section,
    kind: 'news',
    title: e.title,
    url: e.link,
    author: cs.name,
    summary: e.summary,
    tags: ['自定义'],
    publishedAt: e.publishedAt,
  }))
}
