import { useState, useEffect, useCallback, useRef, useMemo, Suspense } from 'react'
import type { TabName, KnowledgePage, KnowledgeCategory, KnowledgeTag } from './types'

import { PALETTE_MODULES, labelOf as tabLabel, resolveStartupTab, isTabName } from './lib/appModules'
import { WORKBENCH_TABBAR_EXCLUDED } from './lib/workbenchLayout'
import { landingAfterClose } from './modules/editor/tabPolicy'
import { WorkbenchShell } from './components/workbench/WorkbenchShell'
import { WorkbenchTabBar } from './components/workbench/WorkbenchTabBar'
import { parseWorkbenchLayout, RAIL_FOLLOW_MAP, WORKBENCH_BOOKMARKS, LOCATE_QUIZ_VIEW_EVENT, type RailModule } from './lib/workbenchLayout'

import { TitleBar, ActivityBar, GlobalConfirm } from './components/shared'
import { ZenHotZone } from './components/shared/ZenHotZone'
import { WorkbenchStatusBar } from './components/shared/WorkbenchStatusBar'
import { QuickSearch } from './modules/knowledge/components/QuickSearch'
import { CommandPalette, type PaletteItem } from './components/shared/CommandPalette'
import { SplitPaneBar } from './components/shared/SplitPaneBar'
import { CodePluginHosts } from './components/shared/CodePluginHosts'
import { Toast } from './components/shared/Toast'
import { FONT_CSS_MAP, applyThemeClass } from './lib/settings'
import { useSettings } from './lib/SettingsContext'
import { isEditingInput } from './lib/shortcuts'
import { setGlobalActiveTab } from './lib/activeTab'
import { getKnowledgePages, getKnowledgeCategories, getKnowledgeTags, workspaceGetCurrent, getReleaseNotesState, pluginListCommands, onPluginInstalledChanged } from './lib/ipc'
import { requestPluginViewActivation, dispatchCodePluginAction } from './lib/pluginCommandBus'
import { showToast } from './lib/toast'
import type { PluginCommandInfo } from './types'
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
import { EditorModule } from './modules/editor'
import { BookshelfModule } from './modules/bookshelf'
import { AiTeachingModule } from './modules/ai-teaching'
import { ReleaseNotesModule } from './modules/release-notes'

