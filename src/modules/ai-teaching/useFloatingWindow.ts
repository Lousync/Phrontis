import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * 支线旁问浮窗力学（v3.1.2 补强，2026-09-14 志岩拍板）。
 *
 * 需求：浮窗要能**在模块内自由拖动**、**拖边缘改尺寸**、**拖近右缘自动停靠成宽轨**（与既有宽轨
 * 统一为「同一个窗口的两态」）、**位置尺寸全局记忆**、**双击标题栏复位**。
 *
 * 为什么单独抽成 hook：`index.tsx` 已 3200+ 行，而 pointer 力学（死区 / 边界钳制 / 拖完补发 click
 * 的兜底窗口）与业务无关，抽出后可单点修改；将来别的浮窗也能直接复用。
 *
 * 关键约定（对齐 AGENTS.md 铁律 9 / 13）：
 * - **一律 pointer events**（HTML5 拖放在 Electron 里会静默失败）；
 * - **window 级 + 捕获阶段监听**：指针移出外壳甚至移出窗口都不会丢帧（原型 CDP 实测这套最稳）；
 * - **跟手过程不写 transition**（只有停靠提示走 `.kb-dock-hint` 进场动画）；
 * - 手势结束浏览器会补发一次 `click`，故记 `guardRef` 250ms 窗口，双击复位在窗口期内忽略
 *   ——否则「拖完松手」会被当成双击、窗口当场弹回默认位；
 * - 顶栏拖拽自动豁免 `button / a / input / textarea / select / [data-no-drag]`，
 *   浮窗里的轮数按钮、⤢、✕ 照常可点。
 *
 * 舞台（stageRef 指向的元素）必须 `position: relative`：返回值里的 `style` 是**舞台局部坐标**
 * （left/top），直接挂到外壳上即可。
 */

export interface FloatRect { x: number; y: number; w: number; h: number }
export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** 手势结束后浏览器补发 click 的兜底窗口（与日程 dragGuard 同口径） */
const DRAG_GUARD_MS = 250
/** 边缘热区厚度 px */
const EDGE = 5
/** 角部热区边长 px（与边缘热区同层，角部优先命中） */
const CORNER = 14
/** 距舞台右缘 ≤ 此值即判定「要停靠」，松手切宽轨。
 *  取 4px（而非二三十）是有意的：默认位就在右缘内 12px 处，阈值一大则**开门即处于停靠区**，
 *  轻轻一拖就被吸走、手感像「窗口自己跑了」。取 4px 后语义变为「把窗口推到最右缘推不动了」——
 *  钳制逻辑保证继续向右拖时 x 会饱和在 sw-w（gap=0），所以「推到底」必然命中，且不误触发。 */
const DOCK_PX = 4
/** 位移死区：触摸板「轻敲」与手动微抖不算拖拽 */
const DEAD_ZONE = 3
/** 命中即不启动拖拽（顶栏里的交互控件） */
const INTERACTIVE = 'button, a, input, textarea, select, [data-no-drag]'

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

const RESIZE_CURSOR: Record<ResizeDir, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
}

/**
 * 八个缩放热区。内贴在外壳内缘（不外探），故外壳的 `overflow-hidden` 不会裁掉它们。
 * 与外壳内容的关系：内容 `px-3` / 标题栏 `h-9` + 居中按钮、输入区 `p-2.5`，
 * 5px 热区全部落在留白里，不挡可点区域。
 */
const HANDLES: { dir: ResizeDir; style: React.CSSProperties }[] = [
  { dir: 'n', style: { top: 0, left: CORNER, right: CORNER, height: EDGE, cursor: 'ns-resize' } },
  { dir: 's', style: { bottom: 0, left: CORNER, right: CORNER, height: EDGE, cursor: 'ns-resize' } },
  { dir: 'w', style: { left: 0, top: CORNER, bottom: CORNER, width: EDGE, cursor: 'ew-resize' } },
  { dir: 'e', style: { right: 0, top: CORNER, bottom: CORNER, width: EDGE, cursor: 'ew-resize' } },
  { dir: 'nw', style: { top: 0, left: 0, width: CORNER, height: CORNER, cursor: 'nwse-resize' } },
  { dir: 'ne', style: { top: 0, right: 0, width: CORNER, height: CORNER, cursor: 'nesw-resize' } },
  { dir: 'sw', style: { bottom: 0, left: 0, width: CORNER, height: CORNER, cursor: 'nesw-resize' } },
  { dir: 'se', style: { bottom: 0, right: 0, width: CORNER, height: CORNER, cursor: 'nwse-resize' } },
]

