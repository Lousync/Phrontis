import { BrowserWindow, globalShortcut, screen, clipboard, app, ipcMain } from 'electron'
import { join } from 'path'
import { readFileSync, existsSync } from 'fs'
import { decodePassword, createPasswordEntryRow } from '../database/repositories/passwordRepo'
import { vaultPasswordsAll } from '../lib/kbStore/secretVaultRepo'
import { pushAppNotice } from '../lib/appNotice'
import { applyUiZoomTo, getUiZoom } from './uiZoom'

/** 小密码本的设计尺寸（CSS px）；窗口实际 DIP 尺寸 = 设计尺寸 × 界面缩放 */
const FILL_W = 340
const FILL_H = 420

let fillWindow: BrowserWindow | null = null

/**
 * 置顶等级：'screen-saver' 是 Electron 在 Windows/macOS 上的最高层级，
 * 高于普通 always-on-top（'floating'）窗口 —— 小密码本要能盖住浏览器/编辑器
 * 以及其它同样是置顶窗口的应用（旧值 'floating' 会被同级置顶窗口压住）。
 */
const TOP_LEVEL = 'screen-saver' as const

/** 当前是否置顶（默认 true；用户可在弹窗标题栏取消，写入 settings.fillPopupAlwaysOnTop） */
function isPinned(): boolean {
  return getSettingsJSON().fillPopupAlwaysOnTop !== false
}

function applyPin(win: BrowserWindow, pinned: boolean): void {
  if (win.isDestroyed()) return
  win.setAlwaysOnTop(pinned, TOP_LEVEL)
  if (pinned) win.moveTop()
}

function getSettingsJSON(): Record<string, unknown> {
  try {
    const sp = join(app.getPath('userData'), 'settings.json')
    if (existsSync(sp)) return JSON.parse(readFileSync(sp, 'utf-8'))
  } catch { /* */ }
  return {}
}

// --------------- floating window ---------------

