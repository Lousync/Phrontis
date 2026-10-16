import type { UsageWindow, ProviderQuotaView, QuotaWindow, QuotaFailReason } from '../../types'
import { fmtTokens, exactTokens } from '../../lib/numFormat'

/**
 * 用量模块的展示口径（纯函数，无副作用）。
 *
 * 只做「数字 → 文案 / 颜色」的映射；聚合数字全部来自主进程 `usageDashboard`（铁律：
 * 渲染层不算业务），这里不重算任何桶。
 */

export { fmtTokens, exactTokens }

/** 费用（USD）：非账单、估算值。0 → $0；极小额给 4 位小数，避免全显示 $0.00 */
export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n === 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

/** 供应商展示名：历史裸键（无 providerId）→ 「默认通道」 */
export function providerLabel(provider: string): string {
  return provider ? provider : '默认通道'
}

export const WIN_LABEL: Record<UsageWindow, string> = {
  30: '近 30 天',
  90: '近 90 天',
  365: '近 365 天',
  all: '全部',
}

export type Metric = 'tok' | 'cost' | 'calls'

/** 取序列点的指标值（tokens = 四桶之和） */
export function metricOf(pt: { i0: number; ir: number; iw: number; out: number; calls: number; cost: number | null }, m: Metric): number {
  if (m === 'cost') return pt.cost ?? 0
  if (m === 'calls') return pt.calls
  return pt.i0 + pt.ir + pt.iw + pt.out
}

export function fmtMetric(v: number, m: Metric): string {
  if (m === 'cost') return fmtUsd(v)
  if (m === 'calls') return String(v)
  return fmtTokens(v)
}

/** 套餐窗口的严重度档：≥100 或 rate-limited → 红；≥80 → amber；其余正常 */
export function windowLevel(w: QuotaWindow): 'ok' | 'warn' | 'hot' {
  if (w.status === 'rate-limited' || w.percent >= 100) return 'hot'
  if (w.percent >= 80) return 'warn'
  return 'ok'
}

/** 重置倒计时（人话：3 天 2 小时 / 5 小时 12 分 / 已重置） */
export function fmtCountdown(resetsAt?: string, now = Date.now()): string {
  if (!resetsAt) return ''
  const t = new Date(resetsAt).getTime()
  if (!Number.isFinite(t)) return ''
  let ms = t - now
  if (ms <= 0) return '已重置'
  const min = Math.floor(ms / 60000)
  const h = Math.floor(min / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d} 天 ${h % 24} 小时`
  if (h > 0) return `${h} 小时 ${min % 60} 分`
  return `${min} 分`
}

/** 额度失败原因 → 一句话（面向用户，不带上游原文） */
export const QUOTA_FAIL_TEXT: Record<QuotaFailReason, string> = {
  unsupported: '未提供余额接口',
  unauthorized: 'Key 无效或权限不足',
  'not-subscribed': '该账号没有对应套餐',
  network: '暂时取不到',
  shape: '返回格式不认识',
  'no-key': '账号未配置 Key',
}

/** 未提供余额接口的失败项是否算「接口缺失」（收成汇总行，不占卡）——只认 unsupported */
export function isUnsupported(q: ProviderQuotaView): boolean {
  return !q.ok && q.reason === 'unsupported'
}
