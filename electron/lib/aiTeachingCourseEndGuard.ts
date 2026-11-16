/**
 * AI教学 · 结课只读守卫（叶子模块，只依赖工作区元数据与会话表）。
 *
 * 单独成文件的原因：`aiTeachingCourse`（业务写接口）与 `aiTeachingCourseEnd`（结课动作）
 * 都要用守卫，守卫若写在任一模块里会形成循环 import。这里只读 `workspaces.json`，不写盘。
 */

import { getAgentSession } from './agentSessionRepo'
import { getWorkspaceEndedAt, getWorkspaceOfSession } from './aiTeachingWorkspaces'

export const COURSE_ENDED_ERROR = '课程已结课，请重新开课'

/** 工作区是否已结课（工作区不存在 = false，让调用方走原有「工作区不存在」错误） */
export function isCourseEnded(wsId: string): boolean {
  return !!wsId && !!getWorkspaceEndedAt(wsId)
}

/** 业务写接口入口守卫：已结课直接抛（读函数不调用本函数） */
export function assertWorkspaceEditable(wsId: string): void {
  if (isCourseEnded(wsId)) throw new Error(COURSE_ENDED_ERROR)
}

/**
 * 会话 → 工作区的结课守卫。
 * - 支线会话取父会话的归属（与 `listSideLanes` 的归属口径一致）；
 * - 无归属（自由对话 / 侧边助手）放行；
 * - 工作区已结课 → 抛错。
 */
export function assertCourseEditableBySession(sessionId: string): void {
  const sid = String(sessionId ?? '')
  if (!sid) return
  let owner = getWorkspaceOfSession(sid)
  if (!owner) {
    const row = getAgentSession(sid)
    const parent = row?.parentSessionId
    if (parent) owner = getWorkspaceOfSession(parent) ?? getWorkspaceOfSession(sid)
  }
  if (owner && getWorkspaceEndedAt(owner)) throw new Error(COURSE_ENDED_ERROR)
}
