/**
 * 昼夜动态主题契约验证（docs/daycycle-theme-plan.md §6）
 *
 * 用法（项目根目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/daycycle/verify-daycycle.mjs
 *
 * 四类断言：
 *   A. 关键帧完整性（t 递增 / 首尾闭合 / 字段齐全 / 0:00 与 24:00 色板一致）
 *   B. 全时段扫描（每 10 分钟采样）：36 支变量齐全非空 + WCAG 对比度下限
 *   C. 接线断言（grep 源码）：TitleBar / 引擎 / CSS 兜底块 / reduced-motion
 *   D. 设置断言：THEME_OPTIONS 与默认值
 *
 * 纯函数直接 import（Node 24 strip-types，先例 judge.ts / verify-translate-pure.mjs）。
 * 改 daycycleTheme.ts 的关键帧或字段后必须重跑本脚本。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')

const { DAYCYCLE_KEYS, daycycleAt, phaseFor, formatMinute, celestialAt } = await import(
  join(ROOT, 'src', 'lib', 'daycycleTheme.ts')
)

let failures = 0
const ok = (name) => console.log(`[OK] ${name}`)
const fail = (name, detail) => { failures++; console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`) }

function assert(cond, name, detail) { cond ? ok(name) : fail(name, detail) }

// ===== WCAG 对比度（sRGB 线性化） =====

function relLum(cssColor) {
  const m = cssColor.match(/rgba?\(([^)]+)\)/) || cssColor.match(/^#([0-9a-f]{6,8})$/i)
  let r, g, b
  if (m[0].startsWith('#')) {
    const h = m[1]
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16)
  } else {
    ;[r, g, b] = m[1].split(',').map(Number)
  }
  const lin = (v) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(c1, c2) {
  const l1 = relLum(c1)
  const l2 = relLum(c2)
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

/** 把两个 rgba/hex 颜色按 t 混成 rgb（通透表面 composite 用；alpha 视作不透明） */
function mixRgb(c1, c2, t) {
  const parse = (c) => {
    if (c.startsWith('#')) {
      const h = c.slice(1)
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
    }
    const m = c.match(/rgba?\(([^)]+)\)/)
    return m ? m[1].split(',').map(Number).slice(0, 3) : [0, 0, 0]
  }
  const a = parse(c1)
  const b = parse(c2)
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`
}

// ===== A. 关键帧完整性 =====

{
  const ts = DAYCYCLE_KEYS.map(k => k.t)
  const increasing = ts.every((t, i) => i === 0 || t > ts[i - 1])
  assert(increasing, 'A1 关键帧 t 严格递增')
  assert(DAYCYCLE_KEYS[0].t === 0 && DAYCYCLE_KEYS[DAYCYCLE_KEYS.length - 1].t === 1440,
    'A2 首帧 t=0 / 末帧 t=1440（闭合覆盖全天）')
  assert(DAYCYCLE_KEYS.length >= 12, 'A3 关键帧数量 ≥ 12（黎明/暮色中间主题在场）', `实际 ${DAYCYCLE_KEYS.length}`)

  const first = DAYCYCLE_KEYS[0]
  const last = DAYCYCLE_KEYS[DAYCYCLE_KEYS.length - 1]
  assert(JSON.stringify(first.sky) === JSON.stringify(last.sky)
    && JSON.stringify(first.ui) === JSON.stringify(last.ui)
    && first.stars === last.stars && first.clouds === last.clouds && first.cloud === last.cloud,
    'A4 0:00 与 24:00 色板完全一致（插值闭合无跳变）')

  const uiFields = ['bg', 'bg2', 'bg3', 'card', 'hover', 'selected', 'border', 't1', 't2', 't3',
    'accent', 'ok', 'warn', 'bad', 'edge', 'sh', 'shA', 'glowA', 'grain']
  const missing = DAYCYCLE_KEYS.flatMap(k =>
    uiFields.filter(f => !(f in k.ui))
      .concat(['top', 'mid', 'low', 'glow'].filter(f => !(f in k.sky)))
      .filter(f => !(f in k))
      .map(f => `t=${k.t}:${f}`))
  assert(missing.length === 0, 'A5 每帧字段齐全（含 ink 极性）', missing.join(', '))

  // 深浅 crossover 限制在 ≤15 分钟：UI 色板虽已改为翻板，但天空仍逐帧插值；
  // 过带越宽，天空在暖调与深色之间的过渡越拖（曾经黎明段掉到 1.1:1 持续约 40 分钟）
  const wideCross = DAYCYCLE_KEYS
    .filter((k, i) => i > 0 && k.ink !== DAYCYCLE_KEYS[i - 1].ink && k.t - DAYCYCLE_KEYS[i - 1].t > 15)
    .map(k => `t=${DAYCYCLE_KEYS[DAYCYCLE_KEYS.indexOf(k) - 1].t}→${k.t}`)
  assert(wideCross.length === 0, 'A6 深浅 crossover ≤15 分钟（文字极性阶梯切换的过带窗口）', wideCross.join(', '))
}

// ===== B. 全时段扫描（每 10 分钟 144 点） =====

{
  const REQUIRED_VARS = [
    '--bg-primary', '--bg-secondary', '--sidebar-bg', '--bg-tertiary', '--input-bg',
    '--activitybar-bg', '--card-bg', '--bg-hover', '--bg-selected',
    '--text-primary', '--text-secondary', '--text-muted', '--text-disabled',
    '--accent', '--accent-hover', '--danger', '--success', '--warning', '--warning-bg',
    '--drop-bg', '--drop-border', '--border-color', '--glass-edge', '--shadow-card',
    '--sky-top', '--sky-mid', '--sky-melt', '--sky-glow', '--sky-glow-x', '--sun-bloom',
    '--tb-fg', '--cloud-o', '--cloud-c', '--star-o', '--dc-grain', '--dc-glass-boost',
  ]

  let varMiss = null
  let contrastBad = []
  let glassBad = []
  let bandMinutes = 0
  let phaseSeq = []
  let wrapBad = null

  for (let minute = 0; minute <= 1440; minute += 10) {
    const snap = daycycleAt(minute % 1440)
    const miss = REQUIRED_VARS.filter(k => !snap.vars[k])
    if (miss.length && varMiss === null) varMiss = `t=${minute}: ${miss.join(',')}`

    // 中间灰带（背景 WCAG 亮度 0.15~0.34）：跨极性段现在直接取整侧 UI，
    // 面板底色不应再落进这个区间（曾导致 19:05 正文 2.84 / 弱文字 1.07）。
    const bgL = relLum(snap.vars['--bg-primary'])
    if (bgL > 0.15 && bgL < 0.34) bandMinutes += 10

    // 通透表面 composite：主内容 26% + 模块 58% ≈ 69% 不透明，背后 31% 天空。
    // 用 sky.mid 近似（最亮的一段）；翻板后全天按同一标准验。
    const glassBg = mixRgb(snap.vars['--bg-primary'], snap.vars['--sky-mid'], 0.31)
    const cGlass = contrast(snap.vars['--text-primary'], glassBg)
    if (cGlass < 3.5) glassBad.push(`t=${formatMinute(minute)} glass=${cGlass.toFixed(2)}`)

    const cBody = contrast(snap.vars['--text-primary'], snap.vars['--bg-primary'])
    const cMuted = contrast(snap.vars['--text-muted'], snap.vars['--bg-primary'])
    const cTitle = contrast(snap.vars['--tb-fg'], snap.vars['--sky-mid'])
    if (cBody < 4.0 || cMuted < 2.0 || cTitle < 2.2) {
      contrastBad.push(`t=${formatMinute(minute)} body=${cBody.toFixed(2)} muted=${cMuted.toFixed(2)} title=${cTitle.toFixed(2)}`)
    }

    phaseSeq.push(phaseFor(minute % 1440))
    if (minute === 1440) {
      const s0 = daycycleAt(0)
      wrapBad = Object.keys(s0.vars).filter(k => s0.vars[k] !== snap.vars[k]).join(',')
    }
  }

  assert(varMiss === null, 'B1 全时段 36 支变量齐全非空', varMiss)
  assert(contrastBad.length === 0, 'B2 全时段对比度达标（正文≥4.0 弱文字≥2.0 顶栏≥2.2）',
    contrastBad.slice(0, 3).join(' | '))
  assert(glassBad.length === 0, 'B2b 通透表面 composite 正文对比度 ≥3.5（69% 不透明 + sky.mid 近似）',
    glassBad.slice(0, 3).join(' | '))
  assert(bandMinutes === 0, 'B2a UI 色板全天不落中间灰带（跨极性直接取一侧，19:05 不再灰褐）',
    `band=${bandMinutes} 分钟/天`)
  assert(wrapBad === null || wrapBad === '', 'B3 插值闭合：24:00 变量与 0:00 一致', wrapBad)

  const nightBg = daycycleAt(1152).vars['--bg-primary']
  assert(daycycleAt(1141).vars['--bg-primary'] === nightBg
    && daycycleAt(1151).vars['--bg-primary'] === nightBg,
    'B10 黄昏跨极性段直接取夜晚侧 UI（19:01 起不再插值灰褐）')
  const dayBg = daycycleAt(366).vars['--bg-primary']
  assert(daycycleAt(360).vars['--bg-primary'] === dayBg
    && daycycleAt(365).vars['--bg-primary'] === dayBg,
    'B11 黎明跨极性段直接取白天侧 UI（06:00 起翻板）')
  const report = daycycleAt(1145)
  const reportContrast = contrast(report.vars['--text-primary'], report.vars['--bg-primary'])
  assert(reportContrast >= 4.0, 'B12 19:05 正文对比度 ≥4.0（用户报灰雾的时间点）',
    `19:05=${reportContrast.toFixed(2)}`)

  // phase 边界抽查：段名切换点与 celestialAt 昼夜界（360/1140）不冲突
  const phases = new Set(phaseSeq)
  assert(phases.size === 8, 'B4 八个时段名全部出现', [...phases].join('/'))
  const noonCel = celestialAt(750)
  const midCel = celestialAt(0)
  assert(!noonCel.night && midCel.night, 'B5 弧线昼夜判定（正午=日 / 午夜=月）')
  assert(Math.abs(noonCel.alt - 1) < 0.001 && Math.abs(celestialAt(360).alt) < 0.001,
    'B6 天体高度 alt：06:00 / 19:00 ≈ 0，正午 ≈ 1（全窗弧线基准）',
    `noon=${noonCel.alt.toFixed(3)} sunrise=${celestialAt(360).alt.toFixed(3)}`)
  assert(Math.abs(daycycleAt(750).celAlt - 1) < 0.001, 'B7 daycycleAt 快照带 celAlt（引擎 tick 供整窗背景用）')

  const boost = (m) => parseFloat(daycycleAt(m).vars['--dc-glass-boost'])
  assert(boost(750) === 0 && boost(0) === 0 && boost(1260) === 0,
    'B8 正午 / 深夜玻璃增益为 0（保持通透）',
    `noon=${boost(750)} midnight=${boost(0)} night=${boost(1260)}`)
  assert(boost(1095) >= 8 && boost(1152) >= 10 && boost(330) >= 10,
    'B9 晨昏玻璃增益抬高（黄昏 18:15 / 暮色 19:12 / 黎明 05:30）',
    `18:15=${boost(1095)} 19:12=${boost(1152)} 05:30=${boost(330)}`)
}

// ===== C. 接线断言（grep 源码） =====

{
  const read = (p) => readFileSync(join(ROOT, p), 'utf8')

  const titlebar = read('src/components/shared/TitleBar.tsx')
  assert(titlebar.includes('<TitleBarDaycycle />'), 'C1 TitleBar 挂载 TitleBarDaycycle')
  assert(titlebar.includes("settings.theme === 'daycycle'"), 'C2 挂载有主题条件门卫')
  assert(titlebar.includes('kb-titlebar'), 'C3 TitleBar 根含 kb-titlebar 类钩子')

  const chip = read('src/components/shared/TitleBarDaycycle.tsx')
  assert(chip.includes('kb-dc-chip') && chip.includes('no-drag'), 'C4 顶栏时间胶囊 + no-drag（天空已迁整窗层）')

  const backdrop = read('src/components/shared/DaycycleBackdrop.tsx')
  assert(backdrop.includes('kb-dc-backdrop') && backdrop.includes('DAYCYCLE_TICK_EVENT'),
    'C5 整窗背景层存在且监听引擎 tick')

  const css = read('src/styles/index.css')
  assert(/\.kb-dc-backdrop\s*\{[^}]*pointer-events:\s*none/.test(css),
    'C6 整窗背景层 pointer-events:none（不挡任何交互）')
  assert(css.includes('html.theme-daycycle'), 'C7 html.theme-daycycle 静态兜底块在场')
  assert(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.kb-dc-bd-celestial\s*\{\s*transition:\s*none/.test(css),
    'C8 reduced-motion 降级（天体平滑 / 环境动效全停）')
  assert(/html\.theme-daycycle\s+\.kb-theme-surface\s*\{[^}]*background-color:\s*color-mix/.test(css)
    && /html\.theme-daycycle\s+\.kb-dc-center\s*\{/.test(css)
    && /html\.theme-daycycle\s+\.kb-dc-side\s*\{/.test(css),
    'C9 通透玻璃表面覆盖（kb-theme-surface / kb-dc-center / kb-dc-side）')

  const app = read('src/App.tsx')
  assert(app.includes('startDaycycleEngine()') && app.includes('stopDaycycleEngine()'),
    'C10 App.tsx 引擎 start/stop 接线')
  assert(app.includes('<DaycycleBackdropHost') && app.includes('zenLevel={zenLevel}'),
    'C11 App.tsx 根部挂载整窗背景层（禅模式档位透传）')

  const engine = read('src/lib/daycycleEngine.ts')
  assert(engine.includes('removeProperty') && engine.includes('celAlt'),
    'C12 引擎 stop 精确清除内联变量 + tick 带 celAlt')

  const settingsSrc = readFileSync(join(ROOT, 'src', 'lib', 'settings.ts'), 'utf8')
  const appearance = read('src/modules/settings/views/AppearanceView.tsx')
  assert(settingsSrc.includes('daycycleFocusDim') && appearance.includes('appearance.daycycleFocusDim'),
    'C13 专注模式降特效设置项 + 外观页锚点')
  assert(backdrop.includes('zenLevel >= 1') && backdrop.includes("phase === 'work'"),
    'C14 专注判定 = 禅模式 Z1/Z2 或番茄钟 work 阶段（休息阶段不降特效）')
  assert(settingsSrc.includes('daycycleTimeOverride')
    && appearance.includes('appearance.daycycleTime')
    && appearance.includes('type="range"')
    && engine.includes('setDaycycleTimeOverride')
    && app.includes('setDaycycleTimeOverride('),
    'C15 预览时间：设置项 + 外观页进度条 + 引擎 override + App 接线')
  assert(/daycycleTimeOverride:\s*\{[^}]*ui:\s*false/.test(settingsSrc)
    && appearance.includes('{import.meta.env.DEV && (')
    && /if \(!import\.meta\.env\.DEV\) \{\s*setDaycycleTimeOverride\(null\)/.test(app),
    'C16 预览时间仅开发版：ui:false 不进搜索 + 外观页 DEV 门卫 + 正式版强制 null')
}

// ===== D. 设置断言 =====

{
  const settingsSrc = readFileSync(join(ROOT, 'src', 'lib', 'settings.ts'), 'utf8')
  assert(/THEME_OPTIONS = \[[\s\S]*daycycle/.test(settingsSrc), 'D1 THEME_OPTIONS 含 daycycle')
  assert(/theme:\s*\{\s*default:\s*'daycycle'/.test(settingsSrc), 'D2 theme 默认值为 daycycle（2026-11-07 用户拍板默认开启）')
  assert(/daycycleTimeOverride:\s*\{\s*default:\s*-1/.test(settingsSrc),
    'D3 预览时间默认 -1 = 跟随本机时间（显式冻结才写 0..1439）')
}

console.log(failures === 0 ? '\nPASS all daycycle checks' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
