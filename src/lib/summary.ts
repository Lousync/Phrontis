/**
 * 周/月总结的日期窗口计算。
 *
 * 规则：
 * - 周总结：当天星期几 === 设置的周总结日 → 窗口 = 往前推 7 天（含当天）
 * - 月总结：
 *   - first（每月第一天）→ 窗口 = 上一个完整自然月
 *   - last（每月最后一天）→ 窗口 = 当前自然月（1 号 ~ 当天）
 *   - fixed（每月固定第 N 天，N 夹取到 1-28）→ 窗口 = 近 30 天（含当天）
 * - 若同一天同时命中周总结与月总结，月总结优先
 */

export interface PeriodWindow {
  type: 'week' | 'month'
  start: string
  end: string
  /** 面板标题，如「周总结(08.17 ~ 08.23)」「2026年8月月总结」 */
  label: string
  /** 下期任务的落日（总结日的下一天） */
  nextDate: string
}

/** 总结层级：周 / 月 / 年 —— 总结文件、窗口函数与联动标签共用这一个联合类型 */
export type SummaryKind = 'week' | 'month' | 'year'

/** 周/月/年总结联动任务标签：总结里新建的任务自带「周任务 / 月任务 / 年任务」 */
export const SUMMARY_TAG_DEFS: Record<SummaryKind, { name: string; color: string }> = {
  week: { name: '周任务', color: '#8b5cf6' },
  month: { name: '月任务', color: '#0ea5e9' },
  year: { name: '年任务', color: '#f59e0b' },
}

/**
 * 判断是否为「来源标签」（周任务/月任务）。
 * 这些标签表达的是任务来源（来自周/月总结），不是用户的分类维度：
 * 在标签管理器中锁定不可删、在任务编辑的标签选择器中隐藏，仅作为来源徽章显示在任务卡片上。
 */
