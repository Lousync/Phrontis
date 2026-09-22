// 契约验证：书市数据层（方案 §2.1 / §2.2 / §八 第 1 项）。
//
// 覆盖五类断言：
//   ① bookMarketSchema 纯函数用例表（书源归一 / 脏数据回落 / patch 白名单 / 键与封面白名单 /
//      剪枝 / 文件名净化）——直接 import 零依赖 .ts，验的是真实实现不是复制品。
//   ② **凭据负向**（本文件存在的头号理由）：带标记值的凭据字段塞进 raw，归一后必须
//      一个字都不留 —— 书源描述永不含凭据（方案 §2.2）。
//   ③ **零依赖不变量**：schema 里出现运行时 import 会让本脚本直接 Cannot find module
//      （Node 的 strip-types 解析不了 extensionless 相对导入，2026-09-22 实测），
//      所以用静态断言把它锁住，免得后人顺手加一行 import 就悄悄废掉整份契约。
//   ④ 唯一写方：`bookSources.json` / `.meta.json` / `.books` 字面量只许出现在各自的写方文件。
//   ⑤ 出 IPC 的源描述只报「凭据存没存」（主进程仓库层从不读凭据字段）。
//
// 运行（仓库根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/book-market/verify-book-sources.mjs
// 期望：全部 ok + exit=0

import { stripComments, walkSourceFiles } from '../shared/strip-comments.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}
const SCHEMA_REL = 'electron/lib/kbStore/bookMarketSchema.ts'
const REPO_REL = 'electron/lib/kbStore/bookSourceVaultRepo.ts'
const META_REL = 'electron/lib/kbStore/vaultBookMetaRepo.ts'

// ===== ① 书源归一 =====
console.log('\n--- ① 书源归一 / 脏数据回落 ---')
const S = await import('../../../electron/lib/kbStore/bookMarketSchema.ts')

const good = { id: 's1', name: '公版书库', kind: 'opds', url: 'https://example.org/opds', enabled: true, builtin: true, createdAt: '2026-09-22T00:00:00.000Z' }
const g = S.coerceBookSource(good)
check('合法源原样收', !!g && g.id === 's1' && g.name === '公版书库' && g.kind === 'opds' && g.builtin === true)
check('auth 缺省 = null（免认证）', g.auth === null)
check('mapping 缺省 = null', g.mapping === null)

check('缺 id 丢整条', S.coerceBookSource({ name: 'n', url: 'https://a.org' }) === null)
check('缺 name 丢整条', S.coerceBookSource({ id: 'i', url: 'https://a.org' }) === null)
check('非对象丢整条', S.coerceBookSource('x') === null)
check('kind 乱值回落 custom', S.coerceBookSource({ ...good, kind: 'weird' }).kind === 'custom')
check('enabled 乱值仍视为启用', S.coerceBookSource({ ...good, enabled: 'no' }).enabled === true)
check('enabled:false 保留', S.coerceBookSource({ ...good, enabled: false }).enabled === false)
check('builtin 非 true 即 false', S.coerceBookSource({ ...good, builtin: 'yes' }).builtin === false)
check('createdAt 缺省补 now', S.coerceBookSource({ ...good, createdAt: undefined }, 'NOW').createdAt === 'NOW')

// 整壳回落：脏壳不抛错
const emptyShell = S.coerceBookSources({})
check('整壳：无 sources 字段 → 空库', emptyShell.sources.length === 0 && emptyShell.version === 1)
check('整壳：非对象 → 空库', S.coerceBookSources('x').sources.length === 0)
check('整壳：sources 非数组 → 空库', S.coerceBookSources({ sources: 'x' }).sources.length === 0)
check('整壳：version 归一到 1', S.coerceBookSources({ version: 9, sources: [good] }).version === 1)
const dup = S.coerceBookSources({ sources: [good, { ...good, name: '第二个' }] })
check('整壳：id 重复只留第一条', dup.sources.length === 1 && dup.sources[0].name === '公版书库')
const mixed = S.coerceBookSources({ sources: [good, { name: '坏条目' }, null] })
check('整壳：坏条目丢弃、好条目保留', mixed.sources.length === 1 && mixed.sources[0].id === 's1')

