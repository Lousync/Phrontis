#!/usr/bin/env node
/**
 * 契约：键帽 / 面板提示文字的**对比度**（2026-10-13，v3.5.0 线）。
 *
 * 动机：开发负责人反馈「深色主题下这个按键提示按钮看着不清晰」。
 * **先量后改**：内置 2 套 + 插件包 12 套主题，键帽现状（--text-disabled on --input-bg）
 * 全部落在 1.48 ~ 2.76:1 —— 不是"某一套主题偏暗"，而是「把禁用色（--text-disabled）当信息色用」。
 * 改法 = 键帽颜色单独立令牌（--kbd-*，值写成 var() 引用 ⇒ 插件主题自动跟随）+ 一个 .kb-kbd 类，
 * 四处键帽统一消费它。
 *
 * 本契约把「以后不许再退回去」变成机器可查，并且**覆盖全部主题**（含以后新增的主题包）：
 *   ① 主题清单够数（内置 2 + 插件 12），且 --kbd-* 是引用而不是字面色；
 *   ② 四处键帽都用 .kb-kbd，且不许再出现 text-[var(--text-disabled)]（负向）；
 *   ③ 逐主题算 WCAG 对比度：键帽 ≥ 4.5（10~11px 小字 AA）；面板分组标题 / 右侧提示 ≥ 4.0（见下注）。
 *
 * 关于 4.0 这条下限（**不是**把标准往下挪）：键帽是要读的**信息**，按 4.5 硬卡，14/14 达标；
 * 分组标题与右侧提示是**标签**，用 --text-secondary 时 10/14 ≥ 4.5，另 4 套（护眼米白纸感 /
 * 春·嫩芽 / 夏·骄阳 / 秋·金秋）落在 4.10 ~ 4.45 —— 要把它们推过 4.5 得改主题色板本身，
 * 那是主题设计决定（已记 docs/v3.5.0-feedback.md F-2），不该由这条契约倒逼。故此处设 4.0 兜底防退化。
 *
 * 跑法：node .AGENT/scripts/theme-contrast/verify-keycap-contrast.mjs
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

let failures = 0
const ok = (label, detail) => console.log(`  [OK]   ${label}${detail ? ' —— ' + detail : ''}`)
const bad = (label, detail) => { failures++; console.error(`  [FAIL] ${label}${detail ? ' —— ' + detail : ''}`) }
const check = (label, cond, detail) => (cond ? ok(label, detail) : bad(label, detail))

// ---------------------------------------------------------------- 对比度工具

const hexOf = (v) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(v ?? '').trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
function ratio(fg, bg) {
  const a = hexOf(fg); const b = hexOf(bg)
  if (!a || !b) return null
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
/** 令牌取值：支持 `var(--x)` 一层引用解析（--kbd-fg 就是这么写的） */
const resolve = (colors, key, depth = 0) => {
  const raw = colors[key]
  if (raw === undefined) return null
  const m = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(String(raw).trim())
  if (!m || depth > 3) return raw
  return resolve(colors, m[1], depth + 1)
}

// ---------------------------------------------------------------- 主题来源

