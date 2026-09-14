import { BrowserWindow, ipcMain, screen, globalShortcut, shell } from 'electron'
import { join } from 'path'
import { broadcast, BROADCAST_CHANNEL } from './windowBus'

/**
 * 日程与打卡侧边栏管理器
 *
 * 三种桌面互动模式（floating / top-dock / desktop-widget）共享一个 BrowserWindow，
 * 通过运行时切换 alwaysOnTop / 鼠标穿透 / 位置 / 尺寸（动画过渡）实现形态变化，
 * 不再 destroy+create，杜绝「脱离→闪一下回主窗口→重新以新形态出现」的动画断点。
 *
 * - detached=false：内嵌（主窗口内 flex 面板）
 * - detached=true：popout 独立窗口，mode 决定桌面形态
 *   - floating      自由漂浮：可拖动、可调整大小
 *   - top-dock      顶部停靠：贴工作区顶缘，QQ 式收缩为 10px 触碰条，悬停展开
 *   - desktop-widget 桌面小组件：固定尺寸，鼠标穿透 ⇄ 可交互
 *
 * 高度自适应（2026-09-01 调整）：
 *   渲染层用 ResizeObserver 报告 document 所需高度，主进程据此把窗口高度贴合内容
 *   （floating 直接 setSize；top-dock 展开态 animateHeight；收缩态/小组件固定）。
 *   「内容变多」会跟上；「内容变少」不缩（保留用户拉大的空间）。
 *   首次开窗（firstSizeSet=false）强制贴合内容，避免开窗闪一下默认高度再缩到内容。
 *
 * 脱离入口中间态：
 *   「脱离」一律先开出独立漂浮窗口，仅本会话显式选过形态时才沿用。
 */

export type PanelMode = 'floating' | 'top-dock' | 'desktop-widget'
const MODES: readonly PanelMode[] = ['floating', 'top-dock', 'desktop-widget']

const TOUCH_STRIP_H = 10          // 触碰条高度
const WIDGET_W = 264              // 桌面小组件尺寸（固定）
const WIDGET_H = 150
const POSITION_MS = 200           // 位置动画时长
const EXPAND_MS = 220             // top-dock 高度动画时长
const COLLAPSE_DELAY_MS = 500     // 鼠标移出后收回的 grace 窗口
const DEFAULT_W = 300
const DEFAULT_H = 520
const BOUNDS_SAVE_MS = 400        // 位置/尺寸落盘防抖
const DOCK_DRAG_THRESHOLD = 20    // 自由漂浮拖拽松手：窗口顶部距工作区顶缘 ≤ 该值 → 自动停靠
const DOCK_JUDGE_MS = 180         // 拖拽停止判定：moved 停止该时长后才判定是否吸附
const POPOUT_GRACE_MS = 800       // 脱离后宽限：期间不判定吸附，避免刚开窗就被吸走
const TOP_EDGE_DIRTY = 48         // 保存位置距顶缘 ≤ 该值视为「停靠残留」，漂浮态改用默认偏移

let popout: BrowserWindow | null = null
let getMainWindow: () => BrowserWindow | null = () => null
let getRendererUrl: () => string | null = () => null
let getSetting: (key: string) => unknown = () => undefined
let setSetting: (key: string, value: unknown) => void = () => {}

let mode: PanelMode = 'floating'
/** 本会话内用户显式选择的形态（托盘/快捷键/窗口按钮）。null = 脱离走漂浮中间态 */
let explicitMode: PanelMode | null = null
let collapsed = false                      // top-dock 收缩态
let widgetInteractive = false              // desktop-widget 可交互态
let topDockAnimating = false
let animTimer: ReturnType<typeof setInterval> | null = null
let collapseTimer: ReturnType<typeof setTimeout> | null = null
let boundsSaveTimer: ReturnType<typeof setTimeout> | null = null
let dockJudgeTimer: ReturnType<typeof setTimeout> | null = null
let popoutShownAt = 0                      // popout 显示时刻（吸附判定宽限起点）
/** 上次 setSize 过的目标高度（floating/top-dock 展开态），仅向上跟随 */
let lastAppliedH = 0
let lastAppliedW = 0
/** 本次 detached 是否已收到首次内容尺寸（决定开窗是否仍需等待） */
let firstSizeSet = false

