import type {
  ScheduleStageStatus,
  ScheduleWorkflow,
  ScheduleWorkflowCheckpoint,
  ScheduleWorkflowCheckpointInput,
  ScheduleWorkflowStage,
  ScheduleWorkflowStageInput,
} from '../../types'

export const STAGE_STATUSES = ['planned', 'doing', 'done'] as const
export const DEFAULT_WORKFLOW_COLOR = '#6b7280'
const DAY_MS = 86400000
let idSeq = 0

export interface StageSeed {
  title: string
  start: string
  end: string
}

export interface WorkflowTaskLike {
  id?: string
  title: string
  date: string
  time: string | null
}

function nextId(prefix: string): string {
  idSeq += 1
  return `${prefix}_${Date.now().toString(36)}_${idSeq.toString(36)}`
}

export function isWorkflowDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export function workflowToday(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function addWorkflowDays(date: string, days: number): string {
  if (!isWorkflowDate(date)) return date
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10)
}

function daysBetween(start: string, end: string): number {
  if (!isWorkflowDate(start) || !isWorkflowDate(end)) return 0
  return Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / DAY_MS)
}

function isStatus(value: unknown): value is ScheduleStageStatus {
  return value === 'planned' || value === 'doing' || value === 'done'
}

function statusOf(value: unknown): ScheduleStageStatus {
  return isStatus(value) ? value : 'planned'
}

export function stageDuration(stage: Pick<ScheduleWorkflowStage, 'start' | 'end'>): number {
  if (!isWorkflowDate(stage.start) || !isWorkflowDate(stage.end)) return 1
  const span = daysBetween(stage.start, stage.end)
  return span < 0 ? 1 : span + 1
}

function normalizeCheckpoint(
  raw: ScheduleWorkflowCheckpointInput | ScheduleWorkflowCheckpoint,
  stageStart: string,
  stageEnd: string,
): ScheduleWorkflowCheckpoint {
  let start = isWorkflowDate(raw.start) ? raw.start : stageStart
  let end = isWorkflowDate(raw.end) ? raw.end : start
  if (start < stageStart) start = stageStart
  if (start > stageEnd) start = stageEnd
  if (end < start) end = start
  if (end > stageEnd) end = stageEnd
  if (end < start) end = start
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : nextId('cp'),
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : '检查点',
    start,
    end,
    status: statusOf(raw.status),
  }
}

function normalizeStageBody(raw: ScheduleWorkflowStageInput | ScheduleWorkflowStage): Omit<ScheduleWorkflowStage, 'start' | 'end' | 'checkpoints'> & { requestedStart: string; checkpoints: ScheduleWorkflowCheckpointInput[] } {
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : nextId('stage'),
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : '未命名阶段',
    status: statusOf(raw.status),
    milestone: raw.milestone === true,
    requestedStart: isWorkflowDate(raw.start) ? raw.start : '',
    checkpoints: Array.isArray(raw.checkpoints) ? raw.checkpoints : [],
  }
}

function expandRange(flowStart: string, flowEnd: string, stages: ScheduleWorkflowStage[]): { start: string; end: string } {
  const validStart = isWorkflowDate(flowStart) ? flowStart : (stages[0]?.start || workflowToday())
  const validEnd = isWorkflowDate(flowEnd) ? flowEnd : (stages[stages.length - 1]?.end || validStart)
  const first = stages[0]
  const last = stages[stages.length - 1]
  const start = first && first.start < validStart ? first.start : validStart
  let end = last && last.end > validEnd ? last.end : validEnd
  if (end < start) end = start
  return { start, end }
}

export function normalizeWorkflow(flow: ScheduleWorkflow): ScheduleWorkflow {
  const rawStages = Array.isArray(flow.stages) ? flow.stages : []
  const stages: ScheduleWorkflowStage[] = []
  let cursor: string | null = null

  for (const raw of rawStages) {
    if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) continue
    const body = normalizeStageBody(raw)
    const duration = stageDuration(raw)
    let start = body.requestedStart || (cursor ? addWorkflowDays(cursor, 1) : (isWorkflowDate(flow.start) ? flow.start : workflowToday()))
    if (cursor && start <= cursor) start = addWorkflowDays(cursor, 1)
    const end = addWorkflowDays(start, duration - 1)
    stages.push({
      id: body.id,
      title: body.title,
      start,
      end,
      status: body.status,
      milestone: body.milestone,
      checkpoints: body.checkpoints
        .filter((cp): cp is ScheduleWorkflowCheckpointInput | ScheduleWorkflowCheckpoint => !!cp && typeof cp === 'object')
        .map((cp) => normalizeCheckpoint(cp, start, end)),
    })
    cursor = end
  }

  const range = expandRange(flow.start, flow.end, stages)
  return {
    ...flow,
    title: typeof flow.title === 'string' && flow.title.trim() ? flow.title.trim() : '未命名工作流',
    taskId: typeof flow.taskId === 'string' && flow.taskId.trim() ? flow.taskId : null,
    tagId: typeof flow.tagId === 'string' && flow.tagId.trim() ? flow.tagId : null,
    color: typeof flow.color === 'string' && flow.color.trim() ? flow.color : DEFAULT_WORKFLOW_COLOR,
    start: range.start,
    end: range.end,
    stages,
  }
}

