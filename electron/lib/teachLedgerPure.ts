/**
 * AI 教学 · 段内进度台账 **纯函数**（P0 契约面）
 *
 * 方案：`/home/lousync/桌面/Phrontis-AI教学-技术方案-2026-11-19.md` §2.8 / §9
 *      `/home/lousync/桌面/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md` E2（已拍板 A）
 *
 * 职责（零运行时依赖，只 `import type` 共享类型，专为契约脚本 strip 类型后直接 import）：
 *   · `parseTeachFence` —— 抓回答尾部 ` ```teach ` 围栏里的增量 JSON（对象）；容错见下；
 *   · `stripTeachFence` —— 渲染层去掉该围栏，**不碰** quiz / plan / ask / outline 等其它围栏；
 *   · `mergeLedger`     —— 程序累加进 `progress.json` 的 ledger：幂等、step 只增不减、术语去重；
 *   · `renderLedgerForPrompt` —— 下轮注入的中文台账块（≤ 800 字符）；
 *   · `lastTeachPatchOf` / `renderSegmentLedger` —— 段会话接线：取最后一条围栏、
 *     渲染「已讲到 / 已覆盖 / 未覆盖 / 下一步 / 最近术语」（≤ 800 字符，台账优先于当前聚焦）；
 *   · `ledgerFromHeadings`    —— 模型漏写围栏时，用回答里最后一个 `### 标题` 兜底。
 *
 * 容错口径（parseTeachFence）：
 *   · 所有普通 JSON 语法错误都不抛，失败返回 null；
 *   · 允许：单引号、尾逗号、`//` 与 `/* *\/` 注释、JSON 前后多余文字；
 *   · 允许全角引号（“”『』）出现在**结构位置**（键 / 值 / 数组元素的首尾），
 *     不做无差别全局替换，避免把正文里的『术语』当成边界引号；
 *   · 围栏内容必须是对象，数组 / 标量一律视为无效。
 */

import type { TeachLedger, TeachPatch } from './aiTeachingTypesPure'

/** 注入台账的字符上限（与 aiTeachingTypesPure.TEACH_LEDGER_MAX_CHARS 同值，契约脚本锁定不漂移） */
export const TEACH_LEDGER_PROMPT_MAX_CHARS = 800

/** 台账块抬头（稳定，便于模型识别「程序维护」） */
export const TEACH_LEDGER_HEADER = '【本段台账（程序维护，权威）】'

/** 超长截断标记（独占末行） */
export const TEACH_LEDGER_TRUNCATED_MARK = '（台账已截断）'

/** 识别 ` ```teach ` 围栏：语言标记后必须是换行，避免误吃 ` ```teachx ` */
const TEACH_FENCE_RE = /```[ \t]*teach[ \t]*\r?\n([\s\S]*?)```/gi

/* ------------------------------------------------------------------ 容错 JSON */

