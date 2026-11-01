import { ipcMain, dialog, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { getCurrentVault } from 'phrontis-core/kbStore/vaultContext'
import { isWritePathAuthorized } from './exportRepo'
import { zipBuffer, unzipBuffer } from '../../lib/zip'

/**
 * 全仓备份/恢复（R6 去库化收尾：纯 .knowbase 仓库语义）。
 * - 导出：当前仓库目录（.knowbase/ JSON + md + 附件）整包压成一个 zip，
 *   不再向 .knowbase/backup 塞 knowledge.db 快照（sqlite 基础设施已删）。
 * - 导入/恢复：解压备份 zip 到目标目录重建仓库。
 * 大仓库（数百 MB 附件）会一次性读入内存压缩，属已知限制（后续可换流式）。
 *
 * 处置（R6）：原 getState / restoreDb 两个 sqlite 快照相关通道已删除
 * （渲染层 DataView 的「还原 sqlite 快照」入口同步移除）。
 */

function requireVault(): string {
  const cur = getCurrentVault()
  if (!cur) throw new Error('当前没有打开的仓库')
  return cur.rootPath
}

function walkFiles(dir: string, out: string[]): void {
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return }
  for (const n of names) {
    const p = join(dir, n)
    let isDir = false
    try { isDir = statSync(p).isDirectory() } catch { continue }
    if (isDir) { walkFiles(p, out); continue }
    out.push(p)
  }
}

function safeUnder(targetRoot: string, relName: string): string | null {
  // 防 zip-slip：解出的相对路径必须落在目标目录内
  const abs = resolve(targetRoot, relName)
  if (!abs.startsWith(resolve(targetRoot) + sep)) return null
  return abs
}

export function registerVaultBackupHandlers(): void {
  // 全仓导出：整个仓库目录压成 zip（zipPath 须经保存对话框授权）
  ipcMain.handle('vaultBackup:exportToZip', (_e, zipPath: string) => {
    if (!isWritePathAuthorized(zipPath)) throw new Error('写入路径未经过保存对话框授权,已拒绝')
    const root = requireVault()
    const files: string[] = []
    walkFiles(root, files)
    const entries = files.map((f) => ({
      path: relative(root, f).replace(/\\/g, '/'),
      data: readFileSync(f),
    }))
    writeFileSync(zipPath, zipBuffer(entries))
    return { ok: true, fileCount: files.length, zipPath }
  })

  // 选择备份 zip（渲染层无授权需求，仅读）
  ipcMain.handle('vaultBackup:pickArchive', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: '仓库备份包', extensions: ['zip'] }],
      title: '选择要导入的整仓备份 zip',
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // 解包恢复：把 zip 展开到目标目录（打开对话框选目标，为空目标最安全）
  ipcMain.handle('vaultBackup:restoreArchive', async (_e, archivePath: string) => {
    if (!existsSync(archivePath)) throw new Error('备份包不存在')
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, message: '没有可用窗口' }
    const targetResult = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择解压目标目录（建议空目录/新目录）',
    })
    if (targetResult.canceled || targetResult.filePaths.length === 0) return { ok: false, message: '未选择目标目录' }
    const target = targetResult.filePaths[0]
    const entries = unzipBuffer(readFileSync(archivePath))
    let written = 0
    for (const [relName, data] of entries) {
      if (relName.endsWith('/')) continue
      const abs = safeUnder(target, relName)
      if (!abs) continue
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, data)
      written++
    }
    return { ok: true, target, written }
  })
}
