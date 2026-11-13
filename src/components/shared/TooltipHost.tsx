import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { placeTooltip, parseTipKeys, TIP_OPEN_DELAY, type TipPlacement } from '../../lib/tooltip'

/**
 * 全局悬停提示宿主（2026-11-13）。
 *
 * 为什么是「一个宿主 + 事件委托」，而不是给每个元素包一个 <Tooltip> 组件：
 *   · 全仓有约 840 处原生 `title`，包组件会插一层 DOM —— 工具栏 / 页签 / 树行都是
 *     靠 flex 几何和 `overflow: hidden` 活的，多一层 wrapper 就可能改布局；
 *   · 委托只认 `data-tip` / `data-keys` 两个属性，迁移时把 `title=` 换成属性即可，
 *     一处的定位 / 延迟 / 无障碍口径改完全仓生效；
 *   · 气泡只挂一份，不会出现「同时开了十个实例」的合成层开销。
 *
 * 与 `HelpHint`（ⓘ 行级浮层）的分工：
 *   · 本宿主 = 触发体只读、文案短的通用提示；
 *   · `HelpHint` = 需要 aria-describedby 与受控开合的说明浮层，共用同一套 `--tip-*` 令牌，
 *     但自己管开合与焦点（它会渲染可聚焦的 ⓘ 按钮）。两者皮肤一致、定位各管各的。
 */

/** 固定 id：锚点的 aria-describedby 指向它（同一时刻只可能有一个气泡） */
const TIP_ID = 'kb-tooltip-layer'

interface ActiveTip {
  anchor: HTMLElement
  label: string
  keys: string[]
}

/** 从事件目标往上找最近的提示锚点；SVG 子元素（图标）也要能命中 */
function findAnchor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  return target.closest<HTMLElement>('[data-tip]')
}

export function TooltipHost() {
  const [active, setActive] = useState<ActiveTip | null>(null)
  const [pos, setPos] = useState<TipPlacement | null>(null)
  const layerRef = useRef<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 当前指针 / 焦点所在的锚点。用它而不是 state 做「同一个锚点别重开」的判断 */
  const anchorRef = useRef<HTMLElement | null>(null)

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const hide = useCallback(() => {
    clearTimer()
    anchorRef.current = null
    setActive(null)
    setPos(null)
  }, [clearTimer])

  const show = useCallback((anchor: HTMLElement) => {
    // 延迟窗口内锚点可能已被卸载（例如列表行被删）—— 别对着脱离文档的元素定位到 (0,0)
    if (!anchor.isConnected) return
    const label = anchor.getAttribute('data-tip') ?? ''
    if (!label) return
    anchorRef.current = anchor
    setActive({
      anchor,
      label,
      keys: parseTipKeys(anchor.getAttribute('data-keys')),
    })
  }, [])

  useEffect(() => clearTimer, [clearTimer])

  useEffect(() => {
    const onOver = (e: PointerEvent) => {
      const anchor = findAnchor(e.target)
      if (!anchor || anchor === anchorRef.current) return
      // 换目标：先把上一个收掉，再按延迟重开（关掉不带延迟，扫过一列图标不连闪）
      clearTimer()
      anchorRef.current = anchor
      setActive(null)
      setPos(null)
      timer.current = setTimeout(() => {
        timer.current = null
        // 延迟期间指针可能已经离开
        if (anchorRef.current === anchor) show(anchor)
      }, TIP_OPEN_DELAY)
    }

    const onOut = (e: PointerEvent) => {
      const anchor = findAnchor(e.target)
      if (!anchor || anchor !== anchorRef.current) return
      // 在同一个锚点内部移动（按钮 → 图标 → 键帽）不算离开
      const to = e.relatedTarget
      if (to instanceof Node && anchor.contains(to)) return
      hide()
    }

    const onFocusIn = (e: FocusEvent) => {
      const anchor = findAnchor(e.target)
      if (!anchor) return
      // 只认键盘聚焦（Tab）：鼠标点出来的焦点也会触发 focusin，不拦的话
      // 「点一下图标 → 气泡留在原地」会一直挡着刚打开的面板。
      if (!anchor.matches(':focus-visible')) return
      // 键盘聚焦零延迟：Tab 过来就该读到
      clearTimer()
      anchorRef.current = anchor
      show(anchor)
    }

    const onFocusOut = (e: FocusEvent) => {
      const anchor = findAnchor(e.target)
      if (!anchor || anchor !== anchorRef.current) return
      const to = e.relatedTarget
      if (to instanceof Node && anchor.contains(to)) return
      hide()
    }

    // 点下去就收：菜单会立刻接管，气泡留着只会压住新界面
    const onDown = () => hide()
    // 滚动 / 改窗口直接关，不追着锚点跑（与 AnchoredLayer 同一口径）
    const onScroll = () => hide()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide() }

    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointerout', onOut)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    window.addEventListener('blur', onScroll)
    window.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('pointerout', onOut)
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('blur', onScroll)
      window.removeEventListener('keydown', onKey)
    }
  }, [show, hide, clearTimer])

  // 无障碍：气泡出现时把锚点指过来；收起时还原（锚点可能自己已经有 aria-describedby）
  useEffect(() => {
    if (!active) return
    const el = active.anchor
    const prev = el.getAttribute('aria-describedby')
    el.setAttribute('aria-describedby', TIP_ID)
    return () => {
      // 只在当前值仍是我们写的那份时还原，避免覆盖 React 后续渲染写入的值
      if (el.getAttribute('aria-describedby') !== TIP_ID) return
      if (prev === null) el.removeAttribute('aria-describedby')
      else el.setAttribute('aria-describedby', prev)
    }
  }, [active])

  // 量一次真实宽高再落位：估算宽度在长短文案上必错，宁可多一趟 layout effect
  useLayoutEffect(() => {
    if (!active) {
      setPos(null)
      return
    }
    const el = layerRef.current
    if (!el) return
    const rect = active.anchor.getBoundingClientRect()
    const next = placeTooltip(
      rect,
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    )
    setPos(next)
  }, [active])

  if (!active) return null

  const style: CSSProperties = {
    left: pos?.left ?? 0,
    top: pos?.top ?? 0,
    visibility: pos ? 'visible' : 'hidden',
    // 箭头位置由定位结果决定：气泡被夹回视口后，箭头仍然指回锚点中心
    ['--tip-arrow-x' as string]: `${pos?.arrowX ?? 0}px`,
  } as CSSProperties

  return createPortal(
    <div
      ref={layerRef}
      id={TIP_ID}
      role="tooltip"
      className="kb-tip"
      data-place={pos?.place ?? 'top'}
      data-ready={pos ? '1' : '0'}
      style={style}
    >
      <span className="kb-tip__label">{active.label}</span>
      {active.keys.length > 0 && (
        <span className="kb-tip__keys">
          {active.keys.map((k) => <kbd key={k} className="kb-kbd">{k}</kbd>)}
        </span>
      )}
      <span className="kb-tip__arrow" aria-hidden="true" />
    </div>,
    document.body,
  )
}