// ===== ② 凭据负向（头号断言） =====
console.log('\n--- ② 凭据负向：书源描述里一个字都不许留 ---')
const LEAK = { username: 'LEAK_USER', password: 'LEAK_PASS', token: 'LEAK_TOKEN', secret: 'LEAK_SECRET', credential: 'LEAK_CRED' }
const dirtyRaw = { ...good, ...LEAK }
const cleaned = S.coerceBookSource(dirtyRaw)
const cleanedKeys = Object.keys(cleaned).sort().join(',')
check('归一结果只含白名单键', cleanedKeys === 'auth,builtin,createdAt,enabled,id,kind,mapping,name,responseType,searchUrl,url', cleanedKeys)
check('归一结果不含任何凭据标记', !JSON.stringify(cleaned).includes('LEAK'))
const dirtyStore = JSON.stringify(S.coerceBookSources({ sources: [dirtyRaw] }))
check('整壳序列化后不含凭据标记', !dirtyStore.includes('LEAK'))

const patchLeak = S.sanitizeBookSourcePatch({ name: '新名字', ...LEAK })
check('patch 白名单只留非凭据字段', Object.keys(patchLeak).join(',') === 'name', Object.keys(patchLeak).join(','))
check('patch 序列化后不含凭据标记', !JSON.stringify(patchLeak).includes('LEAK'))

// ===== ③ patch 白名单 =====
console.log('\n--- ③ patch 白名单 ---')
check('非对象 → null', S.sanitizeBookSourcePatch('x') === null && S.sanitizeBookSourcePatch([]) === null)
check('空对象 → {}（合法 no-op，不是 null）', JSON.stringify(S.sanitizeBookSourcePatch({})) === '{}')
check('name 去首尾空白', S.sanitizeBookSourcePatch({ name: '  A  ' }).name === 'A')
check('kind 合法收', S.sanitizeBookSourcePatch({ kind: 'opds' }).kind === 'opds')
check('kind 非法丢弃', S.sanitizeBookSourcePatch({ kind: 'weird' }).kind === undefined)
check('url 非法静默丢弃（错误文案由调用方给）', S.sanitizeBookSourcePatch({ url: 'ftp://x' }).url === undefined)
check('enabled:false 保留', S.sanitizeBookSourcePatch({ enabled: false }).enabled === false)
check('auth 可为 null（取消认证）', S.sanitizeBookSourcePatch({ auth: null }).auth === null)
check('auth 不完整 → null', S.sanitizeBookSourcePatch({ auth: { type: 'basic' } }).auth === null)
check('mapping 缺 download → null', S.sanitizeBookSourcePatch({ mapping: { list: 'l', title: 't' } }).mapping === null)
check('mapping 三必需项齐 → 收', S.sanitizeBookSourcePatch({ mapping: { list: 'l', title: 't', download: 'd' } }).mapping.download === 'd')

// ===== ④ URL 白名单 =====
console.log('\n--- ④ URL 白名单（只放 http/https） ---')
check('https 收', S.isAllowedSourceUrl('https://example.org/opds') === true)
check('http 收', S.isAllowedSourceUrl('http://example.org/opds') === true)
check('私网地址收（自建库就是局域网）', S.isAllowedSourceUrl('http://192.168.1.9:8080/opds') === true)
check('file: 拒', S.isAllowedSourceUrl('file:///C:/a.xml') === false)
check('kbview: 拒', S.isAllowedSourceUrl('kbview://x') === false)
check('javascript: 拒', S.isAllowedSourceUrl('javascript:alert(1)') === false)
check('ftp: 拒', S.isAllowedSourceUrl('ftp://x/y') === false)
check('非 URL 串拒', S.isAllowedSourceUrl('not a url') === false)
check('空串拒', S.isAllowedSourceUrl('') === false && S.isAllowedSourceUrl(null) === false)

