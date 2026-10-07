/**
 * PDF 阅读器三模式布局纯函数（v3.4.0 PDF 整包批次 3，方案 pdf-reader-v340-design §5.2）。
 *
 * 零依赖、零副作用 —— 契约脚本 `.AGENT/scripts/pdf-reader/verify-pdf-reader.mjs`
 * 用 `node --experimental-strip-types` 直接 import 本文件做用例表验证（§10①），
 * 严禁引入 react / pdfjs / electron 等任何依赖。
 */

export type PdfLayoutMode = 'scroll' | 'single' | 'duo'

/** 双页模式最低容器宽（拍板口径 §5.3）：低于即自动降级单页 + toast */
export const DUO_MIN_WIDTH = 1240

/**
 * 双页跨页起始页归一化（方案 §5.2，原型 v9 真 bug 的修复口径）：
 * 奇数原样返回；偶数退一页（第 1 页特例不动）；0/负数兜 1。
 * 例：1→1，2→1，7→7，12→11。
 */
export function normalizeSpreadStart(p: number): number {
  const n = Math.floor(Number(p))
  if (!Number.isFinite(n) || n < 1) return 1
  return n % 2 === 1 ? n : Math.max(1, n - 1)
}

/**
 * 双页模式给定起始页应渲染的页对 [p, p+1]（末页单收）。
 * 入参允许偶数（内部先归一化），返回值保证都在 1..numPages 内。
 */
export function spreadPages(p: number, numPages: number): number[] {
  const total = Math.max(1, Math.floor(Number(numPages) || 1))
  const start = normalizeSpreadStart(p)
  const clamped = Math.min(start, total)
  return clamped + 1 <= total ? [clamped, clamped + 1] : [clamped]
}

/**
 * 响应式降级（方案 §5.3）：双页需容器 ≥ DUO_MIN_WIDTH，低于自动降级单页；
 * 其他模式原样返回。
 */
export function resolveDegrade(width: number, mode: PdfLayoutMode): PdfLayoutMode {
  if (mode === 'duo' && width < DUO_MIN_WIDTH) return 'single'
  return mode
}

/**
 * 按首页宽高比估算第 n 页占位高度（方案 §5.2 竖滚虚拟渲染的占位依据）：
 * 高 = 首页高 × (容器可用宽 / 首页宽)。异常输入兜底 ≥1，估歪由真实渲染后自然校正。
 */
export function estimatePageHeight(firstW: number, firstH: number, availW: number): number {
  const w = Number(firstW) > 0 ? Number(firstW) : 0
  const h = Number(firstH) > 0 ? Number(firstH) : 0
  const aw = Number(availW) > 0 ? Number(availW) : 0
  if (w <= 0 || h <= 0 || aw <= 0) return 1
  return Math.max(1, Math.round((h * aw) / w))
}
