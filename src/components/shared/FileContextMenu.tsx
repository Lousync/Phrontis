import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * 文件条目统一右键菜单（借鉴 Obsidian：图标前置 + 分组分隔线 + 危险项红色）。
 *
 * 四处宿主共用：工作台·文件树 / 知识库·文件树 / AI 教学·文件树 / 总览·零散文件。
 * 宿主只负责把动作编成 `items`（含图标），本组件负责长相 / portal / 视口钳位 / Esc 关闭。
 *
 * 视觉与关闭口径对齐既有的 `.kb-pop` 菜单：fixed 层铺满窗口接外部点击，
 * 面板 `kb-pop` 进场；⚠️ 必须 portal 到 body —— 左栏面板的变换/收缩容器会改写
 * fixed 的包含块，就地渲染会把菜单压成竖条（历史坑）。
 */

export interface FileMenuItem {
  /** 稳定 key（React key 用） */
  key: string
  label: string
  /** lucide 图标节点（一般 size 15） */
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

/** `{ separator: true }` = 分组分隔线 */
export type FileMenuEntry = FileMenuItem | { separator: true }

export function FileContextMenu({ x, y, items, onClose }: {
  x: number
  y: number
  items: FileMenuEntry[]
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // 实测尺寸后钳进视口（照 src/lib/useContextMenuPosition 口径，8px 边距）
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    })
  }, [x, y, items])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[70] kb-pop-layer"
      onMouseDown={onClose}
      onContextMenu={(e) => { e.preventDefault(); onClose() }}
    >
      <div
        ref={panelRef}
        className="absolute min-w-[216px] max-w-[300px] rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-secondary)] p-[5px] shadow-xl kb-pop"
        style={pos}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {items.map((it, i) => 'separator' in it ? (
          <div key={`sep-${i}`} aria-hidden className="my-1 h-px bg-[var(--border-color)]" />
        ) : (
          <button
            key={it.key}
            type="button"
            disabled={it.disabled}
            onClick={() => { onClose(); it.onSelect() }}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-[6px] text-left text-[12.5px] leading-snug transition-colors disabled:cursor-default disabled:opacity-40 ${
              it.danger
                ? 'text-[var(--danger)] hover:bg-[var(--bg-hover)]'
                : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            {it.icon && (
              <span className={`shrink-0 ${it.danger ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'}`}>{it.icon}</span>
            )}
            <span className="min-w-0 truncate">{it.label}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  )
}