import { FillPopup } from './modules/toolbox/components/FillPopup'
import { VaultPicker } from './components/shared/VaultPicker'
import { PomodoroProvider } from './modules/toolbox/hooks/PomodoroContext'
import { PomodoroPanel } from './modules/toolbox/components/PomodoroPanel'
import { Onboarding } from './components/shared/Onboarding'
import { ImportModal } from './modules/shared/components/ImportModal'
import { useCheckinReminder } from './lib/useCheckinReminder'
import { installFileOpUndoShortcuts } from './lib/fileOpHistory'
import { AssistantPanel } from './components/shared/AssistantPanel'
import { DayPanelWindowApp } from './daypanel/DayPanelWindowApp'
import { DayPanel } from './daypanel/DayPanel'
import { RootErrorBoundary } from './components/shared/RootErrorBoundary'
import { ResizablePanel } from './components/shared/ResizablePanel'
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
  // 日程打卡侧边栏（WeChat 模式）：内嵌/脱离状态由 React + 主进程共同管理
  const [dayPanelVisible, setDayPanelVisible] = useState(false)
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
  const dayPanelMaxWidth = Math.max(300, Math.min(500, Math.floor(winWidth * 0.4)))

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

  // 左栏模块态（书签侧边栏）：null = 总览态。跟随逻辑见下方 effect（RAIL_FOLLOW_MAP + leftLocked）
  const [railModule, setRailModule] = useState<RailModule | null>(null)

  // 抽屉面板实际占宽：标题栏搜索框/按钮锚定主内容区的偏移依据（面板卸载时归零）
  const [dayPanelWidth, setDayPanelWidth] = useState(0)
  useEffect(() => {
    if (!dayPanelVisible || dayPanelDetached) setDayPanelWidth(0)
  }, [dayPanelVisible, dayPanelDetached])

  // 禅模式（docs/zen-mode-design.md）：0=off 1=Z1 专注 2=禅。唯一真相源在 App 层——
  // Z2 需隐藏标题栏/活动栏（模块内无法触及）。入口 = 标题栏「布局」菜单（布局模式 · 禅模式）；
  // 退出四条：ZenHotZone 顶栏热区 / Esc（模块内）/ 菜单再点一次 / 持久化档位由 changeZen 统一收口
  const [zenLevel, setZenLevel] = useState<number>(0)

  const { s, update, ready: settingsReady } = useSettings()
  const workbench = !!s.uiWorkbench
  // 工作台布局（workbenchLayout 键钝解析）：左栏锁定/树模式供跟随与左栏交互用
  const wbLayout = useMemo(() => parseWorkbenchLayout(s.workbenchLayout), [s.workbenchLayout])
  // 布局 · 活动栏整条显隐（标题栏「布局」菜单 ↔ 命令面板两个入口，读写同一个 setting）。
  // 与 activityBarHidden（逐模块显隐）互不干扰：这里关的是「活动栏这个容器本身」。
  // 缺省 true：老仓库 settings.json 里没这个键 → 不因升级被突然藏掉活动栏
  const activityBarVisible = s.activityBarVisible !== false

  // OS 全屏的单一真相源：两个请求方各自表态，合成后才下发——
  //   ① 禅模式 Z2（受 zenFullscreen 开关约束）② 布局菜单「全屏」（VS Code F11 语义，与禅无关）
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
  // W3 · Editor Groups v1：副栏模块（两栏互不相同；null = 未分屏）
  const [secondaryTab, setSecondaryTab] = useState<TabName | null>(null)
  // 工具箱「回主页」信号（单调递增）：已在工具箱时点击活动栏图标 → +1，工具箱模块据此退出当前工具。
  // 用信号而非命令布尔值：同一信号值不会重复触发，连续点击每次都生效
  const [toolboxHomeSignal, setToolboxHomeSignal] = useState(0)

  // 禅模式档位统一出口：内存 + 持久化。入口 = 标题栏「布局」菜单（全模块可用，已从 AI 教学模块迁出）；
  // Esc / 顶部热区 / 菜单再点 都走这里，保证持久化一致
  const changeZen = useCallback((n: number) => { setZenLevel(n); update('zenLevel', n) }, [update])

  // ---- 全局搜索（VS Code 式：标题栏顶部输入 + 顶部结果弹层，Ctrl+P / Ctrl+` 唤出）----
  // 数据源 = 知识库索引（页面/目录/标签），打开搜索时刷新；打开页面/定位目录经事件通道进知识库模块
  const [gsPages, setGsPages] = useState<KnowledgePage[]>([])
  const [gsCategories, setGsCategories] = useState<KnowledgeCategory[]>([])
  const [gsTags, setGsTags] = useState<KnowledgeTag[]>([])
  const refreshGlobalSearch = useCallback(async () => {
    try {
      const [p, c, t] = await Promise.all([getKnowledgePages(), getKnowledgeCategories(), getKnowledgeTags()])
      setGsPages(p ?? []); setGsCategories(c ?? []); setGsTags(t ?? [])
    } catch { /* 索引未就绪时保持旧数据 */ }
  }, [])
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
      // 全局 Esc 退禅兜底（开发负责人 2026-09-15 拍板「全生效」）：禅入口上移到标题栏布局菜单后，
      // 从任意模块都能进禅，但此前只有编辑器 / AI 教学自己监听 Esc（禅入口曾在它们手里），
      // 其余模块只能摸顶部 8px 热区。编辑器 / AI 教学仍优先走自己那份（带「先关本模块弹窗再退禅」
      // 的档位逻辑，App 不抢）；命令面板 / 快速切换器开着时 Esc 归它们收。
      if (e.key === 'Escape' && zenLevel >= 2 && !palette) {
        const zenOwnerActive =
          activeTab === 'editor' || secondaryTab === 'editor' ||
          activeTab === 'aiTeaching' || secondaryTab === 'aiTeaching'
        if (!zenOwnerActive) { e.preventDefault(); changeZen(0); return }
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault()
        setPalette((p) => (p === 'command' ? null : 'command'))
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
  }, [zenLevel, activeTab, secondaryTab, palette, changeZen])

  // 快速切换器数据源：知识页索引（默认 vault 读源带 path → 经 kb-open-in-editor 在编辑器组打开）
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
                if (p.path) window.dispatchEvent(new CustomEvent('kb-open-in-editor', { detail: { relPath: p.path } }))
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
  const SLOT_MODULE: Record<string, TabName> = { knowledge: 'knowledge', editor: 'editor', blog: 'blog', schedule: 'schedule', aiTeach: 'aiTeaching' }
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
      { id: 'editor', label: '打开 编辑器', hint: 'Vault 文件' },
      { id: 'knowledge', label: '打开 知识库', hint: '阅读 / 导航' },
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
      // 布局菜单（VS Code Customize Layout 同款）的命令面板侧入口：与标题栏「布局」下拉共用同一份状态
      { id: 'toggle-activitybar', label: activityBarVisible ? '布局：隐藏活动栏' : '布局：显示活动栏', group: '界面设置', run: () => { update('activityBarVisible', !activityBarVisible); setPalette(null) } },
      { id: 'toggle-zen', label: zenLevel >= 2 ? '布局：退出禅模式' : '布局：禅模式（全屏沉浸）', group: '界面设置', run: () => { changeZen(zenLevel >= 2 ? 0 : 2); setPalette(null) } },
      { id: 'toggle-fullscreen', label: osFullscreen ? '布局：退出全屏' : '布局：全屏', group: '界面设置', run: () => { setOsFullscreen(!osFullscreen); setPalette(null) } },
    )
    // W3 · 分屏命令（Editor Groups）：开/关副栏 + 选副栏模块（排除当前主栏，避免同模块双实例）
    items.push(
      { id: 'split-toggle', label: secondaryTab ? '分屏：关闭副栏' : '分屏：开启副栏', hint: '两栏独立选模块', group: '分屏', run: () => { setSecondaryTab(secondaryTab ? null : (activeTab === 'knowledge' ? 'editor' : 'knowledge')); setPalette(null) } },
    )
    PALETTE_MODULES.filter((m) => m.id !== activeTab).forEach((m) => {
      items.push({ id: `split-${m.id}`, label: `分屏：在副栏打开 ${m.label}`, group: '分屏', run: () => { setSecondaryTab(m.id); setPalette(null) } })
    })
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
      2026-09-17 拍板：恢复为标签条数据源（文档标签式，可关闭/拖拽/全关空态），可关闭与重排由 closeTab / handleReorder 消费。 */
  const [openTabs, setOpenTabs] = useState<TabName[]>([])

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
  // UI 优化条目6：跳转来源记录——kb-open-in-editor 带 from（如 aiTeaching），编辑器出「← 返回 X」chip；
  // 新跳转覆盖旧来源，任何手动切 Tab（handleTabChange）清除
  const [editorJumpFrom, setEditorJumpFrom] = useState<TabName | null>(null)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { relPath?: string; from?: TabName } | undefined
      const relPath = detail?.relPath
      if (typeof relPath === 'string' && relPath) {
        setPendingOpenRel(relPath)
        if (detail?.from) setEditorJumpFrom(detail.from)
      }
      setActiveTab('editor')
    }
    window.addEventListener('kb-open-in-editor', handler)
    return () => window.removeEventListener('kb-open-in-editor', handler)
  }, [])

  // 日程侧边栏（v3.2.0 ⑮）桌面磁贴的日历 → 日志跳转。
  // 与 kb-open-in-editor 同范式：事件只送意图，payload 走 state + props
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

  // 日程打卡侧边栏：脱离态变化推送（独立窗口打开/销毁）
  useEffect(() => {
    const off = window.api?.onDayPanelStateChanged?.(({ detached }) => {
      setDayPanelDetached(detached)
      // 脱离→内嵌（独立窗口被关）：自动恢复内嵌显示，避免用户看到一个"消失的面板"
      if (!detached) setDayPanelVisible(true)
    })
    return () => { off?.() }
  }, [])
  // 全局快捷键 Ctrl+Alt+S toggle：脱离态→吸附 + 显示内嵌；否则切内嵌可见性
  useEffect(() => {
    const off = window.api?.onDayPanelToggleVisibility?.(() => { setDayPanelVisible(v => !v) })
    return () => { off?.() }
  }, [])

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
  useEffect(() => {
    if (!activeTab || WORKBENCH_TABBAR_EXCLUDED.includes(activeTab)) return
    setOpenTabs((ts) => (ts.includes(activeTab) ? ts : [...ts, activeTab]))
  }, [activeTab])

  // 关闭标签（✕ / 中键）：关的是激活标签 → 落右邻居优先、越界退左邻居（tabPolicy.landingAfterClose
  // 与编辑器文档标签同一份语义）；关完为空 = 空态（activeTab 置 null，拍板③允许全部关闭），
  // 且左栏退回总览态（2026-09-17 第四轮反馈拍板①：全关后不滞留某模块侧栏）
  const closeTab = useCallback((tab: TabName) => {
    const i = openTabs.indexOf(tab)
    if (i === -1) return
    const next = openTabs.filter((t) => t !== tab)
    setOpenTabs(next)
    if (activeTab === tab) {
      const landing = landingAfterClose(openTabs, tab) as TabName | null
      setActiveTab(landing)
      if (landing === null) setRailModule(null)
    }
  }, [openTabs, activeTab])

  // 标签拖拽重排（现成机制恢复）：只调 openTabs 顺序，激活标签跟内容走、不变
  const handleReorder = useCallback((tabs: TabName[]) => setOpenTabs(tabs), [])

  const handleTabChange = (tab: TabName) => {
    setEditorJumpFrom(null) // 手动切 Tab 即清除「返回来源」上下文（条目6）
    if (tab === activeTab) {
      // 工具箱专属（2026-09-10）：已在工具箱时再点活动栏图标 = 退出当前工具、回到工具箱主界面。
      // 通用行为对图标条无意义 —— v3.4.0 起图标条幂等哲学：重复点击已激活模块 = 无操作
      //（旧「再点当前 = 切模块侧栏」语义随双态设计废弃，模块侧栏将由左栏双态接管，见方案 §3.6）
      if (tab === 'toolbox') { setToolboxHomeSignal(n => n + 1); return }
      return
    }
    // 分屏冲突：目标已在副栏 → 主栏显示它、旧主栏进副栏（避免同模块双实例）
    if (secondaryTab === tab) {
      const old = activeTab
      setActiveTab(tab)
      setSecondaryTab(old)
      setSidebarOpen(true)
      window.dispatchEvent(new CustomEvent('tab-switched'))
      return
    }
    setActiveTab(tab); setSidebarOpen(true); window.dispatchEvent(new CustomEvent('tab-switched'))
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

  /** 左栏模块态「← 返回总览」：清模块态，锁定态顺带自动解锁（原型 lpBack 语义） */
  const handleBackToOverview = () => {
    setRailModule(null)
    if (wbLayout.leftLocked) update('workbenchLayout', JSON.stringify({ ...wbLayout, leftLocked: false }))
  }

  /** 左栏散文件点击 → 编辑区打开（复用 kb-open-in-editor 的 pendingOpenRel 通道） */
  const handleOpenLooseFile = (relPath: string) => {
    setPendingOpenRel(relPath)
    handleTabChange('editor')
  }

  // 日程打卡侧边栏：标题栏按钮 + Ctrl+Alt+S 统一入口
  // - 脱离态 → 吸附回来（关独立窗口 + 显示内嵌）
  // - 内嵌态 → 切可见性
  const toggleDayPanel = useCallback(() => {
    if (dayPanelDetached) {
      void window.api?.dayPanelDockBack?.()
      setDayPanelVisible(true)
    } else {
      setDayPanelVisible(v => !v)
    }
  }, [dayPanelDetached])

  // Ctrl+= / Ctrl+- zoom — synced with settings
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return
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
  }, [s.zoom, s.zoomMin, s.zoomMax, s.zoomStep, update])

  // Ctrl+B — toggle sidebar
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditingInput(e)) return
      if (e.ctrlKey && e.key === 'b') {
        e.preventDefault()
        setSidebarOpen(v => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!loaded) return null

  /** 整窗模块（2026-09-17 第五轮拍板修正）：回收站/插件市场/工具箱/动态/设置与 aiTeaching/devtools
      一样**与工作台平级**——激活时整窗独占（左右栏与标签条隐藏，见 suppressSides），
      不再呈现为「工作台内的子模块」；EXCLUDED 同时承担「不登记为标签页」的过滤。 */
  const fullWindowTab = activeTab !== null && WORKBENCH_TABBAR_EXCLUDED.includes(activeTab)

  /** 模块内容（主栏/副栏共用；on = 该模块当前在屏幕某栏激活） */
  function renderModuleContent(name: TabName, on: boolean): React.ReactNode {
    switch (name) {
      case 'blog': return <BlogModule showLineNumbers={s.showLineNumbers} sidebarOpen={sidebarOpen} zoom={s.zoom} sidebarWidths={sidebarWidths} onSnapCloseSidebar={() => setSidebarOpen(false)} onSnapOpenSidebar={() => setSidebarOpen(true)} blogJump={pendingBlogJump} onBlogJumpConsumed={() => setPendingBlogJump(null)} sidebarEl={on && railModule === 'blog' ? wbModSlotEl : null} sidebarHosted={on} />
      case 'schedule': return <ScheduleModule isActive={on} sidebarOpen={sidebarOpen} sidebarWidths={sidebarWidths} onSnapCloseSidebar={() => setSidebarOpen(false)} onSnapOpenSidebar={() => setSidebarOpen(true)} sidebarEl={on && railModule === 'schedule' ? wbModSlotEl : null} sidebarHosted={on} />
      case 'knowledge': return <KnowledgeModule sidebarOpen={sidebarOpen} zoom={s.zoom} sidebarWidths={sidebarWidths} onSnapCloseSidebar={() => setSidebarOpen(false)} onSnapOpenSidebar={() => setSidebarOpen(true)} isActive={on} sidebarEl={on && (railModule === 'knowledge' || railModule === 'quiz') ? wbModSlotEl : null} sidebarVariant={railModule === 'quiz' ? 'quiz' : 'knowledge'} sidebarHosted={on} />
      case 'moments': return <MomentsModule />
      case 'editor': return <EditorModule isActive={on} sidebarOpen={sidebarOpen} sidebarWidths={sidebarWidths} onSnapCloseSidebar={() => setSidebarOpen(false)} onSnapOpenSidebar={() => setSidebarOpen(true)} sidebarEl={on && railModule === 'editor' ? wbModSlotEl : null} sidebarHosted markdownDim={s.markdownDim} pendingOpenRel={pendingOpenRel} onPendingConsumed={() => setPendingOpenRel(null)} openFrom={editorJumpFrom && editorJumpFrom !== 'editor' ? tabLabel(editorJumpFrom) : null} onBackFrom={() => { const f = editorJumpFrom; if (f) { setEditorJumpFrom(null); handleTabChange(f) } }} zenLevel={zenLevel} onZenLevelChange={setZenLevel} />
      case 'bookshelf': return <BookshelfModule isActive={on} />
      case 'aiTeaching': return <AiTeachingModule isActive={on} zenLevel={zenLevel} onZenLevelChange={changeZen} />
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
  /** 槽位级保活挂载：首次出现在任意栏后常驻（display:none 保活），同一模块只在一个栏渲染 */
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

  return (
    <RootErrorBoundary>
    <div className={`flex flex-col h-screen bg-[color-mix(in_srgb,var(--bg-primary)_92%,transparent)] overflow-hidden ${winRounded ? 'rounded-[var(--window-radius)]' : 'rounded-none'}`}>
      <CodePluginHosts />
      {zenLevel < 2 ? (
        <TitleBar
          dayPanelActive={dayPanelVisible || dayPanelDetached}
          onToggleDayPanel={toggleDayPanel}
          drawerWidth={dayPanelWidth}
          activityBarVisible={activityBarVisible}
          onActivityBarChange={(v) => update('activityBarVisible', v)}
          zenLevel={zenLevel}
          onZenLevelChange={changeZen}
          osFullscreen={osFullscreen}
          onOsFullscreenChange={setOsFullscreen}
        />
      ) : (
        <ZenHotZone zenLevel={zenLevel} onZenLevelChange={changeZen} />
      )}
      <PomodoroProvider>
        <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-1 overflow-hidden">
          {/* 活动栏两个收起来源：禅模式 Z2（隐壳）与布局菜单（用户显式隐藏），取并集 */}
          {zenLevel < 2 && activityBarVisible && <ActivityBar active={activeTab} onChange={handleTabChange} flush={winMax} />}
<main className="flex-1 flex overflow-hidden bg-transparent relative">
            {/* 工作台三栏外壳（v3.4.0 批次3）：左栏=书签双态（总览/模块侧栏/树模式+锁定+仓库切换） | 中间栏(卡片壳) | 右栏(占位，批次4 填控件)。
                DayPanel 保持 main 层平级（批次4 迁入右栏）；aiTeaching 整窗形态隐藏左右栏（suppressSides，方案 §2） */}
            <WorkbenchShell
              activeTab={activeTab}
              railModule={railModule}
              modSlotRef={wbModSlotRef}
              onBookmarkClick={handleBookmarkClick}
              onBookmarkVisibility={handleBookmarkVisibility}
              onBackToOverview={handleBackToOverview}
              onOpenLooseFile={handleOpenLooseFile}
              onPluginBookmark={handleTabChange}
              suppressSides={fullWindowTab}
              maximized={zenLevel >= 2 || winMax}
              right={
                <div className="flex h-full flex-col p-1.5">
                  <div className={`flex min-h-0 flex-1 flex-col overflow-hidden border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-sm ${zenLevel >= 2 || winMax ? 'rounded-none border-0' : 'rounded-xl'}`}>
                    <div className="flex h-9 shrink-0 items-center border-b border-[var(--border-color)] px-3 text-[12px] font-medium text-[var(--text-secondary)]">小工具</div>
                    <div className="flex flex-1 items-center justify-center text-[11.5px] text-[var(--text-muted)]">控件区 · 批次4</div>
                  </div>
                </div>
              }
              center={
            <>
            {/* 主内容区卡片壳：与左右两侧(ActivityBar / 日程打卡面板)同款圆角+阴影+留白，三卡对称。
                半透明底色 + 顶缘高光 = 液态玻璃卡片；禅模式 Z2+ 或 最大化（UI 优化条目1）全屏化（去边距/圆角/边框，贴满屏幕） */}
            <div className={`transition-all duration-300 ease-out ${zenLevel >= 2 || winMax ? 'flex min-w-0 flex-1' : 'm-1.5 flex min-w-0 flex-1'}`}>
              <div className={`relative flex min-h-0 flex-1 flex-col overflow-hidden transition-all duration-300 ease-out ${zenLevel >= 2 || winMax ? 'bg-[color-mix(in_srgb,var(--bg-primary)_92%,transparent)]' : 'rounded-xl border border-[var(--border-color)] bg-[color-mix(in_srgb,var(--bg-primary)_88%,transparent)] shadow-[inset_0_1px_0_var(--glass-edge),0_6px_24px_rgba(0,0,0,0.16)]'}`}>
              {/* 顶部标签条（v3.4.0 方案 §3.2；2026-09-17 第三轮反馈拍板定稿）：文档标签式动态
                  标签（openTabs，可关闭/拖拽重排/全关空态），模块按钮不上标签栏——模块由书签 /
                  图标条入口打开。整窗模块（EXCLUDED 平级模块）激活时整条隐藏（同 aiTeaching，方案 §2） */}
              {!fullWindowTab && (
                <WorkbenchTabBar
                  tabs={openTabs.filter((t) => !WORKBENCH_TABBAR_EXCLUDED.includes(t))}
                  active={activeTab}
                  onSelect={handleTabChange}
                  onClose={closeTab}
                  onReorder={handleReorder}
                />
              )}
              {fullWindowTab && (
                <button
                  onClick={() => handleTabChange([...openTabs].reverse()[0] ?? 'editor')}
                  title="返回工作台"
                  className="kb-pop absolute right-3 top-2 z-30 flex items-center gap-1 rounded-full bg-[var(--accent)] px-3 py-1 text-[11.5px] text-white shadow-lg transition-opacity hover:opacity-90"
                >
                  工作台
                </button>
              )}
              {/* 编辑器组（W3 · Editor Groups v1）：主栏 + 可选副栏，两栏模块互不相同。
                  v3.4.0 批次3：旧 R1-W1 全局侧栏槽（wbSidebarEl）已删除——editor 文件树与
                  knowledge/schedule/blog 侧栏统一由左栏模块态 slot（wbModSlotEl）portal 承接 */}
              <div className="flex min-h-0 flex-1">
                <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                  {/* 编辑器组（W3 · Editor Groups v1）：主栏 + 可选副栏，两栏模块互不相同 */}
                  <div className="flex min-h-0 min-w-0 flex-1">
                    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                      {/* 主栏：activeTab 可见；其余已访问模块 display:none 常驻保活（切 Tab 不卸载 → 状态保留）。
                          ISS-2026-09-04-02：原实现只渲染 activeTab，切走即卸载（知识库页签/树状态全丢）。
                          保活顺序 = mountedTabs 访问序 + activeTab 兜底首访（on=true 时 add 到集合）。
                          UI 优化条目6B（根因修）：可见与隐藏模块必须装进**同一个 keyed 数组**——旧写法把可见
                          模块单列为数组外的首个子节点，切 Tab 时可见↔隐藏换了子节点槽位，React 按位置卸载重建
                          （= ISS-2026-09-04-07 备注的「保活层在切 Tab 时会重建编辑器实例」真实成因）；
                          同数组内换序由 key 保住实例，模块内状态（会话/中栏视图/滚动）自然保留。 */}
                      {[
                        ...(activeTab ? [activeTab] : []),
                        ...Array.from(mountedTabs.current).filter((t) => t !== activeTab && t !== secondaryTab),
                      ].map((t) => renderMounted(t, t === activeTab))}
                      {/* 全关空态（2026-09-17 拍板③）：无激活模块时显示引导页；已保活模块仍在（display:none） */}
                      {activeTab === null && (
                        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 pb-16">
                          <div className="text-[13.5px] text-[var(--text-secondary)]">所有标签页已关闭</div>
                          <div className="text-[12px] text-[var(--text-muted)]">从左侧书签或图标条打开模块</div>
                        </div>
                      )}
                    </div>
                    {secondaryTab && secondaryTab !== activeTab && (
                      <ResizablePanel
                        storageKey="kb.splitSecondaryWidth"
                        side="right"
                        defaultWidth={380}
                        minWidth={300}
                        maxWidth={Math.max(420, Math.floor(winWidth * 0.45))}
                        visible
                        showHandle
                        onSnapClose={() => setSecondaryTab(null)}
                      >
                        <div className="flex h-full flex-col">
                          <SplitPaneBar
                            currentLabel={tabLabel(secondaryTab)}
                            targets={PALETTE_MODULES.filter((m) => m.id !== activeTab && m.id !== secondaryTab)}
                            onSwitch={(id) => setSecondaryTab(id as TabName)}
                            onClose={() => setSecondaryTab(null)}
                          />
                          <div className="flex min-h-0 flex-1 flex-col">
                            {renderMounted(secondaryTab, true)}
                          </div>
                        </div>
                      </ResizablePanel>
                    )}
                  </div>
                  {/* AI 助手右下浮钮已移除（2026-09-16）：AI 对话入口迁移（批次5 中间栏 aiChat 标签），
                      Ctrl+J 与 ai-assistant:toggle 事件链路保留不受影响 */}
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
            {dayPanelVisible && !dayPanelDetached && (
              <ResizablePanel
                storageKey="dayPanelEmbedded"
                defaultWidth={300}
                minWidth={240}
                maxWidth={dayPanelMaxWidth}
                side="right"
                visible
                showHandle
                growWindow
              >
                {/* 内嵌面板的"子窗口"外壳：留白 + 圆角 + 阴影，让它在主窗口内像独立浮窗（微信会议窗同款）；
                    最大化时与主内容/活动栏同条件贴边（UI 优化条目1） */}
                <div className={`flex min-h-0 flex-1 flex-col overflow-hidden transition-all duration-300 ease-out ${winMax ? 'bg-[var(--bg-secondary)]' : 'm-1.5 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-[0_6px_24px_rgba(0,0,0,0.16)]'}`}>
                  <DayPanel
                    mode="embedded"
                    onPopout={() => { void window.api?.dayPanelPopout?.() }}
                    onClose={() => setDayPanelVisible(false)}
                  />
                </div>
              </ResizablePanel>
            )}
          </main>
      {/* 全局 AI 助手侧栏。shellLeft = 全屏扩张时要避让的活动栏占位宽度
          （活动栏不渲染时 → 0：禅模式 Z2 隐壳，或布局菜单把它整条藏了；最大化 flush → 56；否则 56 + mx-1.5 两侧留白） */}
      <AssistantPanel shellLeft={zenLevel >= 2 || !activityBarVisible ? 0 : winMax ? 56 : 68} />
        </div>
      {/* 全局搜索（VS Code 式顶部弹层）：输入 portal 进标题栏，全模块可用 */}
      <QuickSearch
        pages={gsPages}
        categories={gsCategories}
        tags={gsTags}
        onOpenPage={openKnowledgePageFromSearch}
        onLocateCategory={locateKnowledgeCategoryFromSearch}
        onRequestRefresh={refreshGlobalSearch}
        onRunCommand={(id) => openTab(id as TabName)}
      />
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
      {vaultPickOpen && <VaultPicker onDone={(created) => { setVaultPickOpen(false); if (!s.onboardingDone) setOnboardingOpen(true); if (created) setActiveTab('editor') }} />}
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
