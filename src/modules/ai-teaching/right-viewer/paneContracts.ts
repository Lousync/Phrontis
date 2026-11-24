/**
 * 右侧查看器 · 页签契约（冻结层）
 *
 * 方案：`/home/lousync/Projects/DesginProcess/Phrontis/已实现设计文档/ai-teaching-right-viewer-plan.md` §3 / §6；本轮改版：`tmp/ai-teach-right-viewer/PLAN.md`
 *   （四固定页签 → 动态实例页签；同一 kind 可多开；旁问草稿；文件页签就地编辑）
 *
 * 为什么先冻结这一层：四个 kind 的 pane 由不同批次实现，壳由另外的批次实现。
 * 如果各方各写一套 props，最后接线时必然出现「壳传 A、pane 等 B」的返工；
 * 更糟的是**静默失配**（可选属性漏传 → 页签永远空态，编译不报错）。
 * 所以本文件是唯一真相源：**只允许追加可选字段，不允许改已有字段的类型**。
 *
 * 本文件零运行时依赖（只有 `import type` + 纯常量），可被契约脚本直接读取。
 */

import type { FilePaneKind, NotesFileKind, ViewerPaneType } from './viewerTabs'

/* ============================== 页签 ============================== */

/**
 * 能力标识（网页 / 笔记 / 书架 / 旁问 / 文件）。**不是实例 id**：
 * 每个实例的 id 在 `viewerTabs.ts` 的 `ViewerTab.id` 上，一个 kind 可以有多实例。
 */
export type { FilePaneKind, NotesFileKind, ViewerPaneType } from './viewerTabs'

/** 兼容期别名：老代码 import `ViewerTabKey` 的地方语义不变，但它现在表示「类型」。 */
export type ViewerTabKey = ViewerPaneType

/**
 * 五个 kind 的固定顺序（图标 / 文案共用；页签条由实例数组驱动）。
 * `file` 在 `ask` 之前，但**不进 `+` 菜单** —— 文件统一从左栏 / 素材 / 产物进入。
 */
export const VIEWER_TABS: ReadonlyArray<{ key: ViewerPaneType; label: string }> = [
  { key: 'web', label: '网页' },
  { key: 'notes', label: '笔记' },
  { key: 'books', label: '书架' },
  { key: 'file', label: '文件' },
  { key: 'ask', label: '旁问' },
]

export function isViewerTabKey(v: unknown): v is ViewerPaneType {
  return v === 'web' || v === 'notes' || v === 'books' || v === 'ask' || v === 'file'
}

/* ============================== 公共上下文 ============================== */

/**
 * 壳 → pane 的公共上下文。
 *
 * `active` 与 `open` 是两件事，别合并：
 *   · `open=false` = 面板宽度收敛为 0（内容被 overflow 裁掉），pane 可能还挂载 → 原生视图必须 hide；
 *   · `active=false` = 用户切到了别的页签，pane 可能保活 → 也必须 hide。
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
  /** 本实例的页签 id（aria / 调试 / 去重都靠它；老调用方不传也能跑） */
  tabId?: string
  /** 本实例的能力类型（pane 内部不需要再猜） */
  type?: ViewerPaneType
}

/**
 * 跨页签导航出口：由壳注入。
 *
 * 为什么不让 pane 直接改壳的状态：页签之间会互相唤起（笔记里的链接 → 网页；
 * 素材里的 PDF → 书架），如果每个 pane 各自 `setTab` + 传参，顺序与「先切页签再打开」
 * 的时序会在几个地方各写一遍。统一成几个动作，壳里只实现一次（去重也在壳里）。
 */