/** 去掉 JSON 之外的注释（字符串内的 `//`、`/*` 原样保留） */
function stripJsonComments(src: string): string {
  let out = ''
  let i = 0
  let quote: string | null = null
  while (i < src.length) {
    const c = src[i]
    if (quote) {
      out += c
      if (c === '\\') {
        out += src[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      out += c
      i++
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/** 只做「注释 + 尾逗号」清理：标准 JSON 仍走标准解析 */
function cleanJson(src: string): string {
  return stripJsonComments(src).replace(/,\s*([}\]])/g, '$1')
}

/** 全角引号仅在结构位置转义为 `"`（键 / 值 / 数组元素） */
function convertStructuralFullwidthQuotes(src: string): string {
  return src
    // 键：{『unitId』: ... } / ,『label』: ...
    .replace(/([{,]\s*)[『“]([^『』“”]*)[』”](\s*:)/g, '$1"$2"$3')
    // 值 / 数组元素：:『x』 / ,『x』 / [『x』
    .replace(/([:\s\[])\s*[『“]([^『』“”]*)[』”]/g, '$1"$2"')
}

/** 单引号字符串 → 双引号字符串；裸键补引号；尾逗号清理 */
function looseJson(src: string): string {
  let s = convertStructuralFullwidthQuotes(stripJsonComments(src))
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '"') {
      out += c
      i++
      while (i < s.length) {
        const d = s[i]
        if (d === '\\') {
          out += d + (s[i + 1] ?? '')
          i += 2
          continue
        }
        out += d
        i++
        if (d === '"') break
      }
      continue
    }
    if (c === "'") {
      out += '"'
      i++
      while (i < s.length) {
        const d = s[i]
        if (d === '\\') {
          const n = s[i + 1]
          // 单引号内的 \' 在双引号字符串里直接写 '
          out += n === "'" ? "'" : d + (n ?? '')
          i += 2
          continue
        }
        if (d === '"') {
          out += '\\"'
          i++
          continue
        }
        if (d === "'") {
          out += '"'
          i++
          break
        }
        out += d
        i++
      }
      continue
    }
    out += c
    i++
  }
  s = out.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
  return s.replace(/,\s*([}\]])/g, '$1')
}

/** 从任意文本里截出第一个花括号配对的对象字面量（跳过字符串内的括号） */
function extractObject(src: string): string | null {
  const start = src.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let quote: string | null = null
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') {
        i++
        continue
      }
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
}

/** 解析成对象；全部尝试失败返回 null */
function parseObjectLoose(src: string): Record<string, unknown> | null {
  const lead = src.trim()
  // 围栏里写的是数组（`[{...}]`）按契约无效：teach 只接受单个对象
  if (lead.startsWith('[') && lead.endsWith(']')) return null
  const body = extractObject(src)
  if (!body) return null
  const attempts = [body, cleanJson(body), looseJson(body)]
  for (const attempt of attempts) {
    try {
      const value: unknown = JSON.parse(attempt)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>
      }
    } catch {
      /* 换下一种容错写法 */
    }
  }
  return null
}

/** 只保留 TeachPatch 认识的字段；一条有效信息都没有 → null */
function toTeachPatch(raw: Record<string, unknown>): TeachPatch | null {
  const patch: TeachPatch = {}
  let any = false
  if (typeof raw.unitId === 'string' && raw.unitId.trim()) {
    patch.unitId = raw.unitId.trim()
    any = true
  }
  if (typeof raw.step === 'number' && Number.isFinite(raw.step)) {
    patch.step = Math.max(0, Math.floor(raw.step))
    any = true
  }
  if (typeof raw.label === 'string' && raw.label.trim()) {
    patch.label = raw.label.trim()
    any = true
  }
  if (Array.isArray(raw.newTerms)) {
    const terms = raw.newTerms
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter(Boolean)
    patch.newTerms = terms
    if (terms.length) any = true
  }
  if (typeof raw.next === 'string' && raw.next.trim()) {
    patch.next = raw.next.trim()
    any = true
  }
  return any ? patch : null
}

/* ------------------------------------------------------------------ 围栏 */

/**
 * 抓 ` ```teach ` 围栏里的 JSON 对象（只写本回答的增量）。
 * 第一个能解析成对象的 teach 围栏胜出；没有 / 解析失败返回 null（绝不抛）。
 */
export function parseTeachFence(text: string): TeachPatch | null {
  const src = String(text ?? '')
  if (!src) return null
  const re = new RegExp(TEACH_FENCE_RE.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const parsed = parseObjectLoose(m[1] ?? '')
    if (!parsed) continue
    const patch = toTeachPatch(parsed)
    if (patch) return patch
  }
  return null
}

/**
 * 移除 teach 围栏并清理它留下的多余空行（渲染层用）。
 * 只匹配带 `teach` 语言标记的围栏，quiz / plan / ask / outline 一律原样保留。
 */
export function stripTeachFence(text: string): string {
  let out = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  out = out.replace(/```[ \t]*teach[ \t]*\n[\s\S]*?```[ \t]*/gi, '')
  out = out.replace(/[ \t]+\n/g, '\n')
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.replace(/^\n+/, '').replace(/\s+$/, '')
}

