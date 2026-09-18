/**
 * 会话压缩核心（纯函数，node 冒烟可跑）—— docs/conversation-compaction-design.md
 *
 * 与 agentContextBudget（轮级裁剪兜底）的关系：压缩把「检查点及以前」的旧轮折叠成
 * 一份持久化纪要（存会话索引），裁剪只在压缩失败/关闭时兜底。本模块只做无副作用
 * 的切分 / 分片 / 提示词装配 / 上下文合成；LLM 调用与落盘在 agentCompress.ts。
 */

import type { BudgetMessage } from './agentContextBudget'

/** 自动压缩默认触发线（历史预算的百分比；设置 agentCompressAtPercent 缺省/异常时回退此值） */
export const COMPRESS_AT_PERCENT_DEFAULT = 80

/**
 * 自动压缩触发 token 数 = 预算 × percent/100。percent 夹在 50-100
 * （过低会频繁触发压缩调用烧钱，过高失去提前量），异常值回退默认 80。
 */
export function compressAtTokens(budgetTokens: number, percent: number | null | undefined): number {
  const n = Number(percent)
  const p = Number.isFinite(n) && n > 0 ? Math.floor(n) : COMPRESS_AT_PERCENT_DEFAULT
  const clamped = Math.min(100, Math.max(50, p))
  return Math.floor(budgetTokens * (clamped / 100))
}
/** 压缩时保留尾段轮数（含当前用户消息所在的轮，永不入纪要） */
export const KEEP_RECENT_TURNS = 2
/** 单次触发的最大压缩分片数（防首次巨会话一次性烧掉过多延迟/费用，剩余下次续压） */
export const MAX_SLICES = 3
/** 单片输入字符上限（旧纪要 + 片段拼进一次 LLM 调用的量级控制） */
export const COMPRESS_INPUT_CHAR_CAP = 60000
/** 纪要正文字符上限（≈1.5k token，装配固定成本可控） */
export const MAX_DIGEST_CHARS = 4000
/** 单条消息进纪要输入的截断长度（超长原文模型仍可用 vault 工具重读） */
export const PER_MESSAGE_CHAR_CAP = 4000
/** 纪要注入首条 user 消息的标记前缀（不进 system——保 prompt cache 前缀逐字稳定） */
export const DIGEST_PREFIX = '【此前对话纪要】\n'

export interface CompressionRow {
  id: string
  role: 'user' | 'assistant'
  content: string
}

/** 对 digest 的只读引用（结构与 agentSessionRepo.SessionDigest 对齐，避免反向依赖） */
export interface DigestRef {
  text: string
  upto_id: string
  covered: number
}

/**
 * 检查点之后的消息。返回 null = 检查点在消息列表中已不存在（被删且一致性作废未及）
 * → 调用方应把 digest 当作不存在按全量处理。
 */
export function rowsAfterDigest<T extends { id: string }>(rows: T[], uptoId: string): T[] | null {
  if (!uptoId) return null
  const idx = rows.findIndex((r) => r.id === uptoId)
  if (idx === -1) return null
  return rows.slice(idx + 1)
}

/** 轮切分（与 trimHistoryByBudget 同口径：user 消息开新轮，其余归入当前轮） */
function splitTurns(rows: CompressionRow[]): CompressionRow[][] {
  const turns: CompressionRow[][] = []
  for (const r of rows) {
    if (r.role === 'user' || turns.length === 0) turns.push([r])
    else turns[turns.length - 1].push(r)
  }
  return turns
}

export interface SplitResult {
  /** 可压缩段（最老在前）：未覆盖段去掉保留尾段 */
  compressible: CompressionRow[]
  /** 保留尾段的轮数（1 = 只有当前轮可保） */
  tailTurns: number
}

/**
 * 压缩切分：digest 检查点之后的「未覆盖段」里，保留最后 KEEP_RECENT_TURNS 轮为尾段，
 * 其余为可压段。digestUptoId 传 null = 无 digest（全量切分）；
 * 检查点失效时按全量处理（旧纪要文本仍会折入提示词，信息不丢）。
 */
export function splitForCompression(rows: CompressionRow[], digestUptoId: string | null): SplitResult {
  if (rows.length === 0) return { compressible: [], tailTurns: 0 }
  const base = digestUptoId ? (rowsAfterDigest(rows, digestUptoId) ?? rows) : rows
  const turns = splitTurns(base)
  const tailTurns = Math.min(KEEP_RECENT_TURNS, turns.length)
  const headTurns = turns.slice(0, turns.length - tailTurns)
  return { compressible: headTurns.flat(), tailTurns }
}

