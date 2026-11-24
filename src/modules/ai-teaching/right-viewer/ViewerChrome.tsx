/**
 * 右侧活动栏 · 页签条（单行条 / 窄头部 / `+` 菜单 / 全部页签 / 旁问历史）
 *
 * 形态（PLAN §3 A + §10）：
 *   · ≥400px：单行页签条（图标 + 标题，当前页签贴条首、下划线 + 更宽额度），
 *     溢出时右缘渐隐并出现 `⌄`（全部页签）；`+` / `⤢` / `×` 固定在右端；
 *   · <400px：收成「当前页签名 + `⌄`」，不再硬塞半截页签名；
 *   · 页签自己的 `×` 只在 hover / 当前页签显形；头部 `×` 永远是「关面板」；
 *   · `⤢` 是**查看器全屏**（覆盖整个模块区域），与「关闭面板」并排、`Esc` 可退。
 *
 * 弹层都在头部内部绝对定位（面板根 `overflow-hidden` 已把它们裁在面板内）：
 * 打开时由壳 `webPaneHideAll()`，关闭后再 bump 令牌让网页原生视图回来。
 */

import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type RefObject,
} from 'react'
import {
  BookOpen, ChevronDown, FileCode2, FileText, Globe, Image as ImageIcon, List,
  Maximize2, MessageCircle, Minimize2, Network, NotebookPen, Plus, Presentation, User, X,
} from 'lucide-react'
import type { AgentSideLaneInfo } from '../../../types'
import type { ViewerPaneType } from './paneContracts'
import {
  VIEWER_NEW_TAB_ORDER, stripOverflow, tabTitleOf,
  type ViewerTab,
} from './viewerTabs'
import { AskHistoryMenu } from './AskHistoryMenu'

/* ============================== 图标 ============================== */

const TYPE_ICONS: Record<ViewerPaneType, typeof Globe> = {
  web: Globe,
  notes: NotebookPen,
  books: BookOpen,
  // `file` 不进 `+` 菜单（没有通用文件选择器）；这里只是保住 Record 完整，实际图标走 fileKind
  file: FileText,
  ask: MessageCircle,
}

/** 页签图标：会话文件（画像 / 要求）用语义图标；文件页签按 `fileKind`；其余按 kind */
function TabIcon({ tab, size = 12 }: { tab: ViewerTab; size?: number }) {
  if (tab.type === 'notes') {
    if (tab.fileKind === 'profile') return <User size={size} className="shrink-0 opacity-65" />
    if (tab.fileKind === 'constraints') return <List size={size} className="shrink-0 opacity-65" />
    return <FileText size={size} className="shrink-0 opacity-65" />
  }
  if (tab.type === 'file') {
    const Icon =
      tab.fileKind === 'html' ? FileCode2
        : tab.fileKind === 'image' ? ImageIcon
          : tab.fileKind === 'mindmap' ? Network
            : Presentation
    return <Icon size={size} className="shrink-0 opacity-65" />
  }
  const Icon = TYPE_ICONS[tab.type]
  return <Icon size={size} className="shrink-0 opacity-65" />
}

/* ============================== 工具 ============================== */

const NARROW_WIDTH = 400

type MenuKind = 'none' | 'plus' | 'tablist' | 'ask'

