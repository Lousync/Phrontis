import type { TabName } from '../types'

/**
 * 工作台三栏外壳的布局状态（v3.4.0）。
 *
 * 存储口径（方案 §3.5 定表）：全部走**全局设置**单键 `workbenchLayout`（JSON 字符串）——
 * 工作台是应用外壳而非仓库内容，换库体验应一致；`dayPanelState` 已是全局键，口径统一。
 * 左右栏宽度不进本键：由 `ResizablePanel` 按各自 storageKey（wb.leftWidth / wb.rightWidth）
 * 持久化，本键只存「非宽度」状态。
 *
 * 解析规则刻意做钝：只收已知键、类型不对的丢弃、坏 JSON 整体走默认 ——
 * 外壳状态坏了绝不能炸启动（同 `resolveStartupTab` 的钝规则哲学）。
 */

export interface WorkbenchLayout {
  /** 左栏收起（批次3 前默认展开显示临时模块列表） */
  leftCollapsed: boolean
  /** 左栏双态：总览（书签）/ 树（文件树模式） */
  leftMode: 'overview' | 'tree'
  /** 左栏锁定：锁定后主界面切换不跟随（原型 v15 📌） */
  leftLocked: boolean
  /** 右栏收起 */
  rightCollapsed: boolean
  /** 右栏双 Tab：小工具 / AI */
  rightTab: 'widgets' | 'ai'
  /** 右栏控件排序（今日任务 task / 今日打卡 habit / 番茄钟 pomo / 网址导航 nav / 密码生成器 password） */
  widgetOrder: string[]
  /** 右栏隐藏的控件 id（⋯ 菜单选显） */
  widgetsHidden: string[]
  /** 右栏隐藏的面板 Tab id（⋯ 菜单管理显示哪些 Tab：'widgets' | 'ai'；DP 条目6「无 ✕ 关闭按钮」） */
  panelTabsHidden: string[]
  /** 左栏隐藏的书签（🔖 菜单选显；内置 RailModule key 与插件书签 id 共用此清单） */
  bookmarksHidden: string[]
  /** 分屏比例（主栏:副栏，0~1；null = 未分屏） */
  splitRatio: number | null
  /** 控件默认可见集迁移标记（2026-09-17）：旧布局 widgetsHidden=[] = 「默认全显」时代的默认态，
   *  首次解析时收敛为新默认并置位；置位后尊重用户选择（含手动全显）。见 parseWorkbenchLayout */
  widgetsDefaultMigrated?: boolean
}

/** 右栏控件的规范顺序（缺省序 = 原型 v15 定稿）；DayPanel 四控件 id 沿用 DAY_TABS */
export const WORKBENCH_WIDGET_IDS = ['task', 'habit', 'pomo', 'password', 'nav'] as const

/**
 * 右栏下段简略视图的**默认可见控件**（2026-09-17 右栏优化轮拍板）：
 * 默认只显番茄钟——右栏下段是常驻区，任务/打卡/导航/密码生成器都在各自模块有完整界面，
 * 塞进右栏只会互相挤压。其余 4 个控件仍在切换条 ⋯ 菜单里可手动勾回（隐藏 ≠ 卸载）。
 */
export const DEFAULT_VISIBLE_WIDGET_IDS: readonly string[] = ['pomo']

/**
 * 源自 DayPanel 的四个控件 id（方案 §3.7 互斥判定用）：整体脱离为独立窗口
 * （dayPanelDetached）时，右栏这四槽显示「已在桌面」置灰条目，点击 = 收回悬浮回嵌右栏。
 * password 控件不在 DayPanel 内，不参与互斥。
 */
export const DAY_PANEL_WIDGET_IDS = ['task', 'habit', 'pomo', 'nav'] as const

/** 右栏面板 Tab 的规范集合（🧩 小工具 / 🤖 AI） */
export const WORKBENCH_PANEL_TAB_IDS = ['widgets', 'ai'] as const

export const DEFAULT_WORKBENCH_LAYOUT: WorkbenchLayout = {
  leftCollapsed: false,
  leftMode: 'overview',
  leftLocked: false,
  rightCollapsed: true,
  rightTab: 'widgets',
  widgetOrder: [...WORKBENCH_WIDGET_IDS],
  // 默认隐藏 = 规范集 - 默认可见集（2026-09-17：右栏下段默认只显番茄钟）
  widgetsHidden: WORKBENCH_WIDGET_IDS.filter((id) => !DEFAULT_VISIBLE_WIDGET_IDS.includes(id)),
  panelTabsHidden: [],
  bookmarksHidden: [],
  splitRatio: null,
}

