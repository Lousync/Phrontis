// 契约验证：书市解析层 opdsParse.ts（方案 §三「解析」条、拍板 ①⑤⑥）。
//
// 头号理由：**解析器的判据全来自真抓的 feed**，不是想象的 OPDS。fixtures/ 下四份是真下载的：
//   gutenberg-search.xml   两级源的第一级：8 条 entry 全是 subsection 指针（含 2 条 Authors/Subjects 导航）
//   gutenberg-book.opds    两级源的第二级：真正的 acquisition 在这层
//   stdbooks-sherlock.xml  **单级**源：entry 直接带 5 条 acquisition/open-access
//   stdbooks-search.xml    零结果（`totalResults=0` **显式存在** —— 与「标签缺失」必须区分开）
//
// 覆盖：
//   ① 真实 feed 的两级 / 单级两种形状都吃（拍板 ⑥：两种都必须吃）
//   ② **属性顺序不敏感**（实测 Gutenberg 是 type,rel,title,length,href；SE 是 href,length,rel,title,type）
//   ③ 可读性判定的格式优先级（源给的格式 → MIME → URL）—— 用真 href `…55047.epub.noimages` 锁死
//   ④ 合成边界：`data:` 内联封面 / 转义 HTML content / 买借订阅样本一律不算 acquisition /
//      totalResults 缺失 → null / feed 级 next 不外泄 / CDATA / 未闭合标签 / 未知实体
//   ⑤ JSON 映射取值路径（拍板 ⑤ 的 `responseType:'json'` 走这条）
//
// 运行（仓库根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/book-market/verify-opds-parse.mjs
// 期望：全部 ok + exit=0

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}

const P = await import('../../../electron/lib/bookMarket/opdsParse.ts')
const F = await import('../../../electron/lib/kbStore/bookFormats.ts')

const FIX = 'fixtures'
const fix = (f) => readFileSync(join(ROOT, '.AGENT/scripts/book-market', FIX, f), 'utf-8')

// 真实调用方的依赖注入：可读性判定的格式唯一真相源在 bookFormats.ts（见 opdsParse 头注）
const DEPS = (sourceId, sourceName) => ({ sourceId, sourceName, extOf: F.bookExtOf, extFromMime: F.bookExtFromMime })

// ===== ① 真实 feed：两级源（Project Gutenberg）第一级 =====
console.log('\n--- ① Gutenberg 检索 feed（两级 · 第一级全是指针）---')
const gs = P.parseAtomFeed(fix('gutenberg-search.xml'), 'https://www.gutenberg.org/ebooks/search.opds/?query=turing')
check('解析成功', !!gs)
check('8 条 entry', gs.entries.length === 8, `got ${gs.entries.length}`)
check('第一级**没有任何** acquisition（真链接在下一层）', gs.entries.every((e) => e.acquisitions.length === 0))
check('每条都有 subFeedUrl（含导航条目）', gs.entries.every((e) => e.subFeedUrl !== ''))
check('subFeedUrl 是绝对地址', gs.entries[0].subFeedUrl.startsWith('https://www.gutenberg.org/'))
const navTitles = gs.entries.map((e) => e.title).filter((t) => t === 'Authors' || t === 'Subjects')
check('混着 2 条 Authors/Subjects 导航条目（不是书）', navTitles.length === 2, navTitles.join('/'))
const bookTitles = gs.entries.filter((e) => !navTitles.includes(e.title))
check('6 条真书条目', bookTitles.length === 6, `got ${bookTitles.length}`)
check('书条目 subFeedUrl 指向 /ebooks/<id>.opds', /\/ebooks\/\d+\.opds$/.test(bookTitles[0].subFeedUrl))
check('导航条目 rel=subsection 未被误判成 next/self 之类', !gs.entries.some((e) => e.subFeedUrl.includes('search.opds') === false && e.subFeedUrl === ''))
// 作者三路兜底：Gutenberg 不给 dc:creator，塞在 <content type="text">
check('作者从 <content type="text"> 兜底拿到', bookTitles.every((e) => e.author !== ''), bookTitles[0].author)
// 封面：Gutenberg 检索级封面**全是 data: 内联 base64** ⇒ 必须判成「无封面」而不是把 base64 塞进 img
check('data: 内联封面被丢弃（不落进 coverUrl）', gs.entries.every((e) => e.coverUrl === ''))
// 该 feed **没有** opensearch:totalResults（实测只有 itemsPerPage / startIndex）⇒ 必须是 null 不是 0
check('totalResults 标签缺失 → null（不是 0）', gs.totalResults === null, `got ${JSON.stringify(gs.totalResults)}`)
check('无 rel=next → nextPageUrl 为空', gs.nextPageUrl === '', gs.nextPageUrl)

