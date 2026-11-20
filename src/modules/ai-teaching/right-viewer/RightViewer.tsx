/**
 * AI 教学 · 右侧查看器外壳（四页签 / overlay 定位 / 拖宽 / 持久化 / 动效）
 *
 * 方案：`docs/ai-teaching-right-viewer-plan.md` §3（交互定稿）/ §5（持久化）/ §9（动效与 a11y）
 * 内核决策：C5 四页签（网页 / 笔记 / 书架 / 旁问）· C6 恢复页签但懒加载 · C7 overlay 可调宽
 *          · D5 懒加载 + 关页签卸载、**切页签只隐藏不卸载**
 *
 * 这个文件只做「壳」：定位 / 页签条 / 宽度 / 持久化 / 保活 / 网页视图的可见性上报。
 * 四个 pane 的业务都在各自文件里；壳只按 `paneContracts.ts`（冻结契约）传公共上下文，
 * 因此任何一行 pane 迟到都不会把壳拖成半成品。
 */

import {
  Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState,
  type ComponentType, type JSX, type KeyboardEvent as ReactKeyboardEvent,
  type LazyExoticComponent, type ReactNode,
} from 'react'
import { BookOpen, Globe, MessageCircle, NotebookPen, X } from 'lucide-react'
import { webPaneHideAll } from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'
import {
  VIEWER_LS_KEYS, VIEWER_TABS, isViewerTabKey,
  type AskPaneProps, type BooksPaneProps, type NotesPaneProps,
  type PaneOpenRequest, type ViewerTabKey, type WebPaneProps,
} from './paneContracts'
import { migrateRailTab, shouldHideWebViewer, viewerWidthStyle } from './rightViewerPure'
import { useViewerWidth } from './viewerResize'

/* ============================== 页签图标 ============================== */

/** 内联图标（顺序与 VIEWER_TABS 一致；不做 hover 下拉 / 右键菜单，§3.2） */
const TAB_ICONS: Readonly<Record<ViewerTabKey, ComponentType<{ size?: number; className?: string }>>> = {
  web: Globe,
  notes: NotebookPen,
  books: BookOpen,
  ask: MessageCircle,
}

/* ============================== pane 装载 ============================== */

/**
 * pane 的 props 以 `paneContracts.ts` 为准，这里只借用 React 的组件位。
 * 用 `any` 是刻意的：四个 pane 由并行线各自声明 props 类型，壳若写死一份
 * 泛型参数，反而会在它们调整可选字段时把壳一起卡死（契约文件才是唯一真相源）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseComponent = ComponentType<any>

/**
 * 四个 pane 由并行线实现，导出形态（默认 / 具名）在契约里没有约定。
 * 这里统一归一成 lazy 需要的 `{ default }` —— 否则「模块在、导出名不对」会表现为
 * 页签永远空态且编译不报错，是最难查的一类接线事故。
 */
function lazyPane(load: () => Promise<unknown>, named: string): LazyExoticComponent<LooseComponent> {
  return lazy<LooseComponent>(async () => {
    const mod = (await load()) as Record<string, unknown>
    const picked = (mod.default ?? mod[named]) as LooseComponent | undefined
    return { default: picked ?? (() => null) }
  })
}

const WebPane = lazyPane(() => import('./WebPane'), 'WebPane')
const NotesPane = lazyPane(() => import('./NotesPane'), 'NotesPane')
const BooksPane = lazyPane(() => import('./BooksPane'), 'BooksPane')
const AskPane = lazyPane(() => import('./AskPane'), 'AskPane')

function PaneLoading(): JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center text-[11px] text-[var(--text-secondary)]">
      载入中…
    </div>
  )
}

/**
 * 减少动效偏好。开合过渡写在内联 style 里（见根节点），
 * Tailwind 的变体压不过内联样式，所以这里自己订阅一次媒体查询。
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/**
 * 一个页签的宿主槽。
 *
 * 保活（D5）靠 `display:none` 而不是卸载：切回来时组件状态、编辑中的正文、
 * 阅读位置、旁问滚动全在。切页签的动效复用 `.kb-view-in`：元素从 `display:none`
 * 变回可见时 CSS 动画会重新开始（隐藏期间动画被取消），因此不需要 remount、也不需要
 * 手工重挂类名；时长按 §3.2 定稿收到 180ms（`.kb-view-in` 默认是 --dur-view 260ms，
 * 那个档位留给大区切换）。
 */
