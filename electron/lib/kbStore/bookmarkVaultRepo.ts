import { randomUUID } from 'crypto'
import { readJson, writeJson } from './jsonStore'

/**
 * 书签 vault 数据仓库（去库化 P2，.AGENT/docs/去库化迁移方案.md P2）
 *
 * 存储：.knowbase/modules/bookmarks/{categories.json, bookmarks.json}
 * 结构与 sql.js 表行一致（snake_case 原样保留，复用迁移器导出产物，
 * 避免双格式），对外 DTO 与 sqlite handler 对齐（camelCase）。
 */
export interface VaultCategory {
  id: string
  name: string
  color: string
  sortOrder: number
  createdAt: string
}
export interface VaultBookmark {
  id: string
  categoryId: string
  title: string
  url: string
  description: string
  sortOrder: number
  createdAt: string
  /** 星标收藏（2026-09-28：右栏快捷导航只显示 starred 条目）；缺省 = false */
  starred?: boolean
}

interface CatRow {
  id: string; name: string; color: string; sort_order: number; created_at: string
}
interface BmRow {
  id: string; category_id: string; title: string; url: string
  description: string; sort_order: number; created_at: string
  /** 新增可选字段，旧行缺省 = 未收藏（不写死进 JSON，保持存量文件干净） */
  starred?: boolean
}

const MOD = 'modules/bookmarks'

function catRow(d: VaultCategory): CatRow {
  return { id: d.id, name: d.name, color: d.color, sort_order: d.sortOrder, created_at: d.createdAt }
}
function bmRow(d: VaultBookmark): BmRow {
  return { id: d.id, category_id: d.categoryId, title: d.title, url: d.url, description: d.description, sort_order: d.sortOrder, created_at: d.createdAt, ...(d.starred ? { starred: true } : {}) }
}
function readCatRows(): CatRow[] { return readJson<CatRow[]>(MOD, 'categories.json', []) }
function readBmRows(): BmRow[] { return readJson<BmRow[]>(MOD, 'bookmarks.json', []) }

export function vaultBookmarksAll(): { categories: VaultCategory[]; bookmarks: VaultBookmark[] } {
  const cs = readCatRows().sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
  const bs = readBmRows().sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
  return {
    categories: cs.map((r) => ({ id: r.id, name: r.name, color: r.color, sortOrder: r.sort_order, createdAt: r.created_at })),
    bookmarks: bs.map((r) => ({ id: r.id, categoryId: r.category_id, title: r.title, url: r.url, description: r.description, sortOrder: r.sort_order, createdAt: r.created_at, starred: !!r.starred })),
  }
}

function saveCat(rows: CatRow[]): void { writeJson(MOD, 'categories.json', rows) }
function saveBm(rows: BmRow[]): void { writeJson(MOD, 'bookmarks.json', rows) }

export function vaultCreateCategory(name: string, color?: string): VaultCategory {
  const rows = readCatRows()
  const d: VaultCategory = { id: randomUUID(), name, color: color || '#3B82F6', sortOrder: Date.now(), createdAt: new Date().toISOString() }
  saveCat([...rows, catRow(d)])
  return d
}

export function vaultUpdateCategory(id: string, data: { name?: string; color?: string }): VaultCategory | null {
  const rows = readCatRows()
  const i = rows.findIndex((r) => r.id === id)
  if (i < 0) return null
  const next: CatRow = {
    ...rows[i],
    name: data.name !== undefined ? data.name : rows[i].name,
    color: data.color !== undefined ? data.color : rows[i].color,
  }
  rows[i] = next
  saveCat(rows)
  const r = rows[i]
  return { id: r.id, name: r.name, color: r.color, sortOrder: r.sort_order, createdAt: r.created_at }
}

export function vaultDeleteCategory(id: string): void {
  // 分类下的书签移入未分类，不删书签（与 sqlite 语义一致）
  const bs = readBmRows().map((b) => (b.category_id === id ? { ...b, category_id: '' } : b))
  saveBm(bs)
  saveCat(readCatRows().filter((c) => c.id !== id))
}

export function vaultReorderCategories(orderedIds: string[]): void {
  const rows = readCatRows()
  const base = Date.now()
  const byId = new Map(rows.map((r) => [r.id, r]))
  const next: CatRow[] = orderedIds.map((id, i) => {
    const r = byId.get(id)
    return r ? { ...r, sort_order: i + base - orderedIds.length } : r
  }).filter((x): x is CatRow => !!x)
  // 未列出的保留在原位后面
  const rest = rows.filter((r) => !orderedIds.includes(r.id))
  saveCat([...next, ...rest])
}

export function vaultCreateBookmark(data: { title: string; url: string; description?: string; categoryId?: string; starred?: boolean }): VaultBookmark {
  const rows = readBmRows()
  const d: VaultBookmark = {
    id: randomUUID(),
    categoryId: data.categoryId || '',
    title: data.title,
    url: data.url,
    description: data.description || '',
    sortOrder: Date.now(),
    createdAt: new Date().toISOString(),
    ...(data.starred ? { starred: true } : {}),
  }
  saveBm([...rows, bmRow(d)])
  return d
}

export function vaultUpdateBookmark(id: string, data: {
  title?: string; url?: string; description?: string; categoryId?: string | null; starred?: boolean
}): VaultBookmark | null {
  const rows = readBmRows()
  const i = rows.findIndex((r) => r.id === id)
  if (i < 0) return null
  const cur = rows[i]
  const starred = data.starred !== undefined ? data.starred : !!cur.starred
  const next: BmRow = {
    ...cur,
    title: data.title !== undefined ? data.title : cur.title,
    url: data.url !== undefined ? data.url : cur.url,
    description: data.description !== undefined ? data.description : cur.description,
    category_id: data.categoryId !== undefined ? (data.categoryId || '') : cur.category_id,
    ...(starred ? { starred: true } : {}),
  }
  if (!starred) delete next.starred
  rows[i] = next
  saveBm(rows)
  const r = rows[i]
  return { id: r.id, categoryId: r.category_id, title: r.title, url: r.url, description: r.description, sortOrder: r.sort_order, createdAt: r.created_at, starred }
}

export function vaultDeleteBookmark(id: string): void {
  saveBm(readBmRows().filter((b) => b.id !== id))
}
