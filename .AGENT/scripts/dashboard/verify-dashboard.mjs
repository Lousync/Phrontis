// 契约验证：看板首页「今日纸」（2026-11-14 重做）
//
// 为什么需要它：这条链路上有三处**会静默出错**的地方 ——
//   ① 时间线「现在」插在哪一行、逾期怎么判 —— 差一行只有人眼能看出来，不报错；
//   ② 月历 42 格的周一起排补位、热力图 52 列的区间对齐 —— 差一天就是「日期和格子对不上」；
//   ③ 结构重做最容易漏的接线：图标条顶部三枚 / 启动落看板 / 看板吃 openTabs / 书签里撤掉看板。
//      漏一处不报错，表象只是「某个入口点了没反应」。
//
// 所以本脚本**切片真实实现**（summary.ts / heatmapModel.ts，都是零依赖纯函数），
// 不照抄算法；接线部分用源码探针断言（负向一律先剥注释）。
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/dashboard/verify-dashboard.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../shared/strip-comments.mjs'

import {
  buildHeatmap, levelOf, dayNo, keyOfNo, fmtMinutes, LEVEL_MIN,
} from '../../../src/modules/dashboard/heatmapModel.ts'
import {
  verdictParts, verdictText, orderTimeline, buildMonthGrid, heatRange, dateLine, monthHead,
} from '../../../src/modules/dashboard/summary.ts'

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

/* ================= A. 热力图区间与分档（沿用 2026-09-27 的纯函数） ================= */

eq('A1 无记录 → 0 档', levelOf(0), 0)
eq('A2 阈值边界：刚好到第 2 档下界', levelOf(LEVEL_MIN[2]), 2)
eq('A3 阈值边界：差一分钟仍在第 1 档', levelOf(LEVEL_MIN[2] - 1), 1)
ok('A4 分档单调不减', (() => {
  let prev = -1
  for (let m = 0; m <= 600; m += 5) { const l = levelOf(m); if (l < prev) return false; prev = l }
  return true
})())
eq('A5 dayNo / keyOfNo 往返', keyOfNo(dayNo('2026-06-01')), '2026-06-01')
eq('A6 周一起始 → 不补位', buildHeatmap({}, '2026-06-01', '2026-06-07').pad, 0)
eq('A7 fmtMinutes 口径参数', fmtMinutes(45, '专注'), '专注 45 分钟')

/* ================= B. 一句话结论 ================= */

eq('B1 0 件 → 「都做完了」整句替换', verdictText({ openCount: 0, lateCount: 0, nextAt: null }), '今天的事都做完了，只剩打卡。')
eq('B2 有逾期 + 下一件', verdictText({ openCount: 3, lateCount: 1, nextAt: '14:00' }), '还有 3 件事，其中 1 件已经过了时间，最近一件 14:00。')
eq('B3 没有逾期时不提「过了时间」', verdictText({ openCount: 2, lateCount: 0, nextAt: '09:30' }), '还有 2 件事，最近一件 09:30。')
eq('B4 没排时间的任务不提时刻', verdictText({ openCount: 1, lateCount: 0, nextAt: null }), '还有 1 件事。')
ok('B5 数字片段带 strong（渲染加重）', verdictParts({ openCount: 3, lateCount: 1, nextAt: null }).filter((p) => p.strong).map((p) => p.text).join(',') === '3,1')

/* ================= C. 今天的时间线 ================= */

const T = (id, time, done = false) => ({ id, title: id, time, done })
{
  const m = orderTimeline([T('a', '09:30'), T('b', '14:00'), T('c', null), T('d', '11:00')], '12:00')
  eq('C1 有时间的按时刻升序、没时间的排最后', m.rows.map((r) => r.id), ['a', 'd', 'b', 'c'])
  eq('C2 「现在」插在第一个未到时刻之前', m.nowIndex, 2)
  eq('C3 未完成件数含无时间的', m.openCount, 4)
  eq('C4 已过时间只算未完成', m.lateCount, 2)
  eq('C5 下一件 = 第一个未到时刻', m.nextAt, '14:00')
}
{
  const m = orderTimeline([T('a', '09:30', true), T('b', '10:00')], '12:00')
  eq('C6 已完成的条目保留在列表里（画划线态）', m.rows.length, 2)
  eq('C7 已完成不计入「还有几件」', m.openCount, 1)
  eq('C8 已完成不判逾期', m.rows[0].late, false)
  eq('C9 全部过了时间 → 「现在」落到末尾', m.nowIndex, 2)
}
{
  const m = orderTimeline([], '08:00')
  eq('C10 空列表 → 0 件 / 现在在首个位置', [m.rows.length, m.nowIndex, m.openCount], [0, 0, 0])
}
{
  const m = orderTimeline([T('a', '12:00')], '12:00')
  eq('C11 时刻正好等于现在 → 不算逾期、插在它之前', [m.rows[0].late, m.nowIndex], [false, 0])
}

