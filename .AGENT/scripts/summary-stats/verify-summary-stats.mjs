// 契约验证：周 / 月 / 年总结面板的统计口径（v3.2.0 条目 13）
//
// 为什么需要它：这条链路有三处**会静默出错**的地方 ——
//   ① 「新建知识页」原实现取 `getKnowledgeIndex().pages.length`，与窗口无关 ——
//      看周总结永远显示全库页数。不报错、不崩，只有对账才能发现。
//   ② flexible（每周 N 次）没有「计划日」，完成率若照搬「已打卡 ÷ 计划日」会恒等于 100%。
//   ③ 最长连续：非计划日必须「跳过且不断」，否则每周一三五的习惯永远显示 1 天。
//
// 所以本脚本**切片真实实现**（`electron/lib/kbStore/habitStats.ts`，零依赖纯函数），
// 不照抄算法；跨线类型同步与旧写法残留另用源码探针断言（负向一律先剥注释）。
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/summary-stats/verify-summary-stats.mjs
// 期望：输出 PASS 且 exit=0

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../shared/strip-comments.mjs'

import {
  habitPeriodStats, checkinTotalInWindow, parseRuleDays,
} from '../../../electron/lib/kbStore/habitStats.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

const checks = []
function ok(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail ?? '' })
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(name, a === e, a === e ? '' : `实际 ${a} ≠ 期望 ${e}`)
}
/** 取某个习惯的明细（找不到返回 null） */
function statOf(list, id) {
  return list.find((s) => s.id === id) ?? null
}

/* ---------------- 1. 基线窗口：2026-08-17（周一）~ 2026-08-23（周日） ---------------- */

const START = '2026-08-17'
const END = '2026-08-23'

const habits = [
  { id: 'h1', name: '每天阅读', color: '#111', rule_type: 'daily', rule_days: '[]', weekly_target: 0, archived: 0 },
  { id: 'h2', name: '每天跑步', color: '#222', rule_type: 'daily', rule_days: '[]', weekly_target: 0, archived: 0 },
  { id: 'h3', name: '工作日复盘', color: '#333', rule_type: 'weekdays', rule_days: '[1,2,3,4,5]', weekly_target: 0, archived: 0 },
  { id: 'h4', name: '弹性健身', color: '#444', rule_type: 'flexible', rule_days: '[]', weekly_target: 3, archived: 0 },
  { id: 'h5', name: '未设计划日', color: '#555', rule_type: 'weekdays', rule_days: '[]', weekly_target: 0, archived: 0 },
  { id: 'h6', name: '已归档且当期没打卡', color: '#666', rule_type: 'daily', rule_days: '[]', weekly_target: 0, archived: 1 },
  { id: 'h7', name: '已归档但当期打过', color: '#777', rule_type: 'daily', rule_days: '[]', weekly_target: 0, archived: 1 },
]

const rec = (habitId, date) => ({ id: `${habitId}-${date}`, habit_id: habitId, date, source: 'manual' })
const records = [
  // h1：窗口内全勤 7 天；另加两条窗口外记录（应被裁掉）
  ...['08-17', '08-18', '08-19', '08-20', '08-21', '08-22', '08-23'].map((d) => rec('h1', `2026-${d}`)),
  rec('h1', '2026-08-16'), rec('h1', '2026-08-24'),
  // h2：漏了 08-20 与 08-23 → 最长连续 3（17/18/19）
  rec('h2', '2026-08-17'), rec('h2', '2026-08-18'), rec('h2', '2026-08-19'),
  rec('h2', '2026-08-21'), rec('h2', '2026-08-22'),
  // h3：工作日前四天打卡，漏周五 → 周六周日是非计划日，**不该把连续打断**
  rec('h3', '2026-08-17'), rec('h3', '2026-08-18'), rec('h3', '2026-08-19'), rec('h3', '2026-08-21'),
  // h4：弹性，打了 2 次
  rec('h4', '2026-08-17'), rec('h4', '2026-08-18'),
  // h5：weekdays 但 rule_days 为空 → 无计划日
  rec('h5', '2026-08-19'),
  // h6：归档 + 当期零记录 → 不出现
  // h7：归档但当期打过 1 次 → 应出现
  rec('h7', '2026-08-20'),
]

const stats = habitPeriodStats(habits, records, START, END)

const h1 = statOf(stats, 'h1')
eq('daily 全勤：次数 7（窗口外的两条不算）', h1?.count, 7)
eq('daily 全勤：计划日 7', h1?.planned, 7)
eq('daily 全勤：完成率 100%', h1?.rate, 100)
eq('daily 全勤：最长连续 7', h1?.longest, 7)