// ===== ⑤ 凭据形状与三态判定 =====
console.log('\n--- ⑤ 凭据形状 / credentialSatisfies ---')
check('basic 齐 → 收', S.coerceCredential({ type: 'basic', username: 'u', password: 'p' }).password === 'p')
check('basic 缺 password → null', S.coerceCredential({ type: 'basic', username: 'u' }) === null)
check('bearer 有 token → 收', S.coerceCredential({ type: 'bearer', token: 't' }).token === 't')
check('bearer 无 token → null', S.coerceCredential({ type: 'bearer' }) === null)
check('未知类型 → null', S.coerceCredential({ type: 'oauth', token: 't' }) === null)
const creds = S.coerceCredentials({ creds: { a: { type: 'bearer', token: 'T' }, b: { type: 'bearer' } } })
check('凭据库：坏条目丢弃', Object.keys(creds.creds).join(',') === 'a')
check('凭据库：非对象 → 空', Object.keys(S.coerceCredentials(null).creds).length === 0)

check('三态：basic 齐 → 满足', S.credentialSatisfies('basic', { type: 'basic', username: 'u', password: 'p' }) === true)
check('三态：basic 缺 password → 不满足（应当是「需要凭据」）', S.credentialSatisfies('basic', { type: 'basic', username: 'u' }) === false)
check('三态：bearer 有 token → 满足', S.credentialSatisfies('bearer', { type: 'bearer', token: 't' }) === true)
check('三态：类型不匹配 → 不满足', S.credentialSatisfies('basic', { type: 'bearer', token: 't' }) === false)
check('三态：无凭据 → 不满足', S.credentialSatisfies('basic', null) === false)

// ===== ⑤b 源描述增补（拍板 ⑤：searchUrl / responseType / mapping.summary+format） =====
console.log('\n--- ⑤b 源描述增补：searchUrl / responseType / mapping 增项 ---')
const withSearch = S.coerceBookSource({ ...good, searchUrl: '  https://a.org/s?q={query}  ', responseType: 'json' })
check('searchUrl 去空白保留（模板不是 URL，不做 URL 校验）', withSearch.searchUrl === 'https://a.org/s?q={query}', withSearch.searchUrl)
check('searchUrl 缺省 = 空串', S.coerceBookSource(good).searchUrl === '')
check('custom + responseType:json 保留', S.coerceBookSource({ ...good, kind: 'custom', responseType: 'json' }).responseType === 'json')
check('custom 缺 responseType 缺省 json', S.coerceBookSource({ ...good, kind: 'custom' }).responseType === 'json')
check('custom 乱值回落 json', S.coerceBookSource({ ...good, kind: 'custom', responseType: 'xml' }).responseType === 'json')
check('★ opds 恒 atom（源写 json 也没用，标准协议说了算）', S.coerceBookSource({ ...good, kind: 'opds', responseType: 'json' }).responseType === 'atom')

// coerceMapping 是模块私有的，走公开的 coerceBookSource 验（同一实现，不复制逻辑）
const srcWithMapping = (m) => S.coerceBookSource({ ...good, kind: 'custom', mapping: m })
const fullMapping = srcWithMapping({ list: 'l', title: 't', download: 'd', author: 'a', cover: 'c', summary: 's', format: 'f' }).mapping
check('mapping 收下 summary / format（拍板 ⑤ 新增）', fullMapping.summary === 's' && fullMapping.format === 'f')
check('mapping 可选增项缺省 = 不出现该键（不是空串）', !('summary' in srcWithMapping({ list: 'l', title: 't', download: 'd' }).mapping))
check('★ patch 收 searchUrl（模板不做 URL 合法性判断）', S.sanitizeBookSourcePatch({ searchUrl: 'https://a.org/s?q={query}' }).searchUrl === 'https://a.org/s?q={query}')
check('patch searchUrl 给空串 = 清掉（回落用 url）', S.sanitizeBookSourcePatch({ searchUrl: '' }).searchUrl === '')
check('patch responseType 合法收', S.sanitizeBookSourcePatch({ responseType: 'atom' }).responseType === 'atom')
check('patch responseType 非法丢弃', S.sanitizeBookSourcePatch({ responseType: 'xml' }).responseType === undefined)