export function parseWorkbenchLayout(raw: string | undefined | null): WorkbenchLayout {
  const base: WorkbenchLayout = {
    ...DEFAULT_WORKBENCH_LAYOUT,
    widgetOrder: [...DEFAULT_WORKBENCH_LAYOUT.widgetOrder],
    // 缺键时用规范默认（右栏默认只显番茄钟，见 DEFAULT_VISIBLE_WIDGET_IDS），
    // 不再硬编码 [] —— 否则「默认可见集」永远被空数组（= 全显）覆盖
    widgetsHidden: [...DEFAULT_WORKBENCH_LAYOUT.widgetsHidden],
  }
  if (!raw) return base
  try {
    const v: unknown = JSON.parse(String(raw))
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>
      if (typeof o.leftCollapsed === 'boolean') base.leftCollapsed = o.leftCollapsed
      if (o.leftMode === 'overview' || o.leftMode === 'tree') base.leftMode = o.leftMode
      if (typeof o.leftLocked === 'boolean') base.leftLocked = o.leftLocked
      if (typeof o.rightCollapsed === 'boolean') base.rightCollapsed = o.rightCollapsed
      if (o.rightTab === 'widgets' || o.rightTab === 'ai') base.rightTab = o.rightTab
      if (Array.isArray(o.widgetOrder)) {
        const known = new Set<string>(WORKBENCH_WIDGET_IDS)
        const filtered = o.widgetOrder.filter((x): x is string => typeof x === 'string' && known.has(x))
        // 缺失控件按规范顺序补齐（钝规则：宁补不丢）
        for (const id of WORKBENCH_WIDGET_IDS) if (!filtered.includes(id)) filtered.push(id)
        base.widgetOrder = filtered
      }
      if (Array.isArray(o.widgetsHidden)) {
        base.widgetsHidden = o.widgetsHidden.filter((x): x is string => typeof x === 'string')
      }
      /* 控件默认可见集一次性迁移（2026-09-17 右栏优化轮）：
         旧持久化里 widgetsHidden=[] 是「默认全显」时代的**默认态**（不是用户的显式选择），
         直接改 DEFAULT 对它无效。这里在「未打过迁移标记 + 隐藏集为空」时收敛为新默认，
         并置标记让写回落盘；打过标记的数据（含用户之后手动全显）不再迁移 —— 幂等且不误伤。 */
      if (o.widgetsDefaultMigrated !== true) {
        if (base.widgetsHidden.length === 0) base.widgetsHidden = [...DEFAULT_WORKBENCH_LAYOUT.widgetsHidden]
        base.widgetsDefaultMigrated = true
      }
      if (Array.isArray(o.panelTabsHidden)) {
        base.panelTabsHidden = o.panelTabsHidden.filter((x): x is string => typeof x === 'string')
          .filter((x) => (WORKBENCH_PANEL_TAB_IDS as readonly string[]).includes(x))
      }
      if (Array.isArray(o.bookmarksHidden)) {
        base.bookmarksHidden = o.bookmarksHidden.filter((x): x is string => typeof x === 'string')
      }
      if (o.splitRatio === null || (typeof o.splitRatio === 'number' && Number.isFinite(o.splitRatio))) {
        base.splitRatio = o.splitRatio as number | null
      }
    }
  } catch { /* 坏 JSON 走默认 */ }
  return base
}

/**
 * 顶部模块切换条排除清单：aiTeaching 走整窗形态不进切换条；devtools 由 DEV 按钮直达、
 * 进了切换条也无法从 UI 再打开，一并排除。
 *
 * 2026-09-17 第三轮 UI 反馈拍板：标签条 = **文档标签式动态标签**（openTabs，可关闭/拖拽/
 * 全关空态），模块按钮不上标签栏——openTabs 恢复为标签条数据源。
 * 2026-09-17 第四轮反馈拍板②：**图标条功能（回收站/插件市场/工具箱/动态/设置）点击只切换
 * 视图、不登记为标签页**——它们是功能面板不是文档型模块，图标条常驻可随时返回；
 * aiTeaching 整窗形态（标签条本身隐藏）与 devtools dev-only 一并排除。
 * 本清单在 openTabs 登记处与渲染处双重过滤。本文件保持零 value import，契约脚本 strip-types 直跑不炸。
 */
