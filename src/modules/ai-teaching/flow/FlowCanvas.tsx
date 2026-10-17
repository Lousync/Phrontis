import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Check, ChevronRight, Globe, Lock, Maximize2, Minus, PencilLine, Play, Plus, Repeat, Sparkles } from 'lucide-react'
import type { AiTeachChapterReview, AiTeachCourseOutline, AiTeachCourseUnitProgress, AiTeachLessonInfo } from '../../../types'
import { FLOW_ST_LABEL } from './flowStatus'
import {
  NODE_H, NODE_W,
  applyDragToChapters, bounds, chainEdges, clamp, colsForWidth, dropBarRect, edgePath, fitViewport,
  layoutLanes, resolveDropIndex, screenToWorld, snapValue, spineEdges, spinePath,
  type DropResolve, type FlowChapterShape, type FlowScope, type Point, type Rect, type Viewport,
} from './flowLayout'

/**
 * AI教学「学习流」画布 v2（折行泳道）。
 *
 * 方案：`E:\Projects\KnowledgeRecorder\.AGENT\.claude\plans\ai-teaching-flow-v2-impl.md`（§二 20 项口径）
 * 原型：`E:\Projects\KnowledgeRecorder\tmp\aiteach-flow-proto-v2\index.html`（已验收）
 *
 * 与 v1 的三处根本差别：
 *   1. **折行泳道**：章内按画布宽度折行（`colsForWidth` 反算列数），不再是一条无限宽的横带；
 *   2. **只展开当前在学的章**，其余折叠成条 —— 一眼能扫完整门课的推进顺序；
 *   3. **顺序即真相源**：位置全部由「章顺序 + 章内顺序」派生，`localStorage` 坐标与「整理」按钮退役；
 *      松手只改顺序（走 `aiTeachCourseMoveUnit`），界面上的位置自动补位。
 *
 * 铁律：拖拽一律 **pointer events**（HTML5 拖放会静默失败）；拖拽期间禁用文本选取；
 * 手势结束浏览器会补发 click，靠 `guardRef` 250ms 窗口吞掉（铁律 9）。
 */

interface ScopeCount {
  /** 本层要求条数 */
  req: number
  /** 本层素材条数 */
  src: number
}

interface Props {
  outline: AiTeachCourseOutline
  progress: Record<string, AiTeachCourseUnitProgress>
  lessons: Record<string, AiTeachLessonInfo>
  reviews: Record<string, AiTeachChapterReview>
  /** 每知识点的分层计数（右栏「要求 / 素材」页签同源）；缺省 0 */
  scopeCounts?: Record<string, ScopeCount>
  /** 当前选中的作用域层（画布上三层：工作区 / 章 / 知识点） */
  selScope: FlowScope
  onSelectScope: (scope: FlowScope) => void
  /** 「编辑这一层」——打开该层的要求文档（工作区 / 章 / 知识点三层已接） */
  onOpenScopeDoc?: (scope: FlowScope) => void
  onStartUnit: (unitId: string) => void
  onOpenChapterReview: (chapterId: string) => void
  /** 结束本知识点（收尾自测）——仅当选中节点课时已全部结束时出现 */
  onFinishQuiz: (unitId: string) => void
  /** 拖拽落点：把知识点移到目标章的第 index 位（可同章）。顺序未变时不会调用 */
  onMoveUnit: (unitId: string, targetChapterId: string, beforeUnitId: string | null) => Promise<boolean>
  /** 布局记忆键（= 工作区 id）：当前章 / 上次课时的 localStorage key 用它拼 */
  layoutKey: string
  /** 当前章（CourseMode 记忆，§19）：它的卡片展开，其余折叠成条 */
  activeChapterId: string
  /** 点折叠条 = 展开并成为当前章（§19） */
  onFocusChapter: (chapterId: string) => void
  /** 「继续学」目标（§20 接着上次那节课；CourseMode 算好传进来） */
  nextUnitId: string | null
}

const PAD = 48

interface NodeDrag {
  id: string
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

/** 落点结果等价判定：指针每动一像素都重新解析，但**结论多数时候没变** —— 不变就别造新对象。 */
function sameDrop(a: DropResolve | null, b: DropResolve | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.chapterId === b.chapterId && a.index === b.index && a.beforeUnitId === b.beforeUnitId && a.changed === b.changed
}

/** 最近一次判定的相对时间（只做展示；解析不出来就留空，不猜） */
function agoLabel(iso?: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const day = Math.floor((Date.now() - t) / 86400000)
  if (day < 0) return ''
  if (day === 0) return '今天'
  if (day === 1) return '昨天'
  if (day < 30) return `${day} 天前`
  return `${Math.floor(day / 30)} 个月前`
}

export function FlowCanvas({
  outline, progress, lessons, reviews, scopeCounts, selScope, onSelectScope, onOpenScopeDoc,
  onStartUnit, onOpenChapterReview, onFinishQuiz, onMoveUnit, layoutKey, activeChapterId, onFocusChapter, nextUnitId,
}: Props) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const mmBoxRef = useRef<HTMLDivElement>(null)

