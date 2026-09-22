// 必须最先引入：IPC 注册幂等包装（dev 下 repo 模块被打包两份时避免重复注册崩溃）
import './ipcSafe'
import { app, BrowserWindow, dialog, ipcMain, screen, shell, protocol, clipboard, nativeImage, Menu, net, Tray } from 'electron'
// 无 GPU/无头环境（AI 驱动真机测试）显式 KNOWBASE_DISABLE_GPU=1 时禁用 GPU 加速，防渲染进程连带崩溃
if (process.env.KNOWBASE_DISABLE_GPU === '1') {
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('no-sandbox')
}
import { join, basename, resolve, sep } from 'path'
import { readFileSync, writeFileSync, existsSync, createReadStream, cpSync, mkdirSync, statSync, readdirSync, appendFileSync } from 'fs'
import { Readable } from 'stream'
import { getAttachmentsDir } from '../lib/globalPaths'
import { assertSecretBoxRoundTrip } from '../lib/secretBox'
import { registerPomodoroBroadcast } from './pomodoroState'
import { registerEntryHandlers } from '../database/repositories/entryRepo'
import { registerTagHandlers } from '../database/repositories/tagRepo'
import { registerScheduleHandlers } from '../database/repositories/scheduleRepo'
import { registerKnowledgeHandlers } from '../database/repositories/knowledgeRepo'
import { registerExportHandlers } from '../database/repositories/exportRepo'
import { registerRecycleBinHandlers } from '../database/repositories/recycleBinRepo'
import { registerImportHandlers } from '../database/repositories/importRepo'
import { registerUserHandlers } from '../database/repositories/userRepo'
import { registerToolboxHandlers } from '../database/repositories/toolboxRepo'
import { registerPasswordHandlers } from '../database/repositories/passwordRepo'
import { registerMomentsHandlers } from '../database/repositories/momentsRepo'
import { registerAttachmentHandlers, getAttachmentFilePath } from '../database/repositories/attachmentRepo'
import { registerVaultBackupHandlers } from '../database/repositories/vaultBackupRepo'
import { registerRepoConfigHandlers } from '../database/repositories/repoConfigRepo'
import { registerCheckinHandlers } from '../database/repositories/checkinRepo'
import { registerBookmarkHandlers } from '../database/repositories/bookmarkRepo'
import { registerSuperviseHandlers } from '../database/repositories/superviseRepo'
import { registerSummaryHandlers } from '../database/repositories/summaryRepo'
import { registerBlogTemplateHandlers } from '../database/repositories/blogTemplateRepo'
import { registerBlogSummaryHandlers } from '../database/repositories/blogSummaryRepo'
import { registerQuizHandlers } from '../database/repositories/quizRepo'
import { registerPdfReaderHandlers } from '../database/repositories/pdfReaderRepo'
import { registerReaderStateHandlers } from '../database/repositories/readerStateRepo'
import { registerExcerptHandlers } from '../database/repositories/excerptRepo'
import { startSuperviseScheduler, stopSuperviseScheduler, enqueueExternalPush } from '../lib/pushService'
import { initScheduleReminders } from '../lib/scheduleReminder'
import { initPasswordFiller, destroyPasswordFiller } from './passwordFiller'
import { initDayPanel, disposeDayPanel, getPanelMode, setPanelMode, onPanelModeChanged, isPopoutOpen } from './dayPanelWindow'
import { registerWindowBus } from './windowBus'
import { registerDevtoolsHandlers } from './devtools'
import { registerUpdateHandlers } from '../lib/updateService'
import { registerReleaseNotesHandlers } from '../lib/releaseNotes'
import { registerPluginHandlers, getPluginsRoot } from '../lib/pluginRegistry'
import { registerAiToolHandlers } from '../lib/aiTools'
import { registerKbVisualProtocol } from '../lib/kbVisualProtocol'
import { registerBuiltinTools } from '../lib/builtinTools'
import { registerMcpHandlers, restoreMcpConnections } from '../lib/mcpService'
import { registerSkillHandlers } from '../lib/skillService'
import { registerLlmHandlers } from '../lib/llmService'
import { registerAgentHandlers } from '../lib/agentService'
import { registerAgentCompressHandlers } from '../lib/agentCompress'
import { registerInlineSuggestHandlers } from '../lib/aiAssistant/inlineSuggest'
import { registerSemanticIndexHandlers } from '../lib/kbStore/semanticIndex'
import { registerKnowledgeSearchHandlers } from '../lib/knowledgeSearch'
import { registerAiTeachingFolderHandlers, migrateRootDir as migrateAiTeachRootDir } from '../lib/aiTeachingFolders'
import { registerAiTeachingWorkspaceHandlers } from '../lib/aiTeachingWorkspaces'
import { registerAiTeachingSourceHandlers } from '../lib/aiTeachingSources'
import { registerAiTeachingProfileHandlers } from '../lib/aiTeachingProfile'
import { registerTranslateHandlers } from '../lib/translateService'
import { registerPdfHandlers } from '../lib/pdfService'
import { registerDocsReadHandlers } from '../lib/docsIpc'
import { registerLanShareHandlers } from '../lib/lanShare'
import { registerClipperHandlers, startClipperServer, stopClipperServer } from '../lib/clipperServer'
import { registerWorkspaceHandlers, trashAllRegisteredVaults, clearVaultRegistry } from '../lib/workspaceManager'
import { closeVaultWatcher } from '../lib/fsWatcher'
import { registerVaultArchiveHandlers } from '../lib/vaultArchive'
import { getCurrentVault, setCurrentVault } from '../lib/kbStore/vaultContext'
import { SETTINGS } from '../../src/lib/settings'

