/**
 * 契约脚本：模块清单唯一真相源 + 启动落点
 *
 * 覆盖的缺陷：**把侧边栏模块全部隐藏后重启，应用自动打开回收站**。
 * 根因不是「兜底逻辑写错了」，而是**模块清单被抄在 6 个地方且已经飘了**：
 * 启动候选表里有 `recycle` / `help`，而这两个模块不在活动栏的显隐菜单里（永远隐藏不掉），
 * 于是「前七项全被隐藏」时兜底循环必然走到 recycle。所以本脚本查两件事：
 *   ① 唯一真相源自洽、各消费方不再各抄一份（负向断言：旧字面量必须消失）；
 *   ② `resolveStartupTab` 的行为 —— 穷举 2^9 种隐藏组合，结果永不为回收站/帮助等"刻意目的地"。
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
ok(ids.length === 14, 'A2b APP_MODULES 覆盖 14 个 TabName（v3.2.0 已剥离桌面外壳）', `实际 ${ids.length}`)
ok(BAR_MODULE_IDS.every((id) => ids.includes(id)), 'A3 BAR_MODULE_IDS ⊆ APP_MODULES')
ok(STARTABLE_MODULE_IDS.every((id) => BAR_MODULE_IDS.includes(id)), 'A4 可启动模块 ⊆ 活动栏模块（非活动栏模块不该当落点）')
const utility = ['recycle', 'help', 'settings', 'user', 'releaseNotes', 'devtools']
const leaked = utility.filter((id) => STARTABLE_MODULE_IDS.includes(id))
ok(leaked.length === 0, 'A5 回收站/帮助/设置/账户/更新说明/开发者工具 都不可作启动项', `漏了 ${leaked.join(',')}`)
ok(BAR_MODULE_IDS[0] === 'editor', 'A6 编辑器是活动栏首位（也是兜底落点）')
ok(!STARTABLE_MODULE_IDS.includes('desktop'), 'A6b 桌面已不再是启动项（v3.2.0 随外壳剥离）')
ok(resolveStartupTab(undefined, JSON.stringify(BAR_MODULE_IDS)) === 'editor', 'A6c 全隐藏时兜底落到编辑器（不是回收站/帮助）')
console.log(`  活动栏位(${BAR_MODULE_IDS.length})：${BAR_MODULE_IDS.join(', ')}`)
console.log(`  可启动(${STARTABLE_MODULE_IDS.length})：${STARTABLE_MODULE_IDS.join(', ')}`)
console.log(`  可作磁贴(${TILE_MODULE_IDS.length})：${TILE_MODULE_IDS.join(', ')}`)
console.log(`  命令面板(${PALETTE_MODULES.length})：${PALETTE_MODULES.map((m) => m.id).join(', ')}`)

/* ================= B. 各消费方不再各抄一份（负向断言） ================= */
console.log('\n=== B. 旧的手抄清单必须已消失（负向断言） ===')
const srcApp = stripComments(read('src/App.tsx'))
const srcBar = stripComments(read('src/components/shared/ActivityBar.tsx'))
const srcOnb = stripComments(read('src/components/shared/Onboarding.tsx'))
const srcAppear = stripComments(read('src/modules/settings/views/AppearanceView.tsx'))
const srcSettings = stripComments(read('src/lib/settings.ts'))
// 数组字面量的「松散匹配」：允许空白/换行，只要按下标顺序出现这几个 id 就算命中
const looseArray = (...idsWanted) =>
  new RegExp('\\[\\s*' + idsWanted.map((s) => `'${s}'`).join('\\s*,\\s*') + '\\s*[,]')
ok(!looseArray('blog', 'schedule', 'knowledge', 'editor').test(srcApp),
  'B1 App.tsx 的硬编码启动候选表已删除', '仍匹配到 [\'blog\',\'schedule\',\'knowledge\',\'editor\',…]')
ok(!looseArray('blog', 'schedule', 'knowledge', 'moments').test(srcApp),
  'B2 App.tsx 的小窗 switch-tab 硬编码白名单已删除')
