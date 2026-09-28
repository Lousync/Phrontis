/**
 * 帮助手册检索的**纯算法核心**（零依赖：不 import electron / fs，专为契约脚本 import 而立）。
 *
 * 模式同 releaseNotes/judge.ts：主进程实现与 .AGENT/scripts 契约脚本共用同一份算法，
 * 避免脚本抄一份实现后各自漂移 —— 检索算法改动只改这里，verify-help-retrieval.mjs
 * 跑的就是真实行为。磁盘读取（目录定位依赖 electron app）留在 helpService。
 *
 * 设计记录见 docs/ai-learn-center-design.md §7.3 / §7.5。
 */

export interface HelpDocRaw {
  /** 文件名去扩展名，如「快速上手」 */
  id: string
  title: string
  category: string
  /** frontmatter 里的检索别名（用户口语说法） */
  keywords: string[]
  body: string
}

export interface HelpHit {
  id: string
  title: string
  category: string
  /** 命中位置附近的正文片段 */
  snippet: string
  score: number
}

/** 极简 frontmatter：与渲染层 docsLoader 同规则（CRLF 必须先归一，否则 kv 正则吃不到行尾） */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } | null {
  const text = raw.replace(/\r\n/g, '\n')
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (!m) return null
  const meta: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w ]*?)\s*:\s*(.+)$/)
    if (kv) meta[kv[1].trim()] = kv[2].trim()
  }
  return { meta, body: m[2] }
}

/** `[a, b, c]` 或 `a, b` → 字符串数组 */
export function parseList(v?: string): string[] {
  if (!v) return []
  return v.replace(/^\[|\]$/g, '').split(/[,，]/).map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
}

/** 停用词（bigram 形式）：这些词在任何文档里都常见，留着只会稀释信号 */
export const STOP_TERMS = new Set([
  '怎么', '为什么', '什么', '如何', '是否', '可以', '能不能', '有没有', '一个', '这个', '那个',
  '哪里', '在哪', '为什', '请问', '帮我', '一下', '的话', '不会', '不是', '我要', '我想', '我的',
])

/**
 * 查询分词：英文按原词，中文切 **bigram**（相邻两字滑窗）。
 *
 * 为什么必须切：中文没有空格，把「知识库看不到文件」整句当一个词去匹配，
 * 文档里根本不存在这个连续串 —— 必然全部落空（2026-09-10 自检实测 14 问错 6 问）。
 * 切成 bigram 后，「知识」「识库」「看不」「不到」「文件」各自命中，召回恢复正常。
 */
export function tokenize(query: string): string[] {
  const cleaned = query.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ')
  const out = new Set<string>()
  for (const m of cleaned.matchAll(/[a-z0-9][a-z0-9._-]*/g)) {
    if (m[0].length >= 2) out.add(m[0])
  }
  for (const run of cleaned.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    if (run.length === 1) { out.add(run); continue }
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
  }
  for (const s of STOP_TERMS) out.delete(s)
  return [...out]
}

/** 取命中位置附近的片段（前后各留一段，尽量落在段落边界） */
export function snippetOf(body: string, needle: string, span = 700): string {
  const idx = body.toLowerCase().indexOf(needle.toLowerCase())
  if (idx < 0) return body.slice(0, span)
  const start = Math.max(0, idx - Math.floor(span / 3))
  const text = body.slice(start, start + span)
  return (start > 0 ? '…' : '') + text + (start + span < body.length ? '…' : '')
}

/**
 * 手册检索（纯函数版）：标题 > keywords > 正文，按命中词数累加。
 * 只算「命中与否」而不算出现次数 —— 出现次数会让长文档霸榜，而这里要的是相关性排序。
 * 调用方传入已加载的文档集；文档集为空的提示语由调用方给出（那是磁盘/目录层的事）。
 */
export function searchHelpIn(
  all: HelpDocRaw[],
  query: string,
  limit = 3,
  id?: string,
): { hits: HelpHit[]; total: number; hint?: string } {
  if (id) {
    const doc = all.find(d => d.id === id || d.title === id)
    if (!doc) return { hits: [], total: all.length, hint: `没有名为「${id}」的手册，可用的是：${all.map(d => d.id).join('、')}` }
    return {
      hits: [{ id: doc.id, title: doc.title, category: doc.category, snippet: doc.body.slice(0, 4000), score: 99 }],
      total: all.length,
    }
  }

  const terms = tokenize(query)
  if (terms.length === 0) return { hits: [], total: all.length, hint: '请给出更具体的关键词' }

  const hits: HelpHit[] = []
  for (const d of all) {
    const lowerTitle = d.title.toLowerCase()
    const lowerKeys = d.keywords.join(' ').toLowerCase()
    const lowerBody = d.body.toLowerCase()
    let score = 0
    for (const t of terms) {
      if (lowerTitle.includes(t)) score += 10
      else if (lowerKeys.includes(t)) score += 6
      if (lowerBody.includes(t)) score += 1
    }
    if (score > 0) {
      const first = terms.find(t => lowerBody.includes(t)) ?? terms[0]
      hits.push({ id: d.id, title: d.title, category: d.category, snippet: snippetOf(d.body, first), score })
    }
  }

  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
  const top = hits.slice(0, Math.max(1, Math.min(5, limit)))
  return {
    hits: top,
    total: all.length,
    ...(top.length === 0
      ? { hint: `未命中任何手册。现有手册：${all.map(d => d.title).join('、')}。若确实没有相关内容，如实说明，不要编造软件用法。` }
      : { hint: '以上为官方手册原文片段，回答时请以这些内容为准，并注明手册标题。' }),
  }
}
