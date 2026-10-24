import type { IntelItem, IntelSourceKey } from '../../../src/types'
import { intelHash, intelIdOf, intelScore, intelSpam } from '../../../src/lib/intelPure'
import { intelDraft } from './draft'
/**
 * 情报管线（docs/intel-module-plan.md §4.2）：清洗 → 打分 → hash/去重。
 * 打分与清洗逻辑都在纯函数 src/lib/intelPure.ts（三方共用），本文件只做组装。
 */

export interface IntelPipelineOptions {
  /** 营销水文过滤（设置 intel.filter，默认开） */
  spamFilter?: boolean
  /** 抓取时刻（ISO；缺省 now） */
  now?: string
}

/** 雏形 → 可入库条目：补 hash/id/fetchedAt，过营销拦截，打质量分；批内按 hash 去重（保先到） */
export function buildIntelItems(drafts: IntelItem[], opts: IntelPipelineOptions = {}): IntelItem[] {
  const nowIso = opts.now ?? new Date().toISOString()
  const seen = new Set<string>()
  const out: IntelItem[] = []
  for (const d of drafts) {
    if (!d.url || !/^https?:\/\//i.test(d.url) || !d.title) continue
    if (opts.spamFilter !== false && intelSpam(d.title, d.summary)) continue
    const hash = intelHash(d.url)
    if (seen.has(hash)) continue
    seen.add(hash)
    const item: IntelItem = { ...d, hash, id: intelIdOf(d.url), fetchedAt: nowIso, fav: false }
    item.score = intelScore(item)
    out.push(item)
  }
  return out
}

/** 兜底雏形（单元 / 契约脚本造数据用）：只填必填，其余走 intelDraft 默认 */
export function makeDraft(p: Parameters<typeof intelDraft>[0]): IntelItem {
  return intelDraft(p)
}

/** 单源抓取结果（fetchAll 汇总用） */
export interface SourceFetchResult {
  source: IntelSourceKey
  drafts: IntelItem[]
}