/* ------------------------------------------------------------------ 累加 */

function normTerm(term: string): string {
  return term.trim().toLowerCase()
}

function hasContent(patch: TeachPatch): boolean {
  const unit = typeof patch.unitId === 'string' && patch.unitId.trim() !== ''
  const label = typeof patch.label === 'string' && patch.label.trim() !== ''
  const step = typeof patch.step === 'number' && Number.isFinite(patch.step)
  const terms = Array.isArray(patch.newTerms) && patch.newTerms.some((t) => String(t ?? '').trim() !== '')
  const next = typeof patch.next === 'string' && patch.next.trim() !== ''
  return unit || label || step || terms || next
}

/** 空 ledger（`prev` 为 null 且 patch 全空时返回它，而不是 null） */
function emptyLedger(now: string): TeachLedger {
  return { terms: [], updatedAt: now }
}

/**
 * 把模型给的增量合并进已有台账（纯函数，不改 `prev`）。
 *
 * 不变量：
 *   · **幂等**：同一 patch 连续合并两次结果相同；
 *   · **step 只增不减**：`patch.step` 小于当前 step 视为旧消息，整段 current 不动；
 *   · **terms 去重**（大小写不敏感、忽略首尾空白），保留首次 `definedAt`；
 *   · `newTerms` 为空数组时不动 terms；patch 全空时原样返回 `prev`。
 */
export function mergeLedger(prev: TeachLedger | null, patch: TeachPatch, now: string): TeachLedger {
  const p: TeachPatch = patch ?? {}
  if (!hasContent(p)) return prev ? prev : emptyLedger(now)

  const base: TeachLedger = prev
    ? {
        current: prev.current ? { ...prev.current } : undefined,
        terms: prev.terms.map((t) => ({ ...t })),
        next: prev.next,
        updatedAt: prev.updatedAt,
      }
    : emptyLedger(now)

  let changed = false

  const hasUnit = typeof p.unitId === 'string' && p.unitId.trim() !== ''
  const hasLabel = typeof p.label === 'string' && p.label.trim() !== ''
  const requested =
    typeof p.step === 'number' && Number.isFinite(p.step)
      ? Math.max(0, Math.floor(p.step))
      : undefined
  const prevStep = base.current?.step ?? 0

  // 旧消息（step 回退）整段 current 不动 —— 保证「只增不减」
  const stale = requested !== undefined && requested < prevStep
  if (!stale && (hasUnit || hasLabel || requested !== undefined)) {
    const prevUnit = base.current?.unitId ?? ''
    const nextUnit = hasUnit ? (p.unitId as string).trim() : prevUnit
    const nextStep = requested !== undefined ? Math.max(prevStep, requested) : prevStep
    // 换 unit 且本 patch 没给 label：清空旧 label（否则会显示上一 unit 的台阶名）
    const nextLabel = hasLabel
      ? (p.label as string).trim()
      : nextUnit !== prevUnit
        ? ''
        : (base.current?.label ?? '')
    const nextCurrent = { unitId: nextUnit, step: nextStep, label: nextLabel }
    const before = base.current
    if (
      !before ||
      before.unitId !== nextCurrent.unitId ||
      before.step !== nextCurrent.step ||
      before.label !== nextCurrent.label
    ) {
      base.current = nextCurrent
      changed = true
    }
  }

  if (Array.isArray(p.newTerms) && p.newTerms.length) {
    const seen = new Set(base.terms.map((t) => normTerm(t.term)))
    for (const rawTerm of p.newTerms) {
      const term = String(rawTerm ?? '').trim()
      if (!term) continue
      const key = normTerm(term)
      if (seen.has(key)) continue
      seen.add(key)
      base.terms.push({ term, definedAt: now })
      changed = true
    }
  }

  if (typeof p.next === 'string' && p.next.trim()) {
    const next = p.next.trim()
    if (base.next !== next) {
      base.next = next
      changed = true
    }
  }

  if (!changed) return prev ? prev : base
  base.updatedAt = now
  return base
}

