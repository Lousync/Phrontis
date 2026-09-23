// 契约验证：书架升级全格式阅读器一期（bookshelf-reader-upgrade-design §S7）。
//
// 覆盖十五组断言：
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
//   ⑪ 扫描版探测（detectScanMode / resolveScanPages）
//   ⑫ A1/A5 拆分函数（detectEncoding / decodeWith / resolveScanPages）
//   ⑬ 书签：定位键按 kind 分支 / 空数组可写 / 上限整单拒 + 两个写方共用常量（2026-09-22）
//   ⑭ 大书体积分档（三档边界含端点 / 文案同口径）+ 读取链路镜像（字节通道 / 预分配 / core 唯一 / IPC 三处）
//   ⑮ B-24：PDFViewer 内部 ResizeObserver 的捕获窗口与断开（withRoCapture / detachViewerDocument 第二参 / 两处调用点）
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
// B-15（2026-09-22）：页名 / 映射键必须用**身份名**（带扩展名）；展示名只给人看。
check('bookIdentityName：保留扩展名', F.bookIdentityName('x/呐喊.fb2') === '呐喊.fb2' && F.bookIdentityName('x/画集.CBZ') === '画集.CBZ')
check('bookIdentityName：只取 basename', F.bookIdentityName('a/b/呐喊.epub') === '呐喊.epub')
check('bookIdentityName：非书文件原样 / 空串兜底不炸', F.bookIdentityName('x/note.md') === 'note.md' && F.bookIdentityName('') === '(未命名)')
check('★ B-15 立论：同名三格式的展示名相同、身份名互不相同',
  new Set(['a.epub', 'a.fb2', 'a.cbz'].map((f) => F.bookDisplayName(`x/${f}`))).size === 1
  && new Set(['a.epub', 'a.fb2', 'a.cbz'].map((f) => F.bookIdentityName(`x/${f}`))).size === 3)
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
  // 2026-09-22 书市 S4：15 → 16（+bookMarket）。有意变更（方案 §1.2 第 5 条），与上面「仍 16 项」的小节标题对齐。
  check('APP_MODULES 仍为 16 项（新增模块必须显式改这里，防清单悄悄飘）', ids.length === 16, `实得 ${ids.length}: ${ids.join(',')}`)
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

