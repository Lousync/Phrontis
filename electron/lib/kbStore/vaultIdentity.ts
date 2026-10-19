/**
 * 仓库身份（vault id）统一 —— 3.9.2。
 *
 * 背景：`pdfReader` / `readerState` / `excerpts` / `excerptExports` 的键都是 `{rootId}/{relPath}`，
 * 而 rootId 存在**设备级** settings 里、不写进仓库。同一个仓库在 Windows / Linux 各拿一个 id，
 * 阅读进度与摘录就分成两套（不是丢，是互相看不见）。
 *
 * 口径：
 * - 仓库身份以 `.knowbase/meta.json` 的 `id` 为唯一真相源；缺失时由**第一个打开它的设备**写入本地 id，
 *   另一设备打开时采纳它。
 * - 采纳后把各 store 里其它 UUID 前缀的键迁到当前 id；冲突按 `updatedAt`（导出映射按 `exportedAt`）
 *   取新，摘录按摘录 id 合并取新。
 * - 封面缓存按 `sha1(bookKey)` 命名，键迁移时同步改文件名。
 *
 * 本模块不依赖 Electron，契约脚本可直接 import（只用到 fs / path / crypto）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { createHash, randomUUID } from 'crypto'

export const VAULT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MODULES_DIR = join('.knowbase', 'modules')
const COVER_INDEX = join('.knowbase', 'cache', 'covers', 'index.json')
const COVER_DIR = join('.knowbase', 'cache', 'covers')

type StoreKind = 'pdf' | 'reader' | 'excerpt' | 'export'

const STORES: Array<{ file: string; kind: StoreKind }> = [
  { file: 'pdfReader.json', kind: 'pdf' },
  { file: 'readerState.json', kind: 'reader' },
  { file: 'excerpts.json', kind: 'excerpt' },
  { file: 'excerptExports.json', kind: 'export' },
]

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function tsOf(v: unknown, field: string): number {
  if (!isRecord(v)) return 0
  const raw = v[field]
  const t = typeof raw === 'string' ? Date.parse(raw) : NaN
  return Number.isFinite(t) ? t : 0
}

/** 键前缀是 UUID 才认（避免误伤用户自定义键） */
function keyPrefix(key: string): string | null {
  const i = key.indexOf('/')
  if (i <= 0) return null
  const p = key.slice(0, i)
  return VAULT_UUID_RE.test(p) ? p : null
}

function mergeExcerptBook(a: unknown, b: unknown): unknown {
  if (!isRecord(a)) return b
  if (!isRecord(b)) return a
  const out: Record<string, unknown> = { ...a }
  for (const [id, ex] of Object.entries(b)) {
    const cur = out[id]
    if (!cur || tsOf(ex, 'updatedAt') > tsOf(cur, 'updatedAt')) out[id] = ex
  }
  return out
}

function mergeValue(kind: StoreKind, existing: unknown, incoming: unknown): unknown {
  if (kind === 'excerpt') return mergeExcerptBook(existing, incoming)
  const field = kind === 'export' ? 'exportedAt' : 'updatedAt'
  return tsOf(incoming, field) > tsOf(existing, field) ? incoming : existing
}

/**
 * 把 store 里所有「非当前 id」的 UUID 前缀键迁到当前 id（纯函数，原地修改并返回条数）。
 * 幂等：迁移后再跑 changed=0。
 */
export function migrateStoreKeys<T>(store: T, currentId: string, kind: StoreKind): { store: T; changed: number } {
  if (!isRecord(store) || !isRecord(store.books) || !VAULT_UUID_RE.test(currentId)) return { store, changed: 0 }
  const books = store.books as Record<string, unknown>
  let changed = 0
  for (const key of Object.keys(books)) {
    const prefix = keyPrefix(key)
    if (!prefix || prefix === currentId) continue
    const rel = key.slice(prefix.length + 1)
    const next = `${currentId}/${rel}`
    const incoming = books[key]
    if (!(next in books)) books[next] = incoming
    else books[next] = mergeValue(kind, books[next], incoming)
    delete books[key]
    changed++
  }
  return { store, changed }
}

export interface CoverIndexEntry {
  mtimeMs: number
  file: string
}

