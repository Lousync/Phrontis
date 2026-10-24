import type { IntelItem, IntelKind, IntelSourceKey } from '../../../src/types'

/**
 * 情报条目雏形构造（docs/intel-module-plan.md §4.1）。
 * 适配器只做「拉数 + 映射」：hash / id / score / fetchedAt 由 pipeline 补齐。
 */
export function intelDraft(p: {
  source: IntelSourceKey
  kind: IntelKind
  title: string
  url: string
  author?: string
  summary?: string
  tags?: string[]
  stars?: number
  publishedAt?: string
  extra?: Record<string, unknown>
}): IntelItem {
  return {
    id: '',           // pipeline 填（hash 前 12）
    hash: '',         // pipeline 填
    source: p.source,
    kind: p.kind,
    title: String(p.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    url: String(p.url ?? '').trim(),
    author: String(p.author ?? '').trim().slice(0, 120),
    summary: String(p.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 600),
    tags: (p.tags ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 6),
    score: 0,         // pipeline 填
    stars: typeof p.stars === 'number' && p.stars > 0 ? p.stars : undefined,
    publishedAt: p.publishedAt ?? '',
    fetchedAt: '',    // pipeline 填
    fav: false,
    extra: p.extra,
  }
}
