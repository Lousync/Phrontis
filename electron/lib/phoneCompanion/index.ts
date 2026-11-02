import { app, ipcMain } from 'electron'
import { randomInt } from 'crypto'
import { hostname } from 'os'
import { createCompanionServer, type CompanionPairCode } from './server'
import { DEFAULT_PORT, PAIR_CODE_TTL_MS, buildPairUrl } from './protocol'
import { generateToken } from '../lanShare/auth'
import { getLanAddresses } from '../lanShare/server'
import { toQrDataUrl } from '../lanShare/qr'
import { loadPairedDevices, savePairedDevices } from './devices'
import { vaultAccountingSyncUpsert, vaultAccountingTransactionsAll } from 'phrontis-core/kbStore/accountingVaultRepo'
import { broadcastDataChanged } from '../../main/windowBus'
import type { TransactionRow } from 'phrontis-core/kbStore/accountingVaultRepo'

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

interface ServiceState {
  server: ReturnType<typeof createCompanionServer> | null
  port: number
  pairCode: CompanionPairCode | null
}

let state: ServiceState = { server: null, port: 0, pairCode: null }

export interface CompanionStatus {
  running: boolean
  port: number
  urls: string[]
  pairCode: string
  pairCodeExpiresAt: number
  devices: Array<{ deviceId: string; name: string; pairedAt: number; lastSeenAt: number }>
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
  }
}

export async function start(opts?: { port?: number }): Promise<CompanionStatus> {
  if (state.server) return status()
  const port = opts?.port && opts.port > 0 && opts.port < 65536 ? opts.port : DEFAULT_PORT

  const server = createCompanionServer({
    loadDevices: loadPairedDevices,
    saveDevices: savePairedDevices,
    getPairCode: () => state.pairCode,
    consumePairCode: () => { state.pairCode = null },
    applyLedger: item => vaultAccountingSyncUpsert({
      id: item.id, updatedAt: item.updatedAt,
      date: item.data.date, time: item.data.time, type: item.data.type, amount: item.data.amount,
      category: item.data.category, payment: item.data.payment, merchant: item.data.merchant, note: item.data.note,
    }),
    listLedgerSince: sinceMs => vaultAccountingTransactionsAll()
      .map(rowToLedgerItem)
      .filter((x): x is NonNullable<ReturnType<typeof rowToLedgerItem>> => !!x && Date.parse(x.updatedAt) > sinceMs),
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

  state = { server, port: boundPort, pairCode: newPairCode() }
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

export async function stop(): Promise<CompanionStatus> {
  state.pairCode = null
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
