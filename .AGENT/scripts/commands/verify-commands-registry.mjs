#!/usr/bin/env node
/**
 * 契约验证：指令表真源（src/lib/commandRegistry.ts）。
 *
 * 为什么需要它：真源的价值全在「不许漂移」，而漂移的表现全是静默的 ——
 *   ① 组 id / 锚点写错 → 设置搜索跳错组，页面不报错；
 *   ② 键帽拼错（`Ctr` / 小写 `ctrl` / `Space`）→ 界面照渲染，只是显示错字；
 *   ③ sources 行锚随重构失效 → 后人照着错锚去核，越核越偏；
 *   ④ 两条命令撞同一组键 → 一次按键跑两个动作（2026-10-13 博客 Ctrl+O 就是这么发现的，
 *      当时靠人工；本脚本 §6 把它变成机器可查）。
 *
 * 本脚本只验「真源自身」。**真源与四处消费方是否一致**由后续段落接手：
 *   §2 id ↔ App 绑定表双射（P3）· §3 设置页渲染等价（P1）· §4 手册生成同步（P2）
 *   §5 设置搜索索引组双射（P1）· §7 手册内容（P2）
 * 已有的「内容判据」（死键复查 / Ctrl+O 不再被博客占用 / 密码本不实承诺等）继续由
 * .AGENT/scripts/settings/verify-shortcuts-table.mjs 守着，两边不重复。
 *
 * 运行（项目根目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/commands/verify-commands-registry.mjs
 * 期望：末尾 PASS 且 exit=0
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { COMMANDS, COMMAND_GROUPS, commandsOfGroup, commandById, paletteCommands } from '../../../src/lib/commandRegistry.ts'
import { stripComments } from '../shared/strip-comments.mjs'
import { renderShortcutsDoc } from './build-shortcuts-doc.mjs'
import { parseFrontmatter, stripGenMarkers } from '../../../electron/lib/helpRetrieval.ts'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')

let failures = 0
const ok = (label, detail) => console.log(`  [OK]   ${label}${detail ? ` —— ${detail}` : ''}`)
const bad = (label, detail) => { failures++; console.error(`  [FAIL] ${label}${detail ? ` —— ${detail}` : ''}`) }
const check = (label, cond, detail) => (cond ? ok(label, detail) : bad(label, detail))

// ---------------------------------------------------------------- §1 结构

console.log('\n§1 真源结构（分组 / 命令 / 键帽 / 锚点）')

check(`分组数 11`, COMMAND_GROUPS.length === 11, `实际 ${COMMAND_GROUPS.length}`)

const gids = COMMAND_GROUPS.map((g) => g.id)
const ganchors = COMMAND_GROUPS.map((g) => g.anchor)
check('组 id 唯一', new Set(gids).size === gids.length)
check('组锚点唯一', new Set(ganchors).size === ganchors.length)
check('组锚点都以 shortcuts. 开头', ganchors.every((a) => a.startsWith('shortcuts.')),
  ganchors.filter((a) => !a.startsWith('shortcuts.')).join(' '))
check('组标题非空', COMMAND_GROUPS.every((g) => g.label.trim().length > 0))

check(`命令数 61`, COMMANDS.length === 61, `实际 ${COMMANDS.length}`)

const ids = COMMANDS.map((c) => c.id)
check('命令 id 唯一', new Set(ids).size === ids.length,
  ids.filter((id, i) => ids.indexOf(id) !== i).join(' '))

const badGroup = COMMANDS.filter((c) => !gids.includes(c.group))
check('每条命令的 group 都指向存在的组', badGroup.length === 0,
  badGroup.map((c) => `${c.id}->${c.group}`).join(' '))

const emptyText = COMMANDS.filter((c) => !c.label.trim() || !c.desc.trim())
check('label / desc 都非空', emptyText.length === 0, emptyText.map((c) => c.id).join(' '))

check('每组至少一条命令', COMMAND_GROUPS.every((g) => commandsOfGroup(g.id).length > 0),
  COMMAND_GROUPS.filter((g) => commandsOfGroup(g.id).length === 0).map((g) => g.id).join(' '))

// ---- 键帽 token 校验：修饰键在前、末位是主键、无重复修饰键 ----
const MODS = ['Ctrl', 'Shift', 'Alt']
const NAMED_KEYS = [
  'Escape', 'Esc', 'Tab', 'Enter', 'Delete', 'Backspace', '空格',
  'PageUp', 'PageDown', 'Home', 'End', 'Insert',
  '←', '→', '↑', '↓', '`', '/', '=', '-', '[', ']',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'Up', 'Down', 'Left', 'Right',
]
const isLetter = (t) => /^[A-Za-z]$/.test(t)
const isDigit = (t) => /^[0-9]$/.test(t)
const isKeyToken = (t) => NAMED_KEYS.includes(t) || isLetter(t) || isDigit(t)

const tokenBad = []
for (const c of COMMANDS) {
  if (!Array.isArray(c.keys) || c.keys.length === 0) { tokenBad.push(`${c.id}: keys 为空`); continue }
  for (const chord of c.keys) {
    if (!Array.isArray(chord) || chord.length === 0) { tokenBad.push(`${c.id}: 空组合键`); continue }
    const mods = chord.filter((t) => MODS.includes(t))
    if (new Set(mods).size !== mods.length) tokenBad.push(`${c.id}: 重复修饰键 [${chord.join('+')}]`)
    const last = chord[chord.length - 1]
    if (MODS.includes(last)) tokenBad.push(`${c.id}: 末位是修饰键 [${chord.join('+')}]`)
    const firstNonModIdx = chord.findIndex((t) => !MODS.includes(t))
    if (firstNonModIdx !== -1 && chord.slice(firstNonModIdx).some((t) => MODS.includes(t))) {
      tokenBad.push(`${c.id}: 修饰键位置不连续 [${chord.join('+')}]`)
    }
    for (const t of chord) {
      if (!MODS.includes(t) && !isKeyToken(t)) tokenBad.push(`${c.id}: 未知键帽 "${t}" [${chord.join('+')}]`)
    }
  }
}
check('键帽 token 合法（修饰键在前、末位主键、无重复/未知）', tokenBad.length === 0, tokenBad.slice(0, 6).join(' | '))

check(`palette:true 的条数 11`, COMMANDS.filter((c) => c.palette).length === 11,
  `实际 ${COMMANDS.filter((c) => c.palette).length}`)
// ★ 不变量（2026-10-13 起，kb-new 进面板后取代了原先「只标 global」的过渡口径）：
//   非 global scope 的命令想进面板**必须声明 requires** —— 否则它会在错的上下文里出现
//   （Ctrl+N 在笔记 / 博客 / 日程都有，不门控就是三条命令抢同一个键）。
const ungatedNonGlobal = COMMANDS.filter((c) => c.palette && c.scope !== 'global' && !c.requires)
check('非 global 的 palette 命令必须声明 requires（否则会在错的上下文出现）', ungatedNonGlobal.length === 0,
  ungatedNonGlobal.map((c) => c.id).join(' '))

// ---- sources 锚点：文件存在 + 行号在范围内 + **该行含声明的指纹** ----
// ★ 2026-10-13 收紧：原先只判「非空、不是闭合符」，实测三次漂移里只有一部分被抓到
//   （第二次 4/9、第三次 2/6），偏了几行但落在别的代码行上就会**静默通过**。
//   现在每个代码锚都必须带指纹：`'src/App.tsx:299 @ ((e.ctrlKey'` —— 行一移动或改内容，
//   指纹就不再出现在那一行 ⇒ FAIL。代价是改到被锚定的那行时要顺手更新指纹（这正是想要的：
//   锚指错了本来就该有人看一眼）。指纹用 .AGENT 里的脚本按当前真实内容生成，不手抄。
const lineCache = new Map()
const fileLines = (p) => {
  if (!lineCache.has(p)) {
    const abs = resolve(ROOT, p)
    lineCache.set(p, existsSync(abs) ? readFileSync(abs, 'utf8').split(/\r?\n/) : null)
  }
  return lineCache.get(p)
}
const anchorBad = []
let anchorCount = 0
let docOnly = 0
for (const c of COMMANDS) {
  if (!Array.isArray(c.sources) || c.sources.length === 0) { anchorBad.push(`${c.id}: sources 为空`); continue }
  for (const s of c.sources) {
    if (s === 'doc') { docOnly++; continue }
    anchorCount++
    const m = /^(.+):(\d+)(?:\s+@\s+(.+))?$/.exec(s)
    if (!m) { anchorBad.push(`${c.id}: 锚格式错 "${s}"`); continue }
    const lines = fileLines(m[1])
    if (!lines) { anchorBad.push(`${c.id}: 文件不存在 "${m[1]}"`); continue }
    const n = Number(m[2])
    if (!(n >= 1 && n <= lines.length)) { anchorBad.push(`${c.id}: 行号越界 ${s}（共 ${lines.length} 行）`); continue }
    const tok = m[3]
    if (!tok) { anchorBad.push(`${c.id}: 锚缺指纹 "${s}"（补 " @ 该行片段"，否则行号漂移躲过检查）`); continue }
    const text = lines[n - 1] ?? ''
    if (text.trim().length === 0 || /^[)}\];]+$/.test(text.trim())) anchorBad.push(`${c.id}: 锚落在空行/闭合符上 ${s}`)
    else if (!text.includes(tok)) anchorBad.push(`${c.id}: 锚行不含指纹 "${tok}" ← ${s}（代码动了？核对锚再更新指纹）`)
  }
}
check(`代码锚可解析且指纹对得上（${anchorCount} 个，另有 ${docOnly} 个 doc）`, anchorBad.length === 0, anchorBad.slice(0, 6).join(' | '))

// ---------------------------------------------------------------- §2 id ↔ App 绑定表双射

console.log('\n§2 命令面板绑定表（真源 palette:true ↔ App.tsx 的 buildPaletteBindings）')

const APP_SRC = stripComments(readFileSync(resolve(ROOT, 'src/App.tsx'), 'utf8'))
const from = APP_SRC.indexOf('const buildPaletteBindings')
const to = APP_SRC.indexOf('const buildCommandItems')
const bindSeg = from >= 0 && to > from ? APP_SRC.slice(from, to) : ''
const bindKeys = [...bindSeg.matchAll(/^\s+'([A-Za-z0-9_-]+)':/gm)].map((m) => m[1])
const wantIds = COMMANDS.filter((c) => c.palette).map((c) => c.id)

check(`绑定表可解析（读到 ${bindKeys.length} 个键）`, bindSeg.length > 0 && bindKeys.length > 0,
  '切不出 buildPaletteBindings 段 —— 该函数被改名了？契约的解析锚要跟着改')
check('真源声明 palette:true 的都接了动作（否则面板里列出来却点了没反应）',
  wantIds.every((id) => bindKeys.includes(id)),
  `缺绑定: ${wantIds.filter((id) => !bindKeys.includes(id)).join(',') || '无'}`)
check('绑定表里没有真源之外的幽灵键（否则是绕过真源偷偷接命令）',
  bindKeys.every((id) => wantIds.includes(id)),
  `幽灵: ${bindKeys.filter((id) => !wantIds.includes(id)).join(',') || '无'}`)
check('双射成立（两侧条数相等且互为子集）', bindKeys.length === wantIds.length,
  `绑定 ${bindKeys.length} / 声明 ${wantIds.length}`)

// ---------------------------------------------------------------- §5 设置搜索索引

console.log('\n§5 设置搜索索引（sections.tsx 的 shortcuts.* 与真源组一一对应）')

const SECTIONS_SRC = stripComments(readFileSync(resolve(ROOT, 'src/modules/settings/sections.tsx'), 'utf8'))
const listed = [...SECTIONS_SRC.matchAll(/\{ id: '(shortcuts\.[A-Za-z]+)'/g)].map((m) => m[1])
const anchors = COMMAND_GROUPS.map((g) => g.anchor)
check(`sections.tsx 登记 ${anchors.length} 条 shortcuts 项`, listed.length === anchors.length, `实际 ${listed.length}`)
check('组集合一致（无漏登记 / 无孤儿锚）',
  listed.length === anchors.length && listed.every((a) => anchors.includes(a)),
  `只在 sections: ${listed.filter((a) => !anchors.includes(a)).join(' ') || '无'} ｜ 只在真源: ${anchors.filter((a) => !listed.includes(a)).join(' ') || '无'}`)
check('顺序一致（设置搜索按真源组序展示）', listed.join('|') === anchors.join('|'),
  `sections: ${listed.join(' ')}`)

// ---------------------------------------------------------------- §6 撞车

console.log('\n§6 键位撞车（同键必须写明仲裁说明）')

const byChord = new Map()
for (const c of COMMANDS) {
  for (const chord of c.keys) {
    const key = [...chord].sort().join('+')
    if (!byChord.has(key)) byChord.set(key, [])
    byChord.get(key).push(c)
  }
}
const shared = [...byChord.entries()].filter(([, list]) => list.length > 1)
check('存在共用键位（说明本段真的在跑）', shared.length > 0, `${shared.length} 组键被两条以上命令共用`)

const noNote = []
for (const [key, list] of shared) {
  for (const c of list) {
    if (!c.conflictNote || !c.conflictNote.trim()) noNote.push(`${key} ← ${c.id}(${c.scope})`)
  }
}
check('凡参与共用键位的命令都写了 conflictNote', noNote.length === 0, noNote.slice(0, 8).join(' | '))

const sameScopeSameChord = shared.filter(([, list]) => {
  const scopes = list.map((c) => c.scope)
  return new Set(scopes).size < scopes.length
})
check('同 scope 同键的每一组都有条件区分说明', sameScopeSameChord.every(([, list]) =>
  list.every((c) => c.conflictNote && c.conflictNote.trim())), 
  sameScopeSameChord.map(([k, l]) => `${k}: ${l.map((c) => c.id).join('/')}`).join(' | '))

ok('共用键位清单（审计输出）')
for (const [key, list] of shared) {
  // 显示按**声明顺序**的那个写法（排序后的 key 只用于归并，`B+Ctrl` 这种读不出来）
  const shown = list[0].keys.find((k) => [...k].sort().join('+') === key)
  console.log(`         ${(shown ? shown.join('+') : key).padEnd(18)} ${list.map((c) => `${c.id}(${c.scope})`).join('  ')}`)
}

// ---------------------------------------------------------------- §4 手册表格区同步

console.log('\n§4 手册表格区（AI 手册 ← 真源生成，跑生成器比对）')

const DOC_PATH = resolve(ROOT, 'resources/help/键盘快捷键.md')
const docRaw = readFileSync(DOC_PATH, 'utf8')
const gen = renderShortcutsDoc(docRaw)
const norm = (s) => s.replace(/\r\n/g, '\n')

check('手册表格区 10 处（节标题与散文在标记之外手写）', gen.markers === 10, `实际 ${gen.markers}`)
check('标记完整划分：每条命令恰好被收录一次',
  gen.missing.length === 0 && gen.unknown.length === 0 &&
  gen.ids.length === COMMANDS.length && new Set(gen.ids).size === gen.ids.length,
  `声明 ${gen.ids.length} 条 ｜ 未收录 ${gen.missing.join(',') || '无'} ｜ 幽灵 id ${gen.unknown.join(',') || '无'}`)
check('盘上的表 = 生成结果（手改表格会被这里拦下）', norm(docRaw) === norm(gen.text),
  '不一致 → 跑 node .AGENT/scripts/commands/build-shortcuts-doc.mjs')

// ---------------------------------------------------------------- §7 手册内容与标记不可泄漏

console.log('\n§7 手册内容与标记不可泄漏给消费者')

check('手册有「## 电子书阅读器」一节（此前整节缺失）', /^## 电子书阅读器$/m.test(docRaw))
const pdfIds = ['pdf-find', 'pdf-next', 'pdf-prev', 'pdf-zoom-in', 'pdf-zoom-out', 'pdf-zoom-fit']
const pdfMissing = pdfIds.filter((id) => !gen.text.includes(commandById(id).desc))
check('PDF 一节 6 行都在（含缩放 3 键，此前连手册都没有）', pdfMissing.length === 0, pdfMissing.join(' '))
check('手册有「## 密码本」一节', /^## 密码本$/m.test(docRaw))

// ★ 反引号键帽：`Ctrl` + 反引号 若按常规包成单反引号会拼出**三连反引号**，
//   Markdown 把连续三个反引号当代码围栏 —— 那一行连同后面内容直接烂掉，而生成器不会报错。
//   生成器首跑就撞上了这个（真源里把该键帽投影成「反引号」二字），这里锁死不许复发。
check('手册里无三连反引号（不会被当成代码围栏）', !/```/.test(docRaw))

const parsedDoc = parseFrontmatter(docRaw)
check('parseFrontmatter 能解析本页（前页脚本的前提）', !!parsedDoc)
const loadedBody = stripGenMarkers(parsedDoc ? parsedDoc.body : '')
check('stripGenMarkers 剥净了（帮助中心渲染与 AI 语料都看不到脚手架）',
  !/GEN:keytable/.test(loadedBody) && !/<!--\s*\/GEN/.test(loadedBody))
check('只剥标记、不剥内容（剥完表格仍在）', loadedBody.includes('| 快捷键 | 功能 |'))

// ---------------------------------------------------------------- §8 面板门控

console.log('\n§8 面板门控（声明式条件，含模块维度，7 种上下文穷举）')

const BASE = { workbench: true, fullWindowTab: false, activeTab: null }
const CTXS = [
  { ...BASE },
  { ...BASE, fullWindowTab: true },
  { ...BASE, workbench: false },
  { ...BASE, workbench: false, fullWindowTab: true },
  { workbench: true, fullWindowTab: false, activeTab: 'knowledge' },
  { workbench: true, fullWindowTab: false, activeTab: 'blog' },
  { workbench: false, fullWindowTab: true, activeTab: 'knowledge' },
]
const byCtx = CTXS.map((c) => paletteCommands(c))
const has = (i, id) => byCtx[i].some((c) => c.id === id)
check(`${CTXS.length} 种上下文下都能算出来，且结果都是真源子集`,
  byCtx.every((list) => list.every((c) => COMMANDS.includes(c))), '')
check('right-panel 只在「工作台且非整窗模块」时出现',
  CTXS.every((c, i) => has(i, 'right-panel') === (c.workbench && !c.fullWindowTab)),
  CTXS.map((c, i) => `${c.workbench}/${c.fullWindowTab}:${has(i, 'right-panel') ? '有' : '无'}`).join(' '))
// ★ kb-new 是第一条「模块内命令进面板」，门控维度就是 activeTab
check('kb-new 只在笔记模块激活时出现',
  CTXS.every((c, i) => has(i, 'kb-new') === (c.activeTab === 'knowledge')),
  CTXS.map((c, i) => `${c.activeTab ?? 'null'}:${has(i, 'kb-new') ? '有' : '无'}`).join(' '))
check('blog-new 只在博客模块激活时出现',
  CTXS.every((c, i) => has(i, 'blog-new') === (c.activeTab === 'blog')),
  CTXS.map((c, i) => `${c.activeTab ?? 'null'}:${has(i, 'blog-new') ? '有' : '无'}`).join(' '))
const noReq = COMMANDS.filter((c) => c.palette && !c.requires).map((c) => c.id)
check('无 requires 的命令在所有上下文下都出现', byCtx.every((list) => noReq.every((id) => list.some((c) => c.id === id))),
  `无 requires 的: ${noReq.join(',')}`)
// ★ 打错字段名 = 门控**永不生效**且没有任何报错（gateAllows 只读它认识的键）—— 必须机器拦
const KNOWN_GATE_KEYS = ['workbench', 'fullWindowTab', 'tabs']
const badGate = COMMANDS.filter((c) => c.requires && Object.keys(c.requires).some((k) => !KNOWN_GATE_KEYS.includes(k)))
check('requires 只用已声明的字段（写错字段名会让门控静默失效）', badGate.length === 0,
  badGate.map((c) => `${c.id}: ${Object.keys(c.requires).join(',')}`).join(' | '))
// ★ 同理：requires.tabs 里把模块名写错（knowledge -> knowlege）= 该命令**永远不出现**且零报错，
//   所以对着模块清单（src/lib/appModules.ts，模块唯一真源）核一遍。
const appModulesSrc = readFileSync(resolve(ROOT, 'src/lib/appModules.ts'), 'utf8')
const tabsUsed = [...new Set(COMMANDS.flatMap((c) => c.requires?.tabs ?? []))]
const badTabs = tabsUsed.filter((t) => !appModulesSrc.includes(t))
check('requires.tabs 里的模块名都在 src/lib/appModules.ts 里', badTabs.length === 0,
  `可疑: ${badTabs.join(',') || '无'} ｜ 用到: ${tabsUsed.join(',')}`)

// ---------------------------------------------------------------- 收尾

console.log('')
if (failures === 0) {
  console.log(`PASS  指令表真源：${COMMAND_GROUPS.length} 组 / ${COMMANDS.length} 条命令 / ${anchorCount} 个代码锚 / ${shared.length} 组共用键位`)
  process.exit(0)
}
console.error(`FAIL  ${failures} 项未通过`)
process.exit(1)