ok(!/const\s+MODULE_TABS\s*(:|=)/.test(srcApp), 'B3 App.tsx 不再自持 MODULE_TABS（改用 PALETTE_MODULES）')
ok(/const\s+ALL_MODULES[\s\S]{0,240}?BAR_MODULE_IDS\.map\(/.test(srcBar),
  'B4 ActivityBar 的 ALL_MODULES 由 BAR_MODULE_IDS 派生（不是手抄一份）')
ok(!/\[\s*\{\s*id:\s*'desktop'\s*,\s*label:\s*'桌面'/.test(srcBar),
  'B4b 旧的 9 项字面量数组已删除')
ok(!/const\s+ACTIVITY_MODS\s*=\s*\[/.test(srcOnb), 'B6 Onboarding 不再自持 ACTIVITY_MODS 字面量')
ok(!/const\s+TABS\s*:\s*\{[^}]*\}\[\]\s*=\s*\[/.test(srcAppear), 'B7 设置页不再自持启动项 TABS 字面量')

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
checkCover('C1 ActivityBar BAR_ICONS 覆盖全部活动栏模块', keysOfRecord(srcBar, 'BAR_ICONS'), BAR_MODULE_IDS)
checkCover('C2 设置页 STARTUP_ICONS 覆盖全部可启动模块', keysOfRecord(srcAppear, 'STARTUP_ICONS'), STARTABLE_MODULE_IDS)
checkCover('C4 Onboarding SCENE_META 覆盖全部活动栏模块', keysOfRecord(srcOnb, 'SCENE_META'), BAR_MODULE_IDS)

/* ================= D. settings 默认值 ================= */
console.log('\n=== D. 设置默认值里不许出现非活动栏 id（本次 bug 的引信） ===')
const orderDefM = srcSettings.match(/activityBarOrder:\s*\{\s*default:\s*'([^']*)'/)
ok(!!orderDefM, 'D0 抠到 activityBarOrder 默认值')
const orderDefault = orderDefM ? JSON.parse(orderDefM[1]) : []
const strayIds = orderDefault.filter((id) => !BAR_MODULE_IDS.includes(id))
ok(strayIds.length === 0, 'D1 默认顺序里全部是活动栏模块', `混进了 ${strayIds.join(',')}`)
console.log(`  默认顺序：${orderDefault.join(', ')}`)

/* ================= E. resolveStartupTab 穷举 ================= */
console.log('\n=== E. 启动落点穷举（全部隐藏组合 × 各种 startupTab） ===')
const BAD_LANDINGS = ['recycle', 'help', 'settings', 'user', 'releaseNotes', 'devtools']
const subsets = []
for (let mask = 0; mask < (1 << BAR_MODULE_IDS.length); mask++) {
  subsets.push(BAR_MODULE_IDS.filter((_, i) => mask & (1 << i)))
}
// 'desktop' 是 v3.2.0 剥离掉的 id：它现在既不是合法 TabName 也不是启动项，
// 拿来当坏数据用 —— 落点必须退回兜底，绝不能原样返回（那会渲染出一个不存在的模块）。
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
ok(badLanding === 0, 'E2 **落点永不为 回收站/帮助/设置/账户/更新说明/开发者工具**', `${badLanding} 次落到这些模块`)
ok(unknownLanding === 0, 'E3 落点恒为合法 TabName', `${unknownLanding} 次非法`)
ok(dishonored === 0, 'E4 startupTab 合法且未隐藏时被原样尊重', `${dishonored} 次被忽略`)
console.log(`  其中「应当尊重 startupTab」的 ${honored} 次全部命中`)

console.log('\n  —— 报告场景的定点复现（旧实现全部落到 recycle）——')
const CASES = [
  ['隐藏完所有可隐藏模块', JSON.stringify(BAR_MODULE_IDS), 'editor'],
  ['隐藏掉不用的，只留编辑器', JSON.stringify(BAR_MODULE_IDS.filter((x) => x !== 'editor')), 'editor'],
  ['只留 AI教学', JSON.stringify(BAR_MODULE_IDS.filter((x) => x !== 'aiTeaching')), 'editor'],
  ['只留 编辑器 + AI教学', JSON.stringify(BAR_MODULE_IDS.filter((x) => !['editor', 'aiTeaching'].includes(x))), 'editor'],
  ['只隐藏说说一项，启动项=编辑器', JSON.stringify(['moments']), 'editor'],
  ['只隐藏启动项本身（编辑器）', JSON.stringify(['editor']), 'editor'],
  ['什么都没隐藏，启动项=编辑器', '[]', 'editor'],
]
for (const [label, hidden, want] of CASES) {
  const got = resolveStartupTab(label.includes('编辑器') ? 'editor' : 'editor', hidden)
  ok(got === want, `E5 ${label} → ${want}`, `实际 ${got}`)
  console.log(`     ${got === want ? '✓' : '✗'} ${label} → 打开「${labelOf(got)}」`)
}
// 坏数据
const junk = [undefined, '', 'null', 'not-json', '{}', '123', '["{"', null]
const junkBad = junk.filter((h) => { try { return !isTabName(resolveStartupTab('blog', h)) } catch { return true } })
ok(junkBad.length === 0, 'E6 坏 JSON / null / 数字都不炸且落到合法模块', `坏在 ${JSON.stringify(junkBad)}`)

/* ================= F. 活动栏可见顺序 ================= */
console.log('\n=== F. 活动栏可见顺序（尊重存储 / 缺失补齐 / 陈年 id 过滤） ===')
ok(activityOrder('["blog","editor"]')[0] === 'blog', 'F1 存储顺序原样保留（不再有人为顶首位）', activityOrder('["blog","editor"]').join(','))
ok(activityOrder('["blog","editor"]').length === BAR_MODULE_IDS.length, 'F1b 缺失模块被补齐')
ok(activityVisibleOrder('[]', '["editor"]')[0] !== 'editor', 'F2 隐藏生效（编辑器被隐藏后不再首位）')
// 存储顺序被完整尊重：剥离桌面外壳后，activityOrder 不再往队首插任何模块
ok(activityVisibleOrder('["plugins","blog","editor"]', '[]').slice(0, 3).join(',') === 'plugins,blog,editor',
  'F3 存储顺序被尊重（无人插队）',
  activityVisibleOrder('["plugins","blog","editor"]', '[]').join(','))
ok(activityVisibleOrder('["editor","plugins","blog"]', '[]').slice(0, 3).join(',') === 'editor,plugins,blog',
  'F3b 用户自定义顺序完全照办')
const normalized = activityOrder('["immersive","export","recycle","blog"]')
ok(normalized.includes('aiTeaching') && !normalized.includes('export') && !normalized.includes('recycle'),
  'F4 immersive→aiTeaching 且陈年 id（export/recycle）被滤掉', normalized.join(','))
ok(normalizeModuleId('immersive') === 'aiTeaching', 'F4b normalizeModuleId 归一正确')
ok(activityVisibleOrder(undefined, undefined).length === BAR_MODULE_IDS.length, 'F5 两个参数都缺省时不崩')

/* ================= G. 重构不该顺手洗牌（快照对照） ================= */
console.log('\n=== G. 顺序零变化快照（重构前逐字抄下来的） ===')
// 重构前 `tiles.tsx` 里那份 13 项字面量的实际顺序
const OLD_DESK_ORDER = ['editor', 'knowledge', 'blog', 'schedule', 'moments', 'aiTeaching', 'toolbox',
  'plugins', 'recycle', 'help', 'user', 'releaseNotes', 'settings']
ok(TILE_MODULE_IDS.join(',') === OLD_DESK_ORDER.join(','),
  'G1 桌面「添加控件」面板的模块顺序零变化', `\n     旧 ${OLD_DESK_ORDER.join(',')}\n     新 ${TILE_MODULE_IDS.join(',')}`)

// 取本机真实设置里的活动栏数据（重构前后都应得到同一结果）
const USER_ORDER = '["editor","aiTeaching","knowledge","blog","schedule","moments","toolbox","plugins"]'
const USER_HIDDEN = '["moments"]'
const EXPECT_VISIBLE = 'editor,aiTeaching,knowledge,blog,schedule,toolbox,plugins'
ok(activityVisibleOrder(USER_ORDER, USER_HIDDEN).join(',') === EXPECT_VISIBLE,
  'G2 真实设置下的活动栏可见顺序零变化',
  `\n     期望 ${EXPECT_VISIBLE}\n     实际 ${activityVisibleOrder(USER_ORDER, USER_HIDDEN).join(',')}`)

// 重构前 `App.tsx` 的 MODULE_TABS（12 项）；本次**有意**补进 aiTeaching，
// 并移除已随桌面外壳剥离的 desktop
const OLD_MODULE_TABS = ['editor', 'knowledge', 'blog', 'schedule', 'moments', 'recycle',
  'settings', 'toolbox', 'plugins', 'help', 'user']
const newPalette = PALETTE_MODULES.map((m) => m.id)
const addedToPalette = newPalette.filter((id) => !OLD_MODULE_TABS.includes(id))
ok(addedToPalette.join(',') === 'aiTeaching', 'G3 命令面板相对旧清单只多了 aiTeaching（有意）', `多了 ${addedToPalette.join(',')}`)
ok(OLD_MODULE_TABS.every((id) => newPalette.includes(id)), 'G3b 命令面板没有丢模块')
console.log(`   ⚠ 命令面板顺序有变（旧的是模块段 + 工具段混排，新的按唯一真相源）：`)
console.log(`     旧 ${OLD_MODULE_TABS.join(', ')}`)
console.log(`     新 ${newPalette.join(', ')}`)

// 重构前设置页启动项只有 6 个；本次**有意**补进 aiTeaching / plugins（desktop 已随外壳剥离）
const OLD_STARTUP_OPTS = ['blog', 'schedule', 'knowledge', 'editor', 'moments', 'toolbox']
ok(OLD_STARTUP_OPTS.every((id) => STARTABLE_MODULE_IDS.includes(id)), 'G4 设置页启动项没有丢原有选项')
const addedStartup = STARTABLE_MODULE_IDS.filter((id) => !OLD_STARTUP_OPTS.includes(id))
ok(addedStartup.join(',') === 'aiTeaching,plugins',
  'G4b 设置页新增「AI教学」「插件」两个选项（有意）', `新增 ${addedStartup.join(',')}`)
console.log(`   设置页启动项：旧 ${OLD_STARTUP_OPTS.length} 个 → 新 ${STARTABLE_MODULE_IDS.length} 个（新增 ${addedStartup.join(', ')}）`)

/* ================= 结果 ================= */
console.log('\n========================================')
if (fails.length === 0) {
  console.log(`✅ 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`❌ ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
