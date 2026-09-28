import { useEffect, useRef } from 'react'
import { useSettings } from '../../lib/SettingsContext'

/**
 * 主题氛围特效层（2026-09-27，方案见 docs/theme-fx-design.md §4.1）。
 *
 * 消费主题令牌 `--theme-fx`（petals / beams / leabes→leaves / snow 由主题插件 colors 表声明，
 * 内核只认令牌不认插件 id），在**父容器的最底层**（z-0，父容器内容层 z≥1）画四季粒子：
 *   春·樱瓣  夏·丁达尔光束  秋·落叶  冬·结晶雪
 *
 * 工程约定（原型 proto/theme-fx.html 四轮定稿，参数表见设计文档 §5）：
 *  - sprite 全部预渲染，运行时每帧只有 clearRect + 若干 drawImage（实测 0.34~0.56ms/帧）；
 *  - 单 rAF 循环；document.hidden 暂停归零，恢复续播；
 *  - prefers-reduced-motion → 只画一帧静态分布，不进循环；
 *  - 画布垫底靠「absolute z-0 + 内容层 relative z-1」，永不遮挡主体内容。
 *
 * 挂载面（2026-09-27 反馈 9 定稿，逐面挂法见设计文档 §4.2 挂载表）：**工作台 = WorkbenchShell 外壳**
 * （`!sidesGone` 门控 —— 整窗模块激活时让位给各模块自带画布，防双层粒子）/
 * 看板（dashboard）/ 设置（settings）/ 说说（moments）/ 书市（bookMarket）各一个实例；其它面不要挂。
 * ⚠️ 设计文档旧版写的「工作台 = desktop 模块根」是死代码（desktop 从未被 import），已更正到外壳层。
 */

export type ThemeFxKind = 'petals' | 'beams' | 'leaves' | 'snow'
export type ThemeFxDensity = 'low' | 'mid' | 'high'

const DENSITY: Record<ThemeFxDensity, number> = { low: 0.45, mid: 1, high: 1.8 }
const BASE_COUNT: Record<ThemeFxKind, number> = { petals: 24, beams: 22, leaves: 18, snow: 64 }
const FX_KINDS: readonly ThemeFxKind[] = ['petals', 'beams', 'leaves', 'snow']

/** 从根元素读当前主题声明的特效种类；无 / 未知 → null */
function readFxKind(): ThemeFxKind | null {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--theme-fx').trim()
  return (FX_KINDS as readonly string[]).includes(v) ? (v as ThemeFxKind) : null
}

/* ================= sprite 工厂（模块级单例，惰性构建一次） ================= */

type Sprite = HTMLCanvasElement
let SPRITES: {
  petals: Sprite[]
  leaves: Sprite[]
  snowDot: Sprite
  snowFlakes: Sprite[]
  motes: Sprite
  beam: Sprite
} | null = null

const rnd = (a: number, b: number) => a + Math.random() * (b - a)

function makeSprite(px: number, draw: (g: CanvasRenderingContext2D, s: number) => void): Sprite {
  const c = document.createElement('canvas')
  c.width = c.height = Math.ceil(px * 2.4)
  const g = c.getContext('2d')
  if (!g) return c
  g.translate(c.width / 2, c.height / 2) // 原点居中：负坐标不再被裁
  g.scale(2, 2)
  draw(g, px)
  return c
}