// ===== ⑬ 书签：定位键按 kind 分支 / 上限 / 存量兼容（2026-09-22）=====
// 本组锁四件事：
//   1) 定位键**按 kind 分支**（txt 要 paraIndex、foliate 系要 cfi），不是"有哪个字段就用哪个"；
//      pdf / cbz / 未收录扩展名一律显式拒绝 —— 静默收下一条无定位的书签比报错更坏。
//   2) 空数组必须合法（删掉最后一条书签就是写 `[]`；拒了 = "删了但关书又回来"）。
//   3) 上限是**整单拒绝**（不是截断），且渲染层两个写方必须用同一个常量提前拦 ——
//      schema 拒 + patchReader 静默失败 = "书签加上又消失"，本组用源码级断言把这条锁住。
//   4) 存量兼容：老仓库里 txt 形条目在 txt 书里照旧可读；串到 epub 书里则被丢（不炸）。
console.log('\n--- ⑬ 书签：kind 分行定位键 / 上限 / 存量兼容 ---')
{
  const CFI = 'epubcfi(/6/2!/4/2/4,/1:0,/1:24)'
  const mk = (o) => ({ id: 'b1', label: '书签一', at: 'T', ...o })
  const patchOf = (list, kind) => S.sanitizeReaderPatch({ bookmarks: list }, kind)

  for (const k of S.FOLIATE_KINDS) {
    const r = patchOf([mk({ cfi: CFI, chapter: ' 第一章 ' })], k)
    check(`书签：${k} 带 cfi 收（定位键 = CFI）`, !!r && r.bookmarks.length === 1 && r.bookmarks[0].cfi === CFI)
    check(`书签：${k} 的 chapter 去空白保留`, r?.bookmarks[0].chapter === '第一章')
    check(`书签：${k} 无 cfi 拒`, patchOf([mk({})], k) === null)
    check(`书签：${k} 只带 paraIndex 拒（不按"哪个字段有值"挑）`, patchOf([mk({ paraIndex: 3 })], k) === null)
    // 未列入 FOLIATE_KINDS 的 kind 走不到 cfi 分支 ⇒ 这条即"新格式忘了进 FOLIATE_KINDS"的探针
    check(`书签：${k} 的 cfi 超长 2001 字符拒`, patchOf([mk({ cfi: 'e'.repeat(2001) })], k) === null)
    check(`书签：${k} 的 cfi 含控制字符拒`, patchOf([mk({ cfi: 'epubcfi(/6/2!)\u0000' })], k) === null)
  }
  check('书签：cfi 空串拒（假 CFI 比没书签更坏——点了不动还没报错）', patchOf([mk({ cfi: '' })], 'epub') === null)

  check('书签：txt 带 paraIndex 收', (() => { const r = patchOf([mk({ paraIndex: 7 })], 'txt'); return !!r && r.bookmarks[0].paraIndex === 7 })())
  check('书签：txt 负 paraIndex 拒', patchOf([mk({ paraIndex: -1 })], 'txt') === null)
  check('书签：txt 非整数 paraIndex 拒', patchOf([mk({ paraIndex: 1.5 })], 'txt') === null)
  check('书签：txt 只带 cfi 拒（cfi 是 foliate 系的口径）', patchOf([mk({ cfi: CFI })], 'txt') === null)
  check('书签：txt 的 start/end 可省', (() => { const r = patchOf([mk({ paraIndex: 7, start: 3, end: 9 })], 'txt'); return r?.bookmarks[0].start === 3 && r?.bookmarks[0].end === 9 })())

  for (const k of ['pdf', 'cbz']) {
    check(`书签：${k} 一律拒（定位口径不在 readerState.json）`,
      patchOf([mk({ cfi: CFI })], k) === null && patchOf([mk({ paraIndex: 1 })], k) === null)
  }
  check('书签：kind 未知（未收录扩展名）按 txt 口径 —— paraIndex 形收',
    (() => { const r = patchOf([mk({ paraIndex: 2 })]); return !!r && r.bookmarks[0].paraIndex === 2 })())
  check('书签：kind 未知时 cfi 形仍拒（兜底不新格式开口子）', patchOf([mk({ cfi: CFI })]) === null)

  check('书签：空数组收（删掉最后一条要能落盘）', (() => { const r = patchOf([], 'epub'); return !!r && Array.isArray(r.bookmarks) && r.bookmarks.length === 0 })())
  check('书签：非数组拒', patchOf('x', 'epub') === null)
  const num = (n) => Array.from({ length: n }, (_, i) => mk({ id: `b${i}`, paraIndex: i }))
  check(`书签：${S.MAX_BOOKMARKS} 条收（正好在上限）`, (() => { const r = patchOf(num(S.MAX_BOOKMARKS), 'txt'); return r?.bookmarks.length === S.MAX_BOOKMARKS })())
  check(`书签：${S.MAX_BOOKMARKS + 1} 条**整单**拒（截断会让用户以为加上了）`, patchOf(num(S.MAX_BOOKMARKS + 1), 'txt') === null)
  check('书签：一条坏就整单拒（不静默丢那一条）', patchOf([mk({ paraIndex: 1 }), mk({ cfi: CFI })], 'txt') === null)

  const leg = S.coerceReaderState({ kind: 'txt', pct: 1, bookmarks: [{ id: 'x', paraIndex: 7, label: '老书签', at: 'T' }] }, 'NOW', 'txt')
  check('修补：历史 txt 书签（无 cfi）仍保留', leg.bookmarks.length === 1 && leg.bookmarks[0].paraIndex === 7)
  const mixed = S.coerceReaderState({ kind: 'epub', pct: 1, bookmarks: [{ id: 'x', paraIndex: 7, label: 'txt 形', at: 'T' }, { id: 'y', cfi: CFI, label: 'cfi 形', at: 'T' }] }, 'NOW', 'epub')
  check('修补：epub 书里混进的 txt 形条目被丢、cfi 形留下', mixed.bookmarks.length === 1 && mixed.bookmarks[0].id === 'y')
  check('修补：coerce 不传 kind 时 bookmarks 仍产出（默认空数组）', Array.isArray(S.coerceReaderState({ pct: 1 }, 'NOW').bookmarks))

  // 镜像一致性（源码级 —— 本文件不得值导入，故只能读文本比）
  const schemaSrc = read('electron/lib/kbStore/readerStateSchema.ts')
  const excerptSrc = read('electron/lib/kbStore/excerptSchema.ts')
  const cfiLen = (src) => /MAX_CFI_LEN\s*=\s*(\d+)/.exec(src)?.[1]
  check('镜像：MAX_CFI_LEN 与 excerptSchema 同值', !!cfiLen(schemaSrc) && cfiLen(schemaSrc) === cfiLen(excerptSrc), `${cfiLen(schemaSrc)} vs ${cfiLen(excerptSrc)}`)
  // ★ 这里断言的不是"相等"：**引擎 = foliate ⊋ 书签能用的 kind**。
  //   cbz 也走 foliate 引擎（固定版式），但整页是图片、无文字层 ⇒ 不收书签。
  //   故锁两条：(a) FOLIATE_KINDS 每项引擎都是 foliate；(b) 引擎侧多出来的**恰好只有 cbz** ——
  //   将来多一种 foliate 格式（或 cbz 突然能存书签）时这条会红，逼两处同时决策，而不是静默漏一个。
  const foliateEngineKinds = F.BOOK_EXTS.filter((e) => F.bookEngineOf(e) === 'foliate').map((e) => F.bookKindOf(`a${e}`))
  const badEngine = S.FOLIATE_KINDS.filter((k) => F.bookEngineOf(`a.${k}`) !== 'foliate')
  check('镜像：FOLIATE_KINDS 每项都是 foliate 引擎', badEngine.length === 0, badEngine.join(','))
  const rest = foliateEngineKinds.filter((k) => !S.FOLIATE_KINDS.includes(k))
  check('镜像：foliate 引擎里不收书签的**只有 cbz**（引擎 ⊋ 可存书签的 kind）',
    rest.slice().sort().join(',') === 'cbz', `foliate 引擎=[${foliateEngineKinds}] 非书签格式=[${rest}]`)
  // 上限的**写方**也必须在场：schema 拒 + patchReader 静默失败 = "书签加上又消失"
  const writers = ['src/components/shared/txt/TxtReaderView.tsx', 'src/components/shared/epub/EpubReaderView.tsx']
  const missGuard = writers.filter((p) => !stripComments(read(p)).includes('MAX_BOOKMARKS'))
  check('上限：两个书签写方都按 MAX_BOOKMARKS 提前拦（否则静默失败）', missGuard.length === 0, missGuard.join(', '))
}

