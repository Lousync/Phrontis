import { useState, useEffect, useCallback, useRef, useMemo, Suspense, lazy } from 'react'
import { createPortal } from 'react-dom'
import { AppWindow } from 'lucide-react'
import type { TabName, KnowledgePage, KnowledgeCategory, KnowledgeTag, BookKind } from './types'

import { labelOf as tabLabel, resolveStartupTab, isTabName } from './lib/appModules'
import { WORKBENCH_TABBAR_EXCLUDED, AI_ASSISTANT_SHORTCUT_DISABLED } from './lib/workbenchLayout'
import { WorkbenchShell } from './components/workbench/WorkbenchShell'
import { WorkbenchPageBar, PAGE_OWNED } from './components/workbench/WorkbenchPageBar'
import { WorkbenchRightPanel } from './components/workbench/WorkbenchRightPanel'
import { ToolHost, PluginToolHost, TOOLS_WITH_SIDEBAR, isToolTabId, toolIdOfTab, toolTabId } from './components/workbench/toolRegistry'
import { parseWorkbenchLayout, RAIL_FOLLOW_MAP, QUIZ_ENTRY_ENABLED, WORKBENCH_BOOKMARKS, LOCATE_QUIZ_VIEW_EVENT, QUIZ_VIEW_TOGGLED_EVENT, QUIZ_VIEW_CLOSE_REQUEST_EVENT, type RailModule } from './lib/workbenchLayout'

import { TitleBar, ActivityBar, GlobalConfirm } from './components/shared'
import { ZenHotZone } from './components/shared/ZenHotZone'
import { WorkbenchStatusBar } from './components/shared/WorkbenchStatusBar'
import { CommandPalette, type PaletteItem } from './components/shared/CommandPalette'
import { CodePluginHosts } from './components/shared/CodePluginHosts'
import { Toast } from './components/shared/Toast'
import { FONT_CSS_MAP, applyThemeClass } from './lib/settings'
import { useSettings } from './lib/SettingsContext'
import { isEditingInput } from './lib/shortcuts'
import { setGlobalActiveTab } from './lib/activeTab'
import { getKnowledgePages, getKnowledgeCategories, getKnowledgeTags, workspaceGetCurrent, getReleaseNotesState, pluginListCommands, onPluginInstalledChanged, excerptList } from './lib/ipc'
import { getPluginTools } from './lib/pluginService'
import { requestPluginViewActivation, dispatchCodePluginAction } from './lib/pluginCommandBus'
import { showToast } from './lib/toast'
import type { PluginCommandInfo } from './types'
import type { PluginTool } from './lib/pluginService'
/* 模块引入方式（2026-09-10 二次修正：回退到静态 import）
   曾把 12 个模块改成 React.lazy 做代码分割——首屏从 13.3MB 降到 3.37MB，但代价是
   「每次打开应用后，进入一个尚未访问过的模块都要现取 chunk」：生产下数十 ms，
   dev 下还要叠加 vite 的按需编译（数百 ms）。即使用空闲 + 悬停预热补偿，实测仍能感到
   约 100ms 停顿（chunk 就绪后，Suspense 从 fallback 切回真实内容还要整树渲染一次）。
   本项目是「多 Tab 首挂后 display:none 常驻保活」架构、模块切换极频繁，
   用首屏体积换切换延迟不划算。故模块改回静态 import；
   **真正的大头（monaco 8.3MB / pdfjs / heic-to）仍由各自宿主组件 lazy 拆出**，
   兼顾启动体积与切换手感。 */
import { BlogModule } from './modules/blog'
import type { BlogJump } from './modules/blog'
import type { SummaryKind } from './lib/summary'
import { ScheduleModule } from './modules/schedule'
import { KnowledgeModule } from './modules/knowledge'
import { MomentsModule } from './modules/moments'
import { RecycleBinModule } from './modules/recycle'
import { SettingsModule } from './modules/settings'
import { HelpModule } from './modules/help'
import { ToolboxModule } from './modules/toolbox'
import { PluginsModule } from './modules/plugins'
import { BookshelfModule } from './modules/bookshelf'
import { AiTeachingModule } from './modules/ai-teaching'
import { ReleaseNotesModule } from './modules/release-notes'
// 左栏书架大纲态（内含 pdfjs —— 必须 lazy，不进主包；见上方模块引入方式注释）
const PdfRailPanel = lazy(() => import('./components/shared/pdf/PdfRailPanel').then((m) => ({ default: m.PdfRailPanel })))
// 左栏书架书目条目视图（2026-09-19）：未在读任何书时左栏放书列表（封面 + 书名 + 进度条）
const BookshelfSideList = lazy(() => import('./modules/bookshelf/BookshelfSideList').then((m) => ({ default: m.BookshelfSideList })))

import { FillPopup } from './modules/toolbox/components/FillPopup'
import { VaultPicker } from './components/shared/VaultPicker'
import { KB_PDF_GOTO_PAGE, KB_TXT_GOTO_PARA, KB_OPEN_EXCERPT_LOC } from './components/shared/pdf/pdfEvents'
import { bookDisplayName } from '../electron/lib/kbStore/bookFormats'
import { PomodoroProvider } from './modules/toolbox/hooks/PomodoroContext'
import { PomodoroPanel } from './modules/toolbox/components/PomodoroPanel'
import { Onboarding } from './components/shared/Onboarding'
import { ImportModal } from './modules/shared/components/ImportModal'
import { useCheckinReminder } from './lib/useCheckinReminder'
import { installFileOpUndoShortcuts } from './lib/fileOpHistory'
import { AssistantPanel } from './components/shared/AssistantPanel'
import { AiChatTab } from './components/shared/AssistantPanel/ChatBody'
import { DayPanelWindowApp } from './daypanel/DayPanelWindowApp'
import { RootErrorBoundary } from './components/shared/RootErrorBoundary'
import { WindowResizeHandles } from './components/shared/WindowResizeHandles'
// 仅类型引用,编译期擦除,不会把 devtools 模块带进正式版 bundle
import type { DevToolsModuleProps } from './modules/devtools'
/** 更新说明自动打开的延迟（ms）。错开标题栏 updateStartupCheck() 的 6s 静默检查，
 *  也留出首屏渲染时间——它是一次「告知」，不该和启动路径抢资源。 */
const RELEASE_NOTES_AUTO_OPEN_DELAY_MS = 2000

/** 模块 chunk 拉取期间的占位（仅首次访问该 Tab 时出现一瞬，之后由保活层常驻） */
function ModuleLoadingFallback() {
  return <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--text-muted)] select-none">加载中…</div>
}

