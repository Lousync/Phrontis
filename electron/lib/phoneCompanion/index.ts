import { app, ipcMain } from 'electron'
import { randomInt } from 'crypto'
import { hostname } from 'os'
import { createCompanionServer, type CompanionPairCode, type CompanionPairRequestView, type CompanionServer, type CompanionServerDeps } from './server'
import { DEFAULT_PORT, PAIR_CODE_TTL_MS, shouldApplyIncoming, pairingCapabilities, type ScheduleItemData } from './protocol'
import { startDiscoverResponder, stopDiscoverResponder } from './discover'
import { generateToken } from '../lanShare/auth'
import { getLanAddressCandidates, defaultRouteIp } from '../lanShare/addresses'
import { buildStatusView, type CompanionAddressInfo } from './statusView'
import { toQrDataUrl } from '../lanShare/qr'
import { loadPairedDevices, savePairedDevices } from './devices'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  vaultAccountingSyncUpsert, vaultAccountingTransactionsAll, vaultAccountingDelete,
  type TransactionRow,
} from 'phrontis-core/kbStore/accountingVaultRepo'
import {
  vaultScheduleSyncUpsert, vaultTodosAll, vaultFindTodo, vaultDeleteTodoCascade,
  type TodoRow,
} from 'phrontis-core/kbStore/scheduleVaultRepo'
import { vaultRecordTombstones, vaultTombstonesSince } from 'phrontis-core/kbStore/tombstoneVaultRepo'
import { setVaultDeleteSink } from 'phrontis-core/kbStore/deleteSink'
import { getKnowledgeIndex, findKnowledgePage } from 'phrontis-core/kbStore/knowledgeIndex'
import { getCurrentVault } from 'phrontis-core/kbStore/vaultContext'
import { parseMarkdown } from 'phrontis-core/kbStore/mdStore'
import { broadcastDataChanged, broadcast, subscribeDataChanged } from '../../main/windowBus'
import { applyNoteUsb, applyDeleteNoteUsb, listNotesSinceUsb } from './notesVault'
import { isMobileNotesRel } from './notesUsb'

/**
 * 手机伴侣（工具箱）：局域网常驻同步服务，lanShare 的演化线。
 *
 * 与设备传输（lanShare）的差异：
 *  - 长期配对（配对码换长期令牌，两端互存）vs 一次性 token
 *  - 常驻（无 15 分钟自动关闭）vs 用完即走
 *  - 域级同步端点（写 vault 走 kbStore 业务函数 + broadcast）vs 文件互传
 * 协议冻结口径：E:\Projects\Phrontis-mobile\docs\design.md §2.1。
 */

const MAX_PORT_TRIES = 20
/** 首选端口 8770 被占时的延迟重试：dev HMR 重启竞态下旧实例退净需要一两秒——立即回退会让服务
 *  永久漂离冻结默认端口，占用者退出后也不回搬；手机扫段只探 8770/8771、防火墙放行规则都跟着失配
 *  （2026-11-08 实测：伴侣静默漂到 8771，手机配对失联，是「多轮改代码仍配不上」的根源之一）。 */
const PREFERRED_PORT_RETRIES = 8
const PREFERRED_RETRY_GAP_MS = 500

interface PendingPairEntry {
  view: CompanionPairRequestView
  approve(): { ok: boolean; error?: string }
  reject(): { ok: boolean; error?: string }
}

interface ServiceState {
  server: CompanionServer | null
  port: number
  pairCode: CompanionPairCode | null
  /** v1.5 待确认配对请求（渲染层轮询 status 时渲染确认框） */
  pendingPairs: PendingPairEntry[]
  /** v1.7 数据变更订阅退订手柄（stop 时退订，避免悬挂闭包） */
  unsubDataChanged: (() => void) | null
}

let state: ServiceState = { server: null, port: 0, pairCode: null, pendingPairs: [], unsubDataChanged: null }

/** WP1 地址推荐：最近一次手机请求来源 IP（discover / pair/request / ping 上报）——
 *  与本机某地址同 /24 ⇒ 手机几乎必然可达该地址，推荐位排第一（热点场景手机来源是 192.168.43.1）。 */
let lastClientIp: string | undefined
/** WP1：默认路由出口 IP 缓存——UDP connect 异步取得，status() 是同步函数只能读缓存；
 *  start 时起 30s 自愈轮询（Wi-Fi 漫游 / 热点重连换网后跟着更新），stop 时清。 */
