/**
 * 文本解码（书架升级全格式阅读器一期）：BOM 优先 → UTF-8 严格 → GB18030 兜底。
 *
 * 零依赖纯函数文件 —— 契约脚本 verify-reader-formats.mjs 用
 * `node --experimental-strip-types` 直接 import 跑用例表；
 * 渲染层消费方 = TxtReaderView（唯一）。
 */

/** 文本解码：BOM 优先 → UTF-8 严格 → GB18030 兜底（契约脚本跑用例表，勿内联） */
export function decodeText(u8: Uint8Array): string {
  // ① BOM：EF BB BF = UTF-8；FF FE = UTF-16LE；FE FF = UTF-16BE
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(u8.subarray(3))
  }
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(u8.subarray(2))
  }
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(u8.subarray(2))
  }
  // ② UTF-8 严格模式：有非法字节即抛错
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8)
  } catch {
    // ③ GB18030 兜底（超集覆盖 GBK/GB2312）
    return new TextDecoder('gb18030').decode(u8)
  }
}
