/**
 * 支线旁问 · 派生元数据（纯函数，零依赖；供 agentService 与契约脚本 import）。
 * 见 .claude/plans/ai-teaching-side-lane-center.md §4.2。
 */

export type LaneStatus = 'run' | 'done' | 'cut'

/**
 * 未读判定：有消息 且 存在 AI 回答 且（从未打开 或 最近一条 AI 回答晚于上次打开）。
 * 时间串同格式（`YYYY-MM-DD HH:MM:SS`）可直接**字典序**比较，无需解析。
 */
export function computeLaneUnread(m: {
  hasMessages: boolean
  lastAssistantAt?: string
  laneSeenAt?: string
}): boolean {
  if (!m.hasMessages) return false
  if (!m.lastAssistantAt) return false
  if (!m.laneSeenAt) return true
  return m.lastAssistantAt > m.laneSeenAt
}

/**
 * 运行态：生成中恒为 `run`；否则存储字段（`done` / `cut` 权威）优先；
 * 缺省按末条角色兜底（AI → `done`，用户 → `run`）。
 */
export function deriveLaneStatus(
  stored: LaneStatus | undefined,
  lastRole: 'user' | 'assistant' | '',
  generating = false,
): LaneStatus {
  if (generating) return 'run'
  if (stored === 'done' || stored === 'cut') return stored
  if (lastRole === 'assistant') return 'done'
  return 'run'
}
