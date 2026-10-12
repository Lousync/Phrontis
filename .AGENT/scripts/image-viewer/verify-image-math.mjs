/**
 * 图片视图的几何 + 格式契约（批 3，2026-10-13，v3.5.0 线）。
 *
 * 与 `.AGENT/scripts/image-viewer/verify-image-viewer.mjs` 的分工：
 *   那份查**静态**（分支顺序 / 锚点 / 上限常量 / 格式集合是否落在主进程白名单里），
 *   这份查**性质** —— 而且**直接 import 真的 `.ts`**（`src/lib/imageView.ts` +
 *   `src/lib/imageFormats.ts`），不是抄一份公式来测。抄一份等于没测。
 *
 * 跑法：node --experimental-strip-types .AGENT/scripts/image-viewer/verify-image-math.mjs
 *   （`--experimental-strip-types` 是必需的：这两个 .ts 是真相源，脚本 import 的是它们本身。
 *     Node 会打一条 MODULE_TYPELESS_PACKAGE_JSON 警告，无害。）
 *
 * 这批性质先在原型 `tmp/image-viewer-proto/_math.mjs` 里跑过一轮，抓到一个真问题：
 * `zoomAbout` 的锚点入参口径（详见该函数注释）。此处是搬移 + 扩充格式头解析。
 */
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const {
  effNat, fitScale, clampPan, zoomAbout, withFitMode, rotateBy, reflow, initialImageView,
  VIEW_PAD, PAN_SLACK, MIN_SCALE, MAX_SCALE,
} = await import(`file:///${resolve(ROOT, 'src/lib/imageView.ts').replace(/\\/g, '/')}`)
const {
  isRenderableImageExt, imageMime, imageMayHaveAlpha, dimsFromHeader,
  MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, IMAGE_RENDER_EXTS,
} = await import(`file:///${resolve(ROOT, 'src/lib/imageFormats.ts').replace(/\\/g, '/')}`)