export const WORKBENCH_TABBAR_EXCLUDED: readonly TabName[] = ['aiTeaching', 'devtools', 'moments', 'toolbox', 'plugins', 'recycle', 'settings']

/**
 * 左栏书签模块（v3.4.0 方案 §3.3 映射表，原型 v15 定稿 6 项）。
 * quiz（错题本）不占独立 TabName：打开 = `openTab('knowledge')` + `kb-locate-quiz-view`
 * 事件定位到模块内「错题本 / 收藏」视图；左栏模块态复用 knowledge 侧栏（错题本按空间分区）。
 */
export type RailModule = 'editor' | 'knowledge' | 'schedule' | 'bookshelf' | 'blog' | 'quiz'

export interface WorkbenchBookmark {
  key: RailModule
  label: string
  /** 书签点击打开的中间栏标签 */
  tab: TabName
}

/** 书签集合（内置固定 6 项）——契约脚本 verify-workbench-shell.mjs 对此做映射双向断言 */
export const WORKBENCH_BOOKMARKS: readonly WorkbenchBookmark[] = [
  { key: 'editor', label: '编辑区', tab: 'editor' },
  { key: 'knowledge', label: '知识库', tab: 'knowledge' },
  { key: 'schedule', label: '日程', tab: 'schedule' },
  { key: 'bookshelf', label: '书架', tab: 'bookshelf' },
  { key: 'blog', label: '博客总结', tab: 'blog' },
  { key: 'quiz', label: '错题本', tab: 'knowledge' },
]

/**
 * 书签配色（原型 v15 定稿 c-teal/blue/orange/green/purple/red 六色系）。
 * fg = 图标与文字色，bg = 图标底块色（同色低透明度）；明暗主题下均可读。
 */
export interface BookmarkColor { fg: string; bg: string }
export const BOOKMARK_COLORS: Readonly<Record<RailModule, BookmarkColor>> = {
  editor: { fg: '#2a988f', bg: 'rgba(42,161,152,.14)' },
  knowledge: { fg: '#4f6ef2', bg: 'rgba(79,110,242,.14)' },
  schedule: { fg: '#d97a1e', bg: 'rgba(232,132,44,.16)' },
  bookshelf: { fg: '#35975c', bg: 'rgba(63,174,106,.15)' },
  blog: { fg: '#9157d6', bg: 'rgba(160,107,224,.15)' },
  quiz: { fg: '#c94f4f', bg: 'rgba(217,91,91,.14)' },
}

/**
 * 主界面切换 → 左栏模块态跟随映射（原型 v15「自动跟随」语义）：
 * 激活标签变为映射内的模块且未锁定（!leftLocked）时，左栏进入该模块侧边栏态；
 * **不在映射内的标签（设置/工具箱/动态…）不动左栏**（保持用户当前的书签/总览态）。
 */
export const RAIL_FOLLOW_MAP: Readonly<Partial<Record<TabName, RailModule>>> = {
  editor: 'editor',
  knowledge: 'knowledge',
  schedule: 'schedule',
  bookshelf: 'bookshelf',
  blog: 'blog',
}

/**
 * quiz 书签 → knowledge 模块「错题本 / 收藏」视图的定位事件。
 * App 书签点击 = `openTab('knowledge')` + 延迟派发本事件（同 kb-open-knowledge-page 通道约定，
 * 冷启动时模块保活注册可能未就绪）；knowledge 模块监听后打开错题本视图。
 */
export const LOCATE_QUIZ_VIEW_EVENT = 'kb-locate-quiz-view'

/**
 * 错题本左栏（QuizNavPanel）→ QuizCollection 视图内聚焦某本书（科目）。
 * QuizNavPanel 点书条目 = 派发本事件携带书名；QuizCollection 监听后 setBookFilter + 展开书架。
 * 2026-09-17 第四轮拍板④：错题本从知识库目录树侧栏剥离，左栏 quiz 态挂本组件。
 */
export const QUIZ_FOCUS_BOOK_EVENT = 'kb-quiz-focus-book'
