/**
 * 右侧活动栏 · 动态页签模型（纯函数层，零运行时依赖）
 *
 * 方案：`tmp/ai-teach-right-viewer/PLAN.md`（动态实例页签 / 保活窗口 / 持久化 v2 / 旁问草稿）
 * 约束：`tmp/ui-batch/CONTRACT.md`（B 线只动 `right-viewer/**`）
 *
 * 为什么单独一层：页签增删 / 去重 / 保活取样 / 持久化迁移 / 溢出采样都是「输入决定输出」，
 * 放在组件里只能靠手点验证。抽到这里后 `.AGENT/scripts/ai-teaching/verify-right-viewer-tabs.mjs`
 * 可以 strip 类型后直接 import 跑真值，不起 Electron 也能锁住边界。
 *
 * ★ 本文件只允许 `import type`（保持可被脚本单独 strip 后运行）。
 */

/* ============================== 类型 ============================== */

/** 能力标识：pane 实现认这个，**不是实例 id**（一个 kind 可开多个实例） */
export type ViewerPaneType = 'web' | 'notes' | 'books' | 'ask' | 'file'

/**
 * 文件页签内部按扩展名 / 内容识别的种类（**不是页签类型**）。
 * 图片 / 导图 / PPT / 本地 HTML 共用一种 `file` 页签，内部按它分派渲染器。
 */
export type FilePaneKind = 'html' | 'image' | 'mindmap' | 'pptx'

/**
 * 笔记类页签的文件种类。
 * `profile` / `constraints` 是「会话画像 / 要求」：同一个 NotesPane，差别只在
 * 标题、要不要显示文件列表、以及写盘走哪条通道（见 PLAN §9）。
 */
export type NotesFileKind = 'note' | 'profile' | 'constraints'

export type AskSideScope = 'conversation' | 'anchor' | 'selection'

/** 旁问草稿：首问前只在页签对象里，不写库、不持久化 */
export interface AskDraft {
  parentSessionId: string
  parentTitle: string
  anchorMessageId: string
  sideScope: AskSideScope
  /** 锚定的是主线第几条 AI 回答（1 起）；整段为 null */
  anchorOrdinal: number | null
  /** 锚点回答的 2–3 行摘录（草稿态展示，帮助核对「在问什么」） */
  excerpt: string
}

interface ViewerTabBase {
  /** 动态、稳定、持久化；`t_` + uuid，绝不复用已关闭页签的 id */
  id: string
  type: ViewerPaneType
  /** 展示缓存；真源在各 pane（页面标题 / 文件名 / 书名 / 旁问标题） */
  title: string
  /** 保活 LRU 用；运行时刷新，不持久化 */
  lastActiveAt: number
}

export interface WebViewerTab extends ViewerTabBase {
  type: 'web'
  /** 页面地址；空串 = 起始页 */
  url: string
}

export interface NotesViewerTab extends ViewerTabBase {
  type: 'notes'
  /** 一个笔记页签 = 一个文件；空串 = 壳刚建、还没定文件（会由 pane 回报后回填） */
  relPath: string
  fileKind: NotesFileKind
  /** 画像 / 要求所属会话；普通笔记为 null。页签活过会话切换后，写盘仍按它走 */
  ownerSessionId: string | null
  /** 文件树 / 素材点开：默认渲染预览（空笔记页签仍从编辑开始） */
  previewDefault?: boolean
}

/**
 * 文件页签：非文本文件（html / 图片 / 导图 / pptx）的唯一页签类型，
 * 内部按 `fileKind` 分派渲染器；AI 生成中先用空 relPath 占位，完成后原地替换。
 */
export interface FileViewerTab extends ViewerTabBase {
  type: 'file'
  /** 仓库相对路径；AI 生成中的占位为空串 */
  relPath: string
  fileKind: FilePaneKind
  /** 生成中占位：禁关、不持久化；完成后原地替换 */
  generating?: boolean
  /** visual.html 的 slug / image 的 slug（空串回落 'image'） */
  slug?: string
  /** pptx 当前页（持久化；1 页 = 0） */
  page?: number
  /** 外部改动重读令牌（运行时，不持久化） */
  rev?: number
}

export interface BooksViewerTab extends ViewerTabBase {
  type: 'books'
  /** null = 书架视图；有值 = 正在读这一本（书架 → 书 → 回书架都在同一个页签里） */
  relPath: string | null
  /** 书名缓存（清单还没回来时给页签条用） */
  name?: string
}

export interface AskViewerTab extends ViewerTabBase {
  type: 'ask'
  /** null = 草稿（未发第一问）；有值 = 已落库的旁问会话 */
  laneId: string | null
  /** laneId 为空时才有；首问成功后清空 */
  draft: AskDraft | null
  /** 旁问挂在哪条主对话下（跨会话保活也必须记住，不能用「当前会话」） */
  parentSessionId: string
  parentTitle: string
}

