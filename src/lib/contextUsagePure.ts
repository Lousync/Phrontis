/**
 * AI 教学 · 上下文用量明细 **渲染层纯函数**（零运行时依赖，`.mjs` 契约脚本可 strip 后直接 import）。
 *
 * ★ 与 `electron/lib/aiTeachContextUsagePure.ts` **必须逐字同口径** ★
 *   改这里的 `CHARS_PER_TOKEN` / `CONTEXT_USAGE_CATEGORIES` 顺序与标签 / `scaleTokensToBudget` /
 *   `buildContextUsage`，必须同步另一处，并重跑 `.AGENT/scripts/ai-teaching/verify-context-usage.mjs`
 *   （该脚本第 8 节直接 import 两份实现，逐行比对输出，任何单边改动都会 FAIL）。
 *
 * 为什么渲染层要另存一份：`src/` 不能 import `electron/lib/*`（主进程 / preload 边界），
 * 而明细面板需要「不经过 IPC 就随本次渲染即时重算」的能力。两份实现的输入/输出完全一致，
 * 只是主进程那份多带 `buildInjectionStats`（聚合侧，渲染层用不到）。
 *
 * ── 口径（与主进程逐条一致）──
 * 1. `CHARS_PER_TOKEN = 2.6` 是展示用近似值，不是 tokenizer；
 * 2. 9 个分类是**互斥分区**，其 token 和若超过真实 `usedTokens`（promptTokens）就等比收敛到 used；
 * 3. `freeTokens = max(0, window - used)`；百分比恒夹取 0..100 —— 任何输入都不出负数 / NaN。
 */

import type { AiTeachInjectionStats } from '../types'

/** 字符 → token 展示口径（与 `electron/lib/aiTeachContextUsagePure.ts` 同值） */
export const CHARS_PER_TOKEN = 2.6

/** 明细行 key（顺序即示意图自上而下的顺序） */
export type ContextUsageKey =
  | 'messages'
  | 'toolsDef'
  | 'toolsList'
  | 'skills'
  | 'system'
  | 'sources'
  | 'workspace'
  | 'ledger'
  | 'capability'

export interface ContextUsageCategory {
  key: ContextUsageKey
  label: string
  field: keyof AiTeachInjectionStats
}

/** 9 个内容分类（「剩余空间」由 buildContextUsage 单独给出，不属于字符字段） */
export const CONTEXT_USAGE_CATEGORIES: ContextUsageCategory[] = [
  { key: 'messages', label: '对话消息', field: 'messagesChars' },
  { key: 'toolsDef', label: '内置工具定义', field: 'toolsDefChars' },
  { key: 'toolsList', label: '工具装载提示', field: 'toolsListChars' },
  { key: 'skills', label: '技能', field: 'skillChars' },
  { key: 'system', label: '系统提示词', field: 'systemChars' },
  { key: 'sources', label: '来源', field: 'sourcesChars' },
  { key: 'workspace', label: '工作区', field: 'workspaceChars' },
  { key: 'ledger', label: '学习画像与课程', field: 'ledgerChars' },
  { key: 'capability', label: '教学协议', field: 'capabilityChars' },
]

/** 数字兜底：非有限数 / 负数 → 0（纯函数不抛错，界面不会因缺字段崩） */
function toCount(n: unknown): number {
  const v = Number(n)
  return Number.isFinite(v) && v > 0 ? v : 0
}

/** 字符 → token（展示用近似；<=0 / 非数 → 0） */
export function estimateTokensFromChars(chars: number): number {
  const n = toCount(chars)
  return n > 0 ? Math.round(n / CHARS_PER_TOKEN) : 0
}

export interface ContextUsageOptions {
  /** 模型上下文窗口（tokens）；<=0 / 未设 = 不算百分比（与设置 `ctxWindow` 一致） */
  windowTokens?: number
  /** 最近一次调用的真实输入 tokens（promptTokens）；<=0 时退回分类估算和 */
  usedTokens?: number
}

export interface ContextUsageRow extends ContextUsageCategory {
  chars: number
  tokens: number
  /** 占上下文窗口百分比（0..100；未设窗口恒 0） */
  pct: number
}

export interface ContextUsageView {
  windowTokens: number
  /** 权威「已用」：优先 promptTokens；没有时取分类估算和 */
  usedTokens: number
  usedPct: number
  /** 分类行 token 之和（收敛后恒 <= usedTokens） */
  classifiedTokens: number
  /** 已用但没被任何分类覆盖的 token（用于「其他」兜底行；恒 >= 0） */
  unclassifiedTokens: number
  /** 剩余空间 = max(0, window - used)；未设窗口恒 0 */
  freeTokens: number
  freePct: number
  rows: ContextUsageRow[]
}

/**
 * 等比收敛：估算和超预算时按比例压到预算内（floor + 余数从大到小补 1）。
 * 只减不增；预算 <=0 全 0；返回数组长度与输入一致。
 */
export function scaleTokensToBudget(values: number[], budget: number): number[] {
  const safe = Array.isArray(values) ? values.map(toCount) : []
  const sum = safe.reduce((a, b) => a + b, 0)
  const cap = toCount(budget)
  if (sum <= cap) return safe
  if (cap <= 0) return safe.map(() => 0)
  const out = safe.map((v) => Math.floor((v * cap) / sum))
  let rest = cap - out.reduce((a, b) => a + b, 0)
  const order = safe
    .map((v, i) => ({ i, v, raw: (v * cap) / sum }))
    .filter((x) => out[x.i] < x.v)
    .sort((a, b) => (b.raw - Math.floor(b.raw)) - (a.raw - Math.floor(a.raw)) || a.i - b.i)
  for (let k = 0; k < order.length && rest > 0; k++) {
    out[order[k].i] += 1
    rest -= 1
  }
  return out
}

