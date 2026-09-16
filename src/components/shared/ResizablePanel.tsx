import { useState, useEffect, useRef, useCallback } from 'react'
import { getSettingRaw, setSettingRaw, resizeForSidebar } from '../../lib/ipc'

/**
 * 拖拽防抖阈值（px）：位移不足此值视作「点击 / 掠过手柄」，不进入拖拽态。
 *
 * v3.2.0 条目 ⑤ 修复：原实现是 `mousedown` 立刻 `setDragging(true)`、`mouseup` 无条件写盘，
 * 于是「鼠标掠过手柄」都会改宽度并落盘一次。dead-zone 治的就是这一类误触发。
 */
const DRAG_DEAD_ZONE_PX = 4

/**
 * 手柄命中热区宽度（px）。原实现是 2px（`w-0.5`）——命中区过窄，难抓。
 * 热区**内贴**在面板边缘：不外探，避免与调用方的 border-l / border-r 形成双线（原实现留下的教训）。
 */
const HANDLE_HIT_WIDTH_PX = 5

interface Props {
  storageKey: string
  defaultWidth: number
  minWidth: number
  maxWidth: number
  visible: boolean
  className?: string
  children: React.ReactNode
  /** Pre-loaded persisted width — when provided, skips async getSetting */
  initialWidth?: number
  /** Show drag handle on right edge. Default true. */
  showHandle?: boolean
  /** VS Code snap-close: called when dragged left past minWidth/2 */
  onSnapClose?: () => void
  /** VS Code snap-open: called when dragged right past minWidth/2 from collapsed state */
  onSnapOpen?: () => void
  /** 面板停靠方向：left（默认，手柄在右缘）/ right（手柄在左缘，拖拽方向镜像） */
  side?: 'left' | 'right'
  /** 折叠后保留的边条宽度 px。贴窗口边缘的面板建议 ≥12 以避开系统原生缩放热区 */
  collapsedWidth?: number
  /** 抽屉式窗口外扩：visible 翻转时窗口宽度同步 ±当前面板宽度，主内容不被挤压（最大化/全屏时主进程自动跳过） */
  growWindow?: boolean
  /** 面板实际占宽上报（px，折叠/卸载为 0）。供标题栏把搜索框等锚定在主内容区，外扩时不漂移 */
  onWidthChange?: (width: number) => void
  /** 单击手柄（未越过 dead-zone 的按下-抬起）= 开合切换。工作台三栏外壳的边缘手柄行为（原型 v15）；不传则单击无操作 */
  onHandleClick?: () => void
}

