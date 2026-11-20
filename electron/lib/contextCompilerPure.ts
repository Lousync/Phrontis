/**
 * AI 教学 · 上下文编译器 **纯函数**（P0 契约面）
 *
 * 方案：`/home/lousync/桌面/Phrontis-AI教学-技术方案-2026-11-19.md` §2.7 / §9
 *      `/home/lousync/桌面/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md` A4 / §5.2 / §5.5
 *
 * 三件事（零运行时依赖，契约脚本 strip 类型后直接跑真实实现）：
 *   · `parseConstraintSections` —— `CONSTRAINTS.md` v3 的节语义：必须 / 禁止 / 输出格式 / 范围 → hard，
 *                                偏好 → soft；**不在任何已识别节内的散条目归 hard**（保守，宁可多注入）；
 *   · `compileScopeLayers`      —— 全局 → 课程 → 本段三层合并去重（同句以最细一层为准），
 *                                按条数（默认 12）与字符（默认 1200，只算 hard）截断并标 `truncated`；
 *   · `compileContextBlocks`    —— 固定顺序拼装上下文块（画像 → 要求 → 本段简报 → 素材清单 → 台账），
 *                                总预算超限时**从最后一块开始整块丢弃**，被丢的名字进 `truncated`。
 *
 * 口径说明：
 *   · 去重比较忽略首尾空白、所有空白与全/半角标点差异（NFKC + 去空白 + 去尾标点）；
 *   · 同句出现多层时保留**最先出现的位置**，文本取**最细一层**的写法（lesson > course > global）；
 *   · `CompiledScope.chars` 与 `maxChars` 同口径 —— 只统计 hard 条目的字符；
 *   · 块裁剪不做「半块截断」：整块保留或整块丢弃，避免注入半截 JSON / 半句话。
 */

export interface ScopeLayersInput {
  global?: string
  course?: string
  lesson?: string
}

export interface CompiledScope {
  /** 必须 / 禁止 / 输出格式 / 范围（永远注入） */
  hard: string[]
  /** 偏好（只在相关时注入） */
  soft: string[]
  truncated: boolean
  /** hard 条目占用字符（与 maxChars 同口径） */
  chars: number
  /** 每层**最终归属**的条目数（同句取最细层，故合计可能小于原文条数） */
  layers: Array<{ layer: 'global' | 'course' | 'lesson'; hard: number; soft: number }>
}

export interface CompiledContextBlocks {
  blocks: Array<{ name: string; text: string }>
  /** 因总预算被整块丢弃的块名（按丢弃顺序：先最后一块） */
  truncated: string[]
  chars: number
}

export const CONSTRAINT_HARD_SECTIONS = ['必须', '禁止', '输出格式', '范围'] as const
export const CONSTRAINT_SOFT_SECTION = '偏好'

/** 每层默认条数上限（与 scopePrompt.SCOPE_LAYER_MAX_ITEMS 同值） */
export const CONTEXT_SCOPE_MAX_ITEMS = 12
/** 每层默认字符上限（与 scopePrompt.SCOPE_LAYER_MAX_CHARS 同值；只算 hard） */
export const CONTEXT_SCOPE_MAX_CHARS = 1200
/** 上下文块总预算 */
export const CONTEXT_BLOCKS_BUDGET = 8000

const LAYER_ORDER: Array<'global' | 'course' | 'lesson'> = ['global', 'course', 'lesson']

const ITEM_RE = /^(?:[-*]|\d+[.、)])\s+(.*\S)\s*$/

function normalizeText(raw: string): string {
  return String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

/** 去重键：NFKC + 去空白 + 去尾标点（全/半角由此归一） */
function normalizeKey(raw: string): string {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[.,;:!?。，、；：！？]+$/g, '')
}

/**
 * 解析 `CONSTRAINTS.md` v3 的节语义。
 * - 识别 `## 必须 / ## 禁止 / ## 输出格式 / ## 范围 / ## 偏好`（允许标题后带括号补充）；
 * - 条目认 `- ` / `* ` / `1. `；
 * - 空行与 HTML 注释忽略；
 * - **不在已识别节内的条目归 hard**（保守：少注入一条硬规则比违反它更危险）。
 */
export function parseConstraintSections(text: string): { hard: string[]; soft: string[] } {
  const source = normalizeText(text).replace(/<!--[\s\S]*?-->/g, '')
  const hard: string[] = []
  const soft: string[] = []
  let section: 'hard' | 'soft' | null = null

  for (const line of source.split('\n')) {
    const heading = /^##[ \t]+(.*)$/.exec(line)
    if (heading) {
      const name = (heading[1] ?? '').trim()
      if (name.startsWith(CONSTRAINT_SOFT_SECTION)) section = 'soft'
      else if (CONSTRAINT_HARD_SECTIONS.some((s) => name.startsWith(s))) section = 'hard'
      else section = null
      continue
    }
    const item = ITEM_RE.exec(line)
    if (!item) continue
    const value = (item[1] ?? '').trim()
    if (!value) continue
    if (section === 'soft') soft.push(value)
    else hard.push(value)
  }

  return { hard, soft }
}