function broadcastState(): void {
  broadcast(BROADCAST_CHANNEL.dayPanelStateChanged, { detached: isPopoutOpen(), mode, collapsed, widgetInteractive })
}
export function isPopoutOpen(): boolean {
  return !!popout && !popout.isDestroyed()
}
export function getPanelMode(): PanelMode {
  return mode
}
let onModeChangedCb: (() => void) | null = null
/** 主进程订阅模式变化（托盘菜单刷新 radio 状态） */
export function onPanelModeChanged(cb: () => void): void {
  onModeChangedCb = cb
}

function savedBounds(): { x?: number; y?: number; width?: number; height?: number } {
  const raw = getSetting('dayPanelPopoutBounds')
  if (raw && typeof raw === 'object') return raw as { x?: number; y?: number; width?: number; height?: number }
  return {}
}
function innerHeightOf(main: BrowserWindow): number {
  return Math.max(420, main.getContentSize()[1])
}
function clampToWorkArea(x: number, y: number, w: number, h: number): { x: number; y: number } {
  const wa = screen.getPrimaryDisplay().workArea
  return {
    x: Math.max(wa.x, Math.min(x, wa.x + wa.width - w)),
    y: Math.max(wa.y, Math.min(y, wa.y + wa.height - h)),
  }
}

/**
 * 模式切换（托盘菜单 / 快捷键 / 窗口内按钮 / 拖拽吸附共用入口）。
 * 同一窗口内运行时切换形态（alwaysOnTop / mouseEvents / resizable / 位置），不再 destroy+create。
 * @param opts.explicit false 表示隐式切换（拖拽吸附）：只改当前窗口形态，不写入偏好，
 *        保证下次「脱离」仍从独立漂浮窗口（中间态）开始。
 */
export function setPanelMode(m: PanelMode, opts?: { explicit?: boolean }): void {
  if (!MODES.includes(m)) return
  const explicit = opts?.explicit !== false
  if (mode === m) return
  mode = m
  if (explicit) {
    explicitMode = m
    setSetting('dayPanelMode', m)
  }
  collapsed = false
  if (isPopoutOpen()) applyMode(popout!, m)
  broadcast(BROADCAST_CHANNEL.dayPanelModeChanged, { mode: m })
  onModeChangedCb?.()
}

/** 按当前 mode 计算 popout 应在的位置（尺寸由 applyContentSize 决定） */
function computeTargetPos(m: PanelMode): { x: number; y: number; width: number } {
  const wa = screen.getPrimaryDisplay().workArea
  const main = getMainWindow()
  const mb = main && !main.isDestroyed() ? main.getBounds() : null
  const saved = savedBounds()
  if (m === 'top-dock') {
    const w = saved.width ?? DEFAULT_W
    return { x: saved.x ?? wa.x + wa.width - w - 80, y: wa.y, width: w }
  }
  if (m === 'desktop-widget') {
    return { x: saved.x ?? wa.x + wa.width - WIDGET_W - 24, y: saved.y ?? wa.y + 24, width: WIDGET_W }
  }
  // floating
  const w = DEFAULT_W
  // 停靠/贴顶时期存下的位置（y≈工作区顶缘）直接复用，会让漂浮态「一开窗就贴在最上面」，
  // 且轻微拖动即触发自动停靠 → 判为残留，改回工作区右下角
  const dockResidue = typeof saved.y === 'number' && saved.y - wa.y <= TOP_EDGE_DIRTY
  const x = !dockResidue && typeof saved.x === 'number'
    ? saved.x
    : (wa.x + wa.width - w - 24)
  const y = !dockResidue && typeof saved.y === 'number'
    ? saved.y
    : (wa.y + wa.height - DEFAULT_H - 24)
  return { x, y, width: w }
}

