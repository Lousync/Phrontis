import { ipcMain, dialog, shell } from 'electron'
import { BrowserWindow } from 'electron'
import {
  vaultBookmarksAll, vaultCreateCategory, vaultUpdateCategory, vaultDeleteCategory,
  vaultReorderCategories, vaultCreateBookmark, vaultUpdateBookmark, vaultDeleteBookmark,
} from '../../lib/kbStore/bookmarkVaultRepo'

// R6 去库化：真相源 = .knowbase/modules/bookmarks/（bookmarks.json / categories.json，sql.js 路径已移除，D9）

export function registerBookmarkHandlers(): void {

  // ---- 数据 ----
  ipcMain.handle('bookmark:getAll', () => {
    return vaultBookmarksAll()
  })

  ipcMain.handle('bookmark:createCategory', (_e, data: { name: string; color?: string }) => {
    return vaultCreateCategory(data.name, data.color)
  })

  ipcMain.handle('bookmark:updateCategory', (_e, id: string, data: { name?: string; color?: string }) => {
    return vaultUpdateCategory(id, data)
  })

  ipcMain.handle('bookmark:deleteCategory', (_e, id: string) => {
    // 分类下的书签移入未分类，不删书签
    vaultDeleteCategory(id)
  })

  ipcMain.handle('bookmark:reorderCategories', (_e, orderedIds: string[]) => {
    vaultReorderCategories(orderedIds)
  })

  ipcMain.handle('bookmark:createBookmark', (_e, data: {
    title: string; url: string; description?: string; categoryId?: string; starred?: boolean
  }) => {
    return vaultCreateBookmark(data)
  })

  ipcMain.handle('bookmark:updateBookmark', (_e, id: string, data: {
    title?: string; url?: string; description?: string; categoryId?: string | null; starred?: boolean
  }) => {
    return vaultUpdateBookmark(id, data)
  })

  ipcMain.handle('bookmark:deleteBookmark', (_e, id: string) => {
    vaultDeleteBookmark(id)
  })

  // ---- 外链 / 文件（与存储形态无关，恒可用）----
  // 协议白名单:书签 URL 可经 JSON 导入植入,仅放行网页协议,防 file:// / 自定义协议拉起外部程序
  ipcMain.handle('bookmark:openUrl', async (_e, url: string) => {
    if (typeof url !== 'string' || !url) return
    let u: URL
    try { u = new URL(url) } catch { return }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return
    await shell.openExternal(url)
  })

  ipcMain.handle('bookmark:pickImportFile', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [
        { name: '书签文件（JSON / 浏览器收藏夹 HTML）', extensions: ['json', 'html', 'htm'] },
      ],
      title: '选择要导入的书签文件',
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
}
