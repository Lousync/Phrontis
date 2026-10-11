/**
 * 排期预览卡的纯函数层（日程 AI 化 P1）—— 零依赖，专供契约脚本 import
 * （`.AGENT/scripts/schedule/verify-schedule-assistant.mjs`；同 accountingPure.ts 的口径）。
 */

export interface SchedulePreviewItem { date: string; start: string; end: string; title: string }
export interface SchedulePreviewData { title?: string; items: SchedulePreviewItem[] }

/**
 * 解析 ```schedule-preview 围栏内的 JSON；非法返回 null（调用方回退普通代码块）。
 * 规则：date 必须是 YYYY-MM-DD、title 非空；start/end 可为空串（无时段）。至少 1 条。
 */
export function parseSchedulePreviewFence(src: string): SchedulePreviewData | null {
  try {
    const obj = JSON.parse(src.trim()) as unknown
    if (!obj || typeof obj !== 'object') return null
    const rawItems = (obj as { items?: unknown }).items
    if (!Array.isArray(rawItems) || rawItems.length === 0) return null
    const items: SchedulePreviewItem[] = []
    for (const it of rawItems) {
      if (!it || typeof it !== 'object') continue
      const o = it as Record<string, unknown>
      const date = typeof o.date === 'string' ? o.date : ''
      const title = typeof o.title === 'string' ? o.title.trim() : ''
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !title) continue
      items.push({
        date,
        title,
        start: typeof o.start === 'string' ? o.start : '',
        end: typeof o.end === 'string' ? o.end : '',
      })
    }
    if (items.length === 0) return null
    const title = typeof (obj as { title?: unknown }).title === 'string' ? String((obj as { title?: unknown }).title) : undefined
    return { title, items }
  } catch { return null }
}
