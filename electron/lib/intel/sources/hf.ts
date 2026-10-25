import type { IntelItem } from '../../../../src/types'
import { fetchJson } from '../http'
import { intelDraft } from '../draft'

/**
 * HF Daily Papers（docs/intel-module-plan.md §1）：社区点赞筛选的每日 AI 论文。
 * 基址可配镜像（设置 intel.hfBase，默认 https://huggingface.co）——大陆直连不稳的退路。
 */
export async function fetchHf(limit: number, hfBase = 'https://huggingface.co'): Promise<IntelItem[]> {
  const base = hfBase.replace(/\/+$/, '')
  // 响应两种历史形态都兜：[{ paper: {...} }]（现行）与扁平 [{ title, ... }]
  type PaperShape = {
    id?: string; title?: string; summary?: string; upvotes?: number
    authors?: Array<{ name?: string }>; publishedAt?: string
  }
  type Row = { paper?: PaperShape; publishedAt?: string } & PaperShape
  const data = await fetchJson<Row[]>(`${base}/api/daily_papers?limit=${Math.min(Math.max(limit, 1), 50)}`)
  return (Array.isArray(data) ? data : []).slice(0, limit).map((row) => {
    const p = (row.paper && typeof row.paper === 'object' ? row.paper : row) as PaperShape
    const pid = String(p.id ?? '').trim()
    const title = String(p.title ?? '').replace(/\s+/g, ' ').trim()
    if (!pid || !title) return null
    const upvotes = p.upvotes ?? 0
    const t = row.publishedAt || p.publishedAt
    const td = t ? new Date(t) : null
    return intelDraft({
      source: 'hf',
    section: 'tech',
      kind: 'paper',
      title,
      url: `${base}/papers/${pid}`,
      author: (p.authors ?? []).slice(0, 3).map((a) => String(a.name ?? '')).filter(Boolean).join(', '),
      summary: String(p.summary ?? ''),
      stars: upvotes,
      publishedAt: td && Number.isFinite(td.getTime()) ? td.toISOString() : '',
      extra: { paperId: pid, upvotes },
    })
  }).filter((x): x is IntelItem => x !== null)
}
