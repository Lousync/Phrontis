/**
 * 图片尺寸读取（零依赖纯函数）—— v3.6.0 对话内生图（docs/ai-image-gen-plan.md §4.2/§6）。
 *
 * 为什么不用图片库：主进程只要"这张图多大"这一个数（卡上元信息、工件栏尺寸、
 * 成品卡的 aspect-ratio），为它引一个解码器（sharp/jimp）是几 MB 的原生依赖，
 * 而 PNG/JPEG 的尺寸就写在文件头的前几十个字节里。这里只读头、不解码像素。
 *
 * ★ 为什么单独成"纯"文件：契约脚本要**真跑**它（喂几个构造出来的头字节断言结果），
 *   而不是只做源码文本断言。故本文件不 import electron / node:fs，只用 Buffer（node 全局）。
 *
 * 取不到的形态一律返回 null（调用方按"未知尺寸"降级，不要瞎猜）：
 *  · GIF / WebP / BMP / SVG —— 生图端点实际只回 png/jpeg，别为它们写解析器；
 *  · 被截断 / 非法头 —— 宁可返回 null 也不要抛，落盘路径不能被尺寸解析失败打断。
 */

export interface ImageSize { w: number; h: number }

/** PNG：8 字节签名 + 4 字节长度 + "IHDR" + 宽(4) + 高(4)，宽高都是大端 uint32 */
function pngSize(buf: Buffer): ImageSize | null {
  if (buf.length < 24) return null
  // 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  return w > 0 && h > 0 ? { w, h } : null
}

/** JPEG：SOI(FFD8) → 逐段跳过 → 命中 SOFn(FFC0..FFCF，除 C4/C8/CC) 时读高/宽（大端 uint16） */
function jpegSize(buf: Buffer): ImageSize | null {
  if (buf.length < 4) return null
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue } // 填充字节（0xFF 可重复出现）
    const marker = buf[i + 1]
    if (marker === 0xff) { i++; continue }
    // 无长度字段的段：TEM(01) / RSTn(D0-D7) / SOI(D8) / EOI(D9)
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue }
    const len = buf.readUInt16BE(i + 2)
    if (len < 2) return null
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (i + 9 >= buf.length) return null
      const h = buf.readUInt16BE(i + 5)
      const w = buf.readUInt16BE(i + 7)
      return w > 0 && h > 0 ? { w, h } : null
    }
    if (marker === 0xda) return null // 进入扫描数据（SOF 应在它之前）
    i += 2 + len
  }
  return null
}

/** 读图片尺寸；认不出/读不到返回 null（GIF/WebP/BMP/SVG 一律 null） */
export function imageSizeOf(buf: Buffer): ImageSize | null {
  if (!buf || buf.length < 8) return null
  return pngSize(buf) ?? jpegSize(buf)
}

/** 像素总量是否超过渲染侧守卫（1 亿像素，与 src/lib/imageFormats.ts 同口径）。
 *  尺寸未知时不拦（宁可放行让渲染层自己判，也不要把一张好图误杀）。 */
export function exceedsPixelGuard(buf: Buffer, maxPixels = 100_000_000): boolean {
  const s = imageSizeOf(buf)
  return s ? s.w * s.h > maxPixels : false
}