interface Options {
  /** localStorage 键。**全局**记忆（不随工作区/会话变），缺省值见调用方 */
  storageKey: string
  /** 舞台：拖拽范围 = 该元素的 content box；必须 `position: relative` */
  stageRef: React.RefObject<HTMLElement | null>
  /** 是否接管交互。浮层形态才 true；停靠 / 关闭时 false，所有手势 no-op */
  enabled: boolean
  defaultW: number
  defaultH: number
  minW: number
  minH: number
  /** 默认位的高度上限比例（× 舞台高）。只作用于「默认位」，不影响记忆值 */
  maxHRatio?: number
  /** 距右缘 DOCK_PX 内松手 → 停靠（调用方切宽轨） */
  onDock?: () => void
}

export interface FloatingWindow {
  /** 外壳内联定位（舞台局部坐标）。未测量时为 undefined —— 调用方据 `ready` 决定是否渲染 */
  style: React.CSSProperties | undefined
  ready: boolean
  /** 正在拖动/缩放（跟手过程中为 true；外壳可据此确认「不做过渡」） */
  active: boolean
  /** 已拖到右缘待停靠区（松手即切宽轨）——调用方据此渲染落位提示 */
  dockHint: boolean
  /** 八个缩放热区，调用方渲染为 `absolute` div 并挂 `onPointerDown` */
  handles: { dir: ResizeDir; style: React.CSSProperties }[]
  /** 挂到顶栏（成为拖拽手柄）。顶栏内按钮会因 INTERACTIVE 命中而被豁免 */
  onTitlePointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  /** 挂到顶栏：双击复位到右上角默认位（拖拽收尾 250ms 内忽略） */
  onTitleDoubleClick: (e: React.MouseEvent<HTMLDivElement>) => void
  onHandlePointerDown: (e: React.PointerEvent<HTMLDivElement>, dir: ResizeDir) => void
}

