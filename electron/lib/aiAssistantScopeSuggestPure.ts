/**
 * AI助手「描述圈选作用域」关键词匹配（v3.9.0，方案 §3.5）。
 *
 * 零依赖纯函数：把用户在主输入框写的一句话，匹配到仓库知识页（标题 / 路径 / 标签），
 * 返回候选 relPath 供渲染层出「作用域建议卡」。首期**不做向量检索 / 不调 LLM**——
 * 确定性、零成本、可被契约脚本直接验证。
 */

export interface ScopeSuggestEntry {
  relPath: string
  title: string
  tags?: string[]
  /** 'file' = 非 md 归档，不参与建议（同 AI 检索口径） */
  entryKind?: string
}

export interface ScopeSuggestion {
  relPath: string
  title: string
  score: number
}

/** 查询分词：空白 / 常见中英标点分隔；词长 ≥ 1 */
export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，、;；/\\|()（）\[\]【】{}<>"'`~!！?？:：]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 1)
}

/**
 * 展开匹配词：在分词基础上，对含中文的长词切出**二元组**。
 * 理由：中文查询常无空格（「把指针那篇整理一下」是一个 token），不切二元组就永远匹配不到标题里的「指针」。
 */
export function expandTerms(terms: string[]): string[] {
  const out = new Set<string>()
  for (const t of terms) {
    out.add(t)
    if (t.length >= 2 && /[\u4e00-\u9fff]/.test(t)) {
      for (let i = 0; i < t.length - 1; i++) {
        const bg = t.slice(i, i + 2)
        if (/[\u4e00-\u9fff]/.test(bg)) out.add(bg)
      }
    }
  }
  return [...out]
}

/**
 * 并列次序 —— **码点序**，不依赖 ICU / 运行时 locale（2026-10-19，台账 F-10 拍板：只改 AI 面）。
 *
 * 与 F-9（helpRetrieval 的并列兜底）同因：`localeCompare` 不传 locale 时按**机器语言**比较，
 * 于是同一份数据在不同 locale 的机器上行序不同。本条的落点是**建议作用域卡的行序**（用户可见）。
 * 判据：**给 AI 看的排序必须确定**（码点序），给人看的列表可以自然（那些走 'zh-Hans' 钉死档，
 * 如 src/lib/treeSort.ts）。导出以便契约脚本真跑（见 .AGENT/scripts/linux-port/verify-linux-port.mjs §H）。
 */
export function compareSuggestStable(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 匹配并排序：标题命中权重最高，其次标签，最后路径；只保留 score>0 */
export function suggestScope(query: string, entries: ScopeSuggestEntry[], limit = 8): ScopeSuggestion[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const terms = expandTerms(tokenizeQuery(query))
  const out: ScopeSuggestion[] = []
  for (const e of entries) {
    if (e.entryKind === 'file') continue
    const tl = e.title.toLowerCase()
    const pl = e.relPath.toLowerCase()
    const tags = (e.tags ?? []).map((t) => t.toLowerCase())
    let score = 0
    if (q.length >= 2 && tl.includes(q)) score += 6
    for (const term of terms) {
      if (tl.includes(term)) score += 3
      else if (pl.includes(term)) score += 1
      if (tags.some((t) => t.includes(term))) score += 2
    }
    if (score > 0) out.push({ relPath: e.relPath, title: e.title, score })
  }
  // 同分并列走码点序（见 compareSuggestStable）：行序不得随机器 locale 变
  out.sort((a, b) => (b.score - a.score)
    || compareSuggestStable(a.title, b.title)
    || compareSuggestStable(a.relPath, b.relPath))
  return out.slice(0, Math.max(1, limit))
}
