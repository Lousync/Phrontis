// 契约验证：PDF 阅读体验整包（v3.4.0 第 2 项，方案 pdf-reader-v340-design §10）。
//
// 覆盖四类断言：
//   ① pdfReaderSchema 纯函数用例表（键归一 / patch 键白名单 / 越界拒绝 / 存量修补）——
//      直接 import 零依赖 .ts（node --experimental-strip-types），验的是真实实现不是复制品。
//   ② 负向断言：`.knowbase/modules/pdfReader.json` 的读写路径只允许出现在
//      pdfReaderVaultRepo.ts（唯一写方）；用共用剥注释器，防止注释里的说明文字假命中。
//   ③ DataChangeScope 双侧含 'pdfReader'（渲染层 union + 主进程 broadcastDataChanged 调用）。
//   ④ TabName 仍 16 项（APP_MODULES 行数）——防止后续批次顺手新增 TabName（方案 §0.2 冻结）。
//   ⑤ pdfLayout 纯函数用例（批次 3 落地后启用，本批次自动跳过）。
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/pdf-reader/verify-pdf-reader.mjs
// 期望：全部 ok + exit=0

import { stripComments } from '../shared/strip-comments.mjs'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}

// ===== ① pdfReaderSchema 纯函数用例 =====
console.log('\n--- ① pdfReaderSchema：键归一 / patch 白名单 / 存量修补 ---')
const S = await import('../../../electron/lib/kbStore/pdfReaderSchema.ts')

// 键归一：posix 化、去 ./、空值拒绝
check('键归一：基础', S.pdfBookKey('r1', 'books/a.pdf') === 'r1/books/a.pdf')
check('键归一：反斜杠 → posix', S.pdfBookKey('r1', 'books\\a.pdf') === 'r1/books/a.pdf')
check('键归一：去 ./ 前缀', S.pdfBookKey('r1', './books/a.pdf') === 'r1/books/a.pdf')
check('键归一：空 rootId 拒绝', S.pdfBookKey('', 'a.pdf') === '')
check('键归一：绝对 relPath 拒绝', S.pdfBookKey('r1', '/a.pdf') === '')
check('键反解：relPath 可含子目录', S.pdfKeyRel('r1/books/a.pdf') === 'books/a.pdf')

// patch 白名单：合法收、非法整单拒、updatedAt 永不可从外部注入
const good = S.sanitizeBookPatch({ lastPage: 12, mode: 'duo', zoom: 1.2 })
check('patch：合法字段全收', !!good && good.lastPage === 12 && good.mode === 'duo' && good.zoom === 1.2)
check('patch：updatedAt 不在白名单', S.sanitizeBookPatch({ updatedAt: 'x' }) === null)
check('patch：空 patch 拒绝', S.sanitizeBookPatch({}) === null)
check('patch：非对象拒绝', S.sanitizeBookPatch('scroll') === null)
check('patch：lastPage=0 拒绝', S.sanitizeBookPatch({ lastPage: 0 }) === null)
check('patch：lastPage=1.5 拒绝', S.sanitizeBookPatch({ lastPage: 1.5 }) === null)
check('patch：mode 越界拒绝', S.sanitizeBookPatch({ mode: 'vertical' }) === null)
check('patch：scrollRatio>1 拒绝', S.sanitizeBookPatch({ scrollRatio: 1.2 }) === null)
check('patch：zoom 越界拒绝', S.sanitizeBookPatch({ zoom: 9 }) === null)
check('patch：eyeCare 非布尔拒绝', S.sanitizeBookPatch({ eyeCare: 'yes' }) === null)
check('patch：totalPages 合法收', (() => { const r = S.sanitizeBookPatch({ totalPages: 446 }); return !!r && r.totalPages === 446 })())
check('patch：totalPages=0 拒绝（0 = 未登记语义，走默认而非 patch）', S.sanitizeBookPatch({ totalPages: 0 }) === null)
check('patch：书签坏页码拒绝', S.sanitizeBookPatch({ bookmarks: [{ page: 0, note: '', at: 'x' }] }) === null)
const bm = S.sanitizeBookPatch({ bookmarks: [{ page: 3, note: '重点', at: '2026-09-17T00:00:00Z' }] })
check('patch：合法书签收下', !!bm && Array.isArray(bm.bookmarks) && bm.bookmarks.length === 1 && bm.bookmarks[0].page === 3)