export interface ViewerActions {
  /** 打开 / 聚焦网页（本批只允许一个网页页签：已开则聚焦并导航） */
  openWeb: (url: string) => string
  /** 打开 / 聚焦仓库内的 md / txt（D1：可编辑）；同文件去重 */
  openNote: (relPath: string, meta?: {
    title?: string
    fileKind?: NotesFileKind
    ownerSessionId?: string | null
  }) => string
  /** 打开 / 聚焦一本书（同一本书去重，不同书可多开） */
  openBook: (relPath: string, name?: string) => string
  /** 打开 / 聚焦已落库的旁问（同 lane 去重） */
  openAsk: (laneId: string) => string
  /** 关闭页签（脏笔记先 flush；冲突未决时拦住） */
  closeTab: (tabId: string) => void
  /** 按实例 id 切换页签 */
  setTab: (tabId: string) => void
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

/**
 * 宿主 → 壳的一次性请求（现有 `request` 通道的扩展）。
 *
 * `mode` 只对 AI 产物有意义：
 *   · `open`   普通打开（去重 / 聚焦）
 *   · `begin`  生成占位（按 `slug` 合并，不重复开；自动展开查看器）
 *   · `commit` 占位原地转正式（按 `slug` 匹配；同 relPath 已开则就地刷新）
 *   · `drop`   生成失败 / 停止，清掉对应 `slug`（缺省 = 全部）生成中的占位
 */
export interface ViewerOpenRequest {
  tab: ViewerPaneType
  seq: number
  mode?: 'open' | 'begin' | 'commit' | 'drop'
  url?: string
  relPath?: string
  name?: string
  ask?: unknown
  fileKind?: FilePaneKind
  previewDefault?: boolean
  slug?: string
  page?: number
}

/* ============================== 各页签 props ============================== */

export interface WebPaneProps extends ViewerPaneContext {
  /** 壳转发的外链 / 「打开网址」请求（已保证是 http/https） */
  request?: PaneOpenRequest | null
  /** 恢复 / 外部打开时的初始地址；空串 = 起始页 */
  initialUrl?: string
  /** 标题变化上报（页签条显示当前站点标题） */
  onTitleChange?: (title: string) => void
  /** 地址变化上报（壳把它写回页签对象，重启后仍是这一页） */
  onUrlChange?: (url: string) => void
  /** 原生视图 bounds 失效时上报（壳可据此收起浮层，避免被原生视图盖住） */
  onOverlayRisk?: (risk: boolean) => void
  /**
   * 可见性重算令牌：壳在浮层打开时 `webPaneHideAll()`，
   * 浮层关闭后 bump 这个值让 pane 重新 show（原生视图不会自己回来）。
   */
  syncToken?: number
}

export interface NotesPaneProps extends ViewerPaneContext {
  /** 从「本次改动」/ 产物 / 素材点进来的文件 */
  request?: PaneOpenRequest | null
  /** 本实例要编辑的文件（一个笔记页签 = 一个文件）；空串 = 还没定文件 */
  initialRelPath?: string
  /** 从文件树 / 素材点开：默认进预览（仅 .md 生效） */
  initialPreview?: boolean
  /** 普通笔记 / 会话画像 / 会话要求（只影响标题、列表显隐与写盘通道） */
  fileKind?: NotesFileKind
  /** 画像 / 要求所属会话；普通笔记为空。**写盘按它走，不按当前 sessionId** */
  ownerSessionId?: string | null
  /** 动作行里的文件名 / 页签名（缺省从 relPath 推） */
  displayName?: string
  /** 标题变化上报（文件名 / 画像 / 要求 → 页签条） */
  onTitleChange?: (title: string) => void
  /** 文件真正打开后回填实际 relPath（空串页签据此补上文件身份） */
  onRelPathChange?: (relPath: string) => void
  /** 脏标记上报（壳据此保护页签不被保活窗口淘汰） */
  onDirtyChange?: (dirty: boolean) => void
  /**
   * 注册/注销「关闭前 flush」：壳在关页签前 await 它。
   * 返回 `false` = 有未处理的冲突（或保存失败），壳应拦住关闭。
   */
  registerFlush?: (flush: (() => Promise<boolean>) | null) => void
  /** 「在编辑器中打开」出口（D1 保留正式编辑入口） */
  onOpenInEditor: (relPath: string) => void
  /** 文件切换器点击 → 交给外壳去重 / 开新页签（pane 不自己开第二个实例） */
  onRequestOpenNote?: (relPath: string) => void
  /** 「新建笔记」→ 交给外壳建文件并开页签（一个文件一个页签） */
  onRequestNewNote?: () => void
  /**
   * 不渲染笔记列表列（含窄态的开合按钮）。对话模式由左栏会话文件树承担切文件入口，
   * 这一列是重复入口 —— 模式派生，不是用户可调项，故不落 localStorage。
   * 缺省 false = 课程模式现状。
   */
  hideNoteList?: boolean
}

/**
 * 文件页签（一个页签 = 一个非文本文件）。
 * `generating` 为真时只渲染骨架 + 文案，不读盘；`rev` 是外部改动重读令牌。
 */
export interface FilePaneProps extends ViewerPaneContext {
  /** 壳转发的一次性请求 */
  request?: PaneOpenRequest | null
  /** 本实例要渲染的文件（生成中为空串） */
  initialRelPath: string
  /** 内部渲染分派（html / 图片 / 导图 / pptx） */
  fileKind: FilePaneKind
  /** AI 生成中占位：只出骨架，禁关 */
  generating?: boolean
  /** 产物的 slug（visual.html / image） */
  slug?: string
  /** 外部改动重读令牌（pptx 变化时重新取页） */
  rev?: number
  /** pptx 当前页（0 基）；由壳写回页签对象 */
  page?: number
  /** 动作行里的文件名（缺省从 relPath 推） */
  displayName?: string
  /** 标题变化上报（文件名 → 页签条） */
  onTitleChange?: (title: string) => void
  /** pptx 页码变化上报 */
  onPageChange?: (page: number) => void
  /** html 等「在编辑器中打开」出口 */
  onOpenInEditor?: (relPath: string) => void
  /** 导图节点 ref 点击 → 壳再开一个文件页签（左聊右看，不跳模块） */
  onOpenFileRef?: (relPath: string) => void
  /** pptx「讲解此页」：只传页信息，发送逻辑留在宿主 */
  onTalkPage?: (page: { name: string; page: number; n: number; text: string }) => void
}

export interface BooksPaneProps extends ViewerPaneContext {
  /** 从素材 / 产物点进来的书 */
  request?: PaneOpenRequest | null
  /** 本页签当前在读的书；null = 书架视图（书架 → 书 → 回书架都在同一个页签里） */
  initialRelPath?: string | null
  /** 书名缓存（清单未回来时先显示） */
  displayName?: string
  /** 标题变化上报（书架 / 书名） */
  onTitleChange?: (title: string) => void
  /** 书架点书 → 壳决定是聚焦已开的书页签，还是让当前页签进入 reader */
  onOpenBook?: (relPath: string, name: string) => void
  /** 返回书架（同一个页签内切回 shelf） */
  onBackToShelf?: () => void
  /** 全屏阅读（D8：右侧给「全屏」把当前书与位置带过去） */
  onOpenFullscreen?: (relPath: string) => void
}

export interface AskPaneProps extends ViewerPaneContext {
  /** 支线中心的一次性请求（锚点 chip「就这点追问」）——新模型下由壳消费，pane 可忽略 */
  request?: { kind: string; [k: string]: unknown } | null
  requestSeq?: number
  /** 已落库的旁问会话 id；null = 草稿（未发第一问） */
  laneId?: string | null
  /** 草稿参数（laneId 为空时才有）；首问成功后由壳清空 */
  draft?: import('./viewerTabs').AskDraft | null
  /** 草稿的首问已落库 → 壳写回 laneId / 标题并持久化 */
  onLaneReady?: (laneId: string, title: string) => void
  /** 标题变化上报（首问生成的标题 / 改名） */
  onTitleChange?: (title: string) => void
  /** 关闭本页签（草稿 = 丢弃，不写库；已落库 = 只关视图，lane 仍在历史里） */
  onRequestClose?: () => void
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
 *
 * 页签状态：`aiTeach.rightTabs.v2` 为唯一写入键（全部页签 + 顺序 + 活动页签；草稿不写）。
 * 旧键 `aiTeach.rightTab` / `aiTeach.webTabs.<sid>` / `aiTeach.railTab` **只读迁移**，不再写入。
 */
export const VIEWER_LS_KEYS = {
  open: 'aiTeach.rightOpen',
  /** 动态页签状态（v2） */
  tabsV2: 'aiTeach.rightTabs.v2',
  /** 旧：单个页签类型。只读迁移，一个版本后删除 */
  tab: 'aiTeach.rightTab',
  /** 更旧：右栏分区。只读迁移 */
  legacyRailTab: 'aiTeach.railTab',
  /** 旧：网页页签的内层结构。只读迁移 */
  webTabs: (sessionId: string) => `aiTeach.webTabs.${sessionId}`,
} as const
