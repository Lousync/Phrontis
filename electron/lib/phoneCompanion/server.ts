import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { createReadStream } from 'fs'
import { randomUUID, randomInt } from 'crypto'
import {
  MAX_BODY_BYTES, PAIR_ATTEMPTS_PER_MIN, PAIR_CODE_TTL_MS, PROTOCOL_VERSION, PULL_WAIT_CAP_MS, SYNC_DOMAINS,
  COMPANION_FEATURES,
  normalizeLedgerData, normalizeScheduleData, normalizeNoteData, normalizeHabitData, normalizeHabitRecordData, isTombstoneData, pairingCapabilities,
  type LedgerItemData, type ScheduleItemData, type NoteItemData, type HabitSyncData, type SyncDomain,
} from './protocol.ts'
import type { HandoffPdfEntry, UploadedPdfInfo } from './fileTransfer.ts'
import { isPrivateAddress, generateToken, tokenMatches } from '../lanShare/auth.ts'

/* 相对导入显式带 .ts：契约脚本以 node --experimental-strip-types 直跑本文件（零 electron 依赖）。 */

/**
 * 手机伴侣 HTTP 服务（Node 原生实现，零 electron 依赖 —— 依赖全部注入，契约脚本可直接驱动）。
 *
 * 路由：
 *   OPTIONS *            CORS 预检（手机 WebView 与本服务不同源）
 *   GET  /api/discover   发现：本机电脑名 + 协议版本（无令牌，供手机扫段识别）
 *   POST /api/pair       配对（旧路）：配对码换长期设备令牌（无需令牌）
 *   POST /api/pair/request 配对（新路 v1.5）：手机发起 → 桌面确认框 → 双屏 4 位码核对
 *   GET  /api/pair/status  新路查询：pending / approved（回令牌）/ rejected / expired
 *   GET  /api/ping       存活探测（带令牌）
 *   POST /api/unpair     双向解除（带令牌；手机侧解除配对 best-effort 调用，design.md §2.2）
 *   POST /api/sync/push  手机上行变更（域级 LWW 合并）
 *   POST /api/sync/pull  手机拉取服务端变更
 *   GET  /api/files/tree     文件通道 v1：vault 内可交接的 PDF（只读，design.md §2.3）
 *   GET  /api/files/content  文件通道 v1：按知识索引 id 流式下载 PDF
 *   POST /api/files/upload   文件通道 v1：iPad 批注回传（只落 iPad 批注/ 副本，永不覆盖）
 *
 * 安全：来源 IP 限私有网段（127.0.0.1 供本机测试）+ 设备令牌 Bearer + 配对码限频。
 * 新路的安全边界是「桌面确认框」——服务常驻时陌生人扫到也无令牌可拿，必须本人在电脑上点允许。
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

/** v1.5 配对握手：一条待确认请求（桌面确认框据此渲染；令牌只在 approved 后回给手机） */
export interface CompanionPairRequestView {
  requestId: string
  /** 4 位数字：手机与电脑同屏核对，防「同网陌生人趁乱点允许」 */
  code: string
  deviceName: string
  ip: string
  createdAt: number
  expiresAt: number
}

