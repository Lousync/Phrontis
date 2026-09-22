import { ipcMain } from 'electron'
import { broadcastDataChanged } from '../../main/windowBus'
import {
  bookSourceClearCredential, bookSourceInfos, bookSourceRemove, bookSourceSaveCredential,
  bookSourceSetEnabled, bookSourceUpsert,
} from '../../lib/kbStore/bookSourceVaultRepo'
import { probeSourceConnectivity, searchBookSources } from '../../lib/bookMarket/sourceClient'
import { controlDownload, listDownloadQueue, startDownload } from '../../lib/bookMarket/downloader'

/**
 * 书市 IPC 注册转发层（方案 §2.3）。
 * handler 只做转发 + 广播，逻辑全在 lib/kbStore 与 lib/bookMarket（真相源）。
 *
 * 通道清单（`<domain>:<action>`，与 `excerpt:list` / `readerState:patch` 同格式）：
 *   bookMarket:listSources      书源清单（**只报 hasCredential 布尔**，永不回传凭据本体）→ { sources }
 *   bookMarket:upsertSource     新建 / 更新（带 id 即更新）→ broadcastDataChanged
 *   bookMarket:removeSource     删除（内置源拒绝）→ broadcastDataChanged
 *   bookMarket:setSourceEnabled 启用 / 停用 → broadcastDataChanged
 *   bookMarket:saveCredential   存 / 清凭据（密文只进 secretStore）→ broadcastDataChanged
 *   bookMarket:probeSource      单源连通性三态（书源列表的「已连通 / 需要凭据 / 连接失败」）
 *   bookMarket:search           聚合检索（部分源失败只进 failed[]，不整页报错）
 *   bookMarket:download         入队下载（重名闸未决时返回 conflict，**不入队**）
 *   bookMarket:downloadControl  队列逐项 / 批量控制（pause·resume·cancel·retry·pause-all·resume-all·clear-done）
 *   bookMarket:listQueue        当前仓库的队列快照
 *
 * ★ 位置参数 `(rootId, …)`（不是对象）—— 实测约定，同 `pdfReaderRepo.ts`。
 * ★ 写盘一律由 lib 侧广播 `broadcastDataChanged('bookMarket')`；本层只负责
 *   **书源/凭据**这两类「本层直接调 repo」的写操作（下载器的广播在 downloader 里）。
 */

export function registerBookMarketHandlers(): void {
  ipcMain.handle('bookMarket:listSources', (_e, rootId: string) => {
    try {
      return { ok: true, sources: bookSourceInfos(String(rootId)) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('bookMarket:upsertSource', (_e, rootId: string, patch: unknown, id?: string) => {
    const r = bookSourceUpsert(String(rootId), patch, typeof id === 'string' && id ? id : undefined)
    // 凭据存的是密文（不在源描述里），但书源清单的形状变了 ⇒ 照常广播，否则列表还显示旧名字
    if (r.ok) broadcastDataChanged('bookMarket')
    return r
  })

  ipcMain.handle('bookMarket:removeSource', (_e, rootId: string, id: string) => {
    const r = bookSourceRemove(String(rootId), String(id))
    if (r.ok) broadcastDataChanged('bookMarket')
    return r
  })

  ipcMain.handle('bookMarket:setSourceEnabled', (_e, rootId: string, id: string, enabled: boolean) => {
    const r = bookSourceSetEnabled(String(rootId), String(id), !!enabled)
    if (r.ok) broadcastDataChanged('bookMarket')
    return r
  })

  ipcMain.handle('bookMarket:saveCredential', (_e, rootId: string, id: string, credential: unknown) => {
    // `null` / 缺省 = 清空凭据（UI 的「清除凭据」按钮不必另开一个通道）
    const r = credential == null
      ? bookSourceClearCredential(String(rootId), String(id))
      : bookSourceSaveCredential(String(rootId), String(id), credential)
    if (r.ok) broadcastDataChanged('bookMarket')
    return r
  })

  ipcMain.handle('bookMarket:probeSource', async (_e, rootId: string, id: string, query?: string) => {
    try {
      const state = await probeSourceConnectivity(String(rootId), String(id), typeof query === 'string' && query ? query : 'test')
      return { ok: true, state }
    } catch (e) {
      return { ok: false, state: 'fail', error: (e as Error).message }
    }
  })

  ipcMain.handle('bookMarket:search', async (_e, rootId: string, query: string, opts?: unknown) => {
    try {
      // ★ 返回里带 `connectivity`：书源列表的三态**顺手**就刷新了，不必再发一轮探测请求
      const r = await searchBookSources(String(rootId), String(query ?? ''), (opts ?? {}) as { sourceIds?: string[]; page?: number })
      return { ok: true, items: r.items, failed: r.failed, connectivity: r.connectivity }
    } catch (e) {
      return { ok: false, items: [], failed: [], error: (e as Error).message }
    }
  })

  ipcMain.handle('bookMarket:download', (_e, rootId: string, payload: unknown, conflict?: unknown) => {
    const c = conflict === 'overwrite' || conflict === 'copy' ? conflict : undefined
    return startDownload(String(rootId), payload, c)
  })

  ipcMain.handle('bookMarket:downloadControl', (_e, rootId: string, id: string, action: string) => {
    return controlDownload(String(rootId), String(id ?? ''), action)
  })

  ipcMain.handle('bookMarket:listQueue', (_e, rootId: string) => {
    try {
      return { ok: true, tasks: listDownloadQueue(String(rootId)) }
    } catch (e) {
      return { ok: false, tasks: [], error: (e as Error).message }
    }
  })
}
