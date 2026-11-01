// R6 去库化（D9）：全局数据 = userData/data/*.json（sql.js 已移除）
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { globalReadJson, globalWriteJson } from 'phrontis-core/globalJsonStore'
import { decryptSecret } from './secretBox'
import { registerTool, unregisterToolsByPrefix } from './aiTools'
import type { ToolJsonSchema } from './aiTools'

/**
 * McpManager —— 外部 MCP Server 连接生命周期 / 工具发现 / 工具调用代理。
 * 方案见 .claude/plans/agent-tools-foundation.md 第五、十一节：
 * - 三种传输：stdio（本机命令，添加时双重确认+默认禁用）/ sse / streamable http
 * - 同时连接数上限 5；单次调用超时 30s；单响应体积上限 256KB
 * - 连接成功 → 工具以 mcp.<serverId>.<toolName> 注册进 ToolRegistry；断开即整体下线
 * - 状态持久化到 userData/data/mcp.json（ok/error + last_error），渲染层永远接触不到密文
 */

export const MAX_CONNECTIONS = 5
const CALL_TIMEOUT_MS = 30_000
const MAX_RESPONSE_CHARS = 256 * 1024

/** MCP 服务器配置行（snake_case 结构对齐原 mcp_servers 表；created_at 为迁移兼容可选字段） */
export interface McpServerRow {
  id: string; name: string; transport: string
  endpoint: string; args_json: string
  enabled: number; status: string; last_error: string | null
  created_at?: string
}

/** MCP 服务器配置 = userData/data/mcp.json（数组顺序即原 created_at ASC 语义） */
const MCP_SERVERS_FILE = 'mcp.json'

/** 读取全部 MCP 服务器配置行 */
export function readMcpServerRows(): McpServerRow[] {
  return globalReadJson<McpServerRow[]>(MCP_SERVERS_FILE, [])
}

/** 全量写回 MCP 服务器配置 */
export function writeMcpServerRows(rows: McpServerRow[]): void {
  globalWriteJson(MCP_SERVERS_FILE, rows)
}

interface LiveConnection {
  client: InstanceType<typeof Client>
  toolNames: string[]
}

