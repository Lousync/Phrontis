/**
 * 契约脚本：模块清单唯一真相源
 *
 * 覆盖的缺陷：**把侧边栏模块全部隐藏后重启，应用自动打开回收站**。
 * 根因不是「兜底逻辑写错了」，而是**模块清单被抄在 6 个地方且已经飘了**：
 * 启动候选表里有 `recycle` / `help`，而这两个模块不在活动栏的显隐菜单里（永远隐藏不掉），
 * 于是「前七项全被隐藏」时兜底循环必然走到 recycle。所以本脚本查的是
 * **唯一真相源自洽、各消费方不再各抄一份**（负向断言：旧字面量必须消失）。
 *
 * ★ 2026-09-25 退役说明：**启动落点那半已删**。开发负责人拍板删除「启动时默认显示」设置项，
 *   启动一律落**工作台**（`activeTab = null`，见 App.tsx）⇒ `resolveStartupTab` /
 *   `STARTABLE_MODULE_IDS` / `APP_MODULES.startable` 全部退役，原 E 段（隐藏组合穷举）与
 *   A4/A5/A6/G4 随之删除。本脚本自此只负责「模块清单唯一真相源」这一半；**文件名保留**
 *   （改名会牵动契约清单与文档指针，收益不抵成本）。
 *
 * ★ 2026-09-26 退役说明②：旧八模块活动栏的世界整体收尾 —— 引导「场景选择」步骤（该步写的
 *   `activityBarHidden` 已无读者）、`activityBarOrder` / `activityBarHidden` 两设置键、
 *   `activityOrder` / `activityVisibleOrder` 归一化 API 一并退役；原 B6 / C4 / D 段 / F 段
 *   随之删除。条目顺序/显隐的唯一承载 = 图标条 `railOrder` / `railHidden`（workbench-shell 契约 C1j–C1n 锁）。
 *
 * v3.4.0（工作台三栏外壳）口径：TabName 16 项 —— 删 `desktop`（磁贴壳被三栏外壳替代）、
 * 删 `user`（账户并入设置）；增 `bookshelf` / `aiChat` / `graph`（入口产生型，不当启动落点）；
 * moments 改名「动态」。
 *
 * ★ 2026-09-22 对齐（本脚本此前**已红 16 条**，期望表还停在编辑区退役之前）：
 *   - `56c7e12`（09-19 笔记合并 Phase 2 批次 2）编辑区退役：`bar/palette` 全 false；
 *   - `aaff952`（阶段三+四）编辑器物理退役，APP_MODULES 16 → 15 项；
 *   所以 A2b 的期望按**现设计**重算。改期望前请先确认模块清单真的变了
 *   （本脚本是用来抓清单飘移的，不是用来记录愿望的）。
 *
 * ★ 2026-09-22 再对齐（书市 S4）：APP_MODULES 15 → **16**（+`bookMarket`）；
 *   ActivityBar 固定图标条 4 → 5 项（追加在末尾）。又一次**有意变更**，不是 drift。
 *
 * 与探针的区别：这里**直接 import 真实实现**（`src/lib/appModules.ts`，靠 Node 的
 * `--experimental-strip-types` 剥离类型），而不是照抄一份算法 —— 抄一份正好会掩盖本次这类缺陷。
 *
 * 用法：
 *   node --experimental-strip-types .AGENT/scripts/startup-tab/verify-startup-tab.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  APP_MODULES, BAR_MODULE_IDS, TILE_MODULE_IDS, PALETTE_MODULES,
  normalizeModuleId,
} from '../../../src/lib/appModules.ts'

// 仓库根由脚本位置推导（勿写死盘符：在 worktree 里跑会静默读主仓 → 假 PASS）
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
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
// 2026-09-22 书市（S4）：16 项（+bookMarket）。它是「左栏独立整窗模块」，进活动栏、
// 可作磁贴、进命令面板 —— 与工具箱 / 插件平级（方案 §1.2 第 5 条）。
ok(ids.length === 16, 'A2b APP_MODULES 覆盖 16 个 TabName（v3.4.0：-desktop -user +bookshelf +aiChat +graph；aaff952 再 -editor；2026-09-22 +bookMarket）', `实际 ${ids.length}`)
ok(!ids.includes('desktop') && !ids.includes('user'), 'A2c 已删除的 desktop/user 不再出现在清单')
ok(BAR_MODULE_IDS.every((id) => ids.includes(id)), 'A3 BAR_MODULE_IDS ⊆ APP_MODULES')
ok(!APP_MODULES.some((m) => 'startable' in m),
  'A4 `startable` 标记已随启动落点机制退役（2026-09-25 删「启动时默认显示」设置项）')
console.log(`  活动栏位(${BAR_MODULE_IDS.length})：${BAR_MODULE_IDS.join(', ')}`)
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
ok(!/resolveStartupTab|STARTABLE_MODULE_IDS/.test(srcApp),
  'B3b App.tsx 已不引用已退役的启动落点 API（resolveStartupTab / STARTABLE_MODULE_IDS）')
ok(/const\s+RAIL_BUTTONS\s*:[\s\S]*?=\s*\[/.test(srcBar),
  'B4 ActivityBar 图标条为固定 RAIL_BUTTONS 清单（v3.4.0 拍板：不再由 BAR_MODULE_IDS 派生）')
ok(!/BAR_MODULE_IDS/.test(srcBar),
  'B4c ActivityBar 不再引用 BAR_MODULE_IDS（图标条 5 项独立拍板，禁手抄回归）')
ok(!/\[\s*\{\s*id:\s*'desktop'\s*,\s*label:\s*'桌面'/.test(srcBar),
  'B4b 旧的 9 项字面量数组已删除')
ok(!/const\s+DESK_MODULES\s*:\s*ModuleDef\[\]\s*=\s*\[/.test(srcTiles), 'B5 tiles.tsx 不再自持 DESK_MODULES 字面量（改用 TILE_MODULE_IDS）')
ok(!/ACTIVITY_MODS|SCENE_META|activityBarHidden/.test(srcOnb),
  'B6 Onboarding 已无场景选择残留（ACTIVITY_MODS / SCENE_META / activityBarHidden 写入均删，2026-09-26 该步空转后退役）')
ok(!/const\s+TABS\s*:\s*\{[^}]*\}\[\]\s*=\s*\[/.test(srcAppear), 'B7 设置页不再自持启动项 TABS 字面量')
ok(!/STARTUP_ICONS/.test(srcAppear), 'B7b 设置页启动项图标表 STARTUP_ICONS 已随设置项删除')
ok(!/startupTab/.test(srcSettings) && !/startupTab|activityBarOrder|activityBarHidden/.test(srcSettings),
  'B7c `startupTab` 与旧活动栏两键（activityBarOrder / activityBarHidden）都已删出 settings（顺序/显隐唯一承载 = railOrder / railHidden）')
ok(!/activityOrder|activityVisibleOrder/.test(srcModules),
  'B8b 旧活动栏归一化 API（activityOrder / activityVisibleOrder）已退役（零运行时消费者后删除）')
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
  ok(false, 'C1 ActivityBar RAIL_BUTTONS 覆盖拍板项', '抠不到 RAIL_BUTTONS（结构变了，脚本要跟着改）')
} else {
  // 2026-09-22 书市：4 → 5 项（bookMarket **追加在末尾**，现四项位置不动）
  ok(railIds.join(',') === 'aiTeaching,recycle,plugins,moments,bookMarket',
    'C1 ActivityBar RAIL_BUTTONS 覆盖 5 项（AI 教学入口 + 回收站/插件市场/动态 + 书市）', `实际 ${railIds.join(',')}`)
}
ok(/title="设置"/.test(srcBar), 'C1b 图标条底部设置按钮存在（直开设置标签页）')
checkCover('C3 tiles.tsx TILE_META 覆盖全部可作磁贴模块', keysOfRecord(srcTiles, 'TILE_META'), TILE_MODULE_IDS)

/* ================= D. normalizeModuleId ================= */
console.log('\n=== D. 陈年 id 归一（railOrder / railHidden 的解析口径依赖它） ===')
ok(normalizeModuleId('immersive') === 'aiTeaching', 'D1 normalizeModuleId 归一正确（immersive→aiTeaching）')

