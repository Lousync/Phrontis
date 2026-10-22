import { randomUUID } from 'crypto'
import { readJson, writeJsonOrThrow } from './jsonStore'
import {
  addWorkflowCheckpoint,
  addWorkflowStage,
  isWorkflowDate,
  normalizeWorkflow,
  removeWorkflowCheckpoint,
  removeWorkflowStage,
  reorderWorkflowStages,
  updateWorkflowCheckpoint,
  updateWorkflowStage,
  validateWorkflow,
  workflowToday,
} from '../../../src/modules/schedule/workflowPure'
import type {
  CreateScheduleWorkflowDTO,
  ScheduleStageStatus,
  ScheduleWorkflow,
  ScheduleWorkflowCheckpoint,
  ScheduleWorkflowCheckpointInput,
  ScheduleWorkflowStageInput,
  UpdateScheduleWorkflowDTO,
} from '../../../src/types'

const MOD = 'modules/schedule'
const FILE = 'workflows.json'

function isStatus(value: unknown): value is ScheduleStageStatus {
  return value === 'planned' || value === 'doing' || value === 'done'
}

function checkpointRow(input: ScheduleWorkflowCheckpointInput, stageStart: string, stageEnd: string): ScheduleWorkflowCheckpoint {
  const start = isWorkflowDate(input.start) ? input.start : stageStart
  const end = isWorkflowDate(input.end) ? input.end : start
  return {
    id: typeof input.id === 'string' && input.id.trim() ? input.id : randomUUID(),
    title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : '检查点',
    start,
    end: end < start ? start : (end > stageEnd ? stageEnd : end),
    status: isStatus(input.status) ? input.status : 'planned',
  }
}

function stageRow(input: ScheduleWorkflowStageInput, index: number, fallbackStart: string) {
  const start = isWorkflowDate(input.start) ? input.start : fallbackStart
  const end = isWorkflowDate(input.end) ? input.end : start
  return {
    id: typeof input.id === 'string' && input.id.trim() ? input.id : randomUUID(),
    title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : `阶段 ${index + 1}`,
    start,
    end,
    status: isStatus(input.status) ? input.status : 'planned',
    milestone: input.milestone === true,
    checkpoints: Array.isArray(input.checkpoints)
      ? input.checkpoints.map((cp) => checkpointRow(cp, start, end < start ? start : end))
      : [],
  }
}

export function vaultWorkflowsAll(): ScheduleWorkflow[] {
  const rows = readJson<unknown>(MOD, FILE, [])
  return Array.isArray(rows) ? (rows as ScheduleWorkflow[]) : []
}

export function vaultWorkflowsSave(rows: ScheduleWorkflow[]): void {
  writeJsonOrThrow(MOD, FILE, rows)
}

export function vaultWorkflowById(id: string): ScheduleWorkflow | null {
  return vaultWorkflowsAll().find((w) => w.id === id) ?? null
}

export function vaultWorkflowByTask(taskId: string): ScheduleWorkflow | null {
  return vaultWorkflowsAll().find((w) => w.taskId === taskId) ?? null
}

export function vaultWorkflowsByTaskIds(taskIds: string[]): ScheduleWorkflow[] {
  const ids = new Set(taskIds)
  return vaultWorkflowsAll().filter((w) => !!w.taskId && ids.has(w.taskId))
}

function assertTaskFree(rows: ScheduleWorkflow[], taskId: string | null, exceptId?: string): void {
  if (!taskId) return
  if (rows.some((w) => w.taskId === taskId && w.id !== exceptId)) {
    throw new Error('任务已绑定工作流')
  }
}

function saveOne(rows: ScheduleWorkflow[], flow: ScheduleWorkflow): ScheduleWorkflow {
  const next = { ...flow, updatedAt: new Date().toISOString() }
  const index = rows.findIndex((w) => w.id === next.id)
  if (index < 0) rows.push(next)
  else rows[index] = next
  vaultWorkflowsSave(rows)
  return next
}

function assertExpected(row: ScheduleWorkflow, expectedUpdatedAt?: string): void {
  if (expectedUpdatedAt && row.updatedAt !== expectedUpdatedAt) {
    throw new Error('WORKFLOW_CONFLICT')
  }
}

export function vaultCreateWorkflow(input: CreateScheduleWorkflowDTO): ScheduleWorkflow {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) throw new Error('标题不能为空')
  const rows = vaultWorkflowsAll()
  const taskId = typeof input.taskId === 'string' && input.taskId.trim() ? input.taskId : null
  assertTaskFree(rows, taskId)
  const now = new Date().toISOString()
  const start = isWorkflowDate(input.start) ? input.start : workflowToday()
  const stageInputs = Array.isArray(input.stages) ? input.stages : []
  const flow = normalizeWorkflow({
    id: randomUUID(),
    title,
    taskId,
    tagId: typeof input.tagId === 'string' && input.tagId.trim() ? input.tagId : null,
    color: typeof input.color === 'string' && input.color.trim() ? input.color : '#6b7280',
    start,
    end: isWorkflowDate(input.end) ? input.end : start,
    stages: stageInputs.map((s, i) => stageRow(s, i, start)),
    createdAt: now,
    updatedAt: now,
  })
  const validation = validateWorkflow(flow)
  if (!validation.ok) throw new Error(validation.errors[0] || '工作流数据非法')
  rows.push(flow)
  vaultWorkflowsSave(rows)
  return flow
}

