import { net, ipcMain } from 'electron'
import { Ring, type RingItem } from './ring'

/**
 * 运行时采集 —— 网络请求、日志、IPC 调用，各用一个环形缓冲。
 *
 * 两条硬性约束：
 * 1. 网络只记录元数据，**绝不读 body**。Response 流只能消费一次，读取会破坏原有业务逻辑。
 * 2. 一律脱敏。URL 去掉 query（其中可能带 API Key），请求头只保留 content-type。
 *    项目用 secretBox 加密密钥（Electron safeStorage），不能因调试工具造成泄露。
 */

export interface NetItem extends RingItem {
  source: 'net.fetch' | 'fetch'
  url: string
  method: string
  status: number
  ok: boolean
  size: number
  durationMs: number
  error?: string
}

export interface LogItem extends RingItem {
  level: 'log' | 'info' | 'warn' | 'error'
  scope: 'renderer' | 'main'
  message: string
  stack?: string
  /** 被折叠的**紧邻同消息**条数（>=1；见 recordLog 的 B-19 折叠） */
  count?: number
  /** 该消息最后一次出现的时间（折叠时刷新；`ts` 保持首现时间） */
  lastTs?: string
}

export interface IpcItem extends RingItem {
  channel: string
  durationMs: number
  ok: boolean
  error?: string
}

export const netRing = new Ring<NetItem>(300)
export const logRing = new Ring<LogItem>(500)
export const ipcRing = new Ring<IpcItem>(500)

// ---------- UI 状态（由渲染层经 devbridge:report 上报） ----------

export interface UiState {
  activeModule?: string
  route?: string
  detail?: Record<string, unknown>
  updatedAt?: string
}

let uiState: UiState = {}

export function setUiState(patch: Partial<UiState>): void {
  uiState = { ...uiState, ...patch, updatedAt: new Date().toISOString() }
}

export function getUiState(): UiState {
  return uiState
}

/** URL 脱敏：只保留协议、主机、路径，丢弃 query 与 hash */
export function sanitizeUrl(raw: string): string {
  const s = String(raw ?? '')
  try {
    const u = new URL(s)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return s.split(/[?#]/)[0]
  }
}

function toUrl(input: unknown): string {
  if (typeof input === 'string') return input
  if (input && typeof (input as { url?: unknown }).url === 'string') {
    return (input as { url: string }).url
  }
  return String(input ?? '')
}

type FetchLike = ((input: unknown, init?: unknown) => Promise<unknown>) & {
  __kbWrapped?: boolean
}

function wrapFetch(orig: FetchLike, source: NetItem['source']): FetchLike {
  const wrapped = async (input: unknown, init?: unknown) => {
    const start = Date.now()
    const initObj = (init ?? {}) as { method?: string }
    const inputObj = input as { method?: string } | null
    const method = String(initObj.method ?? inputObj?.method ?? 'GET').toUpperCase()
    let status = 0
    let ok = false
    let size = 0
    let error: string | undefined

    try {
      const res = (await orig(input, init)) as
        | { status?: number; ok?: boolean; headers?: { get?: (k: string) => string | null } }
        | undefined
      status = res?.status ?? 0
      ok = !!res?.ok
      const len = res?.headers?.get?.('content-length')
      size = len ? Number(len) : 0
      return res
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      netRing.push({
        source,
        url: sanitizeUrl(toUrl(input)),
        method,
        status,
        ok,
        size,
        durationMs: Date.now() - start,
        error,
      })
    }
  }
  ;(wrapped as unknown as { __kbWrapped?: boolean }).__kbWrapped = true
  return wrapped
}

/** 包装应用发起的网络请求（net.fetch 用于 LLM/插件/更新，全局 fetch 用于推送） */
export function installNetCapture(): void {
  const netObj = net as unknown as { fetch?: FetchLike }
  if (typeof netObj?.fetch === 'function' && !netObj.fetch.__kbWrapped) {
    netObj.fetch = wrapFetch(netObj.fetch.bind(net), 'net.fetch')
  }
  const g = globalThis as unknown as { fetch?: FetchLike }
  if (typeof g?.fetch === 'function' && !g.fetch.__kbWrapped) {
    g.fetch = wrapFetch(g.fetch.bind(globalThis), 'fetch')
  }
}

/**
 * 包装 ipcMain.handle，记录通道、耗时与成败。
 * 必须在各 Repository 注册 handler **之前**安装，否则覆盖不到已注册的通道。
 */
export function installIpcCapture(): void {
  const target = ipcMain as unknown as {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => unknown
  }
  const orig = target.handle.bind(ipcMain)
  target.handle = (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
    return orig(channel, async (event: unknown, ...args: unknown[]) => {
      const start = Date.now()
      let ok = true
      let error: string | undefined
      try {
        return await listener(event, ...args)
      } catch (e) {
        ok = false
        error = e instanceof Error ? e.message : String(e)
        throw e
      } finally {
        ipcRing.push({ channel, durationMs: Date.now() - start, ok, error })
      }
    })
  }
}

/** 拦截主进程 console，保留原有输出的同时记入日志环 */
export function installConsoleCapture(): void {
  const levels: Array<{ key: 'error' | 'warn'; level: LogItem['level'] }> = [
    { key: 'error', level: 'error' },
    { key: 'warn', level: 'warn' },
  ]
  for (const { key, level } of levels) {
    const orig = console[key].bind(console)
    console[key] = (...args: unknown[]) => {
      try {
        const message = args
          .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : safeJson(a)))
          .join(' ')
        const stack = args.find((a) => a instanceof Error) as Error | undefined
        recordLog(level, 'main', message.slice(0, 2000), stack?.stack)
      } catch {
        /* 采集失败绝不能影响原始调用 */
      }
      orig(...args)
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)?.slice(0, 500) ?? String(v)
  } catch {
    return String(v)
  }
}

