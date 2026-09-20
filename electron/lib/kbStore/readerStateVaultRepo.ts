import { readJson, writeJsonOrThrow } from './jsonStore'
import {
  coerceReaderState, defaultReaderState, readerKey, readerKeyRel,
  sanitizeReaderPatch,
  type VaultReaderState, type VaultReaderStateStore,
} from './readerStateSchema'
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
  return raw ? coerceReaderState(raw, new Date().toISOString()) : null
}

/** 书架 join 用：当前仓库内所有有记录的书键 → 状态（按 rootId 前缀过滤，忽略其他仓库残留） */
export function readerStateListProgress(rootId: string): Record<string, VaultReaderState> {
  const id = String(rootId ?? '').trim()
  const prefix = `${id}/`
  if (!id) return {}
  const store = readStore()
  const out: Record<string, VaultReaderState> = {}
  for (const [key, raw] of Object.entries(store.books)) {
    if (!key.startsWith(prefix)) continue
    out[readerKeyRel(key)] = coerceReaderState(raw, new Date().toISOString())
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
  const clean = sanitizeReaderPatch(patch)
  if (!clean) return { ok: false, error: 'patch 字段非法（只收 pct 整数 0..100）' }
  const now = new Date().toISOString()
  const store = readStore()
  const prev = store.books[key] ? coerceReaderState(store.books[key], now) : defaultReaderState(now)
  if (typeof expectedUpdatedAt === 'string' && expectedUpdatedAt && prev.updatedAt !== expectedUpdatedAt) {
    return { ok: false, conflict: true, state: prev }
  }
  const next: VaultReaderState = { ...prev, ...clean, updatedAt: now }
  store.books[key] = next
  try {
    writeJsonOrThrow(MOD, F_STORE, store)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  return { ok: true, state: next }
}
