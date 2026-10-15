import { useRef, useState, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { AnchoredLayer } from '../../../components/shared/AnchoredLayer'

/**
 * 行级「⋯」菜单（2026-10-14 从 AiModelsTab 抽出来共用）。
 *
 * 三件事一次说清：
 *   · **浮层挂 body**（`AnchoredLayer`）—— 这些菜单都长在折叠组里，就地 absolute 会被
 *     折叠容器的 `overflow: hidden` 裁掉半个。
 *   · **自己持有开合状态**。父组件不必再维护「当前开着哪个菜单」，也就不会出现
 *     "两个菜单同时开着"。点别处 / Esc / 滚动都收（都在 AnchoredLayer 里）。
 *   · **点菜单里的任何一项都自动收起**：内层包一层 `onClick` 捕获式收起，
 *     所以 `MenuItem` 只写动作，别再各写一遍 `setOpen(false)`。
 *
 * 触发器上的 `stopPropagation` 是必需的 —— 它常挂在一个「整行可点」的容器里。
 */
export function RowMenuButton({ label, size = 14, className, children }: {
  /** 触发器语义名（`title` + `aria-label`）；纯图标按钮没有可见文字 */
  label: string
  size?: number
  className?: string
  children: ReactNode
}) {
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={e => { e.stopPropagation(); setOpen(v => !v) }}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`shrink-0 p-1 rounded-md transition-colors ${
          open ? 'text-[var(--accent)] bg-[var(--bg-hover)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
        } ${className ?? ''}`}
      >
        <MoreHorizontal size={size} />
      </button>
      <AnchoredLayer anchorRef={btnRef} open={open} onClose={() => setOpen(false)} align="end"
        className="min-w-[186px] p-1 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-lg">
        <div onClick={() => setOpen(false)}>{children}</div>
      </AnchoredLayer>
    </>
  )
}

export function MenuItem({ onClick, danger, children }: {
  onClick: () => void
  danger?: boolean
  children: ReactNode
}) {
  return (
    <button type="button" onClick={onClick}
      className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] rounded-md transition-colors ${
        danger ? 'text-red-400 hover:bg-red-500/10' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
      }`}>
      {children}
    </button>
  )
}

/** 菜单里的分组横线 */
export function MenuSep() {
  return <div className="my-1 h-px bg-[var(--border-color)]" />
}
