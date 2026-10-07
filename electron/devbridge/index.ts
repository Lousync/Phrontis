import { app, ipcMain } from 'electron'
import {
  installNetCapture,
  installIpcCapture,
  installConsoleCapture,
  recordLog,
  setUiState,
  type LogItem,
} from './capture'
import { configureBridge, startServer, DEFAULT_PORT, type BridgeDeps } from './server'

/**
 * AI 测试桥入口 —— 唯一被 main 动态 import 的文件。
 *
 * 拆成两步是为了满足一个时序约束：
 * installIpcCapture 通过包装 ipcMain.handle 记录调用，**必须早于各 Repository
 * 注册 handler**，否则一个通道都覆盖不到。因此 main 里用
 * `const m = await import('../devbridge'); m.installCapture()` 同步安装采集，
 * 再用 `void m.startBridge(...)` 异步起 HTTP，不阻塞启动流程。
 */

let installed = false

interface ReportPayload {
  logs?: Array<{ level: LogItem['level']; message: string; stack?: string }>
  ui?: { activeModule?: string; route?: string; detail?: Record<string, unknown> }
}

/** 同步：安装全部采集器与上报通道。幂等。 */
export function installCapture(): void {
  // 双保险：构建期由 __DEV_BRIDGE__ 消除，此处再以 app.isPackaged 兜底
  if (app.isPackaged || installed) return
  installed = true

  installIpcCapture()
  installNetCapture()
  installConsoleCapture()

  ipcMain.handle('devbridge:report', (_event, payload: ReportPayload) => {
    try {
      if (payload?.logs?.length) {
        for (const l of payload.logs) {
          recordLog(l.level ?? 'log', 'renderer', String(l.message ?? ''), l.stack)
        }
      }
      if (payload?.ui) setUiState(payload.ui)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

/** 异步：启动 HTTP 服务（不阻塞应用启动） */
export async function startBridge(deps: BridgeDeps = {}): Promise<void> {
  if (app.isPackaged) return
  installCapture()
  configureBridge(deps)

  const preferred = Number(process.env.KNOWBASE_DEV_BRIDGE_PORT) || DEFAULT_PORT
  try {
    const { url } = await startServer(preferred)
    console.log(`[AI-BRIDGE] ${url}   (dev only, not included in production build)`)
  } catch (e) {
    console.error('[AI-BRIDGE] Failed to start:', e instanceof Error ? e.message : e)
  }
}

