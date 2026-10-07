/**
 * B4 · 内联建议的**纯函数区**（零 import，供合同脚本裸 node import）。
 *
 * 独立成文件的理由同 agentCompressCore / releaseNotes-judge：
 * 契约脚本要 import 这些函数做断言；若与编排区同居一个文件，
 * 编排区的 `import { ipcMain } from 'electron'` 会让裸 node 解析失败。
 *
 * ⛔ 本文件禁止出现任何 import（含 type-only 之外的运行时依赖）。
 */

// ===== 常量 =====

/**
 * 光标前取多少字符作为「已写上下文」。
 *
 * 成本口径（2026-09-19 实测）：续写只需最近一小段，2000 → 800 让单次输入从
 * ≈2300-3450 token 降到 ≈1100-1650 token（省 ~55%）。给的越多并不会更准，
 * 反而稀释最近的上下文。
 */
export const INLINE_BEFORE_LIMIT = 800
/** 光标后取多少字符作为「后文线索」（同样收窄：500 → 300） */
export const INLINE_AFTER_LIMIT = 300
/** 单条建议的字数上限（提示模型 + 兜底截断） */
export const INLINE_SUGGEST_MAX_CHARS = 600
/**
 * 单次生成的硬超时（ms）。
 *
 * 为什么必须有：ghost text 是「点一下立刻要」的交互，模型不可达 / 慢时若无限等，
 * 渲染层的忙态微标会永久转圈（探针实测：无 provider 时 8s 仍未返回，且永不 resolve）。
 * 超时后 abort 并回落 —— 用户看到的只是「这次没出建议」，再点一次即可。
 *
 * 渲染层另有一道 UI 兜底（MonacoPane 的 INLINE_UI_TIMEOUT_MS），必须 ≥ 本值（契约 J7b 断言）。
 */
export const INLINE_SUGGEST_TIMEOUT_MS = 10000

// ===== 类型 =====

export interface InlineContext {
  /** 文档全文 */
  text: string
  /** 光标在 text 中的字符偏移（Monaco 的 offset 语义） */
  offset: number
  /** frontmatter 里的 title（可选，取不到留空） */
  title?: string
}

export interface CursorWindow {
  head: string
  tail: string
  truncatedHead: boolean
  truncatedTail: boolean
}

// ===== 光标窗口 =====

/**
 * 光标窗口：前 before 字符 + 后 after 字符，按字符切片并处理越界。
 * offset 可能来自旧版本内容（文档刚被外部改动）→ 夹紧，
 * 绝不让 slice 静默给出错误窗口（越界 slice 会返回空串，看起来像「上下文为空」）。
 */
export function sliceCursorWindow(
  text: string,
  offset: number,
  before = INLINE_BEFORE_LIMIT,
  after = INLINE_AFTER_LIMIT,
): CursorWindow {
  const s = String(text ?? '')
  const total = s.length
  const at = Math.max(0, Math.min(Number.isFinite(offset) ? Math.floor(offset) : 0, total))
  const from = Math.max(0, at - Math.max(0, before))
  const to = Math.min(total, at + Math.max(0, after))
  return {
    head: s.slice(from, at),
    tail: s.slice(at, to),
    truncatedHead: from > 0,
    truncatedTail: to < total,
  }
}

/**
 * 段落锚定窗口（成本优化 ②）：起点对齐「段落边界」，而不是固定回溯 N 字符。
 *
 * 为什么不直接用上面的滑动窗口（`at - 800`）：
 *   DeepSeek 的上下文硬盘缓存要求**两个请求的前缀从第 0 个 token 起完全相同**
 *   （官方文档：中间开始的重复不算命中）。滑动窗口每敲一个字起点就右移一格 →
 *   前缀首 token 变化 → 缓存 **100% 不命中**：输入按未命中价计费，而命中价差 30 倍
 *   （flash 1.5 元/M vs 0.05 元/M）。
 *   锚定到段落起点后，同一段内连续打字时起点不动 → 前缀稳定 → 命中绝大部分输入。
 *
 * 锚点选择：从光标所在段落往上逐段扩展，只要没超出 before 上限就继续 ——
 *   取到的是「不超过上限的最靠前段落起点」，既给足上下文又天然落在段落边界上。
 * 退化：单段就超过上限时（长段落），退回滑动窗口 —— 缓存不再命中，但语义仍正确。
 */
export function sliceParagraphWindow(
  text: string,
  offset: number,
  before = INLINE_BEFORE_LIMIT,
  after = INLINE_AFTER_LIMIT,
): CursorWindow {
  const s = String(text ?? '')
  const total = s.length
  const at = Math.max(0, Math.min(Number.isFinite(offset) ? Math.floor(offset) : 0, total))
  const lim = Math.max(0, before)

  // 段落起点 = 文档开头 + 每个 \n 之后（空行分隔的段落在锚定意义上等价，多锚几个更细）
  const starts: number[] = [0]
  const head = s.slice(0, at)
  for (let i = 0; i < head.length; i++) if (head[i] === '\n') starts.push(i + 1)

  // 从光标所在段落往上逐段扩展：只要没超出上限就继续往前挪锚点
  //   ⚠️ anchor 必须初始化为 -1（无效），不能用 at —— 否则「单段就超上限」时
  //   会误判成「at 这个锚点合法」→ from = at → 窗口退化成空串（契约 J15c/J15e 抓到）。
  let anchor = -1
  for (let i = starts.length - 1; i >= 0; i--) {
    const st = starts[i]
    if (at - st > lim) break
    anchor = st
  }
  const from = anchor >= 0 ? anchor : Math.max(0, at - lim)
  const to = Math.min(total, at + Math.max(0, after))
  return {
    head: s.slice(from, at),
    tail: s.slice(at, to),
    truncatedHead: from > 0,
    truncatedTail: to < total,
  }
}