function reflowFrom(flow: ScheduleWorkflow, index: number): ScheduleWorkflow {
  const stages = flow.stages.map((s) => ({ ...s, checkpoints: s.checkpoints.map((c) => ({ ...c })) }))
  let cursor = stages[index]?.end
  if (!cursor) return normalizeWorkflow(flow)
  for (let i = index + 1; i < stages.length; i += 1) {
    const duration = stageDuration(stages[i])
    const start = addWorkflowDays(cursor, 1)
    const end = addWorkflowDays(start, duration - 1)
    stages[i] = {
      ...stages[i],
      start,
      end,
      checkpoints: stages[i].checkpoints.map((cp) => normalizeCheckpoint(cp, start, end)),
    }
    cursor = end
  }
  return normalizeWorkflow({ ...flow, stages })
}

export function reorderWorkflowStages(flow: ScheduleWorkflow, orderedIds: string[]): ScheduleWorkflow {
  const currentIds = flow.stages.map((s) => s.id)
  if (orderedIds.length !== currentIds.length) return normalizeWorkflow(flow)
  if (new Set(orderedIds).size !== orderedIds.length) return normalizeWorkflow(flow)
  if (orderedIds.some((id) => !currentIds.includes(id))) return normalizeWorkflow(flow)

  const byId = new Map(flow.stages.map((s) => [s.id, s]))
  let cursor = isWorkflowDate(flow.start) ? flow.start : (flow.stages[0]?.start || workflowToday())
  const stages: ScheduleWorkflowStage[] = []
  for (const id of orderedIds) {
    const raw = byId.get(id)!
    const duration = stageDuration(raw)
    const start = cursor
    const end = addWorkflowDays(start, duration - 1)
    stages.push({
      ...raw,
      start,
      end,
      checkpoints: raw.checkpoints.map((cp) => normalizeCheckpoint(cp, start, end)),
    })
    cursor = addWorkflowDays(end, 1)
  }
  return normalizeWorkflow({ ...flow, stages })
}

export function updateWorkflowStage(
  flow: ScheduleWorkflow,
  stageId: string,
  patch: ScheduleWorkflowStageInput,
): ScheduleWorkflow {
  const index = flow.stages.findIndex((s) => s.id === stageId)
  if (index < 0) return normalizeWorkflow(flow)
  const old = flow.stages[index]
  const oldDuration = stageDuration(old)
  const dateChanged = patch.start !== undefined || patch.end !== undefined

  let start = isWorkflowDate(patch.start) ? patch.start : old.start
  let end = isWorkflowDate(patch.end) ? patch.end : old.end
  if (patch.start !== undefined && patch.end === undefined) end = addWorkflowDays(start, oldDuration - 1)
  if (patch.end !== undefined && patch.start === undefined && end < start) end = addWorkflowDays(start, oldDuration - 1)
  if (end < start) end = addWorkflowDays(start, oldDuration - 1)

  if (index > 0) {
    const prevEnd = flow.stages[index - 1].end
    if (start <= prevEnd) {
      start = addWorkflowDays(prevEnd, 1)
      end = addWorkflowDays(start, Math.max(1, stageDuration({ start: patch.start || old.start, end: patch.end || old.end })) - 1)
    }
  }

  const stages = flow.stages.map((stage, i) => {
    if (i !== index) return stage
    return {
      ...stage,
      title: typeof patch.title === 'string' && patch.title.trim() ? patch.title.trim() : stage.title,
      status: isStatus(patch.status) ? patch.status : stage.status,
      milestone: patch.milestone === undefined ? stage.milestone : patch.milestone === true,
      start,
      end,
      checkpoints: stage.checkpoints.map((cp) => normalizeCheckpoint(cp, start, end)),
    }
  })

  const next = normalizeWorkflow({ ...flow, stages })
  return dateChanged ? reflowFrom(next, index) : next
}