let defaultIpCache: string | undefined
let defaultIpTimer: ReturnType<typeof setInterval> | null = null

async function refreshDefaultIp(): Promise<void> {
  try {
    defaultIpCache = await defaultRouteIp()
  } catch { /* 保持旧值：默认路由只是第二优先级，拿不到不致命 */ }
}

function startDefaultIpPolling(): void {
  void refreshDefaultIp()
  if (!defaultIpTimer) {
    defaultIpTimer = setInterval(() => void refreshDefaultIp(), 30_000)
    defaultIpTimer.unref?.()
  }
}

function stopDefaultIpPolling(): void {
  if (defaultIpTimer) {
    clearInterval(defaultIpTimer)
    defaultIpTimer = null
  }
}

export interface CompanionStatus {
  running: boolean
  port: number
  /** 配对链接（含 #配对码），按推荐顺序；无有效配对码时 hash 为空——绝不嵌过期码（WP7） */
  urls: string[]
  /** WP1：推荐地址的配对链接（= urls[0]，二维码 / 默认选中用；语义显式化避免调用方各猜 urls[0]） */
  recommendedUrl: string
  /** WP1：地址明细（接口名 / 虚拟网卡标记 / 推荐标记），面板「手机可访问的地址」列表数据源 */
  addresses: CompanionAddressInfo[]
  /** 8 位配对码，10 分钟有效、一次配对即作废；过期/未运行为空串 */
  pairCode: string
  pairCodeExpiresAt: number
  devices: Array<{ deviceId: string; name: string; pairedAt: number; lastSeenAt: number }>
  /** v1.5：手机发起的待确认配对请求（确认框数据源；过期项被 status 就地过滤） */
  pendingPairs: CompanionPairRequestView[]
}

function newPairCode(): CompanionPairCode {
  return { code: String(randomInt(0, 1e8)).padStart(8, '0'), expiresAt: Date.now() + PAIR_CODE_TTL_MS }
}

function status(): CompanionStatus {
  const running = !!state.server
  const now = Date.now()
  // WP7 10.3：过期待确认请求就地清理——服务端 purgePending 只清自己的 Map，这份 state 不清会永久挂面板
  state.pendingPairs = state.pendingPairs.filter(p => p.view.expiresAt > now)
  const view = buildStatusView({
    running,
    port: state.port,
    candidates: getLanAddressCandidates(),
    pairCode: running ? state.pairCode : null,
    pendingPairs: state.pendingPairs.map(p => p.view),
    defaultIp: defaultIpCache,
    clientIp: lastClientIp,
    now,
  })
  return {
    running,
    port: running ? state.port : 0,
    urls: view.urls,
    recommendedUrl: view.recommendedUrl,
    addresses: view.addresses,
    pairCode: view.pairCode,
    pairCodeExpiresAt: view.pairCodeExpiresAt,
    devices: loadPairedDevices().map(({ deviceId, name, pairedAt, lastSeenAt }) => ({ deviceId, name, pairedAt, lastSeenAt })),
    pendingPairs: view.pendingPairs,
  }
}

/**
 * v1.5 配对确认：渲染层点「允许 / 拒绝」→ 这里执行服务内闭包（设备创建与令牌发放都在服务内部）。
 * 处理完从待确认列表移除并广播，渲染层下一次轮询即消失。
 */
function resolvePairRequest(
  requestId: string,
  action: 'approve' | 'reject',
): { ok: boolean; error?: string; status: CompanionStatus } {
  const i = state.pendingPairs.findIndex(p => p.view.requestId === requestId)
  if (i < 0) return { ok: false, error: '请求不存在或已过期', status: status() }
  const entry = state.pendingPairs[i]
  const r = action === 'approve' ? entry.approve() : entry.reject()
  if (!r.ok) {
    // WP7 10.3：处理失败（已过期 / 已处理）的请求同样是死请求，一并移除——别让它永久挂在面板
    state.pendingPairs.splice(i, 1)
    return { ok: false, error: r.error, status: status() }
  }
  state.pendingPairs.splice(i, 1)
  broadcast('companion:pairChanged', { requestId, approved: action === 'approve' })
  return { ok: true, status: status() }
}

