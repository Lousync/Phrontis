import type { IntelItem } from '../../../../src/types'
import { fetchJson } from '../http'
import { intelDraft } from '../draft'

/**
 * GitHub 新晋高星（docs/intel-module-plan.md §1）：Search API 按创建时间 + star 过滤，
 * 匿名限流 10 req/min —— **每轮只发这 1 个请求**（fetchAll 保证），429 由统计降级不重试轰炸。
 */
export async function fetchGithub(limit: number): Promise<IntelItem[]> {
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
  const q = `created:>${since} stars:>20`
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q).replace(/%20/g, '+')}&sort=stars&order=desc&per_page=${Math.min(Math.max(limit, 1), 50)}`
  type GhRepo = {
    full_name?: string; html_url?: string; description?: string | null
    stargazers_count?: number; forks_count?: number; language?: string | null
    topics?: string[]; created_at?: string; owner?: { login?: string }
  }
  const data = await fetchJson<{ items?: GhRepo[] }>(url, 12000, { Accept: 'application/vnd.github+json' })
  return (data.items ?? []).slice(0, limit).map((r) => {
    const fullName = String(r.full_name ?? '').trim()
    const url2 = String(r.html_url ?? '').trim()
    if (!fullName || !/^https?:\/\//.test(url2)) return null
    return intelDraft({
      source: 'github',
      kind: 'repo',
      title: fullName,
      url: url2,
      author: String(r.owner?.login ?? fullName.split('/')[0] ?? ''),
      summary: String(r.description ?? ''),
      tags: [r.language ?? '', ...(r.topics ?? [])].map(String).filter(Boolean),
      stars: r.stargazers_count ?? undefined,
      publishedAt: r.created_at ?? '',
      extra: { forks: r.forks_count ?? 0, language: r.language ?? '' },
    })
  }).filter((x): x is IntelItem => x !== null)
}
