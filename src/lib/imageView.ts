/**
 * 图片视图的纯几何（批 3，2026-10-13，v3.5.0 线）。
 *
 * 为什么抽成纯函数：这套算式是「错了也不报错、只是手感不对」的那一类 ——
 * 缩放不钉光标、旋转后图飞出视口、图小于视口却还能拖丢。它们没法靠读代码发现，
 * 只能靠**性质**断言。抽出来之后契约脚本能直接 import 真的 .ts 跑
 * （`.AGENT/scripts/image-viewer/verify-image-math.mjs`，`node --experimental-strip-types`）。
 *
 * 这些算式先在 `tmp/image-viewer-proto/index.html` 里被原型点过一轮，
 * 那 36 条性质在原型阶段就抓到了一个真问题（`zoomAbout` 的锚点入参口径，
 * 见该函数注释），此处是原文搬移，性质照旧成立。
 *
 * 不 import react / electron —— 同上，契约脚本要能直接 import。
 */

/** 视口留白（适应窗口时四周各留 32px，免得图贴着边） */
export const VIEW_PAD = 32
/** 平移余量：图比视口大时，允许拖到「边缘再往外 48px」——不留余量会让贴边的图拖不动 */
export const PAN_SLACK = 48
/** 缩放上下限。下限 0.02 是为了还能找到图；上限 16 是因为再往上只是看马赛克 */
export const MIN_SCALE = 0.02
export const MAX_SCALE = 16

export interface ViewBox { w: number; h: number }
export type ImageFitMode = 'fit' | 'width' | 'actual' | null

export interface ImageViewState {
  scale: number
  /** 当前所处的适应模式；手动缩放后置 null（否则窗口一变就被拉回，与用户意图打架） */
  fit: ImageFitMode
  /** 顺时针角度，只取 0 / 90 / 180 / 270 */
  rot: number
  /** 平移量（px），相对「居中」位置 */
  tx: number
  ty: number
}

export const initialImageView = (): ImageViewState => ({ scale: 1, fit: 'fit', rot: 0, tx: 0, ty: 0 })

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/**
 * 旋转 90 / 270 时**显示包围盒**的宽高互换。
 * ★ 适应窗口必须按这个盒子算，不能按原始宽高 —— 否则竖过来之后图会溢出视口一半。
 */
export function effNat(nat: ViewBox, rot: number): ViewBox {
  return rot % 180 === 0 ? { w: nat.w, h: nat.h } : { w: nat.h, h: nat.w }
}

/**
 * 适应比例。
 *
 * ★ `fit` 档**不放大超过 100%**（批 3 拍板 D8，2026-10-13）：一个 64×64 的图标
 *   适应窗口后就显示 64×64、居中一小块 —— VS Code / Obsidian 的口径。
 *   想大看有放大钮与双击（100% ⇄ 适应窗口），不必让默认态去插值放大（那只会糊）。
 *   原型里这一项做成了开关供对比，拍板后此处**不再留开关**。
 */
export function fitScale(mode: Exclude<ImageFitMode, null>, nat: ViewBox, rot: number, view: ViewBox): number {
  if (mode === 'actual') return 1
  const e = effNat(nat, rot)
  const availW = Math.max(1, view.w - VIEW_PAD)
  const availH = Math.max(1, view.h - VIEW_PAD)
  const raw = mode === 'width'
    ? availW / e.w
    : Math.min(availW / e.w, availH / e.h)
  return clamp(mode === 'width' ? raw : Math.min(1, raw), MIN_SCALE, MAX_SCALE)
}

/**
 * 平移夹取：图**小于**视口时该轴强制归零（始终居中，拖不动也丢不了）；
 * 大于视口时夹在「边缘 + PAN_SLACK」。
 */
