import { app, ipcMain } from 'electron'
import { basename } from 'path'
import { createLanShareServer, getLanAddresses } from './server'
import { generateToken } from './auth'
import { toQrDataUrl } from './qr'
import {
  listInboxFiles, listOutboxFiles, removeInboxFile, removeOutboxFile, addToOutbox, clearOutbox,
} from './files'

/**
 * 设备传输（工具箱）生命周期与 IPC。
 *
 * 交互模型：手动开启 → 显示二维码 → 平板扫码即连（token 在 URL 内）→ 用完手动关或超时自动关。
 *  - token 每次开启重新生成，关闭即失效
 *  - outbox 关闭时清空，符合「用完即走、不留垃圾」
 */

export const DEFAULT_PORT = 8765
export const DEFAULT_AUTO_STOP_MINUTES = 15
const MAX_PORT_TRIES = 10

interface ServiceState {
  server: ReturnType<typeof createLanShareServer> | null
  port: number
  token: string
  startedAt: number
  remainingMs: number
  autoStopMs: number
  interval: NodeJS.Timeout | null
}

let state: ServiceState = {
  server: null,
  port: 0,
  token: '',
  startedAt: 0,
  remainingMs: 0,
  autoStopMs: 0,
  interval: null,
}

export interface LanShareStatus {
  running: boolean
  port: number
  urls: string[]
  remainingMs: number
  startedAt: number
}

function status(): LanShareStatus {
  if (!state.server) return { running: false, port: 0, urls: [], remainingMs: 0, startedAt: 0 }
  const urls = getLanAddresses().map(ip => `http://${ip}:${state.port}/?token=${state.token}`)
  return {
    running: true,
    port: state.port,
    urls,
    remainingMs: Math.max(0, state.remainingMs),
    startedAt: state.startedAt,
  }
}

function clearTimer(): void {
  if (state.interval) {
    clearInterval(state.interval)
    state.interval = null
  }
}

function onActivity(): void {
  state.remainingMs = state.autoStopMs
}

function startTimer(): void {
  clearTimer()
  state.interval = setInterval(() => {
    state.remainingMs -= 1000
    if (state.remainingMs <= 0) {
      void stop()
    }
  }, 1000)
}

export async function start(opts?: { port?: number; autoStopMinutes?: number }): Promise<LanShareStatus> {
  if (state.server) await stop()
  const port = opts?.port && opts.port > 0 && opts.port < 65536 ? opts.port : DEFAULT_PORT
  const autoStopMs = (opts?.autoStopMinutes ?? DEFAULT_AUTO_STOP_MINUTES) * 60 * 1000

  const token = generateToken()
  const server = createLanShareServer({
    token,
    onActivity,
    remainingMs: () => Math.max(0, state.remainingMs),
  })

  let boundPort = 0
  for (let i = 0; i < MAX_PORT_TRIES; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port + i, '0.0.0.0', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      boundPort = port + i
      break
    } catch (e) {
      if (i === MAX_PORT_TRIES - 1) throw e
    }
  }

  state = {
    server,
    port: boundPort,
    token,
    startedAt: Date.now(),
    remainingMs: autoStopMs,
    autoStopMs,
    interval: null,
  }
  startTimer()
  return status()
}

export async function stop(): Promise<{ ok: boolean }> {
  clearTimer()
  if (state.server) {
    const s = state.server
    state.server = null
    await new Promise<void>(resolve => {
      s.close(() => resolve())
      s.closeAllConnections() // 强制断开 keep-alive 连接，避免 close 回调挂起
    })
  }
  clearOutbox()
  state.remainingMs = 0
  return { ok: true }
}


// ---- IPC ----

export function registerLanShareHandlers(): void {
  ipcMain.handle('lanShare:start', (_e, opts?: { port?: number; autoStopMinutes?: number }) => start(opts))
  ipcMain.handle('lanShare:stop', () => stop())
  ipcMain.handle('lanShare:status', () => status())
  ipcMain.handle('lanShare:lanAddresses', () => getLanAddresses())
  ipcMain.handle('lanShare:qr', (_e, text: unknown) =>
    typeof text === 'string' && text ? toQrDataUrl(text) : '')
  ipcMain.handle('lanShare:listInbox', () => listInboxFiles())
  ipcMain.handle('lanShare:listOutbox', () => listOutboxFiles())
  ipcMain.handle('lanShare:removeInbox', (_e, name: unknown) => ({ ok: removeInboxFile(name) }))
  ipcMain.handle('lanShare:removeOutbox', (_e, name: unknown) => ({ ok: removeOutboxFile(name) }))
  ipcMain.handle('lanShare:addToOutbox', (_e, data: { path?: string }) => {
    const dest = data && typeof data.path === 'string' && data.path ? addToOutbox(data.path) : null
    return { ok: !!dest, name: dest ? basename(dest) : '' }
  })
  ipcMain.handle('lanShare:clearOutbox', () => ({ ok: (clearOutbox(), true) }))

  // 应用退出时确保服务关闭、outbox 清空
  app.on('before-quit', () => {
    if (state.server) {
      try {
        state.server.close()
        state.server.closeAllConnections()
      } catch { /* 忽略 */ }
      clearOutbox()
    }
  })
}