function buildSprites(): NonNullable<typeof SPRITES> {
  return {
    petals: ['#f6a8c5', '#f48fb1', '#fbc4d6', '#ee7ea4'].map((col) =>
      makeSprite(22, (g, s) => {
        const gr = g.createLinearGradient(0, -s, 0, s)
        gr.addColorStop(0, '#fde3ee'); gr.addColorStop(1, col)
        g.fillStyle = gr
        g.beginPath()
        g.moveTo(0, -s * 0.9)
        g.bezierCurveTo(s * 0.95, -s * 0.4, s * 0.8, s * 0.55, 0, s * 0.9)
        g.bezierCurveTo(-s * 0.8, s * 0.55, -s * 0.95, -s * 0.4, 0, -s * 0.9)
        g.fill()
      })),
    leaves: [['#e09a3e', '#c9622a'], ['#d97b2e', '#b5551f'], ['#e6b14a', '#c9861f'], ['#c9702e', '#9e4a1c'], ['#cdb03a', '#a2821f']].map(([lite, col]) =>
      makeSprite(36, (g, s) => {
        const w = s * 0.62
        const body = () => {
          g.beginPath()
          g.moveTo(0, -s * 0.92)                                          // 叶尖
          g.bezierCurveTo(w, -s * 0.5, w * 0.85, s * 0.4, 0, s * 0.78)    // 右缘鼓腹
          g.bezierCurveTo(-w * 0.85, s * 0.4, -w, -s * 0.5, 0, -s * 0.92) // 左缘鼓腹
          g.closePath()
        }
        const gr = g.createLinearGradient(-w, -s * 0.4, w, s * 0.5)
        gr.addColorStop(0, lite); gr.addColorStop(0.55, col); gr.addColorStop(1, col)
        g.fillStyle = gr
        body(); g.fill()
        g.strokeStyle = 'rgba(96,54,14,0.5)'; g.lineWidth = 1
        g.beginPath(); g.moveTo(0, -s * 0.75); g.quadraticCurveTo(s * 0.08, 0, 0, s * 0.72); g.stroke()
        g.lineWidth = 0.7
        for (const t of [-0.42, -0.08, 0.26]) {
          const y = t * s
          g.beginPath(); g.moveTo(0, y + s * 0.08); g.lineTo(w * 0.52, y - s * 0.14); g.stroke()
          g.beginPath(); g.moveTo(0, y + s * 0.08); g.lineTo(-w * 0.52, y - s * 0.14); g.stroke()
        }
        g.lineWidth = 1.1
        g.beginPath(); g.moveTo(0, s * 0.78); g.lineTo(-s * 0.06, s * 1.02); g.stroke()
      })),
    snowDot: makeSprite(12, (g, s) => {
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, s / 2)
      gr.addColorStop(0, 'rgba(255,255,255,0.9)')
      gr.addColorStop(0.6, 'rgba(255,255,255,0.75)')
      gr.addColorStop(1, 'rgba(185,208,232,0)')
      g.fillStyle = gr
      g.fillRect(-s / 2, -s / 2, s, s)
    }),
    // 近景：六角结晶（双层描边 = 白芯 + 淡蓝晕），3 种枝杈变体
    snowFlakes: [0, 1, 2].map((v) =>
      makeSprite(30, (g, s) => {
        const R = s * 0.42
        for (const pass of [{ c: 'rgba(165,198,230,0.6)', w: 2.4 }, { c: 'rgba(255,255,255,0.95)', w: 1.2 }]) {
          g.strokeStyle = pass.c
          g.lineWidth = pass.w * (s / 30)
          g.lineCap = 'round'
          for (let i = 0; i < 6; i++) {
            g.save()
            g.rotate(i * Math.PI / 3 + v * 0.22)
            g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -R); g.stroke()
            for (const t of [0.48, 0.74]) {
              const y = -R * t, len = R * 0.34 * (1.15 - t * 0.5)
              g.beginPath(); g.moveTo(0, y); g.lineTo(len, y - len * 0.75); g.stroke()
              g.beginPath(); g.moveTo(0, y); g.lineTo(-len, y - len * 0.75); g.stroke()
            }
            g.restore()
          }
          g.fillStyle = pass.c
          g.beginPath(); g.arc(0, 0, pass.w * 0.9, 0, 6.29); g.fill()
        }
      })),
    motes: makeSprite(26, (g, s) => {
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, s / 2)
      gr.addColorStop(0, 'rgba(255,225,140,0.85)')
      gr.addColorStop(0.35, 'rgba(255,208,96,0.35)')
      gr.addColorStop(1, 'rgba(255,200,80,0)')
      g.fillStyle = gr
      g.fillRect(-s / 2, -s / 2, s, s)
    }),
    // 丁达尔光束纹理：纵向 destination-in 高斯柔边，高亮低饱和暖白，沿光程非线性衰减
    beam: (() => {
      const c = document.createElement('canvas')
      c.width = 800; c.height = 220
      const g = c.getContext('2d')
      if (!g) return c
      g.translate(0, 110)
      const w0 = 34, w1 = 88
      const body = () => {
        g.beginPath(); g.moveTo(0, -w0); g.lineTo(800, -w1); g.lineTo(800, w1); g.lineTo(0, w0); g.closePath()
      }
      let gr = g.createLinearGradient(0, 0, 800, 0)
      gr.addColorStop(0, 'rgba(255,246,222,0.85)')
      gr.addColorStop(0.25, 'rgba(255,242,214,0.42)')
      gr.addColorStop(0.6, 'rgba(255,238,205,0.14)')
      gr.addColorStop(1, 'rgba(255,236,200,0)')
      g.fillStyle = gr; body(); g.fill()
      g.globalCompositeOperation = 'destination-in'
      const mask = g.createLinearGradient(0, -w1, 0, w1)
      mask.addColorStop(0, 'rgba(0,0,0,0)'); mask.addColorStop(0.32, 'rgba(0,0,0,1)')
      mask.addColorStop(0.68, 'rgba(0,0,0,1)'); mask.addColorStop(1, 'rgba(0,0,0,0)')
      g.fillStyle = mask; g.fillRect(-2, -w1 - 2, 804, w1 * 2 + 4)
      return c
    })(),
  }
}

