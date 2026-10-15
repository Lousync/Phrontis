/**
 * 页面条横向溢出：**纯计算**（台账 F-16，2026-10-13）。
 *
 * 为什么单独一层：溢出修的三条判据（边沿渐隐什么时候出、激活条目该滚到哪、滚轮要不要劫持）
 * 全是算术，跟 DOM 无关。放这里就能被 Node 直接加载跑行为契约
 * （`.AGENT/scripts/workbench-shell/verify-strip-overflow.mjs`）——所以本文件**零 import**：
 * node 的 ESM 不做扩展名补全，内部一旦出现 `./xxx` 就 ERR_MODULE_NOT_FOUND
 * （同 electron/lib/releaseNotes/judge.ts 的口径）。DOM 侧只负责取值与写回，
 * 见 `src/components/workbench/useStripScroll.tsx`。
 */

/** 滚动容器的三个数（`scrollLeft / clientWidth / scrollWidth` 原样传入） */
export interface StripMetrics {
  scrollLeft: number
  clientWidth: number
  scrollWidth: number
}

/** 条目在**滚动内容坐标系**里的左右边界（不是视口坐标：= 视口 left - 容器 left + scrollLeft） */
export interface StripItemBox {
  start: number
  end: number
}

/** 亚像素容差：缩放 / 分数宽度下 scrollWidth - clientWidth 常带零点几的残差 */
const EPS = 1

/** 可滚动的最大位移（无溢出 = 0） */
export function stripMaxScroll(m: StripMetrics): number {
  return Math.max(0, m.scrollWidth - m.clientWidth)
}

/**
 * 左右两侧是否还有被藏起来的条目 —— 渐隐提示的开关。
 * 静止且不溢出时两侧都 false（不画任何渐隐，外观与修前一致）。
 */
export function stripEdges(m: StripMetrics): { left: boolean; right: boolean } {
  const max = stripMaxScroll(m)
  return {
    left: m.scrollLeft > EPS,
    right: m.scrollLeft < max - EPS,
  }
}

/**
 * 把某个条目滚进可视区，返回**目标 scrollLeft**；已在可视区内则返回 null（不动，避免抖动）。
 *
 * `pad` 是两侧留的空隙，默认 10px：激活条目的两侧各有一道 8px 内凹弧
 * （`.kb-edge-tab-active::before/::after`，index.css:1508-1518），贴着滚动口会把弧裁掉，
 * 看起来像「页签缺了一个角」。留 10px 就够弧完整露出来。
 *
 * 为什么不用 `scrollIntoView`：它只保证「露出来」，不留空隙（贴边 = 弧被裁）；
 * 且它是元素级 API，测不了、也没法在契约里锁行为。
 */
export function stripReveal(m: StripMetrics, item: StripItemBox, pad = 10): number | null {
  const max = stripMaxScroll(m)
  if (max <= 0) return null
  if (item.start - pad < m.scrollLeft) return Math.max(0, Math.min(max, item.start - pad))
  if (item.end + pad > m.scrollLeft + m.clientWidth) {
    return Math.max(0, Math.min(max, item.end + pad - m.clientWidth))
  }
  return null
}

/**
 * 滚轮 → 横向滚动：返回本次要施加的 `scrollLeft` 增量（0 = 别动，交回原生）。
 *
 * 为什么要劫持：鼠标滚轮只发 deltaY，横向滚动容器对纵向滚轮**毫无反应**
 * （Chromium 只在 Shift+滚轮 / 触控板横向手势时才横滚）—— 一个够不到的模块页签，
 * 光靠把区域改成可滚还是够不到，必须有滚轮这一路（VS Code 标签条同口径）。
 *
 * 三种情况交回原生：① 没有横向溢出（不该吞掉滚轮）；② Shift+滚轮（原生就是横滚，
 * 再叠加会变双倍速）；③ 触控板横向手势（|deltaX| > |deltaY|，原生处理得比我们好）。
 */
export function stripWheelDelta(
  e: { deltaX: number; deltaY: number; shiftKey: boolean },
  m: StripMetrics,
): number {
  if (stripMaxScroll(m) <= EPS) return 0
  if (e.shiftKey) return 0
  if (!e.deltaY) return 0
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return 0
  return e.deltaY
}
