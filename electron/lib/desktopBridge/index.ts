import { app } from 'electron'
import { subscribeDataChanged } from '../../main/windowBus'
import { startDesktopBridge, type DesktopBridgeHandle } from './dbusService'

let handle: DesktopBridgeHandle | null = null
let unsubscribe: (() => void) | null = null

/**
 * 启动桌面集成（阶段 1）：D-Bus 服务 + 数据变更 → `Changed` 信号。
 *
 * 调用点必须在 `createWindow()` 之后：D-Bus 激活（面板在没有应用时调用方法）
 * 会等总线名出现，名字注册得越晚，调用方拿到的窗口就越「熟」。
 */
export async function initDesktopBridge(opts: { packaged: boolean; showWindow: () => void }): Promise<void> {
  if (handle) return
  handle = await startDesktopBridge(opts)
  if (!handle) return

  unsubscribe = subscribeDataChanged((scope) => {
    // 只转发消费方关心的域；渲染层的高频 scope（如 settings）不外泄
    const mapped = scope === 'schedule' || scope === 'habit' ? 'today'
      : scope === 'knowledge' ? 'vault'
        : null
    if (mapped) handle?.emitChanged(mapped)
  })

  app.once('before-quit', () => {
    unsubscribe?.()
    unsubscribe = null
    handle?.stop()
    handle = null
  })
}