// ===== ② 真实 feed：两级源第二级 + 格式判定优先级 =====
console.log('\n--- ② Gutenberg 书页 feed（两级 · 第二级带 acquisition）---')
const GB = 'https://www.gutenberg.org/ebooks/55047.opds'
const gb = P.parseAtomFeed(fix('gutenberg-book.opds'), GB)
check('解析成功', !!gb)
check('2 条 entry（noimages 版 / images 版）', gb.entries.length === 2, `got ${gb.entries.length}`)
check('两条都带 acquisition', gb.entries.every((e) => e.acquisitions.length > 0))
check('两条都没有 subFeedUrl（已到底，不再往下）', gb.entries.every((e) => e.subFeedUrl === ''))
// ★ 这条是「属性顺序不敏感」的**真实**锁：Gutenberg 写的是 type,rel,title,length,href
const g0 = gb.entries[0].acquisitions[0]
check('link type 取到（属性在 href 前面也认）', g0.type === 'application/epub+zip', g0.type)
check('link length 取到', g0.length === 322340, String(g0.length))
check('link href 解析成绝对地址', g0.href === 'https://www.gutenberg.org/ebooks/55047.epub.noimages', g0.href)
check('rel 判为 acquisition', P.isAcquisitionRel(g0.rel))

// ★★ 本节的核心：真 href `…55047.epub.noimages` **不以 .epub 结尾** ⇒ bookExtOf 恒 null，
//    只有 link 上的 MIME 能救。这就是 `bookExtFromMime` 存在的全部理由（bookFormats 头注）。
check('★ 陷阱复现：bookExtOf 对 .epub.noimages 返回 null', F.bookExtOf(g0.href) === null, String(F.bookExtOf(g0.href)))
check('★ MIME 兜底：application/epub+zip → .epub', F.bookExtFromMime(g0.type) === '.epub')

const gbItems = P.toBookMarketItems(gb.entries.map(P.feedEntryToRawItem), DEPS('src-gt', 'Project Gutenberg'))
check('归一后 2 条条目', gbItems.length === 2, `got ${gbItems.length}`)
const gi = gbItems[0]
check('★ 选中的是**可读**候选（跳过 mobi）', gi.ext === '.epub' && gi.readable === true, `${gi.ext}/${gi.readable}`)
check('★ 体积取**被选中那条**（不是第一条的）', gi.sizeBytes === 322340, String(gi.sizeBytes))
check('下载链接是可读那一条', gi.downloadUrl === 'https://www.gutenberg.org/ebooks/55047.epub.noimages')
check('acquisition 里的 mobi 不进 downloadUrl', !gi.downloadUrl.includes('.kindle'))
check('封面是真 http 地址（子 feed 有真封面，与第一级的 data: 不同）', gi.coverUrl.startsWith('https://www.gutenberg.org/cache/epub/55047/'), gi.coverUrl)
check('源 id / 源名带上了', gi.sourceId === 'src-gt' && gi.sourceName === 'Project Gutenberg')
check('xhtml content 的简介已去标签', gi.summary !== '' && !gi.summary.includes('<'), gi.summary.slice(0, 40))

// pickAcquisitionFromChildFeed：导航 feed（entry 全无 acquisition）必须返回 null
check('★ pickAcquisitionFromChildFeed 挑到带 acquisition 的那条', !!P.pickAcquisitionFromChildFeed(fix('gutenberg-book.opds'), GB))
const navFeed = '<feed><entry><title>Authors</title><link rel="subsection" type="application/atom+xml;profile=opds-catalog" href="https://a.org/x.opds"/></entry><entry><title>Arthur Thomas Malkin</title></entry></feed>'
check('★ 导航 feed 返回 null（否则会把第一个作者名当书名）', P.pickAcquisitionFromChildFeed(navFeed, 'https://a.org/x.opds') === null)

