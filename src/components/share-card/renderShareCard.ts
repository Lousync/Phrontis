import type { ShareCardData, ShareCardStyle, ShareCardTexts } from '../../types'
import {
  CARD_H, CARD_SCALE, CARD_W, FOOT, FONT_SERIF, FONT_UI, HERO_H, PAD,
  STATS_GEO, BRAND_NAME_BASELINE, TEXT_LIMITS, palette,
  panelLayout, slotRects, type SlotKey, type SlotRect,
} from './shareCardStyles'
import { drawRichText, parseRichText, richTextHeight } from './shareCardRichText'
/**
 * 分享卡片**唯一绘制实现**（2026-09-29）。
 *
 * 预览（右栏小图）与导出（剪贴板 / PNG）都是这张 canvas —— 没有第二套渲染，
 * 所以「预览好看、导出跑版」在结构上不可能发生。
 *
 * 纯函数约束：**不读 `document` / `window` / `getComputedStyle`**，所有输入来自参数
 * （契约脚本对此做静态负向断言），因此它也能在离屏 canvas 里跑。
 * 字体只用系统字体族 —— canvas 不会等 web font 加载完再画。
 *
 * 题目区（富文本 + LaTeX）走 `shareCardRichText.ts` 的**离屏图**路线：
 * 公式先由 KaTeX 排版成 HTML，再整块转成一张图贴上来（细节见那个文件的头注）。
 * 因此本文件仍然不碰 DOM。
 *
 * 坐标系：540×960 逻辑画布，函数内部整体 `× CARD_SCALE` 到 1080×1920 的物理像素。
 */

export interface ShareCardRenderInput {
  data: ShareCardData
  texts: ShareCardTexts
  style: ShareCardStyle
  theme: 'light' | 'dark'
  /** 题目区内容（Markdown 行内语法 + LaTeX）；空则不画该块，布局自然收拢 */
  prompt: string
}

export interface ShareCardRenderOpts {
  /**
   * 正在编辑（输入层显示文字）的槽位 —— 跳过绘制，避免与输入框双重显示。
   * 中文输入法**组字期间**候选字只存在于输入框里，这条是让组字可见的必要机制。
   */
  hideSlots?: readonly SlotKey[]
  /** 已 decode 的二维码图；未就绪/缺省则不画图（白底托板照画） */
  qr?: CanvasImageSource | null
  /** 已排版好的题目区图（由调用方异步产出，见 shareCardRichText.measureRichText）；缺省则题目区不画 */
  promptImage?: CanvasImageSource | null
  /** 题目区图的绘制尺寸（逻辑坐标，宽恒为内容宽） */
  promptSize?: { w: number; h: number } | null
}

export function renderShareCard(
  ctx: CanvasRenderingContext2D,
  input: ShareCardRenderInput,
  opts: ShareCardRenderOpts = {},
): void {
  const { data, style, theme } = input
  const p = palette(theme)
  const hide = new Set<SlotKey>(opts.hideSlots ?? [])

  ctx.save()
  ctx.scale(CARD_SCALE, CARD_SCALE)
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'

  // ★ 第一笔必须是不透明底色：透明 PNG 粘到微信可能被渲染成黑底
  ctx.fillStyle = p.paper
  ctx.fillRect(0, 0, CARD_W, CARD_H)

  drawHero(ctx, input, p)
  drawPanel(ctx, input, p, hide, opts)
  drawQr(ctx, opts.qr ?? null)

  ctx.restore()
}

/* ================= 绘制原语 ================= */

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.arcTo(x + w, y, x + w, y + rr, rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr)
  ctx.lineTo(x + rr, y + h)
  ctx.arcTo(x, y + h, x, y + h - rr, rr)
  ctx.lineTo(x, y + rr)
  ctx.arcTo(x, y, x + rr, y, rr)
  ctx.closePath()
}

