/**
 * 探针 EPUB 生成器（B 段 · 电子书引擎）。
 *
 * 为什么不用现成库：仓库内没有能 **写** zip 的依赖（`fflate` 只在 `src/vendor/foliate/vendor/`
 * 里留了阅读器要用的 `unzlibSync` 一小片，npm 包没装；`jszip` / `adm-zip` 也没有）。
 * 而 EPUB 恰好只需要 STORED（不压缩）——规范本身要求 `mimetype` 是第一个条目且**不压缩**，
 * 全程 stored 最省心，于是用 `node:zlib` 的 `crc32`（Node 自带）手写 ~50 行即可，
 * 不引入新依赖、不给构建链加一个需要升级维护的包袱。
 *
 * 两本样书：
 *   `probeEpub()`      —— 正常书（3 章 + nav 目录 + 外部 CSS + 内联图片），驱动渲染 / 目录 /
 *                         分页 / 划选摘录 / 进度落盘等**正向**断言。
 *   `maliciousEpub()`  —— 恶意书，三种载荷（内联 `<script>`、`onerror` 属性、外部 `<script src>`），
 *                         驱动**负向**断言：载荷**存活在 DOM 里**（foliate 上游不净化，epub.js:856 留了 TODO）
 *                         但**一句都不执行** —— 宿主 window 不被污染、`document.title` 不被改。
 *                         ★ 载荷刻意做成 **inert**（只置标志位，不联网、不读文件、不碰宿主数据），
 *                         它是「验证两条防线还在不在」的靶子，不是攻击工具。
 *
 * 字节可复现：时间戳固定（`ZIP_EPOCH`），同一份源码生成的 epub 逐字节相同 —— 探针失败时可
 * 直接比对两轮产物，判断「是 fixture 变了还是代码变了」。
 */
import { crc32 } from 'node:zlib'

/** 固定 DOS 时间戳 —— 让产物可复现（用 UTC 取值，避免换时区产物就变） */
const ZIP_EPOCH = new Date(Date.UTC(2024, 0, 1))

const dosTime = (d) => ((d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1)) & 0xffff
const dosDate = (d) => (((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()) & 0xffff

const enc = new TextEncoder()
const bytesOf = (v) => (v instanceof Uint8Array ? v : enc.encode(String(v)))

/**
 * STORED-only ZIP 写入。
 * @param {Array<[string, string|Uint8Array]>} entries 顺序即 zip 内顺序（**mimetype 必须第一个**）
 * @returns {Uint8Array}
 */
export function zipStore(entries, when = ZIP_EPOCH) {
  const t = dosTime(when)
  const d = dosDate(when)
  const parts = []
  const dir = []
  let offset = 0
  for (const [name, raw] of entries) {
    const nameBytes = enc.encode(name)
    const data = bytesOf(raw)
    const crc = crc32(data) >>> 0
    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)   // 本地文件头签名
    lv.setUint16(4, 20, true)           // version needed = 2.0
    lv.setUint16(6, 0, true)            // flags（条目名全 ASCII，无需 UTF-8 位）
    lv.setUint16(8, 0, true)            // method = 0 stored
    lv.setUint16(10, t, true)
    lv.setUint16(12, d, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true) // compressed size
    lv.setUint32(22, data.length, true) // uncompressed size
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)           // extra len
    local.set(nameBytes, 30)
    parts.push(local, data)
    dir.push({ nameBytes, crc, size: data.length, offset })
    offset += local.length + data.length
  }
  const cdStart = offset
  for (const e of dir) {
    const h = new Uint8Array(46 + e.nameBytes.length)
    const v = new DataView(h.buffer)
    v.setUint32(0, 0x02014b50, true)    // 中央目录签名
    v.setUint16(4, 20, true)            // version made by
    v.setUint16(6, 20, true)            // version needed
    v.setUint16(8, 0, true)
    v.setUint16(10, 0, true)
    v.setUint16(12, t, true)
    v.setUint16(14, d, true)
    v.setUint32(16, e.crc, true)
    v.setUint32(20, e.size, true)
    v.setUint32(24, e.size, true)
    v.setUint16(28, e.nameBytes.length, true)
    v.setUint16(30, 0, true)            // extra
    v.setUint16(32, 0, true)            // comment
    v.setUint16(34, 0, true)            // disk number
    v.setUint16(36, 0, true)            // internal attrs
    v.setUint32(38, 0, true)            // external attrs
    v.setUint32(42, e.offset, true)
    h.set(e.nameBytes, 46)
    parts.push(h)
    offset += h.length
  }
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)     // EOCD 签名
  ev.setUint16(8, dir.length, true)
  ev.setUint16(10, dir.length, true)
  ev.setUint32(12, offset - cdStart, true) // 中央目录长度
  ev.setUint32(16, cdStart, true)          // 中央目录偏移
  parts.push(eocd)
  const out = new Uint8Array(offset + 22)
  let p = 0
  for (const c of parts) { out.set(c, p); p += c.length }
  return out
}

