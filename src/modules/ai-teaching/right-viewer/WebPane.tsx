import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, Globe, Plus, RotateCw, X } from 'lucide-react'
import type { WebPaneProps } from './paneContracts'
import { VIEWER_LS_KEYS } from './paneContracts'
import {
  onWebPaneChanged,
  openExternal,
  webPaneBack,
  webPaneClose,
  webPaneCreate,
  webPaneForward,
  webPaneReload,
  webPaneSetBounds,
  webPaneSetUrl,
  webPaneSetVisible,
} from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'
import {
  boundsPayload,
  closeTabAt,
  nextTabId,
  normalizeUrl,
  restoreTabs,
  shouldShowView,
  tabCaption,
  type WebTabRef,
} from './webPanePure'

/**
 * AI 教学右侧查看器 · 网页页签（渲染层）
 *
 * 结构：内层页签条（最多 3）→ 浏览器动作行 → 内容占位区。
 * 内容区的真实像素不在 React 里：主进程用 `WebContentsView` 盖在占位区上面，
 * 渲染层只做两件事 —— 把占位区的 CSS px 几何同步过去、决定它该不该可见。
 * 方案：`docs/ai-teaching-right-viewer-plan.md` §6.1 / §8 / §9；决策 C2 / C4 / C6。
 */

interface TabRuntime {
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  /** did-fail-load 的 errorDescription；成功导航后主进程会清空 */
  error?: string
}

const EMPTY_RUNTIME: TabRuntime = { canGoBack: false, canGoForward: false, loading: false }

/** 起始页快捷入口：固定 3 个，不再往上堆（空态只负责「给个能点的东西」） */
const QUICK_LINKS = [
  { label: '百度', url: 'https://www.baidu.com' },
  { label: '维基百科', url: 'https://zh.wikipedia.org' },
  { label: 'MDN 文档', url: 'https://developer.mozilla.org' },
]

interface PaneSnapshot {
  tabs: WebTabRef[]
  activeIndex: number
  active: boolean
  open: boolean
  error?: string
}

function IconButton(props: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      data-tip={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[var(--text-muted)]"
    >
      {props.children}
    </button>
  )
}

