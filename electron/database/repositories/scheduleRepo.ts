import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { emitPluginEvent } from '../../lib/pluginEvents'
import { broadcastDataChanged } from '../../main/windowBus'
import * as V from '../../lib/kbStore/scheduleVaultRepo'
import * as W from '../../lib/kbStore/scheduleWorkflowVaultRepo'
import type { ScheduleRecurring } from '../../../src/lib/scheduleRecurringPure'
import type { CreateScheduleWorkflowDTO, ScheduleWorkflowCheckpointInput, ScheduleWorkflowStageInput, UpdateScheduleWorkflowDTO } from '../../../src/types'

// R6 去库化：真相源 = .knowbase/modules/schedule/*.json（sql.js 路径已移除，D9）

// ---- types ----
interface TodoRow {
  id: string; title: string; description: string | null; date: string
  time: string | null; quadrant: number; task_type: string
  tag_id: string | null; status: string; sort_order: number
  end_criteria: string | null; parent_id: string | null
  scheduled_start: number | null; scheduled_end: number | null
  snooze_until?: string | null
  recurringId?: string | null; recurringDue?: string | null
  estimate_min?: number | null
  created_at: string; updated_at: string
}

function requireId(value: unknown, label: string): value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`)
  return true
}

function rowToTodo(row: TodoRow) {
  return {
    id: row.id, title: row.title, description: row.description || '',
    date: row.date, time: row.time || null,
    quadrant: row.quadrant, taskType: row.task_type as 'deadline' | 'plan' | 'daily',
    tagId: row.tag_id, status: row.status as 'pending' | 'done',
    sortOrder: row.sort_order, endCriteria: row.end_criteria || '',
    parentId: row.parent_id || null,
    // 排期时段（当天分钟数）；旧数据缺字段 → 兜 null
    scheduledStart: typeof row.scheduled_start === 'number' ? row.scheduled_start : null,
    scheduledEnd: typeof row.scheduled_end === 'number' ? row.scheduled_end : null,
    snoozeUntil: row.snooze_until ?? null,
    // 固定日程生成物标记（渲染层画 🔁）
    recurringId: row.recurringId ?? null,
    recurringDue: row.recurringDue ?? null,
    estimateMin: typeof row.estimate_min === 'number' ? row.estimate_min : null,
    createdAt: row.created_at, updatedAt: row.updated_at
  }
}

// ---- IPC handlers ----
export function registerScheduleHandlers(): void {
  // 按日期获取待办（排除子任务）
  ipcMain.handle('schedule:getTodos', (_e, date: string) => {
    return V.vaultTodosForDate(date).map(rowToTodo)
  })

  ipcMain.handle('schedule:getAllTodos', () => {
    return V.vaultTodosAllTopLevel().map(rowToTodo)
  })

  // 获取全部逾期未完成的顶层任务（日期早于 today，不限月份；按日期升序）
  // 计划类任务（plan）无截止时间、不逾期，排除在外
  ipcMain.handle('schedule:getOverdue', (_e, today: string) => {
    if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return []
    return V.vaultOverdueTodos(today).map(rowToTodo)
  })

  // 获取某月有数据的日期列表（日历打点用）— 排除子任务
  ipcMain.handle('schedule:getDatesWithTodos', (_e, yearMonth: string) => {
    return V.vaultDatesWithTodos(yearMonth)
  })

  // 获取某月全部待办（象限图用）— 自动清理 7 天前已完成任务 — 排除子任务
  // 附加未完成的计划类任务（plan 无截止日期，跨月常驻显示直到完成）
  ipcMain.handle('schedule:getMonthTodos', (_e, yearMonth: string) => {
    // 清掉 7 天前完成的待办（含子任务）。
    // 清理是尽力而为的维护动作，且写盘失败现在会抛错（writeJsonOrThrow）——
    // 这里必须兜住，否则磁盘异常会连带把「读取当月待办」一起弄挂。
    try {
      V.vaultPurgeStaleDoneTodos()
    } catch (e) {
      console.error('[schedule] 清理过期已完成待办失败：', e)
    }
    return V.vaultMonthTodos(yearMonth).map(rowToTodo)
  })

  // 获取某个父任务的子任务
  ipcMain.handle('schedule:getSubtasks', (_e, parentId: string) => {
    return V.vaultSubtasks(parentId).map(rowToTodo)
  })

  // 日程表视图「待安排」栏：全部未排期（scheduled_start 为空）的顶层未完成任务，不限月份
  ipcMain.handle('schedule:getUnscheduledTodos', () => {
    return V.vaultUnscheduledTodos().map(rowToTodo)
  })

  // 日程表视图：某一周的任务（含区间之前「已排期未完成」的延后候选）
  ipcMain.handle('schedule:getWeekTodos', (_e, weekStart: string, weekEnd: string) => {
    if (typeof weekStart !== 'string' || typeof weekEnd !== 'string') return []
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || !/^\d{4}-\d{2}-\d{2}$/.test(weekEnd)) return []
    return V.vaultTodosForWeek(weekStart, weekEnd).map(rowToTodo)
  })

  // 获取某月截止日期的任务计数（仅未完成）
  ipcMain.handle('schedule:getDeadlineCounts', (_e, yearMonth: string) => {
    const vaultMap: Record<string, number> = {}
    for (const t of V.vaultPendingDeadlineTimes()) {
      if (!t) continue
      const d = t.slice(0, 10)
      if (d.startsWith(yearMonth)) vaultMap[d] = (vaultMap[d] || 0) + 1
    }
    return vaultMap
  })

  // 创建待办
  ipcMain.handle('schedule:createTodo', (_e, data: {
    title: string; description?: string; date: string; time?: string
    quadrant?: number; taskType?: 'deadline' | 'plan'; tagId?: string
    endCriteria?: string; parentId?: string
    scheduledStart?: number | null; scheduledEnd?: number | null
    estimateMin?: number | null
  }) => {
    const vId = randomUUID()
    const vNow = new Date().toISOString()
    const row: V.TodoRow = {
      id: vId, title: data.title, description: data.description || '', date: data.date,
      time: data.time || null, quadrant: data.quadrant ?? 1, task_type: data.taskType || 'plan',
      tag_id: data.tagId || null, status: 'pending', sort_order: 0,
      end_criteria: data.endCriteria || '', parent_id: data.parentId || null,
      scheduled_start: typeof data.scheduledStart === 'number' ? data.scheduledStart : null,
      scheduled_end: typeof data.scheduledEnd === 'number' ? data.scheduledEnd : null,
      snooze_until: null,
      estimate_min: typeof data.estimateMin === 'number' ? data.estimateMin : null,
      created_at: vNow, updated_at: vNow
    }
    const created = V.vaultCreateTodo(row)
    broadcastDataChanged('schedule')
    return rowToTodo(created)
  })

  // 更新待办
  ipcMain.handle('schedule:updateTodo', (_e, id: string, data: {
    title?: string; description?: string; date?: string; time?: string | null
    quadrant?: number; taskType?: 'deadline' | 'plan'; tagId?: string | null
    status?: string; endCriteria?: string; parentId?: string | null
    scheduledStart?: number | null; scheduledEnd?: number | null
    estimateMin?: number | null
    expectedUpdatedAt?: string
    snoozeUntil?: string | null
  }) => {
    if (data.expectedUpdatedAt) {
      const current = V.vaultFindTodo(id)
      if (!current) throw new Error('任务不存在')
      if (current.updated_at !== data.expectedUpdatedAt) throw new Error('TASK_CONFLICT')
    }
    // 状态跃迁判定：先取旧状态，只有 pending → done 才算「完成」事件
    // （改标题/象限等普通编辑也走本 handler，不能每次都触发）
    const prevStatus = data.status !== undefined ? V.vaultFindTodo(id)?.status : undefined
    const updated = V.vaultUpdateTodo(id, data, new Date().toISOString())
    if (prevStatus !== undefined && prevStatus !== 'done' && data.status === 'done' && updated) {
      emitPluginEvent('schedule:todoCompleted', { todoId: id, title: updated.title ?? '' })
    }
    if (!updated) throw new Error('任务不存在')
    broadcastDataChanged('schedule')
    return rowToTodo(updated)
  })

  // 删除待办（级联删除子任务与工作流）
  ipcMain.handle('schedule:deleteTodo', (_e, id: string) => {
    V.vaultDeleteTodoCascade(id)
    broadcastDataChanged('schedule')
  })

  // ===== 工作流 =====
  ipcMain.handle('schedule:listWorkflows', () => W.vaultWorkflowsAll())
  ipcMain.handle('schedule:getWorkflow', (_e, id: string) => requireId(id, '工作流 id') ? W.vaultWorkflowById(id) : null)
  ipcMain.handle('schedule:getWorkflowByTask', (_e, taskId: string) => requireId(taskId, '任务 id') ? W.vaultWorkflowByTask(taskId) : null)

  ipcMain.handle('schedule:createWorkflow', (_e, input: CreateScheduleWorkflowDTO) => {
    const row = W.vaultCreateWorkflow(input)
    broadcastDataChanged('schedule')
    return row
  })
  ipcMain.handle('schedule:updateWorkflow', (_e, id: string, patch: UpdateScheduleWorkflowDTO, expectedUpdatedAt?: string) => {
    requireId(id, '工作流 id')
    const row = W.vaultUpdateWorkflow(id, patch, expectedUpdatedAt)
    broadcastDataChanged('schedule')
    return row
  })
  ipcMain.handle('schedule:deleteWorkflow', (_e, id: string) => {
    requireId(id, '工作流 id')
    const ok = W.vaultDeleteWorkflow(id)
    if (ok) broadcastDataChanged('schedule')
    return ok
  })
  ipcMain.handle('schedule:addWorkflowStage', (_e, workflowId: string, input: ScheduleWorkflowStageInput) => {
    requireId(workflowId, '工作流 id')
    const row = W.vaultAddWorkflowStage(workflowId, input)
    broadcastDataChanged('schedule')
    return row
  })
  ipcMain.handle('schedule:updateWorkflowStage', (_e, workflowId: string, stageId: string, patch: ScheduleWorkflowStageInput, expectedUpdatedAt?: string) => {
    requireId(workflowId, '工作流 id')
    requireId(stageId, '阶段 id')
    const row = W.vaultUpdateWorkflowStage(workflowId, stageId, patch, expectedUpdatedAt)
    broadcastDataChanged('schedule')
    return row
  })
  ipcMain.handle('schedule:deleteWorkflowStage', (_e, workflowId: string, stageId: string) => {
    requireId(workflowId, '工作流 id')
    requireId(stageId, '阶段 id')
    const row = W.vaultDeleteWorkflowStage(workflowId, stageId)
    broadcastDataChanged('schedule')
    return row
  })
  ipcMain.handle('schedule:reorderWorkflowStages', (_e, workflowId: string, orderedIds: string[]) => {
    requireId(workflowId, '工作流 id')
    if (!Array.isArray(orderedIds) || orderedIds.some((id) => !requireId(id, '阶段 id'))) throw new Error('阶段顺序非法')
    const row = W.vaultReorderWorkflowStages(workflowId, orderedIds)
    broadcastDataChanged('schedule')
    return row
  })
  ipcMain.handle('schedule:addWorkflowCheckpoint', (_e, workflowId: string, stageId: string, input: ScheduleWorkflowCheckpointInput) => {
    requireId(workflowId, '工作流 id')
    requireId(stageId, '阶段 id')
    const row = W.vaultAddWorkflowCheckpoint(workflowId, stageId, input)
    broadcastDataChanged('schedule')
    return row
  })
  ipcMain.handle('schedule:updateWorkflowCheckpoint', (_e, workflowId: string, stageId: string, checkpointId: string, patch: ScheduleWorkflowCheckpointInput) => {
    requireId(workflowId, '工作流 id')
    requireId(stageId, '阶段 id')
    requireId(checkpointId, '检查点 id')
    const row = W.vaultUpdateWorkflowCheckpoint(workflowId, stageId, checkpointId, patch)
    broadcastDataChanged('schedule')
    return row
  })
  ipcMain.handle('schedule:deleteWorkflowCheckpoint', (_e, workflowId: string, stageId: string, checkpointId: string) => {
    requireId(workflowId, '工作流 id')
    requireId(stageId, '阶段 id')
    requireId(checkpointId, '检查点 id')
    const row = W.vaultDeleteWorkflowCheckpoint(workflowId, stageId, checkpointId)
    broadcastDataChanged('schedule')
    return row
  })

  // ===== 标签 =====
  ipcMain.handle('schedule:getTags', () => {
    return V.vaultTagsOrdered()
  })

  ipcMain.handle('schedule:createTag', (_e, name: string, color?: string) => {
    const row = V.vaultCreateTag({ id: randomUUID(), name, color: color || '#6b7280' })
    broadcastDataChanged('schedule')
    return row
  })

  ipcMain.handle('schedule:deleteTag', (_e, id: string) => {
    V.vaultDeleteTag(id)
    broadcastDataChanged('schedule')
  })

  // ===== 固定日程（recurring）=====
  /* ★ 2026-10-13（F-5）：这四条**写盘后必须广播**（铁律 1：主进程写盘后唯一刷新通道）。
     此前它们一条广播都没有 —— 日程模块只靠"自己的操作自己刷"，于是
     ① 另一个窗口 / 另一条通道（AI 工具）写进来时本窗口不知道；
     ② 周网格（TimetableView）只在"切 Tab 重取"时才看见新数据。
     顺带：建/改规则现在由 repo 层顺手结算（`settleAfterWrite`），生成出来的待办也靠这条广播到界面。 */
  ipcMain.handle('schedule:recurringList', () => V.vaultScheduleRecurringAll())
  ipcMain.handle('schedule:recurringCreate', (_e, input: V.CreateScheduleRecurringInput) => {
    const row = V.vaultScheduleCreateRecurring(input)
    broadcastDataChanged('schedule')
    return row
  })
  ipcMain.handle('schedule:recurringUpdate', (_e, id: string, patch: Partial<ScheduleRecurring>) => {
    const row = V.vaultScheduleUpdateRecurring(id, patch)
    if (row) broadcastDataChanged('schedule')
    return row
  })
  ipcMain.handle('schedule:recurringDelete', (_e, id: string) => {
    const ok = V.vaultScheduleDeleteRecurring(id)
    if (ok) broadcastDataChanged('schedule')
    return ok
  })
  ipcMain.handle('schedule:recurringSettle', () => {
    const res = V.vaultScheduleSettleRecurring()
    if (res.added > 0) broadcastDataChanged('schedule')
    return res
  })
  ipcMain.handle('schedule:recurringUndoSettle', (_e, todoIds: string[], restore: Array<{ ruleId: string; lastPostedDate: string }>) =>
    V.vaultScheduleUndoSettleRecurring(todoIds, restore))
}