// ===== ③ 真实 feed：单级源（Standard Ebooks）=====
console.log('\n--- ③ Standard Ebooks 检索 feed（单级）---')
const SE = 'https://standardebooks.org/feeds/opds/all?query=sherlock'
const se = P.parseAtomFeed(fix('stdbooks-sherlock.xml'), SE)
check('解析成功', !!se)
check('3 条 entry', se.entries.length === 3, `got ${se.entries.length}`)
check('每条直接带 5 条 acquisition（单级，不需要展开）', se.entries.every((e) => e.acquisitions.length === 5), se.entries.map((e) => e.acquisitions.length).join(','))
check('单级 ⇒ subFeedUrl 全空', se.entries.every((e) => e.subFeedUrl === ''))
// ★ 这条是「属性顺序不敏感」的另一半：SE 写的是 href,length,rel,title,type
const s0 = se.entries[0].acquisitions[0]
check('★ link 属性（SE 顺序 href,length,rel,title,type 也认）', s0.rel === 'http://opds-spec.org/acquisition/open-access' && s0.length > 0 && s0.type !== '', `${s0.rel}/${s0.length}/${s0.type}`)
check('★ acquisition/open-access 算可下载（SE 全用这个）', se.entries.every((e) => e.acquisitions.every((l) => P.isAcquisitionRel(l.rel))))
check('作者从 <author><name> 拿到', se.entries.every((e) => e.author === 'Arthur Conan Doyle'), se.entries[0].author)
check('简介从 <summary type="text"> 拿到且干净', se.entries.every((e) => e.summary !== '' && !e.summary.includes('<')), se.entries[0].summary.slice(0, 40))
check('封面是真 http 地址', se.entries.every((e) => e.coverUrl.startsWith('https://standardebooks.org/')))

const seItems = P.toBookMarketItems(se.entries.map(P.feedEntryToRawItem), DEPS('src-se', 'Standard Ebooks'))
check('归一后 3 条条目', seItems.length === 3)
check('★ 跳过不可读候选（kepub / azw3 / xhtml）落到 epub', seItems.every((i) => i.ext === '.epub' && i.readable === true), seItems.map((i) => i.ext).join(','))
check('体积是被选中那条的（>0）', seItems.every((i) => i.sizeBytes > 0))
check('kepub / xhtml 的 MIME 判为不可读', F.bookExtFromMime('application/kepub+zip') === null && F.bookExtFromMime('application/xhtml+xml') === null)

// ===== ④ 真实 feed：零结果 =====
console.log('\n--- ④ SE 零结果 feed（totalResults 显式为 0）---')
const empty = P.parseAtomFeed(fix('stdbooks-search.xml'), 'https://standardebooks.org/feeds/opds/all?query=turing')
check('解析成功', !!empty)
check('0 条 entry', empty.entries.length === 0)
check('★ totalResults 显式为 0 时是 0（与标签缺失的 null 区分开）', empty.totalResults === 0, `got ${JSON.stringify(empty.totalResults)}`)
check('没有 rel=next → nextPageUrl 空', empty.nextPageUrl === '')

// ===== ⑤ 合成边界：XML =====
console.log('\n--- ⑤ XML 极简解析边界 ---')
check('实体解码', P.decodeEntities('a &amp; b &lt;i&gt; &quot;q&quot; &apos;s&apos;') === 'a & b <i> "q" \'s\'')
check('数字实体（十进制 / 十六进制）', P.decodeEntities('&#65;&#x42;') === 'AB')
check('认不出的实体原样保留（不抛错）', P.decodeEntities('&weird;') === '&weird;')
check('非法码点原样保留', P.decodeEntities('&#0;') === '&#0;')
const cdata = P.parseXml('<feed><entry><summary><![CDATA[a & b <raw>]]></summary></entry></feed>')
check('CDATA 取原文（不解实体）', P.nodeText(P.findChild(cdata, 'feed/entry/summary')) === 'a & b <raw>')
const messy = P.parseXml('<?xml version="1.0"?><!-- c --><feed><entry><title>T</title><br/><a href=\'x\'>A</a></entry>')
check('跳过 XML 声明与注释、容错未闭合', P.nodeText(P.findChild(messy, 'feed/entry/title')) === 'T')
check('自闭合标签不吞后续', P.findChild(messy, 'feed/entry/a') !== null)
check('残缺输入不抛错', P.parseXml('<feed><entry><title>oops') !== null)
check('非字符串 / 空串 → null', P.parseXml('') === null && P.parseXml(null) === null)
check('无 <feed> → null', P.parseAtomFeed('<html><body>x</body></html>', 'https://a.org') === null)
const attrs = P.parseXml('<feed><entry><link rel=subsection type="a/b" href=\'https://a.org/x\'/></entry></feed>')
const al = P.findChild(attrs, 'feed/entry/link')
check('属性：无引号值也收', P.attrOf(al, 'rel') === 'subsection')
check('属性：单引号值也收', P.attrOf(al, 'href') === 'https://a.org/x')
check('attrOf 大小写不敏感', P.attrOf(al, 'REL') === 'subsection')
check('attrOf 空节点安全', P.attrOf(null, 'rel') === '')

