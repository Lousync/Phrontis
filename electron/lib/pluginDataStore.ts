// R6 去库化（D9）：全局数据 = userData/data/*.json（sql.js 已移除）
import { globalReadJson, globalWriteJson } from 'phrontis-core/globalJsonStore'

/**
 * 插件数据表存储（C 级插件能力 `data`）。
 *
 * 设计原则：
 * 1) 命名空间隔离：逻辑表名固定为 plugin_<safePluginId>_<safeTable>，插件只能访问自己声明的表
 * 2) 不暴露任意 SQL：只提供结构化 CRUD（insert / update / delete / query），
 *    表名与列名一律白名单校验，杜绝注入与越权
 * 3) 行数上限：查询默认 200 行、硬上限 1000 行，防止拖垮主进程
 *
 * 存储：userData/data/plugin-data.json —— 按物理表名分桶，桶内 rows 每行携带 rowid
 * （对齐原 sqlite rowid 语义），next_rowid 单调递增保证删除后不复用。
 */

const SAFE_NAME_RE = /^[a-z][a-z0-9_]{0,40}$/
const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 200

const DATA_FILE = 'plugin-data.json'

/** 单张插件表的存储桶 */
interface PluginTableData {
  next_rowid: number
  rows: Record<string, unknown>[]
}

type PluginDataFile = Record<string, PluginTableData>

function readAllData(): PluginDataFile {
  return globalReadJson<PluginDataFile>(DATA_FILE, {})
}

function writeAllData(data: PluginDataFile): void {
  globalWriteJson(DATA_FILE, data)
}

/** 去掉行内 rowid（原 SELECT * 不含 rowid） */
function stripRowid(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (k === 'rowid') continue
    out[k] = v
  }
  return out
}

/** 插件表的列定义（manifest.contributes.tables[].columns[]） */
export interface PluginColumnDef {
  name: string
  type: string
  notNull?: boolean
  default?: string
}

/** 插件表的索引定义 */
export interface PluginIndexDef {
  name?: string
  columns: string[]
  unique?: boolean
}

/** 插件表声明（manifest.contributes.tables[]） */
export interface PluginTableDef {
  name: string
  columns: PluginColumnDef[]
  indexes?: PluginIndexDef[]
}

/** 允许的列类型（白名单；仅作声明校验，JSON 存储按原值落盘） */
const ALLOWED_TYPES = new Set(['TEXT', 'INTEGER', 'REAL', 'BLOB'])

export function isSafeName(name: string): boolean {
  return SAFE_NAME_RE.test(name)
}

/** 插件 ID → 安全的表名片段（非字母数字转下划线） */
export function safePluginId(pluginId: string): string {
  return pluginId.replace(/[^a-z0-9]/gi, '_').toLowerCase()
}

/** 物理表名（= JSON 存储桶键）：plugin_<id>_<table>；非法输入返回 null */
export function physicalTable(pluginId: string, table: string): string | null {
  if (!isSafeName(table)) return null
  return `plugin_${safePluginId(pluginId)}_${table}`
}

/** 校验表定义：表名/列名合法、列类型在白名单内 */
export function validateTableDef(def: unknown): { ok: true; table: PluginTableDef } | { ok: false; error: string } {
  if (!def || typeof def !== 'object') return { ok: false, error: 'table 定义缺失' }
  const d = def as Partial<PluginTableDef>
  if (typeof d.name !== 'string' || !isSafeName(d.name)) {
    return { ok: false, error: '表名非法（需 ^[a-z][a-z0-9_]{1,41}$）' }
  }
  if (!Array.isArray(d.columns) || d.columns.length === 0) return { ok: false, error: `${d.name}: 列定义为空` }
  const columns: PluginColumnDef[] = []
  for (const c of d.columns) {
    if (!c || typeof c.name !== 'string' || !isSafeName(c.name)) return { ok: false, error: `${d.name}: 列名非法` }
    const type = String(c.type || '').toUpperCase().trim()
    if (!ALLOWED_TYPES.has(type)) return { ok: false, error: `${d.name}.${c.name}: 列类型只允许 TEXT/INTEGER/REAL/BLOB` }
    columns.push({ name: c.name, type, notNull: !!c.notNull, default: c.default })
  }
  const indexes: PluginIndexDef[] = []
  for (const idx of Array.isArray(d.indexes) ? d.indexes! : []) {
    if (!idx || !Array.isArray(idx.columns)) continue
    const cols = idx.columns.filter(c => typeof c === 'string' && isSafeName(c))
    if (cols.length === 0) continue
    indexes.push({ name: idx.name, columns: cols, unique: !!idx.unique })
  }
  return { ok: true, table: { name: d.name!, columns, indexes } }
}

/** 建表（JSON 存储按需自动建桶，无需预建结构；保留幂等签名供安装/启用时调用） */
export function ensurePluginTables(pluginId: string, tables: PluginTableDef[]): void {
  void pluginId
  void tables
}

/** 删表（卸载时调用）：移除存储桶 */
export function dropPluginTables(pluginId: string, tables: PluginTableDef[]): void {
  const data = readAllData()
  let changed = false
  for (const t of tables) {
    const phys = physicalTable(pluginId, t.name)
    if (!phys || !(phys in data)) continue
    delete data[phys]
    changed = true
  }
  if (changed) writeAllData(data)
}

/** 插件声明的表结构（用于列名白名单） */
function tableDefOf(pluginId: string, tables: PluginTableDef[], logicalTable: string): PluginTableDef | null {
  void pluginId
  return tables.find(t => t.name === logicalTable) ?? null
}

export type WhereCond = { column: string; op?: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'like'; value: unknown }

