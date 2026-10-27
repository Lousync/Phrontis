import type { IntelItem } from '../../../../src/types'
import { fetchText } from '../http'
import { parseCsdnHtml } from '../rss'
import { intelDraft } from '../draft'

/**
 * CSDN 人工智能频道：无站级 RSS，解析公开列表页（blog.csdn.net/nav/ai）。
 * 页面结构与 Anthropic 页面解析同级脆弱；单源失败不炸整轮，改版时只改 rss.ts 的 parseCsdnHtml。
 */
export async function fetchCsdn(limit: number): Promise<IntelItem[]> {
  const html = await fetchText('https://blog.csdn.net/nav/ai', 15000, 1)
  return parseCsdnHtml(html, limit).map((e) => intelDraft({
    source: 'csdn',
    section: 'tech',
    kind: 'blog',
    title: e.title,
    url: e.link,
    author: e.author || 'CSDN',
    summary: e.summary,
    tags: ['中文', '社区'],
    publishedAt: '',
    extra: { channel: 'ai' },
  }))
}