// ===== ⑭ 大书体积分档 + 读取链路（B-16 · 2026-09-22）=====
// 本组锁四件事：
//   1) 三档边界（含端点）：≤128MB 静默 / 128–384MB 确认 / >384MB 拒绝 —— 端点写错一个数，
//      用户体感就是「刚过线的那本书没有问一句」或「刚好 384MB 的书打不开」。
//   2) 文案：体积必须与 `mbOf` 同口径（用户拿它跟资源管理器对得上），耗时 / 内存 / 上限 / 建议齐全。
//   3) 阈值与文案**只有一份**：渲染侧不得再出现 128/384 字面量（两份数就会漂）。
//   4) 读取链路的两条改造不许回退：渲染侧不再 base64 解码（无 `atob` / `b64ToU8`）、
//      整本读入必须是**预分配就地写入**（`new Uint8Array(total)` + `.set(`）而不是逐块拼接；
//      主进程两个通道（base64 / bytes）必须共用同一个 core（否则边界与白名单逻辑会分叉）。
//      运行时证据在 `probe-cbz-bigbook.mjs`（整本 FNV-1a 等值 + 分档端到端），此处锁源码形状。
console.log('\n--- ⑭ 大书体积分档 + 读取链路 ---')
{
  const G = await import('../../../electron/lib/kbStore/bookSizeGate.ts')
  const MB = 1048576
  // 边界含端点：128MB 静默、128MB+1 确认、384MB 确认、384MB+1 拒绝
  const cases = [[0, 'ok'], [1, 'ok'], [127 * MB, 'ok'], [128 * MB, 'ok'], [128 * MB + 1, 'confirm'],
    [256 * MB, 'confirm'], [384 * MB, 'confirm'], [384 * MB + 1, 'refuse'], [1024 * MB, 'refuse']]
  for (const [bytes, want] of cases) {
    check(`分档 ${bytes === 0 ? '0' : (bytes / MB).toFixed(0) + 'MB'}${bytes % MB === 1 ? '+1B' : ''} → ${want}`,
      G.bookSizeTier(bytes) === want, G.bookSizeTier(bytes))
  }
  // 异常输入不做输入校验（真出现说明 stat 上游已坏），但**不得**因此进确认/拒绝档
  check('非有限 / 负数按「可开」处理（不拿文案当输入校验）', G.bookSizeTier(NaN) === 'ok' && G.bookSizeTier(-1) === 'ok')
  check('常量口径：静默 128MB / 硬上限 384MB', G.BOOK_SILENT_MAX === 128 * MB && G.BOOK_HARD_MAX === 384 * MB)
  // mbOf：向上取整、最小 1（1.2MB 报 2MB，不能让 0.4MB 显示成 0MB）
  check('mbOf 向上取整', G.mbOf(1.2 * MB) === 2 && G.mbOf(128 * MB) === 128, `${G.mbOf(1.2 * MB)}`)
  check('mbOf 最小 1（不出现 0 MB）', G.mbOf(1) === 1 && G.mbOf(0) === 1)
  // 文案：体积同口径 + 三样信息齐全
  const c130 = G.bigBookConfirmText('超大样书', 136854400)
  check('确认文案含体积（与 mbOf 同口径）', c130.includes(`共 ${G.mbOf(136854400)} MB`), c130)
  check('确认文案含耗时（秒）与内存预估', /约\s*\d+\s*秒/.test(c130) && c130.includes('内存'), c130)
  check('确认文案说清「整本读进内存」这件事（用户要知道为什么慢）', c130.includes('整本读进内存') && c130.includes('无响应'), c130)
  check('书名空 / 空白时回落中性称呼，不出现《》空壳', G.bigBookConfirmText('  ', 2 * MB).includes('《这本电子书》'))
  const t500 = G.tooBigText(500 * MB)
  check('拒绝文案含体积 + 上限 + 建议', t500.includes('500 MB') && t500.includes('384 MB') && t500.includes('建议'), t500)
  const d130 = G.bigBookDeclinedText('超大样书', 136854400)
  check('取消文案点明下一步（「仍要打开」就在下面）', d130.includes('已取消打开') && d130.includes('仍要打开'), d130)
  // 耗时 / 内存估值必须与常量同源（改常量不改文案 = 用户在读旧数字）
  check('耗时估值 = mbOf / READ_EST_MBPS（向上取整 ≥1s）',
    G.estReadSeconds(130 * MB) === Math.max(1, Math.ceil(G.mbOf(130 * MB) / G.READ_EST_MBPS)), `${G.estReadSeconds(130 * MB)}s`)
  check('内存估值 = mbOf × PEAK_MEM_RATIO（<1GB 报 MB）',
    G.estPeakMemText(130 * MB) === `${G.mbOf(130 * MB) * G.PEAK_MEM_RATIO} MB`, G.estPeakMemText(130 * MB))
  check('内存估值 ≥1GB 时换 GB 口径', G.estPeakMemText(2048 * MB).endsWith('GB'), G.estPeakMemText(2048 * MB))

  // ★ 阈值只有一份：渲染侧不得再写 128/384 字面量（判据是「除以 MB 的那个写法」而不是裸数字 ——
  //   128 这种数字在别处出现很正常，是 `128 * 1024 * 1024` 这种**阈值写法**才必须唯一）
  const reader = stripComments(read('src/components/shared/epub/EpubReaderView.tsx'))
  check('渲染侧 import 分档模块（阈值与文案唯一源）', /bookSizeGate/.test(reader) && /bookSizeTier\(/.test(reader))
  check('★ 渲染侧不再自带体积阈值（128/384 的 MB 写法只许出现在 bookSizeGate）',
    !/\b(128|384)\s*\*\s*1024\s*\*\s*1024\b/.test(reader), '见 EpubReaderView 的 MAX_BOOK_BYTES 前身')
  check('★ 闸门在整本读入**之前**（先读 1 字节拿 size 再决定）',
    /workspaceReadRangeBytes\([^)]*,\s*0,\s*1\s*\)/.test(reader))
  check('★ 确认框走应用级 showGlobalConfirm（禁原生 confirm）', /showGlobalConfirm\(/.test(reader) && !/\bwindow\.confirm\(/.test(reader))
  // 读取链路：字节通道 + 预分配就地写入
  check('★ 整本读入走字节通道（不再 base64）', /workspaceReadRangeBytes\(/.test(reader))
  check('★ 渲染侧不再 base64 解码（atob / b64ToU8 已删）', !/\batob\(/.test(reader) && !/b64ToU8/.test(reader))
  check('★ 预分配就地写入（new Uint8Array(total) + set）',
    /new Uint8Array\(total\)/.test(reader) && /\.set\(/.test(reader))
  check('★ 不再逐块拼接（无 [...chunks] / concat 式的 O(n²) 合并）', !/chunks\.push\(/.test(reader) && !/\bchunks\b\s*\.\s*reduce\(/.test(reader))
  check('读取阶段有进度回调（onProgress → setReadPct）', /setReadPct\(/.test(reader) && /onProgress/.test(reader))
  // 主进程：两条通道共用一个 core（白名单 / 边界 / 越界逻辑只此一份）
  const wm = stripComments(read('electron/lib/workspaceManager.ts'))
  const coreCalls = wm.match(/readRangeBuffer\(/g) ?? []
  check('★ 主进程两个通道都转发同一个 readRangeBuffer（core 唯一）', coreCalls.length >= 3, `出现 ${coreCalls.length} 次（1 定义 + 2 转发）`)
  // 白名单在 **IPC handler** 层（`readRangeBuffer` 收的是已校验过的绝对路径 —— 它的注释就是这么写的），
  // 故判据是「两个 handler 各自都过了 requireInside」：漏一个就是新通道绕开 pathGuard 直读磁盘。
  const handlerBody = (channel) => {
    const i = wm.indexOf(`'${channel}'`)
    if (i < 0) return ''
    const j = wm.indexOf('ipcMain.handle(', i + 1)
    return wm.slice(i, j > -1 ? j : i + 900)
  }
  check('★ base64 通道 handler 过白名单', /requireInside\(/.test(handlerBody('ws:readRange')), 'ws:readRange')
  check('★ 字节通道 handler 存在且过白名单', /requireInside\(/.test(handlerBody('ws:readRangeBytes')), 'ws:readRangeBytes')
  // IPC 三处同步（preload / 渲染侧类型镜子 / ipc.ts 封装）—— 漏一处就是「类型门禁也拦不住的静默 undefined」
  const pre = read('electron/preload/index.ts')
  const types = read('src/types/index.ts')
  const ipc = read('src/lib/ipc.ts')
  check('IPC 三处同步：preload / types / ipc.ts 都有 workspaceReadRangeBytes',
    /workspaceReadRangeBytes/.test(pre) && /workspaceReadRangeBytes/.test(types) && /workspaceReadRangeBytes/.test(ipc))
  check('渲染侧类型镜子声明了 WorkspaceRangeBytesResult（bytes 是 Uint8Array）',
    /WorkspaceRangeBytesResult/.test(types) && /bytes:\s*Uint8Array/.test(types))
  // PDF 侧刻意不动：它读的是页片段（几 MB），base64 通道够用，改它是无收益的扩散
  const pdf = stripComments(read('src/components/shared/pdf/PdfReaderView.tsx'))
  check('PDF 侧仍用 base64 通道（本批刻意不动它）', /workspaceReadRange\(/.test(pdf) && !/workspaceReadRangeBytes\(/.test(pdf))
}

// ===== ⑮ B-24：PDFViewer 内部 ResizeObserver 的捕获与断开（2026-09-23）=====
// 防回归点：pdfjs 在 PDFViewer 构造器里自建 #resizeObserver 并 observe(container)，**永不 disconnect**
// （全文件无 destroy()）⇒ 每开一次 PDF 永久留一整套 viewer 图。修法是宿主侧捕获（不能全局换 RO）。
// 四条正向 + 三条负向，全部源码级；运行期判据在 probe-ro-noise.mjs。
{
  console.log('\n--- ⑮ B-24：PDFViewer 内部 RO 的捕获窗口与断开 ---')
  const kit = stripComments(read('src/components/shared/pdf/pdfViewerKit.ts'))
  const pdfRaw = read('src/components/shared/pdf/PdfReaderView.tsx')
  const pdfView = stripComments(pdfRaw)

  // 正向①：捕获工具存在，且是真·继承式包装（能 new 出真实例，不是空实现）
  check('pdfViewerKit 导出 withRoCapture', /export function withRoCapture/.test(kit))
  check('★ 捕获用继承包装（class extends Real）而非直接替换成假对象',
    /class\s+CapturingResizeObserver\s+extends\s+Real/.test(kit))
  check('★ 捕获后 try/finally 还原（异常路径也必须还原，否则全局污染）',
    /finally\s*{[\s\S]{0,80}g\.ResizeObserver\s*=\s*Real/.test(kit))
  check('withRoCapture 返回 { result, observers } 两件',
    /return\s*{\s*result:/.test(kit) && /observers:/.test(kit))

  // 负向①：**绝不能全局替换** —— 捕获必须在同步窗口内、且必须还原。
  //   判据：文件里对 `g.ResizeObserver = ` 的赋值恰好两处（换成捕获版 / 还原成 Real），
  //   多一处 = 有人在别处也动了它（那是全局替换，B-24 明令禁止）。
  const roAssign = kit.match(/g\.ResizeObserver\s*=/g) ?? []
  check('★ 负向：`g.ResizeObserver =` 全文恰 2 处（换捕获 + 还原），不是全局替换',
    roAssign.length === 2, `实际 ${roAssign.length} 处`)
  check('★ 负向：未在模块顶层（函数体之外）替换 globalThis.ResizeObserver',
    !/^\s*g\.ResizeObserver\s*=/m.test(kit.split('export function withRoCapture')[0] ?? ''),
    'withRoCapture 定义之前不得出现赋值')

  // 正向②：detachViewerDocument 的第二参存在且逐个 disconnect（保持可选 = 向后兼容）
  check('detachViewerDocument 第二参 observers 为可选',
    /export function detachViewerDocument\(viewer:\s*unknown,\s*observers\?:/.test(kit))
  check('★ detachViewerDocument 对 observers 逐个 disconnect',
    /for\s*\(const ro of observers\)/.test(kit) && /ro\.disconnect\(\)/.test(kit))
  check('★ 保留 setDocument(null)（清视图与断观察是两件事，不能互相替代）',
    /v\?\.setDocument\?\.\(null\)/.test(kit))
  // 负向②（B-24 收尾修正，2026-09-23）：顺序**必须**是「先断观察者、再 setDocument(null)」。
  //   ⚠ 旧契约把顺序写反了（曾要求 setDocument 在前）—— 而 pdfjs 3.11 的 setDocument(null)
  //   **会同步抛**（"Cannot read properties of null (reading 'destroy')"）：它在前时一次抛就把
  //   disconnect 整段跳过，上层 try/catch 又把异常吞掉 ⇒ 补偿静默失效、运行期一直漏。
  //   当时「契约全绿」正是被这条写反的断言锁住的。现按运行期实测事实改正（见 probe-ro-noise 切片）。
  check('★ 负向：detachViewerDocument 必须先断观察者、再 setDocument(null)（顺序不可颠倒）',
    kit.indexOf('for (const ro of observers)') > -1
    && kit.indexOf('for (const ro of observers)') < kit.indexOf('setDocument?.(null)'),
    '观察者断开必须在 setDocument 之前')
  check('★ setDocument(null) 单独 try/catch 包裹（视图清理失败不得连累观察者断开）',
    /try\s*{\s*v\?\.setDocument\?\.\(null\)\s*}\s*catch/.test(kit))

  // 正向③：宿主侧真的把构造包进了捕获窗口，且**只包 new PDFViewer 这一句**
  const wrapCall = /withRoCapture\(\(\)\s*=>\s*new kit\.PDFViewer\(/.test(pdfView)
  check('PdfReaderView 用 withRoCapture 包住 new kit.PDFViewer', wrapCall)
  // ★ 关键：捕获窗口必须**紧贴**构造表达式 —— 不得把别的 new 也卷进来（会误收别人的观察者）。
  //   判据：`withRoCapture(() =>` 与 `new kit.PDFViewer(` 之间只有空白。
  check('★ 捕获窗口紧贴构造表达式（withRoCapture(() => new kit.PDFViewer( 之间无其它语句）',
    /withRoCapture\(\(\)\s*=>\s*new kit\.PDFViewer\(/.test(pdfView))
  // 全文 `new kit.PDFViewer(` 恰 1 处 —— 多一处说明有未被捕获的第二条构造路径（会漏收 ⇒ 又漏一件图）
  const ctorCount = (pdfView.match(/new kit\.PDFViewer\(/g) ?? []).length
  check('★ 全文 `new kit.PDFViewer(` 恰 1 处（无绕过捕获窗口的第二条构造路径）',
    ctorCount === 1, `实际 ${ctorCount} 处`)

  // 正向④：observers 落到 ref，且**两个 detach 点都传了它**（早退 + 卸载；漏一个就漏一件图）
  check('PdfReaderView 有 viewerRoRef 承接 observers', /const viewerRoRef = useRef<ResizeObserver\[\]>\(\[\]\)/.test(pdfView))
  check('★ 构造后把 observers 存进 viewerRoRef', /viewerRoRef\.current = observers/.test(pdfView))
  const detachCalls = pdfView.match(/detachViewerDocument\([^)]*\)/g) ?? []
  check('★ detachViewerDocument 两处调用点都传了 observers（早退 + 卸载）',
    detachCalls.length === 2 && detachCalls.every((c) => /observers|viewerRoRef\.current/.test(c)),
    JSON.stringify(detachCalls))
  check('★ 负向：不存在只传 viewer 的裸调用（detachViewerDocument(x) 单参形式已绝迹）',
    !/detachViewerDocument\(\s*[A-Za-z_$][\w$]*\s*\)/.test(pdfView))
  // 卸载后清空 ref：避免同一实例被下次卸载重复 disconnect（虽幂等，但留下引用会拴住元素）
  check('卸载路径清空 viewerRoRef（不跨次残留引用）', /viewerRoRef\.current = \[\]/.test(pdfView))
}

console.log(`\n${pass ? '全部通过' : '存在失败项'}`)
process.exit(pass ? 0 : 1)
