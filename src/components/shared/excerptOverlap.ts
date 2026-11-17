/**
 * 摘录高亮「重叠不混色」的纯几何工具 —— 三种阅读器（PDF / EPUB 系 / TXT）共用同一口径：
 *
 *   **后建的盖住先建的**：一段文字被两条摘录覆盖时，只显示较新那条的颜色；
 *   旧条目被扣掉重叠区，绝不出现「黄 + 蓝 = 脏绿」的叠加。
 *
 * 数据一条都不动（右栏仍能看到、能单独删除），只改**画**的结果。
 *
 * 坐标不限定单位：EPUB 用内容帧里的 px、PDF 用文本层的 0..1 百分比，公式完全同式；
 * 碎片过滤阈值 `eps` 由调用方按单位给（px 给 0.5，百分比给 0.0005）。
 * 纯函数、零依赖 —— 契约脚本 `.AGENT/scripts/excerpt-overlap/verify-overlap.mjs` 直接 import。
 */

export interface OverlapRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** 轴对齐矩形求交；面积 ≤ 0 视为不相交（贴边不算覆盖） */
export function intersectRect(a: OverlapRect, b: OverlapRect): OverlapRect | null {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const right = Math.min(a.right, b.right)
  const bottom = Math.min(a.bottom, b.bottom)
  if (right - left <= 0 || bottom - top <= 0) return null
  return { left, top, right, bottom }
}

/**
 * 从 `base` 里扣掉 `cover`，返回剩余碎片（最多 4 块：上 / 下 / 左 / 右）。
 * 不相交时原样返回一块；被完全覆盖时返回空数组。
 */
export function subtractRect(base: OverlapRect, cover: OverlapRect, eps = 0.01): OverlapRect[] {
  const hit = intersectRect(base, cover)
  if (!hit) return [base]
  const out: OverlapRect[] = []
  const push = (r: OverlapRect) => {
    // 扣完之后剩下的 1px 级细条没有视觉意义，反而会多出几个 DOM 节点
    if (r.right - r.left > eps && r.bottom - r.top > eps) out.push(r)
  }
  push({ left: base.left, top: base.top, right: base.right, bottom: hit.top })
  push({ left: base.left, top: hit.bottom, right: base.right, bottom: base.bottom })
  push({ left: base.left, top: hit.top, right: hit.left, bottom: hit.bottom })
  push({ left: hit.right, top: hit.top, right: base.right, bottom: hit.bottom })
  return out
}

/**
 * 一条摘录的**可见碎片** = 自己的矩形组依次扣掉所有「更新」的矩形组。
 * `newer` 是比它新的全部摘录的矩形（顺序无关，逐个扣即可）。
 */
export function visibleRects(rects: OverlapRect[], newer: OverlapRect[], eps = 0.01): OverlapRect[] {
  let out = rects.slice()
  for (const cover of newer) {
    if (out.length === 0) break
    const next: OverlapRect[] = []
    for (const r of out) next.push(...subtractRect(r, cover, eps))
    out = next
    // 兜底：多色反复交叠时碎片数最坏是 4^n，实战不会到；真到了就停手（宁可少画几块碎片）
    if (out.length > 256) break
  }
  return out
}

/**
 * TXT 用：字符区间版的同一口径 —— 段内命中 `[start, end)` 的**最后一条**（最晚创建）。
 * 调用方保证 `marks` 按创建时间升序（`excerptList` 已按 `at` 排序）。
 */
export function newestMarkAt<T extends { start: number; end: number }>(
  marks: T[],
  start: number,
  end: number,
): T | undefined {
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i]
    if (m.start <= start && m.end >= end) return m
  }
  return undefined
}
