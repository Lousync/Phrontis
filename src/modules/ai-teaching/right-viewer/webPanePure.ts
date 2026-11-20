/**
 * AI 教学右侧查看器 · 网页页签纯函数层
 *
 * 为什么要单独一层：URL 归一 / 页签槽位 / 关闭后的邻位选中 / bounds 判定这几段
 * 都会被契约脚本直接跑（`.AGENT/scripts/ai-teaching/verify-web-pane-renderer.mjs`）。
 * 混进组件就只能靠 grep 静态断言，逻辑错了反而测不出来。
 *
 * 本文件零运行时依赖（连 React / ipc 都不 import），可被脚本 strip 类型后直接执行。
 */

export interface WebTabRef {
  /** 主进程 WebContentsView 的 id，固定 w1..w3（最多 3 个） */
  id: string
  /** 空串 = 起始页，此时不调用主进程 */
  url: string
  title?: string
  /**
   * 恢复出来的页签未加载（C6：恢复结构但不预加载）。
   * 只有用户切到该页签 / 点「加载这个页签」时才真正 create。
   */
  dormant?: boolean
}

/** 固定槽位：主进程按 id 保活一个 view，id 必须稳定可预测 */
const TAB_IDS = ['w1', 'w2', 'w3'] as const

/**
 * 地址归一。
 *
 * 规则（C4：网页视图只认 http/https）：
 *   1. 无协议 → 补 `https://`；
 *   2. 显式协议只放行 http/https，`file:` / `javascript:` / `data:` / `about:` /
 *      `mailto:` 一律返回 null —— 主进程那边再有校验也不冲突，这里是第一道闸；
 *   3. `host:port` 会被误认成协议（`localhost:3000`），先按端口形态救回来。
 */
export function normalizeUrl(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  // 换行 / 制表符多半是从文档里粘出来的脏串，别猜意图
  if (/[\r\n\t]/.test(s)) return null

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s)
  if (scheme) {
    const proto = scheme[1].toLowerCase()
    if (proto !== 'http' && proto !== 'https') {
      // `localhost:3000` / `example.com:8080/x`：冒号后是纯端口，说明是主机名不是协议
      const looksLikeHostPort = /^[a-zA-Z][a-zA-Z0-9+.-]*:\d+([/?#]|$)/.test(s)
      if (!looksLikeHostPort) return null
    }
  }

  let candidate = s
  if (/^\/\//.test(candidate)) candidate = `https:${candidate}`
  else if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`

  try {
    const u = new URL(candidate)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!u.hostname) return null
    return u.href
  } catch {
    return null
  }
}

/** 取 hostname；解析不了就原样返回（页签文案 / 地址栏都要用到） */
export function hostOf(url: string): string {
  if (!url) return ''
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** 页签文案：站点标题优先，其次域名，最后兜底 */
export function tabCaption(t: WebTabRef): string {
  const title = (t.title ?? '').trim()
  if (title) return title
  const host = hostOf(t.url).trim()
  if (host) return host
  return '新标签页'
}

/** 第一个空槽位；满了返回 null（调用方据此 Toast「最多 3 个网页页签」） */
export function nextTabId(tabs: WebTabRef[]): string | null {
  const used = new Set(tabs.map((t) => t.id))
  for (const id of TAB_IDS) {
    if (!used.has(id)) return id
  }
  return null
}

/**
 * 关闭某个页签后的「新列表 + 新选中位」。
 *
 * 浏览器惯例：
 *   · 关前面的 → 选中位左移一格，视觉上仍停在原来那页；
 *   · 关当前的 → 优先选右邻，没有右邻就退到左邻；
 *   · 关最后一个 → 变空态（页签条只剩「＋」），不是留一个空白页签。
 * 索引越界当无事发生，返回原引用（调用方可以据此判断有没有变化）。
 */
export function closeTabAt(
  tabs: WebTabRef[],
  activeIndex: number,
  closeIndex: number,
): { tabs: WebTabRef[]; activeIndex: number } {
  const len = tabs.length
  if (closeIndex < 0 || closeIndex >= len) {
    return { tabs, activeIndex: clampIndex(activeIndex, len) }
  }
  const next = tabs.filter((_, i) => i !== closeIndex)
  if (next.length === 0) return { tabs: next, activeIndex: 0 }

  let ai = activeIndex
  if (closeIndex < ai) ai -= 1
  else if (closeIndex === ai) ai = Math.min(closeIndex, next.length - 1)
  return { tabs: next, activeIndex: clampIndex(ai, next.length) }
}

/**
 * 占位区几何 → 主进程 bounds。
 *
 * 单位是 CSS px：UI 缩放由主进程乘 `getEffectiveUiZoom`，这里再乘会双重缩放。
 * 宽高 ≤ 0（面板收起 / 页签隐藏 display:none）返回 null —— 这不是「0 像素的视图」，
 * 而是「现在没有可显示的区域」，调用方必须 hide 而不是 setBounds(0)。
 * 取整是因为原生 setBounds 收的是整数 DIP；四舍五入的半像素缝由主进程夹取。
 */
export function boundsPayload(rect: {
  left: number
  top: number
  width: number
  height: number
}): { x: number; y: number; width: number; height: number } | null {
  if (!rect) return null
  const { left, top, width, height } = rect
  const nums = [left, top, width, height]
  for (const n of nums) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return null
  }
  if (width <= 0 || height <= 0) return null
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  }
}

/**
 * 原生视图该不该露出来。
 *
 * 原生视图永远盖在 DOM 上，所以这是「白块」的唯一闸门：只要有一条不满足就 hide。
 * 失败态同样 hide —— 否则错误卡片会被一块白屏盖住（§8 层级硬约束）。
 */
export function shouldShowView(input: {
  active: boolean
  open: boolean
  url: string
  error?: string
}): boolean {
  return !!(input.active && input.open && input.url && !input.error)
}

/**
 * 从 localStorage 恢复页签。
 *
 * C6：恢复 URL / 标题，但**不预加载** → 全部标 dormant，等用户切过去再 create。
 * 容错是必须的：旧版本可能存过 `file:` 或被手改成坏 JSON；
 * 任何一条不合格就丢那一条，绝不让整组恢复失败。
 */
export function restoreTabs(raw: string | null): WebTabRef[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: WebTabRef[] = []
  for (const item of parsed) {
    if (out.length >= TAB_IDS.length) break
    if (!item || typeof item !== 'object') continue
    const rec = item as { id?: unknown; url?: unknown; title?: unknown }
    if (typeof rec.url !== 'string') continue
    const url = normalizeUrl(rec.url)
    if (!url) continue

    const wanted =
      typeof rec.id === 'string' && /^w[1-3]$/.test(rec.id) && !out.some((t) => t.id === rec.id)
        ? rec.id
        : null
    const id = wanted ?? nextTabId(out)
    if (!id) break

    const title = typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim() : undefined
    out.push({ id, url, title, dormant: true })
  }
  return out
}

function clampIndex(index: number, len: number): number {
  if (!Number.isFinite(index) || len <= 0) return 0
  const i = Math.floor(index)
  if (i < 0) return 0
  return i >= len ? len - 1 : i
}
