/**
 * 图片画布（批 3，2026-10-13，v3.5.0 线）。
 *
 * **受控纯视图**：`scale / fit / rot / tx / ty` 全部由外部传入，本组件一个视图 state 都不持有
 * （只留「正在拖拽」这个瞬态）。为什么这么切：批 3 拍板控件位 = **顶栏内联**，
 * 而顶栏在图片视图**上方** —— 组件没法往祖先的槽里塞东西，除非 portal；
 * 而批 2 已拍板「顶栏行内渲染、不 portal，走 portal 等于再造一个真源」
 * （`PageEditor.tsx:1180-1183`）。所以状态上提到 `PageEditor`，两边都只是视图。
 *
 * 几何算式一律走 `src/lib/imageView.ts`（纯函数、有契约脚本），本文件不自己算。
 *
 * 拖拽用 **pointer events + setPointerCapture**：捕获后指针移出元素（甚至移出窗口）
 * 仍能收到 move，于是不必往 window 上挂监听、也就不存在「换 DOM 后旧监听叠加」那类问题
 * （原型阶段真踩过：切几次视图后一次拖拽被 N 个 handler 各加一遍 delta）。
 */

import { useEffect, useRef, useState } from 'react'
import { effNat, type ImageViewState, type ViewBox } from '../../../lib/imageView'

interface Props {
  /** objectURL（仅 ready 时有值） */
  url: string | null
  /** 自然尺寸（权威值由 `<img>` 解码后回填）。null = 还没解码出来 */
  nat: ViewBox | null
  view: ImageViewState
  /** 透明棋盘格底（调用方按格式判定，见 imageFormats.imageMayHaveAlpha） */
  checker?: boolean
  /** 视口尺寸上报（★ 必须是稳定引用，否则 ResizeObserver 每渲染重建一次） */
  onViewport: (box: ViewBox) => void
  /** 拖拽平移：回传**绝对**平移量（起拖时的值 + 位移），夹取交给调用方 */
  onPan: (tx: number, ty: number) => void
  /** 滚轮缩放。anchor 是**视口内坐标** —— 口径要害见 imageView.zoomAbout 注释 */
  onZoom: (k: number, anchor?: { x: number; y: number }) => void
  /** 双击：在「适应窗口 ⇄ 100%」之间切换 */
  onDoubleClick: () => void
  onDecoded: (w: number, h: number) => void
  onDecodeError: () => void
}

export function ImageViewer({
  url, nat, view, checker = false, onViewport, onPan, onZoom, onDoubleClick, onDecoded, onDecodeError,
}: Props) {
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  /** 本地也留一份视口尺寸：只用来决定光标形状与「能不能拖」 */
  const [box, setBox] = useState<ViewBox>({ w: 0, h: 0 })

  // 视口尺寸：ResizeObserver 是唯一真相（窗口变化、左右栏开合、沉浸态进出都会改它）
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const report = (): void => {
      const b = { w: el.clientWidth, h: el.clientHeight }
      setBox(b)
      onViewport(b)
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [onViewport])

  // 滚轮：必须用**原生**监听 —— React 的 onWheel 走根容器且是 passive 的，
  // 在里面 preventDefault() 拦不住浏览器的页面缩放。
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      onZoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, { x: e.clientX - r.left, y: e.clientY - r.top })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onZoom])

  const e = nat ? effNat(nat, view.rot) : null
  const dispW = e ? e.w * view.scale : 0
  const dispH = e ? e.h * view.scale : 0
  /** 只有图真的超出视口才允许拖（否则 clampPan 会把它按回中心，拖了等于没拖） */
  const pannable = !!e && box.w > 0 && (dispW > box.w || dispH > box.h)
  /** 解码完成前隐藏，避免「先按自然尺寸闪一帧、再跳到适应尺寸」 */
  const decoded = !!nat

  const onPointerDown = (ev: React.PointerEvent<HTMLDivElement>): void => {
    if (ev.button !== 0 || !pannable) return
    ev.currentTarget.setPointerCapture(ev.pointerId)
    dragRef.current = { x: ev.clientX, y: ev.clientY, tx: view.tx, ty: view.ty }
    setDragging(true)
  }
  const onPointerMove = (ev: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d) return
    onPan(d.tx + (ev.clientX - d.x), d.ty + (ev.clientY - d.y))
  }
  const endDrag = (ev: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    try { ev.currentTarget.releasePointerCapture(ev.pointerId) } catch { /* 已释放 */ }
  }

  return (
    <div
      ref={canvasRef}
      data-wb="imageCanvas"
      data-pannable={pannable ? '1' : '0'}
      data-dragging={dragging ? '1' : '0'}
      data-zoom={view.scale >= 4 ? 'far' : 'near'}
      className={`kb-img-canvas kb-view-fade flex-1 min-h-0 min-w-0 ${checker ? 'kb-img-checker' : ''}`}
      style={checker ? undefined : { background: 'var(--bg-primary)' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
    >
      {/* 位置靠绝对定位 + 居中偏移；拖拽只改 translate，缩放/旋转各在自己那一层 —— 
          三层分开是为了让每层的 transform 都只有一个来源，不会互相覆盖 */}
      <div
        className="kb-img-stage"
        style={{ transform: `translate(-50%, -50%) translate(${view.tx}px, ${view.ty}px)` }}
      >
        <div className="kb-img-rot" style={{ transform: `rotate(${view.rot}deg)` }}>
          {url && (
            <img
              src={url}
              alt=""
              draggable={false}
              /* nat 未知时不给显式尺寸：让它按自然尺寸摆着（画布 overflow:hidden + 隐藏，
                 既不影响布局也不会闪一下） */
              style={decoded && e
                ? { width: `${dispW}px`, height: `${dispH}px`, visibility: 'visible' }
                : { visibility: 'hidden' }}
              onLoad={ev => onDecoded(ev.currentTarget.naturalWidth, ev.currentTarget.naturalHeight)}
              onError={onDecodeError}
            />
          )}
        </div>
      </div>
    </div>
  )
}
