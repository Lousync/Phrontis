import { ipcMain, dialog, BrowserWindow } from 'electron'
import { randomBytes, pbkdf2Sync } from 'crypto'
import { getVaultAttachmentsRoot } from '../../lib/kbStore/vaultContext'
import { findAvatarFile, resolveAvatarFile } from '../../lib/attachmentStore'
import { join } from 'path'
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, unlinkSync } from 'fs'
import { registerAttachment, deleteAttachments } from './attachmentRepo'
import { vaultTodosAll, vaultTagsAll } from '../../lib/kbStore/scheduleVaultRepo'
import { vaultListEntries } from '../../lib/kbStore/blogVaultRepo'
import { vaultGetTags } from '../../lib/kbStore/knowledgeVaultRepo'
import { getKnowledgeIndex } from '../../lib/kbStore/knowledgeIndex'
import { vaultUserProfile, vaultUserProfileSave, type UserVaultRow } from '../../lib/kbStore/userVaultRepo'
import { vaultAttachmentsAll } from '../../lib/kbStore/attachmentVaultRepo'

// R6 去库化（D9）：全局数据 = userData/data/*.json（sql.js 已移除）
// R6 去库化：用户档案 = .knowbase/modules/user.json（登录密码 hash 同存；sql.js 路径已移除，D9）

// ---- types ----
interface UserStats {
  blogCount: number
  knowledgePages: number
  scheduleTodos: number
  blogTags: number
  knowledgeTags: number
  scheduleTags: number
  consecutiveDays: number
  totalWords: number
  totalCategories: number
}

// ---- helpers ----
function newVaultProfile(): UserVaultRow {
  const now = new Date().toISOString()
  return { id: 'default', username: '', avatar_path: '', password_hash: '', created_at: now, updated_at: now }
}

/** 读取档案，无则初始化一条 default（不落盘，落盘由各写操作完成） */
function loadProfileOrDefault(): UserVaultRow {
  return vaultUserProfile() ?? newVaultProfile()
}

/** 局部更新档案并落盘（无则初始化后合并） */
function patchProfile(patch: Partial<Omit<UserVaultRow, 'id' | 'created_at'>>): UserVaultRow {
  const row = { ...loadProfileOrDefault(), ...patch, updated_at: new Date().toISOString() }
  vaultUserProfileSave(row)
  return row
}

// ---- PBKDF2 password ----
const PBKDF2_ITERATIONS = 100000
const PBKDF2_KEYLEN = 64
const PBKDF2_DIGEST = 'sha512'
const SALT_LEN = 16

function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN).toString('hex')
  const hash = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password: string, stored: string): boolean {
  if (!stored || !stored.includes(':')) return false
  const [salt, hash] = stored.split(':')
  const computed = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString('hex')
  return computed === hash
}

