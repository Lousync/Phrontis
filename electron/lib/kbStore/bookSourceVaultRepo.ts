import { randomUUID } from 'crypto'
import { readJson, writeJsonOrThrow } from './jsonStore'
import { readSecret, writeSecret } from './secretStore'
import { getCurrentVault } from './vaultContext'
import {
  coerceBookSources, coerceCredentials, credentialSatisfies, emptyBookSources, emptyCredentials,
  isAllowedSourceUrl, sanitizeBookSourcePatch,
  type BookAuthType, type BookCredentialStore, type BookSource, type BookSourceCredential,
  type BookSourceMapping, type BookSourcePatch, type BookSourceStore,
} from './bookMarketSchema'

/**
 * 书源 vault 仓库（书市方案 §2.1 / §2.2）。
 *
 * - `.knowbase/modules/bookSources.json` —— 书源描述，**唯一写方**（本文件）。
 * - `.knowbase/secret/bookSources.json` —— 凭据密文，唯一写方也是本文件，走 `secretStore`
 *   （**不新造加密路径**；密钥 = 源 id，与 `BookAuthRef.ref` 同口径）。
 *
 * ★ 两条不许破的线：
 *   ① 凭据**永不**写进 bookSources.json（连键名都不留）—— 白名单拷贝在 schema 里做，这里只做落库；
 *   ② 出 IPC 的源描述一律走 `bookSourceInfos()`（`hasCredential: boolean` 而非凭据本体），
 *      `bookSourceList()` 是给主进程内部用的，**别直接桥给渲染层**。
 *
 * 纯校验逻辑在 bookMarketSchema.ts（零依赖，契约脚本直接 import）。
 * IPC 转发层 = electron/database/repositories/bookMarketRepo.ts（S3 接线），
 * 写盘后由**调用方**广播 `broadcastDataChanged('bookMarket')`（铁律 1）。
 */

const MOD = 'modules'
const F_SOURCES = 'bookSources.json'
const SECRET_MOD = 'secret'
const F_SECRET = 'bookSources.json'

/** 出渲染层的源描述（**无凭据本体**，只有「存没存」） */
export interface BookSourceInfo {
  id: string
  name: string
  kind: BookSource['kind']
  url: string
  authType: BookAuthType | null
  hasCredential: boolean
  enabled: boolean
  builtin: boolean
  mapping: BookSourceMapping | null
  createdAt: string
}

export interface BookSourceResult {
  ok: boolean
  source?: BookSource
  error?: string
}

/** rootId 必须是当前打开仓库（数据文件按 vault 隔离，跨仓库键一律拒绝） */
function requireCurrentRootId(rootId: string): void {
  const cur = getCurrentVault()
  if (!cur) throw new Error('当前没有打开的仓库')
  if (rootId !== cur.rootId) throw new Error('rootId 与当前仓库不一致')
}

function readSourceStore(): BookSourceStore {
  return coerceBookSources(readJson<unknown>(MOD, F_SOURCES, emptyBookSources()))
}

function writeSourceStore(store: BookSourceStore): void {
  writeJsonOrThrow(MOD, F_SOURCES, store)
}

function readCredentialStore(): BookCredentialStore {
  const raw = readSecret<unknown>(SECRET_MOD, F_SECRET)
  if (raw === null) return emptyCredentials()
  return coerceCredentials(raw)
}

/**
 * 写凭据密文。`writeSecret` 失败（无仓库 / safeStorage 不可用）必须让调用方知道 ——
 * 静默失败的表象是「凭据填了、连通性还是『需要凭据』」，比报错更难查。
 */
function writeCredentialStore(store: BookCredentialStore): void {
  if (!writeSecret(SECRET_MOD, F_SECRET, store)) {
    throw new Error('凭据写入失败（可能没有打开仓库，或系统安全存储不可用）')
  }
}

// ===== 读 =====

/** 主进程内部用：含 auth 引用。**不要**直接桥给渲染层（走 bookSourceInfos） */
export function bookSourceList(rootId: string): BookSource[] {
  try { requireCurrentRootId(rootId) } catch { return [] }
  return readSourceStore().sources
}