export default function App() {
  // Fill popup mode: render standalone popup instead of full app
  if (window.api.isFillPopup) {
    return <FillPopup />
  }
  // 日程与打卡小窗：独立 BrowserWindow 加载 #/day-panel（argv 由主进程注入），渲染独立面板
  if (window.api.isDayPanel) {
    return <DayPanelWindowApp />
  }
  // 2026-09-17 第三轮反馈：允许全部标签关闭（拍板③）→ activeTab 可为 null = 空态（无激活模块）。
  // 初始 null = settings 恢复前的空窗（占位改 null 而非 'blog'：'blog' 会被 openTabs 登记
  // 成假标签——settings 在 mount 前往往已 ready，ready 判定拦不住；null 由 !activeTab 守卫天然拦住）。
  const [activeTab, setActiveTab] = useState<TabName | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidths, setSidebarWidths] = useState<Record<string, number>>({})
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [importBackupPath, setImportBackupPath] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  // 启动检测一次性标记（无当前仓库 → 出 VaultPicker；见下方 startupChecked 效应）
  const [startupChecked, setStartupChecked] = useState(false)
  // 启动仓库选择页（startupVaultPicker，默认开）：已有仓库时每次进入先给一次选择/快速直入的机会
  const [startupPickerOpen, setStartupPickerOpen] = useState(false)
  // 日程打卡侧边栏（WeChat 模式）：v3.4.0 批次4 起内嵌态由右栏小工具接管（控件迁移），
  // 本窗口只保留**脱离态**（独立桌面窗口）；dayPanelDetached 同时驱动右栏控件互斥显示
  const [dayPanelDetached, setDayPanelDetached] = useState(false)
  // 窗口宽度：任务栏最大宽度与窗口联动（窄窗口自动收窄，主体不被压扁）
  const [winWidth, setWinWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = () => setWinWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 文件操作撤销快捷键（Ctrl+Z 撤销 / Ctrl+Shift+Z·Ctrl+Y 重做）：
  // 编辑区与知识库共用一份栈；焦点在 Monaco/输入框时自动让路给文本撤销（isEditingInput）
  useEffect(() => installFileOpUndoShortcuts(), [])

  // 窗口圆角：透明窗口自绘 18px 大圆角；最大化/全屏时切直角（贴满屏幕时圆角会露四角缝）。
  // fsHint = 禅模式已请求全屏的乐观态：Windows 下 enter-full-screen 事件可能迟到或缺失，
  // 以「禅模式自己发起的全屏」直接置直角最可靠；事件到达后以真实状态为准
  const [winMax, setWinMax] = useState(false)
  const [winFs, setWinFs] = useState(false)
  const [fsHint, setFsHint] = useState(false)
  useEffect(() => {
    window.api?.isMaximized?.().then(setWinMax)
    window.api?.onMaximizeChange?.(setWinMax)
    window.api?.onFullscreenChange?.(setWinFs)
  }, [])
  const winRounded = !winMax && !winFs && !fsHint

  // v3.4.0 批次3：左栏模块态 slot 节点（模块侧栏 portal 目标，挂载点迁移）。
  // 以 state 持有保证 portal 目标出现后触发重渲染；ref 回调用 useCallback 稳定引用，
  // React 卸载节点时才以 null 调用，避免内联箭头每帧触发 setState（editor R1-W1 同款手法）
  const [wbModSlotEl, setWbModSlotEl] = useState<HTMLElement | null>(null)
  const wbModSlotRef = useCallback((node: HTMLDivElement | null) => {
    setWbModSlotEl(node)
  }, [])

  // 模块态头部动作槽（2026-09-19 反馈）：模块自己的标题行删除，聚焦/写作等按钮 portal 到
  // 左栏头部（🏠 🔒）最右。ref/state 手法与 wbModSlotEl 同款。
  const [wbModActionsEl, setWbModActionsEl] = useState<HTMLElement | null>(null)
  const wbModActionsRef = useCallback((node: HTMLDivElement | null) => {
    setWbModActionsEl(node)
  }, [])

  // v3.4.0「页面条置顶」（2026-09-18）：中间栏页面条内的两个页签组槽 —— 编辑器与知识库
  // 各自把现有页签条 portal 进来（与上面 wbModSlotEl 同款手法与托管语义）。
  // 另有一个内容级操作槽（插图/大纲/预览/保存全部 的胶囊），挂在内容区右上角浮层里。
  const [wbEditorPageEl, setWbEditorPageEl] = useState<HTMLElement | null>(null)
  const wbEditorPageRef = useCallback((node: HTMLDivElement | null) => { setWbEditorPageEl(node) }, [])
  const [wbKnowledgePageEl, setWbKnowledgePageEl] = useState<HTMLElement | null>(null)
  const wbKnowledgePageRef = useCallback((node: HTMLDivElement | null) => { setWbKnowledgePageEl(node) }, [])
  const [wbContentActionsEl, setWbContentActionsEl] = useState<HTMLElement | null>(null)
  const wbContentActionsRef = useCallback((node: HTMLDivElement | null) => { setWbContentActionsEl(node) }, [])
  // 知识库沉浸阅读 / 图谱模式：模块自己让整条页面条隐藏（那些形态下外壳行也该让位，模块内无法触及）
  const [knowledgeImmersive, setKnowledgeImmersive] = useState(false)
  const handleKnowledgeImmersive = useCallback((v: boolean) => setKnowledgeImmersive(v), [])

  // 左栏模块态（书签侧边栏）：null = 总览态。跟随逻辑见下方 effect（RAIL_FOLLOW_MAP + leftLocked）
  const [railModule, setRailModule] = useState<RailModule | null>(null)
  // 左栏工具侧栏态（2026-09-17 右栏优化轮）：激活工具标签属于 TOOLS_WITH_SIDEBAR 时，
  // 该工具的侧栏 portal 进左栏模块态 slot（与 railModule 互斥共用 slot；锁定/树模式优先）。
  // RailModule 类型不动——工具侧栏态是瞬态跟随（随 activeToolTab 变化），不进书签/持久化体系。
  const [railTool, setRailTool] = useState<string | null>(null)

  // 禅模式（docs/zen-mode-design.md）：0=off 1=Z1 专注 2=禅。唯一真相源在 App 层——
  // Z2 需隐藏标题栏/活动栏（模块内无法触及）。入口 = 命令面板「布局：禅模式（全屏沉浸）」；
  // 退出三条：ZenHotZone 顶栏热区 / Esc（模块内）/ 命令面板同一条命令再执行一次；
  // 持久化档位由 changeZen 统一收口
  const [zenLevel, setZenLevel] = useState<number>(0)

  const { s, update, ready: settingsReady } = useSettings()
  const workbench = !!s.uiWorkbench
  // 工作台布局（workbenchLayout 键钝解析）：左栏锁定/树模式供跟随与左栏交互用
  const wbLayout = useMemo(() => parseWorkbenchLayout(s.workbenchLayout), [s.workbenchLayout])
  // 布局 · 活动栏整条显隐。原名「自定义布局」的标题栏下拉已于 2026-09-17 整条删除，
  // 唯一入口收敛到命令面板「布局：隐藏/显示活动栏」（快捷键 Ctrl+Shift+P）。
  // 与 activityBarHidden（逐模块显隐）互不干扰：这里关的是「活动栏这个容器本身」。
  // 缺省 true：老仓库 settings.json 里没这个键 → 不因升级被突然藏掉活动栏
  const activityBarVisible = s.activityBarVisible !== false

  // OS 全屏的单一真相源：两个请求方各自表态，合成后才下发——
  //   ① 禅模式 Z2（受 zenFullscreen 开关约束）② 命令面板「布局：全屏」（VS Code F11 语义，与禅无关）
  // 刻意「合成」而不是各自记账：分开记账时退出禅模式会连带关掉用户自己开的全屏，两边状态失同步。
  // fsActiveRef = 当前已下发的全屏是否为我们自己请求的——用于躲开启动时空跑一次 setFullscreen(false)
  // （那会把「窗口恰好处于全屏」的现场踢掉）。退出还原（最大化 → 重新最大化，普通 → 还原 bounds）由主进程负责
  const [osFullscreen, setOsFullscreen] = useState(false)
  const wantFullscreen = (zenLevel >= 2 && !!s.zenFullscreen) || osFullscreen
  const fsActiveRef = useRef(false)
  useEffect(() => {
    if (wantFullscreen === fsActiveRef.current) return
    fsActiveRef.current = wantFullscreen
    setFsHint(wantFullscreen)
    window.api?.setFullscreen?.(wantFullscreen)
  }, [wantFullscreen])

  // R1-W2：命令面板 / 快速切换器（Ctrl+Shift+P / Ctrl+O），两布局均可用（docs/rework-workbench-design.md §3）
  const [palette, setPalette] = useState<null | 'command' | 'file'>(null)
  const [fileItems, setFileItems] = useState<PaletteItem[]>([])
  const [fileLoading, setFileLoading] = useState(false)
  // 插件命令（plugin-phase1-design C3）：命令面板聚合 + 执行分发（切模块激活视图 / 推常驻 Worker）
  const [pluginCommands, setPluginCommands] = useState<PluginCommandInfo[]>([])
  useEffect(() => {
    const load = () => { void pluginListCommands().then(setPluginCommands).catch(() => null) }
    load()
    const off = onPluginInstalledChanged(load)
    return off
  }, [])
  // 插件 UI 工具清单（批次4）：右栏入口区的插件工具标签宿主匹配用（ToolLauncherZone 自持一份渲染清单）
  const [pluginTools, setPluginTools] = useState<PluginTool[]>([])
  useEffect(() => {
    const load = () => { void getPluginTools().then(setPluginTools).catch(() => null) }
    load()
    window.addEventListener('plugins-changed', load)
    return () => window.removeEventListener('plugins-changed', load)
  }, [])
  // 工具箱「回主页」信号（单调递增）：已在工具箱时点击活动栏图标 → +1，工具箱模块据此退出当前工具。
  // 用信号而非命令布尔值：同一信号值不会重复触发，连续点击每次都生效
  const [toolboxHomeSignal, setToolboxHomeSignal] = useState(0)

  // 禅模式档位统一出口：内存 + 持久化。入口 = 命令面板「布局：禅模式（全屏沉浸）」
  // （标题栏「自定义布局」菜单已于 2026-09-17 整条删除，这是进禅的唯一入口）；
  // Esc / 顶部 8px 热区退出也走这里，保证持久化一致
  const changeZen = useCallback((n: number) => { setZenLevel(n); update('zenLevel', n) }, [update])

  // ---- 全局搜索（反馈轮：顶栏搜索框删除，入口搬进左栏搜索态——总览态 🔍 / Ctrl+P / Ctrl+`）----
  // 打开页面/定位目录仍经事件通道进知识库模块（openKnowledgePageFromSearch / locateKnowledgeCategoryFromSearch）
  const [leftSearchMode, setLeftSearchMode] = useState(false)
  const openKnowledgePageFromSearch = useCallback((pageId: string) => {
    setActiveTab('knowledge')
    // 冷启动时知识库模块可能尚未挂载（保活注册表为空），延迟派发等监听器就绪
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('kb-open-knowledge-page', { detail: { pageId } })), 100)
  }, [])
  const locateKnowledgeCategoryFromSearch = useCallback((categoryId: string) => {
    setActiveTab('knowledge')
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('kb-locate-knowledge-category', { detail: { categoryId } })), 100)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 全局 Esc 退禅兜底（开发负责人 2026-09-15 拍板「全生效」）：禅入口不再挂在编辑器 / AI 教学
      // 手里之后，从任意模块都能进禅，但此前只有那两个模块自己监听 Esc，其余模块只能摸顶部 8px 热区。
      // 编辑器 / AI 教学仍优先走自己那份（带「先关本模块弹窗再退禅」的档位逻辑，App 不抢）；
      // 命令面板 / 快速切换器开着时 Esc 归它们收。
      if (e.key === 'Escape' && zenLevel >= 2 && !palette) {
        const zenOwnerActive = activeTab === 'aiTeaching'
        if (!zenOwnerActive) { e.preventDefault(); changeZen(0); return }
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault()
        setPalette((p) => (p === 'command' ? null : 'command'))
        return
      }
      // 左栏搜索态快捷键（反馈轮：顶栏搜索框删除后，Ctrl+P / Ctrl+` / Ctrl+Shift+F 全部指向左栏搜索）
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P' || e.key === '`')) {
        e.preventDefault()
        setLeftSearchMode(true)
        return
      }
      if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault()
        setLeftSearchMode(true)
        return
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault()
        setPalette((p) => (p === 'file' ? null : 'file'))
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // 依赖带全：退禅兜底需要读到当前禅档位 / 激活模块 / 面板态，重挂监听比 ref 镜像直白
  }, [zenLevel, activeTab, palette, changeZen])

  // 快速切换器数据源：知识页索引（默认 vault 读源带 path → 经 kb-open-note 在编辑器组打开）
  useEffect(() => {
    if (palette !== 'file') return
    let alive = true
    setFileLoading(true)
    getKnowledgePages()
      .then((ps) => {
        if (!alive) return
        setFileItems(
          (ps ?? [])
            .filter((p) => !!p.path)
            .map((p) => ({
              id: p.id,
              label: p.title || (p.path as string),
              hint: p.path ?? undefined,
              group: '知识页',
              run: () => {
                setPalette(null)
                if (p.path) window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: p.path } }))
              },
            })),
        )
        setFileLoading(false)
      })
      .catch(() => { if (alive) setFileLoading(false) })
    return () => { alive = false }
  }, [palette])

  const openTab = useCallback((tab: TabName) => {
    setActiveTab(tab)
    setSidebarOpen(true)
    setPalette(null)
  }, [])

  /** 插件命令执行分发（plugin-phase1-design C3）：有视图 → 切模块激活；code 插件 → 推常驻 Worker */
  const SLOT_MODULE: Record<string, TabName> = { knowledge: 'knowledge', blog: 'blog', schedule: 'schedule', aiTeach: 'aiTeaching' }
  const runPluginCommand = useCallback((c: PluginCommandInfo) => {
    if (c.viewSlot) {
      const mod = SLOT_MODULE[c.viewSlot.split('.')[0]]
      if (mod) {
        openTab(mod)
        // 模块可能刚首挂：稍候广播激活（PluginSlotEntry 同时消费暂存请求，双保险）
        const slot = c.viewSlot
        window.setTimeout(() => requestPluginViewActivation(c.pluginId, slot), 80)
        return
      }
    }
    if (c.type === 'code') {
      if (!dispatchCodePluginAction(c.pluginId, 'command', { commandId: c.id })) {
        showToast({ type: 'info', message: `插件「${c.name}」后台未运行，无法执行命令` })
      }
      setPalette(null)
      return
    }
    showToast({ type: 'info', message: '该插件没有可打开的视图' })
    setPalette(null)
  }, [openTab])

  const buildCommandItems = (): PaletteItem[] => {
    const tabs: Array<{ id: TabName; label: string; hint?: string }> = [
      { id: 'knowledge', label: '打开 笔记', hint: '阅读 / 编辑 / 导航' },
      { id: 'aiTeaching', label: '打开 AI教学', hint: '讲义 / 研读 / 出题' },
      { id: 'blog', label: '打开 博客' },
      { id: 'schedule', label: '打开 日程' },
      { id: 'moments', label: '打开 说说' },
      { id: 'recycle', label: '打开 回收站' },
      { id: 'settings', label: '打开 设置' },
      { id: 'toolbox', label: '打开 工具箱' },
      { id: 'plugins', label: '打开 插件' },
      { id: 'help', label: '打开 帮助' },
      { id: 'releaseNotes', label: '打开 更新说明', hint: '本版做了什么' },
    ]
    const items: PaletteItem[] = tabs.map((t) => ({
      id: `open-${t.id}`,
      label: t.label,
      hint: t.hint,
      group: '打开模块',
      run: () => openTab(t.id),
    }))
    items.push(
      { id: 'toggle-workbench', label: workbench ? '布局：切回 旧布局' : '布局：启用 Workbench 外壳（实验）', group: '界面设置', run: () => { update('uiWorkbench', !workbench); setPalette(null) } },
      { id: 'toggle-lineno', label: s.showLineNumbers ? '编辑器：隐藏行号' : '编辑器：显示行号', group: '界面设置', run: () => { update('showLineNumbers', !s.showLineNumbers); setPalette(null) } },
      // 布局三条命令（活动栏显隐 / 禅模式 / OS 全屏）：标题栏「自定义布局」下拉于 2026-09-17 整条删除后，
      // 这里成为这三项能力的唯一入口（设置页 ui:false，不再另开入口）
      { id: 'toggle-activitybar', label: activityBarVisible ? '布局：隐藏活动栏' : '布局：显示活动栏', group: '界面设置', run: () => { update('activityBarVisible', !activityBarVisible); setPalette(null) } },
      { id: 'toggle-zen', label: zenLevel >= 2 ? '布局：退出禅模式' : '布局：禅模式（全屏沉浸）', group: '界面设置', run: () => { changeZen(zenLevel >= 2 ? 0 : 2); setPalette(null) } },
      { id: 'toggle-fullscreen', label: osFullscreen ? '布局：退出全屏' : '布局：全屏', group: '界面设置', run: () => { setOsFullscreen(!osFullscreen); setPalette(null) } },
    )
    // 插件命令（plugin-phase1-design C3）：hint = 插件名，与内置命令并列
    for (const c of pluginCommands) {
      items.push({
        id: `plugin-cmd-${c.pluginId}.${c.id}`,
        label: c.title,
        hint: c.name,
        group: '插件命令',
        run: () => runPluginCommand(c),
      })
    }
    return items
  }

  useCheckinReminder()
  const mountedTabs = useRef<Set<TabName>>(new Set())  // keep modules alive after first visit
  /** 中间标签条显示的已打开 Tab（v3.4.0）：只能由入口产生，无「＋新建」按钮；activeTab 变化时自动追加（见下方 effect）。
      2026-09-17 拍板：恢复为标签条数据源（文档标签式，可关闭/拖拽/全关空态），可关闭与重排由 closeTab / handleReorder 消费。
      批次4 起元素放宽为 string：模块标签 = TabName，工具标签 = `tool:<toolId>`（右栏工具入口区产生，不占 TabName）。 */
  const [openTabs, setOpenTabs] = useState<string[]>([])
  /** 激活的工具标签页（`tool:<toolId>` | null）。与 activeTab 互斥共现：工具标签激活时 activeTab=null
      （模块保活层照常 display:none 常驻），激活模块标签时清空。批次4 方案 §10.2「点击入口 → 中间开工具标签页」。 */
  const [activeToolTab, setActiveToolTab] = useState<string | null>(null)

  // 启动检测当前仓库：无 → 仓库选择页（VaultPicker，新老用户统一）；有且开启「每次启动选择仓库」→ 启动形态选择页
  // sessionStorage 一次性标记：应用内切库会整窗 reload（数据激活重读约定），热重载不再打扰；冷启动才重新出页
  useEffect(() => {
    if (!loaded || startupChecked || !settingsReady) return
    let alive = true
    window.api?.workspaceGetCurrent?.()
      .then((cur) => {
        if (!alive) return
        if (!cur) setVaultPickOpen(true)
        else if (s.startupVaultPicker && s.onboardingDone && !sessionStorage.getItem('kb-startup-picker-shown')) {
          sessionStorage.setItem('kb-startup-picker-shown', '1')
          setStartupPickerOpen(true)
        }
      })
      .catch(() => { if (alive) setVaultPickOpen(true) })
      .finally(() => { if (alive) setStartupChecked(true) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, startupChecked, settingsReady])

  // Set startup tab from settings — only on initial load, NOT on subsequent setting changes
  useEffect(() => {
    if (!settingsReady || !loaded) return
    // 口径统一收在 lib/appModules.resolveStartupTab：用户选的启动项可用就用它，否则**桌面兜底**。
    // 旧实现在这里维护了一张硬编码候选清单，里头含 recycle / help —— 而这两个模块不在活动栏的
    // 「显示/隐藏模块」菜单里（永远隐藏不掉），于是「把侧边栏模块全隐藏 + 重启」必然落到回收站。
    // 现在不再做任何逐项回退，从根上消掉这类兜底事故。
    setActiveTab(resolveStartupTab(s.startupTab, s.activityBarHidden))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsReady, loaded])

  // ---- 更新说明（VS Code 式）：启动按版本判定自动打开 ----
  // 判定在主进程（app.getVersion() vs 仓库 `.knowbase/modules/release-notes/index.json` 的基线），
  // 渲染层只消费结果。延迟 2s：错开 updateStartupCheck() 的 6s（不抢网络/IO），也不与首屏渲染抢。
  // 无当前仓库 / IPC 未就绪 → 静默失败，绝不打扰（更新说明不值得为它弹错误）。
  const activeTabRef = useRef<TabName | null>('blog')
  useEffect(() => { activeTabRef.current = activeTab }, [activeTab])
  const tabBeforeNotes = useRef<TabName | null>(null)
  const notesCheckedRef = useRef(false)
  useEffect(() => {
    if (!settingsReady || !loaded || notesCheckedRef.current) return
    notesCheckedRef.current = true
    let alive = true
    let timer = 0
    getReleaseNotesState()
      .then((st) => {
        if (!alive || !st?.shouldAutoOpen) return
        timer = window.setTimeout(() => {
          if (!alive) return
          const prev = activeTabRef.current
          tabBeforeNotes.current = prev === 'releaseNotes' ? null : prev
          setActiveTab('releaseNotes')
        }, RELEASE_NOTES_AUTO_OPEN_DELAY_MS)
      })
      .catch(() => { /* 静默 */ })
    return () => { alive = false; if (timer) window.clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsReady, loaded])

  /** 「知道了」：回到进更新说明之前那个模块（没有来源时退回启动模块） */
  const dismissReleaseNotes = useCallback(() => {
    const prev = tabBeforeNotes.current
    tabBeforeNotes.current = null
    openTab(prev ?? ((s.startupTab as TabName) || 'blog'))
  }, [openTab, s.startupTab])

  // Apply theme class to <html> — reacts to async loaded settings (fixes stale-default bug)
  // 插件主题:先确保 <style> 已注入,再应用主题类(插件主题依赖运行时注入的 CSS 变量)
  // 历史值归一化:旧版可能存了带 "." 的插件主题 id(点号会破坏 CSS 类选择器)
  useEffect(() => {
    const raw = s.theme
    const theme = raw.replace(/[^a-zA-Z0-9_-]/g, '-')
    if (theme !== raw) update('theme', theme)
    if (theme.startsWith('plugin-')) {
      import('./lib/pluginService').then(m => m.ensurePluginThemeStyles()).then(() => applyThemeClass(theme)).catch(() => applyThemeClass(theme))
    } else {
      applyThemeClass(theme)
    }
  }, [s.theme, settingsReady, update])

  // Apply persisted settings on first render — 必须等真实设置加载完成,否则会用默认值覆盖一次
  useEffect(() => {
    if (!settingsReady) return
    if (FONT_CSS_MAP[s.editorFont]) document.documentElement.style.setProperty('--font-sans', FONT_CSS_MAP[s.editorFont])
    setSidebarWidths({
      sidebarWidth_blog: s.sidebarWidth_blog,
      sidebarWidth_schedule: s.sidebarWidth_schedule,
      sidebarWidth_knowledgeCat: s.sidebarWidth_knowledgeCat,
      sidebarWidth_knowledgePages: s.sidebarWidth_knowledgePages,
      sidebarWidth_devtools: s.sidebarWidth_devtools,
    })
    document.documentElement.style.fontSize = `${Math.min(s.zoomMax, Math.max(s.zoomMin, s.zoom)) * 16}px`
    setLoaded(true)
  }, [settingsReady]) // eslint-disable-line react-hooks/exhaustive-deps

  // 空闲预热大 chunk（性能 2026-09-20）：PageEditor 静态内联 monaco（构建产物 monaco chunk 8.12MB），
  // 不预热时**首次打开笔记页面**（哪怕只是阅读态）都要现拉现解析这 8MB —— dev 下体感约 2s。
  // 启动完成后在浏览器空闲期后台 import，把拉取+解析成本从「用户开门瞬间」挪到「启动后空闲」。
  // 串行排队（monaco 优先、pdfjs 靠后），不与启动路径抢主线程。
  useEffect(() => {
    if (!loaded) return
    const w = window as Window & {
      requestIdleCallback?: (cb: (deadline: IdleDeadline) => void, opts?: { timeout: number }) => number
      cancelIdleCallback?: (id: number) => void
    }
    const idle = (fn: () => void, timeout: number): number =>
      w.requestIdleCallback ? w.requestIdleCallback(fn, { timeout }) : window.setTimeout(fn, timeout)
    const ids = [
      idle(() => { void import('./modules/knowledge/components/PageEditor').catch(() => {}) }, 4000),
      idle(() => { void import('./components/shared/pdf/PdfReaderView').catch(() => {}) }, 10000),
    ]
    return () => { for (const id of ids) { w.cancelIdleCallback?.(id); window.clearTimeout(id) } }
  }, [loaded])

  // Listen for import modal open
  useEffect(() => {
    const handler = () => { setImportBackupPath(null); setImportModalOpen(true) }
    window.addEventListener('open-import-modal', handler)
    return () => window.removeEventListener('open-import-modal', handler)
  }, [])

  // Drag a backup zip anywhere onto the window → auto-open import and restore it
  useEffect(() => {
    const onDrop = (e: DragEvent) => {
      const files = e.dataTransfer?.files
      if (!files || files.length === 0) return
      const zip = Array.from(files).find(f => /\.zip$/i.test(f.name))
      if (!zip) return
      e.preventDefault()
      e.stopPropagation()
      try {
        const p = window.api.getPathForFile(zip)
        if (p) {
          setImportBackupPath(p)
          setImportModalOpen(true)
        }
      } catch { /* ignore */ }
    }
    document.addEventListener('drop', onDrop, true)
    return () => document.removeEventListener('drop', onDrop, true)
  }, [])

  // Listen for settings:open — navigate to settings tab
  useEffect(() => {
    const handler = () => { setActiveTab('settings'); setSidebarOpen(true) }
    window.addEventListener('settings:open', handler)
    return () => window.removeEventListener('settings:open', handler)
  }, [])

  // Listen for knowledge:open — navigate to knowledge tab(插件导入完成后「去知识库查看」)
  useEffect(() => {
    const handler = () => { setActiveTab('knowledge'); setSidebarOpen(true) }
    window.addEventListener('knowledge:open', handler)
    return () => window.removeEventListener('knowledge:open', handler)
  }, [])

  // 读写分工：知识库「在编辑器中打开」→ 切到编辑器 Tab 并打开同一文件
  // ISS-2026-09-04-07：跳转改走 App state + props（pendingOpenRel）。
  // 旧实现 = window 事件 + 一次性 window pending：保活层（renderMounted）在切 Tab 时
  // 会重建编辑器实例，旧实例的 listener 消费事件后随实例一起被丢弃，新实例拿不到
  // pending → 永远空态。state+props 不受实例重建影响。
  const [pendingOpenRel, setPendingOpenRel] = useState<string | null>(null)
  // UI 优化条目6：跳转来源记录——kb-open-note 带 from（如 aiTeaching），编辑器出「← 返回 X」chip；
  // 新跳转覆盖旧来源，任何手动切 Tab（handleTabChange）清除
  // 转发给 knowledge 的 kb-open-note-rel 通道（知识页/草稿/PDF/源码统一由文件视图语境消化）。
  // 十余处 dispatch 方零改动；editor 模块代码暂留（不再可达），批次 3 物理清理。
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { relPath?: string; from?: TabName } | undefined
      setActiveTab('knowledge')
      if (detail?.relPath) {
        window.dispatchEvent(new CustomEvent('kb-open-note-rel', { detail: { relPath: detail.relPath } }))
      }
    }
    window.addEventListener('kb-open-note', handler)
    return () => window.removeEventListener('kb-open-note', handler)
  }, [])

  // v3.4.0 PDF 划词 → AI 教学（pdf-reader 方案 §6）：事件只送意图，payload 走 state+props
  // （ISS-2026-09-04-07：保活层实例重建会丢 window 一次性变量）。消费后立即清空防重复跳转。
  const [pendingAsk, setPendingAsk] = useState<{ question: string; source?: { type: string; relPath: string; page: number; excerpt: string } } | null>(null)
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as { question?: string; source?: { type: string; relPath: string; page: number; excerpt: string } } | undefined
      if (!d?.question) return
      setPendingAsk({ question: d.question, source: d.source })
      setActiveTab('aiTeaching')
    }
    window.addEventListener('kb-ai-teaching-ask', handler)
    return () => window.removeEventListener('kb-ai-teaching-ask', handler)
  }, [])

  // 2026-09-17 拍板（书架内自渲染）：点书在书架标签页内部打开阅读器，不再借编辑器文档标签。
  // 阅读状态上收 App（单一真相源）：书架模块消费 + 左栏大纲态（PdfRailPanel）同步跟随。
  // 全格式阅读器一期（2026-09-20）：补 kind —— 决定书架内渲染哪个阅读引擎 + 右栏阅读侧栏。
  const [bookshelfReading, setBookshelfReading] = useState<{ relPath: string; name: string; kind: BookKind } | null>(null)
  /** 左栏阅读态展示对象：**仅书架内正在读的书**。kind 决定左栏挂 PDF 三件套还是回落书目列表。
   *  2026-09-21：原先的 second source「编辑器激活的 PDF」已随编辑器模块退役失效（全仓无人派发
   *  kb-editor-doc-changed，判定恒假），连同其监听一并清除——保留会让人误以为编辑器 PDF 仍进左栏。 */
  const railReaderDoc: { relPath: string; kind: BookKind } | null = bookshelfReading
    ? { relPath: bookshelfReading.relPath, kind: bookshelfReading.kind }
    : null

  // 摘录导出的「回到原文」（v3.5.0 第 5 项 · C4）：知识库「读书笔记」页里的 `kbloc:` 链接
  // 由 MarkdownPreview 单点拦下后派发到这里 —— 解出书 → 打开该书（切到书架标签）→ 定位到摘录所在页/段。
  // 只在这里读一次数据（摘录按 id 查 → 拿 kind 与 locator），阅读器仍从事件拿跳转意图，不新增 second source。
  useEffect(() => {
    const onOpen = (e: Event) => {
      const href = String((e as CustomEvent<{ href?: string }>).detail?.href ?? '')
      const m = /^kbloc:([^#]+)#(.+)$/.exec(href)
      if (!m) { showToast({ type: 'error', message: '无法解析摘录定位链接' }); return }
      const key = m[1]
      const excerptId = m[2]
      const slash = key.indexOf('/')
      const rootId = slash > 0 ? key.slice(0, slash) : ''
      const relPath = slash >= 0 ? key.slice(slash + 1) : ''
      if (!rootId || !relPath) { showToast({ type: 'error', message: '摘录定位链接缺少书籍信息' }); return }
      void (async () => {
        const cur = await workspaceGetCurrent().catch(() => null)
        if (!cur || cur.rootId !== rootId) {
          showToast({ type: 'info', message: '原书不在当前仓库，无法回到原文' })
          return
        }
        const r = await excerptList(rootId, relPath).catch(() => null)
        const ex = r?.ok ? (r.excerpts ?? []).find((x) => x.id === excerptId) : undefined
        if (!ex) {
          showToast({ type: 'info', message: '这条摘录已不在原书里（可能已被删除）' })
          return
        }
        setActiveToolTab(null)
        setBookshelfReading({ relPath, name: bookDisplayName(relPath), kind: ex.kind })
        setActiveTab('bookshelf')
        requestAnimationFrame(() => {
          if (ex.kind === 'pdf' && ex.page) {
            window.dispatchEvent(new CustomEvent(KB_PDF_GOTO_PAGE, { detail: { relPath, page: ex.page } }))
          } else if (ex.kind === 'txt' && typeof ex.paraIndex === 'number') {
            window.dispatchEvent(new CustomEvent(KB_TXT_GOTO_PARA, { detail: { relPath, paraIndex: ex.paraIndex } }))
          }
        })
      })()
    }
    window.addEventListener(KB_OPEN_EXCERPT_LOC, onOpen)
    return () => window.removeEventListener(KB_OPEN_EXCERPT_LOC, onOpen)
  }, [])

  // 日程侧边栏（v3.2.0 ⑮）桌面磁贴的日历 → 日志跳转。
  // 与 kb-open-note 同范式：事件只送意图，payload 走 state + props
  // （保活层会重建 BlogModule 实例，靠 window 一次性变量会丢）。消费后立即清空，
  // 免得切走再切回又跳一次。
  const [pendingBlogJump, setPendingBlogJump] = useState<BlogJump | null>(null)
  useEffect(() => {
    const onDate = (e: Event) => {
      const date = (e as CustomEvent<{ date?: string }>).detail?.date
      if (typeof date !== 'string' || !date) return
      setPendingBlogJump({ kind: 'date', date })
      setActiveTab('blog')
    }
    const onSummary = (e: Event) => {
      const d = (e as CustomEvent<{ kind?: SummaryKind; start?: string; end?: string }>).detail
      if (!d?.kind || !d.start || !d.end) return
      setPendingBlogJump({ kind: 'summary', summaryKind: d.kind, start: d.start, end: d.end })
      setActiveTab('blog')
    }
    window.addEventListener('blog-open-date', onDate)
    window.addEventListener('blog-open-summary', onSummary)
    return () => {
      window.removeEventListener('blog-open-date', onDate)
      window.removeEventListener('blog-open-summary', onSummary)
    }
  }, [])

  // Listen for help:open — navigate to help tab(入口:设置弹出菜单/Toast 深链)
  useEffect(() => {
    const handler = () => { setActiveTab('help'); setSidebarOpen(true) }
    window.addEventListener('help:open', handler)
    return () => window.removeEventListener('help:open', handler)
  }, [])

  // Listen for release-notes:open — 设置→关于与更新 / 活动栏齿轮菜单的手动入口。
  // 走事件而非 prop：与 settings:open / help:open / onboarding:show 的既有通道一致，
  // 模块页本身不需要知道是谁把它打开的。
  useEffect(() => {
    const handler = () => { setActiveTab('releaseNotes'); setSidebarOpen(true); setPalette(null) }
    window.addEventListener('release-notes:open', handler)
    return () => window.removeEventListener('release-notes:open', handler)
  }, [])

  // Listen for ai-learn:goto —— AI 学堂「动手做」跳模块（学堂自身先收起，避免浮层压住目标）
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: TabName }>).detail?.tab
      if (tab) { setActiveTab(tab); setSidebarOpen(true) }
    }
    window.addEventListener('ai-learn:goto', handler)
    return () => window.removeEventListener('ai-learn:goto', handler)
  }, [])

  // Listen for plugins:open — navigate to plugins tab (e.g. 设置→AI 工具→Skill 跳市场)
  useEffect(() => {
    const handler = () => { setActiveTab('plugins'); setSidebarOpen(true) }
    window.addEventListener('plugins:open', handler)
    return () => window.removeEventListener('plugins:open', handler)
  }, [])

  // 接收小窗指令：日程与打卡小窗「打开任务模块/完整配置」→ 切换主窗口 Tab
  useEffect(() => {
    const off = window.api?.onMainCommand?.((p) => {
      if (p?.type === 'switch-tab' && typeof p.tab === 'string') {
        // 白名单走唯一真相源：旧版把清单抄在这里，缺 editor / aiTeaching / desktop
        // —— 小窗喊「切到编辑器」会被静默拒绝，症状是「点了没反应」。
        if (isTabName(p.tab)) {
          setActiveTab(p.tab)
          setSidebarOpen(true)
          // 子工具深链（如小窗书签 → 工具箱·网址导航）：目标模块监听 toolbox:open-tool 自行激活
          if (p.tool) window.dispatchEvent(new CustomEvent('toolbox:open-tool', { detail: { tool: p.tool } }))
        }
      }
    })
    return () => { off?.() }
  }, [])

  // 日程截止提醒：系统通知被点击 → 主进程已唤起窗口，这里切到日程模块
  useEffect(() => {
    const off = window.api?.onScheduleReminderClick?.(() => {
      setActiveTab('schedule')
      setSidebarOpen(true)
    })
    return () => { off?.() }
  }, [])

  // 日程打卡侧边栏：脱离态变化推送（独立窗口打开/销毁）。
  // v3.4.0 批次4：内嵌态由右栏小工具接管，detached=false 不再需要「恢复内嵌显示」。
  useEffect(() => {
    const off = window.api?.onDayPanelStateChanged?.(({ detached }) => {
      setDayPanelDetached(detached)
    })
    return () => { off?.() }
  }, [])
  // 全局快捷键 Ctrl+Alt+S toggle：脱离中 → 吸附回右栏（关独立窗口）；否则脱离为独立窗口
  useEffect(() => {
    const off = window.api?.onDayPanelToggleVisibility?.(() => {
      if (dayPanelDetached) void window.api?.dayPanelDockBack?.()
      else void window.api?.dayPanelPopout?.()
    })
    return () => { off?.() }
  }, [dayPanelDetached])

  // 开发者工具 — 仅 DEV 动态加载:打包构建时 import.meta.env.DEV 被静态替换为 false,
  // 动态 import 随之被 tree-shaking 移除,devtools 模块代码不进入产物
  const [DevToolsModuleDynamic, setDevtoolsNode] = useState<React.ComponentType<DevToolsModuleProps> | null>(null)
  useEffect(() => {
    if (import.meta.env.DEV) {
      import('./modules/devtools').then(m => setDevtoolsNode(() => m.DevToolsModule))
      // AI 测试桥:安装渲染层日志采集(console / error / rejection → 主进程)
      import('./devbridge/collector').then(m => m.installRendererCollector()).catch(() => { /* 桥未启用 */ })
    }
  }, [])

  // AI 测试桥:上报当前激活模块,使 GET /state 能反映真实路由
  useEffect(() => {
    if (!import.meta.env.DEV) return
    import('./devbridge/collector')
      .then(m => m.reportUiState({ activeModule: activeTab ?? undefined }))
      .catch(() => { /* 桥未启用 */ })
  }, [activeTab])

  // First-run onboarding — show once after load & unlock; re-openable from settings
  // 依赖 settingsReady:等真实设置到位后再判断,避免默认值 onboardingDone:false 造成的竞态弹出
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  // 首启仓库选择（Obsidian 式）：新手引导的前置步骤——无当前仓库时先选/建仓库，完成后再进引导
  const [vaultPickOpen, setVaultPickOpen] = useState(false)
  // DEV「开始界面」预览（TitleBar 轮巡按钮发事件）：三个开始界面三选一开关，null=全关
  useEffect(() => {
    const onPreview = (e: Event) => {
      const mode = (e as CustomEvent).detail as 'first' | 'startup' | null
      setVaultPickOpen(mode === 'first')
      setStartupPickerOpen(mode === 'startup')
    }
    window.addEventListener('dev:startScreen', onPreview)
    return () => window.removeEventListener('dev:startScreen', onPreview)
  }, [])
  useEffect(() => {
    if (!settingsReady || !loaded || s.onboardingDone) return
    let cancelled = false
    workspaceGetCurrent()
      .then((cur) => {
        if (cancelled) return
        if (cur?.rootId) setOnboardingOpen(true)
        else setVaultPickOpen(true)
      })
      .catch(() => { if (!cancelled) setVaultPickOpen(true) })
    return () => { cancelled = true }
  }, [settingsReady, loaded, s.onboardingDone])
  useEffect(() => {
    // 重看引导（设置 → 关于）走与首启一致的流程：无当前仓库时先出仓库选择
    const handler = () => {
      workspaceGetCurrent()
        .then((cur) => { if (cur?.rootId) setOnboardingOpen(true); else setVaultPickOpen(true) })
        .catch(() => setOnboardingOpen(true))
    }
    window.addEventListener('onboarding:show', handler)
    return () => window.removeEventListener('onboarding:show', handler)
  }, [])

  // Keep <html> font-size in sync when zoom changes externally
  useEffect(() => {
    document.documentElement.style.fontSize = `${s.zoom * 16}px`
  }, [s.zoom])

  // Sync active tab for module-level shortcut guards (hidden modules stay mounted)
  useEffect(() => { setGlobalActiveTab(activeTab ?? '') }, [activeTab])

  // Blue-outline drag workaround
  useEffect(() => {
    const onDragOver = (e: DragEvent) => { e.preventDefault() }
    const onDragStart = () => { document.body.classList.add('dragging') }
    const onDragEnd = () => { document.body.classList.remove('dragging') }
    document.addEventListener('dragover', onDragOver, true)
    document.addEventListener('dragstart', onDragStart)
    document.addEventListener('dragend', onDragEnd)
    document.addEventListener('drop', onDragEnd)
    return () => {
      document.body.classList.remove('dragging')
      document.removeEventListener('dragover', onDragOver, true)
      document.removeEventListener('dragstart', onDragStart)
      document.removeEventListener('dragend', onDragEnd)
      document.removeEventListener('drop', onDragEnd)
    }
  }, [])

  // 标签条同步（v3.4.0）：任何通道的 setActiveTab（handleTabChange / 全局事件 / 命令面板 / 启动落点）
  // 都会走到这里 —— openTabs 统一在此追加，杜绝「某条打开路径漏登记」。
  // 2026-09-17 拍板：openTabs 恢复为标签条数据源（文档标签式）；aiTeaching 整窗「返回工作台」
  // 也按 openTabs 找回上一个标签。!activeTab 守卫 = 启动占位期（null）不登记假标签；
  // EXCLUDED = 图标条功能面板（回收站/插件/工具箱/动态/设置）与 aiTeaching/devtools，
  // 点击只切换视图不登记标签（第四轮反馈拍板②），图标条常驻可随时返回。
  // 批次4：工具标签（activeToolTab）同批登记——模块与工具标签共用一条 openTabs 序列。
  useEffect(() => {
    if (!activeTab || WORKBENCH_TABBAR_EXCLUDED.includes(activeTab)) return
    setOpenTabs((ts) => (ts.includes(activeTab) ? ts : [...ts, activeTab]))
  }, [activeTab])
  useEffect(() => {
    if (!activeToolTab) return
    setOpenTabs((ts) => (ts.includes(activeToolTab) ? ts : [...ts, activeToolTab]))
  }, [activeToolTab])

  // quizViewOpen / 页签组可见性（2026-09-19）：声明在 closeTab 之前——其全关判定 deps 渲染期就要读
  const [quizViewOpen, setQuizViewOpen] = useState(false)
  // 页面条「错题本」条目 ✕ 的关闭来源标记：CustomEvent 派发是同步的，置位 → CLOSE_REQUEST →
  // knowledge 同步回流 TOGGLED → 此处消费后于 onClose 复位。区分「标签条关闭」（对齐关=回总览）
  // 与「模块内开关关闭」（回知识库树态）。
  const quizTabCloseRef = useRef(false)
  const [kbStripVisible, setKbStripVisible] = useState(false)
  // 关闭标签（✕ / 中键）。2026-09-19 反馈拍板（需求而非 bug）：**关掉激活标签 = 一律回总览空态**，
  // 不再自动落邻居标签——哪怕还有其他标签页，它们原样留在页面条（未激活），点击再激活；
  // 左栏同步退回顶层。「标签 ↔ 左栏」关系收敛为两条可预期规则：点标签 = 左栏跟随；关标签 = 回总览。
  // （旧「右邻居优先落点」语义保留在编辑器/知识库内部的文档页签 landingAfterClose，模块级标签不用。）
  const closeTab = useCallback((tab: string) => {
    // 阅读态清空的唯一事实源（全格式阅读器一期）：书架标签删除 → 右栏阅读入口随之消失
    // （右栏 reading prop 以 openTabs.includes('bookshelf') 为前提，但清 state 是无条件的彻底收口）
    if (tab === 'bookshelf') setBookshelfReading(null)
    const i = openTabs.indexOf(tab)
    if (i === -1) return
    let next = openTabs.filter((t) => t !== tab)
    const isTool = isToolTabId(tab)
    const isActive = isTool ? activeToolTab === tab : activeTab === tab
    if (isActive) {
      setActiveToolTab(null)
      setActiveTab(null)
      setRailModule(null)
    }
    // 全关兜底（2026-09-19 反馈：关掉博客后左栏转到笔记）：剩余标签全部「不可见」=
    // PAGE_OWNED 空壳（模块条目不进页面条、无停靠页面时页签组也不出现）→ 用户视角已无
    // 标签页，按全关收尾：清掉隐形空壳、activeTab/左栏回总览。可见性由模块上报。
    const tabVisible = (t: string) =>
      isToolTabId(t) || !PAGE_OWNED.includes(t) ||
      (t === 'knowledge' && (kbStripVisible || quizViewOpen))
    if (!next.some(tabVisible)) {
      next = next.filter((t) => !PAGE_OWNED.includes(t))
      setActiveToolTab(null)
      setActiveTab(null)
      setRailModule(null)
    }
    setOpenTabs(next)
  }, [openTabs, activeTab, activeToolTab, kbStripVisible, quizViewOpen])
  // 标签拖拽重排（现成机制恢复）：只调 openTabs 顺序，激活标签跟内容走、不变
  const handleReorder = useCallback((tabs: string[]) => setOpenTabs(tabs), [])

  const handleTabChange = (tab: TabName) => {
    setActiveToolTab(null)  // 切回模块标签时退出工具标签（工具标签关闭走 ✕ / 落点分流）
    if (tab === activeTab) {
      // 工具箱专属（2026-09-10）：已在工具箱时再点活动栏图标 = 退出当前工具、回到工具箱主界面。
      // 通用行为对图标条无意义 —— v3.4.0 起图标条幂等哲学：重复点击已激活模块 = 无操作
      //（旧「再点当前 = 切模块侧栏」语义随双态设计废弃，模块侧栏将由左栏双态接管，见方案 §3.6）
      if (tab === 'toolbox') { setToolboxHomeSignal(n => n + 1); return }
      return
    }
    setActiveTab(tab); setSidebarOpen(true); window.dispatchEvent(new CustomEvent('tab-switched'))
  }

  // ---- 工具标签页（v3.4.0 批次4，方案 §10.2）----
  // 右栏工具入口点击 → 中间开对应工具标签页；重复点击同入口 = 激活已有标签（openTabs includes
  // 判定 + openTabs 登记处去重），关闭走文档标签通用 ✕。番茄钟特例 = 既有 pomodoro:activate
  // 全屏面板语义，不开标签。
  // 插件工具标签：App 层持插件工具清单（pluginTools），tool:<pluginId:toolId> 按清单匹配宿主。
  const handleOpenTool = useCallback((toolId: string) => {
    if (toolId === 'pomodoro') {
      window.dispatchEvent(new CustomEvent('pomodoro:activate', { detail: { preset: 0 } }))
      return
    }
    setActiveTab(null)
    setActiveToolTab(toolTabId(toolId))
  }, [])

  const handleOpenPluginTool = useCallback((tool: PluginTool) => {
    setActiveTab(null)
    setActiveToolTab(toolTabId(`${tool.pluginId}:${tool.toolId}`))
  }, [])

  /** 工具标签页宿主：内置工具走共享 ToolHost；插件工具按清单匹配 PluginToolHost；
      onBack（组件头部「← 返回」）= 关闭该标签（标签页语境的「返回」语义）。
      侧栏适配（2026-09-17 右栏优化轮）：激活的有侧栏工具（TOOLS_WITH_SIDEBAR）且左栏未被锁定时，
      侧栏 portal 进左栏模块态 slot；锁定瞬间/槽未就绪 sidebarHosted=true & el=null → 侧栏渲染 null；
      非激活工具（display:none 保活中）不参与 → 回落内嵌侧栏。 */
  const renderToolTabHost = (tabId: string) => {
    const tid = toolIdOfTab(tabId)
    const pluginTool = pluginTools.find((t) => `${t.pluginId}:${t.toolId}` === tid)
    if (pluginTool) return <PluginToolHost tool={pluginTool} onBack={() => closeTab(tabId)} />
    const toolHosted = tabId === activeToolTab && !wbLayout.leftLocked && TOOLS_WITH_SIDEBAR.has(tid)
    const toolSidebarEl = toolHosted ? wbModSlotEl : null
    return <ToolHost toolId={tid} onBack={() => closeTab(tabId)} sidebarEl={toolSidebarEl} sidebarHosted={toolHosted} />
  }

  // ---- 左栏书签（v3.4.0 批次3）----
  // 跟随（原型 v15「自动跟随」）：激活标签变为映射内模块且未锁定时，左栏进入该模块侧边栏态；
  // 不在映射内的标签（设置/工具箱/动态…）不动左栏，锁定（leftLocked）时不跟随。
  // 仅跳过首挂那次；且 mount 后 2s 内不武装——settings 异步恢复 activeTab（占位 'blog' →
  // 恢复值）的那次变化同样不拉左栏（原型 v15 启动=总览态；S3 探针实证启动被拉进模块态）；
  // 武装后的重跑会「追上」当前映射内标签（锁定期间切过的上下文，解锁即恢复跟随）
  const followMountedRef = useRef(false)
  const followArmedRef = useRef(false)
  useEffect(() => {
    const t = window.setTimeout(() => { followArmedRef.current = true }, 2000)
    return () => window.clearTimeout(t)
  }, [])
  useEffect(() => {
    if (!followMountedRef.current) { followMountedRef.current = true; return }
    if (!followArmedRef.current) return
    if (wbLayout.leftLocked) return
    const m = activeTab ? RAIL_FOLLOW_MAP[activeTab] : undefined
    if (m) setRailModule(m)
  }, [activeTab, wbLayout.leftLocked])

  // 工具标签 → 左栏工具侧栏态跟随（2026-09-17 右栏优化轮，语义对齐 RAIL_FOLLOW_MAP：
  // 「不在映射内的标签不动左栏」——无侧栏工具/切回文档标签只清工具态，不碰 railModule）。
  // 锁定时不跟随（侧栏归属权留给用户）；归属判定见 renderToolTabHost（锁定时工具侧栏回落内嵌）。
  useEffect(() => {
    if (!followArmedRef.current) return
    if (wbLayout.leftLocked) { setRailTool(null); return }
    const tid = activeToolTab && isToolTabId(activeToolTab) ? toolIdOfTab(activeToolTab) : null
    setRailTool(tid && TOOLS_WITH_SIDEBAR.has(tid) ? tid : null)
  }, [activeToolTab, wbLayout.leftLocked])

  // 错题本视图开合反向联动（批次5 反馈轮，QUIZ_VIEW_TOGGLED_EVENT）：非书签路径（树内入口）
  // 进出错题本时 knowledge 派发 {open}——左栏非锁定则切 quiz 态（关 = 回 knowledge 树态），
  // 避免「主体错题本 + 左栏知识库树」的双侧栏错位。quizViewOpen 同时作为标签跟随的特判依据：
  // knowledge 标签当前显示的可能是错题本子视图，此时点标签条「知识库」应保持 quiz 态而非切回知识库树
  // （quizViewOpen 等三个状态声明在 closeTab 之前——closeTab 的全关判定 deps 渲染期就要读它们）
  useEffect(() => {
    const handler = (e: Event) => {
      const open = (e as CustomEvent<{ open?: boolean }>).detail?.open ?? true
      setQuizViewOpen(open)
      if (wbLayout.leftLocked) return
      // 页面条「错题本」条目 ✕（quizTabCloseRef 置位）：对齐模块标签「关=回总览」——
      // 当时正看着错题本（activeTab=knowledge）才清视图落总览；知识库标签无停靠页签则随壳清理。
      // 模块内入口（侧栏错题本/收藏开关）关闭 → 维持回知识库树态。
      if (!open && quizTabCloseRef.current) {
        if (activeTab === 'knowledge') {
          setActiveToolTab(null)
          setActiveTab(null)
          setRailModule(null)
        }
        if (!kbStripVisible) setOpenTabs((ts) => ts.filter((t) => t !== 'knowledge'))
        return
      }
      setRailModule(open ? 'quiz' : 'knowledge')
    }
    window.addEventListener(QUIZ_VIEW_TOGGLED_EVENT, handler)
    return () => window.removeEventListener(QUIZ_VIEW_TOGGLED_EVENT, handler)
  }, [wbLayout.leftLocked, activeTab, kbStripVisible])

  
  // 阅读器工具栏「大纲」→ 解锁左栏 + 展开左栏 + 切 bookshelf 模块态（兜底入口，方案 §2）
  useEffect(() => {
    const handler = () => {
      if (wbLayout.leftLocked || wbLayout.leftCollapsed) {
        update('workbenchLayout', JSON.stringify({ ...wbLayout, leftLocked: false, leftCollapsed: false }))
      }
      setRailModule('bookshelf')
    }
    window.addEventListener('kb-rail-show-bookshelf-outline', handler)
    return () => window.removeEventListener('kb-rail-show-bookshelf-outline', handler)
  }, [wbLayout, update])

  // 阅读器请求阅读空间（2026-09-18 书架反馈）→ **左右两栏一起收**给书页让位。
  // 来源：PdfReaderView 判定「整页适配下宽度是瓶颈」时派发（见那里的 spaceAskedRef 注释）；
  // 每次进入阅读只派发一次，用户之后手动展开不会被再收走（不在窗口尺寸变化时重复触发）。
  useEffect(() => {
    const handler = () => {
      if (wbLayout.leftCollapsed && wbLayout.rightCollapsed) return
      update('workbenchLayout', JSON.stringify({ ...wbLayout, leftCollapsed: true, rightCollapsed: true }))
    }
    window.addEventListener('kb-reader-request-space', handler)
    return () => window.removeEventListener('kb-reader-request-space', handler)
  }, [wbLayout, update])

  /** 书签点击（第四轮拍板①：幂等激活——再点当前书签不再退出模块态，退出只走「‹ 返回总览」。
      旧「再点退出」会把左栏退回总览而 activeTab 仍停在该模块，出现「总览态 + 书签高亮」的怪状态）；
      错题本 = openTab('knowledge') + kb-locate-quiz-view 定位事件；其余直开对应标签 */
  const handleBookmarkClick = (key: RailModule) => {
    setRailModule(key)
    const b = WORKBENCH_BOOKMARKS.find((x) => x.key === key)
    if (!b) return
    if (key === 'quiz') {
      handleTabChange('knowledge')
      // 冷启动时知识库模块可能尚未挂载（保活注册表为空），延迟派发等监听器就绪（同 kb-open-knowledge-page 约定）
      window.setTimeout(() => window.dispatchEvent(new CustomEvent(LOCATE_QUIZ_VIEW_EVENT)), 100)
    } else {
      handleTabChange(b.tab)
    }
  }

  /** 🔖 书签选显菜单（v10 拍板落地）：切换某书签显隐并持久化；隐藏当前激活的书签时自动退出模块态 */
  const handleBookmarkVisibility = (key: string) => {
    const hidden = wbLayout.bookmarksHidden.includes(key)
    const next = hidden
      ? wbLayout.bookmarksHidden.filter((k) => k !== key)
      : [...wbLayout.bookmarksHidden, key]
    update('workbenchLayout', JSON.stringify({ ...wbLayout, bookmarksHidden: next }))
    if (!hidden && railModule === key) setRailModule(null)
  }

  /** 左栏模块态「← 返回总览」：清模块态（含工具侧栏态），锁定态顺带自动解锁（原型 lpBack 语义） */
  const handleBackToOverview = () => {
    setRailModule(null)
    setRailTool(null)
    if (wbLayout.leftLocked) update('workbenchLayout', JSON.stringify({ ...wbLayout, leftLocked: false }))
  }

  /** 左栏散文件点击 → 知识库文件视图语境打开（Phase 2 批次 2：kb-open-note 统一改道） */
  const handleOpenLooseFile = (relPath: string) => {
    window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath, from: 'knowledge' } }))
  }

  // 日程打卡侧边栏：标题栏按钮 + Ctrl+Alt+S 统一入口（v3.4.0 批次4 起语义 = 脱离 toggle）：
  // - 脱离中 → 吸附回右栏（关独立窗口，控件互斥解除）
  // - 未脱离 → 脱离为独立桌面窗口（内嵌态已由右栏小工具承担）
  const toggleDayPanel = useCallback(() => {
    if (dayPanelDetached) {
      void window.api?.dayPanelDockBack?.()
    } else {
      void window.api?.dayPanelPopout?.()
    }
  }, [dayPanelDetached])

  // Ctrl+= / Ctrl+- zoom — synced with settings
  // 作用域仲裁（2026-09-20 反馈「界面缩放和页面缩放冲突」）：正在书架里读 PDF 时，
  // 这组快捷键归阅读器页面缩放（PdfReaderView 自行处理），全局界面缩放让位
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return
      if (bookshelfReading && activeTab === 'bookshelf' && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '_')) return
      if (e.code === 'Equal' || e.code === 'NumpadAdd') {
        e.preventDefault()
        const n = Math.min(s.zoomMax, +(s.zoom + s.zoomStep).toFixed(2))
        update('zoom', n)
      }
      if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
        e.preventDefault()
        const n = Math.max(s.zoomMin, +(s.zoom - s.zoomStep).toFixed(2))
        update('zoom', n)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s.zoom, s.zoomMin, s.zoomMax, s.zoomStep, update, bookshelfReading, activeTab])

  // Ctrl+B — toggle sidebar（Alt 修饰的组合键不拦：Ctrl+Alt+B 归工作台右栏，见下方处理器）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditingInput(e)) return
      if (e.ctrlKey && !e.altKey && e.key === 'b') {
        e.preventDefault()
        setSidebarOpen(v => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 工具标签页保活集合（批次4）：**必须声明在下方 `if (!loaded) return null` 早退之前**——
  // hook 若落在早退之后，首挂（loaded=false）与恢复后的两次渲染 hook 数不同 = React #310 整屏崩
  // （2026-09-17 实机启动白屏根因，与 PDF 批次 806a12d 同一类病；教训：早退组件的 hook 一律前置）。
  const mountedToolTabs = useRef<Set<string>>(new Set())

  /**
   * 渲染行的模块序列 —— **单一父节点、顺序恒定**（保活的关键，勿改成「可见模块单列」）。
   *
   * 顺序 = `mountedTabs` 访问序（稳定，不随 activeTab 变化），于是模块在 children 里的下标
   * 恒定 → 切换不触发卸载重建。
   *
   * ⚠️ 绝不能把「当前可见模块」单列到数组之外 —— 那会让可见↔隐藏换子节点槽位，
   * React 按位置卸载重建（ISS-2026-09-04-07 的真实成因）。
   */
  const rowModules = useMemo<TabName[]>(() => {
    const visited = Array.from(mountedTabs.current)
    // activeTab 兜底首访（renderMounted 的 on=true 会 add，但首帧要先进数组）
    if (activeTab && !visited.includes(activeTab)) visited.push(activeTab)
    return visited
    // mountedTabs 是 ref（不进依赖）；activeTab 变化时重算即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  /** 整窗模块（2026-09-17 第五轮拍板修正）：回收站/插件市场/工具箱/动态/设置与 aiTeaching/devtools
      一样**与工作台平级**——激活时整窗独占（左右栏与标签条隐藏，见 suppressSides），
      不再呈现为「工作台内的子模块」；EXCLUDED 同时承担「不登记为标签页」的过滤。 */
  const fullWindowTab = activeTab !== null && WORKBENCH_TABBAR_EXCLUDED.includes(activeTab)

  // AI 助手快捷键闸门（2026-09-22 拍板）：AI 教学区自己就是 AI 对话区，在那里 Ctrl+J / Ctrl+Shift+J
  // 一律不响应（详见 AI_ASSISTANT_SHORTCUT_DISABLED 的注释）。
  // ★ 刻意**不**并进上面的 suspendShortcut —— 那个的语义是「宿主接管了 Ctrl+J」，工作台内恒为 true；
  //   把 Ctrl+Shift+J 也挂上去会连带废掉工作台里现有的「全屏学堂」，超出本条目范围。
  const aiShortcutDisabled = activeTab !== null && AI_ASSISTANT_SHORTCUT_DISABLED.includes(activeTab)

  // Ctrl+Alt+B — 切换工作台右栏（2026-09-19 反馈：工作台区对齐 AI 教学的右栏快捷键；
  // 整窗模块下左右栏本就退场（suppressSides），跳过避免改了布局却看不见）。
  // ⚠️ 必须在 `if (!loaded) return null` 早退**之前**声明（React #310：早退组件的 hook 一律前置）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditingInput(e)) return
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'b') {
        if (fullWindowTab) return
        e.preventDefault()
        update('workbenchLayout', JSON.stringify({ ...wbLayout, rightCollapsed: !wbLayout.rightCollapsed }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullWindowTab, wbLayout, update])

  // Ctrl+J — 上下文路由（2026-09-21 用户拍板）：工作台内唤出**右栏 AI 侧栏**（再按收起）；
  // 整窗模块不拦，由悬浮 AssistantPanel 自己的监听处理（唤出悬浮 AI 助手）。
  // 工作台分支先派 ai-assistant:close 收掉可能开着的浮层 —— 右栏与浮层同为 ChatBody，
  // 叠着会出现两块对话（且浮层盖在右栏正上方，视觉上像同一个东西）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j')) return
      if (fullWindowTab) return // 整窗模块：悬浮助手自己的监听处理
      e.preventDefault()
      window.dispatchEvent(new Event('ai-assistant:close'))
      // 开 = 右栏可见且停在 AI Tab → 再按 = 收起；否则唤出（展开右栏并切到 AI Tab）
      const open = !wbLayout.rightCollapsed && wbLayout.rightTab === 'ai'
      update('workbenchLayout', JSON.stringify({ ...wbLayout, rightTab: 'ai', rightCollapsed: open }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullWindowTab, wbLayout, update])

  if (!loaded) return null

  /** 页面条整行隐藏（v3.4.0 页面条置顶）：知识库沉浸阅读 / 图谱模式本来就是全幅形态，行让位 */
  const pageBarHidden = activeTab === 'knowledge' && knowledgeImmersive

  /** 模块内容（on = 该模块当前在屏幕激活）
      —— 页面条置顶后页签条 portal 进外壳页面条。 */
  function renderModuleContent(name: TabName, on: boolean): React.ReactNode {
    switch (name) {
      case 'blog': return <BlogModule showLineNumbers={s.showLineNumbers} sidebarOpen={sidebarOpen} zoom={s.zoom} sidebarWidths={sidebarWidths} onSnapCloseSidebar={() => setSidebarOpen(false)} onSnapOpenSidebar={() => setSidebarOpen(true)} blogJump={pendingBlogJump} onBlogJumpConsumed={() => setPendingBlogJump(null)} sidebarEl={on && railModule === 'blog' ? wbModSlotEl : null} sidebarHosted={on} modActionsEl={on && railModule === 'blog' ? wbModActionsEl : null} />
      case 'schedule': return <ScheduleModule isActive={on} sidebarOpen={sidebarOpen} sidebarWidths={sidebarWidths} onSnapCloseSidebar={() => setSidebarOpen(false)} onSnapOpenSidebar={() => setSidebarOpen(true)} sidebarEl={on && railModule === 'schedule' ? wbModSlotEl : null} sidebarHosted={on} />
      case 'knowledge': return <KnowledgeModule sidebarOpen={sidebarOpen} zoom={s.zoom} sidebarWidths={sidebarWidths} onSnapCloseSidebar={() => setSidebarOpen(false)} onSnapOpenSidebar={() => setSidebarOpen(true)} isActive={on} sidebarEl={on && (railModule === 'knowledge' || railModule === 'quiz') ? wbModSlotEl : null} sidebarVariant={railModule === 'quiz' ? 'quiz' : 'knowledge'} sidebarHosted={on} pageBarEl={wbKnowledgePageEl} pageBarHosted onImmersiveChange={handleKnowledgeImmersive} modActionsEl={on && (railModule === 'knowledge' || railModule === 'quiz') ? wbModActionsEl : null} onRequestCloseTab={() => closeTab('knowledge')} onStripVisibleChange={setKbStripVisible} onPageTabActivate={() => { handleTabChange('knowledge'); if (!wbLayout.leftLocked) setRailModule('knowledge') }} />
      case 'moments': return <MomentsModule />
      case 'bookshelf': return (
        <BookshelfModule
          isActive={on}
          reading={bookshelfReading}
          onOpenBook={(relPath, name, kind) => {
            setBookshelfReading({ relPath, name, kind })
            // 阅读发生时左栏切书架大纲态（锁定除外；若本就处于书架态则无感）
            if (!wbLayout.leftLocked) setRailModule('bookshelf')
          }}
          onCloseBook={() => setBookshelfReading(null)}
        />
      )
      case 'aiTeaching': return <AiTeachingModule isActive={on} zenLevel={zenLevel} onZenLevelChange={changeZen} pendingAsk={pendingAsk} onConsumePendingAsk={() => setPendingAsk(null)} />
      // aiChat = AI 对话中间标签（v3.4.0 批次5，方案 §4）：右栏 AI 态点 ⤢ 进入，关标签自动回右栏小对话。
      // 激活时左栏经 RAIL_FOLLOW_MAP 切 aiChat 模块态——侧栏（会话列表/会话大纲）portal 进 slot
      case 'aiChat': return <AiChatTab active={on} sidebarEl={on && railModule === 'aiChat' ? wbModSlotEl : null} />
      case 'recycle': return <RecycleBinModule isActive={on} />
      case 'settings': return <SettingsModule />
      case 'toolbox': return <ToolboxModule homeSignal={toolboxHomeSignal} />
      case 'plugins': return <PluginsModule />
      case 'help': return <HelpModule />
      case 'devtools': return DevToolsModuleDynamic ? <DevToolsModuleDynamic sidebarOpen={sidebarOpen} sidebarWidths={sidebarWidths} onSnapCloseSidebar={() => setSidebarOpen(false)} onSnapOpenSidebar={() => setSidebarOpen(true)} /> : null
      case 'releaseNotes': return <ReleaseNotesModule onDismiss={dismissReleaseNotes} />
      default: return null
    }
  }
  /** 槽位级保活挂载：首次出现在任意栏后常驻（display:none 保活） */
  function renderMounted(name: TabName, on: boolean) {
    if (on) mountedTabs.current.add(name)
    if (!on && !mountedTabs.current.has(name)) return null
    // Suspense 不产生 DOM 节点，容器布局与改前一致；fallback 只在该模块 chunk 首次拉取期间出现。
    // 切 Tab 动效（docs/ui-animation-plan.md A 类）：display:none → 显示时浏览器会重新起播 CSS 动画，
    // 所以同一个 kb-view-fade 类在每次切换时自动重放，无需卸载重建（保活语义不变）。
    // 这里用**纯淡入**而非 kb-view-in：模块容器内含 Monaco / PDF canvas / 插件 iframe，
    // 位移动画会把整棵子树提升为合成层重新栅格化（见计划文档 §五 风险表）。
    return (
      <div key={name} className="kb-view-fade flex-1 min-h-0" style={on ? undefined : { display: 'none' }}>
        <Suspense fallback={<ModuleLoadingFallback />}>{renderModuleContent(name, on)}</Suspense>
      </div>
    )
  }

  /** 工具标签页槽位级保活挂载（批次4）：同一工具标签只渲染一份，切走 display:none 常驻
      （工具内状态如密码本解锁态不因切换丢失）。集合声明见上方 hooks 区（早退之前）。
      宿主组件见 renderToolTabHost。 */
  function renderToolMounted(tabId: string, on: boolean) {
    if (on) mountedToolTabs.current.add(tabId)
    if (!on && !mountedToolTabs.current.has(tabId)) return null
    return (
      <div key={tabId} className="kb-view-fade flex-1 min-h-0" style={on ? undefined : { display: 'none' }}>
        {renderToolTabHost(tabId)}
      </div>
    )
  }

  return (
    <RootErrorBoundary>
    <div className={`flex flex-col h-screen bg-[color-mix(in_srgb,var(--bg-primary)_92%,transparent)] overflow-hidden ${winRounded ? 'rounded-[var(--window-radius)]' : 'rounded-none'}`}>
      <CodePluginHosts />
      {zenLevel < 2 ? (
        <TitleBar
          dayPanelActive={dayPanelDetached}
          onToggleDayPanel={toggleDayPanel}
        />
      ) : (
        <ZenHotZone zenLevel={zenLevel} onZenLevelChange={changeZen} />
      )}
      <PomodoroProvider>
        <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-1 overflow-hidden">
          {/* 活动栏两个收起来源：禅模式 Z2（隐壳）与 activityBarVisible=false（用户经命令面板显式隐藏），取并集 */}
          {zenLevel < 2 && activityBarVisible && (
            <ActivityBar
              active={activeTab}
              onChange={handleTabChange}
              onWorkbench={() => handleTabChange(([...openTabs].reverse().find((t) => !isToolTabId(t)) ?? 'knowledge') as TabName)}
              flush={winMax}
            />
          )}
<main className="flex-1 flex overflow-hidden bg-transparent relative">
            {/* 工作台三栏外壳（v3.4.0 批次3）：左栏=书签双态（总览/模块侧栏/树模式+锁定+仓库切换） | 中间栏(卡片壳) | 右栏(占位，批次4 填控件)。
                DayPanel 保持 main 层平级（批次4 迁入右栏）；aiTeaching 整窗形态隐藏左右栏（suppressSides，方案 §2） */}
            {/* 左栏书架态（拍板 B：三件套只在左栏一份；portal 独立于书架标签页挂载；随 railModule 卸载）。
                2026-09-19 反馈：未在读任何书（railReaderDoc 为空）→ 左栏放书目条目视图
                （封面 + 书名 + 进度条，点击即开读），不再空置。
                2026-09-21 修复：三件套**按 kind 分发** —— PdfRailPanel 依赖 pdfjs、且只认 PDF
                （对 .txt 解析必失败并静默降级成空壳三件套）；TXT 在读时回落书目列表 + 当前书高亮。 */}
            {railModule === 'bookshelf' && wbModSlotEl ? createPortal(
              <Suspense fallback={<div className="flex h-full items-center justify-center text-[11.5px] text-[var(--text-muted)]">加载中…</div>}>
                {railReaderDoc?.kind === 'pdf' ? (
                  <PdfRailPanel readerDoc={railReaderDoc} />
                ) : (
                  <BookshelfSideList
                    activeRelPath={railReaderDoc?.relPath ?? null}
                    onOpenBook={(relPath, name, kind) => setBookshelfReading({ relPath, name, kind })}
                  />
                )}
              </Suspense>,
              wbModSlotEl,
              'wb-bookshelf-rail',
            ) : null}
            <WorkbenchShell
              activeTab={activeTab}
              railModule={railModule}
              railTool={railTool}
              modSlotRef={wbModSlotRef}
              modActionsRef={wbModActionsRef}
              onBookmarkClick={handleBookmarkClick}
              onBookmarkVisibility={handleBookmarkVisibility}
              onBackToOverview={handleBackToOverview}
              onOpenLooseFile={handleOpenLooseFile}
              onPluginBookmark={handleTabChange}
              suppressSides={fullWindowTab}
              maximized={zenLevel >= 2 || winMax}
              leftSearch={{
                mode: leftSearchMode,
                onEnter: () => setLeftSearchMode(true),
                onExit: () => setLeftSearchMode(false),
                onOpenPage: openKnowledgePageFromSearch,
                onLocateCategory: locateKnowledgeCategoryFromSearch,
                onRunCommand: (id) => openTab(id as TabName),
              }}
              right={
                <WorkbenchRightPanel
                  dayPanelDetached={dayPanelDetached}
                  onDockDayPanel={() => { void window.api?.dayPanelDockBack?.() }}
                  onOpenTool={handleOpenTool}
                  onOpenPluginTool={handleOpenPluginTool}
                  onOpenFile={(relPath) => handleOpenLooseFile(relPath)}
                  onOpenPage={(pageId) => openKnowledgePageFromSearch(pageId)}
                  onOpenSchedule={() => handleTabChange('schedule')}
                  // token 面板只在 aiChat 标签「激活中」陪伴显示（批次5 反馈拍板）：
                  // 切走模块 → 右栏主动回对话态但 aiChat 标签保留；点回标签 → 右栏再变 token 面板
                  aiChatOpen={activeTab === 'aiChat'}
                  onExpandAiChat={() => handleTabChange('aiChat')}
                  onOpenChangeFile={(relPath) => handleOpenLooseFile(relPath)}
                  // 右栏「阅读」侧栏（全格式阅读器一期）：有书在读且书架标签在位时出现第三个条件 Tab
                  reading={openTabs.includes('bookshelf') && bookshelfReading ? bookshelfReading : null}
                  onLocatePdfPage={(page) => {
                    if (activeTab !== 'bookshelf') handleTabChange('bookshelf')
                    requestAnimationFrame(() => {
                      if (bookshelfReading?.kind === 'pdf') {
                        window.dispatchEvent(new CustomEvent(KB_PDF_GOTO_PAGE, { detail: { relPath: bookshelfReading.relPath, page } }))
                      }
                    })
                  }}
                  onLocateExcerpt={(loc) => {
                    if (activeTab !== 'bookshelf') handleTabChange('bookshelf')
                    requestAnimationFrame(() => {
                      if (!bookshelfReading) return
                      if (loc.kind === 'pdf' && loc.page) {
                        window.dispatchEvent(new CustomEvent(KB_PDF_GOTO_PAGE, { detail: { relPath: bookshelfReading.relPath, page: loc.page } }))
                      } else if (loc.kind === 'txt' && typeof loc.paraIndex === 'number') {
                        window.dispatchEvent(new CustomEvent(KB_TXT_GOTO_PARA, { detail: { relPath: bookshelfReading.relPath, paraIndex: loc.paraIndex } }))
                      }
                    })
                  }}
                />
              }
              center={
            <>
            {/* 主内容区卡片壳：与左右两侧(ActivityBar / 日程打卡面板)同款圆角+阴影+留白，三卡对称。
                半透明底色 + 顶缘高光 = 液态玻璃卡片；禅模式 Z2+ 或 最大化（UI 优化条目1）全屏化（去边距/圆角/边框，贴满屏幕）。
                ⚠️ `min-h-0` 不可删（2026-09-17 根因修复）：它是 flex 列里的 flex item，
                默认 `min-height:auto` 会让「内容的最小高度」把它撑破——模块里只要有一份超过一屏的
                内容（长文档 / PDF / 长列表），这一层就从 774px 撑到内容实际高度（实测 1712px），
                而外壳 `overflow-hidden` 把溢出直接裁掉：**内容看得见上半屏、滚轮却完全不动**
                （实测 scrollHeight 1718 vs clientHeight 786）。补 `min-h-0` 后本层回到 774px，
                溢出下移给内层卡片的 `overflow-hidden`，由模块自己的滚动容器接管 → 滚动恢复。
                与 `docs/release-notes-design.md` §4「模块根节点必须 h-full」是同一类病（高度约束断了）。 */}
            <div className={`min-h-0 transition-all duration-300 ease-out ${zenLevel >= 2 || winMax ? 'flex min-w-0 flex-1' : 'm-1.5 flex min-w-0 flex-1'}`}>
              <div className={`relative flex min-h-0 flex-1 flex-col overflow-hidden transition-all duration-300 ease-out ${zenLevel >= 2 || winMax ? 'bg-[color-mix(in_srgb,var(--bg-primary)_92%,transparent)]' : 'rounded-xl border border-[var(--border-color)] bg-[color-mix(in_srgb,var(--bg-primary)_88%,transparent)] shadow-[inset_0_1px_0_var(--glass-edge),0_6px_24px_rgba(0,0,0,0.16)]'}`}>
              {/* 顶部标签条（v3.4.0 方案 §3.2；2026-09-17 第三轮反馈拍板定稿）：文档标签式动态
                  标签（openTabs，可关闭/拖拽重排/全关空态），模块按钮不上标签栏——模块由书签 /
                  图标条入口打开。整窗模块（EXCLUDED 平级模块）激活时整条隐藏（同 aiTeaching，方案 §2） */}
              {/* 顶部页面条（v3.4.0「页面条置顶」2026-09-18）：中间栏第一行 = 一条页面条，
                  模块条目与两个模块的页面条目同排（编辑器文件青笔 / 知识库页面蓝书，靠图标区分来源）。
                  原「子模块标签条」取消——编辑器 / 知识库由各自页面条目代表，模块切换走左栏书签 / 图标条。
                  整窗模块（EXCLUDED 平级模块）激活时整条隐藏（同 aiTeaching，方案 §2）；
                  知识库沉浸阅读 / 图谱模式由模块反向通知让位（pageBarHidden）。 */}
              {!fullWindowTab && !pageBarHidden && (
                <WorkbenchPageBar
                  tabs={openTabs}
                  active={activeToolTab ?? activeTab}
                  onSelect={(id) => {
                    if (isToolTabId(id)) {
                      setActiveTab(null)
                      setActiveToolTab(id)
                      // 重复点击已激活的工具标签也跟随左栏（跟随 effect 只认 state 变化，同值不触发）
                      if (!wbLayout.leftLocked) {
                        const tid = toolIdOfTab(id)
                        setRailTool(TOOLS_WITH_SIDEBAR.has(tid) ? tid : null)
                      }
                    } else if (id === 'quiz') {
                      // 错题本合成条目（2026-09-19）：回知识库标签 + 定位错题本视图（同错题本书签路径）
                      handleTabChange('knowledge')
                      window.setTimeout(() => window.dispatchEvent(new CustomEvent(LOCATE_QUIZ_VIEW_EVENT)), 100)
                      if (!wbLayout.leftLocked) setRailModule('quiz')
                    } else {
                      const t = id as TabName
                      handleTabChange(t)
                      // 2026-09-17 反馈拍板：点击标签（含重复点击已激活标签）→ 左栏若不在该模块态则切过去；
                      // 锁定时左栏归用户所有，不跟随（与 RAIL_FOLLOW 跟随语义一致）。
                      // 特判：knowledge 标签当前显示错题本子视图时保持 quiz 态（否则点「知识库」会把错题本的左栏错切成目录树）
                      if (!wbLayout.leftLocked) {
                        const m = t === 'knowledge' && quizViewOpen ? 'quiz' : RAIL_FOLLOW_MAP[t]
                        if (m) setRailModule(m)
                      }
                    }
                  }}
                  onClose={(id) => {
                    // 错题本合成条目的 ✕ = 请求关闭错题本视图（视图关 → QUIZ_VIEW_TOGGLED 回流收条目）；
                    // 标记来源 → 回流时对齐「关标签=回总览」（否则回流写死回知识库树态，2026-09-19 反馈）
                    if (id === 'quiz') {
                      quizTabCloseRef.current = true
                      window.dispatchEvent(new CustomEvent(QUIZ_VIEW_CLOSE_REQUEST_EVENT))
                      quizTabCloseRef.current = false
                      return
                    }
                    closeTab(id)
                  }}
                  onReorder={handleReorder}
                  editorSlotRef={wbEditorPageRef}
                  knowledgeSlotRef={wbKnowledgePageRef}
                  /* 错题本条目暂收（QUIZ_ENTRY_ENABLED 总闸，v3.5.0 随交互重做放出）——
                     onSelect/onClose 的 'quiz' 分支保留（死代码但 harmless，重做时直接接线） */
                  showQuizEntry={QUIZ_ENTRY_ENABLED && quizViewOpen && openTabs.includes('knowledge')}
                   /* 单激活（2026-09-20）：激活 = knowledge 标签在前台**且**当前视图是错题本；
                      页面视图时激活落在页签组条目上（模块侧 activeId 置 null 配合） */
                   quizEntryActive={quizViewOpen && activeTab === 'knowledge'}
                   hidePages={zenLevel >= 1}
                 />
              )}
              {/* 整窗模块的「回工作台」入口 = 图标条顶部「工作台」按钮（2026-09-17 bug 修复轮：
                  原右上角浮动「工作台」按钮删除——入口统一收敛到 ActivityBar，避免同一功能两处入口） */}
              {/* 编辑器组（W3 · Editor Groups v1）：主栏渲染。
                  v3.4.0 批次3：旧 R1-W1 全局侧栏槽（wbSidebarEl）已删除——editor 文件树与
                  knowledge/schedule/blog 侧栏统一由左栏模块态 slot（wbModSlotEl）portal 承接 */}
              <div className="flex min-h-0 flex-1">
                <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                  {/* 模块渲染区。
                      ★ 保活结构：模块容器**全部是这一行的直接子元素**（单一父节点），DOM 顺序按
                      `mountedTabs` 访问序恒定不变；可见性只由 style 的 `display` 决定，不换父节点。
                      为什么必须这样：React 的 reconciliation 作用域是「父节点 + children 数组」，
                      把「当前可见模块」挪到数组之外/换父节点 = 旧位置删除 + 新位置新增 →
                      模块内 useState 全归零（实机探针实证过：知识库页签组 items 2 → 0）。
                      已验证的错路：① 挂跨父节点稳定 key（key 只在同父节点内有效）；
                      ② createPortal 换 target（一样重挂）。 */}
                  <div className="relative flex min-h-0 min-w-0 flex-1">
                    {/* 内容级操作浮层（v3.4.0 页面条置顶）：插图/大纲/预览/保存全部 的胶囊，
                        以及知识库页面级动作槽 `#editor-toolbar-slot`。
                        ★ 2026-09-20：两者收进**一个悬浮胶囊**（data-wb="floatBar"，样式见
                        styles/index.css 的 [data-wb='floatBar'] 段）——半透明毛玻璃底，
                        静息态收成小把手（次级钮标 .kb-float-hide 者在非悬停时隐藏），
                        模块只需给次级按钮加类，展开/淡出由 CSS 自持，无需上报状态。
                        `pointer-events-none` 外壳保证空白区不挡内容点击；胶囊本体 auto。
                        该 id 必须保留 —— knowledge/components/PageEditor.tsx 按 id 全局查它做 portal。 */}
                    <div
                      data-wb="mainPane"
                      className="pointer-events-none absolute inset-y-0 left-0 z-30 flex w-full items-start justify-end"
                    >
                      <div data-wb="floatBar" className="pointer-events-auto mr-3 mt-3">
                        <div ref={wbContentActionsRef} className="flex items-center" />
                        <div id="editor-toolbar-slot" className="flex items-center gap-0.5" />
                      </div>
                    </div>
                    {/* 模块容器序列：可见模块撑满（flex-1），其余 display:none 常驻保活。
                        ISS-2026-09-04-02 / -07：可见与隐藏模块必须在**同一个 keyed 数组**里，
                        否则可见↔隐藏换子节点槽位会被 React 按位置卸载重建。 */}
                    {rowModules.map((t) => (
                      <div
                        key={t}
                        data-pane="main"
                        className="relative flex min-h-0 flex-1 flex-col"
                        style={{ display: t === activeTab ? undefined : 'none', minWidth: 0 }}
                      >
                        {renderMounted(t, t === activeTab)}
                      </div>
                    ))}
                    {/* 工具标签宿主（批次4，保活）：**绝对定位铺满主栏区域**，不参与上面的 flex 流。
                        激活的可见，其余已开工具 display:none 常驻（工具内状态如密码本解锁态不丢）。 */}
                    {mountedToolTabs.current.size > 0 && (
                      <div
                        className="absolute inset-y-0 left-0 z-20 flex min-h-0 w-full flex-col"
                        style={{ display: activeToolTab ? undefined : 'none' }}
                      >
                        {activeToolTab && renderToolMounted(activeToolTab, true)}
                        {Array.from(mountedToolTabs.current)
                          .filter((t) => t !== activeToolTab)
                          .map((t) => renderToolMounted(t, false))}
                      </div>
                    )}
                    {/* 全关空态（2026-09-17 拍板③）：无激活模块且无工具标签时显示引导页；
                        绝对定位铺满主栏区域（不参与 flex 流，避免挤动两栏几何）。 */}
                    {activeTab === null && !activeToolTab && (
                      /* 空态只留图标（2026-09-19 反馈：不要文字说明，页面简画） */
                      <div
                        className="absolute inset-y-0 left-0 z-20 flex w-full flex-col items-center justify-center pb-16"
                      >
                        <AppWindow size={44} strokeWidth={1.2} className="text-[var(--text-disabled)]" />
                      </div>
                    )}
                  </div>
                  {/* AI 助手右下浮钮已移除（2026-09-16）：AI 对话入口迁移（批次5 中间栏 aiChat 标签），
                      Ctrl+J 链路保留不受影响（ai-assistant:toggle 事件链路随浮钮一并废除，2026-09-22 清理） */}
                  {/* 番茄钟全屏面板：挂在内容卡片内（而非 main），只覆盖主内容区 ——
                      否则会盖住右侧的任务栏（DayPanel），表现为「进入番茄钟任务栏被关闭/唤不出」 */}
                  <PomodoroPanel />
                </div>
              </div>
              </div>
            </div>
            </>
              }
            />
          </main>
      {/* 全局 AI 助手侧栏。shellLeft = 全屏扩张时要避让的活动栏占位宽度
          （活动栏不渲染时 → 0：禅模式 Z2 隐壳，或用户显式隐藏了活动栏；最大化 flush → 56；否则 56 + mx-1.5 两侧留白）。
          suspendShortcut：工作台内 Ctrl+J 归 App 路由（唤出右栏 AI 侧栏），整窗模块才归本组件。
          aiShortcutDisabled：AI 教学区连 Ctrl+Shift+J 也一并禁（AI_ASSISTANT_SHORTCUT_DISABLED 清单） */}
      <AssistantPanel
        shellLeft={zenLevel >= 2 || !activityBarVisible ? 0 : winMax ? 56 : 68}
        suspendShortcut={!fullWindowTab}
        aiShortcutDisabled={aiShortcutDisabled}
      />
        </div>
      {workbench && <WorkbenchStatusBar />}
        </div>
      </PomodoroProvider>
      {palette === 'command' && (
        <CommandPalette
          placeholder="输入命令…（如：打开编辑器 / 切换布局）"
          items={buildCommandItems()}
          footer="↑↓ 选择 · Enter 执行 · Esc 关闭"
          onClose={() => setPalette(null)}
        />
      )}
      {palette === 'file' && (
        <CommandPalette
          placeholder="搜索页面：标题 / 路径（如：虚拟存储器）"
          items={fileItems}
          loading={fileLoading}
          emptyHint="仓库中暂无可打开的 .md 页面（需 vault 读源并已建索引）"
          footer="基于知识页索引 · Enter 在编辑器打开 · 再按 Ctrl+O 关闭"
          onClose={() => setPalette(null)}
        />
      )}
      {/* UI 优化条目1.7：最大化态边缘/顶栏拖拽恢复热区（Edge 式 v2，随 winMax 挂载/卸载） */}
      {winMax && <WindowResizeHandles />}
      <Toast />
      <GlobalConfirm />
      {vaultPickOpen && <VaultPicker onDone={(created) => { setVaultPickOpen(false); if (!s.onboardingDone) setOnboardingOpen(true); if (created) setActiveTab('knowledge') }} />}
      {startupPickerOpen && <VaultPicker startup onDone={() => setStartupPickerOpen(false)} />}
      {onboardingOpen && (
        <Onboarding
          onComplete={() => { update('onboardingDone', true); setOnboardingOpen(false) }}
          onSwitchTab={tab => setActiveTab(tab)}
        />
      )}
      {importModalOpen && <ImportModal onClose={() => setImportModalOpen(false)} initialBackupPath={importBackupPath} />}
    </div>
    </RootErrorBoundary>
  )
}
