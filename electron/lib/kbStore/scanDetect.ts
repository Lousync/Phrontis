/**
 * 扫描版探测（书架阅读器 · 轻量扫描件识别，2026-09-20）。
 *
 * 零依赖纯函数文件 —— 刻意不 import 任何 electron / fs 模块：
 * 契约脚本 `.AGENT/scripts/pdf-reader/verify-reader-formats.mjs` 直接 import 跑用例。
 *
 * 口径：调用方（PdfReaderView 文档加载后）抽样若干页做 getTextContent 字符计数，
 * 本函数只做判定——texty 页（字符数 ≥ 20）占比 ≥75% → full；一个都没有 → no（纯扫描）；
 * 其余 → partial。空输入返回 'full'（无样本不定罪，缺省有文本层）。
 */

export const SCAN_MODES = ['full', 'partial', 'no'] as const

export type ScanMode = (typeof SCAN_MODES)[number]

/** 一页判定为「有文本层」的最小字符数（过滤页码/水印级零星字符） */
export const TEXTY_MIN_CHARS = 20

export function detectScanMode(
  charsPerPage: number[],
  opts?: { textyMinChars?: number },
): ScanMode {
  const arr = (Array.isArray(charsPerPage) ? charsPerPage : [])
    .map((v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0))
  if (arr.length === 0) return 'full'
  const min = opts?.textyMinChars ?? TEXTY_MIN_CHARS
  const texty = arr.filter((c) => c >= min).length
  const ratio = texty / arr.length
  if (ratio >= 0.75) return 'full'
  if (texty === 0) return 'no'
  return 'partial'
}
