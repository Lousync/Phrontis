/**
 * 用量数字的紧凑口径（2026-10-15，用户拍板参照 DeepSeek「42.8M tokens」）：
 *   千以下原样 → 千以上一位小数 K → 百万以上一位小数 M；`.0` 抹平。
 *   251,433 → 251.4K；42,800,000 → 42.8M；625 → 625。
 * 只做展示缩写 —— 精确值走 `exactTokens`（千分位），配 title 提示，信息不丢。
 * 契约：.AGENT/scripts/ai-usage/verify-num-format.mjs（含 999,999 → 1M 的进位边界）。
 */
export function fmtTokens(n: number): string {
  const v = Number(n)
  if (!Number.isFinite(v)) return '0'
  const abs = Math.abs(v)
  if (abs < 1000) return String(v)
  const strip = (s: string) => s.replace(/\.0$/, '')
  if (abs < 1e6) {
    // 边界：999,999 按 K 舍入会得到「1000K」，直接进位成 1M
    const k = v / 1e3
    if (Math.round(k * 10) / 10 >= 1000) return strip((v / 1e6).toFixed(1)) + 'M'
    return strip(k.toFixed(1)) + 'K'
  }
  return strip((v / 1e6).toFixed(1)) + 'M'
}

/** 精确值（千分位），给 title / 悬停提示用 —— 缩写不丢信息 */
export function exactTokens(n: number): string {
  return Number(n ?? 0).toLocaleString('en-US')
}
