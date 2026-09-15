// 契约验证：层级总结（周 / 月 / 年）的窗口口径、文件命名与目录隔离。
//
// 为什么需要它：这条链路有三处**会静默出错**的地方——
//
//   ① 窗口口径错一格：磁贴点「W34」算出的窗口与落盘文件名对不上 → 用户点第二次又生成一份，
//      日历上哪一周对应哪个文件再也说不清。跨年周（12-29 ~ 01-04）是最容易错的那一格。
//   ② 命名不唯一：省略年份的格式会让 `2026-08-17_08-23` 与 `2025-08-17_08-23` 撞车。
//   ③ 目录隔离漏一处：总结文件同样带 frontmatter.id，一旦被日志扫描收走，
//      它们会静默混进博客列表 / 标签聚合 / 全文搜索 —— 不报错，只是列表里多出几篇「没有日期的日记」。
//
// 所以本脚本**切片真实实现**（`src/lib/summary.ts` 与 `electron/lib/kbStore/blogVaultRepo.ts`，
// 只把 `vaultContext` 换成指向临时仓库的 stub），在真实文件系统上跑。
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/blog-summary/verify-summary-files.mjs
// 期望：输出 PASS 且 exit=0

import { stripTypeScriptTypes } from 'node:module'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 真实纯函数（无 electron 依赖，可直接引）
import {
  weekRangeOf, monthRangeOf, yearRangeOf, isoWeekNo, mondayOf,
  summaryFileKey, summaryFileName, summaryLabel, summaryWindowsAt,
} from '../../../src/lib/summary.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const TMP = join(HERE, 'tmp')
const VAULT = join(TMP, 'vault')
const BLOG = join(VAULT, '.knowbase', 'blog')

const checks = []
function ok(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail ?? '' })
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(name, a === e, a === e ? '' : `实际 ${a} ≠ 期望 ${e}`)
}

/* ---------------- 1. 窗口口径（日历口径） ---------------- */

eq('自然周：周三 → 周一~周日', weekRangeOf('2026-08-19'), { start: '2026-08-17', end: '2026-08-23' })
eq('自然周：周一自身 → 同一周', weekRangeOf('2026-08-17'), { start: '2026-08-17', end: '2026-08-23' })
eq('自然周：周日 → 仍是本周（不是下周）', weekRangeOf('2026-08-23'), { start: '2026-08-17', end: '2026-08-23' })
eq('跨年周：2026-01-01 → 2025-12-29 ~ 2026-01-04', weekRangeOf('2026-01-01'), { start: '2025-12-29', end: '2026-01-04' })
eq('跨年周：2025-12-31 同属该周', weekRangeOf('2025-12-31'), { start: '2025-12-29', end: '2026-01-04' })
eq('mondayOf 与 weekRangeOf 同源', mondayOf('2026-08-19'), '2026-08-17')
eq('自然月：2026-08', monthRangeOf(2026, 8), { start: '2026-08-01', end: '2026-08-31' })
eq('自然月：闰年 2 月 29 天', monthRangeOf(2028, 2), { start: '2028-02-01', end: '2028-02-29' })
eq('自然月：平年 2 月 28 天', monthRangeOf(2027, 2), { start: '2027-02-01', end: '2027-02-28' })
eq('自然年', yearRangeOf(2026), { start: '2026-01-01', end: '2026-12-31' })
eq('ISO 周号：2026-08-19 → 第 34 周', isoWeekNo('2026-08-19'), 34)
eq('ISO 周号：跨年周归属下一年第 1 周', isoWeekNo('2026-01-01'), 1)

/* ---------------- 2. 命名：同窗口幂等、不同窗口必不同 ---------------- */

eq('周文件名', summaryFileName('week', '2026-08-17', '2026-08-23'), 'summary-week-2026-08-17_2026-08-23.md')
eq('月文件名', summaryFileName('month', '2026-08-01', '2026-08-31'), 'summary-month-2026-08-01_2026-08-31.md')
eq('年文件名', summaryFileName('year', '2026-01-01', '2026-12-31'), 'summary-year-2026-01-01_2026-12-31.md')
ok('同名幂等（同窗口两次调用同一 key）',
  summaryFileKey('week', '2026-08-17', '2026-08-23') === summaryFileKey('week', '2026-08-17', '2026-08-23'))