/* ================= D. 月历 42 格 ================= */

{
  // 2026-11-01 是周日 → 周一起排要空 6 格
  const g = buildMonthGrid('2026-11')
  eq('D1 固定 42 格', g.length, 42)
  eq('D2 2026-11 前 6 格为月外（1 日是周日）', g.slice(0, 7), [null, null, null, null, null, null, '2026-11-01'])
  eq('D3 月内日期连续到 30 号', [g[6], g[35], g[36]], ['2026-11-01', '2026-11-30', null])
  eq('D4 2026-02（28 天）不越界', buildMonthGrid('2026-02').filter(Boolean).length, 28)
  eq('D5 2028-02（闰年）29 天', buildMonthGrid('2028-02').filter(Boolean).length, 29)
  eq('D6 畸形输入 → 空数组（不抛错）', buildMonthGrid('2026-13'), [])
}
eq('D7 monthHead 拆「11 月 / 2026」', monthHead('2026-11'), { title: '11 月', year: '2026' })

/* ================= E. 热力图区间 ================= */

{
  // 2026-11-14 是周六（今天）
  const r = heatRange('2026-11-14')
  eq('E1 起点是「今天所在周的周一」往回 51 周', r.from, '2025-11-17')
  eq('E2 终点 = 今天', r.to, '2026-11-14')
  const m = buildHeatmap({}, r.from, r.to)
  eq('E3 区间正好 52 列（首列从周一开始，不补位）', m.weeks, 52)
  eq('E4 补位 0', m.pad, 0)
  ok('E5 列数恒为 52（换一个今天也一样）', buildHeatmap({}, ...Object.values(heatRange('2026-03-02'))).weeks === 52)
  // 去重键必须是「年 + 月」：只按月份号去重时，2025-11 会吃掉 2026-11（刻度少一格、上一月被拉长）
  eq('E6 52 周里 11 月出现两次（跨年不合并）', m.months.filter((x) => x.label === '11 月').length, 2)
  eq('E7 月份刻度总数 = 13（含首尾不完整月）', m.months.length, 13)
  ok('E8 刻度列号递增且不越界', m.months.every((x, i) => (i === 0 || x.start > m.months[i - 1].start) && x.start + x.span - 1 <= m.weeks))
}

/* ================= F. 快照与主进程聚合 ================= */

