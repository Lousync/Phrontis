// 契约验证：书架升级全格式阅读器一期（bookshelf-reader-upgrade-design §S7）。
//
// 覆盖十组断言：
//   ① bookFormats 纯函数用例（扩展名识别 / 展示名 / 常量↔函数一致性）
//   ② readerStateSchema 纯函数用例（键归一 / patch 白名单 / 修补）
//   ③ 负向：readerState.json 单写方（只允许出现在 readerStateVaultRepo.ts）
//   ④ 负向：knowledgeIndex.ts 剥注释后不得出现 .pdf 字面量（过滤一律走 bookKindOf）
//   ⑤ IPC 三处同步：readerState:get/patch 在 preload / types / ipc.ts 均有声明
//   ⑥ DataChangeScope 双侧含 'readerState'
//   ⑦ Tab 集合纪律：WORKBENCH_PANEL_TAB_IDS 仍 2 项且不含 reading；RIGHT_PANEL_TAB_IDS_ALL 含
//     reading；parseWorkbenchLayout 接受 'reading'、坏值回落 'widgets'
//   ⑧ 关标签清阅读态：App.tsx closeTab 函数体内存在 setBookshelfReading(null)
//   ⑨ decodeText 用例表（UTF-8 无 BOM / 带 BOM / GB18030，hex 内联样本）
//   ⑩ TabName 仍 16 项（与 verify-pdf-reader 同口径的冻结断言）
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/pdf-reader/verify-reader-formats.mjs
// 期望：全部 ok + exit=0

import { stripComments } from '../shared/strip-comments.mjs'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

// ===== ① bookFormats 纯函数用例 =====
console.log('\n--- ① bookFormats：扩展名唯一真相源 ---')
const F = await import('../../../electron/lib/kbStore/bookFormats.ts')
check('bookKindOf：txt 大写扩展名', F.bookKindOf('a/b/C.TXT') === 'txt')
check('bookKindOf：pdf', F.bookKindOf('books/x.pdf') === 'pdf')
check('bookKindOf：多重点仍按末段', F.bookKindOf('a.pdf.txt') === 'txt')
check('bookKindOf：未收录返回 null', F.bookKindOf('a.md') === null)
check('bookKindOf：空串返回 null', F.bookKindOf('') === null)
check('bookDisplayName：去 txt 后缀', F.bookDisplayName('x/呐喊.txt') === '呐喊')
check('bookDisplayName：去 pdf 后缀', F.bookDisplayName('x/算法.pdf') === '算法')
check('bookDisplayName：非书文件原样返回', F.bookDisplayName('x/note.md') === 'note.md')
check('BOOK_EXTS 每项都能被 bookKindOf 识别（常量↔函数一致）',
  F.BOOK_EXTS.every((ext) => F.bookKindOf(`x${ext}`) !== null))
check('BOOK_EXTS = pdf + txt + epub + fb2 + fbz + cbz 六项',
  F.BOOK_EXTS.length === 6
  && ['.pdf', '.txt', '.epub', '.fb2', '.fbz', '.cbz'].every((e) => F.BOOK_EXTS.includes(e)))
// ★ 这条断言在 B 段（2026-09-21）由「= 两项」放宽成三项、阶段 2a（2026-09-22）放宽成五项、
//   阶段 2b（2026-09-22）再放宽成六项 —— 加格式本就该改这里，勿当 drift 回滚。
//   加第七种格式时改成本行 + bookFormats 三张表 + src/types 的 BookKind 镜像
//   + 两个 schema 的 BOOK_KINDS，并把新格式补进上面「每项都能识别」。
check('bookKindOf：epub 识别且大小写不敏感', F.bookKindOf('x/三体.EPUB') === 'epub')
check('bookKindOf：epub 不会被误判成 txt', F.bookKindOf('a/b.epub') === 'epub')
// ★ 阶段 2a：fb2 / fbz 与 epub 同引擎，最怕的是「落到 kind 三元里被当 txt」
check('bookKindOf：fb2 识别且大小写不敏感', F.bookKindOf('x/三体.FB2') === 'fb2')
check('bookKindOf：fbz 识别', F.bookKindOf('a/b.fbz') === 'fbz')
check('bookKindOf：fb2 / fbz 不会被误判成 txt', F.bookKindOf('a/b.fb2') === 'fb2' && F.bookKindOf('a/b.fbz') === 'fbz')
check('bookDisplayName：去 fb2 / fbz 后缀',
  F.bookDisplayName('x/三体.fb2') === '三体' && F.bookDisplayName('x/三体.fbz') === '三体')
