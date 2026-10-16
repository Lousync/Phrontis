/**
 * AI教学「学习流」画布 —— 几何 / 推进顺序纯函数。
 *
 * 为什么单独一个文件（口径同 `electron/lib/profilePatch.ts`、`prepPolicy.ts`）：
 * 契约脚本要能 `stripTypeScriptTypes` 之后**直接 import 真实实现执行**，
 * 故本文件**零 import**（连 node 内建都不引），类型一律内联定义 —— 别改成从 `src/types` 引。
 *
 * 几何口径来自原型 `E:\Projects\KnowledgeRecorder\tmp\aiteach-flow-v380\index.html`（已验收）：
 *   · 章 = 子节点包围盒（`zoneRect`）——章框不存坐标，随子节点变化；
 *   · 连线 = 章内相邻链（`chainEdges`），顺序 = 卡片从左到右（`sortChapter`）；
 *   · 自动整理 = 每章一行、章内从左到右（`arrangePositions`）。
 */

export const NODE_W = 224
export const NODE_H = 76
export const GRID = 20
export const ZONE_PAD = 22
export const ZONE_HEAD = 40
export const ROW_H = 250
export const UNIT_GAP_X = 296
export const UNIT_X0 = 40
export const ROW_Y0 = 60
/** 折叠态 / 空章框：固定占位，不随子节点 */
export const COLLAPSED_ZONE_X = 20
export const COLLAPSED_ZONE_W = 320

export interface FlowUnitPos { id: string; x: number; y: number }
export interface FlowChapterShape { id: string; units: readonly FlowUnitPos[] }
export interface FlowEdge { chapterId: string; fromId: string; toId: string }
export interface Rect { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }
export interface Viewport { x: number; y: number; k: number }

export function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v))
}

/** 网格吸附：把坐标对齐到 GRID 的整数倍 */
export function snapValue(v: number, grid = GRID): number {
  return Math.round(v / grid) * grid
}

export interface ZoneRectInput {
  units: readonly FlowUnitPos[]
  /** 章在列表里的序号（折叠 / 空章框占位要用） */
  index: number
  collapsed?: boolean
  /** 正在被拖的节点：算包围盒时排除它，避免「源章框被自己撑大」误判落点 */
  excludeId?: string | null
}

/** 章框矩形 = 子节点包围盒（左/上各留 ZONE_PAD，顶部额外留 ZONE_HEAD 放标题条） */
export function zoneRect(input: ZoneRectInput): Rect {
  const { units, index, collapsed, excludeId } = input
  let list: readonly FlowUnitPos[] = units
  if (excludeId) {
    const filtered = units.filter((u) => u.id !== excludeId)
    if (filtered.length) list = filtered
  }
  if (collapsed || !list.length) {
    return { x: COLLAPSED_ZONE_X, y: ROW_Y0 + index * ROW_H, w: COLLAPSED_ZONE_W, h: ZONE_HEAD }
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const u of list) {
    minX = Math.min(minX, u.x)
    minY = Math.min(minY, u.y)
    maxX = Math.max(maxX, u.x + NODE_W)
    maxY = Math.max(maxY, u.y + NODE_H)
  }
  return { x: minX - ZONE_PAD, y: minY - ZONE_HEAD, w: maxX - minX + ZONE_PAD * 2, h: maxY - minY + ZONE_HEAD + ZONE_PAD }
}

/** 章内推进顺序 = 数组顺序；按 (x, y) 重排（拖完松手时调用） */
export function sortChapter(units: readonly FlowUnitPos[]): FlowUnitPos[] {
  return [...units].sort((a, b) => (a.x - b.x) || (a.y - b.y))
}

/** 章内相邻链（折叠的章不产生连线） */
export function chainEdges(chapters: readonly FlowChapterShape[], collapsedIds: ReadonlySet<string>): FlowEdge[] {
  const out: FlowEdge[] = []
  for (const c of chapters) {
    if (collapsedIds.has(c.id)) continue
    for (let i = 0; i < c.units.length - 1; i++) {
      out.push({ chapterId: c.id, fromId: c.units[i].id, toId: c.units[i + 1].id })
    }
  }
  return out
}

/** 前 → 后 的三次贝塞尔（+2 箭头在渲染层加 marker） */
export function edgePath(from: Point, to: Point): string {
  const x1 = from.x + NODE_W, y1 = from.y + NODE_H / 2
  const x2 = to.x, y2 = to.y + NODE_H / 2
  const dx = Math.max(30, Math.abs(x2 - x1) * 0.45)
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`
}

/** 全部章框的外包矩形（缩略图 / 适应视图用） */
export function bounds(chapters: readonly FlowChapterShape[], collapsedIds: ReadonlySet<string>, excludeId?: string | null): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  chapters.forEach((c, i) => {
    const r = zoneRect({ units: c.units, index: i, collapsed: collapsedIds.has(c.id), excludeId })
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  })
  if (!isFinite(minX)) return { x: 0, y: 0, w: 800, h: 600 }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** 世界坐标命中：落点在哪个章框里（从上到下取第一个命中） */
export function zoneAtWorld(
  chapters: readonly FlowChapterShape[],
  collapsedIds: ReadonlySet<string>,
  wx: number,
  wy: number,
  excludeId?: string | null,
): string | null {
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i]
    const r = zoneRect({ units: c.units, index: i, collapsed: collapsedIds.has(c.id), excludeId })
    if (wx > r.x && wx < r.x + r.w && wy > r.y && wy < r.y + r.h) return c.id
  }
  return null
}

/** 自动整理：每章一行、章内从左到右；返回 unitId → 坐标 */
export function arrangePositions(chapters: readonly FlowChapterShape[]): Record<string, Point> {
  const out: Record<string, Point> = {}
  chapters.forEach((c, ci) => {
    const y = ROW_Y0 + ci * ROW_H
    c.units.forEach((u, ui) => {
      out[u.id] = { x: UNIT_X0 + ui * UNIT_GAP_X, y }
    })
  })
  return out
}

/** 跨章落点：追加到目标章末尾 */
export function appendSlot(chapterIndex: number, unitCount: number): Point {
  return { x: UNIT_X0 + unitCount * UNIT_GAP_X, y: ROW_Y0 + chapterIndex * ROW_H }
}

/** 屏幕坐标 → 世界坐标 */
export function screenToWorld(clientX: number, clientY: number, rectLeft: number, rectTop: number, view: Viewport): Point {
  return { x: (clientX - rectLeft - view.x) / view.k, y: (clientY - rectTop - view.y) / view.k }
}

/** 作用域层级（画布只画前三层；课时不画，见方案 §九 L0/R6） */
export type ScopeLevel = 'global' | 'workspace' | 'chapter' | 'unit'
export interface FlowScope {
  level: ScopeLevel
  chapterId?: string
  unitId?: string
}

/** 最外层框「全局 / 工作区」的外边距 */
export const OUTER_PAD = 18

/** 最外层框 = 全部章框的外包矩形 + 外边距 + 自己的标题条高度（章框不存坐标，随子节点变化） */
export function outerRect(chapters: readonly FlowChapterShape[], collapsedIds: ReadonlySet<string>, pad = OUTER_PAD): Rect {
  const b = bounds(chapters, collapsedIds)
  return { x: b.x - pad, y: b.y - ZONE_HEAD - pad, w: b.w + pad * 2, h: b.h + ZONE_HEAD + pad * 2 }
}
