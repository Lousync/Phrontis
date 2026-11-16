/**
 * 终端 AI 输出整形与续读（P1-3）**纯逻辑**。
 *
 * 解决的问题：一条命令的输出可能几百 KB，但模型一次只该拿 8000 字符。
 *  · `tailLines`：只取末尾 N 行（看日志/构建结果最常用）；
 *  · `filter`：按关键词过滤（不区分大小写；空格分隔的多个词要求**全部命中**，不做正则，避免回溯爆炸）；
 *  · `offset`：在整形后的视图里续读，`nextOffset` 即下一次的 offset。
 *
 * 零依赖独立文件：契约脚本 `verify-terminal-exec.mjs` 直接 import。
 */

export const AI_OUTPUT_CAP = 8_000
export const AI_OUTPUT_RAW_CAP = 400_000
export const MAX_TAIL_LINES = 2_000
export const MAX_FILTER_CHARS = 200

export interface OutputShape {
  /** 只看末尾 N 行；0 / 缺省 = 不裁 */
  tailLines?: number
  /** 关键词过滤（不区分大小写，空格分隔 = AND） */
  filter?: string
}

/** 过滤词归一：小写、按空白切分、去重 */
export function normalizeFilterTokens(raw: unknown): string[] {
  const s = String(raw ?? '').slice(0, MAX_FILTER_CHARS).trim().toLowerCase()
  if (!s) return []
  return [...new Set(s.split(/\s+/).filter(Boolean))]
}

export function clampTailLines(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(MAX_TAIL_LINES, Math.floor(n))
}

/**
 * 输出整形：先按关键词过滤（行级 AND），再取末尾 N 行。
 * 顺序固定：过滤 → 尾部，这样「最近 N 条匹配」才符合直觉。
 */
export function shapeAiOutput(text: string, opts: OutputShape = {}): string {
  const src = String(text ?? '').replace(/\r\n/g, '\n')
  const tokens = normalizeFilterTokens(opts.filter)
  const tail = clampTailLines(opts.tailLines)
  if (tokens.length === 0 && tail === 0) return src
  let lines = src.split('\n')
  if (tokens.length > 0) {
    lines = lines.filter((line) => {
      const low = line.toLowerCase()
      return tokens.every((t) => low.includes(t))
    })
  }
  if (tail > 0) lines = lines.slice(Math.max(0, lines.length - tail))
  return lines.join('\n')
}

export interface SlicedOutput {
  output: string
  truncated: boolean
  hasMore: boolean
  nextOffset: number
  totalChars: number
}

/** 在整形后的视图里从 offset 取一段（默认 8000 字符） */
export function sliceAiOutput(view: string, offset: unknown, cap = AI_OUTPUT_CAP): SlicedOutput {
  const text = String(view ?? '')
  const total = text.length
  const start = Math.max(0, Math.min(total, Math.floor(Number(offset) || 0)))
  const size = Math.max(1, Math.floor(cap) || AI_OUTPUT_CAP)
  const output = text.slice(start, start + size)
  const nextOffset = start + output.length
  return {
    output,
    truncated: total > output.length,
    hasMore: nextOffset < total,
    nextOffset,
    totalChars: total,
  }
}
