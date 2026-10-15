// 书桌伙伴 —— 参数化像素画（从 tmp/mascot-plugin-proto 移植；不依赖 DOM/canvas）。
// 所有绘制原语最终都落到整点 fillRect，故用一个 RGBA 缓冲 + 逐像素写入即可，
// 产出与原型 canvas 完全一致（原型已按整数像素对齐并做过无缝圆角修正）。

export const UNIT = 2 // 每逻辑格像素（= 清单 grid.cell）

function parseColor(c) {
  if (typeof c === 'string' && c[0] === '#') {
    let h = c.slice(1)
    if (h.length === 3) h = h.split('').map(x => x + x).join('')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255]
  }
  return [0, 0, 0, 255]
}

/** 建一个 W×H（设备像素）的透明画布 + 绘制原语；坐标以「逻辑格」为单位。 */
export function makePainter(W, H) {
  const buf = new Uint8ClampedArray(W * H * 4)
  let ox = 0, oy = 0

  function fill(x, y, w, h, color) {
    const [r, g, b, a] = parseColor(color)
    if (a === 0) return
    let x0 = Math.round(x * UNIT) + ox, y0 = Math.round(y * UNIT) + oy
    let x1 = x0 + Math.round(w * UNIT), y1 = y0 + Math.round(h * UNIT)
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0
    if (x1 > W) x1 = W; if (y1 > H) y1 = H
    for (let yy = y0; yy < y1; yy++) {
      let p = (yy * W + x0) * 4
      for (let xx = x0; xx < x1; xx++) {
        buf[p] = r; buf[p + 1] = g; buf[p + 2] = b; buf[p + 3] = a
        p += 4
      }
    }
  }

  // 圆角块：逐行单条带状（两矩形叠加会在细形状上留 1px 接缝）。
  function rr(x, y, w, h, rx, c) {
    const x0 = Math.round(x * UNIT), y0 = Math.round(y * UNIT)
    const w0 = Math.round(w * UNIT), h0 = Math.round(h * UNIT)
    const r0 = Math.max(0, Math.min(Math.round(rx * UNIT), Math.floor(Math.min(w0, h0) / 2)))
    if (r0 <= 0) { fill(x, y, w, h, c); return }
    for (let i = 0; i < h0; i++) {
      let inset = 0
      if (i < r0) inset = r0 - Math.round(Math.sqrt(Math.max(0, r0 * r0 - (r0 - i - 0.5) * (r0 - i - 0.5))))
      else if (i >= h0 - r0) { const j = h0 - 1 - i; inset = r0 - Math.round(Math.sqrt(Math.max(0, r0 * r0 - (r0 - j - 0.5) * (r0 - j - 0.5)))) }
      fill((x0 + inset) / UNIT, (y0 + i) / UNIT, Math.max(1, w0 - 2 * inset) / UNIT, 1 / UNIT, c)
    }
  }
  // 向下的三角（宽在上）——喙
  const tri = (x, y, dir, w, h, c) => {
    for (let i = 0; i < h; i++) { const ww = w * (1 - i / h); fill(dir > 0 ? x : x + (w - ww), y + i, ww, 1, c) }
  }
  // 向上的等腰三角（尖朝上）——耳羽、墨尖
  const tu = (cx, baseY, w, h, c) => {
    for (let i = 0; i < h; i++) { const ww = w * (i + 1) / h; fill(cx - ww / 2, baseY - h + i, ww, 1, c) }
  }

  return { buf, W, H, r: fill, rr, tri, tu, setOffset: (dx, dy) => { ox = Math.round(dx * UNIT); oy = Math.round(dy * UNIT) } }
}

/** eye moods: normal | happy | bad | sleep | wide */
export function drawEyes(P, cx, cy, mood, blink) {
  const ink = P._eye || '#2b2a26'
  if (blink || mood === 'sleep') { P.r(cx - 4.5, cy, 3.5, 1, ink); P.r(cx + 1, cy, 3.5, 1, ink); return }
  if (mood === 'happy') {
    P.r(cx - 4.5, cy + 1, 1, 1, ink); P.r(cx - 3.5, cy, 1.5, 1, ink); P.r(cx - 2, cy + 1, 1, 1, ink)
    P.r(cx + 1, cy + 1, 1, 1, ink); P.r(cx + 2, cy, 1.5, 1, ink); P.r(cx + 3.5, cy + 1, 1, 1, ink); return
  }
  if (mood === 'bad') {
    const X = (lx) => { [[-1.2, -1.2], [-0.6, -0.6], [0, 0], [0.6, 0.6], [1.2, 1.2], [1.2, -1.2], [0.6, -0.6], [-0.6, 0.6], [-1.2, 1.2]]
      .forEach(([dx, dy]) => P.r(lx + dx, cy + dy, 0.9, 0.9, ink)) }
    X(cx - 4); X(cx + 3); return
  }
  const s = mood === 'wide' ? 3.5 : 2.6
  P.r(cx - 4.6, cy - 0.5, 2, 3.4, ink); P.r(cx + 2.2, cy - 0.5, 2, 3.4, ink)
  if (P._eyeLight) { P.r(cx - 2.7, cy, 0.8, 0.8, P._eyeLight); P.r(cx + 4.1, cy, 0.8, 0.8, P._eyeLight) }
  void s
}

