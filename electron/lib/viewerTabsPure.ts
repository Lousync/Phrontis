/**
 * AI 教学重构 · 右侧查看器页签状态（P0 契约面）
 *
 * 方案：`/home/lousync/Projects/DesginProcess/Phrontis/已实现设计文档/Phrontis-AI教学-技术方案-2026-11-19.md`
 *   §2.10 查看器状态（ViewerTab / ViewerState 持久化，只存引用不存正文）
 *   §4.4 查看器 IPC（viewer:state:* / web:tab:*）
 *   §6.2 右侧查看器骨架（懒加载页签 / 切页签只隐藏不卸载 / bounds 同步）
 *   §6.3 动效（切页签 .kb-view-in）
 * 决策：内核文档 C4（网页页签只认 http/https）、C6（恢复页签懒加载）、
 *       C7（overlay 可调宽面板）、D5（关页签卸载）、D7（状态按 rootId+relPath 共享）。
 *
 * 纯函数、零运行时依赖；只允许 `import type` 与纯数据常量。
 * 渲染层只持有引用（rootId + relPath / url / sessionId），**绝不出现绝对路径**。
 * 本文件不读文件、不碰 Electron / DOM。
 */

import type {
  ViewerState,
  ViewerTab,
  ViewerTabFile,
  ViewerTabKind,
  ViewerTabWeb,
} from './aiTeachingTypesPure'
import { VIEWER_PANEL_MAX_W, VIEWER_PANEL_MIN_W } from './aiTeachingTypesPure'

/** 单会话的页签状态（ViewerState.sessions 的值） */
type ViewerSession = ViewerState['sessions'][string]

const FILE_KINDS: ReadonlySet<string> = new Set<ViewerTabKind>([
  'note',
  'pdf',
  'book',
  'text',
  'image',
])

const BOOK_FORMATS: ReadonlySet<string> = new Set(['epub', 'fb2', 'fbz', 'cbz'])

/* ============================== 内部工具 ============================== */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function basename(relPath: string): string {
  const parts = relPath.split(/[\\/]/)
  return parts[parts.length - 1] || relPath
}

/** 网页页签只认 http/https（C4）：本地路径 / file: / javascript: / data: 一律丢弃 */
function normalizeWebUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!/^https?:\/\//i.test(trimmed)) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (!parsed.hostname) return null
    return parsed.href
  } catch {
    return null
  }
}

function normalizeWidth(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined
  return clampWidth(Math.round(raw))
}

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return VIEWER_PANEL_MIN_W
  return Math.min(VIEWER_PANEL_MAX_W, Math.max(VIEWER_PANEL_MIN_W, Math.round(width)))
}

function clampIndex(raw: unknown, length: number): number {
  if (length <= 0) return -1
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0
  return Math.min(length - 1, Math.max(0, Math.trunc(raw)))
}

/** 归一单个页签；坏条目返回 null（调用方丢弃，不抛错） */
function normalizeTab(raw: unknown): ViewerTab | null {
  if (!isRecord(raw)) return null
  const kind = raw.kind

  if (kind === 'web') {
    if (typeof raw.url !== 'string') return null
    const url = normalizeWebUrl(raw.url)
    if (url === null) return null
    const tab: ViewerTabWeb = { kind: 'web', url }
    if (typeof raw.title === 'string' && raw.title.trim()) tab.title = raw.title.trim()
    if (raw.dormant === true) tab.dormant = true
    return tab
  }

  if (kind === 'sidechat') {
    if (typeof raw.sessionId !== 'string' || !raw.sessionId.trim()) return null
    return { kind: 'sidechat', sessionId: raw.sessionId.trim() }
  }

  if (typeof kind === 'string' && FILE_KINDS.has(kind)) {
    const relPath = typeof raw.relPath === 'string' ? raw.relPath.trim() : ''
    if (!relPath) return null
    // note 沿用旧形态（只有 relPath），rootId 缺省为空串；其他文件类必须有 rootId。
    const rootId = typeof raw.rootId === 'string' ? raw.rootId.trim() : ''
    if (!rootId && kind !== 'note') return null
    const name =
      typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : basename(relPath)
    const tab: ViewerTabFile = {
      kind: kind as ViewerTabFile['kind'],
      rootId,
      relPath,
      name,
    }
    const token = typeof raw.externalToken === 'string' ? raw.externalToken.trim() : ''
    if (token) tab.externalToken = token
    if (kind === 'book') {
      if (typeof raw.format !== 'string' || !BOOK_FORMATS.has(raw.format)) return null
      tab.format = raw.format as NonNullable<ViewerTabFile['format']>
    }
    return tab
  }

  return null
}