console.log('\n--- ⑤b URL 白名单与解析 ---')
check('isHttpUrl 收 http/https', P.isHttpUrl('http://a.org/x') && P.isHttpUrl('https://a.org/x'))
check('★ isHttpUrl 挡 data: 内联图', !P.isHttpUrl('data:image/png;base64,iVBORw0KGgo='))
check('isHttpUrl 挡 file: / kbview: / javascript:', !P.isHttpUrl('file:///C:/x') && !P.isHttpUrl('kbview://a/b') && !P.isHttpUrl('javascript:alert(1)'))
check('isHttpUrl 垃圾串 → false', !P.isHttpUrl('not a url') && !P.isHttpUrl('') && !P.isHttpUrl(null))
check('resolveUrl 相对 → 绝对', P.resolveUrl('/ebooks/1.opds', 'https://a.org/ebooks/search.opds') === 'https://a.org/ebooks/1.opds')
check('resolveUrl 绝对原样', P.resolveUrl('https://b.org/x', 'https://a.org/') === 'https://b.org/x')
check('resolveUrl 垃圾 → 空串（不抛错）', P.resolveUrl('http://[bad', 'https://a.org/') === '' && P.resolveUrl('', 'https://a.org/') === '')
check('resolveUrl 无 base 时只收绝对地址', P.resolveUrl('/x', '') === '' && P.resolveUrl('https://b.org/x', '') === 'https://b.org/x')

console.log('\n--- ⑤c acquisition rel 白名单 ---')
check('裸 acquisition 收', P.isAcquisitionRel('http://opds-spec.org/acquisition') && P.isAcquisitionRel('https://opds-spec.org/acquisition'))
check('open-access 收', P.isAcquisitionRel('http://opds-spec.org/acquisition/open-access'))
check('★ 买 / 借 / 订阅 / 样本 一律不收（§八：不做受控借阅与商业平台）',
  ['buy', 'borrow', 'subscribe', 'sample'].every((k) => !P.isAcquisitionRel(`http://opds-spec.org/acquisition/${k}`)))
check('大小写与空白容错', P.isAcquisitionRel('  HTTP://OPDS-SPEC.ORG/ACQUISITION  '))
check('无关 rel → false', !P.isAcquisitionRel('http://opds-spec.org/image') && !P.isAcquisitionRel('') && !P.isAcquisitionRel('subsection'))

// ===== ⑥ 合成边界：entry 抽取 =====
console.log('\n--- ⑥ entry 抽取边界 ---')
const synthetic = `<feed>
  <link rel="next" href="/page2.opds" type="application/atom+xml;profile=opds-catalog"/>
  <entry>
    <title>The Book</title>
    <link href="https://a.org/b.epub" type="application/epub+zip" rel="http://opds-spec.org/acquisition" length="1234"/>
    <link rel="http://opds-spec.org/image/thumbnail" type="image/jpeg" href="https://a.org/small.jpg"/>
    <link rel="http://opds-spec.org/image" type="image/jpeg" href="https://a.org/big.jpg"/>
    <link rel="next" href="/never.opds" type="application/atom+xml;profile=opds-catalog"/>
  </entry>
  <entry>
    <title>No Link Book</title>
  </entry>
  <entry>
    <title>Pointer Only</title>
    <link rel="subsection" type="application/atom+xml;profile=opds-catalog" href="https://a.org/deeper.opds"/>
  </entry>
</feed>`
const syn = P.parseAtomFeed(synthetic, 'https://a.org/search.opds')
check('3 条 entry', syn.entries.length === 3)
check('★ feed 级 rel=next 取到（分页用）', syn.nextPageUrl === 'https://a.org/page2.opds', syn.nextPageUrl)
check('★ entry 里的 rel=next 不冒充分页（两者 type 相同，靠层级区分）', !syn.nextPageUrl.includes('never'))
check('封面优先取 thumbnail', syn.entries[0].coverUrl === 'https://a.org/small.jpg')
check('有 acquisition ⇒ subFeedUrl 为空（不去展开）', syn.entries[0].subFeedUrl === '')
check('光有 subsection ⇒ subFeedUrl 有值', syn.entries[2].subFeedUrl === 'https://a.org/deeper.opds')
check('无 link 的条目：无 acquisition / 无 subFeedUrl', syn.entries[1].acquisitions.length === 0 && syn.entries[1].subFeedUrl === '')
check('无 totalResults 标签 → null', syn.totalResults === null)

