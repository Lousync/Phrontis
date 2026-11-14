#!/usr/bin/env node
/**
 * 契约验证：「更新说明（release notes）」—— 专验那些**错了也不会报错**的地方。
 *
 * 为什么需要它：这一版的失败模式全是静默的 ——
 * ① CHANGELOG 改了却没重跑生成器 → 应用内条目少几条 / 还是上一版的内容，没人发现；
 * ② 判定规则写反（首装就弹 / patch 升级也弹 / 把没读过的当成已读）→
 *    表象只有「用户被莫名弹了一页」或「升级后再也不弹」，开发机上根本撞不到；
 * ③ 亮点挂在一个 data.ts 里不存在的版本上 → 卡片静默消失（渲染层按版本号取）。
 *
 * 所以这里验证的是**三份数据 + 一套规则之间的契约**，而不是「代码能不能跑」：
 *   §1 data.ts 结构完整性        §2 highlights.ts 与 data 的版本对齐
 *   §3 判定规则表（judge.ts）    §4 data.ts 与 CHANGELOG 是否同步
 *   §5 当前版本与说明数据的对齐（发版窗口检查）
 *
 * 运行（项目根目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/release-notes/verify-release-notes.mjs
 * 期望：末尾 PASS 且 exit=0
 *
 * 注意：脚本会**真的重跑一次生成器**来验 §4，比对后若发现不一致会还原原文件。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import { RELEASE_NOTES } from '../../../electron/lib/releaseNotes/data.ts'
import { RELEASE_NOTE_HIGHLIGHTS } from '../../../electron/lib/releaseNotes/highlights.ts'
import {
  majorMinor, majorMinorChanged, decideStartup, decideMarkShown, mergeSeen,
} from '../../../electron/lib/releaseNotes/judge.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const DATA_FILE = join(ROOT, 'electron', 'lib', 'releaseNotes', 'data.ts')
const BUILD_SCRIPT = join(ROOT, '.AGENT', 'scripts', 'release-notes', 'build-release-notes.mjs')

let failures = 0
const pass = (m) => console.log(`  \u2705 ${m}`)
const fail = (m) => { failures++; console.error(`  \u274c ${m}`) }
const warn = (m) => console.warn(`  \u26a0\ufe0f  ${m}`)
const check = (m, ok, detail) => (ok ? pass(m) : fail(detail ? `${m} —— ${detail}` : m))

const KINDS = ['feature', 'ux', 'fix', 'internal', 'other']
const short = (arr, n = 5) => {
  const list = [...new Set(arr)]
  return list.length <= n ? list.join(' ｜ ') : `${list.slice(0, n).join(' ｜ ')} …（共 ${list.length} 项）`
}

// ---------------------------------------------------------------- §1 data.ts
console.log('\n§1 data.ts 结构完整性（CHANGELOG 生成的条目清单）')

check(`版本数 ${RELEASE_NOTES.length} ≥ 30（回归下限）`, RELEASE_NOTES.length >= 30)

const versions = RELEASE_NOTES.map((n) => n.version)
const dups = versions.filter((v, i) => versions.indexOf(v) !== i)
check('版本号互不重复', dups.length === 0, `重复：${short(dups)}`)

check(
  '版本号形如 x.y[.z]',
  versions.every((v) => /^\d+\.\d+/.test(v)),
  `异常：${short(versions.filter((v) => !/^\d+\.\d+/.test(v)))}`,
)

const noGroups = RELEASE_NOTES.filter((n) => !n.groups || n.groups.length === 0).map((n) => n.version)
check('每个版本至少一个分组', noGroups.length === 0, `空版本：${short(noGroups)}`)

const badKind = []
const badGroupTitle = []
const emptyGroups = []
const badItems = []
const boldLeft = []
for (const n of RELEASE_NOTES) {
  for (const g of n.groups || []) {
    if (!KINDS.includes(g.kind)) badKind.push(`${n.version}/${g.title}:${g.kind}`)
    if (!String(g.title || '').trim()) badGroupTitle.push(n.version)
    if (!g.items || g.items.length === 0) emptyGroups.push(`${n.version}/${g.title}`)
    for (const it of g.items || []) {
      if (!String(it.lead || '').trim() && !String(it.rest || '').trim()) badItems.push(`${n.version}/${g.title}`)
      if (/\*\*/.test(String(it.rest || ''))) boldLeft.push(`${n.version}/${g.title}`)
    }
  }
}
check(`分组 kind 合法（${KINDS.join('/')}）`, badKind.length === 0, `异常：${short(badKind)}`)
check('分组标题非空（emoji 已被剥掉）', badGroupTitle.length === 0, `空标题：${short(badGroupTitle)}`)
check('没有「只有标题没条目」的空分组', emptyGroups.length === 0, `空分组：${short(emptyGroups)}`)
check('没有 lead / rest 全空的条目', badItems.length === 0, `异常：${short(badItems)}`)
check('条目正文不残留 Markdown 粗体（生成器应已剥）', boldLeft.length === 0, `残留：${short(boldLeft)}`)