const h2 = statOf(stats, 'h2')
eq('daily 漏 2 天：次数 5', h2?.count, 5)
eq('daily 漏 2 天：完成率 71%（5/7 四舍五入）', h2?.rate, 71)
eq('daily 漏 2 天：最长连续 3', h2?.longest, 3)

const h3 = statOf(stats, 'h3')
eq('weekdays：计划日只算规则日（5 天，不含周末）', h3?.planned, 5)
eq('weekdays：完成率 80%（4/5）', h3?.rate, 80)
eq('weekdays：最长连续 3（周末非计划日不断档）', h3?.longest, 3)

const h4 = statOf(stats, 'h4')
eq('flexible：不以计划日作分母（planned 恒 0）', h4?.planned, 0)
eq('flexible：完成率按 每周目标 3 × 整周数 1 = 3（2/3 → 67%）', h4?.rate, 67)
eq('flexible：次数 2', h4?.count, 2)
eq('flexible：最长连续 2', h4?.longest, 2)

const h5 = statOf(stats, 'h5')
eq('无计划日的 weekdays：完成率为 null（不谎报 0%）', h5?.rate, null)
eq('无计划日的 weekdays：次数照实 1', h5?.count, 1)

ok('归档且当期零记录 → 不出现在明细里', statOf(stats, 'h6') === null)
ok('归档但当期打过卡 → 仍出现在明细里（历史窗口如实反映）', statOf(stats, 'h7') !== null)
eq('明细条目数 = 7 个习惯 − 1 个零记录归档', stats.length, 6)

// 明细求和 vs 总数：两处若各扫一次记录库，这里就会对不上
const sumCount = stats.reduce((s, x) => s + x.count, 0)
eq('明细次数求和 == 窗口内打卡总数（同源印证）', sumCount, checkinTotalInWindow(records, START, END))
eq('窗口内打卡总数 = 20（22 条记录 − 2 条窗口外）', checkinTotalInWindow(records, START, END), 20)

/* ---------------- 2. 其它窗口形状：闰月 / 单日 / 跨月 ---------------- */

const leapHabits = [
  { id: 'd', name: 'daily', color: '#1', rule_type: 'daily', rule_days: '[]', weekly_target: 0, archived: 0 },
  { id: 'f', name: 'flex', color: '#2', rule_type: 'flexible', rule_days: '[]', weekly_target: 3, archived: 0 },
]
const leapRec = []
for (let d = 1; d <= 29; d++) leapRec.push(rec('d', `2028-02-${String(d).padStart(2, '0')}`))
for (const d of ['01', '02', '03', '04', '05', '06']) leapRec.push(rec('f', `2028-02-${d}`))

const leap = habitPeriodStats(leapHabits, leapRec, '2028-02-01', '2028-02-29')
eq('闰年 2 月 29 天：daily 计划日 29', statOf(leap, 'd')?.planned, 29)
eq('闰年 2 月 29 天：daily 次数 29', statOf(leap, 'd')?.count, 29)
eq('闰年 2 月 29 天：daily 完成率 100%', statOf(leap, 'd')?.rate, 100)
// 29 天 → 整周数 4 → 目标 3×4=12，打 6 次 → 50%
eq('flexible 的整周数按 floor(29/7)=4（目标 12）', statOf(leap, 'f')?.rate, 50)

const oneDay = habitPeriodStats(
  [{ id: 'x', name: 'x', color: '#1', rule_type: 'flexible', rule_days: '[]', weekly_target: 5, archived: 0 }],
  [rec('x', '2026-08-17')],
  '2026-08-17', '2026-08-17',
)
eq('单日窗口：不足一周按一周算（目标 5 而非 0）', statOf(oneDay, 'x')?.rate, 20)

const crossMonth = habitPeriodStats(
  [{ id: 'y', name: 'y', color: '#1', rule_type: 'daily', rule_days: '[]', weekly_target: 0, archived: 0 }],
  [rec('y', '2026-07-31'), rec('y', '2026-08-01')],
  '2026-07-15', '2026-08-15',
)
eq('跨月窗口：两端各命中一次', statOf(crossMonth, 'y')?.count, 2)
eq('跨月窗口：计划日 32 天', statOf(crossMonth, 'y')?.planned, 32)

/* ---------------- 3. 边界与容错 ---------------- */

