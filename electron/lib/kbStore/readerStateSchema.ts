/**
 * readerState 数据 schema（书架升级全格式阅读器一期，方案 §S2.1）。
 *
 * 零依赖纯函数文件 —— 刻意不 import 任何 electron / fs 模块：
 * 契约脚本 `.AGENT/scripts/pdf-reader/verify-reader-formats.mjs` 用
 * `node --experimental-strip-types` 直接 import 本文件做用例验证。
 *
 * 存储：vault 级 `.knowbase/modules/readerState.json`（唯一写方 = readerStateVaultRepo.ts）：
 *   { version: 1, books: { "<rootId>/<relPath>": VaultReaderState } }
 * 书键口径与 pdfBookKey 完全一致（`{rootId}/{relPath}`，posix 化 / 拒空 / 拒绝对路径）。
 * 二期预留：VaultReaderState 加 `locator?: string`（foliate CFI 统一承载，一期不动）。
 */

import type { BookKind } from './bookFormats'

export interface VaultReaderState {
  kind: BookKind
  /** 阅读进度 0..100 整数（txt 按滚动位置反算） */
  pct: number
  /** 冲突检测基准（铁律 4 三件事之一）；patch 时服务端重新生成，客户端只读 */
  updatedAt: string
}

/** readerState.json 顶层（version + books） */
export interface VaultReaderStateStore {
  version: number
  books: Record<string, VaultReaderState>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 书键归一：posix 分隔、去首尾空白、去开头 ./；空分量拒绝返回空串（同 pdfBookKey 口径） */
export function readerKey(rootId: string, relPath: string): string {
  const id = String(rootId ?? '').trim()
  let rel = String(relPath ?? '').trim().replace(/\\/g, '/')
  while (rel.startsWith('./')) rel = rel.slice(2)
  if (!id || !rel || rel.startsWith('/')) return ''
  return `${id}/${rel}`
}

/** 从书键反解 relPath（rootId 之后的全部内容，可含目录分隔） */
export function readerKeyRel(key: string): string {
  const i = key.indexOf('/')
  return i < 0 ? '' : key.slice(i + 1)
}

/** patch 白名单：只收 pct；范围越界直接拒（整数 0..100），不静默夹取 */
export function sanitizeReaderPatch(patch: unknown): { pct?: number } | null {
  if (!isRecord(patch)) return null
  const out: { pct?: number } = {}
  let touched = false
  for (const k of Object.keys(patch)) {
    if (k !== 'pct') continue
    const v = patch[k]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100) return null
    out.pct = v
    touched = true
  }
  return touched ? out : null
}

/** 存量/新键的完整书状态：kind 非法回落 'txt'，pct 夹取 0..100 */
export function coerceReaderState(raw: unknown, now: string): VaultReaderState {
  if (!isRecord(raw)) return { kind: 'txt', pct: 0, updatedAt: now }
  const kind = raw['kind'] === 'pdf' ? 'pdf' : 'txt'
  const pct = typeof raw['pct'] === 'number' && Number.isFinite(raw['pct']) ? Math.min(100, Math.max(0, Math.round(raw['pct']))) : 0
  const updatedAt = typeof raw['updatedAt'] === 'string' && raw['updatedAt'] ? raw['updatedAt'] : now
  return { kind, pct, updatedAt }
}

/** 新键默认状态 */
export function defaultReaderState(now: string): VaultReaderState {
  return { kind: 'txt', pct: 0, updatedAt: now }
}
