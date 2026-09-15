import { ipcMain, BrowserWindow } from 'electron'

/**
 * 跨窗口数据变更总线（与任何具体窗口解耦）
 *
 * 任一窗口写操作完成后调用 data:notify({ scope }) → 主进程转发 kb:data-changed
 * 给除发送方外的所有窗口（发送方自身已在渲染层本地广播，无需回传）。
 *
 * 2026-08-31 从 dayPanelWindow.ts 挪出：它是全应用级能力（schedule ↔ habit ↔
 * 小窗 ↔ 未来任何新窗口），不该寄生在小窗模块里，否则小窗一拆同步就断。
 */
export function registerWindowBus(): void {
  ipcMain.on('data:notify', (event, payload) => {
    if (!payload || typeof payload !== 'object' || typeof (payload as { scope?: unknown }).scope !== 'string') return
    // 此通道由渲染层发起、须**排除发送方**（发送方已本地广播），故不走 broadcast() —— 保留显式循环
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents !== event.sender && !w.isDestroyed()) {
        w.webContents.send(BROADCAST_CHANNEL.kbDataChanged, payload)
      }
    }
  })
}

/**
 * 主进程侧主动广播数据变更（2026-09-10 补）。
 *
 * 与 data:notify 的区别：后者由**渲染层**发起、且刻意排除发送方（发送方自己已本地广播过）；
 * 这里由**主进程内部**发起（AI 工具写盘、后台任务等），没有"发送方窗口"这个概念，
 * 因此发给**所有**窗口 —— 否则主窗口永远收不到，AI 写完数据后界面不会刷新
 * （表现为：AI 说创建成功了，日程/打卡页面却看不到，必须切月份或重启）。
 *
 * scope 取值与 src/lib/dataChanged.ts 的 DataChangeScope 对齐。
 */
export function broadcastDataChanged(scope: string): void {
  broadcast(BROADCAST_CHANNEL.kbDataChanged, { scope })
}

/**
 * 主进程 → 渲染层的**自定义事件广播**唯一出口（v3.1.2 收敛）。
 *
 * 与 `broadcastDataChanged` 的分工：后者是「数据变更」这条特定业务通道（载荷固定 `{ scope }`）；
 * 本函数是**裸广播**，凡主进程要主动推给所有窗口的自定义事件都走它。
 *
 * 收敛原因：此前「挨个窗口 for + send」的样板在 10+ 处各写一遍，其中 `aiTeach:tree-refresh`
 * 更是有**六份等价实现**（aiTeachingFolders / Sources / Profile×3 / Workspaces）——通道协议
 * （channel 名 + 载荷形状）没有唯一真相源，改协议只改一处会**静默失效**（不报错，只是界面不刷新）。
 *
 * 语义与 `broadcastDataChanged` 一致：主进程发起 → 发给**所有**窗口（无发送方排除概念；
 * 需要排除发送方的走 `registerWindowBus` 的 data:notify 通道）。
 * `payload` 省略时不带参数 send（保持与 `webContents.send(channel)` 等价，避免多传一个 undefined）。
 */
export function broadcast(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    if (payload === undefined) w.webContents.send(channel)
    else w.webContents.send(channel, payload)
  }
}

/** 主进程 → 渲染层广播通道名（**唯一真相源，改协议只改这里**）；渲染层订阅端为字符串字面量 */
export const BROADCAST_CHANNEL = {
  /** 数据变更（主进程侧主动广播；渲染层 DataChangeScope） */
  kbDataChanged: 'kb:data-changed',
  /** AI教学：编辑区树 / AI教学自绘树刷新，载荷 `{ dirRel: string }` */
  aiTeachTreeRefresh: 'aiTeach:tree-refresh',
  /** AI教学：模块内提示条，载荷 `string` */
  aiTeachNotice: 'aiTeach:notice',
  /** AI教学：网页抓取进度，载荷 `{ sessionId, no, done, total, current }` */
  aiTeachWebCrawlProgress: 'aiTeach:web-crawl-progress',
  /** 仓库文件被主进程改写（AI 写工具落盘），载荷 `{ relPath, mtimeMs? }` */
  wsExternalChange: 'ws:external-change',
  /** 插件事件投递，载荷 `{ pluginId, event, payload, dropped? }` */
  pluginEvent: 'plugin:event',
  /** 插件安装/启停状态变化，无载荷 */
  pluginInstalledChanged: 'plugin:installed-changed',
  /** 插件下载进度，载荷 `{ key, received, total, percent, host }` */
  pluginDownloadProgress: 'plugin:download-progress',
  /** 应用更新下载进度，载荷 `{ percent, receivedBytes, totalBytes }` */
  updateDownloadProgress: 'update:download-progress',
  /** 应用更新下载阶段，载荷 `{ stage: 'downloading' | 'verifying' | 'switching' }`
   *  —— 进度无变化时的可读反馈（校验空窗 / 换通道），见 updateService.ts */
  updateDownloadStage: 'update:download-stage',
  /** 番茄钟状态广播，载荷 PomodoroSnapshot */
  pomodoroStateBroadcast: 'pomodoro:state-broadcast',
  /** 小窗（日面板）状态变化，载荷 `{ detached, mode, collapsed, widgetInteractive }` */
  dayPanelStateChanged: 'daypanel:state-changed',
  /** 小窗（日面板）形态切换，载荷 `{ mode: PanelMode }` */
  dayPanelModeChanged: 'daypanel:mode-changed',
  /** 小窗（日面板）显示/隐藏切换意图，无载荷 */
  dayPanelToggleVisibility: 'daypanel:toggle-visibility',
  /** 小窗（日面板）top-dock 收缩态变化，载荷 `{ collapsed: boolean }` */
  dayPanelCollapsedChanged: 'daypanel:collapsed-changed',
  /** 小窗（日面板）桌面小组件可交互态变化，载荷 `{ interactive: boolean }` */
  dayPanelWidgetInteractiveChanged: 'daypanel:widget-interactive-changed',
} as const