// 附件自定义协议：attachment://{id}/ 与 attachment://{id}/?thumb=1
// 插件自定义协议：plugin://{id}/{file} — UI 插件的沙箱页面(配合 iframe sandbox 使用)
// AI教学示意图渲染协议：kbview://vault/<rel>.html — 工件栏沙箱 iframe 载体（不继承父文档 CSP，见 kbVisualProtocol.ts）
protocol.registerSchemesAsPrivileged([
  { scheme: 'attachment', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'plugin', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'kbview', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

// ===== 数据隔离：开发版（npm run dev）使用独立 userData 目录 =====
// 已安装版用默认 %APPDATA%/knowbase；开发版用 %APPDATA%/knowbase (dev <目录名>)。
// 按检出目录名隔离 → 主仓库与各 git worktree 的 dev 实例数据互不影响、单实例锁互不冲突。
// 必须在任何模块读取 userData 路径之前执行（下方 settingsPath 是第一个消费者），
// 且在 requestSingleInstanceLock 之前。
// 首次运行时从正式版目录快照一份现有数据（跳过易锁死的缓存目录）；
// 想重新迁移：删除对应「knowbase (dev ...)」目录即可。设置 KNOWBASE_SHARED_DATA=1 可强制共用。
if (!app.isPackaged && process.env.KNOWBASE_SHARED_DATA !== '1') {
  const sharedDir = app.getPath('userData')
  const devDir = `${sharedDir} (dev ${basename(app.getAppPath())})`
  const marker = join(devDir, '.dev-migrated')
  if (!existsSync(marker)) {
    try {
      if (!existsSync(devDir)) mkdirSync(devDir, { recursive: true })
      cpSync(sharedDir, devDir, {
        recursive: true,
        filter: src => !/[\\/](Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|Crashpad|crashpad|blob_storage|Session Storage)([\\/]|$)/i.test(src),
      })
      console.log('[DataIsolation] Copied data from shared dir to dev dir:', devDir)
    } catch (e) {
      console.warn('[DataIsolation] Failed to copy legacy data (file may be locked), dev dir will use the copied subset:', e)
    }
    try { writeFileSync(marker, new Date().toISOString()) } catch { /* ignore */ }
  }
  app.setPath('userData', devDir)
}

// ===== 崩溃/异常留痕（黑匣子）：写入 userData/crash-log.txt，供事后定位 =====
{
  const crashLog = () => {
    try { return join(app.getPath('userData'), 'crash-log.txt') } catch { return 'crash-log.txt' }
  }
  const logCrash = (tag: string, detail: string): void => {
    try {
      const line = `\n[${new Date().toISOString()}] ${tag} v${app.getVersion()}\n${detail}\n`
      appendFileSync(crashLog(), line)
    } catch { /* 留痕失败不影响主流程 */ }
  }
  process.on('uncaughtException', err => {
    logCrash('uncaughtException', err.stack ?? String(err))
    console.error('[crash] uncaughtException:', err)
  })
  process.on('unhandledRejection', reason => {
    const stack = (reason as Error)?.stack ?? String(reason)
    logCrash('unhandledRejection', stack)
    console.error('[crash] unhandledRejection:', reason)
  })
  app.on('child-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    logCrash(`child-process-gone(${details.type})`, `reason=${details.reason} exitCode=${details.exitCode}`)
  })
  ;(globalThis as any).__kbLogRendererGone = (details: { reason: string; exitCode: number }): void => {
    if (details.reason === 'clean-exit') return
    logCrash('render-process-gone', `reason=${details.reason} exitCode=${details.exitCode}`)
  }
}

// ===== Settings memory cache =====
// 禁用 Electron 默认应用菜单：其 View 角色绑定了 Ctrl+R / Ctrl+Shift+R（强制刷新）
// / F11 等全局加速键，会在用户操作时整页重载回启动模块。应用自定义快捷键见各模块。
Menu.setApplicationMenu(null)
const settingsPath = join(app.getPath('userData'), 'settings.json')
let settingsCache: Record<string, unknown> = {}
let saveTimer: ReturnType<typeof setTimeout> | null = null

function loadSettingsFromDisk(): Record<string, unknown> {
  let raw: Record<string, unknown> = {}
  try { raw = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf-8')) : {} } catch { raw = {} }
  // 数据源默认值兜底已全部退役（R6 去库化收官：storageData/storageKnowledge/storageBlog
  // 三键随 sqlite 读源退役，知识库/博客/结构化模块恒 vault 文件，无读源分支残留）。
  // 仓库状态键唯一属主是 vaultContext（直写文件）：主进程缓存绝不能持有其快照，
  // 否则任何一次 flush（含退出前）都会把 currentVaultId/recentVaults 覆盖回启动时
  // 的旧值——用户表现为「切换仓库重启后被打回原仓库」。
  delete raw['currentVaultId']
  delete raw['recentVaults']
  return raw
}

function flushSettingsToDisk(): void {
  saveTimer = null
  try {
    // 合并写回：保留文件中 settingsCache 没有的键（如 kbStore 的 currentVaultId），
    // 避免整体覆盖把其它模块写入 settings.json 的字段抹掉
    const existing = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf-8')) : {}
    const merged = { ...existing, ...settingsCache }
    writeFileSync(settingsPath, JSON.stringify(merged, null, 2))
  } catch (err) { console.error('Failed to persist settings:', err) }
}

// 允许打包后 file:// 环境下加载本地 module worker（pdf.js 阅读器需要）
app.commandLine.appendSwitch('allow-file-access-from-files')

// ★ 关闭 Windows「窗口遮挡」判定（2026-09-21 实测根因）：
//   窗口被别的窗口盖住时，Chromium 会把页面标记为 hidden，连带**冻结 requestAnimationFrame 与
//   IntersectionObserver**。而 pdf.js 3.11 的渲染步进正是 rAF 驱动的（display/api.js：
//   `useRequestAnimationFrame: !intentPrint` → `_scheduleNext()` 里走 window.requestAnimationFrame），
//   于是「被遮挡期间发起的那次渲染」永远不结束：画布一片空白、渲染池的 4 个并发槽被僵尸占满，
//   之后缩放/滚动触发的重渲全部排不进去 —— 用户看到的就是「中间页不显示 + 缩放不好用」，
//   且要等下一次滚动（新的一次 IO 投递）才可能自愈。
//   关掉该判定后，被遮挡期间 rAF/IO 照常投递，渲染能正常收尾，回到前台时页面已经画好。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

// 单实例锁 — 防止多窗口数据不同步（sql.js 内存数据库无跨进程共享能力）
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // 已有实例在运行：本实例立即终止，不得执行任何后续初始化。
  // 注意不能用 app.quit()（异步，不阻断同步代码）：whenReady 回调仍会
  // 注册 232 个 IPC + createWindow()，导致窗口闪现后进程
  // 退出，表现为「关闭后再次启动窗口闪烁闪退」。app.exit() 直接终止，
  // 非主实例无任何资源可清理（数据库/窗口尚未创建），安全。
  app.exit(0)
}

let mainWindow: BrowserWindow | null = null

// ===== 托盘常驻：主窗口 X = 隐藏，任务栏独立存活（用户决策 2026-08-31）=====
let isQuitting = false
let tray: Tray | null = null

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  try {
    const candidates = [
      join(app.getAppPath(), 'build', 'icon.png'),
      join(process.resourcesPath ?? '', 'build', 'icon.png'),
      join(process.resourcesPath ?? '', 'icon.png'),   // 打包后 resources 根兜底
    ]
    let img = nativeImage.createEmpty()
    for (const p of candidates) {
      if (!p || p === 'icon.png') continue
      const cand = nativeImage.createFromPath(p)
      if (!cand.isEmpty()) { img = cand; break }
    }
    if (img.isEmpty()) {
      // 兜底：所有候选路径都失败时用内置 16px 彩色占位（拒绝 Windows 空白托盘白块）
      img = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAApUlEQVR4nK3MWwvBAByG8X00KZnTNNNY5jDMSkkppZSUUj6U8/k8p8/zuvN3/fLcPz9F+UeB8AtB9YlQ5AE1ekcsfoOW8KFrPozkFaZ+gZU6wzZOKKaPcMwDqpk9PgAze9mdAMxct7YCMHMjtxGAmZv2WgBmbuVXAjBzu7AUgJk7pYUAzNx15gIwc6/8BTBzvzITgJkH7lQAZh7WJgIw88gbC/BLb/8X7Gi3iexmAAAAAElFTkSuQmCC'
      )
      console.warn('[Tray] All icon candidates failed to load -> using builtin placeholder')
    }
    if (process.platform === 'win32') img = img.resize({ width: 16, height: 16 })
    tray = new Tray(img)
    tray.setToolTip('Phrontis · 日程打卡')
    const rebuildMenu = () => {
      tray?.setContextMenu(Menu.buildFromTemplate([
        { label: '显示主窗口', click: showMainWindow },
        { type: 'separator' },
        { label: '任务栏模式', submenu: [
          { label: '自由漂浮', type: 'radio', checked: getPanelMode() === 'floating', click: () => setPanelMode('floating') },
          { label: '顶部停靠', type: 'radio', checked: getPanelMode() === 'top-dock', click: () => setPanelMode('top-dock') },
          { label: '桌面小组件', type: 'radio', checked: getPanelMode() === 'desktop-widget', click: () => setPanelMode('desktop-widget') },
        ]},
        { type: 'separator' },
        { label: '退出 Phrontis', click: () => { isQuitting = true; app.quit() } },
      ]))
    }
    rebuildMenu()
    // 模式变化时刷新托盘单选状态
    onPanelModeChanged(rebuildMenu)
    tray.on('click', showMainWindow)
    console.log('[Tray] Tray created')
  } catch (e) {
    console.warn('[Tray] Failed to create (non-fatal):', e)
  }
}