export type ViewerTab = WebViewerTab | NotesViewerTab | BooksViewerTab | AskViewerTab | FileViewerTab

/** 持久化结构（旁问草稿 / 生成中的文件占位不进来；`lastActiveAt` 不进来） */
export interface ViewerStateV2 {
  v: 2
  tabs: ViewerTab[]
  activeId: string | null
}

/* ============================== 常量 ============================== */

/** 保活窗口：同时挂载的 pane 数上限（超出按 LRU 卸载，切回时重建） */
export const VIEWER_LIVE_WINDOW = 6
/** 网页：同时保活的实例上限（本批只允许开一个网页页签，cap 留作下一批的护栏） */
export const VIEWER_WEB_LIVE_CAP = 2
/** 电子书：同时保活的阅读器上限（PDF canvas / EPUB iframe 重） */
export const VIEWER_BOOKS_LIVE_CAP = 2
/** 文件：同时保活的实例上限（html / 导图 / 图片都重，超窗按 LRU 卸载，切回重建） */
export const VIEWER_FILE_LIVE_CAP = 3

/** `+` 菜单顺序（笔记 / 电子书 / 网页 / 旁问）—— 与 `paneContracts.VIEWER_TABS` 的图标一致 */
export const VIEWER_NEW_TAB_ORDER: ReadonlyArray<{ type: ViewerPaneType; label: string }> = [
  { type: 'notes', label: '笔记' },
  { type: 'books', label: '电子书' },
  { type: 'web', label: '网页' },
  { type: 'ask', label: '旁问' },
]

const PANE_TYPES: readonly ViewerPaneType[] = ['web', 'notes', 'books', 'ask', 'file']

export function isPaneType(v: unknown): v is ViewerPaneType {
  return v === 'web' || v === 'notes' || v === 'books' || v === 'ask' || v === 'file'
}

export function isNotesFileKind(v: unknown): v is NotesFileKind {
  return v === 'note' || v === 'profile' || v === 'constraints'
}

export function isFilePaneKind(v: unknown): v is FilePaneKind {
  return v === 'html' || v === 'image' || v === 'mindmap' || v === 'pptx'
}

/* ============================== 小工具 ============================== */

/**
 * 路径比较键：统一分隔符（`\` → `/`）+ 去首尾斜杠 + **按平台决定是否折大小写**。
 *
 * 为什么平台相关：Windows（与未来的 macOS）文件系统大小写不敏感，`A.md` / `a.md` 是同一个文件，
 * 同一个文件开两个页签会让两个实例的 mtime 基线互相踩；Linux 上它们是**两个真实文件**，
 * 无条件小写会把两个文件塌成一个页签，第二页签开不出来、`activeId` 只能回退。
 *
 * 为什么不顶层 `import { IS_LINUX } from '../../lib/platform'`：本文件会被契约脚本 strip 后
 * **单独装载到临时目录**（`verify-right-viewer-shell.mjs` 不解析相对 import），顶层 import 会让
 * 那份副本 `ERR_MODULE_NOT_FOUND`。故这里惰性求值，判据与 `src/lib/platform.ts` 的 `IS_LINUX`
 * 完全一致（同一个 `window.api.platform` 字段 + 同一个 typeof 守卫）；Node 契约脚本无 window，
 * 补 `process.platform` 兜底 —— 否则脚本里平台判据恒为「非 Linux」，Linux 行为无从断言。
 */
let defaultCaseInsensitive: boolean | null = null

function platformCaseInsensitive(): boolean {
  if (defaultCaseInsensitive !== null) return defaultCaseInsensitive
  let platform = ''
  if (typeof window !== 'undefined' && window.api && typeof window.api.platform === 'string') {
    platform = window.api.platform
  } else {
    const proc = (globalThis as { process?: { platform?: unknown } }).process
    platform = proc && typeof proc.platform === 'string' ? proc.platform : ''
  }
  defaultCaseInsensitive = platform !== 'linux'
  return defaultCaseInsensitive
}

/**
 * `opts.caseInsensitive` 省略时随平台（Linux 敏感，其它不敏感）。
 * 分隔符归一与首尾斜杠剥离两种模式都保留，唯一变化是大小写。
 */
