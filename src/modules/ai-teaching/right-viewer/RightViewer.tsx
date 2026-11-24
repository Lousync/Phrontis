/**
 * AI 教学 · 右侧活动栏外壳（动态多页签 / overlay 定位 / 拖宽 / 持久化 / 保活 / 动效）
 *
 * 方案：`tmp/ai-teach-right-viewer/PLAN.md`（四固定页签 → 动态实例页签）
 *       + `/home/lousync/Projects/DesginProcess/Phrontis/已实现设计文档/ai-teaching-right-viewer-plan.md` §3（交互）/ §5（持久化）/ §9（动效与 a11y）
 * 内核决策：C7 overlay 可调宽 · D5 懒加载 + 关页签卸载、**切页签只隐藏不卸载**（本版加保活窗口）
 *
 * 这个文件只做「壳」：页签集合 / 页签条 / 宽度 / 持久化 / 保活窗口 / 去重 / 网页视图可见性
 * / 全屏放大。
 * 五个 kind 的业务都在各自 pane 里；壳只按 `paneContracts.ts`（冻结契约）传公共上下文。
 *
 * 三条新纪律（本版新增，改之前先读）：
 *   1. **一个笔记 / 文件 / 电子书页签 = 一个文件 / 一本书**；同文件再去点 = 聚焦已有页签，不新开
 *      （两个实例各持一份 mtime 基线，保存必然互相踩，见 PLAN §7.2 / §7.3）；
 *   2. **保活窗口**：同时挂载 ≤6 个 pane，超出按 LRU 卸载；脏笔记与运行中的旁问永不淘汰；
 *   3. **旁问草稿**：`laneId === null` 的旁问页签不持久化、关掉即丢，首问发出后才落库。
 *
 * 文件页签（`type: 'file'`，2026-11-23 并入工件栏）：所有入口都走本文件的 `openFile()`；
 * AI 产物按 `ViewerOpenRequest.mode` 的 begin / commit / drop 维护「生成中」占位，完成后原地转正。
 */

