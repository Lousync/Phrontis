/**
 * 提示型 hooks（P2）**纯逻辑**：宽容解析、事件 / 工具匹配、注入文案与上限。
 *
 * 边界（已拍板）：钩子只把 prompt 注入模型上下文，**不执行命令、不改文件、不改权限**。
 * 事件：
 *  - run-start：每次运行开始注入到 system；
 *  - after-tool：匹配的工具成功执行后，下一轮 LLM 前注入一条不落库的合成消息。
 *
 * 零依赖独立文件：契约脚本 `verify-assistant-customization.mjs` 直接 import。
 */

export type PromptHookEvent = 'run-start' | 'after-tool'

export interface PromptHook {
  event: PromptHookEvent
  prompt: string
  enabled: boolean
  /** after-tool 专用：工具名匹配（精确名或尾部 `*` 通配） */
  tools: string[]
}

export const PROMPT_HOOK_EVENTS: PromptHookEvent[] = ['run-start', 'after-tool']
export const MAX_HOOKS = 20
export const MAX_HOOK_PROMPT_CHARS = 500
export const MAX_HOOK_TOTAL_CHARS = 3000
export const MAX_HOOK_TOOLS = 10
/** 每轮最多注入几条 after-tool 钩子（防刷屏） */
export const MAX_AFTER_TOOL_PER_ROUND = 3

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 宽容解析 hooks.json：接受 `{ hooks: [...] }` 或直接数组。
 * 非法条目跳过并计入 warnings；不抛错（钩子是锦上添花，不能打断对话）。
 */
export function parsePromptHooks(raw: unknown): { hooks: PromptHook[]; warnings: string[] } {
  const warnings: string[] = []
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.hooks)
      ? raw.hooks
      : null
  if (!list) return { hooks: [], warnings: ['hooks 必须是数组，或 { hooks: [...] }'] }
  const hooks: PromptHook[] = []
  let total = 0
  for (let i = 0; i < list.length; i++) {
    const entry = list[i]
    if (!isRecord(entry)) { warnings.push(`第 ${i + 1} 条不是对象，已跳过`); continue }
    const event = String(entry.event ?? '').trim() as PromptHookEvent
    if (!PROMPT_HOOK_EVENTS.includes(event)) {
      warnings.push(`第 ${i + 1} 条 event 非法（${String(entry.event ?? '')}），已跳过`)
      continue
    }
    const prompt = String(entry.prompt ?? '').replace(/\u0000/g, '').trim()
    if (!prompt) { warnings.push(`第 ${i + 1} 条 prompt 为空，已跳过`); continue }
    if (hooks.length >= MAX_HOOKS) { warnings.push(`钩子最多 ${MAX_HOOKS} 条，其余已忽略`); break }
    const clipped = prompt.length > MAX_HOOK_PROMPT_CHARS ? prompt.slice(0, MAX_HOOK_PROMPT_CHARS) : prompt
    if (total + clipped.length > MAX_HOOK_TOTAL_CHARS) { warnings.push(`钩子文本总量超过 ${MAX_HOOK_TOTAL_CHARS} 字，其余已忽略`); break }
    total += clipped.length
    const tools = entry.tools === undefined
      ? []
      : Array.isArray(entry.tools)
        ? entry.tools.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, MAX_HOOK_TOOLS)
        : []
    hooks.push({ event, prompt: clipped, enabled: entry.enabled !== false, tools: event === 'after-tool' ? tools : [] })
  }
  return { hooks, warnings }
}

/** 工具名匹配：精确名，或 `builtin.vault.*` 这种尾部通配（`*` = 全部） */
export function matchToolPattern(pattern: string, name: string): boolean {
  const p = String(pattern ?? '').trim()
  const n = String(name ?? '').trim()
  if (!p || !n) return false
  if (p === '*') return true
  if (p.endsWith('*')) return n.startsWith(p.slice(0, -1))
  return p === n
}

/** 取本次事件要注入的钩子（after-tool 需传工具名；未配 tools = 匹配所有工具） */
export function hooksForEvent(hooks: PromptHook[], event: PromptHookEvent, toolName?: string): PromptHook[] {
  return hooks.filter((h) => {
    if (!h.enabled || h.event !== event) return false
    if (event !== 'after-tool' || !toolName) return true
    if (h.tools.length === 0) return true
    return h.tools.some((p) => matchToolPattern(p, toolName))
  })
}

/** run-start 注入段（无钩子 → 空串） */
export function renderRunStartHooks(hooks: PromptHook[]): string {
  const list = hooksForEvent(hooks, 'run-start')
  if (list.length === 0) return ''
  return '\n\n【项目钩子 · 运行开始】以下规则来自仓库 .assistant/hooks.json，请在本轮遵守：\n'
    + list.map((h, i) => `${i + 1}. ${h.prompt}`).join('\n')
}

/** after-tool 注入段：调用方已按触发次数截断 */
export function renderAfterToolHooks(prompts: string[]): string {
  const list = prompts.map((p) => String(p ?? '').trim()).filter(Boolean).slice(0, MAX_AFTER_TOOL_PER_ROUND)
  if (list.length === 0) return ''
  return '【项目钩子 · 工具之后】刚才的工具已执行完成，请按以下提醒继续：\n'
    + list.map((p, i) => `${i + 1}. ${p}`).join('\n')
}
