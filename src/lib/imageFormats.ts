/**
 * 图片格式知识 —— 单一真相源（批 3，2026-10-13，v3.5.0 线）。
 *
 * 为什么单独一个文件：这批要动「哪些扩展名算图片」的地方有六处
 * （PageEditor 的落点分支 / ⋮ 菜单门槛 / fileTypes 的展示条目 / fileIcons 的图标 /
 *   attachmentImage 的 md 内联判定 / 契约脚本）。本仓已因「清单各持一份」吃过多次 drift
 *   （见 `aiTextExts.ts` 头注），所以一律从这里取。
 *
 * ★★ 硬约束：`IMAGE_RENDER_EXTS` 必须是主进程 `RANGE_EXT_WHITELIST`
 *    （`electron/lib/workspaceManager.ts:235`）的**子集**。
 *    取回走 `ws:readRangeBytes`，不在那份名单里的扩展名会被主进程直接拒成
 *    `文件类型不支持范围读取` —— 表象是「文件树里有这张图、点开却是一张元信息卡」，
 *    而且**没有任何报错**。契约 `verify-image-viewer.mjs` 的 C 组逐项比对两处，
 *    就是为了拦住「加了一个格式但读不出来」。
 *
 * 本文件是纯函数 + 常量，**不 import react / electron / fs** —— 契约脚本要直接 import 真的 .ts
 * 跑（`node --experimental-strip-types`），所以任何运行时依赖都会让它跑不起来。
 */

/**
 * 可渲染的图片扩展名（不带点、小写）。
 *
 * `avif` 是本批**唯一**动主进程的那一项（2026-10-13 拍板：avif 收、ico 不收）——
 * `RANGE_EXT_WHITELIST` 加了一行，属该文件注释里定义的「安全面变更」，提交信息须写明理由。
 * `ico` 刻意不收：仓库里罕见，不值得为它再动一次安全面。
 *
 * `heic` / `heif` 不收（同批拍板）：Chromium 解不了，要 `heic-to`（libheif WASM ≈1MB）解码，
 * 且同样要扩白名单 —— 双份代价，留待有人真的要收 iPhone 照片时再谈。
 */
export const IMAGE_RENDER_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif'] as const

export const IMAGE_RENDER_EXT_SET: ReadonlySet<string> = new Set(IMAGE_RENDER_EXTS)

/** 该扩展名（可带前导点、任意大小写）能否在应用内渲染 */
export function isRenderableImageExt(ext: string): boolean {
  return IMAGE_RENDER_EXT_SET.has(ext.replace(/^\./, '').toLowerCase())
}

/** 该**路径/文件名**能否在应用内渲染（v3.6.0 阶段二抽：文件树与工件栏两处都要按路径判图片，
 *  各自 `lastIndexOf('.')` 切一遍就是第二份真相；扩展名名单仍只有上面那一处） */
export function isRenderableImagePath(pathOrName: string): boolean {
  const i = pathOrName.lastIndexOf('.')
  return i > 0 && isRenderableImageExt(pathOrName.slice(i + 1))
}

/** 扩展名 → MIME。只服务 Blob 的 type（`<img>` 不看它也不会因此失败，但 DevTools 里好看） */
export function imageMime(ext: string): string {
  switch (ext.replace(/^\./, '').toLowerCase()) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'gif': return 'image/gif'
    case 'bmp': return 'image/bmp'
    case 'svg': return 'image/svg+xml'
    case 'avif': return 'image/avif'
    default: return 'application/octet-stream'
  }
}

/**
 * 该格式**可能**含 alpha ⇒ 画布铺棋盘格底（批 3 拍板 D9「按格式自动」）。
 *
 * 为什么按格式而不是「探测这一张图有没有透明像素」：探测要解码整张图再逐像素扫，
 * 为的只是决定一层底色。而 jpg / bmp 从**格式定义**上就不带 alpha 通道，
 * 给它们铺棋盘格是白铺（用户看到的是「一堆格子」，不是任何信息）。
 * 注意是「可能」：一张不透明的 PNG 也会铺 —— 那层格子只在图像范围外露出来，不干扰。
 *
 * `bmp` 记 false：32 位带 alpha 的 BMP 存在但罕见，而常见的是 24 位。
 */
