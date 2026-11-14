import { keyOfNo, dayNo } from './heatmapModel.ts'

/**
 * 看板首页的**纯计算层**（2026-11-14 首页重做）。
 *
 * 为什么单独一个文件：结论句、时间线的「现在」插入点、月历的 42 格、热力图的一年区间
 * 都是「算错一格/差一天也不报错、只有人眼能看出来」的判定 ——
 * 抽成零依赖纯函数后，契约脚本（`.AGENT/scripts/dashboard/verify-dashboard.mjs`）
 * 可以 `node --experimental-strip-types` 直接装载真实实现来验，而不是抄一份期望值。
 */

/* ==================== 一句话结论 ==================== */

export interface VerdictPart {
  text: string
  /** 需要加重的片段（数字） */
  strong?: boolean
}

/**
 * 「还有 N 件事，其中 M 件已经过了时间，最近一件 HH:mm。」
 *
 * 0 件时整句换掉（不输出「还有 0 件」）；没有下一件就不提时刻。
 */
export function verdictParts(input: {
  openCount: number
  lateCount: number
  nextAt: string | null
}): VerdictPart[] {
  const { openCount, lateCount, nextAt } = input
  if (openCount <= 0) return [{ text: '今天的事都做完了，只剩打卡。' }]
  const parts: VerdictPart[] = [
    { text: '还有 ' },
    { text: String(openCount), strong: true },
    { text: ' 件事' },
  ]
  if (lateCount > 0) {
    parts.push({ text: '，其中 ' }, { text: String(lateCount), strong: true }, { text: ' 件已经过了时间' })
  }
  if (nextAt) parts.push({ text: '，最近一件 ' }, { text: nextAt, strong: true })
  parts.push({ text: '。' })
  return parts
}

/** 纯文本形态（契约脚本与 aria-label 用） */
export function verdictText(input: { openCount: number; lateCount: number; nextAt: string | null }): string {
  return verdictParts(input).map((p) => p.text).join('')
}

/* ==================== 今天的时间线 ==================== */

export interface TimelineTodo {
  id: string
  title: string
  /** 'HH:mm'，无时间 = null */
  time: string | null
  done: boolean
}

export interface TimelineRow extends TimelineTodo {
  /** 未完成且时刻已过（红点 + 红标签） */
  late: boolean
}

export interface TimelineModel {
  rows: TimelineRow[]
  /** 「现在」这一行插在 rows 的哪个下标前（= rows.length 表示末尾） */
  nowIndex: number
  /** 未完成件数 */
  openCount: number
  /** 其中已过时间的件数 */
  lateCount: number
  /** 下一个未到时间的任务时刻（没有 = null） */
  nextAt: string | null
}

/**
 * 时间线：有时间的按时间升序 → 没时间的排最后；「现在」插在第一个**未到时刻**之前。
 *
 * 已完成的条目不剔除（画划线态），但它们不参与「还有几件」的计数 ——
 * 那是结论句的口径，两者必须分开算，否则勾掉一件后句子和列表会互相矛盾。
 */
export function orderTimeline(todos: TimelineTodo[], nowHHmm: string): TimelineModel {
  const timed = todos.filter((t) => !!t.time).sort((a, b) => String(a.time).localeCompare(String(b.time)))
  const untimed = todos.filter((t) => !t.time)
  const all = [...timed, ...untimed]
  const rows: TimelineRow[] = all.map((t) => ({
    ...t,
    late: !t.done && !!t.time && String(t.time) < nowHHmm,
  }))
  const firstFuture = rows.findIndex((r) => !r.done && !!r.time && String(r.time) >= nowHHmm)
  const open = rows.filter((r) => !r.done)
  return {
    rows,
    nowIndex: firstFuture === -1 ? rows.length : firstFuture,
    openCount: open.length,
    lateCount: open.filter((r) => r.late).length,
    nextAt: firstFuture === -1 ? null : rows[firstFuture].time,
  }
}

/* ==================== 月历 ==================== */

/**
 * 'YYYY-MM' → 42 格（周一起排）的日期键，月外为 null。
 *
 * 固定 6 行：行数随月份变化会让整张纸的高度在翻月时跳动，月历又不需要「刚好够」。
 */
export function buildMonthGrid(month: string): Array<string | null> {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) return []
  const year = Number(m[1])
  const mon = Number(m[2])
  if (mon < 1 || mon > 12) return []
  const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate()
  const firstDow = (new Date(Date.UTC(year, mon - 1, 1)).getUTCDay() + 6) % 7 // 周一 = 0
  return Array.from({ length: 42 }, (_, i) => {
    const day = i - firstDow + 1
    if (day < 1 || day > daysInMonth) return null
    return `${month}-${String(day).padStart(2, '0')}`
  })
}

/* ==================== 热力图区间 ==================== */

/**
 * 近一年（52 列 × 7 天）的起止：**从今天所在那一周的周一往回数 51 周**。
 *
 * 为什么不直接 today-363：那样首列会从周中开始，`buildHeatmap` 要补 0–6 个空位，
 * 列数变成 53，月份刻度与格子就多一列、卡片里塞不下。对齐到周一后，列数恒为 52。
 */
export function heatRange(today: string): { from: string; to: string } {
  const no = dayNo(today)
  if (!Number.isFinite(no)) return { from: today, to: today }
  const dow = (new Date(no * 86400000).getUTCDay() + 6) % 7
  return { from: keyOfNo(no - dow - 51 * 7), to: today }
}

/* ==================== 日期文案 ==================== */

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

/** 'YYYY-MM-DD' → '2026 · 11 · 14 星期六'（畸形输入原样返回） */
export function dateLine(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return date
  const no = dayNo(date)
  const dow = new Date(no * 86400000).getUTCDay()
  return `${m[1]} · ${m[2]} · ${m[3]} 星期${WEEKDAYS[dow]}`
}

/** 'YYYY-MM' → '11 月' + '2026'（月历头部） */
export function monthHead(month: string): { title: string; year: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) return { title: month, year: '' }
  return { title: `${Number(m[2])} 月`, year: m[1] }
}
