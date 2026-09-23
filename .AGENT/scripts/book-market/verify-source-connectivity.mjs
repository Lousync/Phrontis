// 契约验证：书源连通性四态（F-6，2026-09-23）。
//
// 背景：原三态把「配置缺凭据」与「服务端 401/403 拒绝」合并成一个 `need-credential`，
//   导致渲染层同一行同时显示「无需登录」（配置声明）与「需要凭据」（探测结果）——
//   两个不同维度撞了同一个词。F-6 拆成四态：401 → need-credential，403 → forbidden。
//
// 为什么用静态断言而不是 import 真实实现：
//   `sourceClient.ts` 有运行时 import（`./netSession` 依赖 electron session），
//   strip-types 跑不起来（Cannot find module）。故本脚本锁**源码结构与映射表**，
//   运行期判据在 `probe-s2-search.cjs` 的 ③b 段（需裸 electron，见该文件头注）。
//
// 运行（仓库根目录）：
//   node .AGENT/scripts/book-market/verify-source-connectivity.mjs
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
const read = (rel) => stripComments(readFileSync(join(ROOT, rel), 'utf8'))

const SC = 'electron/lib/bookMarket/sourceClient.ts'
const TYPES = 'src/types/index.ts'
const SHARED = 'src/modules/bookmarket/shared.ts'
const IDX = 'src/modules/bookmarket/index.tsx'
const FORM = 'src/modules/bookmarket/SourceFormSheet.tsx'
const PROBE = '.AGENT/scripts/book-market/probe-s2-search.cjs'

const sc = read(SC)

console.log('\n--- ① 四态类型：主进程与渲染层两侧同步 ---')
const STATES = ['ok', 'need-credential', 'forbidden', 'fail']
const mainType = (sc.match(/export type SourceConnectivity = ([^\n]+)/) || [])[1] || ''
const uiType = (read(TYPES).match(/export type BookSourceConnectivity = ([^\n]+)/) || [])[1] || ''
for (const s of STATES) {
  check(`主进程 SourceConnectivity 含 '${s}'`, mainType.includes(`'${s}'`), mainType.trim())
}
for (const s of STATES) {
  check(`渲染层 BookSourceConnectivity 含 '${s}'`, uiType.includes(`'${s}'`), uiType.trim())
}

console.log('\n--- ② classifyStatus 映射（401 / 403 必须分开） ---')
const csBody = (sc.match(/export function classifyStatus\(status: number\): SourceConnectivity \{([\s\S]*?)\n\}/) || [])[1] || ''
check('401 → need-credential', /status === 401\)\s*return 'need-credential'/.test(csBody), csBody.replace(/\s+/g, ' ').trim().slice(0, 90))
check('403 → forbidden（**不再**与 401 合并）', /status === 403\)\s*return 'forbidden'/.test(csBody))
check('★ 负向：没有把 401/403 写在同一个 if 里（拆分的核心断言）',
  !/status === 401 \|\| status === 403/.test(csBody))
check('其余 → fail', /return 'fail'/.test(csBody))

console.log('\n--- ③ 原因文案：两条都要有且不撞词 ---')
check(`REASON_NEED_CREDENTIAL = '需要凭据'`, /REASON_NEED_CREDENTIAL = '需要凭据'/.test(sc))
check(`REASON_FORBIDDEN = '访问被拒'（与「需要凭据」区分）`, /REASON_FORBIDDEN = '访问被拒'/.test(sc))
const roBody = (sc.match(/export function reasonOf\([\s\S]*?\n\}/) || [])[0] || ''
check('reasonOf 覆盖 need-credential', /need-credential'\)\s*return REASON_NEED_CREDENTIAL/.test(roBody))
check('reasonOf 覆盖 forbidden', /forbidden'\)\s*return REASON_FORBIDDEN/.test(roBody))

console.log('\n--- ④ 渲染层 CONN_META 必须有 forbidden 条目（漏了 = 状态变了但界面没文案） ---')
const meta = read(SHARED)
for (const s of STATES) {
  check(`CONN_META 含 '${s}'`, new RegExp(`['"]?${s}['"]?\\s*:\\s*\\{`).test(meta) || new RegExp(`^\\s*${s}:\\s*\\{`, 'm').test(meta))
}
check(`CONN_META.forbidden 文案 = '访问被拒'`, /forbidden:\s*\{[^}]*label:\s*'访问被拒'/.test(meta))

console.log('\n--- ⑤ UI 三元判断必须补上 forbidden（漏 case = 静默显示「连接失败」） ---')
const idx = read(IDX)
const form = read(FORM)
check('index.tsx 的 toast 分支含 forbidden', /forbidden/.test(idx))
check('SourceFormSheet 的保存 toast 分支含 forbidden', /forbidden/.test(form))

console.log('\n--- ⑥ 运行期判据在场（探针 ③b 段） ---')
const prob = readFileSync(join(ROOT, PROBE), 'utf8')
check('探针 mock 有 /opds/403 路由', /case '\/opds\/403':\s*return finish\(403/.test(prob))
check('探针断言 403 → forbidden', /403 → 三态 forbidden/.test(prob))
check('探针断言 403 原因文案 =「访问被拒」', /原因文案 =「访问被拒」/.test(prob))
check('探针断言 403 不重试', /403 \*\*不重试\*\*/.test(prob))

console.log('\n' + '='.repeat(40))
console.log(pass ? '✅ 书源连通性四态契约全部通过' : '❌ 有断言失败 —— 见上面的 fail 行')
process.exit(pass ? 0 : 1)
