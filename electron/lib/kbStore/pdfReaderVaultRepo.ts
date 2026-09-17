import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { basename, join } from 'path'
import { exists, kbModulePath, readJson, writeJsonOrThrow } from './jsonStore'
import {
  coerceBookState, defaultBookState, pdfBookKey, pdfKeyRel,
  sanitizeBookPatch,
  type VaultBookState, type VaultCoverIndexEntry, type VaultPdfReaderStore,
} from './pdfReaderSchema'
import { getCurrentVault } from './vaultContext'

/**
 * PDF 阅读数据 vault 仓库（v3.4.0 PDF 阅读体验整包，方案 §3/§4）——`.knowbase/modules/pdfReader.json` **唯一写方**。
 *
 * - 进度/书签/模式：键 `{rootId}/{relPath}`，patch 带 `expectedUpdatedAt` 冲突检测（铁律 4）。
 * - 书架清单不落盘（自动库：扫描即清单，见 knowledgeIndex.scanVaultPdfs）。
 * - 封面缓存：`.knowbase/cache/covers/<sha1(key)>.png` + 同目录 index.json（mtime 失效判据）；缓存目录属 vault 可删可再生。
 * - IPC 转发层 = electron/database/repositories/pdfReaderRepo.ts（老目录名不是死代码，照既有模式）。
 * - 纯校验逻辑在 pdfReaderSchema.ts（零依赖，契约脚本直接 import）。
 */

const MOD = 'modules'
const F_STORE = 'pdfReader.json'
const COVER_DIR = 'cache/covers'
const F_COVER_INDEX = 'index.json'
const MAX_COVER_BYTES = 2 * 1024 * 1024

function emptyStore(): VaultPdfReaderStore {
  return { version: 1, books: {} }
}

/** 读整个 store（损坏/缺失回落空 store；readJson 自带 corrupt 备份兜底） */
function readStore(): VaultPdfReaderStore {
  const raw = readJson<VaultPdfReaderStore>(MOD, F_STORE, emptyStore())
  if (!raw || typeof raw !== 'object' || typeof raw.books !== 'object' || raw.books === null) return emptyStore()
  return raw
}

/** 读封面缓存索引：Record<书键, {mtimeMs, file}> */
function readCoverIndex(): Record<string, VaultCoverIndexEntry> {
  const raw = readJson<Record<string, VaultCoverIndexEntry>>(COVER_DIR, F_COVER_INDEX, {})
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, VaultCoverIndexEntry> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === 'object' && typeof (v as VaultCoverIndexEntry).mtimeMs === 'number' && typeof (v as VaultCoverIndexEntry).file === 'string') {
      out[k] = v as VaultCoverIndexEntry
    }
  }
  return out
}

/** rootId 必须是当前打开仓库（数据文件本身按 vault 隔离，跨仓库键一律拒绝） */
function requireCurrentRootId(rootId: string): void {
  const cur = getCurrentVault()
  if (!cur) throw new Error('当前没有打开的仓库')
  if (rootId !== cur.rootId) throw new Error('rootId 与当前仓库不一致')
}

// ===== 进度 / 书签 / 模式 =====

export function pdfReaderGetBook(rootId: string, relPath: string): VaultBookState | null {
  const key = pdfBookKey(rootId, relPath)
  if (!key) return null
  const store = readStore()
  const raw = store.books[key]
  return raw ? coerceBookState(raw, new Date().toISOString()) : null
}

/** 书架 join 用：当前仓库内所有有记录的书键 → 状态（按 rootId 前缀过滤，忽略其他仓库残留） */
export function pdfReaderListProgress(rootId: string): Record<string, VaultBookState> {
  const id = String(rootId ?? '').trim()
  const prefix = `${id}/`
  if (!id) return {}
  const store = readStore()
  const out: Record<string, VaultBookState> = {}
  for (const [key, raw] of Object.entries(store.books)) {
    if (!key.startsWith(prefix)) continue
    out[pdfKeyRel(key)] = coerceBookState(raw, new Date().toISOString())
  }
  return out
}

export interface PdfPatchResult {
  ok: boolean
  state?: VaultBookState
  conflict?: boolean
  error?: string
}

/**
 * 局部写回（铁律 4：expectedUpdatedAt 冲突检测）。
 * - 白名单外的键 / 非法值：整体拒绝（sanitizeBookPatch）。
 * - expectedUpdatedAt 传了且与服务端不一致 → conflict:true（渲染层决策覆盖策略）。
 * - 写盘走 writeJsonOrThrow：失败必须抛错，不伪装成功。
 */