export function addWorkflowStage(flow: ScheduleWorkflow, input: ScheduleWorkflowStageInput = {}): ScheduleWorkflow {
  const last = flow.stages[flow.stages.length - 1]
  const defaultStart = last
    ? addWorkflowDays(last.end, 1)
    : (isWorkflowDate(flow.end) ? flow.end : (isWorkflowDate(flow.start) ? flow.start : workflowToday()))
  let start = isWorkflowDate(input.start) ? input.start : defaultStart
  let end = isWorkflowDate(input.end) ? input.end : addWorkflowDays(start, 2)
  if (end < start) end = addWorkflowDays(start, 2)

  const stage: ScheduleWorkflowStage = {
    id: typeof input.id === 'string' && input.id.trim() ? input.id : nextId('stage'),
    title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : `阶段 ${flow.stages.length + 1}`,
    start,
    end,
    status: statusOf(input.status),
    milestone: input.milestone === true,
    checkpoints: Array.isArray(input.checkpoints)
      ? input.checkpoints.map((cp) => normalizeCheckpoint(cp, start, end))
      : [],
  }
  return normalizeWorkflow({ ...flow, stages: [...flow.stages, stage] })
}

export function removeWorkflowStage(flow: ScheduleWorkflow, stageId: string): ScheduleWorkflow {
  return normalizeWorkflow({ ...flow, stages: flow.stages.filter((s) => s.id !== stageId) })
}

export function addWorkflowCheckpoint(
  flow: ScheduleWorkflow,
  stageId: string,
  input: ScheduleWorkflowCheckpointInput = {},
): ScheduleWorkflow {
  const stages = flow.stages.map((stage) => {
    if (stage.id !== stageId) return stage
    const checkpoint = normalizeCheckpoint(
      {
        id: input.id,
        title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : '检查点',
        start: isWorkflowDate(input.start) ? input.start : stage.start,
        end: isWorkflowDate(input.end) ? input.end : (isWorkflowDate(input.start) ? input.start : stage.start),
        status: input.status,
      },
      stage.start,
      stage.end,
    )
    return { ...stage, checkpoints: [...stage.checkpoints, checkpoint] }
  })
  return normalizeWorkflow({ ...flow, stages })
}

export function updateWorkflowCheckpoint(
  flow: ScheduleWorkflow,
  stageId: string,
  checkpointId: string,
  patch: ScheduleWorkflowCheckpointInput,
): ScheduleWorkflow {
  const stages = flow.stages.map((stage) => {
    if (stage.id !== stageId) return stage
    return {
      ...stage,
      checkpoints: stage.checkpoints.map((cp) => {
        if (cp.id !== checkpointId) return cp
        return normalizeCheckpoint({
          id: cp.id,
          title: typeof patch.title === 'string' && patch.title.trim() ? patch.title.trim() : cp.title,
          start: isWorkflowDate(patch.start) ? patch.start : cp.start,
          end: isWorkflowDate(patch.end) ? patch.end : cp.end,
          status: isStatus(patch.status) ? patch.status : cp.status,
        }, stage.start, stage.end)
      }),
    }
  })
  return normalizeWorkflow({ ...flow, stages })
}

export function removeWorkflowCheckpoint(
  flow: ScheduleWorkflow,
  stageId: string,
  checkpointId: string,
): ScheduleWorkflow {
  const stages = flow.stages.map((stage) => stage.id === stageId
    ? { ...stage, checkpoints: stage.checkpoints.filter((cp) => cp.id !== checkpointId) }
    : stage)
  return normalizeWorkflow({ ...flow, stages })
}

export function workflowProgress(flow: ScheduleWorkflow): { done: number; total: number; pct: number } {
  const total = flow.stages.length
  const done = flow.stages.filter((s) => s.status === 'done').length
  return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) }
}

