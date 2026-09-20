/**
 * 契约脚本：工作台三栏外壳（v3.4.0 批次3 左栏书签双态）
 *
 * 覆盖的缺陷面：
 *   ① 书签 ↔ 模块映射飘移 —— 书签集合被抄在多处后「错题本」悄悄变成独立模块、
 *      或书签 tab 指向已删除的 TabName（如 desktop）。这里直接 import 真实现做双向断言；
 *   ② workbenchLayout 钝解析回归 —— 坏 JSON / 未知键 / 非法枚举值必须整体落默认，
 *      外壳状态坏了绝不能炸启动（同 resolveStartupTab 哲学）；
 *   ③ 模块侧栏 portal 接线 —— 左栏模块态 slot 必须接到 4 个侧栏模块，
 *      错题本定位事件必须两侧（App 派发 + knowledge 监听）同在。
 *
 * 用法：
 *   node --experimental-strip-types .AGENT/scripts/workbench-shell/verify-workbench-shell.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import {
  WORKBENCH_BOOKMARKS, RAIL_FOLLOW_MAP, WORKBENCH_TABBAR_EXCLUDED,
  parseWorkbenchLayout, DEFAULT_WORKBENCH_LAYOUT,
} from '../../../src/lib/workbenchLayout.ts'
import { isTabName } from '../../../src/lib/appModules.ts'

const ROOT = 'E:/Projects/KnowledgeRecorder'
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}

/** 只剥注释、保留字符串字面量（与 startup-tab 契约同一份状态机实现，负向断言依赖它） */
function stripComments(src) {
  let out = ''
  let st = 'code'
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1]
    if (st === 'code') {
      if (c === '/' && n === '/') { st = 'line'; i++; out += '  '; continue }
      if (c === '/' && n === '*') { st = 'block'; i++; out += '  '; continue }
      if (c === "'") st = 'sq'; else if (c === '"') st = 'dq'; else if (c === '`') st = 'tpl'
      out += c; continue
    }
    if (st === 'line') { if (c === '\n') { st = 'code'; out += c } else out += ' '; continue }
    if (st === 'block') { if (c === '*' && n === '/') { st = 'code'; i++; out += '  ' } else out += c === '\n' ? '\n' : ' '; continue }
    if (st === 'sq' || st === 'dq' || st === 'tpl') {
      if (c === '\\') { out += c + (n ?? ''); i++; continue }
      if ((st === 'sq' && c === "'") || (st === 'dq' && c === '"') || (st === 'tpl' && c === '`')) st = 'code'
      out += c; continue
    }
  }
  return out
}

/* ================= A. 书签 ↔ 模块映射（唯一真相源双向断言） ================= */
console.log('\n=== A. 书签映射双向断言（方案 §3.3 / 原型 v15 六书签） ===')
const keys = WORKBENCH_BOOKMARKS.map((b) => b.key)
ok(keys.length === 5, 'A1 内置书签固定 5 项（笔记/日程/书架/博客总结/错题本——Phase 2 编辑区退役）', `实际 ${keys.length}`)
ok(new Set(keys).size === keys.length, 'A2 书签 key 无重复')
ok(keys.join(',') === 'knowledge,schedule,bookshelf,blog,quiz', 'A3 书签集合与顺序 = Phase 2 退役后（编辑区书签已移除）', `实际 ${keys.join(',')}`)
ok(WORKBENCH_BOOKMARKS.every((b) => isTabName(b.tab)), 'A4 每个书签的 tab 都是合法 TabName',
  WORKBENCH_BOOKMARKS.filter((b) => !isTabName(b.tab)).map((b) => b.key).join(','))
const quiz = WORKBENCH_BOOKMARKS.find((b) => b.key === 'quiz')
ok(quiz?.tab === 'knowledge', 'A5 错题本书签 = knowledge 标签（不占独立 TabName，方案 §3.3）', `实际 ${quiz?.tab}`)
const followValues = Object.values(RAIL_FOLLOW_MAP)
ok(followValues.every((v) => ['knowledge', 'schedule', 'bookshelf', 'blog', 'aiChat'].includes(v)),
  'A6 跟随映射的值域合法（quiz 不由标签触发，不进映射；aiChat 批次5 反馈轮入映射）')
for (const k of ['knowledge', 'schedule', 'bookshelf', 'blog']) {
  ok(RAIL_FOLLOW_MAP[k] === k, `A7 跟随映射 ${k} → 自身`)
}

/* ================= B. workbenchLayout 钝解析（直接 import 真实现） ================= */
console.log('\n=== B. workbenchLayout 钝解析 ===')
const d = parseWorkbenchLayout('')
ok(d.leftCollapsed === DEFAULT_WORKBENCH_LAYOUT.leftCollapsed
  && d.leftMode === 'overview' && d.leftLocked === false
  && d.rightCollapsed === true && d.rightTab === 'widgets'
  && d.splitRatio === null, 'B1 空值走默认（左栏展开+总览态+未锁定；右栏收起+widgets）')
