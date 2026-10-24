import { stripHtml, decodeEntities } from './http'

/**
 * 轻量 RSS / Atom 解析（docs/intel-module-plan.md §4.1）。
 * 只喂固定白名单域（labs / qbitai），正则解析足够；不做通用 XML 兼容。
 */

export interface RssEntry {
  title: string
  link: string
  summary: string
  publishedAt: string
}

function pick(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m ? m[1] : ''
}

/** 相对链接 → 绝对（Anthropic 站内路径用） */
export function absUrl(href: string, base: string): string {
  const h = decodeEntities(String(href ?? '').trim())
  if (/^https?:\/\//i.test(h)) return h
  try { return new URL(h, base).href } catch { return '' }
}

/** RSS `<item>` 与 Atom `<entry>` 都吃；link 优先 rel=alternate / 原生 <link> 文本 */
export function parseFeed(xml: string, baseUrl: string, limit: number): RssEntry[] {
  const out: RssEntry[] = []
  const blocks = [
    ...xml.split(/<item[\s>]/i).slice(1).map((b) => b.split(/<\/item>/i)[0]),
    ...xml.split(/<entry[\s>]/i).slice(1).map((b) => b.split(/<\/entry>/i)[0]),
  ]
  for (const block of blocks) {
    const rawTitle = stripHtml(pick(block, 'title'))
    if (!rawTitle) continue
    let link = ''
    const hrefLink = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i)
    const plainLink = pick(block, 'link').trim()
    if (plainLink && /^https?:\/\//i.test(decodeEntities(plainLink))) link = decodeEntities(plainLink)
    else if (hrefLink) link = absUrl(hrefLink[1], baseUrl)
    const guid = decodeEntities(pick(block, 'guid')).trim()
    if (!link && /^https?:\/\//i.test(guid)) link = guid
    if (!link) continue
    const summary = stripHtml(pick(block, 'description') || pick(block, 'summary') || pick(block, 'content:encoded'))
    const publishedAt = pick(block, 'pubDate') || pick(block, 'published') || pick(block, 'updated')
    const t = Date.parse(publishedAt)
    out.push({
      title: rawTitle.slice(0, 300),
      link,
      summary: summary.slice(0, 600),
      publishedAt: Number.isFinite(t) ? new Date(t).toISOString() : '',
    })
    if (out.length >= limit) break
  }
  return out
}

/** RSS 日期（RFC822 等）→ ISO；失败空串 */
export function rssDateIso(raw: string): string {
  const t = Date.parse(String(raw ?? ''))
  return Number.isFinite(t) ? new Date(t).toISOString() : ''
}