export function WebPane(props: WebPaneProps) {
  const [tabs, setTabs] = useState<WebTabRef[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  /** 主进程回传的每页签状态；有 key 也意味着「这个 id 的 view 已经建过」 */
  const [runtime, setRuntime] = useState<Record<string, TabRuntime>>({})
  const [address, setAddress] = useState('')
  /** 地址栏聚焦中：此时不要用页面 URL 覆盖用户正在敲的字 */
  const [editing, setEditing] = useState(false)
  /** 当前 state 里这组页签属于哪个会话（防止切会话的瞬间把旧页签写进新键） */
  const [tabsSid, setTabsSid] = useState('')

  const slotRef = useRef<HTMLDivElement | null>(null)
  const addrRef = useRef<HTMLInputElement | null>(null)
  const createdRef = useRef<Set<string>>(new Set())
  const visibleRef = useRef<string | null>(null)
  const frameRef = useRef<number>(0)
  const sessionRef = useRef('')
  const lastReqRef = useRef('')
  const latestRef = useRef<PaneSnapshot>({ tabs: [], activeIndex: 0, active: false, open: false })

  const activeTab = tabs[activeIndex] ?? null
  const activeRuntime = (activeTab && runtime[activeTab.id]) || EMPTY_RUNTIME
  const activeLive = !!activeTab && !!runtime[activeTab.id]

  // rAF 回调里必须看到「此刻」的状态，不能拿闭包里那一帧的
  latestRef.current = {
    tabs,
    activeIndex,
    active: props.active,
    open: props.open,
    error: activeRuntime.error,
  }

  /* ------------------------------------------------------------ 主进程桥 */

  /**
   * 几何 + 可见性同步（整个组件最容易出错的一段）。
   *
   * 为什么合并到一帧：ResizeObserver / resize / 宽度过渡会在一次拖拽里吐出几十次回调，
   * 每次 IPC 都排队 setBounds 会让原生视图明显晚一拍；同一帧最多发一次就够。
   *
   * 为什么「先 setBounds 再 setVisible」：先显形再改几何 = 白块闪一下再跳位。
   *
   * 为什么 `want=false` 也一定要发 hide：原生视图永远盖在 DOM 上，
   * 面板收起（open=false）、切到别的页签（active=false）、加载失败、宽度归零，
   * 任何一种漏 hide 都会在别处留一块不属于任何界面的白。
   */
  const syncBounds = useCallback(() => {
    const snap = latestRef.current
    const tab = snap.tabs[snap.activeIndex]
    const prevVisible = visibleRef.current

    // 没有当前页签 / 该页签还没建 view：把上一块收掉就结束
    if (!tab || !createdRef.current.has(tab.id)) {
      if (prevVisible) {
        visibleRef.current = null
        void webPaneSetVisible(prevVisible, false)
      }
      return
    }

    // 切页签：先把上一个视图收掉，别让两个原生视图叠在同一块占位区
    if (prevVisible && prevVisible !== tab.id) {
      visibleRef.current = null
      void webPaneSetVisible(prevVisible, false)
    }

    const el = slotRef.current
    const rect = el ? el.getBoundingClientRect() : null
    const bounds = rect ? boundsPayload(rect) : null
    const want = !!bounds && shouldShowView({
      active: snap.active,
      open: snap.open,
      url: tab.url,
      error: snap.error,
    })

    if (!bounds || !want) {
      if (visibleRef.current === tab.id || prevVisible === tab.id) {
        visibleRef.current = null
        void webPaneSetVisible(tab.id, false)
      }
      return
    }

    void webPaneSetBounds(tab.id, bounds)
    visibleRef.current = tab.id
    void webPaneSetVisible(tab.id, true)
  }, [])

  /** 同一帧最多发一次 bounds / visible（拖拽 / 宽度过渡一帧能触发几十次回调） */
  const scheduleSync = useCallback(() => {
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      syncBounds()
    })
  }, [syncBounds])

  /* ------------------------------------------------------------ 建 / 导航 */

  const mountOrNavigate = useCallback(async (id: string, url: string) => {
    const r = createdRef.current.has(id)
      ? await webPaneSetUrl(id, url).catch(() => null)
      : await (async () => {
          // 先占位再 create：同一帧里的第二次导航会走 setUrl，不会重复建 view
          createdRef.current.add(id)
          const created = await webPaneCreate({ id, url }).catch(() => null)
          if (!created || !created.ok) createdRef.current.delete(id)
          return created
        })()

    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, dormant: false } : t)))

    if (!r || !r.ok) {
      setRuntime((prev) => ({
        ...prev,
        [id]: { ...EMPTY_RUNTIME, error: r?.error || '无法打开这个页面' },
      }))
      showToast({ type: 'error', message: '无法打开这个页面', detail: r?.error })
    }
  }, [])

  const rejectToast = useCallback((raw: string) => {
    const s = raw.trim().toLowerCase()
    if (/^(file:|[a-z]:[\\/]|\\\\)/.test(s)) {
      showToast({
        type: 'warning',
        message: '本地文件不在右侧网页打开',
        detail: '请用笔记 / 书架页签，或先把文件加入课程素材',
      })
      return
    }
    if (/^(javascript:|data:|about:|mailto:|chrome:|edge:)/.test(s)) {
      showToast({
        type: 'warning',
        message: '这个地址不能在这里打开',
        detail: '右侧网页只接受 http / https 链接',
      })
      return
    }
    showToast({
      type: 'warning',
      message: '请输入有效的网址',
      detail: '右侧网页只接受 http / https 链接',
    })
  }, [])

  /** 唯一导航入口：地址栏回车、起始页快捷入口、外链请求、失败重试都走这里 */
  const navigate = useCallback(
    async (raw: string) => {
      const url = normalizeUrl(raw)
      if (!url) {
        rejectToast(raw)
        return
      }
      const snap = latestRef.current
      const current = snap.tabs[snap.activeIndex] ?? null

      let id: string
      let nextTabs: WebTabRef[]
      if (current) {
        id = current.id
        nextTabs = snap.tabs.map((t, i) =>
          i === snap.activeIndex ? { ...t, url, title: undefined, dormant: false } : t,
        )
      } else {
        const slot = nextTabId(snap.tabs)
        if (!slot) {
          showToast({ type: 'warning', message: '最多 3 个网页页签' })
          return
        }
        id = slot
        nextTabs = [...snap.tabs, { id, url, dormant: false }]
      }

      setTabs(nextTabs)
      setActiveIndex(current ? snap.activeIndex : snap.tabs.length)
      setAddress(url)
      setRuntime((prev) => ({ ...prev, [id]: { ...EMPTY_RUNTIME, loading: true } }))
      await mountOrNavigate(id, url)
      scheduleSync()
    },
    [mountOrNavigate, rejectToast, scheduleSync],
  )

  /* ------------------------------------------------------------ 页签操作 */

  const activateTab = useCallback(
    (index: number) => {
      const snap = latestRef.current
      const tab = snap.tabs[index]
      if (!tab) return
      setActiveIndex(index)
      setAddress(tab.url)
      if (tab.url && !createdRef.current.has(tab.id)) {
        // C6：恢复出来的页签在这一刻才 loadURL（恢复阶段不预加载）
        setRuntime((prev) => ({ ...prev, [tab.id]: { ...EMPTY_RUNTIME, loading: true } }))
        void mountOrNavigate(tab.id, tab.url).then(() => scheduleSync())
      }
      scheduleSync()
    },
    [mountOrNavigate, scheduleSync],
  )

  const addTab = useCallback(() => {
    const snap = latestRef.current
    const slot = nextTabId(snap.tabs)
    if (!slot) {
      showToast({ type: 'warning', message: '最多 3 个网页页签' })
      return
    }
    // 空 url = 起始页：此时不调主进程，等真有地址了再 create
    setTabs([...snap.tabs, { id: slot, url: '', dormant: false }])
    setActiveIndex(snap.tabs.length)
    setAddress('')
    // 复用了旧 id 的话，别把上一个 view 的 canGoBack / loading 带进来
    setRuntime((prev) => {
      const next = { ...prev }
      delete next[slot]
      return next
    })
    scheduleSync()
    requestAnimationFrame(() => addrRef.current?.focus())
  }, [scheduleSync])

  const closeTab = useCallback(
    (index: number) => {
      const snap = latestRef.current
      const target = snap.tabs[index]
      if (!target) return
      const result = closeTabAt(snap.tabs, snap.activeIndex, index)
      setTabs(result.tabs)
      setActiveIndex(result.activeIndex)
      setAddress(result.tabs[result.activeIndex]?.url ?? '')
      setRuntime((prev) => {
        const next = { ...prev }
        delete next[target.id]
        return next
      })
      if (visibleRef.current === target.id) {
        visibleRef.current = null
        void webPaneSetVisible(target.id, false)
      }
      if (createdRef.current.delete(target.id)) void webPaneClose(target.id)
      scheduleSync()
    },
    [scheduleSync],
  )

  /** 恢复出来的页签点「加载」时显式唤醒 */
  const wakeActive = useCallback(() => {
    const snap = latestRef.current
    const tab = snap.tabs[snap.activeIndex]
    if (!tab || !tab.url || createdRef.current.has(tab.id)) return
    setRuntime((prev) => ({ ...prev, [tab.id]: { ...EMPTY_RUNTIME, loading: true } }))
    void mountOrNavigate(tab.id, tab.url).then(() => scheduleSync())
  }, [mountOrNavigate, scheduleSync])

  const withActiveView = useCallback((fn: (id: string) => void) => {
    const snap = latestRef.current
    const tab = snap.tabs[snap.activeIndex]
    if (!tab || !createdRef.current.has(tab.id)) return
    fn(tab.id)
  }, [])

  const openInSystemBrowser = useCallback(() => {
    const snap = latestRef.current
    const tab = snap.tabs[snap.activeIndex]
    if (!tab?.url) return
    void openExternal(tab.url)
  }, [])

  /* ------------------------------------------------------------ 会话 / 持久化 */

  // 会话切换：旧会话的 view 必须销毁，否则 w1..w3 是全局 id，新会话会撞上旧页面
  useEffect(() => {
    if (sessionRef.current === props.sessionId) return
    sessionRef.current = props.sessionId

    const prevVisible = visibleRef.current
    visibleRef.current = null
    if (prevVisible) void webPaneSetVisible(prevVisible, false)
    for (const id of createdRef.current) void webPaneClose(id)
    createdRef.current.clear()

    if (!props.sessionId) {
      setTabs([])
      setActiveIndex(0)
      setRuntime({})
      setAddress('')
      setTabsSid('')
      return
    }

    let raw: string | null = null
    try {
      raw = localStorage.getItem(VIEWER_LS_KEYS.webTabs(props.sessionId))
    } catch {
      raw = null
    }
    const restored = restoreTabs(raw)
    setTabs(restored)
    setActiveIndex(0)
    setRuntime({})
    setAddress(restored[0]?.url ?? '')
    // 只有 tabsSid 与 props.sessionId 对齐了才允许写盘（见下面的持久化 effect）
    setTabsSid(props.sessionId)
    scheduleSync()
  }, [props.sessionId, scheduleSync])

  // 只存结构，不存状态：主进程回传的 title 是缓存，url 才是真相
  useEffect(() => {
    if (!props.sessionId || tabsSid !== props.sessionId) return
    try {
      localStorage.setItem(
        VIEWER_LS_KEYS.webTabs(props.sessionId),
        JSON.stringify(tabs.map((t) => ({ id: t.id, url: t.url, title: t.title ?? '' }))),
      )
    } catch {
      /* 存储不可用时放弃持久化：页签只是便利，不该把面板弄崩 */
    }
  }, [tabs, tabsSid, props.sessionId])

  /* ------------------------------------------------------------ 外壳请求 / 事件 */

  // C2：外链默认右侧打开，面板已开时复用当前页签（不新开）
  useEffect(() => {
    const req = props.request
    if (!req || !req.url) return
    const key = `${props.sessionId}:${req.seq}`
    if (lastReqRef.current === key) return
    lastReqRef.current = key
    void navigate(req.url)
  }, [props.request, props.sessionId, navigate])

  /**
   * 壳的页签模型带着地址恢复时（重启 / 休眠后重建）：内部没有页签才导航一次。
   * 等一帧再看页签数 —— 上面那个旧的 `aiTeach.webTabs.<sid>` 恢复是同步排在 effect 队列里的，
   * 直接读会拿到空数组、把恢复出来的页面顶掉。
   */
  const initialUrl = String(props.initialUrl ?? '').trim()
  useEffect(() => {
    if (!initialUrl) return
    const raf = requestAnimationFrame(() => {
      if (latestRef.current.tabs.length === 0) void navigate(initialUrl)
    })
    return () => cancelAnimationFrame(raf)
  }, [initialUrl, navigate])

  // 地址上报：壳把 url 写回页签对象（持久化 / 重启后还是这一页）
  const reportUrl = props.onUrlChange
  useEffect(() => {
    if (!reportUrl) return
    const url = activeTab?.url ?? ''
    if (url) reportUrl(url)
  }, [activeTab?.url, reportUrl])

  useEffect(() => {
    const off = onWebPaneChanged(({ id, state }) => {
      setRuntime((prev) => ({
        ...prev,
        [id]: {
          canGoBack: !!state.canGoBack,
          canGoForward: !!state.canGoForward,
          loading: !!state.loading,
          error: state.error || undefined,
        },
      }))
      setTabs((prev) => {
        let changed = false
        const next = prev.map((t) => {
          if (t.id !== id) return t
          const title = state.title?.trim() || t.title
          const url = state.url || t.url
          if (title === t.title && url === t.url && !t.dormant) return t
          changed = true
          return { ...t, title, url, dormant: false }
        })
        return changed ? next : prev
      })
      scheduleSync()
    })
    return off
  }, [scheduleSync])

  const panelTitle = activeTab ? tabCaption(activeTab) : ''
  const reportTitle = props.onTitleChange
  useEffect(() => {
    reportTitle?.(panelTitle)
  }, [panelTitle, reportTitle])

  // 用户没在敲字时，地址栏跟着真实导航走
  useEffect(() => {
    if (editing) return
    setAddress(activeTab?.url ?? '')
  }, [activeTab?.url, editing])

  /* ------------------------------------------------------------ bounds 触发器 */

  // 几何变化的四条来源：占位区自身尺寸（面板宽度过渡 / 页签条换行）、窗口 resize、
  // 字体加载完成（行高变了）、以及 props.width 变化（壳的宽度是外部状态，不一定先反映到 rect）
  useEffect(() => {
    const el = slotRef.current
    const ro = el ? new ResizeObserver(() => scheduleSync()) : null
    if (el && ro) ro.observe(el)
    const onResize = () => scheduleSync()
    window.addEventListener('resize', onResize)
    // 字体就绪后 chrome 行高可能变 1px，占位区跟着挪
    void document.fonts.ready.then(() => scheduleSync()).catch(() => undefined)
    scheduleSync()
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [scheduleSync])

  // 可见性 / 页签 / 失败态的显式触发（ResizeObserver 看不到这些）。
  // `syncToken`：壳在浮层（`+` 菜单 / 全部页签 / 旁问历史）打开时 `webPaneHideAll()`，
  // 浮层关掉后 bump 这个值让原生视图回来 —— 它不会自己重新 show。
  useEffect(() => {
    scheduleSync()
  }, [props.width, props.active, props.open, props.syncToken, activeTab?.id, activeTab?.url, activeRuntime.error, scheduleSync])

  // 卸载只关自己建的 view：disposeAll 是全局的，会把别的会话正在用的页面一起关掉
  useEffect(
    () => () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = 0
      }
      const visible = visibleRef.current
      visibleRef.current = null
      if (visible) void webPaneSetVisible(visible, false)
      const ids = Array.from(createdRef.current)
      createdRef.current.clear()
      for (const id of ids) void webPaneClose(id)
    },
    [],
  )

  /* ------------------------------------------------------------ 渲染 */

  const loadingBar = activeLive && props.active && activeRuntime.loading && !activeRuntime.error

  const placeholder = (() => {
    if (!activeTab || !activeTab.url) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
          <p className="text-[12px] text-[var(--text-secondary)]">输入网址，或粘贴一个链接</p>
          <div className="flex w-full max-w-[240px] flex-col gap-1">
            {QUICK_LINKS.map((q) => (
              <button
                key={q.url}
                type="button"
                onClick={() => void navigate(q.url)}
                className="flex h-7 w-full items-center gap-2 rounded-md border border-[var(--border-color)] px-2 text-left text-[12px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
              >
                <Globe size={12} className="shrink-0 text-[var(--text-muted)]" />
                <span className="truncate">{q.label}</span>
              </button>
            ))}
          </div>
        </div>
      )
    }

    if (activeTab.dormant) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-[12px] text-[var(--text-secondary)]">这个页签还没有加载</p>
          <p className="max-w-[220px] truncate text-[11.5px] text-[var(--text-muted)]">{activeTab.url}</p>
          <button
            type="button"
            onClick={wakeActive}
            className="mt-1 rounded-md border border-[var(--border-color)] px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
          >
            加载这个页签
          </button>
        </div>
      )
    }

    if (activeRuntime.error) {
      return (
        <div className="flex h-full items-center justify-center p-4">
          <div className="kb-item-in w-full max-w-[300px] rounded-lg border border-[var(--border-color)] bg-[var(--card-bg)] p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--warning)]" />
              <div className="min-w-0">
                <p className="text-[12.5px] text-[var(--text-primary)]">无法加载这个页面</p>
                <p className="mt-0.5 break-words text-[11.5px] text-[var(--text-muted)]">{activeRuntime.error}</p>
              </div>
            </div>
            <div className="mt-2.5 flex gap-1.5">
              <button
                type="button"
                onClick={() => void navigate(activeTab.url)}
                className="rounded-md border border-[var(--border-color)] px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
              >
                重试
              </button>
              <button
                type="button"
                onClick={openInSystemBrowser}
                className="rounded-md px-2.5 py-1 text-[11.5px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                在系统浏览器打开
              </button>
            </div>
          </div>
        </div>
      )
    }

    if (activeRuntime.loading) {
      return (
        <div className="flex h-full items-center justify-center">
          <span className="text-[11.5px] text-[var(--text-muted)]">正在加载页面…</span>
        </div>
      )
    }

    // 已就绪：这块是透明的，真实像素由主进程原生视图盖上来
    return null
  })()

  const placeholderKey = !activeTab || !activeTab.url
    ? 'start'
    : activeTab.dormant
      ? `dormant:${activeTab.id}`
      : activeRuntime.error
        ? `error:${activeTab.id}`
        : activeRuntime.loading
          ? `loading:${activeTab.id}`
          : `ready:${activeTab.id}`

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-secondary)]">
      {/* 内层页签条：切换只改 visible，不重建 view（主进程按 id 保活） */}
      <div
        role="tablist"
        aria-label="网页页签"
        className="flex h-7 shrink-0 items-center gap-1 overflow-x-auto px-1.5"
      >
        {tabs.map((t, i) => {
          const selected = i === activeIndex
          return (
            <div
              key={t.id}
              className={`kb-item-in flex h-6 min-w-0 shrink-0 items-center rounded-md ${
                selected ? 'bg-[var(--bg-primary)]' : 'hover:bg-[var(--bg-hover)]'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                data-tip={t.url || '新标签页'}
                onClick={() => activateTab(i)}
                className={`h-full max-w-[150px] min-w-0 truncate pl-2 pr-1 text-left text-[11.5px] ${
                  selected ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
                }`}
              >
                {tabCaption(t)}
              </button>
              <button
                type="button"
                aria-label={`关闭 ${tabCaption(t)}`}
                data-tip="关闭"
                onClick={() => closeTab(i)}
                className="mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <X size={10} />
              </button>
            </div>
          )
        })}
        <button
          type="button"
          aria-label="新建网页页签"
          data-tip="新建网页页签"
          onClick={addTab}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <Plus size={13} />
        </button>
      </div>

      {/* 浏览器动作行 */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--border-color)] px-1.5">
        <IconButton
          label="后退"
          disabled={!activeLive || !activeRuntime.canGoBack}
          onClick={() => withActiveView((id) => void webPaneBack(id))}
        >
          <ChevronLeft size={14} />
        </IconButton>
        <IconButton
          label="前进"
          disabled={!activeLive || !activeRuntime.canGoForward}
          onClick={() => withActiveView((id) => void webPaneForward(id))}
        >
          <ChevronRight size={14} />
        </IconButton>
        <IconButton
          label="重新加载"
          disabled={!activeLive}
          onClick={() => withActiveView((id) => void webPaneReload(id))}
        >
          <RotateCw size={13} />
        </IconButton>

        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            void navigate(address)
          }}
        >
          {/* 单控件形态：没有图标 / 前后缀，边框由全局 input 自己画（input-field-pattern §2） */}
          <input
            ref={addrRef}
            type="text"
            value={address}
            spellCheck={false}
            aria-label="网址"
            placeholder="输入网址"
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => {
              setEditing(true)
              e.currentTarget.select()
            }}
            onBlur={() => setEditing(false)}
            // 焦点内 Esc 不清空、也不拦：关闭面板的意图交给外壳的全局键位
            className="h-[26px] w-full rounded-md px-2 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)]"
          />
        </form>

        <IconButton
          label="在系统浏览器打开"
          disabled={!activeTab?.url}
          onClick={openInSystemBrowser}
        >
          <ExternalLink size={13} />
        </IconButton>
      </div>

      {/* 内容区：上层 DOM 是占位层，真实像素由主进程原生视图盖在上面 */}
      <div ref={slotRef} className="relative flex-1 min-h-0">
        {/* 进度条挂在占位区上沿之外 2px —— 盖在视图里就等于看不见 */}
        <div
          aria-hidden={!loadingBar}
          className="kb-view-toggle pointer-events-none absolute inset-x-0 -top-[2px] z-10 h-[2px] overflow-hidden"
        >
          <div className="h-full w-1/3 rounded-full bg-[var(--accent)] animate-pulse" />
        </div>

        <div className="absolute inset-0 overflow-auto">
          {placeholder ? (
            <div key={placeholderKey} className="kb-view-fade h-full">
              {placeholder}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