/* ================= G. v3.4.0 口径快照（有意变更后锁定的顺序） ================= */
console.log('\n=== G. v3.4.0 口径快照（锁定新顺序，防后续误动） ===')
// v3.4.0 桌面外壳删除后的磁贴清单（tile:true 的模块，顺序 = APP_MODULES 声明序；editor 已退役故不在列）
const V340_TILE_ORDER = ['knowledge', 'blog', 'schedule', 'moments', 'aiTeaching', 'toolbox',
  'plugins', 'bookMarket', 'recycle', 'help', 'releaseNotes', 'settings']
ok(TILE_MODULE_IDS.join(',') === V340_TILE_ORDER.join(','),
  'G1 磁贴模块清单与 v3.4.0 口径一致', `\n     期望 ${V340_TILE_ORDER.join(',')}\n     实际 ${TILE_MODULE_IDS.join(',')}`)

// 真实用户数据形态的可见顺序快照已随 `activityVisibleOrder` 退役（其消费键 activityBar* 已删）。
// 图标条同款口径的顺序断言由 workbench-shell 契约 C1k / C1m 承接。

// 命令面板快照（palette:true；bookshelf/aiChat/graph 刻意不进面板——只能由工作台入口产生；editor 已退役）
const V340_PALETTE = ['knowledge', 'blog', 'schedule', 'moments', 'aiTeaching', 'toolbox',
  'plugins', 'bookMarket', 'recycle', 'help', 'settings']
const newPalette = PALETTE_MODULES.map((m) => m.id)
ok(newPalette.join(',') === V340_PALETTE.join(','),
  'G3 命令面板清单与 v3.4.0 口径一致（desktop/user 已移除，三个新 Tab 不进面板）',
  `\n     期望 ${V340_PALETTE.join(',')}\n     实际 ${newPalette.join(',')}`)

/* ================= 结果 ================= */
console.log('\n========================================')
if (fails.length === 0) {
  console.log(`✅ 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`❌ ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
