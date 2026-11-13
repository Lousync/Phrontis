/**
 * 昼夜动态主题 —— 纯函数层（零依赖，方案 docs/daycycle-theme-plan.md）
 *
 * 「一天中的分钟」→ 整窗语义令牌 + 天空参数（DaycycleBackdrop 消费）。
 * 关键帧配色与质感参数从定稿原型 tmp/titlebar-daycycle-proto/index.html (v2) 搬运，
 * 修改配色必须同步该原型再回搬，两边肉眼对齐。
 *
 * 被两方消费：
 * - src/lib/daycycleEngine.ts：每分钟调 daycycleAt() 写根 CSS 变量；
 * - .AGENT/scripts/daycycle/verify-daycycle.mjs：--experimental-strip-types 直接 import 跑契约
 *   （关键帧完整性 / 全时段对比度扫描），改本文件必须重跑该脚本。
 *
 * 设计要点（改前先读）：
 * - 黎明(330) / 暮色(1155) 仍是天空的中间主题；但 UI 色板在跨极性段直接取一侧
 *   （06:00 / 19:00 翻板），不再做奶油 ↔ 深紫黑的线性插值——那条路必然路过灰褐，
 *   会让文字在 19:05 前后失去对比度（2026-11-13 修复）。
 * - 太阳 = 白热核心 + 连续 bloom 渐变（sunBloom，8 档非线性衰减），
 *   不要改回 box-shadow 圆环——那是贴纸感的来源（2026-11-07 用户两轮否掉）。
 */

// ===== 颜色工具（hex / hex8 / rgba 字符串通吃；插值产物会再进混色） =====

function parseColor(c: string): { r: number; g: number; b: number; a: number } {
  if (c.startsWith('#')) {
    const h = c.slice(1)
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    }
  }
  const m = c.match(/rgba?\(([^)]+)\)/)
  const p = m ? m[1].split(',').map(Number) : [0, 0, 0, 1]
  return { r: p[0], g: p[1], b: p[2], a: p.length >= 4 ? p[3] : 1 }
}

function mixColor(a: string, b: string, t: number): string {
  const ca = parseColor(a)
  const cb = parseColor(b)
  const r = Math.round(ca.r + (cb.r - ca.r) * t)
  const g = Math.round(ca.g + (cb.g - ca.g) * t)
  const bl = Math.round(ca.b + (cb.b - ca.b) * t)
  const al = ca.a + (cb.a - ca.a) * t
  return `rgba(${r}, ${g}, ${bl}, ${al.toFixed(3)})`
}

function withAlpha(c: string, alpha: number): string {
  const p = parseColor(c)
  return `rgba(${p.r}, ${p.g}, ${p.b}, ${alpha})`
}