export function pdfReaderPatchBook(rootId: string, relPath: string, patch: unknown, expectedUpdatedAt?: string): PdfPatchResult {
  const key = pdfBookKey(rootId, relPath)
  if (!key) return { ok: false, error: '非法的书键' }
  try { requireCurrentRootId(rootId) } catch (e) { return { ok: false, error: (e as Error).message } }
  const clean = sanitizeBookPatch(patch)
  if (!clean) return { ok: false, error: 'patch 字段非法（只收 lastPage/scrollRatio/mode/zoom/eyeCare/bookmarks）' }
  const now = new Date().toISOString()
  const store = readStore()
  const prev = store.books[key] ? coerceBookState(store.books[key], now) : defaultBookState(now)
  if (typeof expectedUpdatedAt === 'string' && expectedUpdatedAt && prev.updatedAt !== expectedUpdatedAt) {
    return { ok: false, conflict: true, state: prev }
  }
  const next: VaultBookState = { ...prev, ...clean, updatedAt: now }
  store.books[key] = next
  try {
    writeJsonOrThrow(MOD, F_STORE, store)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  return { ok: true, state: next }
}

// ===== 封面缓存 =====

/** 封面缓存文件名：<sha1(key)>.png（键派生，方案 §11.5 与进度同键口径） */
export function pdfCoverFileName(rootId: string, relPath: string): string {
  const key = pdfBookKey(rootId, relPath)
  return key ? `${createHash('sha1').update(key).digest('hex')}.png` : ''
}

export function pdfReaderCoverList(): Record<string, VaultCoverIndexEntry> {
  return readCoverIndex()
}

export interface PdfCoverSaveResult {
  ok: boolean
  error?: string
}

/**
 * 写封面：dataUrl(png) + expectedMtimeMs 校验（PDF 文件在渲染封面后没被外部改过才收）。
 * 写盘成功返回 ok；调用方（IPC 层）负责 broadcastDataChanged('pdfReader')。
 */
export function pdfReaderCoverSave(rootId: string, relPath: string, dataUrl: string, expectedMtimeMs: number): PdfCoverSaveResult {
  const key = pdfBookKey(rootId, relPath)
  const file = pdfCoverFileName(rootId, relPath)
  if (!key || !file) return { ok: false, error: '非法的书键' }
  try { requireCurrentRootId(rootId) } catch (e) { return { ok: false, error: (e as Error).message } }
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return { ok: false, error: '封面必须是 png dataUrl' }
  const b64 = dataUrl.slice('data:image/png;base64,'.length)
  if (!b64 || b64.length > Math.ceil(MAX_COVER_BYTES / 3) * 4) return { ok: false, error: '封面数据为空或超过 2MB' }
  const dir = kbModulePath(COVER_DIR, '')
  if (!dir) return { ok: false, error: '当前没有打开的仓库' }
  try {
    const abs = join(dir, file)
    const buf = Buffer.from(b64, 'base64')
    if (buf.length === 0 || buf.length > MAX_COVER_BYTES) return { ok: false, error: '封面数据为空或超过 2MB' }
    mkdirSync(dir, { recursive: true })
    writeFileSync(abs, buf)
    const index = readCoverIndex()
    index[key] = { mtimeMs: expectedMtimeMs, file }
    writeJsonOrThrow(COVER_DIR, F_COVER_INDEX, index)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 读封面 png 原始字节（渲染层经 coverList 命中后自行用 file 名请求；主进程内部用） */
export function pdfCoverExists(file: string): boolean {
  const dir = kbModulePath(COVER_DIR, '')
  if (!dir) return false
  return exists(COVER_DIR, file) && statSyncSafe(join(dir, file))
}

function statSyncSafe(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}

/** 导入外部 PDF → 拷入仓库根（重名自动后缀 name-2.pdf / name-3.pdf …）。返回新 relPath；取消返回 null */
export async function pdfReaderImportPdf(
  rootId: string,
  pickDialog: () => Promise<string[] | null>,
  copyFile: (src: string, dest: string) => void,
): Promise<{ ok: boolean; imported?: string[]; canceled?: boolean; error?: string }> {
  try { requireCurrentRootId(rootId) } catch (e) { return { ok: false, error: (e as Error).message } }
  const picked = await pickDialog()
  if (!picked) return { ok: false, canceled: true }
  const cur = getCurrentVault()
  if (!cur) return { ok: false, error: '当前没有打开的仓库' }
  const imported: string[] = []
  for (const src of picked) {
    try {
      if (!src.toLowerCase().endsWith('.pdf')) continue
      const base = basename(src)
      const stem = base.slice(0, -4)
      let rel = base
      let n = 2
      while (existsSync(join(cur.rootPath, rel))) {
        rel = `${stem}-${n}.pdf`
        n++
      }
      copyFile(src, join(cur.rootPath, rel))
      imported.push(rel)
    } catch { /* 单个失败跳过，不中断整批 */ }
  }
  if (imported.length === 0) return { ok: false, error: '没有可导入的 PDF' }
  return { ok: true, imported }
}

/** 封面缓存目录是否就绪（渲染层预检用） */
export function pdfCoverDirReady(): boolean {
  return !!kbModulePath(COVER_DIR, '')
}

/** 供书架缓存命中判定：索引 + 磁盘文件双确认 */
export function pdfReaderCoverHit(rootId: string, relPath: string, pdfMtimeMs: number): string | null {
  const key = pdfBookKey(rootId, relPath)
  if (!key) return null
  const hit = readCoverIndex()[key]
  if (!hit || hit.mtimeMs !== pdfMtimeMs) return null
  const dir = kbModulePath(COVER_DIR, '')
  if (!dir || !existsSync(join(dir, hit.file))) return null
  return hit.file
}