function PaneSlot({ tab, active, children }: { tab: ViewerTabKey; active: boolean; children: ReactNode }): JSX.Element {
  return (
    <div
      id={`rv-panel-${tab}`}
      role="tabpanel"
      aria-labelledby={`rv-tab-${tab}`}
      aria-hidden={!active}
      className="kb-view-in absolute inset-0 flex min-h-0 flex-col motion-reduce:animate-none"
      style={{ display: active ? 'flex' : 'none', animationDuration: '180ms' }}
    >
      {/* Suspense 边界必须**逐页签一个**：共用一个边界时，任何一个 pane 首次懒加载挂起
          都会把已挂载的兄弟一起撤下，保活（D5）就白做了。 */}
      <Suspense fallback={<PaneLoading />}>{children}</Suspense>
    </div>
  )
}

/* ============================== 读持久页签 ============================== */

function readLs(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/**
 * 首次读页签：`aiTeach.rightTab` 优先；没有就迁移旧右栏的 `aiTeach.railTab`
 * （`lanes → ask`，`progress / sources → web`）。**只读不删旧键**，一个版本后再清。
 */
function readInitialTab(): ViewerTabKey {
  const current = readLs(VIEWER_LS_KEYS.tab)
  if (current !== null) return migrateRailTab(current)
  return migrateRailTab(readLs(VIEWER_LS_KEYS.legacyRailTab))
}

/* ============================== 外壳 ============================== */

export interface RightViewerProps {
  open: boolean
  onClose: () => void
  rootId: string
  sessionId: string
  sessionTitle: string
  workspaceId: string
  /** 外部一次性请求：切到某页签并打开内容；seq 递增（同路径重复点击也要触发） */
  request?: { tab: ViewerTabKey; seq: number; url?: string; relPath?: string; name?: string; ask?: unknown } | null
  onOpenInEditor: (relPath: string) => void
  onOpenFullscreen?: (relPath: string) => void
  onQuote: (text: string) => void
  onFloat: (laneId: string) => void
  anchorMessageId?: string
  onTabChange?: (tab: ViewerTabKey) => void
  /**
   * 面板实际占宽上报（px；关闭为 0）。
   * 追加的可选字段：方案 §3.1 要求中栏用 `padding-right` 跟着面板同一条曲线让位，
   * 壳是宽度的唯一持有者，不报出来调用方就只能猜。
   */
  onWidthChange?: (width: number) => void
}

export function RightViewer(props: RightViewerProps): JSX.Element {
  const {
    open, onClose, rootId, sessionId, sessionTitle, workspaceId,
    request, onOpenInEditor, onOpenFullscreen, onQuote, onFloat,
    anchorMessageId, onTabChange, onWidthChange,
  } = props

  const [activeTab, setActiveTab] = useState<ViewerTabKey>(readInitialTab)
  /** 访问过的页签（首次访问才挂载；之后一直保活 —— D5） */
  const [visited, setVisited] = useState<ViewerTabKey[]>(() => [activeTab])
  /** 面板至少打开过一次才挂 pane：避免冷启动就为网页页签建原生视图（C6 懒加载） */
  const [openedOnce, setOpenedOnce] = useState(open)

  const { width, dragging, beginDrag, reset } = useViewerWidth({ open })
  const reducedMotion = usePrefersReducedMotion()

  const rootRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Partial<Record<ViewerTabKey, HTMLButtonElement | null>>>({})
  /** 同一 seq 不重复处理（StrictMode 双跑 / 父级重渲染） */
  const lastReqSeqRef = useRef<number>(-1)
  const lsWarnedRef = useRef(false)
  const onTabChangeRef = useRef(onTabChange)
  onTabChangeRef.current = onTabChange
  const onWidthChangeRef = useRef(onWidthChange)
  onWidthChangeRef.current = onWidthChange
  /** 当前页签的同步副本：selectTab 里要判「是否真的变了」，又不能读 useState 的异步值 */
  const activeTabRef = useRef(activeTab)
  activeTabRef.current = activeTab

  // 打开时把焦点交给页签条（§9：面板打开 → 焦点进页签条）
  useEffect(() => {
    if (open) tabRefs.current[activeTab]?.focus({ preventScroll: true })
  }, [open, activeTab])

  useEffect(() => {
    if (open) setOpenedOnce(true)
  }, [open])

  // 占宽上报（关闭报 0）：中栏让位与查看器宽度走同一条曲线
  useEffect(() => {
    onWidthChangeRef.current?.(open ? width : 0)
  }, [open, width])

  /**
   * 切页签：状态 + 挂载 + 持久化 + 回调，四件事只在这里发生一次。
   * 副作用**不放进 setState 的 updater**：updater 会被 React 重跑（StrictMode / 并发），
   * 那样 localStorage 与 onTabChange 都会重复触发。
   */
  const selectTab = useCallback((tab: ViewerTabKey) => {
    setVisited((prev) => (prev.includes(tab) ? prev : [...prev, tab]))
    if (activeTabRef.current === tab) return
    activeTabRef.current = tab
    setActiveTab(tab)
    try {
      window.localStorage.setItem(VIEWER_LS_KEYS.tab, tab)
    } catch {
      if (!lsWarnedRef.current) {
        lsWarnedRef.current = true
        showToast({ type: 'warning', message: '页签记忆写入失败', detail: '下次打开会回到上次保存成功的页签' })
      }
    }
    onTabChangeRef.current?.(tab)
  }, [])

  // 外部一次性请求：先切页签（内容由 pane 按 seq 自己消费；壳不越权改 pane 状态）
  useEffect(() => {
    if (!request) return
    if (request.seq === lastReqSeqRef.current) return
    lastReqSeqRef.current = request.seq
    if (!isViewerTabKey(request.tab)) return
    selectTab(request.tab)
  }, [request, selectTab])

  /**
   * 网页原生视图可见性上报：原生视图永远盖在 DOM 之上，
   * 所以「面板关了」或「切到别的页签」都必须 hide；重新可见时由 WebPane 自己 show，
   * 壳不越权 show（否则会出现「壳以为该显示、pane 认为还没有页面」的白块）。
   */
  useEffect(() => {
    if (!shouldHideWebViewer(open, activeTab)) return
    void webPaneHideAll().catch(() => {
      /* 隐藏失败不打扰用户：下次切页签 / 关闭还会再发一次 */
    })
  }, [open, activeTab])

  /** 请求 → pane 的 props（url / relPath / name 分离，避免每个 pane 都去解析联合体） */
  const paneRequest = useMemo<PaneOpenRequest | null>(() => {
    if (!request) return null
    return { seq: request.seq, url: request.url, relPath: request.relPath, name: request.name }
  }, [request])

  /**
   * 旁问请求：AskPane 只认 `request.kind`（`create / open / conversation / whole / new`）
   * 外加 `laneId` / `anchorMessageId`。字符串形式原样透传；没带 ask 就保留空 kind，
   * 让 pane 只停在列表（不做「自动新开一条整段支线」这种没被要求的副作用）。
   */
  const askRequest = useMemo<{ kind: string; [k: string]: unknown } | null>(() => {
    if (!request || request.tab !== 'ask') return null
    const raw = request.ask
    if (typeof raw === 'string') return { kind: raw.trim() }
    const extra = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const kind = typeof extra.kind === 'string' ? extra.kind : ''
    return { ...extra, kind }
  }, [request])

  const reqFor = (tab: ViewerTabKey): PaneOpenRequest | null =>
    request?.tab === tab ? paneRequest : null

  /**
   * 页签条键盘导航（role=tablist 的标配）。
   * 配合 roving tabindex（只有激活页签是 Tab 可达）：不实现方向键的话，
   * 另外三个页签用键盘就永远进不去。
   */
  const onTablistKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const len = VIEWER_TABS.length
    const idx = VIEWER_TABS.findIndex((t) => t.key === activeTab)
    let next = -1
    if (e.key === 'ArrowRight') next = (idx + 1) % len
    else if (e.key === 'ArrowLeft') next = (idx - 1 + len) % len
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = len - 1
    else return
    e.preventDefault()
    const target = VIEWER_TABS[next].key
    selectTab(target)
    tabRefs.current[target]?.focus({ preventScroll: true })
  }

  const webProps: WebPaneProps = {
    rootId, sessionId, sessionTitle, workspaceId,
    width, active: activeTab === 'web', open,
    request: reqFor('web'),
  }
  const notesProps: NotesPaneProps = {
    rootId, sessionId, sessionTitle, workspaceId,
    width, active: activeTab === 'notes', open,
    request: reqFor('notes'),
    onOpenInEditor,
  }
  const booksProps: BooksPaneProps = {
    rootId, sessionId, sessionTitle, workspaceId,
    width, active: activeTab === 'books', open,
    request: reqFor('books'),
    onOpenFullscreen,
  }
  const askProps: AskPaneProps = {
    rootId, sessionId, sessionTitle, workspaceId,
    width, active: activeTab === 'ask', open,
    request: askRequest,
    requestSeq: request?.seq ?? 0,
    anchorMessageId,
    onQuote,
    onFloat,
  }

  const style = viewerWidthStyle(open, width)

  return (
    <div
      ref={rootRef}
      data-right-viewer="1"
      inert={!open}
      className={`absolute top-0 right-0 bottom-0 z-30 flex flex-col overflow-hidden bg-[var(--bg-primary)] ${
        open ? 'border-l border-[var(--border-color)] shadow-[-8px_0_24px_-12px_rgba(0,0,0,0.35)]' : 'shadow-none'
      }`}
      style={{
        ...style,
        // 开合过渡与拖拽互斥：拖拽跟手必须零延迟；其余走既有令牌（--dur-std / --ease-kb）。
        // 减少动效偏好下直接吸附（内联样式优先级高于 Tailwind 变体，所以在 JS 里判一次）。
        transition: dragging || reducedMotion
          ? 'none'
          : 'width var(--dur-std) var(--ease-kb), box-shadow var(--dur-std) var(--ease-kb)',
      }}
    >
      {/* 左缘手柄：8px 热区、内贴（不外探避免与自己那条 border-l 形成双线） */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖拽调整宽度，双击复位"
        data-tip="拖拽调整宽度，双击复位"
        className="group absolute top-0 bottom-0 left-0 z-10"
        style={{ width: 8, cursor: 'col-resize' }}
        onPointerDown={beginDrag}
        onDoubleClick={reset}
      >
        <div
          className={`absolute inset-y-0 left-0 w-px transition-colors ${
            dragging ? 'bg-[var(--accent)]' : 'bg-transparent group-hover:bg-[var(--accent)]/40'
          }`}
        />
      </div>

      {/* 页签条：整条 h-8 级；激活态靠底色 + 主题色，不额外加说明文字（铁律 26） */}
      <div
        role="tablist"
        aria-label="右侧查看器"
        onKeyDown={onTablistKeyDown}
        className="flex h-9 shrink-0 items-center gap-0.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-1"
      >
        {VIEWER_TABS.map(({ key, label }) => {
          const active = activeTab === key
          const Icon = TAB_ICONS[key]
          return (
            <button
              key={key}
              ref={(node) => { tabRefs.current[key] = node }}
              id={`rv-tab-${key}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`rv-panel-${key}`}
              tabIndex={active ? 0 : -1}
              onClick={() => selectTab(key)}
              className={`flex h-7 items-center gap-1.5 rounded-[5px] px-2 text-xs transition-colors ${
                active
                  ? 'bg-[var(--bg-primary)] text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Icon size={13} />
              {label}
            </button>
          )
        })}

        <button
          type="button"
          aria-label="关闭查看器"
          data-tip="关闭查看器"
          onClick={onClose}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-[5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <X size={14} />
        </button>
      </div>

      {/* 页签内容：绝对铺满、父级高度固定，切换不跳动 */}
      <div className="relative min-h-0 flex-1">
        {openedOnce && (
          <>
            {visited.includes('web') && (
              <PaneSlot tab="web" active={activeTab === 'web'}>
                <WebPane {...webProps} />
              </PaneSlot>
            )}
            {visited.includes('notes') && (
              <PaneSlot tab="notes" active={activeTab === 'notes'}>
                <NotesPane {...notesProps} />
              </PaneSlot>
            )}
            {visited.includes('books') && (
              <PaneSlot tab="books" active={activeTab === 'books'}>
                <BooksPane {...booksProps} />
              </PaneSlot>
            )}
            {visited.includes('ask') && (
              <PaneSlot tab="ask" active={activeTab === 'ask'}>
                <AskPane {...askProps} />
              </PaneSlot>
            )}
          </>
        )}
      </div>
    </div>
  )
}