// ===== frontmatter title =====

/**
 * 从文本里取 frontmatter 的 title。
 * 只认文件头部的 `---` 块；取不到返回空串（调用方不得因此失败）。
 */
export function pickFrontmatterTitle(text: string): string {
  const s = String(text ?? '')
  // BOM / 前导空行容忍
  const m = /^\uFEFF?\s*---\r?\n([\s\S]*?)\r?\n---/.exec(s)
  if (!m) return ''
  const tm = /^\s*title\s*:\s*(.*)$/m.exec(m[1])
  if (!tm) return ''
  return tm[1].trim().replace(/^["']|["']$/g, '').trim()
}

// ===== prompt 组装 =====

/**
 * 组装内联建议的 prompt。同输入恒同输出（合同脚本据此断言）。
 * @param ctx 光标上下文
 */
export function buildInlinePrompt(ctx: InlineContext): { system: string; user: string } {
  // 段落锚定窗口（不是滑动）—— 见 sliceParagraphWindow 的缓存说明
  const win = sliceParagraphWindow(ctx.text, ctx.offset)
  const title = String(ctx.title ?? '').trim()

  const system = [
    '你是写作续写助手。用户在 Markdown 编辑器里写到一半，你需要判断「下一步该写什么」。',
    '',
    '规则：',
    '1. 只输出续写内容本身。不要解释、不要复述上文、不要加引号或 Markdown 代码围栏。',
    `2. 长度 1-3 句、至多 ${INLINE_SUGGEST_MAX_CHARS} 字；短比长好，写得像用户自己的语气。`,
    '3. 直接接着光标处的文字往下写，开头不要重复光标前已有的字词。',
    '4. 若上文是标题或列表项，按该结构的自然延续写。',
    '5. 若上下文不足以判断（例如文件刚开头、只有几个字），输出一个简短合理的开头句即可。',
  ].join('\n')

  const parts: string[] = []
  if (title) parts.push(`文档标题：${title}`)
  parts.push(
    '【光标之前的正文】' + (win.truncatedHead ? '（已截断，只保留末尾部分）' : ''),
    win.head || '（空）',
    '',
    '【光标之后的正文】' + (win.truncatedTail ? '（已截断）' : ''),
    win.tail || '（空）',
    '',
    '请在【光标之前】的末尾接着续写。',
  )

  return { system, user: parts.join('\n') }
}

// ===== 输出清洗 =====

/**
 * 清洗模型输出为单条 ghost text 可用的文本。
 * - 去掉可能的代码围栏 / 引号包裹
 * - 去掉「续写：」这类前后缀标签
 * - 压掉首尾空白（但**保留内部的换行**，多行续写是合法的）
 * - 超长截断到上限
 *
 * 幂等：normalizeInlineSuggestion(normalizeInlineSuggestion(x)) === normalizeInlineSuggestion(x)
 */
export function normalizeInlineSuggestion(raw: string): string {
  let s = String(raw ?? '')
  if (!s.trim()) return ''
  // 去掉整体包裹的 ``` 围栏
  const fence = /^\s*```[a-zA-Z0-9]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(s)
  if (fence) s = fence[1]
  s = s.trim()
  // 去掉整体包裹的成对引号（含中文引号）
  if (s.length >= 2) {
    const a = s[0]
    const b = s[s.length - 1]
    if ((a === '"' && b === '"') || (a === '\u201c' && b === '\u201d') || (a === "'" && b === "'")) {
      s = s.slice(1, -1)
    }
  }
  // 去掉行首的「续写：」「下一步：」这类标签
  s = s.replace(/^\s*(?:\*\*)?(?:续写|下一步|建议|next|continuation)\s*(?:\*\*)?\s*[:：]\s*/i, '')
  // 首尾空白（保留内部换行）
  s = s.replace(/^[ \t\r\n]+/, '').replace(/[ \t\r\n]+$/, '')
  if (s.length > INLINE_SUGGEST_MAX_CHARS) s = s.slice(0, INLINE_SUGGEST_MAX_CHARS)
  return s
}

/**
 * 建议文本是否可直接作为 ghost text 呈现。
 * 空 / 纯空白 / 纯标点视为无效（模型偶尔只吐一个句号，呈现出来是坏体验）。
 */
export function isValidSuggestion(s: string): boolean {
  const t = String(s ?? '').trim()
  if (!t) return false
  return /[\p{L}\p{N}]/u.test(t)
}
