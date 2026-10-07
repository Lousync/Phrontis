/**
 * 分享卡片专用派生统计 —— **纯函数、零依赖**。
 *
 * 只放「打卡口径之外」的那部分：番茄钟专注时长与热力率。打卡侧的口径
 * （连续天数 / 本周格 / 热力格）一律在 `habitStats.ts`，本文件不再抄一遍
 * —— 同一 app 里两处数字不该打架。
 *
 * 零 import（连 `import type` 都不用）：契约脚本用 `node --experimental-strip-types`
 * 直接装载本文件验真实实现，任何跨层引用都可能把装载链路拖垮。
 */

/** 分享卡片热力主视觉的窗口：13 周 × 7 天 = 91 天 */
export const SHARE_CARD_HEAT_WEEKS = 13

/**
 * 某日的专注总分钟数（`pomodoro/sessions.json` 的 `minutes` 求和）。
 * 非目标日跳过；`minutes` 缺失 / 非有限数 / 负数一律跳过，不抛错（脏数据不该让出图失败）。
 */
export function focusMinutesOn(
  sessions: Array<{ minutes: number; date: string }>,
  date: string,
): number {
  let sum = 0
  for (const s of sessions) {
    if (!s || s.date !== date) continue
    const m = Number(s.minutes)
    if (!Number.isFinite(m) || m <= 0) continue
    sum += m
  }
  return Math.round(sum)
}

/** 热力格打卡率百分比（非空格 ÷ 总格，四舍五入）；空格/非法输入返回 0，不出现 NaN */
export function heatRate(grid: boolean[]): number {
  if (!Array.isArray(grid) || grid.length === 0) return 0
  let on = 0
  for (const c of grid) if (c) on += 1
  return Math.round((on / grid.length) * 100)
}