check('bookEngineOf：pdf → pdf', F.bookEngineOf('x.pdf') === 'pdf')
check('bookEngineOf：txt → txt', F.bookEngineOf('x.txt') === 'txt')
check('bookEngineOf：epub → foliate（vendored 引擎）', F.bookEngineOf('x.epub') === 'foliate')
check('bookEngineOf：fb2 / fbz → foliate（同引擎，故阅读器与左栏零改动复用）',
  F.bookEngineOf('x.fb2') === 'foliate' && F.bookEngineOf('x.fbz') === 'foliate')
// ★ 阶段 2b：cbz（zip 封装的图片漫画）。三条都是「错一个字就静默坏」的地方：
//   kind 落错 → 左栏拿不到页表；engine 落错 → 书架挂错阅读器；MIME 落错 → foliate
//   `view.js:14` 的 isCBZ 认不出来（它按 name 或 type 判，不看魔数）。
check('bookKindOf：cbz 识别且大小写不敏感', F.bookKindOf('x/画集.CBZ') === 'cbz')
check('bookKindOf：cbz 不会被误判成 fbz / txt', F.bookKindOf('a/b.cbz') === 'cbz' && F.bookKindOf('a/b.fbz') === 'fbz')
check('bookEngineOf：cbz → foliate', F.bookEngineOf('x.cbz') === 'foliate')
check('bookMimeOf：cbz → application/vnd.comicbook+zip（与 foliate view.js:14 逐字一致）',
  F.bookMimeOf('x.cbz') === 'application/vnd.comicbook+zip')
check('bookDisplayName：去 cbz 后缀', F.bookDisplayName('x/画集.cbz') === '画集')
check('bookEngineOf：裸扩展名（带点）也认', F.bookEngineOf('.epub') === 'foliate')
check('bookEngineOf：未收录返回 null', F.bookEngineOf('x.md') === null)
check('bookDisplayName：去 epub 后缀', F.bookDisplayName('x/三体.epub') === '三体')
// ★ MIME 必须与扩展名同源：foliate 的 makeBook 按 File 的 name/type 分派（不看魔数），
//   渲染层自拼就会重演「所有书都叫 .epub」→ 裸 fb2 当场 UnsupportedTypeError。
check('bookMimeOf：六种格式各有一份 MIME', F.BOOK_EXTS.every((ext) => !!F.bookMimeOf(`x${ext}`)))
check('bookMimeOf：fb2 → application/x-fictionbook+xml', F.bookMimeOf('x.fb2') === 'application/x-fictionbook+xml')
check('bookMimeOf：fbz → application/x-zip-compressed-fb2', F.bookMimeOf('x.fbz') === 'application/x-zip-compressed-fb2')
check('bookMimeOf：未收录返回 null', F.bookMimeOf('x.md') === null)
check('bookExtOf：回带点小写扩展名（File 名拼接用）',
  F.bookExtOf('x/三体.FB2') === '.fb2' && F.bookExtOf('x.md') === null)

// bookExtFromMime（书市 S2 加：OPDS 的下载直链**未必以扩展名结尾**，见 bookFormats 头注）
check('bookExtFromMime：六种格式的 MIME 都反查得回自己',
  F.BOOK_EXTS.every((ext) => F.bookExtFromMime(F.bookMimeOf(`x${ext}`)) === ext))
check('bookExtFromMime：去参数 / 大小写 / 空白容错',
  F.bookExtFromMime('  Application/EPUB+Zip; charset=binary ') === '.epub')
check('★ bookExtFromMime：mobi / kepub / xhtml 不在表里 → null（书卡据此标「暂不支持」）',
  F.bookExtFromMime('application/x-mobipocket-ebook') === null &&
  F.bookExtFromMime('application/kepub+zip') === null &&
  F.bookExtFromMime('application/xhtml+xml') === null)
check('bookExtFromMime：空 / 非串 → null', F.bookExtFromMime('') === null && F.bookExtFromMime(null) === null)
// ★★ 这条锁的是真实陷阱：Project Gutenberg 的 EPUB 直链是 `…/55047.epub.noimages`，
//    末尾是 `.noimages` 不是 `.epub` ⇒ bookExtOf 恒 null，只有 link 上的 MIME 能救。
check('★ bookExtOf 对 Gutenberg 真直链返回 null，bookExtFromMime 救回来',
  F.bookExtOf('https://www.gutenberg.org/ebooks/55047.epub.noimages') === null &&
  F.bookExtFromMime('application/epub+zip') === '.epub')