/** LIKE 模式匹配：% 任意串、_ 单字符（对齐 SQLite LIKE，ASCII 不区分大小写） */
function likeMatch(value: unknown, pattern: unknown): boolean {
  const s = String(value ?? '')
  const p = String(pattern ?? '')
  const re = new RegExp(
    '^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '[\\s\\S]*').replace(/_/g, '[\\s\\S]') + '$',
    'i'
  )
  return re.test(s)
}

/** 值比较：同为数字按数值序，否则按字符串序（近似原 SQL 比较语义） */
function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const as = String(a ?? '')
  const bs = String(b ?? '')
  return as < bs ? -1 : as > bs ? 1 : 0
}

/** 构造行过滤器（列名白名单 + 条数上限 8） */
function buildRowFilter(def: PluginTableDef, where: WhereCond[] | undefined): ((row: Record<string, unknown>) => boolean) | null {
  if (!where || where.length === 0) return null
  const colNames = new Set(def.columns.map(c => c.name))
  const conds = where.slice(0, 8).filter(w => w && typeof w.column === 'string' && colNames.has(w.column))
  if (conds.length === 0) return null
  return (row) => conds.every(w => {
    const v = row[w.column] ?? null
    const target = w.value ?? null
    switch (w.op ?? '=') {
      case '=': return v === target
      case '!=': return v !== target
      case '>': return compareValues(v, target) > 0
      case '<': return compareValues(v, target) < 0
      case '>=': return compareValues(v, target) >= 0
      case '<=': return compareValues(v, target) <= 0
      case 'like': return likeMatch(v, target)
      default: return v === target
    }
  })
}

/** 查询（结构化，列名白名单 + 行数上限） */
export function pluginQuery(pluginId: string, tables: PluginTableDef[], logicalTable: string, opts?: {
  where?: WhereCond[]
  orderBy?: string
  desc?: boolean
  limit?: number
}): unknown[] {
  const def = tableDefOf(pluginId, tables, logicalTable)
  const phys = physicalTable(pluginId, logicalTable)
  if (!def || !phys) return []
  const td = readAllData()[phys]
  if (!td) return []
  const colNames = new Set(def.columns.map(c => c.name))
  const filter = buildRowFilter(def, opts?.where)
  let rows = filter ? td.rows.filter(filter) : [...td.rows]
  if (opts?.orderBy && colNames.has(opts.orderBy)) {
    const key = opts.orderBy
    const dir = opts.desc ? -1 : 1
    rows.sort((a, b) => compareValues(a[key], b[key]) * dir)
  }
  const limit = Math.min(Math.max(Number(opts?.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  return rows.slice(0, limit).map(stripRowid)
}

/** 插入一行（列名白名单，只写声明过的列） */
export function pluginInsert(pluginId: string, tables: PluginTableDef[], logicalTable: string, row: Record<string, unknown>): { ok: boolean; id?: string } {
  const def = tableDefOf(pluginId, tables, logicalTable)
  const phys = physicalTable(pluginId, logicalTable)
  if (!def || !phys) return { ok: false }
  const colNames = new Set(def.columns.map(c => c.name))
  const keys = Object.keys(row || {}).filter(k => colNames.has(k))
  if (keys.length === 0) return { ok: false }
  const data = readAllData()
  const td = data[phys] ?? { next_rowid: 1, rows: [] }
  const rowid = td.next_rowid
  const stored: Record<string, unknown> = { rowid }
  for (const k of keys) stored[k] = row[k] ?? null
  td.rows.push(stored)
  data[phys] = { next_rowid: rowid + 1, rows: td.rows }
  writeAllData(data)
  return { ok: true, id: String(rowid) }
}

/** 按 rowid 更新 */
export function pluginUpdate(pluginId: string, tables: PluginTableDef[], logicalTable: string, rowId: string | number, patch: Record<string, unknown>): { ok: boolean } {
  const def = tableDefOf(pluginId, tables, logicalTable)
  const phys = physicalTable(pluginId, logicalTable)
  if (!def || !phys) return { ok: false }
  const colNames = new Set(def.columns.map(c => c.name))
  const keys = Object.keys(patch || {}).filter(k => colNames.has(k))
  if (keys.length === 0) return { ok: false }
  const rid = Number(rowId)
  const data = readAllData()
  const td = data[phys]
  const row = td?.rows.find(r => r.rowid === rid)
  if (!td || !row) return { ok: false }
  for (const k of keys) row[k] = patch[k] ?? null
  writeAllData(data)
  return { ok: true }
}

/** 按 rowid 删除 */
export function pluginDelete(pluginId: string, tables: PluginTableDef[], logicalTable: string, rowId: string | number): { ok: boolean } {
  const phys = physicalTable(pluginId, logicalTable)
  if (!tableDefOf(pluginId, tables, logicalTable) || !phys) return { ok: false }
  const rid = Number(rowId)
  const data = readAllData()
  const td = data[phys]
  if (!td) return { ok: false }
  const before = td.rows.length
  const rows = td.rows.filter(r => r.rowid !== rid)
  if (rows.length === before) return { ok: false }
  data[phys] = { next_rowid: td.next_rowid, rows }
  writeAllData(data)
  return { ok: true }
}

/** 导出整表（卸载前备份用；含 rowid，对齐原 SELECT rowid AS rowid, * 语义） */
export function pluginDumpTable(pluginId: string, tables: PluginTableDef[], logicalTable: string): unknown[] {
  const phys = physicalTable(pluginId, logicalTable)
  if (!tableDefOf(pluginId, tables, logicalTable) || !phys) return []
  const td = readAllData()[phys]
  if (!td) return []
  return td.rows.slice(0, MAX_LIMIT)
}