// ===== ⑤c 检索地址模板展开（resolveSearchUrl 纯函数） =====
console.log('\n--- ⑤c 检索地址模板展开 ---')
const tmplSrc = { url: 'https://a.org/opds/', searchUrl: 'https://a.org/search.opds/?query={query}&page={page}' }
check('{base} 去尾斜杠（含多重斜杠）', S.resolveSearchUrl({ url: 'https://a.org///', searchUrl: '{base}/s?x=1' }, { query: 'q' }) === 'https://a.org/s?x=1')
check('{base} 无尾斜杠时原样', S.resolveSearchUrl({ url: 'https://a.org', searchUrl: '{base}/s?x=1' }, { query: 'q' }) === 'https://a.org/s?x=1')
check('★ {query} 必 encodeURIComponent（中文检索词不编码必炸）',
  S.resolveSearchUrl(tmplSrc, { query: '图灵 test' }) === 'https://a.org/search.opds/?query=%E5%9B%BE%E7%81%B5%20test&page=1',
  S.resolveSearchUrl(tmplSrc, { query: '图灵 test' }))
check('{page} 展开页码', S.resolveSearchUrl(tmplSrc, { query: 'x', page: 3 }).includes('page=3'))
check('{page} 缺省 1 / 乱值回落 1 / 小数取整', S.resolveSearchUrl(tmplSrc, { query: 'x' }).includes('page=1') && S.resolveSearchUrl(tmplSrc, { query: 'x', page: -2 }).includes('page=1') && S.resolveSearchUrl(tmplSrc, { query: 'x', page: 2.9 }).includes('page=2'))
check('{isbn} 展开并编码', S.resolveSearchUrl({ url: 'https://a.org/', searchUrl: '{base}/i/{isbn}' }, { query: '', isbn: '978-7' }) === 'https://a.org/i/978-7')
check('{isbn} 缺省展开成空串', S.resolveSearchUrl({ url: 'https://a.org/', searchUrl: '{base}/i/{isbn}' }, { query: '' }) === 'https://a.org/i/')
check('searchUrl 为空 ⇒ 回落用 url', S.resolveSearchUrl({ url: 'https://a.org/opds', searchUrl: '' }, { query: 'x' }) === 'https://a.org/opds?query=x')
check('★ 无 ? 且 query 非空 ⇒ 兜底追加 ?query=', S.resolveSearchUrl({ url: 'https://a.org/opds', searchUrl: '' }, { query: 'a b' }) === 'https://a.org/opds?query=a%20b')
check('已有 ? 就不再追加', S.resolveSearchUrl({ url: 'https://a.org/', searchUrl: '{base}/s?x=1' }, { query: 'y' }) === 'https://a.org/s?x=1')
check('query 为空时不追加（避免 ?query= 空参）', S.resolveSearchUrl({ url: 'https://a.org/opds', searchUrl: '' }, { query: '' }) === 'https://a.org/opds')
check('★ 展开后 scheme 必须仍是 http(s)（{base} 是用户可控输入）', S.resolveSearchUrl({ url: 'file:///C:/a', searchUrl: '' }, { query: 'x' }) === null)
check('★ 模板里塞 javascript: 也被最终白名单拦下', S.resolveSearchUrl({ url: 'https://a.org/', searchUrl: 'javascript:alert(1)?q={query}' }, { query: 'x' }) === null)
check('url 非法 ⇒ null（调用方报「未配置检索地址」而非「连接失败」）', S.resolveSearchUrl({ url: 'not a url', searchUrl: '' }, { query: 'x' }) === null)
check('Gutenberg 预置模板真值可用', S.resolveSearchUrl(S.PRESET_BOOK_SOURCES[0], { query: 'turing' }) === 'https://www.gutenberg.org/ebooks/search.opds/?query=turing')
check('Standard Ebooks 预置模板真值可用', S.resolveSearchUrl(S.PRESET_BOOK_SOURCES[1], { query: 'turing' }) === 'https://standardebooks.org/feeds/opds/all?query=turing')

