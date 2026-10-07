/**
 * 大体积 CBZ 生成器（B-16「cbz 体积 / 卡顿」的测量与回归 fixture，进 git）。
 *
 * 为什么不用 `make-cbz.mjs`：那本探针样书是 60 页**纯色**图（258KB），deflate 之后每页 ~2KB ——
 * 它测的是「页数」不是「体积」，而 B-16 的怀疑对象恰恰是体积（整本读入 / base64 IPC / 128MB 上限）。
 * 故这里做成**噪声页**（不可压缩 ⇒ STORED 进 zip 后文件 ≈ 页字节总和），体积由 `targetMb` 一个旋钮控制。
 * 页字节刻意贴近真漫画扫描件的量级（500×533×3 ≈ 800KB/页）：太小则测量噪声盖过信号。
 *
 * 字节**完全可复现**（与 `make-cbz.mjs` 同一口径：zip 时间戳固定 + 页内容由固定种子的 PRNG 生成）——
 * 探针失败时可比对两轮产物判断「是 fixture 变了还是代码变了」。**故不用 `crypto.randomBytes`**：
 * 那会让每次产出的 sha256 都不同，等值断言与体积断言全失去意义。
 *
 * 体积分档的三条线（`electron/lib/kbStore/bookSizeGate.ts`）在 fixture 侧的落点：
 *   · ≤128MB 静默 —— 96MB 正好卡在静默档**之内**，「现行策略允许的最坏情况」用它测
 *   · 128–384MB 确认 —— 130MB 刚过线，用它测确认框 / 取消 / 「仍要打开」
 *
 * 用法（CLI）：`node .AGENT/scripts/workbench-shell/probes/make-big-cbz.mjs [目标MB] [输出路径]`
 * 用法（import）：`makeBigCbz({ targetMb })` → `{ buf, pages, bytes }`，供 `seed-probe-vault.mjs` 直接落盘。
 */
import { writeFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'
import { zipStore } from './make-epub.mjs'

/** 单页像素尺寸（真漫画扫描件量级）。改这两个数会改 `PAGE_BYTES`，进而改「目标 MB → 页数」的换算 */
export const PAGE_W = 500
export const PAGE_H = 533
/** 每页字节数：每行 1 字节 filter(None) + W×3 字节 RGB */
export const PAGE_BYTES = (PAGE_W * 3 + 1) * PAGE_H
/** 行字节数。1500 能被 4 整除 ⇒ 每行取整 4 字节 PRNG 输出刚好铺满，无需处理残尾 */
const ROW_BYTES = PAGE_W * 3
/** 页内容种子。换它就等于换一批 fixture —— **别随手改**：改了 sha256 断言全失效 */
const PAGE_SEED = 0x9e3779b9

/** 两本 fixture 的体积（MB）与文件名 —— 与 `probe-cbz-bigbook.mjs`、`seed-probe-vault.mjs` 共用同一份真相 */
export const BIG_BOOK_FIXTURES = [
  { name: '大样书.cbz', targetMb: 96 },   // 静默档上限之内（>128MB 才弹确认框）
  { name: '超大样书.cbz', targetMb: 130 }, // 确认档（128 < size ≤ 384）
]

/** mulberry32：32 位定种 PRNG，跨平台逐位相同（不用 `Math.random` / `crypto` 就是为了这个） */
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return (t ^ (t >>> 14)) >>> 0
  }
}

/**
 * 噪声 PNG（不可压缩）。每行 filter=0，行内容 = PRNG 字节 ⊕ 页码 ——
 * 异或页码是**双保险**：种子本来就逐页不同，但万一将来有人把种子改成常量，页面也不会逐页雷同
 * （逐页雷同会让 zip 靠引用合并、体积旋钮失效）。
 * ★ `level: 0`（store 块）：噪声压不动，写 0 级最快且产物最短 —— 换来的是「文件体积 ≈ 页字节总和」这个可推算关系。
 */
function noisePng(i) {
  const stride = ROW_BYTES + 1
  const raw = Buffer.alloc(stride * PAGE_H)
  const rnd = mulberry32((PAGE_SEED ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0)
  const mix = ((i + 1) * 31) & 0xff
  for (let y = 0; y < PAGE_H; y++) {
    const base = y * stride
    raw[base] = 0 // filter = None
    for (let x = 0; x < ROW_BYTES; x += 4) {
      const v = rnd()
      const at = base + 1 + x
      raw[at] = ((v >>> 24) & 0xff) ^ mix
      raw[at + 1] = ((v >>> 16) & 0xff) ^ mix
      raw[at + 2] = ((v >>> 8) & 0xff) ^ mix
      raw[at + 3] = (v & 0xff) ^ mix
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(PAGE_W, 0)
  ihdr.writeUInt32BE(PAGE_H, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type = truecolor（无 alpha）
  function chunk(type, data) {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const crc = crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc, 0)
    return Buffer.concat([head, data, tail])
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 目标 MB → 页数（向上取整：宁可略超目标，也不让「刚过 128MB」这类边界样本掉回上一档） */
export function bigCbzPageCount(targetMb) {
  return Math.max(1, Math.ceil((targetMb * 1024 * 1024) / PAGE_BYTES))
}

/**
 * 生成大书。返回 `{ buf, pages, bytes }`。
 * ★ 内存：整本页字节 + zip 成品同时在内存里（≈ 2× 体积）。130MB 一档约 260MB 峰值 —— 这是生成期开销，
 *   与阅读器装载期的峰值是两件事（后者见 `bookSizeGate.PEAK_MEM_RATIO`）。
 */
export function makeBigCbz({ targetMb }) {
  const pages = bigCbzPageCount(targetMb)
  const entries = []
  for (let i = 1; i <= pages; i++) entries.push([`page_${String(i).padStart(4, '0')}.png`, noisePng(i - 1)])
  const buf = zipStore(entries)
  return { buf, pages, bytes: buf.length }
}

// ===== CLI =====
if (process.argv[1] && process.argv[1].endsWith('make-big-cbz.mjs')) {
  const targetMb = Number(process.argv[2] ?? BIG_BOOK_FIXTURES[0].targetMb)
  const out = process.argv[3] ?? `tmp/vault-fixture/.books/${BIG_BOOK_FIXTURES[0].name}`
  const t0 = Date.now()
  const { buf, pages } = makeBigCbz({ targetMb })
  writeFileSync(out, buf)
  console.log(`wrote ${out}: ${pages} 页, ${(buf.length / 1048576).toFixed(1)} MB, ${Date.now() - t0}ms`)
}
