import { ipcMain, dialog, BrowserWindow } from 'electron'
import { resolve } from 'path'
import { writeFileSync, statSync } from 'fs'
import * as iconv from 'iconv-lite'

/**
 * 导出基础层（R6 去库化收尾处置）：
 * - 保留：保存对话框（写路径授权源）+ 文本文件写出（渲染层 blog md / knowledge json
 *   等 vault 数据导出仍经由本通道落盘）。
 * - 删除：buildAllData 全库 JSON 导出（逐表读 sqlite）——数据已 vault 化，
 *   连同 backupRepo 的整包备份一起退役；全仓备份改走 vaultBackupRepo（.knowbase 目录 zip）。
 */

function encodeText(content: string, encoding: string): Buffer {
  if (encoding === 'utf-8' || encoding === 'utf8') return Buffer.from(content, 'utf-8')
  try { return iconv.encode(content, encoding) as Buffer }
  catch { return Buffer.from(content, 'utf-8') }
}

// ===== 写路径授权 =====
// 只有近期由"保存对话框"返回的路径才允许被写入 IPC 使用——
// 防止渲染层被注入后用任意路径覆写系统文件(启动目录/计划任务等)。
const authorizedWritePaths = new Set<string>()

export function isWritePathAuthorized(p: string): boolean {
  try {
    const resolved = resolve(p)
    for (const ap of authorizedWritePaths) {
      if (resolve(ap) === resolved) return true
    }
  } catch { /* ignore */ }
  return false
}

export function registerExportHandlers(): void {
  // ===== File dialogs =====
  ipcMain.handle('export:showSaveDialog', async (_e, opts: { defaultName: string; filters: { name: string; extensions: string[] }[] }) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return { filePath: null }
    const result = await dialog.showSaveDialog(win, {
      defaultPath: opts.defaultName,
      filters: opts.filters
    })
    const filePath = result.canceled ? null : result.filePath ?? null
    if (filePath) authorizedWritePaths.add(filePath)
    return { filePath }
  })

  // ===== File I/O =====
  ipcMain.handle('export:writeTextFile', (_e, filePath: string, content: string, encoding: string = 'utf-8') => {
    if (!isWritePathAuthorized(filePath)) throw new Error('写入路径未经过保存对话框授权,已拒绝')
    const buf = encodeText(content, encoding)
    writeFileSync(filePath, buf)
    const size = statSync(filePath).size
    return { filePath, size }
  })

  /**
   * 页面导出 PDF（2026-10-13 页面菜单能力补齐批 3）：
   * **打印的是当前主窗口**（`printToPDF`），所以渲染层得先把版面切成「只留正文」——
   * 走的是「临时进沉浸阅读态 + 一段 @media print 兜底样式」。
   *
   * 为什么由主进程打而不是渲染层自己拼 PDF：Electron 只有 `webContents.printToPDF` 这一条路，
   * 它能完整复用我们现有的排版（主题变量、代码高亮、表格、图片），另拼一套 PDF 排版必然漂。
   *
   * 安全口径与文本导出**完全一致**：只写「刚由保存对话框返回过」的路径（`isWritePathAuthorized`），
   * 渲染层被注入也覆写不了任意系统文件。
   */
  ipcMain.handle('export:writePdf', async (_e, filePath: string) => {
    if (!isWritePathAuthorized(filePath)) throw new Error('写入路径未经过保存对话框授权,已拒绝')
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: '没有可打印的窗口' }
    try {
      const buf = await win.webContents.printToPDF({
        printBackground: true,     // 主题底色 / 代码块底色要留住（否则深色主题打出白底黑字的花脸）
        pageSize: 'A4',
        margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 }, // 英寸
      })
      writeFileSync(filePath, buf)
      return { ok: true, filePath, size: statSync(filePath).size }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '导出失败' }
    }
  })
}
