import { ipcMain } from 'electron'
import { broadcastDataChanged } from '../../main/windowBus'
import { getCurrentVault } from '../../lib/kbStore/vaultContext'
import { readerStateGetBook, readerStateListProgress, readerStatePatchBook } from '../../lib/kbStore/readerStateVaultRepo'

/**
 * 阅读状态 IPC 注册转发层（书架升级全格式阅读器一期，方案 §S2.3）。
 * handler 只做转发 + 广播，逻辑全在 lib/kbStore/readerStateVaultRepo.ts（真相源）。
 *
 * 通道清单：
 *   readerState:get    读单本（txt）书状态
 *   readerState:patch  局部写回（expectedUpdatedAt 冲突检测）→ broadcastDataChanged
 */

export function registerReaderStateHandlers(): void {
  ipcMain.handle('readerState:get', (_e, rootId: string, relPath: string) => {
    try {
      return { ok: true, state: readerStateGetBook(String(rootId), String(relPath)) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('readerState:patch', (_e, rootId: string, relPath: string, patch: unknown, expectedUpdatedAt?: string) => {
    const r = readerStatePatchBook(String(rootId), String(relPath), patch, typeof expectedUpdatedAt === 'string' ? expectedUpdatedAt : undefined)
    if (r.ok) broadcastDataChanged('readerState')
    return r
  })
}
