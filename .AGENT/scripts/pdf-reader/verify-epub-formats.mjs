// 契约验证：书架阅读器 B 段 · 电子书引擎（foliate vendored）与 CSP 例外。
//
// 覆盖十二组断言：
//   ① CSP 例外**只开了该开的**，且 key 防线未被弱化（script-src 不含 'unsafe-inline'）
//   ② vendored foliate 关键文件齐全（缺文件 = 阅读器直接炸，且是运行时才炸）
//   ③ ★ sandbox 负向：所有 setAttribute('sandbox', …) 调用一律不含 allow-scripts
//   ④ ★ patch ①② 在位：createURL 内容文档走 blob:、子资源走 data:（丢了会让书内 CSS/图片全裂）；
//     patch ④ 在位：FB2 样式表内联进 <style>（丢回 blob: 会让 FB2 排版被 CSP 静默拦掉）
//   ⑤ 依赖与文档登记（polyfill 已入 deps、vendor README 未被删）
//   ⑥ ★ 格式真相源四处一致：bookFormats.BOOK_EXTS ↔ src/types 的 BookKind ↔ 两个 schema 的 BOOK_KINDS
//     （都是手工镜像，谁加格式漏改一处就是「kind 认不出 → 阅读器开错引擎」）
//   ⑦ locator 白名单（B 段新引入）＋ kind **仍不在**白名单（它是 relPath 的纯函数）
//   ⑧ ★ 负向：EPUB 相关组件不得把引擎拖进首屏静态闭包（BookCover 静态 PdfCover 是已修的历史违规）
//   ⑨ ★ 阶段 2a 负向：阅读器不得再写死格式（MIME / `.epub` / kind:'epub' 一律走 bookFormats），
//     且主进程整份读白名单 ⊇ BOOK_EXTS（漏一个 = 打开新格式时 readWholeBook 直接报错）
//   ⑩ ★ 阶段 2b（cbz 固定版式）：patch ⑤ 三件事（自然序 / 扩展名大小写 / getPageBlob）·
//     CSP 例外只开在 img-src · 缩略图网格两侧接线与下采样 · 固定版式判据单点 · 右栏 Tab 不留
//   ⑪ ★ patch ⑥（B-17 `#render` 空帧早退，且必须在读 `right` 之前）· patch ⑦（B-18 页图补 MIME，
//     两条都加了「未放宽安全面」的负向）
//   ⑫ ★ patch ⑧（B-21：`View.destroy()` 的自我否定之门 → 按留存引用撤销；含 `#container` / 可选
//     调用两处上游笔误，与 README 计数＝8 的登记面。★ 这条的核心是**负向断言** ——
//     上游那条 `if (this.document)` 一旦被升级重放回去，观察者就永久留在已脱离的帧上）
//
// 注：`bookKindOf` / `bookEngineOf` 的纯函数用例表在 verify-reader-formats.mjs 的 ①组
// （与其它 bookFormats 用例同处），此处只做「跨文件一致性 + 负向」两件事，不重复用例。
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/pdf-reader/verify-epub-formats.mjs
// 期望：全部 ok + exit=0

import { stripComments } from '../shared/strip-comments.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const exists = (p) => existsSync(join(ROOT, p))

const VENDOR = 'src/vendor/foliate'

// ===== ① CSP 例外（index.html） =====
console.log('\n--- ① CSP：例外只开该开的，防线未被弱化 ---')
{
  const html = read('index.html')
  const meta = (html.match(/<meta[^>]*Content-Security-Policy[^>]*>/) || [''])[0]
  const csp = (meta.match(/content="([^"]*)"/) || ['', ''])[1]
  check('index.html 有 CSP meta 且取到 content', csp.length > 0)

  // 取指令值（CSP 指令之间以 ; 分隔）
  const dir = (name) => {
    const m = csp.match(new RegExp(`(?:^|;)\\s*${name}\\s([^;]*)`))
    return m ? m[1].trim() : ''
  }
  const scriptSrc = dir('script-src')
  const frameSrc = dir('frame-src')
  const styleSrc = dir('style-src')

  check("script-src 存在且含 'self'", scriptSrc.includes("'self'"))
  check("★★ script-src 不含 'unsafe-inline'（挡恶意 EPUB 的关键防线，永不可加）",
    !scriptSrc.includes("'unsafe-inline'"), scriptSrc)
  check('frame-src 含 blob:（电子书内容帧同源所需）',
    frameSrc.split(/\s+/).includes('blob:'), frameSrc)
  check('style-src 含 data:（书内 CSS 走 data: 所需）',
    styleSrc.split(/\s+/).includes('data:'), styleSrc)
  check("style-src 仍含 'unsafe-inline'（原本就有，勿被顺手删）",
    styleSrc.includes("'unsafe-inline'"))
  check("default-src 仍为 'self'（未被弱化）", dir('default-src') === "'self'", dir('default-src'))
  check('新增的两处例外均带注释说明（index.html 内有铁律 10 指引）',
    html.includes('铁律 10') && html.includes('vendor/foliate'))
}

