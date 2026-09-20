import { ipcMain } from 'electron'
import { broadcastDataChanged } from '../../main/windowBus'
import { getCurrentVault } from '../../lib/kbStore/vaultContext'
import { excerptCreate, excerptDelete, excerptList, excerptPatch } from '../../lib/kbStore/excerptVaultRepo'

/**
 * 摘录 IPC 注册转发层（书架阅读器 · 摘录先行批次）。
 * handler 只做转发 + 广播，逻辑全在 lib/kbStore/excerptVaultRepo.ts（真相源）。
 *
 * 通道清单：
 *   excerpt:list    单本书全部摘录（at 升序）
 *   excerpt:create  创建（kind/page/rects/paraIndex/start/end/text 校验）→ broadcastDataChanged
 *   excerpt:patch   备注修改（expectedUpdatedAt 冲突检测）→ broadcastDataChanged
 *   excerpt:delete  删除 → broadcastDataChanged
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
}