// ===== ⑤d 预置源与幂等种入（拍板 ⑥⑦） =====
console.log('\n--- ⑤d 预置源 / 幂等种入 ---')
check('预置源两个（Gutenberg + Standard Ebooks；Open Library 另立条目）', S.PRESET_BOOK_SOURCES.length === 2, S.PRESET_BOOK_SOURCES.map((p) => p.id).join(','))
check('预置源 id 稳定（改名会让老用户被重复种一份）',
  S.PRESET_BOOK_SOURCES.map((p) => p.id).join(',') === 'builtin-gutenberg,builtin-standardebooks')
check('预置源全是 opds + atom + 内置 + 免认证',
  S.PRESET_BOOK_SOURCES.every((p) => p.kind === 'opds' && p.responseType === 'atom' && p.builtin === true && p.auth === null && p.mapping === null))
check('预置源地址都过 URL 白名单', S.PRESET_BOOK_SOURCES.every((p) => S.isAllowedSourceUrl(p.url) && S.isAllowedSourceUrl(p.searchUrl)))
check('预置源都带检索模板（连 OPDS 也必须给，推不出来）', S.PRESET_BOOK_SOURCES.every((p) => p.searchUrl !== '' && p.searchUrl.includes('{query}')))
check('★ 预置源里不含任何凭据字段', !JSON.stringify(S.PRESET_BOOK_SOURCES).match(/password|token|username|secret/i))

const seed0 = S.seedPresetSources(S.emptyBookSources())
check('空库种入两个', seed0.added.length === 2 && seed0.store.sources.length === 2)
check('★ 再种一次：added 为空、库不变（幂等）', S.seedPresetSources(seed0.store).added.length === 0)
check('★ 幂等且不重复（不会出现两份 Gutenberg）',
  S.seedPresetSources(S.seedPresetSources(seed0.store).store).store.sources.length === 2)
check('预置源排在用户源**前面**', S.seedPresetSources({ version: 1, sources: [{ ...S.PRESET_BOOK_SOURCES[1], id: 'u1', builtin: false }] }).store.sources[0].id === 'builtin-gutenberg')

// ★ 这条是种入逻辑最容易写错的地方：不能「有缺就整份重种」（会把已存在的那条复制一份）
const halfSeeded = { version: 1, sources: [{ ...S.PRESET_BOOK_SOURCES[0] }] }
const seedHalf = S.seedPresetSources(halfSeeded)
check('★ 半缺时只补缺的那条，已有的不复制', seedHalf.added.join(',') === 'builtin-standardebooks' && seedHalf.store.sources.length === 2, seedHalf.added.join(','))
// ★ 用户把内置源停用/改名后，种入不许把它改回启用
const disabledBuiltin = { version: 1, sources: S.PRESET_BOOK_SOURCES.map((p) => (p.id === 'builtin-gutenberg' ? { ...p, enabled: false, name: '我给改的名' } : p)) }
const seedDisabled = S.seedPresetSources(disabledBuiltin)
check('★ 停用过的内置源：种入不动它（added 空）', seedDisabled.added.length === 0)
check('★ 停用状态与改名都原样保留（不会被种回启用）',
  seedDisabled.store.sources.find((s) => s.id === 'builtin-gutenberg').enabled === false && seedDisabled.store.sources.find((s) => s.id === 'builtin-gutenberg').name === '我给改的名')
check('种入不改动用户自建源', S.seedPresetSources({ version: 1, sources: [{ ...good, id: 'mine', builtin: false }] }).store.sources.some((s) => s.id === 'mine'))
check('种入硬塞凭据字段也进不来', !JSON.stringify(S.seedPresetSources(S.emptyBookSources()).store).match(/password|token|username|secret/i))

// ===== ⑥ 元数据键 / 归一 / 剪枝 =====
console.log('\n--- ⑥ 元数据：键归一 / 归一化 / 孤儿剪枝 ---')
check('键：反斜杠 → posix', S.bookMetaKey('books\\a.epub') === 'books/a.epub')
check('键：去 ./ 前缀', S.bookMetaKey('./books/a.epub') === 'books/a.epub')
check('键：绝对路径拒', S.bookMetaKey('/a.epub') === '')
check('键：含 .. 段拒', S.bookMetaKey('../a.epub') === '')
check('键：空段拒', S.bookMetaKey('books//a.epub') === '')
check('键：合法双点文件名保留（a..b.epub）', S.bookMetaKey('books/a..b.epub') === 'books/a..b.epub')
check('键：空值拒', S.bookMetaKey('') === '' && S.bookMetaKey(null) === '')