/** 上一次压入的日志对象（引用即环内那条，用于折叠紧邻重复） */
let lastLogItem: LogItem | null = null

/**
 * 记一条日志。★ B-19：**紧邻同消息折叠** —— 同 scope/level/message 连续到来时不新占条目，
 * 只在原条目上累加 `count` 并刷新 `lastTs`（`ts` 保持首现时间，首现/末现都查得到）。
 *
 * 为什么必须折叠：日志环容量只有 500，而一次「退出书籍回书架」实测就产生 266 条同一条
 * RO 环告警（主进程转发副本再加 234 条）—— 不作折叠会把整段环形缓冲挤爆，
 * **把同段时间的其它报错一起挤出去**，排查者据此下结论就会错（该现象已实际发生过一次）。
 * 只折叠**紧邻**重复：不同消息穿插时照常各记一条，事件先后关系不变。
 */
export function recordLog(
  level: LogItem['level'],
  scope: LogItem['scope'],
  message: string,
  stack?: string
): void {
  const msg = String(message).slice(0, 2000)
  if (lastLogItem && lastLogItem.scope === scope && lastLogItem.level === level && lastLogItem.message === msg) {
    lastLogItem.count = (lastLogItem.count ?? 1) + 1
    lastLogItem.lastTs = new Date().toISOString()
    return
  }
  lastLogItem = logRing.push({ level, scope, message: msg, stack, count: 1 })
}

export interface AggregatedError {
  message: string
  count: number
  level: string
  scope: string
  firstTs: string
  lastTs: string
  stack?: string
}

/** 把日志环中的 error/warn 按消息聚合，便于 AI 快速定位高发问题 */
export function aggregateErrors(includeWarn = false): AggregatedError[] {
  const map = new Map<string, AggregatedError>()
  for (const item of logRing.list()) {
    if (item.level !== 'error' && !(includeWarn && item.level === 'warn')) continue
    const key = `${item.scope}|${item.level}|${item.message}`
    const existing = map.get(key)
    if (existing) {
      // count / lastTs 都要认折叠后的口径（recordLog 的 B-19 折叠把 N 条压成 1 条 + count）
      existing.count += item.count ?? 1
      existing.lastTs = item.lastTs ?? item.ts
      if (!existing.stack && item.stack) existing.stack = item.stack
    } else {
      map.set(key, {
        message: item.message,
        count: item.count ?? 1,
        level: item.level,
        scope: item.scope,
        firstTs: item.ts,
        lastTs: item.lastTs ?? item.ts,
        stack: item.stack,
      })
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}
