import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Check, ChevronRight, Globe, LayoutGrid, Maximize2, Minus, Play, Plus, Repeat, Sparkles } from 'lucide-react'
import type { AiTeachChapterReview, AiTeachCourseOutline, AiTeachCourseUnitProgress, AiTeachLessonInfo } from '../../../types'
import { FLOW_ST_LABEL } from './flowStatus'
import {
  NODE_W, NODE_H, OUTER_PAD, ROW_Y0, arrangePositions, bounds, chainEdges, clamp, edgePath, outerRect, screenToWorld, snapValue, zoneAtWorld, zoneRect,
  type FlowChapterShape, type FlowScope, type Point, type Viewport,
} from './flowLayout'

/**
 * AI教学「学习流」画布（方案：`.AGENT/.claude/plans/ai-teaching-flow-view-v390.md`）。
 *
 * 定位：替换原课程主页的列表（`CourseHome`），章=背景分组框、知识点=可拖卡片、连线=推进顺序。
 * 作用域分层（方案：`ai-teaching-scope-layers-v390.md`）：最外层「全局 / 工作区」框 → 章框 → 卡片，
 * 点哪层就选中哪层（右栏据此显示该层的要求 / 画像 / 素材）。
 *
 * 铁律：拖拽一律 **pointer events**（HTML5 拖放会静默失败）；拖拽期间禁用文本选取。
 */

interface Props {
  outline: AiTeachCourseOutline
  progress: Record<string, AiTeachCourseUnitProgress>
  lessons: Record<string, AiTeachLessonInfo>
  reviews: Record<string, AiTeachChapterReview>
  /** 当前选中的作用域层（画布上三层：工作区 / 章 / 知识点） */
  selScope: FlowScope
  onSelectScope: (scope: FlowScope) => void
  /** 「编辑这一层」——打开该层的要求 / 画像文档（工作区、全局两层已接现有入口） */
  onOpenScopeDoc?: (scope: FlowScope) => void
  onStartUnit: (unitId: string) => void
  onOpenChapterReview: (chapterId: string) => void
  /** 结束本知识点（收尾自测）——仅当选中节点课时已全部结束时出现 */
  onFinishQuiz: (unitId: string) => void
  /** 拖拽落点：把知识点移到目标章（可同章）的 beforeUnitId 之前；null=移到章末。落点未变时不会调用 */
  onMoveUnit: (unitId: string, targetChapterId: string, beforeUnitId: string | null) => void
  /** 位置持久化键（= 工作区 id）；卡片位置存 localStorage */
  layoutKey: string
}

const PAD = 48

interface NodeDrag {
  id: string
  /** 拖拽起点所在章（用于判断是否跨章高亮） */
  originId: string
  /** 指针相对卡片左上角的偏移（世界坐标） */
  dx: number
  dy: number
  /** 松手时的世界坐标 */
  x: number
  y: number
  moved: boolean
  left: number
  top: number
}

const STATUS_COLOR: Record<string, string> = {
  todo: 'var(--text-muted)',
  learning: 'var(--accent)',
  check: 'var(--warning)',
  mastered: 'var(--success)',
  review: 'var(--danger)',
}

function readStored(key: string): Record<string, Point> {
  try {
    const raw = localStorage.getItem(`aiteach.flow.layout.${key}`)
    if (!raw) return {}
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? obj : {}
  } catch { return {} }
}

