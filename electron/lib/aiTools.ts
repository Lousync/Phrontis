import { ipcMain } from 'electron'
import { appendAudit, countMonthInvocations, listAudit, summarizeArgs } from './pluginAudit'

/**
 * ToolRegistry —— AI Agent 统一工具注册表（方案见 .claude/plans/agent-tools-foundation.md 第四节）。
 * 职责边界：只做「发现 + 描述 + 校验入参」，execute 统一代理到来源处理器。
 * 三类来源：builtin（官方代码，本期）/ mcp（外部服务器，M2）/ skill（提示词能力包，M3）。
 */

// ===== 类型 =====

/** 入参校验用 JSON Schema 的 M1 子集：type/properties/required/description（递归结构用 object/array） */
export interface ToolSchemaProp {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description?: string
  minimum?: number
  maximum?: number
  enum?: string[]
  /** required 字符串参数显式允许空串（如 edit.newText：'' = 删除片段）。缺省空串按缺失拒，防 AI 漏参 */
  allowEmpty?: boolean
  /** type:'object' 的子字段（透传给模型；校验只做浅层 typeof） */
  properties?: Record<string, ToolSchemaProp>
  /** type:'array' 的元素结构 */
  items?: ToolSchemaProp
  required?: string[]
}

export interface ToolJsonSchema {
  type: 'object'
  properties?: Record<string, ToolSchemaProp>
  required?: string[]
}

export interface AgentTool {
  /** 全局唯一：builtin.knowledge.search / mcp.<serverId>.<toolName> / skill.<id>.<name> */
  name: string
  title: string
  description: string
  inputSchema: ToolJsonSchema
  source: 'builtin' | 'mcp' | 'skill'
  enabled: boolean
  /** 内置首批全部 true；mcp 工具默认按 false 处理（保守） */
  readOnly: boolean
  /** 所属业务模块（内置工具必填；权限按模块控制） */
  module?: string
  /** 调用本工具所需的最低权限（默认 read；写工具为 write） */
  requires?: 'read' | 'write'
  /** vaultFile 文件域级别（vault.* 文件工具用）：缺省=不受文件域约束（业务模块工具） */
  vaultFile?: 'read' | 'write'
  /**
   * 装载层（P3）：缺省 'core'（常驻每轮 schema）；'ondemand' 默认不装载，
   * AI 通过 builtin.tool.request 申请后（会话内持久）才进入视野。
   * 写类工具全部 ondemand——典型会话 0~3 次写，却占近半 schema。
   */
  tier?: 'core' | 'ondemand'
}

/** 工具调用上下文（AgentRunner 执行路径注入；IPC 手动调用无上下文）：
 *  visual.html 等「产物落会话目录」的工具用 sessionId 定位归属文件夹 */
export interface ToolInvokeCtx {
  sessionId?: string
  source?: string
}

export type ToolHandler = (args: Record<string, unknown>, ctx?: ToolInvokeCtx) => unknown | Promise<unknown>

interface RegisteredTool extends AgentTool {
  handler: ToolHandler
}

export interface ToolDescription extends Omit<AgentTool, 'handler'> {}

export interface AiToolUsage {
  used: number
  limit: number // 0 = 不限
}

export type AiToolErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'TOOL_DISABLED'
  | 'INVALID_ARGS'
  | 'LIMIT_EXCEEDED'
  | 'EXEC_ERROR'
  | 'MODULE_FORBIDDEN'
  | 'MODULE_READONLY'
  | 'VAULTFILE_FORBIDDEN'
  | 'VAULTFILE_READONLY'

export type AiToolInvokeResult = {
  ok: true
  data: unknown
} | {
  ok: false
  code: AiToolErrorCode
  message: string
}

// ===== 注册表（单例） =====

const registry = new Map<string, RegisteredTool>()