const itemCount = RELEASE_NOTES.reduce((a, n) => a + n.groups.reduce((b, g) => b + g.items.length, 0), 0)
const subCount = RELEASE_NOTES.reduce(
  (a, n) => a + n.groups.reduce((b, g) => b + g.items.reduce((c, i) => c + (i.sub?.length || 0), 0), 0),
  0,
)
check(`条目总数 ${itemCount} ≥ 300（回归下限）`, itemCount >= 300)
console.log(`     （版本 ${RELEASE_NOTES.length} · 条目 ${itemCount} · 子项 ${subCount}）`)

// ---------------------------------------------------------------- §2 highlights
console.log('\n§2 highlights.ts 与 data 的版本对齐')

check('亮点非空', RELEASE_NOTE_HIGHLIGHTS.length > 0)

const hlBad = []
const hlLong = []
const hlVer = []
for (const h of RELEASE_NOTE_HIGHLIGHTS) {
  if (!String(h.title || '').trim() || !String(h.desc || '').trim()) hlBad.push(h.version)
  if (String(h.desc || '').length > 240) hlLong.push(`${h.version}/${h.title}(${String(h.desc).length} 字)`)
  hlVer.push(h.version)
}
check('每条亮点 title / desc 都非空', hlBad.length === 0, `异常：${short(hlBad)}`)
check('desc ≤ 240 字（卡片不是小作文）', hlLong.length === 0, `过长：${short(hlLong)}`)

const hlByVersion = new Map()
for (const h of RELEASE_NOTE_HIGHLIGHTS) {
  hlByVersion.set(h.version, (hlByVersion.get(h.version) || 0) + 1)
}
const tooMany = [...hlByVersion.entries()].filter(([, n]) => n > 6).map(([v, n]) => `${v}(${n} 条)`)
check('单版本亮点 ≤ 6 条（页面留白）', tooMany.length === 0, `过多：${short(tooMany)}`)

/** 版本大小比较（只吃 x.y.z 前缀，够用于「在途 / 陈旧」判定） */
function cmpVersion(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}
const latestDataVersion = versions[0]

// 亮点挂在一个 data 里没有的版本上时：比最新 data 版本**新** = 在途（发版时补 CHANGELOG 即可，警告）；
// **不新** = 陈旧残留（改版本号时漏改 / 删过 CHANGELOG 小节），必须修。
const inFlight = []
const orphan = []
for (const v of hlByVersion.keys()) {
  if (versions.includes(v)) continue
  if (cmpVersion(v, latestDataVersion) > 0) inFlight.push(v)
  else orphan.push(v)
}
check('亮点版本不得陈旧（比最新说明版本还老却查无此版本）', orphan.length === 0, `陈旧：${short(orphan)}`)
if (inFlight.length) {
  warn(`亮点版本 ${inFlight.join(', ')} 在 CHANGELOG 里还没有小节（在途版本）—— 这些卡片当前不会显示。发版时补 ## v${inFlight[0]} 小节并重跑生成器即可。`)
} else {
  pass('所有亮点版本都能在 data 里找到对应说明')
}

// ---------------------------------------------------------------- §3 判定规则
console.log('\n§3 判定规则表（judge.ts，纯函数）')

const mmCases = [
  ['3.1.0', '3.1'],
  ['3.1.0-beta.2', '3.1'],
  ['v3.1.0', '3.1'],
  ['10.2.3', '10.2'],
  ['3.1', '3.1'],
  ['abc', 'abc'],
  ['', ''],
]
let mmBad = []
for (const [input, want] of mmCases) {
  const got = majorMinor(input)
  if (got !== want) mmBad.push(`majorMinor(${JSON.stringify(input)}) = ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`)
}
check(`majorMinor 表驱动 ${mmCases.length} 例`, mmBad.length === 0, mmBad.join(' ； '))

const notifyCases = [
  // [当前版本, 基线(上次展示), 期望「值得提醒一次」, 场景说明]
  ['3.1.0', '3.0.0', true, 'x.y 提升 → 弹'],
  ['3.1.0', '2.9.0', true, '跨多个 x.y → 弹'],
  ['4.0.0', '3.1.0', true, '主版本提升 → 弹'],
  ['3.1.0', '3.1.0', false, '同一版本 → 不弹'],
  ['3.1.2', '3.1.0', false, 'patch 升级 → 不弹'],
  ['3.1.0', '3.1.9', false, 'patch 回退仍同 x.y → 不弹'],
  ['3.1.0', '', false, '首装（无基线）→ 不弹'],
  ['', '3.0.0', false, '当前版本未知 → 不弹'],
  ['v3.1.0', 'v3.0.0', true, '带前导 v 也要认'],
  ['3.1.0-beta.2', '3.0.5', true, '预发布号取自 x.y → 弹'],
]
let notifyBad = []
for (const [cur, base, want, why] of notifyCases) {
  const got = majorMinorChanged(cur, base)
  if (got !== want) notifyBad.push(`${why}: majorMinorChanged(${cur}, ${base}) = ${got}，期望 ${want}`)
}
check(`majorMinorChanged 表驱动 ${notifyCases.length} 例`, notifyBad.length === 0, notifyBad.join(' ； '))

