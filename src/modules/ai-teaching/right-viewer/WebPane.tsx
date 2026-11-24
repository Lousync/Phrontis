import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, Globe, RotateCw } from 'lucide-react'
import type { WebPaneProps } from './paneContracts'
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
  normalizeUrl,
  shouldRebuildWebView,
  shouldShowView,
  tabCaption,
  type WebTabRef,
} from './webPanePure'

/**
 * AI 教学右侧查看器 · 网页页签（渲染层）
 *
 * 结构：单行动作条（← → ↻ [地址栏] ↗）→ 内容占位区。**没有内层页签条**
 * （2026-11-22 删除：壳层页签条 + `+` 菜单已经是唯一的「新建 / 关闭」权威，
 * 内层再放一套就是两个 `+`、两个 `×`；壳的 web 页签本来就只存一个 URL）。
 * 本实例恒为「0 或 1 个页面」，多开留给「网页多开扁平化」那一批（壳层一个 web 页签 = 一个 wN）。
 *
 * 内容区的真实像素不在 React 里：主进程用 `WebContentsView` 盖在占位区上面，
 * 渲染层只做两件事 —— 把占位区的 CSS px 几何同步过去、决定它该不该可见。
 * 方案：`/home/lousync/Projects/DesginProcess/Phrontis/已实现设计文档/ai-teaching-right-viewer-plan.md` §6.1 / §8 / §9；决策 C2 / C4 / C6。
 */

interface TabRuntime {
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  /** did-fail-load 的 errorDescription；成功导航后主进程会清空 */
  error?: string
}

const EMPTY_RUNTIME: TabRuntime = { canGoBack: false, canGoForward: false, loading: false }

interface PaneSnapshot {
  tabs: WebTabRef[]
  activeIndex: number
  active: boolean
  open: boolean
  error?: string
}

/**
 * 占位区的五种面貌 —— 必须一眼能分开（PLAN §5）：
 *   start   空态：只有顶部那一行地址栏 + 内容区极淡点阵，没有任何禁用图标以外的装饰；
 *   dormant 休眠：换会话恢复了地址但按 C6 不预加载（没有原生视图，卡片里有唯一动作）；
 *   loading 加载中：原生视图里是站点自己的首屏，能看见的只有顶部 2px 进度条；
 *   error   加载失败：失败卡（重试 / 系统浏览器打开），动作条上没有第二个「刷新」入口；
 *   ready   已打开：原生视图盖住整个占位区，DOM 侧返回 null。
 */
type PanePhase = 'start' | 'dormant' | 'loading' | 'error' | 'ready'

/**
 * 空态底纹（PLAN §3 方案 B）：18px 网格、1px 点、`--text-primary` 5%。
 *
 * 只用 background-image，不加 DOM 节点、不做动画；外层是 `absolute inset-0` 的装饰层，
 * 绝对定位不参与滚动尺寸，所以既不会撑出滚动条也不影响原生视图的 bounds。
 * 浅色主题由令牌自动反相，不写死颜色。
 */