function createWindow(): void {
  console.log('[Window] ELECTRON_RENDERER_URL =', process.env.ELECTRON_RENDERER_URL || '(empty)')
  // 透明窗口 + 渲染层自绘大圆角（用户决策 2026-09-05）：系统 DWM 圆角半径固定 ~8px 不可调，
  // 且与 acrylic 材质互斥；改为透明窗口后磨砂感由应用内分层半透明模拟，旧系统无兼容性差异
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Phrontis',
    frame: false,                          // 无边框 → 自定义标题栏
    titleBarStyle: 'hidden',              // macOS 隐藏原生标题栏
    transparent: true,                     // 透明底 → 根容器 18px 自绘圆角（最大化时渲染层自动切直角）
    icon: join(app.getAppPath(), 'build', 'icon.png'),  // 任务栏按钮显式用应用图标（dev 下 electron.exe 无内置图标 → 白板按钮的根因；打包后 exe 自带图标不受影响）
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,                         // preload 仅用 contextBridge/ipcRenderer/webUtils,完全兼容沙箱
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 缩放分层钳制（2026-09-20）：界面缩放走 s.zoom（rem），PDF 页面缩走阅读器内部 zoom——
  // 引擎级 zoomFactor（Ctrl+滚轮整页缩放 / 双指捏合）必须关掉，否则三层缩放互相叠加
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1)

  // 安全：主窗口自身永不导航(应用为单页,任何导航请求均为异常/注入行为)。
  // 例外：同 URL 的 reload——Electron 把 location.reload() 也当导航触发本事件，
  // 无差别 preventDefault 会静默吞掉它（P8 仓库切换整窗重载失效、UI 卡旧仓库的根因）。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const win = mainWindow
    if (win && url === win.webContents.getURL()) return
    event.preventDefault()
  })

  console.log('[Boot] Phrontis main ready - net-v2 -', app.getVersion())

  // 开发模式：F12 切换 DevTools（默认菜单已禁用）
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (!app.isPackaged && input.type === 'keyDown' && input.key === 'F12') {
      mainWindow?.webContents.toggleDevTools()
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 一律不在应用内开新窗口;网页链接转交系统浏览器,其余(file:// 等)直接拒绝
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // ★ B-19：该事件对**子帧**同样触发 —— 书籍内容帧（blob:）在「帧还没加载完就被拆掉/换掉」的
    //   时序上报 ERR_ABORTED(-3)，那是有意取消、不是窗口级故障。不判主帧就会把它按窗口错误报，
    //   每次进出书籍各来一条，混在真故障里增加排查噪声。
    if (!isMainFrame) return
    console.error('[Window] did-fail-load:', { errorCode, errorDescription, validatedURL })
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Window] render-process-gone:', details)
    ;(globalThis as any).__kbLogRendererGone?.(details)
  })
  // ★ B-19：渲染层 error 级消息**按「来源+消息体」去重限流**再转发。
  //   一次「退出书籍回书架」实测在 1.45s 内向这里投递 266 条**同一条** RO 环告警；
  //   无条件转发会把 `npm run dev` 的终端整屏刷掉，真报错被淹没（也正是这批刷屏把 devbridge
  //   500 条日志环挤爆、吃掉了同段的其它证据）。同一条消息每个窗口只放行一次，
  //   被压掉的条数在下次放行时标出来 —— **不整条静音**（别的模块可能真出问题）。
  const rendererLogSeen = new Map<string, { at: number; suppressed: number }>()
  const RENDERER_LOG_WINDOW_MS = 1000
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level < 2) return
    const now = Date.now()
    const key = `${sourceId}:${message}`
    const prev = rendererLogSeen.get(key)
    if (prev && now - prev.at < RENDERER_LOG_WINDOW_MS) {
      prev.suppressed += 1
      return
    }
    const suppressed = prev?.suppressed ?? 0
    rendererLogSeen.set(key, { at: now, suppressed: 0 })
    // 窗口外且久未出现的键及时回收，防长期挂机无界增长
    if (rendererLogSeen.size > 200) {
      for (const [k, v] of rendererLogSeen) {
        if (now - v.at > 10_000) rendererLogSeen.delete(k)
      }
    }
    console.error('[Renderer]', message, `(${sourceId}:${line})`, suppressed > 0 ? `[+${suppressed} 条同类已折叠]` : '')
  })

  // 加载页面
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    // 主窗口真正关闭（托盘「退出」路径）→ 销毁任务栏窗口，让退出流程收尾
    disposeDayPanel()
  })

  // 托盘常驻：点 X = 隐藏到托盘（任务栏独立存活），不退出应用；真正退出走托盘菜单
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })
}