// ===== ② vendored foliate 文件齐全 =====
console.log('\n--- ② vendored foliate：关键文件齐全 ---')
{
  const required = [
    'view.js', 'epub.js', 'epubcfi.js', 'paginator.js',
    'overlayer.js', 'progress.js', 'text-walker.js',
    'vendor/zip.js', 'vendor/fflate.js',
    // 阶段 2a：fb2.js 是被 view.js 静态 import 的分支解码器，缺了 = 打开 fb2 直接报错
    'fb2.js',
  ]
  const missing = required.filter((f) => !exists(`${VENDOR}/${f}`))
  check(`${required.length} 个核心文件全部在（缺任一 = 运行时才炸）`, missing.length === 0, missing.join(', '))
  check('LICENSE 随源码入库（MIT 合规）', exists(`${VENDOR}/LICENSE`))
  check('view.js 的静态依赖也在（epubcfi/progress/overlayer/text-walker）',
    ['epubcfi.js', 'progress.js', 'overlayer.js', 'text-walker.js'].every((f) => exists(`${VENDOR}/${f}`)))
}

// ===== ③ ★ sandbox 负向：永不含 allow-scripts =====
console.log('\n--- ③ ★ sandbox：永不含 allow-scripts（独立于 CSP 的第二道防线）---')
{
  for (const f of ['paginator.js', 'fixed-layout.js']) {
    const p = `${VENDOR}/${f}`
    if (!exists(p)) { check(`${f} 存在`, false); continue }
    // 必须先剥注释：KB PATCH 的说明文字里含 "allow-scripts" 字样
    const src = stripComments(read(p))
    const calls = [...src.matchAll(/setAttribute\(\s*['"]sandbox['"]\s*,\s*['"]([^'"]*)['"]\s*\)/g)]
      .map((m) => m[1])
    check(`${f} 确有 sandbox 设置调用`, calls.length > 0, `实得 ${calls.length} 处`)
    check(`★★ ${f} sandbox 不含 allow-scripts`, calls.every((v) => !v.includes('allow-scripts')), calls.join(' | '))
    check(`${f} sandbox 保留 allow-same-origin（分页需读 contentDocument）`,
      calls.every((v) => v.includes('allow-same-origin')), calls.join(' | '))
  }
}

// ===== ④ ★ createURL patch 在位 =====
console.log('\n--- ④ ★ createURL：内容文档 blob: / 子资源 data: ---')
{
  const src = stripComments(read(`${VENDOR}/epub.js`))
  check('kbToDataURL 辅助函数在位', src.includes('kbToDataURL'))
  check('内容文档判定 kbIsDocument 在位', src.includes('kbIsDocument'))
  check('内容文档仍走 URL.createObjectURL（同源分页所需，勿改成 data:）',
    /kbIsDocument[\s\S]{0,200}URL\.createObjectURL/.test(src))
  check('子资源分支调用 kbToDataURL',
    /:\s*await kbToDataURL\(/.test(src))
  check('revokeObjectURL 有 blob: 守卫（data: 不可 revoke）',
    src.includes("startsWith('blob:')"))
}

// ===== ④b ★ patch ④ 在位：FB2 样式表内联 =====
console.log('\n--- ④b ★ fb2.js：内建样式表内联进 <style>（CSP style-src 无 blob:）---')
{
  const src = stripComments(read(`${VENDOR}/fb2.js`))
  check('fb2CSS 常量在位（CSS 文本直挂模块作用域）', /const fb2CSS\s*=/.test(src))
  check('★ template 用 <style>${fb2CSS}</style> 内联（改回 <link href="blob:…"> = FB2 排版被 CSP 静默拦掉）',
    /<style>\$\{fb2CSS\}<\/style>/.test(src))
  check('★ fb2.js 不再为样式表造 blob:（改回去 = 样式表重新变成被 CSP 拦的子资源）',
    !/createObjectURL\(new Blob\(\[[^\]]*text\/css/.test(src))
  check('FB2 节文档仍走 blob:（paginator 要读 contentDocument，勿改成 data:）',
    /new Blob\(\[str\], \{ type: MIME\.XHTML \}\)[\s\S]{0,120}URL\.createObjectURL/.test(src))
}

// ===== ⑤ 依赖与文档登记 =====
console.log('\n--- ⑤ 依赖与文档登记 ---')
{
  const pkg = JSON.parse(read('package.json'))
  check('construct-style-sheets-polyfill 已入 dependencies（fixed-layout.js 静态 import）',
    !!pkg.dependencies?.['construct-style-sheets-polyfill'])
  check('vendor README 在位（含升级手法与安全模型）', exists(`${VENDOR}/README.md`))
  const rdm = exists(`${VENDOR}/README.md`) ? read(`${VENDOR}/README.md`) : ''
  check('README 记录了 KB PATCH 与升级流程',
    rdm.includes('KB PATCH') && rdm.includes('升级流程'))
  check('AGENTS.md 铁律 10 已补例外条款',
    read('AGENTS.md').includes('唯一例外：电子书内容帧'))
}

// ===== ⑥ ★ 格式真相源三处一致 =====
console.log('\n--- ⑥ ★ 格式真相源：bookFormats ↔ src/types ↔ 两个 schema ---')
{
  const F = await import('../../../electron/lib/kbStore/bookFormats.ts')
  const S = await import('../../../electron/lib/kbStore/readerStateSchema.ts')
  const E = await import('../../../electron/lib/kbStore/excerptSchema.ts')

  // 真源：bookFormats 的两张表（BOOK_EXTS 与 BookKind 靠 KIND_BY_EXT 绑定）
  const extKinds = [...F.BOOK_EXTS].map((ext) => F.bookKindOf(`x${ext}`)).sort()
  const truth = [...new Set(extKinds)].sort()
  check('bookFormats 自洽：每个扩展名都能推出一个 kind', extKinds.every((k) => !!k), truth.join(','))

  // 镜像 1：src/types 的 BookKind 联合（源码文本解析 —— 渲染层类型无法值导入）
  const typesSrc = stripComments(read('src/types/index.ts'))
  const unionMatch = typesSrc.match(/export type BookKind\s*=\s*([^\n]+)/)
  const unionKinds = unionMatch
    ? [...unionMatch[1].matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]).sort()
    : []
  check('★ src/types 的 BookKind 与 bookFormats.BOOK_EXTS 双向一致',
    unionKinds.length > 0 && unionKinds.join(',') === truth.join(','),
    `types=[${unionKinds.join(',')}] bookFormats=[${truth.join(',')}]`)

  // 镜像 2 / 3：两个 schema 的 BOOK_KINDS 数组字面量
  for (const [label, mod] of [['readerStateSchema', S], ['excerptSchema', E]]) {
    const kinds = [...(mod.BOOK_KINDS ?? [])].sort()
    check(`★ ${label}.BOOK_KINDS 与 bookFormats.BOOK_EXTS 双向一致`,
      kinds.join(',') === truth.join(','), `schema=[${kinds.join(',')}]`)
  }

  // 引擎路由：kind → engine 必须能推出来（新格式漏配 ENGINE_BY_EXT 就会落到 else 分支被当 PDF 打开）
  const engineOk = truth.every((k) => {
    const ext = [...F.BOOK_EXTS].find((e) => F.bookKindOf(`x${e}`) === k)
    return !!ext && !!F.bookEngineOf(ext)
  })
  check('每个 kind 都能推出引擎（bookEngineOf 无缺口）', engineOk)
}

// ===== ⑦ locator 白名单 + kind 仍不在白名单 =====
console.log('\n--- ⑦ locator 白名单 / kind 不在白名单 ---')
{
  const S = await import('../../../electron/lib/kbStore/readerStateSchema.ts')
  const cfi = 'epubcfi(/6/4!/4/2/1:0)'
  const okLoc = S.sanitizeReaderPatch({ locator: cfi })
  check('patch：locator 收（合法 CFI）', !!okLoc && okLoc.locator === cfi)
  check('patch：locator + pct 可同写（一次写入避免两次 patch 打架）',
    (() => { const r = S.sanitizeReaderPatch({ pct: 42, locator: cfi }); return !!r && r.pct === 42 && r.locator === cfi })())
  check('patch：locator 空串拒', S.sanitizeReaderPatch({ locator: '' }) === null)
  check('patch：locator 非字符串拒', S.sanitizeReaderPatch({ locator: 12 }) === null)
  check('patch：超长 locator 拒（>2000 字符，防写垃圾撑爆 JSON）',
    S.sanitizeReaderPatch({ locator: 'x'.repeat(2001) }) === null)
  check('patch：含控制字符的 locator 拒',
    S.sanitizeReaderPatch({ locator: 'a\u0000b' }) === null)

  // ★ 陷阱复现：kind 若进白名单，客户端就能把 epub 书写成 txt（阅读器开错引擎）
  check('★★ kind 仍不在 patch 白名单（它是 relPath 的纯函数，客户端报什么都不算）',
    S.sanitizeReaderPatch({ kind: 'epub' }) === null)

  const c = S.coerceReaderState({ kind: 'epub', locator: cfi, pct: 30 }, 'NOW')
  check('修补：合法 kind=epub 保留', c.kind === 'epub')
  check('修补：合法 locator 保留', c.locator === cfi)
  const c2 = S.coerceReaderState({ kind: 'epub', locator: 'x'.repeat(2001), pct: 30 }, 'NOW', 'epub')
  check('修补：超长 locator 丢弃，kind 不回退', c2.kind === 'epub' && c2.locator === undefined)
  const c3 = S.coerceReaderState({ kind: 'txt' }, 'NOW', 'epub')
  check('★ 修补：deriveKind（按 relPath 推导）优先于存档 kind —— 自愈历史脏值', c3.kind === 'epub')

  // repo 侧必须真的用上推导（否则 kind 依然只在首写时固定）
  const repo = stripComments(read('electron/lib/kbStore/readerStateVaultRepo.ts'))
  check('readerStateVaultRepo 用 bookKindOf 推导 kind（kindOfPath）', repo.includes('bookKindOf') && repo.includes('kindOfPath'))
  check('readerStateVaultRepo 三处调用点都传了推导值',
    (repo.match(/kindOfPath\(/g) ?? []).length >= 3, `实得 ${(repo.match(/kindOfPath\(/g) ?? []).length} 处`)
}

// ===== ⑧ ★ 负向：引擎不进首屏静态闭包 =====
console.log('\n--- ⑧ ★ 负向：foliate / pdfjs 不得进首屏静态闭包 ---')
{
  // BookCover 是历史上的违规点（静态 import PdfCover → pdfjs → 入口 chunk 1.15MB）
  const cover = stripComments(read('src/modules/bookshelf/BookCover.tsx'))
  check("★ BookCover 不含静态 import PdfCover（必须 lazy）",
    !/^\s*import\s+[^;]*from\s*['"]\.\/PdfCover['"]/m.test(cover), '静态写回 = pdfjs 重新进首屏')
  check('BookCover 用 lazy(() => import(...)) 取 PdfCover', cover.includes('lazy(') && cover.includes("import('./PdfCover')"))
  check('BookCover 不 import foliate', !cover.includes('foliate'))

  /**
   * 静态 import 块的源码切片（用于「组件不得静态引入」断言）。
   * 两步走避免误判：① 先删掉 `import 'x.css'` 这类副作用导入（它没有 from，
   * 会让下面的惰性匹配吞掉整段代码）；② 用 `import … from '…'` 惰性匹配跨行导入块。
   */
  const staticImportBlocks = (src) =>
    (src.replace(/^[ \t]*import\s*['"][^'"]+['"][ \t]*$/gm, '')
      .match(/(?:^|\n)[ \t]*import[\s\S]*?from[ \t]*['"][^'"]+['"]/g) ?? []).join('\n')

  for (const [host, comp] of [
    ['src/modules/bookshelf/index.tsx', 'EpubReaderView'],
    ['src/App.tsx', 'EpubRailPanel'],
  ]) {
    const src = stripComments(read(host))
    check(`${host} 不静态 import ${comp}`,
      !staticImportBlocks(src).includes(comp), '静态引入 = foliate 引擎进首屏静态闭包')
    check(`${host} 经 lazy(() => import(...)) 引 ${comp}`,
      new RegExp(`lazy\\(\\(\\)\\s*=>\\s*import\\([^)]*${comp}`).test(src))
  }

  // 阅读器本体：引擎只能被 lazy 的 EpubReaderView 拖走，不得被 App/书架/左栏面板静态引入
  for (const p of ['src/App.tsx', 'src/modules/bookshelf/index.tsx', 'src/components/shared/epub/EpubRailPanel.tsx']) {
    check(`${p} 不静态 import foliate 引擎`,
      !/from\s*['"][^'"]*vendor\/foliate/.test(staticImportBlocks(stripComments(read(p)))), '')
  }
  check('书架模块按引擎三分发（bookEngineOf，而非 kind 二值）',
    stripComments(read('src/modules/bookshelf/index.tsx')).includes('bookEngineOf'))
  check('App 左栏也按引擎分发（bookEngineOf）',
    stripComments(read('src/App.tsx')).includes('bookEngineOf'))
  check('EpubRailPanel 不 import foliate（目录靠事件传值，不重复解析整本）',
    !stripComments(read('src/components/shared/epub/EpubRailPanel.tsx')).includes('vendor/foliate'))
}

// ===== ⑨ ★ 阶段 2a 负向：阅读器不得写死格式 =====
console.log('\n--- ⑨ ★ fb2/fbz 接入：阅读器零格式字面量 + 主进程白名单同步 ---')
{
  // (1) 阅读器：File 的 name/type 与摘录 kind 都必须由 bookFormats 派生
  const reader = stripComments(read('src/components/shared/epub/EpubReaderView.tsx'))
  check('EpubReaderView 从 bookFormats 取格式（不再自拼 MIME）',
    reader.includes('bookMimeOf') && reader.includes('bookExtOf') && reader.includes('bookKindOf'))
  check('★ EpubReaderView 不含 MIME 字面量（自拼 = foliate 按错 type 选解码器）',
    !/application\/(epub\+zip|x-fictionbook|zip-compressed)/.test(reader))
  check("★ EpubReaderView 不再写死 `kind: 'epub'`（fb2/fbz 摘录会被记成 epub）",
    !/kind:\s*'epub'/.test(reader))
  check("★ EpubReaderView 不再把摘录按 `=== 'epub'` 过滤（fb2/fbz 高亮会整体不画）",
    !/===\s*'epub'/.test(reader))
  check('File 名由 bookExtOf 拼（`.epub` 后缀不再硬编码在 File 名里）',
    /\$\{name \|\| 'book'\}\$\{bookExt/.test(reader))

  // (2) 跳回原文：两个派发点都按**引擎**判定，而非 kind === 'epub'
  const app = stripComments(read('src/App.tsx'))
  const cfiDispatch = (app.match(/KB_EPUB_GOTO_CFI, \{ detail/g) ?? []).length
  const engineGuard = (app.match(/bookEngineOf\([^)]*\) === 'foliate' && (ex|loc)\.cfi/g) ?? []).length
  check(`App 的 ${cfiDispatch} 处 CFI 派发都由引擎判定（bookEngineOf === 'foliate'）`,
    cfiDispatch > 0 && engineGuard === cfiDispatch, `实得守卫 ${engineGuard} 处`)

  // (3) 导出分组：foliate 三格式共用「按章节」分支，不得落到 txt 的 paraIndex 分支
  const exp = stripComments(read('electron/lib/kbStore/excerptExportSchema.ts'))
  check('★ 导出分组显式列出三个 foliate 格式（写 else 会让 fb2 摘录被当 txt 并成「第 1 段」）',
    /\['epub', 'fb2', 'fbz'\]/.test(exp) || /=== 'epub' \|\| kind === 'fb2' \|\| kind === 'fbz'/.test(exp))

  // (4) 摘录 schema：三个 foliate 格式同走 CFI 必填分支，且末尾不留吞新格式的 else
  const exS = stripComments(read('electron/lib/kbStore/excerptSchema.ts'))
  check('★ 摘录 schema 显式列出三个 foliate 格式（else 会把未来格式静默塞进 CFI 校验）',
    /kind === 'epub' \|\| kind === 'fb2' \|\| kind === 'fbz'/.test(exS))

  // (5) 主进程整份读白名单必须覆盖全部书籍格式（漏一个 = readWholeBook 第一步就报错）
  const F2 = await import('../../../electron/lib/kbStore/bookFormats.ts')
  const wm = stripComments(read('electron/lib/workspaceManager.ts'))
  const m = wm.match(/RANGE_EXT_WHITELIST\s*=\s*\[([^\]]*)\]/)
  const listed = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []
  const missing = [...F2.BOOK_EXTS].map((e) => e.slice(1)).filter((e) => !listed.includes(e))
  check(`★ RANGE_EXT_WHITELIST ⊇ BOOK_EXTS（缺 ${missing.length} 项）`, missing.length === 0, missing.join(', '))
}

// ===== ⑩ ★ 阶段 2b：cbz（固定版式）—— patch ⑤ / CSP img-src / 缩略图网格接线 =====
console.log('\n--- ⑩ ★ cbz：comic-book patch ⑤ / img-src 例外 / 缩略图网格 ---')
{
  // (1) patch ⑤ 三件事缺一不可（丢任一条都是「实机才炸」的静默错：错页 / 整包被过滤 / 拿不到页图）
  const comic = stripComments(read(`${VENDOR}/comic-book.js`))
  check('★ patch ⑤-a：页序改自然序比较器（裸 .sort() = page_10 排到 page_2 前面，静默错页）',
    /Intl\.Collator\('en',\s*\{\s*numeric:\s*true/.test(comic))
  check("★ patch ⑤-a：collator 钉死 'en'（传 undefined 会随运行环境 locale 变，页序不可复现）",
    !/new Intl\.Collator\(\s*undefined/.test(comic))
  check('★ patch ⑤-b：扩展名判定大小写不敏感（.JPG 会让整包报 No supported image files）',
    /toLowerCase\(\)/.test(comic) && /lower\.endsWith\(ext\)/.test(comic))
  check('★ patch ⑤-c：暴露页图字节 book.getPageBlob（宿主缩略图网格靠它，否则要再解一遍 zip）',
    /book\.getPageBlob\s*=/.test(comic))
  check('comic-book.js 未被改回 pre-paginated 之外的 layout（固定版式是它的语义）',
    /layout:\s*'pre-paginated'/.test(comic))

  // (2) CSP：cbz 页图只能走 blob:（每页图一个 blob URL，套进一层 blob 文档）——
  //     例外只开在 img-src，且两条硬约束不得松（①组已锁 script-src / 这里再锁一次意义不大，故只锁 img）
  const csp2 = (read('index.html').match(/<meta[^>]*Content-Security-Policy[^>]*>/) || [''])[0]
  const cspVal = (csp2.match(/content="([^"]*)"/) || ['', ''])[1]
  const imgSrc = (cspVal.match(/(?:^|;)\s*img-src\s([^;]*)/) || ['', ''])[1].trim()
  check('★ img-src 含 blob:（cbz 页图所需）', imgSrc.split(/\s+/).includes('blob:'), imgSrc)
  check('img-src 仍含 data: 与 file:（①的子资源改 data: 路线未被这条例外顶掉）',
    imgSrc.split(/\s+/).includes('data:') && imgSrc.split(/\s+/).includes('file:'))
  check('index.html 里有 cbz / img-src 例外与铁律 10 的对应说明', /cbz/i.test(read('index.html')))
  check("style-src / font-src 未被顺势放开 blob:（cbz 只需要 img）",
    !(cspVal.match(/(?:^|;)\s*style-src\s([^;]*)/) || ['', ''])[1].includes('blob:')
    && !(cspVal.match(/(?:^|;)\s*font-src\s([^;]*)/) || ['', ''])[1].includes('blob:'))

  // (3) 事件常量两侧都在用（少接一头 = 网格永远只有页码占位）
  const ev = stripComments(read('src/components/shared/pdf/pdfEvents.ts'))
  check('pdfEvents 定义 KB_CBZ_THUMB_REQ / KB_CBZ_THUMBS',
    ev.includes('KB_CBZ_THUMB_REQ') && ev.includes('KB_CBZ_THUMBS'))
  const readerSrc = stripComments(read('src/components/shared/epub/EpubReaderView.tsx'))
  check('阅读器两侧都接（监听 REQ + 派发 THUMBS）',
    readerSrc.includes('KB_CBZ_THUMB_REQ') && readerSrc.includes('KB_CBZ_THUMBS'))
  const railSrc = stripComments(read('src/components/shared/epub/EpubRailPanel.tsx'))
  check('左栏两侧都接（派发 REQ + 监听 THUMBS）',
    railSrc.includes('KB_CBZ_THUMB_REQ') && railSrc.includes('KB_CBZ_THUMBS'))
  check('缩略图在宿主侧下采样（OffscreenCanvas + createImageBitmap），不是把原图塞进格子',
    readerSrc.includes('OffscreenCanvas') && readerSrc.includes('createImageBitmap'))
  check('★ 位图用完即 close（不下采样/不关位图 = 一屏几百 MB + 滚动重解码）',
    /bmp\.close\(\)/.test(readerSrc))
  check('缩略图缓存有上限（THUMB_CACHE_MAX）', /THUMB_CACHE_MAX\s*=\s*\d+/.test(readerSrc))
  check('★ 队列串行且页间让出主线程（zip 解包与解码都在主线程，连做会把翻页卡住）',
    /setTimeout\(r,\s*0\)/.test(readerSrc))

  // (4) 固定版式判据：单点、按 kind 推导，不读运行时 view.isFixedLayout
  check("★ 固定版式判据单点：isFixedLayoutBook = bookKind === 'cbz'",
    /const isFixedLayoutBook\s*=\s*bookKind === 'cbz'/.test(readerSrc))
  check('★ 不读运行时 view.isFixedLayout（工具栏要在 open() 之前就渲染对）',
    !/\.isFixedLayout\b/.test(readerSrc))
  check("★ 固定版式工具栏：字号按钮隐藏 + 出缩放档（data-wb=\"epubZoom\"）",
    /!isFixedLayoutBook\s*&&/.test(readerSrc) && readerSrc.includes('data-wb="epubZoom"'))
  check('缩放写在 renderer 的 zoom 属性上（无 vendor 改动）',
    /setAttribute\('zoom'/.test(readerSrc))
  check('★ 单页显示：open 前把 rendition.spread 置 none（不是改 vendor 的拼版逻辑）',
    /spread:\s*'none'/.test(readerSrc))
  check('固定版式页面标签用 section.current（relocate detail 顶层没有 index）',
    /d\.section\.current/.test(readerSrc))

  // (5) 左栏网格四要素（丢任一条的分别是：不请求 / 断了线 / 无锚点 / 滚轮没反应）
  check('左栏 cbz 分支按 bookKindOf 判定', /bookKindOf\(relPath\)\s*===\s*'cbz'/.test(railSrc))
  check('左栏格子带 data-cbz-page 锚点（IntersectionObserver 按它读页号）',
    /data-cbz-page=\{i\}/.test(railSrc))
  check('左栏用 IntersectionObserver 按可见范围预取', railSrc.includes('IntersectionObserver'))
  check('左栏网格格子用 .kb-cv-tile（长列表虚拟化，估值必须贴近真实格高）',
    railSrc.includes('kb-cv-tile'))
  const css = read('src/styles/index.css')
  check('.kb-cv-tile 已定义且估值 156px（= 图区 138 + 页码行 18）',
    /\.kb-cv-tile\s*\{[^}]*contain-intrinsic-size:\s*auto\s+156px/.test(css))

  // (6) 右栏阅读 Tab 对 cbz 不留（拍板①）：App 传 null 即 Tab 消失
  const app3 = stripComments(read('src/App.tsx'))
  check("★ 右栏 reading 传参对 cbz 置空（kind !== 'cbz' 守卫在位）",
    /reading=\{[^}]*kind\s*!==\s*'cbz'/.test(app3))

  // (7) 负向：格式知识仍单点 —— 渲染层不得出现 cbz 的 MIME / 扩展名字面量
  for (const p of [
    'src/components/shared/epub/EpubReaderView.tsx',
    'src/components/shared/epub/EpubRailPanel.tsx',
  ]) {
    const s = stripComments(read(p))
    check(`★ ${p.split('/').pop()} 不含 cbz MIME 字面量（自拼 MIME = foliate 按错 type 选解码器）`,
      !/application\/vnd\.comicbook/.test(s))
    check(`★ ${p.split('/').pop()} 不含 '.cbz' 扩展名字面量（一律走 bookKindOf / bookExtOf）`,
      !/['"]\.cbz['"]/i.test(s))
  }
}

// ===== ⑪ ★ B-17 / B-18：vendor patch ⑥⑦（RO 空帧早退 + cbz 页图 MIME）=====
console.log('\n--- ⑪ ★ patch ⑥（B-17 RO 空帧早退）/ patch ⑦（B-18 页图 MIME）---')
{
  // (1) patch ⑥：`#render` 无帧早退（判据 = `right` 缺席，非「三槽全空」）
  const flSrc = stripComments(read(`${VENDOR}/fixed-layout.js`))
  const guardIdx = flSrc.search(/if \(!right\) return/)
  const readIdx = flSrc.search(/const right = this\.#center \?\? this\.#right/)
  const targetIdx = flSrc.search(/const target = side === 'left' \? left : right/)
  const transformIdx = flSrc.search(/transform\(right\)/)
  check('★ patch ⑥：`#render` 无帧早退在位（`right` 缺席 = 无帧可渲）', guardIdx > -1)
  check('★★ patch ⑥：早退位置必须在 `const right = …` **之后**（早于它就是引用未声明变量）'
    + '、且在 `const target = …` **之前**（晚于它就先在 `target.width` 上抛了，白改）',
    guardIdx > -1 && readIdx > -1 && targetIdx > -1 && readIdx < guardIdx && guardIdx < targetIdx)
  check('★ patch ⑥ 覆盖到第二条路径：`transform(right)` 也排在守卫之后'
    + '（双页路径第二个 await 窗口：`#left` 已挂上、`#right` 仍 null —— `side===\'left\'` 时'
    + '前两处都不抛，最后由它解构 null 抛；「三槽全空」判据罩不住这一条）',
    guardIdx > -1 && transformIdx > -1 && guardIdx < transformIdx)
  check('★ patch ⑥ 的前提仍在：`#observer` 回调直连 `#render`（就是 await 窗口里的触发路径）',
    /#observer\s*=\s*new ResizeObserver\(\(\)\s*=>\s*this\.#render\(\)\)/.test(flSrc))

  // (2) patch ⑦：页图补 MIME —— 三条缺一不可（不传 / 表漏项 / 大小写敏感，都回到破图）
  const comic2 = stripComments(read(`${VENDOR}/comic-book.js`))
  check('★ patch ⑦：页图 loadBlob 传了 MIME 第二实参（不传 ⇒ Blob type=\'\' ⇒ Chromium 按未知类型拒绝解码）',
    /URL\.createObjectURL\(await loadBlob\(name,\s*mimeOf\(name\)\)\)/.test(comic2))
  check('★ patch ⑦：`mimeOf` 取后缀是**大小写不敏感**的（与 patch ⑤-b 配对：⑤-b 放 `.JPG` 进白名单，'
    + '这里若大小写敏感，那一类页仍拿到 type=\'\' ⇒ 进得来、显示不出）',
    /lastIndexOf\('\.'\)[\s\S]{0,120}?toLowerCase\(\)/.test(comic2))
  check('★ patch ⑦：`.svg → image/svg+xml` 在表里（B-18 的靶子：SVG 不在浏览器嗅探表里，必须显式给 MIME）',
    /'\.svg':\s*'image\/svg\+xml'/.test(comic2))

  // ★ 交叉校验：MIME 表键集合 ⊇ exts 白名单（漏一项 = 那一类页静默破图，且白名单让它照进归档）
  const extsM = comic2.match(/const exts = \[([^\]]*)\]/)
  const extsList = extsM ? extsM[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : []
  const mimeKeys = [...comic2.matchAll(/'(\.\w+)':\s*'image\//g)].map((m) => m[1])
  const missingMime = extsList.filter((e) => !mimeKeys.includes(e))
  check(`★ patch ⑦：MIME 表覆盖 exts 白名单全部 ${extsList.length} 个扩展名（漏项数 ${missingMime.length}）`,
    extsList.length > 0 && missingMime.length === 0, missingMime.join(', ') || extsList.join(','))

  // (3) 负向：两条 patch 都不得顺势放宽安全面
  const flCalls = [...stripComments(read(`${VENDOR}/fixed-layout.js`)).matchAll(/setAttribute\('sandbox',\s*([^)]*)\)/g)]
    .map((m) => m[1])
  check('★ patch ⑥ 未顺手把 sandbox 的 allow-scripts 加回来',
    flCalls.length > 0 && flCalls.every((c) => !c.includes('allow-scripts')), flCalls.join(' | '))
  check('★ patch ⑦ 未把页图改成 data:/内联 HTML（cbz 页图动辄数 MB，只能走 blob:）',
    !/kbToDataURL|readAsDataURL/.test(comic2))

  // (4) README 登记面：⑥⑦ 两条各自的动机在表里
  //     ★ 总数与「重放 N 处」的硬同步由第 ⑫ 组独占断言（patch 表还在长，别在多处各写一遍总数）
  const rdm2 = read(`${VENDOR}/README.md`)
  const sections = (rdm2.match(/^### [①②③④⑤⑥⑦⑧⑨⑩]/gm) || []).length
  check(`★ README 的 patch 表 ≥7 条（实为 ${sections}；删/加 patch 必须同步这张表）`, sections >= 7)
  check('★ README 记了 ⑥⑦ 两条的动机（升级重放时才知道为什么不能丢）',
    rdm2.includes('空帧早退') && rdm2.includes('页图补 MIME'))
}

// ===== ⑫ ★ B-21：vendor patch ⑧（拆卸时按留存引用撤销 ResizeObserver 观察）=====
console.log('\n--- ⑫ ★ patch ⑧（B-21：`View.destroy()` 的自我否定之门 → 按留存引用撤销）---')
{
  const pg = stripComments(read(`${VENDOR}/paginator.js`))

  // (1) View 侧：留引用 + 按引用撤销
  check('★ patch ⑧：`View` 留住了被观察节点的实体引用（`#body = null` 字段）',
    /#body\s*=\s*null/.test(pg))
  check('★ patch ⑧：`load()` 里**先留引用再 observe**（顺序反了就等于没留 —— 撤销时还是拿不到节点）',
    /this\.#body\s*=\s*doc\.body[\s\S]{0,90}?this\.#observer\.observe\(this\.#body\)/.test(pg))
  check('★ patch ⑧：`View.destroy()` 按留存引用撤销（`if (this.#body) … unobserve(this.#body)`）',
    /if\s*\(this\.#body\)[\s\S]{0,90}?unobserve\(this\.#body\)/.test(pg))

  // (2) ★★ 负向：上游那条「自我否定之门」必须不在
  check('★★ patch ⑧ 负向：`View.destroy()` 不得再按 `this.document`（= `iframe.contentDocument`）判据撤销 ——'
    + '帧一被摘它就变 null，而这**正是唯一需要它起作用的时刻** ⇒ 观察者被永久留在已脱离帧上，'
    + 'Chromium 每帧报一条 loop 告警（实测 166 条/秒，单轮 300~600 条）',
    !/if\s*\(this\.document\)\s*this\.#observer\.unobserve/.test(pg))

  // (3) Paginator 侧：两处上游笔误
  check('★ patch ⑧：`Paginator.destroy()` 撤销的是它**真正观察的** `#container`（上游写 `unobserve(this)` —— 撤错目标）',
    /unobserve\(this\.#container\)/.test(pg) && !/this\.#observer\.unobserve\(this\)/.test(pg))
  check('★ patch ⑧：`this.#view?.destroy()` 写成可选调用（`#view` 为 null 时上游会抛，后面的清理被截断）',
    /this\.#view\?\.destroy\(\)/.test(pg))

  // (4) README 计数与升级流程同步（★ 本组是总数的唯一断言处）
  const rdm3 = read(`${VENDOR}/README.md`)
  const sections3 = (rdm3.match(/^### [①②③④⑤⑥⑦⑧⑨⑩]/gm) || []).length
  check(`★ vendor README 的 patch 表有 ${sections3} 条（应为 8）且标题计数同步`,
    sections3 === 8 && rdm3.includes('KB PATCH（8 处'))
  check('★ README 的升级流程同步到 8 处（照 7 处重放 = 升级后这条修悄悄丢掉）',
    /重放上述 8 处 patch/.test(rdm3))
  check('★ README 登记了 ⑧ 的**实机回归位探针**（只写机制不写判据，后人重放时无从验）',
    rdm3.includes('probe-ro-noise.mjs'))
  check('★ README 记了 ⑧ 的机制与「判据不看告警计数」的口径（计数受 GC 时机影响，会自然归零而看着像好了）',
    rdm3.includes('留存引用') && rdm3.includes('已不可渲染'))
}

console.log(`\n${pass ? '全部通过' : '存在失败项'}`)
process.exit(pass ? 0 : 1)
