/**
 * 当前阅读上下文（2026-11-24，AI 教学「对话」模式 · R 段）。
 *
 * 边界：**本模块只做发布与读取，不含任何 React / DOM 依赖**（SSR 安全）。
 * 发布方 = 阅读器（PDF 当前页 / EPUB 当前章节）；消费方（对话输入卡 / 主进程注入）
 * 自己在组件里用 `useSyncExternalStore(subscribeReadingContext, getReadingContext)` 读取。
 *
 * 为什么是模块级单例：阅读上下文属于「当前打开的那份资料」，不属于某个宿主。
 * 书架阅读态、AI 教学右查看器、笔记编辑器里打开的 PDF 附件都可能挂同一个阅读器组件；
 * 放在组件 state 里就取不到别处的当前页。运行期内存态，不落盘、不走 IPC。
 *
 * 口径（docs/ai-teaching-tutor-mode-plan.md §2.4 / §六-5）：
 * - `text` 在渲染层先截到 ≤ `READING_CONTEXT_LIMIT`（主进程再做一次同样的上限双保险）。
 * - 发布用浅比较去重：同 relPath + kind + page + label + text 不重复通知，
 *   避免阅读器每滚一屏就来一次整树重渲染。
 * - 一次只有一个「当前资料」；`null` = 清空（关闭文件 / 切走）。
 */

/** 单份阅读上下文（与 `src/types/index.ts` 的同构声明保持一致，**不互相 import**） */
export interface ReadingContext {
  relPath: string
  kind: 'pdf' | 'epub' | 'txt' | 'md'
  /** PDF 页码（1-based） */
  page?: number
  /** 章节 / 小节名（EPUB 用；拿不到就不传） */
  label?: string
  /** 已截断的正文 */
  text: string
}

/** 单次注入给模型的正文上限（字符数） */
export const READING_CONTEXT_LIMIT = 3000

/** 截断说明的生成口径：文案里的数字必须与实际 max 一致，不写死 3000 */
export function readingTruncatedNote(max: number): string {
  return `\n\n（只读了前 ${max} 字）`
}

/**
 * 纯函数：≤ max 原样返回；> max 截到 max 并追加说明。
 * 空串 / 非字符串一律回归空串（调用方据此判「本页没有可读文本」）。
 */
export function clampReadingText(text: string, max: number = READING_CONTEXT_LIMIT): string {
  const s = typeof text === 'string' ? text : ''
  if (s === '') return ''
  if (!Number.isFinite(max)) return s
  const limit = Math.floor(max)
  if (limit <= 0) return ''
  if (s.length <= limit) return s
  return s.slice(0, limit) + readingTruncatedNote(limit)
}

/** 这段文本是否已被 `clampReadingText` 截断（按说明标记判定，不靠长度猜） */
export function isReadingTextTruncated(text: string, max: number = READING_CONTEXT_LIMIT): boolean {
  const s = typeof text === 'string' ? text : ''
  if (!s || !Number.isFinite(max)) return false
  return s.endsWith(readingTruncatedNote(Math.floor(max)))
}

type Listener = () => void

let current: ReadingContext | null = null
const listeners = new Set<Listener>()

/** 快照必须身份稳定：`useSyncExternalStore` 用 Object.is 比对，内容不变就不该换对象 */
function normalize(ctx: ReadingContext): ReadingContext {
  const out: ReadingContext = { relPath: ctx.relPath, kind: ctx.kind, text: ctx.text }
  if (typeof ctx.page === 'number' && Number.isFinite(ctx.page)) out.page = ctx.page
  if (typeof ctx.label === 'string' && ctx.label !== '') out.label = ctx.label
  return out
}

function sameContext(a: ReadingContext | null, b: ReadingContext | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.relPath === b.relPath
    && a.kind === b.kind
    && a.page === b.page
    && a.label === b.label
    && a.text === b.text
}

function emit(): void {
  for (const fn of listeners) {
    try { fn() } catch { /* 单个订阅者异常不影响其它订阅者 */ }
  }
}

/** 发布当前资料；`null` = 清空（关闭文件 / 切走） */
export function publishReadingContext(ctx: ReadingContext | null): void {
  const next = ctx ? normalize(ctx) : null
  // 浅比较去重：阅读器每次滚动都会调这里，同内容绝不重复通知
  if (sameContext(current, next)) return
  current = next
  emit()
}

export function getReadingContext(): ReadingContext | null {
  return current
}

/** 订阅变更；返回的取消函数**幂等**（重复调用安全） */
export function subscribeReadingContext(fn: Listener): () => void {
  if (typeof fn !== 'function') return () => {}
  listeners.add(fn)
  let done = false
  return () => {
    if (done) return
    done = true
    listeners.delete(fn)
  }
}

/**
 * 只清「自己发布的那一份」：store 里已是别的资料时不动它。
 * 阅读器卸载 / 切换文件 / 本页提不出文本时都用它 —— 避免误清新打开的另一份资料。
 */
export function clearReadingContextOf(relPath: string): void {
  const cur = current
  if (cur && cur.relPath !== relPath) return
  publishReadingContext(null)
}
