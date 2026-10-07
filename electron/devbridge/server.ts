import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { app, type BrowserWindow } from 'electron'
import { guard, ok, fail, throwErr, BRIDGE_BOOT_AT } from './response'
import { logRing, netRing, ipcRing, aggregateErrors, getUiState } from './capture'
import { parseListOptions } from './ring'
import { runAction, listActions } from './actions'
import { runSelfTest, listChecks, coverage } from './selftest'
import { buildReport } from './report'
import { takeScreenshot, dumpUiTree, configureUiTarget } from './ui'

/**
 * HTTP 调试桥 —— AI 用 curl 即可观测与驱动，无需冷启动应用、无需手写 CDP 协议。
 *
 * 安全：仅监听 127.0.0.1；动作白名单；端口被占用时自动顺延。
 * R6 去库化：/db/* SQL 直查、快照/diff、compat 历史库端点随 connection.ts 移除。
 */

export const DEFAULT_PORT = 7465
const HOST = '127.0.0.1'
const MAX_BODY = 1024 * 1024

export interface BridgeDeps {
  getMainWindow?: () => BrowserWindow | null
  getSettingValue?: (key: string) => unknown
}

let deps: BridgeDeps = {}

export function configureBridge(next: BridgeDeps): void {
  deps = next
  configureUiTarget(next.getMainWindow)
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function parseJson(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') throwErr('E_BAD_REQUEST', '请求体需为 JSON 对象')
    return parsed as Record<string, unknown>
  } catch (e) {
    if (e instanceof SyntaxError) throwErr('E_BAD_REQUEST', 'JSON 解析失败', { raw: raw.slice(0, 200) })
    throw e
  }
}

/** 端点自描述：AI 调一次即可知道有哪些能力 */
function indexDoc() {
  return {
    name: 'knowbase-dev-bridge',
    note: '仅开发/测试环境启用；生产构建不包含本模块',
    endpoints: [
      { method: 'GET', path: '/', desc: '端点清单' },
      { method: 'GET', path: '/health', desc: '存活、版本、运行时长' },
      { method: 'GET', path: '/state', desc: '应用状态：窗口、UI 状态、设置摘要' },
      { method: 'GET', path: '/logs', desc: '日志，query: since / limit / level / scope' },
      { method: 'GET', path: '/errors', desc: '聚合后的报错，query: warn=1 含警告' },
      { method: 'GET', path: '/net', desc: '网络请求，query: since / limit' },
      { method: 'GET', path: '/ipc', desc: 'IPC 调用，query: since / limit' },
      { method: 'POST', path: '/action', desc: '执行动作，body: { name, params }' },
      { method: 'GET', path: '/selftest', desc: '自检，query: only=<name>' },
      { method: 'GET', path: '/report', desc: 'AI 体检报告（selftest+errors+慢IPC）' },
      { method: 'GET', path: '/coverage', desc: '需求↔断言覆盖率地图' },
      { method: 'GET', path: '/ui/screenshot', desc: '截取当前界面存为 PNG，返回文件路径；?window=main|day-panel' },
      { method: 'GET', path: '/ui/tree', desc: '可见可交互元素树（#N 索引 + 稳定选择器）；?window=main|day-panel' },
    ],
    actions: listActions(),
    checks: listChecks(),
  }
}

function health() {
  return {
    ok: true,
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    node: process.version,
    uptimeMs: Date.now() - BRIDGE_BOOT_AT,
  }
}

