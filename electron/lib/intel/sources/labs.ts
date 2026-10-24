import type { IntelItem } from '../../../../src/types'
import { fetchText } from '../http'
import { absUrl, parseFeed, rssDateIso } from '../rss'
import { intelDraft } from '../draft'

/**
 * AI 官方博客（docs/intel-module-plan.md §1）：DeepMind / OpenAI 标准 RSS + Anthropic 页面解析。
 * 三站独立 try/catch —— 单站失败（Anthropic 解析脆弱，§12 风险表）不影响另两站。
 * title 加 `DeepMind:` / `OpenAI:` / `Anthropic:` 前缀区分。
 */
export async function fetchLabs(limit: number): Promise<IntelItem[]> {
  const per = Math.max(1, Math.ceil(limit / 3))
  const settled = await Promise.allSettled([
    fetchFeedStation('https://deepmind.google/blog/rss.xml', 'DeepMind', per),
    fetchFeedStation('https://openai.com/news/rss.xml', 'OpenAI', per),
    fetchAnthropicStation('https://www.anthropic.com/news', per),
  ])
  const out: IntelItem[] = []
  for (const s of settled) {
    if (s.status === 'fulfilled') out.push(...s.value)
    // 单站失败静默（fetchAll 统计按整个 labs 源算，不细拆）
  }
  // 多站合并后按发布时间倒序取上限
  return out
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0))
    .slice(0, limit)
}

async function fetchFeedStation(feedUrl: string, prefix: string, per: number): Promise<IntelItem[]> {
  const xml = await fetchText(feedUrl)
  return parseFeed(xml, feedUrl, per).map((e) => intelDraft({
    source: 'labs',
    section: 'tech',
    kind: 'blog',
    title: `${prefix}: ${e.title}`,
    url: e.link,
    author: prefix,
    summary: e.summary,
    tags: ['官方博客'],
    publishedAt: e.publishedAt || rssDateIso(''),
    extra: { station: prefix },
  }))
}

/** Anthropic 无 RSS：解析 /news 列表页的内链（脆弱，§12——选择器变了只改这一个函数） */
async function fetchAnthropicStation(pageUrl: string, per: number): Promise<IntelItem[]> {
  const html = await fetchText(pageUrl)
  const seen = new Set<string>()
  const out: IntelItem[] = []
  for (const m of html.matchAll(/<a\b[^>]*href=["'](\/news\/[^"#?][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const link = absUrl(m[1], pageUrl)
    const title = m[2]
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!link || !title || title.length < 8 || seen.has(link)) continue
    seen.add(link)
    out.push(intelDraft({
      source: 'labs',
      section: 'tech',
      kind: 'blog',
      title: `Anthropic: ${title}`.slice(0, 300),
      url: link,
      author: 'Anthropic',
      summary: '',
      tags: ['官方博客'],
      publishedAt: '',
      extra: { station: 'Anthropic' },
    }))
    if (out.length >= per) break
  }
  return out
}
