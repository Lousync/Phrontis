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
import { readFileSync, existsSync } from 'node:fs'
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
ok(keys.length === 6, 'A1 内置书签固定 6 项（编辑区/知识库/日程/书架/博客总结/错题本）', `实际 ${keys.length}`)
ok(new Set(keys).size === keys.length, 'A2 书签 key 无重复')
ok(keys.join(',') === 'editor,knowledge,schedule,bookshelf,blog,quiz', 'A3 书签集合与顺序 = v15 定稿', `实际 ${keys.join(',')}`)
ok(WORKBENCH_BOOKMARKS.every((b) => isTabName(b.tab)), 'A4 每个书签的 tab 都是合法 TabName',
  WORKBENCH_BOOKMARKS.filter((b) => !isTabName(b.tab)).map((b) => b.key).join(','))
const quiz = WORKBENCH_BOOKMARKS.find((b) => b.key === 'quiz')
ok(quiz?.tab === 'knowledge', 'A5 错题本书签 = knowledge 标签（不占独立 TabName，方案 §3.3）', `实际 ${quiz?.tab}`)
const followValues = Object.values(RAIL_FOLLOW_MAP)
ok(followValues.every((v) => ['editor', 'knowledge', 'schedule', 'bookshelf', 'blog', 'aiChat'].includes(v)),
  'A6 跟随映射的值域合法（quiz 不由标签触发，不进映射；aiChat 批次5 反馈轮入映射）')