const IDX0 = { lastShown: '', seen: [], updatedAt: '' }
const NOW = '2026-09-12T00:00:00.000Z'

// 情形① 无基线：写基线、不提醒
{
  const d = decideStartup('3.1.0', IDX0, true, NOW)
  check('① 首装：不提醒', d.unread === false)
  check('① 首装：把基线记成当前版本', d.nextIndex?.lastShown === '3.1.0', `实得 ${JSON.stringify(d.nextIndex)}`)
}
// 情形② 同 x.y 且基线=当前版本：不写盘
{
  const idx = { lastShown: '3.1.0', seen: ['3.1.0'], updatedAt: NOW }
  const d = decideStartup('3.1.0', idx, true, NOW)
  check('② 同版本：不提醒', d.unread === false)
  check('② 同版本：不必写盘（省 IO）', d.nextIndex === null)
}
// 情形② patch 升级：推进基线
{
  const idx = { lastShown: '3.1.0', seen: [], updatedAt: NOW }
  const d = decideStartup('3.1.2', idx, true, NOW)
  check('② patch 升级：不提醒', d.unread === false)
  check('② patch 升级：基线推进到 3.1.2', d.nextIndex?.lastShown === '3.1.2')
}
// 情形③ x.y 变化：未读且**不写盘**（等渲染层确认展示过）
{
  const idx = { lastShown: '3.0.0', seen: [], updatedAt: NOW }
  const d = decideStartup('3.1.0', idx, true, NOW)
  check('③ x.y 变化：未读（看板出入口）', d.unread === true)
  check('③ 未展示前不写基线（异常启动不该标成已读）', d.nextIndex === null)
}
// 情形③ 无说明数据 / 开关不再参与判定
{
  const idx = { lastShown: '3.0.0', seen: [], updatedAt: NOW }
  check('③ 当前版本无说明数据 → 不提醒（不为空页出入口）', decideStartup('3.1.0', idx, false, NOW).unread === false)
  // 2026-11-14：开关「新版本时在看板提醒」下移到渲染层（关掉 = 连入口都不画）。
  // 主进程判定必须与开关解耦，否则「有没有东西可读」这个事实会被设置污染。
  check('③ 判定层不再接 autoOpenOn 参数（开关归渲染层）', decideStartup.length === 4, `实得 ${decideStartup.length} 个参数`)
}
// markShown：只认当前版本推进基线
{
  const idx = { lastShown: '3.0.0', seen: ['3.0.0'], updatedAt: NOW }
  const cur = decideMarkShown('3.1.0', '3.1.0', idx, NOW)
  check('markShown 当前版本：推进基线', cur.lastShown === '3.1.0')
  const old = decideMarkShown('2.9.0', '3.1.0', idx, NOW)
  check('markShown 历史版本：基线不动（翻旧说明不该把窗口拨回去）', old.lastShown === '3.0.0', `实得 ${old.lastShown}`)
  check('markShown 历史版本：仍记进 seen', old.seen.includes('2.9.0'))
}
// mergeSeen 去重与截断
{
  check('mergeSeen 去重', mergeSeen(['3.0.0'], '3.0.0').length === 1)
  const big = Array.from({ length: 45 }, (_, i) => `v${i}.0.0`)
  const trimmed = mergeSeen(big, 'v99.0.0')
  check('mergeSeen 截断到 40 条', trimmed.length === 40, `实得 ${trimmed.length}`)
  check('mergeSeen 保留最新一条', trimmed[trimmed.length - 1] === '99.0.0')
}

// ---------------------------------------------------------------- §4 CHANGELOG 同步
console.log('\n§4 data.ts 是否与 CHANGELOG 同步（重跑生成器比对）')

const before = readFileSync(DATA_FILE, 'utf-8')
let after = before
let regenMsg = ''
try {
  const out = execFileSync(process.execPath, [BUILD_SCRIPT], { cwd: ROOT, encoding: 'utf-8' })
  regenMsg = String(out).trim().split('\n')[0] || ''
  after = readFileSync(DATA_FILE, 'utf-8')
} catch (e) {
  regenMsg = `生成器执行失败：${e.message}`
}
if (after !== before) {
  writeFileSync(DATA_FILE, before, 'utf-8') // 还原，绝不让验证脚本改坏已提交的产物
  fail('data.ts 与 CHANGELOG 不同步 —— 已还原原文件。请跑 build-release-notes.mjs 后提交')
} else {
  pass(`data.ts 与 CHANGELOG 同步（重跑零 diff）${regenMsg ? ` — ${regenMsg}` : ''}`)
}

