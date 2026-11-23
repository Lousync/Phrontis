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
/**
 * **旧口径**（不再用于真实布局）：给中栏留 300px。
 *
 * 它只按 `innerWidth` 算，没扣活动栏 + 左栏，窗口一窄就把压力全给中栏
 * （900px 窗下中栏只剩 ≈227px）。现在只剩「调用方没给 reserve」时的兼容缺省。
 */
export const VIEWER_RESERVED_WIDTH = 300
/**
 * 中栏最小可读宽度：查看器上限必须给中栏留出这么多，
 * 否则正文一行只剩 4 个字、输入区工具条竖排（900×700 实机复现）。
 */
export const VIEWER_MIN_MIDDLE_WIDTH = 420
/**
 * 紧凑下限：窗口实在放不下（中栏留够 420 后连 360 都给不出）时，
 * 查看器可以降到 300 —— 但不再往下。
 * ★ 不做「自动关查看器 / 自动折左栏」腾地方：状态自己变，用户会懵。
 */
export const VIEWER_TIGHT_MIN_WIDTH = 300
/** 取不到中栏左缘时的回退：活动栏 63 + 左栏默认 248 */
export const VIEWER_MIDDLE_LEFT_FALLBACK = 63 + 248

const TAB_LABELS: Readonly<Record<ViewerTabKey, string>> = {
  web: '网页',
  notes: '笔记',
  books: '书架',
  ask: '旁问',
  file: '文件',
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
  return v === 'web' || v === 'notes' || v === 'books' || v === 'ask' || v === 'file'
}

/**
 * 旧右栏页签（`aiTeach.railTab`）→ 新页签。
 *
 * `lanes`（支线）由「旁问」接管；`progress` / `sources` 不再进查看器，
 * 一律落回网页 —— 这是 §7.2 的迁移口径，坏值同样落回网页而不是报错。
 * `file` **刻意不接受**：旧右栏没有文件页签，文件只从左栏 / 素材 / 产物进入。
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

/** 有效 reserve（NaN / 负数 / 未传一律视作「没给」） */
function normalizeReserve(reserve: number | undefined | null): number | null {
  return typeof reserve === 'number' && Number.isFinite(reserve) && reserve > 0 ? reserve : null
}

/**
 * reserve = 中栏左缘 + 中栏最小可读宽度。
 *
 * 中栏左缘由调用方实测（`section.getBoundingClientRect().left`），它天然包含
 * 活动栏 + 左栏（展开 / 折叠 / 拖宽都算在内）；取不到时回退
 * `63 + 248（活动栏 + 左栏默认宽）+ 420`。
 */
export function viewerReserveWidth(middleLeft?: number | null): number {
  const left = typeof middleLeft === 'number' && Number.isFinite(middleLeft) && middleLeft >= 0
    ? middleLeft
    : VIEWER_MIDDLE_LEFT_FALLBACK
  return Math.round(left + VIEWER_MIN_MIDDLE_WIDTH)
}

/**
 * 当前窗口可用的宽度上限。
 *
 * - 给了 reserve：`innerWidth - reserve`，下限 `VIEWER_TIGHT_MIN_WIDTH`（300）；
 * - 没给 reserve：沿用旧口径 `innerWidth - VIEWER_RESERVED_WIDTH(300)`，下限仍是 360。
 *
 * 「下限跟着口径走」是刻意的：紧凑下限只在调用方明确知道中栏左缘时启用，
 * 否则等于偷偷放宽了老调用方的下界。
 */
export function upperWidth(innerWidth: number, reserve?: number): number {
  const safeReserve = normalizeReserve(reserve)
  const floor = safeReserve == null ? VIEWER_MIN_WIDTH : VIEWER_TIGHT_MIN_WIDTH
  if (!Number.isFinite(innerWidth) || innerWidth <= 0) return VIEWER_MAX_WIDTH
  return Math.max(floor, Math.min(VIEWER_MAX_WIDTH, innerWidth - (safeReserve ?? VIEWER_RESERVED_WIDTH)))
}

/**
 * 宽度夹紧：坏值（非数字 / NaN / Infinity / <= 0）落回 480，再夹进视口可用区间。
 *
 * 下界是 `min(min, upper)` —— 窗口过窄导致上限低于 360 时，下界**跟着上限降下来**
 * （绝不会出现 `min > max` 把夹紧反着用的老坑）；窗口正常时下界仍是 360。
 */
export function clampViewerWidth(
  raw: unknown,
  innerWidth: number,
  reserve?: number,
  min: number = VIEWER_MIN_WIDTH,
  max: number = VIEWER_MAX_WIDTH,
): number {
  const upper = Math.min(max, upperWidth(innerWidth, reserve))
  const lower = Math.min(min, upper)
  const base =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : VIEWER_DEFAULT_WIDTH
  return Math.round(Math.min(upper, Math.max(lower, base)))
}

/**
 * 首帧宽度：持久值可能来自 SETTINGS（unknown）或根本没写过。
 * 语义与 `clampViewerWidth` 一致，单独留一个名字是为了让调用点读起来是「初值」而不是「夹紧」。
 */
export function initialViewerWidth(persisted: unknown, innerWidth: number, reserve?: number): number {
  return clampViewerWidth(persisted, innerWidth, reserve)
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
