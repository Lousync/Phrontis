import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/**
 * 锚点浮层（2026-10-14，AI 设置区改造的基建）：把菜单 / 下拉 / 提示**挂到 body**，
 * 再用锚点元素的位置把它摆到锚点旁边。
 *
 * 为什么必须挂 body 而不是就地 `absolute`：
 *   折叠容器（`.kb-collapse > *`）自带 `overflow: hidden`（高度动画要裁切开合过程），
 *   落在折叠组里的账号菜单、模型下拉会被**裁成半个**；`content-visibility` 同理。
 *   就地渲染还要求每一层祖先都没有 `transform` / 层叠上下文，脆得没法维护。
 *
 * 三条口径：
 *   · 落位分两步：先按 `prefer` 摆一个初值，再用**实测宽高**纠偏（水平夹回视口、垂直不够就翻面）。
 *     估算尺寸必然在长短不一的文案上失效，所以宁可多一趟 layout effect。
 *   · 滚动 / 改窗口尺寸**一律直接关**，不追着锚点跑 —— 追位要常驻 rAF 监听，而「滚一下就没了」
 *     对菜单和提示都可接受。（滚动在**浮层内部**时不算，那是用户在翻下拉列表。）
 *   · 「点外面关闭」把**锚点自身**也算在里面：否则点触发器会先被判定为「外面」而关掉，
 *     紧接着触发器的 onClick 又把它打开 —— 经典的双触发。锚点交给它自己的 onClick 管。
 */

const EDGE = 8

interface Props {
  /** 浮层贴在哪个元素旁边 */
  anchorRef: RefObject<HTMLElement | null>
  open: boolean
  /** 传了才响应「点外面 / Esc 关闭」；纯悬停提示不需要 */
  onClose?: () => void
  /** 优先出现在锚点的下缘（默认）还是上缘；不够就自动翻面 */
  prefer?: 'bottom' | 'top'
  /** 与锚点对齐的边：`start` = 左对齐，`end` = 右对齐（菜单常用） */
  align?: 'start' | 'end'
  gap?: number
  /** 层宽 = 锚点宽（下拉框用）；否则由内容决定 */
  matchWidth?: boolean
  maxWidth?: number
  /** false = 不吃指针事件（提示浮层用） */
  interactive?: boolean
  zIndex?: number
  className?: string
  /** 无障碍角色（提示浮层传 `tooltip`） */
  role?: string
  /** 固定 id，供锚点的 `aria-describedby` 指向 */
  layerId?: string
  children: ReactNode
}

interface Pos {
  left: number
  top: number
  placement: 'top' | 'bottom'
}

export function AnchoredLayer({
  anchorRef, open, onClose, prefer = 'bottom', align = 'start', gap = 6,
  matchWidth = false, maxWidth, interactive = true, zIndex = 76, className, role, layerId, children,
}: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null)
  const rectRef = useRef<DOMRect | null>(null)
  const [pos, setPos] = useState<Pos | null>(null)

  const close = useCallback(() => { setPos(null); onClose?.() }, [onClose])

  // 打开时量一次锚点位置，摆初值（对齐 / 翻面的最终裁决在下面的 layout effect）
  useEffect(() => {
    if (!open) { setPos(null); return }
    const a = anchorRef.current
    if (!a) { setPos(null); return }
    const r = a.getBoundingClientRect()
    rectRef.current = r
    setPos({
      left: align === 'end' ? r.right : r.left,
      top: prefer === 'top' ? r.top - gap : r.bottom + gap,
      placement: prefer,
    })
  }, [open, align, prefer, gap, anchorRef])

  // 用实测宽高纠偏。幂等：纠正后条件已满足，第二次进来不会再次 setState（无循环）。
  useLayoutEffect(() => {
    const el = layerRef.current
    const r = rectRef.current
    if (!pos || !el || !r) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    let { left, top, placement } = pos
    // 水平：先按对齐边落位，再夹回视口
    if (align === 'end') left = r.right - w
    if (left + w > window.innerWidth - EDGE) left = window.innerWidth - EDGE - w
    if (left < EDGE) left = EDGE
    // 垂直：先按需翻面，再**无论朝哪都夹回视口**。
    // 后半句是必需的：锚点自己可能有一半在视口外（折叠组一展开，触发按钮就被顶到可视区之下），
    // 那时「贴着锚点」和「看得见」是矛盾的，得听后者。
    if (placement === 'bottom') {
      if (top + h > window.innerHeight - EDGE && r.top - gap - h >= EDGE) {
        top = r.top - gap - h
        placement = 'top'
      }
    } else if (top < EDGE && r.bottom + gap + h <= window.innerHeight - EDGE) {
      top = r.bottom + gap
      placement = 'bottom'
    }
    if (top + h > window.innerHeight - EDGE) top = Math.max(EDGE, window.innerHeight - EDGE - h)
    if (top < EDGE) top = EDGE
    if (left !== pos.left || top !== pos.top || placement !== pos.placement) {
      setPos({ left, top, placement })
    }
  }, [pos, align, gap])

  useEffect(() => {
    if (!pos) return
    const onScroll = (e: Event) => {
      // 浮层内部的滚动（下拉列表）不算「页面滚了」，别把用户正在翻的列表关掉
      if (layerRef.current && e.target instanceof Node && layerRef.current.contains(e.target)) return
      setPos(null)
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [pos])

  useEffect(() => {
    if (!pos || !onClose) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (layerRef.current?.contains(t)) return
      if (anchorRef.current?.contains(t)) return   // 锚点自己管开关，见头注
      close()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [pos, onClose, close, anchorRef])

  if (!open || !pos) return null

  const style: CSSProperties = {
    left: pos.left,
    top: pos.top,
    width: matchWidth ? rectRef.current?.width : undefined,
    maxWidth,
    zIndex,
    transformOrigin: `${pos.placement === 'top' ? 'bottom' : 'top'} ${align === 'end' ? 'right' : 'left'}`,
    // 提示浮层不吃指针事件：不必做「鼠标移到浮层上仍保持展开」的保持逻辑
    pointerEvents: interactive ? undefined : 'none',
  }

  return createPortal(
    <div ref={layerRef} id={layerId} role={role} className={`kb-pop fixed ${className ?? ''}`} style={style}>{children}</div>,
    document.body
  )
}
