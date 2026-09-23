import { randomUUID } from 'crypto'
import { readJson, writeJsonOrThrow } from './jsonStore'
import {
  coerceExcerpt, excerptKey, sanitizeExcerptCreate, sanitizeExcerptPatch,
  type VaultExcerpt, type VaultExcerptStore,
} from './excerptSchema'
import { getCurrentVault } from './vaultContext'

/**
 * 摘录 vault 仓库（书架阅读器 · 摘录先行批次）——`.knowbase/modules/excerpts.json` **唯一写方**。
 *
 * - 键 `{rootId}/{relPath}`（与 pdfBookKey/readerKey 同口径），二级键 = 摘录 id（randomUUID）。
 * - patch 带 `expectedUpdatedAt` 冲突检测（铁律 4）；写盘走 writeJsonOrThrow 失败必抛。
 * - IPC 转发层 = electron/database/repositories/excerptRepo.ts。
 * - 纯校验逻辑在 excerptSchema.ts（零依赖，契约脚本直接 import）。
 */

const MOD = 'modules'
const F_STORE = 'excerpts.json'

function emptyStore(): VaultExcerptStore {
  return { version: 1, books: {} }
}

function readStore(): VaultExcerptStore {
  const raw = readJson<VaultExcerptStore>(MOD, F_STORE, emptyStore())
  if (!raw || typeof raw !== 'object' || typeof raw.books !== 'object' || raw.books === null) return emptyStore()
  return raw
}

function requireCurrentRootId(rootId: string): void {
  const cur = getCurrentVault()
  if (!cur) throw new Error('当前没有打开的仓库')
  if (rootId !== cur.rootId) throw new Error('rootId 与当前仓库不一致')
}

// ===== 读 =====

/** 单本书的全部摘录（at 升序 = 划选顺序） */
export function excerptList(rootId: string, relPath: string): VaultExcerpt[] {
  const key = excerptKey(rootId, relPath)
  if (!key) return []
  const store = readStore()
  const book = store.books[key]
  if (!book) return []
  const now = new Date().toISOString()
  const out: VaultExcerpt[] = []
  for (const raw of Object.values(book)) {
    const e = coerceExcerpt(raw, now)
    if (e) out.push(e)
  }
  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  return out
}

// ===== 写 =====

export interface ExcerptMutateResult {
  ok: boolean
  excerpt?: VaultExcerpt
  conflict?: boolean
  error?: string
}

/** 创建摘录（id/at/updatedAt 服务端生成） */
export function excerptCreate(rootId: string, relPath: string, payload: unknown): ExcerptMutateResult {
  const key = excerptKey(rootId, relPath)
  if (!key) return { ok: false, error: '非法的书键' }
  try { requireCurrentRootId(rootId) } catch (e) { return { ok: false, error: (e as Error).message } }
  const clean = sanitizeExcerptCreate(payload)
  if (!clean) return { ok: false, error: '摘录载荷非法（kind/page/paraIndex/text 校验不过）' }
  const now = new Date().toISOString()
  const excerpt: VaultExcerpt = { ...clean, id: randomId(), at: now, updatedAt: now }
  const store = readStore()
  if (!store.books[key]) store.books[key] = {}
  store.books[key][excerpt.id] = excerpt
  try {
    writeJsonOrThrow(MOD, F_STORE, store)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  return { ok: true, excerpt }
}

/** 备注 patch（expectedUpdatedAt 冲突检测） */
export function excerptPatch(rootId: string, relPath: string, id: string, patch: unknown, expectedUpdatedAt?: string): ExcerptMutateResult {
  const key = excerptKey(rootId, relPath)
  if (!key || !String(id ?? '').trim()) return { ok: false, error: '非法的书键或摘录 id' }
  try { requireCurrentRootId(rootId) } catch (e) { return { ok: false, error: (e as Error).message } }
  const clean = sanitizeExcerptPatch(patch)
  if (!clean) return { ok: false, error: 'patch 字段非法（只收 note 字符串）' }
  const now = new Date().toISOString()
  const store = readStore()
  const prev = store.books[key]?.[String(id)]
  const coerced = prev ? coerceExcerpt(prev, now) : null
  if (!coerced) return { ok: false, error: '摘录不存在' }
  if (typeof expectedUpdatedAt === 'string' && expectedUpdatedAt && coerced.updatedAt !== expectedUpdatedAt) {
    return { ok: false, conflict: true, excerpt: coerced }
  }
  const next: VaultExcerpt = { ...coerced, ...clean, updatedAt: now }
  store.books[key][String(id)] = next
  try {
    writeJsonOrThrow(MOD, F_STORE, store)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  return { ok: true, excerpt: next }
}

/** 删除摘录 */
export function excerptDelete(rootId: string, relPath: string, id: string): ExcerptMutateResult {
  const key = excerptKey(rootId, relPath)
  if (!key || !String(id ?? '').trim()) return { ok: false, error: '非法的书键或摘录 id' }
  try { requireCurrentRootId(rootId) } catch (e) { return { ok: false, error: (e as Error).message } }
  const store = readStore()
  const book = store.books[key]
  if (!book || !book[String(id)]) return { ok: false, error: '摘录不存在' }
  delete book[String(id)]
  if (Object.keys(book).length === 0) delete store.books[key]
  try {
    writeJsonOrThrow(MOD, F_STORE, store)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  return { ok: true }
}

/**
 * 删掉一本书的**全部摘录**（彻底删书联动）。幂等：该书无摘录即成功。
 * ⚠️ 摘录是用户创作内容，且**回收站救不回**（它在 JSON 里，不在书文件里）——调用方（删书确认框）
 * 必须把它写进提示文案。
 */
export function excerptDeleteBook(rootId: string, relPath: string): ExcerptMutateResult {
  const key = excerptKey(rootId, relPath)
  if (!key) return { ok: false, error: '非法的书键' }
  try { requireCurrentRootId(rootId) } catch (e) { return { ok: false, error: (e as Error).message } }
  const store = readStore()
  if (!store.books[key]) return { ok: true }
  delete store.books[key]
  try {
    writeJsonOrThrow(MOD, F_STORE, store)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  return { ok: true }
}

/** 摘录 id：node crypto UUID（与知识库 frontmatter id 同源口径） */
function randomId(): string {
  return randomUUID()
}