export function registerUserHandlers(): void {
  // ===== Get profile =====
  ipcMain.handle('user:getProfile', () => {
    let row: ReturnType<typeof vaultUserProfile> = null
    try { row = vaultUserProfile() } catch (err) { console.error('[user:getProfile] 读取失败:', err); return null }
    if (!row) return null
    return {
      username: row.username,
      avatarPath: row.avatar_path,
      hasPassword: !!row.password_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  })

  // ===== Update username =====
  ipcMain.handle('user:setUsername', (_e, username: string) => {
    patchProfile({ username })
    return { success: true }
  })

  // ===== Set password =====
  ipcMain.handle('user:setPassword', (_e, password: string) => {
    patchProfile({ password_hash: hashPassword(password) })
    return { success: true }
  })

  // ===== Verify password =====
  ipcMain.handle('user:verifyPassword', (_e, password: string) => {
    const row = vaultUserProfile()
    if (!row || !row.password_hash) return false
    return verifyPassword(password, row.password_hash)
  })

  // ===== Check if password set =====
  ipcMain.handle('user:hasPassword', () => {
    const row = vaultUserProfile()
    return !!(row && row.password_hash)
  })

  // ===== Verify import password (against provided hash, not stored) =====
  ipcMain.handle('user:verifyImportPassword', (_e, password: string, storedHash: string) => {
    return verifyPassword(password, storedHash)
  })

  // ===== Change password (verify old first) =====
  ipcMain.handle('user:changePassword', (_e, oldPassword: string, newPassword: string) => {
    const row = vaultUserProfile()
    if (row && row.password_hash && !verifyPassword(oldPassword, row.password_hash)) {
      return { success: false, error: '当前密码错误' }
    }
    patchProfile({ password_hash: hashPassword(newPassword) })
    return { success: true }
  })

  // ===== Clear password =====
  ipcMain.handle('user:clearPassword', (_e, password: string) => {
    const row = vaultUserProfile()
    if (row && row.password_hash && !verifyPassword(password, row.password_hash)) {
      return { success: false, error: '密码错误' }
    }
    patchProfile({ password_hash: '' })
    return { success: true }
  })

  // ===== Avatar: pick file dialog =====
  ipcMain.handle('user:pickAvatar', async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择头像图片',
      filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // ===== Avatar: save to vault .attachments/ =====
  ipcMain.handle('user:saveAvatar', (_e, sourcePath: string) => {
    const vaultRoot = getVaultAttachmentsRoot()
    if (!vaultRoot) throw new Error('当前没有打开的仓库')
    const ext = sourcePath.match(/\.(png|jpe?g|gif|webp|bmp)$/i)?.[0] || '.png'
    const fileName = `avatar_${Date.now()}${ext}`
    const destDir = join(vaultRoot, 'user_profile', 'default')
    mkdirSync(destDir, { recursive: true })
    const destPath = join(destDir, fileName)
    copyFileSync(sourcePath, destPath)

    // 删除旧头像文件与旧附件记录
    const prev = vaultUserProfile()
    if (prev?.avatar_path) {
      const oldPath = findAvatarFile(prev.avatar_path)
      try { if (oldPath && existsSync(oldPath)) unlinkSync(oldPath) } catch { /* ignore */ }
    }
    const oldAtts = vaultAttachmentsAll().filter(a => a.owner_type === 'user_profile' && a.owner_id === 'default')
    if (oldAtts.length > 0) deleteAttachments(oldAtts.map(a => a.id))

    const relativePath = `user_profile/default/${fileName}`
    registerAttachment({
      ownerType: 'user_profile',
      ownerId: 'default',
      fileName,
      relPath: relativePath,
      mime: `image/${ext.replace(/^\./, '').replace('jpg', 'jpeg')}`,
      size: readFileSync(destPath).length,
    })
    patchProfile({ avatar_path: relativePath })
    return { success: true, path: relativePath }
  })

  // ===== Avatar: read as base64 =====
  ipcMain.handle('user:getAvatarBase64', () => {
    const row = vaultUserProfile()
    if (!row?.avatar_path) return null
    const hit = resolveAvatarFile(row.avatar_path)
    if (!hit) return null
    if (hit.rel !== row.avatar_path) {
      try { patchProfile({ avatar_path: hit.rel }) } catch { /* ignore */ }
    }
    const buf = readFileSync(hit.abs)
    const ext = hit.rel.match(/\.(\w+)$/)?.[1] || 'png'
    const mime = ext === 'jpg' ? 'jpeg' : ext
    return `data:image/${mime};base64,${buf.toString('base64')}`
  })

  // ===== Get stats =====
  // 2026-09-08 修复「用户模块永远加载中」：getStats 读四路 vault 数据源，任一路抛异常
  // （json 损坏/索引未初始化/仓库切换竞态）整个 handler reject → 渲染层 Promise.all 无 catch
  // → 永远「加载中」。改为每路独立隔离（坏源置 0 不拖垮整体），handler 永不抛。
  const safe = <T,>(fn: () => T, fallback: T): T => { try { return fn() } catch (err) { console.error('[user:getStats] 数据源读取失败（已置兜底值）:', err); return fallback } }
  ipcMain.handle('user:getStats', (): UserStats => {
    // R6 去库化（D9）：统计全部读 vault 数据源（博客 md / knowledgeIndex / schedule json）
    const entries = safe(() => vaultListEntries(), [])
    const scheduleRows = safe(() => vaultTodosAll(), [])
    const scheduleDates = new Set(scheduleRows.map((r) => r.date))
    const blogCount = entries.length
    const knowledgePages = safe(() => getKnowledgeIndex().pages.length, 0)
    const scheduleTodos = scheduleRows.length
    const blogTags = new Set(entries.flatMap((e) => e.tags.map((t) => t.id))).size
    const knowledgeTags = safe(() => vaultGetTags().length, 0)
    const scheduleTags = safe(() => vaultTagsAll().length, 0)
    const totalWords = entries.reduce((sum, e) => sum + (e.wordCount || 0), 0)
    const totalCategories = safe(() => getKnowledgeIndex().categories.length, 0)

    // Consecutive days: count backward from today how many consecutive days have entries
    const entryDates = new Set(entries.map((e) => e.date))
    let consecutiveDays = 0
    const today = new Date()
    for (let i = 0; i < 3650; i++) { // max 10 years
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      // 本地日期(不用 toISOString 的 UTC 截断,避免凌晨连击算错)
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const hasEntry = entryDates.has(dateStr)
      const hasSchedule = scheduleDates.has(dateStr)
      if (hasEntry || hasSchedule) {
        consecutiveDays++
      } else if (i > 0) {
        break // break on first gap (skip today, which may not have been written yet)
      }
    }

    return { blogCount, knowledgePages, scheduleTodos, blogTags, knowledgeTags, scheduleTags, consecutiveDays, totalWords, totalCategories }
  })

  // ===== Export: get full user data (for JSON export) =====
  ipcMain.handle('user:getExportData', () => {
    const row = vaultUserProfile()
    if (!row) return null

    // Read avatar base64 if exists
    let avatarBase64: string | null = null
    if (row.avatar_path) {
      const hit = resolveAvatarFile(row.avatar_path)
      if (hit) {
        const buf = readFileSync(hit.abs)
        const ext = hit.rel.match(/\.(\w+)$/)?.[1] || 'png'
        const mime = ext === 'jpg' ? 'jpeg' : ext
        avatarBase64 = `data:image/${mime};base64,${buf.toString('base64')}`
      }
    }

    return {
      username: row.username,
      avatarPath: row.avatar_path,
      avatarBase64,
      passwordHash: row.password_hash || ''
    }
  })

  // ===== Import: restore user data =====
  ipcMain.handle('user:restoreFromImport', (_e, data: { username?: string; avatarPath?: string; avatarBase64?: string; passwordHash?: string }) => {
    if (data.username !== undefined) {
      patchProfile({ username: data.username })
    }
    if (data.passwordHash !== undefined) {
      patchProfile({ password_hash: data.passwordHash })
    }
    if (data.avatarBase64) {
      // Extract base64 data and mime type
      const match = data.avatarBase64.match(/^data:image\/(\w+);base64,(.+)$/)
      if (match) {
        const vaultRoot = getVaultAttachmentsRoot()
        if (vaultRoot) {
          const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
          const fileName = `avatar_imported_${Date.now()}.${ext}`
          const destDir = join(vaultRoot, 'user_profile', 'default')
          mkdirSync(destDir, { recursive: true })
          const destPath = join(destDir, fileName)
          writeFileSync(destPath, Buffer.from(match[2], 'base64'))
          const oldAtts = vaultAttachmentsAll().filter(a => a.owner_type === 'user_profile' && a.owner_id === 'default')
          if (oldAtts.length > 0) deleteAttachments(oldAtts.map(a => a.id))
          const relativePath = `user_profile/default/${fileName}`
          registerAttachment({
            ownerType: 'user_profile',
            ownerId: 'default',
            fileName,
            relPath: relativePath,
            mime: `image/${ext}`,
            size: Buffer.byteLength(match[2], 'base64'),
          })
          patchProfile({ avatar_path: relativePath })
        }
      }
    }

    return { success: true }
  })
}
