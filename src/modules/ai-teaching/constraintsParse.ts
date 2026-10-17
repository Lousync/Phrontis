/**
 * AI教学「要求」文档（CONSTRAINTS.md）条目化纯函数。
 *
 * 为什么单独一个零 import 文件（口径同 `flow/flowLayout.ts`）：契约脚本
 * `.AGENT/scripts/ai-teaching/verify-constraints-parse.mjs` 要 strip 类型之后**直接 import 真实实现**
 * 跑往返用例，所以这里**不许 import 任何东西**，类型一律内联。
 *
 * 口径（方案 `ai-teaching-flow-v2-impl.md` §三-1 / D1，2026-10-17 拍板）：
 *   · 条目 = 顶格 `- ` 开头的一行；右栏「要求」页签只编辑这些行。
 *   · **非条目行（说明文字 / 标题 / 空行）原文只读** —— 不解析、不重写、不做「软停用」。
 *     这是关键：CONSTRAINTS.md 是人手写的，AI 也往里面补，任何「整篇重新格式化」都会
 *     静默吃掉用户写的段落。故编辑操作一律是**行级就地增删改**，其余行逐字保留。
 */

/** 一个条目行：`text` 去掉 `- ` 与首尾空白后的内容；`line` 是它在原文里的 0 基行号 */
export interface ConstraintItem {
  text: string
  line: number
}

/** 条目级编辑：索引指的是 `parseConstraintItems()` 返回数组里的下标（每次编辑前重新解析） */
export type ConstraintEdit =
  | { op: 'add'; text: string }
  | { op: 'update'; index: number; text: string }
  | { op: 'remove'; index: number }

/** 条目行判据：允许前置缩进（用户可能写在列表里），但只认 `-` 这一种记号 */
const ITEM_RE = /^(\s*)-\s+(.*\S)\s*$/

/** 拆行但记住末尾是否带换行 —— 往返不许凭空多/少一个 \n */
function splitLines(text: string): { lines: string[]; trailing: boolean } {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n')
  if (normalized === '') return { lines: [], trailing: false }
  const trailing = normalized.endsWith('\n')
  const body = trailing ? normalized.slice(0, -1) : normalized
  return { lines: body.split('\n'), trailing }
}

function joinLines(lines: readonly string[], trailing: boolean): string {
  if (!lines.length) return ''
  return lines.join('\n') + (trailing ? '\n' : '')
}

/** 抽出全部条目行（按原文顺序）；非条目行不进结果，也不会被这里丢掉（本函数不返回原文） */
export function parseConstraintItems(text: string): ConstraintItem[] {
  const { lines } = splitLines(text)
  const out: ConstraintItem[] = []
  lines.forEach((ln, i) => {
    const m = ITEM_RE.exec(ln)
    if (m) out.push({ text: m[2].trim(), line: i })
  })
  return out
}

/**
 * 把一组条目文本序列化成 markdown 条目块（`- ` 每行一条）。
 *
 * 只用于「新建一层」时落骨架 —— 已有文档一律走 `applyConstraintEdits`，别拿本函数整篇重写。
 */
export function serializeConstraintItems(items: readonly string[]): string {
  const clean = items.map((s) => String(s ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean)
  if (!clean.length) return ''
  return clean.map((s) => `- ${s}`).join('\n') + '\n'
}

/**
 * 在原文里就地增 / 改 / 删条目行；**非条目行逐字保留**（含空行、标题、说明段）。
 *
 * 索引语义：`index` 指 `parseConstraintItems(text)` 的下标。多条编辑按数组顺序应用，
 * 每条都在**上一条的结果**上重新解析 —— 所以调用方传的 index 必须是「逐步应用后的当下下标」。
 * 越界的 index 直接跳过（不抛错、不改文档）：界面上删一条已被 AI 改掉的条目不该炸。
 *
 * `add` 的落点：插在最后一条条目行之后；全篇没有条目时追加到文末（补一个换行）。
 */
export function applyConstraintEdits(text: string, edits: readonly ConstraintEdit[]): string {
  let cur = String(text ?? '')
  for (const e of edits) {
    const { lines, trailing } = splitLines(cur)
    const items = parseConstraintItems(cur)
    if (e.op === 'add') {
      const clean = String(e.text ?? '').replace(/\s+/g, ' ').trim()
      if (!clean) continue
      const last = items.length ? items[items.length - 1].line : -1
      if (last >= 0) lines.splice(last + 1, 0, `- ${clean}`)
      else lines.push(`- ${clean}`)
      cur = joinLines(lines, trailing || last < 0)
      continue
    }
    const hit = items[e.index]
    if (!hit) {
      // 保底：索引越界但文本没变 → 原样返回，调用方不会白写盘
      cur = joinLines(lines, trailing)
      continue
    }
    if (e.op === 'remove') {
      lines.splice(hit.line, 1)
      cur = joinLines(lines, trailing)
      continue
    }
    const clean = String(e.text ?? '').replace(/\s+/g, ' ').trim()
    if (!clean) {
      lines.splice(hit.line, 1)
      cur = joinLines(lines, trailing)
      continue
    }
    const indent = (ITEM_RE.exec(lines[hit.line])?.[1] ?? '').replace(/\s+$/, '')
    lines[hit.line] = `${indent}- ${clean}`
    cur = joinLines(lines, trailing)
  }
  return cur
}
