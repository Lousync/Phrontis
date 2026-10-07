/**
 * 探针 CBZ 生成器（B 段 · 阶段 2b：固定版式 / 图片漫画）。
 *
 * 为什么要自造样书：本机没有真画集（阶段 2 出口判据已与用户确认为「自造样书跑通即可」），
 * 而 cbz 的**风险面**恰好都不需要真书才能覆盖：
 *   · **页序**（KB PATCH ⑤-a）：上游裸 `.sort()` 是字典序 ⇒ `page_10` 排在 `page_2` **之前**。
 *     本文件的页名**故意不补零**（`page_1 … page_30`），错页时探针第 2 步当场红。
 *     补零命名的 zip 永远看不出差别 —— 用它当 fixture 等于这条 patch 没有测试。
 *   · **扩展名大小写**（KB PATCH ⑤-b）：上游 `endsWith` 大小写敏感 ⇒ 整包被过滤、报
 *     `No supported image files in archive`。故刻意混入 `.PNG` / `.JPG` 大写条目。
 *   · **页图字节**（KB PATCH ⑤-c）：左栏缩略图网格要的是页图本身，不是「包好 <img> 的文档」。
 *   · **固定版式**：一节一文档、文档体只有一个 `<img>`（`comic-book.js:6-8`），无文本层 ⇒
 *     没有划选 / 摘录 / 高亮（探针要断言「打开 cbz 不会冒出摘录浮层」）。
 *
 * 零依赖：PNG 用 `node:zlib` 的 `deflateSync` + `crc32` 手写（约 20 行），zip 复用
 * `make-epub.mjs` 的 `zipStore`（STORED-only）。**不引入任何新依赖**。
 *
 * 字节可复现：zip 时间戳固定（`zipStore` 的 ZIP_EPOCH），同一份源码产物逐字节相同 ——
 * 探针失败时可比对两轮产物，判断「是 fixture 变了还是代码变了」。
 */
import { crc32, deflateSync } from 'node:zlib'
import { zipStore } from './make-epub.mjs'

// ===== 零依赖 PNG 写入（truecolor、8bit、无隔行）=====

/** 一个 PNG chunk：长度 + 类型 + 数据 + CRC（CRC 覆盖「类型 + 数据」，不含长度） */
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc, 0)
  return Buffer.concat([head, data, tail])
}

/**
 * 纯色 PNG（宽 × 高，RGB）。
 * 每行前置一个 filter 字节 0（None）—— 纯色图用 None 就够（deflate 对长重复串极友好，
 * 一张 800×1120 的纯色图压完 ~2KB）。
 */
