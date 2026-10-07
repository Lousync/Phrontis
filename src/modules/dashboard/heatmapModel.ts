/**
 * 使用热力图的**纯计算层**（零依赖，2026-09-27）。
 *
 * 抽出来的理由和 `electron/lib/kbStore/habitStats.ts` 同源：周一起排的补位、
 * 月份标签落在第几列、四档色阶的阈值 —— 这些判定错一格就是「日期和格子对不上」，
 * 而且**不报错**（原型里真踩过：星期标签与数据错了一行）。做成零依赖纯函数后，
 * 契约脚本可以用 `node --experimental-strip-types` 直接装载真实实现来验。
 *
 * 日期一律走 UTC 天序号做算术，避开夏令时。
 */

/** 各等级下界（分钟）。0 = 无记录 */
export const LEVEL_MIN = [0, 30, 90, 170, 260] as const

export type Level = 0 | 1 | 2 | 3 | 4

export function levelOf(minutes: number): Level {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0
  if (minutes < LEVEL_MIN[2]) return 1
  if (minutes < LEVEL_MIN[3]) return 2
  if (minutes < LEVEL_MIN[4]) return 3
  return 4
}

/** 'YYYY-MM-DD' → UTC 天序号；畸形返回 NaN */
export function dayNo(key: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return NaN
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000)
}

/** UTC 天序号 → 'YYYY-MM-DD' */
export function keyOfNo(no: number): string {
  const d = new Date(no * 86400000)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

export interface HeatmapCell {
  key: string
  level: Level
  minutes: number
}

export interface HeatmapModel {
  /** 列数（= 周数） */
  weeks: number
  /** 首列之前要补几个空位（周一起排） */
  pad: number
  cells: Array<HeatmapCell | null>
  months: Array<{ label: string; start: number; span: number }>
  activeDays: number
  totalMinutes: number
}

const EMPTY: HeatmapModel = { weeks: 0, pad: 0, cells: [], months: [], activeDays: 0, totalMinutes: 0 }

/**
 * 把一个日区间摊成热力图的格子布局。
 *
 * 周一起排 —— 星期标签列固定写「一/三/五/日」，所以首格之前必须补 `(dow+6)%7` 个空位，
 * 否则标签和格子错行（**这是最容易错的一处**）。
 */
export function buildHeatmap(
  days: Record<string, number>,
  fromKey: string,
  toKey: string,
): HeatmapModel {
  const fromNo = dayNo(fromKey)
  const toNo = dayNo(toKey)
  if (!Number.isFinite(fromNo) || !Number.isFinite(toNo) || toNo < fromNo) return EMPTY

  const total = toNo - fromNo + 1
  const pad = (new Date(fromNo * 86400000).getUTCDay() + 6) % 7 // 0=周日 → 6；1=周一 → 0
  const weeks = Math.ceil((total + pad) / 7)

  const cells: Array<HeatmapCell | null> = Array.from({ length: pad }, () => null)
  const months: Array<{ m: number; col: number }> = []
  const seen = new Set<number>()
  let activeDays = 0
  let totalMinutes = 0

  for (let i = 0; i < total; i++) {
    const key = keyOfNo(fromNo + i)
    const minutes = days[key] ?? 0
    const level = levelOf(minutes)
    if (level > 0) activeDays++
    totalMinutes += minutes
    const m = Number(key.slice(5, 7)) - 1
    if (!seen.has(m)) { seen.add(m); months.push({ m, col: Math.floor((i + pad) / 7) }) }
    cells.push({ key, level, minutes })
  }

  const monthList = months.map((x, k) => {
    const end = k + 1 < months.length ? months[k + 1].col : weeks
    return { label: `${x.m + 1} 月`, start: x.col + 1, span: Math.max(1, end - x.col) }
  })

  return { weeks, pad, cells, months: monthList, activeDays, totalMinutes }
}

/** 分钟数 → 人话（悬停提示与图例共用，避免两处格式不一致）；label 区分「使用 / 专注」口径 */
export function fmtMinutes(m: number, label = '使用'): string {
  if (!Number.isFinite(m) || m <= 0) return '没有记录'
  return m >= 60 ? `${label} ${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${label} ${m} 分钟`
}
