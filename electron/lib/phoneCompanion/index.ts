import { app, ipcMain } from 'electron'
import { randomInt } from 'crypto'
import { hostname } from 'os'
import { createCompanionServer, type CompanionPairCode, type CompanionPairRequestView } from './server'
import { DEFAULT_PORT, PAIR_CODE_TTL_MS, buildPairUrl, shouldApplyIncoming, type ScheduleItemData } from './protocol'
import { generateToken } from '../lanShare/auth'
import { getLanAddresses } from '../lanShare/server'
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
import { vaultUpsertPhoneNote } from 'phrontis-core/kbStore/knowledgeVaultRepo'
import { getKnowledgeIndex, findKnowledgePage } from 'phrontis-core/kbStore/knowledgeIndex'
import { getCurrentVault } from 'phrontis-core/kbStore/vaultContext'
import { parseMarkdown } from 'phrontis-core/kbStore/mdStore'
import { broadcastDataChanged, broadcast } from '../../main/windowBus'

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

interface PendingPairEntry {
  view: CompanionPairRequestView
  approve(): { ok: boolean; error?: string }
  reject(): { ok: boolean; error?: string }
}

interface ServiceState {
  server: ReturnType<typeof createCompanionServer> | null
  port: number
  pairCode: CompanionPairCode | null
  /** v1.5 待确认配对请求（渲染层轮询 status 时渲染确认框） */
  pendingPairs: PendingPairEntry[]
}

let state: ServiceState = { server: null, port: 0, pairCode: null, pendingPairs: [] }

export interface CompanionStatus {
  running: boolean
  port: number
  urls: string[]
  pairCode: string
  pairCodeExpiresAt: number
  devices: Array<{ deviceId: string; name: string; pairedAt: number; lastSeenAt: number }>
  /** v1.5：手机发起的待确认配对请求（确认框数据源） */
  pendingPairs: CompanionPairRequestView[]
}

function newPairCode(): CompanionPairCode {
  return { code: String(randomInt(0, 1e8)).padStart(8, '0'), expiresAt: Date.now() + PAIR_CODE_TTL_MS }
}

function status(): CompanionStatus {
  const running = !!state.server
  const code = running ? state.pairCode : null
  return {
    running,
    port: running ? state.port : 0,
    urls: running
      ? getLanAddresses().map(ip => buildPairUrl(ip, state.port, code?.code ?? ''))
      : [],
    pairCode: code && code.expiresAt > Date.now() ? code.code : '',
    pairCodeExpiresAt: code?.expiresAt ?? 0,
    devices: loadPairedDevices().map(({ deviceId, name, pairedAt, lastSeenAt }) => ({ deviceId, name, pairedAt, lastSeenAt })),
    pendingPairs: state.pendingPairs.map(p => p.view),
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
  if (!r.ok) return { ok: false, error: r.error, status: status() }
  state.pendingPairs.splice(i, 1)
  broadcast('companion:pairChanged', { requestId, approved: action === 'approve' })
  return { ok: true, status: status() }
}

export async function start(opts?: { port?: number }): Promise<CompanionStatus> {
  if (state.server) return status()
  const port = opts?.port && opts.port > 0 && opts.port < 65536 ? opts.port : DEFAULT_PORT

  const server = createCompanionServer({
    loadDevices: loadPairedDevices,
    saveDevices: savePairedDevices,
    getPairCode: () => state.pairCode,
    consumePairCode: () => { state.pairCode = null },
    /* v1.5 配对握手：手机发请求 → 留出手柄并推给渲染层确认框（渲染层轮询 status 取 pendingPairs） */
    onPairRequest: (view, handlers) => {
      state.pendingPairs.push({ view, approve: handlers.approve, reject: handlers.reject })
      broadcast('companion:pairRequest', view)
    },
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
      // v1.2：手机是闪念真相源，无条件应用（口径见 design.md §2.1 v1.2 节）
      const r = vaultUpsertPhoneNote(item.id, item.data.title, item.data.body)
      broadcastDataChanged('knowledge')
      return { applied: true, reason: r.action }
    },
    listNoteTree: () => getKnowledgeIndex().pages
      // 只给 doc（md）；欢迎页是合成条目且 HTML 手机渲染不了；file 条目（导图/归档）同样排除
      .filter(p => p.entryKind !== 'file' && p.id !== 'kb-welcome-doc')
      .map(p => ({ id: p.id, title: p.title, path: p.path, categoryId: p.categoryId, mtimeMs: p.mtimeMs, sizeBytes: p.sizeBytes ?? 0 })),
    readNoteContent: id => {
      const entry = findKnowledgePage(id)
      if (!entry || entry.entryKind === 'file') return null
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
    } catch {
      if (i === MAX_PORT_TRIES - 1) throw new Error('手机伴侣端口全部被占用（8770 起 20 个）')
    }
  }

  state = { server, port: boundPort, pairCode: newPairCode(), pendingPairs: [] }
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
  state.pairCode = null
  state.pendingPairs = []
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
    savePairedDevices(loadPairedDevices().filter(d => d.deviceId !== id))
    return { ok: true }
  })
  /* v1.5 配对确认框：允许 → 服务内发令牌；拒绝 → 手机侧轮询到 rejected */
  ipcMain.handle('companion:approvePair', (_e, requestId: unknown) => resolvePairRequest(String(requestId ?? ''), 'approve'))
  ipcMain.handle('companion:rejectPair', (_e, requestId: unknown) => resolvePairRequest(String(requestId ?? ''), 'reject'))

  app.on('before-quit', () => {
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
