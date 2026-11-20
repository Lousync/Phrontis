import { session, shell, WebContentsView, type BrowserWindow, type Session, type WebContents } from 'electron'
import { getEffectiveUiZoom } from '../main/uiZoom'

/**
 * AI 教学右侧查看器 · 网页页签（v3.45.0，方案 §6.1 / §8）
 *
 * 为什么必须走主进程 `WebContentsView`：渲染层已有 `<webview>` 全局 `preventDefault`
 * （electron/main/index.ts），CSP `frame-src` 也不含 `https:`，普通 iframe 连不上真实站点；
 * 而用户要的是「登录、Cookie、PDF、前进后退都像浏览器一样能用」的网页 —— 只能开原生子视图。
 *
 * ★ 边界总纲（C4 拍板）：网页视图只认 `http` / `https`。本地文件（PDF / EPUB / 笔记 /
 *   仓库内 HTML）一律走专用查看器 + `kbview://`，绝不把 `file://` 交给这里。
 *   因此本模块所有 URL 入口（create / setUrl / will-navigate / will-redirect）都收敛到
 *   同一个协议判据；任何新入口务必复用它，别再各写一遍。
 *
 * ★ 原生视图永远盖在 DOM 上（这是 `WebContentsView` 的合成层级决定的，不是 z-index 问题），
 *   所以可见性只能由渲染层逐项上报：关页签 / 切页签 / 关面板 / 开浮层都要显式 `setVisible(false)`。
 *   本模块刻意**不**在 `setBounds` 时顺手显示，避免「面板已关但白块还在」。
 */

/** 最多 3 个内层页签 —— 每个页签 = 一个独立 view，主进程导航历史没法按标签拆分 */
export const WEB_PANE_MAX = 3
/** 独立持久分区（C3 拍板 A）：登录态跨页签、跨重启保留，且与主应用 cookie 完全隔离 */
export const WEB_PANE_PARTITION = 'persist:webtabs'
/** 主进程 → 渲染层的状态回传通道（载荷 `{ id, state }`） */
const CHANGED_CHANNEL = 'webPane:changed'

export interface WebPaneBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 与 src/types/index.ts 的 WebPaneState 同形；渲染层靠它画地址栏 / 历史按钮 / 失败卡片 */
export interface WebPaneState {
  id: string
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  /** did-fail-load 的 errorDescription；成功导航清空 */
  error?: string
}

export interface WebPaneActionResult {
  ok: boolean
  error?: string
}

interface PaneRecord {
  view: WebContentsView
  win: BrowserWindow
  /** 渲染层最后上报的意图（本模块只用于自身排查，不做渲染决策） */
  visible: boolean
  /** 最近一次主框架加载失败的描述；成功导航 / 重新开始加载时清空 */
  error?: string
  /** 失败时地址栏仍要显示用户输入的目标地址（失败导航不会进历史） */
  failedUrl?: string
}

const panes = new Map<string, PaneRecord>()

