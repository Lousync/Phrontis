// 契约验证：书市下载与上架（方案 §4.1–§4.3 / S3）。
//
// 探针 `probe-s3-download.cjs` 验**行为**（真请求、真字节、真广播），本脚本验**不会在运行时
// 显形的东西** —— 两处同值、唯一写方、凭据不出门、通道三处对齐、以及两个已经踩过的坑。
// 分工的原因：下载器 import electron，纯 node 里根本加载不起来，所以它的实现细节只能静态锁。
//
// 锁的九类：
//   ① **128MB 两处同值**（下载器 ↔ `EpubReaderView.tsx`）—— 不同值的表象是「下完了打不开」。
//   ② **S0 选型**：书市网络层零 `net.fetch`，且 `net.request` 只在 `netSession.ts` 出现一次。
//   ③ **布局口径**：`.books` / `.meta.json` / `.covers` 字面量不许在书市下载层另写一份。
//   ④ **凭据负向**：下载器里无凭据字段名、无 base64 拼装（凭据只能由 `authHeaderFor` 产出）。
//   ⑤ **广播口径**：队列快照通道在 windowBus 与 preload 各恰好一处，且写盘后确实广播 scope。
//   ⑥ **IPC 三处对齐**：每个 `bookMarket:*` 通道都有 preload 成员 / ElectronAPI 成员 / ipc.ts 包装。
//   ⑦ **续传真的发 `Range` 头**（★ 曾经漏发：`.part` 攒着字节、字节数也对，只是白下了一遍）。
//   ⑧ **半截文件不上架**：写 `.part`、rename 到书名、且 rename 必在写 meta 之前。
//   ⑨ 命名 / 封面路径口径走 schema 真函数（不是复制品）。
//
// 运行（仓库根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/book-market/verify-downloader.mjs
// 期望：全部 ok + exit=0

import { stripComments, walkSourceFiles } from '../shared/strip-comments.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const code = (rel) => stripComments(read(rel))
const has = (rel, re) => re.test(code(rel))

const DL_REL = 'electron/lib/bookMarket/downloader.ts'
const NET_REL = 'electron/lib/bookMarket/netSession.ts'
const BUS_REL = 'electron/main/windowBus.ts'
const PRELOAD_REL = 'electron/preload/index.ts'
const API_REL = 'src/types/index.ts'
const IPC_REL = 'src/lib/ipc.ts'
const REPO_REL = 'electron/database/repositories/bookMarketRepo.ts'
const READER_REL = 'src/components/shared/epub/EpubReaderView.tsx'
/** 装载闸（B-16 起体积上限的唯一真相源，零依赖叶子） */
const GATE_REL = 'electron/lib/kbStore/bookSizeGate.ts'
const SCHEMA_REL = 'electron/lib/kbStore/bookMarketSchema.ts'

// ===== ① 128MB 两处同值 =====
console.log('\n--- ① 体积上限：下载器 ↔ 阅读器装载闸（两处同值）---')
const LITERAL_RE = /MAX_BOOK_BYTES\s*=\s*([0-9*\s]+)/
const dlMax = (code(DL_REL).match(LITERAL_RE) ?? [])[1]
// ★ 2026-09-23 改靶：阅读器侧的体积上限**不再是**组件内的 `MAX_BOOK_BYTES`
//   （B-16「大书体积分档」已把阈值搬到零依赖叶子 `bookSizeGate.ts`：≤128MB 静默 / 128–384MB 确认 / >384MB 拒）。
//   断言意图不变 —— 「下载器能下到的书，阅读器必须装得下」，两处数值仍必须相等；
//   只是被测对象从组件常量换成装载闸的静默档。原先读 EpubReaderView 的写法在 B-16 后恒为 NaN（假红）。
const gateMax = (code(GATE_REL).match(/BOOK_SILENT_MAX\s*=\s*([0-9*\s]+)/) ?? [])[1]
const evalLiteral = (s) => (s ? s.split('*').reduce((a, b) => a * Number(b.trim()), 1) : NaN)
check('下载器有 MAX_BOOK_BYTES 常量', !!dlMax, dlMax ?? '未找到')
check('装载闸有 BOOK_SILENT_MAX 常量（静默档）', !!gateMax, gateMax ?? '未找到')
check('★ 两处同值（= 128MB）', evalLiteral(dlMax) === 128 * 1024 * 1024 && evalLiteral(dlMax) === evalLiteral(gateMax),
  `${evalLiteral(dlMax)} vs ${evalLiteral(gateMax)}`)
