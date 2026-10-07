/**
 * 契约验证：v3.2.0 条目 ⑭「习惯跨模块联动自动打卡」整条拔线后的**双向体检**。
 *
 * 为什么需要它：这是一次**删除**，删除型改动留下的伤口不是报错，是「半删」——
 *
 *   ① **IPC / preload / 类型声明三处漏一处**：渲染层调用写成 `window.api?.habitLinkSave?.(...)`
 *      （可选链），漏删不报错、只是永远静默 no-op。这正是它当初的病：开关保存了却「没生效」。
 *   ② **界面分支漏删**：`h.link?.enabled && <span>自动</span>` 在类型字段删掉后靠可选链活下来，
 *      永远不渲染 —— 或反过来永远渲染一个空角标。没有数据也能过编译，肉眼极难发现。
 *   ③ **主进程调用点漏删**：`recordActivity` 若只删 import、忘删调用，TS 会拦；
 *      但若调用点被包在 try/catch 或 `void` 表达式里又补了 local 桩，就彻底静默了。
 *   ④ **反向误删（本项最贵的一条）**：整条拔线时顺手带走 **手动打卡** 或
 *      **远程监督推送（`notifyCheckin`）**。后者没有界面入口，删了要等下一次真实打卡推送
 *      失败才知道；`DayPanel` 那条 `useDataChanged('habit')` 监听同理 —— 它看着像「自动打卡的
 *      刷新」，其实是**手动打卡的跨窗口刷新通道**，删了表现为「桌面日程面板的打卡状态不更新」。
 *
 * 做法：本项改的全是 electron 依赖的 IPC handler，没法「切片真实实现执行」，
 *   因此用**剥注释后的源码扫描**做双向断言（共 47 条）：
 *     · 负向 24 条：16 组标识符零残留（服务 / 2 个 IPC / 3 个 bridge / 类型 / UI 常量 / 派生索引）
 *       + 2 个待删文件不存在 + 2 处不再产出 links.json + 3 个联动 UI 文件的局部状态 + 1 个派生类型；
 *     · 正向 22 条：保留面逐个在位（手动打卡 / 远程监督 / 刷新通道 / 历史记录兼容 /
 *       相邻模块未误伤 / 文档留痕）。
 *
 *   ⚠️ 扫描**先剥注释、但保留字符串字面量**——这是本脚本的关键手法：
 *      `sender.send('habit:autoChecked')` 是真实代码必须抓到，而注释里
 *      「v3.2.0 条目 14：habitLinkService 已移除」是说明文字不能误报。
 *      `src/types/index.ts` 的说明注释里恰好写着 `HabitLinkSource / HabitLink` 两个名字，是现成靶子。
 *
 * 运行（项目根目录，无需 --experimental-strip-types）：
 *   node --no-warnings .AGENT/scripts/habit-link/verify-habit-link-removal.mjs
 * 期望：全部 PASS 且 exit=0
 */
import fs from 'node:fs'
import path from 'node:path'
// 剥注释器已抽到 shared（条目 18 的契约脚本也要用同一份实现，避免这个「地基」出现两份分叉）
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })

/* ------------------------------------------------------------------ 工具 */

/**
 * 剥注释器见 `../shared/strip-comments.mjs`（含「为什么必须识别正则字面量」的踩坑说明）——
 * 条目 18 的契约脚本共用同一份实现，避免这个「负向断言的地基」出现两份会分叉的副本。
 */
const CODE_EXT = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs'])
const SCAN_ROOTS = ['electron', 'src', 'scripts', '.AGENT/scripts']
const SELF_DIR = path.join(ROOT, '.AGENT', 'scripts', 'habit-link')

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'out') continue
      walk(p, acc)
    } else if (CODE_EXT.has(path.extname(ent.name))) {
      acc.push(p)
    }
  }
  return acc
}