export function isSummaryTagName(name: string): boolean {
  return Object.values(SUMMARY_TAG_DEFS).some(d => d.name === name)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function fmt(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export type MonthlyMode = 'first' | 'last' | 'fixed'

export function getSummaryWindow(
  dateStr: string,
  weeklyDay: number,
  monthlyMode: MonthlyMode,
  monthlyFixedDay: number
): PeriodWindow | null {
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return null
  const date = new Date(y, m - 1, d)
  const nextDate = fmt(new Date(y, m - 1, d + 1))

  // ---- 月总结优先判定 ----
  const lastDom = new Date(y, m, 0).getDate()
  const isFirst = d === 1
  const isLast = d === lastDom
  const fixedClamped = Math.min(Math.max(monthlyFixedDay, 1), 28)
  const hitFixed = d === fixedClamped

  if (monthlyMode === 'first' && isFirst) {
    const ps = new Date(y, m - 2, 1)
    const pe = new Date(y, m - 1, 0)
    return {
      type: 'month',
      start: fmt(ps),
      end: fmt(pe),
      label: `${ps.getFullYear()}年${ps.getMonth() + 1}月月总结`,
      nextDate,
    }
  }
  if (monthlyMode === 'last' && isLast) {
    return {
      type: 'month',
      start: `${y}-${pad(m)}-01`,
      end: dateStr,
      label: `${y}年${m}月月总结`,
      nextDate,
    }
  }
  if (monthlyMode === 'fixed' && hitFixed) {
    const start = new Date(y, m - 1, d - 29)
    return {
      type: 'month',
      start: fmt(start),
      end: dateStr,
      label: `近30天月总结(${fmt(start).slice(5)}~${dateStr.slice(5)})`,
      nextDate,
    }
  }

  // ---- 周总结 ----
  if (date.getDay() === weeklyDay) {
    const start = new Date(y, m - 1, d - 6)
    return {
      type: 'week',
      start: fmt(start),
      end: dateStr,
      label: `周总结(${fmt(start).slice(5)} ~ ${dateStr.slice(5)})`,
      nextDate,
    }
  }

  return null
}

/**
 * 扫描未来，找出「下一次」命中总结的窗口（用于推算下期任务的截止时刻）。
 * 前置约定：必须走 getSummaryWindow（周总结日可配置 + 月总结三模式），不能写死「下周日」。
 */
export function getNextSummaryWindow(
  dateStr: string, weeklyDay: number, monthlyMode: MonthlyMode, monthlyFixedDay: number,
): PeriodWindow | null {
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return null
  // 从明天起向前扫（最多 400 天，覆盖任何月总结周期）
  for (let i = 1; i <= 400; i++) {
    const cur = fmt(new Date(y, m - 1, d + i))
    const w = getSummaryWindow(cur, weeklyDay, monthlyMode, monthlyFixedDay)
    if (w) return w
  }
  return null
}

export function addDaysStr(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return fmt(new Date(y, m - 1, d + n))
}

/**
 * 自然周下一个周一（与 timetable.mondayOf 同源）：date 当周周一 + 7 天。
 * 用于「周总结里加的下周任务」落在下一个自然周，与网格列对齐（避免总结日非周日时错位）。
 */
export function nextMondayStr(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const dow = (date.getDay() + 6) % 7 // 周一 = 0
  return fmt(new Date(y, m - 1, d - dow + 7))
}

/* ==========================================================================
 * 层级总结（周 / 月 / 年）—— 日历口径
 *
 * ⚠️ 本节与上面的 `getSummaryWindow` 是**两套不同用途的口径，不可互相替换**：
 *
 *   · `getSummaryWindow`（旧）回答「今天是不是总结日」，窗口 = 总结日往前推 6 天。
 *     它只用于「提醒 / 徽章」——EntryCard 上的总结日标记、下期任务 DDL 推算。
 *     **它不决定任何文件名。**
 *
 *   · 本节函数（新）是**日历口径**，与桌面上日历看到的周号 / 月份 / 年份逐格对齐，
 *     是**总结文件窗口的唯一来源**。
 *
 * 为什么必须分开（2026-09-15 开发负责人拍板「只认日历」）：
 *   若总结文件也按「总结日 −6 天」划窗口，而日历上的周号是自然周（周一~周日），
 *   两套刻度错位 → 点周号生成的周总结与总结日提示的那一周不是同一周 → 同一周出现两份文件。
 *   详见 DP `v3.2.0.md` 第 12 / 15 项。
 * ========================================================================== */

export interface SummaryWindow {
  kind: SummaryKind
  start: string
  end: string
  /** 文档标题 / 磁贴入口的显示名 */
  label: string
}

/** 该日期所在自然周的周一（与 `nextMondayStr`、`timetable.mondayOf` 同一刻度） */
export function mondayOf(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dow = (new Date(y, m - 1, d).getDay() + 6) % 7 // 周一 = 0
  return fmt(new Date(y, m - 1, d - dow))
}

/** 自然周窗口：周一 ~ 周日 */
export function weekRangeOf(dateStr: string): { start: string; end: string } {
  const start = mondayOf(dateStr)
  return { start, end: addDaysStr(start, 6) }
}

/** 自然月窗口：1 号 ~ 月末（month 取 1-12；跨年进位交给 Date） */
export function monthRangeOf(year: number, month: number): { start: string; end: string } {
  return { start: `${year}-${pad(month)}-01`, end: fmt(new Date(year, month, 0)) }
}

/** 自然年窗口 */
export function yearRangeOf(year: number): { start: string; end: string } {
  return { start: `${year}-01-01`, end: `${year}-12-31` }
}

/**
 * ISO 8601 周号（周一为一周起点，与 `weekRangeOf` 同刻度）。
 * 用 UTC 推「本周的周四」再算年内天数 —— 这是标准算法，跨年周（12-29 ~ 01-04）
 * 会正确归属到下一年的第 1 周。
 */
export function isoWeekNo(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const day = date.getUTCDay() || 7 // 周一 = 1 … 周日 = 7
  date.setUTCDate(date.getUTCDate() + 4 - day) // 挪到本周周四（ISO 周归属判据）
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

/** 窗口标题（沿用既有观感；跨年窗口带完整年份） */
export function summaryLabel(kind: SummaryKind, start: string, end: string): string {
  if (kind === 'week') {
    return start.slice(0, 4) === end.slice(0, 4)
      ? `周总结(${start.slice(5).replace('-', '.')} ~ ${end.slice(5).replace('-', '.')})`
      : `周总结(${start} ~ ${end})`
  }
  if (kind === 'month') {
    const [sy, sm] = start.split('-').map(Number)
    const [ey, em] = end.split('-').map(Number)
    // 整自然月 → 「2026年8月月总结」；非整月窗口（月总结 fixed 模式的近 30 天）→ 带区间
    const lastDom = new Date(sy, sm, 0).getDate()
    const fullMonth = sy === ey && sm === em && start.endsWith('-01') && Number(end.slice(8)) === lastDom
    return fullMonth ? `${sy}年${sm}月月总结` : `月总结(${start} ~ ${end})`
  }
  const y = start.slice(0, 4)
  return `${y}年年度总结`
}

/** 总结文件的唯一键（不含扩展名）：窗口 ⇄ 文件一一对应 */
export function summaryFileKey(kind: SummaryKind, start: string, end: string): string {
  return `summary-${kind}-${start}_${end}`
}

/** 总结文件名。同窗口幂等、不同窗口必不同（含跨年周与跨月窗口） */
export function summaryFileName(kind: SummaryKind, start: string, end: string): string {
  return `${summaryFileKey(kind, start, end)}.md`
}

/** 组装窗口对象（label 一并算好） */
export function makeSummaryWindow(kind: SummaryKind, start: string, end: string): SummaryWindow {
  return { kind, start, end, label: summaryLabel(kind, start, end) }
}

/**
 * 某一天对应的「本周 / 本月 / 今年」三个窗口 —— 磁贴总结入口段与日志尾部
 * 「本期总结」入口卡片共用，保证两处指向完全相同的文件。
 */
export function summaryWindowsAt(dateStr: string): SummaryWindow[] {
  const [y, m] = dateStr.split('-').map(Number)
  const w = weekRangeOf(dateStr)
  const mo = monthRangeOf(y, m)
  const yr = yearRangeOf(y)
  return [
    makeSummaryWindow('week', w.start, w.end),
    makeSummaryWindow('month', mo.start, mo.end),
    makeSummaryWindow('year', yr.start, yr.end),
  ]
}

/**
 * 下一个同类窗口 —— 用于「下期任务」的默认截止日（截止到下次总结之前）。
 *
 * 与旧口径的差别：不再依赖「总结日」设置（`summaryWeeklyDay` 等），
 * 直接按日历口径往后推一格 —— 因为总结文件的窗口是日历口径，
 * 若 DDL 还按总结日推，会出现「总结写的是这一周、任务却落到别的日子」。
 */
export function nextWindowOf(kind: SummaryKind, start: string, end: string): { start: string; end: string } {
  if (kind === 'week') return weekRangeOf(addDaysStr(end, 1))
  if (kind === 'month') {
    const [y, m] = start.split('-').map(Number)
    return m === 12 ? monthRangeOf(y + 1, 1) : monthRangeOf(y, m + 1)
  }
  return yearRangeOf(Number(start.slice(0, 4)) + 1)
}
