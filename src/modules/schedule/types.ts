export {
  type ScheduleTodo,
  type ScheduleTag,
  type CreateScheduleTodoDTO,
  type UpdateScheduleTodoDTO,
  type ScheduleWorkflow,
  type ScheduleWorkflowStage,
  type ScheduleWorkflowCheckpoint,
  type ScheduleStageStatus,
  type ScheduleWorkflowStageInput,
  type ScheduleWorkflowCheckpointInput,
  type CreateScheduleWorkflowDTO,
  type UpdateScheduleWorkflowDTO,
} from '../../types'

export type ViewMode = 'week' | 'date' | 'deadline' | 'quadrant'
export type ScheduleView = 'today' | 'inbox' | 'upcoming' | 'calendar' | 'workflows' | 'canvas' | 'done' | 'tag'
export type CalendarMode = 'day' | 'week' | 'month' | 'quarter'
