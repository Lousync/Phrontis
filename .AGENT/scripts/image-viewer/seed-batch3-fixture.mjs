/**
 * 批 3 实机验收用的 fixture 播种（仓库正文区的图片，含三种异常态）
 *
 * 为什么需要它：批 3 要验的不只是「一张图能显示」，还有**两条上限**与**解码失败**这三种
 * 非正常落点 —— 而它们各自需要一个特定形态的文件：
 *   · 正常图    → 落查看器
 *   · 超像素图  → 落「过大」卡（走**像素**那条，不是字节那条）
 *   · 损坏图    → 落「解码失败」卡（文件头能读、数据解不开）
 *   · 透明图    → 验棋盘格底（jpg 那条则应是纯色底）
 *   · SVG       → 验「默认渲染 + ⋮ 切源码」双落点
 *   · 引用笔记  → 验 md 内联放开（`![](图片/x.png)` 这种**非** .attachments/ 路径）
 *
 * ★ 超像素图刻意造成「IHDR 声称 20000×20000、文件只有几百字节」：
 *   这正是像素守卫存在的理由（压缩后极小、解码后 1.6 GB），而且 fixture 不必占 32MB 磁盘。
 *   它落在「像素超限」而不是「字节超限」，探针据此能分辨两条守卫各自有没有生效。
 *
 * 用法：
 *   node .AGENT/scripts/image-viewer/seed-batch3-fixture.mjs
 *
 * 产物落在 `tmp/vault-fixture/批3图片/`（`tmp/` 已被 .gitignore 忽略，不进版本控制）。
 * 本脚本**只写 fixture 目录**，不碰任何真实仓库。
 */
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const FIXTURE = join(ROOT, 'tmp', 'vault-fixture')
const DIR = join(FIXTURE, '批3图片')
const NOTE_DIR = join(FIXTURE, '批3引用')

const log = (s) => console.log('[batch3-fixture] ' + s)

if (!existsSync(FIXTURE)) {
  log(`fixture 仓库不存在：${FIXTURE}`)
  log('先跑：node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --add-books --ud "knowbase (dev probe-app)"')
  process.exit(1)
}

/* ================================================================
   最小 PNG 编码器（不引任何图像库）
   —— 只为造 fixture，故只做 8 位 RGB / RGBA 两种颜色类型、无隔行、filter 恒 0
   ================================================================ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}

function ihdr(w, h, colorType) {
  const b = Buffer.alloc(13)
  b.writeUInt32BE(w, 0)
  b.writeUInt32BE(h, 4)
  b[8] = 8            // bit depth
  b[9] = colorType    // 2 = RGB, 6 = RGBA
  b[10] = 0           // compression
  b[11] = 0           // filter
  b[12] = 0           // interlace
  return b
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** colorType 2（RGB）或 6（RGBA）；pixel(x,y,w,h) 返回 [r,g,b] 或 [r,g,b,a] */
function makePng(w, h, colorType, pixel) {
  const ch = colorType === 6 ? 4 : 3
  const raw = Buffer.alloc(h * (1 + w * ch))
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * ch)
    raw[off] = 0   // 每行一个 filter 字节
    for (let x = 0; x < w; x++) {
      const px = pixel(x, y, w, h)
      for (let c = 0; c < ch; c++) raw[off + 1 + x * ch + c] = px[c] ?? 255
    }
  }
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr(w, h, colorType)),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(DIR, { recursive: true })
mkdirSync(NOTE_DIR, { recursive: true })

/* ---------- ① 正常图：800×600 渐变 + 100px 网格（便于肉眼验 1:1 与缩放） ---------- */

const W1 = 800, H1 = 600
writeFileSync(join(DIR, '照片.png'), makePng(W1, H1, 2, (x, y) => {
  const grid = (x % 100 === 0 || y % 100 === 0) ? 40 : 0
  return [
    Math.round(30 + 200 * (x / W1)) - grid,
    Math.round(80 + 120 * (y / H1)) - grid,
    Math.round(200 - 120 * (x / W1)) - grid,
  ]
}))
log(`照片.png 已造（${W1}×${H1} RGB，含 100px 网格）—— 顶栏中段应显示「800 × 600」`)

/* ---------- ② 透明图：RGBA，右下角留透明缺口 → 验棋盘格底 ---------- */

