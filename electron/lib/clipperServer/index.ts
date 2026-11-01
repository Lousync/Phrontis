import { app, ipcMain, shell } from 'electron'
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { getCurrentVault, KB_DRAFT_DIR } from 'phrontis-core/kbStore/vaultContext'
import { generateToken, tokenMatches } from '../lanShare/auth'
import { createClipperServer, listenClipper, CLIPPER_DEFAULT_PORT } from './server'
import type { Server } from 'http'

/**
 * 剪藏服务生命周期 + 工具箱面板 IPC。
 * 常驻策略：随应用启动（设计文档 §8.7），绑定失败（8 口漂移耗尽）不炸应用，面板显示错误态。
 * token 设备级持久化于 userData/settings.json（`clipperToken`），不随仓库导出/备份外流。
 */

export interface ClipperDeps {
  getSetting: (key: string) => unknown
  setSetting: (key: string, value: unknown) => boolean
}

let depsRef: ClipperDeps | null = null
let serverRef: Server | null = null
let boundPort = 0
let startError = ''

function ensureToken(): string {
  let t = String(depsRef?.getSetting('clipperToken') ?? '')
  if (!/^[A-Za-z0-9_-]{24,64}$/.test(t)) {
    t = generateToken()
    depsRef?.setSetting('clipperToken', t)
  }
  return t
}

export function startClipperServer(): void {
  if (serverRef) return
  const server = createClipperServer({
    getVaultRoot: () => {
      const v = getCurrentVault()
      return v ? { rootPath: v.rootPath, name: v.name } : null
    },
    getToken: ensureToken,
  })
  listenClipper(server)
    .then((port) => {
      serverRef = server
      boundPort = port
      startError = ''
      if (port !== CLIPPER_DEFAULT_PORT) console.log(`[clipper] Default port busy, drifted to ${port}`)
      console.log(`[clipper] Clipper service listening on http://127.0.0.1:${port}`)
    })
    .catch((err: Error) => {
      startError = err.message
      console.error('[clipper] Failed to start:', err.message)
      try { server.close() } catch { /* 半开状态兜底 */ }
    })
}

export function stopClipperServer(): void {
  try { serverRef?.close() } catch { /* ignore */ }
  serverRef = null
  boundPort = 0
}

/** 扩展目录（dev=工程根 clipper-extension，打包=resources/clipper-extension 需 extraResources 同步） */
function extensionDir(): string {
  for (const base of [app.getAppPath(), process.resourcesPath]) {
    if (!base) continue
    const p = join(base, 'clipper-extension')
    if (existsSync(join(p, 'manifest.json'))) return p
  }
  return ''
}

export interface ClipListItem { name: string; size: number; mtimeMs: number }

function listClips(): { available: boolean; dir: string; items: ClipListItem[] } {
  const v = getCurrentVault()
  if (!v) return { available: false, dir: '', items: [] }
  const dir = join(v.rootPath, KB_DRAFT_DIR, 'clipper')
  if (!existsSync(dir)) return { available: true, dir, items: [] }
  try {
    const items = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .map((f) => {
        try {
          const st = statSync(join(dir, f))
          return { name: f, size: st.size, mtimeMs: st.mtimeMs }
        } catch {
          return { name: f, size: 0, mtimeMs: 0 }
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 30)
    return { available: true, dir, items }
  } catch {
    return { available: false, dir, items: [] }
  }
}

export function registerClipperHandlers(deps: ClipperDeps): void {
  depsRef = deps
  ipcMain.handle('clipper:status', () => {
    const v = getCurrentVault()
    const token = ensureToken()
    return {
      running: !!serverRef && boundPort > 0,
      port: boundPort || CLIPPER_DEFAULT_PORT,
      portDrifted: boundPort > 0 && boundPort !== CLIPPER_DEFAULT_PORT,
      error: startError,
      token,
      tokenHint: token.slice(0, 6) + '...' + token.slice(-4),
      vault: v ? { name: v.name, saveDir: join(v.rootPath, KB_DRAFT_DIR, 'clipper') } : null,
      extensionDir: extensionDir(),
      clips: listClips(),
    }
  })
  ipcMain.handle('clipper:resetToken', () => {
    const t = generateToken()
    deps.setSetting('clipperToken', t)
    return { ok: true, token: t }
  })
  ipcMain.handle('clipper:openFolder', () => {
    const c = listClips()
    if (!c.available || !existsSync(c.dir)) return { ok: false, error: '目录尚不存在（还没有剪藏过任何页面）' }
    shell.openPath(c.dir)
    return { ok: true }
  })
  // 面板内「ping 自检」：走与扩展完全相同的 HTTP 路径（含 Origin 白名单），验证服务真的可被扩展触达
  ipcMain.handle('clipper:selfPing', async () => {
    if (!serverRef || !boundPort) return { ok: false, error: '服务未运行' }
    try {
      const r = await fetch(`http://127.0.0.1:${boundPort}/api/ping`, {
        headers: { origin: 'chrome-extension://selftest' },
        signal: AbortSignal.timeout(3000),
      })
      const j = await r.json() as { ok?: boolean; vault?: string | null }
      return { ok: r.status === 200 && !!j.ok, status: r.status, vault: j.vault ?? null }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  // 验证 token 是否为用户填入值（扩展配对排错用；常量时间比较复用 lanShare/auth）
  ipcMain.handle('clipper:checkToken', (_e, candidate: string) => ({ ok: tokenMatches(ensureToken(), String(candidate ?? '')) }))
}
