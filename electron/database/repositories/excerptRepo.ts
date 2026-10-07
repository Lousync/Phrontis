import { ipcMain } from 'electron'
import { broadcastDataChanged } from '../../main/windowBus'
import { getCurrentVault } from '../../lib/kbStore/vaultContext'
import { excerptCreate, excerptDelete, excerptList, excerptPatch } from '../../lib/kbStore/excerptVaultRepo'
import { excerptExportToNote, getExportEntry } from '../../lib/kbStore/excerptExportVaultRepo'

/**
 * 摘录 IPC 注册转发层（书架阅读器 · 摘录先行批次）。
 * handler 只做转发 + 广播，逻辑全在 lib/kbStore/excerptVaultRepo.ts（真相源）。
 *
 * 通道清单：
 *   excerpt:list        单本书全部摘录（at 升序）
 *   excerpt:create      创建（kind/page/rects/paraIndex/start/end/text 校验）→ broadcastDataChanged
 *   excerpt:patch       备注修改（expectedUpdatedAt 冲突检测）→ broadcastDataChanged
 *   excerpt:delete      删除 → broadcastDataChanged
 *   excerpt:exportEntry 查某书的导出映射（右栏书卡头显示「已导出 / 条数」用）
 *   excerpt:exportNote  导出为知识库「读书笔记」页（每本书一篇，重复导出覆盖重写同一篇）→ broadcastDataChanged('knowledge')
 */

export function registerExcerptHandlers(): void {
  ipcMain.handle('excerpt:list', (_e, rootId: string, relPath: string) => {
    try {
      return { ok: true, excerpts: excerptList(String(rootId), String(relPath)) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('excerpt:create', (_e, rootId: string, relPath: string, payload: unknown) => {
    const r = excerptCreate(String(rootId), String(relPath), payload)
    if (r.ok) broadcastDataChanged('excerpt')
    return r
  })

  ipcMain.handle('excerpt:patch', (_e, rootId: string, relPath: string, id: string, patch: unknown, expectedUpdatedAt?: string) => {
    const r = excerptPatch(String(rootId), String(relPath), String(id), patch, typeof expectedUpdatedAt === 'string' ? expectedUpdatedAt : undefined)
    if (r.ok) broadcastDataChanged('excerpt')
    return r
  })

  ipcMain.handle('excerpt:delete', (_e, rootId: string, relPath: string, id: string) => {
    const r = excerptDelete(String(rootId), String(relPath), String(id))
    if (r.ok) broadcastDataChanged('excerpt')
    return r
  })

  ipcMain.handle('excerpt:exportEntry', (_e, rootId: string, relPath: string) => {
    try {
      return { ok: true, entry: getExportEntry(String(rootId), String(relPath)) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('excerpt:exportNote', (_e, rootId: string, relPath: string) => {
    const r = excerptExportToNote(String(rootId), String(relPath))
    // 导出写的是知识库 .md（新建或覆盖重写）→ 广播 knowledge，否则列表/搜索看不到新页
    if (r.ok) broadcastDataChanged('knowledge')
    return r
  })
}
