/**
 * 划词浮层的定位口径（纯函数 + 三个读数口）—— 划选浮条 / 翻译卡片 / 词典卡片共用。
 *
 * 为什么单独抽出来：这套「夹进可视范围」的算法已经踩过两次同一类坑，而且都不报错：
 * ① **只按窗口右缘夹**（老代码写死 `innerWidth - 340`，而那比浮条窄）：选区靠右时浮条
 *    右半截滑进悬浮 AI 侧栏底下 —— 表象是「复制 / 关闭像被侧栏盖住、点不到」；
 * ② **按挂载那一刻量的高度摆位**：词典结果 / AI 结果随后才长出来，卡片长过窗口底缘被截断
 *    —— 表象是「划靠下的词，卡片下半截看不见」。
 *
 * 所以这里只留：夹水平位置、选上下方向（用**可用空间**而不是已渲染高度，内容随到随长也不会跳）、
 * 以及「安全右缘」（把悬浮 AI 侧栏一起算进去）。组件只负责量自己的宽高。
 */

export interface Rect4 { left: number; top: number; right: number; bottom: number }

/** 浮层与锚点 / 容器边界的最小间距 */
export const FLOAT_GAP = 8

/**
 * 水平：与锚点左缘对齐，再夹进 `[bounds.left + gap, bounds.right - gap - width]`。
 * 比整个可用宽度还宽时贴左缘（调用方同时给 maxWidth 让它换行，右侧才不会出界）。
 */
export function clampFloatingLeft(anchorLeft: number, width: number, bounds: Rect4, gap = FLOAT_GAP): number {
  const min = bounds.left + gap
  const max = bounds.right - gap - width
  if (max <= min) return min
  return Math.min(Math.max(anchorLeft, min), max)
}

export type VerticalSide = 'below' | 'above'

export interface VerticalPlacement {
  side: VerticalSide
  /** side === 'below'：浮层**顶缘的绝对 y**（可直接当 CSS `top` 用） */
  top?: number
  /** side === 'above'：浮层**底缘的绝对 y**（CSS `bottom` = 窗口高 - 该值；底缘贴着选区，内容长短都不会把缝拉开） */
  bottomEdge?: number
  /** 该方向能给出的最大高度（调用方作为 maxHeight 用，超出的内容内部滚动） */
  maxHeight: number
}

/**
 * 垂直：按**可用空间**（不是已渲染高度）选边 —— 首选方向至少要放得下 `min(期望高度, minUsable)`，
 * 否则翻到另一侧；两侧都放不下就取空间更大的一侧，并把高度收进那段空间里。
 *
 * ★ 刻意不依赖「内容当前高度」：词典 / AI 结果是流式长出来的，按实时高度选边会在生成过程中
 *   反复翻面（卡片上下跳）。按空间一次定边 + maxHeight 封顶，长多少都不会越界。
 */
export function placeFloatingVertically(opts: {
  anchorTop: number
  anchorBottom: number
  bounds: Rect4
  /** 内容希望的最大高度（封顶值） */
  cap: number
  /** 首选方向：卡片习惯在下方，划选浮条习惯在上方 */
  prefer?: VerticalSide
  /** 首选方向至少留出这么多空间才算「放得下」 */
  minUsable?: number
  gap?: number
}): VerticalPlacement {
  const { anchorTop, anchorBottom, bounds, cap, prefer = 'below', minUsable = 160, gap = FLOAT_GAP } = opts
  const spaceBelow = bounds.bottom - gap - (anchorBottom + gap)
  const spaceAbove = anchorTop - gap - (bounds.top + gap)
  const primary = prefer === 'below' ? spaceBelow : spaceAbove
  const secondary = prefer === 'below' ? spaceAbove : spaceBelow
  const fits = primary >= Math.min(cap, minUsable)
  const side: VerticalSide = fits || primary >= secondary ? prefer : (prefer === 'below' ? 'above' : 'below')
  const space = side === 'below' ? spaceBelow : spaceAbove
  const maxHeight = Math.max(48, Math.min(cap, space))
  return side === 'below'
    ? { side, top: anchorBottom + gap, maxHeight }
    : { side, bottomEdge: anchorTop - gap, maxHeight }
}

/** 「底缘绝对 y」→ CSS `bottom` 偏移（浮层是 fixed，用视口高换算；bounds 可能是阅读面，不能直接当容器底） */
export function toCssBottom(bottomEdge: number): number {
  return window.innerHeight - bottomEdge
}

/**
 * 浮层的安全右缘：默认窗口右缘；**悬浮 AI 助手开着时退到它的左缘**。
 * 侧栏是 `fixed` 盖在内容之上的（整窗阅读时正文照样铺到底），不把它算进去，
 * 浮层就会滑到侧栏底下 —— 这才是「按钮像被侧栏盖住」的根因。
 */
export function floatingSafeRight(fallback: number): number {
  const panel = document.getElementById('assistant-panel-root')
  if (!panel) return fallback
  const r = panel.getBoundingClientRect()
  // 打开动画的中间态宽度可能是 0，此时不参与夹取
  return r.width > 1 ? Math.min(fallback, r.left) : fallback
}

/**
 * 浮层可用框：以最近的「阅读面」（`data-reader-surface`）为界，右缘再与安全右缘取交。
 * 阅读面给了就拿它 —— 阅读器被侧栏挤窄时，根节点矩形就是**正文实际可见区**；
 * 阅读器是整窗铺开（侧栏浮在上面）时根节点矩形等于窗口，此时由 `floatingSafeRight` 收口。
 */
export function floatingBounds(el?: Element | null): Rect4 {
  const surface = el?.closest('[data-reader-surface]') as HTMLElement | null
  const r = surface?.getBoundingClientRect()
  return {
    left: r?.left ?? 0,
    top: r?.top ?? 0,
    right: floatingSafeRight(r?.right ?? window.innerWidth),
    bottom: r?.bottom ?? window.innerHeight,
  }
}
