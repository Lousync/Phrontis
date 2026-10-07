/**
 * 插件事件总线（plugin-phase1-design C4）——主进程侧订阅注册表 + 宿主事件广播。
 *
 * 流向：宿主模块写动作 → emitPluginEvent → 查订阅者 → 每个窗口 webContents.send
 * ('plugin:event', {pluginId, event, payload}) → 渲染层 CodePluginHosts 经
 * pluginCommandBus 推给常驻 Worker（action:'event'）。
 *
 * 权限（ADR-2）：事件映射到现有模块 capability（knowledge → 'knowledge'，blog/schedule → 'data'），
 * 订阅时逐事件校验（kb.events.subscribe 在 Gateway 表内），未授权逐项报 EPERM。
 * 仅 code 插件可订阅（ADR-3，Gateway 侧查清单类型）。
 * 背压：无 ACK 通道，用轻量限流代替——每插件 10 秒窗口 ≤64 条，超出丢弃计数，
 * 窗口重置后随下一条送达 {dropped}（防 runaway 插件刷爆渲染层）。
 */
import { broadcast, BROADCAST_CHANNEL } from '../main/windowBus'

export const KNOWN_PLUGIN_EVENTS: Record<string, { capability: string }> = {
  'knowledge:pageSaved': { capability: 'knowledge' },
  'knowledge:pageDeleted': { capability: 'knowledge' },
  'blog:postSaved': { capability: 'data' },
  'schedule:todoCompleted': { capability: 'data' },
}

/** pluginId → 订阅的事件集合 */
const subscriptions = new Map<string, Set<string>>()

const RATE_WINDOW_MS = 10_000
const RATE_MAX = 64
const rate = new Map<string, { windowStart: number; sent: number; dropped: number }>()

export interface SubscribeResult {
  subscribed: string[]
  denied: Array<{ event: string; reason: string }>
}

/** Gateway kb.events.subscribe 落地：逐事件做白名单 + capability 校验（未知/未授权都不中断其余） */
export function subscribePluginEvents(pluginId: string, events: string[], capabilities: string[]): SubscribeResult {
  const subscribed: string[] = []
  const denied: SubscribeResult['denied'] = []
  for (const ev of events.slice(0, 16)) {
    const def = KNOWN_PLUGIN_EVENTS[ev]
    if (!def) {
      denied.push({ event: ev, reason: '未知事件' })
      continue
    }
    if (!capabilities.includes(def.capability)) {
      denied.push({ event: ev, reason: `需要能力 ${def.capability}` })
      continue
    }
    subscribed.push(ev)
  }
  if (subscribed.length > 0) {
    const set = subscriptions.get(pluginId) ?? new Set<string>()
    for (const ev of subscribed) set.add(ev)
    subscriptions.set(pluginId, set)
  }
  return { subscribed, denied }
}

/** 取消订阅（events 缺省 = 全部） */
export function unsubscribePluginEvents(pluginId: string, events?: string[]): void {
  if (!events || events.length === 0) {
    subscriptions.delete(pluginId)
    return
  }
  const set = subscriptions.get(pluginId)
  if (!set) return
  for (const ev of events) set.delete(ev)
  if (set.size === 0) subscriptions.delete(pluginId)
}

/** 会话关闭/插件禁用卸载时全清（Gateway onSessionClosed 钩子） */
export function unsubscribeAllPluginEvents(pluginId: string): void {
  subscriptions.delete(pluginId)
  rate.delete(pluginId)
}

/** 宿主模块写动作发射；只投给已订阅且未超限的插件（fire-and-forget，不积压不补发） */
export function emitPluginEvent(event: string, payload: unknown): void {
  if (!KNOWN_PLUGIN_EVENTS[event]) return
  for (const [pluginId, evs] of subscriptions) {
    if (!evs.has(event)) continue
    const now = Date.now()
    let r = rate.get(pluginId)
    if (!r || now - r.windowStart >= RATE_WINDOW_MS) {
      r = { windowStart: now, sent: 0, dropped: 0 }
      rate.set(pluginId, r)
    }
    if (r.sent >= RATE_MAX) {
      r.dropped++
      continue
    }
    r.sent++
    const dropped = r.dropped
    r.dropped = 0
    deliver(pluginId, event, payload, dropped)
  }
}

function deliver(pluginId: string, event: string, payload: unknown, dropped: number): void {
  const msg = { pluginId, event, payload, ...(dropped > 0 ? { dropped } : {}) }
  broadcast(BROADCAST_CHANNEL.pluginEvent, msg)
}
