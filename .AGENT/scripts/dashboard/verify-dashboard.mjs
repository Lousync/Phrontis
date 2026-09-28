// 契约验证：看板模块（P7，2026-09-27）
//
// 为什么需要它：这条链路上有三处**会静默出错**的地方 ——
//   ① 热力图「周一起排」的补位数算错 → 星期标签与格子错行（原型里真踩过：
//      标签写「一」的那行其实是周日）。不报错，只有人眼能看出来。
//   ② 卡片注册表（cards.tsx）与 settings.ts 里 `dashboardCards` 的默认值各写一份 →
//      改了注册表忘了改默认值，表现为「新卡片默认不显示」或「关掉的卡片又回来了」。
//   ③ 过渡编排的延迟只写在注释里没接上线 → 两侧栏根本不会延迟弹出，
//      而这条**纯静态看不出来**（要运行期才判得出），所以这里至少钉住「接线在」。
//
// 所以本脚本**切片真实实现**（src/modules/dashboard/heatmapModel.ts，零依赖纯函数），
// 不照抄算法；其余用源码探针断言（负向一律先剥注释）。
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

/* ================= A. 热力图纯函数 ================= */

eq('A1 无记录 → 0 档', levelOf(0), 0)
eq('A2 负数 / NaN 一律 0 档（不抛错）', [levelOf(-5), levelOf(NaN)], [0, 0])
ok('A3 分档单调不减', (() => {
  let prev = -1
  for (let m = 0; m <= 600; m += 5) { const l = levelOf(m); if (l < prev) return false; prev = l }
  return true
})())
eq('A4 阈值边界：刚好到第 2 档下界', levelOf(LEVEL_MIN[2]), 2)
eq('A5 阈值边界：差一分钟仍在第 1 档', levelOf(LEVEL_MIN[2] - 1), 1)

eq('A6 dayNo 相邻差 1', dayNo('2026-06-02') - dayNo('2026-06-01'), 1)
ok('A7 dayNo 畸形返回 NaN', Number.isNaN(dayNo('2026-6-1')))
eq('A8 keyOfNo 往返一致', keyOfNo(dayNo('2026-06-01')), '2026-06-01')

// 2026-06-01 是周一（算过：2026-01-01 周四，6/1 是年内第 152 天）
{
  const m = buildHeatmap({}, '2026-06-01', '2026-06-07')
  eq('A9 周一起始 → 不补位', m.pad, 0)
  eq('A10 整一周 → 1 列', m.weeks, 1)
  eq('A11 格子数 = 补位 + 天数', m.cells.length, 7)
  eq('A12 首格就是起始日', m.cells[0]?.key, '2026-06-01')
}
{
  const m = buildHeatmap({}, '2026-06-02', '2026-06-07') // 周二起
  eq('A13 周二起始 → 补 1 位（周一起排的关键）', m.pad, 1)
  eq('A14 补位处是空格（null）', m.cells[0], null)
  eq('A15 补位后第一格才是起始日', m.cells[1]?.key, '2026-06-02')
}
{
  const m = buildHeatmap({}, '2026-06-07', '2026-06-07') // 周日单天
  eq('A16 周日起始 → 补 6 位', m.pad, 6)
  eq('A17 单天也占满 1 列', m.weeks, 1)
}
{
  const days = { '2026-06-01': 120, '2026-06-02': 0, '2026-06-03': 400 }
  const m = buildHeatmap(days, '2026-06-01', '2026-06-07')
  eq('A18 分钟数原样带出（分档在渲染层，模型只给事实）', m.cells.map((c) => c?.minutes), [120, 0, 400, 0, 0, 0, 0])
  eq('A19 分档由模型算好', m.cells.map((c) => c?.level), [2, 0, 4, 0, 0, 0, 0])
  eq('A20 有记录天数只数 >0 的', m.activeDays, 2)
  eq('A21 总分钟数求和', m.totalMinutes, 520)
}
{
  const m = buildHeatmap({}, '2026-06-07', '2026-06-01') // 逆序
  eq('A22 逆序区间 → 空模型（不抛错）', [m.weeks, m.cells.length], [0, 0])
}
eq('A23 fmtMinutes 不足一小时', fmtMinutes(45), '使用 45 分钟')
eq('A24 fmtMinutes 跨小时', fmtMinutes(135), '使用 2 小时 15 分')
eq('A25 fmtMinutes 零', fmtMinutes(0), '没有记录')

