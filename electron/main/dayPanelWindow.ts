import { BrowserWindow, ipcMain, screen, globalShortcut, shell } from 'electron'
import { join } from 'path'
import { broadcast, BROADCAST_CHANNEL } from './windowBus'
import { pushAppNotice } from '../lib/appNotice'

/**
 * 日程与打卡侧边栏管理器
 *
 * - detached=false：内嵌（主窗口内 flex 面板）
 * - detached=true：popout 独立窗口（自由漂浮），可拖动、可调整大小
 *
 * 高度自适应（2026-09-01 调整）：
 *   渲染层用 ResizeObserver 报告 document 所需高度，主进程据此把窗口高度贴合内容。
 *   「内容变多」会跟上；「内容变少」不缩（保留用户拉大的空间）。
 *   首次开窗（firstSizeSet=false）强制贴合内容，避免开窗闪一下默认高度再缩到内容。
 *
 * 2026-10-20：顶部停靠（top-dock）与桌面小组件（desktop-widget）两种形态已按用户要求删除，
 * 只保留自由漂浮。「任务栏 / 顶栏联动」由 GNOME 扩展承担，不再在应用内做形态切换。
 */

const DEFAULT_W = 300
const DEFAULT_H = 520
const BOUNDS_SAVE_MS = 400        // 位置/尺寸落盘防抖
const TOP_EDGE_DIRTY = 48         // 旧版本停靠残留：保存位置距顶缘 ≤ 该值视为无效，改用默认偏移

let popout: BrowserWindow | null = null
let getMainWindow: () => BrowserWindow | null = () => null
let getRendererUrl: () => string | null = () => null
let getSetting: (key: string) => unknown = () => undefined
let setSetting: (key: string, value: unknown) => void = () => {}

let boundsSaveTimer: ReturnType<typeof setTimeout> | null = null
/** 上次 setSize 过的目标高度，仅向上跟随 */
let lastAppliedH = 0
let lastAppliedW = 0
/** 本次 detached 是否已收到首次内容尺寸（决定开窗是否仍需等待） */
let firstSizeSet = false

function broadcastState(): void {
  broadcast(BROADCAST_CHANNEL.dayPanelStateChanged, { detached: isPopoutOpen() })
}
export function isPopoutOpen(): boolean {
  return !!popout && !popout.isDestroyed()
}

function savedBounds(): { x?: number; y?: number; width?: number; height?: number } {
  const raw = getSetting('dayPanelPopoutBounds')
  if (raw && typeof raw === 'object') return raw as { x?: number; y?: number; width?: number; height?: number }
  return {}
}

/** 自由漂浮窗口的目标位置（尺寸由 applyContentSize 决定） */
function floatingPosition(): { x: number; y: number; width: number } {
  const wa = screen.getPrimaryDisplay().workArea
  const saved = savedBounds()
  const w = DEFAULT_W
  // 旧版本停靠/贴顶时期存下的位置（y≈工作区顶缘）会让漂浮窗一开就贴在最上面，
  // 判为残留，改回工作区右下角
  const dockResidue = typeof saved.y === 'number' && saved.y - wa.y <= TOP_EDGE_DIRTY
  const x = !dockResidue && typeof saved.x === 'number'
    ? saved.x
    : (wa.x + wa.width - w - 24)
  const y = !dockResidue && typeof saved.y === 'number'
    ? saved.y
    : (wa.y + wa.height - DEFAULT_H - 24)
  return { x, y, width: w }
}

/** 把 popout 窗口调成自由漂浮形态（运行时，无重建）。尺寸由 applyContentSize 驱动 */
function applyFloatingMode(win: BrowserWindow): void {
  const wa = screen.getPrimaryDisplay().workArea
  win.setAlwaysOnTop(false)
  win.setIgnoreMouseEvents(false)
  win.setResizable(true)
  win.setMinimumSize(240, 60)
  win.setMaximumSize(wa.width - 80, wa.height - 80)
  const target = floatingPosition()
  // 首次开窗尚未显示，直接落位即可（不做位移动画，避免与随后的内容贴合抢 y）
  win.setPosition(target.x, target.y)
  // 内容自适应基线重置，重新等首次内容报告
  lastAppliedH = 0
  lastAppliedW = 0
  firstSizeSet = false
  broadcastState()
}

/** 收到渲染层报告的「内容所需尺寸」：让窗口高度贴合内容（仅向上跟随；首次强制贴合） */
function applyContentSize(scrollW: number, scrollH: number): void {
  if (!popout || popout.isDestroyed()) return
  const wa = screen.getPrimaryDisplay().workArea
  const w = Math.max(240, Math.min(scrollW, wa.width - 80))
  const minH = 60
  const maxH = wa.height - 80
  const targetH = Math.max(minH, Math.min(scrollH, maxH))
  // 工作区右下角锚定：内容长高时窗口向上生长，底部始终贴住工作区下缘
  const anchorY = wa.y + wa.height - targetH - 24
  const cur = popout.getBounds()
  if (!firstSizeSet) {
    // 首次：直接贴合内容尺寸并显示（避免开窗先默认高度再缩的闪烁）
    popout.setBounds({ x: cur.x, y: anchorY, width: w, height: targetH })
    lastAppliedH = targetH
    lastAppliedW = w
    firstSizeSet = true
    if (!popout.isVisible()) popout.show()
    scheduleSaveBounds()
    return
  }
  if (targetH > lastAppliedH || Math.abs(w - lastAppliedW) > 1) {
    // 内容变高 / 宽度变了 → 跟上；内容变少不缩（保留用户拉大的空间）
    popout.setBounds({ x: cur.x, y: anchorY, width: w, height: targetH })
    lastAppliedH = targetH
    lastAppliedW = w
    scheduleSaveBounds()
  }
}

