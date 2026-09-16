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
  /** 分屏比例（主栏:副栏，0~1；null = 未分屏） */
  splitRatio: number | null
}

/** 右栏控件的规范顺序（缺省序 = 原型 v15 定稿）；DayPanel 四控件 id 沿用 DAY_TABS */
export const WORKBENCH_WIDGET_IDS = ['task', 'habit', 'pomo', 'password', 'nav'] as const

export const DEFAULT_WORKBENCH_LAYOUT: WorkbenchLayout = {
  leftCollapsed: false,
  leftMode: 'overview',
  leftLocked: false,
  rightCollapsed: true,
  rightTab: 'widgets',
  widgetOrder: [...WORKBENCH_WIDGET_IDS],
  widgetsHidden: [],
  splitRatio: null,
}

export function parseWorkbenchLayout(raw: string | undefined | null): WorkbenchLayout {
  const base: WorkbenchLayout = {
    ...DEFAULT_WORKBENCH_LAYOUT,
    widgetOrder: [...DEFAULT_WORKBENCH_LAYOUT.widgetOrder],
    widgetsHidden: [],
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
      if (o.splitRatio === null || (typeof o.splitRatio === 'number' && Number.isFinite(o.splitRatio))) {
        base.splitRatio = o.splitRatio as number | null
      }
    }
  } catch { /* 坏 JSON 走默认 */ }
  return base
}

/**
 * 工作台标签条可出现的 Tab（入口产生型哲学的反面清单）：
 * aiTeaching 走整窗形态不进标签条；devtools 由 DEV 按钮直达、进了标签条也无法从 UI 再打开，一并排除。
 */
export const WORKBENCH_TABBAR_EXCLUDED: readonly TabName[] = ['aiTeaching', 'devtools']

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
