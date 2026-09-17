/**
 * 契约脚本：模块清单唯一真相源 + 启动落点
 *
 * 覆盖的缺陷：**把侧边栏模块全部隐藏后重启，应用自动打开回收站**。
 * 根因不是「兜底逻辑写错了」，而是**模块清单被抄在 6 个地方且已经飘了**：
 * 启动候选表里有 `recycle` / `help`，而这两个模块不在活动栏的显隐菜单里（永远隐藏不掉），
 * 于是「前七项全被隐藏」时兜底循环必然走到 recycle。所以本脚本查两件事：
 *   ① 唯一真相源自洽、各消费方不再各抄一份（负向断言：旧字面量必须消失）；
 *   ② `resolveStartupTab` 的行为 —— 穷举全部隐藏组合，结果永不为回收站/帮助等"刻意目的地"。
 *
 * v3.4.0（工作台三栏外壳）口径：TabName 16 项 —— 删 `desktop`（磁贴壳被三栏外壳替代）、
 * 删 `user`（账户并入设置）；增 `bookshelf` / `aiChat` / `graph`（入口产生型，不当启动落点）；
 * 启动兜底 desktop → **editor**；moments 改名「动态」。
 *
 * 与探针的区别：这里**直接 import 真实实现**（`src/lib/appModules.ts`，靠 Node 的
 * `--experimental-strip-types` 剥离类型），而不是照抄一份算法 —— 抄一份正好会掩盖本次这类缺陷。
 *
 * 用法：
 *   node --experimental-strip-types .AGENT/scripts/startup-tab/verify-startup-tab.mjs
 */
import { readFileSync } from 'node:fs'
import {
  APP_MODULES, BAR_MODULE_IDS, STARTABLE_MODULE_IDS, TILE_MODULE_IDS, PALETTE_MODULES,
  isTabName, labelOf, normalizeModuleId, activityOrder, activityVisibleOrder, resolveStartupTab,
} from '../../../src/lib/appModules.ts'

const ROOT = 'E:/Projects/KnowledgeRecorder'
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}

/**
 * 只剥注释、**保留字符串字面量** —— 本脚本的负向断言正是要匹配被删掉的数组字面量
 * （`['blog','schedule',…]`），把字符串一起剥了就什么都查不到。
 * 用状态机而不是正则：正则会被字符串里的 `//`（如 'https://…'）或模板串骗到。
 */
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

/* ================= A. 唯一真相源自洽 ================= */
console.log('\n=== A. 唯一真相源自洽 ===')
const ids = APP_MODULES.map((m) => m.id)
ok(new Set(ids).size === ids.length, 'A2 APP_MODULES 内 id 无重复')
ok(ids.length === 16, 'A2b APP_MODULES 覆盖 16 个 TabName（v3.4.0：-desktop -user +bookshelf +aiChat +graph）', `实际 ${ids.length}`)
ok(!ids.includes('desktop') && !ids.includes('user'), 'A2c 已删除的 desktop/user 不再出现在清单')
ok(BAR_MODULE_IDS.every((id) => ids.includes(id)), 'A3 BAR_MODULE_IDS ⊆ APP_MODULES')
ok(STARTABLE_MODULE_IDS.every((id) => BAR_MODULE_IDS.includes(id)), 'A4 可启动模块 ⊆ 活动栏模块（非活动栏模块不该当落点）')
const utility = ['recycle', 'help', 'settings', 'releaseNotes', 'devtools', 'bookshelf', 'aiChat', 'graph']
const leaked = utility.filter((id) => STARTABLE_MODULE_IDS.includes(id))
ok(leaked.length === 0, 'A5 回收站/帮助/设置/更新说明/开发者工具/书架/AI对话/图谱 都不可作启动项', `漏了 ${leaked.join(',')}`)
ok(resolveStartupTab(undefined, '[]') === 'editor', 'A6 启动兜底落点是编辑区（v3.4.0 工作台主区）')
ok(resolveStartupTab('desktop', '[]') === 'editor', 'A6b 旧版兜底值 desktop 作为输入时也落编辑器（老设置安全）')
console.log(`  活动栏位(${BAR_MODULE_IDS.length})：${BAR_MODULE_IDS.join(', ')}`)
console.log(`  可启动(${STARTABLE_MODULE_IDS.length})：${STARTABLE_MODULE_IDS.join(', ')}`)
console.log(`  可作磁贴(${TILE_MODULE_IDS.length})：${TILE_MODULE_IDS.join(', ')}`)
console.log(`  命令面板(${PALETTE_MODULES.length})：${PALETTE_MODULES.map((m) => m.id).join(', ')}`)