export async function start(opts?: { port?: number }): Promise<CompanionStatus> {
  if (state.server) return status()
  const port = opts?.port && opts.port > 0 && opts.port < 65536 ? opts.port : DEFAULT_PORT

  const deps: CompanionServerDeps = {
    loadDevices: loadPairedDevices,
    saveDevices: savePairedDevices,
    getPairCode: () => state.pairCode,
    consumePairCode: () => { state.pairCode = null },
    /* v1.5 配对握手：手机发请求 → 留出手柄并推给渲染层确认框（渲染层轮询 status 取 pendingPairs） */
    onPairRequest: (view, handlers) => {
      state.pendingPairs.push({ view, approve: handlers.approve, reject: handlers.reject })
      broadcast('companion:pairRequest', view)
    },
    /* WP1：手机来源 IP 上报（discover / pair/request / ping 三处），地址推荐同 /24 优先用 */
    onClientSeen: ip => { lastClientIp = ip },
    applyLedger: item => {
      const r = vaultAccountingSyncUpsert({
        id: item.id, updatedAt: item.updatedAt,
        date: item.data.date, time: item.data.time, type: item.data.type, amount: item.data.amount,
        category: item.data.category, payment: item.data.payment, merchant: item.data.merchant, note: item.data.note,
      })
      // 铁律 1：主进程写盘后必须广播（手机上行改了 vault，桌面账本窗口要刷新）
      if (r.applied) broadcastDataChanged('accounting')
      return r
    },
    applySchedule: item => {
      const r = vaultScheduleSyncUpsert({
        id: item.id, updatedAt: item.updatedAt,
        date: item.data.date, title: item.data.title, type: item.data.type, time: item.data.time,
        done: item.data.done, parentId: item.data.parentId,
        schedStart: item.data.schedStart, schedEnd: item.data.schedEnd,
      })
      if (r.applied) broadcastDataChanged('schedule')
      return r
    },
    applyDelete: (domain, id, deletedAt) => {
      // v1.6 笔记 U 盘模式：手机清空标题保存 = 墓碑删除 → 删设备文件夹内文件 + 记墓碑
      if (domain === 'notes') return applyDeleteNoteUsb(id, deletedAt)
      if (domain === 'schedule') {
        const row = vaultFindTodo(id)
        if (!row) {
          // 行不在：可能早已删除。记墓碑幂等收敛（重复上行删除是正常路径）
          vaultRecordTombstones('schedule', [id], deletedAt)
          return { applied: true }
        }
        if (!shouldApplyIncoming(row.updated_at, deletedAt)) {
          return { applied: false, conflict: true, reason: 'server-newer' }
        }
        vaultDeleteTodoCascade(id) // repo 内部 emit → 记墓碑（含级联子任务）
        broadcastDataChanged('schedule')
        return { applied: true }
      }
      if (domain === 'ledger') {
        const row = vaultAccountingTransactionsAll().find(r => r.id === id)
        if (!row) {
          vaultRecordTombstones('ledger', [id], deletedAt)
          return { applied: true }
        }
        if (!shouldApplyIncoming(row.updatedAt, deletedAt)) {
          return { applied: false, conflict: true, reason: 'server-newer' }
        }
        vaultAccountingDelete(id)
        broadcastDataChanged('accounting')
        return { applied: true }
      }
      return { applied: false, reason: 'unsupported-domain' }
    },
    applyNote: item => {
      // v1.6 笔记 U 盘模式：LWW 裁决 + 落设备文件夹（取代 v1.2 收件箱无条件应用）
      return applyNoteUsb(item)
    },
    listNotesSince: (device, sinceMs) => {
      const items = listNotesSinceUsb(device, sinceMs)
      // v1.7：扫描发现桌面侧变更 → 其他设备的挂起 pull 也要醒（本请求已在响应中，自己收不到自己的 poke）
      if (items.length > 0) state.server?.pokeSync()
      return items
    },
    listNoteTree: () => getKnowledgeIndex().pages
      // 只给 doc（md）；欢迎页是合成条目且 HTML 手机渲染不了；file 条目（导图/归档）同样排除；
      // v1.6：移动端/** 是手机笔记 U 盘子树，不进「电脑笔记只读」域（两棵树互不掺和，§4.4）
      .filter(p => p.entryKind !== 'file' && p.id !== 'kb-welcome-doc' && !isMobileNotesRel(p.path))
      .map(p => ({ id: p.id, title: p.title, path: p.path, categoryId: p.categoryId, mtimeMs: p.mtimeMs, sizeBytes: p.sizeBytes ?? 0 })),
    readNoteContent: id => {
      const entry = findKnowledgePage(id)
      if (!entry || entry.entryKind === 'file' || isMobileNotesRel(entry.path)) return null
      const root = getCurrentVault()?.rootPath
      if (!root) return null
      try {
        const doc = parseMarkdown(readFileSync(join(root, entry.path), 'utf-8'))
        // 正文上限 30 万字符（约 900KB UTF-8），超出截断并带 truncated 标记
        const truncated = doc.body.length > 300_000
        return {
          title: entry.title,
          updatedAt: new Date(entry.mtimeMs).toISOString(),
          body: truncated ? doc.body.slice(0, 300_000) : doc.body,
          truncated: truncated || undefined,
        }
      } catch {
        return null
      }
    },
    listLedgerSince: sinceMs => vaultAccountingTransactionsAll()
      .map(rowToLedgerItem)
      .filter((x): x is NonNullable<ReturnType<typeof rowToLedgerItem>> => !!x && Date.parse(x.updatedAt) > sinceMs),
    listScheduleSince: sinceMs => vaultTodosAll()
      .map(rowToScheduleItem)
      .filter((x): x is { id: string; updatedAt: string; data: ScheduleItemData } => !!x && Date.parse(x.updatedAt) > sinceMs),
    listTombstonesSince: sinceMs => vaultTombstonesSince(sinceMs),
    pcName: () => hostname(),
  }
  const server = createCompanionServer(deps)

  let boundPort = 0
  const tryListen = (p: number): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(p, '0.0.0.0', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  // 先赖在首选端口上重试（ride out HMR 竞态），实在被别的程序占死才回退
  for (let i = 0; i < PREFERRED_PORT_RETRIES && !boundPort; i++) {
    try {
      await tryListen(port)
      boundPort = port
    } catch {
      if (i < PREFERRED_PORT_RETRIES - 1) await new Promise(r => setTimeout(r, PREFERRED_RETRY_GAP_MS))
    }
  }
  if (!boundPort) {
    for (let i = 1; i < MAX_PORT_TRIES; i++) {
      try {
        await tryListen(port + i)
        boundPort = port + i
        break
      } catch {
        if (i === MAX_PORT_TRIES - 1) throw new Error('手机伴侣端口全部被占用（8770 起 20 个）')
      }
    }
  }
  if (boundPort !== port) {
    console.warn('[companion] 首选端口', port, '被占，已回退到', boundPort, '——手机扫段只探 8770/8771，请检查占用者')
  }

  state = { server, port: boundPort, pairCode: newPairCode(), pendingPairs: [], unsubDataChanged: null }
  startDefaultIpPolling()

  /* 组播发现应答器（Phrontis-mobile 仓 handoff-multicast-discovery-desktop.md）：手机往组播组喊
   * "PHRONDIS v1" → 向来源单播回发现负载（与 /api/discover 同构 + port），不猜网段任意子网秒回。
   * 电脑名与配对能力取同一份 deps（与 HTTP /api/discover 同源推导），端口为实际绑定值——
   * 电脑改端口时组播路径自动跟随，扫段路径做不到。组播不可用（AP 隔离等）时静默降级，不影响服务。 */
  startDiscoverResponder(boundPort, deps.pcName, pairingCapabilities(!!deps.onPairRequest))

  /* v1.7 唤醒接线（方案 §3.2）：一处订阅覆盖全部信号源——
   * ① 手机 push 应用成功：三域 applied 路径各自 broadcastDataChanged（accounting/schedule/knowledge）；
   * ② 桌面自身改动（编辑器 / AI 工具 / 渲染层 data:notify）：同一广播通道；
   * ③ pull 扫描发现变更：listNotesSince deps 内非空 poke。
   * 信号粗粒度（任何域动一下都算），醒来后各自重扫，不做分域过滤。 */
  state.unsubDataChanged = subscribeDataChanged(scope => {
    if (scope === 'accounting' || scope === 'schedule' || scope === 'knowledge') {
      state.server?.pokeSync()
    }
  })
  return status()
}

/** TransactionRow → 协议 ledger 条目（transfer 不上行；缺字段视为异常丢弃） */
function rowToLedgerItem(row: TransactionRow): { id: string; updatedAt: string; data: import('./protocol').LedgerItemData } | null {
  if (row.type !== 'expense' && row.type !== 'income') return null
  const amount = Number(row.amount)
  if (!Number.isFinite(amount) || amount <= 0) return null
  return {
    id: row.id,
    updatedAt: row.updatedAt,
    data: {
      date: row.date,
      time: row.time,
      type: row.type,
      amount,
      category: row.category,
      payment: row.payment,
      merchant: row.merchant,
      note: row.note,
    },
  }
}

/** TodoRow → 协议 schedule 条目（含子任务行；异常行丢弃不阻断整表 pull） */
function rowToScheduleItem(row: TodoRow): { id: string; updatedAt: string; data: ScheduleItemData } | null {
  const date = typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date : ''
  const title = String(row.title ?? '').trim()
  if (!date || !title) return null
  const type = row.task_type === 'deadline' || row.task_type === 'daily' ? row.task_type : 'plan'
  // 桌面行 time 存 'YYYY-MM-DD HH:MM'（deadline）；截回协议口径 'HH:MM'，异常格式视为无
  const time = typeof row.time === 'string' && /\d{1,2}:\d{2}/.test(row.time) ? row.time.slice(-5) : ''
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    id: row.id,
    updatedAt: String(row.updated_at ?? ''),
    data: {
      date,
      title,
      type,
      time,
      done: row.status === 'done',
      parentId: row.parent_id ?? null,
      schedStart: num(row.scheduled_start),
      schedEnd: num(row.scheduled_end),
    },
  }
}

