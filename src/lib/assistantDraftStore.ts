/**
 * AI 助手输入草稿仓库（2026-10-27，B-45）。
 *
 * 为什么是模块级单例：输入框草稿属于「会话」，不属于某个宿主。完整 AI 助手模块、
 * 右侧栏 / 悬浮侧栏、AI 对话页、日程助手、情报助手都可能同时挂载；放在各自的
 * useState 里就会出现「切会话串台」和「同一会话换个入口草稿消失」。
 *
 * 边界：
 * - **只在本次运行内保留**（内存 Map，不落盘、不走 IPC）；退出应用即丢弃。
 * - 会话 key 带 source：`session:<source>:<id>`；新会话草稿也带 source，避免日程 /
 *   情报的「空白页草稿」串进通用助手。
 * - 空字符串 = 删除，避免为每个看过但没输入的会话留空条目。
 *
 * 订阅模型：useAssistantChat 用 useSyncExternalStore 读取当前 key 的快照；任一草稿
 * 变化都会通知订阅者，宿主各自按自己的 activeId 取快照（别的会话变化不会改自己的值）。
 */

type Listener = () => void

const drafts = new Map<string, string>()
const listeners = new Set<Listener>()

/** 会话草稿 key：source 参与命名，跨来源绝不共用 */
export function draftKeyForSession(sessionId: string, source: string): string {
  return `session:${source}:${sessionId}`
}

/** 「还没有活动会话」时的草稿 key：按 source 隔离 */
export function draftKeyForNew(source: string): string {
  return `new:${source}`
}

export function getDraft(key: string): string {
  return drafts.get(key) ?? ''
}

function emit(): void {
  for (const listener of listeners) listener()
}

export function setDraft(key: string, value: string): void {
  if ((drafts.get(key) ?? '') === value) return
  if (value) drafts.set(key, value)
  else drafts.delete(key)
  emit()
}

/** 新建会话时把「空白页草稿」搬到新会话（旧 key 删除，只通知一次） */
export function moveDraft(from: string, to: string): void {
  if (from === to) return
  const value = drafts.get(from)
  if (value === undefined) return
  drafts.delete(from)
  if (value) drafts.set(to, value)
  else drafts.delete(to)
  emit()
}

/** 删除会话时同步清掉它的草稿；没有条目时静默 */
export function deleteDraft(key: string): void {
  if (!drafts.delete(key)) return
  emit()
}

export function subscribeDrafts(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