function createFillWindow(): BrowserWindow {
  const theme = String(getSettingsJSON().theme || 'dark')
  const bgColor = theme === 'light' ? '#f3f3f3' : '#1e1e1e'
  // 页面缩放（v3.13.2）：窗口尺寸同步乘 zoom，保证弹窗内部仍是设计上的 340×420 CSS px
  const zoom = getUiZoom()

  const win = new BrowserWindow({
    width: Math.round(FILL_W * zoom), height: Math.round(FILL_H * zoom),
    frame: false, alwaysOnTop: true, skipTaskbar: true, show: false,
    resizable: false, maximizable: false, minimizable: false,
    backgroundColor: bgColor,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      additionalArguments: ['--fill-popup-window', `--theme=${theme}`],
    },
  })

  // Never steal focus — user stays in their target app
  win.setAlwaysOnTop(true, TOP_LEVEL)
  // 全屏应用/其它工作区之上仍可见（macOS 全屏空间、Windows 全屏窗口场景）
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 抢回 z 序：被其它置顶窗口压住后，本窗获得焦点时重新置顶（不改变焦点归属）
  win.on('focus', () => { if (isPinned()) win.moveTop() })

  // 与主窗口同级的导航防护:悬浮窗自身永不导航、永不开新窗口
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // 页面缩放：dom-ready 后应用（加载前设值会被导航覆盖）
  win.webContents.on('dom-ready', () => applyUiZoomTo(win))

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/fill-popup`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function showFillPopup() {
  if (!fillWindow || fillWindow.isDestroyed()) {
    fillWindow = createFillWindow()
  }

  const cursor = screen.getCursorScreenPoint()
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  // 窗口实际尺寸随界面缩放（见 createFillWindow），越界夹取也要用同一组值
  const zoom = getUiZoom()
  const winW = Math.round(FILL_W * zoom)
  const winH = Math.round(FILL_H * zoom)

  let x = cursor.x + 10, y = cursor.y + 10
  if (x + winW > width) x = width - winW - 10
  if (y + winH > height) y = cursor.y - winH - 10

  fillWindow.setPosition(x, y)
  applyPin(fillWindow, isPinned()) // 每次唤出都按当前设置重断言层级（用户可能中途改过）
  fillWindow.showInactive() // show but don't steal focus
  fillWindow.moveTop()
  fillWindow.webContents.send('fillPopup:refresh')
}

// --------------- export ---------------

export function initPasswordFiller() {
  ipcMain.handle('fillPopup:getEntries', () => {
    // R6 去库化：密码本读 .knowbase/secret/passwords.json（行结构与旧表一致；排序同原 SQL）
    return vaultPasswordsAll()
      .slice()
      // 收藏优先（与主窗口总览页口径一致），其次 sort_order，最后更新时间倒序
      .sort((a, b) => (Number(b.favorite === true) - Number(a.favorite === true))
        || (a.sort_order - b.sort_order)
        || (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
      .map((r) => {
        const dec = decodePassword(r.password)
        return {
          id: r.id, title: r.title, url: r.url || '', account: r.account || '',
          username: r.username || '', password: dec.value, notes: r.notes || '',
          // 来自其他系统的密文在本机解不开（Linux 平台化三态）：小密码本同样要能显示「无法解密」，
          // 不能给一个空密码让人以为是「没存过」
          passwordUndecryptable: dec.state === 'undecryptable',
          sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at,
          favorite: r.favorite === true, group: r.group || ''
        }
      })
  })

  // Copy to clipboard — 30 秒后若剪贴板仍是所复制的密码则自动清空(不覆盖用户后续复制的内容)
  let clipboardClearTimer: NodeJS.Timeout | null = null
  ipcMain.handle('fillPopup:copy', (_e, field: string, value: string) => {
    clipboard.writeText(value)
    if (clipboardClearTimer) clearTimeout(clipboardClearTimer)
    clipboardClearTimer = setTimeout(() => {
      clipboardClearTimer = null
      try { if (clipboard.readText() === value) clipboard.writeText('') } catch { /* ignore */ }
    }, 30_000)
    console.log(`[PasswordFiller] copied ${field}`)
  })

  ipcMain.handle('fillPopup:hide', () => {
    if (fillWindow && !fillWindow.isDestroyed()) fillWindow.hide()
  })

  // 悬浮窗内直接新增密码条目（与主窗口 passwordVault:create 同一份创建逻辑）
  ipcMain.handle('fillPopup:createEntry', (_e, data: {
    title?: string; url?: string; username?: string; account?: string; password?: string; notes?: string
  }) => {
    return createPasswordEntryRow(data || {})
  })

  // 置顶开关：立即生效 + 落盘（settings 通道由渲染层写入，主进程只负责窗口层级）
  ipcMain.handle('fillPopup:setAlwaysOnTop', (_e, on: boolean) => {
    if (fillWindow && !fillWindow.isDestroyed()) applyPin(fillWindow, !!on)
    return !!on
  })

  const settings = getSettingsJSON()
  const shortcutKey = (settings.fillPopupShortcut as string) || 'Ctrl+Alt+P'

  try {
    // ⚠️ 结论看**返回值**，不是有没有抛异常：false = 组合键被别的程序占了 / 平台不支持
    // （Linux 原生 Wayland 会话下 globalShortcut 恒失败，见本仓平台口径）。原先只 catch
    // 异常，于是「注册没成功」被当成功记进日志，用户那边是「按了没反应、也无从得知为什么」。
    const ok = globalShortcut.register(shortcutKey, () => {
      if (fillWindow && fillWindow.isVisible() && !fillWindow.isDestroyed()) {
        fillWindow.hide()
      } else {
        showFillPopup()
      }
    })
    if (ok) {
      console.log(`[PasswordFiller] Global shortcut registered: ${shortcutKey}`)
    } else {
      console.warn(`[PasswordFiller] 全局快捷键注册失败（可能被其他程序占用）：${shortcutKey}`)
      pushAppNotice({
        type: 'warning',
        message: `密码填充快捷键 ${shortcutKey} 没能生效`,
        detail: '该组合键可能已被其他程序占用；原生 Wayland 会话下全局快捷键也不可用（本项目只支持 X11/XWayland）。释放冲突或切到 X11 会话后重启应用即可恢复。',
      })
    }
  } catch (e) {
    console.error(`[PasswordFiller] Failed to register shortcut "${shortcutKey}":`, e)
  }
}

export function destroyPasswordFiller() {
  globalShortcut.unregisterAll()
  if (fillWindow && !fillWindow.isDestroyed()) { fillWindow.close(); fillWindow = null }
}
