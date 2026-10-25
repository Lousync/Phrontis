/**
 * 轻量 RSS / Atom 解析（docs/intel-module-plan.md §4.1）。
 * 零依赖（实体反转 / 去标签内联在本文件）——契约脚本 verify-intel-rss.mjs 裸 node 直跑同一实现。
 *
 * 2026-10-25 修：CDATA 包裹的 title/description（人民网 / 新浪 / 中新网国际均如此）此前被
 * stripHtml 的 `<[^>]*>` 当整段标签吃掉 → 标题为空 → 条目全被跳过（表象「刷新成功但 0 条」）。
 * 现在 pick() 先解 CDATA 再去标签；另加「非 feed 响应」守卫（错误页 / 代理拦截页 → 抛错进 failed，不静默）。
 */

export interface RssEntry {
  title: string
  link: string
  summary: string
  publishedAt: string
}

/** 文本转义反转（RSS / Atom 摘要里常见实体） */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x2F;|&#47;/g, '/')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&#(\d+);/g, (_, n: string) => { try { return String.fromCodePoint(Number(n)) } catch { return '' } })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => { try { return String.fromCodePoint(parseInt(n, 16)) } catch { return '' } })
}

/** 去标签 + 压空白（RSS description 摘要用） */
export function stripHtml(s: string): string {
  return decodeEntities(String(s ?? ''))
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function pick(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  if (!m) return ''
  // CDATA 解包在 stripHtml 之前：否则 <![CDATA[…]]> 整段被当标签剥掉，内容全丢
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

/** 相对链接 → 绝对（Anthropic 站内路径用） */
export function absUrl(href: string, base: string): string {
  const h = decodeEntities(String(href ?? '').trim())
  if (/^https?:\/\//i.test(h)) return h
  try { return new URL(h, base).href } catch { return '' }
}

/** RSS `<item>` 与 Atom `<entry>` 都吃；link 优先 rel=alternate / 原生 <link> 文本 */
export function parseFeed(xml: string, baseUrl: string, limit: number): RssEntry[] {
  const src = String(xml ?? '')
  if (!/<(item|entry)[\s>]/i.test(src)) {
    throw new Error('响应不是 RSS/Atom（可能是错误页或被代理拦截）')
  }
  const out: RssEntry[] = []
  const blocks = [
    ...src.split(/<item[\s>]/i).slice(1).map((b) => b.split(/<\/item>/i)[0]),
    ...src.split(/<entry[\s>]/i).slice(1).map((b) => b.split(/<\/entry>/i)[0]),
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
    const t = Date.parse(decodeEntities(publishedAt))
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
