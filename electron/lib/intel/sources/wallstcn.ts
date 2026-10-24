import type { IntelItem } from '../../../../src/types'
import { fetchJson } from '../http'
import { intelDraft } from '../draft'

/**
 * 华尔街见闻·快讯（docs/intel-module-plan.md §1 v2）：JSON API
 * https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=N
 * 字段（2026-10-25 实测）：title / content_text（纯文）/ display_time（unix 秒）/ uri（详情链接）。
 * content_text 无摘要时退化取 content 去标签（http.stripHtml）。
 */

interface WallstcnLiveItem {
  title?: string
  content?: string
  content_text?: string
  display_time?: number
  uri?: string
}

export async function fetchWallstcn(limit: number): Promise<IntelItem[]> {
  const cap = Math.min(Math.max(limit, 1), 50)
  const data = await fetchJson<{ code?: number; data?: { items?: WallstcnLiveItem[] } }>(
    `https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=${cap}`,
    15000,
  )
  const items = Array.isArray(data?.data?.items) ? data!.data!.items! : []
  const out: IntelItem[] = []
  for (const it of items.slice(0, cap)) {
    const text = String(it.content_text ?? '').trim() || String(it.content ?? '').trim()
    const title = String(it.title ?? '').trim() || text.slice(0, 60)
    const uri = String(it.uri ?? '').trim()
    if (!title || !/^https?:\/\//.test(uri)) continue
    out.push(intelDraft({
      source: 'wallstcn',
      section: 'finance',
      kind: 'news',
      title,
      url: uri,
      author: '华尔街见闻',
      summary: text,
      tags: ['财经'],
      publishedAt: typeof it.display_time === 'number' && it.display_time > 0 ? new Date(it.display_time * 1000).toISOString() : '',
    }))
  }
  return out
}
