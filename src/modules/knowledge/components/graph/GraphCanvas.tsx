/**
 * 图谱画布（R4-G1/G2/G3+/A8）：Canvas 2D + d3-force 物理 + 交互。
 * - G1：全局渲染 / 拖拽回弹 / 滚轮缩放 / 单击聚焦 / idle 停帧
 * - G2：A3 hover 淡化过渡(displayAlpha→targetAlpha lerp)、A5 空白拖惯性平移、
 *       hover 邻居动画化（淡化有过渡感）
 * - G3：data 变化增量 merge（新建/删除/导入/过滤 → 保留坐标局部重排，非整图重建）
 * - A8：新增节点半径生长淡入、删除节点 ghost 收缩淡出（无全局闪烁）
 * 本地图谱（A7）：由父层 GraphView 裁剪 data（BFS 子图），本组件 data 变化自动
 * 增量更新；本文件不做子图判定。
 */
import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useRef,
} from 'react'
import { forceLink, forceManyBody } from 'd3-force'
import type { GraphIndexData, GraphNode } from '../../../../lib/graphTypes'
import {
  buildSimulation, clusterAttraction, detectCommunities, mergeSimulation,
  type MergeGhost, type SimEdge, type SimNode, type SimOptions, type SimWorld,
} from './forceSim'
import { colorBySpace, readGraphTheme, type GraphThemeColors } from './colors'

export interface GraphCanvasHandle {
  zoomIn(): void
  zoomOut(): void
  fit(): void
  focusTo(id: string): void
}

interface Cam { x: number; y: number; s: number }

interface GhostAnim {
  node: MergeGhost
  /** 收缩进度 1→0（半径与透明度同乘） */
  g: number
}

interface Model {
  world: SimWorld
  cam: Cam
  camT: Cam
  hoverId: string | null
  drag: { id: string; sx: number; sy: number; moved: boolean } | null
  /** 空白拖松手后的惯性速度（世界坐标/帧） */
  panV: { x: number; y: number } | null
  size: { w: number; h: number; dpr: number }
  colors: GraphThemeColors
  /** 淡化状态（da=当前显示倍率, ta=目标），key = node.id；edges 按下标与 world.edges 对齐 */
  nodeDa: Map<string, { da: number; ta: number }>
  edgeDa: { da: number; ta: number }[]
  /** A8 删除动画：已从 sim 摘除、收缩淡出中的 ghost 节点 */
  ghosts: GhostAnim[]
  /** A8 新增节点出生进度：node id → 当前半径倍率（0→1），到 1 后移除条目 */
  births: Map<string, number>
}

interface GraphCanvasProps {
  data: GraphIndexData
  /** G3 开关；默认 false（统一 accent） */
  colorBySpaceEnabled?: boolean
  /** 力导向参数（变化时重应用 force，不重建节点布局） */
  simOpts?: SimOptions
  /** 页面标签显示的最小缩放（G3 设置可调） */
  labelThreshold?: number
  selectedId?: string | null
  onSelect?: (node: Pick<GraphNode, 'id' | 'title' | 'path' | 'kind' | 'degree'> | null) => void
}

const FONT = "-apple-system, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif"
const LERP = 0.18
const DEFAULT_LABEL_THRESHOLD = 0.6