const DOT_GRID_STYLE: CSSProperties = {
  backgroundImage: 'radial-gradient(color-mix(in srgb, var(--text-primary) 5%, transparent) 1px, transparent 1px)',
  backgroundSize: '18px 18px',
  backgroundPosition: 'center',
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
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-default disabled:text-[var(--text-disabled)] disabled:opacity-[0.55] disabled:hover:bg-transparent disabled:hover:text-[var(--text-disabled)]"
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

  const slotRef = useRef<HTMLDivElement | null>(null)
  const addrRef = useRef<HTMLInputElement | null>(null)
  const createdRef = useRef<Set<string>>(new Set())
  const visibleRef = useRef<string | null>(null)
  const frameRef = useRef<number>(0)
  const sessionRef = useRef('')
  const lastReqRef = useRef('')
  /** 首次挂载 ≠ 换会话：挂载时 initialUrl 是「用户刚点开的东西」，必须直接加载 */
  const firstMountRef = useRef(true)
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

  /**
   * 唯一导航入口：地址栏回车、外链请求、失败重试、休眠页签唤醒都走这里。
   * 本 pane 恒为「一个页面」：页面实例的 id 固定 `w1`（主进程按 id 保活 view），
   * 再次导航就是替换这一个页签，而不是新开一个。
   */
  const navigate = useCallback(
    async (raw: string) => {
      const url = normalizeUrl(raw)
      if (!url) {
        rejectToast(raw)
        // 地址被拒之后把焦点还给地址栏（状态在组件里，用户敲的字不会丢）
        requestAnimationFrame(() => addrRef.current?.focus())
        return
      }
      const snap = latestRef.current
      const id = snap.tabs[snap.activeIndex]?.id ?? 'w1'
      setTabs([{ id, url, dormant: false }])
      setActiveIndex(0)
      setAddress(url)
      setRuntime((prev) => ({ ...prev, [id]: { ...EMPTY_RUNTIME, loading: true } }))
      await mountOrNavigate(id, url)
      scheduleSync()
    },
    [mountOrNavigate, rejectToast, scheduleSync],
  )

  /** 休眠页签点「加载这个页签」时显式唤醒（C6：恢复不预加载，加载只在这一刻发生） */
  const wakeActive = useCallback(() => {
    const snap = latestRef.current
    const tab = snap.tabs[snap.activeIndex]
    if (!tab || !tab.url || createdRef.current.has(tab.id)) return
    // 先摘掉 dormant：进度条只在 loading 态出现，点了加载就不该还停在休眠卡上
    setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, dormant: false } : t)))
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

  /* ------------------------------------------------------------ 会话 / 恢复 */

  /**
   * 会话切换 / 首次挂载。
   *
   * 2026-11-23 两条修正（缺陷 1 / 2）：
   *   · **首挂必须等会话 id 非空**。会话 id 是异步恢复的，首帧拿到 `''` 只说明「还不知道是哪个会话」，
   *     此时既不能建视图、也不能把 `firstMountRef` 消费掉 —— 否则 id 晚到会被误判成「换会话」，
   *     走恢复分支清空页签，而 `initialUrl` 没有变化不再触发导航，页面就永久空白。
   *   · **换会话不再卸载视图**。笔记 / 旁问 / 书架本来就跨会话保活；单页化后壳层只有一个网页页签，
   *     `w1` 始终是同一个 view，不存在「另一个会话的 pane 抢同一槽位」。只有壳给的地址与当前页
   *     不同（重启恢复 / 壳里改了地址）才导航过去；地址为空则保持现状。
   *
   * 恢复口径（2026-11-22 内层页签条删除后）：**不再读写 `aiTeach.webTabs.<sid>`**
   * —— 那是内层页签结构的旧键，壳层已经把它当「只读迁移」吞进 v2 页签（`viewerTabs.ts`
   * 的 `parseLegacyWebTabs` + `migrateLegacyViewerState`），pane 再写一份就是第二个真相源。
   * 现在唯一的地址来源是壳传下来的 `initialUrl`（壳的 web 页签只存一个 URL）。
   */
  useEffect(() => {
    const sid = String(props.sessionId ?? '').trim()

    if (firstMountRef.current) {
      // 会话 id 还没恢复：保持首挂态，等它到齐（不清空、不建视图、不消费 firstMountRef）
      if (!sid) return
      firstMountRef.current = false
      sessionRef.current = sid
      // 首挂的加载交给下面的 initialUrl effect（rAF 里避开首帧几何为零）
      return
    }

    if (sessionRef.current === sid) return
    sessionRef.current = sid

    // 会话变了 / 或壳给了新地址：只有「目标地址确实与当前页不同」才动视图
    const tabs = latestRef.current.tabs
    const currentUrl = String(tabs[latestRef.current.activeIndex]?.url ?? tabs[0]?.url ?? '')
    const target = String(props.initialUrl ?? '')
    if (!shouldRebuildWebView({ mounted: true, sessionId: sid, initialUrl: target, currentUrl })) return
    void navigate(target)
  }, [props.sessionId, props.initialUrl, navigate])

  /* ------------------------------------------------------------ 外壳请求 / 事件 */

  // C2：外链默认右侧打开，面板已开时复用当前页签（不新开）
  // `seq` 是模块级单调递增的一次性请求号，**不掺会话 id**：跨会话保活后切会话不该重放
  // 上一段生命里已经处理过的旧地址（那会把正在读的页面顶掉，正是缺陷 2 的另一半）。
  useEffect(() => {
    const req = props.request
    if (!req || !req.url) return
    const key = String(req.seq)
    if (lastReqRef.current === key) return
    lastReqRef.current = key
    void navigate(req.url)
  }, [props.request, navigate])

  /**
   * 壳的页签模型带着地址（重启恢复 / 新建网页页签时直接带 URL）：空态才导航一次。
   *
   * 不再等会话 id：网页视图是全局 w1，与「这段对话是否已就绪」无关；重启后落在
   * 「还没有任何会话的工作区」时也必须把地址加载出来（2026-11-23 复验发现）。
   * 晚到的会话 id 只会走首挂分支并直接 return，不会清掉已经加载的页面（缺陷 1 已修）。
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

  // 几何变化的四条来源：占位区自身尺寸（面板宽度过渡）、窗口 resize、
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

  const phase: PanePhase = !activeTab || !activeTab.url
    ? 'start'
    : activeTab.dormant
      ? 'dormant'
      : activeRuntime.error
        ? 'error'
        : activeRuntime.loading
          ? 'loading'
          : 'ready'

  // 动作条的可见性按状态矩阵走（PLAN §4.1）：休眠没有 view、天然没有历史，干脆不摆三个空按钮；
  // 失败态的「重试」只在卡里，动作条不再留第二个刷新入口。
  // 空态与「有页面但没历史」都**不隐藏**按钮，只用 disabled —— 否则每导航一次行的宽度都会变。
  const showNavButtons = phase !== 'dormant'
  const showReloadButton = phase !== 'dormant' && phase !== 'error'
  const loadingBar = phase === 'loading' && props.active

  const placeholder = (() => {
    if (phase === 'dormant' && activeTab) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <Globe size={22} strokeWidth={1.5} className="text-[var(--text-muted)] opacity-50" aria-hidden />
          <p className="text-[12px] text-[var(--text-secondary)]">这个页签还没有加载</p>
          <p className="max-w-[220px] truncate text-[11.5px] text-[var(--text-muted)]">{activeTab.url}</p>
          <button
            type="button"
            onClick={wakeActive}
            className="mt-1 h-6 rounded-md border border-[var(--border-color)] px-2.5 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
          >
            加载这个页签
          </button>
        </div>
      )
    }

    if (phase === 'error' && activeTab) {
      return (
        <div className="flex h-full items-center justify-center p-4">
          <div className="w-full max-w-[300px] rounded-lg border border-[var(--border-color)] bg-[var(--card-bg)] p-3">
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
                className="h-6 rounded-md border border-[var(--border-color)] px-2.5 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
              >
                重试
              </button>
              <button
                type="button"
                onClick={openInSystemBrowser}
                className="h-6 rounded-md px-2.5 text-[11.5px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                在系统浏览器打开
              </button>
            </div>
          </div>
        </div>
      )
    }

    // 加载中与已打开都不写 DOM 文案：这块会被主进程原生视图整块盖住，
    // 能看见的只有顶部那 2px 进度条（PLAN §5）。
    return null
  })()

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-secondary)]">
      {/* 唯一的动作行：空态也在原位，只有按钮变成 disabled（地址栏不跳位、焦点不丢） */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--border-color)] px-1.5">
        {showNavButtons && (
          <>
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
          </>
        )}
        {showReloadButton && (
          <IconButton
            label="重新加载"
            disabled={!activeLive}
            onClick={() => withActiveView((id) => void webPaneReload(id))}
          >
            <RotateCw size={13} />
          </IconButton>
        )}

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
          {loadingBar && (
            <div className="h-full w-1/3 rounded-full bg-[var(--accent)] animate-pulse motion-reduce:animate-none" />
          )}
        </div>

        <div className="absolute inset-0 overflow-auto">
          {phase === 'start' ? (
            /* 空态：只有一层极淡点阵。装饰层是 absolute，不撑滚动尺寸，也不挡任何指针事件 */
            <div key="start" aria-hidden className="kb-view-fade pointer-events-none absolute inset-0">
              <div className="absolute inset-0" style={DOT_GRID_STYLE} />
            </div>
          ) : placeholder ? (
            <div key={phase} className="kb-view-fade h-full">
              {placeholder}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
