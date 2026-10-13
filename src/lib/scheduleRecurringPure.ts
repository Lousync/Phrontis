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
/** 加 n 天（导出给写侧结算算上界用；口径与内部同一个） */
export function addDaysTo(s: string, n: number): string { return addDays(s, n) }
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

/* ===== 星期几入参解析（2026-10-13，F-6）=====
   只给**跨进程的入参**用（AI 工具），落盘口径永远是「周一=0」那套。

   为什么要有它：工具的 schema 原来写「0=周一…6=周日」，而模型天然按 JS `Date.getDay()`
   （周日=0 … 周六=6）想事 —— 说「周六」传了 6，我们这边 6 = **周日**，整整差一天
   （实机已复现：模型在会话里自己承认「工具里 0=周一…6=周日，我填了 6，实际落在了周日」）。
   教训：**自造刻度**（0=周一）不能出现在要人/模型记住的地方 —— 本仓其它地方一律
   `(getDay()+6)%7` 现算，只有这个跨进程契约需要"记住"。

   现在的口径：主路径传**字符串**（`周六` / `星期六` / `sat`，工具 schema 里是 enum ⇒ 模型不必记数字）；
   数字仍然收，按 **ISO 1..7**（1=周一 … 6=周六、7=周日）解释，并**额外容忍 JS 的 0=周日** ——
   周一…周六 在两套刻度里**数值相同**（都是 1..6），只有「周日」是 7（ISO）/ 0（JS），两个都收
   ⇒ 无论模型按 ISO 还是按 JS 想，都不会再错位。
   非法值**不再静默夹成周一**（原来 clampInt(n,0,6,0) 会把 9 变成周一），而是回一句能照做的错误。 */
const CN_DAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }
const EN_DAY: Record<string, number> = {
  mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6, sun: 7, sunday: 7,
}
/** ISO（1=周一…7=周日，0 当周日）→ 落盘刻度（0=周一…6=周日） */
function isoToMon0(n: number): number { return n === 0 || n === 7 ? 6 : n - 1 }

export type WeekdayParseResult =
  | { ok: true; mon0: number[]; text: string }
  | { ok: false; error: string }

/** 解析 `weekdays` 入参：字符串（`周六`/`sat`）或数字（ISO 1..7，0 也当周日）都收。
 *  返回的 `mon0` 已去重排序（落盘口径），`text` 是人话（「周六」「周一、三」）—— 供工具**回显**，
 *  让模型当轮就能自查（原来返回值不回显 weekdays，模型写错了自己也不知道）。 */
export function parseScheduleWeekdays(input: unknown): WeekdayParseResult {
  const arr = Array.isArray(input) ? input : (input === undefined || input === null || input === '' ? [] : [input])
  const out: number[] = []
  for (const raw of arr) {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const n = Math.trunc(raw)
      if (n < 0 || n > 7) {
        return { ok: false, error: `weekdays 里的 ${raw} 不是合法星期：数字按 1=周一 … 6=周六、7=周日（0 也当周日），或直接传「周六」这样的字符串` }
      }
      out.push(isoToMon0(n)); continue
    }
    if (typeof raw === 'string') {
      const s = raw.trim().toLowerCase().replace(/\s+/g, '')
      const cn = /^(?:周|星期|礼拜)?([一二三四五六日天1-7])$/.exec(s)
      if (cn) {
        const k = cn[1]
        const iso = /^[1-7]$/.test(k) ? Number(k) : CN_DAY[k]
        out.push(isoToMon0(iso)); continue
      }
      const en = EN_DAY[s]
      if (en) { out.push(isoToMon0(en)); continue }
      return { ok: false, error: `weekdays 里的「${raw}」认不出是星期几：可用「周一」…「周日」，或 1=周一 … 7=周日` }
    }
    return { ok: false, error: `weekdays 只接受星期字符串（如「周六」）或数字，收到 ${JSON.stringify(raw)}` }
  }
  const mon0 = [...new Set(out)].sort((a, b) => a - b)
  return { ok: true, mon0, text: mon0.map((i) => WEEKDAY_CN[i]).join('、') }
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