export function registerTool(tool: AgentTool, handler: ToolHandler): void {
  // 命名空间规则：首段为来源前缀(builtin/mcp/skill)，后续段允许数字开头与连字符(容纳 UUID 型 serverId)
  if (!/^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9._-]*)*$/.test(tool.name)) {
    throw new Error(`工具名不合法: ${tool.name}`)
  }
  if (registry.has(tool.name)) {
    throw new Error(`工具名重复注册: ${tool.name}`)
  }
  registry.set(tool.name, { ...tool, handler })
}

/** 工具描述列表（不含处理器），按来源与名称排序保证输出稳定 */
export function listTools(): ToolDescription[] {
  return [...registry.values()]
    .map(({ handler: _h, ...desc }) => desc)
    .sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name))
}

/** 按命名空间前缀批量注销工具（如 MCP server 禁用/删除时其 mcp.<serverId>.* 整体下线） */
export function unregisterToolsByPrefix(prefix: string): number {
  let removed = 0
  for (const name of [...registry.keys()]) {
    if (name === prefix || name.startsWith(prefix)) {
      registry.delete(name)
      removed++
    }
  }
  return removed
}

/** 审计动作按工具来源区分：外部 MCP 调用记 mcp.invoke，其余记 tool.invoke（月度上限两者都计入） */
function auditActionFor(toolName: string): string {
  return toolName.startsWith('mcp.') ? 'mcp.invoke' : 'tool.invoke'
}

// ===== 入参校验（M1 子集：类型/必填/范围/枚举） =====

export function validateArgs(schema: ToolJsonSchema, args: Record<string, unknown>): string | null {
  const props = schema.properties ?? {}
  for (const key of schema.required ?? []) {
    const v = args[key]
    // 空串默认按缺失拒（防漏参）；schema 标 allowEmpty 的参数放行（如 edit.newText='' 表删除）
    if (v === undefined || v === null || (v === '' && props[key]?.allowEmpty !== true)) return `缺少必填参数: ${key}`
  }
  for (const [key, spec] of Object.entries(props)) {
    const v = args[key]
    if (v === undefined) continue
    switch (spec.type) {
      case 'string':
        if (typeof v !== 'string') return `参数 ${key} 应为字符串`
        if (spec.enum && !spec.enum.includes(v)) return `参数 ${key} 应为 ${spec.enum.join('|')}`
        break
      case 'number': {
        if (typeof v !== 'number' || !Number.isFinite(v)) return `参数 ${key} 应为数字`
        if (spec.minimum !== undefined && v < spec.minimum) return `参数 ${key} 不能小于 ${spec.minimum}`
        if (spec.maximum !== undefined && v > spec.maximum) return `参数 ${key} 不能大于 ${spec.maximum}`
        break
      }
      case 'boolean':
        if (typeof v !== 'boolean') return `参数 ${key} 应为布尔值`
        break
      case 'object':
        if (typeof v !== 'object' || v === null || Array.isArray(v)) return `参数 ${key} 应为对象`
        break
      case 'array':
        if (!Array.isArray(v)) return `参数 ${key} 应为数组`
        break
    }
  }
  return null
}

// ===== 模块权限 =====

export type ModulePerm = 'off' | 'read' | 'write'

const MODULE_PERM_LEVEL: Record<ModulePerm, number> = { off: 0, read: 1, write: 2 }

/** 解析 aiModulePermissions 设置（JSON 字符串）；缺省模块视为 read */
export function parseModulePerms(raw: unknown): Record<string, ModulePerm> {
  const out: Record<string, ModulePerm> = {}
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw ?? {})
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v === 'off' || v === 'read' || v === 'write') out[k] = v
    }
  } catch { /* 非法 JSON → 全默认 read */ }
  return out
}

/**
 * 权限硬校验：工具所需级别 > 模块授权级别 → 拒绝。
 * 返回 null 表示放行，否则为错误码。
 */
