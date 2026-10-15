/**
 * 编辑器右键菜单（两档同一份）—— 双写作面方案 `docs/note-surface-dual-engine-design.md`。
 *
 * 「一份定义、两档共用」：菜单树与动作实现在 `src/lib/noteActions.ts`（数据层，零 DOM 依赖），
 * 本组件只负责渲染 + 定位 + 键盘语义 + 失败转 Toast。源码档（Monaco）与即时渲染档（CM6）
 * 各自把 `contextmenu` 事件转成 `{ x, y, engine }` 交给宿主 `NoteSurface`，最终都落到这里。
 *
 * 交互：子菜单悬停展开（右侧）；Esc / 点外部 / 滚动 / 失焦关闭；出屏自动回夹。
 * 动效走既有工具类 `.kb-pop`（只动 transform/opacity，带 prefers-reduced-motion 兜底）。
 */

import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Link2, ExternalLink, Type, Bold, Italic, Strikethrough, Code, Highlighter, Pilcrow, Quote,
  List, ListOrdered, ListChecks, Plus, StickyNote, Table, MessageSquareQuote, Minus,
  SquareCode, Sigma, Scissors, Copy, ClipboardPaste, ClipboardType, SquareDashedMousePointer, ChevronRight, FileText,
} from 'lucide-react'
import { NOTE_MENU, runNoteAction, isNoteActionEnabled, fileTypeActionId, fileTypeOfAction, type NoteActionId, type NoteMenuNode } from '../../lib/noteActions'
import { FILE_LANG_OPTIONS } from '../../lib/fileTypes'
import type { NoteEngineHandle } from '../../lib/noteEngine'
import { showToast } from '../../lib/toast'

const ICONS: Record<string, ComponentType<{ size?: number; className?: string }>> = {
  Link2, ExternalLink, Type, Bold, Italic, Strikethrough, Code, Highlighter, Pilcrow, Quote,
  List, ListOrdered, ListChecks, Plus, StickyNote, Table, MessageSquareQuote, Minus,
  SquareCode, Sigma, Scissors, Copy, ClipboardPaste, ClipboardType, SquareDashedMousePointer, FileText,
}

export interface NoteContextMenuProps {
  /** 视口坐标（clientX / clientY） */
  x: number
  y: number
  engine: NoteEngineHandle
  onClose: () => void
  /** 文件格式落点（拍板 C2）：给定才渲染「文件格式」组 —— 不给就不显示，避免出现点不动的菜单项 */
  onFileType?: (ext: string) => void
}

/** 贴边余量：菜单任何一条边都不得越过它 */
const EDGE = 8

/**
 * 子菜单定位：**贴到窗口边缘也要完整可见**（2026-10-11 反馈：右键菜单被屏幕边缘截断）。
 *
 * 此前只有主菜单做了出屏回夹，子菜单是死的 `left-[calc(100%-4px)] top-[-5px]`：
 * 在窗口右缘右键时，主菜单被夹到贴右缘 → 往右展开的「插入 / 文本格式 / 段落设置」整块落在窗口外；
 * 在下缘右键时，子菜单还会从下边被截掉。
 *
 * 两条规则：① 右侧放不下就翻到**左侧**（主菜单在右缘时这是唯一出路）；② 下边放不下就上移。
 * 尺寸一律用 `offsetWidth / offsetHeight`：`.kb-pop` 的进场 keyframes 从 `scale(0.94)` 起，
 * `getBoundingClientRect()` 在布局期量到的是缩小 6% 的尺寸，拿它算回夹等于没夹。
 */
function SubMenu({ open, children }: { open: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)
  // 未量到尺寸前先藏起来（useLayoutEffect 在首帧绘制前跑完，用户看不到这一步）
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' })

  useLayoutEffect(() => {
    if (!open) return
    const el = ref.current
    const item = el?.parentElement
    if (!el || !item) return
    const r = item.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const gap = 4
    // 水平：默认贴承载项右侧；右侧放不下就翻到左侧
    let left = r.right - gap
    let originX = 'left'
    if (left + w > window.innerWidth - EDGE) { left = Math.max(EDGE, r.left - w + gap); originX = 'right' }
    // 垂直：默认与承载项顶对齐；下边放不下就上移，并夹进视口
    let top = r.top - 5
    let originY = 'top'
    if (top + h > window.innerHeight - EDGE) { top = window.innerHeight - EDGE - h; originY = 'bottom' }
    top = Math.max(EDGE, top)
    setStyle({
      left: left - r.left,
      top: top - r.top,
      // 锚点：翻转发生时菜单落到了承载项的另一侧，锚点跟着换边才像「从承载项长出来」
      transformOrigin: `${originY} ${originX}`,
      // 极高窗口 / 极矮窗口兜底：超出可用高度就在菜单内滚动，别整块溢出
      maxHeight: Math.max(120, window.innerHeight - EDGE * 2),
      overflowY: 'auto',
      visibility: 'visible',
    })
  }, [open])

  if (!open) return null
  return (
    <div ref={ref} className="kb-menu kb-pop absolute" style={style}>
      {children}
    </div>
  )
}

