// R6 去库化（D9）：全局数据 = userData/data/*.json（sql.js 已移除）
import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { encryptSecret } from './secretBox'
import { McpManager, MAX_CONNECTIONS, readMcpServerRows, writeMcpServerRows } from './mcpManager'
import type { McpServerRow } from './mcpManager'
import { appendAudit } from './pluginAudit'

/**
 * MCP 管理面 IPC（前缀 mcp:，方案第五节）——校验/CRUD/生命周期编排。
 * 安全红线：
 * - stdio 会执行本机任意命令：保存与连通性测试都必须携带 confirmCommand=true（UI 双重确认），
 *   且新条目一律默认禁用，需手动启用
 * - sse/http 仅允许 http(s) URL
 * - 环境变量值加密落盘（secretBox）；渲染层只回传键名，永远拿不到明文
 * 存储：mcp_servers 表 → userData/data/mcp.json（行结构对齐原表，数组顺序 = 创建顺序）
 */

const TRANSPORTS = ['stdio', 'sse', 'http'] as const
type Transport = typeof TRANSPORTS[number]

interface ServerDraft {
  name: string
  transport: Transport
  /** stdio：命令与参数数组 */
  command?: string
  commandArgs?: string[]
  /** sse/http：完整 URL */
  url?: string
  /** stdio 环境变量（明文入参，加密后落盘） */
  env?: Record<string, string>
  /** stdio 双重确认标记 */
  confirmCommand?: boolean
}

/** 草稿 → 存储形态；校验失败直接抛错（消息面向用户） */
function buildStoredFields(draft: ServerDraft): { endpoint: string; argsJson: string } {
  if (!draft.name || typeof draft.name !== 'string') throw new Error('名称不能为空')
  if (!TRANSPORTS.includes(draft.transport)) throw new Error(`不支持的传输类型: ${draft.transport}`)

  if (draft.transport === 'stdio') {
    if (typeof draft.command !== 'string' || !draft.command.trim()) throw new Error('命令不能为空')
    if (draft.confirmCommand !== true) throw new Error('未确认「我了解将执行此命令」，无法保存 stdio 型服务器')
    const args = Array.isArray(draft.commandArgs) ? draft.commandArgs.filter(a => typeof a === 'string') : []
    const argv = [draft.command.trim(), ...args]
    return { endpoint: JSON.stringify(argv), argsJson: JSON.stringify({ env: encodeEnv(draft.env) }) }
  }

  if (typeof draft.url !== 'string' || !draft.url.trim()) throw new Error('URL 不能为空')
  let u: URL
  try { u = new URL(draft.url.trim()) } catch { throw new Error(`URL 不合法: ${draft.url}`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅允许 http(s) 地址')
  return { endpoint: u.toString(), argsJson: '{}' }
}

/** 明文 env → 加密 env（空对象返回空串省空间） */
function encodeEnv(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env ?? {})) {
    if (typeof k !== 'string' || !k) continue
    out[k] = encryptSecret(String(v))
  }
  return out
}

function rowToInfo(row: McpServerRow) {
  let argvPreview = ''
  if (row.transport === 'stdio') {
    try { argvPreview = (JSON.parse(row.endpoint) as unknown[]).join(' ') } catch { argvPreview = row.endpoint }
  }
  let envKeys: string[] = []
  try {
    const meta = JSON.parse(row.args_json || '{}') as { env?: Record<string, string> }
    envKeys = Object.keys(meta.env ?? {})
  } catch { /* ignore */ }
  const connected = McpManager.isConnected(row.id)
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    endpointPreview: row.transport === 'stdio' ? argvPreview : row.endpoint,
    envKeys,
    enabled: !!row.enabled,
    status: row.status,
    lastError: row.last_error || '',
    toolCount: McpManager.listLiveTools(row.id).length,
    maxConnections: MAX_CONNECTIONS,
  }
}

function getRow(id: string): McpServerRow {
  const row = readMcpServerRows().find(r => r.id === id)
  if (!row) throw new Error('服务器不存在')
  return row
}

async function connectWithRegistrySync(row: McpServerRow) {
  try {
    await McpManager.connect(row)
    return { ok: true as const }
  } catch (err) {
    // 失败时确保半注册状态被清理
    McpManager.disconnect(row.id)
    return { ok: false as const, error: String((err as Error)?.message ?? err) }
  }
}

