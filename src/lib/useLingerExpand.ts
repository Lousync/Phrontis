import { useCallback, useEffect, useRef, useState, type FocusEvent } from 'react'

/**
 * 「先展开、再收起」的停留时长：选完模型 / 关掉菜单后，名字至少再亮 1.2s，
 * 让用户看清改成了什么，而不是刚点完就缩回图标。
 */
export const LINGER_EXPAND_MS = 1200

export interface LingerExpandState {
  /** 菜单（或任何「必须展开」的附属 UI）是否打开 */
  open: boolean
  hovered: boolean
  /** 只认 `:focus-visible` —— 鼠标点出来的焦点不展开，键盘 Tab 才展开 */
  keyboardFocused: boolean
  /** 是否处在「刚收起理由消失」的停留窗口内 */
  lingering: boolean
}

/** 纯函数版本的状态判定（契约脚本可直接跑；hook 与它共用同一口径） */
export function isLingerExpanded(state: LingerExpandState): boolean {
  return state.hovered || state.keyboardFocused || state.open || state.lingering
}

export interface LingerExpandTriggerProps {
  onMouseEnter: () => void
  onMouseLeave: () => void
  onFocus: (event: FocusEvent<HTMLElement>) => void
  onBlur: () => void
}

/**
 * 图标化工具栏控件（模型选择器等）的「收起 ↔ 展开」状态机，移植自 DeepTutor
 * 同名的 `use-linger-expand`，去掉 framer-motion 依赖：宽度动画交给 CSS 令牌
 * `.kb-collapse-x`（`grid-template-columns 0fr ↔ 1fr`），这里只管**什么时候**展开。
 *
 * 展开条件（任一成立）：hover · 键盘聚焦 · `open`（菜单打开）· 停留窗口内。
 * 收起条件：以上全部消失 —— 但鼠标离开 / 失焦 / 菜单关闭时**不立刻收**，而是
 * 调入 `linger()` 停留 `lingerMs`（默认 1.2s）。菜单持有方在「选中 / 点外部 / Esc
 * 关闭」处显式调 `linger()`，就能保证刚改完的名字不会立刻消失。
 *
 * 用法：
 *   const { expanded, linger, triggerProps } = useLingerExpand(menu.open)
 *   <button {...triggerProps}>
 *     <Icon />
 *     <span className={'kb-collapse-x' + (expanded ? ' open' : '')}>…</span>
 *   </button>
 */
export function useLingerExpand(open: boolean, lingerMs = LINGER_EXPAND_MS): {
  expanded: boolean
  /** 手动续 1.2s（菜单关闭 / 选中条目后调用） */
  linger: () => void
  triggerProps: LingerExpandTriggerProps
} {
  const [hovered, setHovered] = useState(false)
  const [keyboardFocused, setKeyboardFocused] = useState(false)
  const [lingering, setLingering] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  /** 续一段停留窗口；重复调用 = 重新计时（不会叠加） */
  const linger = useCallback(() => {
    clearTimer()
    setLingering(true)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setLingering(false)
    }, lingerMs)
  }, [clearTimer, lingerMs])

  // 卸载时清定时器：会话切走 / 面板关掉后不能再 setState
  useEffect(() => clearTimer, [clearTimer])

  const onMouseEnter = useCallback(() => {
    clearTimer()
    setLingering(false) // 真正 hover 上了，就不需要停留窗口续命
    setHovered(true)
  }, [clearTimer])

  const onMouseLeave = useCallback(() => {
    setHovered(false)
    linger()
  }, [linger])

  return {
    expanded: isLingerExpanded({ open, hovered, keyboardFocused, lingering }),
    linger,
    triggerProps: {
      onMouseEnter,
      onMouseLeave,
      onFocus: (event) => setKeyboardFocused(event.currentTarget.matches(':focus-visible')),
      onBlur: () => {
        setKeyboardFocused(false)
        linger()
      },
    },
  }
}
