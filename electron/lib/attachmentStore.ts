/**
 * 附件存储（主进程侧，3.9.2「附件入仓库」）。
 *
 * 新布局：`<vault>/.attachments/<ownerType>/<ownerId>/<file>`（与 AI 生图 / 知识包图片同一附件区）。
 * 旧布局：`<userData>/attachments/...` —— 只读兼容；读命中旧文件时先原子复制进仓库再用。
 * 回收区：`<vault>/.knowbase/attachments_trash/<binId>/<file>`；旧 userData 回收区继续可读。
 *
 * 纯路径逻辑在 `kbStore/attachmentPath.ts`（零 Electron 依赖，契约脚本直接验）。
 */
import { app } from 'electron'
import { join } from 'path'
import { getLegacyAttachmentsDir } from './globalPaths'
import { getCurrentVault, getVaultAttachmentsRoot, getVaultKbRoot } from './kbStore/vaultContext'
import { vaultAttachmentsAll, vaultAttachmentsSave } from './kbStore/attachmentVaultRepo'
import {
  copyMissingFile,
  migrationRels,
  normalizeRel,
  relToAbs,
  resolveExistingPath,
} from './kbStore/attachmentPath'
import { existsSync } from 'fs'

/** 旧附件根：<userData>/attachments（只读兜底，不再写入） */
export function getLegacyAttachmentsRoot(): string {
  return getLegacyAttachmentsDir()
}

/** 当前仓库的回收区目录；无仓库返回 null */
export function getVaultTrashRoot(binId: string): string | null {
  const kb = getVaultKbRoot()
  return kb ? join(kb, 'attachments_trash', binId) : null
}

/** 读附件：仓库内优先；旧目录命中则复制进仓库后返回；都没有返回 null */
export function ensureAttachmentInVault(relRaw: unknown): string | null {
  const vaultRoot = getVaultAttachmentsRoot()
  const rel = normalizeRel(relRaw)
  if (!vaultRoot || !rel) return null
  const legacyRoot = getLegacyAttachmentsRoot()
  const hit = resolveExistingPath(vaultRoot, legacyRoot, rel)
  if (!hit) return null
  if (hit.inVault) return hit.abs
  return copyMissingFile(vaultRoot, legacyRoot, rel)?.abs ?? hit.abs
}

/** 头像路径候选：新值 `user_profile/...`；旧值 `attachments/user_profile/...` */
function avatarRelCandidates(avatarPath: unknown): string[] {
  const rel = normalizeRel(avatarPath)
  if (!rel) return []
  const stripped = rel.startsWith('attachments/') ? rel.slice('attachments/'.length) : rel
  return stripped === rel ? [rel] : [rel, stripped]
}

/** 只查头像文件（不复制），用于删除旧头像 */
export function findAvatarFile(avatarPath: unknown): string | null {
  const vaultRoot = getVaultAttachmentsRoot()
  const candidates = avatarRelCandidates(avatarPath)
  if (candidates.length === 0) return null
  if (vaultRoot) {
    for (const rel of candidates) {
      const hit = resolveExistingPath(vaultRoot, null, rel)
      if (hit) return hit.abs
    }
  }
  const userData = app.getPath('userData')
  for (const rel of candidates) {
    const abs = relToAbs(userData, rel)
    if (existsSync(abs)) return abs
  }
  return null
}

/**
 * 头像解析：仓库内优先；旧值（带 `attachments/` 前缀）从 userData 复制进仓库。
 * 返回的 `rel` 是新口径（不带 `attachments/` 前缀），调用方应写回 profile。
 */
export function resolveAvatarFile(avatarPath: unknown): { abs: string; rel: string } | null {
  const vaultRoot = getVaultAttachmentsRoot()
  const candidates = avatarRelCandidates(avatarPath)
  if (!vaultRoot || candidates.length === 0) return null
  for (const rel of candidates) {
    const hit = resolveExistingPath(vaultRoot, null, rel)
    if (hit) return { abs: hit.abs, rel }
  }
  const userData = app.getPath('userData')
  for (const rel of candidates) {
    const destRel = rel.startsWith('attachments/') ? rel.slice('attachments/'.length) : rel
    const copied = copyMissingFile(vaultRoot, userData, destRel, rel)
    if (copied) return { abs: copied.abs, rel: destRel }
  }
  return null
}

const migratedRoots = new Set<string>()

/**
 * 一次性把当前仓库台账里的旧附件复制进仓库（幂等；每仓库每会话一次）。
 *
 * - 只复制不删旧文件：旧版 Windows 仍能读，回滚安全；
 * - 目标已存在一律跳过，绝不覆盖；
 * - 顺手把台账里的 `\` 归一化成 `/`；
 * - 失败只记日志，读路径仍有旧目录兜底。
 */
export function ensureAttachmentStoreMigrated(): void {
  const cur = getCurrentVault()
  if (!cur || migratedRoots.has(cur.rootId)) return
  const vaultRoot = getVaultAttachmentsRoot()
  const kbRoot = getVaultKbRoot()
  if (!vaultRoot || !kbRoot) return
  try {
    const rows = vaultAttachmentsAll()
    let changed = false
    for (const row of rows) {
      const fp = normalizeRel(row.file_path)
      if (fp && fp !== row.file_path) { row.file_path = fp; changed = true }
      const tp = normalizeRel(row.thumb_path)
      if (tp && tp !== row.thumb_path) { row.thumb_path = tp; changed = true }
      const trp = normalizeRel(row.trash_path)
      if (trp && trp !== row.trash_path) { row.trash_path = trp; changed = true }
    }
    let copied = 0
    for (const m of migrationRels(rows)) {
      const hit = m.kind === 'trash'
        ? copyMissingFile(kbRoot, app.getPath('userData'), m.rel)
        : copyMissingFile(vaultRoot, getLegacyAttachmentsRoot(), m.rel)
      if (hit?.copied) copied++
    }
    if (changed) vaultAttachmentsSave(rows)
    migratedRoots.add(cur.rootId)
    if (copied || changed) {
      console.log(`[attachments] 附件入仓库：复制 ${copied} 个文件${changed ? '，并归一化台账路径' : ''}`)
    }
  } catch (e) {
    console.error('[attachments] 迁移失败（读取会回退旧目录，不影响使用）:', e)
  }
}
