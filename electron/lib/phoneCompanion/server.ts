import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import {
  MAX_BODY_BYTES, PAIR_ATTEMPTS_PER_MIN, PAIR_CODE_TTL_MS, PROTOCOL_VERSION, SYNC_DOMAINS,
  normalizeLedgerData, normalizeScheduleData, normalizeNoteData, isTombstoneData,
  type LedgerItemData, type ScheduleItemData, type NoteItemData, type SyncDomain,
} from './protocol.ts'
import { isPrivateAddress, generateToken, tokenMatches } from '../lanShare/auth.ts'

/* 相对导入显式带 .ts：契约脚本以 node --experimental-strip-types 直跑本文件（零 electron 依赖）。 */

/**
 * 手机伴侣 HTTP 服务（Node 原生实现，零 electron 依赖 —— 依赖全部注入，契约脚本可直接驱动）。
 *
 * 路由：
 *   OPTIONS *            CORS 预检（手机 WebView 与本服务不同源）
 *   POST /api/pair       配对：配对码换长期设备令牌（无需令牌）
 *   GET  /api/ping       存活探测（带令牌）
 *   POST /api/sync/push  手机上行变更（域级 LWW 合并）
 *   POST /api/sync/pull  手机拉取服务端变更
 *
 * 安全：来源 IP 限私有网段（127.0.0.1 供本机测试）+ 设备令牌 Bearer + 配对码限频。
 * 与 lanShare 的差异：令牌长期有效（配对即存）、服务常驻（无自动关闭计时）。
 */

export interface CompanionDevice {
  deviceId: string
  name: string
  /** 长期令牌：仅存在于服务端设备表与手机本地，请求经 Bearer 头携带 */
  token: string
  pairedAt: number
  lastSeenAt: number
}

export interface CompanionPairCode {
  code: string
  expiresAt: number
}

export interface CompanionServerDeps {
  /** 已配对设备持久层（生产 = userData JSON；契约脚本 = 内存） */
  loadDevices(): CompanionDevice[]
  saveDevices(list: CompanionDevice[]): void
  /** 当前配对码（null = 未出示）；服务端只读，作废走 consumePairCode */
  getPairCode(): CompanionPairCode | null
  consumePairCode(): void
  /** ledger 域写入（生产 = vaultAccountingSyncUpsert；已含 LWW，返回 conflict 即服务端更新） */
  applyLedger(item: { id: string; updatedAt: string; data: LedgerItemData }): { applied: boolean; conflict?: boolean; reason?: string }
  /** schedule 域写入（生产 = vaultScheduleSyncUpsert；同一条 LWW 时线） */
  applySchedule(item: { id: string; updatedAt: string; data: ScheduleItemData }): { applied: boolean; conflict?: boolean; reason?: string }
  /** notes 域写入（v1.2，生产 = vaultUpsertPhoneNote；手机是闪念真相源，无条件应用） */
  applyNote(item: { id: string; updatedAt: string; data: NoteItemData }): { applied: boolean; reason?: string }
  /** 删除同步（v1.1 墓碑）：手机上行 `data:{deleted:true}` 的变更。
   * 生产 = 查现行行做 LWW（删除比行 updatedAt 旧 → conflict 拒删）→ 删行（repo 内部 emit 墓碑）
   * → 无行时直接记墓碑（幂等）。
   */
  applyDelete(domain: SyncDomain, id: string, deletedAt: string): { applied: boolean; conflict?: boolean; reason?: string }
  /** ledger 域读取：updatedAt > sinceMs 的条目 */
  listLedgerSince(sinceMs: number): Array<{ id: string; updatedAt: string; data: LedgerItemData }>
  /** schedule 域读取：updatedAt > sinceMs 的条目（含子任务行） */
  listScheduleSince(sinceMs: number): Array<{ id: string; updatedAt: string; data: ScheduleItemData }>
  /** 全域墓碑：deletedAt > sinceMs（手机按 domain 分派 + 幂等应用） */
  listTombstonesSince(sinceMs: number): Array<{ domain: string; id: string; deletedAt: string }>
  /** v1.2 内容 API：doc 类页面平表（排除欢迎页与 file 条目；手机按 path 自行建目录树） */
  listNoteTree(): Array<{ id: string; title: string; path: string; categoryId: string | null; mtimeMs: number; sizeBytes: number }>
  /** v1.2 内容 API：按 id 读正文（服务端解析路径；找不到/不可读返回 null → 404） */
  readNoteContent(id: string): { title: string; updatedAt: string; body: string; truncated?: boolean } | null
  /**
   * v1.3 电脑档：对话中继到桌面完整 agentService（生产 = agentChatViaCompanion 的瘦身投影）。
   * sessionId 空 → 桌面新建会话并在响应回传；业务失败 ok:false 携带 error/code（HTTP 仍 200）。
   */
  aiChat(req: { sessionId: string; message: string }): Promise<{
    ok: boolean; reply?: string; sessionId: string; error?: string; code?: string
    changes?: Array<{ tool: string; action: string; target: string }>
  }>
  /** 配对响应里的电脑名 */
  pcName(): string
}