// 存量修补：缺键补默认、坏值回落、已知值保留
const coerced = S.coerceBookState({ lastPage: 5, mode: 'bogus', zoom: 99 }, 'NOW')
check('修补：坏 mode 回落 scroll', coerced.mode === 'scroll')
check('修补：越界 zoom 夹取到上限 5', coerced.zoom === 5)
check('修补：lastPage 保留', coerced.lastPage === 5)
check('修补：totalPages 缺键补 0（未知）', coerced.totalPages === 0)
check('修补：updatedAt 透传', coerced.updatedAt === 'NOW')
check('修补：非对象给全默认', S.coerceBookState(null, 'NOW').mode === 'scroll')
check('默认态：竖滚 + 适宽 + 无书签', (() => { const d = S.defaultBookState('NOW'); return d.mode === 'scroll' && d.zoom === 1 && d.bookmarks.length === 0 && d.totalPages === 0 })())

// ===== ② 负向断言：pdfReader.json 唯一写方 =====
console.log('\n--- ② 负向断言：pdfReader.json 唯一写方 ---')
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'out' || e.name === '.git' || e.name.startsWith('dist')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(p)
  }
  return out
}
const targets = [...walk(join(ROOT, 'electron')), ...walk(join(ROOT, 'src'))]
const offenders = []
for (const f of targets) {
  const src = stripComments(readFileSync(f, 'utf8'))
  if (src.includes('pdfReader.json') && !f.replace(/\\/g, '/').endsWith('electron/lib/kbStore/pdfReaderVaultRepo.ts')) {
    offenders.push(f.replace(ROOT, ''))
  }
}
check('pdfReader.json 只在 pdfReaderVaultRepo.ts 出现', offenders.length === 0, offenders.join(',') || `${targets.length} 个文件扫描通过`)

// ===== ③ DataChangeScope 双侧 =====
console.log('\n--- ③ DataChangeScope 双侧含 pdfReader ---')
const dataChangedSrc = stripComments(readFileSync(join(ROOT, 'src/lib/dataChanged.ts'), 'utf8'))
const scopeOk = /export type DataChangeScope\s*=[^;]*'pdfReader'/.test(dataChangedSrc)
check('渲染层 DataChangeScope union 含 pdfReader', scopeOk)
const repoSrc = stripComments(readFileSync(join(ROOT, 'electron/database/repositories/pdfReaderRepo.ts'), 'utf8'))
check('主进程写盘后 broadcastDataChanged(pdfReader)', repoSrc.includes("broadcastDataChanged('pdfReader')"))
const bookshelfSrc = stripComments(readFileSync(join(ROOT, 'src/modules/bookshelf/index.tsx'), 'utf8'))
check('书架挂 useDataChanged(pdfReader)（AI/导入改动界面自动刷新）', bookshelfSrc.includes("useDataChanged('pdfReader'"))
// 2026-09-17 拍板「书架内自渲染」：点书走模块内阅读器，不再借道编辑器
check('书架点书不再派发 kb-open-note（书架内自渲染）', !bookshelfSrc.includes('kb-open-note'))

// ===== ④ TabName 冻结 16 项 =====
console.log('\n--- ④ TabName 冻结 ---')
const appModulesSrc = stripComments(readFileSync(join(ROOT, 'src/lib/appModules.ts'), 'utf8'))
const moduleBlock = appModulesSrc.slice(appModulesSrc.indexOf('export const APP_MODULES'), appModulesSrc.indexOf('as const satisfies'))
const ids = [...moduleBlock.matchAll(/id:\s*'([A-Za-z]+)'/g)].map((m) => m[1])
// 2026-09-22 书市 S4：15 → 16（+bookMarket）。这是**有意变更**，不是漂移 —— 判据是
// appModules 里它 bar/tile/palette 全 true 且与工具箱/插件平级（方案 §1.2 第 5 条）。
check('APP_MODULES 仍为 16 项（新增模块必须显式改这里，防清单悄悄飘）', ids.length === 16, `实得 ${ids.length}: ${ids.join(',')}`)
check("bookshelf 仍为入口产生型（bar:false / tile:false / palette:false）", /id:\s*'bookshelf',\s*label:\s*'书架',\s*bar:\s*false,\s*tile:\s*false,\s*palette:\s*false/.test(moduleBlock))