/* ------------------------------------------------------------------ 注入 */

/**
 * 抬头 + 若干行拼成注入块；超长时**从最后一行开始丢**，末尾追加「（台账已截断）」，
 * 且保证总长 ≤ limit。renderLedgerForPrompt / renderSegmentLedger 共用这一份截断口径。
 */
function joinLedgerLines(header: string, lines: string[], limit: number): string {
  const joined = `${header}\n${lines.join('\n')}`
  if (joined.length <= limit) return joined

  const keep = lines.slice()
  const mark = TEACH_LEDGER_TRUNCATED_MARK
  let body = `${header}\n${keep.join('\n')}`
  while (keep.length > 0 && body.length + 1 + mark.length > limit) {
    keep.pop()
    body = keep.length ? `${header}\n${keep.join('\n')}` : header
  }
  if (body.length + 1 + mark.length <= limit) return `${body}\n${mark}`
  if (limit <= mark.length) return mark.slice(0, limit)
  return `${body.slice(0, limit - mark.length)}${mark}`
}

/**
 * 产出中文台账块（下轮注入用）。空 ledger → 空串。
 * 超长按行截断（从最后一行开始丢），末尾追加「（台账已截断）」且总长 ≤ maxChars。
 */
export function renderLedgerForPrompt(
  ledger: TeachLedger | null,
  maxChars: number = TEACH_LEDGER_PROMPT_MAX_CHARS,
): string {
  if (!ledger) return ''
  const limit = Math.max(1, Math.floor(maxChars))

  const lines: string[] = []
  const cur = ledger.current
  if (cur) {
    const parts: string[] = []
    if (cur.unitId) parts.push(`unit ${cur.unitId}`)
    if (typeof cur.step === 'number' && cur.step > 0) parts.push(`第 ${cur.step} 步`)
    if (cur.label) parts.push(cur.label)
    if (parts.length) lines.push(`已讲到：${parts.join(' · ')}`)
  }
  const terms = (ledger.terms ?? []).map((t) => t.term.trim()).filter(Boolean)
  if (terms.length) lines.push(`已定义：${terms.join('、')}`)
  if (ledger.next && ledger.next.trim()) lines.push(`下一步：${ledger.next.trim()}`)
  if (!lines.length) return ''

  return joinLedgerLines(TEACH_LEDGER_HEADER, lines, limit)
}

/* ------------------------------------------------------------------ 段内注入 */

/** 台账里「最近术语」最多展示几个（本轮增量通常就两三个；异常长时只留后几个） */
const SEGMENT_LEDGER_TERMS_MAX = 8

export interface SegmentLedgerInput {
  /** 最后一条 ` ```teach ` 围栏解析出的增量（null = 本段还没有围栏） */
  patch: TeachPatch | null
  /** 本段知识点（按大纲顺序）—— 用来把 unitId 换成名字、并推导已覆盖 / 未覆盖 */
  units: Array<{ id: string; name: string }>
  /** 界面当前聚焦的知识点 id（「当前聚焦第 X/N」推断口径） */
  focusId?: string
  /** 注入上限（字符），默认与 renderLedgerForPrompt 同值 */
  maxChars?: number
}

export interface SegmentLedgerBlock {
  /** 台账块；无围栏 / 围栏里没有任何进度字段 → 空串（调用方据此保持原注入逐字不变） */
  text: string
  /** 台账当前知识点 ≠ 界面当前聚焦（块内已点明「以台账为准」） */
  conflict: boolean
}

/**
 * 取**最后一条**带 ` ```teach ` 围栏的 assistant 消息里的增量。
 *
 * 口径：整段消息从新往旧扫，跳过 user 消息与没有有效围栏的 assistant 回答；
 * 一条都找不到返回 null。只读，不落盘、不改消息。
 */