/** 出渲染层的清单：把凭据替换成 hasCredential 布尔 */
export function bookSourceInfos(rootId: string): BookSourceInfo[] {
  const sources = bookSourceList(rootId)
  if (sources.length === 0) return []
  const creds = readCredentialStore().creds
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    url: s.url,
    authType: s.auth?.type ?? null,
    hasCredential: !!s.auth && credentialSatisfies(s.auth.type, creds[s.auth.ref]),
    enabled: s.enabled,
    builtin: s.builtin,
    mapping: s.mapping,
    createdAt: s.createdAt,
  }))
}

/** 单条源（主进程内部用，含 auth 引用） */
export function bookSourceGet(rootId: string, id: string): BookSource | null {
  const sid = String(id ?? '').trim()
  if (!sid) return null
  return bookSourceList(rootId).find((s) => s.id === sid) ?? null
}

/**
 * 取凭据本体 —— **只在主进程网络层（S2 注入 Authorization 头）用**。
 * 任何把它送进 IPC / 日志 / 错误信息的地方都是缺陷。
 */
export function bookSourceCredentialFor(rootId: string, id: string): BookSourceCredential | null {
  const sid = String(id ?? '').trim()
  if (!sid) return null
  try { requireCurrentRootId(rootId) } catch { return null }
  return readCredentialStore().creds[sid] ?? null
}

export function bookSourceHasCredential(rootId: string, id: string): boolean {
  const src = bookSourceGet(rootId, id)
  if (!src?.auth) return false
  return credentialSatisfies(src.auth.type, bookSourceCredentialFor(rootId, id))
}

// ===== 写 =====

/**
 * 新建 / 更新书源。
 * - 新建（`id` 缺省）：必须给 `name` + 合法 `url`，否则拒绝（不建半成品）。
 * - 更新：只覆盖 patch 里出现的字段；`auth.ref` 恒被改写成源 id（引用不可能指向别处）。
 * - `patch.url` 非法 → **明确报错**（不是静默丢弃：用户输错了需要看见）。
 */