/** 协议判据（唯一真相源）：只认 http / https，大小写按 URL 规范归一 */
function isHttpUrl(raw: unknown): boolean {
  try {
    const u = new URL(String(raw ?? ''))
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 把用户输入变成可加载的 http(s) 地址。
 * 只输入域名（`example.com`）时补 `https://` —— 补完仍要过 `isHttpUrl`，
 * 所以 `javascript:` / `file:` / `data:` 不会因为「没写协议」被误放行。
 */
function toHttpUrl(raw: unknown): string | null {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return null
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
  const candidate = hasScheme ? trimmed : `https://${trimmed}`
  if (!isHttpUrl(candidate)) return null
  try {
    return new URL(candidate).toString()
  } catch {
    return null
  }
}

function liveWebContents(pane: PaneRecord) {
  const wc = pane.view.webContents
  return wc && !wc.isDestroyed() ? wc : null
}

function currentState(id: string, pane: PaneRecord): WebPaneState {
  const wc = liveWebContents(pane)
  const url = wc ? wc.getURL() : ''
  return {
    id,
    // 加载失败时 getURL() 为空（失败导航不入历史），回落到用户输入的目标地址
    url: url || pane.failedUrl || '',
    title: wc ? wc.getTitle() : '',
    canGoBack: !!wc && wc.navigationHistory.canGoBack(),
    canGoForward: !!wc && wc.navigationHistory.canGoForward(),
    loading: !!wc && wc.isLoading(),
    ...(pane.error ? { error: pane.error } : {}),
  }
}

/**
 * 状态回传给**拥有该 view 的窗口**。
 * 窗口已销毁就静默跳过 —— 关窗竞态里 `webContents.send` 会抛「Object has been destroyed」，
 * 而这个模块的事件源是网页（随时可能在窗口消失后补一个 did-stop-loading）。
 */
function emitState(id: string, pane: PaneRecord): void {
  const win = pane.win
  if (!win || win.isDestroyed()) return
  if (win.webContents.isDestroyed()) return
  win.webContents.send(CHANGED_CHANNEL, { id, state: currentState(id, pane) })
}

function findPaneByWebContents(wc: unknown): [string, PaneRecord] | null {
  for (const [id, pane] of panes) {
    if (pane.view.webContents === wc) return [id, pane]
  }
  return null
}

/**
 * 会话级加固只挂一次。
 * `session.fromPartition` 每次返回**同一个** session 实例，重复注册会覆盖 handler；
 * 虽然覆盖结果相同，但下载监听会叠成多份（一个下载触发 N 次 preventDefault + N 次广播）。
 */
let sessionHardened = false

function ensureSessionHardened(): Session {
  const ses = session.fromPartition(WEB_PANE_PARTITION)
  if (sessionHardened) return ses
  sessionHardened = true

  // 安全四件套之三：权限一律拒绝（摄像头 / 麦克风 / 定位 / 通知 / 剪贴板读取 / 全屏…）。
  // request 必须显式回调 false —— 只 return 不回调会让请求方永远挂起，站点会卡在「正在请求」。
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  // check 是同步预判（很多 API 先查后请），两者都要挂才算完整拦截。
  ses.setPermissionCheckHandler(() => false)

  // 安全四件套之四：下载一律阻止。
  // 告知方式选了「复用 webPane:changed 的 state.error」而不是新开 `webPane:blocked` 通道：
  // 渲染层本来就要渲染 state（地址栏 / 失败卡片），多一条通道等于让它对同一件事维护两套分支；
  // 而 `error: '下载已阻止'` 会随下一次成功导航自动清空，语义正好是「这次动作没成功」。
  ses.on('will-download', (event, _item, wc) => {
    event.preventDefault()
    const hit = findPaneByWebContents(wc)
    if (!hit) return
    const [id, pane] = hit
    pane.error = '下载已阻止'
    emitState(id, pane)
  })

  return ses
}

/**
 * 每个 view 自己的安全钩子（会话级的三、四在 `ensureSessionHardened` 里）。
 */
function attachPaneSecurity(id: string, pane: PaneRecord): void {
  const wc = pane.view.webContents

  // 安全四件套之一：新窗口一律不放行。
  // 真实站点常把登录 / 外链做成 window.open / target=_blank；deny 之后若目标是 http(s)
  // 就交给系统浏览器，既不丢链接也不会凭空多出一个脱离管理的 Electron 窗口。
  wc.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) {
      // openExternal 返回 Promise，站点给的地址可能触发系统无关联程序 —— 吞掉 rejection，
      // 避免主进程出现 unhandledRejection（用户侧已没有任何可操作的补救动作）
      void shell.openExternal(url).catch(() => undefined)
    }
    return { action: 'deny' }
  })

  // 安全四件套之二：站内导航只允许 http(s)。
  // file: / javascript: / data: / blob: / 自定义 scheme 全部拦下 —— 这一条是「网页视图只认
  // http/https」的执行点，别为了某个站点方便而放开。
  wc.on('will-navigate', (event, url) => {
    if (!isHttpUrl(url)) event.preventDefault()
  })
  wc.on('will-redirect', (event, url) => {
    if (!isHttpUrl(url)) event.preventDefault()
  })
  // 网页里再嵌 <webview> 也一并关死（沙箱视图本身创建不出，但钩子成本为零）
  wc.on('will-attach-webview', (event) => event.preventDefault())

  wc.on('did-start-loading', () => {
    // 新一次导航开始即清掉上一次的失败态，否则地址栏会一直挂着旧错误卡片
    pane.error = undefined
    pane.failedUrl = undefined
    emitState(id, pane)
  })
  wc.on('did-stop-loading', () => emitState(id, pane))
  wc.on('did-navigate', () => {
    pane.error = undefined
    pane.failedUrl = undefined
    emitState(id, pane)
  })
  wc.on('did-navigate-in-page', () => emitState(id, pane))
  wc.on('page-title-updated', () => emitState(id, pane))

  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 = ERR_ABORTED（用户中途点了别的链接 / 刷新）；子框架失败也不是本页失败 ——
    // 两者都不该把整块区域切成失败卡片
    if (!isMainFrame) return
    if (errorCode === -3) return
    pane.error = errorDescription || `加载失败（${errorCode}）`
    pane.failedUrl = validatedURL || pane.failedUrl
    emitState(id, pane)
  })
}

