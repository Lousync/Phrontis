import { useLayoutEffect, useRef, useState } from 'react'

const EDGE_MARGIN = 8

interface MenuPosition {
  left: number
  top: number
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
    setPosition({ left, top })
  }, [menu])

  return {
    menuRef,
    style: position ?? { left: menu?.x ?? 0, top: menu?.y ?? 0 },
  }
}