export function pngSolid(w, h, [r, g, b]) {
  const stride = 1 + w * 3
  const raw = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const base = y * stride
    raw[base] = 0
    for (let x = 0; x < w; x++) {
      const p = base + 1 + x * 3
      raw[p] = r
      raw[p + 1] = g
      raw[p + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 2   // color type = truecolor（无 alpha，省 1/4 体积）
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),   // PNG 签名
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ===== 页表（探针与 fixture 共用的唯一真相源）=====

/** 总页数。60 是**刻意**的（11 → 30 → 60 两次上调，原因同一条）：
 *  ① 页序断言要有意义 —— `page_10` / `page_20` 必须出现在 `page_2` **之后**（不补零命名）；
 *  ② 缩略图「按需生成」要可证明 —— 面板的预取跨度是「可见 ± 12」，一屏能装下多少格由
 *     **左栏宽度**决定（`auto-fill` 列数：240px 默认宽 = 2 列，420px 上限宽 = 4 列），
 *     而网格高度由窗口决定（≈5-6 行）。极端情况下可见 24 格 ⇒ 预取到 index 35。
 *     ⇒ 页数必须**明显多于**「最坏情况的可见范围 + 12」，否则整本被一次预取覆盖，
 *       「没预生成」这条断言就永远是绿的假象（30 页时在 4 列布局下已接近临界）。 */
export const CBZ_PAGES = 60

/**
 * 第 i 页（0-based）的主色。
 * ★ 三个乘数都是**奇数** ⇒ 各自在 mod 256 下可逆 ⇒ 「页号 → 颜色」是单射，
 *   探针可以反推「这一格的图到底是不是第 i 页的」——这是缩略图**映射正确**唯一的可断言形式
 *   （图片里没有可 OCR 的页号）。同理三个通道都取模可以让纯色页两两不同。
 */
export function pageColor(i) {
  const n = i + 1
  return [(43 * n) % 256, (97 * n) % 256, (191 * n) % 256]
}

/** 第 i 页的图宽（逐页递增，页高按 1.4 倍；尺寸不同也是为了确认真按各自比例渲染） */
export function pageSize(i) {
  const w = 600 + 40 * (i % 11)
  return [w, Math.round(w * 1.4)]
}

/**
 * 页条目名（**自然序**，探针按这个数组逐字比对 DOM 顺序）。
 * 故意让**一部分条目用大写扩展名 `.PNG`** —— 上游 `endsWith` 大小写敏感时它们会被整包过滤掉，
 * 表象是 `No supported image files in archive`。补零与否是另一条关键：**不补零**才对字典序敏感。
 * （只玩大小写、不混真假类型：`.JPG` 里塞 PNG 字节要靠浏览器内容嗅探，会把「后缀过滤」这条
 *  断言和「解码器是否嗅探」混在一起，两个变量一个断言 —— 分开验更省事。）
 */
export function pageNames() {
  const names = []
  for (let i = 0; i < CBZ_PAGES; i++) {
    const n = i + 1
    const ext = (n % 7 === 0 || n % 11 === 0) ? '.PNG' : '.png'
    names.push(`page_${n}${ext}`)
  }
  return names
}

function pageBytes(i) {
  const [w, h] = pageSize(i)
  return pngSolid(w, h, pageColor(i))
}

/**
 * 正常样书：`CBZ_PAGES` 页纯色图 + 一个非图片条目（`.txt` 诱饵，验证「按扩展名过滤」这一步真的发生）。
 */
export function probeCbz() {
  const names = pageNames()
  const entries = names.map((name, i) => [name, pageBytes(i)])
  // 诱饵放**中间**：若它被当页收进来，页数会变成 31，探针第 1 步当场红
  entries.splice(3, 0, ['notes.txt', '探针 cbz 的非图片条目：用于验证归档里的扩展名过滤真的在跑\n'])
  return zipStore(entries)
}

/**
 * 恶意载荷本体（内联 `<script>` + `onerror` 的 SVG）。
 * ★ 由探针**直接 import** 做正向对照 —— 「同一份载荷在正确 MIME 下确实可解码」是
 *   「没执行不是因为载荷是废文本」的前提，两边必须逐字相同（所以导出，不各写一份）。
 *
 * ★ 预期结果：页内的脚本**一句都不执行**。三条理由各自独立成立，探针逐条断言：
 *   ① cbz 的「页」在 DOM 里只是一个 `<img>`（`comic-book.js:8`）—— SVG 作为**图片**加载时
 *      Chromium 根本不做脚本执行，`<script>` 连解析都不进；
 *   ② 就算退一步，内容帧 sandbox 不含 `allow-scripts`（KB PATCH ③）；
 *   ③ 再退一步，应用 CSP 的 `script-src 'self'` 不含 `'unsafe-inline'`（`blob:` 文档继承父 CSP）。
 * 载荷刻意做成 **inert**（只置标志位、不联网、不读文件），是「验证防线还在不在」的靶子，
 * 不是攻击工具。
 */
export const EVIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1120" viewBox="0 0 800 1120">
<rect width="800" height="1120" fill="#c0392b"/>
<text x="40" y="90" font-size="44" fill="#ffffff">恶意样书 第 2 页</text>
<script type="text/javascript">
window.__kbProbePwnedSvg = true;
try { window.parent.__kbProbePwnedParentSvg = true; window.parent.document.title = 'PWNED-CBZ' } catch (e) {}
</script>
<image href="missing.png" width="200" height="200" onerror="window.__kbProbePwnedOnerror = true; try { window.parent.__kbProbePwnedParentOnerror = true } catch (e) {}"/>
</svg>
`

/** 恶意样书：第 2 页就是 `EVIL_SVG`（其余页正常，验证「只有这一页异常」不会毁掉整本书） */
export function maliciousCbz() {
  const evilSvg = EVIL_SVG
  return zipStore([
    ['page_1.png', pageBytes(0)],
    ['page_2.svg', evilSvg],
    ['page_3.png', pageBytes(2)],
    ['notes.txt', '恶意样书的诱饵条目（非图片）\n'],
  ])
}
