// R6 去库化（D9）：全局数据 = userData/data/*.json（sql.js 已移除）
import { app } from 'electron'
import { appendFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getPluginsRoot, auditWrite } from './pluginRegistry'
import { importPackToVault, packStateVault } from './knowledgePackVault'
import { invalidateKnowledgeIndex } from 'phrontis-core/kbStore/knowledgeIndex'
import { invalidateGraphIndex } from 'phrontis-core/kbStore/graphIndex'

/**
 * 内容型插件(knowledgePages)导入引擎。
 * 插件 zip 内携带 Markdown 页面集合,导入后在知识库批量创建 空间 → 笔记本 → 章节 → 页面。
 * 幂等:external_id + content_hash 判重;用户改过的页面默认跳过(可强制覆盖)。
 *
 * R6 去库化（D9）：原 sqlite 直写分支已移除 —— 知识包导入/状态查询的唯一目标
 * 是仓库 .knowbase（knowledgePackVault 引擎：categories.json / pack-imports.json / 仓库 .md）。
 * isVault 参数保留仅为兼容既有调用方签名，实际一律走 vault 引擎。
 */

interface KPPage { file: string; title: string; externalId: string; tags?: string[] }
interface KPChapter { name: string; pages: KPPage[] }
/** v2 多笔记本形态 */
interface KPNotebook { name: string; coverColor?: string; chapters: KPChapter[] }
/**
 * 兼容两种 manifest 形态:
 * - v1(单笔记本):{ notebook, coverColor?, chapters[] }
 * - v2(空间优先,多笔记本):{ space, notebooks:[{ name, chapters[] }] }
 * 解析后统一为 { spaceBase, notebooks }
 */
interface KPPackNormalized { spaceBase: string; notebooks: KPNotebook[] }
type KPPackRaw = {
  notebook?: unknown; space?: unknown; coverColor?: unknown; chapters?: unknown; notebooks?: unknown
}

function pluginDebugLog(line: string): void {
  try { appendFileSync(join(app.getPath('userData'), 'plugin-debug.log'), new Date().toISOString().slice(11, 23) + ' ' + line + '\n') } catch { /* ignore */ }
}

function parsePack(mf: { knowledgePages?: unknown }): KPPackNormalized | null {
  const kp = mf.knowledgePages as KPPackRaw | undefined
  if (!kp || typeof kp !== 'object') return null
  const isChapterArr = (v: unknown): v is KPChapter[] =>
    Array.isArray(v) && v.length > 0 && v.every(c => c && typeof c === 'object' && typeof (c as KPChapter).name === 'string' && Array.isArray((c as KPChapter).pages))
  // v2:space + notebooks[]
  if (Array.isArray(kp.notebooks) && kp.notebooks.length > 0) {
    const notebooks: KPNotebook[] = []
    for (const nb of kp.notebooks as unknown[]) {
      const n = nb as KPNotebook
      if (!n || typeof n !== 'object' || typeof n.name !== 'string' || !isChapterArr(n.chapters)) {
        pluginDebugLog(`[knowledgePack] notebook validation failed: name=${(n as KPNotebook)?.name} nameType=${typeof (n as KPNotebook)?.name} chaptersIsArr=${Array.isArray(n?.chapters)} chLen=${Array.isArray(n?.chapters) ? n.chapters.length : -1}`)
        return null
      }
      notebooks.push({ name: n.name, coverColor: typeof n.coverColor === 'string' ? n.coverColor : undefined, chapters: n.chapters })
    }
    const spaceBase = (typeof kp.space === 'string' && kp.space.trim()) || notebooks[0].name
    return { spaceBase, notebooks }
  }
  // v1:单笔记本
  if (typeof kp.notebook === 'string' && isChapterArr(kp.chapters)) {
    return { spaceBase: kp.notebook, notebooks: [{ name: kp.notebook, coverColor: typeof kp.coverColor === 'string' ? kp.coverColor : undefined, chapters: kp.chapters }] }
  }
  return null
}

// ---------- 状态查询 ----------

export function getPackState(pluginId: string, isVault = false): {
  ok: boolean
  state?: 'not-imported' | 'imported' | 'update-available'
  version?: string
  chapters?: number
  totalPages?: number
  newPages?: number
  changedPages?: number
  lastImportedAt?: string
  spaceId?: string | null
  notebookCount?: number
  spaceName?: string
  message?: string
} {
  void isVault // R6 去库化：读源恒为仓库（.knowbase），该开关已无 sqlite 分支可切
  try {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(pluginId)) return { ok: false, message: '插件 id 非法' }
    const pluginDir = join(getPluginsRoot(), pluginId)
    if (!existsSync(pluginDir)) return { ok: false, message: '插件未安装' }
    const parsed = readPackManifest(pluginDir)
    if ('error' in parsed) return { ok: false, message: parsed.error }
    const st = packStateVault(pluginId, parsed.pack, parsed.version, pluginDir)
    return st.ok ? { ...st, notebookCount: parsed.pack.notebooks.length } : st
  } catch (e: any) {
    return { ok: false, message: e?.message || String(e) }
  }
}

function readPackManifest(pluginDir: string): { pack: KPPackNormalized; version: string } | { error: string } {
  const mfPath = join(pluginDir, 'plugin.json')
  if (!existsSync(mfPath)) return { error: 'plugin.json 缺失' }
  let mf: any
  try { mf = JSON.parse(readFileSync(mfPath, 'utf-8')) } catch { return { error: 'plugin.json 解析失败' } }
  // 注意:parsePack 接收 contributes 子对象,knowledgePages 声明在 contributes 下
  const pack = parsePack((mf.contributes ?? {}) as { knowledgePages?: unknown })
  if (!pack) return { error: 'manifest 缺少有效的 knowledgePages 贡献' }
  return { pack, version: String(mf.version || '') }
}

// ---------- 导入 ----------

export function importPack(pluginId: string, overwriteModified: boolean, forceExternalIds?: string[], isVault = false): {
  ok: boolean
  created?: number; updated?: number; skipped?: number; conflicts?: { title: string; reason: string; externalId: string }[]
  spaceId?: string | null
  message?: string
} {
  void isVault // R6 去库化：导入目标恒为仓库 .knowbase，sqlite 直写分支已移除
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(pluginId)) return { ok: false, message: '插件 id 非法' }
  const pluginDir = join(getPluginsRoot(), pluginId)
  if (!existsSync(pluginDir)) return { ok: false, message: '插件未安装' }
  const mfParsed = readPackManifest(pluginDir)
  if ('error' in mfParsed) return { ok: false, message: mfParsed.error }
  // vault 引擎：批量写仓库 .md + .knowbase/modules/knowledge/*.json（幂等/更新/本地修改保护）
  const r = importPackToVault(pluginId, mfParsed.pack, mfParsed.version, pluginDir, overwriteModified, forceExternalIds)
  // 写 .md 后必须双失效：knowledge 索引（页面列表）+ graph 缓存（图谱节点/边），
  // 否则图谱读旧 graph.json —— 导入 408 空间后图谱为空的根因（2026-09-03 修复）
  if (r.ok) {
    invalidateKnowledgeIndex()
    invalidateGraphIndex()
    auditWrite(pluginId, 'pack.import', {
      version: mfParsed.version,
      created: r.created ?? 0, updated: r.updated ?? 0, skipped: r.skipped ?? 0,
      overwriteModified,
    })
  }
  return r
}