export function FlowCanvas({ outline, progress, lessons, reviews, selScope, onSelectScope, onOpenScopeDoc, onStartUnit, onOpenChapterReview, onFinishQuiz, onMoveUnit, layoutKey }: Props) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const mmBoxRef = useRef<HTMLDivElement>(null)

  const viewRef = useRef<Viewport>({ x: 0, y: 0, k: 1 })
  const fittedRef = useRef<string | null>(null)
  const dragRef = useRef<{ x0: number; y0: number; vx: number; vy: number } | null>(null)
  const ndRef = useRef<NodeDrag | null>(null)
  /** pointer 手势结束会补发 click —— 拖完 250ms 内吞掉选中（铁律 9 dragGuard） */
  const guardRef = useRef(0)

  const [pos, setPos] = useState<Record<string, Point>>({})
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [zoomPct, setZoomPct] = useState(100)
  const [panning, setPanning] = useState(false)
  const [dragUnit, setDragUnit] = useState<Point & { id: string } | null>(null)
  const [dropZoneId, setDropZoneId] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 })
  const [mmSize, setMmSize] = useState({ w: 0, h: 0 })

  const baseChapters = useMemo<FlowChapterShape[]>(
    () => (outline.chapters ?? []).map((c) => ({ id: c.id, units: c.units.map((u) => ({ id: u.id, x: 0, y: 0 })) })),
    [outline],
  )

  // 位置初始化：已排过的沿用 → localStorage → 自动整理
  useEffect(() => {
    const arranged = arrangePositions(baseChapters)
    const stored = readStored(layoutKey)
    setPos((prev) => {
      const next: Record<string, Point> = {}
      for (const c of baseChapters) for (const u of c.units) {
        next[u.id] = prev[u.id] ?? stored[u.id] ?? arranged[u.id] ?? { x: 40, y: ROW_Y0 }
      }
      return next
    })
    fittedRef.current = null
  }, [baseChapters, layoutKey])

  const chapters = useMemo<FlowChapterShape[]>(
    () => baseChapters.map((c) => ({ id: c.id, units: c.units.map((u) => ({ id: u.id, ...(pos[u.id] ?? { x: 0, y: 0 }) })) })),
    [baseChapters, pos],
  )

  const posById = useMemo(() => {
    const m: Record<string, Point> = {}
    for (const c of chapters) for (const u of c.units) m[u.id] = { x: u.x, y: u.y }
    return m
  }, [chapters])

  const edges = useMemo(() => chainEdges(chapters, collapsed), [chapters, collapsed])
  const outer = useMemo(() => outerRect(chapters, collapsed), [chapters, collapsed])
  /** 选中的知识点 id（选中章 / 工作区层时为 null） */
  const selUnitId = selScope.level === 'unit' ? (selScope.unitId ?? null) : null
  /** 选中的章 id（选中知识点时同时高亮它所在的章） */
  const selChapterId = selScope.chapterId ?? (selUnitId ? chapters.find((c) => c.units.some((u) => u.id === selUnitId))?.id ?? null : null)

  const stats = useMemo(() => {
    let m = 0, d = 0, t = 0, sum = 0, n = 0
    for (const c of outline.chapters ?? []) for (const u of c.units) {
      const st = progress[u.id]?.status ?? 'todo'
      n++; sum += progress[u.id]?.mastery ?? 0
      if (st === 'mastered') m++; else if (st === 'learning') d++; else t++
    }
    return { m, d, t, n, pct: n ? Math.round((sum / n) * 100) : 0 }
  }, [outline, progress])

  const contUnit = useMemo(() => {
    const units = (outline.chapters ?? []).flatMap((c) => c.units)
    return units.find((u) => progress[u.id]?.status === 'learning')
      ?? units.find((u) => (progress[u.id]?.status ?? 'todo') !== 'mastered')
  }, [outline, progress])

  // 选中节点：课时全部结束且未收尾 → 可「结束本知识点（收尾自测）」
  const finishEligible = useMemo(() => {
    if (!selUnitId) return false
    if (progress[selUnitId]?.finished) return false
    const ls = Object.values(lessons ?? {}).filter((l) => l.unitId === selUnitId)
    return ls.length > 0 && ls.every((l) => l.status === 'ended')
  }, [selUnitId, progress, lessons])

  const persist = useCallback((p: Record<string, Point>) => {
    try { localStorage.setItem(`aiteach.flow.layout.${layoutKey}`, JSON.stringify(p)) } catch { /* 配额/隐私模式失败不影响主流程 */ }
  }, [layoutKey])

  const applyView = useCallback(() => {
    const v = viewRef.current
    const w = worldRef.current
    if (w) w.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.k})`
    const c = canvasRef.current
    if (c) {
      const g = 20 * 2 * v.k
      c.style.backgroundSize = `${g}px ${g}px`
      c.style.backgroundPosition = `${v.x}px ${v.y}px`
    }
  }, [])

  const fitView = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const cw = c.clientWidth, ch = c.clientHeight
    if (!cw || !ch) return
    const b = bounds(chapters, collapsed)
    const k = clamp(Math.min((cw - PAD * 2) / b.w, (ch - PAD * 2) / b.h), 0.3, 1.15)
    const v = viewRef.current
    v.k = k
    v.x = (cw - b.w * k) / 2 - b.x * k
    v.y = (ch - b.h * k) / 2 - b.y * k
    applyView()
    setZoomPct(Math.round(k * 100))
    setTick((t) => t + 1)
  }, [chapters, collapsed, applyView])

  const zoomBy = useCallback((f: number) => {
    const c = canvasRef.current
    if (!c) return
    const cx = c.clientWidth / 2, cy = c.clientHeight / 2
    const v = viewRef.current
    const k2 = clamp(v.k * f, 0.3, 2.4)
    v.x = cx - (cx - v.x) * (k2 / v.k)
    v.y = cy - (cy - v.y) * (k2 / v.k)
    v.k = k2
    applyView()
    setZoomPct(Math.round(k2 * 100))
    setTick((t) => t + 1)
  }, [applyView])

  const doArrange = useCallback(() => {
    const arranged = arrangePositions(baseChapters)
    setPos(arranged)
    persist(arranged)
    requestAnimationFrame(() => fitView())
  }, [baseChapters, persist, fitView])

  // 尺寸观测
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setCanvasSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setCanvasSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const el = mmBoxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setMmSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setMmSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  useEffect(() => { applyView() }, [applyView])

  // 首次适应视图（每个 layoutKey 一次）
  useEffect(() => {
    if (fittedRef.current === layoutKey) return
    if (!canvasSize.w || !canvasSize.h) return
    if (!Object.keys(pos).length) return
    fittedRef.current = layoutKey
    fitView()
  }, [canvasSize, pos, layoutKey, fitView])

  // 滚轮缩放（围绕光标）：必须原生非 passive 监听
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = c.getBoundingClientRect()
      const mx = e.clientX - r.left, my = e.clientY - r.top
      const v = viewRef.current
      const k2 = clamp(v.k * Math.pow(1.0016, -e.deltaY), 0.3, 2.4)
      v.x = mx - (mx - v.x) * (k2 / v.k)
      v.y = my - (my - v.y) * (k2 / v.k)
      v.k = k2
      applyView()
      setZoomPct(Math.round(k2 * 100))
      setTick((t) => t + 1)
    }
    c.addEventListener('wheel', onWheel, { passive: false })
    return () => c.removeEventListener('wheel', onWheel)
  }, [applyView])

  // 平移（拖空白）：pointer events
  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0) return
    const t = e.target as HTMLElement
    if (t.closest('[data-no-drag]')) return
    e.preventDefault()
    document.body.classList.add('dragging')
    setPanning(true)
    const v = viewRef.current
    dragRef.current = { x0: e.clientX, y0: e.clientY, vx: v.x, vy: v.y }
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      viewRef.current.x = d.vx + (ev.clientX - d.x0)
      viewRef.current.y = d.vy + (ev.clientY - d.y0)
      applyView()
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.classList.remove('dragging')
      dragRef.current = null
      setPanning(false)
      setTick((x) => x + 1)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [applyView])

  const onCanvasClick = useCallback((e: ReactMouseEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('[data-unit]') || t.closest('[data-zone]') || t.closest('[data-no-drag]')) return
    onSelectScope({ level: 'workspace' })
  }, [onSelectScope])

  /** 落点解析：目标章 + 插入位置（章内按 x 找第一个中心在拖拽卡片右侧的节点） */
  const resolveDrop = useCallback((unitId: string, nx: number, ny: number) => {
    const src = chapters.find((c) => c.units.some((u) => u.id === unitId))
    if (!src) return null
    const cx = nx + NODE_W / 2, cy = ny + NODE_H / 2
    const targetId = zoneAtWorld(chapters, collapsed, cx, cy, unitId) ?? src.id
    const target = chapters.find((c) => c.id === targetId)
    if (!target) return null
    const sorted = target.units.filter((u) => u.id !== unitId).slice().sort((a, b) => (a.x - b.x) || (a.y - b.y))
    const next = sorted.find((u) => u.x + NODE_W / 2 > cx)
    const beforeId = next ? next.id : null
    const newOrder = sorted.map((u) => u.id)
    newOrder.splice(beforeId ? newOrder.indexOf(beforeId) : newOrder.length, 0, unitId)
    const changed = targetId !== src.id || newOrder.join(',') !== target.units.map((u) => u.id).join(',')
    return { chapterId: targetId, beforeId, changed, crossChapter: targetId !== src.id }
  }, [chapters, collapsed])

  const commitMove = useCallback((unitId: string, nx: number, ny: number) => {
    const next = { ...posById, [unitId]: { x: nx, y: ny } }
    setPos(next)
    persist(next)
    const drop = resolveDrop(unitId, nx, ny)
    if (drop?.changed) onMoveUnit(unitId, drop.chapterId, drop.beforeId)
  }, [posById, persist, resolveDrop, onMoveUnit])

  // 拖卡片：pointer events（HTML5 拖放会静默失败）；未按住 Alt 时按 20 网格吸附
  const onNodeDown = useCallback((e: ReactPointerEvent, unitId: string) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const c = canvasRef.current
    const p = posById[unitId]
    if (!c || !p) return
    const origin = chapters.find((ch) => ch.units.some((u) => u.id === unitId))
    e.preventDefault()
    const r = c.getBoundingClientRect()
    const w = screenToWorld(e.clientX, e.clientY, r.left, r.top, viewRef.current)
    const nd: NodeDrag = { id: unitId, originId: origin?.id ?? '', dx: w.x - p.x, dy: w.y - p.y, x: p.x, y: p.y, moved: false, left: r.left, top: r.top }
    ndRef.current = nd
    const onMove = (ev: PointerEvent) => {
      const cur = ndRef.current
      if (!cur) return
      const wp = screenToWorld(ev.clientX, ev.clientY, cur.left, cur.top, viewRef.current)
      let nx = wp.x - cur.dx, ny = wp.y - cur.dy
      if (!ev.altKey) { nx = snapValue(nx); ny = snapValue(ny) }
      if (!cur.moved && (Math.abs(nx - cur.x) > 2 || Math.abs(ny - cur.y) > 2)) {
        cur.moved = true
        document.body.classList.add('dragging')
      }
      if (!cur.moved) return
      cur.x = nx; cur.y = ny
      setDragUnit({ id: cur.id, x: nx, y: ny })
      const d = resolveDrop(cur.id, nx, ny)
      setDropZoneId(d?.crossChapter ? d.chapterId : null)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.classList.remove('dragging')
      const done = ndRef.current
      ndRef.current = null
      setDragUnit(null)
      setDropZoneId(null)
      if (done?.moved) { guardRef.current = Date.now() + 250; commitMove(done.id, done.x, done.y) }
      setTick((t) => t + 1)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [posById, chapters, resolveDrop, commitMove])

  const toggleCollapse = useCallback((chapterId: string) => {
    setCollapsed((prev) => {
      const n = new Set(prev)
      if (n.has(chapterId)) n.delete(chapterId); else n.add(chapterId)
      return n
    })
    setTick((t) => t + 1)
  }, [])

  const doCenter = useCallback((unitId: string) => {
    const p = posById[unitId]
    const c = canvasRef.current
    if (!p || !c) return
    const v = viewRef.current
    v.x = c.clientWidth / 2 - (p.x + NODE_W / 2) * v.k
    v.y = c.clientHeight / 2 - (p.y + 38) * v.k
    applyView()
    setTick((t) => t + 1)
  }, [posById, applyView])

  const doCenterRect = useCallback((x: number, y: number, w: number, h: number) => {
    const c = canvasRef.current
    if (!c) return
    const v = viewRef.current
    v.x = c.clientWidth / 2 - (x + w / 2) * v.k
    v.y = c.clientHeight / 2 - (y + h / 2) * v.k
    applyView()
    setTick((t) => t + 1)
  }, [applyView])

  /** 选层 = 选中 + 视口跟随（知识点居中该卡、章居中该框、工作区适应全图） */
  const selectScope = useCallback((s: FlowScope) => {
    onSelectScope(s)
    if (s.level === 'unit' && s.unitId) { doCenter(s.unitId); return }
    if (s.level === 'chapter' && s.chapterId) {
      const ci = (outline.chapters ?? []).findIndex((c) => c.id === s.chapterId)
      const shape = chapters[ci]
      if (shape) {
        const r = zoneRect({ units: shape.units, index: ci, collapsed: collapsed.has(s.chapterId) })
        doCenterRect(r.x, r.y, r.w, r.h)
      }
      return
    }
    fitView()
  }, [onSelectScope, doCenter, doCenterRect, chapters, collapsed, outline, fitView])

  // 缩略图（几何同原型：包围盒 + 等比 fit）
  const mm = useMemo(() => {
    const b = bounds(chapters, collapsed)
    const pad = 60
    const W = b.w + pad * 2, H = b.h + pad * 2
    const s = Math.min((mmSize.w || 160) / W, (mmSize.h || 100) / H)
    const ox = ((mmSize.w || 160) - W * s) / 2
    const oy = ((mmSize.h || 100) - H * s) / 2
    return { b, pad, s, ox, oy }
  }, [chapters, collapsed, mmSize])
  const mmMap = (x: number, y: number): [number, number] => [
    (x - mm.b.x + mm.pad) * mm.s + mm.ox,
    (y - mm.b.y + mm.pad) * mm.s + mm.oy,
  ]
  const v = viewRef.current
  const [vx, vy] = mmMap(-v.x / v.k, -v.y / v.k)

  if (!chapters.length) {
    return (
      <div className="h-full min-h-0 flex items-center justify-center px-6">
        <div className="w-full max-w-[460px] text-center">
          <div className="mx-auto w-[46px] h-[46px] rounded-xl bg-[var(--accent)]/12 text-[var(--accent)] flex items-center justify-center"><Sparkles size={22} /></div>
          <h2 className="mt-4 text-[17px] font-semibold text-[var(--text-primary)]">这个工作区还没有课程大纲</h2>
          <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">学习流只服务有课程大纲的工作区。回到对话，跟<b>教学助手</b>说你的学习目标和素材，它会给一份大纲草稿；零散对话（随手提问、临时答疑）不入图。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 kb-flow">
      <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-[var(--border-soft)] overflow-hidden">
        <span className="text-[13px] font-semibold text-[var(--text-primary)] truncate min-w-0" title={outline.title}>{outline.title || '学习流'}</span>
        <span className="text-[11px] text-[var(--text-muted)] shrink-0">{stats.n} 个知识点 · {chapters.length} 章</span>
        <div className="flex items-center gap-3 text-[11px] text-[var(--text-secondary)] ml-1 shrink-0 whitespace-nowrap">
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><i className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--success)' }} />已掌握 <b className="text-[var(--text-primary)]">{stats.m}</b></span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><i className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--accent)' }} />在学 <b className="text-[var(--text-primary)]">{stats.d}</b></span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><i className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--text-muted)' }} />未学 <b className="text-[var(--text-primary)]">{stats.t}</b></span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">总掌握度 <b className="text-[var(--text-primary)]">{stats.pct}%</b></span>
          <span className="w-[110px] h-[4px] rounded-full bg-[var(--bg-tertiary)] overflow-hidden shrink-0"><i className="block h-full bg-[var(--accent)] kb-flow-bar" style={{ width: `${stats.pct}%` }} /></span>
        </div>
        <span className="flex-1 min-w-2" />
        <button data-no-drag onClick={doArrange} title="自动整理布局（按章分行、章内从左到右）"
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] kb-press shrink-0 whitespace-nowrap"><LayoutGrid size={13} />整理</button>
      </div>

      <div ref={canvasRef} onPointerDown={onPointerDown} onClick={onCanvasClick}
        className={`kb-flow-canvas relative flex-1 min-h-0 overflow-hidden ${panning ? 'kb-panning' : ''}`}
        style={{ cursor: panning ? 'grabbing' : 'grab' }}>
        <div ref={worldRef} className="absolute left-0 top-0 origin-top-left kb-flow-world">
          <svg width={8000} height={6000} className="absolute left-0 top-0 pointer-events-none overflow-visible">
            <defs>
              <marker id="kb-flow-arw" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,1 L7,4 L0,7 z" fill="var(--text-muted)" />
              </marker>
            </defs>
            {edges.map((e) => {
              const from = posById[e.fromId], to = posById[e.toId]
              if (!from || !to) return null
              return <path key={`${e.fromId}->${e.toId}`} d={edgePath(from, to)} fill="none" stroke="var(--text-muted)" strokeWidth={1.2} strokeDasharray="4 3" markerEnd="url(#kb-flow-arw)" opacity={0.75} />
            })}
          </svg>

          {/* 最外层框 = 全局 / 工作区（三层嵌套：外框 → 章框 → 卡片） */}
          <div data-outer onClick={() => selectScope({ level: 'workspace' })}
            className={`absolute left-0 top-0 rounded-[18px] border border-dashed cursor-pointer kb-flow-outer ${selScope.level === 'workspace' || selScope.level === 'global' ? 'kb-on' : ''}`}
            style={{ transform: `translate(${outer.x}px,${outer.y}px)`, width: outer.w, height: outer.h }}>
            <div className="h-10 flex items-center gap-2 px-3.5 select-none">
              <Globe size={12} className="shrink-0 text-[var(--text-muted)]" />
              <span className="text-[12px] font-semibold text-[var(--text-secondary)] whitespace-nowrap">全局 / 工作区</span>
              <span className="text-[10.5px] text-[var(--text-muted)] whitespace-nowrap">对本章及其下所有知识点生效</span>
              <span className="flex-1" />
              {onOpenScopeDoc && (
                <button data-no-drag onClick={(e) => { e.stopPropagation(); onOpenScopeDoc({ level: 'workspace' }) }}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] kb-press whitespace-nowrap">
                  编辑这一层
                </button>
              )}
            </div>
          </div>

          {(outline.chapters ?? []).map((c, ci) => {
            const shape = chapters[ci]
            const closed = collapsed.has(c.id)
            const zr = zoneRect({ units: shape.units, index: ci, collapsed: closed })
            const done = c.units.filter((u) => progress[u.id]?.status === 'mastered').length
            return (
              <div key={c.id} data-zone={c.id} onClick={() => selectScope({ level: 'chapter', chapterId: c.id })}
                className={`absolute left-0 top-0 rounded-[14px] border kb-flow-zone ${dropZoneId === c.id ? 'kb-drop' : ''} ${selChapterId === c.id ? 'kb-on' : ''}`}
                style={{ transform: `translate(${zr.x}px,${zr.y}px)`, width: zr.w, height: zr.h }}>
                <div data-zonehead data-no-drag className="h-10 flex items-center gap-2 px-3 select-none">
                  <button onClick={(e) => { e.stopPropagation(); toggleCollapse(c.id) }} title={closed ? '展开' : '折叠'}
                    className="w-[18px] h-[18px] grid place-items-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                    <ChevronRight size={12} className={closed ? '' : 'rotate-90'} />
                  </button>
                  <span className="text-[12.5px] font-semibold text-[var(--text-primary)] whitespace-nowrap overflow-hidden text-ellipsis">{c.name}</span>
                  <span className="text-[11px] text-[var(--text-muted)] shrink-0">{done}/{c.units.length}</span>
                  <span className="flex-1" />
                  <button onClick={(e) => { e.stopPropagation(); onOpenChapterReview(c.id) }} title="章末复习课：和课程助手讨论本章复习"
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] border border-[var(--accent)]/40 text-[var(--accent)] hover:bg-[var(--accent)]/10 kb-press">
                    <Repeat size={11} />复习课
                    {reviews[c.id]?.rel && <span className="text-[10px]">讲义</span>}
                  </button>
                </div>
                {!closed && (
                  <div className="absolute left-3 bottom-2 text-[10.5px] text-[var(--text-muted)] pointer-events-none">
                    {c.units.length} 个知识点 · 连线 = 推进顺序
                  </div>
                )}
                {!closed && shape.units.map((u) => {
                  const meta = outline.chapters[ci].units.find((x) => x.id === u.id)
                  const st = progress[u.id]?.status ?? 'todo'
                  const mastery = progress[u.id]?.mastery ?? 0
                  const lessonN = Object.values(lessons ?? {}).filter((l) => l.unitId === u.id).length
                  const on = selUnitId === u.id
                  const color = STATUS_COLOR[st] ?? 'var(--text-muted)'
                  const dragging = dragUnit?.id === u.id
                  const nx = dragging ? dragUnit!.x : u.x
                  const ny = dragging ? dragUnit!.y : u.y
                  return (
                    <div key={u.id} data-unit={u.id}
                      onPointerDown={(e) => onNodeDown(e, u.id)}
                      onClick={(e) => { e.stopPropagation(); if (Date.now() < guardRef.current) return; selectScope({ level: 'unit', unitId: u.id, chapterId: c.id }) }}
                      className={`absolute left-0 top-0 rounded-[10px] border cursor-pointer kb-flow-node ${on ? 'kb-on' : ''} ${dragging ? 'kb-dragging' : ''}`}
                      style={{ transform: `translate(${nx - zr.x}px,${ny - zr.y}px)`, width: NODE_W, borderColor: on ? 'var(--accent)' : undefined }}>
                      <span className="absolute left-0 top-[9px] bottom-[9px] w-[3px] rounded" style={{ background: color }} />
                      <div className="flex items-start gap-1.5">
                        <span className="text-[12.5px] font-semibold leading-snug flex-1 text-[var(--text-primary)]">{meta?.name ?? u.id}</span>
                        <span className="shrink-0 text-[10.5px] px-1.5 py-px rounded-[9px] border whitespace-nowrap" style={{ color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }}>
                          {st === 'learning' && <i className="kb-flow-pulse inline-block w-[5px] h-[5px] rounded-full mr-1 align-[1px]" style={{ background: 'var(--accent)' }} />}
                          {FLOW_ST_LABEL[st] ?? st}
                        </span>
                      </div>
                      <div className="my-1.5 h-[3px] rounded bg-[var(--bg-tertiary)] overflow-hidden">
                        <i className="block h-full kb-flow-bar" style={{ width: `${Math.round(mastery * 100)}%`, background: color }} />
                      </div>
                      <div className="text-[11px] text-[var(--text-muted)] whitespace-nowrap overflow-hidden text-ellipsis">
                        {Math.round(mastery * 100)}%{meta?.goal ? ` · ${meta.goal}` : ''}{lessonN ? ` · ${lessonN} 课时` : ''}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>

        {/* 缩放控件 */}
        <div data-no-drag className="absolute left-3.5 bottom-3.5 flex flex-col gap-0.5 p-1 rounded-[9px] bg-[var(--bg-secondary)] border border-[var(--border-color)] shadow-lg z-[6]">
          <ZBtn title="放大 ( + )" act={() => zoomBy(1.2)}><Plus size={14} /></ZBtn>
          <ZBtn title="缩小 ( − )" act={() => zoomBy(1 / 1.2)}><Minus size={14} /></ZBtn>
          <ZBtn title="适应视图 ( 0 )" act={fitView}><Maximize2 size={13} /></ZBtn>
        </div>

        {/* 缩略图 */}
        <div data-no-drag ref={mmBoxRef} className="absolute right-3.5 bottom-3.5 w-[172px] h-[114px] rounded-[9px] bg-[var(--bg-secondary)] border border-[var(--border-color)] shadow-lg overflow-hidden z-[6]">
          <div className="absolute inset-1.5">
            {chapters.map((c) => collapsed.has(c.id) ? null : c.units.map((u) => {
              const [x, y] = mmMap(u.x, u.y)
              const st = progress[u.id]?.status ?? 'todo'
              const color = STATUS_COLOR[st] ?? 'var(--text-muted)'
              return <div key={u.id} className="absolute rounded-[2px]" style={{ left: x, top: y, width: Math.max(3, NODE_W * mm.s), height: Math.max(2, 76 * mm.s), background: color, opacity: st === 'todo' ? 0.5 : 0.75 }} />
            }))}
            <div className="absolute border border-[var(--accent)] rounded-[3px] bg-[var(--accent)]/10"
              style={{ left: vx, top: vy, width: Math.max(8, (canvasSize.w / v.k) * mm.s), height: Math.max(8, (canvasSize.h / v.k) * mm.s) }} />
          </div>
        </div>

        {/* 浮动动作条 */}
        <div data-no-drag className="absolute left-1/2 -translate-x-1/2 bottom-4 flex items-center gap-1.5 p-1.5 rounded-[11px] bg-[var(--bg-secondary)] border border-[var(--border-color)] shadow-lg z-[6]">
          <button disabled={!contUnit} onClick={() => contUnit && onStartUnit(contUnit.id)}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-[var(--accent)] text-white text-[11.5px] hover:opacity-90 disabled:opacity-40 kb-press">
            <Play size={12} />继续学
          </button>
          {selUnitId && finishEligible && (
            <button onClick={() => onFinishQuiz(selUnitId)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[var(--success)]/40 text-[var(--success)] text-[11.5px] hover:bg-[var(--success)]/10 kb-press">
              <Check size={12} />结束本知识点
            </button>
          )}
          <span className="px-1.5 text-[11px] text-[var(--text-muted)]">在学 {stats.d} · 掌握度 {stats.pct}% · {zoomPct}%</span>
        </div>
      </div>
    </div>
  )
}

function ZBtn({ title, act, children }: { title: string; act: () => void; children: ReactNode }) {
  return (
    <button title={title} onClick={act}
      className="w-[26px] h-[26px] grid place-items-center rounded text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] kb-press">
      {children}
    </button>
  )
}

export default FlowCanvas