import {
  Suspense, lazy, useCallback, useEffect, useMemo, useReducer, useRef, useState,
  type ComponentType, type JSX, type LazyExoticComponent, type ReactNode,
} from 'react'
import { isSessionRunning, subscribeAssistantRunState } from '../../../lib/assistantRunStore'
import { getSettingRaw, setSettingRaw, webPaneHideAll } from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'
import type { AgentSideLaneInfo } from '../../../types'
import {
  VIEWER_LS_KEYS, isViewerTabKey,
  type FilePaneKind, type PaneOpenRequest, type ViewerOpenRequest, type ViewerPaneType,
} from './paneContracts'
import { shouldHideWebViewer, viewerWidthStyle } from './rightViewerPure'
import { VIEWER_WIDTH_SETTING_KEY, useViewerWidth } from './viewerResize'
import { ViewerChrome, ViewerEmptyCard } from './ViewerChrome'
import { createSessionNote } from './noteFileOps'
import {
  VIEWER_LIVE_WINDOW, activateTab, appendTab, closeTabById, findAnyPathTab, findAskTabByLane,
  findBooksTabByBook, findDraftTab, findFileTab, findNotesTab, findWebTab, firstTabOfType,
  inferNotesFileKind, isFilePaneKind, makeAskTab, makeBooksTab, makeFileTab, makeNotesTab,
  makeWebTab, migrateLegacyViewerState, parseViewerState, sanitizeViewerScope,
  scopedViewerTabsKey, scopedViewerWidthKey, selectLiveIds, serializeViewerState,
  stemOf, tabById, updateTab,
  type AskDraft, type FileViewerTab, type NotesFileKind, type ViewerStateV2, type ViewerTab,
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
const FilePane = lazyPane(() => import('./FilePane'), 'FilePane')
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
 * 写页签状态：有作用域写 `aiTeachViewerTabs:<scope>`，没有就写课程会话的旧键
 * `aiTeach.rightTabs.v2`（唯一的旧键写入点，旧键永不删除）。
 */
function writeTabsState(scope: string, state: ViewerStateV2): boolean {
  const key = scopedViewerTabsKey(scope)
  const json = JSON.stringify(state)
  try {
    if (key) window.localStorage.setItem(key, json)
    else window.localStorage.setItem(VIEWER_LS_KEYS.tabsV2, json)
    return true
  } catch {
    return false
  }
}

/** 作用域宽度：只存一个数字；坏值 / 没有键 → null */
function readScopedWidth(key: string | null): number | null {
  if (!key) return null
  const n = Number(readLs(key))
  return Number.isFinite(n) && n > 0 ? n : null
}

function writeScopedWidth(key: string | null, width: number): void {
  if (!key || !Number.isFinite(width) || width <= 0) return
  try {
    window.localStorage.setItem(key, String(Math.round(width)))
  } catch {
    /* 写不进就下次再试：宽度记忆不是关键数据 */
  }
}

/**
 * 首帧页签：`aiTeach.rightTabs.v2` 优先；没有就做一次性迁移
 * （`aiTeach.rightTab` + `aiTeach.webTabs.<sid>` + 更旧的 `aiTeach.railTab`，只读不删）。
 *
 * 有作用域（对话模式）时**只读该作用域自己的键**：没有记录 = 空页签，
 * 绝不回落到课程会话的页签，也不做旧键迁移（迁移只属于课程会话）。
 */
function loadBootState(sessionId: string, scope = ''): ViewerStateV2 {
  const scopedKey = scopedViewerTabsKey(scope)
  if (scopedKey) {
    return parseViewerState(readJson(readLs(scopedKey))) ?? { v: 2, tabs: [], activeId: null }
  }
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
  /**
   * 页签 / 宽度的持久化作用域（对话模式传 `tutor:<sessionId>`）。
   *
   * 不传 = 课程会话：沿用旧键 `aiTeach.rightTabs.v2` 与 `aiTeachRightViewerWidth` 设置，
   * 行为与持久化键都不变。传了 = 页签与宽度分别落到
   * `aiTeachViewerTabs:<scope>` / `aiTeachViewerWidth:<scope>`，切换作用域即重新载入。
   * scope 会被轻量清洗（只留字母数字 `-_:`，其余换 `_`）。
   */
  persistScope?: string
  /** 外部一次性请求：打开并聚焦某类内容；seq 递增（同路径重复点击也要触发） */
  request?: ViewerOpenRequest | null
  onOpenInEditor: (relPath: string) => void
  onOpenFullscreen?: (relPath: string) => void
  /**
   * 文件页签「讲解此页」：只把页信息交给宿主，发送逻辑留在宿主（课件页签保留该动作）。
   */
  onTalkPage?: (page: { name: string; page: number; n: number; text: string }) => void
  onQuote: (text: string) => void
  onFloat: (laneId: string) => void
  /**
   * 当前活动页签对应的仓库相对路径（笔记 / 文件 / 电子书）；其它类型或面板关闭为 null。
   * 左栏文件树用它回显「正在看哪个文件」——工件栏退役后宿主不再持有页签状态。
   */
  onActivePathChange?: (relPath: string | null) => void
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
  /**
   * 笔记页签不渲染文件列表列（对话模式：左栏会话文件树已承担切文件入口）。
   * 缺省 false = 课程模式现状。
   */
  hideNoteList?: boolean
}

export function RightViewer(props: RightViewerProps): JSX.Element {
  const {
    open, onClose, rootId, sessionId, sessionTitle, workspaceId, persistScope,
    request, onOpenInEditor, onOpenFullscreen, onTalkPage, onQuote, onFloat,
    onActivePathChange, anchorMessageId, onTabChange, onWidthChange, reserve,
    hideNoteList,
  } = props

  /** 清洗后的作用域：空串 = 课程会话（旧键 / 旧行为） */
  const persistScopeKey = sanitizeViewerScope(persistScope)
  const scopedWidthKey = scopedViewerWidthKey(persistScopeKey)

  /* ------ 首帧页签（迁移只跑一次） ------ */
  const bootRef = useRef<ViewerStateV2 | null>(null)
  if (bootRef.current === null) bootRef.current = loadBootState(sessionId, persistScopeKey)
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
  /** 全屏放大（⤢）：覆盖整个 AI 教学模块区域；Esc / 再点一次退出，关面板时自动复位 */
  const [expanded, setExpanded] = useState(false)
  /** 全屏时的实测宽度：pane / 页签条靠它做宽度自适应（此刻记忆宽度不是可见宽度） */
  const [expandedWidth, setExpandedWidth] = useState(0)

  const { width, setWidth, dragging, beginDrag, reset } = useViewerWidth({ open, reserve })
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
  /** 当前渲染作用域（写持久化时读「此刻」的 scope，不让旧闭包写错键） */
  const scopeKeyRef = useRef(persistScopeKey)
  scopeKeyRef.current = persistScopeKey
  /** `tabs` / 宽度状态当前属于哪个作用域：切换作用域前不得拿旧状态写新键 */
  const tabsScopeRef = useRef(persistScopeKey)
  /** 上一次观察到的「作用域 + 宽度」：只在同一作用域内宽度真的变了才落盘 */
  const lastScopedWidthRef = useRef<{ scope: string; width: number } | null>(null)
  /** 课程会话宽度基线：作用域会话复用全局宽度设置，离开时还原，课程侧不受影响 */
  const courseWidthRef = useRef<number | null>(null)
  const courseWidthLoadedRef = useRef(false)
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
  const onTalkPageRef = useRef(onTalkPage)
  onTalkPageRef.current = onTalkPage
  const onActivePathChangeRef = useRef(onActivePathChange)
  onActivePathChangeRef.current = onActivePathChange
  /** 全屏按钮（退出全屏后焦点回到它） */
  const expandBtnRef = useRef<HTMLButtonElement | null>(null)

  const apply = useCallback((nextTabs: ViewerTab[], nextActive: string | null) => {
    tabsRef.current = nextTabs
    activeIdRef.current = nextActive
    setTabs(nextTabs)
    setActiveId(nextActive)
  }, [])

  /** 写页签状态；失败只提示一次（旧行为不变，只是多了一条按作用域分流的路径） */
  const persistTabsState = useCallback((scope: string, state: ViewerStateV2) => {
    if (writeTabsState(scope, state)) return
    if (lsWarnedRef.current) return
    lsWarnedRef.current = true
    showToast({ type: 'warning', message: '页签记忆写入失败', detail: '下次打开会回到上次保存成功的页签' })
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
    meta?: {
      title?: string
      fileKind?: NotesFileKind
      ownerSessionId?: string | null
      /** 文件树 / 素材点开：默认进预览（仅 .md 生效） */
      previewDefault?: boolean
    },
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
      previewDefault: meta?.previewDefault,
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

  /* ------------------------------------------------------------ 文件统一入口 */

  /**
   * 打开 / 聚焦仓库内的任意文件。**所有文件入口都必须走它**（文件树 / 素材 / 产物 /
   * 导图节点 ref）：跨 `notes` / `file` 两种页签按路径去重，避免同一文件开出两个实例。
   *
   * 分派规则（方案 §4.2）：`meta.fileKind` 有值 → 文件页签；否则一律笔记页签
   * （md / txt / 非导图 json），`previewDefault` 只对笔记页签生效。
   */
  const openFile = useCallback((
    relPath: string,
    meta?: { fileKind?: FilePaneKind; title?: string; previewDefault?: boolean; page?: number },
  ): string => {
    const rel = String(relPath ?? '').replace(/\\/g, '/').trim()
    // 空路径不造空文件页签（生成中占位只走 begin）：退回笔记空页签，保持旧口径
    if (!rel) return openNote('')
    // 跨类型去重：命中就聚焦；文件页签 bump `rev` 重读，笔记页签走一次性请求重新读盘
    const hit = findAnyPathTab(tabsRef.current, rel)
    if (hit) {
      if (hit.type === 'file') {
        patchTab(hit.id, {
          rev: (hit.rev ?? 0) + 1,
          ...(meta?.page !== undefined ? { page: meta.page } : {}),
        })
      } else {
        sendPaneReq(hit.id, { relPath: rel, name: meta?.title })
      }
      selectTab(hit.id)
      return hit.id
    }
    if (meta?.fileKind) {
      const tab = makeFileTab(newTabId(), {
        relPath: rel,
        fileKind: meta.fileKind,
        title: meta?.title,
        page: meta?.page,
      }, Date.now())
      apply(appendTab(tabsRef.current, tab).tabs, tab.id)
      return tab.id
    }
    // 笔记页签复用 openNote：文件种类推导与画像 / 要求的会话归属只有那一处口径
    return openNote(rel, { title: meta?.title, previewDefault: meta?.previewDefault })
  }, [apply, openNote, patchTab, selectTab, sendPaneReq])

  /* ------------------------------------------------------------ AI 产物占位协议 */

  /** 生成中占位查找：给了 slug 就按 slug 匹配，没给就找「无 slug 的生成中」 */
  const findGenerating = useCallback((slug?: string): FileViewerTab | null => {
    const key = String(slug ?? '').trim()
    for (const t of tabsRef.current) {
      if (t.type !== 'file' || t.generating !== true) continue
      if (key ? t.slug === key : !t.slug) return t
    }
    return null
  }, [])

  /**
   * `begin`：AI 开始生成 → 生成中占位（按 slug 合并，不重复开；自动成为活动页签）。
   * 宿主在发请求时已经把查看器展开，壳这里只维护页签。
   */
  const beginArtifact = useCallback((input: {
    fileKind: FilePaneKind
    slug?: string
    name?: string
    page?: number
  }): void => {
    const slug = String(input.slug ?? '').trim()
    const fileKind: FilePaneKind = isFilePaneKind(input.fileKind) ? input.fileKind : 'html'
    const title = String(input.name ?? '').trim()
    const existing = findGenerating(slug)
    if (existing) {
      if (title) patchTab(existing.id, { title })
      selectTab(existing.id)
      return
    }
    // 占位 id 按 slug 稳定复用（commit 后就地转正）；但上一轮同名产物可能还开着正式页签，
    // 那时必须换一次性 id —— 重复 id 会让 tabById / React key 同时指错页签。
    const genId = tabById(tabsRef.current, `gen:${slug || fileKind}`)
      ? newTabId()
      : `gen:${slug || fileKind}`
    const tab = makeFileTab(genId, {
      fileKind,
      generating: true,
      slug,
      title,
      page: input.page,
    }, Date.now())
    apply(appendTab(tabsRef.current, tab).tabs, tab.id)
  }, [apply, findGenerating, patchTab, selectTab])

  /**
   * `commit`：生成完成 → 占位原地转正式页签。
   *
   * 同一 `relPath` 已经有正式页签时**不新开**：删掉占位、聚焦已有页签并 bump `rev`
   * 让它重读盘（同一文件两个实例会互相踩 mtime 基线）。
   */
  const commitArtifact = useCallback((input: {
    fileKind: FilePaneKind
    slug?: string
    relPath: string
    name?: string
    page?: number
  }): void => {
    const rel = String(input.relPath ?? '').replace(/\\/g, '/').trim()
    if (!rel) return
    const fileKind: FilePaneKind = isFilePaneKind(input.fileKind) ? input.fileKind : 'html'
    const title = String(input.name ?? '').trim() || stemOf(rel) || '文件'
    const ph = findGenerating(input.slug)
    if (!ph) {
      openFile(rel, { fileKind, title: input.name, page: input.page })
      return
    }
    const formal = findFileTab(tabsRef.current, rel)
    if (formal && formal.id !== ph.id) {
      const closed = closeTabById(tabsRef.current, activeIdRef.current, ph.id)
      apply(closed.tabs, formal.id)
      patchTab(formal.id, {
        rev: (formal.rev ?? 0) + 1,
        ...(input.page !== undefined ? { page: input.page } : {}),
      })
      return
    }
    // 原地转正：`generating` / `slug` 必须摘掉（前者决定持久化与禁关，后者是占位身份）
    const next = tabsRef.current.map((t): ViewerTab => {
      if (t.id !== ph.id || t.type !== 'file') return t
      const page = input.page !== undefined
        ? input.page
        : (typeof t.page === 'number' ? t.page : undefined)
      const out: FileViewerTab = {
        id: t.id,
        type: 'file',
        title,
        lastActiveAt: Date.now(),
        relPath: rel,
        fileKind,
        rev: (t.rev ?? 0) + 1,
      }
      if (page !== undefined) out.page = page
      return out
    })
    apply(activateTab(next, ph.id, Date.now()).tabs, ph.id)
  }, [activateTab, apply, findGenerating, openFile, patchTab])

  /**
   * `drop`：生成失败 / 停止 → 直接移除生成中占位（不走关闭动效，占位本来就没有内容）。
   * 活动页签落回邻位：优先右侧邻页，没有就退左侧，最后一个 → 零态。
   */
  const dropArtifact = useCallback((slug?: string): void => {
    const key = String(slug ?? '').trim()
    const drop = new Set<string>()
    for (const t of tabsRef.current) {
      if (t.type !== 'file' || t.generating !== true) continue
      if (key && t.slug !== key) continue
      drop.add(t.id)
    }
    if (drop.size === 0) return
    const next = tabsRef.current.filter((t) => !drop.has(t.id))
    let nextActive = activeIdRef.current
    if (!nextActive || drop.has(nextActive)) {
      const at = tabsRef.current.findIndex((t) => t.id === activeIdRef.current)
      const right = next.find((t) => tabsRef.current.indexOf(t) > at)
      nextActive = (right ?? next[next.length - 1])?.id ?? null
    }
    apply(next, nextActive)
    drop.forEach((id) => {
      closeTimersRef.current.delete(id)
      cbCacheRef.current.forEach((_v, key2) => {
        if (key2.startsWith(`${id}:`)) cbCacheRef.current.delete(key2)
      })
    })
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
    // 生成中的文件占位禁关（旧工件栏口径）：完成时壳会原地转正；中途关掉只会「又冒出来」
    if (!tab || (tab.type === 'file' && tab.generating) || closeTimersRef.current.has(id)) return
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
    const rel = String(request.relPath ?? '').replace(/\\/g, '/').trim()
    const mode = request.mode ?? 'open'

    // AI 产物协议：不带 mode 一律按普通打开处理，老调用方形状不变
    if (mode === 'drop') {
      dropArtifact(request.slug)
      return
    }
    if (mode === 'begin') {
      beginArtifact({
        fileKind: isFilePaneKind(request.fileKind) ? request.fileKind : 'html',
        slug: request.slug,
        name: request.name,
        page: request.page,
      })
      return
    }
    if (mode === 'commit') {
      commitArtifact({
        fileKind: isFilePaneKind(request.fileKind) ? request.fileKind : 'html',
        slug: request.slug,
        relPath: rel,
        name: request.name,
        page: request.page,
      })
      return
    }

    if (type === 'file') {
      // 空路径不造空文件页签（生成中占位只走 begin）
      if (!rel) return
      openFile(rel, {
        fileKind: isFilePaneKind(request.fileKind) ? request.fileKind : undefined,
        title: request.name,
        page: request.page,
      })
      return
    }
    if (type === 'notes') {
      const hit = rel ? findNotesTab(tabsRef.current, rel) : null
      const id = openNote(rel, { title: request.name, previewDefault: request.previewDefault })
      // 已经开着同一个文件：让它重新读一次盘（文件被删后 ensure 又建回来的场景）
      if (hit) sendPaneReq(id, { relPath: rel, name: request.name })
      return
    }
    if (type === 'books') {
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
  }, [request, openNote, openBook, openWeb, selectTab, openAskDraft, openWholeDraft, apply, sendPaneReq,
    openFile, beginArtifact, commitArtifact, dropArtifact])

  /* ------------------------------------------------------------ 作用域切换 */

  /**
   * 作用域切换：页签 / 宽度都按新 scope 重新载入，绝不把上一个会话的页签带过来。
   * 不传 scope（课程会话）时这是空操作；首帧已由 `loadBootState` 直接读对键。
   */
  useEffect(() => {
    if (tabsScopeRef.current === persistScopeKey) return
    // 先把旧作用域的页签落盘：父级可能在同一帧里换了会话
    persistTabsState(tabsScopeRef.current, serializeViewerState(tabsRef.current, activeIdRef.current))
    // 关闭定时器 / 脏标记 / 回调缓存都绑在旧页签 id 上，换作用域必须一起清
    closeTimersRef.current.forEach((t) => clearTimeout(t))
    closeTimersRef.current.clear()
    flushRef.current.clear()
    flushRegistrarRef.current.clear()
    dirtySetterRef.current.clear()
    cbCacheRef.current.clear()
    setClosingIds([])
    setDirtyIds([])
    setPaneReq(null)
    const boot = loadBootState(sessionIdRef.current, persistScopeKey)
    tabsScopeRef.current = persistScopeKey
    apply(boot.tabs, boot.activeId)
    // 宽度：本作用域有记录就用记录；回到课程会话则还原课程宽度基线
    const nextWidthKey = scopedViewerWidthKey(persistScopeKey)
    const stored = readScopedWidth(nextWidthKey)
    if (stored !== null) setWidth(stored)
    else if (!nextWidthKey && courseWidthRef.current !== null) setWidth(courseWidthRef.current)
  }, [persistScopeKey, apply, persistTabsState, setWidth])

  // 课程宽度基线（只读一次）：作用域会话宽度复用全局设置，离开时用它还原
  useEffect(() => {
    if (!persistScopeKey || courseWidthLoadedRef.current) return
    courseWidthLoadedRef.current = true
    let cancelled = false
    void getSettingRaw(VIEWER_WIDTH_SETTING_KEY)
      .then((v) => {
        if (!cancelled && typeof v === 'number' && Number.isFinite(v) && v > 0) courseWidthRef.current = v
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [persistScopeKey])

  // 首帧进入作用域：宽度 hook 会异步读回全局设置（课程宽度），作用域记录必须压过这一次读回
  useEffect(() => {
    const stored = readScopedWidth(scopedViewerWidthKey(persistScopeKey))
    if (stored === null) return
    setWidth(stored)
    const t = setTimeout(() => setWidth(stored), 150)
    return () => clearTimeout(t)
    // 只在挂载时跑一次；切换作用域由上面那条 effect 负责
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 作用域宽度落盘：只写「同一作用域里宽度真的变了」的那一次（首次观察 / 拖拽中不写）
  useEffect(() => {
    if (!scopedWidthKey) return
    if (dragging) return
    const prev = lastScopedWidthRef.current
    lastScopedWidthRef.current = { scope: persistScopeKey, width }
    // 新作用域第一次观察：有记录时等 setWidth 把记录应用上来，别用上一个会话的宽度覆盖它
    if (!prev || prev.scope !== persistScopeKey) {
      if (readScopedWidth(scopedWidthKey) === null) writeScopedWidth(scopedWidthKey, width)
      return
    }
    if (prev.width === width) return
    writeScopedWidth(scopedWidthKey, width)
  }, [scopedWidthKey, persistScopeKey, width, dragging])

  // 卸载 / 离开作用域时还原课程宽度（作用域会话可能把全局设置写成了自己的宽度）
  useEffect(() => () => {
    if (!scopedWidthKey) return
    const base = courseWidthRef.current
    if (base !== null) void setSettingRaw(VIEWER_WIDTH_SETTING_KEY, base).catch(() => undefined)
  }, [scopedWidthKey])

  /* ------------------------------------------------------------ 持久化 */

  useEffect(() => {
    persistTabsState(scopeKeyRef.current, serializeViewerState(tabs, activeId))
  }, [tabs, activeId, persistTabsState])

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

  /* ------------------------------------------------------------ 全屏（⤢） */

  /** 全屏只在面板打开时成立：关面板即复位（下次打开回到原宽度） */
  const full = open && expanded

  // 关面板 → 退出全屏（不把全屏态留给下一次打开）
  useEffect(() => {
    if (!open && expanded) setExpanded(false)
  }, [open, expanded])

  // 全屏时实测可见宽度：pane 的窄栏适配 / 页签条的收起阈值都按这个值判
  useEffect(() => {
    if (!full) return
    const el = rootRef.current
    if (!el) return
    const measure = () => {
      const next = Math.round(el.getBoundingClientRect().width)
      if (next > 0) setExpandedWidth((prev) => (prev === next ? prev : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [full])

  // Esc 退出全屏：只在全屏时挂；`stopPropagation` 免得被外层（页面 / 弹窗）再吃一次。
  // 故意走冒泡阶段的 window 监听：页签条弹层自己的 Esc 会先 `stopPropagation` 关菜单，
  // 那一拍不该顺手把全屏也退掉。
  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.stopPropagation()
      setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])

  // 退出全屏后把焦点交回全屏按钮（键盘用户不至于掉到 body）
  const wasExpandedRef = useRef(false)
  useEffect(() => {
    if (full) {
      wasExpandedRef.current = true
      return
    }
    if (!wasExpandedRef.current) return
    wasExpandedRef.current = false
    if (!open) return
    expandBtnRef.current?.focus({ preventScroll: true })
  }, [full, open])

  // 占宽上报（关闭 / 全屏都报 0）：全屏时中栏不需要让位，退出后按原宽度恢复
  useEffect(() => {
    onWidthChangeRef.current?.(open && !expanded ? width : 0)
  }, [open, width, expanded])

  const activeType = tabById(tabs, activeId)?.type ?? null

  /** 活动页签的仓库相对路径：文件树高亮用（笔记 / 文件 / 电子书才有意义） */
  const activeTab = tabById(tabs, activeId)
  const activePath = activeTab && (activeTab.type === 'notes' || activeTab.type === 'file' || activeTab.type === 'books')
    ? (activeTab.relPath || null)
    : null
  useEffect(() => {
    onActivePathChangeRef.current?.(open ? activePath : null)
  }, [open, activePath])

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

  // 全屏：铺满整个模块区域（含左栏）；宽度过渡与收起共用同一条曲线，退回来仍走记忆宽度
  const style = full
    ? { left: 0, right: 0, width: '100%', minWidth: '0px' }
    : viewerWidthStyle(open, width)
  /** pane / 页签条能看见的宽度（全屏时是实测值，不是记忆宽度） */
  const viewWidth = full && expandedWidth > 0 ? expandedWidth : width

  /** 该页签有没有一次性请求（外链换址 / 同一文件重新读盘） */
  const reqFor = (tabId: string): PaneOpenRequest | null =>
    paneReq && paneReq.tabId === tabId ? paneReq.req : null

  const paneFor = (tab: ViewerTab): JSX.Element => {
    const active = tab.id === activeId
    const ctx = {
      rootId,
      workspaceId,
      width: viewWidth,
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
            initialPreview={tab.previewDefault}
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
            hideNoteList={hideNoteList}
          />
        </PaneSlot>
      )
    }
    if (tab.type === 'file') {
      return (
        <PaneSlot key={tab.id} tabId={tab.id} active={active}>
          <FilePane
            {...ctx}
            request={reqFor(tab.id)}
            initialRelPath={tab.relPath}
            fileKind={tab.fileKind}
            generating={tab.generating}
            slug={tab.slug}
            rev={tab.rev ?? 0}
            page={tab.page}
            displayName={tab.title}
            onTitleChange={cached(`${tab.id}:title`, () => (t: string) => setTitle(tab.id, t))}
            onPageChange={cached(`${tab.id}:page`, () => (p: number) => patchTab(tab.id, { page: p }))}
            onOpenInEditor={onOpenInEditor}
            onOpenFileRef={cached(`${tab.id}:fileRef`, () => (rel: string) => { openFile(rel) })}
            onTalkPage={cached(`${tab.id}:talk`, () => (
              p: { name: string; page: number; n: number; text: string },
            ) => onTalkPageRef.current?.(p))}
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
      data-viewer-expanded={full ? '1' : undefined}
      inert={!open}
      className={`absolute top-0 right-0 bottom-0 flex flex-col overflow-hidden bg-[var(--bg-primary)] ${
        full ? 'z-40' : 'z-30'
      } ${
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
      {/* 左缘手柄：8px 热区、内贴（不外探避免与自己那条 border-l 形成双线）。
          全屏时不渲染：这时候没有「右栏宽度」可调，拖它就是拖整块模块。 */}
      {!full && (
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
      )}

      <ViewerChrome
        tabs={tabs}
        activeId={activeId}
        width={viewWidth}
        closingIds={closingIds}
        autoFocusToken={focusToken}
        expanded={full}
        expandButtonRef={expandBtnRef}
        onToggleExpand={() => setExpanded((v) => !v)}
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