export function registerMcpHandlers(): void {

  ipcMain.handle('mcp:listServers', () => readMcpServerRows().map(rowToInfo))

  ipcMain.handle('mcp:addServer', (_e, draft: ServerDraft) => {
    const { endpoint, argsJson } = buildStoredFields(draft)
    const id = randomUUID()
    const row: McpServerRow = {
      id, name: draft.name.trim(), transport: draft.transport,
      endpoint, args_json: argsJson, enabled: 0, status: 'untested', last_error: '',
    }
    writeMcpServerRows([...readMcpServerRows(), row])
    appendAudit('', 'mcp.server.add', { server: draft.name, transport: draft.transport })
    return rowToInfo(getRow(id))
  })

  ipcMain.handle('mcp:updateServer', (_e, id: string, patch: Partial<ServerDraft>) => {
    const row = getRow(id)
    const merged: ServerDraft = {
      name: patch.name ?? row.name,
      transport: (patch.transport ?? row.transport) as Transport,
      env: patch.env,
      confirmCommand: patch.confirmCommand,
    }
    if (row.transport === 'stdio') {
      let oldArgv: string[] = []
      try { oldArgv = JSON.parse(row.endpoint) as string[] } catch { /* ignore */ }
      merged.command = patch.command ?? oldArgv[0] ?? ''
      merged.commandArgs = patch.commandArgs ?? oldArgv.slice(1)
    } else {
      merged.url = patch.url ?? row.endpoint
      if (!patch.env) delete merged.env // 未提交新 env 则保留旧密文
    }
    const { endpoint, argsJson } = buildStoredFields(merged)
    // 配置变更后断开旧连接，由用户重新启用以生效
    McpManager.disconnect(id)
    const rows = readMcpServerRows()
    const target = rows.find(r => r.id === id)
    if (!target) throw new Error('服务器不存在')
    target.name = merged.name!.trim()
    target.transport = merged.transport
    target.endpoint = endpoint
    target.args_json = argsJson
    target.status = 'untested'
    writeMcpServerRows(rows)
    appendAudit('', 'mcp.server.update', { server: merged.name })
    return rowToInfo(getRow(id))
  })

  ipcMain.handle('mcp:removeServer', (_e, id: string) => {
    const row = getRow(id)
    McpManager.disconnect(id)
    writeMcpServerRows(readMcpServerRows().filter(r => r.id !== id))
    appendAudit('', 'mcp.server.remove', { server: row.name })
    return true
  })

  ipcMain.handle('mcp:toggleServer', async (_e, id: string, enabled: boolean) => {
    const row = getRow(id)
    if (enabled) {
      row.enabled = 1
      writeMcpServerRows(readMcpServerRows().map(r => (r.id === id ? row : r)))
      const r = await connectWithRegistrySync({ ...row, enabled: 1 })
      if (!r.ok) return { ok: false, error: r.error, ...rowToInfo(getRow(id)) }
      return { ok: true, ...rowToInfo(getRow(id)) }
    }
    McpManager.disconnect(id)
    row.enabled = 0
    writeMcpServerRows(readMcpServerRows().map(r => (r.id === id ? row : r)))
    return { ok: true, ...rowToInfo(getRow(id)) }
  })

  ipcMain.handle('mcp:listTools', (_e, id: string) => ({ tools: McpManager.listLiveTools(id) }))

  ipcMain.handle('mcp:refreshTools', async (_e, id: string) => {
    const row = getRow(id)
    McpManager.disconnect(id)
    const r = await connectWithRegistrySync(row)
    if (!r.ok) return { ok: false, error: r.error, tools: [] }
    return { ok: true, tools: McpManager.listLiveTools(id) }
  })

  // 连通性测试：用草稿配置瞬时建连，成功回传工具预览后立即断开（LightBot 式体验）
  ipcMain.handle('mcp:testConnection', async (_e, draft: ServerDraft) => {
    const started = Date.now()
    const { endpoint, argsJson } = buildStoredFields(draft) // stdio 未确认在此拦截
    const tempRow: McpServerRow = {
      id: '__test__', name: draft.name || 'test', transport: draft.transport,
      endpoint, args_json: argsJson, enabled: 0, status: 'untested', last_error: '',
    }
    try {
      const { tools } = await McpManager.connect(tempRow)
      McpManager.disconnect('__test__')
      return { ok: true, latencyMs: Date.now() - started, tools }
    } catch (err) {
      McpManager.disconnect('__test__')
      return { ok: false, latencyMs: Date.now() - started, error: String((err as Error)?.message ?? err), tools: [] }
    }
  })
}

/** 启动恢复：把上次处于启用状态的 server 重连（逐个尝试，失败仅记录不阻断启动） */
export async function restoreMcpConnections(): Promise<void> {
  const rows = readMcpServerRows().filter(r => r.enabled === 1)
  for (const row of rows) {
    const r = await connectWithRegistrySync(row)
    if (!r.ok) console.warn(`[MCP] Failed to restore connection ${row.name}:`, r.error)
  }
}