check('条目：无 title 丢整条', S.coerceBookMetaEntry({ author: 'A' }) === null)
check('条目：size 取整', S.coerceBookMetaEntry({ title: 'T', size: '123.9' }).size === 123)
check('条目：size 负数归 0', S.coerceBookMetaEntry({ title: 'T', size: -5 }).size === 0)
check('条目：size 乱值归 0', S.coerceBookMetaEntry({ title: 'T', size: 'x' }).size === 0)
check('条目：越权 coverRel 清空', S.coerceBookMetaEntry({ title: 'T', coverRel: '../../etc/passwd' }).coverRel === '')
check('条目：合法 coverRel 保留', S.coerceBookMetaEntry({ title: 'T', coverRel: '.books/.covers/ab12.jpg' }).coverRel === '.books/.covers/ab12.jpg')

check('封面白名单：单层文件收', S.isSafeCoverRel('.books/.covers/ab12.jpg') === true)
check('封面白名单：只有目录拒', S.isSafeCoverRel('.books/.covers/') === false)
check('封面白名单：嵌套拒', S.isSafeCoverRel('.books/.covers/x/y.jpg') === false)
check('封面白名单：换目录拒', S.isSafeCoverRel('.covers/a.jpg') === false)
check('封面白名单：含 .. 拒', S.isSafeCoverRel('.books/.covers/..') === false)
check('封面文件名：hash 净化 + 小写', S.bookCoverRelFor('AB-cd_12', '.png') === '.books/.covers/abcd12.png')
check('封面文件名：空 hash → 空串', S.bookCoverRelFor('') === '')
check('封面文件名：非法 ext 回落 .jpg', S.bookCoverRelFor('abc', '.jp/g') === '.books/.covers/abc.jpg')

const metaStore = S.coerceBookMeta({ books: { 'books/a.epub': { title: 'A' }, 'books/b.epub': { title: 'B' }, 'bad//key': { title: 'C' } } })
check('元数据整壳：坏键丢弃', Object.keys(metaStore.books).join(',') === 'books/a.epub,books/b.epub')
const pruned = S.pruneOrphanMeta(metaStore, ['books/a.epub'])
check('剪枝：留下的对', Object.keys(pruned.store.books).join(',') === 'books/a.epub')
check('剪枝：removed 带出被删条目（供顺手删封面）', pruned.removed['books/b.epub']?.title === 'B')
check('剪枝：现存清单里的非规范键也能对上', Object.keys(S.pruneOrphanMeta(metaStore, ['./books/a.epub']).store.books).join(',') === 'books/a.epub')
check('剪枝：全空库不报错', Object.keys(S.pruneOrphanMeta(S.coerceBookMeta(null), []).store.books).length === 0)

// ===== ⑦ 文件名与显示名 =====
console.log('\n--- ⑦ 落盘文件名 / 显示名 ---')
check('文件名：作者 + 书名', S.safeBookFileName('鲁迅', '呐喊', '.epub') === '鲁迅 - 呐喊.epub')
check('文件名：无作者只留书名', S.safeBookFileName('', '呐喊', '.epub') === '呐喊.epub')
check('文件名：非法字符换 _', S.safeBookFileName('a/b', 'c:d?', '.pdf') === 'a_b - c_d_.pdf')
check('文件名：结尾的点被去掉（Windows 会静默吞）', S.safeBookFileName('', 'a.', '.txt') === 'a.txt')
check('文件名：空书名兜底', S.safeBookFileName('', '   ', '.epub') === '未命名书籍.epub')
check('文件名：ext 非形状 → 不带后缀', S.safeBookFileName('', 'a', 'epub') === 'a')
check('显示名：meta.title 优先', S.bookMetaDisplayName('books/a.epub', { title: '真名' }) === '真名')
check('显示名：无 meta 回落文件名', S.bookMetaDisplayName('books/a.epub', null) === 'a')
check('显示名：meta.title 空白视作没有', S.bookMetaDisplayName('books/a.epub', { title: '   ' }) === 'a')