export function useFloatingWindow({ storageKey, stageRef, enabled, defaultW, defaultH, minW, minH, maxHRatio = 0.74, onDock }: Options): FloatingWindow {
  const [rect, setRect] = useState<FloatRect | null>(null)
  const [active, setActive] = useState(false)
  const [dockHint, setDockHint] = useState(false)
  /** 位置尺寸的 ref 镜像：pointermove 高频回调里读它，避免闭包捕获旧值 */
  const rectRef = useRef<FloatRect | null>(null)
  /** 手势收尾时刻：250ms 内的双击复位一律忽略（浏览器在 pointerup 后会补发 click） */
  const guardRef = useRef(0)
  const onDockRef = useRef(onDock)
  onDockRef.current = onDock

  /** 把任意 rect 钳进舞台（窗口缩放 / 恢复记忆值 / 拖到边界 都走这一处） */
  const fit = useCallback((r: FloatRect, sw: number, sh: number): FloatRect => {
    const w = clamp(r.w, minW, Math.max(minW, sw))
    const h = clamp(r.h, minH, Math.max(minH, sh))
    return { w, h, x: clamp(r.x, 0, Math.max(0, sw - w)), y: clamp(r.y, 0, Math.max(0, sh - h)) }
  }, [minW, minH])

  const stageBox = useCallback((): { w: number; h: number } | null => {
    const el = stageRef.current
    return el && el.clientWidth > 0 ? { w: el.clientWidth, h: el.clientHeight } : null
  }, [stageRef])

  /** 默认位 = 贴右上角（沿用原浮层位置），高度按舞台比例限高，小窗下不会顶出舞台 */
  const defaultRect = useCallback((sw: number, sh: number): FloatRect => {
    const h = clamp(defaultH, minH, Math.max(minH, Math.min(sh, sh * maxHRatio)))
    return fit({ x: sw - defaultW - 12, y: 12, w: defaultW, h }, sw, sh)
  }, [defaultW, defaultH, minH, maxHRatio, fit])

  const persist = useCallback((): void => {
    try {
      if (rectRef.current) localStorage.setItem(storageKey, JSON.stringify(rectRef.current))
    } catch { /* 隐私模式 / 配额满：静默降级为「不记忆」，不影响交互 */ }
  }, [storageKey])

  /** 按当前舞台重钳一次（只在真的越界时才 setState，避免每帧多一次渲染） */
  const applyFit = useCallback((sw: number, sh: number): void => {
    const cur = rectRef.current
    if (!cur) return
    const next = fit(cur, sw, sh)
    if (next.x !== cur.x || next.y !== cur.y || next.w !== cur.w || next.h !== cur.h) {
      rectRef.current = next
      setRect(next)
    }
  }, [fit])

  // ---- 初始化 + 舞台尺寸联动 ----
  // 只在 enabled 时初始化：舞台（三栏工作区行）只在「已进工作区」时存在，而本模块首屏是选择页；
  // 等到浮窗真要挂载那一刻再量舞台，时序上必然有效。
  useLayoutEffect(() => {
    if (!enabled) return
    const box = stageBox()
    if (!box) return

    if (!rectRef.current) {
      let saved: FloatRect | null = null
      try {
        const raw = localStorage.getItem(storageKey)
        const p = raw ? (JSON.parse(raw) as Partial<FloatRect>) : null
        if (p && [p.x, p.y, p.w, p.h].every(n => typeof n === 'number' && Number.isFinite(n))) saved = p as FloatRect
      } catch { /* 脏数据：退回默认位 */ }
      const next = fit(saved ?? defaultRect(box.w, box.h), box.w, box.h)
      rectRef.current = next
      setRect(next)
    } else {
      // 每次重新启用都重钳一次：浮窗关闭期间用户可能改过主窗口尺寸，
      // 记忆坐标会落到舞台外 → 表象是「浮窗跑到可视区外，像丢了」
      applyFit(box.w, box.h)
    }

    const el = stageRef.current
    if (!el) return
    // 舞台变小（收窄窗口 / 展开工件栏）→ 把窗口拉回可视区
    const ro = new ResizeObserver(() => {
      const b = stageBox()
      if (b) applyFit(b.w, b.h)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [enabled, storageKey, stageRef, fit, defaultRect, stageBox, applyFit])

  // 停靠 / 关闭时清掉手势态——浮窗随时会重新挂载（取消停靠），不能带着上一轮的 dragging / 提示
  useEffect(() => {
    if (enabled) return
    setActive(false)
    setDockHint(false)
  }, [enabled])

  /** 拖拽/缩放共用一个手势循环：`kind='move'` 走位移，其余走八向改尺寸 */
  const begin = (e: React.PointerEvent<HTMLElement>, kind: 'move' | ResizeDir): void => {
    if (!enabled) return
    if (kind === 'move' && (e.target as HTMLElement).closest(INTERACTIVE)) return
    const el = stageRef.current
    const start = rectRef.current
    if (!el || !start) return
    e.preventDefault()
    e.stopPropagation()

    const sw = el.clientWidth
    const sh = el.clientHeight
    const px = e.clientX
    const py = e.clientY
    const base: FloatRect = { ...start }
    let moved = false
    let hint = false

    const onMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - px
      const dy = ev.clientY - py
      if (!moved) {
        if (Math.abs(dx) + Math.abs(dy) < DEAD_ZONE) return
        moved = true
        setActive(true)
        document.body.style.userSelect = 'none'
        document.body.style.cursor = kind === 'move' ? 'grabbing' : RESIZE_CURSOR[kind]
      }
      if (kind === 'move') {
        const x = clamp(base.x + dx, 0, Math.max(0, sw - base.w))
        const y = clamp(base.y + dy, 0, Math.max(0, sh - base.h))
        const next: FloatRect = { ...base, x, y }
        rectRef.current = next
        setRect(next)
        const near = sw - (x + base.w) <= DOCK_PX
        if (near !== hint) { hint = near; setDockHint(near) }
        return
      }
      let { x, y, w, h } = base
      if (kind.includes('e')) w = clamp(base.w + dx, minW, Math.max(minW, sw - base.x))
      if (kind.includes('s')) h = clamp(base.h + dy, minH, Math.max(minH, sh - base.y))
      if (kind.includes('w')) { const nx = clamp(base.x + dx, 0, base.x + base.w - minW); x = nx; w = base.x + base.w - nx }
      if (kind.includes('n')) { const ny = clamp(base.y + dy, 0, base.y + base.h - minH); y = ny; h = base.y + base.h - ny }
      const next: FloatRect = { x, y, w, h }
      rectRef.current = next
      setRect(next)
    }

    const onEnd = (): void => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onEnd, true)
      window.removeEventListener('pointercancel', onEnd, true)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      setActive(false)
      guardRef.current = Date.now()
      if (moved) persist()
      if (hint) { hint = false; setDockHint(false); onDockRef.current?.() }
    }

    // 捕获阶段 + window 级：指针移出外壳 / 移出舞台都不丢帧
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onEnd, true)
    window.addEventListener('pointercancel', onEnd, true)
  }

  const onTitlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => begin(e, 'move')
  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>, dir: ResizeDir): void => begin(e, dir)
  const onTitleDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (Date.now() - guardRef.current < DRAG_GUARD_MS) return
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return
    const box = stageBox()
    if (!box) return
    const next = defaultRect(box.w, box.h)
    rectRef.current = next
    setRect(next)
    persist()
  }

  return {
    style: rect ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h } : undefined,
    ready: rect !== null,
    active,
    dockHint,
    handles: HANDLES,
    onTitlePointerDown,
    onTitleDoubleClick,
    onHandlePointerDown,
  }
}
