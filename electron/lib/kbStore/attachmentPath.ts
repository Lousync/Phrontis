/**
 * 附件路径工具（零 Electron 依赖，`.AGENT/scripts/attachments/verify-attachment-store.mjs` 直接 import）。
 *
 * 设计口径（3.9.2「附件入仓库」）：
 * - 附件文件根 = `<vault>/.attachments/`；台账里 `file_path` / `thumb_path` 仍是相对「附件根」的路径，
 *   所以从旧布局 `userData/attachments` 迁移时**不需要改写路径**，只搬文件 + 归一化分隔符。
 * - 对外一律 POSIX（`/`）：Windows 能读 `/`，Linux 读不了 `\`，所以归一化是单向必须的。
 * - 安全：归一化先拒绝绝对路径 / 盘符 / UNC / NUL，再交给调用方的 `safePathInside` 做 containment。
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { randomUUID } from 'crypto'

/** 反斜杠→斜杠并折叠 `.` / 合法 `..`；非法（绝对/盘符/越界）返回 null */
export function normalizeRel(rel: unknown): string | null {
  if (typeof rel !== 'string') return null
  const raw = rel.replace(/\\/g, '/').trim()
  if (!raw || raw.includes('\0')) return null
  if (raw.startsWith('/')) return null // 绝对路径 / UNC（//server/share）
  if (/^[A-Za-z]:/.test(raw)) return null // Windows 盘符（C: / C:/x）
  const out: string[] = []
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.length > 0 ? out.join('/') : null
}

/** 生成附件相对路径：永远出 `/`，ext 可带可不带点 */
export function attachmentRel(ownerType: string, ownerId: string, id: string, ext: string): string {
  const e = ext ? (ext.startsWith('.') ? ext : `.${ext}`) : ''
  return [ownerType, ownerId, `${id}${e}`].join('/')
}

/** 相对路径 → 绝对路径（相对路径必须已经 normalizeRel） */
export function relToAbs(root: string, rel: string): string {
  return join(root, ...rel.split('/'))
}

/** abs 是否落在 root 内（含 root 自身） */
export function isInside(root: string, abs: string): boolean {
  const base = resolve(root)
  const target = resolve(abs)
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * 依次在仓库 / 旧 userData 目录里找文件（不复制）。
 * 返回第一个存在且未越界的路径；`inVault` 表示命中的是新布局。
 */
export function resolveExistingPath(
  vaultRoot: string | null,
  legacyRoot: string | null,
  relRaw: unknown,
): { abs: string; rel: string; inVault: boolean } | null {
  const rel = normalizeRel(relRaw)
  if (!rel) return null
  const bases: Array<[string | null, boolean]> = [[vaultRoot, true], [legacyRoot, false]]
  for (const [root, inVault] of bases) {
    if (!root) continue
    const abs = relToAbs(root, rel)
    if (isInside(root, abs) && existsSync(abs)) return { abs, rel, inVault }
  }
  return null
}

/**
 * 从旧目录补一份到目标目录（原子：临时文件 + rename），目标已存在则跳过。
 * `srcRelRaw` 允许与目标相对路径不同（头像旧值带 `attachments/` 前缀时会用到）。
 */
export function copyMissingFile(
  destRoot: string,
  srcRoot: string,
  relRaw: unknown,
  srcRelRaw: unknown = relRaw,
): { abs: string; copied: boolean } | null {
  const rel = normalizeRel(relRaw)
  const srcRel = normalizeRel(srcRelRaw)
  if (!rel || !srcRel) return null
  const dest = relToAbs(destRoot, rel)
  if (!isInside(destRoot, dest)) return null
  if (existsSync(dest)) return { abs: dest, copied: false }
  const src = relToAbs(srcRoot, srcRel)
  if (!isInside(srcRoot, src) || !existsSync(src)) return null
  const tmp = `${dest}.tmp-${randomUUID()}`
  try {
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, tmp)
    renameSync(tmp, dest)
    return { abs: dest, copied: true }
  } catch {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    return existsSync(dest) ? { abs: dest, copied: false } : null
  }
}

export interface MigrationSourceRow {
  id: string
  file_path: string
  thumb_path?: string
  trashed?: number
  trash_path?: string
}

export interface MigrationRel {
  id: string
  rel: string
  kind: 'file' | 'thumb' | 'trash'
}

/** 迁移计划：把台账里有值的路径归一化后去重列出（文件是否存在由调用方判断） */
export function migrationRels(rows: MigrationSourceRow[]): MigrationRel[] {
  const out: MigrationRel[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const pairs: Array<[unknown, MigrationRel['kind']]> = [
      [row.file_path, 'file'],
      [row.thumb_path, 'thumb'],
      [row.trash_path, 'trash'],
    ]
    for (const [raw, kind] of pairs) {
      if (!raw) continue
      if (kind === 'trash' && row.trashed !== 1) continue
      const rel = normalizeRel(raw)
      if (!rel) continue
      const key = `${kind}:${rel}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ id: row.id, rel, kind })
    }
  }
  return out
}
