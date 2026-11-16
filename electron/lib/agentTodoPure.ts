/**
 * 通用任务清单（P1-4 `builtin.plan.todo`）**纯逻辑**。
 *
 * 模型每次提交**完整最新清单**（不是增量），主进程归一后原样返回；
 * 渲染层从消息 trace 里取最后一条 `todo` 渲染成对话框清单。
 * 零依赖独立文件：契约脚本 `verify-plan-mode.mjs` 直接 import。
 */

export type AgentTodoStatus = 'todo' | 'doing' | 'done'

export interface AgentTodoItem {
  text: string
  status: AgentTodoStatus
}

export const MAX_TODOS = 20
export const MAX_TODO_TEXT = 200

export type NormalizeTodosResult =
  | { ok: true; items: AgentTodoItem[] }
  | { ok: false; error: string }

function normalizeStatus(raw: unknown): AgentTodoStatus {
  const s = String(raw ?? '').trim().toLowerCase()
  if (s === 'doing' || s === 'current' || s === 'running' || s === 'in_progress' || s === 'in-progress') return 'doing'
  if (s === 'done' || s === 'completed' || s === 'complete' || s === 'finished') return 'done'
  return 'todo'
}

/**
 * 归一清单：最多 20 项、单项 200 字；空文本项丢弃；多个 doing 只保留第一个（其余降为 todo）。
 * 传空数组 = 清空清单（合法）。
 */
export function normalizeAgentTodos(raw: unknown): NormalizeTodosResult {
  if (!Array.isArray(raw)) return { ok: false, error: 'items 必须是数组' }
  if (raw.length > MAX_TODOS) return { ok: false, error: `任务清单最多 ${MAX_TODOS} 项` }
  const items: AgentTodoItem[] = []
  let doingSeen = false
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return { ok: false, error: 'items 的每一项必须是 { text, status }' }
    const obj = entry as Record<string, unknown>
    const text = String(obj.text ?? '').trim().slice(0, MAX_TODO_TEXT)
    if (!text) continue
    let status = normalizeStatus(obj.status)
    if (status === 'doing') {
      if (doingSeen) status = 'todo'
      else doingSeen = true
    }
    items.push({ text, status })
  }
  return { ok: true, items }
}

/** 从 trace 里取最后一条任务清单（渲染层 / 契约共用） */
export function latestTodoOfSteps<T extends { todo?: AgentTodoItem[] }>(steps: T[] | undefined): AgentTodoItem[] | null {
  if (!steps || steps.length === 0) return null
  for (let i = steps.length - 1; i >= 0; i--) {
    const todo = steps[i]?.todo
    if (Array.isArray(todo)) return todo
  }
  return null
}