export function pathKey(relPath: unknown, opts?: { caseInsensitive?: boolean }): string {
  const key = String(relPath ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const caseInsensitive = opts?.caseInsensitive ?? platformCaseInsensitive()
  return caseInsensitive ? key.toLowerCase() : key
}

/** 文件名（去目录）；无扩展名原样返回 */
export function baseName(relPath: unknown): string {
  const p = String(relPath ?? '').replace(/\\/g, '/')
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

/** 去目录、去扩展名：`AI教学/x/笔记.md` → `笔记`；`.keep` 这类点文件不被吃掉 */
export function stemOf(relPath: unknown): string {
  const base = baseName(relPath)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

const ASCII_DASH = /[\u2010-\u2015]/g

/** 文本 → 单行标题（去 markdown 标题号、压空白、截断） */
export function clipTitle(text: unknown, max = 16): string {
  const s = String(text ?? '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(ASCII_DASH, '-')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return ''
  return s.length > max ? s.slice(0, max) : s
}

/* ============================== 创建 ============================== */

export function makeWebTab(
  id: string,
  opts: { url?: string; title?: string } = {},
  now = 0,
): WebViewerTab {
  const url = String(opts.url ?? '').trim()
  return {
    id,
    type: 'web',
    title: String(opts.title ?? '').trim() || '新网页',
    lastActiveAt: now,
    url,
  }
}

export function makeNotesTab(
  id: string,
  opts: {
    relPath?: string
    fileKind?: NotesFileKind
    ownerSessionId?: string | null
    title?: string
    previewDefault?: boolean
  } = {},
  now = 0,
): NotesViewerTab {
  const relPath = String(opts.relPath ?? '').replace(/\\/g, '/')
  const fileKind = isNotesFileKind(opts.fileKind) ? opts.fileKind : 'note'
  return {
    id,
    type: 'notes',
    title: String(opts.title ?? '').trim() || noteTabTitle(relPath, fileKind),
    lastActiveAt: now,
    relPath,
    fileKind,
    ownerSessionId: opts.ownerSessionId ? String(opts.ownerSessionId) : null,
    ...(opts.previewDefault ? { previewDefault: true } : {}),
  }
}

/**
 * 文件页签工厂。
 * `relPath` 为空 = AI 生成中的占位（配 `generating`），标题兜底为「文件」。
 */
export function makeFileTab(
  id: string,
  opts: {
    relPath?: string
    fileKind: FilePaneKind
    title?: string
    generating?: boolean
    slug?: string
    page?: number
  },
  now = 0,
): FileViewerTab {
  const relPath = String(opts.relPath ?? '').replace(/\\/g, '/')
  const fileKind = isFilePaneKind(opts.fileKind) ? opts.fileKind : 'html'
  const slug = String(opts.slug ?? '').trim()
  const page =
    typeof opts.page === 'number' && Number.isFinite(opts.page) && opts.page >= 0
      ? Math.trunc(opts.page)
      : undefined
  return {
    id,
    type: 'file',
    title: String(opts.title ?? '').trim() || fileTabTitle(relPath),
    lastActiveAt: now,
    relPath,
    fileKind,
    ...(opts.generating ? { generating: true } : {}),
    ...(slug ? { slug } : {}),
    ...(page !== undefined ? { page } : {}),
  }
}

export function makeBooksTab(
  id: string,
  opts: { relPath?: string | null; name?: string; title?: string } = {},
  now = 0,
): BooksViewerTab {
  const relPath = opts.relPath ? String(opts.relPath).replace(/\\/g, '/') : null
  const name = String(opts.name ?? '').trim()
  const title = String(opts.title ?? '').trim() || name || (relPath ? stemOf(relPath) || '电子书' : '书架')
  return { id, type: 'books', title, lastActiveAt: now, relPath, ...(name ? { name } : {}) }
}

export function makeAskTab(
  id: string,
  opts: {
    laneId?: string | null
    draft?: AskDraft | null
    parentSessionId?: string
    parentTitle?: string
    title?: string
  } = {},
  now = 0,
): AskViewerTab {
  const laneId = opts.laneId ? String(opts.laneId) : null
  const draft = laneId ? null : (opts.draft ?? null)
  return {
    id,
    type: 'ask',
    title: String(opts.title ?? '').trim() || (draft ? draftTitle(draft) : '旁问'),
    lastActiveAt: now,
    laneId,
    draft,
    parentSessionId: String(opts.parentSessionId ?? draft?.parentSessionId ?? ''),
    parentTitle: String(opts.parentTitle ?? draft?.parentTitle ?? ''),
  }
}

/* ============================== 标题 ============================== */

/** 笔记页签标题：画像 / 要求 用人话，普通笔记用文件名 */
export function noteTabTitle(relPath: unknown, fileKind: NotesFileKind = 'note'): string {
  if (fileKind === 'profile') return '画像'
  if (fileKind === 'constraints') return '要求'
  return stemOf(relPath) || '笔记'
}

/** 文件页签标题：文件名去扩展名；生成中还没有路径时给「文件」 */
function fileTabTitle(relPath: unknown): string {
  return stemOf(relPath) || '文件'
}

/** 草稿页签标题：`新旁问 · 整段` / `新旁问 · 第 N 条` / `新旁问 · 锚定` */
export function draftTitle(draft: AskDraft | null | undefined): string {
  if (!draft) return '新旁问'
  if (draft.sideScope === 'selection') return '新旁问 · 选区'
  if (draft.sideScope === 'conversation') return '新旁问 · 整段'
  return draft.anchorOrdinal && draft.anchorOrdinal > 0
    ? `新旁问 · 第 ${draft.anchorOrdinal} 条`
    : '新旁问 · 锚定'
}

/** 首问 → 旁问标题（落库时带上去，历史列表才分得清同名整段旁问） */
export function firstQuestionTitle(text: unknown): string {
  return clipTitle(text, 16) || '旁问'
}

/** 页签条上显示什么：缓存标题为空时按类型兜底（绝不出现空页签） */
export function tabTitleOf(tab: ViewerTab | null | undefined): string {
  if (!tab) return ''
  const t = String(tab.title ?? '').trim()
  if (t) return t
  if (tab.type === 'notes') return noteTabTitle(tab.relPath, tab.fileKind)
  if (tab.type === 'file') return fileTabTitle(tab.relPath)
  if (tab.type === 'books') return tab.relPath ? stemOf(tab.relPath) || '电子书' : '书架'
  if (tab.type === 'ask') return tab.laneId ? '旁问' : draftTitle(tab.draft)
  return '新网页'
}

/** 从文件路径猜会话文件种类（壳拿不到 fileKind 时的唯一兜底；A 线可显式传） */
export function inferNotesFileKind(relPath: unknown): NotesFileKind {
  const name = baseName(relPath).toUpperCase()
  if (name === 'PROFILE.MD') return 'profile'
  if (name === 'CONSTRAINTS.MD') return 'constraints'
  return 'note'
}

/* ============================== 查找 / 去重 ============================== */

export function tabById(tabs: readonly ViewerTab[], id: string | null | undefined): ViewerTab | null {
  if (!id) return null
  return tabs.find((t) => t.id === id) ?? null
}

/** 同文件去重（笔记 / 画像 / 要求 一律按 relPath）；`opts` 只给契约脚本显式指定大小写口径 */
export function findNotesTab(
  tabs: readonly ViewerTab[],
  relPath: unknown,
  opts?: { caseInsensitive?: boolean },
): NotesViewerTab | null {
  const key = pathKey(relPath, opts)
  if (!key) return null
  for (const t of tabs) if (t.type === 'notes' && pathKey(t.relPath, opts) === key) return t
  return null
}

/** 同文件页签去重（html / 图片 / 导图 / pptx 一律按 relPath）；`opts` 同 `findNotesTab` */
export function findFileTab(
  tabs: readonly ViewerTab[],
  relPath: unknown,
  opts?: { caseInsensitive?: boolean },
): FileViewerTab | null {
  const key = pathKey(relPath, opts)
  if (!key) return null
  for (const t of tabs) if (t.type === 'file' && pathKey(t.relPath, opts) === key) return t
  return null
}

/**
 * 跨类型路径去重：md 走笔记页签、其它走文件页签，但两者都可能占用同一路径。
 * 打开前先查这一条，避免同一文件开出两个实例（两个 mtime 基线互相踩）。
 */
export function findAnyPathTab(
  tabs: readonly ViewerTab[],
  relPath: unknown,
  opts?: { caseInsensitive?: boolean },
): NotesViewerTab | FileViewerTab | null {
  const key = pathKey(relPath, opts)
  if (!key) return null
  for (const t of tabs) {
    if ((t.type === 'notes' || t.type === 'file') && pathKey(t.relPath, opts) === key) return t
  }
  return null
}

/** 同书去重（不同书可多开）；`opts` 同 `findNotesTab` */
export function findBooksTabByBook(
  tabs: readonly ViewerTab[],
  relPath: unknown,
  opts?: { caseInsensitive?: boolean },
): BooksViewerTab | null {
  const key = pathKey(relPath, opts)
  if (!key) return null
  for (const t of tabs) if (t.type === 'books' && t.relPath && pathKey(t.relPath, opts) === key) return t
  return null
}

/** 同 lane 去重（已落库的旁问） */
export function findAskTabByLane(tabs: readonly ViewerTab[], laneId: unknown): AskViewerTab | null {
  const id = String(laneId ?? '').trim()
  if (!id) return null
  for (const t of tabs) if (t.type === 'ask' && t.laneId === id) return t
  return null
}

/**
 * 草稿去重：同一作用域只留一个**未发送**草稿。
 * 整段草稿全局唯一；锚定草稿按锚点消息去重（同一锚点追问两次 = 聚焦原草稿，
 * 想换问法可以先发掉那条）。
 */
export function findDraftTab(tabs: readonly ViewerTab[], draft: AskDraft): AskViewerTab | null {
  for (const t of tabs) {
    if (t.type !== 'ask' || t.laneId || !t.draft) continue
    if (draft.sideScope === 'conversation') {
      if (t.draft.sideScope === 'conversation') return t
      continue
    }
    if (t.draft.sideScope === draft.sideScope && t.draft.anchorMessageId === draft.anchorMessageId) return t
  }
  return null
}

export function findWebTab(tabs: readonly ViewerTab[]): WebViewerTab | null {
  for (const t of tabs) if (t.type === 'web') return t
  return null
}

export function firstTabOfType(tabs: readonly ViewerTab[], type: ViewerPaneType): ViewerTab | null {
  for (const t of tabs) if (t.type === type) return t
  return null
}

/** 未发第一问的草稿页签（不持久化、关掉即丢） */
export function isDraftAskTab(tab: ViewerTab | null | undefined): tab is AskViewerTab {
  return !!tab && tab.type === 'ask' && !tab.laneId
}

/* ============================== 变更（全部返回新数组） ============================== */

/** 追加并激活（调用方负责去重；id 必须唯一） */
export function appendTab(
  tabs: readonly ViewerTab[],
  tab: ViewerTab,
): { tabs: ViewerTab[]; activeId: string } {
  return { tabs: [...tabs, tab], activeId: tab.id }
}

/** 通用补丁（title / relPath / laneId / url …）；不认识的 id 原样返回 */
export function updateTab(
  tabs: readonly ViewerTab[],
  id: string,
  patch: Record<string, unknown>,
): ViewerTab[] {
  let changed = false
  const next = tabs.map((t) => {
    if (t.id !== id) return t
    const merged = { ...t, ...patch } as ViewerTab
    // 类型标签必须留在自己的联合分支上：调用方误传 type 时以原值为准
    merged.type = t.type
    merged.id = t.id
    changed = true
    return merged
  })
  return changed ? next : (tabs as ViewerTab[])
}

/** 激活页签并刷新 LRU 时间戳（顺便把标题补成兜底值，避免空标题） */
export function activateTab(
  tabs: readonly ViewerTab[],
  id: string,
  now: number,
): { tabs: ViewerTab[]; activeId: string } {
  let hit = false
  const next = tabs.map((t) => {
    if (t.id !== id) return t
    hit = true
    return { ...t, lastActiveAt: now, title: tabTitleOf(t) }
  })
  return { tabs: hit ? next : (tabs as ViewerTab[]), activeId: id }
}

/**
 * 关闭页签并选下一个活动页签（浏览器惯例）：
 *   关的是当前 → 优先右邻，没有右邻退左邻；
 *   关的不是当前 → 活动页签不变；
 *   关掉最后一个 → `activeId = null`（面板不自动关，出零态卡）。
 */
export function closeTabById(
  tabs: readonly ViewerTab[],
  activeId: string | null,
  id: string,
): { tabs: ViewerTab[]; activeId: string | null } {
  const idx = tabs.findIndex((t) => t.id === id)
  if (idx < 0) return { tabs: tabs as ViewerTab[], activeId }
  const next = tabs.filter((t) => t.id !== id)
  if (activeId !== id) return { tabs: next, activeId }
  const fallback = next[idx] ?? next[idx - 1] ?? null
  return { tabs: next, activeId: fallback ? fallback.id : null }
}

/* ============================== 保活窗口 ============================== */

export interface LiveWindowInput {
  tabs: readonly ViewerTab[]
  activeId: string | null
  /** 有未保存正文的笔记（永不淘汰） */
  dirtyIds?: Iterable<string>
  /** 正在跑回答的旁问 lane（永不淘汰，后台跑完再切回来能看到结果） */
  runningIds?: Iterable<string>
  windowSize?: number
}

/**
 * 保活取样：返回这一轮要**挂载**的页签 id。
 *
 * 顺序：当前页签 → 脏笔记 / 运行中旁问（保护项）→ 其余按 `lastActiveAt` 降序，
 * 直到窗口满 / 类型配额满。没进窗口的页签**只卸载 pane**，页签对象与参数仍在，
 * 切回时按参数重建（不设「休眠」角标 —— 铁律 26：加载态本身就是提示）。
 */
export function selectLiveIds(input: LiveWindowInput): string[] {
  const { tabs, activeId } = input
  const limit = Math.max(1, Math.floor(input.windowSize ?? VIEWER_LIVE_WINDOW))
  const dirty = new Set(input.dirtyIds ?? [])
  const running = new Set(input.runningIds ?? [])
  const keep: string[] = []
  const counts: Record<string, number> = {}
  const capOf = (t: ViewerTab): number =>
    t.type === 'web'
      ? VIEWER_WEB_LIVE_CAP
      : t.type === 'books'
        ? VIEWER_BOOKS_LIVE_CAP
        : t.type === 'file'
          ? VIEWER_FILE_LIVE_CAP
          : limit

  const add = (t: ViewerTab | null | undefined) => {
    if (!t || keep.length >= limit || keep.includes(t.id)) return false
    if ((counts[t.type] ?? 0) >= capOf(t)) return false
    keep.push(t.id)
    counts[t.type] = (counts[t.type] ?? 0) + 1
    return true
  }

  add(tabById(tabs, activeId))
  // 保护项：脏笔记（未保存正文）与运行中的旁问，先占位再填 LRU
  for (const t of tabs) {
    if (t.type === 'notes' && dirty.has(t.id)) add(t)
  }
  for (const t of tabs) {
    if (t.type === 'ask' && t.laneId && running.has(t.id)) add(t)
  }
  const sorted = tabs.slice().sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
  for (const t of sorted) {
    if (keep.length >= limit) break
    add(t)
  }
  return keep
}

/* ============================== 页签条溢出 ============================== */

export interface StripOverflow {
  /** 是否需要 `⌄ 全部页签`（只看数量会在 4 个长标题时漏掉兜底入口） */
  overflowing: boolean
  /** 完全放得下的前 N 个（纯函数只做算术，实际滚动仍由 DOM 负责） */
  visible: number
}

/**
 * 溢出采样：按每个页签的实测宽度累加，超过容器可用宽度即「溢出」。
 * `gap` 是页签之间的间距（px）。宽度可以是 0（还没量到）——那时按「放得下」处理，
 * 由 ResizeObserver 下一帧再来一次。
 */
export function stripOverflow(itemWidths: readonly number[], available: number, gap = 1): StripOverflow {
  const total = itemWidths.reduce((s, w) => s + (Number.isFinite(w) && w > 0 ? w : 0), 0)
    + Math.max(0, itemWidths.length - 1) * gap
  if (!Number.isFinite(available) || available <= 0) return { overflowing: false, visible: itemWidths.length }
  let acc = 0
  let visible = 0
  for (const w of itemWidths) {
    const width = Number.isFinite(w) && w > 0 ? w : 0
    const next = acc + width + (visible > 0 ? gap : 0)
    if (next > available) break
    acc = next
    visible += 1
  }
  // 1px 容差：亚像素宽度之和经常正好超 0.x，不该因此常年挂一个下拉按钮
  return { overflowing: total > available + 1, visible }
}

/* ============================== 持久化 ============================== */

/** 关闭态 / 运行时字段不进持久化 */
function toPersisted(tab: ViewerTab): ViewerTab {
  const base = { id: tab.id, type: tab.type, title: tabTitleOf(tab), lastActiveAt: 0 }
  if (tab.type === 'web') return { ...base, type: 'web', url: String(tab.url ?? '') }
  if (tab.type === 'notes') {
    return {
      ...base,
      type: 'notes',
      relPath: String(tab.relPath ?? ''),
      fileKind: tab.fileKind,
      ownerSessionId: tab.ownerSessionId ?? null,
      ...(tab.previewDefault ? { previewDefault: true } : {}),
    }
  }
  if (tab.type === 'file') {
    // 运行时字段（generating / slug / rev）一律不进持久化；正文在重启后按路径重读
    return {
      ...base,
      type: 'file',
      relPath: String(tab.relPath ?? ''),
      fileKind: tab.fileKind,
      ...(typeof tab.page === 'number' && Number.isFinite(tab.page) && tab.page >= 0
        ? { page: Math.trunc(tab.page) }
        : {}),
    }
  }
  if (tab.type === 'books') {
    return {
      ...base,
      type: 'books',
      relPath: tab.relPath ? String(tab.relPath) : null,
      ...(tab.name ? { name: tab.name } : {}),
    }
  }
  return {
    ...base,
    type: 'ask',
    laneId: tab.laneId,
    draft: null,
    parentSessionId: tab.parentSessionId,
    parentTitle: tab.parentTitle,
  }
}

/** 生成中的文件占位：禁关、不持久化（与旁问草稿同一口径） */
function isGeneratingFileTab(tab: ViewerTab): boolean {
  return tab.type === 'file' && tab.generating === true
}

/**
 * 序列化：草稿页签与生成中的文件占位被过滤（关掉/刷新即消失），
 * 活动页签若指向被过滤项则落回第一个保留页签。
 * 只存「页签 + 顺序 + 活动页签」，不存任何运行时态。
 */
export function serializeViewerState(
  tabs: readonly ViewerTab[],
  activeId: string | null,
): ViewerStateV2 {
  const kept = tabs.filter((t) => !isDraftAskTab(t) && !isGeneratingFileTab(t))
  const persisted = kept.map(toPersisted)
  const active = activeId && kept.some((t) => t.id === activeId) ? activeId : (kept[0]?.id ?? null)
  return { v: 2, tabs: persisted, activeId: active }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * 反序列化（宽容）：坏 JSON / 坏项 / 未知 type / 重复 id / 重复文件一律丢弃，绝不抛。
 * 笔记 / 文件 / 电子书额外做**同文件去重**：一个文件只允许一个页签，否则两个实例的
 * mtime 基线会互相踩（PLAN §7.2 / §7.3）；file 页签按自身路径去重，坏 fileKind 与
 * 空 relPath 直接丢弃。`opts` 只给契约脚本显式指定大小写口径。
 */
export function parseViewerState(
  raw: unknown,
  opts?: { caseInsensitive?: boolean },
): ViewerStateV2 | null {
  const obj = asRecord(raw)
  if (!obj || obj.v !== 2 || !Array.isArray(obj.tabs)) return null
  const ids = new Set<string>()
  const noteKeys = new Set<string>()
  const fileKeys = new Set<string>()
  const bookKeys = new Set<string>()
  const out: ViewerTab[] = []
  for (const item of obj.tabs) {
    const r = asRecord(item)
    if (!r) continue
    const id = str(r.id).trim()
    if (!id || ids.has(id)) continue
    if (!isPaneType(r.type)) continue
    const now = Number(r.lastActiveAt)
    const lastActiveAt = Number.isFinite(now) && now > 0 ? now : 0
    const title = str(r.title)
    if (r.type === 'web') {
      ids.add(id)
      const url = str(r.url).trim()
      // 网页只认 http(s)：坏值不建页签（与 webPanePure.normalizeUrl 的口径一致）
      if (url && !/^https?:\/\//i.test(url)) continue
      out.push({ id, type: 'web', title: title || url || '新网页', lastActiveAt, url })
      continue
    }
    if (r.type === 'notes') {
      const relPath = str(r.relPath).replace(/\\/g, '/')
      const key = pathKey(relPath, opts)
      if (key && noteKeys.has(key)) continue
      if (key) noteKeys.add(key)
      const fileKind = isNotesFileKind(r.fileKind) ? r.fileKind : inferNotesFileKind(relPath)
      const owner = str(r.ownerSessionId)
      ids.add(id)
      out.push({
        id, type: 'notes', title: title || noteTabTitle(relPath, fileKind), lastActiveAt,
        relPath, fileKind, ownerSessionId: owner || null,
        ...(r.previewDefault === true ? { previewDefault: true } : {}),
      })
      continue
    }
    if (r.type === 'file') {
      const relPath = str(r.relPath).replace(/\\/g, '/')
      const key = pathKey(relPath, opts)
      // 生成中的占位不持久化；空 relPath 与非法 fileKind 都是坏项
      if (!key || !isFilePaneKind(r.fileKind)) continue
      if (fileKeys.has(key)) continue
      fileKeys.add(key)
      const page =
        typeof r.page === 'number' && Number.isFinite(r.page) && r.page >= 0
          ? Math.trunc(r.page)
          : undefined
      ids.add(id)
      out.push({
        id, type: 'file', title: title || fileTabTitle(relPath), lastActiveAt,
        relPath, fileKind: r.fileKind,
        ...(page !== undefined ? { page } : {}),
      })
      continue
    }
    if (r.type === 'books') {
      const relPath = str(r.relPath).replace(/\\/g, '/') || null
      const key = relPath ? pathKey(relPath, opts) : ''
      if (key && bookKeys.has(key)) continue
      if (key) bookKeys.add(key)
      const name = str(r.name)
      ids.add(id)
      out.push({
        id, type: 'books', title: title || (relPath ? stemOf(relPath) || '电子书' : '书架'), lastActiveAt,
        relPath, ...(name ? { name } : {}),
      })
      continue
    }
    // ask：没有 laneId 的草稿不持久化（历史遗留的坏项也按坏项丢）
    const laneId = str(r.laneId).trim()
    if (!laneId) continue
    ids.add(id)
    out.push({
      id, type: 'ask', title: title || '旁问', lastActiveAt,
      laneId, draft: null,
      parentSessionId: str(r.parentSessionId),
      parentTitle: str(r.parentTitle),
    })
  }
  const activeId = str(obj.activeId) && out.some((t) => t.id === str(obj.activeId))
    ? str(obj.activeId)
    : (out[0]?.id ?? null)
  return { v: 2, tabs: out, activeId }
}

/** 旧版网页内层页签持久化（`aiTeach.webTabs.<sid>`）的最小解析 —— 只用于一次性迁移 */
export function parseLegacyWebTabs(raw: unknown): Array<{ url: string; title: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ url: string; title: string }> = []
  for (const item of raw) {
    const r = asRecord(item)
    if (!r) continue
    const url = str(r.url).trim()
    if (!/^https?:\/\//i.test(url)) continue
    out.push({ url, title: str(r.title).trim() })
  }
  return out
}

/* ============================== 作用域持久化键 ============================== */

/**
 * 带作用域的持久化键前缀（对话模式：每个会话各记一份页签 / 宽度）。
 *
 * 与课程会话的旧键**完全分开**：旧键是 `aiTeach.rightTabs.v2`（点分隔）与
 * `aiTeachRightViewerWidth`（SETTINGS），新键是 `aiTeachViewerTabs:<scope>` /
 * `aiTeachViewerWidth:<scope>`（冒号分隔）。不传 scope 时一律走旧键，课程侧零变化。
 */
export const VIEWER_SCOPED_TABS_PREFIX = 'aiTeachViewerTabs:'
export const VIEWER_SCOPED_WIDTH_PREFIX = 'aiTeachViewerWidth:'

/**
 * 作用域清洗：只保留字母 / 数字 / `-` / `_` / `:`，其余字符替换成 `_`。
 *
 * 目的只是让 localStorage 键稳定可读（会话 id 里可能出现 `/`、空白、中文），
 * 不做任何安全承诺；清洗后为空 = 没有作用域 → 调用方走旧键。
 */
export function sanitizeViewerScope(scope: unknown): string {
  return String(scope ?? '').trim().replace(/[^A-Za-z0-9_:-]/g, '_')
}

/** 作用域 → 页签键；返回 null 表示调用方应使用旧键 `VIEWER_LS_KEYS.tabsV2` */
export function scopedViewerTabsKey(scope: unknown): string | null {
  const clean = sanitizeViewerScope(scope)
  return clean ? `${VIEWER_SCOPED_TABS_PREFIX}${clean}` : null
}

/** 作用域 → 宽度键；返回 null 表示调用方应使用旧的 SETTINGS 宽度记忆 */
export function scopedViewerWidthKey(scope: unknown): string | null {
  const clean = sanitizeViewerScope(scope)
  return clean ? `${VIEWER_SCOPED_WIDTH_PREFIX}${clean}` : null
}

/**
 * 旧键迁移（只读不删，一个版本后再清）：
 *   · `aiTeach.rightTabs.v2` 不存在时，读 `aiTeach.rightTab`（单类型）；
 *   · 该类型是 web 时，把 `aiTeach.webTabs.<sessionId>` 的每一项拆成网页页签
 *     （本批网页只允许一个，故只取第一条并保留 URL）；
 *   · 都没有 → 读更旧的 `aiTeach.railTab`；再没有 → 一个空网页页签。
 */
export function migrateLegacyViewerState(input: {
  rightTab?: string | null
  railTab?: string | null
  legacyWebTabs?: unknown
  /** id 生成器（组件传 crypto.randomUUID；脚本传固定序列） */
  newId: (index: number) => string
}): ViewerStateV2 {
  const { newId } = input
  let type: ViewerPaneType = 'web'
  const rawTab = (input.rightTab ?? '').trim()
  const rawRail = (input.railTab ?? '').trim()
  if (rawTab === 'notes' || rawTab === 'books' || rawTab === 'ask' || rawTab === 'web') {
    type = rawTab
  } else if (rawRail === 'lanes' || rawRail === 'ask') {
    type = 'ask'
  } else if (rawRail === 'notes' || rawRail === 'books') {
    type = rawRail
  }

  if (type === 'web') {
    const legacy = parseLegacyWebTabs(input.legacyWebTabs)
    const first = legacy[0]
    const tab = makeWebTab(newId(0), { url: first?.url ?? '', title: first?.title ?? '' })
    return { v: 2, tabs: [tab], activeId: tab.id }
  }
  if (type === 'notes') {
    const tab = makeNotesTab(newId(0), {})
    return { v: 2, tabs: [tab], activeId: tab.id }
  }
  if (type === 'books') {
    const tab = makeBooksTab(newId(0), {})
    return { v: 2, tabs: [tab], activeId: tab.id }
  }
  const tab = makeAskTab(newId(0), { draft: { parentSessionId: '', parentTitle: '', anchorMessageId: '', sideScope: 'conversation', anchorOrdinal: null, excerpt: '' } })
  return { v: 2, tabs: [tab], activeId: tab.id }
}
