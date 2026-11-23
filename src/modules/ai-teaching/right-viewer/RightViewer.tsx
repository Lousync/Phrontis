/**
 * AI 教学 · 右侧活动栏外壳（动态多页签 / overlay 定位 / 拖宽 / 持久化 / 保活 / 动效）
 *
 * 方案：`tmp/ai-teach-right-viewer/PLAN.md`（四固定页签 → 动态实例页签）
 *       + `docs/ai-teaching-right-viewer-plan.md` §3（交互）/ §5（持久化）/ §9（动效与 a11y）
 * 内核决策：C7 overlay 可调宽 · D5 懒加载 + 关页签卸载、**切页签只隐藏不卸载**（本版加保活窗口）
 *
 * 这个文件只做「壳」：页签集合 / 页签条 / 宽度 / 持久化 / 保活窗口 / 去重 / 网页视图可见性。
 * 四个 kind 的业务都在各自 pane 里；壳只按 `paneContracts.ts`（冻结契约）传公共上下文。
 *
 * 三条新纪律（本版新增，改之前先读）：
 *   1. **一个笔记 / 电子书页签 = 一个文件 / 一本书**；同文件再去点 = 聚焦已有页签，不新开
 *      （两个实例各持一份 mtime 基线，保存必然互相踩，见 PLAN §7.2 / §7.3）；
 *   2. **保活窗口**：同时挂载 ≤6 个 pane，超出按 LRU 卸载；脏笔记与运行中的旁问永不淘汰；
 *   3. **旁问草稿**：`laneId === null` 的旁问页签不持久化、关掉即丢，首问发出后才落库。
 */

import {
  Suspense, lazy, useCallback, useEffect, useMemo, useReducer, useRef, useState,
  type ComponentType, type JSX, type LazyExoticComponent, type ReactNode,
} from 'react'
import { isSessionRunning, subscribeAssistantRunState } from '../../../lib/assistantRunStore'
import { webPaneHideAll } from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'
import type { AgentSideLaneInfo } from '../../../types'
import {
  VIEWER_LS_KEYS, isViewerTabKey,
  type PaneOpenRequest, type ViewerPaneType,
} from './paneContracts'
import { shouldHideWebViewer, viewerWidthStyle } from './rightViewerPure'
import { useViewerWidth } from './viewerResize'
import { ViewerChrome, ViewerEmptyCard } from './ViewerChrome'
import { createSessionNote } from './noteFileOps'
import {
  VIEWER_LIVE_WINDOW, activateTab, appendTab, closeTabById, findAskTabByLane, findBooksTabByBook,
  findDraftTab, findNotesTab, findWebTab, firstTabOfType, inferNotesFileKind, makeAskTab,
  makeBooksTab, makeNotesTab, makeWebTab, migrateLegacyViewerState, parseViewerState,
  selectLiveIds, serializeViewerState, stemOf, tabById, updateTab,
  type AskDraft, type NotesFileKind, type ViewerStateV2, type ViewerTab,
} from './viewerTabs'

/* ============================== pane 装载 ============================== */

/**
 * pane 的 props 以 `paneContracts.ts` 为准，这里只借用 React 的组件位。
 * 用 `any` 是刻意的：pane 的 props 由契约文件定义，壳若写死一份泛型参数，
 * 反而会在追加可选字段时把壳一起卡死（契约文件才是唯一真相源）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseComponent = ComponentType<any>

/**
 * pane 导出形态（默认 / 具名）在契约里没有约定。这里统一归一成 lazy 需要的 `{ default }` ——
 * 否则「模块在、导出名不对」会表现为页签永远空态且编译不报错，是最难查的一类接线事故。
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

/** 减少动效偏好。开合过渡写在内联 style 里（见根节点），Tailwind 变体压不过它。 */
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
 * 保活靠 `display:none` 而不是卸载：切回来时组件状态、编辑中的正文、阅读位置、旁问滚动全在。
 * 切页签的动效复用 `.kb-view-in`：元素从 `display:none` 变回可见时 CSS 动画会重新开始
 * （隐藏期间动画被取消），因此不需要 remount、也不需要手工重挂类名；时长收到 180ms。
 */