const C_INK = '#2f2e3a', C_INK2 = '#52516a', C_WHITE = '#fdfcfa'
const C_OWL = '#9c7452', C_OWL2 = '#74553a', C_BELLY = '#e6d3ad', C_BEAK = '#e8a94a'
const C_PAPER = '#fbf8ef', C_PAPER2 = '#e8e2d0', C_PAPER3 = '#c4b99e'

export const CHARACTERS = {
  papy: {
    name: '纸灵', id: 'papy', frameMs: 110,
    paint(P, state, t) {
      P._eye = '#3a352c'; P._eyeLight = null
      const mood = state === 'sweeping' ? 'sleep' : state === 'error' ? 'bad' : state === 'attention' ? 'happy' : state === 'notification' ? 'wide' : 'normal'
      const blink = (t % 97) < 2
      const shake = state === 'error' ? (t % 2 ? 1.2 : -1.2) : 0
      const bob = state === 'attention' ? -Math.abs(Math.sin(t * 0.45)) * 2.5 : Math.round(Math.sin(t * 0.16) * 0.8)
      const cx = 26 + shake
      const flat = state === 'sweeping', narrow = state === 'notification'
      const w = narrow ? 9 : (flat ? 22 : 18)
      const h = narrow ? 22 : (flat ? 8 : 18)
      const top = (narrow ? 14 : (flat ? 29 : 19)) + bob
      P.rr(cx - w / 2 - 1, top - 1, w + 2, h + 2, 3, C_PAPER3)
      P.rr(cx - w / 2, top, w, h, 2.5, C_PAPER)
      P.rr(cx + w / 2 - 3.4, top + 0.6, 3, 3, 0.8, C_PAPER2)
      const ey = top + (flat ? 4 : h * 0.44)
      drawEyes(P, cx, ey, mood, blink)
      if (!flat && !narrow && mood !== 'bad') P.r(cx - 1, ey + 3.2, 2, 0.9, C_PAPER3)
      if (state === 'thinking') { P.r(cx + 7, top - 5, 1.4, 1.4, C_PAPER3); P.r(cx + 9, top - 8, 2, 2, C_PAPER3) }
      if (state === 'notification') { P.r(cx + 6, top - 8, 1.5, 4, '#d97757'); P.r(cx + 6, top - 2.5, 1.5, 1.5, '#d97757') }
      if (state === 'sweeping') { P.r(cx + 7, top - 3, 1, 1, C_PAPER3); P.r(cx + 8.5, top - 6, 1.5, 1.5, C_PAPER3); P.r(cx + 11, top - 10, 2, 2, C_PAPER3) }
      if (state === 'attention') { P.r(cx + 8, top - 2, 1, 3, '#e0a94a'); P.r(cx + 7, top - 0.5, 3, 1, '#e0a94a') }
    },
  },
  inkling: {
    name: '小墨', id: 'inkling', frameMs: 80,
    paint(P, state, t) {
      P._eye = '#fdfcfa'; P._eyeLight = null
      const mood = state === 'sweeping' ? 'sleep' : state === 'error' ? 'bad' : state === 'attention' ? 'happy' : state === 'notification' ? 'wide' : 'normal'
      const blink = (t % 89) < 2
      const shake = state === 'error' ? (t % 2 ? 1.4 : -1.4) : 0
      const bob = state === 'attention' ? -Math.abs(Math.sin(t * 0.45)) * 2.5 : Math.round(Math.sin(t * 0.15) * 0.8)
      const cx = 26 + shake
      const flat = state === 'sweeping'
      const w = flat ? 22 : 16, h = flat ? 8 : 18
      const top = (flat ? 29 : 17) + bob
      P.rr(cx - w / 2 - 0.8, top + 0.8, w + 1.6, h - 0.8, 6, '#5b5a6b')
      P.rr(cx - w / 2, top + 1.6, w, h - 1.6, 6, C_INK)
      P.tu(cx, top + 3, 6, 6, C_INK)
      P.rr(cx - w / 2 + 2.4, top + 3.4, 2.6, 2.6, 1, C_WHITE)
      drawEyes(P, cx, top + (flat ? 3.6 : h * 0.44), mood, blink)
      if (state === 'thinking') { for (let i = 0; i < 3; i++) { const yy = top - 3 - ((t + i * 6) % 18) * 0.5; P.rr(cx + 5 + i * 2, yy, 1.8, 1.8, 0.8, C_INK2) } }
      if (state === 'notification') { P.r(cx + 7, top - 7, 1.6, 4, '#d97757'); P.r(cx + 7, top - 1.5, 1.6, 1.6, '#d97757') }
      if (state === 'sweeping') { P.r(cx - w / 2 - 3, top + h - 1, w + 6, 1.4, C_INK2); P.r(cx + 7, top - 3, 1, 1, C_INK2); P.r(cx + 8.5, top - 6, 1.5, 1.5, C_INK2); P.r(cx + 11, top - 10, 2, 2, C_INK2) }
      if (state === 'attention') { for (let i = 0; i < 4; i++) { P.r(cx - 11 + i * 7, top - 2 + (i % 2 ? 1 : 0), 1.4, 1.4, '#8a89a0') } }
      if (state === 'error' && t % 4 >= 2) { P.r(cx + 7, top + 3, 1.6, 4, '#d97757'); P.r(cx + 7, top + 8, 1.6, 1.6, '#d97757') }
    },
  },
  owlie: {
    name: '枭枭', id: 'owlie', frameMs: 80,
    paint(P, state, t) {
      const mood = state === 'sweeping' ? 'sleep' : state === 'error' ? 'bad' : state === 'attention' ? 'happy' : state === 'notification' ? 'wide' : 'normal'
      const blink = (t % 83) < 2
      const shake = state === 'error' ? (t % 2 ? 1.5 : -1.5) : 0
      const bob = state === 'attention' ? -Math.abs(Math.sin(t * 0.42)) * 2.5 : Math.round(Math.sin(t * 0.15) * 0.8)
      const turn = state === 'thinking' ? Math.round(Math.sin(t * 0.25) * 2) : 0
      const cx = 26 + shake
      const top = 13 + bob
      P.tu(cx - 7, top + 2, 5, 6, C_OWL2)
      P.tu(cx + 7, top + 2, 5, 6, C_OWL2)
      P.rr(cx - 10, top, 20, 21, 7, C_OWL)
      P.rr(cx - 5.5, top + 10.5, 11, 10, 3.5, C_BELLY)
      const flap = state === 'working' ? (t % 2 ? 1 : -1) : (state === 'attention' ? -2 : 0)
      P.rr(cx - 12.5, top + 8, 3.2, 9 + flap, 1.4, C_OWL2)
      P.rr(cx + 9.3, top + 8, 3.2, 9 + flap, 1.4, C_OWL2)
      const ex = 5.2, ey = top + 7.5
      for (const s of [-1, 1]) P.rr(cx + s * ex - 3.4 + turn * 0.15, ey - 3.4, 6.8, 6.8, 3.2, C_WHITE)
      if (mood === 'sleep' || blink) { P.r(cx - ex - 2.6, ey - 0.4, 5.2, 1, C_OWL2); P.r(cx + ex - 2.6, ey - 0.4, 5.2, 1, C_OWL2) }
      else if (mood === 'happy') { const H = (x) => { P.r(x - 2, ey + 0.4, 1.4, 1.4, C_OWL2); P.r(x - 0.4, ey - 0.8, 1.4, 1.4, C_OWL2); P.r(x + 1.2, ey + 0.4, 1.4, 1.4, C_OWL2) }; H(cx - ex); H(cx + ex) }
      else if (mood === 'bad') { const X = (x) => { [[-1.6, -1.6], [-0.8, -0.8], [0, 0], [0.8, 0.8], [1.6, 1.6], [1.6, -1.6], [0.8, -0.8], [-0.8, 0.8], [-1.6, 1.6]].forEach(([dx, dy]) => P.r(x + dx, ey + dy, 1, 1, C_OWL2)) }; X(cx - ex); X(cx + ex) }
      else { const pr = mood === 'wide' ? 3.2 : 2.6
        P.rr(cx - ex - pr / 2 + turn * 0.2, ey - pr / 2, pr, pr + 0.6, 0.9, C_OWL2)
        P.rr(cx + ex - pr / 2 + turn * 0.2, ey - pr / 2, pr, pr + 0.6, 0.9, C_OWL2)
        P.r(cx - ex - pr / 2 + 0.5, ey - pr / 2 + 0.3, 0.9, 0.9, '#fff'); P.r(cx + ex - pr / 2 + 0.5, ey - pr / 2 + 0.3, 0.9, 0.9, '#fff') }
      P.tri(cx - 1.7, ey + 3.4, 1, 3.4, 3, C_BEAK)
      P.r(cx - 6.5, top + 21, 4, 2, C_BEAK); P.r(cx - 7, top + 22.6, 3, 1.2, C_BEAK)
      P.r(cx + 2.5, top + 21, 4, 2, C_BEAK); P.r(cx + 2.5, top + 22.6, 3, 1.2, C_BEAK)
      if (state === 'thinking') { P.r(cx + 8, top - 6, 1.4, 1.4, C_OWL2); P.r(cx + 10, top - 9, 2, 2, C_OWL2) }
      if (state === 'notification') { P.r(cx + 8, top - 6, 1.6, 4, '#d97757'); P.r(cx + 8, top - 0.5, 1.6, 1.6, '#d97757') }
      if (state === 'sweeping') { P.r(cx + 8, top + 1, 1, 1, C_OWL2); P.r(cx + 9.5, top - 2, 1.5, 1.5, C_OWL2); P.r(cx + 12, top - 6, 2, 2, C_OWL2) }
      if (state === 'attention') { P.r(cx - 14, top + 8, 1.4, 3, '#e0a94a'); P.r(cx - 15.5, top + 9, 3, 1, '#e0a94a') }
    },
  },
}

export const LW = 52, LH = 40
