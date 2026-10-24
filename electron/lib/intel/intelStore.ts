import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { broadcastDataChanged } from '../../main/windowBus'
import { getVaultKbRoot } from '../kbStore/vaultContext'
import { readJson, writeJsonOrThrow, kbModulePath } from '../kbStore/jsonStore'
import { sanitizeFileName } from '../workspaceManager'
import { extractArticle } from '../clipperServer/extract'
import type { IntelAiFilter, IntelAiRec, IntelItem, IntelMeta, IntelRefreshResult, IntelSourceKey, IntelTranslateResult } from '../../../src/types'
import { mergeIntelPool, pruneIntelPool, capIntelPool, sortIntelItems, isEnglishText } from '../../../src/lib/intelPure'
import { fetchAllIntelSources } from './fetchAll'
import type { IntelGetSetting } from './intelSettings'
import { intelKeepDays } from './intelSettings'
import {
  mergeItemZh, serializeTranslate, translateSession, translateBudgetOf, translateBatch, persistTranslations,
  TITLE_BATCH, SUMMARY_BATCH, PREHEAT_TITLES, plainKeyOf, existingPlainKeys,
  isKeyPoisoned, markKeyFailed, markSkippedId, isSkippedId,
} from './translate'

/**
 * 情报模块唯一真相源（docs/intel-module-plan.md §4.3）。
 *
 * 落盘（jsonStore，MOD = 'modules/intel'，写用 writeJsonOrThrow）：
 *   items.json            全量池（score 降序）
 *   meta.json             AI 推荐 + 抓取统计 + AI 筛选态
 *   articles/<itemId>.json 正文缓存（惰性写：首次打开文章才提取；随 prune 清理；**不广播**）
 *
 * IPC handler 与 AI 工具共用本层导出的业务函数（铁律 2：不给 .knowbase 开写白名单）。
 * 主进程写盘后必须 windowBus.broadcastDataChanged('intel')（铁律 1；正文缓存除外）。
 */

const MOD = 'modules/intel'
const POOL_CAP = 2000

// ===== 读取 =====

export function intelItemsAll(): IntelItem[] {
  // 读取边界统一合并卡片译文（titleZh/summaryZh 为运行时字段，不落 intel.json；intel-translate-plan §2）
  return mergeItemZh(sortIntelItems(readJson<IntelItem[]>(MOD, 'items.json', [])))
}

export function intelReadMeta(): IntelMeta {
  const m = readJson<Partial<IntelMeta>>(MOD, 'meta.json', {})
  return {
    aiRec: m.aiRec ?? null,
    lastFetchAt: m.lastFetchAt ?? '',
    lastFetchStats: m.lastFetchStats,
    aiFilter: m.aiFilter,
  }
}

function readItemById(id: string): IntelItem | null {
  return intelItemsAll().find((it) => it.id === id) ?? null
}

// ===== 写入（用户可见变更，写后广播）=====

/** 合并一轮原始条目：按 hash 去重；已存在只更新热度类字段（stars/score/publishedAt），fav 原样保留 */
export function intelMergeItems(raw: IntelItem[]): { added: number } {
  if (!raw.length) return { added: 0 }
  const pool = readJson<IntelItem[]>(MOD, 'items.json', [])
  // 池运算（去重 / 热度字段更新 / fav 豁免）在纯函数 mergeIntelPool（契约脚本直跑同一实现）
  const merged = mergeIntelPool(pool, raw)
  writeJsonOrThrow(MOD, 'items.json', merged.pool)
  return { added: merged.added }
}