/* ================= B. 各消费方不再各抄一份（负向断言） ================= */
console.log('\n=== B. 旧的手抄清单必须已消失（负向断言） ===')
const srcApp = stripComments(read('src/App.tsx'))
const srcBar = stripComments(read('src/components/shared/ActivityBar.tsx'))
const srcTiles = stripComments(read('src/modules/desktop/tiles.tsx'))
const srcOnb = stripComments(read('src/components/shared/Onboarding.tsx'))
const srcAppear = stripComments(read('src/modules/settings/views/AppearanceView.tsx'))
const srcSettings = stripComments(read('src/lib/settings.ts'))
const srcModules = stripComments(read('src/lib/appModules.ts'))
// 数组字面量的「松散匹配」：允许空白/换行，只要按下标顺序出现这几个 id 就算命中
const looseArray = (...idsWanted) =>
  new RegExp('\\[\\s*' + idsWanted.map((s) => `'${s}'`).join('\\s*,\\s*') + '\\s*[,]')
ok(!looseArray('blog', 'schedule', 'knowledge', 'editor').test(srcApp),
  'B1 App.tsx 的硬编码启动候选表已删除', '仍匹配到 [\'blog\',\'schedule\',\'knowledge\',\'editor\',…]')
ok(!looseArray('blog', 'schedule', 'knowledge', 'moments').test(srcApp),
  'B2 App.tsx 的小窗 switch-tab 硬编码白名单已删除')
