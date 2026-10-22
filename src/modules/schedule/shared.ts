/**
 * 日程模块与工作台外壳的事件桥（日程 AI 化）。
 *
 * 排期预览卡 / 「打开周日程」只派发 window 事件，由日程助手面板与日程模块各自消费；
 * 日程助手本身经工作台右栏「🗓 日程助手」页签进入。
 */

// ===== 排期预览卡（助手消息里的 ```schedule-preview 围栏）=====
/** 卡上「确认排入」→ 面板代发一条确认消息，模型据上一条预览落盘 */
export const SCHEDULE_PREVIEW_CONFIRM_EVENT = 'kb-schedule-preview-confirm'
/** 卡上「调整」→ 面板聚焦输入并预填一句微调指令 */
export const SCHEDULE_PREVIEW_ADJUST_EVENT = 'kb-schedule-preview-adjust'
/** 卡上「打开周日程」→ 日程模块切到「周日程」视图（不自动切，由用户点触发） */
export const SCHEDULE_OPEN_WEEK_EVENT = 'kb-schedule-open-week'
export const SCHEDULE_OPEN_CANVAS_EVENT = 'kb-schedule-open-canvas'
export const SCHEDULE_OPEN_CALENDAR_EVENT = 'kb-schedule-open-calendar'
export const SCHEDULE_NEW_WORKFLOW_EVENT = 'kb-schedule-new-workflow'
export const SCHEDULE_NEW_TASK_EVENT = 'kb-schedule-new-task'
export const SCHEDULE_AI_PREFILL_EVENT = 'kb-schedule-ai-prefill'

export function requestSchedulePreviewConfirm(): void {
  window.dispatchEvent(new CustomEvent(SCHEDULE_PREVIEW_CONFIRM_EVENT))
}
export function requestSchedulePreviewAdjust(): void {
  window.dispatchEvent(new CustomEvent(SCHEDULE_PREVIEW_ADJUST_EVENT))
}
export function requestScheduleOpenWeek(): void {
  window.dispatchEvent(new CustomEvent(SCHEDULE_OPEN_WEEK_EVENT))
}
export function requestScheduleOpenCanvas(workflowId: string): void {
  window.dispatchEvent(new CustomEvent(SCHEDULE_OPEN_CANVAS_EVENT, { detail: { workflowId } }))
}
export function requestScheduleOpenCalendar(): void {
  window.dispatchEvent(new CustomEvent(SCHEDULE_OPEN_CALENDAR_EVENT))
}
export function requestScheduleNewWorkflow(): void {
  window.dispatchEvent(new CustomEvent(SCHEDULE_NEW_WORKFLOW_EVENT))
}
export function requestScheduleNewTask(): void {
  window.dispatchEvent(new CustomEvent(SCHEDULE_NEW_TASK_EVENT))
}
export function requestScheduleAiPrefill(text: string): void {
  window.dispatchEvent(new CustomEvent(SCHEDULE_AI_PREFILL_EVENT, { detail: { text } }))
}
