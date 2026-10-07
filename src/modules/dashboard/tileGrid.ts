/**
 * 看板磁贴布局纯函数（2026-09-28 栅格化，docs/dashboard-tile-grid-design.md §2）。
 *
 * 零依赖、无 React —— 契约脚本用 `node --experimental-strip-types` 直接装载验证
 * （heatmapModel 同款先例，见 .AGENT/scripts/dashboard/verify-dashboard-tile-grid.mjs）。
 *
 * 两键分工（语义不合并）：
 *   - `dashboardCards`（既有）：显示哪些卡（id 数组）—— 显隐
 *   - `dashboardTileLayout`（新增）：`[{id, w, h}]` —— 布局序 + 格子尺寸
 * 卸载/停用插件的 id 两边都不清洗，渲染侧按在场清单过滤即可；插件回来还在原槽位。
 */

export interface TileLayoutItem {
  id: string
  w: number
  h: number
}

/** 默认比例来源（内置注册表条目 / 插件控件声明） */
export interface LayoutSource {
  id: string
  w: number
  h: number
}

export const GRID_COLS = 6
export const MIN_W = 2
export const MAX_W = 6
export const MIN_H = 1
export const MAX_H = 4

/** 夹取到合法格子档位；非有限值回退最小档 */
export function clampWH(w: number, h: number): { w: number; h: number } {
  const nw = Math.max(MIN_W, Math.min(MAX_W, Math.round(Number.isFinite(w) ? w : MIN_W)))
  const nh = Math.max(MIN_H, Math.min(MAX_H, Math.round(Number.isFinite(h) ? h : MIN_H)))
  return { w: nw, h: nh }
}

/** 解析 setting JSON：非数组 / 坏项 / 重复 id 丢弃，w/h 夹取；缺省档 2×2（同插件 manifest 缺省）。补缺交给 normalizeLayout（需要注册表） */
export function parseLayout(json: string | undefined | null): TileLayoutItem[] {
  try {
    const v: unknown = JSON.parse(json || '')
    if (!Array.isArray(v)) return []
    const out: TileLayoutItem[] = []
    const seen = new Set<string>()
    for (const it of v) {
      if (!it || typeof it !== 'object') continue
      const id = (it as { id?: unknown }).id
      if (typeof id !== 'string' || seen.has(id)) continue
      seen.add(id)
      const raw = it as { w?: unknown; h?: unknown }
      const { w, h } = clampWH(
        typeof raw.w === 'number' ? raw.w : 2,
        typeof raw.h === 'number' ? raw.h : 2,
      )
      out.push({ id, w, h })
    }
    return out
  } catch {
    return []
  }
}

/**
 * 归一化：未知 id 丢弃；注册表/插件清单里有而布局缺的 id **按来源序追加**（带默认比例）。
 * 这是布局读取的唯一入口 —— 缺 id（新卡 / 首次开启）在这里长出来。
 */
export function normalizeLayout(layout: TileLayoutItem[], known: LayoutSource[]): TileLayoutItem[] {
  const knownMap = new Map(known.map((k) => [k.id, k]))
  const out: TileLayoutItem[] = []
  const seen = new Set<string>()
  for (const it of layout) {
    if (!knownMap.has(it.id) || seen.has(it.id)) continue
    seen.add(it.id)
    out.push(it)
  }
  for (const k of known) {
    if (!seen.has(k.id)) {
      seen.add(k.id)
      out.push({ id: k.id, w: k.w, h: k.h })
    }
  }
  return out
}

/** 对调语义（网格内拖拽换位）。任一 id 不在 → 原样返回（不抛错，调用方无需预判） */
export function swapIds(layout: TileLayoutItem[], idA: string, idB: string): TileLayoutItem[] {
  const i = layout.findIndex((t) => t.id === idA)
  const j = layout.findIndex((t) => t.id === idB)
  if (i < 0 || j < 0 || i === j) return layout
  const out = layout.slice()
  const tmp = out[i]
  out[i] = out[j]
  out[j] = tmp
  return out
}

/** 插入语义（托盘拖入网格）：把 id 挪到 targetId 前 / 后。id 或 target 不在 → 原样返回 */
export function insertId(layout: TileLayoutItem[], id: string, targetId: string, after: boolean): TileLayoutItem[] {
  const item = layout.find((t) => t.id === id)
  if (!item) return layout
  const without = layout.filter((t) => t.id !== id)
  const j = without.findIndex((t) => t.id === targetId)
  if (j < 0) return layout
  const out = without.slice()
  out.splice(j + (after ? 1 : 0), 0, item)
  return out
}

/** 改尺寸提交（拉角吸附后落库） */
export function withSize(layout: TileLayoutItem[], id: string, w: number, h: number): TileLayoutItem[] {
  return layout.map((t) => (t.id === id ? { id: t.id, ...clampWH(w, h) } : t))
}
