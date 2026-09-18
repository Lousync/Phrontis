import { useState, useEffect, useRef, useCallback } from 'react'
import { getSettingRaw, setSettingRaw } from '../../lib/ipc'

/** 拖拽防抖阈值（px）：位移不足此值视作「点击 / 掠过手柄」，不进入拖拽态（同 ResizablePanel） */
const DRAG_DEAD_ZONE_PX = 4
/** 手柄命中热区宽度（px），内贴边界不外探（避免与调用方 border 形成双线） */
const HANDLE_HIT_WIDTH_PX = 5

interface Props {
  /** 当前副栏宽度（px，由 App 持有 —— 模块容器的宽度也在用同一份值） */
  width: number
  minWidth: number
  maxWidth: number
  /** 宽度持久化键 */
  storageKey: string
  /** 宽度变化上报（拖拽中每帧、以及加载持久化值时） */
  onWidthChange: (w: number) => void
  /** 向左拖过半程 → 关闭分屏（VS Code snap-close 语义） */
  onSnapClose: () => void
}

/**
 * 分屏手柄（2026-09-18 第十二轮 · 跨栏保活重构的配套件）。
 *
 * 为什么不再用 `ResizablePanel`：那个组件的结构是「面板容器（宽度=自己持有）> children」，
 * 而跨栏保活要求**模块容器不能是它的子孙**（换栏会跨父节点 → 卸载重建）。
 * 但它的拖拽实现踩过很多坑（pointer capture、四路收尾、body 污染、dead-zone），
 * 所以这里把那份语义**原样搬过来**，只把「宽度归属」改成 App 持有（onWidthChange 上报）。
 *
 * 硬约束（照抄 ResizablePanel 的教训，不要"简化"）：
 *   · pointer capture + 四路收尾（pointerup / pointercancel / lostpointercapture / 卸载兜底）
 *     —— 指针进入工件 iframe 会断流，missing 收尾会让 body 的 cursor / user-select 永久污染；
 *   · 首次越过 dead-zone 才置 dragging / 禁选中 / 换光标（误触零副作用）；
 *   · 拖拽期挂全屏遮罩（第二层保险，把指针留在父文档内）；
 *   · 双击复位到默认宽度。
 */
export function SplitHandle({ width, minWidth, maxWidth, storageKey, onWidthChange, onSnapClose }: Props) {
  const [dragging, setDragging] = useState(false)
  const [fallbackDrag, setFallbackDrag] = useState(false)
  const widthRef = useRef(width)
  widthRef.current = width

  /** 拖拽会话（null = 未按下）。移动与收尾都要读它，故用 ref */
  const dragRef = useRef<{ startX: number; startW: number; moved: boolean; snapped: boolean } | null>(null)

  const onSnapCloseRef = useRef(onSnapClose)
  onSnapCloseRef.current = onSnapClose
  const onWidthChangeRef = useRef(onWidthChange)
  onWidthChangeRef.current = onWidthChange

  // 加载持久化宽度（仅首次）：读到的值直接上报给 App（宽度真相源在 App）
  useEffect(() => {
    let alive = true
    void getSettingRaw(storageKey).then((v) => {
      if (!alive) return
      if (typeof v === 'number') onWidthChangeRef.current(Math.max(minWidth, Math.min(maxWidth, v)))
    })
    return () => { alive = false }
  }, [storageKey, minWidth, maxWidth])

  /** 拖拽收尾 —— 四路兜底共用这一份（清 body 污染这一步不允许缺席） */
  const endDrag = useCallback((persist = true) => {
    const d = dragRef.current
    dragRef.current = null
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    setDragging(false)
    setFallbackDrag(false)
    if (!d) return
    // 只有「真拖过且没被 snap 掉」才落盘
    if (persist && d.moved && !d.snapped) void setSettingRaw(storageKey, widthRef.current)
  }, [storageKey])

  /** 拖拽主体：向左拖 = 副栏变宽 */
  const applyDrag = useCallback((clientX: number) => {
    const d = dragRef.current
    if (!d || d.snapped) return
    const delta = d.startX - clientX
    if (!d.moved) {
      if (Math.abs(delta) < DRAG_DEAD_ZONE_PX) return
      d.moved = true
      setDragging(true)
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
    }
    const raw = d.startW + delta
    // snap-close：拖过最小宽度的一半 → 收合
    if (raw < minWidth * 0.5) {
      d.snapped = true
      onSnapCloseRef.current()
      endDrag(false)
      return
    }
    const next = Math.max(minWidth, Math.min(maxWidth, raw))
    widthRef.current = next
    onWidthChangeRef.current(next)
  }, [endDrag, minWidth, maxWidth])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = { startX: e.clientX, startW: widthRef.current, moved: false, snapped: false }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
      setFallbackDrag(false)
    } catch {
      setFallbackDrag(true)
    }
  }, [])

  // 退路：无 pointer capture 的环境从 window 收事件
  useEffect(() => {
    if (!fallbackDrag) return
    const onMove = (e: PointerEvent) => applyDrag(e.clientX)
    const onUp = () => endDrag()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [fallbackDrag, applyDrag, endDrag])

  // 卸载兜底：拖拽中组件被卸载 → 必须摘掉 body 污染
  useEffect(() => () => {
    if (!dragRef.current) return
    dragRef.current = null
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }, [])

  const onDoubleClick = useCallback(() => {
    const next = Math.max(minWidth, Math.min(maxWidth, 380))
    widthRef.current = next
    onWidthChangeRef.current(next)
    void setSettingRaw(storageKey, next)
  }, [minWidth, maxWidth, storageKey])

  return (
    <div
      data-wb="splitHandle"
      className="absolute inset-y-0 z-30 group"
      style={{ right: width - HANDLE_HIT_WIDTH_PX, width: HANDLE_HIT_WIDTH_PX, cursor: 'col-resize' }}
      role="separator"
      aria-orientation="vertical"
      title="拖拽调整宽度，双击复位"
      onPointerDown={onPointerDown}
      onPointerMove={(e) => applyDrag(e.clientX)}
      onPointerUp={() => endDrag()}
      onPointerCancel={() => endDrag()}
      onLostPointerCapture={() => endDrag()}
      onDoubleClick={onDoubleClick}
    >
      <div
        className={`absolute inset-y-0 w-px transition-colors ${
          dragging ? 'bg-[var(--accent)]' : 'bg-[var(--border-color)] group-hover:bg-[var(--accent)]/40'
        }`}
        style={{ left: 0 }}
      />
    </div>
  )
}
