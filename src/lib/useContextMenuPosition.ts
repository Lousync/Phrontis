import { useLayoutEffect, useRef, useState } from 'react'

const EDGE_MARGIN = 8

interface MenuPosition {
  left: number
  top: number
  /**
   * 菜单缩放进场的锚点（`.kb-pop` 的 `kb-pop-in` 从 `scale(0.94)` 起）。
   *
   * 不给的话是 CSS 默认的 `50% 50%` = 从菜单**自己的中心**长出来，与触发位置无关 ——
   * 菜单「从哪来」这条空间关系就断了（计划文档 §二 B 段要求「transform-origin 对准锚点」，
   * 但当时只有少数调用方手工给过）。这里直接由 clamp 结果推出来，调用方零改动受益。
   *
   * 规则：菜单被右/下边界推回时会整体落到鼠标的另一侧，锚点就该换到对应的那一角，
   * 缩放才像「从这个点长出来」。
   *   · `left < menu.x` ⇒ 菜单被向左推（右侧空间不足），鼠标贴着菜单**右上角** ⇒ 取 right
   *   · 反之鼠标在菜单左上角 ⇒ 取 left
   *   · 纵向同理（下边界推回 ⇒ bottom）
   */
  transformOrigin: string
}

/**
 * Keep a fixed-position context menu fully inside the window.
 *
 * The menu's real size is measured after render, then the click coordinates are
 * clamped against the viewport with a small edge margin. This replaces hard-coded
 * size estimates, which cut the menu off when it is opened near a window edge.
 *
 * ⚠️ Size must come from `offsetWidth / offsetHeight`, **not** `getBoundingClientRect()`:
 * most of these menus enter with `.kb-pop` / `.kb-pop-layer`, whose keyframes start at
 * `scale(0.94)`. The rect is therefore ~6% smaller than the menu's real footprint at
 * measure time (layout effects run on the animation's first frame), so clamping with it
 * still leaves the menu hanging over the edge — a ~500px menu was allowed to overflow by
 * ~30px. `offset*` returns the untransformed border-box size.
 */
function menuBoxSize(el: HTMLElement): { width: number; height: number } {
  const w = el.offsetWidth
  const h = el.offsetHeight
  if (w > 0 && h > 0) return { width: w, height: h }
  // display:none / detached 兜底：没有布局尺寸时才退回 rect（此时也没有 transform）
  const rect = el.getBoundingClientRect()
  return { width: rect.width, height: rect.height }
}

export function useContextMenuPosition(menu: { x: number; y: number } | null) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<MenuPosition | null>(null)

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return
    const { width, height } = menuBoxSize(menuRef.current)
    const left = Math.max(EDGE_MARGIN, Math.min(menu.x, window.innerWidth - width - EDGE_MARGIN))
    const top = Math.max(EDGE_MARGIN, Math.min(menu.y, window.innerHeight - height - EDGE_MARGIN))
    const originY = top < menu.y ? 'bottom' : 'top'
    const originX = left < menu.x ? 'right' : 'left'
    setPosition({ left, top, transformOrigin: `${originY} ${originX}` })
  }, [menu])

  return {
    menuRef,
    style: position ?? { left: menu?.x ?? 0, top: menu?.y ?? 0, transformOrigin: 'top left' },
  }
}
