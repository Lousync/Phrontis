/**
 * 文本解码（书架升级全格式阅读器一期）：BOM 优先 → UTF-8 严格 → GB18030 兜底。
 *
 * 零依赖纯函数文件 —— 契约脚本 verify-reader-formats.mjs 用
 * `node --experimental-strip-types` 直接 import 跑用例表；
 * 渲染层消费方 = TxtReaderView（唯一）。
 *
 * 2026-09-21 改造（A1 按需分块续读）：拆分出 `detectEncoding` / `decodeWith` 两个纯函数，
 * 首块探测一次编码、后续块沿用（`decodeText` 保留为兼容包装，契约脚本仍在跑）。
 */

/** 探测出的编码标签（utf8-bom 仅首块出现一次，后续块按 utf8 处理） */
export type TextEncoding = 'utf8-bom' | 'utf16le' | 'utf16be' | 'utf8' | 'gb18030'

/** 探测编码：只读开头若干字节，不解码正文。无 BOM 时探测 UTF-8 严格是否可行，否则回落 GB18030。 */
export function detectEncoding(firstBytes: Uint8Array): TextEncoding {
  // ① BOM：EF BB BF = UTF-8；FF FE = UTF-16LE；FE FF = UTF-16BE
  if (firstBytes.length >= 3 && firstBytes[0] === 0xef && firstBytes[1] === 0xbb && firstBytes[2] === 0xbf) return 'utf8-bom'
  if (firstBytes.length >= 2 && firstBytes[0] === 0xff && firstBytes[1] === 0xfe) return 'utf16le'
  if (firstBytes.length >= 2 && firstBytes[0] === 0xfe && firstBytes[1] === 0xff) return 'utf16be'
  // ② 无 BOM：UTF-8 严格可解码即 utf8，否则 GB18030（超集覆盖 GBK/GB2312）
  // 仅取前 1MB 探样即可（文件整体同编码；极端混合编码本就无解，与旧 decodeText 语义一致）
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(firstBytes.subarray(0, Math.min(firstBytes.length, 1024 * 1024)))
    return 'utf8'
  } catch {
    return 'gb18030'
  }
}

/** 按已探测编码解码一段字节（BOM 由 detectEncoding 阶段识别，本函数按标签剥离对应 BOM） */
export function decodeWith(bytes: Uint8Array, enc: TextEncoding): string {
  switch (enc) {
    case 'utf8-bom': return new TextDecoder('utf-8').decode(bytes.subarray(3))
    case 'utf16le': return new TextDecoder('utf-16le').decode(bytes.subarray(2))
    case 'utf16be': return new TextDecoder('utf-16be').decode(bytes.subarray(2))
    case 'utf8': return new TextDecoder('utf-8').decode(bytes)
    case 'gb18030': return new TextDecoder('gb18030').decode(bytes)
  }
}

/** 兼容包装：一次性探测 + 解码（契约脚本用例表走此函数，行为不变） */
export function decodeText(u8: Uint8Array): string {
  return decodeWith(u8, detectEncoding(u8))
}
