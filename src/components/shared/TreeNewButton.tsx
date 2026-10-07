import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Plus } from 'lucide-react'

/** 菜单项：key 由调用方定义语义（本组件不认识具体业务），icon 已带色，note 是右侧灰色小字 */
export interface TreeNewMenuItem {
  key: string
  label: string
  icon: ReactNode
  /** 右侧灰色小字（如「根层」）：说明该项不跟随当前落点 */
  note?: string
}

/**
 * 头部「＋」新建按钮（B-7）：点开弹小菜单选类型，具体落点与提交语义全在调用方。
 *
 * 与 `FolderFocusButton` 同体量、同挂载方式（portal 进左栏模块态头部动作槽），
 * 菜单本身 portal 到 body —— 模块槽是窄包含块，就地 absolute 会被压成竖条
 * （同 `treeMenu` 的理由，见 knowledge/index.tsx 的注释）。
 */
export function TreeNewButton({ items, onPick, title = '新建…' }: {
  items: TreeNewMenuItem[]
  onPick: (key: string) => void
  title?: string
}) {
  const btnRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ left: 0, top: 0 })

  // Esc 关闭（打开态才挂监听；菜单开着时不该被模块级快捷键抢走）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const toggle = () => {
    if (open) { setOpen(false); return }
    const r = btnRef.current?.getBoundingClientRect()
    // 左对齐到按钮左缘再左移 8px：与菜单项的内边距对齐，视觉上"从按钮长出来"
    if (r) setPos({ left: r.left - 8, top: r.bottom + 6 })
    setOpen(true)
  }

  return (
    <>
      <button
        ref={btnRef}
        data-wb="treeNewBtn"
        onClick={toggle}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`shrink-0 rounded-md p-1 transition-colors ${
          open
            ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
        }`}
      >
        <Plus size={13} />
      </button>
      {open && createPortal(
        <div
          className="fixed inset-0 z-[70]"
          onMouseDown={() => setOpen(false)}
          onContextMenu={(e) => { e.preventDefault(); setOpen(false) }}
        >
          <div
            role="menu"
            className="kb-pop absolute min-w-[168px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-lg"
            style={{ left: pos.left, top: pos.top }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {items.map((it) => (
              <button
                key={it.key}
                role="menuitem"
                data-wb={`treeNewItem-${it.key}`}
                onClick={() => { setOpen(false); onPick(it.key) }}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                {it.icon}
                <span>{it.label}</span>
                {it.note && <span className="ml-auto text-[10.5px] text-[var(--text-muted)]">{it.note}</span>}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