export function checkModulePermission(
  tool: Pick<AgentTool, 'module' | 'requires'>,
  getSettingValue: (key: string) => unknown
): 'MODULE_FORBIDDEN' | 'MODULE_READONLY' | null {
  if (!tool.module) return null // 未归属模块的工具（如 skill）不受此约束
  const required: 'read' | 'write' = tool.requires ?? 'read'
  const perms = parseModulePerms(getSettingValue('aiModulePermissions'))
  const granted: ModulePerm = perms[tool.module] ?? 'read'
  return MODULE_PERM_LEVEL[granted] >= MODULE_PERM_LEVEL[required] ? null
    : (required === 'write' && granted !== 'off' ? 'MODULE_READONLY' : 'MODULE_FORBIDDEN')
}

// ===== vaultFile 文件域（vault.* 工具）：settings aiVaultFilePerm 三档，独立于业务模块 =====

export type VaultFilePerm = 'off' | 'read' | 'write'

const VAULT_FILE_LEVEL: Record<VaultFilePerm, number> = { off: 0, read: 1, write: 2 }

/** 解析 aiVaultFilePerm 设置；非法/缺省 → read（保守可读、不可写） */
export function parseVaultFilePerm(raw: unknown): VaultFilePerm {
  return raw === 'off' || raw === 'read' || raw === 'write' ? raw : 'read'
}

/**
 * vaultFile 域硬校验：工具所需文件域级别 > 用户授权级别 → 拒绝。
 * 返回 null 放行，否则为错误码（agent 预过滤 + invoke 硬校验双防线复用）。
 */
export function checkVaultFilePermission(
  tool: Pick<AgentTool, 'vaultFile'>,
  getSettingValue: (key: string) => unknown
): 'VAULTFILE_FORBIDDEN' | 'VAULTFILE_READONLY' | null {
  if (!tool.vaultFile) return null
  const granted = parseVaultFilePerm(getSettingValue('aiVaultFilePerm'))
  return VAULT_FILE_LEVEL[granted] >= VAULT_FILE_LEVEL[tool.vaultFile] ? null
    : (tool.vaultFile === 'write' && granted !== 'off' ? 'VAULTFILE_READONLY' : 'VAULTFILE_FORBIDDEN')
}

// ===== 月度调用上限 =====

function readMonthlyLimit(getSettingValue: (key: string) => unknown): number {
  const raw = getSettingValue('aiToolMonthlyLimit')
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n > 0 ? n : 0 // 0 = 不限
}

function getUsage(getSettingValue: (key: string) => unknown): AiToolUsage {
  return { used: countMonthInvocations(), limit: readMonthlyLimit(getSettingValue) }
}

// ===== 调用入口 =====