/** 逐字测量断行（CJK 友好）；超出限行数时末行回缩并补省略号 */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const src = String(text ?? '').replace(/\r/g, '')
  if (!src || maxLines <= 0) return []

  const all: string[] = []
  for (const para of src.split('\n')) {
    if (para === '') { all.push(''); continue }
    let line = ''
    for (const ch of para) {
      const test = line + ch
      if (line === '' || ctx.measureText(test).width <= maxW) line = test
      else { all.push(line); line = ch }
    }
    all.push(line)
  }

  if (all.length <= maxLines) return all
  const kept = all.slice(0, maxLines)
  let last = kept[maxLines - 1]
  while (last.length > 0 && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1)
  kept[maxLines - 1] = `${last}…`
  return kept
}

/** 画一个纯文案槽位（固定矩形 + 断行 + 限长） */
function drawSlot(ctx: CanvasRenderingContext2D, rect: SlotRect, text: string, color: string, maxChars: number): void {
  const raw = String(text ?? '').slice(0, maxChars)
  if (!raw.trim()) return
  ctx.font = rect.font
  ctx.fillStyle = color
  ctx.textAlign = 'left'
  const lines = wrapLines(ctx, raw, rect.w, rect.maxLines)
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], rect.x, rect.y + rect.baseline + i * rect.lineH)
  }
}

/** 手工字距（`ctx.letterSpacing` 在各 Electron 版本上可用性不一，自己排更稳） */
function spacedWidth(ctx: CanvasRenderingContext2D, text: string, spacing: number): number {
  let w = 0
  for (const ch of text) w += ctx.measureText(ch).width + spacing
  return Math.max(0, w - spacing)
}

function drawSpaced(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  spacing: number,
  color: string,
  align: 'left' | 'right' | 'center' = 'left',
): void {
  ctx.fillStyle = color
  ctx.textAlign = 'left'
  const total = spacedWidth(ctx, text, spacing)
  let cx = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x
  for (const ch of text) {
    ctx.fillText(ch, cx, y)
    cx += ctx.measureText(ch).width + spacing
  }
}

/* ================= 主视觉 ================= */

const WD = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/** 'YYYY-MM-DD' → { y, m, d }（非法输入回落 1970-01-01，不抛错） */
function parts(date: string): { y: number; m: number; d: number } {
  const mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''))
  if (!mt) return { y: 1970, m: 1, d: 1 }
  return { y: Number(mt[1]), m: Number(mt[2]), d: Number(mt[3]) }
}

function dateCn(date: string): string {
  const { y, m, d } = parts(date)
  const dow = WD[new Date(y, m - 1, d).getDay()] ?? ''
  return `${y} 年 ${m} 月 ${d} 日 · ${dow}`
}

function dateTag(date: string): string {
  const { y, m, d } = parts(date)
  return `${MON[m - 1] ?? ''} ${d}, ${y}`
}

function seedOf(s: string): number {
  let x = 0
  for (const c of s) x = (x * 31 + c.charCodeAt(0)) % 99991
  return x
}

interface HeroCtx {
  data: ShareCardData
  texts: ShareCardTexts
  style: ShareCardStyle
  theme: 'light' | 'dark'
  prompt: string
}

function drawHero(ctx: CanvasRenderingContext2D, input: HeroCtx, p: ReturnType<typeof palette>): void {
  if (input.style === 'peak') drawPeak(ctx, input.data.date)
  else if (input.style === 'page') drawPage(ctx, input, p)
  else drawHeat(ctx, input, p)
}