// ===== 窗口控制 + 缩放 + 设置 IPC =====
// 最大化态兜底（真机验证 · UI 优化条目1 的根因）：
// Windows 上 frame:false + transparent:true 的窗口调用 maximize() 后，bounds 已铺满工作区，
// 但 isMaximized() 仍返回 false 且不触发 'maximize' 事件 → 渲染层收不到窗口态变化，
// 自绘圆角与卡片留白都不会切换，表现为「最大化后四个角填不满」。故这里以
// 「bounds 覆盖工作区」的几何判定兜底，任何尺寸/位置变化后都主动同步一次给渲染层。
function coversWorkArea(win: BrowserWindow): boolean {
  if (win.isDestroyed() || win.isMinimized()) return false
  const b = win.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  return b.x <= wa.x + 2 && b.y <= wa.y + 2 && b.width >= wa.width - 2 && b.height >= wa.height - 2
}
function isWinMaximized(win?: BrowserWindow | null): boolean {
  if (!win || win.isDestroyed()) return false
  return win.isMaximized() || coversWorkArea(win)
}
function registerWindowHandlers(): void {
  let lastMaxSent: boolean | null = null
  let preMaxBounds: Electron.Rectangle | null = null
  const syncMaxState = (): void => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    const maxed = isWinMaximized(win)
    if (maxed === lastMaxSent) return
    lastMaxSent = maxed
    win.webContents.send('window:maximizeChange', maxed)
  }
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize()
    // WeChat 模式下小窗要么内嵌在主窗口、要么是独立顶层窗口；最小化主窗口时：
    //   - 内嵌态：随主窗口最小化（同一 BrowserWindow）
    //   - 独立态：保持可见（用户可能想让小窗单独常驻），不联动
  })
  ipcMain.handle('window:maximize', () => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    if (isWinMaximized(win)) {
      // 未进最大化态的透明无边框窗口，unmaximize()/restore() 都可能无效 → 回落到记录的原始 bounds
      if (win.isMaximized()) win.unmaximize()
      else if (preMaxBounds) win.setBounds(preMaxBounds)
      else win.restore()
    } else {
      preMaxBounds = win.getBounds()
      win.maximize()
    }
    syncMaxState()
  })
  ipcMain.handle('window:close', () => mainWindow?.close())
  ipcMain.handle('window:isMaximized', () => isWinMaximized(mainWindow))

  // OS 级全屏（禅模式 Z2+）：覆盖系统任务栏，比最大化更彻底的沉浸。
  // 进入前记录窗口状态，退出时还原（最大化态 → 重新最大化，普通态 → 还原 bounds）
  let preFsMaximized = false
  let preFsBounds: Electron.Rectangle | null = null
  ipcMain.handle('window:set-fullscreen', (_e, flag: boolean) => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    if (flag && !win.isFullScreen()) {
      preFsMaximized = win.isMaximized()
      preFsBounds = preFsMaximized ? null : win.getBounds()
      win.setFullScreen(true)
    } else if (!flag && win.isFullScreen()) {
      win.setFullScreen(false)
      if (preFsMaximized) {
        if (!win.isMaximized()) win.maximize()
      } else if (preFsBounds) {
        win.setBounds(preFsBounds)
      }
      preFsBounds = null
    }
  })
  mainWindow?.on('enter-full-screen', () => mainWindow?.webContents.send('window:fullscreenChange', true))
  mainWindow?.on('leave-full-screen', () => mainWindow?.webContents.send('window:fullscreenChange', false))

  // 抽屉式日程面板：renderer 发送「面板期望宽度」（0 = 收回）。增量协议（2026-09-08 重写）——
  // 打开/拖拽 = 当前窗口宽 + (期望宽 − 上次期望宽)，收回 = 当前窗口宽 − 上次期望宽。
  // 旧「打开时刻基准锚点」的绝对值协议在用户展开态手动放大/缩小窗口后锚点过期：
  // 收起回跳旧基准宽（窗口骤缩，用户实锤），拖拽也会把放大后的窗口拉回旧基准+面板宽。
  // 增量语义下任意窗口尺寸变化后开合都正确；重复/乱序/HMR 重发的同值消息 delta=0 不漂移。
  // 最大化/全屏时窗口由系统管理，自动跳过；右缘越界则整体左移夹回工作区。
  // animate = true 时窗口宽度缓动过渡（开合平滑展开/收回），拖拽调宽传 false 即时跟随。
  let lastDrawerWidth = 0 // 最近一次上报的面板期望宽（>0 = 抽屉开；收回 settle 后清零）
  let drawerAnimTimer: ReturnType<typeof setInterval> | null = null
  const stopDrawerAnim = () => {
    if (drawerAnimTimer) { clearInterval(drawerAnimTimer); drawerAnimTimer = null }
  }
  /** 窗口 bounds 缓动过渡（easeOutCubic，约 200ms）；新请求到来或异常时中断，latest-wins */
  const animateWindowTo = (win: Electron.BrowserWindow, target: Electron.Rectangle, onSettle?: () => void) => {
    stopDrawerAnim()
    const start = win.getBounds()
    const t0 = performance.now()
    const duration = 200
    drawerAnimTimer = setInterval(() => {
      if (win.isDestroyed()) { stopDrawerAnim(); return }
      if (win.isMaximized() || win.isFullScreen()) { stopDrawerAnim(); onSettle?.(); return }
      const p = Math.min(1, (performance.now() - t0) / duration)
      const e = 1 - Math.pow(1 - p, 3)
      const w = Math.round(start.width + (target.width - start.width) * e)
      const x = Math.round(start.x + (target.x - start.x) * e)
      if (p >= 1) {
        stopDrawerAnim()
        win.setBounds({ x: target.x, y: target.y, width: target.width, height: target.height })
        onSettle?.()
        return
      }
      win.setBounds({ x, y: start.y, width: w, height: start.height })
    }, 16)
  }
  ipcMain.handle('window:resizeForSidebar', (_e, width: number, animate = false) => {
    const win = mainWindow
    if (!win || win.isDestroyed() || typeof width !== 'number' || !Number.isFinite(width)) {
      return { applied: false }
    }
    // 贴满/最大化（isWinMaximized = OS maximize ∪ 覆盖工作区——无边框窗口 isMaximized() 不可靠）
    // 时窗口由用户管理，侧栏开合不改窗口尺寸。2026-09-08 实锤：裸 isMaximized() 漏判贴满态，
    // 最大化收侧栏把窗口一起缩了。
    if (isWinMaximized(win) || win.isFullScreen()) return { applied: false, reason: 'maximized' }
    stopDrawerAnim()
    const b = win.getBounds()
    const { workArea } = screen.getDisplayMatching(b)
    const req = Math.max(0, Math.round(width))

    // 收回：当前窗口宽 − 上次面板宽（增量语义，见上；动画进行中忽略重复请求防目标漂移）
    if (req <= 0) {
      if (lastDrawerWidth === 0) return { applied: false }
      const w = Math.max(900, Math.min(workArea.width, b.width - lastDrawerWidth))
      if (w === b.width) {
        lastDrawerWidth = 0
        return { applied: false }
      }
      const target = { ...b, width: w }
      if (animate) animateWindowTo(win, target, () => { lastDrawerWidth = 0 })
      else { win.setBounds(target); lastDrawerWidth = 0 }
      return { applied: true, width: w }
    }

    // 开合缓动进行中忽略重复请求（否则中间态 bounds 参与计算会漂移目标）
    if (drawerAnimTimer) return { applied: false, reason: 'animating' }

    // 打开/拖拽：当前窗口宽 + 宽度增量。首次打开 lastDrawerWidth=0 → delta=期望宽（整体外扩）；
    // 拖拽每帧 delta=与上帧差（跟手）；用户手动改窗后 delta 基于实时 bounds 永远正确。
    // 右缘越界则整体左移夹回工作区防膨胀。
    const delta = req - lastDrawerWidth
    const w = Math.max(900, Math.min(workArea.width, b.width + delta))
    lastDrawerWidth = req
    let x = b.x
    if (w > b.width && x + w > workArea.x + workArea.width) {
      x = Math.max(workArea.x, workArea.x + workArea.width - w)
    }
    const target = { x, y: b.y, width: w, height: b.height }
    if (target.width === b.width && target.x === b.x) return { applied: true, width: w }
    if (animate) animateWindowTo(win, target)
    else win.setBounds(target)
    return { applied: true, width: w }
  })

  // UI 优化条目1.7：最大化后边缘拖拽 → 恢复窗口 + 对边固定 + 被拖边贴随鼠标（Edge 式 v2）。
  // 无埋窗口在最大化态由 OS 接管，原生 resize 热区不响应——渲染层在四边/四角渲染透明热区，
  // mousedown 经此 IPC 交主进程接管：unmaximize → 按恢复几何（preMaxBounds）锚定对边 →
  // 轮询光标实时 setBounds（v2 贴鼠标）。edge='move' 为顶栏拖拽恢复模式（比例映射 + 跟随移动）。
  let edgeDrag: { edge: string; anchor: Electron.Rectangle; p0: Electron.Point; timer: ReturnType<typeof setInterval> | null } | null = null
  const MINW = 900, MINH = 600
  const stopEdgeDrag = (): void => {
    if (edgeDrag?.timer) clearInterval(edgeDrag.timer)
    edgeDrag = null
  }
  /** 恢复几何基准：进最大化前的 bounds；无记录（异常路径）时按工作区 70% 居中兜底 */
  const edgeRestoreRef = (cur: Electron.Rectangle): Electron.Rectangle => {
    if (preMaxBounds) return preMaxBounds
    const { workArea: wa } = screen.getDisplayMatching(cur)
    return {
      x: Math.round(wa.x + wa.width * 0.15), y: Math.round(wa.y + wa.height * 0.12),
      width: Math.round(wa.width * 0.7), height: Math.round(wa.height * 0.7),
    }
  }
  /** 按拖拽边与光标求矩形：对边固定自锚定基准，被拖边贴光标，min clamp 朝拖拽方向撑 */
  const edgeRectFromCursor = (edge: string, ref: Electron.Rectangle, c: Electron.Point): Electron.Rectangle => {
    const dragTop = edge === 'top' || edge.startsWith('top-')
    const dragBottom = edge === 'bottom' || edge.startsWith('bottom-')
    let x = ref.x, y = ref.y
    let right = ref.x + ref.width, bottom = ref.y + ref.height
    if (edge.includes('left')) x = c.x
    if (edge.includes('right')) right = c.x
    if (dragTop) y = c.y
    if (dragBottom) bottom = c.y
    if (right - x < MINW) { if (edge.includes('left')) x = right - MINW; else right = x + MINW }
    if (bottom - y < MINH) { if (dragTop) y = bottom - MINH; else bottom = y + MINH }
    return { x, y, width: right - x, height: bottom - y }
  }
  ipcMain.handle('window:edgeResizeStart', (_e, edge: string) => {
    const win = mainWindow
    if (!win || win.isDestroyed() || typeof edge !== 'string' || !/^(top|bottom|left|right|top-left|top-right|bottom-left|bottom-right|move)$/.test(edge)) {
      return { ok: false }
    }
    stopEdgeDrag()
    const cur = win.getBounds()
    const p0 = screen.getCursorScreenPoint()
    // 真最大化态先退出（透明无埋窗口的几何兜底型 isMaximized=false，直接由下方 setBounds 覆盖）
    if (win.isMaximized()) win.unmaximize()
    let anchor: Electron.Rectangle
    if (edge === 'move') {
      // 顶栏拖拽恢复：水平方向按光标在最大化宽度中的比例映射（Chrome 同款），垂直方向标题栏贴光标下 18px
      const ref = edgeRestoreRef(cur)
      const { workArea: wa } = screen.getDisplayMatching(cur)
      const relX = cur.width > 0 ? (p0.x - cur.x) / cur.width : 0.5
      const x = Math.max(wa.x - ref.width + 120, Math.min(Math.round(p0.x - ref.width * relX), wa.x + wa.width - 120))
      const y = Math.max(wa.y, Math.min(Math.round(p0.y - 18), wa.y + wa.height - 40))
      anchor = { x, y, width: ref.width, height: ref.height }
    } else {
      anchor = edgeRectFromCursor(edge, edgeRestoreRef(cur), p0)
    }
    win.setBounds(anchor)
    edgeDrag = { edge, anchor, p0, timer: null }
    // 跟随循环：光标轮询（DIP 一致）实时 setBounds；mouseup（渲染层）/ 窗口失焦兜底收尾
    edgeDrag.timer = setInterval(() => {
      const w = mainWindow
      if (!w || w.isDestroyed()) { stopEdgeDrag(); return }
      const c = screen.getCursorScreenPoint()
      if (edgeDrag?.edge === 'move') {
        const a = edgeDrag.anchor
        w.setBounds({ x: a.x + (c.x - p0.x), y: a.y + (c.y - p0.y), width: a.width, height: a.height })
      } else {
        w.setBounds(edgeRectFromCursor(edge, edgeDrag!.anchor, c))
      }
    }, 16)
    return { ok: true }
  })
  ipcMain.handle('window:edgeResizeEnd', () => { stopEdgeDrag(); return { ok: true } })

  // 窗口置顶（锁定）
  ipcMain.handle('window:setAlwaysOnTop', (_e, onTop: boolean) => {
    mainWindow?.setAlwaysOnTop(onTop)
    return mainWindow?.isAlwaysOnTop() ?? false
  })
  ipcMain.handle('window:isAlwaysOnTop', () => mainWindow?.isAlwaysOnTop() ?? false)
  ipcMain.handle('window:reload', () => { mainWindow?.webContents.reload() })

  mainWindow?.on('maximize', () => syncMaxState())
  mainWindow?.on('unmaximize', () => syncMaxState())
  mainWindow?.on('closed', stopEdgeDrag)
  mainWindow?.on('blur', stopEdgeDrag) // 拖拽中失焦（Alt-Tab 等）兜底收尾，防跟随循环悬挂
  // 几何兜底路径（透明无边框窗口不进最大化态）依赖 bounds 变化后重估，故 resize/move 也同步
  mainWindow?.on('resize', () => syncMaxState())
  mainWindow?.on('move', () => syncMaxState())
  syncMaxState()

  // 缩放 — 仅缩放内容区（不缩放 chrome）


  // 设置持久化（内存缓存 + 防抖写盘）
  ipcMain.handle('settings:get', (_e, key: string) => {
    return settingsCache[key] ?? null
  })
  ipcMain.handle('settings:getAll', () => {
    return { ...settingsCache }
  })
  ipcMain.handle('settings:set', (_e, key: string, value: unknown) => {
    // 键白名单 + 值类型校验:防止渲染层被注入后覆写任意配置(如 trashExportDir 指向系统目录)
    if (typeof key !== 'string' || !(key in SETTINGS)) return false
    const expected = typeof (SETTINGS as unknown as Record<string, { default: unknown }>)[key].default
    if (typeof value !== expected) return false
    // AI教学 P1（3-15）：aiTeachRootDir 改名 → 当前仓库旧根目录重命名迁移；
    // 失败（占用/权限）保留原文件夹并广播提示不阻塞，仅新名非法时回滚设置值
    if (key === 'aiTeachRootDir' && typeof value === 'string') {
      const raw = settingsCache[key]
      const prev = typeof raw === 'string' && raw ? raw : String((SETTINGS as unknown as Record<string, { default: unknown }>).aiTeachRootDir.default)
      if (prev !== value) {
        settingsCache[key] = value
        const r = migrateAiTeachRootDir(prev, value)
        if (!r.ok && r.error === '目录名不合法') { settingsCache[key] = prev; return false }
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(flushSettingsToDisk, 500)
        return true
      }
    }
    settingsCache[key] = value
    // Debounce write to disk — coalesce rapid setSetting calls into one write
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flushSettingsToDisk, 500)
    return true
  })

  // 清空所有数据（P7 对齐 D6）：已登记仓库整体进 OS 回收站（可还原，替代旧 rmSync 直删）+ 全局重置 → 回首启引导
  ipcMain.handle('db:clearAllData', async () => {
    try {
      // 1) 全部已登记仓库 → 回收站并移除注册（护栏校验失败的仓库跳过并中止，绝不半途强删）
      const { trashed, errors } = await trashAllRegisteredVaults()
      console.log(`[clearAllData] ${trashed} vault(s) moved to trash${errors.length ? '; errors: ' + errors.join('; ') : ''}`)
      if (errors.length > 0 && trashed === 0) {
        return { success: false, error: errors[0] }
      }

      // 2) 仓库登记表清空（回首启引导）+ 当前仓库内存态/持久化一并清
      try { clearVaultRegistry() } catch { /* ignore */ }
      setCurrentVault(null)

      // 3) settings 恢复默认
      settingsCache = {}
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
      flushSettingsToDisk()

      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: (err as Error).message || String(err) }
    }
  })

  // 选择目录对话框
  ipcMain.handle('dialog:openDir', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择回收站文件导出目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })
}

