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

import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Link2, ExternalLink, Type, Bold, Italic, Strikethrough, Code, Highlighter, Pilcrow, Quote,
  List, ListOrdered, ListChecks, Plus, StickyNote, Table, MessageSquareQuote, Minus,
  SquareCode, Sigma, Scissors, Copy, ClipboardPaste, ClipboardType, SquareDashedMousePointer, ChevronRight,
} from 'lucide-react'
import { NOTE_MENU, runNoteAction, isNoteActionEnabled, type NoteActionId, type NoteMenuNode } from '../../lib/noteActions'
import type { NoteEngineHandle } from '../../lib/noteEngine'
import { showToast } from '../../lib/toast'

const ICONS: Record<string, ComponentType<{ size?: number; className?: string }>> = {
  Link2, ExternalLink, Type, Bold, Italic, Strikethrough, Code, Highlighter, Pilcrow, Quote,
  List, ListOrdered, ListChecks, Plus, StickyNote, Table, MessageSquareQuote, Minus,
  SquareCode, Sigma, Scissors, Copy, ClipboardPaste, ClipboardType, SquareDashedMousePointer,
}

export interface NoteContextMenuProps {
  /** 视口坐标（clientX / clientY） */
  x: number
  y: number
  engine: NoteEngineHandle
  onClose: () => void
}

export function NoteContextMenu({ x, y, engine, onClose }: NoteContextMenuProps) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [openSub, setOpenSub] = useState<string | null>(null)

  // 出屏回夹：先渲染在屏幕外测量，再定位（避免先闪一下再跳）
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8))
    const top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8))
    setPos({ left, top })
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

  const ctx = engine.getBlockContext()
  // 打开菜单不打断选区：右键若把光标挪走，`ctx` 就是挪走后的位置（Obsidian 同款行为不追求，
  // 这里只保证「有选区就按选区走」——两档引擎都不在 contextmenu 里改选区）
  const run = (id: NoteActionId): void => {
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

  const renderNode = (node: NoteMenuNode, key: string, depth: number): ReactNode => {
    if (node.sep) return <div key={key} className="kb-menu-sep" />
    const Icon = node.icon ? ICONS[node.icon] : undefined
    if (node.children?.length) {
      const open = openSub === key
      return (
        <div key={key} className="relative" onMouseEnter={() => setOpenSub(key)} onMouseLeave={() => setOpenSub(null)}>
          <button type="button" className="kb-menu-item" onClick={() => setOpenSub(open ? null : key)}>
            {Icon ? <Icon size={14} className="kb-menu-icon" /> : <span className="kb-menu-icon" />}
            <span className="flex-1 text-left">{node.label}</span>
            <ChevronRight size={13} className="opacity-60" />
          </button>
          {open && (
            <div className={`kb-menu kb-pop ${depth === 0 ? 'absolute left-[calc(100%-4px)] top-[-5px]' : ''}`}>
              {node.children.map((c, i) => renderNode(c, `${key}.${i}`, depth + 1))}
            </div>
          )}
        </div>
      )
    }
    const id = node.action as NoteActionId
    const disabled = !isNoteActionEnabled(id, ctx)
    return (
      <button
        key={key}
        type="button"
        disabled={disabled}
        className="kb-menu-item"
        onClick={() => run(id)}
      >
        {Icon ? <Icon size={14} className="kb-menu-icon" /> : <span className="kb-menu-icon" />}
        <span className="flex-1 text-left">{node.label}</span>
        {node.hint && <span className="text-[10px] text-[var(--text-disabled)] ml-3">{node.hint}</span>}
      </button>
    )
  }

  return createPortal(
    <div
      ref={boxRef}
      className="kb-menu kb-pop fixed z-[9999]"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
      data-wb="noteContextMenu"
    >
      {NOTE_MENU.map((n, i) => renderNode(n, `n${i}`, 0))}
    </div>,
    document.body,
  )
}
