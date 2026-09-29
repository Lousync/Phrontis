import type { ShareCardStyle } from '../../types'

/**
 * 分享卡片的视觉参数与**槽位矩形**（2026-09-29）。
 *
 * 本文件是绘制层（`renderShareCard.ts`）与编辑输入层（`ShareCardEditor.tsx`）的
 * **唯一几何来源** —— 图上的位置、字号、行高只在这里定义一次。
 * 输入层按「显示宽度 ÷ CARD_W」把同一份矩形铺成透明输入框盖在 canvas 上，
 * 因此「图上改字」的位置天然不会与画出来的字漂移。
 *
 * 坐标系：**540 × 960 逻辑画布**（导出时整体 2× → 1080×1920）。
 * 文本一律不做自由排版：每个槽位是固定矩形，超出按宽度断行、限行数、末行省略号。
 *
 * 面板（hero 以下）走**自上而下流式排版**、页脚**贴底**（照原型：`.foot{margin-top:auto}`），
 * 所以书页风格（面板无寄语行）的数字区自然上提，不留空洞。
 */

export const CARD_W = 540
export const CARD_H = 960
/** 导出倍率（1080×1920） */
export const CARD_SCALE = 2

export const SHARE_CARD_STYLES: readonly ShareCardStyle[] = ['peak', 'page', 'heat']

export const STYLE_LABEL: Record<ShareCardStyle, string> = {
  peak: '纸山',
  page: '书页',
  heat: '热力',
}

/** 槽位限长（输入侧硬闸：宁可截断也不要画出界） */
export const TEXT_LIMITS = { quote: 60, slogan: 40, signature: 20 } as const

/** 钝解析：非法值一律回落 'peak'（照 workbenchLayout 的钝规则哲学） */
export function parseShareCardStyle(v: unknown): ShareCardStyle {
  return typeof v === 'string' && (SHARE_CARD_STYLES as readonly string[]).includes(v)
    ? (v as ShareCardStyle)
    : 'peak'
}

export function parseShareCardTheme(v: unknown): 'light' | 'dark' {
  return v === 'dark' ? 'dark' : 'light'
}

export type SlotKey = 'quote' | 'slogan' | 'signature'

export const SLOT_ORDER: readonly SlotKey[] = ['quote', 'slogan', 'signature']

export const SLOT_LABEL: Record<SlotKey, string> = {
  quote: '寄语（主文案）',
  slogan: '品牌语',
  signature: '署名（落款）',
}

export const FONT_UI = '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif'
export const FONT_SERIF = 'Georgia, "Times New Roman", "STZhongsong", SimSun, serif'

export interface SlotRect {
  x: number
  y: number
  w: number
  h: number
  /** canvas `ctx.font` 的完整字体串（含字号与字重） */
  font: string
  size: number
  /** 行高（像素） */
  lineH: number
  /** 首行基线相对矩形顶部的偏移 */
  baseline: number
  maxLines: number
}

export interface ShareCardPalette {
  paper: string
  ink: string
  ink2: string
  ink3: string
  line: string
  accent: string
  accent2: string
  accent3: string
}

export function palette(theme: 'light' | 'dark'): ShareCardPalette {
  return theme === 'dark'
    ? { paper: '#16161a', ink: '#eceaf3', ink2: '#a8a5b4', ink3: '#77747f',
        line: 'rgba(236,234,243,.12)', accent: '#a49ef0', accent2: '#8b85d8', accent3: '#5f59a8' }
    : { paper: '#ffffff', ink: '#1f1d18', ink2: '#6d6a61', ink3: '#9b978c',
        line: 'rgba(31,29,24,.10)', accent: '#534ab7', accent2: '#7f77dd', accent3: '#a49ef0' }
}

/* ---------------- 几何（540×960 逻辑坐标） ---------------- */

export const HERO_H = 470
export const PAD = 34

/** 面板纵向流式排版参数 */
const FLOW = {
  padTop: 26,
  dateH: 38,
  /** 日期行 → 寄语行 */
  gapDateQuote: 20,
  quoteH: 74,
  /** 寄语行 → 数字区 */
  gapQuoteStats: 26,
  /** 日期行 → 数字区（无寄语行时） */
  gapDateStats: 26,
  statsH: 90,
  /** 数字区 → 周格行 */
  gapStatsWeek: 26,
  weekH: 13,
} as const

/** 题目区限行 / 限字（这两个是**内容侧**约定，绘制与输入共用） */
export const PROMPT_MAX_LINES = 4
export const PROMPT_MAX_CHARS = 400