let pass = 0, fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`) }
  else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps
const view = (w, h) => ({ w, h })

console.log('=== A 适应窗口的算式 ===')
{
  // 4000x3000 放进 1000x800（四周留 32px 边距）。
  // 注意哪一侧是约束：图 4:3=1.333，视口 1000:800=1.25 ⇒ **宽**这一侧先顶满。
  const nat = view(4000, 3000)
  const s = fitScale('fit', nat, 0, view(1000, 800))
  ok(near(s, (1000 - VIEW_PAD) / 4000), '含边距的 contain：取「宽」这一侧（1000×800 装 4:3）', `得 ${s}`)
  ok(near(4000 * s, 1000 - VIEW_PAD), '适应后宽度正好用满可用宽')
  ok(3000 * s <= 800 && 4000 * s <= 1000, '适应后不溢出视口')
  ok(near(fitScale('width', nat, 0, view(1000, 800)), (1000 - VIEW_PAD) / 4000), '适应宽度：按可用宽算')
  ok(near(fitScale('actual', nat, 0, view(1000, 800)), 1), '1:1 恒为 1，与视口无关')
  ok(near(fitScale('fit', nat, 0, view(400, 300)), (300 - VIEW_PAD) / 3000), '大图在小视口里缩到可用高')
}
{
  // ★ 拍板 D8：适应窗口**不放大超过 100%**
  const s = fitScale('fit', view(64, 64), 0, view(1000, 800))
  ok(near(s, 1), '64×64 的小图适应窗口后停在 100%（不插值放大）')
  ok(64 * s < 1000, '小图适应后确实小于视口（居中一小块，不是被拉满）')
}
{
  // 上下限
  ok(fitScale('fit', view(10, 10), 0, view(10, 10)) >= MIN_SCALE, '极端小视口下适应比例不低于 MIN_SCALE')
  ok(fitScale('width', view(1, 1), 0, view(100000, 800)) <= MAX_SCALE, '极端大视口下不高于 MAX_SCALE')
}

console.log('\n=== B 旋转后按包围盒算（90/270 宽高互换） ===')
{
  const nat = view(4000, 3000)
  ok(effNat(nat, 0).w === 4000 && effNat(nat, 0).h === 3000, '0° 时不换')
  ok(effNat(nat, 90).w === 3000 && effNat(nat, 90).h === 4000, '90° 时宽高互换')
  ok(effNat(nat, 180).w === 4000 && effNat(nat, 180).h === 3000, '180° 时与 0° 同')
  ok(effNat(nat, 270).w === 3000 && effNat(nat, 270).h === 4000, '270° 时也互换')
  ok(fitScale('fit', nat, 90, view(1000, 800)) < fitScale('fit', nat, 0, view(1000, 800)),
    '旋转 90° 后适应比例变小（长边现在竖着）')
  ok(near(fitScale('fit', nat, 90, view(1000, 800)), (800 - VIEW_PAD) / 4000), '90° 的 contain 按互换后的高算')
}

console.log('\n=== C 锚点缩放：光标下的那个像素必须钉住不动 ===')
{
  /* 性质：屏幕 = t + R(rot)·(s·c)，c 为图内坐标（相对图心）。
     缩放后要求同一个 c 仍落在光标处。逐 4 个旋转角 × 3 个起始缩放验证。
     ★ 入参口径：`zoomAbout` 的 anchor 是**视口内坐标**，不是「相对视口中心」——
       后者会让锚点整体偏 (k-1)·(view/2)，偏移量恒定 ⇒ 现象是「缩放正常、只是没钉住」。 */
  const nat = view(4000, 3000), vw = 1000, vh = 800
  for (const rot of [0, 90, 180, 270]) {
    for (const s0 of [0.5, 1, 2.5]) {
      const st = { scale: s0, fit: null, rot, tx: 37, ty: -21 }
      const pc = { x: 180, y: -95 }                       // 光标相对视口中心
      const anchor = { x: pc.x + vw / 2, y: pc.y + vh / 2 } // 函数要的是视口内坐标
      // 反解光标下的图内坐标（独立写一遍以便交叉验证）
      const r0 = -rot * Math.PI / 180, c0 = Math.cos(r0), n0 = Math.sin(r0)
      const dx = pc.x - st.tx, dy = pc.y - st.ty
      const cx = (dx * c0 - dy * n0) / s0, cy = (dx * n0 + dy * c0) / s0
      const next = zoomAbout(st, nat, view(vw, vh), 1.25, anchor)
      // 正解新屏幕位置
      const r1 = rot * Math.PI / 180, c1 = Math.cos(r1), n1 = Math.sin(r1)
      const sx = next.tx + (next.scale * cx * c1 - next.scale * cy * n1)
      const sy = next.ty + (next.scale * cx * n1 + next.scale * cy * c1)
      ok(near(sx, pc.x, 1e-6) && near(sy, pc.y, 1e-6),
        `rot=${rot} s=${s0}：缩放后光标下的像素仍在光标处`,
        `偏 (${(sx - pc.x).toFixed(4)}, ${(sy - pc.y).toFixed(4)})`)
    }
  }
}
{
  const nat = view(4000, 3000)
  const st = { scale: 1, fit: 'fit', rot: 0, tx: 50, ty: 50 }
  const next = zoomAbout(st, nat, view(1000, 800), 1.25)
  ok(near(next.scale, 1.25) && next.tx === 50 && next.ty === 50, '按钮缩放（无锚点）不动平移')
  ok(next.fit === null, '手动缩放后脱离「适应」态（否则窗口一变就被拉回）')
  ok(st.scale === 1 && st.tx === 50, '纯函数：不修改传入的 state（React 下必须如此）')
}
{
  // 封顶 / 兜底
  const nat = view(4000, 3000)
  let st = initialImageView()
  for (let i = 0; i < 40; i++) st = zoomAbout(st, nat, view(1000, 800), 1.25)
  ok(near(st.scale, MAX_SCALE), '连按放大封顶在 MAX_SCALE', `${st.scale}`)
  for (let i = 0; i < 80; i++) st = zoomAbout(st, nat, view(1000, 800), 1 / 1.25)
  ok(near(st.scale, MIN_SCALE), '连按缩小兜底在 MIN_SCALE', `${st.scale}`)
}

console.log('\n=== D 平移夹取（不许把图拖丢） ===')
{
  const p = clampPan({ scale: 1, fit: null, rot: 0, tx: 999, ty: -999 }, view(100, 100), view(1000, 800))
  ok(p.tx === 0 && p.ty === 0, '图小于视口时平移归零（始终居中，拖不动也丢不了）')
}
{
  const p = clampPan({ scale: 1, fit: null, rot: 0, tx: 99999, ty: -99999 }, view(4000, 3000), view(1000, 800))
  ok(near(p.tx, (4000 - 1000) / 2 + PAN_SLACK) && near(p.ty, -((3000 - 800) / 2 + PAN_SLACK)),
    '大图平移夹在「边缘 + PAN_SLACK」处')
  ok(Math.abs(p.tx) < 99999, '确实被夹住了（不是原样放行）')
}
{
  const p = clampPan({ scale: 1, fit: null, rot: 90, tx: 99999, ty: 0 }, view(4000, 3000), view(1000, 800))
  ok(near(p.tx, (3000 - 1000) / 2 + PAN_SLACK), '旋转 90° 后按互换后的宽算水平余量')
}

console.log('\n=== E 旋转 / 适应模式 / 重算 ===')
{
  const nat = view(4000, 3000)
  let st = withFitMode(initialImageView(), nat, view(1000, 800), 'fit')
  ok(st.fit === 'fit' && near(st.scale, fitScale('fit', nat, 0, view(1000, 800))), 'withFitMode 落到 fit 比例')
  ok(st.tx === 0 && st.ty === 0, 'withFitMode 清平移')
  const r = rotateBy(st, nat, view(1000, 800), 90)
  ok(r.rot === 90 && r.fit === 'fit', '旋转保留适应模式')
  ok(r.tx === 0 && r.ty === 0, '旋转后平移归零（保留会让图飞出视口）')
  ok(near(r.scale, fitScale('fit', nat, 90, view(1000, 800))), '旋转后按新包围盒重算比例')
  const r4 = rotateBy(r, nat, view(1000, 800), 270)
  ok(r4.rot === 0, '旋转累计回 0（360 归一）')
  const free = rotateBy({ scale: 2, fit: null, rot: 0, tx: 10, ty: 10 }, nat, view(1000, 800), 90)
  ok(free.rot === 90 && near(free.scale, 2), '自由态旋转不改比例')
  // 窗口变化：适应态重算、自由态只夹平移
  const re1 = reflow({ scale: 0.1, fit: 'fit', rot: 0, tx: 0, ty: 0 }, nat, view(2000, 1600))
  ok(near(re1.scale, fitScale('fit', nat, 0, view(2000, 1600))), '适应态：窗口变大后比例跟着重算')
  const re2 = reflow({ scale: 2, fit: null, rot: 0, tx: 99999, ty: 0 }, nat, view(1000, 800))
  ok(near(re2.scale, 2) && Math.abs(re2.tx) < 99999, '自由态：窗口变化只夹平移、不动比例')
}

console.log('\n=== F 格式集合 / MIME / alpha ===')
{
  ok(IMAGE_RENDER_EXTS.includes('avif'), 'avif 在可渲染集合里（本批唯一动主进程的那一项）')
  ok(!IMAGE_RENDER_EXTS.includes('ico'), 'ico 不在（同批拍板：不收）')
  ok(!IMAGE_RENDER_EXTS.includes('heic') && !IMAGE_RENDER_EXTS.includes('heif'), 'heic / heif 不在（要 libheif）')
  ok(isRenderableImageExt('.PNG') && isRenderableImageExt('JPEG'), '扩展名判定：带点 / 大写都能认')
  ok(!isRenderableImageExt('txt') && !isRenderableImageExt(''), '非图片扩展名为 false')
  ok(imageMime('svg') === 'image/svg+xml' && imageMime('.JPG') === 'image/jpeg', 'MIME：svg 与大小写')
  ok(imageMime('avif') === 'image/avif' && imageMime('nope') === 'application/octet-stream', 'MIME：avif 与兜底')
  ok(imageMayHaveAlpha('png') && imageMayHaveAlpha('webp') && imageMayHaveAlpha('svg'), '可能含 alpha：png / webp / svg')
  ok(!imageMayHaveAlpha('jpg') && !imageMayHaveAlpha('jpeg') && !imageMayHaveAlpha('bmp'),
    '不含 alpha：jpg / jpeg / bmp（铺棋盘格是白铺）')
  ok(MAX_IMAGE_BYTES === 32 * 1024 * 1024, '字节上限 = 32MB')
  ok(MAX_IMAGE_PIXELS === 100_000_000, '像素上限 = 1 亿（防「压缩后几 MB、解码后 1.6GB」）')
}

console.log('\n=== G 文件头解析：六种容器 + SVG ===')
const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
const le16 = (v) => [v & 255, (v >>> 8) & 255]
const le24 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255]
const put = (arr, at, bytes) => { arr.set(bytes, at); return arr }

{
  const b = put(put(new Uint8Array(24), 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 12, [0x49, 0x48, 0x44, 0x52])
  put(b, 16, be32(1920)); put(b, 20, be32(1080))
  const d = dimsFromHeader(b)
  ok(d && d.w === 1920 && d.h === 1080, 'PNG：IHDR 的 1920×1080', JSON.stringify(d))
}
{
  // JPEG：APP0(len 16) 之后紧接 SOF0
  const b = new Uint8Array(32)
  put(b, 0, [0xff, 0xd8])
  put(b, 2, [0xff, 0xe0, 0x00, 0x10])
  put(b, 20, [0xff, 0xc0, 0x00, 0x11, 0x08])
  put(b, 25, [0x04, 0x38]); put(b, 27, [0x07, 0x80])   // h=1080, w=1920
  const d = dimsFromHeader(b)
  ok(d && d.w === 1920 && d.h === 1080, 'JPEG：跳过 APP0 找到 SOF0', JSON.stringify(d))
}
{
  // JPEG：SOF 排在 256 字节的 APP1（EXIF 常见形态）之后 —— 这条就是探测段要 128KB 的理由
  const b = new Uint8Array(280)
  put(b, 0, [0xff, 0xd8])
  put(b, 2, [0xff, 0xe1, 0x01, 0x00])                  // APP1，段长 256
  const at = 2 + 2 + 256                               // = 260
  put(b, at, [0xff, 0xc2, 0x00, 0x11, 0x08])
  put(b, at + 5, [0x02, 0xd0]); put(b, at + 7, [0x05, 0x00])  // h=720, w=1280
  const d = dimsFromHeader(b)
  ok(d && d.w === 1280 && d.h === 720, 'JPEG：SOF 排在大 APP1 之后仍能找到（128KB 探测段的理由）', JSON.stringify(d))
}
{
  const b = put(new Uint8Array(16), 0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  put(b, 6, le16(320)); put(b, 8, le16(240))
  const d = dimsFromHeader(b)
  ok(d && d.w === 320 && d.h === 240, 'GIF：LSD 的 320×240', JSON.stringify(d))
}
{
  const b = new Uint8Array(32)
  put(b, 0, [0x42, 0x4d])
  put(b, 18, [0x00, 0x05, 0x00, 0x00])                 // w=1280
  put(b, 22, [0x38, 0xff, 0xff, 0xff])                 // h=-200（自上而下位图）
  const d = dimsFromHeader(b)
  ok(d && d.w === 1280 && d.h === 200, 'BMP：负高取绝对值（自上而下的位图）', JSON.stringify(d))
}
{
  const b = new Uint8Array(32)
  put(b, 0, [0x52, 0x49, 0x46, 0x46]); put(b, 8, [0x57, 0x45, 0x42, 0x50])
  put(b, 12, [0x56, 0x50, 0x38, 0x58])                 // VP8X
  put(b, 24, le24(1600 - 1)); put(b, 27, le24(900 - 1))
  const d = dimsFromHeader(b)
  ok(d && d.w === 1600 && d.h === 900, 'WebP VP8X：画布宽高存的是「值-1」', JSON.stringify(d))
}
{
  const b = new Uint8Array(32)
  put(b, 0, [0x52, 0x49, 0x46, 0x46]); put(b, 8, [0x57, 0x45, 0x42, 0x50])
  put(b, 12, [0x56, 0x50, 0x38, 0x20])                 // 'VP8 '
  put(b, 23, [0x9d, 0x01, 0x2a])
  put(b, 26, le16(640)); put(b, 28, le16(480))
  const d = dimsFromHeader(b)
  ok(d && d.w === 640 && d.h === 480, 'WebP VP8（有损）：同步码后的 14 位宽高', JSON.stringify(d))
}
{
  const b = new Uint8Array(32)
  put(b, 0, [0x52, 0x49, 0x46, 0x46]); put(b, 8, [0x57, 0x45, 0x42, 0x50])
  put(b, 12, [0x56, 0x50, 0x38, 0x4c])                 // VP8L
  put(b, 20, [0x2f])
  const bits = (100 - 1) | ((50 - 1) << 14)            // w-1 低 14 位，h-1 次 14 位
  put(b, 21, [bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255])
  const d = dimsFromHeader(b)
  ok(d && d.w === 100 && d.h === 50, 'WebP VP8L（无损）：位流里的 14+14 位', JSON.stringify(d))
}
{
  const b = new Uint8Array(48)
  put(b, 4, [0x66, 0x74, 0x79, 0x70])                  // 'ftyp'
  put(b, 8, [0x61, 0x76, 0x69, 0x66])                  // 'avif'
  put(b, 24, be32(20)); put(b, 28, [0x69, 0x73, 0x70, 0x65])   // 'ispe'
  put(b, 36, be32(1080)); put(b, 40, be32(1920))
  const d = dimsFromHeader(b)
  ok(d && d.w === 1080 && d.h === 1920, 'AVIF：ispe box 的宽高（+8 / +12）', JSON.stringify(d))
}
{
  const mk = (s) => new TextEncoder().encode(s)
  const a = dimsFromHeader(mk('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect/></svg>'))
  ok(a && a.w === 800 && a.h === 600, 'SVG：显式 width/height')
  const b = dimsFromHeader(mk('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12"><rect/></svg>'))
  ok(b && b.w === 24 && b.h === 12, 'SVG：只有 viewBox 时取后两位')
  const c = dimsFromHeader(mk('<svg width="100%" height="100%" viewBox="0 0 300 150"><rect/></svg>'))
  ok(c && c.w === 300 && c.h === 150, 'SVG：百分比 width 不算数，回落到 viewBox')
  const d = dimsFromHeader(mk('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'))
  ok(d === null, 'SVG：既无宽高也无 viewBox ⇒ null（跳过像素守卫，不拦）')
}
{
  ok(dimsFromHeader(new Uint8Array(0)) === null, '空缓冲 ⇒ null')
  ok(dimsFromHeader(new Uint8Array(4)) === null, '过短缓冲 ⇒ null')
  ok(dimsFromHeader(new Uint8Array(64).fill(0x41)) === null, '纯文本非 SVG ⇒ null')
  // 长度非法的 JPEG 段：不能死循环、不能抛
  const bad = new Uint8Array(32)
  put(bad, 0, [0xff, 0xd8]); put(bad, 2, [0xff, 0xe0, 0x00, 0x00])
  ok(dimsFromHeader(bad) === null, 'JPEG 段长非法 ⇒ null（不死循环、不抛）')
  const pngZero = put(put(new Uint8Array(24), 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 12, [0x49, 0x48, 0x44, 0x52])
  ok(dimsFromHeader(pngZero) === null, 'PNG 宽高为 0 ⇒ null（不当成合法尺寸）')
}

console.log(`\n===== ${pass} PASS / ${fail} FAIL =====`)
process.exit(fail === 0 ? 0 : 1)
