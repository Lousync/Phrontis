import { ipcMain } from 'electron'
import { getCurrentVault } from './kbStore/vaultContext'
import { readJson, writeJson } from './kbStore/jsonStore'

/**
 * AI教学 · 左栏「收藏」（v3.6.0 新功能）。
 *
 * 把「跨课时的活文档」（如会持续扩充的缩写表）手动钉住，左栏顶部一条细行里随手翻到。
 * 课时/知识点总结仍走课程结构，不进收藏。
 *
 * - 存储：`.knowbase/modules/aiTeaching/favorites.json`（随仓库走，vault = 真相源）；
 * - 按工作区分组；`rel` = **仓库相对路径**（唯一口径，打开直接走 openArtFile）；
 * - 最近钉的在前（addedAt 倒序）。
 */

export interface AiTeachFavorite {
  /** 仓库相对路径 */
  rel: string
  name: string
  addedAt: string
}

interface FavStore {
  v: 1
  byWs: Record<string, AiTeachFavorite[]>
}

const KEY = 'favorites.json'
const MODULE = 'modules/aiTeaching'

let cache: FavStore | null = null
let cacheVault: string | null = null

function store(): FavStore | null {
  const vault = getCurrentVault()
  if (!vault) return null
  if (cache && cacheVault === vault.rootPath) return cache
  const s = readJson<FavStore>(MODULE, KEY, { v: 1, byWs: {} })
  if (!s.byWs || typeof s.byWs !== 'object') s.byWs = {}
  cache = s
  cacheVault = vault.rootPath
  return cache
}

function persist(s: FavStore): void {
  writeJson(MODULE, KEY, s)
}

/** 某工作区的收藏（最近钉的在前） */
export function listFavorites(wsId: string): AiTeachFavorite[] {
  const s = store()
  if (!s || !wsId) return []
  const rows = s.byWs[wsId]
  return Array.isArray(rows) ? rows : []
}

/** 钉住一份文档（幂等：同 rel 已存在则前置并刷新时间）；返回该工作区最新收藏列表 */
export function addFavorite(wsId: string, rel: string, name: string): AiTeachFavorite[] {
  const s = store()
  if (!s || !wsId || !rel) return listFavorites(wsId)
  const rows = (s.byWs[wsId] ?? []).filter((r) => r.rel !== rel)
  rows.unshift({ rel, name: name || rel.split('/').pop() || rel, addedAt: new Date().toISOString() })
  s.byWs[wsId] = rows
  persist(s)
  return rows
}

/** 取消收藏；返回该工作区最新收藏列表 */
export function removeFavorite(wsId: string, rel: string): AiTeachFavorite[] {
  const s = store()
  if (!s || !wsId || !rel) return listFavorites(wsId)
  const rows = (s.byWs[wsId] ?? []).filter((r) => r.rel !== rel)
  s.byWs[wsId] = rows
  persist(s)
  return rows
}

export function registerAiTeachingFavoriteHandlers(_getSetting: (key: string) => unknown): void {
  ipcMain.handle('aiTeachFav:list', (_e, wsId: string) => listFavorites(String(wsId ?? '')))
  ipcMain.handle('aiTeachFav:add', (_e, wsId: string, rel: string, name: string) =>
    addFavorite(String(wsId ?? ''), String(rel ?? ''), String(name ?? '')))
  ipcMain.handle('aiTeachFav:remove', (_e, wsId: string, rel: string) =>
    removeFavorite(String(wsId ?? ''), String(rel ?? '')))
}
