#!/usr/bin/env node
/**
 * 契约：Markdown 代码块的**阅读可读性**（2026-11-09）。
 *
 * 背景：知识库阅读态的代码块此前与页面同底色、字号 13.1px 却继承正文 1.9 行高、
 * 关键字/函数/类型/标签共用 --accent，暗色下关键字对比度只有 3.70:1。
 * 改法 = 代码块独立表面 + 共享排版令牌 + Monaco vs/vs-dark 色板 + 右上角语言芯片。
 *
 * 本契约把「以后不许再退回 UI 语义色 / 不许漏映射 / 不许暗色对比度掉到 4.5 以下」变成机器可查：
 *   ① 共享 pre 规则消费 --md-code-block-size / --code-surface / --code-border / 1.6 行高 / tab 4；
 *   ② 深/亮两套 --code-* 令牌齐全，代码色板里不再出现 var(--accent) 等 UI 语义色（负向）；
 *   ③ 逐主题算 token 对比度：内置深/浅 + 昼夜 + themes-collection 的 12 套插件主题，
 *      每个 token 在对应 --code-surface 上 ≥ 4.5:1；语言芯片文字 ≥ 4.5:1；
 *   ④ 预览与即时渲染档共用 kb-code-plain / kb-code-lang-chip；themeTone 接线存在；
 *   ⑤ 控制流关键字补类（P2）在预览和写作面都接上，集合里 if 为真、await 为假。
 *
 * 跑法：node .AGENT/scripts/code-block-palette/verify-code-palette.mjs
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0
let fail = 0
const fails = []
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [OK]   ${name}${extra ? ' —— ' + extra : ''}`) }
  else { fail++; fails.push(name + (extra ? ' —— ' + extra : '')); console.error(`  [FAIL] ${name}${extra ? ' —— ' + extra : ''}`) }
}

// ---------------------------------------------------------------- 颜色 / 对比度

function parseRgb(raw) {
  const s = String(raw ?? '').trim()
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s)
  if (hex) {
    const h = hex[1]
    if (h.length === 3) return [0, 1, 2].map(i => parseInt(h[i] + h[i], 16))
    if (h.length === 6 || h.length === 8) {
      const n = parseInt(h.slice(0, 6), 16)
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    }
    return null
  }
  const m = /^rgba?\((.*)\)$/i.exec(s)
  if (!m) return null
  const parts = m[1].replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean)
  if (parts.length < 3) return null
  const ch = (v) => {
    const pct = /^([\d.]+)%$/.exec(v)
    if (pct) return Math.max(0, Math.min(255, Math.round(Number(pct[1]) * 2.55)))
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : null
  }
  const r = ch(parts[0]); const g = ch(parts[1]); const b = ch(parts[2])
  return r === null || g === null || b === null ? null : [r, g, b]
}

const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
const ratio = (fg, bg) => {
  const a = parseRgb(fg); const b = parseRgb(bg)
  if (!a || !b) return null
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const isLight = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] > 140

// ---------------------------------------------------------------- 源码解析

const css = read('src/styles/index.css')
const toneSrc = read('src/lib/themeTone.ts')
const settingsSrc = read('src/lib/settings.ts')
const engineSrc = read('src/lib/daycycleEngine.ts')
const mdSrc = read('src/components/shared/MarkdownPreview.tsx')
const liveSrc = read('src/components/shared/LiveMarkdownPane.tsx')
const controlSrc = read('src/lib/controlKeywords.ts')
const rehypeSrc = read('src/components/shared/rehypeControlKeywords.ts')

function parseBlock(selector) {
  const i = css.indexOf(selector)
  if (i < 0) return {}
  const open = css.indexOf('{', i)
  const close = css.indexOf('}', open)
  if (open < 0 || close < 0) return {}
  const out = {}
  for (const m of css.slice(open + 1, close).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim()
  return out
}

const builtinDark = parseBlock(':root {')
const builtinLight = { ...builtinDark, ...parseBlock('html.theme-light {') }
const daycycle = { ...builtinDark, ...parseBlock('html.theme-daycycle {') }
const darkCode = Object.fromEntries(Object.entries(builtinDark).filter(([k]) => k.startsWith('--code-')))
const lightCode = Object.fromEntries(Object.entries(parseBlock('html[data-code-tone="light"] {')).filter(([k]) => k.startsWith('--code-')))
const daycycleSurface = /html\.theme-daycycle(?::not\(\[data-code-tone="dark"\]\))?\s*\{[^}]*--code-surface:\s*(#[0-9a-f]{6})/i.exec(css)?.[1] ?? null

const market = JSON.parse(read('resources/market-plugins/themes-collection/plugin.json'))
const pluginThemes = (market.contributes?.theme ?? []).map(t => {
  const colors = t.colors ?? {}
  const bg = colors['--bg-primary'] ?? '#1e1e1e'
  const rgb = parseRgb(bg)
  const tone = rgb && isLight(rgb) ? 'light' : 'dark'
  return {
    name: t.name,
    tone,
    colors: { ...(tone === 'light' ? builtinLight : builtinDark), ...colors },
  }
})

// ---------------------------------------------------------------- §1 令牌与共享 pre

console.log('\n§1 令牌与共享 pre')

ok('--md-code-block-size 存在且是 clamp（块级字号下限）',
  /--md-code-block-size\s*:\s*clamp\(/.test(css))

const preRule = /:is\(\.prose-content, \.kb-md-atom\) pre \{[^}]*\}/.exec(css)?.[0] ?? ''
for (const [label, needle] of [
  ['背景走 --code-surface', 'background: var(--code-surface)'],
  ['边框走 --code-border', 'border: 1px solid var(--code-border)'],
  ['正文色走 --code-fg', 'color: var(--code-fg)'],
  ['字体走 --font-mono', 'font-family: var(--font-mono)'],
  ['字号走 --md-code-block-size', 'font-size: var(--md-code-block-size)'],
  ['行高 1.6', 'line-height: 1.6'],
  ['tab-size 4', 'tab-size: 4'],
]) ok(`共享 pre：${label}`, preRule.includes(needle))

ok('pre code 继承 pre 的字号/字体（不被行内代码 0.875em 二次缩放）',
  /:is\(\.prose-content, \.kb-md-atom\) pre code \{[^}]*font-size:\s*inherit[^}]*font-family:\s*inherit/.test(css))

ok('plain 芯片带：pre.kb-code-plain 有 34px 顶部内边距',
  /pre\.kb-code-plain\s*\{[^}]*padding-top:\s*34px/.test(css))
ok('语言芯片样式存在且用 --text-primary（小字 AA）',
  /\.kb-code-lang-chip\s*\{[^}]*color:\s*var\(--text-primary\)/.test(css)
  && /\.kb-code-lang-chip\s*\{[^}]*background:\s*var\(--bg-tertiary\)/.test(css)
  && /\.kb-code-lang-chip\s*\{[^}]*border:\s*1px solid var\(--code-border\)/.test(css))

// ---------------------------------------------------------------- §2 色板令牌

console.log('\n§2 深/亮色板令牌')

const ROLES = ['surface', 'border', 'fg', 'keyword', 'control', 'string', 'number', 'comment',
  'function', 'type', 'tag', 'attr', 'var', 'regexp', 'const', 'op', 'meta', 'addition', 'deletion']
for (const role of ROLES) {
  ok(`深色 --code-${role}`, darkCode[`--code-${role}`] != null)
  ok(`亮色 --code-${role}`, lightCode[`--code-${role}`] != null)
}
ok('昼夜代码表面有独立覆盖（与页面同调）',
  daycycleSurface === '#e9ede6')

const paletteRuleStart = css.indexOf('/* ===== 代码语法高亮')
const paletteRuleEnd = css.indexOf('/* ===== 工具类', paletteRuleStart)
const paletteBlock = paletteRuleStart >= 0 && paletteRuleEnd > paletteRuleStart
  ? css.slice(paletteRuleStart, paletteRuleEnd) : ''
ok('hljs 映射块存在', paletteBlock.length > 0)
ok('负向：代码色板不再复用 UI 语义色（accent / success / warning / danger）',
  !/var\(--(accent|success|warning|danger)\)/.test(paletteBlock))
for (const cls of ['hljs-keyword', 'hljs-control', 'hljs-string', 'hljs-regexp', 'hljs-number',
  'hljs-comment', 'hljs-title.function_', 'hljs-title.class_', 'hljs-type', 'hljs-tag',
  'hljs-attr', 'hljs-variable', 'hljs-literal', 'hljs-meta', 'hljs-operator', 'hljs-addition', 'hljs-deletion']) {
  ok(`hljs 映射覆盖 ${cls}`, paletteBlock.includes(`.${cls}`))
}

// ---------------------------------------------------------------- §3 逐主题对比度

console.log('\n§3 逐主题对比度（代码 token 在 --code-surface 上 ≥ 4.5:1）')

const themes = [
  { name: '内置 · 深色', tone: 'dark', colors: builtinDark, palette: darkCode, surface: darkCode['--code-surface'] },
  { name: '内置 · 浅色', tone: 'light', colors: builtinLight, palette: lightCode, surface: lightCode['--code-surface'] },
  { name: '昼夜动态 · 日间', tone: 'light', colors: daycycle, palette: lightCode, surface: daycycleSurface },
  // 夜间 daycycle 的代码表面回落到 :root 暗色；UI 色用内置深色近似（夜间 --bg-primary 也是深色）
  { name: '昼夜动态 · 夜间', tone: 'dark', colors: builtinDark, palette: darkCode, surface: darkCode['--code-surface'] },
  ...pluginThemes.map(t => ({
    name: t.name,
    tone: t.tone,
    colors: t.colors,
    palette: t.tone === 'light' ? lightCode : darkCode,
    surface: t.tone === 'light' ? lightCode['--code-surface'] : darkCode['--code-surface'],
  })),
]

ok('主题清单覆盖内置深/浅 + 昼夜 + 插件 12 套', themes.length >= 14, `实际 ${themes.length}`)

const resolveVar = (colors, key, depth = 0) => {
  const raw = colors[key]
  if (raw == null || depth > 3) return raw
  const m = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(String(raw).trim())
  return m ? resolveVar(colors, m[1], depth + 1) : raw
}

for (const t of themes) {
  for (const role of ROLES) {
    if (role === 'surface' || role === 'border') continue
    const fg = t.palette[`--code-${role}`]
    const r = ratio(fg, t.surface)
    ok(`${t.name} · --code-${role} ≥ 4.5`, r != null && r >= 4.5, r == null ? `${fg} / ${t.surface}` : `${r.toFixed(2)}:1`)
  }
  const chipFg = resolveVar(t.colors, '--text-primary')
  const chipBg = resolveVar(t.colors, '--bg-tertiary')
  const chip = ratio(chipFg, chipBg)
  ok(`${t.name} · 语言芯片文字 ≥ 4.5`, chip != null && chip >= 4.5, chip == null ? `${chipFg} / ${chipBg}` : `${chip.toFixed(2)}:1`)
}

// ---------------------------------------------------------------- §4 接线

console.log('\n§4 主题 tone / 预览 / 写作面接线')

ok('themeTone 从 --bg-primary 取亮度', toneSrc.includes("getPropertyValue('--bg-primary')") && toneSrc.includes('parseCssRgb'))
ok('themeTone 写 data-code-tone', /dataset\.codeTone\s*=/.test(toneSrc))
ok('settings.applyThemeClass 调用 applyCodeTone', /applyCodeTone\(root\)/.test(settingsSrc))
ok('daycycle 引擎每分钟同步代码块 tone（夜间不沿用正午亮色兜底）',
  engineSrc.includes('applyCodeTone(document.documentElement)'))
ok('daycycle 停止时重算 tone（切走不残留日间/夜间色板）',
  (engineSrc.match(/applyCodeTone\(document\.documentElement\)/g) ?? []).length >= 2)
ok('CSS 有 html[data-code-tone="light"] 选择器', css.includes('html[data-code-tone="light"]'))
ok('daycycle 亮色代码块只在非夜间生效',
  css.includes('html.theme-daycycle:not([data-code-tone="dark"])'))
ok('MarkdownPreview 接入 rehypeControlKeywords', /REHYPE_PLUGINS[^\n]*rehypeControlKeywords/.test(mdSrc))
ok('MarkdownPreview plain 出芯片', mdSrc.includes("fenceLang ? 'kb-code-plain kb-thin-scroll'") && mdSrc.includes('kb-code-lang-chip'))
ok('负向：MarkdownPreview 不再有 relative group / opacity-40 旧标签',
  !mdSrc.includes('relative group') && !mdSrc.includes('opacity-40'))
ok('LiveMarkdownPane 复用 kb-code-plain', liveSrc.includes("pre.className = this.lang ? 'kb-code-plain kb-thin-scroll' : 'kb-thin-scroll'"))
ok('LiveMarkdownPane 复用 kb-code-lang-chip', liveSrc.includes("tag.className = 'kb-code-lang-chip'"))
ok('LiveMarkdownPane 与预览共用控制流判定', liveSrc.includes('isControlKeyword'))
ok('rehypeControlKeywords 给 keyword 补 hljs-control', rehypeSrc.includes("'hljs-control'") && rehypeSrc.includes('isControlKeyword'))

const setBody = controlSrc.slice(controlSrc.indexOf('new Set(['), controlSrc.indexOf('])'))
ok('控制流集合含 if', /['"]if['"]/.test(setBody))
ok('控制流集合不含 await（普通关键字保持蓝色）', !/['"]await['"]/.test(setBody))
ok('isControlKeyword 做了 trim + 小写归一', /trim\(\)\.toLowerCase\(\)/.test(controlSrc))

// ---------------------------------------------------------------- 汇总

console.log(`\nverify-code-palette: ${pass} PASS / ${fail} FAIL`)
if (fail) {
  console.error('\n失败项：')
  for (const f of fails) console.error('  x ' + f)
  process.exit(1)
}