export function lastTeachPatchOf(
  messages: Array<{ role?: string; content?: string }>,
): TeachPatch | null {
  const rows = Array.isArray(messages) ? messages : []
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i]
    if (!m || m.role !== 'assistant') continue
    const patch = parseTeachFence(String(m.content ?? ''))
    if (patch) return patch
  }
  return null
}

/**
 * 段内台账注入块（已讲到 / 已覆盖 / 未覆盖 / 下一步 / 最近术语）。
 *
 * 优先级：**围栏里的台账 > 「当前聚焦第 X/N」推断** —— 台账与界面聚焦不一致时，
 * 块内单独点名「以台账为准」，调用方另把那句推断降级为界面状态。
 * 无围栏时返回空串（调用方必须让原注入逐字不变）。
 */
export function renderSegmentLedger(input: SegmentLedgerInput): SegmentLedgerBlock {
  const patch = input?.patch ?? null
  if (!patch) return { text: '', conflict: false }
  const limit = Math.max(1, Math.floor(input.maxChars ?? TEACH_LEDGER_PROMPT_MAX_CHARS))
  const units = Array.isArray(input.units) ? input.units : []

  const rawId = typeof patch.unitId === 'string' ? patch.unitId.trim() : ''
  const idx = rawId ? units.findIndex((u) => u.id === rawId || u.name === rawId) : -1
  const cur = idx >= 0 ? units[idx] : null
  const curName = cur?.name ?? rawId
  const focusId = String(input.focusId ?? '').trim()
  // 模型写名字也认（cur 已解析出 id）；解析不出 unit 时按原文比对，宁可报冲突也不静默吞掉
  const conflict = !!curName && !!focusId && (cur ? cur.id !== focusId : curName !== focusId)

  const lines: string[] = []
  const progress: string[] = []
  if (curName) progress.push(curName)
  if (typeof patch.step === 'number' && Number.isFinite(patch.step) && patch.step > 0) {
    progress.push(`第 ${Math.floor(patch.step)} 步`)
  }
  if (patch.label && patch.label.trim()) progress.push(patch.label.trim())
  if (progress.length) lines.push(`已讲到：${progress.join(' · ')}`)
  if (conflict) lines.push('冲突提示：界面「当前聚焦」与台账不一致，以台账为准（继续按台账推进）。')
  if (idx > 0) lines.push(`已覆盖：${units.slice(0, idx).map((u) => u.name).join('、')}`)
  if (idx >= 0 && idx < units.length - 1) lines.push(`未覆盖：${units.slice(idx + 1).map((u) => u.name).join('、')}`)
  if (patch.next && patch.next.trim()) lines.push(`下一步：${patch.next.trim()}`)
  const terms: string[] = []
  const seenTerms = new Set<string>()
  for (const rawTerm of patch.newTerms ?? []) {
    const term = String(rawTerm ?? '').trim()
    if (!term) continue
    const key = normTerm(term)
    if (seenTerms.has(key)) continue
    seenTerms.add(key)
    terms.push(term)
  }
  if (terms.length) lines.push(`最近术语：${terms.slice(-SEGMENT_LEDGER_TERMS_MAX).join('、')}`)

  if (!lines.length) return { text: '', conflict: false }
  return { text: joinLedgerLines(TEACH_LEDGER_HEADER, lines, limit), conflict }
}

/* ------------------------------------------------------------------ 兜底 */

/**
 * 模型漏写 ` ```teach ` 围栏时的兜底：取回答里**最后一个** `### 标题` 当 label。
 * 找不到标题返回 null（不凭猜测编台账）。
 */
export function ledgerFromHeadings(text: string, unitId?: string): TeachPatch | null {
  const src = String(text ?? '')
  const re = /^###[ \t]+(.+?)[ \t]*$/gm
  let last: string | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const label = (m[1] ?? '').trim()
    if (label) last = label
  }
  if (!last) return null
  const patch: TeachPatch = { label: last }
  const unit = typeof unitId === 'string' ? unitId.trim() : ''
  if (unit) patch.unitId = unit
  return patch
}