export async function stop(): Promise<CompanionStatus> {
  stopDiscoverResponder()
  stopDefaultIpPolling()
  defaultIpCache = undefined
  lastClientIp = undefined
  state.pairCode = null
  state.pendingPairs = []
  state.unsubDataChanged?.()
  state.unsubDataChanged = null
  if (state.server) {
    const s = state.server
    state.server = null
    await new Promise<void>(resolve => {
      s.close(() => resolve())
      s.closeAllConnections()
    })
  }
  return status()
}

// ---- IPC ----

export function registerCompanionHandlers(): void {
  // 墓碑数据源（v1.1）：桌面侧一切 vault 条目删除（界面 / AI / 7 天清理 / 结算撤销）
  // 统一经 deleteSink 记墓碑 —— 服务开着与否都记（服务关着时删除，下次 pull 手机照样能收到）
  setVaultDeleteSink((domain, ids) => vaultRecordTombstones(domain, ids, new Date().toISOString()))

  ipcMain.handle('companion:start', (_e, opts?: { port?: number }) => start(opts))
  ipcMain.handle('companion:stop', () => stop())
  ipcMain.handle('companion:status', () => status())
  ipcMain.handle('companion:newPairCode', () => {
    if (state.server) state.pairCode = newPairCode()
    return status()
  })
  ipcMain.handle('companion:qr', (_e, text: unknown) =>
    typeof text === 'string' && text ? toQrDataUrl(text) : '')
  ipcMain.handle('companion:revoke', (_e, deviceId: unknown) => {
    const id = String(deviceId ?? '')
    // WP5：运行中必须同时失效内存令牌——只删设备文件的话 tokenIndex 还认旧 token，
    // 手机下次 ping 仍 200，「电脑已移除设备 → 手机显示重新配对」永远走不通
    state.server?.revokeDevice(id)
    savePairedDevices(loadPairedDevices().filter(d => d.deviceId !== id))
    return { ok: true }
  })
  /* v1.5 配对确认框：允许 → 服务内发令牌；拒绝 → 手机侧轮询到 rejected */
  ipcMain.handle('companion:approvePair', (_e, requestId: unknown) => resolvePairRequest(String(requestId ?? ''), 'approve'))
  ipcMain.handle('companion:rejectPair', (_e, requestId: unknown) => resolvePairRequest(String(requestId ?? ''), 'reject'))

  app.on('before-quit', () => {
    stopDiscoverResponder()
    if (state.server) {
      try {
        state.server.close()
        state.server.closeAllConnections()
      } catch { /* 忽略 */ }
      state.server = null
    }
  })
}

/**
 * 开机自启（设置 companionAutoStart）。由 main/index.ts 在 settingsCache 就绪后调用；
 * 失败只打日志不打扰启动流程（devbridge 同款「异步启动不阻塞」口径）。
 */
export async function companionAutoStartIfConfigured(getSetting: (key: string) => unknown): Promise<void> {
  if (getSetting('companionAutoStart') !== true) return
  try {
    await start()
    console.log('[companion] auto-started on port', state.port)
  } catch (e) {
    console.error('[companion] auto-start failed', e)
  }
}