// ===== ⑤ pdfLayout 纯函数（批次 3 落地后自动启用）=====
console.log('\n--- ⑤ pdfLayout 纯函数用例 ---')
let layoutPath = join(ROOT, 'src/lib/pdfLayout.ts')
if (statSync(layoutPath, { throwIfNoEntry: false })?.isFile?.()) {
  const L = await import('../../../src/lib/pdfLayout.ts')
  // 归一化：奇数原样、偶数退 1、第 1 页不动、0/负兜 1
  check('normalizeSpreadStart(1)=1', L.normalizeSpreadStart(1) === 1)
  check('normalizeSpreadStart(2)=1', L.normalizeSpreadStart(2) === 1)
  check('normalizeSpreadStart(7)=7', L.normalizeSpreadStart(7) === 7)
  check('normalizeSpreadStart(12)=11', L.normalizeSpreadStart(12) === 11)
  check('normalizeSpreadStart(0)=1（兜底）', L.normalizeSpreadStart(0) === 1)
  // 跨页：duo 起始页 → [p, p+1]，末页单页收尾
  check('spreadPages(1,10)=[1,2]', JSON.stringify(L.spreadPages(1, 10)) === '[1,2]')
  check('spreadPages(9,10)=[9,10]', JSON.stringify(L.spreadPages(9, 10)) === '[9,10]')
  check('spreadPages(9,9)=[9]（末页单收）', JSON.stringify(L.spreadPages(9, 9)) === '[9]')
  // 降级：容器 <1240px 双页自动降单页
  check('resolveDegrade(1239,duo)=single', L.resolveDegrade(1239, 'duo') === 'single')
  check('resolveDegrade(1240,duo)=duo', L.resolveDegrade(1240, 'duo') === 'duo')
  check('resolveDegrade(800,scroll)=scroll', L.resolveDegrade(800, 'scroll') === 'scroll')
  // 估高：按首页宽高比 × 容器宽
  check('estimatePageHeight(800,600,800)=600', L.estimatePageHeight(800, 600, 800) === 600)
  check('estimatePageHeight(600,900,600)=900', L.estimatePageHeight(600, 900, 600) === 900)
  check('estimatePageHeight 零宽兜底 ≥1', L.estimatePageHeight(0, 0, 800) >= 1)
} else {
  console.log('  skip  src/lib/pdfLayout.ts 未落地（批次 3 启用）')
}

// ===== ⑥ A5 页级降级：scanPages 白名单 + resolveScanPages =====
console.log('\n--- ⑥ A5 页级扫描白名单 / resolveScanPages ---')
{
  const good = S.sanitizeBookPatch({ scanPages: [false, true, false] })
  check('patch：scanPages 合法收', !!good && Array.isArray(good.scanPages) && good.scanPages.length === 3 && good.scanPages[1] === true)
  check('patch：scanPages 空数组收', (() => { const r = S.sanitizeBookPatch({ scanPages: [] }); return !!r && Array.isArray(r.scanPages) && r.scanPages.length === 0 })())
  check('patch：scanPages 含非布尔拒', S.sanitizeBookPatch({ scanPages: [true, 1] }) === null)
  check('patch：scanPages 超长（>2000）拒', S.sanitizeBookPatch({ scanPages: new Array(2001).fill(false) }) === null)
  check('patch：scanPages 非数组拒', S.sanitizeBookPatch({ scanPages: 'no' }) === null)
  const coerced = S.coerceBookState({ lastPage: 2, scanPages: [false, true] }, 'NOW')
  check('修补：合法 scanPages 保留', Array.isArray(coerced.scanPages) && coerced.scanPages[1] === true)
  const coerced2 = S.coerceBookState({ lastPage: 2, scanPages: ['x'] }, 'NOW')
  check('修补：坏 scanPages 回落缺省（undefined）', coerced2.scanPages === undefined)
  const SD = await import('../../../electron/lib/kbStore/scanDetect.ts')
  check('resolveScanPages：[t,f,t] → [f,t,f]', JSON.stringify(SD.resolveScanPages([true, false, true])) === '[false,true,false]')
  check('resolveScanPages：全文本页 → 全 false', JSON.stringify(SD.resolveScanPages([true, true])) === '[false,false]')
}

console.log(pass ? '\nPASS: pdf-reader 契约全部通过' : '\nFAIL: 存在失败断言')
process.exit(pass ? 0 : 1)