/** 把 popout 窗口按当前 mode 调整形态（运行时，无重建）。尺寸由 applyContentSize 驱动 */
function applyMode(win: BrowserWindow, m: PanelMode): void {
  const wa = screen.getPrimaryDisplay().workArea
  // 形态属性 + 限制
  if (m === 'floating') {
    win.setAlwaysOnTop(false)
    win.setIgnoreMouseEvents(false)
    win.setResizable(true)
    win.setMinimumSize(240, 60)
    win.setMaximumSize(wa.width - 80, wa.height - 80)
  } else if (m === 'top-dock') {
    win.setAlwaysOnTop(true, 'floating')
    win.setIgnoreMouseEvents(false)
    win.setResizable(false)
    win.setMinimumSize(240, TOUCH_STRIP_H)
    win.setMaximumSize(wa.width - 40, wa.height - 20)
  } else {
    // desktop-widget
    win.setAlwaysOnTop(true)
    widgetInteractive = false
    win.setIgnoreMouseEvents(true, { forward: true })
    win.setResizable(false)
    win.setMinimumSize(WIDGET_W, WIDGET_H)
    win.setMaximumSize(WIDGET_W, WIDGET_H)
    broadcast(BROADCAST_CHANNEL.dayPanelWidgetInteractiveChanged, { interactive: false })
  }
  // 位置（动画到目标 x/y；尺寸由 applyContentSize 决定）
  const target = computeTargetPos(m)
  animatePositionXY(win, target.x, target.y)
  // 内容自适应基线重置（不同模式策略不同，重新等首次内容报告）
  lastAppliedH = 0
  lastAppliedW = 0
  firstSizeSet = false
  broadcastState()
}

/** top-dock 展开目标高度（首次开窗的占位期望高度，随后被内容覆盖） */
function expandedHeightOf(): number {
  const h = savedBounds().height
  return h && h > 100 ? h : DEFAULT_H
}

/** 收到渲染层报告的「内容所需尺寸」：让窗口高度贴合内容（仅向上跟随；首次强制贴合） */
function applyContentSize(scrollW: number, scrollH: number): void {
  if (!popout || popout.isDestroyed()) return
  if (mode === 'desktop-widget') {
    // widget 固定尺寸，仅在首次时按内容摆位（基本不会触发，因为 widget 走 ready-to-show 直接 show）
    if (!firstSizeSet) {
      popout.setSize(WIDGET_W, WIDGET_H)
      firstSizeSet = true
      if (!popout.isVisible()) popout.show()
    }
    return
  }
  const wa = screen.getPrimaryDisplay().workArea

  if (mode === 'floating') {
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
  } else {
    // top-dock（展开态跟内容，收缩态不动）
    if (collapsed) return
    const maxH = wa.height - 20
    const targetH = Math.max(60, Math.min(scrollH, maxH))
    const cur = popout.getBounds()
    if (!firstSizeSet) {
      // 首次：直接展开到内容高度并显示
      popout.setBounds({ ...cur, height: targetH })
      lastAppliedH = targetH
      firstSizeSet = true
      if (!popout.isVisible()) popout.show()
      scheduleSaveBounds()
      return
    }
    if (targetH > cur.height + 1) {
      animateHeight(targetH)
      lastAppliedH = targetH
    }
  }
}

/** top-dock 高度动画（缓动） */
function animateHeight(target: number): void {
  if (!popout || popout.isDestroyed()) return
  const b = popout.getBounds()
  const start = b.height
  if (Math.abs(start - target) < 2) return
  const t0 = Date.now()
  topDockAnimating = true
  stopAnim()
  animTimer = setInterval(() => {
    if (!popout || popout.isDestroyed()) { stopAnim(); topDockAnimating = false; return }
    const p = Math.min(1, (Date.now() - t0) / EXPAND_MS)
    const ease = 1 - Math.pow(1 - p, 3)
    const h = Math.round(start + (target - start) * ease)
    const cur = popout.getBounds()
    popout.setBounds({ ...cur, height: h })
    if (p >= 1) { stopAnim(); topDockAnimating = false; scheduleSaveBounds() }
  }, 16)
}

