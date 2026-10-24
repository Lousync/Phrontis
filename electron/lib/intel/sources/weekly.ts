import type { IntelItem } from '../../../../src/types'
import { fetchJson, fetchText } from '../http'
import { intelDraft } from '../draft'

/**
 * 阮一峰周刊（docs/intel-module-plan.md §1）：GitHub contents API 取最新一期，
 * 条目 = 期内的文章 / 工具链接（plan D 决策；抓完存 cache 时随 prune 清理）。
 * 走 GitHub 匿名 API —— fetchAll 里与 github 源共用每轮低请求量纪律（各 1 请求 + 1 次正文拉取）。
 */
export async function fetchWeekly(limit: number): Promise<IntelItem[]> {
  const files = await fetchJson<Array<{ name?: string; download_url?: string }>>(
    'https://api.github.com/repos/ruanyf/weekly/contents/docs',
  )
  const issues = (files ?? [])
    .map((f) => ({ name: String(f.name ?? ''), url: String(f.download_url ?? '') }))
    .filter((f) => /^issue-\d+\.md$/i.test(f.name) && /^https?:\/\//.test(f.url))
    .map((f) => ({ num: Number(f.name.match(/(\d+)/)?.[1] ?? 0), url: f.url }))
    .filter((f) => f.num > 0)
    .sort((a, b) => b.num - a.num)
  if (!issues.length) return []
  const md = await fetchText(issues[0].url)
  const lines = md.split(/\r?\n/)

  const out: IntelItem[] = []
  const skipRe = /^https?:\/\/(www\.)?github\.com\/ruanyf\/weekly/i
  for (let i = 0; i < lines.length && out.length < Math.min(Math.max(limit, 1), 50); i++) {
    const line = lines[i]
    // 周刊条目形如「1、[标题](https://…)」，图片是 `![..](..)`（行首多一个 ! 不匹配）
    const m = line.match(/^\s*\d+[、.．]\s*\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\s*(.*)$/)
    if (!m) continue
    const title = m[1].trim()
    const link = m[2]
    if (!title || skipRe.test(link)) continue
    // 描述：行内余文（剥掉「（英文）」类标注）；没有就看下一行非链接的纯文本
    let desc = m[3].replace(/^（[^）]*）/, '').replace(/（[^）]*）$/, '').trim()
    if (!desc) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const nxt = lines[j].trim()
        if (!nxt) continue
        if (/^[!#>|*\-\d]/.test(nxt) || /\]\(https?:\/\//.test(nxt)) break
        desc = nxt; i = j
        break
      }
    }
    out.push(intelDraft({
      source: 'weekly',
      kind: 'weekly',
      title,
      url: link,
      author: 'ruanyf',
      summary: desc,
      tags: ['周刊'],
      extra: { issue: issues[0].num },
    }))
  }
  return out
}