// ★ 转义风格照抄真 feed（SE 的 content 体是**单层**转义：`&lt;p&gt;` / `&amp;`），
//   别写成 `&amp;quot;` —— 那是双层转义，解码出来是字面量 `&quot;` 而不是 `"`。
//   这条路径 SE 实际不会走到（它有 <summary>），但自定义源可能只有 html content。
const seLike = `<feed><entry><title>T</title>
  <content type="html">&lt;p&gt;&lt;i&gt;The Casebook of Sherlock Holmes&lt;/i&gt;, published in 1927, &amp; more&lt;/p&gt;</content>
  <link href="https://a.org/x.epub" rel="http://opds-spec.org/acquisition/open-access" type="application/epub+zip"/>
</entry></feed>`
const seEntry = P.parseAtomFeed(seLike, 'https://a.org/f.opds').entries[0]
check('★ 转义 HTML 型 content 的简介已去标签、实体已解', seEntry.summary === 'The Casebook of Sherlock Holmes, published in 1927, & more', JSON.stringify(seEntry.summary))
const xhtmlLike = '<feed><entry><title>T</title><content type="xhtml"><div><p>Para <b>one</b></p><p>Two</p></div></content></entry></feed>'
const xEntry = P.parseAtomFeed(xhtmlLike, 'https://a.org/f.opds').entries[0]
check('xhtml 型 content（真元素）取全部后代文本', xEntry.summary === 'Para one Two', JSON.stringify(xEntry.summary))
const dataCover = '<feed><entry><title>T</title><link rel="http://opds-spec.org/image/thumbnail" type="image/png" href="data:image/png;base64,AAAA"/><link rel="http://opds-spec.org/image/thumbnail" type="image/jpeg" href="https://a.org/real.jpg"/></entry></feed>'
check('★ data: 内联封面跳过、取后面那张真图', P.parseAtomFeed(dataCover, 'https://a.org/f.opds').entries[0].coverUrl === 'https://a.org/real.jpg')
const onlyDataCover = '<feed><entry><title>T</title><link rel="http://opds-spec.org/image" type="image/png" href="data:image/png;base64,AAAA"/></entry></feed>'
check('全是 data: 封面 ⇒ 空串（不是把 base64 塞进 img src）', P.parseAtomFeed(onlyDataCover, 'https://a.org/f.opds').entries[0].coverUrl === '')

console.log('\n--- ⑥b 归一为统一条目模型 ---')
const noCand = P.toBookMarketItems([{ title: 'Only Title', author: '', summary: '', coverUrl: '', candidates: [] }], DEPS('s', 'S'))
check('无候选 ⇒ downloadUrl 空 + 不可读', noCand.length === 1 && noCand[0].downloadUrl === '' && noCand[0].readable === false)
const allBad = P.toBookMarketItems([{ title: 'Bad', author: '', summary: '', coverUrl: '', candidates: [{ url: 'https://a.org/b.mobi', format: 'application/x-mobipocket-ebook', sizeBytes: 9 }] }], DEPS('s', 'S'))
check('★ 只有不可读候选 ⇒ 取第一条但标 readable:false（书卡据此禁用下载）', allBad[0].readable === false && allBad[0].downloadUrl === 'https://a.org/b.mobi' && allBad[0].ext === '')
check('无书名的条目丢弃', P.toBookMarketItems([{ title: '', author: 'x', summary: '', coverUrl: '', candidates: [] }], DEPS('s', 'S')).length === 0)
const fmtPriority = P.toBookMarketItems([{ title: 'P', author: '', summary: '', coverUrl: '', candidates: [{ url: 'https://a.org/download/123', format: 'epub', sizeBytes: 5 }] }], DEPS('s', 'S'))
check('★ 源给的格式字段优先于 URL（无扩展名直链也判得出可读）', fmtPriority[0].ext === '.epub' && fmtPriority[0].readable === true)
const badCover = P.toBookMarketItems([{ title: 'C', author: '', summary: '', coverUrl: 'kbview://x/y.png', candidates: [] }], DEPS('s', 'S'))
check('非 http 封面在归一时被清空', badCover[0].coverUrl === '')

