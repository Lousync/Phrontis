import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * 文件条目统一右键菜单（借鉴 Obsidian：图标前置 + 分组分隔线 + 危险项红色）。
 *
 * 六个调用点共用：工作台·文件树 / 知识库·文件树 / AI 教学·文件树 / 总览·零散文件
 * + 两处**排序菜单**（借它的长相与视口钳位）。
 * 宿主只负责把动作编成 `items`（含图标），本组件负责长相 / portal / 视口钳位 / 二级面板选边 / Esc 关闭。
 *
 * 视觉与关闭口径对齐既有的 `.kb-pop` 菜单：fixed 层铺满窗口接外部点击，
 * 面板 `kb-pop` 进场；⚠️ 必须 portal 到 body —— 左栏面板的变换/收缩容器会改写
 * fixed 的包含块，就地渲染会把菜单压成竖条（历史坑）。
 *
 * ★ 2026-10-12 三处改造（docs/file-menu-rework-design.md）：
 *   ① **宽度内容自适应** —— 原 `min-w-[216px]` 是硬地板，而各宿主最长的一条只需约 130px
 *      ⇒ 每条右侧恒定留约 85px 点不到的空白。面板本就是 shrink-to-fit，去掉地板即贴内容。
 *   ② **二级面板自动选边** —— 同一颗组件既服务**左栏文件树**（往右开没事），也服务
 *      **知识页顶栏的 ⋮**（贴窗口右缘，那里的「文件格式 ▸」是写死往左的）。加二级菜单就会撞上这个分叉。
 *   ③ 新增 `submenu`（二级条目表）与 `popover`（任意二级内容，给「目录搜索弹层」用）两个字段。
 *      交互刻意不同：`submenu` **悬停即开**（照 Obsidian「复制路径 ▸」），
 *      `popover` **点击才开**（里面有输入框，悬停开会没法用）。
 */

export interface FileMenuItem {
  /** 稳定 key（React key 用） */
  key: string
  label: string
  /** lucide 图标节点（一般 size 15） */
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  /** 右侧小字说明（如「根层」） */
  note?: string
  onSelect?: () => void
  /** 二级条目表：悬停 / 点击展开 */
  submenu?: Array<{ label: string; onSelect: () => void }>
  /** 二级任意内容（如目录搜索弹层 DirPicker）：**点击**展开 */
  popover?: ReactNode
}

/** `{ separator: true }` = 分组分隔线 */
export type FileMenuEntry = FileMenuItem | { separator: true }

/** 二级面板预估宽（用于判断往左还是往右开）；比实测值略大一点留余量 */
const SUB_W = 240

export function FileContextMenu({ x, y, items, onClose }: {
  x: number
  y: number
  items: FileMenuEntry[]
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [side, setSide] = useState<'left' | 'right'>('right')
  const [openKey, setOpenKey] = useState<string | null>(null)
  /** 二级面板贴底时上移多少（负值向下、正值向上）；见下方 effect */
  const [subShift, setSubShift] = useState(0)

  // 实测尺寸后钳进视口（照 src/lib/useContextMenuPosition 口径，8px 边距）+ 定二级面板选边
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8))
    setPos({ left, top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) })
    // 右侧剩余空间不够放二级面板 ⇒ 改往左开
    setSide(window.innerWidth - (left + r.width) < SUB_W ? 'left' : 'right')
  }, [x, y, items])

  // 二级面板贴底时上移（编辑器右键菜单已为同类问题修过一次，见 notes-surface 契约 C13）
  useLayoutEffect(() => {
    setSubShift(0)
    if (!openKey) return
    const el = subRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const over = r.bottom - (window.innerHeight - 8)
    if (over > 0) setSubShift(over)
  }, [openKey])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const subStyle: CSSProperties = side === 'left'
    ? { right: 'calc(100% + 4px)', top: -5 - subShift }
    : { left: 'calc(100% + 4px)', top: -5 - subShift }

  return createPortal(
    <div
      className="fixed inset-0 z-[70] kb-pop-layer"
      onMouseDown={onClose}
      onContextMenu={(e) => { e.preventDefault(); onClose() }}
    >
      <div
        ref={panelRef}
        className="absolute max-w-[300px] rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-secondary)] p-[5px] shadow-xl kb-pop"
        style={pos}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {items.map((it, i) => 'separator' in it ? (
          <div key={`sep-${i}`} aria-hidden className="my-1 h-px bg-[var(--border-color)]" />
        ) : (
          <div key={it.key} className="relative">
            <button
              type="button"
              disabled={it.disabled}
              data-wb-menu-item={it.key}
              {...(openKey === it.key ? { 'data-open': '1' } : {})}
              onMouseEnter={() => { if (it.submenu && !it.disabled) setOpenKey(it.key) }}
              onClick={() => {
                if (it.submenu || it.popover) { setOpenKey((k) => (k === it.key ? null : it.key)); return }
                onClose(); it.onSelect?.()
              }}
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
              {/* note（键位 / 说明）：2026-10-13 由 --text-disabled 改 --text-secondary ——
                  禁用色的对比度在 14 套主题里全部 <3:1，而这是要读的信息（同 .kb-kbd 的整改） */}
              {it.note && <span className="ml-auto shrink-0 pl-2.5 text-[10px] text-[var(--text-secondary)]">{it.note}</span>}
              {(it.submenu || it.popover) && (
                <span className="ml-auto shrink-0 pl-2 text-[var(--text-muted)]" aria-hidden>›</span>
              )}
            </button>

            {openKey === it.key && (it.submenu || it.popover) && (
              <div
                ref={subRef}
                data-sub-side={side}
                className={`kb-pop absolute z-50 rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-xl ${
                  it.popover ? 'p-0' : 'max-w-[300px] p-[5px]'
                }`}
                style={subStyle}
              >
                {it.submenu
                  ? it.submenu.map((s) => (
                      <button
                        key={s.label}
                        type="button"
                        onClick={() => { onClose(); s.onSelect() }}
                        className="flex w-full items-center gap-2 rounded-md px-2.5 py-[6px] text-left text-[12.5px] leading-snug text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
                      >
                        <span className="min-w-0 truncate">{s.label}</span>
                      </button>
                    ))
                  : it.popover}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  )
}