/** 封面键迁移：返回新索引 + 需要改名的文件对 + 需要丢弃的旧文件（纯函数） */
export function migrateCoverIndex(
  index: Record<string, CoverIndexEntry>,
  currentId: string,
): { index: Record<string, CoverIndexEntry>; renames: Array<{ from: string; to: string }>; drops: string[]; changed: number } {
  const out: Record<string, CoverIndexEntry> = {}
  const renames: Array<{ from: string; to: string }> = []
  const drops: string[] = []
  let changed = 0
  if (!VAULT_UUID_RE.test(currentId)) return { index, renames, drops, changed }
  for (const [key, entry] of Object.entries(index)) {
    const prefix = keyPrefix(key)
    if (!prefix || prefix === currentId) {
      out[key] = entry
      continue
    }
    const rel = key.slice(prefix.length + 1)
    const next = `${currentId}/${rel}`
    const nextFile = `${createHash('sha1').update(next).digest('hex')}.png`
    if (out[next]) {
      // 目标键已存在：保留已有封面，旧文件丢弃
      if (entry?.file) drops.push(entry.file)
    } else {
      out[next] = { ...entry, file: nextFile }
      if (entry?.file && entry.file !== nextFile) renames.push({ from: entry.file, to: nextFile })
    }
    changed++
  }
  return { index: out, renames, drops, changed }
}

/** 原子写 JSON（与 jsonStore 同格式） */
function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomUUID()}`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  try {
    renameSync(tmp, path)
  } catch {
    if (existsSync(path)) unlinkSync(path)
    renameSync(tmp, path)
  }
}

/** 读仓库身份：`.knowbase/meta.json` 的 id（仅认 UUID） */
export function readVaultMetaId(rootPath: string): string | null {
  try {
    const p = join(rootPath, '.knowbase', 'meta.json')
    if (!existsSync(p)) return null
    const meta = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
    const id = meta['id']
    return typeof id === 'string' && VAULT_UUID_RE.test(id) ? id : null
  } catch {
    return null
  }
}

/**
 * 解析仓库身份：meta.id 优先；缺失时写入本地 id（第一个打开的设备决定）。
 * 返回最终 rootId。
 */
export function resolveVaultId(rootPath: string, localId: string): string {
  const existing = readVaultMetaId(rootPath)
  if (existing) return existing
  try {
    const p = join(rootPath, '.knowbase', 'meta.json')
    if (existsSync(p)) {
      const meta = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
      meta['id'] = localId
      writeJsonAtomic(p, meta)
    }
  } catch { /* meta 损坏：保持本地 id，ensureKbRoot 会兜底写入 */ }
  return localId
}

export interface VaultIdentityMigration {
  stores: number
  keys: number
  covers: number
  files: number
}

/**
 * 把仓库内所有按 rootId 分键的数据统一到 currentId。
 * 幂等、失败静默（返回已完成的部分）。
 */
export function migrateVaultIdentity(rootPath: string, currentId: string): VaultIdentityMigration {
  const result: VaultIdentityMigration = { stores: 0, keys: 0, covers: 0, files: 0 }
  if (!VAULT_UUID_RE.test(currentId)) return result

  for (const item of STORES) {
    const p = join(rootPath, MODULES_DIR, item.file)
    if (!existsSync(p)) continue
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as unknown
      const { store, changed } = migrateStoreKeys(raw, currentId, item.kind)
      if (changed > 0) {
        writeJsonAtomic(p, store)
        result.stores++
        result.keys += changed
      }
    } catch (e) {
      console.warn(`[vault-identity] ${item.file} 迁移失败（保持原样）:`, (e as Error)?.message || e)
    }
  }

  const coverPath = join(rootPath, COVER_INDEX)
  if (existsSync(coverPath)) {
    try {
      const raw = JSON.parse(readFileSync(coverPath, 'utf-8')) as unknown
      if (isRecord(raw)) {
        const { index, renames, drops, changed } = migrateCoverIndex(raw as Record<string, CoverIndexEntry>, currentId)
        if (changed > 0) {
          const dir = join(rootPath, COVER_DIR)
          for (const r of renames) {
            const from = join(dir, r.from)
            const to = join(dir, r.to)
            try {
              if (existsSync(from) && !existsSync(to)) renameSync(from, to)
            } catch { /* 缓存文件失败不影响索引 */ }
          }
          for (const f of drops) {
            try { unlinkSync(join(dir, f)) } catch { /* ignore */ }
          }
          writeJsonAtomic(coverPath, index)
          result.covers += changed
          result.files += renames.length
        }
      }
    } catch (e) {
      console.warn('[vault-identity] 封面索引迁移失败（保持原样）:', (e as Error)?.message || e)
    }
  }
  return result
}