/**
 * 分类行 + 百分比 + 剩余空间（与主进程同签名、同输出）。
 *
 * - 估算和 > 真实 used 时**等比收敛**（ASCII 工具 schema 的 chars/token 比中文高，
 *   直接除会假装比真实占得还多）；收敛后 `classifiedTokens <= usedTokens` 恒成立。
 * - `freeTokens = max(0, window - used)`；窗口未设 / used 超窗 / 空 stats 都不出负数。
 */
export function buildContextUsage(
  stats: AiTeachInjectionStats | null | undefined,
  opts?: ContextUsageOptions,
): ContextUsageView {
  const windowTokens = toCount(opts?.windowTokens)
  const rows: ContextUsageRow[] = CONTEXT_USAGE_CATEGORIES.map((c) => {
    const chars = toCount(stats ? stats[c.field] : 0)
    return { ...c, chars, tokens: estimateTokensFromChars(chars), pct: 0 }
  })
  const rawUsed = toCount(opts?.usedTokens)
  let estimated = rows.reduce((a, r) => a + r.tokens, 0)
  let usedTokens = rawUsed > 0 ? rawUsed : estimated
  if (estimated > usedTokens) {
    const scaled = scaleTokensToBudget(rows.map((r) => r.tokens), usedTokens)
    for (let i = 0; i < rows.length; i++) rows[i].tokens = toCount(scaled[i])
    estimated = rows.reduce((a, r) => a + r.tokens, 0)
  }
  for (const row of rows) {
    row.pct = windowTokens > 0 ? Math.min(100, Math.max(0, Math.round((row.tokens / windowTokens) * 100))) : 0
  }
  const freeTokens = windowTokens > 0 ? Math.max(0, windowTokens - usedTokens) : 0
  return {
    windowTokens,
    usedTokens,
    usedPct: windowTokens > 0 ? Math.min(100, Math.max(0, Math.round((usedTokens / windowTokens) * 100))) : 0,
    classifiedTokens: estimated,
    unclassifiedTokens: Math.max(0, usedTokens - estimated),
    freeTokens,
    freePct: windowTokens > 0 ? Math.min(100, Math.max(0, Math.round((freeTokens / windowTokens) * 100))) : 0,
    rows,
  }
}

/* ------------------------------------------------------------------ *
 * 展示格式化（渲染层专用；主进程无对应实现，不参与双端一致性断言）
 * ------------------------------------------------------------------ */

/**
 * token 数的紧凑写法：`429` / `1.3k` / `12.9k` / `987.1k` / `1M`。
 * 比 `UsageRing.fmtTok` 多两件事：① 万级也保留一位小数（明细表要能看出 12.9k 与 13k 的差）；
 * ② 百万级缩成 M（否则 1M 窗口会显示成 `1000k`）。
 */
export function formatContextTokens(n: number): string {
  const v = toCount(n)
  if (v >= 1_000_000) {
    const m = v / 1_000_000
    return `${m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, '')}M`
  }
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(Math.round(v))
}

/**
 * 百分比文案：未设窗口 → `''`（整列不渲染）；0 → `0%`；不足 1% → `<1%`；其余取整。
 * 直接吃原始比值（不能用 view.pct，它已经 Math.round，0.04% 会被抹成 0）。
 */
export function formatContextPct(tokens: number, windowTokens: number): string {
  const win = toCount(windowTokens)
  if (win <= 0) return ''
  const t = toCount(tokens)
  if (t <= 0) return '0%'
  const raw = (t / win) * 100
  return raw < 1 ? '<1%' : `${Math.round(raw)}%`
}

/**
 * 圆环指示旁的百分比（`UsageRing` 用）：直接吃 0..1 的占用比，不经过 token 换算。
 * 0 → `0%`；不足 1% → `<1%`；10% 以下保留一位小数（`1%` / `1.3%`）；其余取整。
 * 与 `formatContextPct` 的差别只在输入形态与小数档：环旁要的是「精确到一位」的短标签。
 */
export function formatContextShare(share: number): string {
  const raw = Number.isFinite(share) ? Math.max(0, Math.min(1, share)) * 100 : 0
  if (raw <= 0) return '0%'
  if (raw < 1) return '<1%'
  if (raw < 10) return `${raw.toFixed(1).replace(/\.0$/, '')}%`
  return `${Math.round(raw)}%`
}

/**
 * 顶部大号数字旁的比例：**保留一位小数**（示意图口径 `（1.3%）`；极小值给 `<0.1%`）。
 * 行内/剩余空间仍用 `formatContextPct`（`<1%` / 取整）—— 行要的是「大概多少」，头部要的是「精确到哪」。
 */
export function formatContextPctDetailed(tokens: number, windowTokens: number): string {
  const win = toCount(windowTokens)
  if (win <= 0) return ''
  const t = toCount(tokens)
  if (t <= 0) return '0%'
  const raw = (t / win) * 100
  return raw < 0.1 ? '<0.1%' : `${raw.toFixed(1)}%`
}
