/**
 * 右侧查看器 · 宽度会话（拖拽 / 持久化 / 视口重算）
 *
 * 方案：`/home/lousync/Projects/DesginProcess/Phrontis/已实现设计文档/ai-teaching-right-viewer-plan.md` §3.3（360–960、innerWidth-300、4px dead-zone、
 * 双击回 480）与 §5.1 / §5.3（`aiTeachRightViewerWidth` 走 SETTINGS）。
 * 2026-11-23：上限改成 `innerWidth - reserve`，`reserve = 中栏左缘 + 420`（由调用方实测传入），
 * 窗口过窄时查看器降到紧凑下限 300（不再把中栏压到一行 4 个字）。
 * 拖拽口径对齐 `src/components/shared/ResizablePanel.tsx`：pointerdown + capture、
 * 越过 dead-zone 才进拖拽态、**四路收尾**（pointerup / pointercancel / lostpointercapture / 卸载）。
 *
 * 为什么从 RightViewer 里拆出来：宽度会话与页签 / 渲染没有耦合，
 * 以后书架要单独开个可调宽抽屉时可以直接复用；也让「body 污染」这类收尾逻辑只有一个出处。
 */

import {
  useCallback, useEffect, useRef, useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { getSettingRaw, setSettingRaw } from '../../../lib/ipc'
import { VIEWER_DEFAULT_WIDTH, VIEWER_MAX_WIDTH, VIEWER_MIN_WIDTH, clampViewerWidth } from './rightViewerPure'

/** SETTINGS 键（`src/lib/settings.ts` 已注册，默认 480、范围 360–960） */
export const VIEWER_WIDTH_SETTING_KEY = 'aiTeachRightViewerWidth'

/** 位移不足 4px 视作「掠过手柄」，不进入拖拽态、也不落盘（同 ResizablePanel 口径） */
const DRAG_DEAD_ZONE_PX = 4

/** 写盘防抖：拖拽期间每帧都会变宽，松手写一次即可；其余的中间值由这个窗口合并 */
const PERSIST_DEBOUNCE_MS = 300

const BODY_SELECT_CLASS = 'select-none'

export interface UseViewerWidthOptions {
  open: boolean
  min?: number
  max?: number
  defaultWidth?: number
  /**
   * `reserve = 中栏左缘 + VIEWER_MIN_MIDDLE_WIDTH`（调用方实测后传入）。
   * 缺省 = 旧口径 `innerWidth - VIEWER_RESERVED_WIDTH(300)`，行为与改造前一致。
   */
  reserve?: number
}

export interface UseViewerWidthResult {
  width: number
  setWidth: (n: number) => void
  dragging: boolean
  beginDrag: (e: ReactPointerEvent) => void
  reset: () => void
}

export function useViewerWidth(opts: UseViewerWidthOptions): UseViewerWidthResult {
  const min = opts.min ?? VIEWER_MIN_WIDTH
  const max = opts.max ?? VIEWER_MAX_WIDTH
  const defaultWidth = opts.defaultWidth ?? VIEWER_DEFAULT_WIDTH

  // 首帧用「默认宽 + 当前视口」：持久值走异步 IPC，等它回来会闪一下，
  // 而默认宽本来就在合法区间内，先画出来再夹紧最稳。
  const [width, setWidthState] = useState(() =>
    clampViewerWidth(defaultWidth, window.innerWidth, opts.reserve, min, max))
  const [dragging, setDragging] = useState(false)

  const widthRef = useRef(width)
  const draggingRef = useRef(false)
  const dragRef = useRef<{ startX: number; startW: number; moved: boolean } | null>(null)
  const detachRef = useRef<(() => void) | null>(null)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 持久值是否已读回：读回之前绝不写盘，否则会用默认宽覆盖用户存的值 */
  const loadedRef = useRef(false)
  const aliveRef = useRef(true)
  /** body 是否被我们污染过（拖拽期的 select-none / col-resize） */
  const bodyDirtyRef = useRef(false)

  // 约束与默认宽随 props 变（调用方一般是常量，用 ref 是为了不让回调依赖抖动）
  const boundsRef = useRef({ min, max })
  boundsRef.current = { min, max }
  const defaultRef = useRef(defaultWidth)
  defaultRef.current = defaultWidth
  /** 中栏 reserve（左缘 + 最小可读宽）：每次夹紧都读「此刻」的值，避免闭包拿旧 reserve */
  const reserveRef = useRef(opts.reserve)
  reserveRef.current = opts.reserve

  /** 清掉 body 污染 —— 收尾路径**必须**都走到这里，否则整窗永久不能选中文本 */
  const clearBody = useCallback(() => {
    if (!bodyDirtyRef.current) return
    bodyDirtyRef.current = false
    document.body.classList.remove(BODY_SELECT_CLASS)
    document.body.style.cursor = ''
  }, [])

  const detachWindowListeners = useCallback(() => {
    detachRef.current?.()
    detachRef.current = null
  }, [])

  const applyWidth = useCallback((next: number): number => {
    const b = boundsRef.current
    const clamped = clampViewerWidth(next, window.innerWidth, reserveRef.current, b.min, b.max)
    widthRef.current = clamped
    setWidthState(clamped)
    return clamped
  }, [])

  const flushPersist = useCallback(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
    }
    if (!aliveRef.current || !loadedRef.current) return
    // setSetting 失败（键未注册 / 主进程拒绝）不打扰用户：宽度下次仍按默认值走
    void setSettingRaw(VIEWER_WIDTH_SETTING_KEY, widthRef.current).catch(() => {})
  }, [])

  const schedulePersist = useCallback(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null
      flushPersist()
    }, PERSIST_DEBOUNCE_MS)
  }, [flushPersist])

  const setWidth = useCallback((n: number) => {
    loadedRef.current = true // 用户主动改宽即视为「已就绪」，不因读到旧值而被回滚
    applyWidth(n)
    schedulePersist()
  }, [applyWidth, schedulePersist])

  const reset = useCallback(() => {
    loadedRef.current = true
    applyWidth(defaultRef.current)
    flushPersist()
  }, [applyWidth, flushPersist])

  /**
   * 拖拽收尾（四路共用、必须幂等）：
   * pointerup / pointercancel / lostpointercapture / 卸载。
   * 只有真越过 dead-zone 才落盘 —— 掠过手柄不再产生一次无意义的写盘。
   */
  const endDrag = useCallback(() => {
    const session = dragRef.current
    dragRef.current = null
    detachWindowListeners()
    clearBody()
    draggingRef.current = false
    setDragging(false)
    if (!session || !session.moved) return
    loadedRef.current = true
    flushPersist()
  }, [clearBody, detachWindowListeners, flushPersist])

  const applyMove = useCallback((clientX: number) => {
    const session = dragRef.current
    if (!session) return
    // 手柄在面板**左缘**：指针左移（clientX 变小）= 变宽，方向取反
    const delta = session.startX - clientX
    if (!session.moved) {
      if (Math.abs(delta) < DRAG_DEAD_ZONE_PX) return
      session.moved = true
      draggingRef.current = true
      setDragging(true)
      bodyDirtyRef.current = true
      document.body.classList.add(BODY_SELECT_CLASS)
      document.body.style.cursor = 'col-resize'
    }
    applyWidth(session.startW + delta)
  }, [applyWidth])

  const beginDrag = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = { startX: e.clientX, startW: widthRef.current, moved: false }

    // 指针捕获：指针滑到原生网页视图 / 阅读器 iframe 之上时，事件仍派发回本元素
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 不支持 capture 的环境靠下面的 window 监听兜底 */
    }

    // window 侧监听与 capture **同时挂**：capture 期间事件仍会冒泡到 window，
    // 两条路都调同一个 applyMove / endDrag，靠 dragRef 空判保证幂等。
    detachWindowListeners()
    const onMove = (ev: PointerEvent) => applyMove(ev.clientX)
    const onEnd = () => endDrag()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    // lostpointercapture 会冒泡：捕获被系统收回（切窗 / 触摸被接管）时也必须收尾
    window.addEventListener('lostpointercapture', onEnd)
    detachRef.current = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
      window.removeEventListener('lostpointercapture', onEnd)
    }
  }, [applyMove, detachWindowListeners, endDrag])

  // 读回持久宽度（异步；读不到 / 坏值就保持默认，不弹 Toast）
  useEffect(() => {
    let cancelled = false
    void getSettingRaw(VIEWER_WIDTH_SETTING_KEY)
      .then((v) => {
        if (cancelled) return
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
          loadedRef.current = true
          applyWidth(v)
        }
        loadedRef.current = true
      })
      .catch(() => {
        if (!cancelled) loadedRef.current = true
      })
    return () => { cancelled = true }
  }, [applyWidth])

  // 窗口变化：上限跟着 `innerWidth - reserve` 走，超限时收窄并落盘（缩放窗口不该丢宽度记忆）
  useEffect(() => {
    const onResize = () => {
      const b = boundsRef.current
      const next = clampViewerWidth(widthRef.current, window.innerWidth, reserveRef.current, b.min, b.max)
      if (next === widthRef.current) return
      applyWidth(next)
      schedulePersist()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [applyWidth, schedulePersist])

  /**
   * 中栏 reserve 变化（左栏拖宽 / 折叠 / 窗口缩放导致中栏左缘移动）→ 重夹一次。
   * 只收不放：reserve 变小时不主动把查看器撑宽（用户的宽度记忆优先，拖宽是他自己的事）。
   */
  useEffect(() => {
    const b = boundsRef.current
    const next = clampViewerWidth(widthRef.current, window.innerWidth, opts.reserve, b.min, b.max)
    if (next === widthRef.current) return
    applyWidth(next)
    schedulePersist()
  }, [opts.reserve, applyWidth, schedulePersist])

  // 面板关掉时若还在拖（快捷键 / 外部关闭），立刻收尾，别把 select-none 留在 body 上
  useEffect(() => {
    if (!opts.open && dragRef.current) endDrag()
  }, [opts.open, endDrag])

  // 卸载兜底：拖拽中组件被卸载 → 必须摘掉监听与 body 污染（这条不允许缺席）
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current)
        persistTimerRef.current = null
      }
      dragRef.current = null
      draggingRef.current = false
      detachWindowListeners()
      clearBody()
    }
  }, [clearBody, detachWindowListeners])

  return { width, setWidth, dragging, beginDrag, reset }
}
