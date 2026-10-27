import type { IntelItem, IntelSourceKey } from '../../../src/types'
import { INTEL_SOURCE_KEYS, sortIntelItems, SOURCE_META } from '../../../src/lib/intelPure'
import { fetchGithub } from './sources/github'
import { fetchHn } from './sources/hn'
import { fetchArxiv } from './sources/arxiv'
import { fetchOpenAlex } from './sources/openalex'
import { fetchWeekly } from './sources/weekly'
import { fetchHf } from './sources/hf'
import { fetchLabs } from './sources/labs'
import { fetchQbitai } from './sources/qbitai'
import { fetchCnblogs } from './sources/cnblogs'
import { fetchCsdn } from './sources/csdn'
import { fetchChinanews, fetchChinanewsWorld } from './sources/chinanews'
import { fetchWallstcn } from './sources/wallstcn'
import { fetchCustomSource } from './sources/custom'
import { intelListCustomSources } from './customSources'
import { buildIntelItems } from './pipeline'
import { intelFetchOpts, type IntelGetSetting } from './intelSettings'

/**
 * 一轮抓取编排（docs/intel-module-plan.md §4.1 v2）：
 * Promise.allSettled 并行 13 内置源 + 启用的自定义 RSS 源，**单源失败返回 []，绝不炸整轮**；
 * 失败源进 stats.failed（顶栏「Y 源失败」+ meta.lastFetchStats）。
 * GitHub 匿名限流 10 req/min —— 每轮只发 1 请求（github 源自身），不做重试轰炸。
 */

export interface IntelFetchStats {
  ok: string[]
  failed: string[]
}

/**
 * @param only 只抓这一个源（单源刷新语义：左栏停在某个源时，刷新按钮只刷它；
 *   v2 起可为 custom:<id>）。该源在设置/自定义列表中关闭时抛错（用户意图与配置冲突，给明确提示）。
 */
export async function fetchAllIntelSources(get: IntelGetSetting, only?: string): Promise<{
  items: IntelItem[]
  stats: IntelFetchStats
  added: number
}> {
  const opts = intelFetchOpts(get)
  const customs = intelListCustomSources().filter((c) => c.enabled)
  const onlyCustomId = only?.startsWith('custom:') ? only.slice('custom:'.length) : null
  if (only && onlyCustomId) {
    if (!customs.some((c) => c.id === onlyCustomId)) {
      throw new Error('该自定义源不存在或已停用（设置 › 模块 › 情报 › 自定义 RSS 源）')
    }
  } else if (only && INTEL_SOURCE_KEYS.includes(only as IntelSourceKey)) {
    if (!opts.enabled.has(only as IntelSourceKey)) {
      throw new Error(`「${SOURCE_META[only as IntelSourceKey]?.label ?? only}」已在设置中关闭（设置 › 模块 › 情报）`)
    }
  } else if (only) {
    only = undefined // 非法键当全量
  }

  const all: Array<[string, () => Promise<IntelItem[]>]> = [
    ['github', () => fetchGithub(opts.limit)],
    ['hn', () => fetchHn(opts.limit)],
    ['arxiv', () => fetchArxiv(opts.limit)],
    ['openalex', () => fetchOpenAlex(opts.limit)],
    ['weekly', () => fetchWeekly(opts.limit)],
    ['hf', () => fetchHf(opts.limit, opts.hfBase)],
    ['labs', () => fetchLabs(opts.limit)],
    ['qbitai', () => fetchQbitai(opts.limit)],
    ['cnblogs', () => fetchCnblogs(opts.limit)],
    ['csdn', () => fetchCsdn(opts.limit)],
    ['chinanews', () => fetchChinanews(opts.limit)],
    ['chinanews_world', () => fetchChinanewsWorld(opts.limit)],
    ['wallstcn', () => fetchWallstcn(opts.limit)],
  ]
  // 自定义源：单源轮只跑指定那个；全量轮全部参与
  for (const cs of onlyCustomId ? customs.filter((c) => c.id === onlyCustomId) : !only ? customs : []) {
    all.push([`custom:${cs.id}`, () => fetchCustomSource(cs, opts.limit)])
  }

  const runners = only && !onlyCustomId ? all.filter(([key]) => key === only) : all
  const settled = await Promise.allSettled(
    runners.map(([key, run]) =>
      onlyCustomId || key.startsWith('custom:') || opts.enabled.has(key as IntelSourceKey)
        ? run()
        : Promise.resolve<IntelItem[]>([])),
  )
  const drafts: IntelItem[] = []
  const ok: string[] = []
  const failed: string[] = []
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
  // 组装：营销过滤（可关，自定义源同样生效）→ hash/id → 打分 → 批内去重；池排序按 score 降序
  const items = sortIntelItems(buildIntelItems(drafts, { spamFilter: opts.spamFilter }))
  return { items, stats: { ok, failed }, added: items.length }
}
