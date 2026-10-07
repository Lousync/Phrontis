/**
 * 应用使用时长 —— 采集与落盘（主进程，有状态）。
 *
 * 为什么要有它：看板的「今日使用」卡与半年使用热力图都要「这台机器上用这个软件多久」，
 * 而全仓原本**没有任何**这类采集（`agentUsage.ts` 记的是 AI token，不是应用用时；
 * 遍布各处的 `durationMs` 全是 IPC / 调用延迟）。所以这块是净新增。
 *
 * 存储：`userData/data/app-usage.json`，形状 `{ version: 1, days: { 'YYYY-MM-DD': 秒 } }`。
 * **全局数据、不属于任何知识仓库**（与 `agentUsage.ts` 同层；换仓库不该换使用时长）。
 *
 * 记账时机 = 前台且未锁屏未休眠。三段式：
 *   1. 事件驱动 —— app 级 browser-window-focus/blur、powerMonitor 的
 *      suspend/resume + lock-screen/unlock-screen，一律走 `sync()` 重算「该不该计」；
 *   2. 心跳 —— 每 TICK_MS 把当前段**结算并重开**，所以崩溃最多丢一个 TICK 的量；
 *   3. 兜底 —— 每段结算时再过一遍 `clampSegment`，防「系统休眠但没发出 suspend 事件」
 *      导致一段横跨数小时。
 *
 * 日期分桶 / 跨零点拆分 / 裁剪这些判定在 `./appUsage` 里，纯函数、零依赖、可单测。
 */

import { globalReadJson, globalWriteJson } from './globalJsonStore'
import {
  clampSegment, dateKeyOf, mergeSegment, minutesOn, pruneDays, rangeMinutes, type UsageDays,
} from './appUsage'

const USAGE_FILE = 'app-usage.json'
/** 半年热力图要 ≥183 天；留足余量，换机/长期不用也能回溯一段 */
const KEEP_DAYS = 400
const FLUSH_MS = 10_000
const TICK_MS = 60_000

interface UsageFile {
  version: 1
  days: UsageDays
}

let cache: UsageFile | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null

/** 窗口是否处于前台（任一自有窗口 focused 即算） */
let focused = false
/** 系统休眠 / 锁屏中 —— 这两种状态下不该记 */
let suspended = false
/** 当前打开中的段起点；null = 没在计 */
let activeSince: number | null = null

function load(): UsageFile {
  if (cache) return cache
  const raw = globalReadJson<UsageFile>(USAGE_FILE, { version: 1, days: {} })
  cache = raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object'
    ? { version: 1, days: raw.days }
    : { version: 1, days: {} }
  return cache
}

function scheduleFlush(): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => { flushTimer = null; flush() }, FLUSH_MS)
}

function flush(): void {
  if (!cache) return
  pruneDays(cache.days, KEEP_DAYS, Date.now())
  globalWriteJson(USAGE_FILE, cache)
}

/** 结算当前段：夹上限 → 按本地日拆桶累加 → 关段 */
function settle(): void {
  if (activeSince === null) return
  const [s, e] = clampSegment(activeSince, Date.now())
  activeSince = null
  if (e > s) {
    mergeSegment(load().days, s, e)
    scheduleFlush()
  }
}

const shouldCount = (): boolean => focused && !suspended

/** 任何「该不该计」的因素变化后调用：进入计数态就开段，离开就结算关段 */
function sync(): void {
  if (shouldCount()) {
    if (activeSince === null) activeSince = Date.now()
  } else {
    settle()
  }
}

/** 窗口前台/后台切换（app 级 browser-window-focus / blur） */
export function noteFocus(v: boolean): void {
  focused = !!v
  sync()
}

/** 系统休眠 / 锁屏切换（powerMonitor suspend/resume、lock-screen/unlock-screen） */
export function noteSuspended(v: boolean): void {
  suspended = !!v
  sync()
}

/** 立即结算并落盘（before-quit 用；进程结束前不能靠 debounce） */
export function flushAppUsageNow(): void {
  settle()
  if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null }
  flush()
}

/** 起心跳。幂等 —— 重复调用不会叠加定时器。 */
export function startAppUsageCollector(): void {
  if (tickTimer !== null) return
  tickTimer = setInterval(() => {
    // 结算并重开：把「崩溃最多丢一整个上午」压到「最多丢一个 TICK」
    if (activeSince !== null) {
      settle()
      if (shouldCount()) activeSince = Date.now()
    }
  }, TICK_MS)
  // 别让心跳拖住进程退出
  if (typeof tickTimer === 'object' && tickTimer && 'unref' in tickTimer) tickTimer.unref()
}


// ---------- 只读出口（供 IPC / 聚合层） ----------


/** `[fromKey, toKey]` 闭区间每天分钟数，缺失日补 0（热力图数据源） */
export function getUsageRange(fromKey: string, toKey: string): Record<string, number> {
  return rangeMinutes(load().days, fromKey, toKey)
}

/** 今天（本地日）的分钟数 */
export function getUsageTodayMinutes(): number {
  return minutesOn(load().days, dateKeyOf(Date.now()))
}