/** 位置缓动（x/y 单独动画，不动尺寸） */
function animatePositionXY(win: BrowserWindow, tx: number, ty: number): void {
  const cur = win.getBounds()
  if (Math.abs(tx - cur.x) < 1 && Math.abs(ty - cur.y) < 1) return
  const t0 = Date.now()
  topDockAnimating = true
  stopAnim()
  const startX = cur.x
  const startY = cur.y
  animTimer = setInterval(() => {
    if (win.isDestroyed()) { stopAnim(); topDockAnimating = false; return }
    const p = Math.min(1, (Date.now() - t0) / POSITION_MS)
    const ease = 1 - Math.pow(1 - p, 3)
    const x = Math.round(startX + (tx - startX) * ease)
    const y = Math.round(startY + (ty - startY) * ease)
    win.setPosition(x, y)
    if (p >= 1) { stopAnim(); topDockAnimating = false; scheduleSaveBounds() }
  }, 16)
}

function stopAnim(): void {
  if (animTimer) { clearInterval(animTimer); animTimer = null }
}

function createPopout(): void {
  if (popout && !popout.isDestroyed()) {
    popout.show()
    popout.focus()
    return
  }
  // 脱离 = 独立漂浮中间态；仅当本会话显式选过形态时才沿用
  mode = explicitMode ?? 'floating'
  collapsed = false
  firstSizeSet = false
  lastAppliedH = 0
  lastAppliedW = 0

  // 统一 transparent：floating 渲染层 html 有不透明背景 → 视觉不透明；
  // top-dock / widget 需要玻璃感也走 transparent；统一后模式切换无需重建窗口
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

  popout.once('ready-to-show', () => {
    if (!popout || popout.isDestroyed()) return
    popoutShownAt = Date.now()
    // 先应用形态属性 + 位置（widget 固定尺寸可直接显示）
    applyMode(popout, mode)
    if (mode === 'desktop-widget') {
      popout.setSize(WIDGET_W, WIDGET_H)
      if (!popout.isVisible()) popout.show()
    }
    // floating / top-dock 等待渲染层首次报告内容尺寸（applyContentSize 中 firstSizeSet 时再 show），
    // 避免「开窗先默认高度再缩到内容」的闪烁
  })

  popout.on('moved', onPopoutMoved)
  popout.on('resized', scheduleSaveBounds)

  popout.on('closed', () => {
    popout = null
    stopAnim()
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null }
    if (dockJudgeTimer) { clearTimeout(dockJudgeTimer); dockJudgeTimer = null }
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
    if (topDockAnimating) { scheduleSaveBounds(); return }
    if (mode === 'top-dock' && collapsed) return
    const b = popout.getBounds()
    if (b.width < 40 || b.height < 20) return
    setSetting('dayPanelPopoutBounds', { x: b.x, y: b.y, width: b.width, height: b.height })
  }, BOUNDS_SAVE_MS)
}

/** 自由漂浮拖拽松手：窗口顶部贴近工作区顶缘 → 自动停靠（隐式，不写偏好） */
function onPopoutMoved(): void {
  scheduleSaveBounds()
  if (mode !== 'floating' || !popout || popout.isDestroyed()) return
  // 刚脱离的宽限期内不判定：窗口可能刚被创建/动画落位，此时不应立刻被吸走
  if (Date.now() - popoutShownAt < POPOUT_GRACE_MS) return
  // 拖拽停止后才判定（moved 每次移动都触发），避免拖动途中掠过顶缘就被吸走
  if (dockJudgeTimer) clearTimeout(dockJudgeTimer)
  dockJudgeTimer = setTimeout(() => {
    dockJudgeTimer = null
    if (mode !== 'floating' || !popout || popout.isDestroyed()) return
    const b = popout.getBounds()
    const wa = screen.getPrimaryDisplay().workArea
    if (b.y - wa.y <= DOCK_DRAG_THRESHOLD) {
      // 隐式：不写入偏好，下次脱离仍回到独立漂浮中间态
      setPanelMode('top-dock', { explicit: false })
    }
  }, DOCK_JUDGE_MS)
}