/**
 * 渲染层重载（Ctrl+R / 崩溃恢复 / dev 全量刷新）时它自己的页签状态会清零，
 * 但原生视图还挂在窗口上并保持上次的可见性 —— 表象是「刷新后一块网页白块压在界面上」。
 * 这里在宿主窗口重新开始加载时先统一隐藏；新页面重新上报 bounds / visible 才会再亮起来。
 * 每个窗口只挂一次（WeakSet 记名，窗口销毁后自然回收）。
 */
const watchedWindows = new WeakSet<BrowserWindow>()

function watchOwnerWindow(win: BrowserWindow): void {
  if (watchedWindows.has(win)) return
  watchedWindows.add(win)
  const hideOurs = () => {
    for (const pane of panes.values()) {
      if (pane.win !== win) continue
      pane.visible = false
      try {
        if (!pane.view.webContents.isDestroyed()) pane.view.setVisible(false)
      } catch { /* 销毁竞态 */ }
    }
  }
  win.webContents.on('did-start-loading', hideOurs)
}

/** 创建页签；同一 id 重复 create 视为幂等成功（渲染层恢复会话时可能重放调用） */
export function createWebPane(win: BrowserWindow | null | undefined, id: unknown, url: unknown): WebPaneActionResult {
  if (!win || win.isDestroyed()) return { ok: false, error: '主窗口不可用' }
  const paneId = String(id ?? '').trim()
  if (!paneId) return { ok: false, error: '页签 id 为空' }
  if (panes.has(paneId)) return { ok: true }
  if (panes.size >= WEB_PANE_MAX) return { ok: false, error: `最多 ${WEB_PANE_MAX} 个网页页签` }

  const target = toHttpUrl(url)
  if (!target) return { ok: false, error: '只支持 http/https 地址' }

  ensureSessionHardened()

  let view: WebContentsView
  try {
    view = new WebContentsView({
      webPreferences: {
        // 与主窗同规；★ 不挂 preload —— 网页拿不到任何 window.api，边界全靠四道钩子
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        partition: WEB_PANE_PARTITION,
      },
    })
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }

  const pane: PaneRecord = { view, win, visible: false }

  try {
    win.contentView.addChildView(view)
    // 先隐藏再导航：bounds 由渲染层随后上报，此处若可见会先在左上角闪一块 0×0 的空白
    view.setVisible(false)
  } catch (e) {
    try { view.webContents.close() } catch { /* 创建半途失败，尽力回收 */ }
    return { ok: false, error: (e as Error).message }
  }

  panes.set(paneId, pane)
  watchOwnerWindow(win)
  attachPaneSecurity(paneId, pane)

  // loadURL 的 rejection 与 did-fail-load 是同一件事；失败态统一由 did-fail-load 广播，
  // 这里只吞掉 rejection，避免 unhandledRejection
  void view.webContents.loadURL(target).catch(() => undefined)
  emitState(paneId, pane)
  return { ok: true }
}

export function setWebPaneUrl(id: string, url: unknown): WebPaneActionResult {
  const pane = panes.get(String(id))
  if (!pane) return { ok: false, error: '页签不存在' }
  const wc = liveWebContents(pane)
  if (!wc) return { ok: false, error: '页面已销毁' }
  const target = toHttpUrl(url)
  if (!target) return { ok: false, error: '只支持 http/https 地址' }
  void wc.loadURL(target).catch(() => undefined)
  return { ok: true }
}

/**
 * 渲染层给的是**窗口内 CSS px**（`getBoundingClientRect` 口径），必须换算成 DIP 才能 setBounds：
 * 界面缩放 125% 时 1 CSS px = 1.25 DIP，直接下单会整体偏移 + 缩小一圈。
 */
