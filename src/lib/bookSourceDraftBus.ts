/**
 * 书源草案总线（S5）—— 纯渲染层模块级单例，「事件广播 + 待消费暂存」双机制。
 *
 * 为什么需要暂存：主进程 `builtin.booksource.draft` 广播那一刻，书市模块**可能还没挂载**
 * （模块首访才挂载，挂在 App 的保活列表里）。App 收到广播后先把草案暂存在这里再切模块，
 * 模块挂载时消费暂存 —— 只靠 window 事件会漏（事件发在挂载之前）。
 * 同一手法见 `pluginCommandBus.ts` 的 `requestPluginViewActivation`。
 *
 * ★ 与那边唯一的差别：**这里不设 TTL**。那边怕「陈旧视图被激活」（5 秒），
 *   这里最坏结果只是用户看到一份草案、点取消即弃；反过来加 TTL 会在模块慢挂载
 *   （首次进入要拉书源列表）时把草案悄悄丢掉，那才是真的坏。
 *   草案本身不落盘、重启即失效（有意如此，见施工方案 §13.8）。
 */

import type { BookSourceDraft } from '../types'

/** 仅用于 dev 探针：把触发函数挂到 window（`import.meta.env.DEV` 下才挂，生产不挂） */
declare global {
  interface Window {
    __kbBookSourceDraft?: (draft: BookSourceDraft) => void
  }
}

let pendingDraft: BookSourceDraft | null = null

/** 模块内订阅「草案到达」用的事件名（与暂存双轨，覆盖「已挂载 / 未挂载」两种时序） */
export const SOURCE_DRAFT_EVENT = 'bookMarket:source-draft'

/**
 * 请求「切到书市 + 打开预填表单」：
 *  1. 暂存草案（模块晚于本调用挂载时由 `peekPendingSourceDraft` 取走）；
 *  2. 广播 `window` 事件（模块**已挂载**时立即响应，不必等下次挂载）。
 * 调用方（App.tsx）负责切模块与 toast —— 总线只管数据，不碰导航（免得两处都能切 Tab）。
 */
export function requestSourceDraftPrefill(draft: BookSourceDraft): void {
  pendingDraft = draft
  window.dispatchEvent(new CustomEvent(SOURCE_DRAFT_EVENT, { detail: draft }))
}

/** 书市模块消费用：取未消费的草案（**不移除**，匹配方处理完自行 clear） */
export function peekPendingSourceDraft(): BookSourceDraft | null {
  return pendingDraft
}

/** 表单已按草案打开（或用户明确弃用）后清除 */
export function clearPendingSourceDraft(): void {
  pendingDraft = null
}

/** 模块内订阅「草案到达」，返回退订函数 */
export function onSourceDraftPrefill(cb: (draft: BookSourceDraft) => void): () => void {
  const handler = (e: Event): void => cb((e as CustomEvent<BookSourceDraft>).detail)
  window.addEventListener(SOURCE_DRAFT_EVENT, handler)
  return () => window.removeEventListener(SOURCE_DRAFT_EVENT, handler)
}

// dev-only 钩子：探针要确定性地触发「草案到达」这一跳（真实触发出自主进程广播）。
// 先例见阅读器边缘翻页的 window.__kbEdgeDiag —— 生产构建下这段不执行，window 上不留口子。
if (import.meta.env.DEV) {
  window.__kbBookSourceDraft = (draft: BookSourceDraft) => requestSourceDraftPrefill(draft)
}