const css = read('src/styles/index.css')
function parseBlock(selector) {
  const i = css.indexOf(selector)
  if (i < 0) return {}
  const open = css.indexOf('{', i)
  const close = css.indexOf('}', open)
  const out = {}
  for (const m of css.slice(open + 1, close).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim()
  return out
}
const builtinDark = parseBlock(':root {')
const builtinLight = { ...builtinDark, ...parseBlock('html.theme-light') }

const MARKET = 'resources/market-plugins/themes-collection/plugin.json'
const market = JSON.parse(read(MARKET))
const pluginThemes = (market.contributes?.theme ?? []).map((t) => ({ name: t.name, colors: { ...builtinDark, ...(t.colors ?? {}) } }))

const themes = [
  { name: '内置 · 深色（默认）', colors: builtinDark },
  { name: '内置 · 浅色', colors: builtinLight },
  ...pluginThemes,
]

// ---------------------------------------------------------------- §1 令牌与主题清单

console.log('\n§1 令牌与主题清单')

check('主题清单齐备（内置 2 + 插件 12）', themes.length === 14, `实际 ${themes.length}：${themes.map((t) => t.name).join('、')}`)
check('.kb-kbd 类已在 index.css 定义', /\.kb-kbd\s*\{/.test(css))
check('.kb-kbd 消费 --kbd-* 三支令牌',
  ['--kbd-fg', '--kbd-bg', '--kbd-border'].every((k) => css.includes(`var(${k})`)),
  '缺一支 = 有的调用点会退回 Tailwind 原色')
check('--kbd-* 三支都在 :root 里声明',
  ['--kbd-fg', '--kbd-bg', '--kbd-border'].every((k) => new RegExp(`${k}\\s*:`).test(css)))
// ★ 最容易踩空的一条：写成字面色（如 #cccccc）只有内置主题是对的，插件主题照旧看不清
for (const k of ['--kbd-fg', '--kbd-bg', '--kbd-border']) {
  const m = new RegExp(`(${k})\\s*:\\s*([^;]+);`).exec(css)
  const val = m ? m[2].trim() : ''
  check(`${k} 是 var() 引用（不是字面色）—— 插件主题才能跟着走`, /^var\(/.test(val), `实际 ${val}`)
}

// ---------------------------------------------------------------- §2 调用点接线

console.log('\n§2 四处键帽都走同一个类')

const SITES = [
  ['src/components/shared/CommandPalette.tsx', '命令面板键帽'],
  ['src/modules/settings/views/ShortcutsView.tsx', '设置·快捷键指令表键帽'],
  ['src/components/workbench/WorkbenchEmptyState.tsx', '工作台空态键帽'],
  ['src/components/shared/Onboarding.tsx', '首启引导键帽'],
]
for (const [file, label] of SITES) {
  const src = read(file)
  check(`${label}（${file.split('/').pop()}）用 kb-kbd`, /className="[^"]*\bkb-kbd\b/.test(src))
}
// 负向：键帽不许再退回禁用色（Esc 芯片同属键帽样式，一起卡）
const backslide = []
for (const [file] of SITES) {
  const src = read(file)
  // 只看「同一行既有 kb 键帽语义又写 text-disabled」的退化；各处其它禁用态文字不受影响
  if (/kb-kbd[^"]*text-\[var\(--text-disabled\)\]|text-\[var\(--text-disabled\)\][^"]*kb-kbd/.test(src)) backslide.push(file)
}
check('负向：键帽行不再写 --text-disabled', backslide.length === 0, backslide.join('、'))

// 面板里另外两处（分组标题 / 右侧提示）也不该再用禁用色 —— 它们是标签，不是禁用态
const palette = read('src/components/shared/CommandPalette.tsx')
check('命令面板分组标题 / 右侧提示改用 --text-secondary（原来一律 text-disabled）',
  /uppercase tracking-wide text-\[var\(--text-secondary\)\]/.test(palette) &&
  /max-w-\[38%\] text-\[10\.5px\] text-\[var\(--text-secondary\)\]/.test(palette))

// 键位提示出现在菜单里（笔记 ⋮ / 编辑器右键 / 文件右键）—— 同一条整改，别只改看得见的那一处
// 判据：这些文件里 `text-[var(--text-disabled)]` 的处数必须等于 `placeholder:` 前缀的处数
//       （占位符用禁用色是对的：它本来就是"还没有内容"的灰字）
for (const [file, label] of [
  ['src/modules/knowledge/components/PageEditor.tsx', '笔记 ⋮ 菜单右侧的键位提示'],
  ['src/components/shared/NoteContextMenu.tsx', '编辑器右键菜单的键位提示'],
  ['src/components/shared/FileContextMenu.tsx', '文件右键菜单的说明文字'],
]) {
  const src = read(file)
  const all = (src.match(/text-\[var\(--text-disabled\)\]/g) || []).length
  const placeholder = (src.match(/placeholder:text-\[var\(--text-disabled\)\]/g) || []).length
  check(`${label}不再用禁用色（占位符除外）`, all === placeholder, `共 ${all} 处，其中占位符 ${placeholder} 处`)
}

// ---------------------------------------------------------------- §3 逐主题对比度

console.log('\n§3 逐主题对比度（WCAG 2.x；键帽 ≥4.5 = 小字 AA，标签 ≥4.0）')

const KBD_MIN = 4.5
const LABEL_MIN = 4.0
const rows = []
const kbdFail = []
const labelFail = []
for (const t of themes) {
  const c = t.colors
  const kbd = ratio(resolve(c, '--kbd-fg'), resolve(c, '--kbd-bg'))
  const label = ratio(resolve(c, '--text-secondary'), c['--bg-secondary'])
  rows.push({ theme: t.name, kbd, label })
  if (kbd === null || kbd < KBD_MIN) kbdFail.push(`${t.name}(${kbd === null ? 'n/a' : kbd.toFixed(2)})`)
  if (label === null || label < LABEL_MIN) labelFail.push(`${t.name}(${label === null ? 'n/a' : label.toFixed(2)})`)
}
const pad = (s, n) => String(s).padEnd(n)
console.log('         ' + pad('主题', 20) + pad('键帽', 12) + '标签')
for (const r of rows) {
  console.log('         ' + pad(r.theme, 18) + pad(r.kbd === null ? 'n/a' : r.kbd.toFixed(2), 12) + (r.label === null ? 'n/a' : r.label.toFixed(2)))
}
check(`键帽对比度 ${themes.length}/${themes.length} 达标（≥${KBD_MIN}:1）`, kbdFail.length === 0,
  kbdFail.length ? `不达标：${kbdFail.join('、')}` : `最低 ${Math.min(...rows.map((r) => r.kbd ?? 99)).toFixed(2)}:1`)
check(`面板标签对比度达标（≥${LABEL_MIN}:1，见文件头注为何不是 4.5）`, labelFail.length === 0,
  labelFail.length ? `不达标：${labelFail.join('、')}` : `最低 ${Math.min(...rows.map((r) => r.label ?? 99)).toFixed(2)}:1`)

// 负向（证明上面那条不是空转）：把旧的用法喂进同一个算式，必须是不达标的
const oldRatio = ratio(builtinDark['--text-disabled'], builtinDark['--input-bg'])
check('反例：旧的 text-disabled 写法在默认深色下确实不达标（证明这条闸门有效）',
  oldRatio !== null && oldRatio < 3, `旧值 ${oldRatio === null ? 'n/a' : oldRatio.toFixed(2)}:1`)

// ---------------------------------------------------------------- 收尾

console.log('')
if (failures === 0) {
  console.log(`PASS  键帽对比度：${themes.length} 套主题全部达标（键帽 ≥${KBD_MIN} / 标签 ≥${LABEL_MIN}）`)
  process.exit(0)
}
console.error(`FAIL  ${failures} 项未通过`)
process.exit(1)