const W2 = 600, H2 = 400
writeFileSync(join(DIR, '透明图.png'), makePng(W2, H2, 6, (x, y) => {
  const inHole = x > W2 * 0.55 && y > H2 * 0.55
  if (inHole) return [0, 0, 0, 0]                       // 全透明
  const a = Math.round(255 * (0.35 + 0.65 * (x / W2)))  // 左侧半透明 → 右侧不透明
  return [90, 160, 240, a]
}))
log(`透明图.png 已造（${W2}×${H2} RGBA，右下角全透明 + 左侧半透明）—— 应露出棋盘格底`)

/* ---------- ③ 超像素图：IHDR 声称 20000×20000，文件只有几百字节 ---------- */
/* 像素守卫必须在**解码前**拦下它。若这条守卫失效，Chromium 会尝试解码 4 亿像素 ⇒ 明显卡死。 */

writeFileSync(join(DIR, '超像素.png'), Buffer.concat([
  PNG_SIG,
  chunk('IHDR', ihdr(20000, 20000, 2)),
  chunk('IDAT', deflateSync(Buffer.alloc(16), { level: 6 })),
  chunk('IEND', Buffer.alloc(0)),
]))
log('超像素.png 已造（IHDR 20000×20000 = 4 亿像素，实际仅几百字节）—— 应落「过大」卡，且原因为**像素**那条')

/* ---------- ④ 损坏图：文件头合法（800×600），IDAT 是随机字节 ---------- */

const garbage = Buffer.alloc(512)
for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 37 + 11) & 0xff
writeFileSync(join(DIR, '损坏.png'), Buffer.concat([
  PNG_SIG,
  chunk('IHDR', ihdr(800, 600, 2)),
  chunk('IDAT', garbage),   // 不是合法 zlib 流 ⇒ 解码失败
  chunk('IEND', Buffer.alloc(0)),
]))
log('损坏.png 已造（头可读 800×600、IDAT 非法）—— 应落「解码失败」卡，带「重新读取」')

/* ---------- ⑤ SVG：默认渲染 + ⋮ 切源码 ---------- */

writeFileSync(join(DIR, '示意.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <rect width="640" height="360" fill="#0f172a"/>
  <circle cx="320" cy="150" r="90" fill="none" stroke="#38bdf8" stroke-width="4"/>
  <circle cx="320" cy="150" r="45" fill="#38bdf8" opacity=".25"/>
  <text x="320" y="300" fill="#e2e8f0" font-family="system-ui" font-size="28" text-anchor="middle">SVG 640 x 360</text>
</svg>
`, 'utf8')
log('示意.svg 已造（640×360）—— 默认渲染，⋮ 里应有「看源码」')

/* ---------- ⑥ 引用笔记：验 md 内联放开（非附件区路径） ---------- */

writeFileSync(join(NOTE_DIR, '图片引用.md'), `---
id: kb-batch3-image-ref
title: 批3 图片引用
created: 2026-10-13T00:00:00.000Z
updated: 2026-10-13T00:00:00.000Z
---

# 批 3 图片引用 fixture

下面这张图用的是**仓库内任意路径**（不是 \`.attachments/\`）。批 3 之前这里必然是破图 ——
\`normalizeVaultRel\` 只认三个附件前缀，主进程 \`ws:readImage\` 也只放行附件区。

![正常引用](../批3图片/照片.png)

再试一个**不存在**的路径，应显示破图占位而不是把整页搞坏：

![不存在](../批3图片/没有这张图.png)

以及一个**扩展名不在放行集合里**的引用（应同样落破图占位，且不该白跑一次 IPC）：

![非图片](../批3图片/说明.txt)
`, 'utf8')
log('批3引用/图片引用.md 已造 —— 三张图：正常 / 路径不存在 / 扩展名不收')

/* ---------- 汇总 ---------- */

log('')
log('fixture 就绪：' + DIR)
for (const n of ['照片.png', '透明图.png', '超像素.png', '损坏.png', '示意.svg']) {
  const p = join(DIR, n)
  if (existsSync(p)) log(`  · ${n}  (${statSync(p).size} B)`)
}
log('  · 批3引用/图片引用.md')
log('')
log('探针：node .AGENT/scripts/image-viewer/probe-image-viewer.mjs')
