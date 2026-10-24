import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { broadcastDataChanged } from '../../main/windowBus'
import { getVaultKbRoot } from '../kbStore/vaultContext'
import { readJson, writeJsonOrThrow, kbModulePath } from '../kbStore/jsonStore'
import { sanitizeFileName } from '../workspaceManager'
import { extractArticle } from '../clipperServer/extract'
import type { IntelAiFilter, IntelAiRec, IntelItem, IntelMeta, IntelRefreshResult, IntelSourceKey } from '../../../src/types'
import { mergeIntelPool, pruneIntelPool, capIntelPool, sortIntelItems } from '../../../src/lib/intelPure'
import { fetchAllIntelSources } from './fetchAll'
import type { IntelGetSetting } from './intelSettings'
import { intelKeepDays } from './intelSettings'

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
  return sortIntelItems(readJson<IntelItem[]>(MOD, 'items.json', []))
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
  return { meta: next, scope: only ?? 'all', added, failedSources: stats.failed }
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