export function bookSourceUpsert(rootId: string, patch: unknown, id?: string): BookSourceResult {
  try { requireCurrentRootId(rootId) } catch (e) { return { ok: false, error: (e as Error).message } }
  const clean = sanitizeBookSourcePatch(patch)
  if (!clean) return { ok: false, error: 'patch 必须是对象' }
  const rawUrl = (patch as Record<string, unknown>).url
  if (rawUrl !== undefined && !isAllowedSourceUrl(rawUrl)) {
    return { ok: false, error: '书源地址只允许 http:// 或 https://' }
  }
  const now = new Date().toISOString()
  const store = readSourceStore()
  const sid = String(id ?? '').trim()
  const existing = sid ? store.sources.find((s) => s.id === sid) : undefined
  if (sid && !existing) return { ok: false, error: '书源不存在' }

  const patchTyped: BookSourcePatch = clean
  const merged: BookSource = existing
    ? { ...existing }
    : {
        id: randomUUID(),
        name: '',
        kind: 'custom',
        url: '',
        auth: null,
        enabled: true,
        builtin: false,
        mapping: null,
        createdAt: now,
      }
  if (patchTyped.name !== undefined) merged.name = patchTyped.name
  if (patchTyped.kind !== undefined) merged.kind = patchTyped.kind
  if (patchTyped.url !== undefined) merged.url = patchTyped.url
  if (patchTyped.enabled !== undefined) merged.enabled = patchTyped.enabled
  if (patchTyped.auth !== undefined) {
    // ref 恒等于源 id：凭据引用不可能指向别的源（也就无法借 A 源读 B 源的密钥）
    merged.auth = patchTyped.auth === null ? null : { type: patchTyped.auth.type, ref: merged.id }
  }
  // mapping 只对 custom 有意义；opds 走标准解析，留 mapping 只会误导
  if (patchTyped.mapping !== undefined) merged.mapping = patchTyped.mapping
  if (merged.kind === 'opds') merged.mapping = null

  if (!merged.name) return { ok: false, error: '书源名称不能为空' }
  if (!isAllowedSourceUrl(merged.url)) return { ok: false, error: '书源地址只允许 http:// 或 https://' }

  const sources = existing
    ? store.sources.map((s) => (s.id === merged.id ? merged : s))
    : [...store.sources, merged]
  try {
    writeSourceStore({ version: store.version, sources })
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  return { ok: true, source: merged }
}

/** 删除书源 + 顺手清掉它的凭据（不留孤儿密文） */
export function bookSourceRemove(rootId: string, id: string): BookSourceResult {
  try { requireCurrentRootId(rootId) } catch (e) { return { ok: false, error: (e as Error).message } }
  const sid = String(id ?? '').trim()
  if (!sid) return { ok: false, error: '缺少书源 id' }
  const store = readSourceStore()
  const target = store.sources.find((s) => s.id === sid)
  if (!target) return { ok: false, error: '书源不存在' }
  if (target.builtin) return { ok: false, error: '内置书源不可删除（可停用）' }
  try {
    writeSourceStore({ version: store.version, sources: store.sources.filter((s) => s.id !== sid) })
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  // 源没了，密钥留着就是孤儿；删失败不能反过来把已成功的删除报成失败 → 静默但记在返回值里
  try {
    const creds = readCredentialStore()
    if (creds.creds[sid]) {
      const next = { ...creds.creds }
      delete next[sid]
      writeCredentialStore({ version: creds.version, creds: next })
    }
  } catch { /* 密文清理失败不改变删除结果 */ }
  return { ok: true, source: target }
}

export function bookSourceSetEnabled(rootId: string, id: string, enabled: boolean): BookSourceResult {
  try { requireCurrentRootId(rootId) } catch (e) { return { ok: false, error: (e as Error).message } }
  const sid = String(id ?? '').trim()
  const store = readSourceStore()
  const target = store.sources.find((s) => s.id === sid)
  if (!target) return { ok: false, error: '书源不存在' }
  const next = { ...target, enabled: enabled !== false }
  try {
    writeSourceStore({ version: store.version, sources: store.sources.map((s) => (s.id === sid ? next : s)) })
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  return { ok: true, source: next }
}

/**
 * 存凭据（**唯一**的凭据入口）。密文落 `.knowbase/secret/bookSources.json`，
 * 书源描述只记 `auth:{type, ref}` —— 本函数绝不碰 bookSources.json。
 */
export function bookSourceSaveCredential(rootId: string, id: string, credential: unknown): BookSourceResult {
  try { requireCurrentRootId(rootId) } catch (e) { return { ok: false, error: (e as Error).message } }
  const sid = String(id ?? '').trim()
  const source = bookSourceGet(rootId, sid)
  if (!source) return { ok: false, error: '书源不存在' }
  const cred = coerceCredentials({ creds: { [sid]: credential } }).creds[sid]
  if (!cred) return { ok: false, error: '凭据不完整（basic 需用户名+密码，bearer 需 token）' }
  try {
    const store = readCredentialStore()
    writeCredentialStore({ version: store.version, creds: { ...store.creds, [sid]: cred } })
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  // 源上原本是「免认证」而现在要认证 → 补一条 auth 引用，否则取凭据时不知道该找哪把钥匙
  if (!source.auth) {
    const res = bookSourceUpsert(rootId, { auth: { type: cred.type, ref: sid } }, sid)
    if (!res.ok) return res
    return { ok: true, source: res.source }
  }
  return { ok: true, source }
}

/** 清凭据（保留源）—— 用于「换人 / 换机器后重输」 */
export function bookSourceClearCredential(rootId: string, id: string): BookSourceResult {
  try { requireCurrentRootId(rootId) } catch (e) { return { ok: false, error: (e as Error).message } }
  const sid = String(id ?? '').trim()
  const store = readCredentialStore()
  if (!store.creds[sid]) return { ok: true, source: bookSourceGet(rootId, sid) ?? undefined }
  const next = { ...store.creds }
  delete next[sid]
  try {
    writeCredentialStore({ version: store.version, creds: next })
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  return { ok: true, source: bookSourceGet(rootId, sid) ?? undefined }
}