function mixNum(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function luminance(c: string): number {
  const p = parseColor(c)
  return 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b
}

// ===== 关键帧 =====

export interface DcSky { top: string; mid: string; low: string; glow: string }

export interface DcUi {
  bg: string; bg2: string; bg3: string; card: string; hover: string; selected: string
  border: string
  t1: string; t2: string; t3: string
  accent: string; ok: string; warn: string; bad: string
  edge: string
  sh: string; shA: number
  glowA: number; grain: number
}

/** ink = 该帧文字极性：'light' = 浅色文字（深背景），'dark' = 深色文字（浅背景） */
export interface DcKey { t: number; ink: 'light' | 'dark'; sky: DcSky; stars: number; clouds: number; cloud: string; ui: DcUi }

export const DAYCYCLE_KEYS: DcKey[] = [
  // 深夜（dark）
  { t: 0, ink: 'light', sky: { top: '#060a18', mid: '#0f1730', low: '#253055', glow: '#8fa0e8' }, stars: 1, clouds: 0.06, cloud: '#dfe6ff',
    ui: { bg: '#0e1420', bg2: '#121827', bg3: '#171f30', card: '#151c2b', hover: '#1b2334', selected: '#1d2739', border: '#ffffff12',
      t1: '#e6eaf3', t2: '#a7b0c2', t3: '#6d7689', accent: '#4e8f7b', ok: '#74b08a', warn: '#d1a04a', bad: '#d06a55',
      edge: '#ffffff0d', sh: '#000000', shA: 0.4, glowA: 13, grain: 0.05 } },
  // 凌晨（dark，微微回暖）
  { t: 270, ink: 'light', sky: { top: '#0a1128', mid: '#182248', low: '#323660', glow: '#98a4ee' }, stars: 0.85, clouds: 0.06, cloud: '#e2e6ff',
    ui: { bg: '#10141f', bg2: '#141927', bg3: '#1a2130', card: '#161c2a', hover: '#1c2333', selected: '#1e2839', border: '#ffffff14',
      t1: '#e5e9f2', t2: '#a4adc0', t3: '#6c7588', accent: '#4e8f7b', ok: '#74b08a', warn: '#d1a04a', bad: '#d06a55',
      edge: '#ffffff0d', sh: '#000000', shA: 0.4, glowA: 13, grain: 0.05 } },
  // 黎明（中间主题：暖紫暮调，浅色文字）
  { t: 330, ink: 'light', sky: { top: '#1f2c55', mid: '#5f4a75', low: '#e8955f', glow: '#ffb36b' }, stars: 0.3, clouds: 0.22, cloud: '#ffd2b0',
    ui: { bg: '#262233', bg2: '#2d2839', bg3: '#352f40', card: '#322c40', hover: '#3a3348', selected: '#3e3650', border: '#ffffff1a',
      t1: '#f1e9e6', t2: '#c0b3bd', t3: '#8d8291', accent: '#d98a6a', ok: '#a8b47a', warn: '#d1a05a', bad: '#d07a5a',
      edge: '#ffffff14', sh: '#000000', shA: 0.33, glowA: 17, grain: 0.05 } },
  // 黎明深处（浅色文字的最后一帧，背景仍深）
  { t: 354, ink: 'light', sky: { top: '#2c3a63', mid: '#6f4a70', low: '#ef9a58', glow: '#ffab5e' }, stars: 0.12, clouds: 0.26, cloud: '#ffcf9e',
    ui: { bg: '#2c2536', bg2: '#332b3d', bg3: '#3b3244', card: '#382f42', hover: '#40364a', selected: '#443a52', border: '#ffffff1a',
      t1: '#f1e9e6', t2: '#c0b3bd', t3: '#8d8291', accent: '#d98a6a', ok: '#a8b47a', warn: '#d1a05a', bad: '#d07a5a',
      edge: '#ffffff14', sh: '#000000', shA: 0.33, glowA: 17, grain: 0.05 } },
  // 破晓（深色文字第一帧，背景已到浅色）—— 354→366 的 12 分钟是全天的深浅快速过带
  { t: 366, ink: 'dark', sky: { top: '#6e9cc8', mid: '#eec08e', low: '#ffd9a2', glow: '#ffa54e' }, stars: 0, clouds: 0.38, cloud: '#fff2dc',
    ui: { bg: '#f2e6cf', bg2: '#e9dcc0', bg3: '#e0d1ab', card: '#f8eeda', hover: '#e7dabd', selected: '#e0e0c2', border: '#4a3a2630',
      t1: '#3e362a', t2: '#6a5f4c', t3: '#726a56', accent: '#4e7d55', ok: '#5a8a3c', warn: '#a8842c', bad: '#c0563f',
      edge: '#ffffffa6', sh: '#8a6a3a', shA: 0.15, glowA: 16, grain: 0.04 } },
  // 日出（浅色，暖调）
  { t: 390, ink: 'dark', sky: { top: '#4f83b8', mid: '#e9b184', low: '#ffd9a8', glow: '#ffab52' }, stars: 0, clouds: 0.4, cloud: '#fff0d8',
    ui: { bg: '#f3ecdd', bg2: '#eae1cc', bg3: '#e2d7bd', card: '#faf3e4', hover: '#e6dcc4', selected: '#dde3c8', border: '#3d342626',
      t1: '#3c352a', t2: '#665e4e', t3: '#6e6656', accent: '#4e7d55', ok: '#5a8a3c', warn: '#a8842c', bad: '#c0563f',
      edge: '#ffffffa6', sh: '#8a6a3a', shA: 0.15, glowA: 16, grain: 0.04 } },
  // 清晨（经典纸感）
  { t: 480, ink: 'dark', sky: { top: '#64b0e2', mid: '#b5dff0', low: '#ffe9c7', glow: '#ffdf85' }, stars: 0, clouds: 0.5, cloud: '#ffffff',
    ui: { bg: '#f7f3e3', bg2: '#efe9d8', bg3: '#e7dfc9', card: '#faf6ea', hover: '#e3dac2', selected: '#dbe6c9', border: '#453b2830',
      t1: '#3d3d34', t2: '#606055', t3: '#6d6756', accent: '#4a7c59', ok: '#5a8a3c', warn: '#a8842c', bad: '#c0563f',
      edge: '#ffffffa6', sh: '#7a6234', shA: 0.12, glowA: 14, grain: 0.04 } },
  // 上午（明亮微冷）
  { t: 660, ink: 'dark', sky: { top: '#57b5ea', mid: '#a4dcf3', low: '#e2f6ff', glow: '#ffe36e' }, stars: 0, clouds: 0.42, cloud: '#ffffff',
    ui: { bg: '#f6f8f3', bg2: '#edf1e7', bg3: '#e3e9dc', card: '#fbfdf8', hover: '#e0e6d7', selected: '#d8e4cd', border: '#35402f2b',
      t1: '#313730', t2: '#5b635a', t3: '#68706a', accent: '#3e7d52', ok: '#5a8a3c', warn: '#a8842c', bad: '#c0563f',
      edge: '#ffffff99', sh: '#3a5a3a', shA: 0.1, glowA: 12, grain: 0.035 } },
  // 正午（最亮最脆）—— html.theme-daycycle 静态兜底块的取值来源
  { t: 750, ink: 'dark', sky: { top: '#3fa9e8', mid: '#8fd6f5', low: '#d8f4ff', glow: '#ffe45c' }, stars: 0, clouds: 0.3, cloud: '#ffffff',
    ui: { bg: '#f7faf5', bg2: '#eef2ea', bg3: '#e4eadf', card: '#fcfefd', hover: '#e2e8dc', selected: '#d9e5cf', border: '#33402e28',
      t1: '#2f3531', t2: '#58605a', t3: '#656d66', accent: '#3e7d52', ok: '#5a8a3c', warn: '#a8842c', bad: '#c0563f',
      edge: '#ffffff8c', sh: '#3a5a3a', shA: 0.09, glowA: 10, grain: 0.035 } },
  // 午后（回暖）
  { t: 930, ink: 'dark', sky: { top: '#4aa6de', mid: '#a3d6ee', low: '#f6e5c8', glow: '#ffcf6a' }, stars: 0, clouds: 0.4, cloud: '#fff8e8',
    ui: { bg: '#f7f1df', bg2: '#efe6cd', bg3: '#e6dab8', card: '#fbf5e6', hover: '#e5dabf', selected: '#dfe4c6', border: '#463a2430',
      t1: '#3b372c', t2: '#635c4c', t3: '#6c6555', accent: '#47794f', ok: '#5a8a3c', warn: '#a8842c', bad: '#c0563f',
      edge: '#ffffff9e', sh: '#6a5a2e', shA: 0.12, glowA: 13, grain: 0.04 } },
  // 黄金时刻（浅色，金调）
  { t: 1095, ink: 'dark', sky: { top: '#4c5f9e', mid: '#d68a60', low: '#ffbe74', glow: '#ff8a4c' }, stars: 0.05, clouds: 0.5, cloud: '#ffd8b8',
    ui: { bg: '#f4e8cf', bg2: '#ecdfc0', bg3: '#e2d2ac', card: '#f9efdb', hover: '#e6d7b4', selected: '#e2dfbf', border: '#46351f36',
      t1: '#3e3324', t2: '#6b5c46', t3: '#736753', accent: '#a4713a', ok: '#6a8a3c', warn: '#b0762c', bad: '#c0563f',
      edge: '#ffffff8f', sh: '#7a4a1a', shA: 0.17, glowA: 16, grain: 0.045 } },
  // 残照（浅色文字最后一帧，金调压深）
  { t: 1140, ink: 'dark', sky: { top: '#3c4d8c', mid: '#c47a52', low: '#f2a45c', glow: '#ff7a42' }, stars: 0.12, clouds: 0.42, cloud: '#ffcaa2',
    ui: { bg: '#e9d3ab', bg2: '#dfc398', bg3: '#d4b280', card: '#f1e0bd', hover: '#e2cc9e', selected: '#dbd3a8', border: '#4a341838',
      t1: '#3e3222', t2: '#6e5c42', t3: '#776a4e', accent: '#a4682f', ok: '#6a8a3c', warn: '#b0762c', bad: '#c0563f',
      edge: '#ffffff85', sh: '#7a4a1a', shA: 0.18, glowA: 16, grain: 0.045 } },
  // 暮初（浅色文字第一帧，背景落回深）—— 1140→1152 是黄昏侧的深浅快速过带
  { t: 1152, ink: 'light', sky: { top: '#1c2348', mid: '#4a3060', low: '#c65a48', glow: '#ff5f4e' }, stars: 0.25, clouds: 0.3, cloud: '#ffb8a4',
    ui: { bg: '#292232', bg2: '#302a3a', bg3: '#383043', card: '#352d3e', hover: '#3d3447', selected: '#423851', border: '#ffffff18',
      t1: '#f2eae3', t2: '#c5b6b0', t3: '#918478', accent: '#d98a5a', ok: '#a8b47a', warn: '#d1a05a', bad: '#d07a5a',
      edge: '#ffffff13', sh: '#000000', shA: 0.33, glowA: 18, grain: 0.05 } },
  // 夜晚（dark）
  { t: 1260, ink: 'light', sky: { top: '#0c1129', mid: '#172043', low: '#2e375f', glow: '#96a4f2' }, stars: 0.85, clouds: 0.08, cloud: '#d5dcff',
    ui: { bg: '#0e1420', bg2: '#121827', bg3: '#171f30', card: '#151c2b', hover: '#1b2334', selected: '#1d2739', border: '#ffffff12',
      t1: '#e6eaf3', t2: '#a7b0c2', t3: '#6d7689', accent: '#4e8f7b', ok: '#74b08a', warn: '#d1a04a', bad: '#d06a55',
      edge: '#ffffff0d', sh: '#000000', shA: 0.4, glowA: 14, grain: 0.05 } },
  // 回到深夜（与 t=0 同色板闭合，verify 脚本断言）
  { t: 1440, ink: 'light', sky: { top: '#060a18', mid: '#0f1730', low: '#253055', glow: '#8fa0e8' }, stars: 1, clouds: 0.06, cloud: '#dfe6ff',
    ui: { bg: '#0e1420', bg2: '#121827', bg3: '#171f30', card: '#151c2b', hover: '#1b2334', selected: '#1d2739', border: '#ffffff12',
      t1: '#e6eaf3', t2: '#a7b0c2', t3: '#6d7689', accent: '#4e8f7b', ok: '#74b08a', warn: '#d1a04a', bad: '#d06a55',
      edge: '#ffffff0d', sh: '#000000', shA: 0.4, glowA: 13, grain: 0.05 } },
]

// ===== 太阳 / 月亮弧线（06:00–19:00 太阳，其余月亮；交接点位置连续） =====

export const DAY_START = 360
export const DAY_END = 1140

export function celestialAt(minute: number): { night: boolean; x: number; y: number; alt: number } {
  const night = minute < DAY_START || minute >= DAY_END
  let p: number
  let x: number
  let y: number
  if (!night) {
    p = (minute - DAY_START) / (DAY_END - DAY_START)
    x = 0.08 + 0.84 * p
    y = 0.72 - 0.42 * Math.sin(Math.PI * p)
  } else {
    const m = minute < DAY_START ? minute + 1440 : minute
    p = (m - DAY_END) / (1440 - DAY_END + DAY_START)
    x = 0.92 - 0.84 * p
    y = 0.72 - 0.42 * Math.sin(Math.PI * p)
  }
  // alt = 0 在地平线（06:00 / 19:00），1 在天顶。全窗背景的天体弧线用它算纵向位置；
  // 顶栏仍用 y（36px 小舞台），两者共用同一圆弧参数，交接点连续。
  return { night, x, y, alt: Math.sin(Math.PI * p) }
}

// ===== 文案 =====

export function phaseFor(minute: number): string {
  if (minute < 300) return '深夜'
  if (minute < 360) return '黎明'
  if (minute < 540) return '清晨'
  if (minute < 690) return '上午'
  if (minute < 810) return '正午'
  if (minute < 1020) return '午后'
  if (minute < 1140) return '黄昏'
  return '夜晚'
}

export function formatMinute(minute: number): string {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

// ===== 太阳 bloom（白热核心 + 单条连续渐变，8 档非线性衰减） =====

export function sunBloom(glow: string): string {
  const p = parseColor(glow)
  const a = (x: number): string => `rgba(${p.r}, ${p.g}, ${p.b}, ${x})`
  return `radial-gradient(circle, rgba(255, 255, 255, .98) 0%, rgba(255, 253, 244, .9) 8%, ${a(.78)} 16%, ${a(.5)} 26%, ${a(.26)} 40%, ${a(.11)} 56%, ${a(.03)} 76%, transparent 100%)`
}

// ===== 主入口：分钟 → 快照 =====

export interface DaycycleSnapshot {
  minute: number
  phase: string
  isNight: boolean
  celX: number
  celY: number
  /** 天体高度 0..1（0 = 地平线，1 = 天顶）：全窗背景用它算纵向弧线 */
  celAlt: number
  /** 引擎要写到 documentElement 上的全部 CSS 变量（36 支） */
  vars: Record<string, string>
}

export function daycycleAt(minute: number): DaycycleSnapshot {
  let a = DAYCYCLE_KEYS[0]
  let b = DAYCYCLE_KEYS[1]
  for (let i = 0; i < DAYCYCLE_KEYS.length - 1; i++) {
    if (minute >= DAYCYCLE_KEYS[i].t && minute <= DAYCYCLE_KEYS[i + 1].t) {
      a = DAYCYCLE_KEYS[i]
      b = DAYCYCLE_KEYS[i + 1]
      break
    }
  }
  const span = b.t - a.t || 1
  const t = Math.max(0, Math.min(1, (minute - a.t) / span))

  const sky = {} as Record<keyof DcSky, string>
  for (const k of Object.keys(a.sky) as (keyof DcSky)[]) sky[k] = mixColor(a.sky[k], b.sky[k], t)

  // 文字极性（ink）与 UI 色板在跨极性段**不做线性插值**。
  // 奶油色 ↔ 深紫黑之间做 12 分钟插值，必然路过灰褐：文字极性切换的那几分钟，
  // 面板底色和文字一起落在中间灰（2026-11-13 用户报 19:05~19:07「蒙了一层雾」，
  // 实测正文对比度 2.84、弱文字 1.07）。规则改为：跨极性段按太阳是否在地平线上
  // 直接取**整侧** UI（白天侧 / 夜晚侧），面板在 06:00 / 19:00 翻板；
  // 天空仍按关键帧插值，晨昏暖光渐变保留。同极性段照常逐分钟插值。
  const crossover = a.ink !== b.ink
  const sunUp = minute >= DAY_START && minute < DAY_END
  const dayUi = a.ink === 'dark' ? a.ui : b.ui
  const nightUi = a.ink === 'light' ? a.ui : b.ui
  const poleUi = crossover ? (sunUp ? dayUi : nightUi) : null

  const ui = {} as Record<keyof DcUi, string | number>
  for (const k of Object.keys(a.ui) as (keyof DcUi)[]) {
    if (poleUi) {
      ui[k] = poleUi[k]
      continue
    }
    const va = a.ui[k]
    const vb = b.ui[k]
    // va/vb 同字段同型（number 或 hex 字符串）；先收窄再进对应混色函数
    ui[k] = typeof va === 'number'
      ? mixNum(va, vb as number, t)
      : mixColor(va, vb as string, t)
  }

  const accent = ui.accent as string
  const bg = ui.bg as string
  const bg2 = ui.bg2 as string

  let t1: string
  let t2v: string
  let t3v: string
  if (poleUi) {
    t1 = poleUi.t1
    t2v = poleUi.t2
    t3v = poleUi.t3
  } else {
    t1 = mixColor(a.ui.t1, b.ui.t1, t)
    t2v = mixColor(a.ui.t2, b.ui.t2, t)
    t3v = mixColor(a.ui.t3, b.ui.t3, t)
  }
  const t3 = t3v
  // 顶栏前景由天空亮度推导（黄昏 / 夜晚浅字，白天深字），不写死
  const fgIsDark = luminance(sky.mid) * 0.6 + luminance(sky.low) * 0.4 > 145
  const tbFg = fgIsDark ? '#2d2922' : '#f7f1e2'

  const cel = celestialAt(minute)
  // 晨昏玻璃增益：太阳高度越低，天空暖光越强，面板需要更实才不糊正文。
  // 日间按 alt 线性给 0→40%；夜间只照顾日出前/日落后的 120 分钟窗口，深夜回到 0。
  const duskDist = cel.night
    ? (minute < DAY_START ? DAY_START - minute : minute - DAY_END)
    : 0
  const glassBoost = cel.night
    ? Math.max(0, 1 - duskDist / 120) * 40
    : (1 - cel.alt) * 40
  const glowXPct = (0.17 + cel.x * 0.66) * 100
  const stars = mixNum(a.stars, b.stars, t)
  const clouds = mixNum(a.clouds, b.clouds, t)
  const cloud = mixColor(a.cloud, b.cloud, t)

  const vars: Record<string, string> = {
    // 背景
    '--bg-primary': bg,
    '--bg-secondary': ui.bg2 as string,
    '--sidebar-bg': ui.bg2 as string,
    '--bg-tertiary': ui.bg3 as string,
    '--input-bg': ui.bg3 as string,
    '--activitybar-bg': mixColor(bg2, bg, 0.35),
    '--card-bg': ui.card as string,
    '--bg-hover': ui.hover as string,
    '--bg-selected': ui.selected as string,
    // 文字（跨极性段走阶梯选择的 pole，见上方 ink 规则）
    '--text-primary': t1,
    '--text-secondary': t2v,
    '--text-muted': t3,
    '--text-disabled': mixColor(t3, bg, 0.18),
    // 强调
    '--accent': accent,
    '--accent-hover': luminance(accent) > 110 ? mixColor(accent, '#000000', 0.14) : mixColor(accent, '#ffffff', 0.16),
    '--danger': ui.bad as string,
    '--success': ui.ok as string,
    '--warning': ui.warn as string,
    '--warning-bg': mixColor(ui.warn as string, bg, 0.82),
    '--drop-bg': mixColor(accent, bg, 0.78),
    '--drop-border': accent,
    // 边框 / 玻璃高光 / 卡片阴影（alpha 随昼夜：暗色时段边框更透、阴影更深）
    '--border-color': ui.border as string,
    '--glass-edge': ui.edge as string,
    '--shadow-card': `0 1px 2px ${withAlpha(ui.sh as string, ui.shA as number)}, 0 12px 32px ${withAlpha(ui.sh as string, (ui.shA as number) * 0.4)}`,
    // 天空层（DaycycleBackdrop 消费；顶栏时间胶囊只读 tick）
    '--sky-top': sky.top,
    '--sky-mid': sky.mid,
    '--sky-melt': mixColor(sky.low, bg, 0.3),
    '--sky-glow': sky.glow,
    '--sky-glow-x': `${glowXPct.toFixed(1)}%`,
    '--sun-bloom': sunBloom(sky.glow),
    '--tb-fg': tbFg,
    '--cloud-o': clouds.toFixed(3),
    '--cloud-c': cloud,
    '--star-o': stars.toFixed(3),
    // 晨昏玻璃增益：CSS 用它抬高通透表面的不透明度（0% 正午/深夜，最高 14% 地平线附近）
    '--dc-glass-boost': `${glassBoost.toFixed(2)}%`,
    // 整窗噪点（body::after，消渐变色带 + 加质感，Stripe 手法）
    '--dc-grain': (ui.grain as number).toFixed(3),
  }

  return {
    minute,
    phase: phaseFor(minute),
    isNight: cel.night,
    celX: cel.x,
    celY: cel.y,
    celAlt: cel.alt,
    vars,
  }
}