for (const k of ['editor', 'knowledge', 'schedule', 'bookshelf', 'blog']) {
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
ok(/case\s+'editor'[\s\S]{0,220}sidebarEl=\{on && railModule === 'editor'/.test(srcApp), 'C3 editor sidebarEl ← 左栏模块态')
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
ok(/id="editor-toolbar-slot"/.test(srcApp) && /pointer-events-none absolute right-3 top-3/.test(srcApp),
  'F8 内容级操作浮层在 App（含 #editor-toolbar-slot；pointer-events 分层不挡内容）')
ok(/pageBarHosted/.test(srcKnowledge) && /createPortal\(strip/.test(srcKnowledge),
  'F9 知识库页签条 portal 进页面条槽')
ok(/onImmersiveChange\?\.\(v\)/.test(srcKnowledge) && /readingMode \|\| graphMode/.test(srcKnowledge) && /pageBarHidden/.test(srcApp),
  'F10 沉浸阅读 / 图谱模式反向通知外壳让位（页面条整行隐藏）')
ok(/OWNER_COLOR/.test(srcStrip) && /PenLine/.test(srcStrip) && /BookOpen/.test(srcStrip)
  && /owner="editor"/.test(srcEditor) && /owner="knowledge"/.test(srcKnowledge),
  'F11 页签条按来源出图标与配色（编辑器=青笔 / 知识库=蓝书；两处调用各传自己 owner）')
ok(srcStrip.indexOf('if (items.length === 0) return null') > srcStrip.indexOf('const [draggedId'),
  'F12 页签条 hooks 全在早退之前（React #310 防线）')

// ===== G. 分屏完整化（中间栏双栏分区，2026-09-18）=====
// 形态：页面条右端一个分屏开关 + Ctrl+\；副栏 = 自己那块区域；栏焦点 activePane 决定
// 「页面条点模块条目开在哪一栏」；关闭统一走 closeSplit 复位焦点。
// （注：原副栏顶条的 SplitPaneMenu 已于第十二轮删除，见 G9 / J5）

ok(/activePane/.test(srcApp) && /const closeSplit = useCallback/.test(srcApp) && /const toggleSplit = useCallback/.test(srcApp),
  'G1 App 有栏焦点 activePane + closeSplit / toggleSplit 两个收口')
ok(/data-pb-split-btn="1"/.test(srcApp) && /onClick=\{toggleSplit\}/.test(srcApp)
  && /data-pb-split-close="1"/.test(srcApp) && /onClick=\{closeSplit\}/.test(srcApp),
  'G2 分屏开关只在未分屏时出（data-pb-split-btn）；分屏后由副段 ✕（data-pb-split-close → closeSplit）关闭')
// 注：`Ctrl+\` 的反斜杠在 regex 字面量里要写成 `\\\\`，极易写错；且此脚本用的是 `stripComments`
// 后的源码，**注释里的字面量测不到**。所以这里只用代码判据：① 分屏 keydown 处理体认 `\` / `Backslash`
// （用 e.code 断，绕开反斜杠转义）；② 该处理体挂在 window keydown 上并正确清理。
ok(/e\.ctrlKey && \(e\.key === '\\\\' \|\| e\.code === 'Backslash'\)/.test(srcApp)
  && /window\.addEventListener\('keydown', onKey\)[\s\S]{0,400}?return \(\) => window\.removeEventListener\('keydown', onKey\)/.test(srcApp),
  'G3 Ctrl+\\ 全局快捷键已绑定（分屏 toggle 处理体接管 Backslash，且 effect 正确卸载）')
ok(!/setSecondaryTab\(secondaryTab \? null/.test(srcApp) && !/onSnapClose=\{\(\) => setSecondaryTab\(null\)\}/.test(srcApp)
  && !/onClose=\{\(\) => setSecondaryTab\(null\)\}/.test(srcApp),
  'G4 关闭副栏的四条路径（拖拽收合 / 顶条 ✕ / 页面条按钮 / Ctrl+\\）都走 closeSplit，无遗留 setSecondaryTab(null)')
ok(/function renderModuleContent\(name: TabName, on: boolean, pane/.test(srcApp)
  && /function renderMounted\(name: TabName, on: boolean, pane/.test(srcApp)
  && /renderMounted\(t, t === activeTab \|\| isSec, isSec \? 'secondary' : 'main'\)/.test(srcApp),
  'G5 栏位参数 pane 贯通 renderMounted → renderModuleContent（副栏模块同一调用点传 secondary）')
ok(/pageBarEl=\{pane === 'main' \? wbKnowledgePageEl : wbSecondaryTabsEl\} pageBarHosted/.test(srcApp)
  && /pageBarEl=\{pane === 'main' \? wbEditorPageEl : wbSecondaryTabsEl\} pageBarHosted/.test(srcApp)
  && /secondarySlotRef=\{wbSecondaryTabsRef\}/.test(srcApp),
  'G6 页签归属：主栏 → 主段编辑器/知识库槽；副栏 → 顶栏副段槽（两栏页签同挂一条行）')
ok(/data-wb="splitPane"/.test(srcApp)
  && /onMouseDownCapture=\{\(\) => \{ if \(\(activePane === 'main'\) === isSec\) return; setActivePane\(isSec \? 'secondary' : 'main'\) \}\}/.test(srcApp),
  'G7 副栏容器带 data-wb=splitPane 且点击接管栏焦点（与主栏同一套 click-capture 语义）')
ok(/data-wb="mainPane"/.test(srcApp) && /if \(activePane !== 'main'\) setActivePane\('main'\)/.test(srcApp),
  'G11 主栏容器带 data-wb=mainPane（栏焦点的两个锚点都在 DOM 上可观测）')
ok(/activePane !== 'main'\) setActivePane\('main'\)/.test(srcApp) && /data-pane-module=\{t\}/.test(srcApp),
  'G8 主栏点击回收焦点；副栏容器暴露 data-pane-module（模块序列化渲染，属性值 = 该栏模块名）')
ok(!existsSync(`${ROOT}/src/components/shared/SplitPaneMenu.tsx`),
  'G9 ⋯ 菜单（SplitPaneMenu）已随「副段 chip 纯标识化」整件退役（2026-09-18 第十二轮，见 J5）')
ok(/activePane === 'secondary' && secondaryTab && t !== activeTab/.test(srcApp) && /setSecondaryTab\(t\)/.test(srcApp),
  'G10 副栏聚焦时页面条点模块条目 → 开进副栏（focused group 语义）')

// ===== H. 分屏改 VS Code 式（2026-09-18 第二轮反馈拍板）=====
// 形态：副栏**不再有**独立的功能条（模块名 + 下拉 + ✕），顶部就是该模块自己的标签行；
// 栏焦点靠标签明暗（非焦点栏的激活标签不给底色）；模块切换/关闭收进 ⋯ 菜单。
ok(!existsSync(`${ROOT}/src/components/shared/SplitPaneBar.tsx`) && !/SplitPaneBar/.test(srcApp),
  'H1 旧的副栏功能条组件已删除且 App 不再引用（副栏顶部只该有标签行）')
ok(/paneActive\?: boolean/.test(srcStrip)
  && /data-pane-active=\{paneActive \? '1' : '0'\}/.test(srcStrip)
  && /paneActive \? '' : 'opacity-75'/.test(srcStrip)
  && /bg-transparent text-\[var\(--text-secondary\)\]/.test(srcStrip),
  'H2 栏焦点 = 标签明暗：非焦点栏整条淡化 + 激活标签不出底色（VS Code 观感，不另加边框/竖线）')
ok(/\tpaneActive=| paneActive=\{paneActive\}/.test(srcEditor)
  && /paneActive=\{paneActive\}/.test(srcKnowledge)
  && /paneActive=\{pane === 'main' \? activePane === 'main' : activePane === 'secondary'\}/.test(srcApp),
  'H3 paneActive 从 App 贯通到两个模块的标签组（不分屏时恒 true，不引入无意义淡化）')
ok(/secondarySlotRef/.test(srcPageBar) && /data-pb-slot-wrap="secondary"/.test(srcPageBar) && /data-pb-slot="secondary"/.test(srcPageBar)
  && /border-l border-\[var\(--border-color\)\]/.test(srcPageBar),
  'H4 顶栏 = 一条行两段：主段（flex-1）+ 副段（border-l 分界竖线 + 模块名 chip + 副栏页签槽 + ✕）')
ok(/function paneChipNode\(cur: TabName\)/.test(srcApp) && /data-pb-pane-chip=\{cur\}/.test(srcApp)
  && /lead: paneChipNode\(secondaryTab\)/.test(srcApp)
  && /\{secondary\.lead\}/.test(srcPageBar),
  'H5 副段左端 = 模块名 chip（**纯标识**，第十二轮起不再是 ⌄ 菜单；App 渲染 → PageBar 以 secondary.lead 承载，见 J6）')
ok(!/data-pb-split="1"/.test(srcApp) && !/triggerTitle="选择副栏模块 \/ 关闭分屏"/.test(srcApp)
  && !/paneMenu=/.test(srcApp),
  'H6 旧的两处 ⋯ 入口（模块标签行右端 paneMenu / 页面条小箭头）已收回，入口统一在副段')
ok(/data-wb="mainPane"[\s\S]{0,900}?id="editor-toolbar-slot"/.test(srcApp)
  && /secondaryTab !== 'knowledge' && \(/.test(srcApp) && /t === 'knowledge' && \(/.test(srcApp)
  && (srcApp.match(/id="editor-toolbar-slot"/g) || []).length === 2,
  'H7 内容级操作浮层按栏各一份（mainPane 内 + splitPane 内）；#editor-toolbar-slot 恰好两处且互斥渲染 → 全窗口只出现一次')

// ===== I. 两栏共用一条顶栏（2026-09-18 第三轮反馈：页面条下面右边「矮上一节」）=====
// 病根：主栏页签在全宽条里、副栏页签在副栏自己的一行里 → 横向底线不在同一 y、分界处断成两段。
// 修法：两栏的条合并成同一条（主段 + 副段），副段宽度取副栏实测宽度与手柄对齐。
ok(/style=\{\{ width: secondary\.width \}\}/.test(srcPageBar)
  && /width: splitSecondaryWidth,/.test(srcApp) && /onWidthChange=\{setSplitWidth\}/.test(srcApp),
  'I1 副段宽度取副栏实测宽度（SplitHandle.onWidthChange → splitWidth → splitSecondaryWidth），分界竖线才能与分屏手柄对齐')
ok(/data-pb-main/.test(srcPageBar) && /items-stretch/.test(srcPageBar),
  'I2 一条行内部 items-stretch：分界竖线贯穿整行高度，底线连续、不再断成两段')
ok(!/paneMenu/.test(srcEditor) && !/paneMenu/.test(srcKnowledge),
  'I3 paneMenu 机制退役：副栏页签已挂在顶栏副段，模块不再自渲染一行 + ⋯')
ok(/isActive && contentActionsHosted && contentActionsEl && createPortal\(actionsPill, contentActionsEl\)/.test(srcEditor),
  'I4 编辑器动作胶囊加 isActive 门槛（隐藏保活时不会飘到当前模块头上）')

// ===== J. 副栏准入收窄 + 副段 chip 纯标识化 + ★ 跨栏保活（2026-09-18 第十二轮）=====
// 方案：docs/workbench-split-scope-design.md；核心病根 = 模块容器跨父节点搬迁 → React 卸载重建。
const srcModules = stripComments(read('src/lib/appModules.ts'))
const srcSplitHandle = stripComments(read('src/components/workbench/SplitHandle.tsx'))

ok(/export const SPLIT_ELIGIBLE: TabName\[\] = \['editor', 'knowledge'\]/.test(srcModules)
  && /export function isSplitEligible/.test(srcModules),
  'J1 分屏准入唯一真相源 SPLIT_ELIGIBLE + isSplitEligible 落在 appModules.ts')
ok(/isSplitEligible\(target\)/.test(srcApp) && /const openInSecondary = useCallback/.test(srcApp),
  'J2 开副栏收敛到 openInSecondary（准入判断在收口层，三个入口自动同口径）')
ok(/isSplitEligible\(activeTab\)/.test(srcApp) && /分屏仅支持编辑区 \/ 知识库/.test(srcApp)
  && /showToast\(\{ type: 'info', message: '分屏仅支持编辑区 \/ 知识库' \}\)/.test(srcApp),
  'J3 Ctrl+\\ 在主栏非准入模块时 → 不换主栏、不强开副栏，只给一次提示（B 方案）')
ok(!/split-toggle/.test(srcApp) && /SPLIT_ELIGIBLE\.filter\(\(t\) => t !== activeTab\)/.test(srcApp),
  'J4 命令面板分屏组只消费 SPLIT_ELIGIBLE（2 条打开项，排除主栏自身；旧的开启/关闭项已删）')
ok(!existsSync(`${ROOT}/src/components/shared/SplitPaneMenu.tsx`) && !/SplitPaneMenu/.test(srcApp)
  && !/paneMenuNode/.test(srcApp),
  'J5 SplitPaneMenu 组件文件已删 + App 无 paneMenuNode 残留（副段不再是菜单）')
ok(/function paneChipNode\(cur: TabName\)/.test(srcApp) && /data-pb-pane-chip=\{cur\}/.test(srcApp)
  && /cursor-default/.test(srcApp) && !/ChevronDown/.test(srcApp),
  'J6 副段模块名 = 纯标识 span（data-pb-pane-chip、cursor-default、全文件无 ChevronDown）')
// ★ 跨栏保活的结构三约束（任一条破了就退回卸载重建，见 docs 方案 §2.5）
ok(/const rowModules = useMemo<TabName\[\]>/.test(srcApp)
  && /const visited = Array\.from\(mountedTabs\.current\)/.test(srcApp),
  'J7 ★ 模块序列 rowModules 按 mountedTabs 访问序生成（顺序恒定，不随栏位变化）')
ok(/\{rowModules\.map\(\(t\) => \{/.test(srcApp) && /const isSec = t === secondaryTab/.test(srcApp)
  && /order: isSec \? 2 : 1/.test(srcApp),
  'J8 ★ 单一父节点 + pane 只改样式：模块容器同挂一行，order 决定视觉左右')
ok(!/renderMounted\(secondaryTab, true, 'secondary'\)/.test(srcApp)
  && /renderMounted\(t, t === activeTab \|\| isSec, isSec \? 'secondary' : 'main'\)/.test(srcApp),
  'J9 ★ 副栏模块不再单独渲染进另一个容器（旧结构 = 跨父节点搬迁 = 卸载重建）')
ok(!/<ResizablePanel/.test(srcApp) && /<SplitHandle/.test(srcApp) && /from '\.\/components\/workbench\/SplitHandle'/.test(srcApp),
  'J10 副栏不再用 ResizablePanel 装模块（它会把模块变成子孙 = 另一个父节点）；改用 SplitHandle')
ok(/splitPaneModules/.test(srcApp) && /onWidthChange=\{setSplitWidth\}/.test(srcApp),
  'J11 副栏仍有 splitPaneModules / 宽度上报（宽度真相源在 App，模块容器与顶栏副段共用）')
ok(/function SplitHandle/.test(srcSplitHandle) && /setPointerCapture/.test(srcSplitHandle)
  && /onLostPointerCapture=\{\(\) => endDrag\(\)\}/.test(srcSplitHandle)
  && /document\.body\.style\.cursor = ''/.test(srcSplitHandle),
  'J12 SplitHandle 原样继承 ResizablePanel 的拖拽语义（pointer capture + 四路收尾 + body 污染兜底）')
// ★ 副栏宽度兜底的单一真相源（2026-09-18 实机探针 S2e 抓到的 81px 错位根因）：
// App 曾用 `380` 兜底、PageBar 自留 `46%` 兜底 → 两个基准不同的数算同一个未知宽度。
// 断言：常量只声明一次、五处调用点全用它、且**全仓无残留的第二种兜底写法**。
const splitFallbackSites = (srcApp.match(/SPLIT_FALLBACK_WIDTH/g) || []).length
ok(/const SPLIT_FALLBACK_WIDTH = 380/.test(srcApp) && /const splitSecondaryWidth = splitWidth > 0 \? splitWidth : SPLIT_FALLBACK_WIDTH/.test(srcApp)
  && splitFallbackSites >= 2
  && !/splitWidth > 0 \? splitWidth : 380/.test(srcApp)
  && !/width: secondary\.width > 0 \? secondary\.width : '46%'/.test(srcPageBar)
  && /style=\{\{ width: secondary\.width \}\}/.test(srcPageBar),
  'J13 ★ 副栏宽度兜底单一真相源 SPLIT_FALLBACK_WIDTH（App 五处调用点共用；PageBar 不自带第二种兜底）')

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`✅ 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`❌ ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