// ★ 2026-09-22 随 S4 挪窝：常量本体搬到**零依赖叶子** `bookMarketSchema.ts`
//   （下载器与 vaultBookMetaRepo 都要用它，留在 downloader.ts 会形成循环 import），
//   downloader 改为 re-export 保持既有引用面不变。所以断言改成「真源在 schema」+「下载器仍在用」。
check('封面上限常量真源在 schema（= 4MB，书的 1/32）', /MAX_COVER_BYTES\s*=\s*4\s*\*\s*1024\s*\*\s*1024/.test(code(SCHEMA_REL)))
check('封面上限常量从下载器 re-export（既有引用面不破）',
  /export\s*\{\s*MAX_COVER_BYTES\s*\}/.test(code(DL_REL)) && /fetchBinary\([^)]*MAX_COVER_BYTES/.test(code(DL_REL)))

// ===== ② S0 选型 =====
console.log('\n--- ② S0 选型：书市网络层零 net.fetch ---')
const bmFiles = walkSourceFiles(join(ROOT, 'electron/lib/bookMarket'))
const bmScan = new Map(bmFiles.map((f) => [f.replace(/\\/g, '/'), stripComments(readFileSync(f, 'utf8'))]))
const bmWho = (re) => [...bmScan.entries()].filter(([, src]) => re.test(src)).map(([f]) => f.replace(`${ROOT.replace(/\\/g, '/')}/`, ''))
check('★ 书市层无 net.fetch（代理会读到 defaultSession）', bmWho(/\bnet\.fetch\s*\(/).length === 0, bmWho(/\bnet\.fetch\s*\(/).join(','))
const reqWho = bmWho(/\bnet\.request\s*\(/)
check('net.request 只在 netSession（唯一入口）', reqWho.join(',') === NET_REL, reqWho.join(','))
check('下载器只经 openBookRequest 发请求', has(DL_REL, /import\s*\{[^}]*openBookRequest[^}]*\}\s*from\s*'\.\/netSession'/) && !/\bnet\.request\s*\(/.test(code(DL_REL)))
check('下载器不从 electron 引 net（只有 import type）', !/import\s*\{[^}]*\bnet\b[^}]*\}\s*from\s*'electron'/.test(code(DL_REL)))

