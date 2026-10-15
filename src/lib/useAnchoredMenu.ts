import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react'

/** 菜单与锚点按钮 / 视口边缘的间距 */
const GAP = 6
const EDGE_MARGIN = 8

export interface MenuPosition {
  left: number
  top: number
  /**
   * 缩放进场的锚点（`.kb-pop` 的 `kb-pop-in` 从 `scale(0.94)` 起），默认 `50% 50%`
   * = 从菜单自己的中心长出来，读不出「它从哪个按钮来」。
   * 这里由定位结果反推：向下展开 ⇒ `top`；向上翻转 ⇒ `bottom`；默认右对齐触发按钮
   * ⇒ `right`（被左边界推回时才换 `left`）。
   */
  transformOrigin: string
}

/**
 * 锚定到触发按钮的固定定位弹出菜单：开合状态 + 定位 + 外部关闭一次收口。
 *
 * 定位规则（解决「菜单凭空浮到别处」）：
 * - **优先向下**展开（`r.bottom + GAP`）；下方剩余空间装不下**实测高度**时翻转为
 *   `r.top - GAP - h` —— 高度取 `menuRef` 的 offsetHeight，不用估值常量；
 * - 菜单挂载后由 `useLayoutEffect` 实测回填（首帧按 h=0 估位，paint 前修正 → 无跳动）；
 * - `left` / `top` 一律 clamp 进视口；
 * - open 期间捕获阶段监听 `scroll` + `resize` 重算，菜单跟随滚动而不脱离锚点。
 *
 * 与 `useContextMenuPosition` 的区别：那个吃**点击坐标**（右键菜单），本 hook 吃**锚点元素**。
 */
export function useAnchoredMenu(
  triggerRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  /** 菜单宽度兜底（首帧未挂载时用；应与菜单实际宽度一致） */
  fallbackWidth = 210,
) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<MenuPosition | null>(null)

  const place = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const r = trigger.getBoundingClientRect()
    const menu = menuRef.current
    const w = menu?.offsetWidth || fallbackWidth
    const h = menu?.offsetHeight ?? 0

    // 未 clamp 的目标位：菜单右边缘对齐触发按钮右边缘（默认右对齐）
    const rawLeft = r.right - w
    const left = Math.max(EDGE_MARGIN, Math.min(rawLeft, window.innerWidth - w - EDGE_MARGIN))
    const fitsBelow = r.bottom + GAP + h + EDGE_MARGIN <= window.innerHeight
    const top = fitsBelow
      ? r.bottom + GAP
      : Math.max(EDGE_MARGIN, r.top - GAP - h)

    // 锚点：被左边界推右（left > rawLeft）说明触发按钮贴着屏幕左边，菜单相对它在右侧 ⇒ 取 left；
    // 否则菜单右对齐触发按钮，鼠标贴着菜单右上角 ⇒ 取 right。纵向取翻转方向。
    const originX = left > rawLeft ? 'left' : 'right'
    const originY = fitsBelow ? 'top' : 'bottom'
    setPos({ left, top, transformOrigin: `${originY} ${originX}` })
  }, [triggerRef, menuRef, fallbackWidth])

  const close = useCallback(() => setOpen(false), [])

  const toggle = useCallback(() => {
    if (open) {
      setOpen(false)
      return
    }
    place()
    setOpen(true)
  }, [open, place])

  // 菜单挂载后实测尺寸回填：首帧按 h=0 定位，layout effect 在 paint 前修正
  useLayoutEffect(() => { if (open) place() }, [open, place])

  // open 期间跟随侧栏滚动 / 窗口缩放
  useEffect(() => {
    if (!open) return
    const onViewportChange = () => place()
    window.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('resize', onViewportChange)
    return () => {
      window.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('resize', onViewportChange)
    }
  }, [open, place])

  // 外部点击 / Esc 关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, triggerRef, menuRef])

  return { open, pos, toggle, close }
}
