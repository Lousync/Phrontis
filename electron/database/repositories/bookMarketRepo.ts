import { ipcMain } from 'electron'
import { broadcastDataChanged } from '../../main/windowBus'
import { bookCoverReadDataUrl } from '../../lib/kbStore/vaultBookMetaRepo'
import {
  bookSourceClearCredential, bookSourceInfos, bookSourceRemove, bookSourceSaveCredential,
  bookSourceSetEnabled, bookSourceUpsert,
} from '../../lib/kbStore/bookSourceVaultRepo'
import { probeSourceConnectivity, searchBookSources } from '../../lib/bookMarket/sourceClient'
import { controlDownload, listDownloadQueue, startDownload } from '../../lib/bookMarket/downloader'
import { deleteBookEverywhere } from '../../lib/bookDelete'

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
 *   bookMarket:coverGet         封面字节（**只读**，S4 拍板 ①；书架显示下载来的封面用）
 *   bookMarket:deleteBook       彻底删书（书架右键入口）→ 书文件进系统回收站 + 清 meta/封面/进度/书签/摘录/导出映射
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

  // 封面只读（S4 拍板 ①）：书架显示书市下到的封面用。
  // 路径守卫在 repo 层（bookCoverAbsPath → isSafeCoverRel），越权/缺失/超限一律 null，
  // 渲染层拿不到就回落纯色书卡 —— 封面是增益，不该让书架整页报错。
  ipcMain.handle('bookMarket:coverGet', (_e, rootId: string, coverRel: string) => {
    try {
      return { ok: true, dataUrl: bookCoverReadDataUrl(String(coverRel ?? ''), String(rootId ?? '')) }
    } catch (e) {
      return { ok: false, dataUrl: null, error: (e as Error).message }
    }
  })

  /**
   * 彻底删书（2026-09-23 拍板：右键菜单入口 + 范围「彻底删」）。
   *
   * 本 handler 只做两件事：转发给 `lib/bookDelete.deleteBookEverywhere` + 广播。
   * 七步清理的实现与顺序约束见那个文件（★ 放 `lib/` 而非 `kbStore/`：
   * 清理要调 `workspaceManager`，而下沉进 kbStore 会形成 `kbStore → workspaceManager` 循环
   * ——后者已 import kbStore）。核里不广播，广播留在这里，故核可被运行期探针直接调用。
   *
   * 广播 4 个 scope：书架监听 pdfReader/knowledge，右栏监听 readerState/pdfReader/excerpt。
   */
  ipcMain.handle('bookMarket:deleteBook', async (_e, rootId: string, relPath: string) => {
    const r = await deleteBookEverywhere(String(rootId ?? ''), String(relPath ?? ''))
    for (const s of ['pdfReader', 'knowledge', 'readerState', 'excerpt']) broadcastDataChanged(s)
    return r
  })
}