function PaneSlot({ tabId, active, children }: { tabId: string; active: boolean; children: ReactNode }): JSX.Element {
  return (
    <div
      id={`rv-panel-${tabId}`}
      role="tabpanel"
      aria-labelledby={`rv-tab-${tabId}`}
      aria-hidden={!active}
      className="kb-view-in absolute inset-0 flex min-h-0 flex-col motion-reduce:animate-none"
      style={{ display: active ? 'flex' : 'none', animationDuration: '180ms' }}
    >
      {/* Suspense 边界必须**逐页签一个**：共用一个边界时，任何一个 pane 首次懒加载挂起
          都会把已挂载的兄弟一起撤下，保活就白做了。 */}
      <Suspense fallback={<PaneLoading />}>{children}</Suspense>
    </div>
  )
}

/* ============================== 启动 / 持久化 ============================== */

function readLs(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function readJson(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function newTabId(): string {
  try {
    return `t_${crypto.randomUUID()}`
  } catch {
    return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  }
}

/**
 * 首帧页签：`aiTeach.rightTabs.v2` 优先；没有就做一次性迁移
 * （`aiTeach.rightTab` + `aiTeach.webTabs.<sid>` + 更旧的 `aiTeach.railTab`，只读不删）。
 */
function loadBootState(sessionId: string): ViewerStateV2 {
  const persisted = parseViewerState(readJson(readLs(VIEWER_LS_KEYS.tabsV2)))
  if (persisted) return persisted
  return migrateLegacyViewerState({
    rightTab: readLs(VIEWER_LS_KEYS.tab),
    railTab: readLs(VIEWER_LS_KEYS.legacyRailTab),
    legacyWebTabs: sessionId ? readJson(readLs(VIEWER_LS_KEYS.webTabs(sessionId))) : null,
    newId: () => newTabId(),
  })
}

function wholeDraft(sessionId: string, sessionTitle: string): AskDraft {
  return {
    parentSessionId: sessionId,
    parentTitle: sessionTitle,
    anchorMessageId: '',
    sideScope: 'conversation',
    anchorOrdinal: null,
    excerpt: '',
  }
}

function numberOrNull(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/* ============================== 外壳 ============================== */

export interface RightViewerProps {
  open: boolean
  onClose: () => void
  rootId: string
  sessionId: string
  sessionTitle: string
  workspaceId: string
  /** 外部一次性请求：打开并聚焦某类内容；seq 递增（同路径重复点击也要触发） */
  request?: { tab: ViewerPaneType; seq: number; url?: string; relPath?: string; name?: string; ask?: unknown } | null
  onOpenInEditor: (relPath: string) => void
  onOpenFullscreen?: (relPath: string) => void
  onQuote: (text: string) => void
  onFloat: (laneId: string) => void
  anchorMessageId?: string
  onTabChange?: (tab: ViewerPaneType) => void
  /**
   * 面板实际占宽上报（px；关闭为 0）。
   * 中栏用 `padding-right` 跟着同一条曲线让位，壳是宽度的唯一持有者。
   */
  onWidthChange?: (width: number) => void
  /**
   * 中栏 reserve（`中栏左缘 + 中栏最小可读宽`，由页面实测后传入）。
   * 缺省 = 旧口径 `innerWidth - 300`；传入后窗口过窄时查看器降到紧凑下限 300。
   */
  reserve?: number
}

export function RightViewer(props: RightViewerProps): JSX.Element {
  const {
    open, onClose, rootId, sessionId, sessionTitle, workspaceId,
    request, onOpenInEditor, onOpenFullscreen, onQuote, onFloat,
    anchorMessageId, onTabChange, onWidthChange, reserve,
  } = props

  /* ------ 首帧页签（迁移只跑一次） ------ */
  const bootRef = useRef<ViewerStateV2 | null>(null)
  if (bootRef.current === null) bootRef.current = loadBootState(sessionId)
  const [tabs, setTabs] = useState<ViewerTab[]>(bootRef.current.tabs)
  const [activeId, setActiveId] = useState<string | null>(bootRef.current.activeId)
  /** 面板至少打开过一次才挂 pane：避免冷启动就为网页页签建原生视图 */
  const [openedOnce, setOpenedOnce] = useState(open)
  /** 正在播关闭动效的页签（已从活动态摘掉，视觉上留一拍 ≈190ms） */
  const [closingIds, setClosingIds] = useState<string[]>([])
  /** 脏笔记（保活保护项 + 关闭需 flush） */
  const [dirtyIds, setDirtyIds] = useState<string[]>([])
  /** 网页原生视图可见性令牌：浮层关掉后 bump，让 pane 重新 show */
  const [webSyncToken, setWebSyncToken] = useState(0)
  /**
   * 一次性「请这个页签再打开一次」请求。`seq` 只保证单调递增 —— pane 只认「变了」。
   * 用于：外链换地址、同一文件被重新请求（例如画像文件被删后 ensure 又建回来）。
   */
  const [paneReq, setPaneReq] = useState<{ tabId: string; req: PaneOpenRequest } | null>(null)
  const [focusToken, setFocusToken] = useState(0)
  /** 旁问运行态变化（保活保护项；值只用来驱动重算） */
  const [runTick, bumpRun] = useReducer((x: number) => x + 1, 0)

  const { width, dragging, beginDrag, reset } = useViewerWidth({ open, reserve })
  const reducedMotion = usePrefersReducedMotion()

  const rootRef = useRef<HTMLDivElement>(null)
  /** 状态镜像：异步流程（关页签 flush / 请求处理）必须读「此刻」的页签，不能读闭包里的旧值 */
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  /** 关页签后要清掉的 flush 注册表 */
  const flushRef = useRef(new Map<string, () => Promise<boolean>>())
  const flushRegistrarRef = useRef(new Map<string, (fn: (() => Promise<boolean>) | null) => void>())
  const dirtySetterRef = useRef(new Map<string, (dirty: boolean) => void>())
  /** 每个页签的回调缓存：pane 的 effect 依赖这些函数身份，每渲染换一个新的会造成无谓重跑 */
  const cbCacheRef = useRef(new Map<string, unknown>())
  const closeTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const lastReqSeqRef = useRef<number>(-1)
  /** 一次性请求的 seq（单调递增；只用来让 pane 知道「变了」） */
  const reqSeqRef = useRef(0)
  const lsWarnedRef = useRef(false)
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const sessionTitleRef = useRef(sessionTitle)
  sessionTitleRef.current = sessionTitle
  const rootIdRef = useRef(rootId)
  rootIdRef.current = rootId
  const activeTypeRef = useRef<ViewerPaneType | null>(null)
  const onTabChangeRef = useRef(onTabChange)
  onTabChangeRef.current = onTabChange
  const onWidthChangeRef = useRef(onWidthChange)
  onWidthChangeRef.current = onWidthChange

  const apply = useCallback((nextTabs: ViewerTab[], nextActive: string | null) => {
    tabsRef.current = nextTabs
    activeIdRef.current = nextActive
    setTabs(nextTabs)
    setActiveId(nextActive)
  }, [])

  /** 稳定的每页签回调（同一个页签始终拿到同一个函数身份） */
  const cached = useCallback(<T,>(key: string, make: () => T): T => {
    const hit = cbCacheRef.current.get(key)
    if (hit) return hit as T
    const fn = make()
    cbCacheRef.current.set(key, fn)
    return fn
  }, [])

  /* ------------------------------------------------------------ 打开 / 聚焦 */

  /**
   * 复活「正在播关闭动效」的页签：撤掉待移除定时器 + 从 `closingIds` 摘出。
   *
   * 关页签有 190ms 的视觉留拍，这段窗口里页签**仍在 `tabs` 里**，因此
   * `findWebTab` / `findNotesTab` / `findBooksTabByBook` 依然能命中它；但 `liveIds`
   * 会把 `closingIds` 排除，于是「激活它 → 内容区空白 → 到点被定时器删掉并跳到邻位」，
   * 用户看到的是「点了没反应 + 页签闪一下消失」。凡是激活**已存在**页签的入口，
   * 都必须先复活它，再激活。
   */
  const reviveClosing = useCallback((id: string) => {
    // 浏览器里 setTimeout 的返回值可能是 0，只能判 `undefined`，不能判真值
    const t = closeTimersRef.current.get(id)
    if (t !== undefined) {
      clearTimeout(t)
      closeTimersRef.current.delete(id)
    }
    setClosingIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev))
  }, [])

  const selectTab = useCallback((id: string) => {
    // 必须先复活：同一帧里 `liveIds` 才不会继续把它过滤掉
    reviveClosing(id)
    const r = activateTab(tabsRef.current, id, Date.now())
    apply(r.tabs, id)
  }, [apply, reviveClosing])

  /** 请某个页签「再打开一次」某样东西（地址 / 文件）；seq 单调递增，pane 只认「变了」 */
  const sendPaneReq = useCallback((tabId: string, req: Omit<PaneOpenRequest, 'seq'>) => {
    reqSeqRef.current += 1
    setPaneReq({ tabId, req: { ...req, seq: reqSeqRef.current } })
  }, [])

  /** 打开 / 聚焦网页。**本批网页只允许一个**：已开则聚焦（有 url 就导航）。 */
  const openWeb = useCallback((url?: string): string => {
    const clean = String(url ?? '').trim()
    const existing = findWebTab(tabsRef.current)
    if (existing) {
      if (clean) sendPaneReq(existing.id, { url: clean })
      selectTab(existing.id)
      return existing.id
    }
    const tab = makeWebTab(newTabId(), { url: clean }, Date.now())
    apply(appendTab(tabsRef.current, tab).tabs, tab.id)
    return tab.id
  }, [apply, sendPaneReq, selectTab])

  /** 打开 / 聚焦笔记文件；同文件去重（两个实例各持一份 mtime 基线会互相踩）。 */
  const openNote = useCallback((
    relPath: string,
    meta?: { title?: string; fileKind?: NotesFileKind; ownerSessionId?: string | null },
  ): string => {
    const rel = String(relPath ?? '').replace(/\\/g, '/').trim()
    if (!rel) {
      const existing = firstTabOfType(tabsRef.current, 'notes')
      if (existing) {
        selectTab(existing.id)
        return existing.id
      }
      const tab = makeNotesTab(newTabId(), {}, Date.now())
      apply(appendTab(tabsRef.current, tab).tabs, tab.id)
      return tab.id
    }
    const hit = findNotesTab(tabsRef.current, rel)
    if (hit) {
      selectTab(hit.id)
      return hit.id
    }
    const kind: NotesFileKind = meta?.fileKind ?? inferNotesFileKind(rel)
    const tab = makeNotesTab(newTabId(), {
      relPath: rel,
      fileKind: kind,
      ownerSessionId: meta?.ownerSessionId ?? (kind === 'note' ? null : (sessionIdRef.current || null)),
      title: meta?.title,
    }, Date.now())
    apply(appendTab(tabsRef.current, tab).tabs, tab.id)
    return tab.id
  }, [apply, selectTab])

  /** 打开 / 聚焦一本书；同书去重，不同书可多开。 */
  const openBook = useCallback((relPath: string, name?: string): string => {
    const rel = String(relPath ?? '').replace(/\\/g, '/').trim()
    if (!rel) {
      const shelf = firstTabOfType(tabsRef.current, 'books')
      if (shelf) {
        selectTab(shelf.id)
        return shelf.id
      }
      const tab = makeBooksTab(newTabId(), {}, Date.now())
      apply(appendTab(tabsRef.current, tab).tabs, tab.id)
      return tab.id
    }
    const dup = findBooksTabByBook(tabsRef.current, rel)
    if (dup) {
      selectTab(dup.id)
      return dup.id
    }
    // 优先让「当前书架页签」承载这本书（书架 → 书 → 回书架都在同一个页签里）
    const current = tabById(tabsRef.current, activeIdRef.current)
    const shelfTab = (current && current.type === 'books' && !current.relPath ? current : null)
      ?? [...tabsRef.current].reverse().find((t): t is Extract<ViewerTab, { type: 'books' }> => t.type === 'books' && !t.relPath)
      ?? null
    if (shelfTab) {
      // 书架页签可能正在播关闭动效（仍在 tabs 里）：复用前先复活，否则内容区空白 + 到点被删
      reviveClosing(shelfTab.id)
      const next = updateTab(tabsRef.current, shelfTab.id, {
        relPath: rel,
        name: String(name ?? '').trim(),
        title: String(name ?? '').trim() || stemOf(rel) || '电子书',
      })
      apply(next, shelfTab.id)
      return shelfTab.id
    }
    const tab = makeBooksTab(newTabId(), { relPath: rel, name }, Date.now())
    apply(appendTab(tabsRef.current, tab).tabs, tab.id)
    return tab.id
  }, [apply, reviveClosing, selectTab])

  /** 打开 / 聚焦已落库的旁问（同一 lane 去重）。 */
  const openAskLane = useCallback((lane: AgentSideLaneInfo): string => {
    const hit = findAskTabByLane(tabsRef.current, lane.id)
    if (hit) {
      selectTab(hit.id)
      return hit.id
    }
    const tab = makeAskTab(newTabId(), {
      laneId: lane.id,
      parentSessionId: lane.parentSessionId ?? '',
      parentTitle: lane.parentTitle ?? '',
      title: (lane.title ?? '').trim() || '旁问',
    }, Date.now())
    apply(appendTab(tabsRef.current, tab).tabs, tab.id)
    return tab.id
  }, [apply, selectTab])

  /** 新建旁问草稿页签（同一作用域只留一个未发送草稿）。 */
  const openAskDraft = useCallback((draft: AskDraft): string => {
    const hit = findDraftTab(tabsRef.current, draft)
    if (hit) {
      selectTab(hit.id)
      return hit.id
    }
    const tab = makeAskTab(newTabId(), { draft }, Date.now())
    apply(appendTab(tabsRef.current, tab).tabs, tab.id)
    return tab.id
  }, [apply, selectTab])

  const openWholeDraft = useCallback(() => {
    if (!sessionIdRef.current) {
      showToast({ type: 'warning', message: '先进入一个 AI 教学对话' })
      return
    }
    openAskDraft(wholeDraft(sessionIdRef.current, sessionTitleRef.current))
  }, [openAskDraft])

  /** `+ → 笔记`：先落文件再开页签（一个文件一个页签） */
  const newNote = useCallback(async () => {
    if (!rootIdRef.current || !sessionIdRef.current) {
      showToast({ type: 'warning', message: '先进入一个 AI 教学对话' })
      return
    }
    const made = await createSessionNote(rootIdRef.current, sessionIdRef.current)
    if (!made.ok) {
      showToast({ type: 'error', message: '新建笔记失败', detail: made.error })
      return
    }
    openNote(made.relPath)
  }, [openNote])

  /** `+` 菜单 */
  const onNewTab = useCallback((type: ViewerPaneType) => {
    if (type === 'notes') { void newNote(); return }
    if (type === 'web') { openWeb(); return }
    if (type === 'books') {
      // 同类可多开：每次都新建一个书架页签（具体某本书仍按 relPath 去重）
      const tab = makeBooksTab(newTabId(), {}, Date.now())
      apply(appendTab(tabsRef.current, tab).tabs, tab.id)
      return
    }
    openWholeDraft()
  }, [apply, newNote, openWeb, openWholeDraft])

  /* ------------------------------------------------------------ 页签变更 */

  const setTitle = useCallback((tabId: string, title: string) => {
    const next = String(title ?? '').trim()
    if (!next) return
    const tab = tabById(tabsRef.current, tabId)
    if (!tab || tab.title === next) return
    apply(updateTab(tabsRef.current, tabId, { title: next }), activeIdRef.current)
  }, [apply])

  const patchTab = useCallback((tabId: string, patch: Record<string, unknown>) => {
    const tab = tabById(tabsRef.current, tabId)
    if (!tab) return
    // 值没变就不写：避免「回填同一个 relPath / 标题」把页签数组和持久化都推着走
    const unchanged = Object.keys(patch).every(
      (key) => (tab as unknown as Record<string, unknown>)[key] === patch[key],
    )
    if (unchanged) return
    apply(updateTab(tabsRef.current, tabId, patch), activeIdRef.current)
  }, [apply])

  const registerFlush = useCallback((tabId: string) => {
    let fn = flushRegistrarRef.current.get(tabId)
    if (!fn) {
      fn = (f: (() => Promise<boolean>) | null) => {
        if (f) flushRef.current.set(tabId, f)
        else flushRef.current.delete(tabId)
      }
      flushRegistrarRef.current.set(tabId, fn)
    }
    return fn
  }, [])

  const dirtySetter = useCallback((tabId: string) => {
    let fn = dirtySetterRef.current.get(tabId)
    if (!fn) {
      fn = (dirty: boolean) => {
        setDirtyIds((prev) => (dirty
          ? (prev.includes(tabId) ? prev : [...prev, tabId])
          : prev.filter((id) => id !== tabId)))
      }
      dirtySetterRef.current.set(tabId, fn)
    }
    return fn
  }, [])

  /**
   * 关页签：先 flush 当前笔记（冲突未决 / 保存失败 = 拦住，不静默丢正文），
   * 再把活动页签按「右邻 → 左邻 → 零态」切换，最后播一拍关闭动效再移除（`.kb-item-out` 220ms × 0.82）。
   */
  const closeTab = useCallback(async (id: string) => {
    const tab = tabById(tabsRef.current, id)
    if (!tab || closeTimersRef.current.has(id)) return
    const flush = flushRef.current.get(id)
    if (flush) {
      const closable = await flush().catch(() => true)
      if (!closable) {
        showToast({
          type: 'warning',
          message: '这份文件还有未处理的改动',
          detail: '先选「保留我的版本」或「重新载入」，再关闭页签',
        })
        return
      }
    }
    flushRef.current.delete(id)
    flushRegistrarRef.current.delete(id)
    dirtySetterRef.current.delete(id)
    setDirtyIds((prev) => prev.filter((x) => x !== id))
    // flush 是异步的：期间页签可能已被别的路径关掉
    if (!tabById(tabsRef.current, id)) return
    // 活动页签立即切走（内容切换不跟着动效等），页签本体留一拍再移除（190ms ≈ 220ms × 0.82）
    // 注意：这里**不能**走 `selectTab` —— 它会 reviveClosing，等于把刚关掉的页签复活。
    const preview = closeTabById(tabsRef.current, activeIdRef.current, id)
    activeIdRef.current = preview.activeId
    setActiveId(preview.activeId)
    setClosingIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
    const timer = setTimeout(() => {
      closeTimersRef.current.delete(id)
      const r = closeTabById(tabsRef.current, activeIdRef.current, id)
      apply(r.tabs, r.activeId)
      setClosingIds((prev) => prev.filter((x) => x !== id))
      cbCacheRef.current.forEach((_v, key) => {
        if (key.startsWith(`${id}:`)) cbCacheRef.current.delete(key)
      })
    }, 190)
    closeTimersRef.current.set(id, timer)
  }, [apply])

  /* ------------------------------------------------------------ 外部请求 */

  useEffect(() => {
    if (!request) return
    if (request.seq === lastReqSeqRef.current) return
    lastReqSeqRef.current = request.seq
    const type = request.tab
    if (!isViewerTabKey(type)) return

    if (type === 'notes') {
      const rel = String(request.relPath ?? '').replace(/\\/g, '/').trim()
      const hit = rel ? findNotesTab(tabsRef.current, rel) : null
      const id = openNote(rel, { title: request.name })
      // 已经开着同一个文件：让它重新读一次盘（文件被删后 ensure 又建回来的场景）
      if (hit) sendPaneReq(id, { relPath: rel, name: request.name })
      return
    }
    if (type === 'books') {
      const rel = String(request.relPath ?? '').replace(/\\/g, '/').trim()
      const hit = rel ? findBooksTabByBook(tabsRef.current, rel) : null
      const id = openBook(rel, request.name)
      if (hit) sendPaneReq(id, { relPath: rel, name: request.name })
      return
    }
    if (type === 'web') {
      openWeb(request.url)
      return
    }

    // ask：兼容老形状（字符串 / 对象 kind），列表演进到浮层后这里只负责「开哪个页签」
    const raw = request.ask
    const extra = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const kind = typeof raw === 'string' ? raw.trim() : String(extra.kind ?? '').trim()
    if (kind === 'open') {
      const laneId = String(extra.laneId ?? '').trim()
      if (laneId) {
        const hit = findAskTabByLane(tabsRef.current, laneId)
        if (hit) {
          selectTab(hit.id)
          return
        }
        const tab = makeAskTab(newTabId(), {
          laneId,
          parentSessionId: sessionIdRef.current,
          parentTitle: sessionTitleRef.current,
          title: '旁问',
        }, Date.now())
        apply(appendTab(tabsRef.current, tab).tabs, tab.id)
        return
      }
    }
    const anchor = String(extra.anchorMessageId ?? '').trim()
    if (!sessionIdRef.current) {
      showToast({ type: 'warning', message: '先进入一个 AI 教学对话' })
      return
    }
    if (kind === 'create' && anchor) {
      openAskDraft({
        parentSessionId: sessionIdRef.current,
        parentTitle: sessionTitleRef.current,
        anchorMessageId: anchor,
        sideScope: 'anchor',
        anchorOrdinal: numberOrNull(extra.anchorOrdinal),
        excerpt: String(extra.excerpt ?? ''),
      })
      return
    }
    // 整段 / 无参数：显式整段就开草稿；只是「打开旁问」就先把已有的旁问切出来
    if (!kind) {
      const asks = tabsRef.current.filter((t) => t.type === 'ask')
      if (asks.length > 0) {
        const recent = asks.reduce((a, b) => (b.lastActiveAt > a.lastActiveAt ? b : a))
        selectTab(recent.id)
        return
      }
    }
    openWholeDraft()
  }, [request, openNote, openBook, openWeb, selectTab, openAskDraft, openWholeDraft, apply, sendPaneReq])

  /* ------------------------------------------------------------ 持久化 */

  useEffect(() => {
    try {
      window.localStorage.setItem(
        VIEWER_LS_KEYS.tabsV2,
        JSON.stringify(serializeViewerState(tabs, activeId)),
      )
    } catch {
      if (!lsWarnedRef.current) {
        lsWarnedRef.current = true
        showToast({ type: 'warning', message: '页签记忆写入失败', detail: '下次打开会回到上次保存成功的页签' })
      }
    }
  }, [tabs, activeId])

  /* ------------------------------------------------------------ 视野 / 保活 */

  useEffect(() => subscribeAssistantRunState(() => bumpRun()), [])

  const runningTabIds = useMemo(() => {
    const ids: string[] = []
    for (const t of tabs) if (t.type === 'ask' && t.laneId && isSessionRunning(t.laneId)) ids.push(t.id)
    return ids
    // runTick 变了说明某条旁问开跑 / 跑完，必须重算保护集
  }, [tabs, runTick])

  const liveIds = useMemo(() => {
    const ids = selectLiveIds({
      tabs, activeId, dirtyIds, runningIds: runningTabIds, windowSize: VIEWER_LIVE_WINDOW,
    })
    return closingIds.length ? ids.filter((id) => !closingIds.includes(id)) : ids
  }, [tabs, activeId, dirtyIds, runningTabIds, closingIds])

  // 面板打开：首次打开才挂 pane（避免冷启动为网页建原生视图）；焦点交给当前页签 / `+`
  useEffect(() => {
    if (!open) return
    setOpenedOnce(true)
    setFocusToken((n) => n + 1)
  }, [open])

  // 占宽上报（关闭报 0）：中栏让位与查看器宽度走同一条曲线
  useEffect(() => {
    onWidthChangeRef.current?.(open ? width : 0)
  }, [open, width])

  const activeType = tabById(tabs, activeId)?.type ?? null

  // 页签类型变化 → 顶栏按钮的 tooltip / 记忆（值没变就不回调，避免每次改标题都通知一次）
  useEffect(() => {
    if (activeType === activeTypeRef.current) return
    activeTypeRef.current = activeType
    if (activeType) onTabChangeRef.current?.(activeType)
  }, [activeType])

  /**
   * 网页原生视图可见性：原生视图**永远盖在 DOM 之上**，所以「面板关了」或「切到非网页页签」
   * 都必须 hide；重新可见时由 WebPane 自己按 active / open show（壳不越权 show）。
   */
  useEffect(() => {
    if (!shouldHideWebViewer(open, activeType)) return
    void webPaneHideAll().catch(() => {
      /* 隐藏失败不打扰用户：下次切页签 / 关闭还会再发一次 */
    })
  }, [open, activeType])

  /** 浮层（`+` / 全部页签 / 旁问历史）会盖到网页区：开时 hide，关后 bump 令牌让视图回来 */
  const onMenuOpenChange = useCallback((isOpen: boolean) => {
    if (isOpen) {
      void webPaneHideAll().catch(() => undefined)
      return
    }
    setWebSyncToken((n) => n + 1)
  }, [])

  const requestClose = useCallback((id: string) => { void closeTab(id) }, [closeTab])

  // 卸载：清掉关闭动效定时器（否则 setState 落在已卸载组件上）
  useEffect(() => () => {
    closeTimersRef.current.forEach((t) => clearTimeout(t))
    closeTimersRef.current.clear()
  }, [])

  /* ------------------------------------------------------------ 渲染 */

  const style = viewerWidthStyle(open, width)

  /** 该页签有没有一次性请求（外链换址 / 同一文件重新读盘） */
  const reqFor = (tabId: string): PaneOpenRequest | null =>
    paneReq && paneReq.tabId === tabId ? paneReq.req : null

  const paneFor = (tab: ViewerTab): JSX.Element => {
    const active = tab.id === activeId
    const ctx = {
      rootId,
      workspaceId,
      width,
      active,
      open,
      tabId: tab.id,
      type: tab.type,
      // 旁问页签的「会话」是它所属的主对话（跨会话保活时也不能漂移）
      sessionId: tab.type === 'ask' ? (tab.parentSessionId || sessionId) : sessionId,
      sessionTitle: tab.type === 'ask' ? (tab.parentTitle || sessionTitle) : sessionTitle,
    }
    if (tab.type === 'web') {
      return (
        <PaneSlot key={tab.id} tabId={tab.id} active={active}>
          <WebPane
            {...ctx}
            initialUrl={tab.url}
            request={reqFor(tab.id)}
            syncToken={webSyncToken}
            onTitleChange={cached(`${tab.id}:title`, () => (t: string) => setTitle(tab.id, t))}
            onUrlChange={cached(`${tab.id}:url`, () => (u: string) => patchTab(tab.id, { url: u }))}
          />
        </PaneSlot>
      )
    }
    if (tab.type === 'notes') {
      return (
        <PaneSlot key={tab.id} tabId={tab.id} active={active}>
          <NotesPane
            {...ctx}
            request={reqFor(tab.id)}
            initialRelPath={tab.relPath}
            fileKind={tab.fileKind}
            ownerSessionId={tab.ownerSessionId}
            displayName={tab.title}
            onOpenInEditor={onOpenInEditor}
            onTitleChange={cached(`${tab.id}:title`, () => (t: string) => setTitle(tab.id, t))}
            onRelPathChange={cached(`${tab.id}:rel`, () => (rel: string) => patchTab(tab.id, { relPath: rel }))}
            onDirtyChange={dirtySetter(tab.id)}
            registerFlush={registerFlush(tab.id)}
            onRequestOpenNote={cached(`${tab.id}:openNote`, () => (rel: string) => { openNote(rel) })}
            onRequestNewNote={cached(`${tab.id}:newNote`, () => () => { void newNote() })}
          />
        </PaneSlot>
      )
    }
    if (tab.type === 'books') {
      return (
        <PaneSlot key={tab.id} tabId={tab.id} active={active}>
          <BooksPane
            {...ctx}
            request={reqFor(tab.id)}
            initialRelPath={tab.relPath}
            displayName={tab.name ?? tab.title}
            onOpenFullscreen={onOpenFullscreen}
            onTitleChange={cached(`${tab.id}:title`, () => (t: string) => setTitle(tab.id, t))}
            onOpenBook={cached(`${tab.id}:openBook`, () => (rel: string, name: string) => { openBook(rel, name) })}
            onBackToShelf={cached(`${tab.id}:shelf`, () => () => patchTab(tab.id, { relPath: null, name: '', title: '书架' }))}
          />
        </PaneSlot>
      )
    }
    return (
      <PaneSlot key={tab.id} tabId={tab.id} active={active}>
        <AskPane
          {...ctx}
          laneId={tab.laneId}
          draft={tab.draft}
          anchorMessageId={anchorMessageId}
          onQuote={onQuote}
          onFloat={onFloat}
          onRequestClose={cached(`${tab.id}:close`, () => () => { void closeTab(tab.id) })}
          onLaneReady={cached(`${tab.id}:lane`, () => (laneId: string, title: string) => {
            patchTab(tab.id, { laneId, title, draft: null })
          })}
          onTitleChange={cached(`${tab.id}:title`, () => (t: string) => setTitle(tab.id, t))}
        />
      </PaneSlot>
    )
  }

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

      <ViewerChrome
        tabs={tabs}
        activeId={activeId}
        width={width}
        closingIds={closingIds}
        autoFocusToken={focusToken}
        onSelect={selectTab}
        onCloseTab={requestClose}
        onClosePanel={onClose}
        onNewTab={onNewTab}
        onNewWholeAsk={openWholeDraft}
        onOpenLane={openAskLane}
        onMenuOpenChange={onMenuOpenChange}
      />

      {/* 页签内容：绝对铺满、父级高度固定，切换不跳动 */}
      <div className="relative min-h-0 flex-1">
        {openedOnce && tabs.filter((t) => liveIds.includes(t.id)).map(paneFor)}
        {tabs.length === 0 && <ViewerEmptyCard />}
      </div>
    </div>
  )
}

