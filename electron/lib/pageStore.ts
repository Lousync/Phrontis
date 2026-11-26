import { createHash } from 'crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, sep } from 'path'
import { writeJsonOrThrow } from 'phrontis-core/kbStore/jsonStore'
import { getCurrentVault } from 'phrontis-core/kbStore/vaultContext'
import { broadcastDataChanged } from '../main/windowBus'
import { safePathInside } from './pathGuard'
import {
  PAGE_STORE_DIR, PAGE_STORE_MAX_DIR_DEPTH, measurePageStorePayload, normalizePageStoreRel,
  pageStoreConflict, pageStoreKey,
} from './pageStorePath'

/**
 * 页面数据（page store）读写 —— 知识库内 HTML 页面与 AI 工具共用的**唯一实现**。
 *
 * 背景（2026-11-26）：仓库里的 html 由 kbview:// 沙箱渲染（不透明源 + `connect-src 'none'`），
 * 页面脚本既 fetch 不了同目录 json、也没有任何写盘能力。于是走「页面声明 → 宿主转发 → 主进程
 * 落盘」：页面用 `<meta name="kb-store" content=".knowbase/pagesdata/x.json">` 声明数据文件，
 * 注入的桥把读写转给宿主，宿主调本文件的 IPC 通道。
 *
 * 铁律对齐：
 * - 写盘走 phrontis-core `jsonStore.writeJsonOrThrow`（原子写 + 自动建目录），不自己造 fs 写入；
 * - 写盘后 `broadcastDataChanged('pagesdata')` —— 打开着同一份数据的页面 / 其它窗口据此重读；
 * - 路径只在 `.knowbase/pagesdata/` 里（`pageStorePath.ts` 硬校验），核心模块数据一概碰不到。
 *
 * 与 AI 工具的关系：`builtin.pagedata.*` 直接调本文件，**不给 `.knowbase` 开文件写白名单**
 * （`isAiWritableFile` 对点目录恒 false 的规则不变）。
 */

/** 磁盘内容指纹。文件不存在返回 null（与「空文件」区分开） */
export function pageStoreRev(absPath: string): string | null {
  try {
    if (!existsSync(absPath) || !statSync(absPath).isFile()) return null
    return createHash('sha1').update(readFileSync(absPath)).digest('hex')
  } catch {
    return null
  }
}

function requireVaultRoot(): string | null {
  return getCurrentVault()?.rootPath ?? null
}

export type PageStoreReadResult =
  | { ok: true; exists: boolean; data: unknown; rev: string; bytes: number }
  | { ok: false; error: string }

export function readPageStore(rel: unknown): PageStoreReadResult {
  const norm = normalizePageStoreRel(rel)
  if (!norm) return { ok: false, error: `路径不合法：只允许 ${PAGE_STORE_DIR}/*.json` }
  const root = requireVaultRoot()
  if (!root) return { ok: false, error: '尚未打开仓库' }
  const abs = safePathInside(root, norm)
  if (!abs) return { ok: false, error: '路径越界' }
  if (!existsSync(abs)) return { ok: true, exists: false, data: null, rev: '', bytes: 0 }
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(abs)
  } catch (e) {
    return { ok: false, error: `读取失败：${(e as Error).message}` }
  }
  if (!st.isFile()) return { ok: false, error: '目标不是文件' }
  if (st.size > 1024 * 1024 * 4) return { ok: false, error: '页面数据文件异常大（>4MB），已拒绝读取' }
  let text: string
  try {
    text = readFileSync(abs, 'utf-8')
  } catch (e) {
    return { ok: false, error: `读取失败：${(e as Error).message}` }
  }
  try {
    return {
      ok: true,
      exists: true,
      data: JSON.parse(text) as unknown,
      rev: pageStoreRev(abs) ?? '',
      bytes: st.size,
    }
  } catch {
    return { ok: false, error: '页面数据文件不是合法 JSON（可在编辑器里改好，或删除后由页面重建）' }
  }
}

export type PageStoreWriteResult =
  | { ok: true; rev: string; bytes: number; created: boolean }
  | { ok: false; error: string; conflict?: boolean; rev?: string }

export function writePageStore(rel: unknown, data: unknown, expectedRev?: unknown): PageStoreWriteResult {
  const norm = normalizePageStoreRel(rel)
  if (!norm) return { ok: false, error: `路径不合法：只允许 ${PAGE_STORE_DIR}/*.json` }
  const key = pageStoreKey(norm)
  if (!key) return { ok: false, error: '路径不合法' }
  const root = requireVaultRoot()
  if (!root) return { ok: false, error: '尚未打开仓库' }
  const abs = safePathInside(root, norm)
  if (!abs) return { ok: false, error: '路径越界' }

  const payload = measurePageStorePayload(data)
  if (!payload.ok) return { ok: false, error: payload.error }

  const diskRev = pageStoreRev(abs)
  if (pageStoreConflict(diskRev, expectedRev)) {
    return { ok: false, conflict: true, error: '数据已被别处修改', rev: diskRev ?? '' }
  }

  try {
    writeJsonOrThrow('pagesdata', key, data)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }

  const rev = pageStoreRev(abs) ?? ''
  broadcastDataChanged('pagesdata')
  return { ok: true, rev, bytes: payload.bytes, created: diskRev === null }
}

export interface PageStoreEntry {
  rel: string
  bytes: number
  rev: string
  updatedAt: number
}

/** 列出 pagesdata 下的全部 json（AI 工具用来「有哪些看板数据」）。最多 200 条 */
export function listPageStore(): { dir: string; files: PageStoreEntry[] } {
  const root = requireVaultRoot()
  const out: PageStoreEntry[] = []
  if (!root) return { dir: PAGE_STORE_DIR, files: out }
  const base = safePathInside(root, PAGE_STORE_DIR)
  if (!base || !existsSync(base)) return { dir: PAGE_STORE_DIR, files: out }
  const walk = (dir: string, depth: number): void => {
    if (out.length >= 200 || depth > PAGE_STORE_MAX_DIR_DEPTH + 1) return
    let names: string[] = []
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      if (out.length >= 200) return
      if (name.startsWith('.')) continue
      const abs = join(dir, name)
      let st: ReturnType<typeof statSync>
      try { st = statSync(abs) } catch { continue }
      if (st.isDirectory()) { walk(abs, depth + 1); continue }
      if (!/\.json$/i.test(name)) continue
      const rel = `${PAGE_STORE_DIR}/${relative(base, abs).split(sep).join('/')}`
      out.push({ rel, bytes: st.size, rev: pageStoreRev(abs) ?? '', updatedAt: Math.round(st.mtimeMs) })
    }
  }
  walk(base, 1)
  return { dir: PAGE_STORE_DIR, files: out }
}