/** 把可压段按输入上限分片（最老在前；单条先按 PER_MESSAGE_CHAR_CAP 截断，故单片必有界） */
export function partitionSlices(
  rows: CompressionRow[],
  totalCap = COMPRESS_INPUT_CHAR_CAP,
  perMsgCap = PER_MESSAGE_CHAR_CAP,
): CompressionRow[][] {
  const slices: CompressionRow[][] = []
  let cur: CompressionRow[] = []
  let used = 0
  for (const r of rows) {
    const cost = Math.min(r.content.length, perMsgCap) + 24
    if (cur.length > 0 && used + cost > totalCap) {
      slices.push(cur)
      cur = []
      used = 0
    }
    cur.push(r)
    used += cost
  }
  if (cur.length > 0) slices.push(cur)
  return slices
}

/** 纪要生成 system（固定串；与对话主循环的 system 互不影响各自缓存） */
export const DIGEST_SYSTEM_PROMPT = [
  '你是会议纪要员。把「旧纪要 + 新对话片段」合并为一份新的对话纪要，供 AI 助手在后续对话中替代被压缩的原始记录使用。要求：',
  '- 只保留对后续有用的事实：用户目标、已确认的决策与结论、关键数字/名称/路径/日期、涉及的文件与页面、用户表达的偏好、未完成事项',
  '- 保留具体细节（数字、id、标题、路径），不写「讨论了若干问题」这类空话',
  '- 用户纠正过的结论必须体现最终版本',
  '- 分节输出：## 用户目标 / ## 已确认结论 / ## 关键事实 / ## 涉及文件 / ## 未完成事项（无内容的节省略）',
  '- 直接输出纪要正文，不要任何解释',
].join('\n')

/** 单次压缩调用的提示词装配：旧纪要（如有）+ 本片逐条对话（超长单条截断并标注） */
export function buildDigestPrompt(oldText: string | null, slice: CompressionRow[]): { system: string; user: string } {
  const lines = slice.map((r) => {
    const c = String(r.content ?? '')
    return `[${r.role}] ${c.length > PER_MESSAGE_CHAR_CAP ? c.slice(0, PER_MESSAGE_CHAR_CAP) + '…（该条过长已截断）' : c}`
  })
  const parts: string[] = []
  if (oldText) parts.push(`【旧纪要】\n${oldText}`)
  parts.push(`【对话片段】\n${lines.join('\n')}`)
  return { system: DIGEST_SYSTEM_PROMPT, user: parts.join('\n\n') }
}

/** 纪要输出校验：空串拒绝；超长截断并标注 */
export function normalizeDigestOutput(text: string): string {
  const t = String(text ?? '').trim()
  if (!t) return ''
  return t.length > MAX_DIGEST_CHARS ? t.slice(0, MAX_DIGEST_CHARS) + '\n…（纪要过长已截断）' : t
}

/**
 * 上下文合成：纪要以**首条 user 消息**注入（system+tools 是 prompt cache 前缀，
 * 必须逐字稳定——纪要只在压缩时变化，变化时前缀重建是一次性成本）。
 *
 * `extraPrefix`（v3.4.0 批次 B2 新增）：**每轮变化的上下文注入段**（@ 引用骨架 / 感知素材）。
 * 它们与纪要同层注入首条 user 消息，而**不进 system** —— 理由：
 *  - system + tools 是 prompt cache 前缀，逐字稳定才能命中（core 14 工具 ≈7.7k tok/轮）；
 *  - B1 初版把骨架塞进 `buildSystemPrompt`（= system），引用一变 system 就变 →
 *    **缓存前缀全量失效**，每轮多付整段 system + tools 的钱。B2 一并纠正。
 *  - 注入首条 user 消息也更符合语义：素材只对**本轮**有效，不该沉淀成系统的长期人设。
 *
 * 顺序：`extraPrefix` 在纪要**之后**（纪要是历史、注入段是当下，越靠近当前用户消息
 * 越贴合注意力；且纪要变化频率更低，放前面更利于其内部缓存）。
 */
export function composeContextWithDigest<T extends BudgetMessage>(
  digestText: string | null | undefined,
  history: T[],
  extraPrefix?: string | null,
): Array<T | { role: 'user'; content: string }> {
  const head: Array<{ role: 'user'; content: string }> = []
  if (digestText) head.push({ role: 'user' as const, content: DIGEST_PREFIX + digestText })
  if (extraPrefix) head.push({ role: 'user' as const, content: extraPrefix })
  if (head.length === 0) return [...history]
  return [...head, ...history]
}
