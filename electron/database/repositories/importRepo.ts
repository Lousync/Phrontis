import { ipcMain, BrowserWindow, dialog } from 'electron'
import { readFileSync } from 'fs'
import { basename, extname } from 'path'
import { vaultImportFolder } from 'phrontis-core/kbStore/knowledgeVaultRepo'

/**
 * 导入 IPC 层（R6 去库化收尾处置）：
 * - 保留：文件/文件夹导入对话框与读取（纯文件 I/O），以及知识库目录导入
 *   （import:importFolder → vaultImportFolder，目录镜像 + frontmatter md + 附件协议引用）。
 * - 弃用（保留通道返回提示，渲染层不崩）：旧 .db 整库替换（import:importDb /
 *   import:previewUserFromDb）、JSON 合并导入（import:executeImport，依赖已删的
 *   executeImportData/sql.js）、PDF/二进制入库（import:importPdf 等，原走
 *   knowledge_pages 表写入）、备份包合并导入（import:importBackupPackage，原 backupRepo）。
 *   数据已随仓库文件夹（.knowbase/）保存，恢复请用 设置 → 数据与仓库 的整仓备份/恢复。
 */

const TEXT_EXTS = ['md', 'txt', 'json', 'cpp', 'c', 'h', 'hpp', 'py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'java', 'rs', 'go', 'sh', 'bat', 'xml', 'yaml', 'yml', 'sql', 'r', 'rb', 'php', 'swift', 'kt', 'lua', 'ini', 'cfg', 'toml']

function fileNameBase(filePath: string): string {
  const ext = extname(filePath).slice(1).toLowerCase()
  return basename(filePath).replace(new RegExp(`\\.${ext}$`, 'i'), '')
}

function extToFileType(ext: string): string {
  const extLower = ext.toLowerCase()
  const mapping: Record<string, string> = {
    'md': 'md', 'txt': 'txt', 'json': 'json',
    'cpp': 'cpp', 'c': 'c', 'h': 'c', 'hpp': 'cpp',
    'py': 'py', 'js': 'js', 'jsx': 'jsx', 'ts': 'ts', 'tsx': 'tsx',
    'html': 'html', 'css': 'css',
    'java': 'java', 'rs': 'rs', 'go': 'go',
    'sh': 'sh', 'bat': 'bat', 'xml': 'xml',
    'yaml': 'yaml', 'yml': 'yaml', 'sql': 'sql',
    'r': 'r', 'rb': 'rb', 'php': 'php', 'swift': 'swift', 'kt': 'kt',
    'lua': 'lua', 'ini': 'ini', 'cfg': 'ini', 'toml': 'toml',
    'xmind': 'xmind',
  }
  return mapping[extLower] || extLower
}

// ===== 弃用提示（通道保留，防止渲染层调用崩） =====
const DEPRECATED_DB_IMPORT = '已弃用：数据已随仓库文件夹保存（.knowbase/），数据库文件导入不再支持。如需恢复数据请使用 设置 → 数据与仓库 的整仓备份/恢复'

export function registerImportHandlers(): void {
  // ===== 弃用：旧 .db 整库替换 / JSON 合并 / PDF·二进制入库 / 备份包合并 =====
  ipcMain.handle('import:previewUserFromDb', () => ({ error: DEPRECATED_DB_IMPORT }))
  ipcMain.handle('import:importPdf', () => ({ error: DEPRECATED_DB_IMPORT }))
  ipcMain.handle('import:importBinary', () => ({ error: DEPRECATED_DB_IMPORT }))
  ipcMain.handle('import:importPdfFile', () => ({ error: DEPRECATED_DB_IMPORT }))
  ipcMain.handle('import:importBinaryFile', () => ({ error: DEPRECATED_DB_IMPORT }))
  ipcMain.handle('import:importDb', () => ({ success: false, message: DEPRECATED_DB_IMPORT }))
  ipcMain.handle('import:executeImport', () => ({ success: false, imported: 0, skipped: 0, message: DEPRECATED_DB_IMPORT }))
  ipcMain.handle('import:importBackupPackage', () => ({ success: false, imported: 0, skipped: 0, attachments: 0, message: DEPRECATED_DB_IMPORT }))

  // ===== 导入文件对话框 =====
  ipcMain.handle('import:showOpenDialog', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '文本/代码/PDF/XMind文件', extensions: [...TEXT_EXTS, 'pdf', 'xmind'] },
      ],
      title: '导入文件到知识库'
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('import:readFiles', async (_e, paths: string[]) => {
    return paths.map(p => {
      const ext = extname(p).slice(1).toLowerCase()
      if (ext === 'pdf' || ext === 'xmind') {
        return { path: p, baseName: fileNameBase(p), content: '', fileType: ext, error: `${ext.toUpperCase()} files are imported via import:import${ext.charAt(0).toUpperCase() + ext.slice(1)}File` }
      }
      try {
        const content = readFileSync(p, 'utf-8')
        return { path: p, baseName: fileNameBase(p), content, fileType: extToFileType(ext) }
      } catch (e) {
        return { path: p, baseName: fileNameBase(p), content: '', fileType: '', error: String(e) }
      }
    })
  })

  // ===== Folder import =====
  ipcMain.handle('import:showFolderDialog', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '选择要导入的文件夹'
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('import:importFolder', async (_e, folderPath: string, parentCategoryId: string | null) => {
    // R6 去库化：目录导入唯一路径 = vaultImportFolder（目录镜像 + 文本转 frontmatter md + 二进制附件协议引用）
    try {
      return vaultImportFolder(folderPath, parentCategoryId)
    } catch (e: any) {
      console.error('[importFolder][vault] failed:', e)
      return { error: String(e) }
    }
  })

  // ===== Data import dialogs =====
  ipcMain.handle('import:showDataDialog', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'openDirectory'],
      filters: [
        { name: '支持的文件（备份包 zip / JSON）', extensions: ['zip', 'json'] },
      ],
      title: '导入 Phrontis 数据'
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('import:readFile', async (_e, filePath: string) => {
    try { return readFileSync(filePath, 'utf-8') }
    catch { return null }
  })
}