/* ================= 引擎 ================= */

interface FxParticle {
  s: Sprite | Sprite[]
  i?: number
  x: number; y: number; size: number
  vy: number
  sway: number; ph: number; ps: number
  rot?: number; vr?: number
  flip?: number; fs?: number
  tw?: number; tws?: number
}

interface BeamConf { off: number; w: number; jit: number; phase: number; alpha: number }

class FxLayer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private effect: ThemeFxKind | null = null
  private density: ThemeFxDensity = 'mid'
  private parts: FxParticle[] = []
  private beams: BeamConf[] | null = null
  private raf = 0
  private running = false
  private last = 0
  private t = 0
  private w = 0
  private h = 0
  private ro: ResizeObserver

  constructor(canvas: HTMLCanvasElement) {
    SPRITES ??= buildSprites() // 惰性单例：首个实例构建，之后全部复用
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('[ThemeFxLayer] 2d context 不可用')
    this.ctx = ctx
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(canvas.parentElement ?? canvas)
    this.resize()
    document.addEventListener('visibilitychange', this.onVis)
  }

  private onVis = () => {
    if (document.hidden) this.stop()
    else this.start()
  }

  destroy(): void {
    this.stop()
    this.ro.disconnect()
    document.removeEventListener('visibilitychange', this.onVis)
  }

  private resize(): void {
    const r = (this.canvas.parentElement ?? this.canvas).getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.w = r.width; this.h = r.height
    this.canvas.width = r.width * dpr
    this.canvas.height = r.height * dpr
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (this.effect) this.spawnAll()
  }

  setDensity(d: ThemeFxDensity): void {
    this.density = d
    if (this.effect) this.spawnAll()
  }

  setEffect(kind: ThemeFxKind | null): void {
    this.effect = kind
    this.spawnAll()
    this.beams = kind === 'beams' ? this.buildBeams() : null
    if (!kind) {
      this.stop()
      this.ctx.clearRect(0, 0, this.w, this.h)
      return
    }
    this.start()
  }

  private count(kind: ThemeFxKind): number {
    return Math.round(BASE_COUNT[kind] * DENSITY[this.density])
  }

  private spawnOne(top: boolean): FxParticle {
    const w = this.w, h = this.h
    const S = SPRITES!
    // 速度单位 px/帧（60fps 基准）：落叶 0.5-1.2 ≈ 30-72px/秒
    if (!SPRITES) return { s: document.createElement('canvas'), x: 0, y: 0, size: 0, vy: 0, sway: 0, ph: 0, ps: 0 }
    switch (this.effect) {
      case 'petals':
        return { s: S.petals, i: Math.floor(rnd(0, 4)), x: rnd(0, w), y: top ? rnd(-40, 0) : rnd(0, h), size: rnd(7, 13), vy: rnd(0.3, 0.75), sway: rnd(12, 26), ph: rnd(0, 6.28), ps: rnd(0.04, 0.09), rot: rnd(0, 6.28), vr: rnd(-0.018, 0.018) }
      case 'leaves':
        return { s: S.leaves, i: Math.floor(rnd(0, 5)), x: rnd(0, w), y: top ? rnd(-50, 0) : rnd(0, h), size: rnd(13, 19), vy: rnd(0.5, 1.2), sway: rnd(15, 35), ph: rnd(0, 6.28), ps: rnd(0.03, 0.07), rot: rnd(0, 6.28), vr: rnd(-0.025, 0.025), flip: rnd(0, 6.28), fs: rnd(0.02, 0.06) }
      case 'snow': {
        // 远景 = 虚化雪点（纵深），近景 = 六角结晶（慢旋转）
        const near = Math.random() < 0.38
        return near
          ? { s: S.snowFlakes, i: Math.floor(rnd(0, 3)), x: rnd(0, w), y: top ? rnd(-40, 0) : rnd(0, h), size: rnd(17, 26), vy: rnd(0.5, 1.0), sway: rnd(10, 20), ph: rnd(0, 6.28), ps: rnd(0.03, 0.06), rot: rnd(0, 6.28), vr: rnd(-0.012, 0.012) }
          : { s: S.snowDot, x: rnd(0, w), y: top ? rnd(-30, 0) : rnd(0, h), size: rnd(3, 6), vy: rnd(0.35, 0.9), sway: rnd(8, 22), ph: rnd(0, 6.28), ps: rnd(0.03, 0.08) }
      }
      case 'beams':
        return { s: S.motes, x: rnd(0, w), y: top ? rnd(h, h + 40) : rnd(0, h), size: rnd(5, 12), vy: -rnd(0.15, 0.35), sway: rnd(6, 16), ph: rnd(0, 6.28), ps: rnd(0.02, 0.05), tw: rnd(0, 6.28), tws: rnd(0.05, 0.12) }
    }
    return { s: S.petals[0], x: 0, y: 0, size: 0, vy: 0, sway: 0, ph: 0, ps: 0 }
  }

  private spawnAll(): void {
    if (!this.effect) { this.parts = []; return }
    this.parts = Array.from({ length: this.count(this.effect) }, () => this.spawnOne(false))
  }

  private buildBeams(): BeamConf[] {
    return [
      { off: -185, w: 240, jit: -0.05, phase: 0.0, alpha: 0.7 },
      { off: -55,  w: 190, jit: 0.02,  phase: 1.3, alpha: 0.95 },
      { off: 55,   w: 260, jit: 0.05,  phase: 2.4, alpha: 0.6 },
      { off: 165,  w: 180, jit: -0.02, phase: 3.1, alpha: 0.85 },
      { off: 272,  w: 280, jit: 0.08,  phase: 4.2, alpha: 0.55 },
    ]
  }

  private step(dt: number): void {
    this.t += dt * 16.7
    const w = this.w, h = this.h
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i]
      p.ph += p.ps * dt
      p.x += Math.sin(p.ph) * p.sway * dt * 0.06
      p.y += p.vy * dt
      if (p.rot !== undefined) p.rot += (p.vr ?? 0) * dt
      if (p.flip !== undefined) p.flip += (p.fs ?? 0) * dt
      if (p.tw !== undefined) p.tw += (p.tws ?? 0) * dt
      const down = p.vy > 0
      if (down ? p.y > h + 30 : p.y < -30) this.parts[i] = this.spawnOne(true)
      if (p.x < -40) p.x = w + 30; else if (p.x > w + 40) p.x = -30
    }
  }

  private drawBeams(): void {
    const g = this.ctx
    if (!this.beams) return
    const L = Math.max(this.w, this.h) * 1.45
    const sx = this.w * 0.72, sy = this.h * 0.05
    for (const b of this.beams) {
      const ang = 2.44 + b.jit + Math.sin(this.t * 0.00004 + b.phase) * 0.018
      const px = Math.cos(ang - Math.PI / 2), py = Math.sin(ang - Math.PI / 2)
      g.save()
      g.globalCompositeOperation = 'lighter'
      g.globalAlpha = b.alpha * (0.72 + 0.28 * Math.sin(this.t * 0.00022 + b.phase * 2))
      g.translate(sx + px * b.off, sy + py * b.off)
      g.rotate(ang)
      g.drawImage(SPRITES!.beam, 0, -b.w / 2, L, b.w)
      g.restore()
    }
    // 光源光晕：大半径极低 alpha 径向渐变
    g.save()
    g.globalCompositeOperation = 'lighter'
    const glow = g.createRadialGradient(sx, sy, 0, sx, sy, this.h * 0.55)
    glow.addColorStop(0, 'rgba(255,240,205,0.45)')
    glow.addColorStop(0.4, 'rgba(255,230,170,0.14)')
    glow.addColorStop(1, 'rgba(255,225,160,0)')
    g.fillStyle = glow
    g.fillRect(0, 0, this.w, this.h)
    g.restore()
  }

  private draw(): void {
    const g = this.ctx
    g.clearRect(0, 0, this.w, this.h)
    if (this.effect === 'beams') this.drawBeams()
    if (this.effect === 'beams') g.globalCompositeOperation = 'lighter'
    for (const p of this.parts) {
      const img = (Array.isArray(p.s) ? p.s[p.i ?? 0] : p.s) as CanvasImageSource
      const half = p.size
      g.save()
      g.globalAlpha = p.tw !== undefined ? 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(p.tw)) : 0.92
      g.translate(p.x, p.y)
      if (p.rot !== undefined) g.rotate(p.rot)
      if (p.flip !== undefined) g.scale(0.55 + 0.45 * Math.abs(Math.cos(p.flip)), 1)
      g.drawImage(img, -half, -half, half * 2, half * 2)
      g.restore()
    }
    if (this.effect === 'beams') g.globalCompositeOperation = 'source-over'
  }

  private loop = (t: number): void => {
    if (!this.running) return
    if (!this.last) this.last = t
    const dt = Math.min((t - this.last) / 16.7, 3)
    this.last = t
    this.step(dt)
    this.draw()
    this.raf = requestAnimationFrame(this.loop)
  }

  private start(): void {
    if (this.running || !this.effect) return
    // 降级：reduced-motion 只画一帧静态分布，不进循环
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { this.draw(); return }
    this.running = true
    this.last = 0
    this.raf = requestAnimationFrame(this.loop)
  }

  private stop(): void {
    this.running = false
    cancelAnimationFrame(this.raf)
  }
}