function createPopout(): void {
  if (popout && !popout.isDestroyed()) {
    popout.show()
    popout.focus()
    return
  }
  firstSizeSet = false
  lastAppliedH = 0
  lastAppliedW = 0

  popout = new BrowserWindow({
    x: 0, y: 0, width: DEFAULT_W, height: DEFAULT_H,
    frame: false,
    skipTaskbar: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: '日程与打卡',
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: ['--day-panel-window'],
    },
  })

  // 形态与位置在开窗前直接落定：内容尺寸报告可能早于 ready-to-show 到达并先 show()，
  // 那时 ready-to-show 不再触发，靠它摆位会留在 (0,0)。
  applyFloatingMode(popout)

  // 同 URL reload 放行（仓库切换等正常刷新），其余导航一律阻断
  popout.webContents.on('will-navigate', (e, url) => {
    const w = popout
    if (w && url === w.webContents.getURL()) return
    e.preventDefault()
  })
  popout.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  popout.webContents.on('render-process-gone', (_e, details) => {
    console.error('[DayPanel popout] render-process-gone:', details)
  })

  const devUrl = getRendererUrl()
  if (devUrl) void popout.loadURL(`${devUrl}#/day-panel`)
  else void popout.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'day-panel' })

  popout.on('moved', scheduleSaveBounds)
  popout.on('resized', scheduleSaveBounds)

  popout.on('closed', () => {
    popout = null
    lastAppliedH = 0
    lastAppliedW = 0
    firstSizeSet = false
    broadcastState()
  })
}

function scheduleSaveBounds(): void {
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer)
  boundsSaveTimer = setTimeout(() => {
    boundsSaveTimer = null
    if (!popout || popout.isDestroyed()) return
    const b = popout.getBounds()
    if (b.width < 40 || b.height < 20) return
    setSetting('dayPanelPopoutBounds', { x: b.x, y: b.y, width: b.width, height: b.height })
  }, BOUNDS_SAVE_MS)
}

function destroyPopout(): void {
  if (boundsSaveTimer) { clearTimeout(boundsSaveTimer); boundsSaveTimer = null }
  if (popout && !popout.isDestroyed()) popout.destroy()
  popout = null
  lastAppliedH = 0
  lastAppliedW = 0
  firstSizeSet = false
  broadcastState()
}

export function initDayPanel(opts: {
  getMainWindow: () => BrowserWindow | null
  rendererUrl: () => string | null
  getSetting: (key: string) => unknown
  setSetting: (key: string, value: unknown) => void
}): void {
  getMainWindow = opts.getMainWindow
  getRendererUrl = opts.rendererUrl
  getSetting = opts.getSetting
  setSetting = opts.setSetting
  registerHandlers()
  try {
    // ⚠️ 结论看 `register` 的**返回值**（false = 被其他程序占用 / 平台不支持，原生 Wayland 下恒 false）：
    // 原先没看返回值，失败时只在控制台留不下任何痕迹 ⇒ 用户侧表象是「按了没反应」。
    const failed: string[] = []
    const bind = (accel: string, fn: () => void): void => { if (!globalShortcut.register(accel, fn)) failed.push(accel) }
    bind('Control+Alt+S', () => { toggleDayPanel() })
    if (failed.length > 0) {
      console.warn(`[DayPanel] 全局快捷键注册失败（可能被其他程序占用）：${failed.join(' / ')}`)
      pushAppNotice({
        type: 'warning',
        message: `日程小窗快捷键 ${failed.join(' / ')} 没能生效`,
        detail: '该组合键可能已被其他程序占用；原生 Wayland 会话下全局快捷键也不可用（本项目只支持 X11/XWayland）。释放冲突或切到 X11 会话后重启应用即可恢复。',
      })
    }
  } catch (e) {
    console.warn('[DayPanel] Global shortcut registration failed:', e)
  }
}

export function toggleDayPanel(): void {
  if (isPopoutOpen()) destroyPopout()
  else broadcast(BROADCAST_CHANNEL.dayPanelToggleVisibility)
}

/** 全局快捷键当前是否真的注册上了（dev bridge /state 用；Wayland 原生会话下恒 false） */
export function dayPanelShortcutState(): Record<string, boolean> {
  return {
    'Control+Alt+S': globalShortcut.isRegistered('Control+Alt+S'),
  }
}

function registerHandlers(): void {
  ipcMain.handle('daypanel:popout', () => { createPopout(); return isPopoutOpen() })
  ipcMain.handle('daypanel:dock-back', () => { destroyPopout(); return isPopoutOpen() })
  ipcMain.handle('daypanel:toggle', () => {
    toggleDayPanel()
    return isPopoutOpen()
  })

  // 渲染层报告 document 所需尺寸（独立窗口高度自适应）
  ipcMain.on('daypanel:content-size', (_e, payload: { width?: number; height?: number }) => {
    if (!payload) return
    const w = Number(payload.width)
    const h = Number(payload.height)
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return
    applyContentSize(w, h)
  })

  ipcMain.on('daypanel:open-in-main', (_e, tab: string, tool?: string) => {
    const main = getMainWindow()
    if (!main || main.isDestroyed() || typeof tab !== 'string') return
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
    main.webContents.send('main:command', { type: 'switch-tab', tab, tool })
  })
}

export function disposeDayPanel(): void {
  try { globalShortcut.unregister('Control+Alt+S') } catch { /* ignore */ }
  destroyPopout()
}
