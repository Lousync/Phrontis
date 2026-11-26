import { ipcMain } from 'electron'
import { listPageStore, readPageStore, writePageStore } from '../../lib/pageStore'

/**
 * 页面数据（page store）的 IPC 注册层。
 *
 * 只做转发：路径校验 / JSON 校验 / 冲突检测 / 原子写 / 广播全在
 * `electron/lib/pageStore.ts`（AI 工具 `builtin.pagedata.*` 走同一个实现）。
 *
 * 为什么不让渲染层直接 `ws:writeFile`：
 * - 那条通道能写仓库任意路径（含 `.knowbase/modules/**`），页面脚本一旦能借道就等于开了
 *   `.knowbase` 的写白名单 —— 铁律 2 明令禁止；
 * - 页面数据需要「乐观锁 + 大小上限 + 只允许 pagesdata」这三条，`ws:writeFile` 一条都没有。
 *
 * 调用方只有 `src/lib/pageStoreBridge.ts`（知识库 / AI 教学两个 html 渲染面共用）。
 */

export function registerPageStoreHandlers(): void {
  ipcMain.handle('pageStore:read', (_e, rel: unknown) => {
    try {
      return readPageStore(rel)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('pageStore:write', (_e, rel: unknown, data: unknown, expectedRev?: unknown) => {
    try {
      return writePageStore(rel, data, expectedRev)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // AI 工具 / 调试用：列出 pagesdata 下有哪些数据文件
  ipcMain.handle('pageStore:list', () => {
    try {
      return { ok: true, ...listPageStore() }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
