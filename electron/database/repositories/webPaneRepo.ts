import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import {
  clearWebPaneData, closeWebPane, createWebPane, disposeAllWebPanes, getWebPaneState,
  hideAllWebPanes, setWebPaneBounds, setWebPaneUrl, setWebPaneVisible,
  webPaneGoBack, webPaneGoForward, webPaneReload,
  type WebPaneBounds,
} from '../../lib/webPaneView'

/**
 * AI 教学右侧查看器 · 网页页签 IPC 注册层（v3.45.0，方案 §4.1 / §6.1）
 *
 * 与其余 33 个 `registerXxxHandlers()` 同规：本文件只是**转发层**，所有状态与安全钩子都在
 * `electron/lib/webPaneView.ts`；这里只负责「拿窗口 + 转参数 + 兜异常」。
 *
 * 通道（渲染层封装见 src/lib/ipc.ts，preload 见 electron/preload/index.ts）：
 *   webPane:create / setUrl / setBounds / setVisible / hideAll
 *   webPane:back / forward / reload / close / state / clearData / disposeAll
 * 主进程 → 渲染层：`webPane:changed`（载荷 `{ id, state }`，由 webPaneView 直接发给所属窗口）。
 *
 * ★ 窗口来源：`BrowserWindow.fromWebContents(event.sender)` —— 谁发起调用谁就是宿主。
 *   刻意不用 `getFocusedWindow()`：应用里还有 dock 小窗（dayPanelWindow），用户点完主窗再点
 *   小窗时焦点会切走，按焦点取窗口会把网页视图挂到错误窗口上（表象：网页不显示）。
 *   取不到就返回 `{ ok:false }`，绝不抛错 —— 渲染层在窗口关闭竞态里仍可能重放调用。
 */

export interface WebPaneRegisterResult {
  ok: boolean
  error?: string
}

/** 重复注册会抛「Attempted to register a second handler」，用标志兜底（热重启 / 测试双调） */
let registered = false

/** 取发起调用的主窗口；拿不到返回 null（调用方统一转成 `{ ok:false }`） */
function ownerWindow(sender: WebContents): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(sender)
  if (win && !win.isDestroyed()) return win
  const fallback = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  return fallback && !fallback.isDestroyed() ? fallback : null
}

function fail(error: string): WebPaneRegisterResult {
  return { ok: false, error }
}

export function registerWebPaneHandlers(): void {
  if (registered) return
  registered = true

  ipcMain.handle('webPane:create', (event, payload: unknown) => {
    const win = ownerWindow(event.sender)
    if (!win) return fail('主窗口不可用')
    const p = (payload ?? {}) as { id?: unknown; url?: unknown }
    try {
      return createWebPane(win, p.id, p.url)
    } catch (e) {
      return fail((e as Error).message)
    }
  })

  ipcMain.handle('webPane:setUrl', (_event, id: string, url: string) => {
    try {
      return setWebPaneUrl(String(id), url)
    } catch (e) {
      return fail((e as Error).message)
    }
  })

  ipcMain.handle('webPane:setBounds', (_event, id: string, bounds: WebPaneBounds) => {
    try {
      return setWebPaneBounds(String(id), bounds)
    } catch (e) {
      return fail((e as Error).message)
    }
  })

  ipcMain.handle('webPane:setVisible', (_event, id: string, visible: boolean) => {
    try {
      return setWebPaneVisible(String(id), visible)
    } catch (e) {
      return fail((e as Error).message)
    }
  })

  ipcMain.handle('webPane:hideAll', () => {
    try {
      hideAllWebPanes()
      return { ok: true }
    } catch (e) {
      return fail((e as Error).message)
    }
  })

  ipcMain.handle('webPane:back', (_event, id: string) => {
    try {
      return webPaneGoBack(String(id))
    } catch (e) {
      return fail((e as Error).message)
    }
  })

  ipcMain.handle('webPane:forward', (_event, id: string) => {
    try {
      return webPaneGoForward(String(id))
    } catch (e) {
      return fail((e as Error).message)
    }
  })

  ipcMain.handle('webPane:reload', (_event, id: string) => {
    try {
      return webPaneReload(String(id))
    } catch (e) {
      return fail((e as Error).message)
    }
  })

  ipcMain.handle('webPane:close', (_event, id: string) => {
    try {
      return closeWebPane(String(id))
    } catch (e) {
      return fail((e as Error).message)
    }
  })

  // 渲染层初次挂载时取一次快照（create 之后的事件可能在监听器挂上之前就发完了）
  ipcMain.handle('webPane:state', (_event, id: string) => {
    try {
      return getWebPaneState(String(id))
    } catch {
      return null
    }
  })

  // 设置页入口：清 cookie / storage / cache（C3 配套）。异步，等真正清完再回 ok
  ipcMain.handle('webPane:clearData', async () => {
    try {
      return await clearWebPaneData()
    } catch (e) {
      return fail((e as Error).message)
    }
  })

  // 页面卸载 / 窗口关闭时的兜底回收（主进程也会在窗口 closed 时直接调 disposeAllWebPanes）
  ipcMain.handle('webPane:disposeAll', () => {
    try {
      disposeAllWebPanes()
      return { ok: true }
    } catch (e) {
      return fail((e as Error).message)
    }
  })
}