// 跨月：月份标签必须有两条，且列号递增
{
  const m = buildHeatmap({}, '2026-06-29', '2026-07-05') // 周一 6/29 → 周日 7/5
  eq('A26 跨月产生两个月标签', m.months.map((x) => x.label), ['6 月', '7 月'])
  ok('A27 月份标签列号递增且不越界',
    m.months[0].start <= m.months[1].start && m.months.every((x) => x.start >= 1 && x.start + x.span - 1 <= m.weeks))
}

/* ================= B. 卡片注册表 ↔ settings 默认值同源 ================= */

{
  const cards = read('src/modules/dashboard/cards.tsx')
  const settings = stripComments(read('src/lib/settings.ts'))
  // 抠注册表里的 id 与 defaultOn。注意图标名带数字（CalendarCheck2），字符类别漏数字
  const entries = [...cards.matchAll(/id:\s*'([a-zA-Z]+)',\s*label:\s*'[^']*',\s*group:\s*'[a-z]+',\s*Icon:\s*[A-Za-z][A-Za-z0-9]*,\s*defaultOn:\s*(true|false)/g)]
    .map((m) => ({ id: m[1], on: m[2] === 'true' }))
  ok('B1 能抠到卡片注册表条目（结构变了脚本要跟着改）', entries.length > 0, `实得 ${entries.length} 条`)
  const ids = entries.map((e) => e.id)
  eq('B2 卡片 id 无重复', new Set(ids).size, ids.length)
  const onIds = entries.filter((e) => e.on).map((e) => e.id)

  const def = settings.match(/dashboardCards:\s*\{\s*default:\s*'([^']*)'/)
  ok('B3 settings.dashboardCards 存在且有默认值', !!def)
  if (def) {
    let parsed = null
    try { parsed = JSON.parse(def[1].replace(/\\"/g, '"')) } catch { /* 交给下面的断言报错 */ }
    eq('B4 settings 默认值 = 注册表里 defaultOn 的集合（改一处忘另一处会在这里红）', parsed, onIds)
  }

  // B5（看板方案 §5 反馈 4①，2026-09-27 改口径）：错题卡移除，首批默认 6 → 5 张
  ok('B5 首批默认 5 张（反馈 4① 删错题卡后的量）', onIds.length === 5, `实得 ${onIds.length}`)
  ok('B5b 负向：错题卡已从注册表移除（快照不再为其取数）', !ids.includes('quiz'))
  ok('B6 卡片总数 ≥ 首批数', ids.length >= onIds.length)
  ok('B7 dashboardBg 默认值在 CARD_BG_OPTIONS 里', (() => {
    const bg = settings.match(/dashboardBg:\s*\{\s*default:\s*'([a-z]+)'/)
    const opts = [...cards.matchAll(/\{\s*id:\s*'(none|tint|mark|glow)',\s*label:/g)].map((m) => m[1])
    return !!bg && opts.includes(bg[1])
  })())
}

/* ================= C. 接线探针（整链贯通） ================= */

{
  const types = read('src/types/index.ts')
  const appModules = stripComments(read('src/lib/appModules.ts'))
  const layout = stripComments(read('src/lib/workbenchLayout.ts'))
  const leftPanel = stripComments(read('src/components/workbench/WorkbenchLeftPanel.tsx'))
  const app = stripComments(read('src/App.tsx'))
  const preload = stripComments(read('electron/preload/index.ts'))
  const ipc = stripComments(read('src/lib/ipc.ts'))
  const repo = stripComments(read('electron/database/repositories/dashboardRepo.ts'))
  const main = stripComments(read('electron/main/index.ts'))

  ok('C1 TabName 含 dashboard', /export type TabName = [^\n]*'dashboard'/.test(types))
  ok('C2 APP_MODULES 有 dashboard 且三 flag 全 false（入口只在书签）',
    /id:\s*'dashboard',\s*label:\s*'看板',\s*bar:\s*false,\s*tile:\s*false,\s*palette:\s*false/.test(appModules))
  ok('C3 dashboard 在 WORKBENCH_TABBAR_EXCLUDED（整窗 + 不产生标签页）',
    /WORKBENCH_TABBAR_EXCLUDED[^\n]*\[[^\]]*'dashboard'/.test(layout))
  ok('C4 书签首项是 dashboard', /WORKBENCH_BOOKMARKS[\s\S]{0,260}key:\s*'dashboard'/.test(layout))
  ok('C5 BOOKMARK_ICONS / BOOKMARK_COLORS 覆盖 dashboard',
    /BOOKMARK_ICONS[\s\S]*?dashboard:\s*\(s\)/.test(leftPanel) && /dashboard:\s*\{\s*fg:/.test(layout))
  ok('C6 App.tsx 有 dashboard 渲染分支', /case\s*'dashboard':/.test(app))
  // C7（看板方案 §5 反馈 1，2026-09-27 改口径）：返回落**顶层（总览态）**，不再写死笔记区 ——
  // 对齐 closeTab 关激活标签收尾（三态一并落 null）+ handleBackToOverview 的锁定态解锁。
  ok('C7 返回 = 总览态收尾（activeToolTab / activeTab / railModule 落 null，不落笔记区）',
    /case\s*'dashboard':[\s\S]{0,400}setActiveTab\(null\)/.test(app)
    && /case\s*'dashboard':[\s\S]{0,400}setRailModule\(null\)/.test(app)
    && !/case\s*'dashboard':[\s\S]{0,400}setRailModule\('knowledge'\)/.test(app)
    && !/case\s*'dashboard':[\s\S]{0,400}handleTabChange\('knowledge'\)/.test(app))
  ok('C8 preload 暴露 dashboardGetSnapshot', /dashboardGetSnapshot:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('dashboard:getSnapshot'\)/.test(preload))
  ok('C9 ipc.ts 有 wrapper', /export const dashboardGetSnapshot\s*=/.test(ipc))
  ok('C10 ElectronAPI 有声明', /dashboardGetSnapshot:\s*\(\)\s*=>\s*Promise<DashboardSnapshot>/.test(types))
  ok('C11 主进程注册了 handler', /registerDashboardHandlers\(\)/.test(main) && /ipcMain\.handle\('dashboard:getSnapshot'/.test(repo))
}

/* ================= D. 快照上限真的被消费 ================= */

{
  const repo = stripComments(read('electron/database/repositories/dashboardRepo.ts'))
  const limits = [...repo.matchAll(/^\s{2}([a-zA-Z]+):\s*(\d+),/gm)]
    .map((m) => ({ key: m[1], val: Number(m[2]) }))
  ok('D1 能抠到 DASHBOARD_LIMITS（结构变了脚本要跟着改）', limits.length >= 4, `实得 ${limits.length}`)
  for (const l of limits) {
    // 每个上限都必须被 slice(0, DASHBOARD_LIMITS.x) 真的用上 —— 防「定义了但没消费」
    const used = new RegExp(`slice\\(0,\\s*DASHBOARD_LIMITS\\.${l.key}\\)`).test(repo)
    const usedInRange = new RegExp(`DASHBOARD_LIMITS\\.${l.key}`).test(repo)
    ok(`D2 上限 ${l.key} 被消费`, used || usedInRange)
  }
  ok('D3 热力图跨度是半年（183 天）', /heatmapDays:\s*183/.test(repo))
  ok('D4 逐块 try 兜底（一张卡失败不该让看板打不开）',
    (repo.match(/catch\s*\(e\)\s*\{\s*console\.warn\('\[dashboard\]/g) || []).length >= 5)
  ok('D5 最近编辑走索引而不是全量正文（别把全库 markdown 拉进内存）',
    /getKnowledgeIndex\(\)\.pages/.test(repo) && !/vaultGetPages/.test(repo))
  ok('D6 在读书复用 listBooksImpl（与书架同一实现）', /listBooksImpl\(\)/.test(repo))
}

/* ================= E. 落地后反馈批次接线（看板方案 §5，2026-09-27） ================= */

{
  const index = stripComments(read('src/modules/dashboard/index.tsx'))
  const cards = stripComments(read('src/modules/dashboard/cards.tsx'))
  const repo = stripComments(read('electron/database/repositories/dashboardRepo.ts'))
  const app = stripComments(read('src/App.tsx'))
  const settings = stripComments(read('src/lib/settings.ts'))
  const css = read('src/styles/index.css')
  const animPlan = read('docs/ui-animation-plan.md')

  // --- 反馈 4②：今日打卡列表 ---
  ok('E1 打卡卡消费逐项 items 并可勾选（onToggleHabit 接线在）',
    /const h = snap\.habit/.test(cards) && /h\.items\.map/.test(cards) && /onToggleHabit\?\.\(it\.id\)/.test(cards))
  ok('E2 勾选走 toggleHabitCheck + notifyDataChanged(habit)（写完广播，hero 同批刷新）',
    /toggleHabitCheck\(/.test(index) && /notifyDataChanged\('habit'\)/.test(index))
  ok('E3 卡内滚动挂 .kb-thin-scroll（悬停才现形）', /kb-thin-scroll/.test(cards))
  ok('E4 .kb-thin-scroll 基建在场：悬停显 thumb（index.css）+ 文档登记（ui-animation-plan §I）',
    /\.kb-thin-scroll:hover[^{]*::-webkit-scrollbar-thumb[^{]*\{[^}]*background/.test(css.replace(/\r/g, '')) && /kb-thin-scroll/.test(animPlan))
  ok('E5 负向：打卡卡不再有 14 日小格 / streak 大数字（hero pill 已有）',
    !/days14/.test(cards) && !/天连续/.test(cards))

  // --- 反馈 4①：错题卡移除 ---
  ok('E6 负向：注册表 / 分发 / 组件三处 quiz 已清除',
    !/id:\s*'quiz'/.test(cards) && !/case 'quiz'/.test(cards) && !/QuizCard/.test(cards))
  ok('E7 负向：快照不再取错题（拿得少）', !/quizRecordStats/.test(repo) && !/\bquiz:/.test(repo))

  // --- 反馈 4③：「其余」分隔行删除 ---
  ok('E8 负向：「其余」分隔行已移除', !/其余/.test(index))

  // --- 反馈 2：称呼 ---
  ok('E9 设置键 dashboardUserName 在场（默认空 = 不带称呼）',
    /dashboardUserName:\s*\{\s*default:\s*''/.test(settings))
  ok('E10 问候语消费设置且名字不再写死',
    /s\.dashboardUserName/.test(index) && !/志岩/.test(index))
  ok('E11 hero 行内编辑在位（Enter 提交 / Esc 放弃 / 失焦提交）',
    /commitUserName/.test(index) && /onBlur=\{commitUserName\}/.test(index) && /'Escape'\) setNameEdit\(null\)/.test(index))

  // --- 反馈 5：两个跳转 ---
  ok('E12 最近编辑走 kb-open-note 统一通道且带 from:\'dashboard\'（返回 chip 白捡 N-4）',
    /kb-open-note',\s*\{\s*detail:\s*\{\s*relPath,\s*from:\s*'dashboard'\s*\}/.test(index))
  ok('E13 在读书跳转由 App 接线（onOpenBook），kind 磁盘推导（不信历史数据）',
    /onOpenBook=\{\(relPath\)/.test(app) && /bookKindOf\(relPath\)/.test(app))
  ok('E14 负向：书架跳转不做返回看板（拍板：单向）',
    !/onOpenBook[\s\S]{0,200}noteJumpFrom/.test(app))

  // --- 反馈 3：紧凑档 ---
  ok('E15 紧凑档钩子在位（视口 <1000 → compact；resize 只翻布尔）',
    /function useCompactTier[\s\S]{0,400}window\.innerHeight < 1000/.test(index))
  ok('E16 紧凑档待办限 4 条 + 「去日程」收口（2026-09-28 主卡降维磁贴：逻辑移入 cards.tsx，index 留跳转接线）',
    /openTodos\.slice\(0, 4\)/.test(cards) && /onJumpSchedule/.test(index))
  ok('E17 App 侧跳日程接线', /onJumpSchedule=\{\(\) => handleTabChange\('schedule'\)\}/.test(app))
  ok('E18 紧凑档收口覆盖三卡（打卡 max-h / 使用柱高 / 最近编辑条数）',
    /compact \? 'max-h-\[111px\]' : 'max-h-\[148px\]'/.test(cards)
    && /compact \? 'h-\[38px\]' : 'h-\[50px\]'/.test(cards)
    && /compact \? snap\.recentNotes\.slice\(0, 4\) : snap\.recentNotes/.test(cards))

  // --- 反馈 7：打卡勾选反馈特效（与打卡列表 TodayView 同款） ---
  ok('E19 勾选炸彩纸（burstConfetti 在勾选圈坐标、习惯色随快照透出）',
    /burstConfetti\(pos\.x, pos\.y\)/.test(index) && /color:\s*h\.color/.test(repo)
    && /it\.color \|\| 'var\(--accent\)'/.test(cards))
  ok('E20 圈体 ck-pop 弹跳 + key 强制重挂（动画可重播）；样式懒注入在挂载时保证',
    /key=\{it\.done \? 'd' : 'u'\}/.test(cards) && /it\.done \? 'ck-pop' : ''/.test(cards)
    && /ensureFeedbackStyles\(\)/.test(index))

  // --- 反馈 8：首跳冷挂载竞态（事件改 state+props + openByRelPath 冷态补拉） ---
  const knowledge = stripComments(read('src/modules/knowledge/index.tsx'))
  ok('E21 负向：App 不再同步派发 kb-open-note-rel（冷挂载无监听器必丢），改投 pendingOpenRel',
    !/kb-open-note-rel/.test(app) && /setPendingOpenRel\(\{\s*relPath/.test(app))
  ok('E22 消费接线：case knowledge 传 pendingRelPath/onPendingRelConsumed，模块侧先消费再打开',
    /pendingRelPath=\{pendingOpenRel\}/.test(app) && /onPendingRelConsumed=\{consumePendingOpenRel\}/.test(app)
    && knowledge.indexOf('onPendingRelConsumed?.()') < knowledge.indexOf('void openByRelPath(pendingRel.relPath)'))
  ok('E23 openByRelPath 冷态补拉（allPages 未装载时真实笔记不再误落 draft）',
    /const fresh = await getKnowledgePages\(\)/.test(knowledge) && /setAllPages\(fresh\)/.test(knowledge))
}

/* ================= E. 过渡编排接线 ================= */

{
  const panel = stripComments(read('src/components/shared/ResizablePanel.tsx'))
  const shell = stripComments(read('src/components/workbench/WorkbenchShell.tsx'))
  const app = stripComments(read('src/App.tsx'))
  const dash = read('src/modules/dashboard/index.tsx')

  ok('E1 ResizablePanel 有 openDelayMs 且只作用于展开',
    /openDelayMs\?:\s*number/.test(panel) && /visible\s*&&\s*openDelayMs\s*>\s*0/.test(panel))
  ok('E2 收起不加延迟（收起要立刻响应）', /!dragging\s*&&\s*visible\s*&&\s*openDelayMs/.test(panel))
  ok('E3 WorkbenchShell 把延迟透传给左右两栏',
    (shell.match(/openDelayMs=\{sidesOpenDelayMs\}/g) || []).length === 2)
  ok('E4 App 只在「刚从看板返回」时给延迟',
    /backFromDashboard\s*\?\s*130\s*:\s*0/.test(app) && /prevTabRef\.current\s*===\s*'dashboard'/.test(app))
  ok('E5 看板入场有延迟（让「两侧先收」看得见）', /animationDelay:\s*'130ms'/.test(dash))
  ok('E6 看板动效复用现有令牌而不是另造过渡',
    /kb-view-in/.test(dash) && /kb-item-in|kb-pop/.test(read('src/modules/dashboard/cards.tsx')))
}

/* ================= F. 专注时长指标（热力图第二指标，2026-09-27 接入） ================= */

{
  const repo = stripComments(read('electron/database/repositories/dashboardRepo.ts'))
  const types = read('src/types/index.ts')
  const cards = read('src/modules/dashboard/cards.tsx')
  const srcIndex = read('src/modules/dashboard/index.tsx')
  const heat = read('src/modules/dashboard/Heatmap.tsx')

  eq('F1 fmtMinutes 支持口径参数（专注）', fmtMinutes(45, '专注'), '专注 45 分钟')
  eq('F2 fmtMinutes 默认口径仍是「使用」（老用例不回归）', fmtMinutes(135), '使用 2 小时 15 分')
  eq('F3 fmtMinutes 零值不出口径', fmtMinutes(0, '专注'), '没有记录')

  ok('F4 快照类型有 pomodoro.days', /pomodoro:\s*\{\s*days:\s*Record<string,\s*number>\s*\}/.test(types))
  ok('F5 repo 消费 pomoSessionsAll（番茄场次是专注指标的唯一数据源）', /pomoSessionsAll\(\)/.test(repo))
  ok('F6 repo 聚合出 pomodoro.days（按日累加场次分钟）',
    /const days: Record<string, number> = \{\}/.test(repo) && /pomodoro = \{ days \}/.test(repo))
  ok('F7 聚合有跨度与今日边界（不把全历史拉进快照）', /s\.date >= from && s\.date <= today/.test(repo))
  ok('F8 cards.tsx 占位文案已移除（专注指标真的接上了）', !/还没有接入/.test(cards))
  // F9/F10 修订（2026-09-28）：热力图指标切换器已撤（用户拍板只留「使用时长」），
  // 改断言负向：cards.tsx 不得再有 focus 指标分支 / HEAT_METRICS 切换清单。
  // pomodoro.days 聚合（F4-F7）保留 —— 数据侧口径不变，仅 UI 消费面收窄。
  ok('F9 热力图只吃 usage.days（专注时长指标已撤，无 focus 分支）',
    !/metric === 'focus'/.test(cards) && /snap\.usage\.days/.test(cards))
  ok('F10 切换清单已拔线（HEAT_METRICS / HeatMetric 不复存在）',
    !/HEAT_METRICS/.test(cards) && !/HeatMetric/.test(cards) && !/HEAT_METRICS/.test(srcIndex))
  ok('F11 Heatmap 接收 unit 并传入 fmtMinutes', /unit\??:\s*string/.test(heat) && /fmtMinutes\(minutes, unit\)/.test(heat))
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