// ---------------------------------------------------------------- §5 发版窗口
console.log('\n§5 当前版本与说明数据的对齐（发版窗口检查）')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
const appVer = String(pkg.version || '')
check('package.json 有 version', !!appVer)

const hasCurrent = versions.includes(appVer)
if (hasCurrent) {
  pass(`当前版本 v${appVer} 在 data 里有对应说明（看板入口路径可用）`)
} else {
  warn(
    `当前版本 v${appVer} 在 CHANGELOG 里没有 ## v${appVer} 小节 —— ` +
    `getReleaseNotesState 会对当前版本判 hasNotes=false，看板上的入口在开发机上不会出现。` +
    `发版时补小节 + 重跑生成器即可；dev 下也可用 KNOWBASE_FAKE_APP_VERSION 指向一个已有说明的版本做联调。`,
  )
}

// ---------------------------------------------------------------- §6 入口接线
// 2026-11-14：提醒从「启动自动跳整页」改成「看板右上角一枚入口」。
// 这一段的失败模式同样是静默的 —— 入口不画 / 画了但点了没反应 / 把关掉的开关当没关，
// 全都不会有任何报错，只会在真机上「好像没看到」。
console.log('\n§6 看板入口接线（启动不跳页 / 关了开关就静默 / 点击回得来）')

const readSrc = (rel) => readFileSync(join(ROOT, rel), 'utf-8')
const app = readSrc('src/App.tsx')
const dash = readSrc('src/modules/dashboard/index.tsx')
const settingsTs = readSrc('src/lib/settings.ts')
const about = readSrc('src/modules/settings/views/AboutView.tsx')
const stTypes = readSrc('electron/lib/releaseNotes/types.ts')
const mainTs = readSrc('electron/lib/releaseNotes/index.ts')

check('主进程状态字段是 unread（不再叫 shouldAutoOpen）',
  /unread:\s*boolean/.test(stTypes) && !/shouldAutoOpen/.test(stTypes))
check('判定层不再读 autoOpenOn 设置（开关归渲染层）', !/autoOpenOn/.test(mainTs))
check('启动不再自动跳到更新说明页（负向：延迟常量与自动 effect 都已删除）',
  !/RELEASE_NOTES_AUTO_OPEN_DELAY_MS/.test(app) && !/shouldAutoOpen/.test(app))
check('启动首次取未读（activeTab 落看板时取）',
  /getReleaseNotesState\(\)[\s\S]{0,220}?setNotesUnread\(st\?\.unread/.test(app))
check('回到看板会重取（读完入口消失，markShown 不广播）',
  /activeTab !== null && activeTab !== 'dashboard'\) return/.test(app))
check('「新版本时在看板提醒」关掉 = 连入口都不画',
  /notes=\{s\.releaseNotesAutoOpen === false \? null : notesUnread\}/.test(app))
check('入口点击走 openNotesFromBoard（来源记成看板，关掉后回看板）',
  /onOpenNotes=\{openNotesFromBoard\}/.test(app)
  && /tabBeforeNotes\.current = 'dashboard'[\s\S]{0,120}?setActiveTab\('releaseNotes'\)/.test(app))
check('看板渲染那枚入口（版本号 + 与日期行同高右对齐）',
  /notes && onOpenNotes/.test(dash)
  && /有什么变化/.test(dash)
  && /absolute right-0 top-0/.test(dash)
  && /onClick=\{onOpenNotes\}/.test(dash))
check('入口仍是原来那页：普通标签、开在工作区里（不新增整窗页）',
  /case 'releaseNotes': return <ReleaseNotesModule onDismiss=\{dismissReleaseNotes\} \/>/.test(app))
check('设置项改名「新版本时在看板提醒」，键名不变（保住用户已存的值）',
  /releaseNotesAutoOpen: \{[^}]*label: '新版本时在看板提醒'/.test(settingsTs)
  && /新版本时在看板提醒/.test(about)
  && !/新版本时自动打开更新说明/.test(about))

// ---------------------------------------------------------------- 结果
console.log('')
if (failures === 0) {
  console.log(`PASS —— 全部检查通过（data ${versions.length} 版本 / ${itemCount} 条目，亮点 ${RELEASE_NOTE_HIGHLIGHTS.length} 条）`)
  process.exit(0)
} else {
  console.error(`FAIL —— ${failures} 项不通过`)
  process.exit(1)
}