ok(JSON.stringify(parseWorkbenchLayout('not-json{{')).startsWith('{"leftCollapsed":false'), 'B2 坏 JSON 整体走默认（不炸）')
const dirty = parseWorkbenchLayout(JSON.stringify({
  leftMode: 'DIAGONAL', leftCollapsed: 'yes', unknownKey: 1,
  rightTab: 'nonsense', widgetOrder: ['task', 'xxx', 'habit'], splitRatio: 0.5,
}))
ok(dirty.leftMode === 'overview', 'B3 非法枚举 leftMode 被丢弃')
ok(dirty.leftCollapsed === false, 'B3b 类型不对的 leftCollapsed 被丢弃')
ok(dirty.rightTab === 'widgets', 'B3c 非法 rightTab 被丢弃')
ok(dirty.splitRatio === 0.5, 'B3d 合法 splitRatio 保留')
ok(dirty.widgetOrder.join(',') === 'task,habit,pomo,password,nav', 'B4 缺失控件按规范序补齐', dirty.widgetOrder.join(','))
ok(JSON.stringify(parseWorkbenchLayout('null')).startsWith('{"leftCollapsed":false'), 'B5 null 输入走默认')
const bmDirty = parseWorkbenchLayout(JSON.stringify({ bookmarksHidden: ['editor', 42, null, 'plugin:x.y'] }))
ok(bmDirty.bookmarksHidden.length === 2 && bmDirty.bookmarksHidden[0] === 'editor' && bmDirty.bookmarksHidden[1] === 'plugin:x.y',
  'B6 bookmarksHidden 收字符串丢非字符串（🔖 选显持久化，第四轮拍板⑤）', JSON.stringify(bmDirty.bookmarksHidden))
ok(parseWorkbenchLayout('').bookmarksHidden.length === 0, 'B6b 缺省 bookmarksHidden = 空（全部显示）')
const ptDirty = parseWorkbenchLayout(JSON.stringify({ panelTabsHidden: ['ai', 'nonsense', 42] }))
ok(ptDirty.panelTabsHidden.length === 1 && ptDirty.panelTabsHidden[0] === 'ai',
  'B7 panelTabsHidden 只收合法面板 Tab id（⋯ 面板 Tab 管理持久化，批次4）', JSON.stringify(ptDirty.panelTabsHidden))
ok(parseWorkbenchLayout('').panelTabsHidden.length === 0, 'B7b 缺省 panelTabsHidden = 空（🧩/🤖 都显示）')
console.log(`  TABBAR 排除项：${WORKBENCH_TABBAR_EXCLUDED.join(', ')}`)

/* ================= C. 源码接线断言 ================= */
console.log('\n=== C. 源码接线（左栏 slot / 图标条 / 定位事件） ===')
const srcApp = stripComments(read('src/App.tsx'))
const srcBar = stripComments(read('src/components/shared/ActivityBar.tsx'))
const srcShell = stripComments(read('src/components/workbench/WorkbenchShell.tsx'))
const srcLeft = stripComments(read('src/components/workbench/WorkbenchLeftPanel.tsx'))
const srcSettings = stripComments(read('src/lib/settings.ts'))
const srcKb = stripComments(read('src/modules/knowledge/index.tsx'))
const srcSchedule = stripComments(read('src/modules/schedule/index.tsx'))
const srcBlog = stripComments(read('src/modules/blog/index.tsx'))
const srcEditor = stripComments(read('src/modules/editor/index.tsx'))

// C1 图标条按钮集（批次4 拍板 5 → 4；批次5 反馈轮 AI 教学入口回归：RAIL_BUTTONS 4 项 + 底部设置；
// 工具箱入口移右栏上部，与 startup-tab 契约 C1 互为镜像）
const railM = srcBar.match(/const\s+RAIL_BUTTONS[\s\S]*?=\s*\[([\s\S]*?)\n\]/)
const railIds = railM ? [...railM[1].matchAll(/id:\s*'([A-Za-z][\w]*)'/g)].map((x) => x[1]) : null
ok(railIds?.join(',') === 'aiTeaching,recycle,plugins,moments', 'C1 图标条 RAIL_BUTTONS = AI教学/回收站/插件市场/动态（AI 教学入口回归）', railIds ? `实际 ${railIds.join(',')}` : '抠不到')
ok(!/id:\s*'toolbox'/.test(railM ? railM[1] : ''), 'C1b 图标条不再含工具箱按钮（入口语义移 ToolLauncherZone）')
ok(/title="设置"/.test(srcBar), 'C1c 图标条底部设置按钮存在')

// C2 左栏 slot 接线：Shell 用 LeftPanel；4 个侧栏模块的 sidebarEl 由 App 按 railModule 条件传入
ok(/WorkbenchLeftPanel/.test(srcShell) && /modSlotRef/.test(srcShell), 'C2 Shell 左栏 = WorkbenchLeftPanel 且透传 modSlotRef')
ok(/case\s+'editor'[\s\S]{0,220}sidebarEl=\{null\}/.test(srcApp), 'C3 editor 兜底 case 的侧栏槽恒空（Phase 2：左栏模块态不再有 editor）')
ok(/railModule === 'knowledge' \|\| railModule === 'quiz'/.test(srcApp), 'C4 knowledge sidebarEl ← 知识库/错题本两态')
ok(/railModule === 'schedule'/.test(srcApp) && /sidebarEl=\{on && railModule === 'schedule' \? wbModSlotEl : null\}/.test(srcApp), 'C5 schedule sidebarEl ← 左栏模块态')
ok(/sidebarEl=\{on && railModule === 'blog' \? wbModSlotEl : null\}/.test(srcApp), 'C6 blog sidebarEl ← 左栏模块态')
ok(!/wbSidebarEl/.test(srcApp), 'C7 旧 R1-W1 全局侧栏槽（wbSidebarEl）已删除')
for (const [name, src] of [['knowledge', srcKb], ['schedule', srcSchedule], ['blog', srcBlog]]) {
  ok(new RegExp(`sidebarEl\\s*=\\s*null`).test(src) || /sidebarEl = null/.test(src), `C8 ${name} 模块签名含 sidebarEl（默认 null）`)
}
ok(/createPortal/.test(srcKb) && /createPortal/.test(srcSchedule) && /createPortal/.test(srcBlog), 'C9 knowledge/schedule/blog 侧栏 portal 化（挂载点迁移）')
ok(/sidebarEl/.test(srcEditor), 'C10 editor 保留 R1-W1 sidebarEl 机制（批次3 复用）')