// ===== ⑦ JSON 映射（拍板 ⑤ 的 responseType:'json'）=====
console.log('\n--- ⑦ JSON 取值路径 ---')
check('路径 a.b[*].c 可解析', P.parseJsonPath('a.b[*].c') !== null)
check('路径 a.b[0].c 可解析', P.parseJsonPath('a.b[0].c') !== null)
check('首段 [*] 可解析', P.parseJsonPath('[*].title') !== null)
check('空路径 / 连续点 / 多下标 / 表达式 一律 null',
  P.parseJsonPath('') === null && P.parseJsonPath('a..b') === null && P.parseJsonPath('a[0][1]') === null && P.parseJsonPath('a[?(@.x)]') === null && P.parseJsonPath('a[foo]') === null)

const doc = { data: { books: [{ title: 'A', author: 'Au', cover: '/c/a.jpg', desc: 'D', files: [{ format: 'epub', url: '/d/1' }] }, { title: 'B', files: [] }, { author: 'no title' }] } }
check('readJsonPath 数组展开命中 3 条', P.readJsonPath(doc, 'data.books[*]').length === 3)
check('readJsonPath 定下标命中 1 条', P.readJsonPath(doc, 'data.books[0]').length === 1)
check('readJsonPath 越界 → 空', P.readJsonPath(doc, 'data.books[9]').length === 0)
check('readJsonPath 认不出 → 空数组（不抛错）', P.readJsonPath(doc, 'nope.nope[*]').length === 0 && P.readJsonPath(doc, 'bad path!!').length === 0)

const MAP = { list: 'data.books[*]', title: 'title', author: 'author', cover: 'cover', summary: 'desc', download: 'files[0].url', format: 'files[0].format' }
const jItems = P.toBookMarketItems(P.jsonToRawItems(doc, MAP, 'https://a.org/api'), DEPS('json-src', 'JSON 源'))
check('★ 只产出有书名的条目（B 有 title 无 files / 第三条无 title）', jItems.length === 2, `got ${jItems.length}`)
check('相对下载直链按 base 解析成绝对', jItems[0].downloadUrl === 'https://a.org/d/1', jItems[0].downloadUrl)
check('mapping.format 决定 ext（直链无扩展名也可读）', jItems[0].ext === '.epub' && jItems[0].readable === true)
check('相对封面解析成绝对', jItems[0].coverUrl === 'https://a.org/c/a.jpg')
check('author / summary 按映射取到', jItems[0].author === 'Au' && jItems[0].summary === 'D')
check('无 files 的条目：downloadUrl 空 + 不可读', jItems[1].downloadUrl === '' && jItems[1].readable === false)
check('★ JSON 映射没有体积字段 ⇒ sizeBytes 为 null（留给下载时看 Content-Length）', jItems[0].sizeBytes === null)
const noFmt = P.jsonToRawItems(doc, { list: 'data.books[*]', title: 'title', download: 'files[0].url' }, 'https://a.org/api')
check('mapping 无 format ⇒ 从 URL 推（/d/1 推不出 ⇒ 不可读，符合预期）', P.toBookMarketItems(noFmt, DEPS('s', 'S'))[0].readable === false)

// ===== ⑧ 零依赖不变量 =====
console.log('\n--- ⑧ 零依赖不变量（改了会静默废掉本脚本）---')
const SRC = readFileSync(join(ROOT, 'electron/lib/bookMarket/opdsParse.ts'), 'utf-8')
const importLines = SRC.split('\n').filter((l) => /^\s*import\s/.test(l))
check('★ opdsParse.ts 里没有任何 import（Node strip-types 解析不了 extensionless 相对导入）', importLines.length === 0, importLines.join(' | '))

console.log(`\n${pass ? '全部通过' : '存在失败项'}`)
process.exit(pass ? 0 : 1)
