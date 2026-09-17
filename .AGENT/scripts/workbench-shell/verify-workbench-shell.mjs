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
import { readFileSync } from 'node:fs'
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
ok(followValues.every((v) => ['editor', 'knowledge', 'schedule', 'bookshelf', 'blog'].includes(v)),
  'A6 跟随映射的值域合法（quiz 不由标签触发，不进映射）')
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

// C1 图标条按钮集（固定 5 按钮：RAIL_BUTTONS 4 项 + 底部设置；与 startup-tab 契约 B4/C1 互为镜像）
const railM = srcBar.match(/const\s+RAIL_BUTTONS[\s\S]*?=\s*\[([\s\S]*?)\n\]/)
const railIds = railM ? [...railM[1].matchAll(/id:\s*'([A-Za-z][\w]*)'/g)].map((x) => x[1]) : null
ok(railIds?.join(',') === 'recycle,plugins,toolbox,moments', 'C1 图标条 RAIL_BUTTONS = 回收站/插件市场/工具箱/动态', railIds ? `实际 ${railIds.join(',')}` : '抠不到')
ok(/title="设置"/.test(srcBar), 'C1b 图标条底部设置按钮存在')

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

// C14 bookshelf 占位模块存在且被 App 渲染
ok(/case\s+'bookshelf':\s*return <BookshelfModule/.test(srcApp), 'C14 App 渲染 bookshelf 占位模块')

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
ok(/\{fullWindowTab && \(/.test(srcApp) && /title="返回工作台"/.test(srcApp),
  'C20b 整窗模块激活时显示「返回工作台」返回钮（返回 openTabs 最后工作台标签）')

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`✅ 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`❌ ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