ok('跨年周不与其他年同月日撞车（带完整年份的意义）',
  summaryFileKey('week', '2025-12-29', '2026-01-04') !== summaryFileKey('week', '2026-12-29', '2027-01-04'))
ok('非整月窗口（月总结 fixed 模式）也能唯一表达',
  summaryFileName('month', '2026-07-17', '2026-08-15') !== summaryFileName('month', '2026-08-01', '2026-08-31'))

/* ---------------- 3. 标题 ---------------- */

eq('整月标题', summaryLabel('month', '2026-08-01', '2026-08-31'), '2026年8月月总结')
eq('非整月标题带区间', summaryLabel('month', '2026-07-17', '2026-08-15'), '月总结(2026-07-17 ~ 2026-08-15)')
eq('同年周标题', summaryLabel('week', '2026-08-17', '2026-08-23'), '周总结(08.17 ~ 08.23)')
eq('跨年周标题带完整年份', summaryLabel('week', '2025-12-29', '2026-01-04'), '周总结(2025-12-29 ~ 2026-01-04)')
eq('年标题', summaryLabel('year', '2026-01-01', '2026-12-31'), '2026年年度总结')

/* ---------------- 4. 磁贴入口三档与日历口径一致 ---------------- */

const wins = summaryWindowsAt('2026-08-19')
eq('三档 kind 顺序', wins.map((w) => w.kind), ['week', 'month', 'year'])
eq('三档窗口', wins.map((w) => `${w.start}~${w.end}`), [
  '2026-08-17~2026-08-23', '2026-08-01~2026-08-31', '2026-01-01~2026-12-31',
])

/* ---------------- 5. 落盘：目录隔离 + 防重（切片真实实现） ---------------- */

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

/** 源码切片：删类型 + 把同目录相对依赖指向本目录（`.mjs`），electron 侧上下文换成 stub */
function slice(relPath, outName, rewrites = []) {
  let src = readFileSync(join(ROOT, relPath), 'utf-8')
  for (const [from, to] of rewrites) src = src.replace(from, to)
  writeFileSync(join(TMP, outName), stripTypeScriptTypes(src, { mode: 'transform' }), 'utf-8')
}

writeFileSync(join(TMP, 'vaultContext.mjs'), `
let current = null
export function __setVault(rootPath) { current = { rootId: 'probe', name: 'probe', rootPath } }
export function getCurrentVault() { return current }
export function getVaultKbRoot() { return current ? current.rootPath + '/.knowbase' : null }
`, 'utf-8')

slice('src/lib/summary.ts', 'summary.mjs')
slice('electron/lib/kbStore/mdStore.ts', 'mdStore.mjs', [
  [/from '\.\/vaultContext'/, "from './vaultContext.mjs'"],
])
slice('electron/lib/kbStore/blogVaultRepo.ts', 'blogVaultRepo.mjs', [
  [/from '\.\/vaultContext'/, "from './vaultContext.mjs'"],
  [/from '\.\/mdStore'/, "from './mdStore.mjs'"],
  [/import \{ summaryFileName, summaryLabel, type SummaryKind \} from '[^']*'/, "import { summaryFileName, summaryLabel } from './summary.mjs'"],
])

// 夹具：一篇日志 + 一份「别的窗口」的旧总结（前者应被日志扫描看到，后者绝不可以）
mkdirSync(join(BLOG, '2026'), { recursive: true })
mkdirSync(join(BLOG, 'summaries'), { recursive: true })
writeFileSync(join(BLOG, '2026', '2026-08-19.md'), [
  '---',
  'id: log-2026-08-19',
  'title: 2026-08-19',
  'date: 2026-08-19',
  'created: 2026-08-19T10:00:00.000Z',
  'tags: [日记]',
  '---',
  '',
  '今天的日志正文',
].join('\n'), 'utf-8')
writeFileSync(join(BLOG, 'summaries', 'legacy-week.md'), [
  '---',
  'id: legacy-sum-1',
  'kind: week',
  'start: 2026-08-10',
  'end: 2026-08-16',
  'title: 周总结(08.10 ~ 08.16)',
  'created: 2026-08-16T10:00:00.000Z',
  'tags: [旧总结标签]',
  '---',
  '',
  '旧总结正文',
].join('\n'), 'utf-8')