export function setWebPaneBounds(id: string, bounds: WebPaneBounds | null | undefined): WebPaneActionResult {
  const pane = panes.get(String(id))
  if (!pane) return { ok: false, error: '页签不存在' }
  const wc = liveWebContents(pane)
  if (!wc) return { ok: false, error: '页面已销毁' }
  const win = pane.win
  if (!win || win.isDestroyed()) return { ok: false, error: '主窗口不可用' }

  const zoom = getEffectiveUiZoom(win)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  let width = Math.round(num(bounds?.width) * zoom)
  let height = Math.round(num(bounds?.height) * zoom)
  if (width <= 0 || height <= 0) {
    // 面板收起 / 页签切换的中间态会给出 0 尺寸：直接隐藏而不是设一个非法 bounds
    pane.view.setVisible(false)
    pane.visible = false
    return { ok: true }
  }

  let x = Math.round(num(bounds?.x) * zoom)
  let y = Math.round(num(bounds?.y) * zoom)

  // 夹进窗口内容区：拖拽 + 缩放 + 窗口 resize 三者竞态时可能算出越界矩形，
  // 越界的子视图在 Linux / Windows 上会被整块裁掉，表象是「网页突然白屏」
  const content = win.getContentBounds()
  const cw = Math.max(0, content.width)
  const ch = Math.max(0, content.height)
  width = Math.min(width, cw)
  height = Math.min(height, ch)
  x = Math.min(Math.max(x, 0), Math.max(0, cw - width))
  y = Math.min(Math.max(y, 0), Math.max(0, ch - height))

  pane.view.setBounds({ x, y, width, height })
  return { ok: true }
}

/**
 * 只切可见性，不碰 bounds —— 原生视图盖在 DOM 上，显隐必须由宿主按时序显式调用。
 * `setBounds` 里**不**自动 show：否则面板关闭后最后一次 bounds 上报会把视图重新亮起来。
 */
export function setWebPaneVisible(id: string, visible: unknown): WebPaneActionResult {
  const pane = panes.get(String(id))
  if (!pane) return { ok: false, error: '页签不存在' }
  const wc = liveWebContents(pane)
  if (!wc) return { ok: false, error: '页面已销毁' }
  const on = visible === true
  pane.view.setVisible(on)
  pane.visible = on
  return { ok: true }
}

/** 面板关闭 / 切页签 / 窗口失焦等一次性收起全部页签（不销毁，登录态与滚动位置保留） */
export function hideAllWebPanes(): void {
  for (const pane of panes.values()) {
    pane.visible = false
    try {
      if (!pane.view.webContents.isDestroyed()) pane.view.setVisible(false)
    } catch { /* 窗口销毁竞态 */ }
  }
}

function navAction(id: string, run: (wc: WebContents) => void): WebPaneActionResult {
  const pane = panes.get(String(id))
  if (!pane) return { ok: false, error: '页签不存在' }
  const wc = liveWebContents(pane)
  if (!wc) return { ok: false, error: '页面已销毁' }
  try {
    run(wc)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** Electron 33 起挂在 webContents 上的旧 `canGoBack()` / `canGoForward()` 已废弃，统一走 navigationHistory */
export function webPaneGoBack(id: string): WebPaneActionResult {
  return navAction(id, (wc) => {
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  })
}

export function webPaneGoForward(id: string): WebPaneActionResult {
  return navAction(id, (wc) => {
    if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  })
}

export function webPaneReload(id: string): WebPaneActionResult {
  return navAction(id, (wc) => wc.reload())
}

/**
 * 真正关闭页签：摘除子视图 → 销毁 webContents → 删 Map。
 * 先摘除再销毁是刻意的：销毁瞬间窗口若仍在合成这个子视图，部分平台上会留下残影。
 * 重复 close 幂等（渲染层关闭页签 + 父组件卸载可能各调一次）。
 */
export function closeWebPane(id: string): WebPaneActionResult {
  const key = String(id)
  const pane = panes.get(key)
  if (!pane) return { ok: true }
  panes.delete(key)
  const win = pane.win
  try {
    if (win && !win.isDestroyed()) win.contentView.removeChildView(pane.view)
  } catch { /* 窗口已销毁，子视图随之回收 */ }
  try {
    if (!pane.view.webContents.isDestroyed()) pane.view.webContents.close()
  } catch { /* 已销毁 */ }
  return { ok: true }
}

export function getWebPaneState(id: string): WebPaneState | null {
  const pane = panes.get(String(id))
  if (!pane) return null
  return currentState(String(id), pane)
}

/**
 * 设置页「清除网页数据」入口（C3 配套）：清 storage + cookie + cache。
 * 不清当前已打开页签 —— 用户可能正要靠某个标签重新登录；刷新由用户自己点 ⟳。
 */
export async function clearWebPaneData(): Promise<WebPaneActionResult> {
  try {
    const ses = ensureSessionHardened()
    await ses.clearStorageData()
    await ses.clearCache()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 窗口关闭 / 应用退出时统一回收；幂等，可在 `before-quit` 与 `closed` 各调一次 */
export function disposeAllWebPanes(): void {
  for (const id of [...panes.keys()]) closeWebPane(id)
}
