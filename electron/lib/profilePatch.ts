/**
 * 画像「变化条目」的合并写入判定 —— **纯函数 / 零 import / 不 touch fs**。
 *
 * 为什么单独一个文件（口径同 `src/modules/editor/tabPolicy.ts`、`src/modules/ai-teaching/prepPolicy.ts`）：
 * 契约脚本要能 `stripTypeScriptTypes` 之后**直接 import 真实实现执行**。
 * 若把判定写在 `aiTeachingProfile.ts` 里，脚本就只能照抄一份算法 ——
 * 而「切段切错 / 去重判错 / mergeOnly 漏放行」这类缺陷恰恰会被照抄的算法掩盖。
 * 所以本文件必须保持零依赖（连 node 内建都不引），否则脚本装不进来。
 *
 * 形状约定 `{ field, op, text, from? }` 与渲染层的
 * `src/modules/ai-teaching/profilePatchParse.ts` 必须一致 —— 一个在主进程应用、一个在渲染层解析，
 * 跨进程共享不了模块，故各留一份；**改形状要同时改两处**。
 *
 * 语义边界（v3.2.0 第 20 项拍板口径）：
 * - 只认 md 里的二级标题（`## 薄弱点`）作为「字段」；**不新建字段** —— AI 不得重排画像结构，
 *   落到不存在的小节一律跳过并回报。
 * - `add`：追加到该小节正文末尾（跳过尾部空行），同小节已有同一内容则去重跳过。
 * - `update`：在该小节里找 `from` 原文所在行整行替换；**未命中 → 降级为新增**（不丢 AI 提的信息）。
 * - `remove`：在该小节里找到 `text` 所在行整行删除；未命中则跳过。
 * - `mergeOnly`：上层画像（工作区 / 全局）只允许追加 —— `update` / `remove` 在**函数入口**就被拒绝，
 *   不依赖调用方自觉过滤（这是「不许整篇覆盖上层」这条红线的落点）。
 */

export type ProfileOp = 'add' | 'update' | 'remove'

export interface ProfileEntry {
  /** 二级标题名，可带 `## ` 前缀（会被剥掉） */
  field: string
  op: ProfileOp
  /** 新内容（不带 `- ` 前缀；换行会被压成空格） */
  text: string
  /** 仅 `update`：被替换的原文（不带 `- ` 前缀） */
  from?: string
}

export interface ProfileApplyOutcome {
  field: string
  op: ProfileOp
  text: string
  /** 落地时的偏差说明（如「原文未匹配，已改为新增」） */
  note?: string
}

export interface ProfileApplySkipped extends ProfileApplyOutcome {
  reason: string
}

export interface ProfileApplyResult {
  /** 应用后的全文（换行已归一到 LF） */
  text: string
  applied: ProfileApplyOutcome[]
  skipped: ProfileApplySkipped[]
}

/** 小节在行数组里的范围：`[from, to)`，`from` 是标题行本身 */
export interface ProfileSection {
  field: string
  from: number
  to: number
}

const BULLET_RE = /^\s*[-*+]\s+/
const HEADING_RE = /^##\s+(.+?)\s*$/

/** 字段名归一：剥 `##` 前缀与首尾空白（AI 常把 `## 薄弱点` 整个塞进 field） */
export function normalizeField(raw: unknown): string {
  return String(raw ?? '').replace(/^\s*#+\s*/, '').trim()
}

/** 单行内容归一（比对用）：去行尾 `\r`、剥列表符号、去首尾空白 */
function cell(line: string): string {
  return String(line ?? '').replace(/\r$/, '').replace(BULLET_RE, '').trim()
}

/** 按二级标题切段；返回行号区间，供调用方定位插入 / 替换位置 */
export function parseProfileSections(md: string): ProfileSection[] {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n')
  const out: ProfileSection[] = []
  let cur: ProfileSection | null = null
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i])
    if (!m) continue
    if (cur) { cur.to = i; out.push(cur) }
    cur = { field: normalizeField(m[1]), from: i, to: lines.length }
  }
  if (cur) out.push(cur)
  return out
}

/** 条目是否合法（渲染层可用同口径做前置校验；主进程侧不信任入参） */
export function isValidEntry(raw: unknown): raw is ProfileEntry {
  const e = raw as ProfileEntry | null
  if (!e || typeof e !== 'object') return false
  if (e.op !== 'add' && e.op !== 'update' && e.op !== 'remove') return false
  if (!normalizeField(e.field)) return false
  if (!String(e.text ?? '').trim()) return false
  return true
}

export function applyProfileEntries(
  md: string,
  entries: readonly ProfileEntry[],
  opts: { mergeOnly?: boolean } = {},
): ProfileApplyResult {
  const mergeOnly = opts.mergeOnly === true
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n')
  const applied: ProfileApplyOutcome[] = []
  const skipped: ProfileApplySkipped[] = []

  for (const raw of entries ?? []) {
    const op = raw?.op
    const field = normalizeField(raw?.field)
    const text = String(raw?.text ?? '').replace(/\r?\n/g, ' ').trim()
    const base: ProfileApplyOutcome = { field, op: op as ProfileOp, text }

    if (op !== 'add' && op !== 'update' && op !== 'remove') {
      skipped.push({ ...base, reason: `未知操作「${String(op)}」` })
      continue
    }
    if (!field) { skipped.push({ ...base, reason: '条目缺 field（画像小节名）' }); continue }
    if (!text) { skipped.push({ ...base, reason: '条目缺 text' }); continue }
    // 上层画像红线：不允许修改 / 删除已有内容。在入口拦，不靠调用方过滤。
    if (mergeOnly && op !== 'add') {
      skipped.push({ ...base, reason: '上层画像只允许追加（mergeOnly），不支持修改 / 删除' })
      continue
    }

    // 每次迭代重新切段：前面的条目会挪动行号
    const sec = parseProfileSections(lines.join('\n')).find((s) => s.field === field)
    if (!sec) { skipped.push({ ...base, reason: `画像里没有「${field}」小节` }); continue }

    const bodyFrom = sec.from + 1
    const findIn = (needle: string): number => {
      const want = cell(needle)
      if (!want) return -1
      for (let i = bodyFrom; i < sec.to; i++) if (cell(lines[i]) === want) return i
      return -1
    }
    /** 追加落点：小节正文最后一行的下一行（跳过尾部空行，保持小节间的空行不变） */
    const appendAt = (): number => {
      let at = sec.to
      while (at > bodyFrom && lines[at - 1].trim() === '') at--
      return at
    }

    if (op === 'add') {
      if (findIn(text) >= 0) { skipped.push({ ...base, reason: '该小节已有相同内容（去重）' }); continue }
      lines.splice(appendAt(), 0, `- ${text}`)
      applied.push(base)
      continue
    }

    if (op === 'update') {
      const hit = findIn(String(raw?.from ?? ''))
      if (hit >= 0) {
        lines[hit] = `- ${text}`
        applied.push(base)
      } else if (findIn(text) >= 0) {
        skipped.push({ ...base, reason: 'from 原文未匹配，且该小节已有相同内容' })
      } else {
        lines.splice(appendAt(), 0, `- ${text}`)
        applied.push({ ...base, note: 'from 原文未匹配，已改为新增' })
      }
      continue
    }

    // remove
    const hit = findIn(text)
    if (hit >= 0) { lines.splice(hit, 1); applied.push(base) }
    else skipped.push({ ...base, reason: '未找到待删除的内容' })
  }

  return { text: lines.join('\n'), applied, skipped }
}
