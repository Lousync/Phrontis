import type { IntelItem, IntelSourceKey } from '../../../src/types'
import { INTEL_SOURCE_KEYS, sortIntelItems } from '../../../src/lib/intelPure'
import { fetchGithub } from './sources/github'
import { fetchHn } from './sources/hn'
import { fetchArxiv } from './sources/arxiv'
import { fetchOpenAlex } from './sources/openalex'
import { fetchWeekly } from './sources/weekly'
import { fetchHf } from './sources/hf'
import { fetchLabs } from './sources/labs'
import { fetchQbitai } from './sources/qbitai'
import { buildIntelItems } from './pipeline'
import { intelFetchOpts, type IntelGetSetting } from './intelSettings'

/**
 * 一轮抓取编排（docs/intel-module-plan.md §4.1）：
 * Promise.allSettled 并行 8 源，**单源失败返回 []，绝不炸整轮**；
 * 失败源进 stats.failed（顶栏「Y 源失败」+ meta.lastFetchStats）。
 * GitHub 匿名限流 10 req/min —— 每轮只发 1 请求（github 源自身），不做重试轰炸。
 */

export interface IntelFetchStats {
  ok: IntelSourceKey[]
  failed: IntelSourceKey[]
}

export async function fetchAllIntelSources(get: IntelGetSetting): Promise<{
  items: IntelItem[]
  stats: IntelFetchStats
  added: number
}> {
  const opts = intelFetchOpts(get)
  const runners: Array<[IntelSourceKey, () => Promise<IntelItem[]>]> = [
    ['github', () => fetchGithub(opts.limit)],
    ['hn', () => fetchHn(opts.limit)],
    ['arxiv', () => fetchArxiv(opts.limit)],
    ['openalex', () => fetchOpenAlex(opts.limit)],
    ['weekly', () => fetchWeekly(opts.limit)],
    ['hf', () => fetchHf(opts.limit, opts.hfBase)],
    ['labs', () => fetchLabs(opts.limit)],
    ['qbitai', () => fetchQbitai(opts.limit)],
  ]
  const settled = await Promise.allSettled(
    runners.map(([key, run]) => (opts.enabled.has(key) ? run() : Promise.resolve<IntelItem[]>([]))),
  )
  const drafts: IntelItem[] = []
  const ok: IntelSourceKey[] = []
  const failed: IntelSourceKey[] = []
  settled.forEach((r, i) => {
    const key = runners[i][0]
    if (r.status === 'fulfilled') {
      ok.push(key)
      drafts.push(...r.value)
    } else {
      failed.push(key)
      console.warn(`[intel] source ${key} failed:`, String((r.reason as Error)?.message ?? r.reason).slice(0, 160))
    }
  })
  // 组装：营销过滤（可关）→ hash/id → 打分 → 批内去重；池排序按 score 降序
  const items = sortIntelItems(buildIntelItems(drafts, { spamFilter: opts.spamFilter }))
  return { items, stats: { ok, failed }, added: items.length }
}
