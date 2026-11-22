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

/** 跨对话旁问列表的行形状（只需筛选 / 排序用到的字段） */
export interface SideLaneListableRow {
  lane?: 'main' | 'side'
  source?: string
  updated_at: string
}

/**
 * 跨对话旁问列表的筛选 + 排序（右栏「旁问」历史页签，2026-11-22 契约）：
 * - **只留未升格的教学支线**：`lane === 'side'` && `source === 'aiTeaching'`
 *   （已升格为 `main` 的是正式会话，不属于旁问历史；非教学来源的支线不混进来）；
 * - **`updated_at` 倒序**：时间串同格式可直接字典序比较；同一时刻由稳定排序保持传入顺序。
 *
 * 纯函数、零依赖：主进程落库查询与契约脚本共用同一份口径。
 */
export function selectAllSideLanes<T extends SideLaneListableRow>(rows: T[]): T[] {
  return rows
    .filter((r) => r.lane === 'side' && r.source === 'aiTeaching')
    .sort((a, b) => (a.updated_at === b.updated_at ? 0 : a.updated_at < b.updated_at ? 1 : -1))
}