/** 全仓（受控根目录）扫描每个文件的「剥注释后源码」，记在内存供多次断言复用 */
const files = []
for (const r of SCAN_ROOTS) {
  for (const abs of walk(path.join(ROOT, r))) {
    // 本脚本自身与同目录产物会包含这些标识符字面量，跳过
    if (abs.startsWith(SELF_DIR)) continue
    files.push({ rel: path.relative(ROOT, abs).replace(/\\/g, '/'), abs })
  }
}
for (const f of files) {
  f.code = stripComments(fs.readFileSync(f.abs, 'utf8'))
}

/** 返回命中列表 [{rel, line, text}] */
function hitsIn(f, re) {
  const found = []
  const lines = f.code.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) found.push({ rel: f.rel, line: i + 1, text: lines[i].trim().slice(0, 120) })
    re.lastIndex = 0
  }
  return found
}

function scanAll(re) {
  const out = []
  for (const f of files) out.push(...hitsIn(f, re))
  return out
}

const readRaw = (rel) => {
  const p = path.join(ROOT, rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}
const readCode = (rel) => stripComments(readRaw(rel))
const has = (rel, re) => re.test(readCode(rel))

check('扫描根目录可读且非空（守卫脚本自身没跑错地方）',
  files.length > 200, `扫到 ${files.length} 个源码文件`)

/* ------------------------------------------------------- 一、负向：零残留 */

const FORBIDDEN = [
  ['主进程服务入口 recordActivity', /\brecordActivity\b/],
  ['服务模块 habitLinkService', /\bhabitLinkService\b/],
  ['IPC bridge habitLinkSave', /\bhabitLinkSave\b/],
  ['IPC bridge habitLinkRemove', /\bhabitLinkRemove\b/],
  ['IPC 通道前缀 habitLink:', /['"`]habitLink:/],
  ['推送通道 habit:autoChecked', /['"`]habit:autoChecked['"`]/],
  ['preload 订阅 onHabitAutoChecked', /\bonHabitAutoChecked\b/],
  ['渲染层 hook useHabitAutoCheckin(Toast)', /\buseHabitAutoCheckin(?:Toast)?\b/],
  ['类型 HabitLink / HabitLinkSource / HabitLinkRow / HabitLinkExport', /\bHabitLink(?:Source|Row|Export)?\b/],
  ['vault 读 habitVaultRepo.vaultHabitLinksAll', /\bvaultHabitLinksAll\b/],
  ['vault 写 habitVaultRepo.vaultHabitLinksSave', /\bvaultHabitLinksSave\b/],
  ['编辑器联动来源表 LINK_SOURCES', /\bLINK_SOURCES\b/],
  ['今日视图联动标签表 LINK_LABELS', /\bLINK_LABELS\b/],
  ['日历入口联动标签表 LINK_LABELS', /\bLINK_LABELS\b/],
  ['派生索引 buildRecordSourceIndex', /\bbuildRecordSourceIndex\b/],
  ['Habit 的 link 字段消费点（h.link / .link?.enabled）', /\.link\?{0,1}\./],
]
for (const [name, re] of FORBIDDEN) {
  const h = scanAll(re)
  check(`残留为零：${name}`, h.length === 0,
    h.length ? h.slice(0, 4).map((x) => `${x.rel}:${x.line} ${x.text}`).join(' ｜ ') + (h.length > 4 ? ` …共 ${h.length} 处` : '') : '')
}

/* ------------------------------------------- 二、负向：文件与产物级残留 */

check('已删除文件不存在：electron/lib/habitLinkService.ts',
  !fs.existsSync(path.join(ROOT, 'electron/lib/habitLinkService.ts')))
check('已删除文件不存在：src/lib/useHabitAutoCheckin.ts',
  !fs.existsSync(path.join(ROOT, 'src/lib/useHabitAutoCheckin.ts')))
check('vault 层不再写 links.json（剥注释后）',
  !has('electron/lib/kbStore/habitVaultRepo.ts', /links\.json/))
check('备份导入脚本不再产出 checkin/links.json（剥注释后）',
  !has('scripts/import-backup-to-vault.mjs', /links\.json/))

/* 三个联动 UI 文件的局部变量与图标，逐文件断（这些名字太通用，不做全仓断言） */
check('HabitEditorModal 无联动表单状态与 Zap 图标',
  !has('src/modules/toolbox/components/habit-tracker/components/HabitEditorModal.tsx',
    /\blinkOn\b|\blinkSource\b|\blinkThreshold\b|\bZap\b/))
check('CalendarView 无自动打卡角标分支（isAuto / sourceIdx / Zap）',
  !has('src/modules/toolbox/components/habit-tracker/components/CalendarView.tsx',
    /\bisAuto\b|\bsourceIdx\b|\bZap\b/))
check('TodayView 无联动徽标（Zap）',
  !has('src/modules/toolbox/components/habit-tracker/components/TodayView.tsx', /\bZap\b/))
check('dateUtils 不再导出联动派生索引',
  !has('src/modules/toolbox/components/habit-tracker/dateUtils.ts', /\bRecordSourceIndex\b/))

/* ------------------------------------------------- 三、正向：保留面在位 */

const CHECKIN = 'electron/database/repositories/checkinRepo.ts'
check('手动打卡 IPC habit:toggleCheck 仍在', has(CHECKIN, /ipcMain\.handle\('habit:toggleCheck'/))
check('【保留】远程监督推送 notifyCheckin 仍在（无界面入口，易被顺手删）',
  has(CHECKIN, /notifyCheckin\(habitId, date\)/))
check('手动打卡写入口径 source=manual 未变',
  has(CHECKIN, /vaultHabitRecordAddIfAbsent\(habitId, date, 'manual'\)/))
check('撤销打卡仍走 vaultHabitRecordRemove', has(CHECKIN, /vaultHabitRecordRemove\(habitId, date\)/))
check('habit:getAll 返回 { habits, records }（无 linkMap 注入）',
  has(CHECKIN, /handle\('habit:getAll', \(\) => \{[\s\S]{0,400}?return \{ habits, records \}/))
check('删习惯仍连带删其打卡记录', has(CHECKIN, /vaultRecordsSave\(vaultRecordsAll\(\)\.filter\(r => r\.habit_id !== id\)\)/))
check('习惯 CRUD 与排序 handler 全在位（create/update/delete/reorder）',
  ['habit:create', 'habit:update', 'habit:delete', 'habit:reorder'].every((c) => has(CHECKIN, new RegExp(`handle\\('${c}'`))))

const PRELOAD = 'electron/preload/index.ts'
check('preload 六个 habit bridge 全在位',
  ['habitGetAll', 'createHabit', 'updateHabit', 'deleteHabit', 'toggleHabitCheck', 'reorderHabits']
    .every((m) => has(PRELOAD, new RegExp(`\\b${m}:`))))

const IPC_LIB = 'src/lib/ipc.ts'
const ipcHabitExports = (readCode(IPC_LIB).match(/export const (\w*(?:[Hh]abit)\w*) =/g) || [])
  .map((s) => s.replace(/export const /, '').replace(/ =$/, '').trim())
  .sort()
check('ipc.ts 的 habit 导出集合收敛为既有 6 个（不多不少）',
  JSON.stringify(ipcHabitExports) ===
    JSON.stringify(['createHabit', 'deleteHabit', 'habitGetAll', 'reorderHabits', 'toggleHabitCheck', 'updateHabit']),
  `实际 ${JSON.stringify(ipcHabitExports)}`)

const TYPES = 'src/types/index.ts'
check('类型保留历史来源字段 HabitRecord.source（旧数据仍读得出来）',
  has(TYPES, /interface HabitRecord \{ id: string; habitId: string; date: string; source\?: 'manual' \| 'auto' \}/))
check('导出结构 CheckinExportData 已无 links 字段',
  has(TYPES, /interface CheckinExportData \{ habits: HabitExport\[\]; records: HabitRecordExport\[\] \}/))
check('ElectronAPI 的 habitGetAll 不再带 linkMap',
  has(TYPES, /habitGetAll: \(\) => Promise<\{ habits: Habit\[\]; records: HabitRecord\[\] \}>/))
check('Habit 接口不再有 link 成员（避免死字段回归）',
  /export interface Habit \{[\s\S]*?\n\}/.test(readCode(TYPES)) &&
  !/export interface Habit \{[\s\S]*?\blink\b[\s\S]*?\n\}/.test(readCode(TYPES)))
check('【保留】DayPanel 的 useDataChanged(\'habit\') 刷新通道仍在（手动打卡跨窗口刷新靠它）',
  has('src/daypanel/DayPanel.tsx', /useDataChanged\('habit', load\)/))
check('习惯模块侧仍 notifyDataChanged(\'habit\') 广播',
  has('src/modules/toolbox/components/habit-tracker/index.tsx', /notifyDataChanged\('habit'\)/))
check('App.tsx 不再挂全局自动打卡轻提示',
  !has('src/App.tsx', /useHabitAutoCheckin/))

/* 相邻模块「别删多了」：这几处与联动无关，是各自模块的既有行为 */
check('相邻未误伤：entryRepo 仍发 blog:postSaved 插件事件',
  has('electron/database/repositories/entryRepo.ts', /emitPluginEvent\('blog:postSaved'/))
check('相邻未误伤：summaryRepo 仍注册 pomodoro:createSession 并返回结果',
  has('electron/database/repositories/summaryRepo.ts', /handle\('pomodoro:createSession'/) &&
  has('electron/database/repositories/summaryRepo.ts', /pomoSessionCreate\(mins\)/))
check('相邻未误伤：scheduleRepo 仍注册 updateTodo 且发 todoCompleted',
  has('electron/database/repositories/scheduleRepo.ts', /handle\('schedule:updateTodo'/) &&
  has('electron/database/repositories/scheduleRepo.ts', /emitPluginEvent\('schedule:todoCompleted'/))
check('相邻未误伤：builtinTools 的 AI 标记完成仍发插件事件',
  has('electron/lib/builtinTools.ts', /emitPluginEvent\('schedule:todoCompleted'/))
check('相邻未误伤：habitVaultRepo 的 records 读写函数仍在（手动打卡与统计依赖）',
  ['vaultRecordsAll', 'vaultRecordsSave', 'vaultHabitRecordAddIfAbsent', 'vaultHabitRecordRemove']
    .every((m) => has('electron/lib/kbStore/habitVaultRepo.ts', new RegExp(`function ${m}\\b|export .*${m}\\b`))))

/* 文档留痕：避免后人拿 DESIGN-ARCHIVE 里的「已实现」当现状 */
check('DESIGN-ARCHIVE 已标注该设计已整体移除',
  /habit-module-linkage\.md[^\n]*已整体移除/.test(readRaw('docs/DESIGN-ARCHIVE.md')))

/* ------------------------------------------------------------------ 汇总 */
const failed = checks.filter((c) => !c.pass)
console.log('\n=== verify-habit-link-removal ===')
console.log(`扫描: ${SCAN_ROOTS.join(' / ')}（剥注释、保留字符串字面量）  共 ${files.length} 文件`)
console.log(`断言: ${checks.length - failed.length} PASS / ${failed.length} FAIL（共 ${checks.length}）\n`)
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  → ' + c.detail : ''}`)
}
if (failed.length) {
  console.log(`\nFAILED: ${failed.map((c) => c.name).join(' | ')}`)
  process.exit(1)
}
console.log('\n全部通过')
process.exit(0)