/** 纸山：程序化山峦 + 晨空。形状按日期派生 → 每天一张不同的图，零图片资源 */
function drawPeak(ctx: CanvasRenderingContext2D, date: string): void {
  const sky = ctx.createLinearGradient(0, 0, 0, HERO_H)
  sky.addColorStop(0, '#e8e4ff')
  sky.addColorStop(0.55, '#f6f1e6')
  sky.addColorStop(1, '#fbf6ec')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, CARD_W, HERO_H)

  ctx.fillStyle = 'rgba(255,255,255,.85)'
  ctx.beginPath(); ctx.arc(152, 148, 46, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,.9)'
  ctx.beginPath(); ctx.arc(400, 104, 3.5, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,.7)'
  ctx.beginPath(); ctx.arc(330, 150, 2.5, 0, Math.PI * 2); ctx.fill()

  const seed = seedOf(`${date}-phrontis`)
  const rnd = (i: number) => ((seed >> (i % 12)) % 100) / 100
  const layers = [
    { fill: '#cdc7f2', op: 0.95, y: 250, amp: 34, i: 1 },
    { fill: '#a49ef0', op: 0.95, y: 300, amp: 46, i: 4 },
    { fill: '#7f77dd', op: 1, y: 356, amp: 40, i: 7 },
    { fill: '#534ab7', op: 1, y: 412, amp: 30, i: 10 },
  ]
  const n = 7
  const step = (CARD_W + 40) / n
  for (const l of layers) {
    ctx.beginPath()
    ctx.moveTo(-20, HERO_H)
    for (let k = 0; k <= n; k++) {
      const x = -20 + k * step
      const y = l.y - Math.sin(k * 1.05 + l.i * 1.7 + rnd(l.i + k) * 2) * l.amp - rnd(l.i + k + 3) * l.amp * 0.35
      ctx.lineTo(x, y)
    }
    ctx.lineTo(CARD_W + 20, HERO_H)
    ctx.closePath()
    ctx.globalAlpha = l.op
    ctx.fillStyle = l.fill
    ctx.fill()
  }
  ctx.globalAlpha = 1

  ctx.fillStyle = '#534ab7'
  ctx.fillRect(0, 404, CARD_W, HERO_H - 404)

  ctx.fillStyle = 'rgba(255,255,255,.06)'
  for (let y = 0; y < HERO_H; y += 3) ctx.fillRect(0, y, CARD_W, 1)
}

/** 书页：格言 + 超大日期水印，走「纸与铅字」气质 */
function drawPage(ctx: CanvasRenderingContext2D, input: HeroCtx, p: ReturnType<typeof palette>): void {
  const dark = input.theme === 'dark'
  const g = ctx.createLinearGradient(0, 0, 0, HERO_H)
  if (dark) { g.addColorStop(0, '#1d1c24'); g.addColorStop(1, '#141319') }
  else { g.addColorStop(0, '#fbf8f2'); g.addColorStop(1, '#f4efe4') }
  ctx.fillStyle = g
  ctx.fillRect(0, 0, CARD_W, HERO_H)

  const { d } = parts(input.data.date)
  ctx.font = `600 150px ${FONT_SERIF}`
  ctx.fillStyle = dark ? 'rgba(164,158,240,.12)' : 'rgba(83,74,183,.08)'
  ctx.textAlign = 'right'
  ctx.fillText(String(d), CARD_W - 34, 500)
  ctx.textAlign = 'left'

  // 注：寄语**不在此处绘制** —— 三风格一律由 drawPanel 在面板里画。
  // 这里曾多画一份，两头都画且互不知情，表现为「改了寄语但预览看着没更新」。
  ctx.fillStyle = p.accent
  roundRect(ctx, 44, 330, 52, 2, 1)
  ctx.fill()
}

