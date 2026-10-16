/**
 * 用量看板聚合（**零依赖纯函数**，v3.9.0 用量模块）—— 供 IPC handler 与契约脚本共用。
 *
 * 只吃 `ai-usage.json` 的 `days` 快照，输出看板要的四块数据；不读盘、不碰 electron。
 * 费用走 `modelPricing.estimateCost`（模型无价目 → `cost: null` 并进 `unknownModels`，
 * 界面显示「无价目」而非 0 —— 方案 §4.1）。
 *
 * 分桶粒度（方案 §4.1）：时间窗 ≤92 天按天 / ≤400 天按周 / 更长按月；
 * 热力图固定回看 365 天（与时间窗无关，就是「这一年」的日历）。
 */

import type { AiUsageDay } from './agentUsage'
import { estimateCost } from './modelPricing'

export type UsageWindow = 30 | 90 | 365 | 'all'

export interface UsageModelRow {
  key: string
  provider: string
  model: string
  i0: number
  ir: number
  iw: number
  out: number
  calls: number
  /** 估算费用（USD）；无价目 → null */
  cost: number | null
  /** 该模型 token 占总量的比例 0–1 */
  share: number
}

export interface UsageSeriesPoint {
  key: string
  label: string
  i0: number
  ir: number
  iw: number
  out: number
  calls: number
  cost: number | null
}

export interface UsageHeatCell {
  date: string
  tokens: number
}

export interface UsageDashboardView {
  window: UsageWindow
  totals: { i0: number; ir: number; iw: number; out: number; calls: number; days: number }
  models: UsageModelRow[]
  series: UsageSeriesPoint[]
  heat: UsageHeatCell[]
  /** 无价目的模型键（界面提示「实际费用为下限」） */
  unknownModels: string[]
}

const pad = (n: number): string => String(n).padStart(2, '0')
const keyOf = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const parseKey = (k: string): Date | null => {
  const t = new Date(`${k}T00:00:00`)
  return Number.isFinite(t.getTime()) ? t : null
}
const weekStartKey = (d: Date): string => {
  const c = new Date(d)
  const day = (c.getDay() + 6) % 7 // 周一为一周之首
  c.setDate(c.getDate() - day)
  return keyOf(c)
}
const monthKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`

/** 拆 `providerId:modelId` 键；无 `:` 的历史裸键 → provider 空（界面显示「默认通道」） */
function splitKey(key: string): { provider: string; model: string } {
  const i = key.indexOf(':')
  return i > 0 ? { provider: key.slice(0, i), model: key.slice(i + 1) } : { provider: '', model: key }
}

const tokensOf = (d: AiUsageDay): number => d.in + d.out

export function buildUsageDashboard(days: Record<string, AiUsageDay>, win: UsageWindow): UsageDashboardView {
  const allKeys = Object.keys(days).sort()
  const today = new Date()
  const startKey = (() => {
    if (win === 'all') return allKeys[0] ?? keyOf(today)
    const s = new Date(today)
    s.setDate(s.getDate() - (win - 1))
    return keyOf(s)
  })()
  const endKey = keyOf(today)
  const inWindow = allKeys.filter((k) => k >= startKey && k <= endKey)

  // —— 总量 ——（out/calls 直接取日桶；输入按 models 桶拆 i0/ir/iw，历史无 models 的日桶全部算未缓存输入）
  const totals = { i0: 0, ir: 0, iw: 0, out: 0, calls: 0, days: inWindow.length }
  for (const k of inWindow) {
    const d = days[k]
    totals.out += d.out
    totals.calls += d.calls
    if (d.models) {
      for (const b of Object.values(d.models)) {
        totals.i0 += b.i0
        totals.ir += b.ir
        totals.iw += b.iw
      }
    } else {
      totals.i0 += d.in
    }
  }

  // —— 按模型聚合 ——
  const modelAgg = new Map<string, UsageModelRow>()
  for (const k of inWindow) {
    const d = days[k]
    if (!d.models) continue
    for (const [key, b] of Object.entries(d.models)) {
      const row = modelAgg.get(key) ?? (() => {
        const s = splitKey(key)
        return { key, provider: s.provider, model: s.model, i0: 0, ir: 0, iw: 0, out: 0, calls: 0, cost: null as number | null, share: 0 }
      })()
      row.i0 += b.i0
      row.ir += b.ir
      row.iw += b.iw
      row.out += b.out
      row.calls += b.calls
      modelAgg.set(key, row)
    }
  }
  const totalModelTokens = [...modelAgg.values()].reduce((a, r) => a + r.i0 + r.ir + r.iw + r.out, 0)
  const unknownModels: string[] = []
  for (const row of modelAgg.values()) {
    const cost = estimateCost({ i0: row.i0, ir: row.ir, iw: row.iw, out: row.out, calls: row.calls }, row.key)
    row.cost = cost
    if (cost === null) unknownModels.push(row.key)
    row.share = totalModelTokens > 0 ? (row.i0 + row.ir + row.iw + row.out) / totalModelTokens : 0
  }
  const models = [...modelAgg.values()].sort((a, b) => (b.i0 + b.ir + b.iw + b.out) - (a.i0 + a.ir + a.iw + a.out))

  // —— 时间序列分桶 ——
  const mode: 'day' | 'week' | 'month' = win === 'all' ? 'month' : win <= 92 ? 'day' : win <= 400 ? 'week' : 'month'
  const bucketOf = (d: Date): string => (mode === 'day' ? keyOf(d) : mode === 'week' ? weekStartKey(d) : monthKey(d))
  const labelOf = (bucketKey: string): string => {
    if (mode === 'month') return bucketKey
    const d = parseKey(bucketKey)
    if (!d) return bucketKey
    return mode === 'week' ? `${d.getMonth() + 1}/${d.getDate()}` : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  const seriesMap = new Map<string, UsageSeriesPoint>()
  for (const k of inWindow) {
    const d = days[k]
    const date = parseKey(k)
    if (!date) continue
    const bk = bucketOf(date)
    const pt = seriesMap.get(bk) ?? (() => ({ key: bk, label: labelOf(bk), i0: 0, ir: 0, iw: 0, out: 0, calls: 0, cost: 0 as number | null }))()
    pt.calls += d.calls
    if (d.models) {
      for (const b of Object.values(d.models)) {
        pt.i0 += b.i0
        pt.ir += b.ir
        pt.iw += b.iw
        pt.out += b.out
      }
    } else {
      pt.i0 += d.in
      pt.out += d.out
    }
    seriesMap.set(bk, pt)
  }
  // 序列费用：按当日各模型估费求和（无价目模型按 0 计，并在 unknownModels 里提示）
  for (const k of inWindow) {
    const d = days[k]
    const date = parseKey(k)
    if (!date || !d.models) continue
    const bk = bucketOf(date)
    const pt = seriesMap.get(bk)
    if (!pt) continue
    let add = 0
    for (const [key, b] of Object.entries(d.models)) {
      const c = estimateCost(b, key)
      if (c !== null) add += c
    }
    pt.cost = (pt.cost ?? 0) + add
  }
  const series = [...seriesMap.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  // —— 热力图（固定回看 365 天）——
  const heat: UsageHeatCell[] = []
  for (let i = 364; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const k = keyOf(d)
    heat.push({ date: k, tokens: days[k] ? tokensOf(days[k]) : 0 })
  }

  return { window: win, totals, models, series, heat, unknownModels }
}