  const viewRef = useRef<Viewport>({ x: 0, y: 0, k: 1 })
  const dragRef = useRef<{ x0: number; y0: number; vx: number; vy: number } | null>(null)
  const ndRef = useRef<NodeDrag | null>(null)
  /** pointer 手势结束会补发 click —— 拖完 250ms 内吞掉选中（铁律 9 dragGuard） */
  const guardRef = useRef(0)

  /** 编辑布局态：**不落盘**（刷新即回锁定态 —— 学习面上不该长期开着「可改大纲」） */
  const [editMode, setEditMode] = useState(false)
  const [zoomPct, setZoomPct] = useState(100)
  const [panning, setPanning] = useState(false)
  const [dragUnit, setDragUnit] = useState<(Point & { id: string }) | null>(null)
  const [drop, setDrop] = useState<DropResolve | null>(null)
  const [lockBubble, setLockBubble] = useState<{ left: number; top: number } | null>(null)
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 })
  const [mmSize, setMmSize] = useState({ w: 0, h: 0 })
  const [, setTick] = useState(0)

  /**
   * 松手后的乐观顺序：主进程要写 `课程.md` 再广播回来（几十~几百毫秒），
   * 不先本地翻顺序的话，卡片会「弹回旧位 → 广播到了再跳到新位」。
   * 用 `from === outline` 自证作废：`outline` 每次课程态刷新都是新对象，一到就自动丢掉乐观值。
   */
  const [pending, setPending] = useState<{ from: AiTeachCourseOutline; order: Array<{ id: string; unitIds: string[] }> } | null>(null)

  const metaById = useMemo(() => {
    const m = new Map<string, { name: string; goal: string }>()
    for (const c of outline.chapters ?? []) for (const u of c.units) m.set(u.id, { name: u.name, goal: u.goal })
    return m
  }, [outline])

  const order = useMemo<Array<{ id: string; unitIds: string[] }>>(() => {
    if (pending && pending.from === outline) return pending.order
    return (outline.chapters ?? []).map((c) => ({ id: c.id, unitIds: c.units.map((u) => u.id) }))
  }, [outline, pending])

  const ordered = useMemo<FlowChapterShape[]>(
    () => order.map((c) => ({ id: c.id, units: c.unitIds.map((id) => ({ id, x: 0, y: 0 })) })),
    [order],
  )

  /** 折行列数由画布宽度反算（§四-1：固定阈值会让宽中栏又退回横带） */
  const cols = useMemo(() => colsForWidth(canvasSize.w), [canvasSize.w])

  /** 折叠集合 = 除当前章以外全部（§4「只展开当前在学的章」） */
  const closedIds = useMemo(() => {
    const s = new Set<string>()
    for (const c of outline.chapters ?? []) if (c.id !== activeChapterId) s.add(c.id)
    return s
  }, [outline, activeChapterId])

  const base = useMemo(() => layoutLanes({ chapters: ordered, cols, closedIds }), [ordered, cols, closedIds])

  /** 拖拽实时坐标只喂给连线 / 缩略图；章框是「顺序的投影」，不随指针变形 */
  const liveChapters = useMemo(
    () => applyDragToChapters(base.chapters, dragUnit?.id ?? null, dragUnit?.x ?? 0, dragUnit?.y ?? 0),
    [base, dragUnit],
  )

  const posById = useMemo(() => {
    const m: Record<string, Point> = {}
    for (const c of liveChapters) for (const u of c.units) m[u.id] = { x: u.x, y: u.y }
    return m
  }, [liveChapters])

  const chain = useMemo(() => chainEdges(liveChapters, closedIds), [liveChapters, closedIds])
  const spine = useMemo(() => spineEdges(base.frames), [base])
  const barRect = useMemo(
    () => (drop ? dropBarRect(base.chapters, base.frames, cols, drop) : null),
    [drop, base, cols],
  )

  const stats = useMemo(() => {
    let m = 0, d = 0, c = 0, r = 0, t = 0, sum = 0, n = 0
    for (const ch of outline.chapters ?? []) for (const u of ch.units) {
      const st = progress[u.id]?.status ?? 'todo'
      n++; sum += progress[u.id]?.mastery ?? 0
      if (st === 'mastered') m++
      else if (st === 'learning') d++
      else if (st === 'check') c++
      else if (st === 'review') r++
      else t++
    }
    return { m, d, c, r, t, n, pct: n ? Math.round((sum / n) * 100) : 0 }
  }, [outline, progress])

  const selUnitId = selScope.level === 'unit' ? (selScope.unitId ?? null) : null
  const selChapterId = selScope.chapterId
    ?? (selUnitId ? (outline.chapters ?? []).find((c) => c.units.some((u) => u.id === selUnitId))?.id ?? null : null)

  // 选中节点：课时全部结束且未收尾 → 可「结束本知识点（收尾自测）」
  const finishEligible = useMemo(() => {
    if (!selUnitId) return false
    if (progress[selUnitId]?.finished) return false
    const ls = Object.values(lessons ?? {}).filter((l) => l.unitId === selUnitId)
    return ls.length > 0 && ls.every((l) => l.status === 'ended')
  }, [selUnitId, progress, lessons])

  const nextMeta = nextUnitId ? { id: nextUnitId, name: metaById.get(nextUnitId)?.name ?? '' } : null

  /* ---------------------------------------------------------------- 视线 */

  const applyView = useCallback(() => {
    const v = viewRef.current
    const w = worldRef.current
    if (w) w.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.k})`
    const c = canvasRef.current
    if (c) {
      const g = 40 * v.k
      c.style.backgroundSize = `${g}px ${g}px`
      c.style.backgroundPosition = `${v.x}px ${v.y}px`
    }
  }, [])

  const fit = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const cw = c.clientWidth, ch = c.clientHeight
    if (!cw || !ch) return
    const v = fitViewport(bounds(base.frames), cw, ch, PAD)
    viewRef.current = v
    applyView()
    setZoomPct(Math.round(v.k * 100))
    setTick((t) => t + 1)
  }, [base, applyView])

  /** 通过 ref 调 fit：避免「布局变了 → fit 变了 → effect 重跑 → 又 fit」把用户视角按住 */
  const fitRef = useRef(fit)
  useEffect(() => { fitRef.current = fit }, [fit])

  // 首次 / 改宽高 / 切工作区才调适应视图。
  // **数据刷新（outline 每次都是新对象）绝不重算视线** —— 那正是「拖完卡片视角被强行回正」的根因。
  useEffect(() => {
    if (!canvasSize.w || !canvasSize.h) return
    fitRef.current()
  }, [canvasSize.w, canvasSize.h, layoutKey])

  /** 选中后「露出」目标：已完整可见就不动视线（数据驱动的选中不该拽着画布跑） */
  const reveal = useCallback((r: Rect) => {
    const c = canvasRef.current
    if (!c) return
    const v = viewRef.current
    const left = -v.x / v.k, top = -v.y / v.k
    const right = left + c.clientWidth / v.k, bottom = top + c.clientHeight / v.k
    if (r.x >= left && r.y >= top && r.x + r.w <= right && r.y + r.h <= bottom) return
    viewRef.current = { k: v.k, x: c.clientWidth / 2 - (r.x + r.w / 2) * v.k, y: c.clientHeight / 2 - (r.y + r.h / 2) * v.k }
    applyView()
    setTick((t) => t + 1)
  }, [applyView])

  const zoomBy = useCallback((f: number) => {
    const c = canvasRef.current
    if (!c) return
    const cx = c.clientWidth / 2, cy = c.clientHeight / 2
    const v = viewRef.current
    const k2 = clamp(v.k * f, 0.18, 2.4)
    viewRef.current = { k: k2, x: cx - (cx - v.x) * (k2 / v.k), y: cy - (cy - v.y) * (k2 / v.k) }
    applyView()
    setZoomPct(Math.round(k2 * 100))
    setTick((t) => t + 1)
  }, [applyView])

  useEffect(() => { applyView() }, [applyView])

  // 尺寸观测。★ 尺寸没变就**不要 setState**：对象字面量每次都是新引用，React 不会 bail out，
  // 一次无意义的 ResizeObserver 回调就会把整块画布（含全部卡片）重渲一遍。
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const sync = () => setCanvasSize((p) => (p.w === el.clientWidth && p.h === el.clientHeight ? p : { w: el.clientWidth, h: el.clientHeight }))
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    sync()
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const el = mmBoxRef.current
    if (!el) return
    const sync = () => setMmSize((p) => (p.w === el.clientWidth && p.h === el.clientHeight ? p : { w: el.clientWidth, h: el.clientHeight }))
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    sync()
    return () => ro.disconnect()
  }, [])

  // 滚轮缩放（围绕光标）：必须原生非 passive 监听
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = c.getBoundingClientRect()
      const mx = e.clientX - r.left, my = e.clientY - r.top
      const v = viewRef.current
      const k2 = clamp(v.k * Math.pow(1.0016, -e.deltaY), 0.18, 2.4)
      viewRef.current = { k: k2, x: mx - (mx - v.x) * (k2 / v.k), y: my - (my - v.y) * (k2 / v.k) }
      applyView()
      setZoomPct(Math.round(k2 * 100))
      setTick((t) => t + 1)
    }
    c.addEventListener('wheel', onWheel, { passive: false })
    return () => c.removeEventListener('wheel', onWheel)
  }, [applyView])

  // 快捷键（方案里承诺过、v1 实现漏掉的 Esc / 0 / ±）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.key === 'Escape') { setLockBubble(null); onSelectScope({ level: 'workspace' }); return }
      if (e.key === '0') { fitRef.current(); return }
      if (e.key === '+' || e.key === '=') { zoomBy(1.2); return }
      if (e.key === '-') { zoomBy(1 / 1.2) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSelectScope, zoomBy])

  /* ---------------------------------------------------------------- 选择 */

  /** 选层 = 选中 + （必要时）把目标露出来；不动视线的情形一律不动 */
  const selectScope = useCallback((s: FlowScope) => {
    /** 刚结束的手势（卡片拖拽 / 画布平移）会补发 click —— 不吞掉就会在拖完瞬间挪视口 */
    if (Date.now() < guardRef.current) return
    onSelectScope(s)
    if (s.level === 'unit' && s.unitId) {
      const p = posById[s.unitId]
      if (p) reveal({ x: p.x, y: p.y, w: NODE_W, h: NODE_H })
      return
    }
    if (s.level === 'chapter' && s.chapterId) {
      const f = base.frames.find((x) => x.id === s.chapterId)
      if (f) reveal(f.rect)
    }
  }, [onSelectScope, posById, base, reveal])

  /** 点折叠条 = 展开并成为当前章（§19）：切换本身就会重排，这里顺手露一下 */
  const focusChapter = useCallback((chapterId: string) => {
    if (Date.now() < guardRef.current) return
    onFocusChapter(chapterId)
    onSelectScope({ level: 'chapter', chapterId })
  }, [onFocusChapter, onSelectScope])

  const onCanvasClick = useCallback((e: ReactMouseEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('[data-unit]') || t.closest('[data-zone]') || t.closest('[data-no-drag]')) return
    if (Date.now() < guardRef.current) return
    setLockBubble(null)
    onSelectScope({ level: 'workspace' })
  }, [onSelectScope])

  /* ---------------------------------------------------------------- 平移 */

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0) return
    const t = e.target as HTMLElement
    if (t.closest('[data-no-drag]')) return
    e.preventDefault()
    document.body.classList.add('dragging')
    setPanning(true)
    setLockBubble(null)
    const v = viewRef.current
    let moved = false
    dragRef.current = { x0: e.clientX, y0: e.clientY, vx: v.x, vy: v.y }
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const dx = ev.clientX - d.x0, dy = ev.clientY - d.y0
      if (!moved && Math.abs(dx) + Math.abs(dy) > 3) moved = true
      viewRef.current = { k: viewRef.current.k, x: d.vx + dx, y: d.vy + dy }
      applyView()
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.classList.remove('dragging')
      dragRef.current = null
      setPanning(false)
      // 平移手势结束后浏览器**仍会补发 click**，落点多半是章框 / 最外层工作区框（它们铺满整张图）。
      // 不吞掉这个 click，就会「刚拖走 → 立刻被居中 / 适应视图拽回原处」= 视角被强行回正。
      if (moved) guardRef.current = Date.now() + 250
      setTick((x) => x + 1)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [applyView])

  /* ---------------------------------------------------------------- 拖拽 */

  /** 订单被主进程确认前的乐观重排：移除 → 按 index 插回目标章 */
  const optimisticMove = useCallback((unitId: string, targetChapterId: string, index: number) => {
    const next = order.map((c) => ({ id: c.id, unitIds: c.unitIds.filter((id) => id !== unitId) }))
    const t = next.find((c) => c.id === targetChapterId)
    if (!t) return
    t.unitIds.splice(clamp(index, 0, t.unitIds.length), 0, unitId)
    setPending({ from: outline, order: next })
  }, [order, outline])

  const commitDrop = useCallback((unitId: string, res: DropResolve | null) => {
    if (!res || !res.changed) return
    optimisticMove(unitId, res.chapterId, res.index)
    void onMoveUnit(unitId, res.chapterId, res.beforeUnitId).then((ok) => {
      // 写盘失败（或主进程拒了）→ 撤掉乐观值，界面回到真相
      if (!ok) setPending(null)
    })
  }, [optimisticMove, onMoveUnit])

  /** 锁定态按下卡片：给行内提示 + 一键进编辑布局（替代「点了没反应」） */
  const showLockBubble = useCallback((clientX: number, clientY: number) => {
    const c = canvasRef.current
    if (!c) return
    const r = c.getBoundingClientRect()
    setLockBubble({
      left: clamp(clientX - r.left, 8, Math.max(8, r.width - 310)),
      top: clamp(clientY - r.top + 10, 8, Math.max(8, r.height - 96)),
    })
  }, [])

  const onNodeDown = useCallback((e: ReactPointerEvent, unitId: string) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button')) return
    e.stopPropagation()
    // §12：拖拽默认锁住 —— 学习面上不让误拖改大纲
    if (!editMode) { showLockBubble(e.clientX, e.clientY); return }
    const c = canvasRef.current
    const p = posById[unitId]
    if (!c || !p) return
    e.preventDefault()
    setLockBubble(null)
    const r = c.getBoundingClientRect()
    const w = screenToWorld(e.clientX, e.clientY, r.left, r.top, viewRef.current)
    const nd: NodeDrag = { id: unitId, dx: w.x - p.x, dy: w.y - p.y, x: p.x, y: p.y, moved: false, left: r.left, top: r.top }
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
      setDragUnit((prev) => (prev && prev.id === cur.id && prev.x === nx && prev.y === ny ? prev : { id: cur.id, x: nx, y: ny }))
      const d = resolveDropIndex({
        chapters: base.chapters, cols, closedIds, dragId: cur.id,
        cx: nx + NODE_W / 2, cy: ny + NODE_H / 2,
      })
      setDrop((prev) => (sameDrop(prev, d) ? prev : d))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.classList.remove('dragging')
      const done = ndRef.current
      ndRef.current = null
      setDragUnit(null)
      const res = done?.moved && done
        ? resolveDropIndex({ chapters: base.chapters, cols, closedIds, dragId: done.id, cx: done.x + NODE_W / 2, cy: done.y + NODE_H / 2 })
        : null
      setDrop(null)
      if (done?.moved) {
        guardRef.current = Date.now() + 250
        commitDrop(done.id, res)
      }
      setTick((t) => t + 1)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [editMode, posById, showLockBubble, base, cols, closedIds, commitDrop])

  /* ---------------------------------------------------------------- 缩略图 */

  const mm = useMemo(() => {
    const b = bounds(base.frames)
    const pad = 60
    const W = b.w + pad * 2, H = b.h + pad * 2
    const s = Math.min((mmSize.w || 160) / W, (mmSize.h || 100) / H)
    return { b, pad, s, ox: ((mmSize.w || 160) - W * s) / 2, oy: ((mmSize.h || 100) - H * s) / 2 }
  }, [base, mmSize])
  const mmMap = (x: number, y: number): [number, number] => [
    (x - mm.b.x + mm.pad) * mm.s + mm.ox,
    (y - mm.b.y + mm.pad) * mm.s + mm.oy,
  ]
  const v = viewRef.current
  const [vx, vy] = mmMap(-v.x / v.k, -v.y / v.k)

  const chapters = outline.chapters ?? []
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
      {/* 顶栏：标题 + 四段分段条（大数字）+ 编辑布局 */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-[var(--border-soft)] overflow-hidden">
        <span className="text-[13px] font-semibold text-[var(--text-primary)] truncate min-w-0" title={outline.title}>{outline.title || '学习流'}</span>
        <span className="text-[11px] text-[var(--text-muted)] shrink-0 whitespace-nowrap">{stats.n} 个知识点 · {chapters.length} 章</span>
        <div data-stats className="flex items-center gap-2.5 shrink-0 min-w-0">
          <span className="text-[19px] font-semibold text-[var(--text-primary)] tabular-nums whitespace-nowrap">{stats.pct}<span className="text-[11px] font-normal text-[var(--text-muted)]">% 总掌握度</span></span>
          <span className="kb-flow-segbar w-[190px]">
            {([['m', 'var(--success)'], ['d', 'var(--accent)'], ['c', 'var(--warning)'], ['r', 'var(--danger)'], ['t', 'var(--text-disabled)']] as const).map(([k, color]) => (
              <i key={k} style={{ width: `${(stats[k] / Math.max(1, stats.n)) * 100}%`, background: color }} />
            ))}
          </span>
          <span data-legend className="flex items-center gap-[9px] text-[10.5px] text-[var(--text-secondary)] whitespace-nowrap">
            <span title="已掌握"><i className="kb-flow-dot" style={{ background: 'var(--success)' }} />{stats.m}</span>
            <span title="在学"><i className="kb-flow-dot" style={{ background: 'var(--accent)' }} />{stats.d}</span>
            <span title="待检验"><i className="kb-flow-dot" style={{ background: 'var(--warning)' }} />{stats.c}</span>
            <span title="待复习"><i className="kb-flow-dot" style={{ background: 'var(--danger)' }} />{stats.r}</span>
            <span title="未开始"><i className="kb-flow-dot" style={{ background: 'var(--text-disabled)' }} />{stats.t}</span>
          </span>
        </div>
        <span className="flex-1 min-w-2" />
        {/* 工作区层的入口（外框撤掉后从顶栏进）：直接开本工作区的要求文档 */}
        {onOpenScopeDoc && (
          <button data-no-drag onClick={() => onOpenScopeDoc({ level: 'workspace' })}
            title="工作区层要求：本工作区所有会话都读得到（写在这里的条目对本工作区所有知识点生效）"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] kb-press shrink-0 whitespace-nowrap">
            <Globe size={12} />本工作区要求
          </button>
        )}
        <button data-no-drag onClick={() => { setEditMode((m) => !m); setLockBubble(null) }}
          title={editMode ? '退出编辑布局（回到锁定态）' : '进入编辑布局：可以拖卡片改推进顺序'}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] border kb-press shrink-0 whitespace-nowrap ${editMode ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
          {editMode ? <><Check size={13} />完成布局</> : <><PencilLine size={12} />编辑布局</>}
        </button>
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
              <marker id="kb-flow-arw-on" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,1 L7,4 L0,7 z" fill="var(--accent)" />
              </marker>
            </defs>
            {/* 章间主干：锚章框底中 → 下一章框顶中（章折叠时这条线必须还在） */}
            {spine.map((e) => {
              const prev = chapters.find((c) => c.id === e.chapterId)
              const done = !!prev && prev.units.length > 0 && prev.units.every((u) => progress[u.id]?.status === 'mastered')
              return (
                <path key={`spine-${e.chapterId}`} data-edge="spine" d={spinePath(e.from, e.to)} fill="none"
                  stroke={done ? 'var(--accent)' : 'var(--text-muted)'} strokeWidth={done ? 1.6 : 1.2}
                  strokeDasharray={done ? undefined : '6 4'} markerEnd={done ? 'url(#kb-flow-arw-on)' : 'url(#kb-flow-arw)'}
                  opacity={done ? 0.9 : 0.7} />
              )
            })}
            {/* 章内推进链：已走过（源节点已掌握 / 在学）→ 实线 + 状态色 */}
            {chain.map((e) => {
              const from = posById[e.fromId], to = posById[e.toId]
              if (!from || !to) return null
              const st = progress[e.fromId]?.status ?? 'todo'
              const done = st === 'mastered' || st === 'learning'
              return (
                <path key={`chain-${e.fromId}-${e.toId}`} data-edge="chain" d={edgePath(from, to)} fill="none"
                  stroke={done ? 'var(--accent)' : 'var(--text-muted)'} strokeWidth={done ? 1.6 : 1.2}
                  strokeDasharray={done ? undefined : '4 3'} markerEnd={done ? 'url(#kb-flow-arw-on)' : 'url(#kb-flow-arw)'}
                  opacity={done ? 0.9 : 0.7} />
              )
            })}
          </svg>

          {/* 2026-10-17 撤掉「全局 / 工作区」外框：一整个画布就是一个工作区，再套一圈虚线框纯属冗余
              （用户原话「明明一个画布就是一个工作区啊」）。工作区层的入口没丢：
              ① 顶栏「本工作区要求」按钮 → 直接开该层要求文档；② 右栏「层级」页签的面包屑首项「工作区」；
              ③ 点画布空白处 = 选中工作区层（右栏跟着切到该层），不画框也有反馈。 */}

          {/* 章框：当前章展开（折行泳道 + 底部注记带），其余折叠成条 */}
          {base.frames.map((f, fi) => {
            const c = chapters[fi]
            if (!c) return null
            const done = c.units.filter((u) => progress[u.id]?.status === 'mastered').length
            const pct = c.units.length ? Math.round((done / c.units.length) * 100) : 0
            const isActive = !f.closed
            return (
              <div key={c.id} data-zone={c.id} onClick={() => (isActive ? selectScope({ level: 'chapter', chapterId: c.id }) : focusChapter(c.id))}
                className={`absolute left-0 top-0 rounded-[14px] border kb-flow-zone ${drop?.chapterId === c.id && dragUnit ? 'kb-drop' : ''} ${selChapterId === c.id ? 'kb-on' : ''} ${isActive ? '' : 'kb-closed'}`}
                style={{ transform: `translate(${f.rect.x}px,${f.rect.y}px)`, width: f.rect.w, height: f.rect.h }}>
                <div data-zonehead data-no-drag className="h-10 flex items-center gap-2 px-3 select-none">
                  <span className={`w-[18px] h-[18px] grid place-items-center rounded text-[var(--text-muted)] ${isActive ? '' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
                    <ChevronRight size={12} className={isActive ? 'rotate-90 kb-chevron' : 'kb-chevron'} />
                  </span>
                  <span className="text-[12.5px] font-semibold text-[var(--text-primary)] whitespace-nowrap overflow-hidden text-ellipsis">{c.name}</span>
                  <span className="text-[11px] text-[var(--text-muted)] shrink-0 tabular-nums">{done}/{c.units.length}</span>
                  <span data-chprog className="w-[56px] h-[5px] rounded-full bg-[var(--bg-tertiary)] overflow-hidden shrink-0">
                    <i className="block h-full kb-flow-bar" style={{ width: `${pct}%`, background: 'var(--success)' }} />
                  </span>
                  <span className="flex-1" />
                  {isActive && (
                    <button data-no-drag onClick={(e) => { e.stopPropagation(); onOpenChapterReview(c.id) }} title="章末复习课：和课程助手讨论本章复习"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] border border-[var(--accent)]/40 text-[var(--accent)] hover:bg-[var(--accent)]/10 kb-press shrink-0">
                      <Repeat size={11} />复习课
                      {reviews[c.id]?.rel && <span className="text-[10px]">讲义</span>}
                    </button>
                  )}
                </div>
                {/* 注记只在「展开且有卡片」时出现：折叠条高度只有 62px，塞进去会压住标题 */}
                {isActive && c.units.length > 0 && (
                  <div data-zonefoot={c.id} className="absolute left-3 bottom-2 text-[10.5px] text-[var(--text-muted)] pointer-events-none">
                    {c.units.length} 个知识点 · 连线 = 推进顺序
                  </div>
                )}
              </div>
            )
          })}

          {/* 卡片独立图层（世界坐标，不嵌在章框里 —— 章框是顺序的投影，卡片可以拖到它外面） */}
          {liveChapters.map((shape) => {
            if (closedIds.has(shape.id)) return null
            return shape.units.map((u) => {
              const meta = metaById.get(u.id)
              const st = progress[u.id]?.status ?? 'todo'
              const mastery = progress[u.id]?.mastery ?? 0
              const lessonN = Object.values(lessons ?? {}).filter((l) => l.unitId === u.id).length
              const cnt = scopeCounts?.[u.id]
              const art = progress[u.id]?.summaryRel ? 1 : 0
              const ago = agoLabel(progress[u.id]?.lastCheckedAt)
              const on = selUnitId === u.id
              const color = STATUS_COLOR[st] ?? 'var(--text-muted)'
              const dragging = dragUnit?.id === u.id
              const label = st === 'learning' ? '继续学' : st === 'mastered' ? '复习' : '开始学'
              return (
                <div key={u.id} data-unit={u.id}
                  onPointerDown={(e) => onNodeDown(e, u.id)}
                  onClick={(e) => { e.stopPropagation(); if (Date.now() < guardRef.current) return; selectScope({ level: 'unit', unitId: u.id, chapterId: shape.id }) }}
                  title={meta?.goal || meta?.name}
                  className={`absolute left-0 top-0 rounded-[10px] border cursor-pointer kb-flow-node ${on ? 'kb-on' : ''} ${dragging ? 'kb-dragging' : ''} ${editMode ? 'kb-drag-on' : 'kb-locked'}`}
                  style={{
                    transform: `translate(${u.x}px,${u.y}px)`, width: NODE_W, height: NODE_H,
                    background: `color-mix(in srgb, ${color} 11%, var(--card-bg))`,
                    borderColor: on ? 'var(--accent)' : `color-mix(in srgb, ${color} 34%, transparent)`,
                  }}>
                  <span className="absolute left-0 top-[9px] bottom-[9px] w-[3px] rounded" style={{ background: color }} />
                  <div className="flex items-start gap-1.5">
                    <span className="text-[12.5px] font-semibold leading-[1.35] flex-1 min-w-0 truncate text-[var(--text-primary)]">{meta?.name ?? u.id}</span>
                    <span className="shrink-0 text-[10.5px] px-1.5 py-px rounded-[9px] border whitespace-nowrap" style={{ color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }}>
                      {st === 'learning' && <i className="kb-flow-pulse inline-block w-[5px] h-[5px] rounded-full mr-1 align-[1px]" style={{ background: 'var(--accent)' }} />}
                      {FLOW_ST_LABEL[st] ?? st}
                    </span>
                  </div>
                  <div className="my-1 h-[3px] rounded bg-[var(--bg-tertiary)] overflow-hidden">
                    <i className="block h-full kb-flow-bar" style={{ width: `${Math.round(mastery * 100)}%`, background: color }} />
                  </div>
                  <div data-cardmeta className="text-[11px] text-[var(--text-muted)] whitespace-nowrap overflow-hidden text-ellipsis">
                    要求 {cnt?.req ?? 0} · 素材 {cnt?.src ?? 0} · 产物 {art}
                  </div>
                  <div data-cardmeta2 className="mt-0.5 text-[10.5px] text-[var(--text-muted)] whitespace-nowrap overflow-hidden text-ellipsis">
                    {lessonN ? `${lessonN} 课时` : '待开课'}{ago ? ` · 最近 ${ago}` : ''}
                  </div>
                  <div data-cardact className="mt-[5px] flex items-center gap-1.5">
                    <button data-no-drag onClick={(e) => { e.stopPropagation(); onStartUnit(u.id) }}
                      className="px-2 py-0.5 rounded-md bg-[var(--accent)] text-white text-[11px] hover:opacity-90 kb-press whitespace-nowrap">
                      {label}
                    </button>
                  </div>
                </div>
              )
            })
          })}

          {/* 插入位指示条（松手前看得见落在第几位） */}
          {barRect && dragUnit && (
            <div data-dropbar className="absolute left-0 top-0 w-[3px] rounded-[3px] kb-flow-dropbar pointer-events-none"
              style={{ transform: `translate(${barRect.x}px,${barRect.y}px)`, height: barRect.h }} />
          )}
        </div>

        {/* 布局锁提示（右上）：锁定态说清「为什么拖不动、去哪解锁」 */}
        <div data-no-drag data-lockhint className={`absolute right-3 top-3 z-[7] flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[11px] kb-flow-lockhint ${editMode ? 'on' : ''}`}>
          {editMode ? <><PencilLine size={11} />编辑布局中：拖卡片 = 改推进顺序（写课程.md）· Alt 拖动可脱离 20 网格</> : <><Lock size={11} />布局已锁定 · 点右上「编辑布局」才能拖</>}
        </div>

        {/* 锁定态点卡片的行内提示（一键进编辑布局） */}
        {lockBubble && (
          <div data-no-drag data-lockbubble className="absolute z-[22] w-[292px] px-2.5 py-2 rounded-[10px] border bg-[var(--bg-secondary)] shadow-lg kb-flow-lockbubble"
            style={{ left: lockBubble.left, top: lockBubble.top }}>
            <div className="text-[11.5px] leading-relaxed text-[var(--text-secondary)]">布局已锁定 —— 学习面上不让你误拖改大纲。</div>
            <button onClick={() => { setEditMode(true); setLockBubble(null) }}
              className="mt-1.5 px-2 py-0.5 rounded-md bg-[var(--accent)] text-white text-[11.5px] hover:opacity-90 kb-press">进「编辑布局」再拖</button>
          </div>
        )}

        {/* 缩放控件 */}
        <div data-no-drag className="absolute left-3.5 bottom-3.5 flex flex-col gap-0.5 p-1 rounded-[9px] bg-[var(--bg-secondary)] border border-[var(--border-color)] shadow-lg z-[6]">
          <ZBtn title="放大 ( + )" act={() => zoomBy(1.2)}><Plus size={14} /></ZBtn>
          <ZBtn title="缩小 ( − )" act={() => zoomBy(1 / 1.2)}><Minus size={14} /></ZBtn>
          <ZBtn title="适应视图 ( 0 )" act={fit}><Maximize2 size={13} /></ZBtn>
        </div>

        {/* 缩略图：掌握度热力（透明度随 mastery） */}
        <div data-no-drag ref={mmBoxRef} className="absolute right-3.5 bottom-3.5 w-[172px] h-[114px] rounded-[9px] bg-[var(--bg-secondary)] border border-[var(--border-color)] shadow-lg overflow-hidden z-[6]">
          <div className="absolute inset-1.5">
            {liveChapters.map((c) => closedIds.has(c.id) ? null : c.units.map((u) => {
              const [x, y] = mmMap(u.x, u.y)
              const st = progress[u.id]?.status ?? 'todo'
              const color = STATUS_COLOR[st] ?? 'var(--text-muted)'
              const mastery = progress[u.id]?.mastery ?? 0
              return <div key={u.id} data-mm={u.id} className="absolute rounded-[2px]"
                style={{ left: x, top: y, width: Math.max(3, NODE_W * mm.s), height: Math.max(2, NODE_H * mm.s), background: color, opacity: 0.25 + mastery * 0.7 }} />
            }))}
            <div className="absolute border border-[var(--accent)] rounded-[3px] bg-[var(--accent)]/10"
              style={{ left: vx, top: vy, width: Math.max(8, (canvasSize.w / v.k) * mm.s), height: Math.max(8, (canvasSize.h / v.k) * mm.s) }} />
          </div>
        </div>

        {/* 浮动动作条：接着上次那节课（§20） */}
        <div data-no-drag className="absolute left-1/2 -translate-x-1/2 bottom-4 flex items-center gap-1.5 p-1.5 rounded-[11px] bg-[var(--bg-secondary)] border border-[var(--border-color)] shadow-lg z-[6]">
          <button disabled={!nextMeta} onClick={() => nextMeta && onStartUnit(nextMeta.id)}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-[var(--accent)] text-white text-[11.5px] hover:opacity-90 disabled:opacity-40 kb-press whitespace-nowrap">
            <Play size={12} />{nextMeta ? `继续学 ${nextMeta.id} ${nextMeta.name.slice(0, 8)}` : '全部学完'}
          </button>
          {selUnitId && finishEligible && (
            <button onClick={() => onFinishQuiz(selUnitId)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[var(--success)]/40 text-[var(--success)] text-[11.5px] hover:bg-[var(--success)]/10 kb-press whitespace-nowrap">
              <Check size={12} />结束本知识点
            </button>
          )}
          <span className="px-1.5 text-[11px] text-[var(--text-muted)] whitespace-nowrap">在学 {stats.d} · 掌握度 {stats.pct}% · {zoomPct}%</span>
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