export function vaultUpdateWorkflow(
  id: string,
  patch: UpdateScheduleWorkflowDTO,
  expectedUpdatedAt?: string,
): ScheduleWorkflow {
  const rows = vaultWorkflowsAll()
  const row = rows.find((w) => w.id === id)
  if (!row) throw new Error('工作流不存在')
  assertExpected(row, expectedUpdatedAt)
  const taskId = patch.taskId === undefined
    ? row.taskId
    : (typeof patch.taskId === 'string' && patch.taskId.trim() ? patch.taskId : null)
  if (taskId !== row.taskId) assertTaskFree(rows, taskId, id)
  const next = normalizeWorkflow({
    ...row,
    title: typeof patch.title === 'string' && patch.title.trim() ? patch.title.trim() : row.title,
    taskId,
    tagId: patch.tagId === undefined
      ? row.tagId
      : (typeof patch.tagId === 'string' && patch.tagId.trim() ? patch.tagId : null),
    color: typeof patch.color === 'string' && patch.color.trim() ? patch.color : row.color,
    start: isWorkflowDate(patch.start) ? patch.start : row.start,
    end: isWorkflowDate(patch.end) ? patch.end : row.end,
  })
  return saveOne(rows, next)
}

export function vaultDeleteWorkflow(id: string): boolean {
  const rows = vaultWorkflowsAll()
  const next = rows.filter((w) => w.id !== id)
  if (next.length === rows.length) return false
  vaultWorkflowsSave(next)
  return true
}

export function vaultDeleteWorkflowsByTask(taskId: string): boolean {
  if (!taskId) return false
  const rows = vaultWorkflowsAll()
  const next = rows.filter((w) => w.taskId !== taskId)
  if (next.length === rows.length) return false
  vaultWorkflowsSave(next)
  return true
}

function mutateWorkflow(id: string, mutate: (flow: ScheduleWorkflow) => ScheduleWorkflow): ScheduleWorkflow {
  const rows = vaultWorkflowsAll()
  const row = rows.find((w) => w.id === id)
  if (!row) throw new Error('工作流不存在')
  return saveOne(rows, normalizeWorkflow(mutate(row)))
}

export function vaultAddWorkflowStage(workflowId: string, input: ScheduleWorkflowStageInput): ScheduleWorkflow {
  return mutateWorkflow(workflowId, (flow) => addWorkflowStage(flow, { ...input, id: input.id || randomUUID() }))
}

export function vaultUpdateWorkflowStage(
  workflowId: string,
  stageId: string,
  patch: ScheduleWorkflowStageInput,
  expectedUpdatedAt?: string,
): ScheduleWorkflow {
  const current = vaultWorkflowById(workflowId)
  if (!current) throw new Error('工作流不存在')
  assertExpected(current, expectedUpdatedAt)
  return mutateWorkflow(workflowId, (flow) => updateWorkflowStage(flow, stageId, patch))
}

export function vaultDeleteWorkflowStage(workflowId: string, stageId: string): ScheduleWorkflow {
  return mutateWorkflow(workflowId, (flow) => removeWorkflowStage(flow, stageId))
}

export function vaultReorderWorkflowStages(workflowId: string, orderedIds: string[]): ScheduleWorkflow {
  return mutateWorkflow(workflowId, (flow) => reorderWorkflowStages(flow, orderedIds))
}

export function vaultAddWorkflowCheckpoint(
  workflowId: string,
  stageId: string,
  input: ScheduleWorkflowCheckpointInput,
): ScheduleWorkflow {
  return mutateWorkflow(workflowId, (flow) => addWorkflowCheckpoint(flow, stageId, { ...input, id: input.id || randomUUID() }))
}

export function vaultUpdateWorkflowCheckpoint(
  workflowId: string,
  stageId: string,
  checkpointId: string,
  patch: ScheduleWorkflowCheckpointInput,
): ScheduleWorkflow {
  return mutateWorkflow(workflowId, (flow) => updateWorkflowCheckpoint(flow, stageId, checkpointId, patch))
}

export function vaultDeleteWorkflowCheckpoint(
  workflowId: string,
  stageId: string,
  checkpointId: string,
): ScheduleWorkflow {
  return mutateWorkflow(workflowId, (flow) => removeWorkflowCheckpoint(flow, stageId, checkpointId))
}