/** 解析库内 endpoint/args_json → 可用的启动配置（env 值在此刻才解密） */
function parseEndpoint(row: McpServerRow): { command?: string; args?: string[]; url?: URL; env?: Record<string, string> } {
  if (row.transport === 'stdio') {
    let argv: unknown
    try { argv = JSON.parse(row.endpoint) } catch { throw new Error('endpoint 不是合法的命令行 JSON 数组') }
    if (!Array.isArray(argv) || argv.length === 0 || argv.some(a => typeof a !== 'string')) {
      throw new Error('命令行必须是非空字符串数组')
    }
    let meta: { env?: Record<string, string> } = {}
    try { meta = JSON.parse(row.args_json || '{}') } catch { /* keep empty */ }
    const env: Record<string, string> = {}
    for (const [k, cipher] of Object.entries(meta.env ?? {})) {
      const v = decryptSecret(String(cipher))
      if (v) env[k] = v
    }
    return { command: argv[0], args: argv.slice(1), env }
  }
  let url: URL
  try { url = new URL(row.endpoint) } catch { throw new Error(`URL 不合法: ${row.endpoint}`) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('仅允许 http(s) 地址')
  return { url }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} 超时（${Math.round(ms / 1000)}s）`)), ms)
    p.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
  })
}

class McpManagerImpl {
  private connections = new Map<string, LiveConnection>()

  isConnected(serverId: string): boolean { return this.connections.has(serverId) }
  get connectionCount(): number { return this.connections.size }

  /** 建立连接并发现工具；成功则把工具注册进 ToolRegistry 并持久化 ok 状态 */
  async connect(row: McpServerRow): Promise<{ tools: { name: string; description: string }[] }> {
    if (this.connections.has(row.id)) this.disconnect(row.id)
    if (this.connections.size >= MAX_CONNECTIONS) {
      await this.markStatus(row, 'error', `已达同时连接数上限（${MAX_CONNECTIONS}）`)
      throw new Error(`已达同时连接数上限（${MAX_CONNECTIONS}），请先停用部分服务器`)
    }

    const ep = parseEndpoint(row)
    let transport
    if (row.transport === 'stdio') {
      transport = new StdioClientTransport({
        command: ep.command!,
        args: ep.args,
        env: { ...getDefaultEnvironment(), ...ep.env },
      })
    } else if (row.transport === 'sse') {
      transport = new SSEClientTransport(ep.url!)
    } else {
      transport = new StreamableHTTPClientTransport(ep.url!)
    }

    const client = new Client({ name: 'Phrontis', version: '1.0.0' })
    try {
      await withTimeout(client.connect(transport), CALL_TIMEOUT_MS, '连接')
      const listed = await withTimeout(client.listTools(), CALL_TIMEOUT_MS, '工具发现')
      const tools = (listed.tools ?? []).map(t => ({
        name: String(t.name),
        description: String(t.description ?? ''),
        inputSchema: t.inputSchema,
      }))
      // 注册进统一注册表：mcp.<serverId>.<toolName>，外部工具保守按非只读处理
      for (const t of tools) {
        // 工具名净化：MCP 侧允许任意字符，这里统一小写并替换非法字符，保证命名空间规则
        const safeName = t.name.toLowerCase().replace(/[^a-z0-9._-]/g, '-') || 'tool'
        registerTool({
          name: `mcp.${row.id}.${safeName}`,
          title: t.name,
          description: t.description || `${row.name} 提供的工具 ${t.name}`,
          // MCP 工具自带 JSON Schema 原样透传；注册表校验器只校验基础类型，其余结构留给调用方
          inputSchema: t.inputSchema as ToolJsonSchema,
          source: 'mcp',
          enabled: true,
          readOnly: false,
        }, async (args) => this.callTool(row.id, t.name, args))
      }
      this.connections.set(row.id, { client, toolNames: tools.map(t => t.name) })
      await this.markStatus(row, 'ok', '')
      return { tools: tools.map(({ name, description }) => ({ name, description })) }
    } catch (err) {
      try { await client.close() } catch { /* ignore */ }
      const msg = String((err as Error)?.message ?? err).slice(0, 500)
      await this.markStatus(row, 'error', msg)
      throw err
    }
  }

  /** 断开连接并把该 server 的全部工具从注册表摘除 */
  disconnect(serverId: string): void {
    const conn = this.connections.get(serverId)
    if (!conn) return
    this.connections.delete(serverId)
    unregisterToolsByPrefix(`mcp.${serverId}.`)
    void conn.client.close().catch(() => { /* ignore */ })
  }

  /** 代理调用外部工具（供 ToolRegistry 的 mcp.* handler 使用） */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const conn = this.connections.get(serverId)
    if (!conn) throw new Error('服务器未连接，请先启用或刷新连接')
    const result = await withTimeout(
      conn.client.callTool({ name: toolName, arguments: args }),
      CALL_TIMEOUT_MS,
      '工具调用'
    )
    let text: string
    try { text = JSON.stringify(result) } catch { text = String(result) }
    if (text.length > MAX_RESPONSE_CHARS) {
      return { __truncated: true, note: `响应超过 ${Math.round(MAX_RESPONSE_CHARS / 1024)}KB 已截断`, data: text.slice(0, MAX_RESPONSE_CHARS) }
    }
    return result
  }

  listLiveTools(serverId: string): { name: string; description: string }[] {
    const conn = this.connections.get(serverId)
    if (!conn) return []
    return conn.toolNames.map(n => ({ name: n, description: '' }))
  }

  // ---- 状态持久化 ----
  private async markStatus(row: McpServerRow, status: string, lastError: string): Promise<void> {
    try {
      const rows = readMcpServerRows()
      const target = rows.find(r => r.id === row.id)
      if (!target) return
      target.status = status
      target.last_error = lastError
      writeMcpServerRows(rows)
    } catch (err) {
      console.error('[MCP] Failed to persist state:', err)
    }
  }
}

export const McpManager = new McpManagerImpl()