eq('end < start → 空数组（不抛错）', habitPeriodStats(habits, records, '2026-08-24', '2026-08-17'), [])
eq('日期格式非法 → 空数组', habitPeriodStats(habits, records, '2026/08/17', '2026-08-23'), [])
eq('无习惯 → 空数组', habitPeriodStats([], records, START, END), [])
eq('无记录 → 各项为 0 / null', (() => {
  const r = habitPeriodStats([habits[0]], [], START, END)
  return [r[0].count, r[0].planned, r[0].rate, r[0].longest]
})(), [0, 7, 0, 0])
eq('窗口内打卡次数为 0 的 non-flexible：完成率是 0 而不是 null', (() => {
  const r = habitPeriodStats([habits[0]], [], START, END)
  return r[0].rate
})(), 0)
ok('脏记录（缺 date / 日期非法）不会让整次统计抛错', (() => {
  try {
    habitPeriodStats([habits[0]], [{ habit_id: 'h1' }, { habit_id: 'h1', date: 'nope' }, null], START, END)
    return true
  } catch { return false }
})())

eq('parseRuleDays：空串 → []', parseRuleDays(''), [])
eq('parseRuleDays：正常数组', parseRuleDays('[1,2,3,4,5]'), [1, 2, 3, 4, 5])
eq('parseRuleDays：非法 JSON → []（不抛）', parseRuleDays('not json'), [])
eq('parseRuleDays：越界与非整数被丢弃', parseRuleDays('[1,"x",9,-1,2.5,3]'), [1, 3])
eq('parseRuleDays：非数组的 JSON → []', parseRuleDays('{"a":1}'), [])

/* ---------------- 4. 源码探针：口径修复与跨线类型同步 ---------------- */

const readSrc = (p) => readFileSync(join(ROOT, p), 'utf8')
const repoSrc = stripComments(readSrc('electron/database/repositories/summaryRepo.ts'))
const typesSrc = stripComments(readSrc('src/types/index.ts'))
const ipcSrc = stripComments(readSrc('src/lib/ipc.ts'))
const panelSrc = stripComments(readSrc('src/modules/blog/components/SummaryPanel.tsx'))

// ① 旧写法必须零残留（剥注释后，避免注释里提到就假失败）
ok('旧口径 `getKnowledgeIndex().pages.length` 已零残留',
  !repoSrc.includes('getKnowledgeIndex().pages.length'))
// ② 新口径：按 createdAt 归窗口
ok('知识页数改为按 frontmatter created 归窗口（localDay(p.createdAt)）',
  /pages[\s\S]{0,200}localDay\(p\.createdAt\)/.test(repoSrc))
// ③ 明细接线
ok('summaryRepo 调用了 habitPeriodStats', repoSrc.includes('habitPeriodStats'))
ok('summaryRepo 读的是 vaultHabitsAll + records 同一份记录',
  repoSrc.includes('vaultHabitsAll') && repoSrc.includes('vaultRecordsAll'))
// ④ 跨线类型同步（types = 跨线共享汇点）
const gpBlock = typesSrc.slice(typesSrc.indexOf('getBlogPeriodStats'))
ok('types/index.ts 的 ElectronAPI 返回含 habitDetails',
  gpBlock.slice(0, 400).includes('habitDetails: HabitPeriodStat[]'))
ok('types/index.ts 已声明 HabitPeriodStat 形状',
  /interface HabitPeriodStat\s*\{[\s\S]*?rate: number \| null[\s\S]*?longest: number/.test(typesSrc))
ok('ipc.ts 的 PeriodStats 含 habitDetails',
  /interface PeriodStats\s*\{[\s\S]*?habitDetails: HabitPeriodStat\[\]/.test(ipcSrc))
// ⑤ 渲染层真的用上了（不是只加了类型）
ok('SummaryPanel 渲染 habitDetails 明细', panelSrc.includes('habitDetails') && panelSrc.includes('h.rate'))
// ⑥ 相邻未误伤：五项统计仍在
for (const f of ['checkins', 'blogEntries', 'knowledgePages', 'pomodoroMinutes', 'scheduleDone']) {
  ok(`相邻未误伤：${f} 仍在返回值里`, repoSrc.includes(f))
}

/* ---------------- 输出 ---------------- */

let failed = 0
for (const c of checks) {
  if (!c.pass) failed++
  console.log(`${c.pass ? 'ok  ' : 'FAIL'} ${c.name}${c.pass || !c.detail ? '' : '  → ' + c.detail}`)
}
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${checks.length - failed}/${checks.length}`)
process.exit(failed === 0 ? 0 : 1)