export function clampPan(st: ImageViewState, nat: ViewBox, view: ViewBox): { tx: number; ty: number } {
  const e = effNat(nat, st.rot)
  const dw = e.w * st.scale
  const dh = e.h * st.scale
  const limX = Math.max(0, (dw - view.w) / 2 + PAN_SLACK)
  const limY = Math.max(0, (dh - view.h) / 2 + PAN_SLACK)
  return {
    tx: dw <= view.w ? 0 : clamp(st.tx, -limX, limX),
    ty: dh <= view.h ? 0 : clamp(st.ty, -limY, limY),
  }
}

/**
 * 缩放。`anchor` 是**视口内坐标**（`clientX - rect.left`），不传则以视口中心为锚。
 *
 * ★ 口径要害（原型阶段靠性质断言才发现的真问题，写在这里免得实现时重犯）：
 *   若把「相对视口中心」当入参传进来，锚点会整体偏 `(k-1)·(view.w/2, view.h/2)`。
 *   偏移量**恒定**，所以现象是「缩放本身正常、只是没钉在光标下」——
 *   肉眼几乎发现不了，而 Ctrl+滚轮缩放一旦不钉光标就没法用了
 *   （每滚一下目标就跑掉，越放大越难对准）。
 *
 * 算式：屏幕 = t + R(rot)·(s·c)，c 为图内坐标（相对图心）。
 * 反解光标下的 c，缩放后令同一个 c 仍落在光标处。
 */
export function zoomAbout(
  st: ImageViewState, nat: ViewBox, view: ViewBox, k: number, anchor?: { x: number; y: number },
): ImageViewState {
  const next = clamp(st.scale * k, MIN_SCALE, MAX_SCALE)
  if (!anchor) {
    const s: ImageViewState = { ...st, scale: next, fit: null }
    return { ...s, ...clampPan(s, nat, view) }
  }
  const p = { x: anchor.x - view.w / 2, y: anchor.y - view.h / 2 }
  const r0 = -st.rot * Math.PI / 180
  const c0 = Math.cos(r0), n0 = Math.sin(r0)
  const dx = p.x - st.tx, dy = p.y - st.ty
  const cx = (dx * c0 - dy * n0) / st.scale
  const cy = (dx * n0 + dy * c0) / st.scale
  const r1 = st.rot * Math.PI / 180
  const c1 = Math.cos(r1), n1 = Math.sin(r1)
  const s: ImageViewState = {
    scale: next,
    fit: null,
    rot: st.rot,
    tx: p.x - (next * cx * c1 - next * cy * n1),
    ty: p.y - (next * cx * n1 + next * cy * c1),
  }
  return { ...s, ...clampPan(s, nat, view) }
}

/** 切到某个适应模式（并清平移） */
export function withFitMode(
  st: ImageViewState, nat: ViewBox, view: ViewBox, mode: Exclude<ImageFitMode, null>,
): ImageViewState {
  return { scale: fitScale(mode, nat, st.rot, view), fit: mode, rot: st.rot, tx: 0, ty: 0 }
}

/**
 * 旋转 90°。**平移归零再按当前模式重算** —— 旋转后原来的平移方向不再成立，
 * 保留它会让图飞出视口（原型里就是这么处理并验过的）。
 */
export function rotateBy(
  st: ImageViewState, nat: ViewBox, view: ViewBox, delta: number,
): ImageViewState {
  const rot = (st.rot + delta + 360) % 360
  if (!st.fit) return { scale: st.scale, fit: null, rot, tx: 0, ty: 0 }
  return { scale: fitScale(st.fit, nat, rot, view), fit: st.fit, rot, tx: 0, ty: 0 }
}

/** 窗口尺寸变化 / 图装载完成后的重算：仍在适应模式就重算比例，自由态则只夹平移 */
export function reflow(st: ImageViewState, nat: ViewBox, view: ViewBox): ImageViewState {
  if (st.fit) return { scale: fitScale(st.fit, nat, st.rot, view), fit: st.fit, rot: st.rot, tx: 0, ty: 0 }
  return { ...st, ...clampPan(st, nat, view) }
}