ok(!/const\s+MODULE_TABS\s*(:|=)/.test(srcApp), 'B3 App.tsx 不再自持 MODULE_TABS（改用 PALETTE_MODULES）')
ok(/const\s+RAIL_BUTTONS\s*:[\s\S]*?=\s*\[/.test(srcBar),
  'B4 ActivityBar 图标条为固定 RAIL_BUTTONS 清单（v3.4.0 拍板：不再由 BAR_MODULE_IDS 派生）')
ok(!/BAR_MODULE_IDS/.test(srcBar),
  'B4c ActivityBar 不再引用 BAR_MODULE_IDS（图标条 4 项独立拍板，禁手抄回归）')
ok(!/\[\s*\{\s*id:\s*'desktop'\s*,\s*label:\s*'桌面'/.test(srcBar),
  'B4b 旧的 9 项字面量数组已删除')
ok(!/const\s+DESK_MODULES\s*:\s*ModuleDef\[\]\s*=\s*\[/.test(srcTiles), 'B5 tiles.tsx 不再自持 DESK_MODULES 字面量（改用 TILE_MODULE_IDS）')
ok(!/const\s+ACTIVITY_MODS\s*=\s*\[/.test(srcOnb), 'B6 Onboarding 不再自持 ACTIVITY_MODS 字面量')
ok(!/const\s+TABS\s*:\s*\{[^}]*\}\[\]\s*=\s*\[/.test(srcAppear), 'B7 设置页不再自持启动项 TABS 字面量')
ok(!/case\s+'desktop'/.test(srcApp) && !/case\s+'user'/.test(srcApp),
  'B8 App.tsx 已无 desktop/user 渲染分支（v3.4.0 删模块）')
ok(!/unshift\('desktop'\)/.test(srcBar) && !/unshift\('desktop'\)/.test(srcModules),
  'B9 活动栏顺序不再把 desktop 顶到首位（v3.4.0）')

/* ================= C. 图标表必须覆盖成员 ================= */
console.log('\n=== C. 图标表覆盖成员（新增模块忘了配图标会渲染成空） ===')
const keysOfRecord = (src, name) => {
  // ⚠️ 别用 `Record<[^>]*>` 去跳类型注解：注解里常有 `(size: number) => ReactNode`，
  // 那个 `=>` 里就带 `>`，字符类会在这里断掉、整个匹配失败（探针会误报「抠不到图标表」）。
  // 用惰性匹配顶到 `= {`，再取到第一个顶格 `}` 为止。
  const m = src.match(new RegExp(`const\\s+${name}[\\s\\S]*?=\\s*\\{([\\s\\S]*?)\\n\\}`))
  return m ? [...m[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((x) => x[1]) : null
}
const checkCover = (label, keys, members) => {
  if (keys === null) return ok(false, label, '抠不到图标表（结构变了，脚本要跟着改）')
  const miss = members.filter((id) => !keys.includes(id))
  return ok(miss.length === 0, label, `缺 ${miss.join(',')}`)
}
// C1 v3.4.0 批次4 新口径（2026-09-17 拍板变化）：图标条 = 固定 RAIL_BUTTONS 数组
//   （回收站/插件市场/动态）+ 底部设置按钮——🧰工具箱按钮撤掉，入口语义由右栏上部
//   「工具箱工具入口区」（ToolLauncherZone，方案 §10）承接。旧 BAR_ICONS Record 已随外壳重写删除。
const railIds = (() => {
  const m = srcBar.match(/const\s+RAIL_BUTTONS[\s\S]*?=\s*\[([\s\S]*?)\n\]/)
  return m ? [...m[1].matchAll(/id:\s*'([A-Za-z][\w]*)'/g)].map((x) => x[1]) : null
})()
if (railIds === null) {
  ok(false, 'C1 ActivityBar RAIL_BUTTONS 覆盖拍板 3 项（回收站/插件市场/动态）', '抠不到 RAIL_BUTTONS（结构变了，脚本要跟着改）')
} else {
  ok(railIds.join(',') === 'recycle,plugins,moments',
    'C1 ActivityBar RAIL_BUTTONS 覆盖拍板 3 项（回收站/插件市场/动态，工具箱撤到右栏入口区）', `实际 ${railIds.join(',')}`)
}
ok(/title="设置"/.test(srcBar), 'C1b 图标条底部设置按钮存在（直开设置标签页）')
checkCover('C2 设置页 STARTUP_ICONS 覆盖全部可启动模块', keysOfRecord(srcAppear, 'STARTUP_ICONS'), STARTABLE_MODULE_IDS)
checkCover('C3 tiles.tsx TILE_META 覆盖全部可作磁贴模块', keysOfRecord(srcTiles, 'TILE_META'), TILE_MODULE_IDS)
checkCover('C4 Onboarding SCENE_META 覆盖全部活动栏模块', keysOfRecord(srcOnb, 'SCENE_META'), BAR_MODULE_IDS)

/* ================= D. settings 默认值 ================= */
console.log('\n=== D. 设置默认值里不许出现非活动栏 id（本次 bug 的引信） ===')
const orderDefM = srcSettings.match(/activityBarOrder:\s*\{\s*default:\s*'([^']*)'/)
ok(!!orderDefM, 'D0 抠到 activityBarOrder 默认值')
const orderDefault = orderDefM ? JSON.parse(orderDefM[1]) : []
const strayIds = orderDefault.filter((id) => !BAR_MODULE_IDS.includes(id))
ok(strayIds.length === 0, 'D1 默认顺序里全部是活动栏模块', `混进了 ${strayIds.join(',')}`)
ok(!orderDefault.includes('desktop') && !orderDefault.includes('user'), 'D1b 默认顺序不含已删除的 desktop/user')
console.log(`  默认顺序：${orderDefault.join(', ')}`)

/* ================= E. resolveStartupTab 穷举 ================= */
console.log('\n=== E. 启动落点穷举（全部隐藏组合 × 各种 startupTab） ===')
const BAD_LANDINGS = ['recycle', 'help', 'settings', 'releaseNotes', 'devtools', 'bookshelf', 'aiChat', 'graph']
const subsets = []
for (let mask = 0; mask < (1 << BAR_MODULE_IDS.length); mask++) {
  subsets.push(BAR_MODULE_IDS.filter((_, i) => mask & (1 << i)))
}
const startupChoices = [undefined, '', 'blog', 'editor', 'desktop', 'recycle', 'help', 'ghost', ...BAR_MODULE_IDS]
let badLanding = 0, unknownLanding = 0, honored = 0, dishonored = 0, threw = 0
for (const sub of subsets) {
  const hidden = JSON.stringify(sub)
  for (const st of startupChoices) {
    let got
    try { got = resolveStartupTab(st, hidden) } catch { threw++; continue }
    if (BAD_LANDINGS.includes(got)) badLanding++
    if (!isTabName(got)) unknownLanding++
    const shouldHonor = typeof st === 'string' && STARTABLE_MODULE_IDS.includes(st) && !sub.includes(st)
    if (shouldHonor) { if (got === st) honored++; else dishonored++ }
  }
}
const total = subsets.length * startupChoices.length
console.log(`  遍历 ${subsets.length} 种隐藏组合 × ${startupChoices.length} 种 startupTab = ${total} 次`)
ok(threw === 0, 'E1 任何组合都不抛异常（坏数据走兜底）', `${threw} 次抛异常`)
ok(badLanding === 0, 'E2 **落点永不为 回收站/帮助/设置/更新说明/开发者工具/书架/AI对话/图谱**', `${badLanding} 次落到这些模块`)
ok(unknownLanding === 0, 'E3 落点恒为合法 TabName', `${unknownLanding} 次非法`)
ok(dishonored === 0, 'E4 startupTab 合法且未隐藏时被原样尊重', `${dishonored} 次被忽略`)
console.log(`  其中「应当尊重 startupTab」的 ${honored} 次全部命中`)

console.log('\n  —— 定点复现（v3.4.0 兜底口径 = editor）——')
const CASES = [
  // [描述, hidden, startupTab, 期望落点]
  ['隐藏完所有可隐藏模块', JSON.stringify(BAR_MODULE_IDS), 'editor', 'editor'],
  ['隐藏完所有可隐藏模块，启动项=博客（被隐藏）', JSON.stringify(BAR_MODULE_IDS), 'blog', 'editor'],
  ['只隐藏说说一项，启动项=编辑器', JSON.stringify(['moments']), 'editor', 'editor'],
  ['什么都没隐藏，启动项=编辑器', '[]', 'editor', 'editor'],
  ['只隐藏启动项本身（编辑器）', JSON.stringify(['editor']), 'editor', 'editor'],
  ['启动项=幽灵 id，落兜底', '[]', 'ghost', 'editor'],
  ['旧版兜底值 desktop 作为启动项，落编辑器', '[]', 'desktop', 'editor'],
]
for (const [label, hidden, st, want] of CASES) {
  const got = resolveStartupTab(st, hidden)
  ok(got === want, `E5 ${label} → ${want}`, `实际 ${got}`)
  console.log(`     ${got === want ? '✓' : '✗'} ${label} → 打开「${labelOf(got)}」`)
}
// 坏数据
const junk = [undefined, '', 'null', 'not-json', '{}', '123', '["{"', null]
const junkBad = junk.filter((h) => { try { return !isTabName(resolveStartupTab('blog', h)) } catch { return true } })
ok(junkBad.length === 0, 'E6 坏 JSON / null / 数字都不炸且落到合法模块', `坏在 ${JSON.stringify(junkBad)}`)

/* ================= F. 活动栏可见顺序 ================= */
console.log('\n=== F. 活动栏可见顺序（尊重存储 / 缺失补齐 / 陈年 id 过滤） ===')
ok(!activityOrder('["blog","editor"]').includes('desktop'), 'F1 活动栏顺序不再补 desktop（v3.4.0 桌面外壳已删）')
ok(activityOrder('["blog","editor"]').length === BAR_MODULE_IDS.length, 'F1b 缺失模块被补齐')
// 存储顺序被原样尊重 —— v3.4.0 起没有「入口插队」，activityOrder 只做补齐
ok(activityVisibleOrder('["plugins","blog","editor"]', '[]').slice(0, 3).join(',') === 'plugins,blog,editor',
  'F3 存储顺序被原样尊重（无插队）',
  activityVisibleOrder('["plugins","blog","editor"]', '[]').join(','))
const normalized = activityOrder('["immersive","export","recycle","blog"]')
ok(normalized.includes('aiTeaching') && !normalized.includes('export') && !normalized.includes('recycle'),
  'F4 immersive→aiTeaching 且陈年 id（export/recycle）被滤掉', normalized.join(','))
ok(normalizeModuleId('immersive') === 'aiTeaching', 'F4b normalizeModuleId 归一正确')
ok(activityVisibleOrder(undefined, undefined).length === BAR_MODULE_IDS.length, 'F5 两个参数都缺省时不崩')

/* ================= G. v3.4.0 口径快照（有意变更后锁定的顺序） ================= */
console.log('\n=== G. v3.4.0 口径快照（锁定新顺序，防后续误动） ===')
// v3.4.0 桌面外壳删除后的磁贴清单（tile:true 的模块，顺序 = APP_MODULES 声明序）
const V340_TILE_ORDER = ['editor', 'knowledge', 'blog', 'schedule', 'moments', 'aiTeaching', 'toolbox',
  'plugins', 'recycle', 'help', 'releaseNotes', 'settings']
ok(TILE_MODULE_IDS.join(',') === V340_TILE_ORDER.join(','),
  'G1 磁贴模块清单与 v3.4.0 口径一致', `\n     期望 ${V340_TILE_ORDER.join(',')}\n     实际 ${TILE_MODULE_IDS.join(',')}`)

// 真实用户数据形态：moments 被隐藏时的可见顺序（moments 改名「动态」不影响 id）
const USER_ORDER = '["editor","aiTeaching","knowledge","blog","schedule","moments","toolbox","plugins"]'
const USER_HIDDEN = '["moments"]'
const EXPECT_VISIBLE = 'editor,aiTeaching,knowledge,blog,schedule,toolbox,plugins'
ok(activityVisibleOrder(USER_ORDER, USER_HIDDEN).join(',') === EXPECT_VISIBLE,
  'G2 真实设置下的活动栏可见顺序与 v3.4.0 口径一致',
  `\n     期望 ${EXPECT_VISIBLE}\n     实际 ${activityVisibleOrder(USER_ORDER, USER_HIDDEN).join(',')}`)

// 命令面板快照（palette:true；bookshelf/aiChat/graph 刻意不进面板——只能由工作台入口产生）
const V340_PALETTE = ['editor', 'knowledge', 'blog', 'schedule', 'moments', 'aiTeaching', 'toolbox',
  'plugins', 'recycle', 'help', 'settings']
const newPalette = PALETTE_MODULES.map((m) => m.id)
ok(newPalette.join(',') === V340_PALETTE.join(','),
  'G3 命令面板清单与 v3.4.0 口径一致（desktop/user 已移除，三个新 Tab 不进面板）',
  `\n     期望 ${V340_PALETTE.join(',')}\n     实际 ${newPalette.join(',')}`)

// 设置页启动项：旧 6 项一个不能少；desktop 从可启动清单移除（v3.4.0 有意）
const OLD_STARTUP_OPTS = ['blog', 'schedule', 'knowledge', 'editor', 'moments', 'toolbox']
ok(OLD_STARTUP_OPTS.every((id) => STARTABLE_MODULE_IDS.includes(id)), 'G4 设置页启动项没有丢原有选项')
ok(!STARTABLE_MODULE_IDS.includes('desktop') && STARTABLE_MODULE_IDS.join(',').length > 0,
  'G4b desktop 已从可启动清单移除（v3.4.0 有意）')
console.log(`   设置页启动项（${STARTABLE_MODULE_IDS.length} 个）：${STARTABLE_MODULE_IDS.join(', ')}`)

/* ================= 结果 ================= */
console.log('\n========================================')
if (fails.length === 0) {
  console.log(`✅ 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`❌ ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