function replaceSession(
  state: ViewerState,
  sessionId: string,
  session: ViewerSession
): ViewerState {
  return {
    ...state,
    sessions: { ...state.sessions, [sessionId]: session },
  }
}

function makeSession(
  current: ViewerSession | undefined,
  tabs: ViewerTab[],
  activeIndex: number
): ViewerSession {
  const session: ViewerSession = { tabs, activeIndex }
  if (current?.width !== undefined) session.width = current.width
  return session
}

/* ============================== 归一 ============================== */

/**
 * 容错归一持久化数据：坏 tab 丢弃；activeIndex 钳到 `0..len-1`（空会话 -1）；
 * web tab 的 url 必须 http/https（C4）；width 钳到面板边界。
 */
export function normalizeViewerState(raw: unknown): ViewerState {
  const out: ViewerState = { v: 1, sessions: {} }
  if (!isRecord(raw) || !isRecord(raw.sessions)) return out

  for (const [sessionId, value] of Object.entries(raw.sessions)) {
    if (!sessionId) continue
    const src = isRecord(value) ? value : {}
    const tabs: ViewerTab[] = []
    if (Array.isArray(src.tabs)) {
      for (const item of src.tabs) {
        const tab = normalizeTab(item)
        if (tab !== null) tabs.push(tab)
      }
    }
    const session: ViewerSession = {
      tabs,
      activeIndex: clampIndex(src.activeIndex, tabs.length),
    }
    const width = normalizeWidth(src.width)
    if (width !== undefined) session.width = width
    out.sessions[sessionId] = session
  }

  return out
}

/* ============================== 身份 ============================== */

/**
 * 页签身份：同身份复用（C2 / D7）。
 * web → `web:<url>`；文件类 → `<kind>:<rootId>:<relPath>:<externalToken>`；sidechat → `sidechat:<sessionId>`。
 */
export function tabIdentity(t: ViewerTab): string {
  if (t.kind === 'web') return `web:${t.url}`
  if (t.kind === 'sidechat') return `sidechat:${t.sessionId}`
  return `${t.kind}:${t.rootId}:${t.relPath}:${t.externalToken ?? ''}`
}

/** 仓库外文件页签（带只读 token）；渲染层据此显示「仓库外」 */
export function isExternalTab(t: ViewerTab): boolean {
  if (t.kind === 'web' || t.kind === 'sidechat') return false
  return typeof t.externalToken === 'string' && t.externalToken.length > 0
}

/* ============================== 页签操作（全部不可变） ============================== */

/**
 * 打开页签：命中同身份 → 复用并切到它；否则追加到末尾并激活。
 * 不修改入参对象。
 */
export function openTab(
  state: ViewerState,
  sessionId: string,
  tab: ViewerTab
): { state: ViewerState; index: number; reused: boolean } {
  const current = state.sessions[sessionId]
  const tabs = current ? current.tabs.slice() : []
  const identity = tabIdentity(tab)
  const existing = tabs.findIndex((item) => tabIdentity(item) === identity)

  if (existing >= 0) {
    return {
      state: replaceSession(state, sessionId, makeSession(current, tabs, existing)),
      index: existing,
      reused: true,
    }
  }

  tabs.push(tab)
  const index = tabs.length - 1
  return {
    state: replaceSession(state, sessionId, makeSession(current, tabs, index)),
    index,
    reused: false,
  }
}