/* ================= React 壳 ================= */

export function ThemeFxLayer(): React.JSX.Element {
  const { s } = useSettings()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const layerRef = useRef<FxLayer | null>(null)
  const enabledRef = useRef(s.themeFxEnabled !== false)
  enabledRef.current = s.themeFxEnabled !== false
  const density: ThemeFxDensity = s.themeFxDensity === 'low' || s.themeFxDensity === 'high' ? s.themeFxDensity : 'mid'

  useEffect(() => {
    if (!canvasRef.current) return
    const layer = new FxLayer(canvasRef.current)
    layerRef.current = layer
    return () => { layer.destroy(); layerRef.current = null }
  }, [])

  // 主题 class 变更 / 插件装卸 → 重读 --theme-fx；开关与密度 → 即时应用
  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    layer.setDensity(density)
    layer.setEffect(enabledRef.current ? readFxKind() : null)
  }, [density, s.themeFxEnabled])

  useEffect(() => {
    const apply = () => { layerRef.current?.setEffect(enabledRef.current ? readFxKind() : null) }
    const mo = new MutationObserver(apply)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    window.addEventListener('plugins-changed', apply)
    return () => {
      mo.disconnect()
      window.removeEventListener('plugins-changed', apply)
    }
  }, [])

  return <canvas ref={canvasRef} aria-hidden className="fx-layer pointer-events-none absolute inset-0 z-0 h-full w-full" />
}