export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas(
  { data, colorBySpaceEnabled = false, simOpts, labelThreshold, selectedId = null, onSelect },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const m = useRef<Model | null>(null)
  const raf = useRef(0)
  const lastDataRef = useRef<GraphIndexData | null>(null)
  const propsRef = useRef({ colorBySpaceEnabled, selectedId, labelThreshold: labelThreshold ?? DEFAULT_LABEL_THRESHOLD, data, simOpts })
  /** 自适应 tick 降频计数（大图单帧 tick 超预算时改为隔帧执行，见 step 内注释） */
  const tickGate = useRef({ skip: 0 })
  propsRef.current = { colorBySpaceEnabled, selectedId, labelThreshold: labelThreshold ?? DEFAULT_LABEL_THRESHOLD, data, simOpts }

  // ---- 世界坐标 ⇄ 屏幕 ----
  const screenToWorld = useCallback((sx: number, sy: number): { x: number; y: number } => {
    const md = m.current!
    return { x: (sx - md.size.w / 2) / md.cam.s + md.cam.x, y: (sy - md.size.h / 2) / md.cam.s + md.cam.y }
  }, [])

  const hitTest = useCallback((sx: number, sy: number): SimNode | null => {
    const md = m.current!
    let best: SimNode | null = null
    let bestD = Number.POSITIVE_INFINITY
    const s = md.cam.s
    for (const n of md.world.nodes) {
      if (n.x === undefined || n.y === undefined) continue
      const px = (n.x - md.cam.x) * s + md.size.w / 2
      const py = (n.y - md.cam.y) * s + md.size.h / 2
      const r = (n.r + (n.kind === 'tag' ? 5 : 4)) * s
      const d2 = (px - sx) ** 2 + (py - sy) ** 2
      if (d2 <= r * r && d2 < bestD) { bestD = d2; best = n }
    }
    return best
  }, [])

  /** 依据 hoverId 刷新每个 node/edge 的目标倍率（每帧调用；淡化交给 lerp） */
  const setTargets = useCallback((md: Model) => {
    const hoverId = md.hoverId
    const hoverSet = hoverId ? md.world.nbr.get(hoverId) : null
    for (const n of md.world.nodes) {
      const a = md.nodeDa.get(n.id)
      if (!a) continue
      if (!hoverSet) { a.ta = 1; continue }
      a.ta = (hoverId === n.id || hoverSet.has(n.id)) ? 1 : (n.kind === 'tag' ? 0.3 : 0.08)
    }
    for (let i = 0; i < md.world.edges.length; i++) {
      const e = md.world.edges[i]
      if (!hoverSet) { md.edgeDa[i].ta = 1; continue }
      const a = e.source as SimNode
      const b = e.target as SimNode
      const near = hoverId === a.id || hoverId === b.id || hoverSet.has(a.id) || hoverSet.has(b.id)
      md.edgeDa[i].ta = near ? 1 : 0.08
    }
  }, [])

  const draw = useCallback((md: Model) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // world 未就绪（骨架期 / 空数据）时不绘制
    if (!md.world?.sim) return
    const { w, h, dpr } = md.size
    const c = md.cam
    const colors = readGraphTheme()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = colors.bg
    ctx.fillRect(0, 0, w, h)

    const s = c.s
    const world = md.world
    const hoverId = md.hoverId
    const hoverSet = hoverId ? world.nbr.get(hoverId) : null
    const en = propsRef.current.colorBySpaceEnabled

    ctx.save()
    ctx.translate(w / 2, h / 2)
    ctx.scale(s, s)
    ctx.translate(-c.x, -c.y)

    // edges（倍率来自 nodeDa/edgeDa 淡化）
    ctx.lineWidth = 1 / s
    for (let i = 0; i < world.edges.length; i++) {
      const e = world.edges[i]
      const a = e.source as SimNode
      const b = e.target as SimNode
      const ax = a.x, ay = a.y, bx = b.x, by = b.y
      if (ax === undefined || ay === undefined || bx === undefined || by === undefined) continue
      const base = e.tag ? 0.2 : 0.4
      ctx.strokeStyle = colors.textMuted
      ctx.globalAlpha = Math.max(0, Math.min(1, base * md.edgeDa[i].da))
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(bx, by)
      ctx.stroke()
    }
    ctx.globalAlpha = 1

    for (const n of world.nodes) {
      const alpha = md.nodeDa.get(n.id)
      const da = alpha ? alpha.da : 1
      if (da <= 0.02) continue
      const ns = md.births.get(n.id) ?? 1 // A8 出生半径倍率
      const isOrphan = n.kind === 'page' && n.degree === 0
      ctx.globalAlpha = Math.max(0.03, Math.min(1, da)) * (isOrphan ? 0.5 : 1)
      if (n.kind === 'tag') {
        ctx.fillStyle = colors.textMuted
        const r = n.r * ns
        ctx.fillRect(n.x! - r / 2, n.y! - r / 2, r, r)
      } else if (n.kind === 'dangling') {
        // 未解析引用虚节点：虚线灰圈
        ctx.strokeStyle = colors.textDisabled
        ctx.lineWidth = 1.2 / s
        ctx.setLineDash([4 / s, 4 / s])
        ctx.beginPath()
        ctx.arc(n.x!, n.y!, n.r * ns, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
      } else {
        // 身份统一后无草稿态（2026-09-20 §2）：页节点一律实心填充，虚化分支退役
        ctx.fillStyle = en ? colorBySpace(n.path, colors) : colors.accent
        ctx.beginPath()
        ctx.arc(n.x!, n.y!, n.r * ns, 0, Math.PI * 2)
        ctx.fill()
      }
      // 选中/悬停环
      if (hoverId === n.id || propsRef.current.selectedId === n.id) {
        ctx.globalAlpha = 1
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 1.4 / s
        ctx.beginPath()
        ctx.arc(n.x!, n.y!, n.r * ns + 3.5 / s, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1

    // A8 删除动画：ghost 节点在原坐标收缩淡出（g 1→0，半径与透明度同乘）
    for (const gh of md.ghosts) {
      const gn = gh.node
      const g = Math.max(0, Math.min(1, gh.g))
      if (g <= 0.02) continue
      const gr = Math.max(0.01, gn.r * g)
      if (gn.kind === 'tag') {
        ctx.globalAlpha = g * 0.7
        ctx.fillStyle = colors.textMuted
        ctx.fillRect(gn.x - gr / 2, gn.y - gr / 2, gr, gr)
      } else if (gn.kind === 'dangling') {
        ctx.globalAlpha = g * 0.7
        ctx.strokeStyle = colors.textDisabled
        ctx.lineWidth = 1.2 / s
        ctx.setLineDash([4 / s, 4 / s])
        ctx.beginPath()
        ctx.arc(gn.x, gn.y, gr, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
      } else {
        ctx.globalAlpha = g * 0.75
        ctx.fillStyle = en ? colorBySpace(gn.path, colors) : colors.accent
        ctx.beginPath()
        ctx.arc(gn.x, gn.y, gr, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1

    // labels（tag 恒显；页在缩放足够大或为悬停/焦点/邻居时显示）
    if (s > 0.22) {
      ctx.font = `${11 / s}px ${FONT}`
      ctx.textBaseline = 'top'
      const maxWorld = 150 / s
      const focusId = propsRef.current.selectedId
      for (const n of world.nodes) {
        const alpha = md.nodeDa.get(n.id)
        const da = alpha ? alpha.da : 1
        if (da <= 0.05) continue
        const isHoverish = hoverId === n.id || (hoverSet ? hoverSet.has(n.id) : false)
        const labelAlways = n.kind === 'tag' || n.kind === 'dangling'
        const labelAt = propsRef.current.labelThreshold
        if (!labelAlways && !(s > labelAt || isHoverish || focusId === n.id)) continue
        const t = n.title
        if (!t) continue
        ctx.fillStyle = n.kind === 'dangling' ? colors.textDisabled : colors.textMuted
        ctx.globalAlpha = Math.max(0.05, da) * (isHoverish ? 1 : 0.8)
        ctx.font = `${11 / s}px ${FONT}`
        const w2 = ctx.measureText(t).width
        const ell = w2 > maxWorld ? `${t.slice(0, Math.max(1, Math.floor(maxWorld / 11) - 1))}…` : t
        const ns = md.births.get(n.id) ?? 1
        // 两行 label：title（主） + 父级目录（副·小灰），让 kb-hdlc-2 这类英文短代码
        // 可识别为「HDLC / kb-hdlc-2」（用户最直观的「这节点是什么」信号）
        // ISS-2026-09-04-05：tag 节点（kind=tag 且无 path）也补 parentCtx 副线（来自 graphIndex 注入的关联度最高 page 的父目录段）
        ctx.fillText(ell, n.x! - ctx.measureText(ell).width / 2, n.y! + n.r * ns + 6 / s)
        let parent = ''
        if (n.kind === 'page' && n.path) {
          parent = n.path.replace(/\.md$/i, '').split('/').slice(-2, -1)[0] || ''
        } else if (n.kind === 'tag') {
          parent = (n as { parentCtx?: string }).parentCtx || ''
        }
        if (parent && parent !== n.title) {
          ctx.font = `${9 / s}px ${FONT}`
          const subEll = ctx.measureText(parent).width > maxWorld ? `${parent.slice(0, Math.max(1, Math.floor(maxWorld / 9) - 1))}…` : parent
          ctx.fillText(subEll, n.x! - ctx.measureText(subEll).width / 2, n.y! + n.r * ns + 17 / s)
        }
      }
      ctx.globalAlpha = 1
    }
    ctx.restore()
  }, [])

  // ---- 帧循环（sim tick + alpha lerp + 相机插值 + 惯性 + 生长/收缩动画；全部收敛后停帧） ----
  // 自适应 tick 降频（性能 2026-09-10）：这里本就是「每帧最多 tick 一次」，但大图单次 tick
  // 可能逼近甚至吃掉整个帧预算，连续跑就是肉眼可见的卡顿。改为实测单次耗时，超过半帧
  // 预算（8ms）即隔帧 tick —— 布局收敛略慢一点，渲染与交互始终有帧可用。
  // 为什么没搬进 Web Worker：每帧仍需把上千节点坐标克隆回主线程（结构化克隆成本与一次
  // tick 同量级），且拖拽交互与增量 merge 都要跨线程双向同步状态，净收益为负。
  const step = useCallback((md: Model) => {
    const { sim } = md.world
    if (sim.alpha() > sim.alphaMin()) {
      if (tickGate.current.skip > 0) tickGate.current.skip--
      else {
        const t0 = performance.now()
        sim.tick()
        if (performance.now() - t0 > 8) tickGate.current.skip = 1
      }
    }
    setTargets(md)
    let alphaMoving = false
    for (const [, n] of md.nodeDa) {
      if (Math.abs(n.ta - n.da) > 0.002) { n.da += (n.ta - n.da) * LERP; alphaMoving = true } else n.da = n.ta
    }
    for (const e of md.edgeDa) {
      if (Math.abs(e.ta - e.da) > 0.002) { e.da += (e.ta - e.da) * LERP; alphaMoving = true } else e.da = e.ta
    }
    // A8 新增节点生长：半径倍率 0→1（比 alpha lerp 稍快，出生利落）
    let birthMoving = false
    if (md.births.size > 0) {
      for (const [id, g] of md.births) {
        const ng = g + (1 - g) * 0.3
        if (ng > 0.985) md.births.delete(id)
        else { md.births.set(id, ng); birthMoving = true }
      }
    }
    // A8 消失节点 ghost：半径/透明度 1→0 收缩淡出，收敛后移除
    let ghostMoving = false
    if (md.ghosts.length > 0) {
      md.ghosts = md.ghosts.filter((gh) => {
        gh.g -= 0.08
        if (gh.g <= 0.02) return false
        ghostMoving = true
        return true
      })
    }
    const k = 0.2
    const c = md.cam
    c.x += (md.camT.x - c.x) * k
    c.y += (md.camT.y - c.y) * k
    c.s += (md.camT.s - c.s) * k
    if (Math.abs(md.camT.x - c.x) < 0.01) c.x = md.camT.x
    if (Math.abs(md.camT.y - c.y) < 0.01) c.y = md.camT.y
    if (Math.abs(md.camT.s - c.s) < 0.001) c.s = md.camT.s
    // 惯性
    let panning = false
    if (md.panV) {
      const pv = md.panV
      c.x += pv.x
      c.y += pv.y
      pv.x *= 0.9
      pv.y *= 0.9
      if (Math.abs(pv.x) + Math.abs(pv.y) < 0.02) md.panV = null
      else panning = true
      md.camT.x = c.x
      md.camT.y = c.y
    }
    return {
      active: sim.alpha() > sim.alphaMin() || alphaMoving || birthMoving || ghostMoving || panning ||
        Math.abs(md.camT.x - c.x) + Math.abs(md.camT.y - c.y) + Math.abs(md.camT.s - c.s) > 0.001,
    }
  }, [setTargets])

  const kick = useCallback(() => {
    if (raf.current) return
    raf.current = requestAnimationFrame(function loop() {
      const md = m.current
      if (!md) { raf.current = 0; return }
      const { active } = step(md)
      draw(md)
      if (active || md.drag) raf.current = requestAnimationFrame(loop)
      else raf.current = 0
    })
  }, [draw, step])

  // ---- 相机命令 ----
  const zoomAt = useCallback((sx: number, sy: number, factor: number) => {
    const md = m.current!
    const w = screenToWorld(sx, sy)
    const ns = Math.min(3.5, Math.max(0.15, md.camT.s * factor))
    md.camT.s = ns
    md.camT.x = w.x - (sx - md.size.w / 2) / ns
    md.camT.y = w.y - (sy - md.size.h / 2) / ns
    kick()
  }, [kick, screenToWorld])

  useImperativeHandle(ref, () => ({
    zoomIn: () => { const md = m.current!; zoomAt(md.size.w / 2, md.size.h / 2, 1.45) },
    zoomOut: () => { const md = m.current!; zoomAt(md.size.w / 2, md.size.h / 2, 1 / 1.45) },
    fit() {
      const md = m.current
      if (!md || md.world.nodes.length === 0) return
      let minX = Number.POSITIVE_INFINITY, minY = Number.POSITIVE_INFINITY
      let maxX = Number.NEGATIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY
      for (const n of md.world.nodes) {
        if (n.x === undefined || n.y === undefined) continue
        minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x)
        minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y)
      }
      if (minX > maxX) return
      const bw = Math.max(1, maxX - minX)
      const bh = Math.max(1, maxY - minY)
      const ns = Math.min(2.5, Math.min((md.size.w - 100) / bw, (md.size.h - 100) / bh))
      md.camT.s = Math.max(0.08, ns)
      md.camT.x = (minX + maxX) / 2
      md.camT.y = (minY + maxY) / 2
      kick()
    },
    focusTo(id) {
      const md = m.current
      const n = md?.world.nodes.find((x) => x.id === id)
      if (!md || !n) return
      if (n.x === undefined || n.y === undefined) return
      md.camT.s = Math.max(1.5, md.camT.s)
      md.camT.x = n.x
      md.camT.y = n.y
      kick()
    },
  }), [kick])

  // ---- 交互 ----
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const md = m.current!
    const canvas = canvasRef.current!
    canvas.setPointerCapture(e.pointerId)
    const rect = canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const hit = hitTest(sx, sy)
    if (hit) {
      md.drag = { id: hit.id, sx, sy, moved: false }
      md.world.sim.alpha(0.3)
      canvas.style.cursor = 'grabbing'
      kick()
    } else {
      md.drag = { id: '', sx, sy, moved: false }
      canvas.style.cursor = 'grabbing'
      kick()
    }
  }, [hitTest, kick])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const md = m.current!
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    if (md.drag && md.drag.id) {
      const w = screenToWorld(sx, sy)
      const node = md.world.nodes.find((n) => n.id === md.drag!.id)
      if (node) {
        const dx = sx - md.drag.sx
        const dy = sy - md.drag.sy
        if (Math.abs(dx) + Math.abs(dy) > 3) md.drag.moved = true
        node.fx = w.x
        node.fy = w.y
        md.world.sim.alpha(0.3)
        kick()
      }
      return
    }
    if (md.drag && !md.drag.id) {
      // 空白拖 = 平移视口（记录速度供松手惯性）
      const dx = sx - md.drag.sx
      const dy = sy - md.drag.sy
      if (Math.abs(dx) + Math.abs(dy) > 2) md.drag.moved = true
      md.drag.sx = sx
      md.drag.sy = sy
      if (md.drag.moved) {
        const inv = 1 / md.cam.s
        const vx = -dx * inv
        const vy = -dy * inv
        md.cam.x += vx
        md.cam.y += vy
        md.camT.x = md.cam.x
        md.camT.y = md.cam.y
        md.panV = { x: vx * 1.6, y: vy * 1.6 }
      }
      return
    }
    // hover
    const prev = md.hoverId
    const hit = hitTest(sx, sy)
    md.hoverId = hit ? hit.id : null
    if (md.hoverId !== prev) {
      canvas.style.cursor = hit ? 'pointer' : 'default'
      kick()
    }
  }, [screenToWorld, hitTest, kick])

  const onPointerUp = useCallback(() => {
    const md = m.current!
    if (!md.drag) return
    const d = md.drag
    md.drag = null
    const node = d.id ? md.world.nodes.find((n) => n.id === d.id) : null
    if (node) {
      node.fx = null
      node.fy = null
      if (!d.moved && node.x !== undefined && node.y !== undefined) {
        // 单击 = 选中 + 聚焦
        onSelect?.({ id: node.id, title: node.title, path: node.path, kind: node.kind, degree: node.degree })
        const canvas = canvasRef.current!
        const md2 = m.current!
        md2.camT.s = Math.max(1.4, md2.camT.s)
        md2.camT.x = node.x
        md2.camT.y = node.y
        canvas.style.cursor = 'pointer'
        kick()
      }
    } else if (!d.moved) {
      onSelect?.(null)
    }
    // 惯性由 panV 承接（step 中衰减）；轻微速度直接忽略不启
  }, [onSelect, kick])

  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.18 : 1 / 1.18)
  }, [zoomAt])

  // ---- 生命周期 A（mount）：canvas 尺寸 + ResizeObserver + model 骨架 ----
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const w = canvas.clientWidth || 600
    const h = canvas.clientHeight || 400
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, w * dpr)
    canvas.height = Math.max(1, h * dpr)
    m.current = {
      world: undefined as unknown as SimWorld,
      cam: { x: 0, y: 0, s: 1 },
      camT: { x: 0, y: 0, s: 1 },
      hoverId: null, drag: null, panV: null,
      size: { w, h, dpr }, colors: readGraphTheme(),
      nodeDa: new Map(), edgeDa: [], ghosts: [], births: new Map(),
    }
    const ro = new ResizeObserver(() => {
      const md = m.current
      if (!md?.world?.sim) return
      const nw = canvas.clientWidth
      const nh = canvas.clientHeight
      if (!nw || !nh) return
      const nd = window.devicePixelRatio || 1
      canvas.width = Math.max(1, nw * nd)
      canvas.height = Math.max(1, nh * nd)
      md.size = { w: nw, h: nh, dpr: nd }
      draw(md)
    })
    ro.observe(canvas)
    return () => {
      ro.disconnect()
      if (raf.current) cancelAnimationFrame(raf.current)
      raf.current = 0
      const md = m.current
      if (md?.world?.sim) md.world.sim.stop()
      m.current = null
      lastDataRef.current = null
    }
  }, [draw])

  // ---- 生命周期 B（data）：首载全量 build；后续增量 merge（A8，保留坐标局部重排） ----
  useEffect(() => {
    const canvas = canvasRef.current
    const md = m.current
    if (!canvas || !md) return
    const dataChanged = lastDataRef.current !== data
    lastDataRef.current = data
    const first = !md.world
    const opts = propsRef.current.simOpts ?? {}
    if (first) {
      // 全量构建（首载 / 首次进入）：中心带散开 + 首帧自动适应
      const world = buildSimulation(data, opts)
      md.world = world
      md.nodeDa = new Map()
      for (const n of world.nodes) md.nodeDa.set(n.id, { da: 1, ta: 1 })
      md.edgeDa = world.edges.map(() => ({ da: 1, ta: 1 }))
      md.ghosts = []
      md.births = new Map()
      requestAnimationFrame(() => {
        const m2 = m.current
        if (!m2 || m2.world !== world || world.nodes.length === 0) return
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const n of world.nodes) {
          if (n.x === undefined || n.y === undefined) continue
          minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x)
          minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y)
        }
        if (minX > maxX) return
        const w2 = m2.size.w, h2 = m2.size.h
        const ns = Math.min(1, Math.min((w2 - 100) / Math.max(1, maxX - minX), (h2 - 100) / Math.max(1, maxY - minY)))
        const ct = m2.camT
        ct.s = m2.cam.s = Math.max(0.08, ns)
        ct.x = m2.cam.x = (minX + maxX) / 2
        ct.y = m2.cam.y = (minY + maxY) / 2
        kick()
      })
      return
    }
    if (!dataChanged) return
    // 增量 merge：保留 cam/camT（视角不跳），新节点生长、消失节点 ghost；
    // 仅当确有结构性变化才停旧 sim 换新（未变化保留旧 world，避免冻结画面）
    const prevWorld = md.world
    const mr = mergeSimulation(prevWorld, data, opts)
    if (!mr.changed) return
    prevWorld.sim.stop()
    md.world = mr.world
    // nodeDa：保留仍在的节点淡化状态；新增节点淡入；消失节点交给 ghosts
    const prevIds = new Set(prevWorld.nodes.map((p) => p.id))
    const addedSetIds = new Set(mr.addedIds)
    const nextNodeDa = new Map<string, { da: number; ta: number }>()
    for (const n of mr.world.nodes) {
      const old = prevIds.has(n.id) ? md.nodeDa.get(n.id) : null
      nextNodeDa.set(n.id, old ?? { da: addedSetIds.has(n.id) ? 0.001 : 1, ta: 1 })
    }
    md.nodeDa = nextNodeDa
    // edgeDa：与 edges 对齐重建；新增边淡入（旧边沿用 1，hover 淡化由 setTargets 每帧重算）
    const addedSet = new Set(mr.addedEdgeKeys)
    md.edgeDa = mr.world.edges.map((e) => {
      const a = e.source as SimNode
      const b = e.target as SimNode
      const aId = typeof a === 'object' ? a.id : String(a)
      const bId = typeof b === 'object' ? b.id : String(b)
      const k = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`
      return { da: addedSet.has(k) ? 0.001 : 1, ta: 1 }
    })
    // 出生进度表（新增节点半径 0→1 生长）；连续 merge 中未完成出生的节点保留进度
    const liveIds = new Set(mr.world.nodes.map((n) => n.id))
    const births = new Map<string, number>()
    for (const [id, g] of md.births) if (liveIds.has(id)) births.set(id, g)
    for (const id of mr.addedIds) if (!births.has(id)) births.set(id, 0.02)
    md.births = births
    // 消失节点 → ghost（收缩淡出）
    md.ghosts = md.ghosts.concat(mr.ghosts.map((node) => ({ node, g: 1 })))
    md.hoverId = null
    md.drag = null
    kick()
  }, [data, draw, kick])

  // ---- sim 参数动态应用（G3）：link/charge 参数与簇力开关变化时重配 force，不重建节点布局 ----
  useEffect(() => {
    const md = m.current
    if (!md?.world?.sim) return
    const { sim, nodes, edges } = md.world
    const o = simOpts ?? {}
    const linkDistance = o.linkDistance ?? 130
    const chargeStrength = o.chargeStrength ?? -320
    sim.force('link', forceLink<SimNode, SimEdge>(edges)
      .id((d) => d.id)
      .distance((l) => (l.tag ? 95 : linkDistance)))
    sim.force('charge', forceManyBody<SimNode>().strength((d) => (d.kind === 'tag' ? -90 : chargeStrength)))
    if (o.clusterForce) {
      const clusterMap = detectCommunities(propsRef.current.data)
      for (const n of nodes) n.cluster = clusterMap.get(n.id)
      sim.force('cluster', clusterAttraction((n) => n.cluster))
    } else {
      sim.force('cluster', null)
      for (const n of nodes) n.cluster = undefined
    }
    sim.alpha(0.5)
    kick()
    // 注意：仅 simOpts 变化时重配（data 变化走 mergeSimulation 已带 opts 建 force；
    // 依赖 data 会在 merge 后二次 alpha 重启，干扰 A8 局部动画）
  }, [simOpts, kick])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full block"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        const md = m.current
        if (md && md.hoverId) { md.hoverId = null; kick() }
      }}
      onWheel={onWheel}
    />
  )
})