// ===== ② readerStateSchema 纯函数用例 =====
console.log('\n--- ② readerStateSchema：键归一 / patch 白名单 / 修补 ---')
const S = await import('../../../electron/lib/kbStore/readerStateSchema.ts')
check('键归一：基础', S.readerKey('r1', 'books/a.txt') === 'r1/books/a.txt')
check('键归一：反斜杠 → posix', S.readerKey('r1', 'books\\a.txt') === 'r1/books/a.txt')
check('键归一：去 ./ 前缀', S.readerKey('r1', './a.txt') === 'r1/a.txt')
check('键归一：空 rootId 拒绝', S.readerKey('', 'a.txt') === '')
check('键归一：绝对 relPath 拒绝', S.readerKey('r1', '/a.txt') === '')
check('键反解：relPath 可含子目录', S.readerKeyRel('r1/books/a.txt') === 'books/a.txt')
check('patch：pct=50 收', (() => { const r = S.sanitizeReaderPatch({ pct: 50 }); return !!r && r.pct === 50 })())
check('patch：pct=1.5 拒（非整数）', S.sanitizeReaderPatch({ pct: 1.5 }) === null)
check('patch：pct=101 拒（越界）', S.sanitizeReaderPatch({ pct: 101 }) === null)
check('patch：pct=-1 拒（越界）', S.sanitizeReaderPatch({ pct: -1 }) === null)
check('patch：pct 字符串拒', S.sanitizeReaderPatch({ pct: '50' }) === null)
check('patch：空 patch 拒', S.sanitizeReaderPatch({}) === null)
check('patch：非对象拒', S.sanitizeReaderPatch('x') === null)
check('patch：updatedAt 不在白名单', S.sanitizeReaderPatch({ updatedAt: 'x' }) === null)
const coerced = S.coerceReaderState({ kind: 'bogus', pct: 250, updatedAt: 'KEEP' }, 'NOW')
check('修补：坏 kind 回落 txt', coerced.kind === 'txt')
check('修补：越界 pct 夹取到 100', coerced.pct === 100)
check('修补：合法 updatedAt 保留', coerced.updatedAt === 'KEEP')
const coerced2 = S.coerceReaderState({ kind: 'pdf', pct: 42 }, 'NOW')
check('修补：合法 kind pdf 保留', coerced2.kind === 'pdf')

// ===== ③ 负向：readerState.json 单写方 =====
console.log('\n--- ③ 负向：readerState.json 唯一写方 ---')
{
  const offenders = []
  const walk = (dir) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx|mjs)$/.test(e.name)) {
        const src = readFileSync(p, 'utf8')
        if (stripComments(src).includes('readerState.json') && !p.replaceAll('\\', '/').endsWith('electron/lib/kbStore/readerStateVaultRepo.ts')) offenders.push(p)
      }
    }
  }
  walk(join(ROOT, 'electron'))
  walk(join(ROOT, 'src'))
  check('readerState.json 只出现在 readerStateVaultRepo.ts', offenders.length === 0, offenders.join(', '))
}

// ===== ④ 负向：knowledgeIndex 不再有 .pdf 字面量 =====
console.log('\n--- ④ 负向：扫描过滤唯一走 bookKindOf ---')
{
  const stripped = stripComments(read('electron/lib/kbStore/knowledgeIndex.ts'))
  check('knowledgeIndex.ts 剥注释后不含 .pdf 字面量', !stripped.includes(".pdf"), '过滤一律走 bookKindOf')
  check('knowledgeIndex.ts 已 import bookKindOf', stripped.includes('bookKindOf'))
  check('scanVaultBooks 存在（scanVaultPdfs 已更名）', stripped.includes('function scanVaultBooks'))
}

