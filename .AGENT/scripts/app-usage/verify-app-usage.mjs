// 契约验证：应用使用时长（P1，2026-09-27）
//
// 为什么需要它：日期分桶这条链路有三处**会静默出错**的地方 ——
//   ① 跨零点的一段必须拆进两个桶。若整段记到起点那天，用户熬夜学到 0:30，
//      第二天热力图是空的、前一天虚高，而且不报错。
//   ② 系统休眠但没发出 suspend 事件时，一段会横跨数小时；不夹上限就会
//      把「合盖一晚上」记成 8 小时使用。夹的是**结束端**（保留最近的时长）。
//   ③ 热力图要的是闭区间且**缺失日补 0**；渲染层若自己拿 Object.keys 拼格子，
//      没记录的那天会整格消失，看起来像 bug。
//
// 所以本脚本**切片真实实现**（electron/lib/appUsage.ts，零依赖纯函数），不照抄算法；
// 主进程接线另用源码探针断言（负向一律先剥注释）。
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/app-usage/verify-app-usage.mjs
// 期望：输出 PASS 且 exit=0

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../shared/strip-comments.mjs'

import {
  dateKeyOf, dayNo, clampSegment, mergeSegment, pruneDays, minutesOn, rangeMinutes,
  MAX_SEGMENT_MS,
} from '../../../electron/lib/appUsage.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf-8')

const checks = []
function ok(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail ?? '' })
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(name, a === e, a === e ? '' : `实际 ${a} ≠ 期望 ${e}`)
}

/* 时间一律用**本地构造器**造，脚本在任何时区都跑得出同样结果。
   日期刻意选 6 月中 —— 南北半球都不在夏令时切换窗口里（午夜切点才不会被跳变日影响）。 */
const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime()

/* ================= A. dateKeyOf / dayNo ================= */

eq('A1 本地日键格式为零填充 YYYY-MM-DD', dateKeyOf(at(2026, 6, 5, 9, 3)), '2026-06-05')
eq('A2 深夜仍是本地的当天', dateKeyOf(at(2026, 6, 15, 23, 59, 59)), '2026-06-15')
ok('A3 dayNo 可解析合法键', Number.isFinite(dayNo('2026-06-15')))
ok('A4 dayNo 对畸形键返回 NaN（而不是抛错）', Number.isNaN(dayNo('2026-6-15')) && Number.isNaN(dayNo('')))
eq('A5 dayNo 相邻两天差 1', dayNo('2026-06-16') - dayNo('2026-06-15'), 1)

/* ================= B. mergeSegment ================= */

{
  const days = {}
  mergeSegment(days, at(2026, 6, 15, 10, 0), at(2026, 6, 15, 10, 30))
  eq('B1 同日内一段 = 1800 秒', days['2026-06-15'], 1800)
}

{
  // 23:30 → 次日 00:30：必须拆成两桶各 30 分钟
  const days = {}
  mergeSegment(days, at(2026, 6, 15, 23, 30), at(2026, 6, 16, 0, 30))
  eq('B2a 跨零点：前一天得 1800 秒', days['2026-06-15'], 1800)
  eq('B2b 跨零点：次日得 1800 秒', days['2026-06-16'], 1800)
  eq('B2c 不产生多余的桶', Object.keys(days).sort(), ['2026-06-15', '2026-06-16'])
}

{
  // 横跨三天的长段：中间那天拿满 86400 秒
  const days = {}
  mergeSegment(days, at(2026, 6, 15, 22, 0), at(2026, 6, 17, 2, 0))
  eq('B3a 三天段：首日 2 小时', days['2026-06-15'], 7200)
  eq('B3b 三天段：中间整日 24 小时', days['2026-06-16'], 86400)
  eq('B3c 三天段：末日 2 小时', days['2026-06-17'], 7200)
}

{
  const days = {}
  mergeSegment(days, at(2026, 6, 15, 10, 0), at(2026, 6, 15, 10, 10))
  mergeSegment(days, at(2026, 6, 15, 11, 0), at(2026, 6, 15, 11, 20))
  eq('B4 多段累加到同一桶', days['2026-06-15'], 600 + 1200)
}

{
  const days = {}
  mergeSegment(days, at(2026, 6, 15, 10, 0), at(2026, 6, 15, 10, 0))   // 零长
  mergeSegment(days, at(2026, 6, 15, 10, 0), at(2026, 6, 15, 9, 0))    // 逆序
  mergeSegment(days, NaN, at(2026, 6, 15, 10, 0))                       // 非法
  eq('B5 零长 / 逆序 / NaN 一律不记账（也不抛错）', days, {})
}

/* ================= C. clampSegment ================= */

{
  const [s, e] = clampSegment(at(2026, 6, 15, 10, 0), at(2026, 6, 15, 10, 3))
  eq('C1 未超上限：原样返回', [e - s, e === at(2026, 6, 15, 10, 3)], [3 * 60_000, true])
}

