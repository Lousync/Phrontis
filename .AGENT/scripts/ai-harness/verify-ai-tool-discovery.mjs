// 契约脚本：MCP / Skill 装载层与工具发现（P0-D / v3.31.0）
// 覆盖：按需装载、requires 映射、确认模式暂存、tool.list 取代硬编码清单、信任态不预过滤。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ok, report } from '../shared/ts-module.mjs'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const mcp = read('electron/lib/mcpManager.ts')
const skill = read('electron/lib/skillService.ts')
const stage = read('electron/lib/aiAssistantStageable.ts')
const bt = read('electron/lib/builtinTools.ts')
const agent = read('electron/lib/agentService.ts')
const tools = read('electron/lib/aiTools.ts')

// ── ① MCP ──────────────────────────────────────────────────────────────────────
ok('MCP 工具注册为 ondemand（不再每轮常驻）', /tier: 'ondemand'/.test(mcp))
ok('MCP 工具 requires 由 server readOnly 决定', /requires: serverReadOnly \? 'read' : 'write'/.test(mcp))
ok('MCP 未声明 readOnly 时按写工具处理', /const serverReadOnly = row\.readOnly === true/.test(mcp))
ok('MCP server 行支持 readOnly 字段', /readOnly\?: boolean/.test(mcp))
ok('MCP 工具在确认模式可暂存（mcp. 前缀）', /name\.startsWith\('mcp\.'\)\) return true/.test(stage))
ok('MCP 暂存项标注「外部工具，不可自动回滚」', /不可自动回滚/.test(tools))
ok('MCP 工具 readOnly 属性随 server 声明', /readOnly: serverReadOnly/.test(mcp))

// ── ② Skill ────────────────────────────────────────────────────────────────────
ok('Skill 注册为 ondemand', /tier: 'ondemand'/.test(skill))

// ── ③ 工具发现 ─────────────────────────────────────────────────────────────────
ok('新增 builtin.tool.list 且为 core', /name: 'builtin\.tool\.list'/.test(bt) && /name: 'builtin\.tool\.list'[\s\S]{0,900}?tier: 'core'/.test(bt))
ok('tool.list 只列 ondemand 工具', /t\.tier === 'ondemand'/.test(bt))
ok('tool.list 走模块权限过滤', /checkModulePermission\(t, reader\)/.test(bt))
ok('tool.request 指向 tool.list（描述不再硬编码清单）', /先调 builtin\.tool\.list/.test(bt))
ok('tool.request 描述已瘦身（无旧长清单）', !/vault\.move \/ vault\.trash/.test(bt) && !/knowledge\.graph-topology \/ blog\.create-entry/.test(bt))
ok('tool.request 描述长度受控（<400 字符）', (() => {
  const i = bt.indexOf("name: 'builtin.tool.request'")
  const seg = bt.slice(i, bt.indexOf('inputSchema:', i))
  return seg.length < 400
})())

// ── ④ 三层权限接线 ─────────────────────────────────────────────────────────────
ok('agent 预过滤只隐藏「明确拒绝」，不隐藏「尚未授权」', /fileErr !== 'VAULTFILE_NEEDS_TRUST'/.test(agent))
ok('终端的可用性由工作区信任 + aiExec 决定', /trust\.shellExec === 'allow'/.test(agent) && /readWorkspaceTrust\(\)/.test(agent))
ok('invoke 层对「尚未授权」给出可操作提示', /当前工作区尚未授权 AI 写文件/.test(tools))
ok('tool.request 不把「尚未授权」当拒绝', /fileErr !== 'VAULTFILE_NEEDS_TRUST'/.test(bt))

report('verify-ai-tool-discovery')
