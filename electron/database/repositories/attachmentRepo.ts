// R6 去库化：附件台账 = .knowbase/modules/attachments/registry.json
// 3.9.2：附件文件本体→仓库内 .attachments/（旧 userData/attachments 只读兼容，读命中时原子复制进仓库）
import { ipcMain, app } from 'electron'
import { join, basename, dirname } from 'path'
import { mkdirSync, writeFileSync, copyFileSync, existsSync, unlinkSync, renameSync, readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { safePathInside } from '../../lib/pathGuard'
import { getVaultAttachmentsRoot, getVaultKbRoot } from '../../lib/kbStore/vaultContext'
import { normalizeRel, attachmentRel, resolveExistingPath } from '../../lib/kbStore/attachmentPath'
import {
  ensureAttachmentInVault,
  ensureAttachmentStoreMigrated,
  getLegacyAttachmentsRoot,
  getVaultTrashRoot,
} from '../../lib/attachmentStore'
import { vaultAttachmentsAll, vaultAttachmentsSave, AttachmentRow } from '../../lib/kbStore/attachmentVaultRepo'
import { vaultPostsAll } from '../../lib/kbStore/momentsVaultRepo'
import { vaultListEntries } from '../../lib/kbStore/blogVaultRepo'
import { getKnowledgeIndex } from '../../lib/kbStore/knowledgeIndex'

const EXT_MAP: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'application/json': 'json',
  'application/octet-stream': 'bin',
}

function extFor(mime: string, fallbackName: string): string {
  if (EXT_MAP[mime]) return '.' + EXT_MAP[mime]
  const m = /\.(\w+)$/.exec(fallbackName || '')
  return m ? '.' + m[1].toLowerCase() : '.bin'
}

function mimeFromPath(p: string): string {
  const ext = (p.match(/\.(\w+)$/)?.[1] || '').toLowerCase()
  const inv: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json' }
  return inv[ext] || 'application/octet-stream'
}

function toMeta(r: AttachmentRow) {
  return {
    id: r.id,
    name: r.file_name,
    url: `attachment://${r.id}/`,
    thumbUrl: `attachment://${r.id}/?thumb=1`,
    mime: r.mime_type,
    size: r.size_bytes,
    position: r.position,
  }
}

export type AttachmentMeta = ReturnType<typeof toMeta>

/** 写附件前必须有当前仓库；无仓库直接抛错（不静默退回 userData） */
function requireVaultAttachmentsRoot(): string {
  const root = getVaultAttachmentsRoot()
  if (!root) throw new Error('当前没有打开的仓库')
  return root
}

