/**
 * 日程模块与工作台外壳的事件桥（日程 AI 化 P1）。
 *
 * 「＋ 一句话加任务」要展开**工作台右栏**并切到「🗓 日程助手」Tab —— 而右栏折叠时
 * 整个 WorkbenchRightPanel 是卸载的（ResizablePanel 只渲染 visible 子节点），
 * 故与记账同款：中央模块只派发事件，由 App 层监听并改 workbenchLayout。
 */
export const SCHEDULE_OPEN_ASSISTANT_EVENT = 'kb-schedule-open-assistant'

/** 中央「＋ 一句话加任务」→ 展开右栏 + 切到日程助手 Tab（并聚焦输入，由面板挂载时自理） */
export function requestScheduleAssistant(): void {
  window.dispatchEvent(new CustomEvent(SCHEDULE_OPEN_ASSISTANT_EVENT))
}

// ===== 排期预览卡（助手消息里的 ```schedule-preview 围栏）=====
/** 卡上「确认排入」→ 面板代发一条确认消息，模型据上一条预览落盘 */
export const SCHEDULE_PREVIEW_CONFIRM_EVENT = 'kb-schedule-preview-confirm'
/** 卡上「调整」→ 面板聚焦输入并预填一句微调指令 */
export const SCHEDULE_PREVIEW_ADJUST_EVENT = 'kb-schedule-preview-adjust'
/** 卡上「打开周日程」→ 日程模块切到「周日程」视图（不自动切，由用户点触发） */
export const SCHEDULE_OPEN_WEEK_EVENT = 'kb-schedule-open-week'

export function requestSchedulePreviewConfirm(): void {
  window.dispatchEvent(new CustomEvent(SCHEDULE_PREVIEW_CONFIRM_EVENT))
}
export function requestSchedulePreviewAdjust(): void {
  window.dispatchEvent(new CustomEvent(SCHEDULE_PREVIEW_ADJUST_EVENT))
}
export function requestScheduleOpenWeek(): void {
  window.dispatchEvent(new CustomEvent(SCHEDULE_OPEN_WEEK_EVENT))
}