// ===== 应用生命周期 =====
app.whenReady().then(async () => {
  // Windows 系统通知需要 AppUserModelId，否则不进操作中心（日程 DDL 提醒依赖系统通知通道）
  app.setAppUserModelId('com.local.knowbase.programmer')

  // Initialize settings cache once at startup
  settingsCache = loadSettingsFromDisk()

  // 加密自检：确认 safeStorage 密文格式与 secretBox 的假设一致（只告警不阻断，见 secretBox.ts）
  // 目的：把「密文格式变化 / 被误改」这类问题暴露在启动期，而非用户发现「密码全空」时
  try {
    assertSecretBoxRoundTrip()
  } catch { /* 自检自身异常不应影响启动 */ }

  // UI 插件页面协议:plugin://{id}/{file}
  // 安全:CSP 锁死网络(none),只允许插件自身源的内联资源;配合渲染层 iframe sandbox 使用
  const pluginDebugLog = (line: string) => {
    try { appendFileSync(join(app.getPath('userData'), 'plugin-debug.log'), new Date().toISOString().slice(11, 23) + ' ' + line + '\n') } catch { /* ignore */ }
  }
  protocol.handle('plugin', async (request) => {
    pluginDebugLog(`request: ${request.url}`)
    try {
      const url = new URL(request.url)
      const id = url.hostname
      const rel = decodeURIComponent(url.pathname).replace(/^\//, '')
      if (!id || !/^[a-z0-9][a-z0-9._-]*$/.test(id) || !rel) {
        pluginDebugLog(`400 validation failed - hostname=${JSON.stringify(id)} rel=${JSON.stringify(rel)}`)
        return new Response('Bad Request', { status: 400 })
      }
      const dir = join(getPluginsRoot(), id)
      const resolved = resolve(dir, rel)
      if (!resolved.startsWith(dir.endsWith(sep) ? dir : dir + sep)) {
        pluginDebugLog(`403 out-of-bounds - resolved=${resolved}`)
        return new Response('Forbidden', { status: 403 })
      }
      // 内置插件只读兜底（plugin-phase1-design C1）：内置插件首启才播种进插件根目录，
      // 播种前（含启动尾部自检）按插件根查找必然 404——这里按序回落 builtin-plugins 目录，
      // 消解启动时序依赖。逐候选做同样的越界校验，只读不写。
      let file: string | null = existsSync(resolved) && statSync(resolved).isFile() ? resolved : null
      if (!file) {
        const builtinCandidates = app.isPackaged
          ? [join(process.resourcesPath, 'builtin-plugins')]
          : [
              join(app.getAppPath(), 'resources', 'builtin-plugins'),
              resolve(app.getAppPath(), '../..', 'resources', 'builtin-plugins'),
              join(process.cwd(), 'resources', 'builtin-plugins'),
            ]
        for (const builtinDir of builtinCandidates) {
          if (!existsSync(builtinDir)) continue
          const bResolved = resolve(join(builtinDir, id), rel)
          const bRoot = join(builtinDir, id)
          if (!bResolved.startsWith(bRoot.endsWith(sep) ? bRoot : bRoot + sep)) continue
          if (existsSync(bResolved) && statSync(bResolved).isFile()) { file = bResolved; break }
        }
      }
      if (!file) {
        pluginDebugLog(`404 not found - resolved=${resolved}`)
        return new Response('Not Found', { status: 404 })
      }
      const ext = (file.match(/\.(\w+)$/)?.[1] || '').toLowerCase()
      const mimeMap: Record<string, string> = {
        html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css',
        json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
        jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', woff2: 'font/woff2', woff: 'font/woff',
      }
      return new Response(Readable.toWeb(createReadStream(file)) as unknown as BodyInit, {
        headers: {
          'Content-Type': mimeMap[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
          // 插件页面专用 CSP:允许内联脚本/样式与同源自取,断网、禁嵌套、禁表单提交。
          // anims/(内容包分步动画播放器)额外放行 unsafe-eval —— manim-web/MathJax 运行时需要
          'Content-Security-Policy': (rel.startsWith('anims/')
            ? "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' plugin:; style-src 'unsafe-inline' plugin:; img-src data: plugin: blob:; font-src data: plugin:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
            : "default-src 'none'; script-src 'unsafe-inline' plugin:; style-src 'unsafe-inline' plugin:; img-src data: plugin:; font-src data: plugin:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"),
        },
      })
    } catch (e) {
      pluginDebugLog(`handler error: ${e}`)
      console.error('[plugin://] handler error:', request.url, e)
      return new Response('Bad Request', { status: 400 })
    }
  })

  // AI 教学示意图渲染协议 kbview://vault/<rel>.html（工件栏沙箱 iframe；白名单/CSP 见 kbVisualProtocol.ts 头注释）
  registerKbVisualProtocol((key) => settingsCache[key])

  protocol.handle('attachment', async (request) => {
    try {
      const url = new URL(request.url)
      // vault 分支：attachment://vault/<pageId>/<file> —— 页面/仓库移动均不断链
      // （主进程每次按「当前仓库」动态定位，新落盘 .attachments/knowledge_page/<pageId>/<file>，
      //   旧包兼容读取 .knowbase/_attachments/knowledge_page/<pageId>/<file>）
      if (url.hostname === 'vault') {
        const { getCurrentVault } = await import('../lib/kbStore/vaultContext')
        const cur = getCurrentVault()
        if (!cur) return new Response('Not Found', { status: 404 })
        const segs = url.pathname.split('/').filter(Boolean)
        if (segs.length !== 2) return new Response('Not Found', { status: 404 })
        const [pageId, rawFile] = segs
        const file = decodeURIComponent(rawFile)
        // 严格白名单防路径穿越：pageId=UUID；file=文件名（无分隔符、无 ..）
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pageId)) return new Response('Not Found', { status: 404 })
        if (!/^[A-Za-z0-9._\u4e00-\u9fa5-]{1,160}$/.test(file)) return new Response('Not Found', { status: 404 })
        const candidates = [
          join(cur.rootPath, '.attachments', 'knowledge_page', pageId, file),
          join(cur.rootPath, '.knowbase', '_attachments', 'knowledge_page', pageId, file),
        ]
        const p = candidates.find((c) => existsSync(c))
        if (!p) return new Response('Not Found', { status: 404 })
        const ext = (file.match(/\.(\w+)$/)?.[1] || '').toLowerCase()
        const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json' }
        return new Response(Readable.toWeb(createReadStream(p)) as unknown as BodyInit, {
          headers: { 'Content-Type': mimeMap[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' },
        })
      }
      const id = url.hostname
      const thumb = url.searchParams.get('thumb') === '1'
      const p = getAttachmentFilePath(id, thumb)
      if (!p) return new Response('Not Found', { status: 404 })
      const ext = (p.match(/\.(\w+)$/)?.[1] || '').toLowerCase()
        const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json' }
      return new Response(Readable.toWeb(createReadStream(p)) as unknown as BodyInit, {
        headers: { 'Content-Type': mimeMap[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' },
      })
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
  })

  ipcMain.handle('app:getAttachmentsPath', () => getAttachmentsDir())
  // 复制图片到系统剪贴板（path 或 dataUrl），供粘贴到其他程序
  // 剪贴板条件清空:仅当剪贴板内容仍为所复制的密码时才清空,不覆盖用户后续复制的内容
  ipcMain.handle('clipboard:clearIfEqual', (_e, text: string) => {
    try { if (typeof text === 'string' && text && clipboard.readText() === text) clipboard.writeText('') } catch { /* ignore */ }
    return true
  })
  // 通用文本复制（AI 消息复制等）；限制单次 1MB 防滥用
  ipcMain.handle('clipboard:writeText', (_e, text: string) => {
    try {
      if (typeof text !== 'string' || text.length > 1024 * 1024) return false
      clipboard.writeText(text)
      return true
    } catch { return false }
  })
  ipcMain.handle('clipboard:copyImage', (_e, src: { path?: string; dataUrl?: string }) => {
    try {
      let img: Electron.NativeImage | null = null
      if (src?.dataUrl) {
        img = nativeImage.createFromDataURL(src.dataUrl)
      } else if (src?.path && existsSync(src.path)) {
        // 用 Node fs 读字节再转 data URL：nativeImage.createFromPath 对含中文路径可能失败
        const buf = readFileSync(src.path)
        const ext = (src.path.match(/\.(\w+)$/)?.[1] || '').toLowerCase()
        const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml' }
        img = nativeImage.createFromDataURL(`data:${mimeMap[ext] || 'image/png'};base64,${buf.toString('base64')}`)
      }
      if (!img || img.isEmpty()) return false
      clipboard.writeImage(img)
      return true
    } catch {
      return false
    }
  })
  /**
   * 向发起窗口补发一次真实粘贴命令（编辑器文件树右键「粘贴」用，v3.2.0 条目 ③）。
   *
   * Ctrl+V 会自然产生带 `clipboardData.files` 的 paste 事件，但**右键菜单点击是合成动作**，
   * 拿不到 clipboardData；所以由渲染层先把焦点交给文件树，再请主进程代为执行
   * `webContents.paste()`，从而复用同一条 paste 链路（落盘见 ws:pasteExternal）。
   * 用 `e.sender` 而非 mainWindow：多窗口下必须打在发起方（小窗也有编辑器宿主）。
   */
  ipcMain.handle('clipboard:paste', (e) => {
    try { e.sender.paste() } catch { /* 窗口已销毁等：静默 */ }
    return { ok: true }
  })
  ipcMain.handle('app:openExternal', async (_e, target: string) => {
    if (typeof target !== 'string' || !target) return
    // 网页链接 → 系统浏览器(仅 http/https,拒绝 file:/自定义协议)
    if (/^https?:\/\//i.test(target)) {
      await shell.openExternal(target)
      return
    }
    // 本地路径 → 仅允许打开应用数据目录内的文件(附件等);UNC/任意盘符路径一律拒绝
    const resolved = resolve(target)
    const userDataRoot = resolve(app.getPath('userData'))
    const rootWithSep = userDataRoot.endsWith(sep) ? userDataRoot : userDataRoot + sep
    if (resolved.startsWith(rootWithSep) && existsSync(resolved)) {
      await shell.openPath(resolved)
    } else {
      console.warn('[Security] Blocked opening path outside data dir:', target)
    }
  })
  // 番茄钟状态跨窗口中转：主进程维护快照，渲染层上报 + 接收广播（让 popout 独立窗口也能显示番茄钟状态）
  registerPomodoroBroadcast()
  // AI 测试桥(构建期由 __DEV_BRIDGE__ 消除, 运行期再以 app.isPackaged 兜底)。
  // installCapture 同步安装采集, 必须早于下方各 Repository 注册 handler,
  // 否则 IPC 追踪一个通道都覆盖不到; HTTP 服务改为异步启动, 不阻塞启动流程。
  if (__DEV_BRIDGE__ && !app.isPackaged) {
    const bridge = await import('../devbridge')
    bridge.installCapture()
    void bridge.startBridge({
      getMainWindow: () => mainWindow,
      getSettingValue: (key) => settingsCache[key],
    })
  }
  registerWindowHandlers()
  registerRepoConfigHandlers()
  registerEntryHandlers()
  registerTagHandlers()
  registerScheduleHandlers()
  registerKnowledgeHandlers()
  registerExportHandlers()
  registerRecycleBinHandlers()
  registerImportHandlers()
  registerUserHandlers()
  registerToolboxHandlers()
  registerPasswordHandlers()
  registerMomentsHandlers()
  registerAttachmentHandlers()
  registerVaultBackupHandlers()
  registerCheckinHandlers()
  registerBookmarkHandlers()
  registerSuperviseHandlers()
  registerSummaryHandlers()
  registerBlogSummaryHandlers()
  registerBlogTemplateHandlers()
  registerQuizHandlers({ getSettingValue: (key) => settingsCache[key] })
  // PDF 阅读体验整包（v3.4.0 第 2 项）：进度/书签/封面缓存/导入六通道
  registerPdfReaderHandlers()
  // 阅读状态（书架升级全格式阅读器一期）：txt 进度两通道
  registerReaderStateHandlers()
  // 摘录（阅读器 · 摘录先行批次）：四通道
  registerExcerptHandlers()
  // 开发者工具(内部对 app.isPackaged 自行守卫,打包版不注册任何 handler)
  registerDevtoolsHandlers()
  registerUpdateHandlers({ getSettingValue: (key) => settingsCache[key] })
  // 更新说明（VS Code 式 tab）：CHANGELOG 生成的清单 + 手写亮点 + 仓库内阅读记录
  registerReleaseNotesHandlers({ getSettingValue: (key) => settingsCache[key] })
  // 设备传输：局域网短时双向互传（工具箱）
  registerLanShareHandlers()
  // 编辑器工作区（Vault 仓库）：文件服务 + 授权根管理（getSetting 供 AI教学 产物根沉底名单）
  registerWorkspaceHandlers((key) => settingsCache[key])
  // 整仓归档：导出 zip / 导入（剥壳→校验→冲突逐条决策→登记重建，P6）
  registerVaultArchiveHandlers()
  registerPluginHandlers({ getSettingValue: (key) => settingsCache[key] })
  // AI 工具注册表（M1 地基）：内置只读工具 + 审计 + 月度调用上限
  registerAiToolHandlers({ getSettingValue: (key) => settingsCache[key] })
  registerBuiltinTools()
  // MCP 外部服务器管理面（M2）
  registerMcpHandlers()
  // Skill 提示词资产（M3）：聚合插件贡献并登记进注册表（停用状态读写走设置）
  {
    const getSettingValue = (key: string) => settingsCache[key]
    const setSettingValue = (key: string, value: unknown) => {
      if (typeof key !== 'string' || !(key in SETTINGS)) return false
      if (typeof value !== typeof (SETTINGS as unknown as Record<string, { default: unknown }>)[key].default) return false
      settingsCache[key] = value
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(flushSettingsToDisk, 500)
      return true
    }
    registerSkillHandlers({ getSettingValue, setSettingValue })
  }
  // 模型网关 + 最小 Agent 循环
  {
    const getSettingValue = (key: string) => settingsCache[key]
    const setSettingValue = (key: string, value: unknown) => {
      if (typeof key !== 'string' || !(key in SETTINGS)) return false
      if (typeof value !== typeof (SETTINGS as unknown as Record<string, { default: unknown }>)[key].default) return false
      settingsCache[key] = value
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(flushSettingsToDisk, 500)
      return true
    }
    registerLlmHandlers({ getSettingValue, setSettingValue })
    registerAgentHandlers()
    // 会话压缩（conversation-compaction-design）：agent:compressSession（/compress 指令 + 自动预检共用）
    registerAgentCompressHandlers()
    // B4 编辑器内联建议：ai:inlineSuggest:run / :cancel（手动触发，独立于对话历史）
    registerInlineSuggestHandlers()
    // 知识语义索引（knowledge-index-design）：设置页状态卡 + 手动重建
    registerSemanticIndexHandlers()
    // 相似笔记（编辑器右栏）检索 handler
    registerKnowledgeSearchHandlers()
    // AI教学 P1：会话 ⇄ 文件夹绑定（aiTeach:* IPC，总纲 §二）
    registerAiTeachingFolderHandlers((key) => settingsCache[key])
    // AI教学 P5：工作区两层（元数据 .knowbase/modules/aiTeaching/workspaces.json，§3.2-6/3-6）
    registerAiTeachingWorkspaceHandlers((key) => settingsCache[key])
    // AI教学 P6：素材库（SOURCES/{对话夹}/SOURCE.md 登记+区间提取，§3.13 结构 v3）
    registerAiTeachingSourceHandlers((key) => settingsCache[key])
    // AI教学 P8：用户画像（全局 userData + 会话 PROFILE.md 两层，§3.14）
    registerAiTeachingProfileHandlers((key) => settingsCache[key])
    // 划词翻译:离线词典 + LLM 翻译/AI 精讲
    registerTranslateHandlers()
    // PDF 工具箱:合并/页面重组/导出
    registerPdfHandlers()
    // 文档读取（界面阅读 PPT 等）
    registerDocsReadHandlers()
  }

  ipcMain.handle('app:getVersion', () => app.getVersion())

  // 启动自测:验证 plugin:// 管线(仅内置插件存在时),结果写 userData/plugin-debug.log
  {
    const builtinDirDev = join(app.getAppPath(), 'resources', 'builtin-plugins')
    const builtinDir = app.isPackaged ? join(process.resourcesPath, 'builtin-plugins') : builtinDirDev
    try {
      if (existsSync(builtinDir)) {
        const first = readdirSync(builtinDir, { withFileTypes: true }).find(d => d.isDirectory())
        if (first) {
          // 注意:插件 id 以 manifest 为准,可能与目录名不同
          let manifestId = first.name
          try {
            const mf = JSON.parse(readFileSync(join(builtinDir, first.name, 'plugin.json'), 'utf-8'))
            if (typeof mf.id === 'string' && mf.id) manifestId = mf.id
          } catch { /* 用目录名兜底 */ }
          const testUrl = `plugin://${manifestId}/index.html`
          pluginDebugLog(`self-test start: ${testUrl}`)
          net.fetch(testUrl)
            .then(async r => {
              const body = r.ok ? await r.text() : ''
              pluginDebugLog(`self-test result: HTTP ${r.status}${r.ok ? `, body ${body.length} bytes, head=${JSON.stringify(body.slice(0, 50))}` : ''}`)
              console.log(`[plugin://] self-test: ${manifestId}/index.html -> HTTP ${r.status}`)
            })
            .catch(e => { pluginDebugLog(`self-test failed: ${e}`); console.error('[plugin://] self-test failed:', e) })
        }
      } else {
        pluginDebugLog(`self-test skipped: builtin dir missing ${builtinDir}`)
      }
    } catch (e) { pluginDebugLog(`self-test init error: ${e}`) }
  }

  createWindow()

  // 远程监督：每日汇总定时器 + 免打扰补发
  startSuperviseScheduler()

  // 日程 DDL 提醒：接线设置读取器与外部通道；实际检查挂在上面那个 30s tick 里（复用调度器，不新建）
  initScheduleReminders({
    getSetting: (key) => settingsCache[key],
    pushExternal: enqueueExternalPush,
  })

  // MCP：恢复上次启用状态的外部服务器连接（异步，不阻断首帧）
  void restoreMcpConnections().catch((e) => console.warn('[MCP] Startup connection restore error (non-blocking):', (e as Error)?.message || e))

  // Init password auto-fill popup (global shortcut)
  initPasswordFiller()

  // 跨窗口数据变更总线（data:notify → kb:data-changed），先于任何窗口能力注册
  registerWindowBus()

  // 日程与打卡侧边栏（WeChat 模式：内嵌 + 可脱离；桌面互动模式见 dayPanelWindow.ts）
  initDayPanel({
    getMainWindow: () => mainWindow,
    rendererUrl: () => process.env.ELECTRON_RENDERER_URL ?? null,
    getSetting: (key) => settingsCache[key],
    setSetting: (key, value) => {
      settingsCache[key] = value
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(flushSettingsToDisk, 500)
    },
  })

  createTray()

  // Web 剪藏服务（工具箱「网页剪藏」入口的数据面；127.0.0.1 常驻，随应用启停）
  registerClipperHandlers({
    getSetting: (key) => settingsCache[key],
    setSetting: (key, value) => {
      settingsCache[key] = value
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(flushSettingsToDisk, 500)
      return true
    },
  })
  startClipperServer()

  app.on('activate', () => {
    // macOS: 点击 dock 图标时重建窗口
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 用户尝试打开第二个实例 → 激活已有窗口
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    // 托盘常驻下窗口可能处于 hide() 状态：focus() 对隐藏窗口无效，必须 show()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  // 托盘常驻：主窗口隐藏（未销毁）时不会走到这里；真到全窗口关闭时，
  // 若还在托盘常驻期（未触发退出）则保持后台（任务栏 popout 可能存活），否则退出
  if (isQuitting) {
    if (process.platform !== 'darwin') app.quit()
  } else if (!tray && !isPopoutOpen()) {
    app.quit()
  }
})

app.on('before-quit', () => {
  isQuitting = true
  tray?.destroy()
  tray = null
  destroyPasswordFiller()
  stopSuperviseScheduler()
  disposeDayPanel()
  stopClipperServer()
  // v3.2.0 条目 ④：关掉仓库文件监听（防句柄泄漏、防 dev 重启后重复挂载）
  closeVaultWatcher()
  // Flush pending settings writes
  if (saveTimer) { clearTimeout(saveTimer); flushSettingsToDisk() }
})

// 安全：禁止 webview
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (_ev, _wp, _params) => _ev.preventDefault())
})

// dev-watch tick 180146

// dev-watch tick 180459