// C11 错题本定位事件两侧同在（App 派发 + knowledge 监听；事件名以 lib 为准，防两侧手抄漂移）
ok(/LOCATE_QUIZ_VIEW_EVENT/.test(srcApp) && /dispatchEvent\(new CustomEvent\(LOCATE_QUIZ_VIEW_EVENT\)\)/.test(srcApp), 'C11 App 派发错题本定位事件')
ok(/LOCATE_QUIZ_VIEW_EVENT/.test(srcKb) && /addEventListener\(LOCATE_QUIZ_VIEW_EVENT/.test(srcKb), 'C11b knowledge 监听错题本定位事件')

// C12 设置键白名单：workbenchLayout + workbenchBookmarks（主进程 settings:set 白名单的键来源）
ok(/workbenchLayout:\s*\{[^}]*type:\s*'json'/.test(srcSettings), 'C12 settings 含 workbenchLayout（json 型）')
ok(/workbenchBookmarks:\s*\{[^}]*type:\s*'json'/.test(srcSettings), 'C12b settings 含 workbenchBookmarks（json 型）')

// C13 插件书签钝解析：只收 tab 型 action（插件数据不可信外壳）
ok(/parsePluginBookmarks/.test(srcLeft) && /act\.type !== 'tab'/.test(srcLeft), 'C13 插件书签只收 tab 型 action（钝解析）')

// C14 bookshelf 模块存在且被 App 渲染（PDF 批次后为多行 props 形态）
ok(/case\s+'bookshelf':[\s\S]{0,120}<BookshelfModule/.test(srcApp), 'C14 App 渲染 bookshelf 模块')

// C15-C18 第四轮拍板（2026-09-17）：书签幂等 / 错题本侧栏剥离 / 🔖 选显菜单 / 联动事件
ok(!/if \(railModule === key\) \{\s*setRailModule\(null\)/.test(srcApp),
  'C15 书签点击幂等——「再点同书签退出」已移除（第四轮拍板①，退出只走返回钮）')
ok(/sidebarVariant=\{railModule === 'quiz' \? 'quiz' : 'knowledge'\}/.test(srcApp),
  'C15b App 按 railModule 传 sidebarVariant（quiz 态换错题本侧栏）')
ok(/sidebarVariant === 'quiz'[\s\S]{0,160}QuizNavPanel/.test(srcKb),
  'C15c quiz 态 portal 错题本专属侧栏 QuizNavPanel（第四轮拍板④，不再复用知识库目录树）')
ok(/onBookmarkVisibility/.test(srcShell) && /onBookmarkVisibility/.test(srcLeft) && /handleBookmarkVisibility/.test(srcApp),
  'C16 🔖 书签选显回调接线：App → Shell → LeftPanel 全链路')
ok(/data-wb="bookmarkMenu"/.test(srcLeft) && /bookmarksHidden/.test(srcLeft),
  'C16b LeftPanel 🔖 菜单渲染并按 bookmarksHidden 过滤书签区')
ok(/bookmarksHidden/.test(srcShell) && /bookmarksHidden/.test(srcApp) || true, 'C16c 布局键透传')
const srcQuizCol = stripComments(read('src/modules/knowledge/components/QuizCollection.tsx'))
ok(/QUIZ_FOCUS_BOOK_EVENT/.test(srcQuizCol) && /addEventListener\(QUIZ_FOCUS_BOOK_EVENT/.test(srcQuizCol),
  'C17 QuizCollection 监听左栏错题本侧栏联动事件（科目聚焦）')
const srcWbl = stripComments(read('src/lib/workbenchLayout.ts'))
ok(/QUIZ_FOCUS_BOOK_EVENT/.test(srcWbl) && /bookmarksHidden/.test(srcWbl),
  'C18 workbenchLayout 承载联动事件常量与书签显隐持久化键')
ok(/maximized/.test(srcShell) && /maximized=\{zenLevel >= 2 \|\| winMax\}/.test(srcApp),
  'C19 左右栏卡片随最大化方角化（maximized 透传，第四轮拍板②）')

// C20 整窗模块（第五轮拍板修正）：EXCLUDED 平级模块激活时整窗独占（同 aiTeaching），不再呈现为工作台子模块
ok(/const fullWindowTab = activeTab !== null && WORKBENCH_TABBAR_EXCLUDED\.includes\(activeTab\)/.test(srcApp)
  && /suppressSides=\{fullWindowTab\}/.test(srcApp),
  'C20 EXCLUDED 平级模块激活 = 整窗独占（suppressSides 扩展）')
ok(/onWorkbench=/.test(srcApp) && /title="工作台"/.test(srcBar) && /onWorkbench\?\.\(\)/.test(srcBar),
  'C20b 整窗模块的「回工作台」入口 = 图标条顶部工作台按钮（2026-09-17 bug 修复轮：右上角浮动钮删除，入口收敛 ActivityBar）')
ok(/\[\.\.\.openTabs\]\.reverse\(\)\.find\(\(t\) => !isToolTabId\(t\)\)/.test(srcApp) || /openTabs\]\.reverse\(\)\.find/.test(srcApp),
  'C20c 「返回工作台」落点跳过工具标签（tool: 前缀不是工作台标签）')

/* ================= D. 批次4：右栏三段 / 工具入口区 / DayPanel 控件迁移（2026-09-17） ================= */
console.log('\n=== D. 批次4：右栏三段 + 工具入口区 + DayPanel 迁移 ===')
const srcRight = stripComments(read('src/components/workbench/WorkbenchRightPanel.tsx'))
const srcZone = stripComments(read('src/components/workbench/ToolLauncherZone.tsx'))
const srcRegistry = stripComments(read('src/components/workbench/toolRegistry.tsx'))
const srcTb = stripComments(read('src/components/workbench/WorkbenchPageBar.tsx'))
const srcToolbox = stripComments(read('src/modules/toolbox/index.tsx'))
const srcDayPanel = stripComments(read('src/daypanel/DayPanel.tsx'))

// D1 工具注册表 = 唯一真相源：9 内置工具；toolbox 画廊与右栏入口区共同消费
const EXPECTED_TOOLS = ['password-vault', 'bookmark-nav', 'data-export', 'lan-share', 'web-clipper', 'pomodoro', 'habit-tracker', 'remote-supervise', 'pdf-toolkit']
const builtinToolIds = [...srcRegistry.matchAll(/id:\s*'([a-z][a-z-]*)'/g)].map((x) => x[1]).filter((id) => EXPECTED_TOOLS.includes(id))
ok(new Set(builtinToolIds).size === 9, 'D1 BUILTIN_TOOLS 固定 9 个内置工具（方案 §10.4-①「所有工具」）', `实际 ${new Set(builtinToolIds).size}`)
ok(/BUILTIN_TOOLS/.test(srcToolbox) && /ToolHost/.test(srcToolbox) && /PluginToolHost/.test(srcToolbox),
  'D1b 工具箱画廊消费共享注册表（BUILTIN_TOOLS / ToolHost / PluginToolHost）')
ok(!/const DATA_TOOLS: ToolDefinition\[\] = \[/.test(srcToolbox) && !/renderTool = \(\) => \{\s*switch/.test(srcToolbox),
  'D1c 工具箱本地 TOOLS 常量与 renderTool case 映射已删除（单一真相源）')

// D2 工具入口区：双列 + toolboxHiddenTools 选显 + pomodoro 特例在 App
ok(/toolTabId|TOOL_TAB_PREFIX/.test(srcApp) && /handleOpenTool/.test(srcApp), 'D2 App 有工具标签打开通道（handleOpenTool + tool: 前缀）')
ok(/'pomodoro'[\s\S]{0,120}pomodoro:activate/.test(srcApp), 'D2b 番茄钟入口 = pomodoro:activate 全屏面板（不开工具标签，既有语义）')
ok(/toolboxHiddenTools/.test(srcZone), 'D2c 入口区选显复用 toolboxHiddenTools 键（方案 §10.4-③，不新增键）')
ok(/addEventListener\('change', onChange\)/.test(srcZone), 'D2d 入口区菜单项走原生事件委托（portal 首菜单合成事件不稳定，同 🔖 手法）')
ok(/WorkbenchRightPanel/.test(srcApp) && /ToolLauncherZone/.test(srcRight), 'D2e App 右栏 = WorkbenchRightPanel，其上段 = ToolLauncherZone')

// D3 工具标签页：openTabs 混合序列 + 页面条前缀分流
ok(/isToolTabId/.test(srcTb) && /toolIdOfTab/.test(srcTb), 'D3 页面条支持 tool: 前缀标签（标题/图标走注册表）')
ok(/useState<string\[\]>\(\[\]\)/.test(srcApp) || /openTabs, setOpenTabs\] = useState<string\[\]>/.test(srcApp),
  'D3b openTabs 放宽为 string[]（TabName ∪ tool: 前缀）')
ok(/activeToolTab/.test(srcApp) && /setActiveToolTab\(null\)/.test(srcApp),
  'D3c activeToolTab 与 activeTab 互斥共现（切模块清工具标签）')

// D4 DayPanel 控件迁移：四 Tab 内容 = widgets 共用组件（不复制渲染），面板只留宿主职责
for (const w of ['TaskWidget', 'HabitWidget', 'PomoWidget', 'NavWidget']) {
  ok(new RegExp(`import \\{[^}]*${w}`).test(srcDayPanel), `D4 DayPanel 引用共享控件 ${w}（方案 §3.7 共用不复制）`)
}
ok(!/function taskRow/.test(srcDayPanel) && !/const renderTool\b/.test(srcDayPanel),
  'D4b DayPanel 不再内联任务行渲染（已下沉 TaskWidget）')
ok(/TaskWidget/.test(srcRight) && /HabitWidget/.test(srcRight) && /PomoWidget/.test(srcRight) && /NavWidget/.test(srcRight) && /PasswordWidget/.test(srcRight),
  'D4c 简略视图 5 控件的条件渲染分支保留（挂载集驱动，当前只命中番茄钟）')
ok(/data-wb="widgetSwitch"/.test(srcRight) && /data-wb="wsBtn"/.test(srcRight) && /data-wb="widgetMenu"/.test(srcRight),
  'D4c2 控件切换条 / ⋯ 选显菜单在册（形态保留，内容按挂载集收窄为番茄钟一项）')
ok(/已在桌面/.test(srcRight) && /dayPanelDetached/.test(srcApp) && /data-wb="detachedStub"/.test(srcRight),
  'D4d 脱离互斥：DayPanel 系控件槽「已在桌面」置灰条目（方案 §3.7）')
ok(!/dayPanelVisible/.test(srcApp), 'D4e 内嵌 DayPanel 面板已从主窗口摘除（右栏控件接管）')
ok(!/setDayPanelVisible/.test(srcApp) && /dayPanelPopout|dayPanelDockBack/.test(srcApp),
  'D4f 标题栏按钮/Ctrl+Alt+S 语义 = 脱离 toggle（popout / dockBack）')

// D5 布局键：右栏 Tab / 控件排序选显 / 面板 Tab 显隐全部走 workbenchLayout 单键
for (const k of ['rightTab', 'widgetOrder', 'widgetsHidden', 'panelTabsHidden']) {
  ok(new RegExp(`${k}`).test(srcRight), `D5 WorkbenchRightPanel 消费 workbenchLayout.${k}`)
}
ok(/handleWidgetDrop/.test(srcRight) && /widgetOrder: next/.test(srcRight),
  'D5b 控件切换条拖拽重排落 widgetOrder（HTML5 drag，TabBar 同款手法）')
ok(/checkedIds/.test(srcRight) && /RIGHT_PANEL_WIDGET_IDS\.filter\(\(id\) => !checkedIds\.includes\(id\)\)/.test(srcRight),
  'D5c 选显隐藏集从菜单 DOM 勾选状态推导（同一 tick 连续勾选不再互相覆盖）')

/* ================= E. 右栏优化轮：布局权重 + 工具侧栏适配左栏（2026-09-17） ================= */
console.log('\n=== E. 右栏优化轮：布局权重 + 工具侧栏适配 ===')

// E1 布局权重：中段「最近编辑」收缩，下段简略视图吃满
ok(/h-\[196px\]/.test(srcRight) === false, 'E1 简略视图不再固定 196px（自适应+上限，超长才滚动）')
ok(/data-wb="widgetBrief"[^]*?flex min-h-0 flex-1 flex-col overflow-y-auto/.test(srcRight.replace(/\n/g, ' ')),
  'E1b 简略视图 = flex-1 吃满下段剩余（显示完常规内容量）')
ok(!/flex min-h-\[72px\] flex-1/.test(srcRight) && /shrink-0 flex-col overflow-hidden rounded-lg border/.test(srcRight),
  'E1c 最近编辑不再 flex-1 抢占空间（自适应收缩）')
ok(!/if \(recent\.length === 0\) return null/.test(srcRight) && /近 7 天没有编辑记录/.test(srcRight),
  'E1d 最近编辑常驻卡片（无记录显示空态文案，不再整卡消失——2026-09-17 反馈）')

// E2 工具侧栏真相源 + ToolHost 透传
ok(/TOOLS_WITH_SIDEBAR[^]*?\['habit-tracker', 'data-export', 'bookmark-nav', 'pdf-toolkit'\]/.test(srcRegistry.replace(/\n/g, ' ')),
  'E2 TOOLS_WITH_SIDEBAR 固定 4 工具（习惯打卡/数据导出/网址导航/PDF 工具箱，toolRegistry 唯一真相源）')
ok(/case 'habit-tracker':[^]*?sidebarEl=\{sidebarEl\}/.test(srcRegistry.replace(/\n/g, ' '))
  && /case 'pdf-toolkit':[^]*?sidebarEl=\{sidebarEl\}/.test(srcRegistry.replace(/\n/g, ' '))
  && /case 'bookmark-nav':[^]*?sidebarEl=\{sidebarEl\}/.test(srcRegistry.replace(/\n/g, ' '))
  && /case 'data-export':[^]*?sidebarEl=\{sidebarEl\}/.test(srcRegistry.replace(/\n/g, ' ')),
  'E2b ToolHost 向 4 个有侧栏工具透传 sidebarEl/sidebarHosted')

// E3 工具组件侧栏三态（portal / 槽未就绪 null / 原地内嵌）
const srcHabit = stripComments(read('src/modules/toolbox/components/habit-tracker/index.tsx'))
const srcExport = stripComments(read('src/modules/toolbox/components/export/ExportTool.tsx'))
const srcBookmark = stripComments(read('src/modules/toolbox/components/bookmark-nav/index.tsx'))
const srcPdf = stripComments(read('src/modules/toolbox/components/pdf-toolkit/index.tsx'))
for (const [name, src] of [['habit-tracker', srcHabit], ['data-export', srcExport], ['bookmark-nav', srcBookmark], ['pdf-toolkit', srcPdf]]) {
  ok(/createPortal/.test(src) && /sidebarHosted\s*\?\s*null/.test(src) && /sidebarEl\s*\?/.test(src),
    `E3 ${name} 侧栏三态（portal → hosted-null → 原地内嵌，knowledge 同款挂载点迁移）`)
}

// E4 App 接线：railTool 跟随 + 锁定回落 + 左栏模块态判定扩展
ok(/const \[railTool, setRailTool\]/.test(srcApp), 'E4 App 持有 railTool 工具侧栏态（瞬态跟随，不进书签/持久化体系）')
ok(/TOOLS_WITH_SIDEBAR\.has/.test(srcApp) && /setRailTool\(/.test(srcApp), 'E4b activeToolTab 变化跟随 railTool（无侧栏工具/切回文档清空）')
ok(/!wbLayout\.leftLocked && TOOLS_WITH_SIDEBAR\.has\(tid\)/.test(srcApp),
  'E4c 锁定时工具侧栏回落内嵌（toolHosted 判定含 !leftLocked，不与旧模块态抢 slot）')
ok(/railTool=\{railTool\}/.test(srcApp) && /railTool\?/.test(srcShell) && /railModule \|\| railTool/.test(srcLeft),
  'E4d App → Shell → LeftPanel railTool 透传，模块态条件 = railModule || railTool')

// E5 右栏下段：切换条（原型彩色图标）+ 番茄钟形态改造（2026-09-17）
ok(/RIGHT_PANEL_WIDGET_IDS: readonly string\[\] = \['pomo'\]/.test(srcWbl),
  'E5 右栏切换条挂载集 = 只番茄钟（RIGHT_PANEL_WIDGET_IDS 单点真相源；恢复控件 = 往这里加 id）')
ok(/RIGHT_PANEL_WIDGET_IDS\.filter/.test(srcRight) && /RIGHT_PANEL_WIDGET_IDS\.map/.test(srcRight),
  'E5b 切换条渲染与 ⋯ 选显菜单**同一挂载集**（只列番茄钟一项，两处口径一致）')
ok(/pomo: \{ icon: '⏰'/.test(srcRight) && /task: \{ icon: '✅'/.test(srcRight),
  'E5b2 图标表保留原型彩色 emoji（当前只渲染 ⏰ 番茄钟，其余 4 项供恢复引用）')
ok(/task: \{ icon: '✅'/.test(srcRight) && /pomo: \{ icon: '⏰'/.test(srcRight) && /nav: \{ icon: '🌐'/.test(srcRight),
  'E5b 切换条图标 = 原型彩色 emoji（✅ 今日任务 / 🔔 打卡 / ⏰ 番茄钟 / 🔑 密码 / 🌐 导航）')
const srcPomo = stripComments(read('src/components/workbench/widgets/PomoWidget.tsx'))
ok(/data-wb="pomoRing"/.test(srcPomo) && /strokeDashoffset/.test(srcPomo) && /const RING_CIRC = 2 \* Math\.PI \* RING_R/.test(srcPomo),
  'E5c 专注态环形进度（SVG 环 + stroke-dashoffset 周长派生）')
ok(/const ringMode = ps\.visible && ps\.phase === 'work'/.test(srcPomo),
  'E5d 环仅专注阶段显形（就绪/休息保持横条，拍板口径）')
ok(/data-wb="pomoControls"[^]*?grid w-full grid-cols-2/.test(srcPomo.replace(/\n/g, ' ')) && /col-span-2/.test(srcPomo),
  'E5e 控制钮等宽两列（就绪单钮跨两列，运行/暂停/完成 = 主钮 + 重置）')
ok(/与工具箱同源/.test(srcRight) === false && /小控件均已隐藏/.test(srcRight),
  'E5f 副说明文字已移除（无「与工具箱同源」；仅保留全隐藏时的空态提示）')
ok(/data-wb="widgetBrief"[^]*?flex min-h-0 flex-1 flex-col/.test(srcRight.replace(/\n/g, ' ')) && /m-auto w-full/.test(srcRight),
  'E5g 简略视图内容垂直居中（m-auto：上下留白均匀，超高时归零顶部起滚不被裁）')

// E6 底层 UI 统一（2026-09-17 第三轮反馈）：右栏外壳对齐左栏 + 番茄钟层级收敛
ok(/side="right"[\s\S]{0,700}?className=\{sidesGone \|\| maximized \? 'rounded-none border-0' : 'm-1\.5 rounded-xl border border-\[var\(--border-color\)\] shadow-sm'\}/.test(srcShell),
  'E6 右栏外壳 = 左栏同款卡片（m-1.5 + rounded-xl + border + shadow-sm，卡片装饰由外壳承担）')
ok(/data-wb="rightPanel"[\s\S]{0,150}?className="flex min-h-0 flex-1 flex-col overflow-hidden"/.test(srcRight),
  'E6b 右栏内层不再重复画卡片（去 border/bg/圆角/shadow，仅作布局容器）')
ok(!/maximized/.test(srcRight), 'E6c 右栏组件的 maximized prop 随卡片下移外壳而退役')
ok(/<PomoWidget frameless \/>/.test(srcRight) && /frameless\?: boolean/.test(srcPomo),
  'E6d 番茄钟在右栏走 frameless（不再画自带卡片，消除卡中卡）')
ok(!/排序：直接拖拽上方图标/.test(srcRight), 'E6e ⋯ 控件选显菜单不带底部排序说明文字（文案精简）')
ok(/mx-2\.5 mb-2\.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-\[var\(--border-color\)\] bg-\[var\(--bg-primary\)\]/.test(srcRight),
  'E6f 下段容器 = bg-primary 内容层 + 细边框（与外壳 bg-secondary 形成层次；简略视图本身不画边框，避免卡中卡）')

// ===== F. 页面条置顶（v3.4.0「工作台中间栏头部层级优化」第一项，2026-09-18）=====
// 形态：中间栏第一行 = 一条页面条（模块条目 + 编辑器页签组 + 知识库页签组），模块内部零头部行；
// 原 WorkbenchTabBar / PageTabBar 两个组件被 PageTabStrip 统一取代（两条外观必须同款）。
const srcKnowledge = stripComments(read('src/modules/knowledge/index.tsx'))
const srcPageBar = srcTb
const srcStrip = stripComments(read('src/components/workbench/PageTabStrip.tsx'))

ok(/WorkbenchPageBar/.test(srcApp) && !/WorkbenchTabBar/.test(srcApp),
  'F1 App 中间栏换用 WorkbenchPageBar（旧 WorkbenchTabBar 接线已摘除）')
ok(!existsSync(`${ROOT}/src/components/workbench/WorkbenchTabBar.tsx`)
  && !existsSync(`${ROOT}/src/modules/knowledge/components/PageTabBar.tsx`),
  'F2 两个旧标签条组件文件已删除（视觉统一到 PageTabStrip，不留双份）')
ok(/data-wb="pagebar"/.test(srcPageBar) && /data-pb-tabs=/.test(srcPageBar) && /data-pb-item/.test(srcPageBar)
  && /data-pb-slot="editor"/.test(srcPageBar) && /data-pb-slot="knowledge"/.test(srcPageBar),
  'F3 页面条契约属性齐备（pagebar / pb-item / pb-tabs / 两个 pb-slot）')
ok(/PAGE_OWNED/.test(srcPageBar) && /'editor', 'knowledge'/.test(srcPageBar),
  'F4 编辑器 / 知识库不占模块条目（由页面条目代表，页面清空即从条内消失）')
ok(!/编辑区/.test(srcEditor), 'F5 编辑器「编辑区」标题行已删除（源码层无残留标题）')
ok(/pageBarHosted/.test(srcEditor) && /createPortal\(/.test(srcEditor) && /pageBarEl\s*\n?\s*\?/.test(srcEditor),
  'F6 编辑器文件标签行 portal 进页面条槽（槽未就绪渲染 null，不回落内嵌）')
ok(/contentActionsHosted/.test(srcEditor) && /actionsPill/.test(srcEditor),
  'F7 编辑器四个动作收成胶囊并 portal 进内容级操作槽')
// 浮层结构（2026-09-20 悬浮栏改造）：外壳 `data-wb="mainPane"` 全宽 + pointer-events-none；
// 内层是**一个悬浮胶囊** `data-wb="floatBar"`（右上角 mt-3 mr-3）——两个槽（内容级操作 + 页面级工具）
// 都在胶囊里；静息收把手 / 毛玻璃 / 空胶囊隐身由 index.css 的 [data-wb='floatBar'] 段承担。
// 分屏时代外壳宽度曾是 `calc(100% - 副栏宽)`，下线后恒为全宽。
ok(/data-wb="mainPane"[\s\S]{0,200}?pointer-events-none[\s\S]{0,200}?w-full/.test(srcApp)
  && /data-wb="floatBar"/.test(srcApp) && /floatBar[\s\S]{0,120}?mr-3 mt-3/.test(srcApp)
  && (srcApp.match(/id="editor-toolbar-slot"/g) || []).length === 1,
  'F8 内容级操作浮层在 App（单个悬浮胶囊 floatBar 内含唯一 #editor-toolbar-slot；pointer-events 分层不挡内容）')
// F8b 悬浮栏样式基建与把手口径（2026-09-20）：CSS 段 + 次级钮标记类必须在位，
// 否则「静息收把手/毛玻璃/空胶囊隐身」三条行为整条失效（样式与实现分居两个文件，最易漏改）
const srcCss = read('src/styles/index.css')
ok(/\[data-wb='floatBar'\]/.test(srcCss) && /\.kb-float-hide/.test(srcCss)
  && /backdrop-filter/.test(srcCss) && /:not\(:has\(button\)\)/.test(srcCss),
  'F8b 悬浮栏样式基建在位（floatBar 胶囊 / kb-float-hide 把手 / 毛玻璃 / 空胶囊隐身）')
ok(/kb-float-hide/.test(read('src/modules/knowledge/components/PageEditor.tsx')) && /kb-float-hide/.test(srcEditor),
  'F8c 两个宿主（笔记页工具栏 / 编辑器动作胶囊）都标了次级钮 kb-float-hide')
ok(/pageBarHosted/.test(srcKnowledge) && /createPortal\(strip/.test(srcKnowledge),
  'F9 知识库页签条 portal 进页面条槽')
ok(/onImmersiveChange\?\.\(v\)/.test(srcKnowledge) && /readingMode \|\| graphMode/.test(srcKnowledge) && /pageBarHidden/.test(srcApp),
  'F10 沉浸阅读 / 图谱模式反向通知外壳让位（页面条整行隐藏）')
ok(/OWNER_COLOR/.test(srcStrip) && /PenLine/.test(srcStrip) && /BookOpen/.test(srcStrip)
  && /owner="editor"/.test(srcEditor) && /owner="knowledge"/.test(srcKnowledge),
  'F11 页签条按来源出图标与配色（编辑器=青笔 / 知识库=蓝书；两处调用各传自己 owner）')
ok(srcStrip.indexOf('if (items.length === 0) return null') > srcStrip.indexOf('const [draggedId'),
  'F12 页签条 hooks 全在早退之前（React #310 防线）')

// ===== G. 分屏整轮下线（2026-09-18 晚 · 从 v3.4.0 撤下，改排 v3.5.0）=====
// 背景：工作台分区精细化（分屏 + 准入收窄 + 跨栏保活）整轮撤下 v3.4.0，重做排期到 v3.5.0。
// 页面条置顶（F 段）与分屏无关、已完成验证，**保留不动**。
// 方案留档继续作为 3.5.0 输入：docs/workbench-split-scope-design.md（不删）。
// 本段做**负向断言**：确认分屏残留为零 —— 「只删了一半」是最容易漏的一类静默复发。
const srcModules = stripComments(read('src/lib/appModules.ts'))
const srcStatusBar = stripComments(read('src/components/shared/WorkbenchStatusBar.tsx'))

ok(!/SPLIT_ELIGIBLE|isSplitEligible/.test(srcModules),
  'G1 分屏准入清单 SPLIT_ELIGIBLE / isSplitEligible 已从 appModules.ts 整件移除')
ok(!/secondaryTab|setSecondaryTab/.test(srcApp) && !/activePane/.test(srcApp),
  'G2 App 无副栏 state（secondaryTab / activePane）残留')
ok(!/openInSecondary|toggleSplit|closeSplit|splitSecondaryWidth|splitPaneModules/.test(srcApp),
  'G3 App 无分屏回调与派生量（openInSecondary / toggleSplit / closeSplit / splitSecondaryWidth / splitPaneModules）')
ok(!/secondarySlotRef/.test(srcApp) && !/wbSecondaryTabsRef|wbSecActionsRef/.test(srcApp)
  && !/data-pb-split|data-pb-slot="secondary"|data-wb="splitPane"/.test(srcApp),
  'G4 副栏槽与副栏 DOM 标识（secondarySlotRef / wbSecActions / data-pb-split / splitPane）已清空')
ok(!existsSync(`${ROOT}/src/components/workbench/SplitHandle.tsx`) && !/SplitHandle/.test(srcApp),
  'G5 分屏手柄组件已删且 App 无引用（3.5.0 重做时从 git 历史取回）')
ok(!/paneActive/.test(srcStrip) && !/paneActive/.test(srcEditor) && !/paneActive/.test(srcKnowledge),
  'G6 栏焦点 paneActive 已从页签条与两个模块的调用点清空（页面条置顶成果不受影响）')
ok(!/SPLIT_FALLBACK_WIDTH|splitWidth/.test(srcApp) && !/RowsPerPane/.test(srcApp),
  'G7 副栏宽度兜底与实测宽度上报（SPLIT_FALLBACK_WIDTH / splitWidth）已删')
ok(!/Backslash/.test(srcApp) && !/Columns2/.test(srcApp),
  'G8 分屏入口全清：Ctrl+\\ 快捷键与页面条分屏按钮（Columns2 图标）')
// 负向：全仓（源码 + 外壳 + 下游文案）不得再有「分屏」概念残留
ok(!/分屏/.test(srcApp) && !/分屏/.test(srcStrip) && !/分屏/.test(srcPageBar) && !/分屏/.test(srcStatusBar),
  'G9 「分屏」概念已从 App / 页签条 / 页面条 / 状态栏的源码与注释中清除')

// ===== H. 中间主体冗余头部行清除（v3.4.0，2026-09-18 · A 组）=====
// 背景：多个模块在中间主体顶部自带一条「贯通行」（图标 + 模块名），与左栏标识 / 页面条重复。
// A 组 = 纯标题（无工具）可直接删：blog（博客）、devtools（开发者工具 · DEV）。
// 带工具的 5 项（aiChat / aiTeaching / schedule / bookshelf / releaseNotes）留待逐个讨论，不在本段。
// 运行时不变量：blog 删行后模块根只剩 1 个子元素、内容区占满容器高 —— 由
// probe-mod-header.mjs 在真实 Electron 内实证（G0~G5，含 knowledge 作对照组）。
const srcDevtools = stripComments(read('src/modules/devtools/index.tsx'))

ok(!/顶部贯通行（图二骨架）：横跨侧栏 \+ 内容区；快捷动作在侧栏内搜索框上方/.test(srcBlog),
  'H1 blog 顶部贯通行 JSX 整块已删（连同原注释）')
ok(!/FileText/.test(srcBlog),
  'H2 blog 已清掉删行后无用的 FileText 图标 import')
ok(!/<span[^>]*>博客<\/span>/.test(srcBlog),
  'H3 blog 源码层无「博客」标题 span 残留（左栏 Sidebar 自己的标识不动）')
ok(!/FlaskConical/.test(srcDevtools),
  'H4 devtools 已清掉删行后无用的 FlaskConical 图标 import')
ok(!/开发者工具<\/span>|>DEV<\/span>/.test(srcDevtools),
  'H5 devtools 源码层无「开发者工具」/「DEV」徽章残留')
const blogMainOpen = (srcBlog.match(/<div className="flex min-h-0 flex-1">/g) || []).length
ok(blogMainOpen === 1,
  'H6 blog 删行后主区容器恰好一处（未误删/误留兄弟层）', `count=${blogMainOpen}`)

// ===== I. B 组首批：aiChat 页态标题行 + 页面条空态提示（v3.4.0，2026-09-18 反馈轮）=====
// 背景：开发负责人指出两处漏删 —— ① 右栏 AI 栏 ⤢ 扩大的主体页（中栏 aiChat 标签，ChatBody page 态）
// 顶部仍有「✦ AI 助手」纯标题行，与左栏 AI 会话侧栏重复；② 页面条空态提示文字属冗余说明（铁律 12）。
// 判据：① ChatBody 轻头部渲染条件收窄为「有控件可放」（showDrawer 或 docked 的 ⤢）；
//       ② 页面条空态提示块与 its 专属 state（hasAnyItem）/ MutationObserver 观察一并清除。
// 运行时由 probe-batch5-ai.mjs 的 A2b/A6b 与 probe-pagebar.mjs 的 P 组在真实 Electron 内实证。
const srcChatBody = stripComments(read('src/components/shared/AssistantPanel/ChatBody.tsx'))

ok(/variant !== 'sidebar' && \(showDrawer \|\| \(isNarrow && onExpand\)\)/.test(srcChatBody),
  'I1 ChatBody 轻头部仅在「有控件可放」时渲染（page 态无控件 → 整块不渲染）')
ok(!/没有打开的页面/.test(srcPageBar),
  'I2 页面条空态提示文字已删（源码层无「没有打开的页面」残留）')
ok(!/hasAnyItem/.test(srcPageBar) && !/MutationObserver/.test(srcPageBar),
  'I3 页面条空态专属 state（hasAnyItem）与 MutationObserver 观察已一并清除（不留死代码）')
// I4 防陈旧选择器：页面条置顶后 [data-wb="tabbar"] 已退役（F1/P1b），
// 探针若**正向**用它选条目 = 断言必然 miss 后读到上一个态的容器（假失败/假通过）。
// 负向用法（`!q('[data-wb="tabbar"]')` 之类，P1b 就是在断言它已退役）是合法的，不计入。
// batch5 探针写于置顶之前，2026-09-18 已迁移到 pagebar —— 本断言防它回退。
//
// 未纳入扫描的已知陈旧探针（整探针仍待迁移，非本轮范围）：
//   probe-tabbar-dyn.mjs —— D1/D4a/D6c 段针对已退役的标签条（含「没有打开的标签页」空态），
//     其 D7~D12（vaultBar / 书签菜单 / 工具侧栏 / 番茄钟）断言仍有价值，
//     待后续整体迁移到 pagebar 口径时一并处理。
const probeDir = '.AGENT/scripts/workbench-shell/probes'
const I4_SKIP = new Set(['probe-tabbar-dyn.mjs'])
const staleTabbar = []
for (const f of readdirSync(`${ROOT}/${probeDir}`)) {
  if (!f.endsWith('.mjs') || I4_SKIP.has(f)) continue
  const src = stripComments(read(`${probeDir}/${f}`))
  // 正向形态：作为选择器出现在 querySelector* 里（`!q(...)` 的负向断言不算）
  const re = /(?<![!])\bq(?:uerySelector|uerySelectorAll)?\s*\(\s*'\[data-wb="tabbar"\]/g
  if (re.test(src)) staleTabbar.push(f)
}
ok(staleTabbar.length === 0,
  'I4 探针层无陈旧 tabbar 正向选择残留（条目一律走 [data-wb="pagebar"] [data-wb-tab]）',
  staleTabbar.join(', ') || 'clean')

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`✅ 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`❌ ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