// ===== ③ 布局口径 =====
console.log('\n--- ③ 布局口径：路径字面量不许在下载层另写一份 ---')
const dlSrc = code(DL_REL)
check("下载层无 '.books' 字面量（用 BOOKS_DIR）", !/['"`]\.books/.test(dlSrc) && /BOOKS_DIR/.test(dlSrc))
check("下载层无 '.meta.json' 字面量（写方专属）", !dlSrc.includes('.meta.json'))
check("下载层无 '.covers' 字面量（封面路径走 bookCoverRelFor）", !dlSrc.includes('.covers') && /bookCoverRelFor/.test(dlSrc))
check('封面文件名一律 .jpg（口径写死在 schema）', /bookCoverRelFor\(hash\)/.test(dlSrc))

// ===== ④ 凭据负向 =====
console.log('\n--- ④ 凭据负向：下载器里没有第二份凭据实现 ---')
check('无 password / token / username 字面量', !/["'`](password|token|username)["'`]/i.test(dlSrc))
check('无 base64 拼装（凭据只能由 authHeaderFor 产出）', !/toString\(['"]base64['"]\)/.test(dlSrc) && /authHeaderFor/.test(dlSrc))
check('Authorization 只从 authHeaderFor 的返回值挂', /headers\.Authorization\s*=\s*h\b/.test(dlSrc))
check('错误文案不含整个 URL（只拼 hostname）', !/new DownloadError\(`\$\{task\.url\}/.test(dlSrc))

// ===== ⑤ 广播口径 =====
console.log('\n--- ⑤ 广播：队列快照通道 + 写盘后广播 ---')
const busSrc = code(BUS_REL)
check('BROADCAST_CHANNEL 含 bookMarketDownloadProgress',
  /bookMarketDownloadProgress:\s*'bookMarket:download-progress'/.test(busSrc))
const preloadSrc = code(PRELOAD_REL)
const onHits = (preloadSrc.match(/ipcRenderer\.on\('bookMarket:download-progress'/g) ?? []).length
const offHits = (preloadSrc.match(/removeListener\('bookMarket:download-progress'/g) ?? []).length
// 判据是「订阅恰好一次且退订成对」，不是字面量出现次数 —— on / removeListener 各写一次字面量
// 是正常写法（同一个 `handler` 引用），把「2 次」判成错就是条错的断言
check('preload 里该通道订阅恰好 1 次、退订成对', onHits === 1 && offHits === 1, `on=${onHits} off=${offHits}`)
check('preload 暴露了订阅函数且返回退订', /onBookMarketDownloadProgress\s*:/.test(preloadSrc) && /return \(\) => \{ ipcRenderer\.removeListener/.test(preloadSrc))
check('下载器写盘后广播 scope=bookMarket', /broadcastDataChanged\(['"]bookMarket['"]\)/.test(dlSrc))
check('进度广播走 BROADCAST_CHANNEL 常量而非裸字面量',
  /BROADCAST_CHANNEL\.bookMarketDownloadProgress/.test(dlSrc) && !/send\(\s*['"]bookMarket:download-progress/.test(dlSrc))

// ===== ⑥ IPC 三处对齐 =====
console.log('\n--- ⑥ IPC 三处对齐：通道 ↔ preload ↔ ElectronAPI ↔ ipc.ts ---')
const repoSrc = code(REPO_REL)
const channels = [...new Set([...repoSrc.matchAll(/ipcMain\.handle\(\s*'(bookMarket:[A-Za-z]+)'/g)].map((m) => m[1]))]
const apiSrc = code(API_REL)
const ipcSrc = code(IPC_REL)
const memberOf = (channel) => `bookMarket${channel.split(':')[1][0].toUpperCase()}${channel.split(':')[1].slice(1)}`
// 2026-09-22 书市 S4：10 → 11 —— 新增**只读**的 `bookMarket:coverGet`（书架显示书市下到的
// 封面，S4 拍板 ①）。这条数字是「加通道要显式改这里」的闸门，不是许愿池：加通道请连注释一起改。
// 2026-09-23 删书：11 → 12 —— 新增 `bookMarket:deleteBook`（书架右键整本删除，写通道）。
check('通道数是 12（书源 5 + 检索 1 + 下载 3 + 队列 1 + 封面只读 1 + 删书 1）', channels.length === 12, channels.join(','))
for (const ch of channels) {
  const member = memberOf(ch)
  const ok = preloadSrc.includes(`ipcRenderer.invoke('${ch}'`)
    && new RegExp(`${member}\\s*:`).test(apiSrc)
    && new RegExp(`\\b${member}\\b`).test(ipcSrc)
  check(`通道 ${ch} → ${member} 三处齐`, ok,
    [!preloadSrc.includes(`ipcRenderer.invoke('${ch}'`) && 'preload 缺', !new RegExp(`${member}\\s*:`).test(apiSrc) && 'ElectronAPI 缺', !new RegExp(`\\b${member}\\b`).test(ipcSrc) && 'ipc.ts 缺'].filter(Boolean).join(' '))
}
check('写入类通道都广播 bookMarket scope', /broadcastDataChanged\(['"]bookMarket['"]\)/.test(repoSrc))
check('download 通道把 conflict 映射成 overwrite / copy', /'overwrite'|"overwrite"/.test(repoSrc) && /'copy'|"copy"/.test(repoSrc))
check('saveCredential 把 null 当「清空」', /bookSourceClearCredential/.test(repoSrc))

// ===== ⑦ 续传真的发 Range =====
console.log('\n--- ⑦ 续传：`Range` 头必须真的发出去 ---')
// ★ 这条是**实测逮到的回归**：`offset` 算出来了、`.part` 也按续传点追加，但请求里没带 Range
//   ⇒ 服务器从头传、我们按非 206 归零重写。表象是「文件对、字节数对、白下了一遍」，
//   除了服务端看到的东西以外没有任何可观测差异 —— 所以只能把「发 Range」写死成静态断言。
check('续传时拼 Range: bytes=N-', /reqHeaders\.Range\s*=\s*`bytes=\$\{startOffset\}-`/.test(dlSrc))
check('续传时声明 Accept-Encoding: identity（压缩会让偏移错位）', /reqHeaders\['Accept-Encoding'\]\s*=\s*'identity'/.test(dlSrc))
check('非 206 时归零重下（服务器不支持续传的兜底）', /startOffset\s*>\s*0\s*&&\s*status\s*!==\s*206/.test(dlSrc))
check('206 的 total 含续传前已有的字节', /status\s*===\s*206\s*\?\s*startOffset\s*\+\s*segTotal/.test(dlSrc))

// ===== ⑧ 半截文件不上架 =====
console.log('\n--- ⑧ 半截文件不上架：写 .part → rename → 写 meta ---')
check('★ 落盘目标是 `.part`（绝不直接写书名）', /destAbs:\s*task\.partAbs/.test(dlSrc))
check('没有直接往书名文件开写流', !/createWriteStream\(\s*task\.destAbs/.test(dlSrc))
check('成功后 rename 成正式书名', /renameSync\(task\.partAbs,\s*task\.destAbs\)/.test(dlSrc))
const renameAt = dlSrc.indexOf('renameSync(task.partAbs, task.destAbs)')
const metaAt = dlSrc.indexOf('bookMetaUpsert(')
check('★ rename 必在写 meta 之前（顺序换了 = 书架列出还没到位的书）', renameAt > 0 && metaAt > renameAt, `rename@${renameAt} meta@${metaAt}`)
check('取消时清掉半截 `.part`', /unlinkSync\(task\.partAbs\)/.test(dlSrc))
check('封面抓失败不抹掉上一版封面（不拿空串覆盖 coverRel）', /\.\.\.\(coverRel \? \{ coverRel \} : \{\}\)/.test(dlSrc))
check('换封面后回收旧封面（避免孤儿文件）', /bookCoverDelete\(prevCover\)/.test(dlSrc))
check('队列是内存态（不落盘：无 writeFileSync 到 jsonStore）', !/writeJsonOrThrow/.test(dlSrc))

// ===== ⑨ 命名与封面（走 schema 真函数）=====
console.log('\n--- ⑨ 命名闸与封面路径（schema 真函数）---')
const S = await import('../../../electron/lib/kbStore/bookMarketSchema.ts')
check('作者 + 书名 + 扩展名', S.safeBookFileName('鲁迅', '呐喊', '.epub') === '鲁迅 - 呐喊.epub')
check('作者为空 → 只留书名', S.safeBookFileName('', '只书名', '.epub') === '只书名.epub')
check('空书名回落「未命名书籍」', S.safeBookFileName('鲁迅', '   ', '.epub') === '鲁迅 - 未命名书籍.epub')
check('非法字符换 `_`、逗号不误伤',
  S.safeBookFileName('作者/甲', '含/非法:字符*的?书"名<>,|', '.epub') === '作者_甲 - 含_非法_字符_的_书_名__,_.epub',
  S.safeBookFileName('作者/甲', '含/非法:字符*的?书"名<>,|', '.epub'))
check('扩展名不是合法裸扩展名时不拼后缀', S.safeBookFileName('甲', '书', 'EPUB') === '甲 - 书')
check('封面相对路径 = .books/.covers/<hash>.jpg', S.bookCoverRelFor('abc123') === '.books/.covers/abc123.jpg')
check('封面 hash 里的非法字符被剥掉（防路径注入）', S.bookCoverRelFor('../../etc/passwd') === '.books/.covers/etcpasswd.jpg', S.bookCoverRelFor('../../etc/passwd'))
check('封面扩展名非法回落 .jpg', S.bookCoverRelFor('abc', '../x') === '.books/.covers/abc.jpg')
const F = await import('../../../electron/lib/kbStore/bookFormats.ts')
check('格式闸收 epub/pdf（BOOK_EXTS 口径）', F.bookExtOf('.epub') === '.epub' && F.bookExtOf('.pdf') === '.pdf')
check('格式闸拒 mobi（下得到的书必须书架点得开）', F.bookExtOf('.mobi') === null)

// ===== 结果 =====
console.log('\n========================================')
if (pass) {
  console.log('✅ 书市下载与上架契约全部通过')
} else {
  console.log('❌ 有断言失败 —— 见上面的 fail 行')
}
process.exit(pass ? 0 : 1)