export function splitRangeIntoStages(start: string, end: string, count = 3): StageSeed[] {
  const safeStart = isWorkflowDate(start) ? start : workflowToday()
  const safeEnd = isWorkflowDate(end) ? end : safeStart
  const n = Math.max(1, Math.min(20, Math.round(count) || 1))
  const requestedDays = daysBetween(safeStart, safeEnd) + 1
  const total = Math.max(n, requestedDays)
  const base = Math.floor(total / n)
  const remainder = total % n
  const seeds: StageSeed[] = []
  let cursor = safeStart
  for (let i = 0; i < n; i += 1) {
    const duration = base + (i < remainder ? 1 : 0)
    const stageEnd = addWorkflowDays(cursor, duration - 1)
    seeds.push({ title: `阶段 ${i + 1}`, start: cursor, end: stageEnd })
    cursor = addWorkflowDays(stageEnd, 1)
  }
  return seeds
}

export function buildWorkflowFromTask(
  task: WorkflowTaskLike,
  tag: { id?: string; color: string } | null = null,
  now = new Date().toISOString(),
): ScheduleWorkflow {
  const deadline = typeof task.time === 'string' && isWorkflowDate(task.time.slice(0, 10))
    ? task.time.slice(0, 10)
    : ''
  const start = isWorkflowDate(task.date) ? task.date : (deadline || workflowToday())
  const end = deadline && deadline >= start ? deadline : addWorkflowDays(start, 27)
  const titles = ['准备', '执行', '收尾']
  const seeds = splitRangeIntoStages(start, end, 3)
  return normalizeWorkflow({
    id: nextId('wf'),
    title: task.title.trim() || '未命名工作流',
    taskId: task.id?.trim() || null,
    tagId: tag?.id?.trim() || null,
    color: tag?.color || DEFAULT_WORKFLOW_COLOR,
    start,
    end,
    stages: seeds.map((seed, i) => ({
      id: nextId('stage'),
      title: titles[i] || `阶段 ${i + 1}`,
      start: seed.start,
      end: seed.end,
      status: i === 0 ? 'doing' : 'planned',
      milestone: i === seeds.length - 1,
      checkpoints: [],
    })),
    createdAt: now,
    updatedAt: now,
  })
}

export function validateWorkflow(flow: ScheduleWorkflow): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  if (!flow.title.trim()) errors.push('标题不能为空')
  if (!isWorkflowDate(flow.start)) errors.push('工作流开始日期非法')
  if (!isWorkflowDate(flow.end)) errors.push('工作流结束日期非法')
  if (isWorkflowDate(flow.start) && isWorkflowDate(flow.end) && flow.end < flow.start) errors.push('工作流结束日期早于开始日期')

  const ids = new Set<string>()
  let prevEnd = ''
  for (const stage of flow.stages) {
    if (!stage.id.trim()) errors.push('阶段 id 不能为空')
    if (ids.has(stage.id)) errors.push(`阶段 id 重复：${stage.id}`)
    ids.add(stage.id)
    if (!stage.title.trim()) errors.push(`阶段标题为空：${stage.id}`)
    if (!isWorkflowDate(stage.start) || !isWorkflowDate(stage.end)) errors.push(`阶段日期非法：${stage.title}`)
    if (isWorkflowDate(stage.start) && isWorkflowDate(stage.end) && stage.end < stage.start) errors.push(`阶段结束日期早于开始日期：${stage.title}`)
    if (prevEnd && stage.start <= prevEnd) errors.push(`阶段日期重叠：${stage.title}`)
    prevEnd = stage.end
    for (const cp of stage.checkpoints) {
      if (!cp.id.trim()) errors.push('检查点 id 不能为空')
      if (ids.has(cp.id)) errors.push(`检查点 id 重复：${cp.id}`)
      ids.add(cp.id)
      if (!isWorkflowDate(cp.start) || !isWorkflowDate(cp.end)) errors.push(`检查点日期非法：${cp.title}`)
      if (isWorkflowDate(cp.start) && cp.start < stage.start) errors.push(`检查点早于阶段开始：${cp.title}`)
      if (isWorkflowDate(cp.end) && cp.end > stage.end) errors.push(`检查点晚于阶段结束：${cp.title}`)
      if (isWorkflowDate(cp.start) && isWorkflowDate(cp.end) && cp.end < cp.start) errors.push(`检查点结束早于开始：${cp.title}`)
    }
  }
  if (flow.stages[0] && isWorkflowDate(flow.start) && flow.start > flow.stages[0].start) errors.push('工作流范围未覆盖首个阶段')
  if (flow.stages.length > 0 && isWorkflowDate(flow.end) && flow.end < flow.stages[flow.stages.length - 1].end) errors.push('工作流范围未覆盖最后阶段')
  return { ok: errors.length === 0, errors }
}