function destroyPopout(): void {
  stopAnim()
  if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null }
  if (dockJudgeTimer) { clearTimeout(dockJudgeTimer); dockJudgeTimer = null }
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
  // 不再跨会话恢复 dayPanelMode：旧逻辑中「拖拽吸附」也会写入该设置，恢复它会导致
  // 下次「脱离」直接变成停靠/小组件、跳过独立漂浮中间态。形态只在会话内有效。
  mode = 'floating'
  explicitMode = null
  registerHandlers()
  try {
    globalShortcut.register('Control+Alt+S', () => { togglePanel() })
    globalShortcut.register('Control+Alt+Up', () => { setPanelMode('top-dock') })
    globalShortcut.register('Control+Alt+Down', () => { setPanelMode('desktop-widget') })
  } catch (e) {
    console.warn('[DayPanel] Global shortcut registration failed:', e)
  }
}

function togglePanel(): void {
  if (isPopoutOpen()) destroyPopout()
  else broadcast(BROADCAST_CHANNEL.dayPanelToggleVisibility)
}

function registerHandlers(): void {
  ipcMain.handle('daypanel:popout', () => {
    if (!isPopoutOpen()) {
      mode = explicitMode ?? 'floating'
      collapsed = false
    }
    createPopout()
    return isPopoutOpen()
  })
  ipcMain.handle('daypanel:dock-back', () => { destroyPopout(); return isPopoutOpen() })
  ipcMain.handle('daypanel:get-state', () => ({ detached: isPopoutOpen(), mode, collapsed, widgetInteractive }))
  ipcMain.handle('daypanel:toggle', () => {
    togglePanel()
    return isPopoutOpen()
  })
  ipcMain.handle('daypanel:mode-set', (_e, m: PanelMode) => { setPanelMode(m); return mode })
  ipcMain.handle('daypanel:mode-get', () => mode)

  // 渲染层报告 document 所需尺寸（floating/top-dock 高度自适应）
  ipcMain.on('daypanel:content-size', (_e, payload: { width?: number; height?: number }) => {
    if (!payload) return
    const w = Number(payload.width)
    const h = Number(payload.height)
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return
    applyContentSize(w, h)
  })

  // ---- top-dock：展开 / 收回意图（500ms grace）/ 取消收回 ----
  ipcMain.handle('daypanel:topdock-expand', () => {
    if (mode !== 'top-dock' || !isPopoutOpen()) return
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null }
    if (collapsed && !topDockAnimating) {
      collapsed = false
      const target = lastAppliedH || expandedHeightOf()
      animateHeight(target)
      broadcast(BROADCAST_CHANNEL.dayPanelCollapsedChanged, { collapsed: false })
    }
  })
  ipcMain.handle('daypanel:topdock-collapse-intent', () => {
    if (mode !== 'top-dock' || !isPopoutOpen() || topDockAnimating || collapsed) return
    if (collapseTimer) return
    collapseTimer = setTimeout(() => {
      collapseTimer = null
      if (!isPopoutOpen() || topDockAnimating || collapsed) return
      collapsed = true
      animateHeight(TOUCH_STRIP_H)
      broadcast(BROADCAST_CHANNEL.dayPanelCollapsedChanged, { collapsed: true })
    }, COLLAPSE_DELAY_MS)
  })
  ipcMain.handle('daypanel:topdock-cancel-collapse', () => {
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null }
  })

  // ---- desktop-widget：可交互态切换（穿透 ⇄ 可点）----
  ipcMain.handle('daypanel:widget-interactive', (_e, active: boolean) => {
    if (mode !== 'desktop-widget' || !isPopoutOpen()) return
    widgetInteractive = !!active
    popout?.setIgnoreMouseEvents(!widgetInteractive, { forward: true })
    broadcast(BROADCAST_CHANNEL.dayPanelWidgetInteractiveChanged, { interactive: widgetInteractive })
    return widgetInteractive
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
  try { globalShortcut.unregister('Control+Alt+Up') } catch { /* ignore */ }
  try { globalShortcut.unregister('Control+Alt+Down') } catch { /* ignore */ }
  destroyPopout()
}
