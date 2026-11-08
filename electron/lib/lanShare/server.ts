import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { createReadStream, statSync } from 'fs'
import { isPrivateAddress, tokenMatches, extractToken } from './auth'
import { getLanAddressCandidates, orderLanAddresses } from './addresses'
import { listOutboxFiles, markOutboxDownloaded, resolveOutboxPath } from './files'
import { parseUpload, HttpError } from './upload'
import { renderPage } from './page'

/**
 * 设备传输 HTTP 服务（Node 原生实现，零依赖）。
 *
 * 路由：
 *   GET  /                 平板端单页（需 token，随扫码 URL 带入）
 *   GET  /api/status       剩余时间
 *   GET  /api/outbox       电脑待发送文件列表
 *   POST /api/upload       平板上传（multipart，流式写盘）
 *   GET  /api/download     下载 outbox 文件并标记已下载
 *   GET  /api/ping         存活探测
 *
 * 安全：token 一次性（每次开启重新生成）+ 来源 IP 限私有网段 + 文件名全走 safePathInside。
 */

export interface LanShareServerOptions {
  token: string
  /** 每次有效请求时回调，供上层重置「自动关闭」计时 */
  onActivity?: () => void
  /** 剩余毫秒数（上层维护，-1 表示不限时） */
  remainingMs: () => number
}

/** 本机局域网 IPv4 列表（推荐序：真实网卡优先、docker 网桥等虚拟网卡靠后，去重），用于展示地址与生成二维码。
 *  排序规格 2026-11-08 起收敛到 ./addresses.ts（orderLanAddresses），此处只保留 string[] 兼容出口。 */
export function getLanAddresses(): string[] {
  return orderLanAddresses(getLanAddressCandidates()).map(c => c.addr)
}

export function createLanShareServer(opts: LanShareServerOptions): ReturnType<typeof createServer> {
  const { token, onActivity, remainingMs } = opts

  function sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  function deny(res: ServerResponse, status: number, message: string): void {
    sendJson(res, status, { ok: false, error: message })
  }

  /** 全局守卫：私有网段 + token。通过则返回 true 并触发 activity */
  function guard(req: IncomingMessage, res: ServerResponse): boolean {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
    if (!isPrivateAddress(ip) && ip !== '127.0.0.1' && ip !== '::1') {
      deny(res, 403, '仅允许局域网设备访问')
      return false
    }
    const provided = extractToken(req.url, req.headers.authorization)
    if (!tokenMatches(token, provided)) {
      deny(res, 401, '无效的访问令牌')
      return false
    }
    onActivity?.()
    return true
  }

  const server = createServer((req, res) => {
    const method = (req.method || 'GET').toUpperCase()
    const url = req.url || '/'
    const pathname = url.split('?')[0]

    try {
      if (!guard(req, res)) return

      if (method === 'GET' && pathname === '/') {
        const hostname = getLanAddresses()[0] || '本机'
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(renderPage(hostname))
        return
      }

      if (method === 'GET' && pathname === '/api/status') {
        sendJson(res, 200, { ok: true, remainingMs: remainingMs() })
        return
      }

      if (method === 'GET' && pathname === '/api/ping') {
        sendJson(res, 200, { ok: true })
        return
      }

      if (method === 'GET' && pathname === '/api/outbox') {
        sendJson(res, 200, { ok: true, files: listOutboxFiles() })
        return
      }

      if (method === 'POST' && pathname === '/api/upload') {
        void (async () => {
          try {
            const files = await parseUpload(req)
            sendJson(res, 200, {
              ok: true,
              files: files.map(f => ({ originalName: f.originalName, size: f.size })),
            })
          } catch (e) {
            if (e instanceof HttpError) deny(res, e.status, e.message)
            else {
              console.error('[lanShare] Upload parse failed', e)
              deny(res, 500, '上传处理失败')
            }
          }
        })()
        return
      }

      if (method === 'GET' && pathname === '/api/download') {
        const name = new URLSearchParams(url.split('?')[1] || '').get('name') || ''
        const p = resolveOutboxPath(name)
        if (!p) {
          deny(res, 404, '文件不存在')
          return
        }
        const size = statSync(p).size
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': size,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          'cache-control': 'no-store',
        })
        const stream = createReadStream(p)
        stream.pipe(res)
        stream.on('end', () => markOutboxDownloaded(name))
        stream.on('error', () => res.destroy())
        return
      }

      deny(res, 404, '接口不存在')
    } catch (e) {
      console.error('[lanShare] Request handling error', e)
      deny(res, 500, '内部错误')
    }
  })

  return server
}
