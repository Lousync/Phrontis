// 契约验证：书市 `bookMarket` 这个 DataChangeScope 的**双侧登记**（设计文档 §9 第 3 条 / 铁律 1、18）
//
// 分工：本脚本验**静态接线** —— 这条链路漏了就**静默降级**，不报错、只是界面不刷新：
//   ① 类型侧：`DataChangeScope` 联合里必须有 `'bookMarket'`（少了连编译都过不去，但仍锁一道）
//   ② 生产侧（主进程写盘后广播）：书源四个写 handler + downloader 落盘后，**各有一处**广播
//      —— 漏一处 = 那个操作改完界面不动（铁律 1：写盘必须 broadcastDataChanged）
//   ③ 消费侧（渲染层监听重拉）：书市模块挂 `useDataChanged('bookMarket')` 重拉三份清单；
//      **书架也要挂** —— 这是 §9 第 3 条点名的正向链路：「下载完成后书架能刷新」，
//      漏了它的表象正是铁律 18 那句「AI/主进程说下好了、书架里没有」
//   ④ 负向：广播只用 `broadcastDataChanged` 这一条通道，不自造 `data:notify` 语义（铁律 1）
//
// 为什么单独一个脚本（而非塞进 verify-book-sources.mjs 的一条正则）：
//   类型侧早先只在 S1 脚本里有一条正则，**消费侧零断言** —— 而那才是真正会静默失效的一半。
//   双侧分开成独立脚本，改 scope 协议时漏改哪一侧都能当场看见。
//
// 运行（仓库根目录）：
//   node .AGENT/scripts/book-market/verify-book-market-scope.mjs
// 期望：全部 ok + exit=0

import { stripComments } from '../shared/strip-comments.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const code = (rel) => stripComments(read(rel))

const SCOPE = 'bookMarket'
const DATA_CHANGED = 'src/lib/dataChanged.ts'
const REPO = 'electron/database/repositories/bookMarketRepo.ts'
const DOWNLOADER = 'electron/lib/bookMarket/downloader.ts'
const MARKET_UI = 'src/modules/bookmarket/index.tsx'
const BOOKSHELF = 'src/modules/bookshelf/index.tsx'

/** 统计某文件里 `broadcastDataChanged('bookMarket')` 的出现次数 */
const countBroadcast = (src) => (src.match(/broadcastDataChanged\(\s*'bookMarket'\s*\)/g) ?? []).length

/* ================= ① 类型侧：DataChangeScope 含 'bookMarket' ================= */
console.log('\n--- ① 类型侧（DataChangeScope 联合）---')
const sc = code(DATA_CHANGED)
check(`DataChangeScope 含 '${SCOPE}'`, new RegExp(`DataChangeScope\\s*=[^;]*'${SCOPE}'`).test(sc))

/* ================= ② 生产侧：写盘后广播 ================= */
console.log('\n--- ② 生产侧（主进程写盘后广播）---')
const repo = code(REPO)
// 书源四个写 handler：upsert / remove / setSourceEnabled / saveCredential —— 各恰一处广播
check('upsertSource 写盘后广播', /ipcMain\.handle\(\s*'bookMarket:upsertSource'[\s\S]*?broadcastDataChanged\(\s*'bookMarket'\s*\)/.test(repo))
check('removeSource 写盘后广播', /ipcMain\.handle\(\s*'bookMarket:removeSource'[\s\S]*?broadcastDataChanged\(\s*'bookMarket'\s*\)/.test(repo))
check('setSourceEnabled 写盘后广播', /ipcMain\.handle\(\s*'bookMarket:setSourceEnabled'[\s\S]*?broadcastDataChanged\(\s*'bookMarket'\s*\)/.test(repo))
check('saveCredential 写盘后广播', /ipcMain\.handle\(\s*'bookMarket:saveCredential'[\s\S]*?broadcastDataChanged\(\s*'bookMarket'\s*\)/.test(repo))
const repoBroadcasts = countBroadcast(repo)
check('书源层恰 4 处广播', repoBroadcasts === 4, `实得 ${repoBroadcasts}`)

const dl = code(DOWNLOADER)
const dlBroadcasts = countBroadcast(dl)
check('downloader 落盘后广播（下载完成 → 上架）', dlBroadcasts >= 1, `实得 ${dlBroadcasts}`)

/* ================= ③ 消费侧：两处订阅 ================= */
console.log('\n--- ③ 消费侧（渲染层监听重拉）---')
const market = code(MARKET_UI)
check("书市模块挂 useDataChanged('bookMarket')", /useDataChanged\(\s*'bookMarket'\s*,/.test(market))
// 消费回调必须真的重拉清单（否则「订阅了但什么也没做」= 照样不刷新）
const marketCb = market.match(/useDataChanged\(\s*'bookMarket'\s*,\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\}\)/)
check('书市订阅回调重拉源/队列/已上架', !!marketCb && /loadSources\(|loadQueue\(|loadInstalled\(/.test(marketCb[1]), marketCb ? marketCb[1].replace(/\s+/g, ' ').trim().slice(0, 80) : '抠不到回调')

const shelf = code(BOOKSHELF)
check("书架挂 useDataChanged('bookMarket')（下载完成即上新）", /useDataChanged\(\s*'bookMarket'\s*,/.test(shelf))
check('书架订阅回调重拉清单', /useDataChanged\(\s*'bookMarket'\s*,[\s\S]{0,120}?load\(\)/.test(shelf))

/* ================= ④ 负向：广播通道唯一 ================= */
console.log('\n--- ④ 负向（通道唯一性）---')
// 书市这两处生产方不得自造 data:notify 语义去刷新（铁律 1：data:notify 排除发送方，语义不同）
check('书市生产侧不自造 data:notify', !/data:notify/.test(repo) && !/data:notify/.test(dl))
// 渲染层不直接调用广播原语（应由主进程写盘方发）
check('渲染层书市模块不直接调 broadcastDataChanged', !/broadcastDataChanged/.test(market))

/* ================= 结果 ================= */
console.log('\n========================================')
if (pass) {
  console.log('✅ bookMarket scope 双侧登记契约全部通过')
} else {
  console.log('❌ 有断言失败 —— 见上面的 fail 行')
}
process.exit(pass ? 0 : 1)