export function imageMayHaveAlpha(ext: string): boolean {
  switch (ext.replace(/^\./, '').toLowerCase()) {
    case 'png':
    case 'gif':
    case 'webp':
    case 'svg':
    case 'avif': return true
    default: return false
  }
}

/**
 * 读字节上限（32 MB）。挡的是「读进内存 + 过一次 IPC」这一段。
 * 与主进程 `MAX_EDIT_SIZE` / `MAX_OPEN_SIZE`（`workspaceManager.ts:31-32`）同一口径：
 * 技术守卫，**不走 `SETTINGS`**（`AGENTS.md`「设置项的唯一真源」针对的是用户可调项）。
 */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024

/**
 * 像素上限（1 亿）。★ 这一条**不是字节上限的补充说明，是另一条独立的命门**：
 * 一张 20000×20000 的 PNG 压缩后可能只有几 MB（大片同色），
 * 解码成 RGBA 却是 20000×20000×4 = **1.6 GB**。只卡字节数会被它整个绕过。
 * 1 亿像素 ≈ 400 MB RGBA，留了余量给 Chromium 自己的降采样与多页缓存。
 */
export const MAX_IMAGE_PIXELS = 100_000_000

export interface ImageDims { w: number; h: number }

/**
 * 从**文件头**解析像素尺寸（不解码）。拿不到就返回 null。
 *
 * 用途有二：① 解码前的像素守卫（见 `MAX_IMAGE_PIXELS`）；
 * ② 「解码失败」那张卡上仍能报出尺寸（"文件头能读出 800×600，但图像数据无法解码"）——
 *    有尺寸才分得清「文件坏了」和「格式不认识」。
 *
 * ★ 它**不是**权威尺寸：`<img>` 的 `naturalWidth/naturalHeight` 才是。
 *   所以解析不出来时一律返回 null 让调用方跳过守卫、继续走 `<img>` 那条路 ——
 *   宁可放一张冷门变体的大图进去让 Chromium 自己降采样，也不要因为解析器认不出
 *   就把用户能看的图判成不能看。
 *
 * 认六种：PNG / JPEG / GIF / BMP / WebP / AVIF，外加 SVG（属性解析）。
 */
export function dimsFromHeader(bytes: Uint8Array): ImageDims | null {
  try {
    if (!bytes || bytes.length < 16) return null
    // ---- PNG：89 50 4E 47 0D 0A 1A 0A，IHDR 的宽高在 16 / 20（大端）----
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      if (bytes.length < 24) return null
      return pos(u32be(bytes, 16), u32be(bytes, 20))
    }
    // ---- JPEG：FF D8 开头，扫段找 SOFn ----
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegDims(bytes)
    // ---- GIF：GIF87a / GIF89a，宽高在 6 / 8（小端）----
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
      return pos(u16le(bytes, 6), u16le(bytes, 8))
    }
    // ---- BMP：BM，DIB 头的宽高在 18 / 22（小端有符号，高可为负＝自上而下）----
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
      return pos(i32le(bytes, 18), Math.abs(i32le(bytes, 22)))
    }
    // ---- WebP：RIFF....WEBP，再看 12 处的 chunk fourcc ----
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
      return webpDims(bytes)
    }
    // ---- AVIF：ISO BMFF（ftyp 品牌 avif/avis），尺寸在 meta 里的 ispe box ----
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      return avifDims(bytes)
    }
    // ---- SVG：文本属性。没有 width/height 就看 viewBox 的 w/h ----
    const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 4096)))
    if (/<svg[\s>]/i.test(head)) return svgDims(head)
    return null
  } catch {
    return null
  }
}

function pos(w: number, h: number): ImageDims | null {
  return w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h) ? { w, h } : null
}
function u32be(b: Uint8Array, i: number): number {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
}
function u16le(b: Uint8Array, i: number): number { return b[i] | (b[i + 1] << 8) }
function i32le(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) | 0
}

