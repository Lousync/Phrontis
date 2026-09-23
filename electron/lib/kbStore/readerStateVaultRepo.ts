import { readJson, writeJsonOrThrow } from './jsonStore'
import {
  coerceReaderState, defaultReaderState, readerKey, readerKeyRel,
  sanitizeReaderPatch,
  type VaultReaderState, type VaultReaderStateStore,
} from './readerStateSchema'
import { bookKindOf } from './bookFormats'
import { getCurrentVault } from './vaultContext'

/**
 * 阅读状态 vault 仓库（书架升级全格式阅读器一期，方案 §S2.2）——
 * `.knowbase/modules/readerState.json` **唯一写方**。
 *
 * - TXT 进度：键 `{rootId}/{relPath}`（与 pdfBookKey 同口径），patch 带 `expectedUpdatedAt` 冲突检测（铁律 4）。
 * - 书架清单不落盘（自动库：扫描即清单，见 knowledgeIndex.scanVaultBooks）。
 * - IPC 转发层 = electron/database/repositories/readerStateRepo.ts（老目录名不是死代码，照既有模式）。
 * - 纯校验逻辑在 readerStateSchema.ts（零依赖，契约脚本直接 import）。
 */

const MOD = 'modules'
const F_STORE = 'readerState.json'

/**
 * kind 是 relPath 的纯函数（bookKindOf），故**每次读写都按路径重算**，不信存量值：
 * - 读：历史条目里 epub 曾被落成 'txt'（B 段之前 defaultReaderState 写死），重算即自愈；
 * - 写：客户端报什么都被覆盖，新格式首写不会再落错。
 * 未收录扩展名（.md 等非书文件误入）返回 undefined → 保留存量值。
 */
function kindOfPath(relPath: string) {
  return bookKindOf(relPath) ?? undefined
}

function emptyStore(): VaultReaderStateStore {
  return { version: 1, books: {} }
}

/** 读整个 store（损坏/缺失回落空 store；readJson 自带 corrupt 备份兜底） */
function readStore(): VaultReaderStateStore {
  const raw = readJson<VaultReaderStateStore>(MOD, F_STORE, emptyStore())
  if (!raw || typeof raw !== 'object' || typeof raw.books !== 'object' || raw.books === null) return emptyStore()
  return raw
}

/** rootId 必须是当前打开仓库（数据文件本身按 vault 隔离，跨仓库键一律拒绝） */
function requireCurrentRootId(rootId: string): void {
  const cur = getCurrentVault()
  if (!cur) throw new Error('当前没有打开的仓库')
  if (rootId !== cur.rootId) throw new Error('rootId 与当前仓库不一致')
}

// ===== 进度 =====

export function readerStateGetBook(rootId: string, relPath: string): VaultReaderState | null {
  const key = readerKey(rootId, relPath)
  if (!key) return null
  const store = readStore()
  const raw = store.books[key]
  return raw ? coerceReaderState(raw, new Date().toISOString(), kindOfPath(relPath)) : null
}

/** 书架 join 用：当前仓库内所有有记录的书键 → 状态（按 rootId 前缀过滤，忽略其他仓库残留） */
export function readerStateListProgress(rootId: string): Record<string, VaultReaderState> {
  const id = String(rootId ?? '').trim()
  const prefix = `${id}/`
  if (!id) return {}
  const store = readStore()
  const now = new Date().toISOString()
  const out: Record<string, VaultReaderState> = {}
  for (const [key, raw] of Object.entries(store.books)) {
    if (!key.startsWith(prefix)) continue
    const rel = readerKeyRel(key)
    out[rel] = coerceReaderState(raw, now, kindOfPath(rel))
  }
  return out
}

export interface ReaderStatePatchResult {
  ok: boolean
  state?: VaultReaderState
  conflict?: boolean
  error?: string
}

/**
 * 局部写回（铁律 4：expectedUpdatedAt 冲突检测）。
 * - 白名单外的键 / 非法值：整体拒绝（sanitizeReaderPatch）。
 * - expectedUpdatedAt 传了且与服务端不一致 → conflict:true（渲染层决策覆盖策略）。
 * - 写盘走 writeJsonOrThrow：失败必须抛错，不伪装成功。
 */
export function readerStatePatchBook(rootId: string, relPath: string, patch: unknown, expectedUpdatedAt?: string): ReaderStatePatchResult {
  const key = readerKey(rootId, relPath)
  if (!key) return { ok: false, error: '非法的书键' }
  try { requireCurrentRootId(rootId) } catch (e) { return { ok: false, error: (e as Error).message } }
  const derived = kindOfPath(relPath)
  // kind 先算出来再校验：书签的定位字段合法性依赖它（txt 要 paraIndex / foliate 系要 cfi）
  const clean = sanitizeReaderPatch(patch, derived)
  if (!clean) return { ok: false, error: 'patch 字段非法（只收 pct 整数 0..100 / 书签 / locator 串等白名单项；书签定位字段须与本书格式匹配）' }
  const now = new Date().toISOString()
  const store = readStore()
  const prev = store.books[key]
    ? coerceReaderState(store.books[key], now, derived)
    : defaultReaderState(now, derived ?? 'txt')
  if (typeof expectedUpdatedAt === 'string' && expectedUpdatedAt && prev.updatedAt !== expectedUpdatedAt) {
    return { ok: false, conflict: true, state: prev }
  }
  // kind 显式写回：prev 已是重算结果，此处只是让「kind 不可被 patch 覆盖」在代码里可见
  const next: VaultReaderState = { ...prev, ...clean, kind: derived ?? prev.kind, updatedAt: now }
  store.books[key] = next
  try {
    writeJsonOrThrow(MOD, F_STORE, store)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  return { ok: true, state: next }
}

// ===== 整本删除（彻底删书联动） =====

/**
 * 删掉一本书的进度 + 书签键（「删书 = 彻底删」的联动项之一）。
 * 键不存在即视为成功（幂等）——删书时书文件已在回收站，残留键的清理由调用方触发，
 * 与「文件在不在」无关。**不删书文件**（那是 ws:trash 的职责）。
 */
export function readerStateRemoveBook(rootId: string, relPath: string): { ok: boolean; error?: string } {
  const key = readerKey(rootId, relPath)
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