// ===== ⑤ IPC 三处同步 =====
console.log('\n--- ⑤ IPC 三处同步：preload / types / ipc.ts ---')
{
  const preload = stripComments(read('electron/preload/index.ts'))
  const types = stripComments(read('src/types/index.ts'))
  const ipc = stripComments(read('src/lib/ipc.ts'))
  for (const ch of ['readerState:get', 'readerState:patch']) {
    check(`preload 桥含 ${ch}`, preload.includes(`'${ch}'`))
  }
  check('types 声明 readerStateGet', types.includes('readerStateGet:'))
  check('types 声明 readerStatePatch', types.includes('readerStatePatch:'))
  check('types 声明 ReaderBookState', types.includes('interface ReaderBookState'))
  check('ipc.ts 封装 readerStateGet', ipc.includes('export const readerStateGet'))
  check('ipc.ts 封装 readerStatePatch', ipc.includes('export const readerStatePatch'))
}

// ===== ⑥ DataChangeScope 双侧 =====
console.log('\n--- ⑥ DataChangeScope 双侧含 readerState ---')
{
  const scopeSrc = stripComments(read('src/lib/dataChanged.ts'))
  check("渲染层 union 含 'readerState'", scopeSrc.includes("'readerState'"))
  const repoSrc = stripComments(read('electron/database/repositories/readerStateRepo.ts'))
  check("主进程 broadcastDataChanged('readerState')", repoSrc.includes("broadcastDataChanged('readerState')"))
}

// ===== ⑦ Tab 集合纪律 =====
console.log('\n--- ⑦ Tab 集合纪律：双集合刻意不同 ---')
{
  const L = await import('../../../src/lib/workbenchLayout.ts')
  check('WORKBENCH_PANEL_TAB_IDS 仍 2 项（widgets/ai）', L.WORKBENCH_PANEL_TAB_IDS.length === 2 && !L.WORKBENCH_PANEL_TAB_IDS.includes('reading'))
  check('RIGHT_PANEL_TAB_IDS_ALL 含 reading', L.RIGHT_PANEL_TAB_IDS_ALL.includes('reading'))
  const parsed = L.parseWorkbenchLayout(JSON.stringify({ rightTab: 'reading' }))
  check("parseWorkbenchLayout 接受 'reading'", parsed.rightTab === 'reading')
  const fallback = L.parseWorkbenchLayout(JSON.stringify({ rightTab: 'bogus' }))
  check("parseWorkbenchLayout 坏值回落 'widgets'", fallback.rightTab === 'widgets')
  const panel = stripComments(read('src/components/workbench/WorkbenchRightPanel.tsx'))
  check('rightTab===reading 关书回落表达式在位', panel.includes("layout.rightTab === 'reading'") && panel.includes('visiblePanelTabs[0]'))
}

// ===== ⑧ 关标签清阅读态 =====
console.log('\n--- ⑧ closeTab 清阅读态（书架标签删除 → 阅读入口消失） ---')
{
  const app = stripComments(read('src/App.tsx'))
  const i = app.indexOf('const closeTab = useCallback')
  const body = i >= 0 ? app.slice(i, i + 600) : ''
  check('closeTab 函数体内存在 setBookshelfReading(null)', body.includes('setBookshelfReading(null)'))
}

// ===== ⑨ decodeText 用例表 =====
console.log('\n--- ⑨ decodeText：编码探测（hex 内联样本） ---')
{
  const { decodeText } = await import('../../../src/lib/textDecode.ts')
  const utf8 = Buffer.from('第一行\n第二段正文。', 'utf8')
  check('UTF-8 无 BOM', decodeText(new Uint8Array(utf8)) === '第一行\n第二段正文。')
  const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8])
  check('UTF-8 带 BOM（去 BOM 解码）', decodeText(new Uint8Array(utf8Bom)) === '第一行\n第二段正文。')
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文阅读', 'utf16le')])
  check('UTF-16LE BOM', decodeText(new Uint8Array(utf16le)) === '中文阅读')
  // GB18030 样本：中文阅读（GBK 区 D6D0 CEC4 D4C4 B6C1；Buffer 不支持该编码名，内联 hex）
  const gb = Buffer.from('D6D0CEC4D4C4B6C1', 'hex')
  check('GB18030 兜底', decodeText(new Uint8Array(gb)) === '中文阅读')
}

// ===== ⑩ TabName 冻结 =====
console.log('\n--- ⑩ TabName 冻结（仍 16 项） ---')
{
  const appModulesSrc = stripComments(read('src/lib/appModules.ts'))
  const moduleBlock = appModulesSrc.slice(appModulesSrc.indexOf('export const APP_MODULES'), appModulesSrc.indexOf('as const satisfies'))
  const ids = [...moduleBlock.matchAll(/id:\s*'([A-Za-z]+)'/g)].map((m) => m[1])
  check('APP_MODULES 仍为 15 项（编辑器退役后冻结，新增即 FAIL）', ids.length === 15, `实得 ${ids.length}: ${ids.join(',')}`)
}

