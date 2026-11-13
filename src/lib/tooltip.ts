/**
 * 悬停提示（Tooltip）纯函数层（2026-11-13）。
 *
 * 形状定稿 = 方案 B「浮起一档 + 9px 微箭头」，先在 tmp/tooltip-proto 原型里对比了
 * 原生 title / 线性描边 / 强调微光 / 毛玻璃 / 胶囊六种皮肤后由用户拍板。
 *
 * 为什么单独抽纯函数：
 *   · 定位是「翻面 + 左右钳制 + 箭头回指锚点中心」三件事，最容易写错又最难手测；
 *   · 契约脚本 `.AGENT/scripts/tooltip/verify-tooltip.mjs` 直接 import 本文件跑用例，
 *     不需要 DOM，也不需要起 Electron；
 *   · 组件只负责「什么时候显示」，不负责「摆在哪」。
 */

/** 悬停多久浮出。关掉不走延迟（离开即收），扫过一列图标才不会连闪 */
export const TIP_OPEN_DELAY = 120

/** 气泡与锚点的间距 */
export const TIP_GAP = 8

/** 气泡与视口边缘的最小留白 */
export const TIP_EDGE = 8

/** 一个提示最多展示几枚键帽；超出的截断（防长键位串把气泡撑爆） */
export const TIP_MAX_KEYS = 4

/** 箭头至少要离气泡圆角这么远，避免悬在圆角上 */
export const TIP_ARROW_INSET = 14

export interface TipRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface TipSize {
  width: number
  height: number
}

export interface TipViewport {
  width: number
  height: number
}

export interface TipPlacement {
  left: number
  top: number
  place: 'top' | 'bottom'
  /** 箭头中心相对气泡左缘的 x（夹在圆角内侧） */
  arrowX: number
}

export interface PlaceOptions {
  gap?: number
  edge?: number
  /** 调试 / 截图用：强制方向（正常调用不要传，交给翻面逻辑） */
  force?: 'top' | 'bottom' | null
}

function clamp(value: number, min: number, max: number): number {
  // max 可能小于 min（视口比气泡还窄的极端情况），此时以 min 为准，保证左边不被裁
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * 计算气泡位置。
 *
 * 口径：
 *   · 默认朝上；上方放不下且下方放得下 → 翻到下方；两边都放不下时**不翻**，交给钳制兜底。
 *   · 水平永远以锚点中心对齐，再整体夹回视口 —— 夹回来之后箭头单独回指锚点中心。
 *     这是和「气泡跟着夹、箭头也跟着夹」做法唯一的区别：贴边时箭头仍然指着触发点。
 */
export function placeTooltip(
  anchor: TipRect,
  size: TipSize,
  viewport: TipViewport,
  options: PlaceOptions = {},
): TipPlacement {
  const gap = options.gap ?? TIP_GAP
  const edge = options.edge ?? TIP_EDGE
  const w = Math.max(size.width, 0)
  const h = Math.max(size.height, 0)
  const centerX = anchor.left + anchor.width / 2

  const roomAbove = anchor.top - gap - h >= edge
  const roomBelow = anchor.bottom + gap + h <= viewport.height - edge

  let place: 'top' | 'bottom'
  if (options.force) {
    place = options.force
  } else if (roomAbove) {
    place = 'top'
  } else if (roomBelow) {
    place = 'bottom'
  } else {
    place = 'top'
  }

  const rawTop = place === 'top' ? anchor.top - gap - h : anchor.bottom + gap
  const top = clamp(rawTop, edge, viewport.height - edge - h)
  const left = clamp(centerX - w / 2, edge, viewport.width - edge - w)
  const arrowX = clamp(centerX - left, TIP_ARROW_INSET, w - TIP_ARROW_INSET)

  return {
    left: Math.round(left),
    top: Math.round(top),
    place,
    arrowX: Math.round(arrowX),
  }
}

/**
 * 解析 `data-keys`：逗号分隔，去空白、去空项、限量。
 * 不用空格分隔是因为键帽本身可能含空格（如「空格」）。
 */
export function parseTipKeys(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, TIP_MAX_KEYS)
}

/**
 * 给普通 DOM 元素铺 `data-tip` / `data-keys`。
 *
 * 迁移口径：把 `title="打开命令面板"` 换成 `{...tipAttrs('打开命令面板', ['Ctrl','Shift','P'])}`，
 * 不再拼「（Ctrl + Shift + P）」这种括号串 —— 键帽由气泡自己渲染。
 */
export function tipAttrs(label: string, keys?: string[]): Record<string, string> {
  const attrs: Record<string, string> = { 'data-tip': label }
  const list = (keys ?? []).map((k) => k.trim()).filter(Boolean).slice(0, TIP_MAX_KEYS)
  if (list.length > 0) attrs['data-keys'] = list.join(',')
  return attrs
}