// 1x1 红色 PNG（验证书内图片经 data: 子资源通道能加载）
// ★ 导出给 make-fb2.mjs 复用（FB2 的图片是**自带 base64** 的 <binary>，通道不同但图同一张）。
//   导出这个常量不改变 epub 产物字节（zipStore 未动），故已绿的 probe-epub-reader 无需重跑证伪。
export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const xhtml = (title, body) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${title}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${body}
</body></html>`

const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

const nav = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body><nav epub:type="toc"><ol>
  <li><a href="ch1.xhtml#c1">第一章 探针样书</a></li>
  <li><a href="ch2.xhtml#c2">第二章 正文与划选</a></li>
  <li><a href="ch3.xhtml#c3">第三章 收尾</a></li>
</ol></nav></body></html>`

/** 书内 CSS：给探针一个稳定可断言的特征（`h1 { color: #c00 }` → computed rgb(204, 0, 0)） */
const style = `body { font-family: serif; line-height: 1.8; }
h1 { color: #c00; }`

/**
 * 组装整本 EPUB。
 * @param {{title:string, id:string, chapters:string[], extraFiles?:Array<[string,string]>}} o
 *        `extraFiles` 的路径相对 `OEBPS/`（如 `['evil.js', '…']`），会**同时**进 manifest
 *        —— 只放文件不登记 manifest 会让子资源解析不到，探针就测不到「data: 脚本被 CSP 拦」。
 */
function pack({ title, id, chapters, extraFiles = [] }) {
  const items = extraFiles.map(([name], i) =>
    `    <item id="extra${i}" href="${name}" media-type="${name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream'}"/>`)
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${id}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="img" href="img.png" media-type="image/png"/>
${items.join('\n')}
  </manifest>
  <spine>
    <itemref idref="ch1"/><itemref idref="ch2"/><itemref idref="ch3"/>
  </spine>
</package>`
  return zipStore([
    ['mimetype', 'application/epub+zip'], // ★ 必须第一个且不压缩（EPUB 规范）
    ['META-INF/container.xml', container],
    ['OEBPS/content.opf', opf],
    ['OEBPS/nav.xhtml', nav],
    ['OEBPS/style.css', style],
    ['OEBPS/img.png', new Uint8Array(PNG_1PX)],
    ['OEBPS/ch1.xhtml', xhtml('第一章', chapters[0])],
    ['OEBPS/ch2.xhtml', xhtml('第二章', chapters[1])],
    ['OEBPS/ch3.xhtml', xhtml('第三章', chapters[2])],
    ...extraFiles.map(([name, body]) => [`OEBPS/${name}`, body]),
  ])
}

/**
 * 正常样书：段落带唯一可断言文本（`第 N 段`），且**足够长以触发真实分页**
 * （paginator 要能测出多页，否则「翻页 / 进度 / CFI 落盘」全退化成单页恒真）。
 */
export function probeEpub() {
  const filler = (from, to) => {
    const out = []
    for (let i = from; i <= to; i++) {
      out.push(`<p>第 ${i} 段：这是探针样书的正文段落，用于驱动真实分页并验证 EPUB 阅读器的进度落盘、目录跳转与划选摘录。</p>`)
    }
    return out.join('\n')
  }
  return pack({
    title: '探针样书',
    id: 'probe-epub-0001',
    chapters: [
      `<h1 id="c1">第一章 探针样书</h1>
<p>这一段用于验证外部 CSS 与图片在沙箱内能否加载。样式生效时本章标题应为红色。</p>
<p><img src="img.png" alt="探针图" width="40" height="40"/></p>
${filler(1, 20)}`,
      `<h1 id="c2">第二章 正文与划选</h1>
${filler(21, 45)}`,
      `<h1 id="c3">第三章 收尾</h1>
${filler(46, 60)}`,
    ],
  })
}

/**
 * 恶意样书：三种载荷各占一章。载荷全部 **inert**（只置标志位），用于断言
 * 「DOM 里在、执行没发生」——断言侧读宿主 `window.__kbProbePwned*` 与 `document.title`。
 */
export function maliciousEpub() {
  const evilJs = `window.__kbProbePwnedExt = true;
try { window.parent.__kbProbePwnedParentExt = true } catch (e) {}`
  return pack({
    title: '恶意样书（探针）',
    id: 'probe-epub-evil',
    extraFiles: [['evil.js', evilJs]],
    chapters: [
      `<h1 id="c1">第一章 外部脚本载荷</h1>
<p id="payload-ext">本页用 &lt;script src&gt; 引外部脚本（该子资源会被改写成 data: URL）。</p>
<script src="evil.js"></script>
<p>这段在外部脚本之后。</p>`,
      `<h1 id="c2">第二章 内联脚本载荷</h1>
<p id="payload-inline">本页含内联 script。</p>
<script>
  window.__kbProbePwnedInline = true;
  try { window.parent.__kbProbePwnedParent = true; window.parent.document.title = 'PWNED-INLINE' } catch (e) { window.__kbProbePwnedErr = String(e) }
</script>
<p>这段在内联脚本之后。</p>`,
      `<h1 id="c3">第三章 事件处理器载荷</h1>
<p id="payload-onerror">本页含 onerror 事件处理器属性。</p>
<img src="missing-not-exist.png" alt="坏图" onerror="window.__kbProbePwnedOnerror = true; try { window.parent.__kbProbePwnedParentOnerror = true } catch (e) {}"/>
<p>这段在坏图之后。</p>`,
    ],
  })
}
