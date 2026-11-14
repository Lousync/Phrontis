import type { KnowledgePage, KnowledgeTopic, KnowledgeTopicColor } from '../../types'

/**
 * 笔记流 / 虚拟主题的零依赖纯函数（v3.27.0，docs/knowledge-feed-topics-plan.md §4.1）。
 *
 * 契约脚本用 `node --experimental-strip-types` 直接 import 本文件做真值断言 ——
 * 所以这里**只准放纯函数**：不 import React / electron / ipc，不读 window / fs。
 * 类型用 `import type`（strip-types 时整条擦除）。
 */

/** 主题调色板：亮/暗主题下都可读的中间调（与静态样式里的 --topic-* 对应） */
export const TOPIC_COLOR_HEX: Record<KnowledgeTopicColor, string> = {
  blue: '#4f6ef2',
  teal: '#2a988f',
  gold: '#c9962e',
  purple: '#8b5cf6',
  red: '#e05252',
  sky: '#2f9bd6',
}

export function topicColorOf(color: KnowledgeTopicColor | string | undefined): string {
  return TOPIC_COLOR_HEX[(color as KnowledgeTopicColor) ?? 'blue'] ?? TOPIC_COLOR_HEX.blue
}

/** 目录路径（正斜杠）：'a/b/c.md' → 'a/b'；根层页 → '' */
export function dirOfPath(path?: string | null): string {
  if (!path) return ''
  const p = path.replace(/\\/g, '/')
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

/** 顶层目录（第一段）：'a/b/c.md' → 'a'；根层页 → '' */
export function topDirOfPath(path?: string | null): string {
  const dir = dirOfPath(path)
  return dir.split('/')[0] ?? ''
}

/** 目录显示名（最后一段）：'a/b/c.md' → 'b'；根层页 → '仓库根' */
export function dirLabelOfPath(path?: string | null): string {
  const dir = dirOfPath(path)
  if (!dir) return '仓库根'
  const parts = dir.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : '仓库根'
}

/** 主题成员 id 集合（成员已由主进程修复，这里只做去重） */
export function topicMemberIds(topic: KnowledgeTopic | null | undefined): Set<string> {
  return new Set((topic?.members ?? []).map((m) => m.pageId))
}

/** 所有已归类页面的 id（多个主题去重） */
export function filedPageIds(topics: KnowledgeTopic[]): Set<string> {
  const out = new Set<string>()
  for (const t of topics) for (const m of t.members) out.add(m.pageId)
  return out
}

/** 未归类 = 不在任何主题里的页面（目录不再算归类） */
export function unfiledPages(pages: KnowledgePage[], topics: KnowledgeTopic[]): KnowledgePage[] {
  const filed = filedPageIds(topics)
  return pages.filter((p) => !filed.has(p.id))
}

/** 某页所属的主题（多对多） */
export function topicsOfPage(pageId: string, topics: KnowledgeTopic[]): KnowledgeTopic[] {
  return topics.filter((t) => t.members.some((m) => m.pageId === pageId))
}

/**
 * 主题成员 → 页面对象。优先按 pageId 命中；`auto:` 临时身份 / 已改名页按 path 兜底。
 * 解析不到的成员直接丢弃（主进程读到的是已剔除版本，这里只做前端防御）。
 */
export function resolveTopicPages(topic: KnowledgeTopic | null | undefined, pages: KnowledgePage[]): KnowledgePage[] {
  if (!topic) return []
  const byId = new Map(pages.map((p) => [p.id, p]))
  const byPath = new Map(pages.map((p) => [p.path ?? '', p]))
  const out: KnowledgePage[] = []
  const seen = new Set<string>()
  for (const m of topic.members) {
    const p = byId.get(m.pageId) ?? (m.path ? byPath.get(m.path) : undefined)
    if (!p || seen.has(p.id)) continue
    seen.add(p.id)
    out.push(p)
  }
  return out
}

export type FeedSort = 'mtime' | 'title'
export type RecentGroupKey = '今天' | '昨天' | '本周' | '更早'

/** 最近视图分组（按修改时间；无效时间归「更早」） */
export function recentGroupOf(updatedAt: string | undefined, now: number = Date.now()): RecentGroupKey {
  const t = updatedAt ? Date.parse(updatedAt) : NaN
  if (!Number.isFinite(t)) return '更早'
  const diff = now - t
  const day = 24 * 60 * 60 * 1000
  if (diff < day) return '今天'
  if (diff < 2 * day) return '昨天'
  if (diff < 7 * day) return '本周'
  return '更早'
}

const GROUPS: RecentGroupKey[] = ['今天', '昨天', '本周', '更早']

/**
 * 「最近」视图的排序 + 分组：
 *  - sort='title' → 扁平列表（单组，标题序）；
 *  - sort='mtime' → 今天/昨天/本周/更早 四组，组内按修改时间倒序。
 */
export function buildFeedGroups(
  pages: KnowledgePage[],
  sort: FeedSort,
  now: number = Date.now(),
): Array<{ key: RecentGroupKey; pages: KnowledgePage[] }> {
  if (sort === 'title') {
    const list = [...pages].sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans'))
    return [{ key: '今天', pages: list }]
  }
  const buckets = new Map<RecentGroupKey, KnowledgePage[]>()
  for (const p of pages) {
    const key = recentGroupOf(p.updatedAt, now)
    const arr = buckets.get(key) ?? []
    arr.push(p)
    buckets.set(key, arr)
  }
  const ts = (p: KnowledgePage): number => {
    const t = p.updatedAt ? Date.parse(p.updatedAt) : NaN
    return Number.isFinite(t) ? t : 0
  }
  return GROUPS
    .filter((key) => buckets.has(key))
    .map((key) => ({ key, pages: buckets.get(key)!.sort((a, b) => ts(b) - ts(a)) }))
}

/** 主题成员按目录分组（详情页用）：组按顶层目录 + 目录名排序，组内按修改时间倒序 */
export function groupPagesByDir(pages: KnowledgePage[]): Array<{ key: string; label: string; top: string; pages: KnowledgePage[] }> {
  const buckets = new Map<string, KnowledgePage[]>()
  for (const p of pages) {
    const key = dirOfPath(p.path)
    const arr = buckets.get(key) ?? []
    arr.push(p)
    buckets.set(key, arr)
  }
  const ts = (p: KnowledgePage): number => {
    const t = p.updatedAt ? Date.parse(p.updatedAt) : NaN
    return Number.isFinite(t) ? t : 0
  }
  return [...buckets.entries()]
    .map(([key, arr]) => ({
      key,
      label: dirLabelOfPath(key ? `${key}/x` : 'x'),
      top: key.split('/')[0] ?? '',
      pages: arr.sort((a, b) => ts(b) - ts(a)),
    }))
    .sort((a, b) => a.key.localeCompare(b.key, 'zh-Hans'))
}

/** 主题「跨几个目录」 */
export function topicDirCount(pages: KnowledgePage[]): number {
  return new Set(pages.map((p) => dirOfPath(p.path))).size
}

/** 最近更新时间（最大 updatedAt，毫秒）；无有效时间 → 0 */
export function latestUpdatedMs(pages: KnowledgePage[]): number {
  let max = 0
  for (const p of pages) {
    const t = p.updatedAt ? Date.parse(p.updatedAt) : NaN
    if (Number.isFinite(t) && t > max) max = t
  }
  return max
}

/** 相对时间文案（原型口径：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / N 周前） */
export function formatRelTime(input: string | number | undefined, now: number = Date.now()): string {
  if (input === undefined || input === null || input === '') return ''
  const t = typeof input === 'number' ? input : Date.parse(input)
  if (!Number.isFinite(t)) return ''
  const m = Math.floor((now - t) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d === 1) return '昨天'
  if (d < 7) return `${d} 天前`
  return `${Math.floor(d / 7)} 周前`
}

/** 列表摘要：优先索引摘要，其次正文兜底（正文只在已加载时存在） */
export function excerptOf(page: KnowledgePage, max = 120): string {
  const raw = (page.excerpt || page.contentMd || '').replace(/\s+/g, ' ').trim()
  return raw.length > max ? `${raw.slice(0, max)}…` : raw
}

/** 笔记流搜索过滤：标题 / 摘要 / 标签 / 目录名 */
export function filterFeedPages(pages: KnowledgePage[], query: string): KnowledgePage[] {
  const q = query.trim().toLowerCase()
  if (!q) return pages
  return pages.filter((p) => {
    const hay = [p.title, excerptOf(p), p.path ?? '', ...(p.tags ?? []).map((t) => t.name)]
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  })
}