export function NoteContextMenu({ x, y, engine, onFileType, onClose }: NoteContextMenuProps) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; transformOrigin: string } | null>(null)
  const [openSub, setOpenSub] = useState<string | null>(null)

  // 出屏回夹：先渲染在屏幕外测量，再定位（避免先闪一下再跳）。
  // ★ 用 offsetWidth / offsetHeight 量：`.kb-pop` 进场是 scale(0.94)，rect 会小 6%，
  //   按缩小尺寸回夹仍会溢出（子菜单同因，见 SubMenu）。
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = Math.max(EDGE, Math.min(x, window.innerWidth - w - EDGE))
    const top = Math.max(EDGE, Math.min(y, window.innerHeight - h - EDGE))
    // 锚点：被下/右边界推回时菜单整体落到鼠标另一侧 → 锚点换到那一角
    // （同 lib/useContextMenuPosition 口径；不给锚点就是从菜单自己中心长出来）
    setPos({ left, top, transformOrigin: `${top < y ? 'bottom' : 'top'} ${left < x ? 'right' : 'left'}` })
  }, [x, y])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current?.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    }
    const onScroll = (): void => onClose()
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', onScroll)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [onClose])

  /** 「文件格式」组：清单直接取 `fileTypes.ts` 的 FILE_LANG_OPTIONS（**单一真源**，
   *  含 '' = Markdown）。宿主没给 onFileType 时整组不渲染。 */
  const menuNodes: NoteMenuNode[] = onFileType
    ? [
        ...NOTE_MENU,
        { sep: true },
        {
          label: '文件格式', icon: 'FileText',
          children: FILE_LANG_OPTIONS.map((o) => ({ label: o.label, action: fileTypeActionId(o.ext), icon: 'FileText' })),
        },
      ]
    : NOTE_MENU

  const ctx = engine.getBlockContext()
  // 打开菜单不打断选区：右键若把光标挪走，`ctx` 就是挪走后的位置（Obsidian 同款行为不追求，
  // 这里只保证「有选区就按选区走」——两档引擎都不在 contextmenu 里改选区）
  const run = (raw: string): void => {
    // 文件格式：执行权在宿主（PageEditor 的 applyFileType —— 要改渲染态并把类型回报父级/状态栏），
    // 本组件只把扩展名递上去。两处入口（⋮ / 右键菜单）共用同一个落点，不会各写一套。
    const ext = fileTypeOfAction(raw)
    if (ext !== null) {
      onFileType?.(ext)
      onClose()
      return
    }
    const id = raw as NoteActionId
    const out = runNoteAction(id, engine)
    if (out instanceof Promise) {
      void out.then((r) => {
        if (!r.ok) showToast({ type: 'info', message: r.message })
      }).catch(() => showToast({ type: 'error', message: '操作失败' }))
    } else if (!out.ok) {
      showToast({ type: 'info', message: out.message })
    }
    onClose()
  }

  const renderNode = (node: NoteMenuNode, key: string): ReactNode => {
    if (node.sep) return <div key={key} className="kb-menu-sep" />
    const Icon = node.icon ? ICONS[node.icon] : undefined
    if (node.children?.length) {
      const open = openSub === key
      return (
        <div key={key} className="relative" onMouseEnter={() => setOpenSub(key)} onMouseLeave={() => setOpenSub(null)}>
          {/* 点击父项**只开不关**：悬停已经把它打开了，再做成 toggle 就会出现
              「鼠标还在这一行、点一下反而收起来」的自相矛盾（真实用户路径，探针也踩到过）。
              收起靠移开鼠标（onMouseLeave）——这也是菜单的通行手感。 */}
          <button type="button" className="kb-menu-item" onClick={() => setOpenSub(key)}>
            {Icon ? <Icon size={14} className="kb-menu-icon" /> : <span className="kb-menu-icon" />}
            <span className="flex-1 text-left">{node.label}</span>
            <ChevronRight size={13} className="opacity-60" />
          </button>
          <SubMenu open={open}>
            {node.children.map((c, i) => renderNode(c, `${key}.${i}`))}
          </SubMenu>
        </div>
      )
    }
    const raw = String(node.action ?? '')
    const disabled = !isNoteActionEnabled(raw as NoteActionId, ctx)
    return (
      <button
        key={key}
        type="button"
        disabled={disabled}
        className="kb-menu-item"
        onClick={() => run(raw)}
      >
        {Icon ? <Icon size={14} className="kb-menu-icon" /> : <span className="kb-menu-icon" />}
        <span className="flex-1 text-left">{node.label}</span>
        {/* 键位提示（如 Ctrl+B）：2026-10-13 由 --text-disabled 改 --text-secondary ——
            禁用色的对比度在 14 套主题里全部 <3:1，而这是要读的信息（同 .kb-kbd 的整改） */}
        {node.hint && <span className="text-[10px] text-[var(--text-secondary)] ml-3">{node.hint}</span>}
      </button>
    )
  }

  return createPortal(
    <div
      ref={boxRef}
      className="kb-menu kb-pop fixed z-[9999]"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, transformOrigin: pos?.transformOrigin ?? 'top left', visibility: pos ? 'visible' : 'hidden' }}
      data-wb="noteContextMenu"
    >
      {menuNodes.map((n, i) => renderNode(n, `n${i}`))}
    </div>,
    document.body,
  )
}
