/**
 * 固定日程（重复任务）口径纯函数（零运行时依赖，供渲染层 / 主进程 / 契约脚本共用）。
 *
 * 模型：规则存 `.knowbase/modules/schedule/recurring.json`；到点由 settle 生成**普通待办**
 * （带 `recurringId` + `recurringDue` 去重键），复用现有排期/勾选/提醒/视图全链路。
 * 结算计划 = `planScheduleRecurringSettle`（幂等，纯函数）。
 */

import type { ScheduleRecurring } from '../types'
export type { ScheduleRecurring } from '../types'

/** 生成物去重所需的最小待办面 */
export interface RecurringTodoLike { recurringId?: string | null; recurringDue?: string | null }

const pad2 = (n: number): string => String(n).padStart(2, '0')
function parseDate(s: string): Date {
  const [y, m, d] = String(s).split('-').map(Number)
  return new Date(y || 1970, (m || 1) - 1, d || 1)
}
function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
function addDays(s: string, n: number): string {
  const d = parseDate(s); d.setDate(d.getDate() + n); return fmtDate(d)
}
/** 周一为 0 … 周日为 6（与规则 weekdays 口径一致） */
function weekdayMon0(d: Date): number { return (d.getDay() + 6) % 7 }
function clampDay(year: number, month: number, day: number): number {
  const last = new Date(year, month, 0).getDate()
  return Math.max(1, Math.min(day || 1, last))
}
function monthDue(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(clampDay(year, month, day))}`
}
function shiftMonth(y: number, m: number, k: number): { y: number; m: number } {
  const d = new Date(y, m - 1 + k, 1)
  return { y: d.getFullYear(), m: d.getMonth() + 1 }
}

/** 当天分钟数 → 'HH:mm' */
export function minToHm(min: number): string {
  const m = Math.max(0, Math.min(1439, Math.round(min)))
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`
}
/** 'HH:mm' → 当天分钟数（非法返回 fallback） */
export function hmToMin(hm: string, fallback = 0): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm).trim())
  if (!m) return fallback
  return Math.max(0, Math.min(1439, Number(m[1]) * 60 + Number(m[2])))
}

const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
/** 重复规则的人话标签（「每周六」「每周一、三」「每月 15 号」「每 7 天」） */
export function recurringFreqLabel(r: ScheduleRecurring): string {
  if (r.freq === 'monthly') return `每月 ${r.day || 1} 号`
  if (r.freq === 'interval') return `每 ${r.intervalDays || 1} 天`
  const wd = [...(r.weekdays || [])].sort((a, b) => a - b)
  if (wd.length === 0) return '每周'
  if (wd.length === 7) return '每天'
  return wd.map((i) => WEEKDAY_CN[i]).join('、')
}

/** 本周一（含）— 周日（含）的末日日期 */
export function endOfWeek(dateStr: string): string {
  const d = parseDate(dateStr)
  const mon0 = weekdayMon0(d)
  return addDays(dateStr, 6 - mon0)
}

export interface ScheduleRecurringDue { ruleId: string; due: string }

/**
 * 结算计划（纯函数）：列出「应生成但还没生成」的 (规则, 日期)。
 * 幂等——已有同 (recurringId, recurringDue) 的待办即跳过；只处理 enabled 规则。
 * 起点 = 规则 lastPostedDate **之后**；上界 = horizon（默认 today）；跳过 > endDate 的日期。
 */
export function planScheduleRecurringSettle(
  rules: ScheduleRecurring[],
  todos: RecurringTodoLike[],
  today: string,
  horizon?: string,
): ScheduleRecurringDue[] {
  const out: ScheduleRecurringDue[] = []
  const existing = new Set(
    todos.filter((t) => t.recurringId && t.recurringDue).map((t) => `${t.recurringId}@${t.recurringDue}`),
  )
  const upper = parseDate(horizon || today)
  for (const r of rules) {
    if (!r.enabled) continue
    const start = parseDate(r.lastPostedDate || addDays(today, -1))
    const endD = r.endDate ? parseDate(r.endDate) : null
    if (r.freq === 'monthly') {
      let { y, m } = shiftMonth(start.getFullYear(), start.getMonth() + 1, 1)
      let guard = 0
      while (guard++ < 120) {
        const due = monthDue(y, m, r.day || 1)
        const dueD = parseDate(due)
        if (dueD > upper) break
        if (dueD > start && (!endD || dueD <= endD) && !existing.has(`${r.id}@${due}`)) out.push({ ruleId: r.id, due })
        ;({ y, m } = shiftMonth(y, m, 1))
      }
    } else if (r.freq === 'interval') {
      const step = Math.max(1, r.intervalDays || 1)
      let d = parseDate(addDays(r.lastPostedDate || today, step))
      let guard = 0
      while (d <= upper && guard++ < 800) {
        const ds = fmtDate(d)
        if ((!endD || d <= endD) && !existing.has(`${r.id}@${ds}`)) out.push({ ruleId: r.id, due: ds })
        d = parseDate(addDays(ds, step))
      }
    } else {
      let d = parseDate(addDays(r.lastPostedDate || today, 1))
      let guard = 0
      while (d <= upper && guard++ < 800) {
        const ds = fmtDate(d)
        if ((r.weekdays || []).includes(weekdayMon0(d)) && (!endD || d <= endD) && !existing.has(`${r.id}@${ds}`)) out.push({ ruleId: r.id, due: ds })
        d = parseDate(addDays(ds, 1))
      }
    }
  }
  return out
}