{
  // 合盖一晚上 8 小时 → 只认最后 MAX_SEGMENT_MS，且**保留结束端**
  const end = at(2026, 6, 15, 10, 0)
  const [s, e] = clampSegment(at(2026, 6, 14, 2, 0), end)
  eq('C2a 超上限：截到上限长度', e - s, MAX_SEGMENT_MS)
  eq('C2b 超上限：保留的是结束端（不是起点）', e, end)
}

{
  const t = at(2026, 6, 15, 10, 0)
  const [s, e] = clampSegment(t, t)
  eq('C3 零长区间返回零长（不抛错）', [s, e], [t, t])
}

/* ================= D. pruneDays ================= */

{
  const now = at(2026, 6, 15, 12, 0)
  const days = { '2026-06-01': 100, '2026-06-13': 200, '2026-06-15': 300 }
  pruneDays(days, 3, now)
  // keepDays=3 → 保留 06-13 / 06-14 / 06-15；06-01 掉
  eq('D1 保留最近 keepDays 天（含边界日）', Object.keys(days).sort(), ['2026-06-13', '2026-06-15'])
}

{
  const days = { '2026-06-15': 300 }
  pruneDays(days, 1, at(2026, 6, 15, 12, 0))
  eq('D2 keepDays=1 时只留今天', Object.keys(days), ['2026-06-15'])
}

/* ================= E. minutesOn / rangeMinutes ================= */

{
  const days = { '2026-06-15': 90, '2026-06-17': 30 }
  eq('E1 秒 → 分钟四舍五入', minutesOn(days, '2026-06-15'), 2)   // 90s → 1.5min → 2
  eq('E2 缺失键当 0', minutesOn(days, '2026-06-16'), 0)
}

{
  const days = { '2026-06-15': 600, '2026-06-17': 600 }
  const r = rangeMinutes(days, '2026-06-15', '2026-06-17')
  eq('E3 闭区间且缺失日补 0（热力图不能空格）',
    Object.entries(r), [['2026-06-15', 10], ['2026-06-16', 0], ['2026-06-17', 10]])
  eq('E4 逆序区间返回空对象', rangeMinutes(days, '2026-06-17', '2026-06-15'), {})
  eq('E5 区间长度 = 天数（含首尾）', Object.keys(rangeMinutes(days, '2026-06-01', '2026-06-30')).length, 30)
}

// 跨月的补零必须连续（月末 → 次月初不能断）
{
  const r = rangeMinutes({}, '2026-06-29', '2026-07-02')
  eq('E6 跨月补零连续', Object.keys(r), ['2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02'])
}

/* ================= F. 纯函数层必须零依赖（能被契约脚本直接装载） ================= */

{
  const src = read('electron/lib/appUsage.ts')
  ok('F1 appUsage.ts 无任何 import（跨层引用会拖垮 --experimental-strip-types 装载链路）',
    !/^\s*import\s/m.test(src))
}

/* ================= G. 主进程接线（源码探针，先剥注释） ================= */

{
  const main = stripComments(read('electron/main/index.ts'))
  const store = stripComments(read('electron/lib/appUsageStore.ts'))

  ok('G1 index.ts 从 electron 引入了 powerMonitor', /import\s*\{[^}]*powerMonitor[^}]*\}\s*from\s*'electron'/.test(main))
  ok('G2 index.ts 启动了采集器', /startAppUsageCollector\(\)/.test(main))
  ok('G3 index.ts 挂了 app 级 focus/blur（多窗口来回切不算离开）',
    /browser-window-focus[\s\S]{0,80}noteFocus\(true\)/.test(main) &&
    /browser-window-blur[\s\S]{0,80}noteFocus\(false\)/.test(main))
  ok('G4 index.ts 挂了电源 / 锁屏事件',
    /powerMonitor\.on\('suspend'[\s\S]{0,60}noteSuspended\(true\)/.test(main) &&
    /powerMonitor\.on\('resume'[\s\S]{0,60}noteSuspended\(false\)/.test(main) &&
    /powerMonitor\.on\('lock-screen'/.test(main) &&
    /powerMonitor\.on\('unlock-screen'/.test(main))
  ok('G5 before-quit 里强制落盘（不能靠 debounce，进程马上就没了）',
    /before-quit[\s\S]*?flushAppUsageNow\(\)/.test(main))
  ok('G6 用时是**全局**数据，落 userData/data（不属于任何知识仓库）',
    /globalReadJson/.test(store) && /globalWriteJson/.test(store))
  ok('G7 心跳是幂等的（重复 start 不叠加定时器）',
    /if\s*\(tickTimer\s*!==\s*null\)\s*return/.test(store))
}

/* ================= 结果 ================= */

const fails = checks.filter((c) => !c.pass)
const pass = checks.length - fails.length
console.log('\n========================================')
if (fails.length === 0) {
  console.log(`✅ 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`❌ ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log(`   FAIL  ${f.name}${f.detail ? `\n         ${f.detail}` : ''}`)
}
console.log('========================================\n')
process.exit(fails.length === 0 ? 0 : 1)
