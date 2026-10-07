/**
 * 博客 AI 工具纯函数（正式版台账 F-15，2026-10-07）。
 *
 * 零依赖（不 import 任何模块），与 manualChannelPure.ts 同款约定 —— 专为契约脚本
 * strip-types 直接执行而拆（.AGENT/scripts/blog-tools/verify-blog-tools-f15.mjs）。
 * 日期容错与摘录窗口的口径变化都在这里，工具 handler 只做取数与拼装。
 */

/** \x60 = 反引号转义：.AGENT 契约的注释剥离状态机不认 regex 字面量，会把它当模板串起点吞掉后续源码（与 builtinTools.ts 同约定） */
const MD_NOISE_RE = /[#>*\x60[\]~-]/g
const WS_RE = /\s+/g

/**
 * 口述/模型给出的日期容错归一为 YYYY-MM-DD；认不出返回 null。
 * 全格式：2026-10-05 / 2026/10/5 / 2026.10.05 / 2026年10月5日；
 * 缺年（10月5日 / 10-05）补 today 的年份 —— 模型应传全格式，此为兜底。
 */
export function normalizeBlogDate(input: string, today: string): string | null {
  const s = (input || '').trim()
  if (!s) return null
  const full = s.match(/^(\d{4})[年\-/.]\s*(\d{1,2})[月\-/.]\s*(\d{1,2})\s*日?$/)
  const md = full ? null : s.match(/^(\d{1,2})[月\-/.]\s*(\d{1,2})\s*日?$/)
  const y = full ? Number(full[1]) : Number((today || '').slice(0, 4))
  const m = full ? Number(full[2]) : md ? Number(md[1]) : NaN
  const d = full ? Number(full[3]) : md ? Number(md[2]) : NaN
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** 扑空提示：离 target 最近的 n 个日记日期（先按距离选，再按时间正序排，直接可拼进报错） */
export function nearestEntryDates(target: string, dates: string[], n = 5): string[] {
  const t = Date.parse(target)
  if (Number.isNaN(t)) return []
  const uniq = [...new Set(dates.filter(x => x && !Number.isNaN(Date.parse(x))))]
  return uniq
    .sort((a, b) => Math.abs(Date.parse(a) - t) - Math.abs(Date.parse(b) - t))
    .slice(0, Math.max(0, n))
    .sort((a, b) => a.localeCompare(b))
}

/**
 * search 摘录：剥 markdown 后取「正文命中处前后各 radius 字」的窗口（F-15：
 * 固定取开头 120 字时，命中在正文中段的摘录根本不含命中处，模型无法确认是否目标篇目）。
 * query 可传拆好的词表（F-15 处置4 多词检索）—— 依次找**首个命中词**做窗口锚点，
 * 多词 AND 命中但整句不在正文时摘录仍能落在命中处。
 * 仅标题命中（正文无任何命中词）回落开头 2×radius 字 —— 与旧行为一致。
 */
export function blogHitExcerpt(contentMd: string, query: string | string[], radius = 60): string {
  const plain = (contentMd || '').replace(MD_NOISE_RE, ' ').replace(WS_RE, ' ').trim()
  if (!plain) return ''
  const qs = (Array.isArray(query) ? query : [query]).map(x => (x || '').trim().toLowerCase()).filter(Boolean)
  if (!qs.length) return plain.slice(0, radius * 2)
  const lower = plain.toLowerCase()
  let idx = -1
  let q = ''
  for (const term of qs) {
    idx = lower.indexOf(term)
    if (idx >= 0) { q = term; break }
  }
  if (idx < 0) return plain.slice(0, radius * 2)
  const qlen = Math.min(q.length, 60) // 防超长查询把窗口撑成全文
  const start = Math.max(0, idx - radius)
  const end = Math.min(plain.length, idx + qlen + radius)
  return (start > 0 ? '…' : '') + plain.slice(start, end).trim() + (end < plain.length ? '…' : '')
}

/**
 * F-15 处置4：search 拆词 —— 空白（含全角空格）与中西文逗号/顿号/分号切分，
 * 去空去重保序，统一小写（检索口径大小写不敏感）。
 */
export function splitBlogSearchTerms(q: string): string[] {
  return [...new Set((q || '').toLowerCase().split(/[\s,，、;；]+/).map(t => t.trim()).filter(Boolean))]
}

/**
 * F-15 处置4：多词 AND 语义 —— 每个词都在「标题或正文」命中才算命中。
 * 单词查询与旧整段子串匹配完全一致；多词时 AND 是旧匹配的严格超集
 * （含完整子串必含全部词），对既有调用方零回归。
 */
export function matchBlogEntry(title: string, body: string, terms: string[]): boolean {
  if (!terms.length) return false
  const t = (title || '').toLowerCase()
  const b = (body || '').toLowerCase()
  return terms.every(term => t.includes(term) || b.includes(term))
}
