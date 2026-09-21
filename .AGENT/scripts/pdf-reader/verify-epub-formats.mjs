// 契约验证：书架阅读器 B 段 · 电子书引擎（foliate vendored）与 CSP 例外。
//
// 覆盖八组断言：
//   ① CSP 例外**只开了该开的**，且 key 防线未被弱化（script-src 不含 'unsafe-inline'）
//   ② vendored foliate 关键文件齐全（缺文件 = 阅读器直接炸，且是运行时才炸）
//   ③ ★ sandbox 负向：所有 setAttribute('sandbox', …) 调用一律不含 allow-scripts
//   ④ ★ createURL patch 在位：内容文档走 blob:、子资源走 data:（丢了会让书内 CSS/图片全裂）
//   ⑤ 依赖与文档登记（polyfill 已入 deps、vendor README 未被删）
//   ⑥ ★ 格式真相源三处一致：bookFormats.BOOK_EXTS ↔ src/types 的 BookKind ↔ 两个 schema 的 BOOK_KINDS
//     （三处都是手工镜像，谁加格式漏改一处就是「kind 认不出 → 阅读器开错引擎」）
//   ⑦ locator 白名单（B 段新引入）＋ kind **仍不在**白名单（它是 relPath 的纯函数）
//   ⑧ ★ 负向：EPUB 相关组件不得把引擎拖进首屏静态闭包（BookCover 静态 PdfCover 是已修的历史违规）
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

console.log(`\n${pass ? '全部通过' : '存在失败项'}`)
process.exit(pass ? 0 : 1)
