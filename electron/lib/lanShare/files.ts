import { join, basename } from 'path'
import {
  existsSync, readdirSync, statSync, unlinkSync,
  readFileSync, writeFileSync, copyFileSync, mkdirSync,
} from 'fs'
import { safePathInside } from '../pathGuard'
import { getInboxDir, getOutboxDir } from './paths'

/**
 * 交换目录文件操作。所有对外部可控文件名/路径的解析一律过 safePathInside，
 * 落盘路径被锁死在 sync/inbox 与 sync/outbox 两个目录内。
 */

export interface InboxFileInfo {
  name: string
  size: number
  path: string
  receivedAt: number
}

export interface OutboxFileInfo {
  name: string
  size: number
  path: string
  downloaded: boolean
}

/** 文件名合法性：非空、不含路径分隔符、不是 . / .. */
export function isValidFileName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 240) return false
  if (name === '.' || name === '..') return false
  if (/[\\/]/.test(name)) return false
  if (/[\x00-\x1f]/.test(name)) return false
  return true
}

function statOrNull(p: string) {
  try {
    const s = statSync(p)
    return s.isFile() ? s : null
  } catch {
    return null
  }
}

/** 把不受信文件名安全解析到目录内；非法返回 null */
export function safeResolveInside(dir: string, name: unknown): string | null {
  if (!isValidFileName(name)) return null
  return safePathInside(dir, name)
}

// ---- inbox（平板 → 电脑） ----

export function listInboxFiles(): InboxFileInfo[] {
  const dir = getInboxDir()
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isFile())
    .map(d => {
      const p = join(dir, d.name)
      const s = statOrNull(p)
      return { name: d.name, size: s?.size ?? 0, path: p, receivedAt: s?.mtimeMs ?? 0 }
    })
    .sort((a, b) => b.receivedAt - a.receivedAt)
}

/** 移除一条收件（误传清理 / 归档成功后调用方负责移动，本函数只删） */
export function removeInboxFile(name: unknown): boolean {
  const p = safeResolveInside(getInboxDir(), name)
  if (!p || !existsSync(p)) return false
  try {
    unlinkSync(p)
    return true
  } catch {
    return false
  }
}


// ---- outbox（电脑 → 平板） ----

const OUTBOX_META = '.downloaded.json'

function readOutboxMeta(): Record<string, number> {
  const p = join(getOutboxDir(), OUTBOX_META)
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'))
    return raw && typeof raw === 'object' ? raw as Record<string, number> : {}
  } catch {
    return {}
  }
}

function writeOutboxMeta(meta: Record<string, number>): void {
  writeFileSync(join(getOutboxDir(), OUTBOX_META), JSON.stringify(meta, null, 2))
}

export function listOutboxFiles(): OutboxFileInfo[] {
  const dir = getOutboxDir()
  const meta = readOutboxMeta()
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isFile() && d.name !== OUTBOX_META)
    .map(d => {
      const p = join(dir, d.name)
      const s = statOrNull(p)
      return { name: d.name, size: s?.size ?? 0, path: p, downloaded: d.name in meta }
    })
    .sort((a, b) => b.name.localeCompare(a.name))
}

/** 把本地文件复制进 outbox（电脑 → 平板）；返回 outbox 内路径，失败返回 null */
export function addToOutbox(srcPath: string): string | null {
  if (!existsSync(srcPath) || !statSync(srcPath).isFile()) return null
  const name = basename(srcPath)
  const dest = safeResolveInside(getOutboxDir(), name)
  if (!dest) return null
  try {
    copyFileSync(srcPath, dest)
    return dest
  } catch {
    return null
  }
}

/** 下载时标记「已下载」；多个设备可重复下载，互不干扰 */
export function markOutboxDownloaded(name: unknown): void {
  const p = safeResolveInside(getOutboxDir(), name)
  if (!p || !existsSync(p)) return
  const meta = readOutboxMeta()
  meta[basename(p)] = Date.now()
  writeOutboxMeta(meta)
}

/** 关闭服务时清空 outbox（含下载标记），符合「用完即走、不留垃圾」 */
export function clearOutbox(): void {
  const dir = getOutboxDir()
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.isFile()) {
      try { unlinkSync(join(dir, d.name)) } catch { /* 忽略 */ }
    }
  }
  writeOutboxMeta({})
}

/** 单条删除 outbox 文件（同步清理下载标记） */
export function removeOutboxFile(name: unknown): boolean {
  const p = safeResolveInside(getOutboxDir(), name)
  if (!p || !existsSync(p)) return false
  try {
    unlinkSync(p)
    const meta = readOutboxMeta()
    delete meta[basename(p)]
    writeOutboxMeta(meta)
    return true
  } catch {
    return false
  }
}

/** outbox 内的文件安全解析（下载 / 重命名用） */
export function resolveOutboxPath(name: unknown): string | null {
  const p = safeResolveInside(getOutboxDir(), name)
  return p && existsSync(p) ? p : null
}

/** 重命名：防止多次传输同名文件互相覆盖 */