/** 热力：把最近 13 周的打卡马赛克当主视觉 —— 数据本身就是图 */
function drawHeat(ctx: CanvasRenderingContext2D, input: HeroCtx, p: ReturnType<typeof palette>): void {
  const dark = input.theme === 'dark'
  const g = ctx.createLinearGradient(0, 0, 0, HERO_H)
  if (dark) { g.addColorStop(0, '#1e1c2b'); g.addColorStop(1, '#171622') }
  else { g.addColorStop(0, '#f7f5ff'); g.addColorStop(1, '#eceafb') }
  ctx.fillStyle = g
  ctx.fillRect(0, 0, CARD_W, HERO_H)

  const rateStr = String(input.data.heat.rate)
  ctx.font = `600 62px ${FONT_UI}`
  ctx.fillStyle = dark ? '#e6e3f5' : '#3a3554'
  ctx.textAlign = 'left'
  ctx.fillText(rateStr, 40, 98)
  const wRate = ctx.measureText(rateStr).width

  ctx.font = `500 24px ${FONT_UI}`
  ctx.fillStyle = dark ? '#918dba' : '#7c789a'
  ctx.fillText('%', 40 + wRate + 4, 98)

  ctx.font = `13px ${FONT_UI}`
  ctx.fillStyle = dark ? '#8f8bab' : '#7c789a'
  ctx.fillText(`最近 ${input.data.heat.weeks} 周打卡率`, 40 + wRate + 46, 94)

  const cols = Math.max(1, input.data.heat.weeks)
  const rows = 7
  const gap = 6
  const x0 = 40
  const gridTop = 150
  const cell = Math.max(2, (CARD_W - x0 * 2 - (cols - 1) * gap) / cols)
  const offFill = dark ? 'rgba(164,158,240,.11)' : 'rgba(83,74,183,.07)'
  const onFill = dark ? 'rgba(164,158,240,.95)' : '#534ab7'
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const on = !!input.data.heat.grid[c * 7 + r]
      ctx.fillStyle = on ? onFill : offFill
      roundRect(ctx, x0 + c * (cell + gap), gridTop + r * (cell + gap), cell, cell, 4)
      ctx.fill()
    }
  }

  const gridBottom = gridTop + rows * cell + (rows - 1) * gap
  const capY = Math.min(HERO_H - 34, gridBottom + 42)
  ctx.font = `600 15px ${FONT_UI}`
  ctx.fillStyle = dark ? '#d8d4ea' : '#3a3554'
  ctx.textAlign = 'left'
  ctx.fillText('一季 · 每日一格', 40, capY)
  ctx.font = `11.5px ${FONT_UI}`
  drawSpaced(ctx, 'QUARTER ACTIVITY', 176, capY - 1, 2, dark ? '#8f8bab' : '#7c789a')
}

/* ================= 信息面板 ================= */