// ===== ⑧ 落盘布局常量 =====
console.log('\n--- ⑧ 落盘布局常量自洽 ---')
check("BOOKS_DIR = '.books'", S.BOOKS_DIR === '.books')
check("BOOKS_COVERS_DIR = '.books/.covers'", S.BOOKS_COVERS_DIR === '.books/.covers')
check("BOOKS_META_FILE = '.meta.json'", S.BOOKS_META_FILE === '.meta.json')
check('封面目录 = BOOKS_DIR + /.covers', S.BOOKS_COVERS_DIR === `${S.BOOKS_DIR}/.covers`)

// ===== ⑨ 零依赖不变量 + 唯一写方（静态） =====
console.log('\n--- ⑨ 静态：零依赖不变量 / 唯一写方 / 凭据不出 IPC ---')
const schemaSrc = stripComments(readFileSync(join(ROOT, SCHEMA_REL), 'utf8'))
const runtimeImports = [...schemaSrc.matchAll(/\bimport\s+([^;]*?)\s+from\s+'[^']+'/g)]
  .map((m) => m[1].trim())
  .filter((clause) => !clause.startsWith('type'))
check('schema 无运行时 import（只有 import type 或没有）', runtimeImports.length === 0, runtimeImports.join(' | '))
check('schema 无 require()', !/\brequire\s*\(/.test(schemaSrc))

const files = walkSourceFiles(join(ROOT, 'electron')).concat(walkSourceFiles(join(ROOT, 'src')))
const scan = new Map()
for (const f of files) scan.set(f.replace(/\\/g, '/'), stripComments(readFileSync(f, 'utf8')))
const whoHas = (needle) => [...scan.entries()].filter(([, src]) => src.includes(needle)).map(([f]) => f.replace(`${ROOT.replace(/\\/g, '/')}/`, ''))

check("'.books' 字面量只出现在 schema（布局单源）", whoHas("'.books'").join(',') === SCHEMA_REL, whoHas("'.books'").join(','))
check("'.meta.json' 字面量只出现在 schema（消费方一律用常量）", whoHas("'.meta.json'").join(',') === SCHEMA_REL, whoHas("'.meta.json'").join(','))
check('元数据写方确实引用常量而非硬编码路径', /BOOKS_META_FILE/.test(scan.get(join(ROOT, META_REL).replace(/\\/g, '/')) ?? ''))
check("'bookSources.json' 只出现在书源写方（含密文文件，同属一个写方）", whoHas('bookSources.json').join(',') === REPO_REL, whoHas('bookSources.json').join(','))

const repoSrc = scan.get(join(ROOT, REPO_REL).replace(/\\/g, '/')) ?? ''
check('仓库层从不读凭据字段（无 .password / .token）', !/\.password\b/.test(repoSrc) && !/\.token\b/.test(repoSrc))
check('出 IPC 的源描述只报 hasCredential', /hasCredential\s*:/.test(repoSrc) && /export interface BookSourceInfo/.test(repoSrc))
const infoBlock = repoSrc.slice(repoSrc.indexOf('export interface BookSourceInfo'), repoSrc.indexOf('export interface BookSourceResult'))
check('BookSourceInfo 结构内不含凭据字段名', !/password|token|username/i.test(infoBlock), infoBlock.match(/password|token|username/i)?.[0] ?? '')

const scopeSrc = scan.get(join(ROOT, 'src/lib/dataChanged.ts').replace(/\\/g, '/')) ?? ''
check("DataChangeScope 已含 'bookMarket'", /DataChangeScope\s*=[^;]*'bookMarket'/.test(scopeSrc))

// ===== 结果 =====
console.log('\n========================================')
if (pass) {
  console.log('✅ book-market 数据层契约全部通过')
} else {
  console.log('❌ 有断言失败 —— 见上面的 fail 行')
}
process.exit(pass ? 0 : 1)
