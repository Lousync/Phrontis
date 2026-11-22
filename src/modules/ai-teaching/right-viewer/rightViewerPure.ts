/**
 * 右侧查看器 · 纯函数层（零运行时依赖，只 `import type`）
 *
 * 方案：`docs/ai-teaching-right-viewer-plan.md` §3.2 / §3.3 / §5.1 / §9，
 * 内核决策 C5（四页签）/ C7（overlay 可调宽）/ D5（切页签只隐藏不卸载）。
 *
 * 为什么单独拆一层：宽度夹紧与页签迁移都是「看起来一行、实际到处出错」的逻辑
 * （负数宽度、innerWidth 很小的分屏、旧键 lanes 迁移）。抽成纯函数后
 * `.AGENT/scripts/ai-teaching/verify-right-viewer-shell.mjs` 可以脱离 DOM 直接跑，
 * 不必起 Electron 就能锁住边界。
 */

import type { ViewerTabKey } from './paneContracts'

/* ============================== 常量 ============================== */

/** 宽度下限：再窄就放不下书架网格 / 笔记正文 */
export const VIEWER_MIN_WIDTH = 360
/** 宽度上限：再宽中栏就没法读了（960 之上留给全屏阅读） */
export const VIEWER_MAX_WIDTH = 960
/** 默认宽（SETTINGS 里 `aiTeachRightViewerWidth` 的默认值必须与这里一致） */
export const VIEWER_DEFAULT_WIDTH = 480
/** 给中栏保留的最小可读宽度：窗口不够宽时上限收窄到 `innerWidth - 这条` */
export const VIEWER_RESERVED_WIDTH = 300

const TAB_LABELS: Readonly<Record<ViewerTabKey, string>> = {
  web: '网页',
  notes: '笔记',
  books: '书架',
  ask: '旁问',
}

/* ============================== 页签 ============================== */

/**
 * 页签键判定。
 *
 * 这里不复用 `paneContracts.isViewerTabKey`：契约层是**运行时**模块，
 * 一旦 import，本文件就再也不能被契约脚本单独 strip 后运行（会缺依赖）。
 * 所以纯函数层自带一份 —— 两份的取值必须一致，脚本会交叉断言。
 */
export function isViewerTabKey(v: unknown): v is ViewerTabKey {
  return v === 'web' || v === 'notes' || v === 'books' || v === 'ask'
}

/**
 * 旧右栏页签（`aiTeach.railTab`）→ 新页签。
 *
 * `lanes`（支线）由「旁问」接管；`progress` / `sources` 不再进查看器，
 * 一律落回网页 —— 这是 §7.2 的迁移口径，坏值同样落回网页而不是报错。
 */
export function migrateRailTab(raw: string | null | undefined): ViewerTabKey {
  if (typeof raw !== 'string') return 'web'
  const key = raw.trim()
  if (key === 'lanes' || key === 'ask') return 'ask'
  if (key === 'notes' || key === 'books' || key === 'web') return key
  return 'web'
}

/** 页签文案（页签条、aria-label、空态标题共用一份，避免三处各写一套） */
export function tabLabel(tab: ViewerTabKey): string {
  return isViewerTabKey(tab) ? TAB_LABELS[tab] : TAB_LABELS.web
}

/**
 * 网页原生视图是否必须 hide。
 *
 * 为什么这条要独立成函数：`WebContentsView` **永远盖在 DOM 之上**，
 * 漏一次 hide 就会在别的页签 / 关闭后的空白处留下白块，而且不报错。
 * 判据只有两个来源：面板关了，或者当前页签不是网页（pane 保活但不可见）。
 * `tab = null` = 一个页签都没有，同样必须 hide。
 */
export function shouldHideWebViewer(open: boolean, tab: ViewerTabKey | null): boolean {
  return !open || tab !== 'web'
}

/* ============================== 宽度 ============================== */

/** 当前窗口可用的宽度上限（夹在 MIN..MAX 之间，绝不返回小于 MIN 的值） */
function upperWidth(innerWidth: number): number {
  if (!Number.isFinite(innerWidth) || innerWidth <= 0) return VIEWER_MAX_WIDTH
  // 分屏 / 小窗时 `innerWidth - 300` 可能低于 360：此时按 360 收，不要返回负数。
  return Math.max(VIEWER_MIN_WIDTH, Math.min(VIEWER_MAX_WIDTH, innerWidth - VIEWER_RESERVED_WIDTH))
}

/**
 * 宽度夹紧：坏值（非数字 / NaN / Infinity / <= 0）落回 480，再夹进视口可用区间。
 */
export function clampViewerWidth(raw: unknown, innerWidth: number): number {
  const base =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : VIEWER_DEFAULT_WIDTH
  return Math.round(Math.min(upperWidth(innerWidth), Math.max(VIEWER_MIN_WIDTH, base)))
}

/**
 * 首帧宽度：持久值可能来自 SETTINGS（unknown）或根本没写过。
 * 语义与 `clampViewerWidth` 一致，单独留一个名字是为了让调用点读起来是「初值」而不是「夹紧」。
 */
export function initialViewerWidth(persisted: unknown, innerWidth: number): number {
  return clampViewerWidth(persisted, innerWidth)
}

/**
 * 面板根节点的内联宽度样式。
 *
 * `minWidth` 恒为 0（而不是等于 width）：min 一旦等于目标宽度，
 * CSS 会把 used width 立刻撑到 min，收起 / 展开的宽度过渡就被吃掉了。
 * 这里输出它只是为了让调用点拿到的是一份完整 style，不漏项。
 */
export function viewerWidthStyle(open: boolean, width: number): { width: string; minWidth: string } {
  const safe = Number.isFinite(width) && width > 0 ? Math.round(width) : VIEWER_DEFAULT_WIDTH
  return { width: open ? `${safe}px` : '0px', minWidth: '0px' }
}
