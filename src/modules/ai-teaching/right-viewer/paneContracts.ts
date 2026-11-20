/**
 * 右侧查看器 · 页签契约（冻结层）
 *
 * 方案：`docs/ai-teaching-right-viewer-plan.md` §3 / §6，决策 C5（四页签）与 D1–D8。
 *
 * 为什么先冻结这一层：四个页签由四条并行线各自实现，壳由第五条线实现。
 * 如果各方各写一套 props，最后接线时必然出现「壳传 A、pane 等 B」的返工；
 * 更糟的是**静默失配**（可选属性漏传 → 页签永远空态，编译不报错）。
 * 所以本文件是唯一真相源：**只允许追加可选字段，不允许改已有字段的类型**。
 *
 * 本文件零运行时依赖（只有 `import type`），可被契约脚本直接读取。
 */

/* ============================== 页签 ============================== */

/** 四个固定页签（C5 已拍板：网页 / 笔记 / 书架 / 旁问；进度与素材不进来） */
export type ViewerTabKey = 'web' | 'notes' | 'books' | 'ask'

export const VIEWER_TABS: ReadonlyArray<{ key: ViewerTabKey; label: string }> = [
  { key: 'web', label: '网页' },
  { key: 'notes', label: '笔记' },
  { key: 'books', label: '书架' },
  { key: 'ask', label: '旁问' },
]

export function isViewerTabKey(v: unknown): v is ViewerTabKey {
  return v === 'web' || v === 'notes' || v === 'books' || v === 'ask'
}

/* ============================== 公共上下文 ============================== */

/**
 * 壳 → pane 的公共上下文。
 *
 * `active` 与 `open` 是两件事，别合并：
 *   · `open=false` = 面板宽度收敛为 0（内容被 overflow 裁掉），pane 仍挂载 → 原生视图必须 hide；
 *   · `active=false` = 用户切到了别的页签，pane 保活（D5：切页签只隐藏不卸载）→ 也必须 hide。
 * 网页页签尤其依赖这两个值：`WebContentsView` 永远盖在 DOM 上，漏一次 hide 就会在别处留下白块。
 */
export interface ViewerPaneContext {
  /** 当前仓库 rootId；未打开仓库时为空串（pane 自己出空态，不要抛错） */
  rootId: string
  /** 当前 AI 教学会话 id；空串 = 还没有会话 */
  sessionId: string
  /** 当前会话标题（笔记默认文件名、旁问标题用） */
  sessionTitle: string
  /** 当前课程工作区 id；空串或 '__none__' = 未进课程 */
  workspaceId: string
  /** 面板宽度 px —— pane 用它做窄栏适配（阅读器重排、列表单双列） */
  width: number
  /** 是否为当前页签 */
  active: boolean
  /** 面板是否打开 */
  open: boolean
}

/**
 * 跨页签导航出口：由壳注入。
 *
 * 为什么不让 pane 直接改壳的状态：页签之间会互相唤起（笔记里的链接 → 网页；
 * 素材里的 PDF → 书架），如果每个 pane 各自 `setTab` + 传参，顺序与"先切页签再打开"
 * 的时序会在四个地方各写一遍。统一成四个动作，壳里只实现一次。
 */
export interface ViewerActions {
  /** 在网页页签打开 http(s) 链接（外链默认行为，C2） */
  openWeb: (url: string) => void
  /** 在笔记页签打开仓库内的 md / txt（D1：可编辑） */
  openNote: (relPath: string, name?: string) => void
  /** 在书架页签打开仓库内的书（PDF / EPUB / FB2 / FBZ / CBZ / TXT） */
  openBook: (relPath: string, name?: string) => void
  /** 切换页签（不改变已打开的页签内容） */
  setTab: (tab: ViewerTabKey) => void
  /** 关闭整个查看器 */
  close: () => void
}

/** 「请某个页签打开某个东西」的一次性请求；seq 递增用于同一路径重复点击也能触发 */
export interface PaneOpenRequest {
  seq: number
  /** 网页用 url；文件类用 relPath */
  url?: string
  relPath?: string
  name?: string
}

/* ============================== 各页签 props ============================== */

export interface WebPaneProps extends ViewerPaneContext {
  /** 壳转发的外链 / 「打开网址」请求（已保证是 http/https） */
  request?: PaneOpenRequest | null
  /** 标题变化上报（页签条显示当前站点标题） */
  onTitleChange?: (title: string) => void
  /** 原生视图 bounds 失效时上报（壳可据此收起浮层，避免被原生视图盖住） */
  onOverlayRisk?: (risk: boolean) => void
}

export interface NotesPaneProps extends ViewerPaneContext {
  /** 从「本次改动」/ 产物 / 素材点进来的文件 */
  request?: PaneOpenRequest | null
  /** 脏标记上报（壳在切页签 / 关面板前 flush） */
  onDirtyChange?: (dirty: boolean) => void
  /** 「在编辑器中打开」出口（D1 保留正式编辑入口） */
  onOpenInEditor: (relPath: string) => void
}

export interface BooksPaneProps extends ViewerPaneContext {
  /** 从素材 / 产物点进来的书 */
  request?: PaneOpenRequest | null
  /** 全屏阅读（D8：右侧给「全屏」把当前书与位置带过去） */
  onOpenFullscreen?: (relPath: string) => void
}

export interface AskPaneProps extends ViewerPaneContext {
  /** 支线中心的一次性请求（锚点 chip「就这点追问」） */
  request?: { kind: string; [k: string]: unknown } | null
  requestSeq?: number
  /** 主线会话最后一条 AI 回答的 messageId（作为「锚定第 N 条」的落点） */
  anchorMessageId?: string
  /** 引用回主线（只塞胶囊队列，不自动发送） */
  onQuote: (text: string) => void
  /** 浮出为独立窗口 */
  onFloat: (laneId: string) => void
  onChanged?: () => void
}

/* ============================== 持久化键 ============================== */

/**
 * localStorage 键（与现有 `aiTeach.*` 口径一致；宽度走 SETTINGS，见 `aiTeachRightViewerWidth`）。
 * 迁移：旧右栏的 `aiTeach.railTab === 'lanes'` → `ask`，其余（progress / sources）→ `web`。
 */
export const VIEWER_LS_KEYS = {
  open: 'aiTeach.rightOpen',
  tab: 'aiTeach.rightTab',
  legacyRailTab: 'aiTeach.railTab',
  webTabs: (sessionId: string) => `aiTeach.webTabs.${sessionId}`,
} as const