export function ResizablePanel({ storageKey, defaultWidth, minWidth, maxWidth, visible, className = '', children, initialWidth, showHandle = true, onSnapClose, onSnapOpen, side = 'left', collapsedWidth = 4, growWindow = false, onWidthChange, onHandleClick }: Props) {
  const [width, setWidth] = useState(initialWidth ?? defaultWidth)
  const [dragging, setDragging] = useState(false)
  /** pointer capture 不可用时的退路标记（退回 window 监听，老实现同构但带 dead-zone 与统一收尾） */
  const [fallbackDrag, setFallbackDrag] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const widthRef = useRef(initialWidth ?? defaultWidth)
  const loadedRef = useRef(initialWidth != null)  // skip async load if pre-loaded

  /**
   * 拖拽会话（null = 未按下）。用 ref 而非 state：拖拽期间每帧都在改，且收尾需要读到最终状态。
   * `moved` = 已越过 dead-zone（真拖过）；`snapped` = 拖过半程触发 snap-close（此时不落盘）。
   */
  const dragRef = useRef<{ startX: number; startW: number; moved: boolean; snapped: boolean } | null>(null)

  // 加载持久化宽度（仅在未预加载时）
  useEffect(() => {
    if (loadedRef.current) return
    getSettingRaw(storageKey).then(v => {
      if (typeof v === 'number') {
        const clamped = Math.max(minWidth, Math.min(maxWidth, v))
        setWidth(clamped)
        widthRef.current = clamped
      }
    })
  }, [storageKey, minWidth, maxWidth])

  // 约束变化联动（如主窗口缩放导致 maxWidth 变小）→ 当前宽度超限时自动收窄
  useEffect(() => {
    const next = Math.max(minWidth, Math.min(maxWidth, widthRef.current))
    if (next !== widthRef.current) {
      widthRef.current = next
      setWidth(next)
    }
  }, [minWidth, maxWidth])

  // 抽屉式窗口外扩（绝对宽度协议）：上报面板期望宽度，0 = 收回。
  // 主进程以「打开时刻基准宽」为锚点计算，重复/乱序消息不会累积漂移。
  // 开合/卸载请求缓动动画（animate = !dragging），拖拽调宽传 false 即时跟随；
  // 卸载时收回（日程面板以卸载方式隐藏）。
  useEffect(() => {
    if (!growWindow) return
    void resizeForSidebar(visible ? widthRef.current : 0, !dragging)
  }, [growWindow, visible, width, dragging])
  useEffect(() => {
    return () => {
      if (growWindow) void resizeForSidebar(0, true)
    }
  }, [growWindow])

  // 面板实际占宽上报：经 ref 转发避免调用方内联回调导致重复触发
  const reportWidthRef = useRef(onWidthChange)
  reportWidthRef.current = onWidthChange
  useEffect(() => {
    reportWidthRef.current?.(visible ? width : 0)
  }, [visible, width])

  // onSnapClose 经 ref 转发（2026-09-09 修）：调用方普遍传内联箭头函数，若直接进依赖数组，
  // 拖拽期间每次 setWidth 渲染都会 cleanup + 重注册 window 监听，顺带把 body.cursor 反复置空再设回
  // （cursor 闪烁），且局部 snapped 被重置。改为 ref 后监听器只在 dragging 翻转时绑定一次。
  const onSnapCloseRef = useRef(onSnapClose)
  onSnapCloseRef.current = onSnapClose

  // 单击开合回调同样经 ref 转发（调用方传内联箭头函数，避免 endDrag 依赖抖动）
  const onHandleClickRef = useRef(onHandleClick)
  onHandleClickRef.current = onHandleClick

  /**
   * 拖拽收尾 —— **四路兜底共用这一份实现**：pointerup / pointercancel / lostpointercapture / 卸载。
   *
   * v3.2.0 条目 ⑤ 根因③（最严重的一条）：原实现只挂 `mouseup`，指针一进工件 HTML 的 iframe
   * （`kbview://` 独立文档，无 allow-same-origin）事件就断流 → `mouseup` 永远不来 →
   * `dragging` 卡在 true → 那个 effect 的 cleanup 不执行 → `body` 的 `user-select:none` 与
   * `cursor:col-resize` **永久污染全窗口**（只能重启恢复）。
   * 所以收尾必须多路可达，且**清 body 污染这一步不允许缺席**。
   */
  const endDrag = useCallback((persist = true) => {
    const d = dragRef.current
    dragRef.current = null
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    setDragging(false)
    setFallbackDrag(false)
    if (!d) return
    // 只有「真拖过且没被 snap 掉」才落盘：误触（没过 dead-zone）不再产生一次宽度持久化
    if (persist && d.moved && !d.snapped) void setSettingRaw(storageKey, widthRef.current)
    // 单击手柄（按下-抬起都没越过 dead-zone 也没 snap）= 开合切换（工作台三栏外壳的边缘手柄行为）
    if (!d.moved && !d.snapped) onHandleClickRef.current?.()
  }, [storageKey])

  /**
   * 拖拽主体：按指针横坐标推进宽度。**两处复用**（元素上的 pointermove 与退路的 window pointermove）。
   * 首次越过 dead-zone 时才置 dragging + 禁选中 + 换光标 —— 误触全程零副作用。
   */
  const applyDrag = useCallback((clientX: number) => {
    const d = dragRef.current
    if (!d || d.snapped) return
    // right 侧面板：向左拖 = 变宽，方向镜像
    const delta = (clientX - d.startX) * (side === 'right' ? -1 : 1)
    if (!d.moved) {
      if (Math.abs(delta) < DRAG_DEAD_ZONE_PX) return
      d.moved = true
      setDragging(true)
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
    }
    const raw = d.startW + delta
    // VS Code snap-close: drag past half of minWidth → auto-collapse
    if (onSnapCloseRef.current && raw < minWidth * 0.5) {
      d.snapped = true
      onSnapCloseRef.current()
      endDrag()
      return
    }
    const next = Math.max(minWidth, Math.min(maxWidth, raw))
    widthRef.current = next
    setWidth(next)
  }, [endDrag, minWidth, maxWidth, side])

  /** 按下手柄：只登记起点，**不**立即进入拖拽态（dead-zone 决定何时真的开始） */
  const onHandlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = { startX: e.clientX, startW: widthRef.current, moved: false, snapped: false }
    // 指针捕获（本条的根治手段）：即使指针移到 iframe 之上，事件仍派发给本元素。
    // 环境不支持时退回 window 监听（fallbackDrag），两条路都用同一个 applyDrag / endDrag。
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
      setFallbackDrag(false)
    } catch {
      setFallbackDrag(true)
    }
  }, [])

  // 退路：无 pointer capture 的环境下从 window 收事件（老实现同构，但带 dead-zone 与统一收尾）
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

  // 卸载兜底：拖拽中组件被卸载（切 Tab / 面板关闭 / 禅模式）→ 必须摘掉 body 污染。
  // 这里直接清样式、不走 endDrag（卸载后 setState 无意义，清样式才是这条兜底的全部目的）。
  useEffect(() => () => {
    if (!dragRef.current) return
    dragRef.current = null
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }, [])

  /** 双击手柄复位到默认宽度（VS Code 侧栏双击边线的同款语义） */
  const onHandleDoubleClick = useCallback(() => {
    const next = Math.max(minWidth, Math.min(maxWidth, defaultWidth))
    widthRef.current = next
    setWidth(next)
    void setSettingRaw(storageKey, next)
  }, [defaultWidth, minWidth, maxWidth, storageKey])

  // 折叠时重置为边条宽度（贴窗缘的面板用 collapsedWidth 避开系统缩放热区）
  const displayWidth = visible ? width : (onSnapOpen ? collapsedWidth : 0)

  /* ── 折叠态「拖出展开」 ────────────────────────────────────────────────
     与主手柄同一套指针语义（pointer events + capture + 双路收尾），但**不能**照抄
     「有 capture 就不挂 window 监听」那种二选一：边条只有 4~14px 宽，指针一离开它，
     元素级监听就收不到事件了；而 capture 期间事件仍会冒泡到 window。
     所以这里两条路**同时挂着**，靠 `opened` 一次性标记 + `edgeDragRef.current` 空判保证幂等。
     （`onSnapOpenRef` 转发理由同 `onSnapCloseRef`：调用方传内联箭头函数。） */
  const onSnapOpenRef = useRef(onSnapOpen)
  onSnapOpenRef.current = onSnapOpen

  const [edgeDrag, setEdgeDrag] = useState(false)
  const edgeDragRef = useRef<{ startX: number; opened: boolean } | null>(null)

  const applyEdgeDrag = useCallback((clientX: number) => {
    const d = edgeDragRef.current
    if (!d || d.opened) return
    const moved = side === 'right' ? d.startX - clientX : clientX - d.startX
    if (moved > minWidth * 0.5) {
      d.opened = true
      onSnapOpenRef.current?.()
    }
  }, [minWidth, side])

  const endEdgeDrag = useCallback(() => {
    if (!edgeDragRef.current) return
    edgeDragRef.current = null
    document.body.style.cursor = ''
    setEdgeDrag(false)
  }, [])

  const onEdgePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!onSnapOpenRef.current) return
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    edgeDragRef.current = { startX: e.clientX, opened: false }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch { /* 元素级 + window 双路已足够 */ }
    document.body.style.cursor = 'col-resize'
    setEdgeDrag(true)
  }, [])

  // window 侧收尾路（元素级监听见下方 JSX；两条路都幂等）
  useEffect(() => {
    if (!edgeDrag) return
    const onMove = (e: PointerEvent) => applyEdgeDrag(e.clientX)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', endEdgeDrag)
    window.addEventListener('pointercancel', endEdgeDrag)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', endEdgeDrag)
      window.removeEventListener('pointercancel', endEdgeDrag)
      // 展开瞬间边条会卸载，收尾可能来不及跑 → 在这里也清一次光标（幂等）
      document.body.style.cursor = ''
    }
  }, [edgeDrag, applyEdgeDrag, endEdgeDrag])

  const isRight = side === 'right'
  return (
    <div
      ref={panelRef}
      className={`shrink-0 relative flex flex-col bg-[var(--bg-secondary)] overflow-hidden ${className}`}
      style={{
        width: displayWidth,
        transition: dragging ? 'none' : 'width 200ms ease-out'
      }}
    >
      {visible && children}

      {/* 折叠边缘分割条 — 悬停显示蓝色可拖拽条；支持拖拽拉出 + 单击兜底展开 */}
      {!visible && onSnapOpen && (
        <div
          className="absolute inset-0 z-30 group"
          style={{ cursor: 'col-resize' }}
          onPointerDown={onEdgePointerDown}
          onPointerMove={(e) => applyEdgeDrag(e.clientX)}
          onPointerUp={endEdgeDrag}
          onPointerCancel={endEdgeDrag}
          onLostPointerCapture={endEdgeDrag}
          onClick={onSnapOpen}
          title="拖拽或点击展开"
        >
          <div className={`absolute top-0 bottom-0 ${isRight ? 'right-0' : 'left-0'} w-1 bg-[var(--accent)]/0 group-hover:bg-[var(--accent)]/60 transition-colors duration-150`} />
        </div>
      )}

      {/* 拖拽手柄（v3.2.0 条目 ⑤ 重做）：
          · 命中热区 5px 内贴（原 2px 太难抓），视觉线 1px 贴外缘（与外层 border 同位，不外探避免双线）；
          · 按下只登记起点，越过 4px dead-zone 才算真拖（鼠标掠过不再改宽度、也不再落盘）；
          · pointer capture + 四路收尾（见 endDrag 注释）；
          · 双击复位到默认宽度。 */}
      {visible && showHandle && (
        <div
          role="separator"
          aria-orientation="vertical"
          title="拖拽调整宽度，双击复位"
          className="absolute top-0 h-full z-30 group"
          style={{
            width: HANDLE_HIT_WIDTH_PX,
            cursor: 'col-resize',
            ...(isRight ? { left: 0 } : { right: 0 }),
          }}
          onPointerDown={onHandlePointerDown}
          onPointerMove={(e) => applyDrag(e.clientX)}
          onPointerUp={() => endDrag()}
          onPointerCancel={() => endDrag()}
          onLostPointerCapture={() => endDrag()}
          onDoubleClick={onHandleDoubleClick}
        >
          <div
            className={`absolute inset-y-0 w-px transition-colors ${
              dragging ? 'bg-[var(--accent)]' : 'bg-[var(--border-color)] group-hover:bg-[var(--accent)]/40'
            }`}
            style={isRight ? { left: 0 } : { right: 0 }}
          />
        </div>
      )}

      {/* 拖拽期遮罩（第二层保险）：把指针留在父文档内 —— 工件 HTML 是 `kbview://` 独立文档，
          指针一旦进入它的 iframe，父文档就收不到后续事件。pointer capture 已能覆盖这种情况，
          这层遮罩再加一道保险，并让整个窗口的光标在拖拽期保持 col-resize（观感对齐 VS Code）。
          **必须由 dragging 状态摘除**（即统一收尾路径），绝不另挂一个只认 up 的监听了事。 */}
      {dragging && <div className="fixed inset-0 z-[60] cursor-col-resize" />}
    </div>
  )
}
