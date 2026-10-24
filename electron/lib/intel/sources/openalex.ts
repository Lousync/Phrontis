import type { IntelItem } from '../../../../src/types'
import { fetchJson } from '../http'
import { intelDraft } from '../draft'

/**
 * OpenAlex 论文（docs/intel-module-plan.md §1）：全学科开放学术索引，免 Key。
 * abstract 是倒排索引（abstract_inverted_index），这里重排回正读文本。
 */
export async function fetchOpenAlex(limit: number): Promise<IntelItem[]> {
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
  const n = Math.min(Math.max(limit, 1), 50)
  const url = `https://api.openalex.org/works?filter=from_publication_date:${since}&sort=cited_by_count:desc&per-page=${n}&mailto=phrontis@local`
  type Work = {
    id?: string; doi?: string | null; title?: string | null; display_name?: string | null
    publication_date?: string; cited_by_count?: number
    authorships?: Array<{ author?: { display_name?: string } }>
    primary_location?: { landing_page_url?: string | null } | null
    abstract_inverted_index?: Record<string, number[]> | null
  }
  const data = await fetchJson<{ results?: Work[] }>(url)
  return (data.results ?? []).slice(0, n).map((w) => {
    const title = String(w.title ?? w.display_name ?? '').trim()
    const landing = String(w.primary_location?.landing_page_url ?? '').trim()
    const doi = String(w.doi ?? '').trim()
    const link = /^https?:\/\//.test(landing) ? landing : (/^https?:\/\//.test(doi) ? doi : String(w.id ?? ''))
    if (!title || !/^https?:\/\//.test(link)) return null
    // 倒排索引重建摘要（词 → 出现位置数组）
    let abstract = ''
    const inv = w.abstract_inverted_index
    if (inv && typeof inv === 'object') {
      const slots: Array<[number, string]> = []
      for (const [word, pos] of Object.entries(inv)) {
        if (!Array.isArray(pos)) continue
        for (const p of pos) slots.push([p, word])
      }
      abstract = slots.sort((a, b) => a[0] - b[0]).map(([, wd]) => wd).join(' ')
    }
    const t = w.publication_date ? new Date(w.publication_date) : null
    return intelDraft({
      source: 'openalex',
      kind: 'paper',
      title,
      url: link,
      author: (w.authorships ?? []).slice(0, 3).map((a) => String(a.author?.display_name ?? '')).filter(Boolean).join(', '),
      summary: abstract,
      tags: [],
      stars: w.cited_by_count ?? 0,
      publishedAt: t && Number.isFinite(t.getTime()) ? t.toISOString() : '',
      extra: { citedBy: w.cited_by_count ?? 0 },
    })
  }).filter((x): x is IntelItem => x !== null)
}