const ctx = await import(pathToFileURL(join(TMP, 'vaultContext.mjs')).href)
ctx.__setVault(VAULT)
const repo = await import(pathToFileURL(join(TMP, 'blogVaultRepo.mjs')).href)

// 5.1 隔离：总结不进日志列表 / 搜索 / 标签
const entries = repo.vaultListEntries()
eq('日志列表只有 1 篇（总结没被收走）', entries.length, 1)
eq('日志列表是那篇日志', entries[0]?.date, '2026-08-19')
ok('搜索命中不到总结文件', repo.vaultSearchEntries('旧总结').length === 0, `命中 ${repo.vaultSearchEntries('旧总结').length} 条`)
eq('标签聚合不含总结里的标签', repo.vaultBlogTags().map((t) => t.name), ['日记'])

// 5.2 按需生成：同窗口幂等
const w1 = repo.vaultEnsureSummary('week', '2026-08-17', '2026-08-23')
ok('周总结落到约定文件名', existsSync(join(BLOG, 'summaries', 'summary-week-2026-08-17_2026-08-23.md')))
eq('周总结 frontmatter 窗口字段', [w1.kind, w1.start, w1.end], ['week', '2026-08-17', '2026-08-23'])
eq('周总结标题由窗口推出', w1.title, '周总结(08.17 ~ 08.23)')
ok('新总结正文为空（不堆模板）', w1.contentMd === '')

const before = readdirSync(join(BLOG, 'summaries')).length
const w2 = repo.vaultEnsureSummary('week', '2026-08-17', '2026-08-23')
ok('同窗口二次生成：同一份', w2.id === w1.id, `${w1.id} vs ${w2.id}`)
eq('同窗口二次生成：文件数不变', readdirSync(join(BLOG, 'summaries')).length, before)

const m1 = repo.vaultEnsureSummary('month', '2026-08-01', '2026-08-31')
const y1 = repo.vaultEnsureSummary('year', '2026-01-01', '2026-12-31')
ok('月总结落到约定文件名', existsSync(join(BLOG, 'summaries', 'summary-month-2026-08-01_2026-08-31.md')))
ok('年总结落到约定文件名', existsSync(join(BLOG, 'summaries', 'summary-year-2026-01-01_2026-12-31.md')))
ok('三类总结 id 互不相同', new Set([w1.id, m1.id, y1.id]).size === 3)

// 5.3 正文回写：读回来必须一致
const saved = repo.vaultUpdateSummary(w1.id, { contentMd: '本周复盘：\n- 一件事' })
eq('保存后正文一致', saved.contentMd, '本周复盘：\n- 一件事')
eq('按 id 取回一致', repo.vaultGetSummaryById(w1.id)?.contentMd, '本周复盘：\n- 一件事')
ok('保存后 updatedAt 被刷新', saved.updatedAt >= w1.updatedAt)

// 5.4 列表：倒序 + 只认字段齐全的文件
const list = repo.vaultListSummaries()
eq('列表含 4 份（3 新建 + 1 旧）', list.length, 4)
ok('列表按窗口起点倒序', list.every((s, i) => i === 0 || list[i - 1].start >= s.start), list.map((s) => s.start).join(' > '))

// 5.5 半成品（有文件无 id）→ 补 id 写回，不另建文件
writeFileSync(join(BLOG, 'summaries', 'summary-month-2026-07-01_2026-07-31.md'), [
  '---',
  'title: 手搓的七月总结',
  '---',
  '',
  '我手写的正文',
].join('\n'), 'utf-8')
const fixed = repo.vaultEnsureSummary('month', '2026-07-01', '2026-07-31')
ok('半成品补 id 而不是另建文件', !!fixed.id && fixed.start === '2026-07-01' && fixed.end === '2026-07-31')
eq('半成品正文未丢', fixed.contentMd.trim(), '我手写的正文')
eq('补 id 后该窗口仍只有一份', repo.vaultListSummaries().filter((s) => s.start === '2026-07-01').length, 1)

rmSync(TMP, { recursive: true, force: true })

/* ---------------- 输出 ---------------- */

let failed = 0
for (const c of checks) {
  if (!c.pass) failed++
  console.log(`${c.pass ? 'ok  ' : 'FAIL'} ${c.name}${c.pass || !c.detail ? '' : '  → ' + c.detail}`)
}
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${checks.length - failed}/${checks.length}`)
process.exit(failed === 0 ? 0 : 1)