export type PairRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface CompanionServerDeps {
  /** 已配对设备持久层（生产 = userData JSON；契约脚本 = 内存） */
  loadDevices(): CompanionDevice[]
  saveDevices(list: CompanionDevice[]): void
  /**
   * 当前是否打开了仓库（2026-11-09 实锤：无仓时 pull 返回空数组 + cursor=now，
   * 手机把游标推到现在后，之后开仓也永远拉不到更旧的条目；push 写盘失败还会被手机出队）。
   * fail-closed：无仓时 pull 直接拒绝（不带 cursor）、push 逐条回 reason:'no-vault'。
   */
  hasVault(): boolean
  /** 当前配对码（null = 未出示）；服务端只读，作废走 consumePairCode */
  getPairCode(): CompanionPairCode | null
  consumePairCode(): void
  /**
   * v1.5 配对握手：手机发起请求时回调（生产 = 推给渲染层弹确认框并留出手柄；契约脚本 = 内存记录）。
   * approve / reject 由 UI 侧调用；设备创建与令牌发放留在服务内部（tokenIndex 是闭包状态，外部改不到）。
   */
  onPairRequest?(view: CompanionPairRequestView, handlers: {
    approve(): { ok: boolean; error?: string }
    reject(): { ok: boolean; error?: string }
  }): void
  /** ledger 域写入（生产 = vaultAccountingSyncUpsert；已含 LWW，返回 conflict 即服务端更新） */
  applyLedger(item: { id: string; updatedAt: string; data: LedgerItemData }): { applied: boolean; conflict?: boolean; reason?: string }
  /** schedule 域写入（生产 = vaultScheduleSyncUpsert；同一条 LWW 时线） */
  applySchedule(item: { id: string; updatedAt: string; data: ScheduleItemData }): { applied: boolean; conflict?: boolean; reason?: string }
  /** notes 域写入（v1.6 LWW 裁决：incoming 严格更新才 applied；否则 conflict，手机以服务端版本收敛） */
  applyNote(item: { deviceId: string; deviceName: string; id: string; updatedAt: string; data: NoteItemData }): { applied: boolean; conflict?: boolean; reason?: string }
  /** v1.8 habit 域写入：习惯定义与打卡记录共用（按 data.kind 分派；已含 LWW） */
  applyHabit(item: { id: string; updatedAt: string; data: HabitSyncData }): { applied: boolean; conflict?: boolean; reason?: string }
  /** 删除同步（v1.1 墓碑）：手机上行 `data:{deleted:true}` 的变更。
   * 生产 = 查现行行做 LWW（删除比行 updatedAt 旧 → conflict 拒删）→ 删行（repo 内部 emit 墓碑）
   * → 无行时直接记墓碑（幂等）。
   */
  applyDelete(domain: SyncDomain, id: string, deletedAt: string): { applied: boolean; conflict?: boolean; reason?: string }
  /** ledger 域读取：updatedAt > sinceMs 的条目 */
  listLedgerSince(sinceMs: number): Array<{ id: string; updatedAt: string; data: LedgerItemData }>
  /** schedule 域读取：updatedAt > sinceMs 的条目（含子任务行） */
  listScheduleSince(sinceMs: number): Array<{ id: string; updatedAt: string; data: ScheduleItemData }>
  /** v1.8 habit 域读取：习惯定义 + 打卡记录（updatedAt > sinceMs） */
  listHabitChangesSince(sinceMs: number): Array<{ id: string; updatedAt: string; data: HabitSyncData }>
  /**
   * v1.6 笔记 U 盘模式下行：该设备文件夹内桌面侧的增改（§4.2/§4.3）。
   * sinceMs ≤ 0 = 全量（冲突后重对 / 旧手机）；实现在生产 = 扫描设备文件夹 + 更新 notesState。
   * 桌面侧发现的删除不从这里回：走 vaultRecordTombstones('notes') → listTombstonesSince。
   */
  listNotesSince(device: { deviceId: string; deviceName: string }, sinceMs: number): Array<{ id: string; updatedAt: string; data: NoteItemData }>
  /** 全域墓碑：deletedAt > sinceMs（手机按 domain 分派 + 幂等应用） */
  listTombstonesSince(sinceMs: number): Array<{ domain: string; id: string; deletedAt: string }>
  /** v1.2 内容 API：doc 类页面平表（排除欢迎页与 file 条目；手机按 path 自行建目录树） */
  listNoteTree(): Array<{ id: string; title: string; path: string; categoryId: string | null; mtimeMs: number; sizeBytes: number }>
  /** v1.2 内容 API：按 id 读正文（服务端解析路径；找不到/不可读返回 null → 404） */
  readNoteContent(id: string): { title: string; updatedAt: string; body: string; truncated?: boolean } | null
  /**
   * v1.9 文件通道 v1：vault 内可交接的 PDF（知识索引过滤；无仓 / 空 vault 返回 []）。
   * 与 notes 域分开：`entryKind:'file'` 的 PDF 不进「电脑笔记」树。
   */
  listPdfFiles(): HandoffPdfEntry[]
  /**
   * v1.9 文件通道 v1：按知识索引 id 解析 PDF。
   * 不存在 / 不是 PDF → 404；路径越界 / 符号链接逃逸 → 403。
   */
  openPdfFile(id: string): { ok: true; absPath: string; name: string; size: number } | { ok: false; status: 403 | 404 }
  /**
   * v1.9 文件通道 v1：流式接收 multipart，只写 `<vault>/iPad 批注/`。
   * 失败时临时文件已清理；状态码由实现给出（400 / 409 / 413 / 415 / 500）。
   */
  savePdfUpload(req: IncomingMessage): Promise<{ ok: true; file: UploadedPdfInfo } | { ok: false; status: number; error: string }>
  /** 配对响应里的电脑名 */
  pcName(): string
  /** 配对链路修复 WP1：手机请求来源 IP 上报（生产 = 更新 lastClientIp 供地址推荐同 /24 优先；discover/pair/request/ping 三处） */
  onClientSeen?(ip: string): void
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

/** v1.7：返回值在裸 Server 上挂两个唤醒入口（侵入最小——契约脚本与 stop() 的 close 语义不变） */
export type CompanionServer = Server & {
  /** 唤醒全部挂起 pull（粗粒度信号：任何同步域动了都调它，醒来后各自重扫，不做分域过滤） */
  pokeSync(): void
  /** 当前有挂起 pull 的 deviceId 列表（状态展示用） */
  pendingPullDeviceIds(): string[]
  /** 配对链路修复：面板删除设备时立即失效内存令牌（否则运行中 revoke 只删了文件，tokenIndex 还认旧 token，手机永远等不来 401） */
  revokeDevice(deviceId: string): boolean
}

export function createCompanionServer(deps: CompanionServerDeps): CompanionServer {
  const pairAttempts = new Map<string, RateBucket>()

  /* ---------- v1.7 长轮询：挂起 pull 注册表（per-device 顶掉语义） ---------- */
  /** deviceId → resolver；调用即放行对应挂起请求（响应在其后现扫当前状态） */
  const pendingPulls = new Map<string, () => void>()
  const pokeSync = (): void => {
    // 拷贝后再放行：done() 会从表里摘自己，直接迭代会在中途遇变更
    for (const release of [...pendingPulls.values()]) release()
  }

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

  /* ---------- v1.5 配对握手：待确认请求（进程内，3 分钟过期） ---------- */
  const PAIR_REQUEST_TTL_MS = 3 * 60_000
  interface PendingPair extends CompanionPairRequestView {
    status: 'pending' | 'approved' | 'rejected'
    deviceToken?: string
  }
  const pendingPairs = new Map<string, PendingPair>()

  function purgePending(): void {
    const now = Date.now()
    for (const [id, p] of pendingPairs) if (now > p.expiresAt + 60_000) pendingPairs.delete(id)
  }

  /** 配对限频：10 次/分钟/IP（旧路 /api/pair 与新路 /api/pair/request 共用同一桶） */
  function allowPairAttempt(ip: string): boolean {
    const now = Date.now()
    const bucket = pairAttempts.get(ip)
    if (!bucket || now - bucket.windowStart > 60_000) {
      pairAttempts.set(ip, { windowStart: now, count: 1 })
      return true
    }
    bucket.count++
    return bucket.count <= PAIR_ATTEMPTS_PER_MIN
  }

  /** 发一张新令牌并落库（旧路 /api/pair 与新路 approve 共用，tokenIndex 必须同步） */
  function issueDevice(name: string): CompanionDevice {
    const now = Date.now()
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
    return device
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
      // ----- 发现（无需令牌；供手机扫段识别本机，只回电脑名）-----
      if (method === 'GET' && pathname === '/api/discover') {
        deps.onClientSeen?.(ip)
        sendJson(res, 200, {
          ok: true,
          protocol: PROTOCOL_VERSION,
          pc: { name: deps.pcName() },
          pairing: pairingCapabilities(!!deps.onPairRequest),
        })
        return
      }

      // ----- 配对握手 v1.5（无需令牌）-----
      if (method === 'POST' && pathname === '/api/pair/request') {
        deps.onClientSeen?.(ip)
        const onPairRequest = deps.onPairRequest
        if (!onPairRequest) {
          deny(res, 501, '电脑端未开启配对确认，请走配对码')
          return
        }
        if (!allowPairAttempt(ip)) {
          deny(res, 429, '配对尝试过于频繁，稍后再试')
          return
        }
        void (async () => {
          const body = await readJsonBody(req) as { deviceName?: unknown }
          purgePending()
          const now = Date.now()
          const view: CompanionPairRequestView = {
            requestId: randomUUID(),
            code: String(randomInt(0, 10000)).padStart(4, '0'),
            deviceName: String(body.deviceName ?? '').trim().slice(0, 40) || '手机',
            ip,
            createdAt: now,
            expiresAt: now + PAIR_REQUEST_TTL_MS,
          }
          const pending: PendingPair = { ...view, status: 'pending' }
          pendingPairs.set(view.requestId, pending)
          onPairRequest(view, {
            approve: () => {
              if (pending.status !== 'pending') return { ok: false, error: '请求已处理' }
              if (Date.now() > pending.expiresAt) return { ok: false, error: '请求已过期' }
              const device = issueDevice(pending.deviceName)
              pending.status = 'approved'
              pending.deviceToken = device.token
              return { ok: true }
            },
            reject: () => {
              if (pending.status !== 'pending') return { ok: false, error: '请求已处理' }
              pending.status = 'rejected'
              return { ok: true }
            },
          })
          sendJson(res, 200, { ok: true, requestId: view.requestId, code: view.code, expiresAt: view.expiresAt })
        })().catch(() => deny(res, 400, '请求体解析失败'))
        return
      }

      if (method === 'GET' && pathname === '/api/pair/status') {
        purgePending()
        const q = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '')
        const pending = pendingPairs.get(q.get('id') || '')
        if (!pending) {
          deny(res, 404, '配对请求不存在或已过期')
          return
        }
        const expired = pending.status === 'pending' && Date.now() > pending.expiresAt
        sendJson(res, 200, {
          ok: true,
          status: expired ? 'expired' : pending.status,
          ...(pending.status === 'approved' && pending.deviceToken
            ? {
                deviceToken: pending.deviceToken,
                protocol: PROTOCOL_VERSION,
                pc: { name: deps.pcName() },
                domains: SYNC_DOMAINS,
              }
            : {}),
        })
        return
      }

      // ----- 配对（无需令牌）-----
      if (method === 'POST' && pathname === '/api/pair') {
        if (!allowPairAttempt(ip)) {
          deny(res, 429, '配对尝试过于频繁，稍后再试')
          return
        }
        const now = Date.now()

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
          const device = issueDevice(name)
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
        deps.onClientSeen?.(ip)
        sendJson(res, 200, {
          ok: true,
          protocol: PROTOCOL_VERSION,
          pc: { name: deps.pcName() },
          // v1.9 能力位：旧手机忽略；新手机在旧桌面（无此字段）时隐藏文件区，零破坏
          features: [...COMPANION_FEATURES],
        })
        return
      }

      // ----- 双向解除（2026-11-08，design.md §2.2）：手机侧解除配对时 best-effort 调用，
      // 桌面即时注销令牌 + 移除设备表；notesStates 保留（重配对新 deviceId 重建）。 -----
      if (method === 'POST' && pathname === '/api/unpair') {
        const list = deps.loadDevices().filter(d => d.deviceId !== device.deviceId)
        deps.saveDevices(list)
        for (const [tok, d] of tokenIndex) {
          if (d.deviceId === device.deviceId) tokenIndex.delete(tok)
        }
        sendJson(res, 200, { ok: true })
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

      // ----- v1.9 文件通道 v1（iPad 交接 / 批注回传，design.md §2.3）-----
      // 只读清单 + 按 id 下载；客户端永不传路径，服务端经知识索引解析后过 safePathInside。
      if (method === 'GET' && pathname === '/api/files/tree') {
        sendJson(res, 200, { ok: true, generatedAt: Date.now(), files: deps.listPdfFiles() })
        return
      }
      if (method === 'GET' && pathname === '/api/files/content') {
        const qId = new URL(url, 'http://local').searchParams.get('id') || ''
        const hit = qId ? deps.openPdfFile(qId) : null
        if (!hit) {
          deny(res, 404, '文件不存在或不是 PDF')
          return
        }
        if (!hit.ok) {
          deny(res, hit.status, hit.status === 403 ? '路径越界' : '文件不存在或不是 PDF')
          return
        }
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'content-length': hit.size,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(hit.name)}`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'access-control-allow-origin': '*',
        })
        const stream = createReadStream(hit.absPath)
        // 客户端断开（手机切后台 / 取消下载）：及时释放 fd，别把服务拖死
        res.on('close', () => { if (!res.writableEnded) stream.destroy() })
        stream.on('error', () => res.destroy())
        stream.pipe(res)
        return
      }
      if (method === 'POST' && pathname === '/api/files/upload') {
        const ct = String(req.headers['content-type'] || '')
        if (!/^multipart\/form-data/i.test(ct)) {
          deny(res, 400, '需要 multipart/form-data')
          return
        }
        // 无仓 fail-closed：回传必须落到具体 vault 的 iPad 批注/
        if (!deps.hasVault()) {
          deny(res, 409, '电脑端尚未打开仓库')
          return
        }
        void deps.savePdfUpload(req)
          .then(r => {
            if (res.writableEnded || res.destroyed) return
            if (!r.ok) {
              deny(res, r.status, r.error)
              return
            }
            sendJson(res, 200, { ok: true, file: r.file })
          })
          .catch(e => {
            console.error('[companion] file upload failed', e)
            if (!res.writableEnded && !res.destroyed) deny(res, 500, '上传处理失败')
          })
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
            // 无仓 fail-closed：不应用、不出队（手机 RETRYABLE_PUSH_REASONS 会保留这条）
            if (!deps.hasVault()) return { id, applied: false, reason: 'no-vault' }
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
              if (domain === 'habit') {
                const kind = c.data && typeof c.data === 'object' ? (c.data as Record<string, unknown>).kind : ''
                if (kind === 'habit') {
                  const data = normalizeHabitData(c.data)
                  if (!data) return { id, applied: false, reason: 'invalid-data' }
                  return toResult(deps.applyHabit({ id, updatedAt, data }))
                }
                if (kind === 'record') {
                  const data = normalizeHabitRecordData(c.data)
                  if (!data) return { id, applied: false, reason: 'invalid-data' }
                  return toResult(deps.applyHabit({ id, updatedAt, data }))
                }
                return { id, applied: false, reason: 'invalid-data' }
              }
              if (domain === 'notes') {
                const data = normalizeNoteData(c.data)
                if (!data) return { id, applied: false, reason: 'invalid-data' }
                return toResult(deps.applyNote({ deviceId: device.deviceId, deviceName: device.name, id, updatedAt, data }))
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
          // 无仓 fail-closed：绝不能返回空 changes + cursor=now（手机推游标后旧数据永久拉不回）
          if (!deps.hasVault()) { deny(res, 409, '电脑端尚未打开仓库'); return }
          const body = await readJsonBody(req) as { since?: Record<string, unknown>; wait?: unknown }
          const since = body.since && typeof body.since === 'object' ? body.since : {}
          const sinceLedger = Number(since.ledger ?? 0)
          const sinceSchedule = Number(since.schedule ?? 0)
          // v1.6：旧手机不传 since.notes → 缺省 0 = 全量 notes（兼容矩阵 §4.2）
          const sinceNotesRaw = since.notes
          const sinceNotes = sinceNotesRaw === undefined ? 0 : Number(sinceNotesRaw)
          // v1.8：旧手机不传 since.habit → 不返回 habit 变更、也不让 habit 游标影响墓碑过滤（零影响）
          const sinceHabitRaw = since.habit
          const hasHabitSince = sinceHabitRaw !== undefined
          const sinceHabit = hasHabitSince ? Number(sinceHabitRaw) : 0
          const valid = (n: number): boolean => Number.isFinite(n)
          // 墓碑游标 = 各域游标取最小（手机对收到的墓碑按 id 幂等应用，多收无害、少收有害）
          const sinceTs = Math.min(
            valid(sinceLedger) ? sinceLedger : 0,
            valid(sinceSchedule) ? sinceSchedule : 0,
            valid(sinceNotes) ? sinceNotes : 0,
            hasHabitSince && valid(sinceHabit) ? sinceHabit : Number.POSITIVE_INFINITY,
          )

          // v1.7 长轮询：wait 缺省/0/非法 = 旧行为立即返回（响应不带 waitSupported，手机据此探测旧桌面）
          const waitRaw = Number(body.wait)
          const waitMs = Number.isFinite(waitRaw) && waitRaw > 0 ? Math.min(Math.round(waitRaw), PULL_WAIT_CAP_MS) : 0
          if (waitMs > 0) {
            const preempted = pendingPulls.get(device.deviceId)
            if (preempted) preempted() // 同设备第二个 pull 顶掉第一个：旧请求立即以当前状态返回
            const disconnected = await new Promise<boolean>(resolve => {
              let settled = false
              const finish = (wasDisconnected: boolean): void => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                res.removeListener('close', onClose)
                if (pendingPulls.get(device.deviceId) === release) pendingPulls.delete(device.deviceId)
                resolve(wasDisconnected)
              }
              const release = (): void => finish(false)
              // 客户端断连（手机切后台 / 网络切换）：清理注册表，响应放弃
              const onClose = (): void => finish(true)
              const timer = setTimeout(() => finish(false), waitMs)
              res.on('close', onClose)
              pendingPulls.set(device.deviceId, release)
            })
            if (disconnected) return // 连接已死，不再写响应
          }

          // 挂起醒来后现扫（信号是通知不是数据）：返回什么由 since 过滤决定，可能为空数组
          const now = Date.now()
          const changes: Record<string, unknown> = {
            ledger: valid(sinceLedger) ? deps.listLedgerSince(sinceLedger) : [],
            schedule: valid(sinceSchedule) ? deps.listScheduleSince(sinceSchedule) : [],
            notes: valid(sinceNotes) ? deps.listNotesSince({ deviceId: device.deviceId, deviceName: device.name }, sinceNotes) : [],
            habit: hasHabitSince && valid(sinceHabit) ? deps.listHabitChangesSince(sinceHabit) : [],
          }
          sendJson(res, 200, {
            ok: true,
            changes,
            tombstones: deps.listTombstonesSince(sinceTs),
            cursor: { ledger: now, schedule: now, notes: now, habit: now },
            ...(waitMs > 0 ? { waitSupported: true } : {}),
          })
        })().catch(() => deny(res, 400, '请求体解析失败'))
        return
      }

      deny(res, 404, '接口不存在')
    } catch (e) {
      console.error('[companion] request error', e)
      deny(res, 500, '内部错误')
    }
  })

  // v1.7：唤醒入口挂在 Server 对象上（侵入最小，close/closeAllConnections 语义不变）
  const companion = server as CompanionServer
  companion.pokeSync = pokeSync
  companion.pendingPullDeviceIds = () => [...pendingPulls.keys()]
  companion.revokeDevice = (deviceId: string): boolean => {
    let hit = false
    for (const [tok, d] of tokenIndex) {
      if (d.deviceId === deviceId) {
        tokenIndex.delete(tok)
        hit = true
      }
    }
    return hit
  }
  return companion
}