function drawPanel(
  ctx: CanvasRenderingContext2D,
  input: HeroCtx,
  p: ReturnType<typeof palette>,
  hide: Set<SlotKey>,
  opts: ShareCardRenderOpts,
): void {
  const { data, texts, style, theme, prompt } = input
  const dark = theme === 'dark'
  const L = panelLayout(style)
  const rects = slotRects(style)

  /* ---- 日期行 ---- */
  const mk = L.dateTop
  ctx.fillStyle = p.accent
  roundRect(ctx, PAD, mk, 38, 38, 11)
  ctx.fill()
  ctx.font = `21px ${FONT_SERIF}`
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.fillText('P', PAD + 19, mk + 27)

  ctx.textAlign = 'left'
  ctx.font = `500 15.5px ${FONT_UI}`
  ctx.fillStyle = p.ink
  ctx.fillText(dateCn(data.date), PAD + 50, mk + 17)
  ctx.font = `10.5px ${FONT_UI}`
  drawSpaced(ctx, 'PRODUCTIVITY LOG', PAD + 50, mk + 33, 1.7, p.ink3)
  ctx.font = `10.5px ${FONT_UI}`
  drawSpaced(ctx, dateTag(data.date), CARD_W - PAD, mk + 25, 1.6, p.ink3, 'right')

  /* ---- 寄语（三风格一律画在这里；曾有一份画在 hero，已删） ---- */
  if (!hide.has('quote')) {
    drawSlot(ctx, L.quote, texts.quote, dark ? '#e6e3f5' : p.ink, TEXT_LIMITS.quote)
  }

  /* ---- 题目区（富文本 + LaTeX）：有内容才画 ----
   *
   * 矩形由 `panelLayout()` 算出（`L.prompt`）—— 与编辑浮层的占位框、输入层共用同一份几何，
   * 不会漂移。早先这里用过手抄常量，错位 88px（见 shareCardRichText 头注）。
   *
   * 这块**不使用 hideSlots 跳过**：它没有对应的透明输入层 —— 公式的源码在输入框里是
   * 无法与渲染结果对齐的（同一段文本在不同排版下宽度差几倍），所以编辑期间由浮层
   * 自己在图上盖一块「源码」小面板，canvas 这边照画渲染结果。
   */
  if (prompt.trim() && opts.promptImage && opts.promptSize) {
    const pr = L.prompt
    ctx.fillStyle = dark ? 'rgba(164,158,240,.07)' : 'rgba(83,74,183,.05)'
    roundRect(ctx, pr.x, pr.y, pr.w, pr.h, 12)
    ctx.fill()
    ctx.strokeStyle = dark ? 'rgba(164,158,240,.18)' : 'rgba(83,74,183,.14)'
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.fillStyle = p.accent
    roundRect(ctx, pr.x + 14, pr.y + 14, 3, pr.h - 28, 2)
    ctx.fill()

    const iw = opts.promptSize.w
    const ih = opts.promptSize.h
    const maxW = pr.w - 34
    const maxH = pr.h - 24
    const k = Math.min(1, maxW / iw, maxH / ih)
    try {
      ctx.drawImage(opts.promptImage, pr.x + 26, pr.y + 12, iw * k, ih * k)
    } catch { /* 图损坏时不阻断整张卡 */ }
  }

  /* ---- 本周 7 格（周一起始） ---- */
  const wy = L.weekTop
  const cells = Array.isArray(data.week.cells) ? data.week.cells : []
  for (let i = 0; i < 7; i++) {
    ctx.fillStyle = cells[i] ? p.accent : p.line
    roundRect(ctx, PAD + i * 20, wy, 13, 13, 4)
    ctx.fill()
  }
  ctx.font = `11px ${FONT_UI}`
  ctx.fillStyle = p.ink3
  ctx.textAlign = 'right'
  ctx.fillText(`本周 ${Math.max(0, Math.min(7, data.week.done))}/7 天`, CARD_W - PAD, wy + 11)
  ctx.textAlign = 'left'

  /* ---- 页脚（贴底） ---- */
  ctx.strokeStyle = p.line
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(PAD, FOOT.ruleY + 0.5)
  ctx.lineTo(CARD_W - PAD, FOOT.ruleY + 0.5)
  ctx.stroke()

  const brandMarkTop = FOOT.brandTop + 13
  ctx.fillStyle = p.accent
  roundRect(ctx, PAD, brandMarkTop, FOOT.brandMark, FOOT.brandMark, 9)
  ctx.fill()
  ctx.font = `17px ${FONT_SERIF}`
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.fillText('P', PAD + FOOT.brandMark / 2, brandMarkTop + 21)
  ctx.textAlign = 'left'

  const brandX = PAD + FOOT.brandMark + FOOT.brandTextGap
  ctx.font = `600 17px ${FONT_UI}`
  ctx.fillStyle = p.ink
  ctx.fillText('Phrontis', brandX, BRAND_NAME_BASELINE)

  if (!hide.has('slogan')) drawSlot(ctx, rects.slogan, texts.slogan, p.ink3, TEXT_LIMITS.slogan)
  if (!hide.has('signature')) drawSlot(ctx, rects.signature, texts.signature, p.ink2, TEXT_LIMITS.signature)
}

/** 二维码：白底托板 + 图片（图未就绪时只画托板，不留洞） */
function drawQr(ctx: CanvasRenderingContext2D, qr: CanvasImageSource | null): void {
  const s = FOOT.qrSize
  const x = CARD_W - PAD - s
  const y = FOOT.bottom - s
  ctx.fillStyle = '#ffffff'
  roundRect(ctx, x, y, s, s, 8)
  ctx.fill()
  if (!qr) return
  try {
    ctx.drawImage(qr, x + 4, y + 4, s - 8, s - 8)
  } catch { /* 图损坏时保留白托板，出图不中断 */ }
}

export { CARD_H, parseRichText, richTextHeight, drawRichText }