/** 页脚（贴底锚定；与原型 `.foot` 的 padding-top / margin-top:auto 同形） */
export const FOOT = {
  /** 页脚分隔线 */
  ruleY: 816,
  brandTop: 872,
  brandMark: 30,
  nameSize: 17,
  brandTextGap: 10,
  lineSlogan: 16,
  lineSignGap: 6,
  qrSize: 96,
  bottom: CARD_H - 28,
} as const

/** 数字区三个纵向偏移（相对数字区顶部） */
const STATS = { bigBaseline: 44, labelGap: 24, labelSize: 14.5, enGap: 14, enSize: 9.5 } as const

export interface PanelLayout {
  dateTop: number
  /** 面板寄语槽位（三风格恒在此处；曾有过「书页风格挪到 hero」的支路，已删） */
  quote: SlotRect
  /** 题目区矩形（**由布局算出，不是手抄常量** —— 早先写死 y 值导致过 88px 错位） */
  prompt: SlotRect
  weekTop: number
}

/**
 * 题目区几何：占据「寄语行之下、周格行之上」的全部空间。
 * 宽度 = 内容宽（左右各 PAD），高度 = 到周格行的余量。
 */
export type PanelRect = { x: number; y: number; w: number; h: number }

/** 面板流式纵向布局（绘制层与输入层共用；题目区矩形也在这里算出来） */
/**
 * 面板流式纵向布局（绘制层与输入层共用）。
 *
 * **寄语槽位恒在面板**（不再分「书页风格挪到 hero」那条支路）——
 * 2026-09-29 截图反馈：hero 里也画了一份寄语，两头都画且互相不知道，改字时预览看起来「没更新」。
 * 统一到面板一处，题区、周格行随之上移/下移由本函数一处算出。
 */
export function panelLayout(style: ShareCardStyle): PanelLayout {
  let y = HERO_H + FLOW.padTop
  const dateTop = y
  y += FLOW.dateH

  y += FLOW.gapDateQuote
  const quote: SlotRect = {
    x: PAD, y, w: CARD_W - PAD * 2, h: FLOW.quoteH,
    font: `20px ${FONT_SERIF}`, size: 20, lineH: 34, baseline: 24, maxLines: 2,
  }
  y += FLOW.quoteH

  // 题目区：从当前位置起，一直占到周格行前（gapStatsWeek 留作题块与周格之间的呼吸）
  y += FLOW.gapQuoteStats
  const promptTop = y
  const promptH = Math.max(72, FOOT.ruleY - FLOW.gapStatsWeek - promptTop)
  const prompt: SlotRect = {
    x: PAD, y: promptTop, w: CARD_W - PAD * 2, h: promptH,
    font: `17px ${FONT_UI}`, size: 17, lineH: 29, baseline: 22, maxLines: PROMPT_MAX_LINES,
  }

  y += promptH + FLOW.gapStatsWeek
  return { quote, prompt, weekTop: y, dateTop }
}

/** 品牌文字块的行位置 */
function brandRects(): { slogan: SlotRect; signature: SlotRect } {
  const x = PAD + FOOT.brandMark + FOOT.brandTextGap
  const w = CARD_W - PAD - FOOT.qrSize - 12 - x
  const top = FOOT.brandTop + FOOT.nameSize + 2
  return {
    slogan: {
      x, y: top, w, h: FOOT.lineSlogan,
      font: `11.5px ${FONT_UI}`, size: 11.5, lineH: 16, baseline: 12, maxLines: 2,
    },
    signature: {
      x, y: top + FOOT.lineSlogan + FOOT.lineSignGap, w, h: 16,
      font: `italic 11.5px ${FONT_UI}`, size: 11.5, lineH: 16, baseline: 12, maxLines: 1,
    },
  }
}

/** 三个槽位的矩形（逻辑坐标）。寄语的落点随风格变（hero vs 面板）。 */
export function slotRects(style: ShareCardStyle): Record<SlotKey, SlotRect> {
  const panel = panelLayout(style)
  const brand = brandRects()
  return {
    quote: panel.quote,
    slogan: brand.slogan,
    signature: brand.signature,
  }
}

/** 数字区 / 周格等固定元素的锚点（绘制层用） */
export const STATS_GEO = STATS

/** 品牌名基线 */
export const BRAND_NAME_BASELINE = FOOT.brandTop + FOOT.nameSize