function state() {
  const win = deps.getMainWindow?.() ?? null
  const bounds = win && !win.isDestroyed() ? win.getBounds() : null
  return {
    app: { version: app.getVersion(), isPackaged: app.isPackaged },
    window: {
      exists: !!win && !win.isDestroyed(),
      focused: win && !win.isDestroyed() ? win.isFocused() : false,
      minimized: win && !win.isDestroyed() ? win.isMinimized() : false,
      bounds,
    },
    ui: getUiState(),
    settingsSummary: {
      theme: deps.getSettingValue?.('theme') ?? null,
    },
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const startedAt = Date.now()
  const url = new URL(req.url ?? '/', `http://${HOST}`)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const method = (req.method ?? 'GET').toUpperCase()

  // 只接受本机回环地址，防止同网段其他机器探测
  const remote = req.socket.remoteAddress ?? ''
  if (remote && remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
    send(res, 403, fail('E_DISABLED', '仅允许本机访问', startedAt, { remote }))
    return
  }

  try {
    if (path === '/' && method === 'GET') {
      send(res, 200, ok(indexDoc(), startedAt))
      return
    }
    if (path === '/health' && method === 'GET') {
      send(res, 200, ok(health(), startedAt))
      return
    }
    if (path === '/state' && method === 'GET') {
      send(res, 200, ok(state(), startedAt))
      return
    }
    if (path === '/logs' && method === 'GET') {
      const opts = parseListOptions(url.searchParams)
      const level = url.searchParams.get('level')
      const scope = url.searchParams.get('scope')
      let items = logRing.list(opts)
      if (level) items = items.filter((i) => i.level === level)
      if (scope) items = items.filter((i) => i.scope === scope)
      send(res, 200, ok({ items, total: logRing.size, lastSeq: logRing.lastSeq }, startedAt))
      return
    }
    if (path === '/errors' && method === 'GET') {
      const includeWarn = url.searchParams.get('warn') === '1'
      send(res, 200, ok({ items: aggregateErrors(includeWarn) }, startedAt))
      return
    }
    if (path === '/net' && method === 'GET') {
      const opts = parseListOptions(url.searchParams)
      send(res, 200, ok({ items: netRing.list(opts), total: netRing.size, lastSeq: netRing.lastSeq }, startedAt))
      return
    }
    if (path === '/ipc' && method === 'GET') {
      const opts = parseListOptions(url.searchParams)
      send(res, 200, ok({ items: ipcRing.list(opts), total: ipcRing.size, lastSeq: ipcRing.lastSeq }, startedAt))
      return
    }
    if (path === '/action' && method === 'POST') {
      const body = parseJson(await readBody(req))
      const result = await runAction(String(body.name ?? ''), (body.params ?? {}) as Record<string, unknown>)
      send(res, 200, ok(result, startedAt))
      return
    }
    if (path === '/selftest' && method === 'GET') {
      const only = url.searchParams.get('only') ?? undefined
      const report = await runSelfTest(only)
      // 整体失败时仍返回 200：HTTP 状态码表示「接口可达」，业务成败看 body 的 ok/failed
      send(res, 200, ok(report, startedAt))
      return
    }
    if (path === '/report' && method === 'GET') {
      send(res, 200, ok(await buildReport(), startedAt))
      return
    }
    if (path === '/coverage' && method === 'GET') {
      send(res, 200, ok(coverage(), startedAt))
      return
    }
    if (path === '/ui/screenshot' && method === 'GET') {
      send(res, 200, ok(await takeScreenshot(url.searchParams.get('window') ?? undefined), startedAt))
      return
    }
    if (path === '/ui/tree' && method === 'GET') {
      send(res, 200, ok(await dumpUiTree(url.searchParams.get('window') ?? undefined), startedAt))
      return
    }

    send(res, 404, fail('E_NOT_FOUND', `未知端点 ${method} ${path}`, startedAt))
  } catch (err) {
    const resp = await guard(
      () => {
        throw err
      },
      startedAt
    )
    const status =
      resp.error?.code === 'E_NOT_FOUND'
        ? 404
        : resp.error?.code?.startsWith('E_BAD') || resp.error?.code?.startsWith('E_UI')
          ? 400
          : 500
    send(res, status, resp)
  }
}

export interface StartedServer {
  port: number
  url: string
}

/** 启动服务；端口被占用时自动顺延，最多尝试 10 次 */
export function startServer(preferredPort = DEFAULT_PORT): Promise<StartedServer> {
  return new Promise((resolve, reject) => {
    let attempt = 0
    const server = createServer((req, res) => {
      void route(req, res).catch((e) => {
        try {
          send(res, 500, { ok: false, error: { code: 'E_INTERNAL', message: String(e) } })
        } catch {
          /* 连接已断开 */
        }
      })
    })

    const tryListen = (port: number) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        // Windows 系统保留段(Hyper-V/WSL 动态排除)是连续整块(实测本机 7465 起约 25+ 个端口全部 EACCES),
        // 步进 1 时必须跨过整块才能落点,故尝试上限取 120(7465→7585)而非小步数
        if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && attempt < 120) {
          attempt++
          tryListen(port + 1)
          return
        }
        reject(err)
      })
      server.listen(port, HOST, () => {
        resolve({ port, url: `http://${HOST}:${port}` })
      })
    }

    tryListen(preferredPort)
  })
}