{
  const repo = stripComments(read('electron/database/repositories/dashboardRepo.ts'))
  const types = read('src/types/index.ts')
  const ipc = stripComments(read('src/lib/ipc.ts'))
  const preload = stripComments(read('electron/preload/index.ts'))
  const main = stripComments(read('electron/main/index.ts'))

  ok('F1 热力图跨度 = 近一年 364 天', /heatmapDays:\s*364/.test(repo))
  ok('F2 快照带本月日历（month + days 计数）', /calendar:\s*\{\s*month:\s*string[\s\S]{0,160}days:\s*Record<string,\s*\{\s*total:\s*number;\s*done:\s*number\s*\}>/.test(repo))
  ok('F3 日历走月视图同一实现（vaultMonthTodos）', /vaultMonthTodos\(month\)/.test(repo))
  ok('F4 日历只按当月过滤（计划类无日期的行不落任何一天）', /date\.slice\(0,\s*7\) !== month/.test(repo))
  ok('F4b 日历不计已取消（与「今天 2/6 件」同一口径）', /if \(t\.status === 'canceled'\) continue/.test(repo))
  ok('F5 课程快照取最近工作区（listWorkspaces 的 lastWorkspaceId）', /listWorkspaces\(getSetting\)/.test(repo) && /lastWorkspaceId/.test(repo))
  ok('F6 课程快照复用 getCourseState（不新开存储）', /getCourseState\(/.test(repo))
  ok('F7 课程进度 = 已收尾知识点 / 总数', /done \/ total/.test(repo))
  ok('F8 今日任务含已完成（时间线要画划线态）', /vaultTodosForDate\(today\)\.filter\(\(t\) => t\.status !== 'canceled'\)/.test(repo))
  ok('F17 已完成数只数 status=done（已取消既不画也不计入分母）',
    /doneToday:\s*rows\.filter\(\(t\) => t\.status === 'done'\)\.length/.test(repo)
    && /totalToday:\s*rows\.length/.test(repo))
  ok('F9 时间列优先排期时段、其次截止时刻', /scheduled_start/.test(repo) && /T\(\\d\{2\}:\\d\{2\}\)/.test(repo))
  ok('F10 逐块 try 兜底（一块失败不该让看板打不开）',
    (repo.match(/catch\s*\(e\)\s*\{\s*console\.warn\('\[dashboard\]/g) || []).length >= 6)
  ok('F11 快照上限逐个被消费', (() => {
    const limits = [...repo.matchAll(/^\s{2}([a-zA-Z]+):\s*(\d+),/gm)].map((m) => m[1])
    return limits.length >= 3 && limits.every((k) => new RegExp(`DASHBOARD_LIMITS\\.${k}`).test(repo))
  })())
  ok('F12 类型侧双区同步（DashboardSnapshot 有 calendar / course）',
    /export interface DashboardSnapshot[\s\S]{0,1600}calendar:\s*\{/.test(types) && /export interface DashboardSnapshot[\s\S]{0,2400}course:\s*null\s*\|/.test(types))
  ok('F13 主进程注入设置读取器（课程快照要用 getSetting）',
    /registerDashboardHandlers\(\{\s*getSettingValue:/.test(main) && /registerDashboardHandlers\(deps:/.test(repo))
  ok('F14 IPC 三处仍在（preload / ipc.ts / handler）',
    /dashboardGetSnapshot:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('dashboard:getSnapshot'\)/.test(preload)
    && /export const dashboardGetSnapshot\s*=/.test(ipc)
    && /ipcMain\.handle\('dashboard:getSnapshot'/.test(repo))
  ok('F15 负向：快照不再取错题（拿得少）', !/quizRecordStats/.test(repo))
  ok('F16 负向：跨天逾期不塞进首页时间线（逾期去日程看）', !/vaultOverdueTodos/.test(repo))
}

/* ================= G. 结构接线（顶层视图） ================= */

{
  const app = stripComments(read('src/App.tsx'))
  const bar = stripComments(read('src/components/shared/ActivityBar.tsx'))
  const dash = stripComments(read('src/modules/dashboard/index.tsx'))
  const layout = stripComments(read('src/lib/workbenchLayout.ts'))
  const appModules = stripComments(read('src/lib/appModules.ts'))
  const settings = stripComments(read('src/lib/settings.ts'))

  ok('G1 图标条顶部固定三枚：看板 / 工作台 / AI 教学',
    /data-tip="看板"/.test(bar) && /data-tip="工作台"/.test(bar) && /data-tip="AI 教学"/.test(bar))
  ok('G2 顶部三枚不参与拖拽排序（渲染在 data-rail-btn 列表之前）',
    bar.indexOf('data-tip="AI 教学"') < bar.lastIndexOf('{visible.map('))
  ok('G3 ActivityBar 收 onBoard 回调（回看板只此一枚）', /onBoard\?:/.test(bar) && /onBoard\?\.\(\)/.test(bar))
  ok('G4 AI 教学已从可拖拽图标条成员移出', /RAIL_MODULE_IDS: TabName\[\] = \['recycle'/.test(appModules))
  ok('G5 appModules 顶部固定组 = 看板 + AI 教学', /RAIL_PINNED_IDS[^\n]*\['dashboard', 'aiTeaching'\]/.test(appModules))
  ok('G6 看板不再是工作台书签', !/key:\s*'dashboard'/.test(layout))
  ok('G7 RailModule 类型不再含 dashboard', !/export type RailModule =[^\n]*'dashboard'/.test(layout))
  ok('G8 看板仍在 EXCLUDED（整窗 + 不产生标签页）', /WORKBENCH_TABBAR_EXCLUDED[^\n]*\[[^\]]*'dashboard'/.test(layout))
  ok('G9 启动落看板（恢复 openTabs，但不把 lastActiveTab 当可见标签）',
    /setActiveTab\('dashboard'\)/.test(app) && /if \(tabs\.length\) setOpenTabs\(tabs\)/.test(app))
  ok('G10 看板吃工作台标签（openTabs / lastTab / onOpenTab / onOpenWorkbench）',
    /openTabs=\{openTabs\.filter/.test(app) && /lastTab=\{lastWorkbenchTab\}/.test(app)
    && /onOpenTab=\{handleTabChange\}/.test(app) && /onOpenWorkbench=\{goWorkbench\}/.test(app))
  ok('G11 「回工作台」判定收口一处（图标条与看板窗口共用 goWorkbench）',
    /const goWorkbench = useCallback/.test(app) && (app.match(/goWorkbench/g) || []).length >= 3)
  ok('G12 负向：看板不再有 onBack 参数 / 返回箭头',
    !/onBack/.test(dash) && !/ArrowLeft/.test(dash))
  ok('G13 负向：工作台左栏没有「回看板」行 / AI 教学头部没有「看板」面包屑',
    !/data-wb="bookToBoard"/.test(read('src/components/workbench/WorkbenchLeftPanel.tsx'))
    && !/回看板/.test(read('src/modules/ai-teaching/index.tsx')))
  ok('G14 railOrder 默认值不含 aiTeaching（它是固定枚）',
    /railOrder:\s*\{\s*default:\s*'\["recycle","plugins","moments","bookMarket","usage"\]'/.test(settings))
}

/* ================= H. 版面与动效 ================= */

{
  const dash = stripComments(read('src/modules/dashboard/index.tsx'))
  const cal = read('src/modules/dashboard/MonthCalendar.tsx')
  const tl = read('src/modules/dashboard/DayTimeline.tsx')
  const heat = read('src/modules/dashboard/UsageHeatmap.tsx')
  const win = read('src/modules/dashboard/ModuleWindow.tsx')

  ok('H1 日期文案走快照的 today（两端不会算出不同的今天）', /dateLine\(snap\.today\)/.test(dash))
  ok('H2 一句话结论来自纯函数（不在组件里拼句子）', /verdictParts\(\{ openCount: timeline\.openCount/.test(dash))
  ok('H3 时间线用纯函数模型', /orderTimeline\(/.test(dash))
  ok('H4 热力图区间 52 列、格子随宽度自适应', /heatRange\(/.test(heat) && /minmax\(9px, 1fr\)/.test(heat))
  ok('H5 热力图宽度不够时从左边裁（最近的数据贴右边）',
    /justify-end/.test(heat) && /overflow-hidden/.test(heat) && /minWidth/.test(heat))
  ok('H6 热力图有月份刻度且跳过首个不完整月', /m\.start > 1/.test(heat))
  ok('H7 时间线宽度封顶 760（状态标签不会被推远）', /max-w-\[760px\]/.test(dash))
  ok('H8 宽窗打卡转右列（容器查询，不按视口写死）', /@min-\[660px\]:col-start-2/.test(dash))
  ok('H9 月历行高随可用高度收缩（矮窗不滚动）', /repeat\(6,minmax\(0,1fr\)\)/.test(cal))
  ok('H10 两个模块窗口共用外壳（标题栏 + 内容 + 底部入口）', /function WindowShell/.test(win) && /打开工作台/.test(win))
  ok('H11 工作台窗口点一行直达对应标签', /onOpenTab\(tab\)/.test(win))
  ok('H12 动效全部复用既有令牌（kb-view-in / kb-item-in / kb-pop）',
    /kb-view-in/.test(dash) && /kb-item-in/.test(win) && /kb-pop/.test(heat))
  ok('H13 打卡勾选仍走 toggleHabitCheck + 广播（写完别处也刷新）',
    /toggleHabitCheck\(/.test(dash) && /notifyDataChanged\('habit'\)/.test(dash))
  ok('H14 称呼仍在 hero 行内编辑（Enter 提交 / Esc 放弃 / 失焦提交）',
    /commitUserName/.test(dash) && /onBlur=\{commitUserName\}/.test(dash) && /'Escape'\) setNameEdit\(null\)/.test(dash))
  ok('H15 主题特效画布只在看板根挂一次', /<ThemeFxLayer \/>/.test(dash))
  ok('H17 专注 KPI 吃番茄钟分钟（pomodoro.days），不是 app 使用时长',
    /snap\.pomodoro\.days\[snap\.today\]/.test(dash) && /label="分钟专注"/.test(dash))
  ok('H18 打卡分母用快照真实习惯数（不是被 20 条上限截断的 items.length）',
    /snap\.habit\.doneToday}\/\{snap\.habit\.habits/.test(dash))
  ok('H16 负向：旧磁贴引擎 / 插件控件 / 底部入口条已从看板移除',
    !/dashboardTileLayout/.test(dash) && !/CARD_REGISTRY/.test(dash) && !/PluginFrame/.test(dash))
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