/**
 * 关闭页签：优先激活右侧邻居，没有则左侧，空则 -1。
 * 越界 index 不改动状态。不修改入参对象。
 */
export function closeTab(
  state: ViewerState,
  sessionId: string,
  index: number
): { state: ViewerState; activeIndex: number } {
  const current = state.sessions[sessionId]
  if (!current) return { state, activeIndex: -1 }
  if (!Number.isInteger(index) || index < 0 || index >= current.tabs.length) {
    return { state, activeIndex: current.activeIndex }
  }

  const tabs = current.tabs.slice()
  tabs.splice(index, 1)
  const activeIndex = tabs.length === 0 ? -1 : Math.min(index, tabs.length - 1)
  return {
    state: replaceSession(state, sessionId, makeSession(current, tabs, activeIndex)),
    activeIndex,
  }
}

/** 切换激活页签：index 钳到 `0..len-1`；空会话 -1。不修改入参对象。 */
export function setActive(state: ViewerState, sessionId: string, index: number): ViewerState {
  const current = state.sessions[sessionId]
  if (!current) return state
  const activeIndex = clampIndex(index, current.tabs.length)
  return replaceSession(state, sessionId, makeSession(current, current.tabs.slice(), activeIndex))
}

/**
 * 设置面板宽度：钳到 `VIEWER_PANEL_MIN_W..VIEWER_PANEL_MAX_W`；
 * `width <= 0` 视为清除（undefined）。不修改入参对象。
 */
export function setWidth(state: ViewerState, sessionId: string, width: number): ViewerState {
  const current = state.sessions[sessionId] ?? { tabs: [], activeIndex: -1 }
  const session = makeSession(current, current.tabs.slice(), current.activeIndex)
  if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
    session.width = clampWidth(width)
  } else {
    delete session.width
  }
  return replaceSession(state, sessionId, session)
}

/* ============================== 懒加载 / 清理 ============================== */

/** 恢复的网页页签点击后才加载（C6）：把 dormant 置 false；幂等。 */
export function activateDormant(
  state: ViewerState,
  sessionId: string,
  index: number
): ViewerState {
  const current = state.sessions[sessionId]
  if (!current) return state
  if (!Number.isInteger(index) || index < 0 || index >= current.tabs.length) return state

  const target = current.tabs[index]
  if (target.kind !== 'web' || target.dormant !== true) {
    // 幂等：已经加载 / 不是网页页签时只复制一层，不改语义。
    return replaceSession(state, sessionId, makeSession(current, current.tabs.slice(), current.activeIndex))
  }

  const tabs = current.tabs.slice()
  tabs[index] = { ...target, dormant: false }
  return replaceSession(state, sessionId, makeSession(current, tabs, current.activeIndex))
}

/** 会话被删除时清理它的页签；只删不在 alive 列表里的会话。不修改入参对象。 */
export function pruneSessions(state: ViewerState, aliveSessionIds: string[]): ViewerState {
  const alive = new Set(Array.isArray(aliveSessionIds) ? aliveSessionIds : [])
  const sessions: ViewerState['sessions'] = {}
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    if (alive.has(sessionId)) sessions[sessionId] = { ...session, tabs: session.tabs.slice() }
  }
  return { ...state, sessions }
}

/* ============================== 坐标换算 ============================== */

/**
 * 渲染层 CSS px 矩形 → 主进程 `web:tab:setBounds` 需要的设备像素。
 * `zoom <= 0`（含非有限值）视为 1；四舍五入到整数；宽高最小 1。
 */
export function boundsToDevice(
  rect: { x: number; y: number; width: number; height: number },
  zoom: number
): { x: number; y: number; width: number; height: number } {
  const z = typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  return {
    x: Math.round(rect.x * z),
    y: Math.round(rect.y * z),
    width: Math.max(1, Math.round(rect.width * z)),
    height: Math.max(1, Math.round(rect.height * z)),
  }
}