/**
 * 三层合并：顺序恒为 global → course → lesson。
 * 同句（忽略空白与全/半角标点）以最细一层为准 —— Map 保留首次插入位置，覆盖只换文本与归属层。
 */
export function compileScopeLayers(
  input: ScopeLayersInput,
  opts?: { maxItems?: number; maxChars?: number },
): CompiledScope {
  const maxItems =
    typeof opts?.maxItems === 'number' && Number.isFinite(opts.maxItems)
      ? Math.max(0, Math.floor(opts.maxItems))
      : CONTEXT_SCOPE_MAX_ITEMS
  const maxChars =
    typeof opts?.maxChars === 'number' && Number.isFinite(opts.maxChars)
      ? Math.max(0, Math.floor(opts.maxChars))
      : CONTEXT_SCOPE_MAX_CHARS

  const hardMap = new Map<string, { text: string; layer: 'global' | 'course' | 'lesson' }>()
  const softMap = new Map<string, { text: string; layer: 'global' | 'course' | 'lesson' }>()

  for (const layer of LAYER_ORDER) {
    const source = input?.[layer] ?? ''
    const parsed = parseConstraintSections(source)
    for (const item of parsed.hard) {
      const key = normalizeKey(item)
      if (!key) continue
      // set 已有键不会改变插入位置，只替换成更细层的写法
      hardMap.set(key, { text: item, layer })
    }
    for (const item of parsed.soft) {
      const key = normalizeKey(item)
      if (!key) continue
      softMap.set(key, { text: item, layer })
    }
  }

  const layers = LAYER_ORDER.map((layer) => {
    let hard = 0
    let soft = 0
    for (const entry of hardMap.values()) if (entry.layer === layer) hard++
    for (const entry of softMap.values()) if (entry.layer === layer) soft++
    return { layer, hard, soft }
  })

  const allHard = Array.from(hardMap.values()).map((e) => e.text)
  let truncated = false

  let keptByCount = allHard
  if (keptByCount.length > maxItems) {
    keptByCount = keptByCount.slice(0, maxItems)
    truncated = true
  }

  const hard: string[] = []
  let chars = 0
  for (const item of keptByCount) {
    const add = hard.length ? item.length + 1 : item.length
    if (chars + add > maxChars) {
      truncated = true
      break
    }
    hard.push(item)
    chars += add
  }

  const soft = Array.from(softMap.values()).map((e) => e.text)
  return { hard, soft, truncated, chars, layers }
}

/** 把编译后的要求渲染成注入文本（hard 在前，soft 有则单列「偏好」） */
function renderCompiledScope(scope: CompiledScope): string {
  const lines: string[] = []
  if (scope.hard.length) {
    lines.push('必须遵守：')
    for (const item of scope.hard) lines.push(`- ${item}`)
  }
  if (scope.soft.length) {
    if (lines.length) lines.push('')
    lines.push('偏好：')
    for (const item of scope.soft) lines.push(`- ${item}`)
  }
  if (!lines.length) return ''
  if (scope.truncated) lines.push('（要求已截断）')
  return lines.join('\n')
}

/**
 * 固定顺序拼装上下文块：画像 → 要求 → 本段简报 → 素材清单 → 台账。
 * 空块跳过；总量超预算时**从最后一块开始整块丢弃**，被丢的名字依次进 `truncated`。
 */
export function compileContextBlocks(input: {
  profile?: string
  scope?: CompiledScope
  brief?: string
  materials?: string
  ledger?: string
  budgetChars?: number
}): CompiledContextBlocks {
  const budget =
    typeof input?.budgetChars === 'number' && Number.isFinite(input.budgetChars)
      ? Math.max(0, Math.floor(input.budgetChars))
      : CONTEXT_BLOCKS_BUDGET

  const blocks: Array<{ name: string; text: string }> = []
  const push = (name: string, text: string | undefined) => {
    const body = typeof text === 'string' ? text.trim() : ''
    if (body) blocks.push({ name, text: body })
  }

  push('画像', input?.profile)
  if (input?.scope) push('要求', renderCompiledScope(input.scope))
  push('本段简报', input?.brief)
  push('素材清单', input?.materials)
  push('台账', input?.ledger)

  let chars = blocks.reduce((sum, b) => sum + b.text.length, 0)
  const truncated: string[] = []
  while (chars > budget && blocks.length) {
    const dropped = blocks.pop()
    if (!dropped) break
    truncated.push(dropped.name)
    chars -= dropped.text.length
  }

  return { blocks, truncated, chars }
}