async function invokeTool(
  name: string,
  args: unknown,
  getSettingValue: (key: string) => unknown,
  callerPluginId = '',
  ctx?: ToolInvokeCtx
): Promise<AiToolInvokeResult> {
  const tool = registry.get(name)
  if (!tool) return { ok: false, code: 'TOOL_NOT_FOUND', message: `工具不存在: ${name}` }
  if (!tool.enabled) return { ok: false, code: 'TOOL_DISABLED', message: `工具已禁用: ${name}` }

  let cleanArgs: Record<string, unknown>
  if (args === undefined || args === null) cleanArgs = {}
  else if (typeof args === 'object' && !Array.isArray(args)) cleanArgs = args as Record<string, unknown>
  else return { ok: false, code: 'INVALID_ARGS', message: '入参必须是对象' }

  const invalid = validateArgs(tool.inputSchema, cleanArgs)
  if (invalid) return { ok: false, code: 'INVALID_ARGS', message: invalid }

  // 模块权限硬校验（与 agent 工具表预过滤双重防线）
  const permErr = checkModulePermission(tool, getSettingValue)
  if (permErr) {
    const moduleName = tool.module ?? ''
    appendAudit(callerPluginId, auditActionFor(name) + '.denied', { tool: name, module: moduleName, reason: permErr })
    return {
      ok: false,
      code: permErr,
      message: permErr === 'MODULE_READONLY'
        ? `模块「${moduleName}」对 AI 授权为只读，本操作被拒绝。可在 设置 → AI 工具 → AI 权限 中调整`
        : `模块「${moduleName}」已对 AI 关闭，本操作被拒绝。可在 设置 → AI 工具 → AI 权限 中调整`,
    }
  }

  // vaultFile 文件域硬校验（vault.* 工具；独立于业务模块，双防线同 checkModulePermission）
  if (tool.vaultFile) {
    const fileErr = checkVaultFilePermission(tool, getSettingValue)
    if (fileErr) {
      appendAudit(callerPluginId, auditActionFor(name) + '.denied', { tool: name, reason: fileErr })
      return {
        ok: false,
        code: fileErr,
        message: fileErr === 'VAULTFILE_READONLY'
          ? '仓库文件对 AI 仅开放只读，写入类操作被拒绝。可在 设置 → AI 工具 → 权限 → 仓库文件 中调整为读写'
          : '仓库文件已对 AI 关闭，本操作被拒绝。可在 设置 → AI 工具 → 权限 → 仓库文件 中调整',
      }
    }
  }

  const usage = getUsage(getSettingValue)
  if (usage.limit > 0 && usage.used >= usage.limit) {
    appendAudit(callerPluginId, auditActionFor(name) + '.limit_blocked', {
      tool: name,
      monthUsed: usage.used,
      limit: usage.limit,
    })
    return {
      ok: false,
      code: 'LIMIT_EXCEEDED',
      message: `本月调用次数已达上限（${usage.used}/${usage.limit}），请在 设置 → AI 工具 中调整`,
    }
  }

  const started = Date.now()
  const action = auditActionFor(name)
  try {
    const data = await tool.handler(cleanArgs, ctx)
    appendAudit(callerPluginId, action, {
      tool: name,
      args: summarizeArgs(cleanArgs),
      durationMs: Date.now() - started,
      ok: true,
    })
    return { ok: true, data }
  } catch (err) {
    appendAudit(callerPluginId, action, {
      tool: name,
      args: summarizeArgs(cleanArgs),
      durationMs: Date.now() - started,
      ok: false,
      error: String((err as Error)?.message ?? err).slice(0, 300),
    })
    return { ok: false, code: 'EXEC_ERROR', message: String((err as Error)?.message ?? err) }
  }
}

// ===== IPC 注册 =====

/** 注册时注入的设置读取器（供主进程内部调用路径复用） */
let settingReader: ((key: string) => unknown) | null = null

/** 主进程内部消费方（agentService 等）读取设置的统一入口 */
export function getSettingReader(): (key: string) => unknown {
  return settingReader ?? (() => undefined)
}

/**
 * 主进程内部调用入口（AgentRunner 等消费方）：
 * 与 IPC 完全同一套校验/审计/月度上限链路，不允许绕行。
 */
export function invokeToolInternal(name: string, args: unknown, callerPluginId = '', ctx?: ToolInvokeCtx): Promise<AiToolInvokeResult> {
  if (!settingReader) {
    return Promise.resolve({ ok: false, code: 'EXEC_ERROR', message: 'AI 工具服务尚未初始化' })
  }
  return invokeTool(name, args, settingReader, callerPluginId, ctx)
}

export function registerAiToolHandlers(deps: {
  /** 读主进程设置缓存（避免跨模块循环依赖，由 main/index.ts 注入） */
  getSettingValue: (key: string) => unknown
}): void {
  settingReader = deps.getSettingValue
  // 内置六工具由 main/index.ts 在调用本函数后另行 registerBuiltinTools() 登记
  // （M2 的 mcp.*、M3 的 skill.* 后续接入同一注册表）
  ipcMain.handle('aiTools:list', () => ({ tools: listTools(), usage: getUsage(settingReader!) }))
  ipcMain.handle('aiTools:invoke', (_e, name: string, args: unknown) => invokeTool(name, args, settingReader!))
  ipcMain.handle('aiTools:getUsage', () => getUsage(settingReader!))
  ipcMain.handle('aiTools:getRecentAudit', (_e, limit?: number) => listAudit(limit ?? 20, ['tool.invoke', 'mcp.invoke', 'llm.invoke']))
}