// ===== ⑪ 扫描版探测（轻量方案） =====
console.log('\n--- ⑪ detectScanMode：抽样字数 → full/partial/no ---')
{
  const D = await import('../../../electron/lib/kbStore/scanDetect.ts')
  check('空样本 → full（无样本不定罪）', D.detectScanMode([]) === 'full')
  check('全部 texty → full', D.detectScanMode([300, 420, 260, 380, 510]) === 'full')
  check('全零 → no（纯扫描）', D.detectScanMode([0, 0, 0, 0]) === 'no')
  check('零星字符（<20）也算无文本 → no', D.detectScanMode([5, 12, 3, 8]) === 'no')
  check('混合 → partial', D.detectScanMode([500, 0, 600, 0, 0, 400]) === 'partial')
  check('阈值：恰 20 字符算 texty', D.detectScanMode([20]) === 'full')
  check('阈值：19 字符不算 texty', D.detectScanMode([19]) === 'no')
  check('SCAN_MODES 与 schema 白名单一致', D.SCAN_MODES.join(',') === 'full,partial,no')
  const S2 = await import('../../../electron/lib/kbStore/pdfReaderSchema.ts')
  check('patch：scan= 合法收', (() => { const r = S2.sanitizeBookPatch({ scan: 'no' }); return !!r && r.scan === 'no' })())
  check('patch：scan 非法值拒', S2.sanitizeBookPatch({ scan: 'unknown' }) === null)
  const c = S2.coerceBookState({ lastPage: 2, scan: 'partial' }, 'NOW')
  check('修补：合法 scan 保留', c.scan === 'partial')
  const c2 = S2.coerceBookState({ lastPage: 2, scan: 'bogus' }, 'NOW')
  check('修补：坏 scan 回落缺省（undefined = full）', c2.scan === undefined)
}

// ===== ⑫ A1/A5 拆分函数：detectEncoding / decodeWith / resolveScanPages =====
console.log('\n--- ⑫ detectEncoding / decodeWith / resolveScanPages ---')
{
  const { detectEncoding, decodeWith } = await import('../../../src/lib/textDecode.ts')
  check('detectEncoding：UTF-8 BOM → utf8-bom', detectEncoding(new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi', 'utf8')]))) === 'utf8-bom')
  check('detectEncoding：UTF-16LE BOM → utf16le', detectEncoding(new Uint8Array(Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))) === 'utf16le')
  check('detectEncoding：UTF-16BE BOM → utf16be', detectEncoding(new Uint8Array(Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]))) === 'utf16be')
  check('detectEncoding：无 BOM 合法 UTF-8 → utf8', detectEncoding(new Uint8Array(Buffer.from('中文阅读', 'utf8'))) === 'utf8')
  check('detectEncoding：无 BOM GB18030 样本 → gb18030', detectEncoding(new Uint8Array(Buffer.from('D6D0CEC4D4C4B6C1', 'hex'))) === 'gb18030')
  const utf8 = new Uint8Array(Buffer.from('第一行\n第二段正文。', 'utf8'))
  check('decodeWith 复用 decodeText（无 BOM UTF-8）', decodeWith(utf8, detectEncoding(utf8)) === '第一行\n第二段正文。')
  const gb = new Uint8Array(Buffer.from('D6D0CEC4D4C4B6C1', 'hex'))
  check('decodeWith 复用 decodeText（GB18030）', decodeWith(gb, detectEncoding(gb)) === '中文阅读')
  const D = await import('../../../electron/lib/kbStore/scanDetect.ts')
  check('resolveScanPages：[t,f,t] → [f,t,f]', JSON.stringify(D.resolveScanPages([true, false, true])) === '[false,true,false]')
  check('resolveScanPages：空 → 空', JSON.stringify(D.resolveScanPages([])) === '[]')
  check('resolveScanPages：[f,f] → [t,t]', JSON.stringify(D.resolveScanPages([false, false])) === '[true,true]')
}

console.log(`\n${pass ? '全部通过' : '存在失败项'}`)
process.exit(pass ? 0 : 1)