/** 弹层里的键盘导航（↑↓ / Home / End）：只在 `[role="menuitem"]` 或 `[data-menu-row]` 上移动 */
function moveMenuFocus(container: HTMLElement | null, key: string): boolean {
  if (!container) return false
  const items = Array.from(
    container.querySelectorAll<HTMLElement>('[role="menuitem"], [data-menu-row="1"]'),
  ).filter((el) => !el.hasAttribute('disabled'))
  if (items.length === 0) return false
  const current = items.indexOf(document.activeElement as HTMLElement)
  let next = current
  if (key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length
  else if (key === 'ArrowUp') next = current <= 0 ? items.length - 1 : current - 1
  else if (key === 'Home') next = 0
  else if (key === 'End') next = items.length - 1
  else return false
  items[next]?.focus()
  return true
}

/* ============================== 组件 ============================== */

export interface ViewerChromeProps {
  tabs: ViewerTab[]
  activeId: string | null
  /** 面板实际宽度：<400 收成窄头部 */
  width: number
  /** 正在播关闭动效的页签（立即从活动态里摘掉，视觉上留 160ms） */
  closingIds: string[]
  /** 侧栏打开时把焦点交给当前页签 / `+`（首次打开一次） */
  autoFocusToken: number
  onSelect: (id: string) => void
  onCloseTab: (id: string) => void
  onClosePanel: () => void
  /** 全屏放大（覆盖整个模块区域）；再点一次退出 */
  expanded: boolean
  onToggleExpand: () => void
  /** 全屏按钮的引用：退出全屏后壳把焦点交回它 */
  expandButtonRef?: RefObject<HTMLButtonElement | null>
  onNewTab: (type: ViewerPaneType) => void
  /** 问整段对话（新建整段草稿页签） */
  onNewWholeAsk: () => void
  /** 历史条目 → 聚焦或新建该旁问页签 */
  onOpenLane: (lane: AgentSideLaneInfo) => void
  /** 弹层开合（壳据此隐藏 / 恢复网页原生视图） */
  onMenuOpenChange: (open: boolean) => void
}

export function ViewerChrome(props: ViewerChromeProps) {
  const {
    tabs, activeId, width, closingIds, autoFocusToken,
    onSelect, onCloseTab, onClosePanel, expanded, onToggleExpand, expandButtonRef,
    onNewTab, onNewWholeAsk, onOpenLane, onMenuOpenChange,
  } = props

  const [menu, setMenu] = useState<MenuKind>('none')
  const [overflowing, setOverflowing] = useState(false)
  const stripRef = useRef<HTMLDivElement | null>(null)
  const headRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const plusRef = useRef<HTMLButtonElement | null>(null)
  const listBtnRef = useRef<HTMLButtonElement | null>(null)

  const narrow = width > 0 && width < NARROW_WIDTH
  const activeTab = tabs.find((t) => t.id === activeId) ?? null
  const closing = new Set(closingIds)

  /* ------ 溢出采样：只按实测宽度判，不按数量（4 个长标题也会溢出） ------ */
  useLayoutEffect(() => {
    const el = stripRef.current
    if (!el) {
      setOverflowing(false)
      return
    }
    const measure = () => {
      const widths = Array.from(el.children).map((c) => (c as HTMLElement).offsetWidth)
      setOverflowing(stripOverflow(widths, el.clientWidth, 1).overflowing)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [tabs, narrow])

  /* ------ 弹层开合：外部点击 / Esc ------ */
  useEffect(() => {
    onMenuOpenChange(menu !== 'none')
  }, [menu, onMenuOpenChange])

  useEffect(() => {
    if (menu === 'none') return
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (menuRef.current?.contains(t) || t.closest('[data-viewer-menu-trigger="1"]'))) return
      setMenu('none')
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setMenu('none')
      const back = menu === 'ask' ? plusRef.current : menu === 'tablist' ? (narrow ? listBtnRef.current : listBtnRef.current) : plusRef.current
      back?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu, narrow])

  // 弹层打开：焦点进第一项（菜单可键盘走完）
  useEffect(() => {
    if (menu === 'none') return
    const el = menuRef.current
    const first = el?.querySelector<HTMLElement>('[role="menuitem"], [data-menu-row="1"]')
    first?.focus({ preventScroll: true })
  }, [menu])

  /* ------ 面板打开：焦点进当前页签 / `+`（§9 a11y） ------ */
  useEffect(() => {
    if (autoFocusToken <= 0) return
    const target = activeTab ? tabRefs.current[activeTab.id] : plusRef.current
    target?.focus({ preventScroll: true })
    // 只在「打开面板」这一拍执行；切换页签时焦点由点击自己带走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocusToken])

  // 当前页签滚进视野（8+ 页签时靠它找回来）
  useEffect(() => {
    if (!activeId) return
    tabRefs.current[activeId]?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [activeId, tabs.length])

  const onStripKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (tabs.length === 0) return
    const idx = tabs.findIndex((t) => t.id === activeId)
    const len = tabs.length
    let next = -1
    if (e.key === 'ArrowRight') next = idx < 0 ? 0 : (idx + 1) % len
    else if (e.key === 'ArrowLeft') next = idx <= 0 ? len - 1 : idx - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = len - 1
    else return
    e.preventDefault()
    const id = tabs[next]?.id
    if (!id) return
    onSelect(id)
    tabRefs.current[id]?.focus({ preventScroll: true })
  }, [tabs, activeId, onSelect])

  const openMenu = (kind: Exclude<MenuKind, 'none'>) => {
    const next = menu === kind ? 'none' : kind
    // 打开这一拍就通知壳收起网页原生视图（不能等 effect：晚一帧菜单就会被切掉一截）
    if (next !== 'none') onMenuOpenChange(true)
    setMenu(next)
  }

  /* ------------------------------ 页签按钮 ------------------------------ */

  const renderTab = (tab: ViewerTab, forList = false) => {
    const active = tab.id === activeId
    const isClosing = closing.has(tab.id)
    const title = tabTitleOf(tab)
    /** 生成中的文件占位禁关（旧工件栏口径）：完成后由壳原地转正，关掉会让页签「自己又冒出来」 */
    const canClose = !(tab.type === 'file' && tab.generating)
    if (forList) {
      return (
        <div
          key={tab.id}
          role="presentation"
          className={`group flex items-center rounded-[5px] ${active ? 'bg-[var(--bg-selected)]' : 'hover:bg-[var(--bg-hover)]'} ${isClosing ? 'kb-item-out pointer-events-none' : ''}`}
        >
          <button
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={-1}
            data-menu-row="1"
            data-tip={title}
            onClick={() => { setMenu('none'); onSelect(tab.id) }}
            className={`flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[5px] pl-2 text-left text-[11.5px] ${active ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}
          >
            <span className={active ? 'text-[var(--accent)]' : ''}><TabIcon tab={tab} /></span>
            <span className="min-w-0 flex-1 truncate">{title}</span>
          </button>
          {canClose && (
            <button
              type="button"
              aria-label={`关闭 ${title}`}
              data-tip="关闭页签"
              tabIndex={-1}
              onClick={() => onCloseTab(tab.id)}
              className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            >
              <X size={10} />
            </button>
          )}
        </div>
      )
    }
    return (
      <div
        key={tab.id}
        role="presentation"
        className={`group relative flex h-7 min-w-0 shrink-0 items-center overflow-hidden rounded-[5px] transition-colors ${
          active ? 'max-w-[190px] bg-[var(--bg-primary)]' : 'max-w-[156px] hover:bg-[var(--bg-hover)]'
        } ${isClosing ? 'kb-item-out pointer-events-none' : 'kb-item-in'}`}
      >
        <button
          ref={(node) => { tabRefs.current[tab.id] = node }}
          id={`rv-tab-${tab.id}`}
          type="button"
          role="tab"
          aria-selected={active}
          aria-controls={`rv-panel-${tab.id}`}
          tabIndex={active ? 0 : -1}
          data-tip={title}
          onClick={() => onSelect(tab.id)}
          className={`flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[5px] pl-2 pr-1 text-left text-[11.5px] ${active ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}
        >
          <span className={active ? 'text-[var(--accent)] [&>*]:opacity-100' : ''}><TabIcon tab={tab} /></span>
          <span className="min-w-0 truncate">{title}</span>
        </button>
        {canClose && (
          <button
            type="button"
            aria-label={`关闭 ${title}`}
            data-tip="关闭页签"
            tabIndex={active ? 0 : -1}
            onClick={() => onCloseTab(tab.id)}
            className={`mr-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded text-[var(--text-muted)] transition-opacity hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] group-hover:opacity-100 group-focus-within:opacity-100 ${active ? 'opacity-100' : 'opacity-0'}`}
          >
            <X size={10} />
          </button>
        )}
        {/* 当前页签下划线：静态 2px（不新增 keyframes；切换由内容 .kb-view-in 承担） */}
        {active && (
          <span aria-hidden className="pointer-events-none absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-[var(--accent)]" />
        )}
      </div>
    )
  }

  /* ------------------------------ 头部 ------------------------------ */

  const iconBtnCls = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'

  const plusButton = (
    <button
      ref={plusRef}
      type="button"
      data-viewer-menu-trigger="1"
      aria-haspopup="menu"
      aria-expanded={menu === 'plus' || menu === 'ask'}
      aria-label="新建页签"
      data-tip="新建页签"
      onClick={() => openMenu('plus')}
      className={iconBtnCls}
    >
      <Plus size={14} />
    </button>
  )

  const closePanelButton = (
    <button
      type="button"
      aria-label="关闭面板"
      data-tip="关闭面板"
      onClick={onClosePanel}
      className={`${iconBtnCls} text-[var(--text-muted)]`}
    >
      <X size={14} />
    </button>
  )

  /**
   * 全屏（⤢）：把查看器铺满整个 AI 教学模块区域（含左栏）。
   * `aria-pressed` 而不是 `aria-expanded` —— 这是开关态，不是「展开某个菜单」。
   */
  const expandButton = (
    <button
      ref={expandButtonRef}
      type="button"
      aria-label={expanded ? '退出全屏' : '全屏'}
      aria-pressed={expanded}
      data-tip={expanded ? '退出全屏（Esc）' : '全屏'}
      onClick={onToggleExpand}
      className={iconBtnCls}
    >
      {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
    </button>
  )

  const listButton = (
    <button
      ref={listBtnRef}
      type="button"
      data-viewer-menu-trigger="1"
      aria-haspopup="dialog"
      aria-expanded={menu === 'tablist'}
      aria-label="全部页签"
      data-tip="全部页签"
      onClick={() => openMenu('tablist')}
      className={`${iconBtnCls} ${narrow || overflowing ? '' : 'hidden'}`}
    >
      <ChevronDown size={12} />
    </button>
  )

  return (
    <div
      ref={headRef}
      className="relative flex h-9 shrink-0 items-center gap-0.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-1.5"
    >
      {narrow ? (
        activeTab ? (
          <button
            type="button"
            data-viewer-menu-trigger="1"
            aria-haspopup="dialog"
            aria-expanded={menu === 'tablist'}
            aria-label={`切换页签：${tabTitleOf(activeTab)}`}
            data-tip={tabTitleOf(activeTab)}
            onClick={() => openMenu('tablist')}
            className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[5px] px-1.5 text-left hover:bg-[var(--bg-hover)]"
          >
            <span className="text-[var(--accent)] [&>*]:opacity-100"><TabIcon tab={activeTab} size={13} /></span>
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--text-primary)]">{tabTitleOf(activeTab)}</span>
            <ChevronDown size={11} className="shrink-0 text-[var(--text-muted)]" />
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate px-1.5 text-[11px] text-[var(--text-muted)]">没有打开的页签</span>
        )
      ) : (
        <div
          ref={stripRef}
          role="tablist"
          aria-label="右侧页签"
          onKeyDown={onStripKeyDown}
          className="flex min-w-0 flex-1 items-center gap-px overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={overflowing ? {
            maskImage: 'linear-gradient(to right, #000 calc(100% - 18px), transparent)',
            WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 18px), transparent)',
          } : undefined}
        >
          {tabs.length === 0
            ? <span className="truncate px-1.5 text-[11px] text-[var(--text-muted)]">没有打开的页签</span>
            : tabs.map((t) => renderTab(t))}
        </div>
      )}

      {!narrow && listButton}
      {plusButton}
      {expandButton}
      {closePanelButton}

      {/* ---------- 浮层：新建菜单 / 全部页签 / 旁问历史 ---------- */}
      {menu !== 'none' && (
        <div ref={menuRef} className="absolute top-full right-1 z-50">
          {menu === 'plus' && (
            <div
              role="menu"
              aria-label="新建页签"
              className="kb-pop absolute right-0 w-[184px] origin-top-right rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-1 shadow-[var(--tip-shadow)]"
              onKeyDown={(e) => {
                if (moveMenuFocus(menuRef.current, e.key)) e.preventDefault()
                else if (e.key === 'Escape') { e.stopPropagation(); setMenu('none'); plusRef.current?.focus() }
              }}
            >
              <div className="px-2 py-1 text-[10.5px] text-[var(--text-muted)]">新建页签</div>
              {VIEWER_NEW_TAB_ORDER.map(({ type, label }) => {
                const Icon = TYPE_ICONS[type]
                return (
                  <button
                    key={type}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() => {
                      setMenu('none')
                      if (type === 'ask') setMenu('ask')
                      else onNewTab(type)
                    }}
                    className="flex h-[30px] w-full items-center gap-2 rounded-[5px] px-2 text-left text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus:bg-[var(--bg-hover)] focus:text-[var(--text-primary)] focus:outline-none"
                  >
                    <Icon size={14} className="shrink-0 text-[var(--text-muted)]" />
                    {label}
                  </button>
                )
              })}
            </div>
          )}

          {menu === 'tablist' && (
            <div
              role="dialog"
              aria-label="全部页签"
              className="kb-pop absolute right-0 w-[236px] max-h-[330px] overflow-y-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-1 shadow-[var(--tip-shadow)]"
              onKeyDown={(e) => {
                if (moveMenuFocus(menuRef.current, e.key)) e.preventDefault()
                else if (e.key === 'Escape') { e.stopPropagation(); setMenu('none') }
              }}
            >
              <div className="px-2 py-1 text-[10.5px] text-[var(--text-muted)]">页签 · {tabs.length}</div>
              <div role="tablist" aria-label="右侧页签" aria-orientation="vertical" className="flex flex-col gap-px">
                {tabs.length === 0
                  ? <div className="px-2 py-3 text-center text-[11px] text-[var(--text-muted)]">没有打开的页签。</div>
                  : tabs.map((t) => renderTab(t, true))}
              </div>
            </div>
          )}

          {menu === 'ask' && (
            <AskHistoryMenu
              onBack={() => { setMenu('plus'); plusRef.current?.focus({ preventScroll: true }) }}
              onNewWhole={() => { setMenu('none'); onNewWholeAsk() }}
              onOpenLane={(lane) => {
                setMenu('none')
                onOpenLane(lane)
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}

/** 零页签空态卡（动作入口是头部那枚 `+`，卡里不再重复一枚会「猜错类型」的按钮） */
export function ViewerEmptyCard() {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="kb-view-fade flex w-full max-w-[300px] flex-col items-center gap-2 rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-[18px] text-center">
        <NotebookPen size={24} strokeWidth={1.5} className="text-[var(--text-muted)]" />
        <div className="text-[12.5px] font-medium text-[var(--text-primary)]">没有打开的页签</div>
        <div className="text-[11px] leading-relaxed text-[var(--text-muted)]">
          用右上角的 <span className="text-[var(--text-secondary)]">+</span> 新建网页、笔记、电子书或旁问。
        </div>
      </div>
    </div>
  )
}