/** 过期清理：按 fetchedAt 清（fav 豁免），同时清 articles/ 下失联缓存；再按 score 截断上限 */
export function intelPrune(keepDays: number): { removed: number } {
  const pool = readJson<IntelItem[]>(MOD, 'items.json', [])
  const finalPool = capIntelPool(pruneIntelPool(pool, keepDays), POOL_CAP)
  const removed = pool.length - finalPool.length
  if (removed > 0) {
    writeJsonOrThrow(MOD, 'items.json', sortIntelItems(finalPool))
    // 失联正文缓存随清（尽力而为，不抛错——正文缓存不是真相源）
    const liveIds = new Set(finalPool.map((it) => it.id))
    const dir = kbModulePath(MOD, 'articles')
    if (dir && existsSync(dir)) {
      try {
        for (const name of readdirSync(dir)) {
          const id = name.replace(/\.json$/i, '')
          if (!liveIds.has(id)) {
            try { unlinkSync(join(dir, name)) } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    }
  }
  return { removed }
}

export function intelToggleFav(id: string): IntelItem | null {
  const pool = readJson<IntelItem[]>(MOD, 'items.json', [])
  const it = pool.find((x) => x.id === id)
  if (!it) return null
  it.fav = !it.fav
  it.favAt = it.fav ? new Date().toISOString() : undefined
  writeJsonOrThrow(MOD, 'items.json', pool)
  broadcastDataChanged('intel')
  return it
}

export function intelSetAiRec(rec: IntelAiRec): boolean {
  const meta = intelReadMeta()
  writeJsonOrThrow(MOD, 'meta.json', { ...meta, aiRec: { ...rec, updatedAt: rec.updatedAt || new Date().toISOString() } })
  broadcastDataChanged('intel')
  return true
}

export function intelClearAiRec(): boolean {
  const meta = intelReadMeta()
  if (!meta.aiRec) return true
  writeJsonOrThrow(MOD, 'meta.json', { ...meta, aiRec: null })
  broadcastDataChanged('intel')
  return true
}

export function intelSetAiFilter(filter: { kind: 'paper' | 'chinese' | ''; kw: string }): boolean {
  const meta = intelReadMeta()
  const next: IntelAiFilter = { kind: filter.kind === 'paper' || filter.kind === 'chinese' ? filter.kind : '', kw: String(filter.kw ?? '').slice(0, 80), updatedAt: new Date().toISOString() }
  writeJsonOrThrow(MOD, 'meta.json', { ...meta, aiFilter: next })
  broadcastDataChanged('intel')
  return true
}

// ===== 一轮抓取 =====

export async function intelRefresh(get: IntelGetSetting, only?: IntelSourceKey): Promise<IntelRefreshResult> {
  if (!getVaultKbRoot()) throw new Error('请先打开仓库')
  const { items, stats, added } = await fetchAllIntelSources(get, only)
  intelMergeItems(items)
  intelPrune(intelKeepDays(get))
  const meta = intelReadMeta()
  let next: IntelMeta = { ...meta, lastFetchAt: new Date().toISOString() }
  if (only) {
    // 单源轮：lastFetchStats 只更新该源的成败归属，其余源保持上轮全量抓取的记录
    const prevOk = new Set(meta.lastFetchStats?.ok ?? [])
    const prevFailed = new Set(meta.lastFetchStats?.failed ?? [])
    for (const k of stats.ok) { prevOk.add(k); prevFailed.delete(k) }
    for (const k of stats.failed) { prevFailed.add(k); prevOk.delete(k) }
    next = { ...next, lastFetchStats: { ok: [...prevOk], failed: [...prevFailed], added: meta.lastFetchStats?.added ?? 0 } }
  } else {
    next = { ...next, lastFetchStats: { ok: stats.ok as IntelSourceKey[], failed: stats.failed as IntelSourceKey[], added } }
  }
  writeJsonOrThrow(MOD, 'meta.json', next)
  broadcastDataChanged('intel')
  // 预热卡片译题（idle、fire-and-forget；单源轮也跑——增量条目同样受益，内容寻址缓存零重复翻译）
  preheatTranslateTitles(get)
  return { meta: next, scope: only ?? 'all', added, failedSources: stats.failed }
}

// ===== 卡片英文自动翻译（docs/intel-translate-plan.md §4）=====

let zhBroadcastTimer: ReturnType<typeof setTimeout> | undefined
/** 译文落库后的合并广播（400ms 防抖：一次 IPC 可能拆多次 LLM 批，避免列表反复 refetch 抖动） */
function broadcastZhSoon(): void {
  if (zhBroadcastTimer !== undefined) return
  zhBroadcastTimer = setTimeout(() => {
    zhBroadcastTimer = undefined
    broadcastDataChanged('intel')
  }, 400)
}

function zeroTranslateResult(reason: 'off' | 'noModel' | 'budget'): IntelTranslateResult {
  return { translated: 0, cachedHit: 0, skippedChinese: 0, failed: 0, disabled: true, reason }
}

/** 任务切成 title/summary 批串行执行；configFail = 配置类失败（调用方据此熔断会话） */
async function runTaskChunks(
  tasks: Array<{ kind: 'title' | 'summary'; text: string }>,
  budgetRoom: number,
): Promise<{ translated: number; failed: number; configFail: boolean }> {
  const sizeOf = (k: 'title' | 'summary') => (k === 'title' ? TITLE_BATCH : SUMMARY_BATCH)
  const byKind: Record<'title' | 'summary', string[]> = { title: [], summary: [] }
  let used = 0
  for (const t of tasks) {
    if (used >= budgetRoom) break
    byKind[t.kind].push(t.text)
    used++
  }
  let translated = 0
  let failed = 0
  for (const kind of ['title', 'summary'] as const) {
    const texts = byKind[kind]
    for (let i = 0; i < texts.length; i += sizeOf(kind)) {
      const chunk = texts.slice(i, i + sizeOf(kind))
      const r = await translateBatch(chunk, kind)
      if (r.ok) {
        translated += persistTranslations(kind, chunk, r.out, r.model)
        broadcastZhSoon()
      } else if (r.configFail) {
        return { translated, failed, configFail: true }
      } else {
        for (const text of chunk) markKeyFailed(plainKeyOf(text))
        failed += chunk.length
      }
    }
  }
  return { translated, failed, configFail: false }
}

/** 卡片可见即译（intel:translate）：await 全流程后返回统计；译文经 broadcastZhSoon → 渲染层 reload 合并 */
export async function intelTranslateItems(get: IntelGetSetting, ids: string[]): Promise<IntelTranslateResult> {
  if (get('intel.translateOn') === false) return zeroTranslateResult('off')
  return serializeTranslate(() => translateItemsLocked(get, ids))
}

async function translateItemsLocked(get: IntelGetSetting, ids: string[]): Promise<IntelTranslateResult> {
  const budget = translateBudgetOf(get)
  if (translateSession.disabledReason === 'noModel') return zeroTranslateResult('noModel')
  if (translateSession.translatedCount >= budget) return zeroTranslateResult('budget')

  const want = new Set(ids)
  const zhKeys = existingPlainKeys()
  const queued = new Set<string>()
  const tasks: Array<{ kind: 'title' | 'summary'; text: string }> = []
  let cachedHit = 0
  let skippedChinese = 0
  for (const it of readJson<IntelItem[]>(MOD, 'items.json', [])) {
    if (!want.has(it.id) || isSkippedId(it.id)) continue
    let en = 0      // 英文文本数（=0 即中文条目）
    let handled = 0 // 有产出的英文文本数（缓存命中或已入队；=0 说明全部毒化）
    for (const [kind, text] of [['title', it.title], ['summary', it.summary]] as Array<['title' | 'summary', string]>) {
      if (!text || !isEnglishText(text)) continue
      en++
      const key = plainKeyOf(text)
      if (zhKeys.has(key)) {
        cachedHit++
        handled++
      } else if (!isKeyPoisoned(key) && !queued.has(text)) {
        queued.add(text)
        tasks.push({ kind, text })
        handled++
      }
    }
    if (en === 0) skippedChinese++
    if (handled === 0) markSkippedId(it.id) // 中文条目 / 全毒化：本会话不再对其发请求
  }

  const room = Math.max(budget - translateSession.translatedCount, 0)
  const run = room > 0 ? tasks.slice(0, room) : []
  const r = run.length ? await runTaskChunks(run, room) : { translated: 0, failed: 0, configFail: false }
  if (r.configFail) translateSession.disabledReason = 'noModel'
  const result: IntelTranslateResult = { translated: r.translated, cachedHit, skippedChinese, failed: r.failed }
  if (r.configFail) return { ...result, disabled: true, reason: 'noModel' }
  if (translateSession.translatedCount >= budget) return { ...result, disabled: true, reason: 'budget' }
  return result
}

/** 刷新后 idle 预热 top-N 英文条目标题（一批；失败静默——预热绝不打扰刷新语义） */
function preheatTranslateTitles(get: IntelGetSetting): void {
  void serializeTranslate(async () => {
    if (get('intel.translateOn') === false) return
    if (translateSession.disabledReason === 'noModel') return
    const budget = translateBudgetOf(get)
    if (translateSession.translatedCount >= budget) return
    const zhKeys = existingPlainKeys()
    const seen = new Set<string>()
    const texts: string[] = []
    for (const it of sortIntelItems(readJson<IntelItem[]>(MOD, 'items.json', []))) {
      if (texts.length >= PREHEAT_TITLES) break
      const t = it.title
      if (!t || !isEnglishText(t) || seen.has(t)) continue
      const key = plainKeyOf(t)
      if (zhKeys.has(key) || isKeyPoisoned(key)) continue
      seen.add(t)
      texts.push(t)
    }
    if (!texts.length) return
    const r = await translateBatch(texts, 'title')
    if (r.ok) {
      persistTranslations('title', texts, r.out, r.model)
      broadcastZhSoon()
    } else if (r.configFail) {
      translateSession.disabledReason = 'noModel'
    } else {
      for (const t of texts) markKeyFailed(plainKeyOf(t))
    }
  }).catch(() => undefined)
}

// ===== 正文（惰性缓存；不广播）=====

export async function intelGetArticle(id: string): Promise<{ md: string; url: string; title: string; cached: boolean } | { error: string }> {
  const item = readItemById(id)
  if (!item) return { error: '该条情报已过期（可能已被清理）' }
  const cachePath = kbModulePath(MOD, `articles/${id}.json`)
  if (cachePath && existsSync(cachePath)) {
    const cached = readJson<{ url: string; title: string; md: string; fetchedAt: string }>(MOD, `articles/${id}.json`, { url: '', title: '', md: '', fetchedAt: '' })
    if (cached.md) return { md: cached.md, url: item.url, title: item.title, cached: true }
  }
  if (!/^https?:\/\//i.test(item.url)) return { error: '链接不支持提取' }
  const { fetchText } = await import('./http')
  const { stripDangerous } = await import('../clipperServer/sanitize')
  try {
    const html = await fetchText(item.url, 15000)
    const ext = await extractArticle(stripDangerous(html), item.url)
    const md = String(ext?.markdown ?? '').trim()
    if (!md || md.length < 40) return { error: '该站点正文无法在应用内提取（动态渲染 / 反爬 / 登录墙），可「打开原文」兜底' }
    if (cachePath) {
      try {
        mkdirSync(join(cachePath, '..'), { recursive: true })
        const tmp = `${cachePath}.${process.pid}.tmp`
        writeFileSync(tmp, JSON.stringify({ url: item.url, title: item.title, md, fetchedAt: new Date().toISOString() }), 'utf-8')
        renameSync(tmp, cachePath)
      } catch { /* 缓存写失败不影响本次阅读 */ }
    }
    return { md, url: item.url, title: item.title, cached: false }
  } catch (err) {
    return { error: `正文提取失败：${String((err as Error)?.message ?? err).slice(0, 160)}` }
  }
}

// ===== 存为笔记（走 clipper 草稿通道；编辑器是唯一正文写入方，铁律 2）=====

export async function intelSaveAsNote(id: string): Promise<{ ok: true; relPath: string; title: string } | { ok: false; error: string }> {
  const item = readItemById(id)
  if (!item) return { ok: false, error: '该条情报已过期' }
  const art = await intelGetArticle(id)
  if ('error' in art) return { ok: false, error: art.error }
  const root = getVaultKbRoot()
  if (!root) return { ok: false, error: '请先打开仓库' }
  const title = item.title.replace(/\s+/g, ' ').trim().slice(0, 120) || '未命名情报'
  const safe = sanitizeFileName(title) || 'untitled'
  const dirAbs = join(root, '.knowbase', '_draft', 'intel')
  mkdirSync(dirAbs, { recursive: true })
  let fileName = `${new Date().toISOString().slice(0, 10)}-${safe}.md`
  if (existsSync(join(dirAbs, fileName))) fileName = `${new Date().toISOString().slice(0, 10)}-${safe}-${String(Date.now()).slice(-6)}.md`
  // frontmatter 用 JSON 引号安全转义（同 clipperServer.frontmatter 手法）
  const head = '---\n' + [
    `source: ${JSON.stringify(item.url)}`,
    `title: ${JSON.stringify(title)}`,
    `saved: ${JSON.stringify(new Date().toISOString())}`,
    `intel_source: ${JSON.stringify(item.source)}`,
    'clipper: true',
  ].join('\n') + '\n---\n\n'
  const doc = `${head}# ${title}\n\n> 情报存档 · [原文](${item.url}) · ${new Date().toLocaleString()}\n\n${art.md}\n\n<!-- 情报草稿：无 frontmatter.id 不进知识索引/图谱；整理后补 id 并移入库内即转正 -->\n`
  const abs = join(dirAbs, fileName)
  const tmp = join(dirAbs, `.${fileName}.${process.pid}.tmp`)
  writeFileSync(tmp, doc, 'utf-8')
  renameSync(tmp, abs)
  return { ok: true, relPath: `.knowbase/_draft/intel/${fileName}`, title }
}

// ===== AI 注入快照辅助（agentService buildIntelInjection 消费）=====

export function intelPoolStats(): { total: number; perSource: Array<[IntelSourceKey, number]>; fav: number } {
  const pool = intelItemsAll()
  const per = new Map<IntelSourceKey, number>()
  let fav = 0
  for (const it of pool) {
    per.set(it.source, (per.get(it.source) ?? 0) + 1)
    if (it.fav) fav++
  }
  return { total: pool.length, perSource: [...per.entries()], fav }
}