/** 从 Markdown 正文中提取内联图片引用的附件 ID（attachment://{id}/ 或 ?thumb=1） */
export function parseInlineAttachmentIds(md: string): string[] {
  if (!md) return []
  const re = /attachment:\/\/([^/?#\s"'<>)]+)/g
  const ids: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(md)) !== null) {
    const id = m[1]
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** 供 attachment:// 协议解析真实文件路径（路径防护:历史脏数据/恶意注入的 file_path 不会越出附件目录） */
export function getAttachmentFilePath(id: string, thumb = false): string | null {
  ensureAttachmentStoreMigrated()
  const row = vaultAttachmentsAll().find(r => r.id === id)
  if (!row) return null
  return ensureAttachmentInVault(thumb && row.thumb_path ? row.thumb_path : row.file_path)
}

/** 一次查询多个附件的元数据（供说说列表批量组装） */
export function getAttachmentsForIds(ids: string[]): ReturnType<typeof toMeta>[] {
  ensureAttachmentStoreMigrated()
  const list = ids.filter(Boolean)
  if (list.length === 0) return []
  const rows = vaultAttachmentsAll().filter(r => list.includes(r.id))
  const map = new Map(rows.map(r => [r.id, toMeta(r)]))
  return list.map(id => map.get(id)).filter((x): x is ReturnType<typeof toMeta> => !!x)
}

/** 认领附件：上传时 owner_id 为空，创建业务记录后归属到具体对象 */
export function claimAttachments(ids: string[], ownerType: string, ownerId: string): void {
  const rows = vaultAttachmentsAll()
  let changed = false
  ids.forEach((id, i) => {
    if (!id) return
    const row = rows.find(r => r.id === id)
    if (!row) return
    row.owner_type = ownerType
    row.owner_id = ownerId
    row.position = i
    changed = true
  })
  if (changed) vaultAttachmentsSave(rows)
}

/** 删除业务记录时，附件文件移入仓库内回收区（可恢复；保留原相对路径，避免同名冲突） */
export function trashAttachments(ids: string[], binId: string): void {
  ensureAttachmentStoreMigrated()
  const trashRoot = getVaultTrashRoot(binId)
  const vaultRoot = getVaultAttachmentsRoot()
  if (!trashRoot || !vaultRoot) return
  mkdirSync(trashRoot, { recursive: true })
  const legacyRoot = getLegacyAttachmentsRoot()
  const rows = vaultAttachmentsAll()
  let changed = false
  for (const id of ids) {
    if (!id) continue
    const row = rows.find(r => r.id === id)
    if (!row || row.trashed) continue
    const rels = [normalizeRel(row.file_path), normalizeRel(row.thumb_path)].filter((x): x is string => !!x)
    for (const rel of rels) {
      const src = resolveExistingPath(vaultRoot, legacyRoot, rel)
      if (!src) continue
      const dest = join(trashRoot, ...rel.split('/'))
      try {
        mkdirSync(dirname(dest), { recursive: true })
        renameSync(src.abs, dest)
      } catch {
        try { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(src.abs, dest); unlinkSync(src.abs) } catch { /* keep */ }
      }
    }
    const fileRel = normalizeRel(row.file_path)
    row.trashed = 1
    row.trash_path = fileRel ? `attachments_trash/${binId}/${fileRel}` : ''
    changed = true
  }
  if (changed) vaultAttachmentsSave(rows)
}

/** 从回收区恢复附件文件 */
export function restoreAttachments(ids: string[]): void {
  ensureAttachmentStoreMigrated()
  const vaultRoot = getVaultAttachmentsRoot()
  const kbRoot = getVaultKbRoot()
  if (!vaultRoot || !kbRoot) return
  const rows = vaultAttachmentsAll()
  let changed = false
  for (const id of ids) {
    if (!id) continue
    const row = rows.find(r => r.id === id)
    if (!row || !row.trashed || !row.trash_path) continue
    // 路径防护:trash_path / file_path 均来自台账,越出预期目录的脏数据直接跳过
    const trashRel = normalizeRel(row.trash_path)
    const src = trashRel
      ? (safePathInside(kbRoot, trashRel) ?? safePathInside(app.getPath('userData'), trashRel))
      : null
    const destRel = normalizeRel(row.file_path)
    const dest = destRel ? safePathInside(vaultRoot, destRel) : null
    if (!src || !dest) continue
    try {
      mkdirSync(dirname(dest), { recursive: true })
      if (existsSync(dest)) unlinkSync(dest)
      if (existsSync(src)) renameSync(src, dest)
    } catch {
      try { if (existsSync(src)) { copyFileSync(src, dest); unlinkSync(src) } } catch { /* keep */ }
    }
    row.trashed = 0
    row.trash_path = ''
    changed = true
  }
  if (changed) vaultAttachmentsSave(rows)
}

/** 彻底删除附件（文件 + 记录） */
export function deleteAttachments(ids: string[]): void {
  if (ids.filter(Boolean).length === 0) return
  const vaultRoot = getVaultAttachmentsRoot()
  const kbRoot = getVaultKbRoot()
  let rows = vaultAttachmentsAll()
  let changed = false
  for (const id of ids) {
    if (!id) continue
    const row = rows.find(r => r.id === id)
    if (!row) continue
    for (const p of [row.file_path, row.thumb_path]) {
      const rel = normalizeRel(p)
      if (!rel) continue
      for (const root of [vaultRoot, getLegacyAttachmentsRoot()]) {
        if (!root) continue
        const full = safePathInside(root, rel)
        try { if (full && existsSync(full)) unlinkSync(full) } catch { /* ignore */ }
      }
    }
    if (row.trashed && row.trash_path) {
      const trashRel = normalizeRel(row.trash_path)
      for (const root of [kbRoot, app.getPath('userData')]) {
        if (!root || !trashRel) continue
        const trashFull = safePathInside(root, trashRel)
        try { if (trashFull && existsSync(trashFull)) unlinkSync(trashFull) } catch { /* ignore */ }
      }
    }
    rows = rows.filter(r => r.id !== id)
    changed = true
  }
  if (changed) vaultAttachmentsSave(rows)
}

/** 注册一条已有文件的附件记录（文件已由调用方落盘） */
export function registerAttachment(data: {
  ownerType: string
  ownerId: string
  position?: number
  fileName: string
  relPath: string
  mime?: string
  size?: number
}): string {
  const id = randomUUID()
  const rows = vaultAttachmentsAll()
  rows.push({
    id,
    owner_type: data.ownerType,
    owner_id: data.ownerId,
    position: data.position || 0,
    file_name: data.fileName,
    file_path: normalizeRel(data.relPath) ?? data.relPath,
    thumb_path: '',
    mime_type: data.mime || 'application/octet-stream',
    size_bytes: data.size || 0,
    trashed: 0,
    trash_path: '',
    created_at: new Date().toISOString(),
  })
  vaultAttachmentsSave(rows)
  return id
}

export function registerAttachmentHandlers(): void {
  // 通道 B：渲染进程传字节（前端选择/拖拽，先预览再上传）
  ipcMain.handle('attachment:uploadMany', (_e, data: {
    ownerType?: string
    ownerId?: string
    files: { name?: string; mime?: string; dataUrl?: string; base64?: string; thumbDataUrl?: string }[]
  }) => {
    ensureAttachmentStoreMigrated()
    const vaultRoot = requireVaultAttachmentsRoot()
    const ownerType = data.ownerType || 'misc'
    const ownerId = data.ownerId || '_pending'
    // 白名单校验:两者会拼进落盘路径,含路径分隔符/点号可越出附件目录
    if (!/^[A-Za-z0-9_-]+$/.test(ownerType) || !/^[A-Za-z0-9_-]+$/.test(ownerId)) return []
    const now = new Date().toISOString()
    const out: ReturnType<typeof toMeta>[] = []
    const rows = vaultAttachmentsAll()
    for (const f of data.files || []) {
      const id = randomUUID()
      const raw = f.dataUrl || ''
      const mime = f.mime || (/^data:([^;]+)/.exec(raw)?.[1] || 'application/octet-stream')
      const ext = extFor(mime, f.name || 'file')
      mkdirSync(join(vaultRoot, ownerType, ownerId), { recursive: true })
      const rel = attachmentRel(ownerType, ownerId, id, ext)
      const buf = raw.includes(',') ? Buffer.from(raw.split(',')[1] || '', 'base64') : Buffer.from(f.base64 || '', 'base64')
      writeFileSync(join(vaultRoot, ...rel.split('/')), buf)

      let relThumb = ''
      if (f.thumbDataUrl && f.thumbDataUrl.includes(',')) {
        mkdirSync(join(vaultRoot, ownerType, ownerId, 'thumbs'), { recursive: true })
        relThumb = [ownerType, ownerId, 'thumbs', `${id}.jpg`].join('/')
        writeFileSync(join(vaultRoot, ...relThumb.split('/')), Buffer.from(f.thumbDataUrl.split(',')[1] || '', 'base64'))
      }

      const row: AttachmentRow = {
        id,
        owner_type: ownerType,
        owner_id: ownerId,
        position: out.length,
        file_name: f.name || 'file',
        file_path: rel,
        thumb_path: relThumb,
        mime_type: mime,
        size_bytes: buf.length,
        trashed: 0,
        trash_path: '',
        created_at: now,
      }
      rows.push(row)
      out.push(toMeta(row))
    }
    vaultAttachmentsSave(rows)
    return out
  })

  // 通道 A：主进程直接复制本地文件（批量导入/知识库附件）
  ipcMain.handle('attachment:uploadFromPath', (_e, data: { ownerType?: string; ownerId?: string; filePath: string }) => {
    if (!data.filePath || !existsSync(data.filePath)) return null
    ensureAttachmentStoreMigrated()
    const vaultRoot = requireVaultAttachmentsRoot()
    const ownerType = data.ownerType || 'misc'
    const ownerId = data.ownerId || '_pending'
    // 白名单校验:两者会拼进落盘路径(同 uploadMany)
    if (!/^[A-Za-z0-9_-]+$/.test(ownerType) || !/^[A-Za-z0-9_-]+$/.test(ownerId)) return null
    const id = randomUUID()
    const name = basename(data.filePath)
    const ext = extFor(mimeFromPath(data.filePath), name)
    mkdirSync(join(vaultRoot, ownerType, ownerId), { recursive: true })
    const rel = attachmentRel(ownerType, ownerId, id, ext)
    copyFileSync(data.filePath, join(vaultRoot, ...rel.split('/')))
    const size = readFileSync(data.filePath).length
    const row: AttachmentRow = {
      id,
      owner_type: ownerType,
      owner_id: ownerId,
      position: 0,
      file_name: name,
      file_path: rel,
      thumb_path: '',
      mime_type: mimeFromPath(data.filePath),
      size_bytes: size,
      trashed: 0,
      trash_path: '',
      created_at: new Date().toISOString(),
    }
    const rows = vaultAttachmentsAll()
    rows.push(row)
    vaultAttachmentsSave(rows)
    return toMeta(row)
  })

  ipcMain.handle('attachment:getByOwner', (_e, ownerType: string, ownerId: string) => {
    ensureAttachmentStoreMigrated()
    const rows = vaultAttachmentsAll()
      .filter(r => r.owner_type === ownerType && r.owner_id === ownerId)
      .sort((a, b) => a.position - b.position)
    return rows.map(toMeta)
  })

  ipcMain.handle('attachment:delete', (_e, id: string) => {
    deleteAttachments([id])
  })

  ipcMain.handle('attachment:getPath', (_e, id: string) => {
    return getAttachmentFilePath(id)
  })

  // 解析仓库内相对路径（编辑器 PDF/XMind 兜底用）：仓库优先，旧目录命中则复制进仓库
  ipcMain.handle('attachment:resolveRel', (_e, rel: string) => {
    ensureAttachmentStoreMigrated()
    return ensureAttachmentInVault(rel)
  })

  // 读取附件文件内容为 base64（PDF 阅读器用）
  ipcMain.handle('attachment:readBase64', (_e, id: string) => {
    const p = getAttachmentFilePath(id)
    if (!p) return null
    try {
      return readFileSync(p).toString('base64')
    } catch (e) {
      console.error('[attachment:readBase64] failed:', e)
      return null
    }
  })

  // 按附件目录内的文件名读取 base64（兼容旧版无 attachment_id 的附件）
  ipcMain.handle('attachment:readBase64ByFileName', (_e, fileName: string) => {
    if (!fileName || /[\\/]/.test(fileName)) return null  // 只允许附件目录内相对文件名
    const p = ensureAttachmentInVault(fileName)
    if (!p) return null
    try {
      return readFileSync(p).toString('base64')
    } catch (e) {
      console.error('[attachment:readBase64ByFileName] failed:', e)
      return null
    }
  })

  ipcMain.handle('attachment:cleanupOrphans', () => {
    ensureAttachmentStoreMigrated()
    let removed = 0
    // 1) 超过 24 小时的未认领上传（owner_id = _pending）
    const pending = vaultAttachmentsAll().filter(r => r.owner_id === '_pending')
    for (const r of pending) {
      const age = Date.now() - new Date(r.created_at).getTime()
      if (age > 24 * 3600 * 1000) {
        deleteAttachments([r.id])
        removed++
      }
    }
    // 2) 归属对象已不存在的附件（说说 / 知识页面 / 博客；头像等固定归属跳过）
    const momentsIds = new Set(vaultPostsAll().map(r => r.id))
    const pageIds = new Set(Object.keys(getKnowledgeIndex().byId))
    const entryIds = new Set(vaultListEntries().map(r => r.id))
    const rows = vaultAttachmentsAll().filter(r => r.owner_id !== '_pending')
    for (const r of rows) {
      let exists = true
      if (r.owner_type === 'moments_post') exists = momentsIds.has(r.owner_id)
      else if (r.owner_type === 'knowledge_page') exists = pageIds.has(r.owner_id)
      else if (r.owner_type === 'blog_entry') exists = entryIds.has(r.owner_id)
      if (!exists) {
        deleteAttachments([r.id])
        removed++
      }
    }
    return { removed }
  })
}
