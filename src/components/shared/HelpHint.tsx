import { Info } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AnchoredLayer } from './AnchoredLayer'

/**
 * 行级「ⓘ 悬停披露」（docs/help-disclosure-pattern.md §5 里那条待办：抽通用 HelpHint）。
 *
 * 与既有 `SectionHead`（同文档形态 B，标题 + 悬停展开段落）的分工：
 *   · `SectionHead` = **段级**说明，展开体铺在标题下方，会把这节后面的内容往下推；
 *   · `HelpHint`   = **行级**说明，浮层不入布局流，悬停/聚焦时叠在图标旁，**行内零位移**。
 * 设置区改造后一行就是「标签 + 控件」那么窄，展开体会把下面所有行顶走，所以行级一律走本组件。
 *
 * 三个刻意的取舍：
 *   · 浮层交给 `AnchoredLayer` 走 portal + `fixed`：折叠容器自带 `overflow: hidden`，
 *     就地渲染的浮层在折叠组里会被裁成半个。
 *   · 开启动带 120ms 延迟、关闭不带：鼠标扫过一列 ⓘ 时不会连闪，但离开即收，不拖泥带水。
 *   · 浮层不吃指针事件，所以不做「鼠标从图标移到浮层上仍保持展开」那套悬停保持逻辑
 *     （那是给可点菜单用的）。
 */

/** 悬停后多久浮出 */
const OPEN_DELAY = 120

interface Props {
  /** 说明正文。按披露规范**一字不删**，只是从常显改成悬停可见 */
  text: ReactNode
  /** 触发图标，默认 `Info`（规范 §4 的定稿图标） */
  icon?: typeof Info
  /** 浮层最大宽度，默认 280px（信息卡里的说明最长也就这个量级） */
  width?: number
  /** 无障碍名。默认「说明」——不要用 `text` 兜底，那是整段说明，读屏会把它念成按钮名 */
  label?: string
  className?: string
}

export function HelpHint({ text, icon, width = 280, label = '说明', className }: Props) {
  const Icon = icon ?? Info
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [open, setOpen] = useState(false)
  const tipId = useId()

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])
  const hide = useCallback(() => {
    clearTimer()
    setOpen(false)
  }, [clearTimer])
  const showNow = useCallback(() => {
    clearTimer()
    setOpen(true)
  }, [clearTimer])
  const onEnter = useCallback(() => {
    clearTimer()
    timer.current = setTimeout(() => setOpen(true), OPEN_DELAY)
  }, [clearTimer])

  // 卸载时清掉未触发的开启动定时器（快速划过 + 组件被折叠卸载的路径）
  useEffect(() => clearTimer, [clearTimer])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        aria-describedby={open ? tipId : undefined}
        onPointerEnter={onEnter}
        onPointerLeave={hide}
        onFocus={showNow}
        onBlur={hide}
        className={`shrink-0 inline-flex items-center text-[var(--text-disabled)] hover:text-[var(--text-muted)] transition-colors ${className ?? ''}`}
      >
        <Icon size={12} />
      </button>
      <AnchoredLayer
        anchorRef={btnRef}
        open={open}
        interactive={false}
        maxWidth={width}
        role="tooltip"
        layerId={tipId}
        className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-[11.5px] leading-relaxed text-[var(--text-secondary)] shadow-lg"
      >
        {text}
      </AnchoredLayer>
    </>
  )
}