interface RateBucket {
  windowStart: number
  count: number
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
  })
  res.end(JSON.stringify(payload))
}

function deny(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { ok: false, error: message })
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {})
      } catch {
        reject(new Error('bad json'))
      }
    })
    req.on('error', reject)
  })
}

export function createCompanionServer(deps: CompanionServerDeps): Server {
  const pairAttempts = new Map<string, RateBucket>()

  /** 已配对设备查令牌（内存缓存 + lastSeen 节流回写，避免每请求写盘） */
  const tokenIndex = new Map<string, CompanionDevice>()
  for (const d of deps.loadDevices()) tokenIndex.set(d.token, d)
  const flushLastSeen = (d: CompanionDevice): void => {
    const list = deps.loadDevices()
    const i = list.findIndex(x => x.deviceId === d.deviceId)
    if (i >= 0) {
      list[i] = { ...list[i], lastSeenAt: d.lastSeenAt }
      deps.saveDevices(list)
    }
  }

  function deviceByToken(req: IncomingMessage): CompanionDevice | null {
    const auth = req.headers.authorization || ''
    if (!auth.startsWith('Bearer ')) return null
    const provided = auth.slice(7).trim()
    for (const d of tokenIndex.values()) {
      if (tokenMatches(d.token, provided)) return d
    }
    return null
  }

  const server = createServer((req, res) => {
    const method = (req.method || 'GET').toUpperCase()
    const url = req.url || '/'
    const pathname = url.split('?')[0]

    // CORS 预检先于一切守卫（预检请求不带鉴权头）
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
      })
      res.end()
      return
    }

    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
    if (!isPrivateAddress(ip) && ip !== '127.0.0.1' && ip !== '::1') {
      deny(res, 403, '仅允许局域网设备访问')
      return
    }

    try {
      // ----- 配对（无需令牌）-----
      if (method === 'POST' && pathname === '/api/pair') {
        // 限频：10 次/分钟/IP
        const now = Date.now()
        const bucket = pairAttempts.get(ip)
        if (!bucket || now - bucket.windowStart > 60_000) {
          pairAttempts.set(ip, { windowStart: now, count: 1 })
        } else {
          bucket.count++
          if (bucket.count > PAIR_ATTEMPTS_PER_MIN) {
            deny(res, 429, '配对尝试过于频繁，稍后再试')
            return
          }
        }

        void (async () => {
          const body = await readJsonBody(req) as { code?: unknown; deviceName?: unknown }
          const pc = deps.getPairCode()
          if (!pc || now > pc.expiresAt) {
            deny(res, 401, '配对码不存在或已过期，请在电脑端重新出示')
            return
          }
          if (!tokenMatches(pc.code, String(body.code ?? ''))) {
            deny(res, 401, '配对码不正确')
            return
          }
          const name = String(body.deviceName ?? '').trim().slice(0, 40) || '手机'
          const device: CompanionDevice = {
            deviceId: randomUUID(),
            name,
            token: generateToken(),
            pairedAt: now,
            lastSeenAt: now,
          }
          const list = deps.loadDevices()
          list.push(device)
          deps.saveDevices(list)
          tokenIndex.set(device.token, device)
          deps.consumePairCode() // 一次配对即作废
          sendJson(res, 200, {
            ok: true,
            deviceToken: device.token,
            protocol: PROTOCOL_VERSION,
            pc: { name: deps.pcName() },
            domains: SYNC_DOMAINS,
          })
        })().catch(() => deny(res, 400, '请求体解析失败'))
        return
      }

      // ----- 以下端点需要设备令牌 -----
      const device = deviceByToken(req)
      if (!device) {
        deny(res, 401, '无效的设备令牌，请重新配对')
        return
      }
      if (Date.now() - device.lastSeenAt > 60_000) {
        device.lastSeenAt = Date.now()
        flushLastSeen(device)
      }

      if (method === 'GET' && pathname === '/api/ping') {
        sendJson(res, 200, { ok: true, protocol: PROTOCOL_VERSION, pc: { name: deps.pcName() } })
        return
      }

      // ----- v1.2 内容 API（电脑笔记 → 手机只读缓存）-----
      if (method === 'GET' && pathname === '/api/notes/tree') {
        sendJson(res, 200, { ok: true, generatedAt: Date.now(), pages: deps.listNoteTree() })
        return
      }
      if (method === 'GET' && pathname === '/api/notes/content') {
        // 按 id 服务端解析路径：客户端永不传路径，无目录穿越面
        const qId = new URL(url, 'http://local').searchParams.get('id') || ''
        const hit = qId ? deps.readNoteContent(qId) : null
        if (!hit) {
          deny(res, 404, '笔记不存在或不可读')
          return
        }
        sendJson(res, 200, { ok: true, id: qId, ...hit })
        return
      }

      if (method === 'POST' && pathname === '/api/sync/push') {
        void (async () => {
          const body = await readJsonBody(req) as { changes?: unknown }
          const changes = Array.isArray(body.changes) ? body.changes : []
          const results = changes.map(raw => {
            const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
            const id = String(c.id ?? '')
            const domain = String(c.domain ?? '') as SyncDomain
            const updatedAt = String(c.updatedAt ?? '')
            if (!id || !updatedAt) return { id, applied: false, reason: 'invalid-change' }
            if (!(SYNC_DOMAINS as readonly string[]).includes(domain)) {
              return { id, applied: false, reason: 'unsupported-domain' }
            }
            /** applied→ok；conflict→手机以服务端版本回写收敛；其余 reason 原样带回 */
            const toResult = (r: { applied: boolean; conflict?: boolean; reason?: string }) =>
              r.applied
                ? { id, applied: true }
                : { id, applied: false, ...(r.conflict ? { conflict: true } : {}), ...(r.reason ? { reason: r.reason } : {}) }
            try {
              // 墓碑（删除）优先判定：data = { deleted: true }
              if (isTombstoneData(c.data)) {
                return toResult(deps.applyDelete(domain, id, updatedAt))
              }
              if (domain === 'ledger') {
                const data = normalizeLedgerData(c.data)
                if (!data) return { id, applied: false, reason: 'invalid-data' }
                return toResult(deps.applyLedger({ id, updatedAt, data }))
              }
              if (domain === 'schedule') {
                const data = normalizeScheduleData(c.data)
                if (!data) return { id, applied: false, reason: 'invalid-data' }
                return toResult(deps.applySchedule({ id, updatedAt, data }))
              }
              if (domain === 'notes') {
                const data = normalizeNoteData(c.data)
                if (!data) return { id, applied: false, reason: 'invalid-data' }
                return toResult(deps.applyNote({ id, updatedAt, data }))
              }
              return { id, applied: false, reason: 'unsupported-domain' }
            } catch (e) {
              console.error('[companion] apply change failed', e)
              return { id, applied: false, reason: 'apply-error' }
            }
          })
          sendJson(res, 200, { ok: true, results, serverTime: Date.now() })
        })().catch(e => {
          console.error('[companion] push failed', e)
          deny(res, e instanceof Error && e.message === 'bad json' ? 400 : 500, e instanceof Error && e.message === 'body too large' ? '请求体过大' : '推送处理失败')
        })
        return
      }

      if (method === 'POST' && pathname === '/api/sync/pull') {
        void (async () => {
          const body = await readJsonBody(req) as { since?: Record<string, unknown> }
          const since = body.since && typeof body.since === 'object' ? body.since : {}
          const sinceLedger = Number(since.ledger ?? 0)
          const sinceSchedule = Number(since.schedule ?? 0)
          const valid = (n: number): boolean => Number.isFinite(n)
          // 墓碑游标 = 各域游标取最小（手机对收到的墓碑按 id 幂等应用，多收无害、少收有害）
          const sinceTs = Math.min(
            valid(sinceLedger) ? sinceLedger : 0,
            valid(sinceSchedule) ? sinceSchedule : 0,
          )
          const now = Date.now()
          const changes: Record<string, unknown> = {
            ledger: valid(sinceLedger) ? deps.listLedgerSince(sinceLedger) : [],
            schedule: valid(sinceSchedule) ? deps.listScheduleSince(sinceSchedule) : [],
          }
          sendJson(res, 200, {
            ok: true,
            changes,
            tombstones: deps.listTombstonesSince(sinceTs),
            cursor: { ledger: now, schedule: now },
          })
        })().catch(() => deny(res, 400, '请求体解析失败'))
        return
      }

      // ----- v1.3 电脑档：对话中继到桌面 agentService -----
      if (method === 'POST' && pathname === '/api/ai/chat') {
        void (async () => {
          const body = await readJsonBody(req) as { sessionId?: unknown; message?: unknown }
          const message = String(body.message ?? '').trim()
          if (!message) {
            deny(res, 400, '消息不能为空')
            return
          }
          // 业务失败（无供应商/中断等）以 ok:false + error 返回，HTTP 仍 200 —— 传输失败才 5xx
          const r = await deps.aiChat({ sessionId: String(body.sessionId ?? ''), message })
          sendJson(res, 200, r)
        })().catch(e => {
          console.error('[companion] ai chat failed', e)
          deny(res, e instanceof Error && e.message === 'bad json' ? 400 : 500, 'AI 中继失败')
        })
        return
      }

      deny(res, 404, '接口不存在')
    } catch (e) {
      console.error('[companion] request error', e)
      deny(res, 500, '内部错误')
    }
  })

  return server
}