/**
 * JPEG 段扫描。为什么不能只看固定偏移：SOF 之前可能有任意多个 APPn，
 * 其中 APP1（EXIF）常常几十 KB（内含缩略图）—— 所以探测段给到 128 KB（见 useVaultImage）。
 * 扫不到就返回 null（不抛），由调用方跳过像素守卫。
 */
function jpegDims(b: Uint8Array): ImageDims | null {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue }          // 失步就重新对齐到下一个 FF
    const m = b[i + 1]
    if (m === 0xff) { i++; continue }             // 填充字节
    // 无长度字段的标记：TEM(01) 与 RSTn(D0-D7)、SOI(D8)、EOI(D9)
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue }
    const segLen = (b[i + 2] << 8) | b[i + 3]
    if (segLen < 2) return null                   // 长度非法 ⇒ 文件有问题，别再往下走
    // SOF0..SOF15 里，C4(DHT) / C8(JPG) / CC(DAC) 不是 SOF
    const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc
    if (isSof) {
      if (i + 9 >= b.length) return null
      // 段内布局：len(2) precision(1) height(2) width(2)
      return pos((b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6])
    }
    i += 2 + segLen
  }
  return null
}

/** WebP 三种子格式的尺寸位置各不相同（VP8X 扩展 / VP8 有损 / VP8L 无损） */
function webpDims(b: Uint8Array): ImageDims | null {
  const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15])
  if (fourcc === 'VP8X') {
    if (b.length < 30) return null
    // 画布宽高各 3 字节小端，存的是「实际值 - 1」
    const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1
    const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1
    return pos(w, h)
  }
  if (fourcc === 'VP8 ') {
    if (b.length < 30) return null
    // 关键帧头：3 字节 frame tag + 3 字节同步码 9D 01 2A，然后宽高各 2 字节（低 14 位有效）
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    return pos((b[26] | (b[27] << 8)) & 0x3fff, (b[28] | (b[29] << 8)) & 0x3fff)
  }
  if (fourcc === 'VP8L') {
    if (b.length < 25) return null
    // 无损：签名 0x2F，然后 14 位宽-1 + 14 位高-1，小端位流
    if (b[20] !== 0x2f) return null
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
    return pos((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
  }
  return null
}

/**
 * AVIF：在探测缓冲里找 `ispe` box。box 布局是 size(4) type(4) version+flags(4) width(4) height(4)，
 * 所以从 `ispe` 的 ASCII 位置起，宽在 +8、高在 +12。
 * 不走完整的 BMFF box 树遍历 —— 只为一个像素守卫不值得，而认不出就返回 null（不拦）。
 */
function avifDims(b: Uint8Array): ImageDims | null {
  for (let i = 0; i + 16 <= b.length; i++) {
    if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) {
      return pos(u32be(b, i + 8), u32be(b, i + 12))
    }
  }
  return null
}

/** SVG：优先显式 width/height（两个都是纯数字），否则 viewBox 的后两位 */
function svgDims(text: string): ImageDims | null {
  const num = (s: string | undefined): number | null => {
    if (!s) return null
    const t = s.trim()
    if (!/^[\d.]+$/.test(t)) return null          // 排除 "100%" / "10em" 这类
    const n = Number(t)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const wAttr = /<svg[^>]*\swidth\s*=\s*["']([^"']*)["']/i.exec(text)?.[1]
  const hAttr = /<svg[^>]*\sheight\s*=\s*["']([^"']*)["']/i.exec(text)?.[1]
  const w = num(wAttr), h = num(hAttr)
  if (w && h) return { w, h }
  const vb = /viewBox\s*=\s*["']\s*([-\d.eE+]+)[\s,]+([-\d.eE+]+)[\s,]+([-\d.eE+]+)[\s,]+([-\d.eE+]+)/i.exec(text)
  if (vb) return pos(Number(vb[3]), Number(vb[4]))
  return null
}
