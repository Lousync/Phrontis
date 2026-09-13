/**
 * 选择题解析器（刷题模式数据层）
 *
 * 双轨输入：
 * 1. 旧 408 知识包格式（兼容）：`### 第 N 题（X 分）` 块 + `- **A.**` 选项行 +
 *    ```spoiler-answer 块内 `**答案：X**` / `**解析**：...`
 * 2. 新规范格式（推荐给未来数学/英语/政治知识包）：```quiz 围栏内 JSON
 *
 * 渲染层流程：preprocessContent(旧→quiz 围栏) → ReactMarkdown 的 pre 组件
 * 识别 language-quiz → parseQuizFence → QuizCard / QuizMode 消费。
 * 无法识别的块静默降级为原文，绝不破坏现有渲染。
 */

export interface QuizOption {
  key: string
  text: string
}

export interface QuizItem {
  no: number
  points: string
  question: string
  options: QuizOption[]
  answer: string
  explanation: string
}

const QUESTION_HEAD_RE = /^###\s+第\s*(\d+)\s*题(?:\s*[（(]\s*(\d+)\s*分\s*[）)])?/m
const OPTION_RE = /^-\s*\*\*([A-H])\.?\*\*\s*(.*)$/i
const ANSWER_RE = /^\*\*?\s*答案\s*[：:]\s*\*?\s*([A-H]{1,8})\b/im
const EXPLAIN_RE = /^\*\*?\s*解析\s*\*{0,2}\s*[：:]\s*([\s\S]*)$/im

/** 匹配整个"第 N 题"块：从 `### 第 N 题` 到下一个 `### 第`/`#### 第` 或文件尾 */
function blockRegex(): RegExp {
  return /(^|\n)(###\s+第[^\n]*\n[\s\S]*?)(?=\n#{2,4}\s+第|$)/g
}

/** 从 spoiler 块文本中提取答案字母与解析正文 */
function parseSpoiler(spoiler: string): { answer: string; explanation: string } {
  let answer = ''
  const am = spoiler.match(ANSWER_RE)
  if (am) answer = am[1].toUpperCase()
  let explanation = ''
  const em = spoiler.match(EXPLAIN_RE)
  if (em) {
    explanation = em[1].trim()
    // 解析正文中若第一行是"答案 X"行则去掉（部分内容里解析与答案同行）
    explanation = explanation.replace(/^答案\s*[：:]?\s*[A-H]{1,8}\s*[，,。]?\s*/i, '')
  } else {
    // 兜底：整个 spoiler 去掉答案行后作为解析
    explanation = spoiler.replace(ANSWER_RE, '').trim()
  }
  return { answer, explanation }
}

/** 解析单个"第 N 题"块 → QuizItem；非选择题（无选项/无答案）返回 null */
function parseQuestionBlock(block: string): QuizItem | null {
  const head = block.match(QUESTION_HEAD_RE)
  if (!head) return null
  const no = parseInt(head[1], 10) || 0
  const points = head[2] || ''

  // 提取 spoiler 块（答案/解析）
  const spoilerMatch = block.match(/```spoiler-answer\s*\n([\s\S]*?)\n```/)
  const spoiler = spoilerMatch ? spoilerMatch[1] : ''
  const { answer, explanation } = spoiler ? parseSpoiler(spoiler) : { answer: '', explanation: '' }

  // 选项行：`- **A.** 文本`，后续非选项行并入前一个选项（支持多行选项）
  // spoiler 围栏（```spoiler-answer）整块跳过：内容行可能被拼接到最后一个选项的 text
  const lines = block.split('\n')
  const options: QuizOption[] = []
  let questionEnd = -1
  let cur: QuizOption | null = null
  let inSpoiler = false
  for (let i = 0; i < lines.length; i) {
    const line = lines[i]
    // 围栏切换：```spoiler 开头进入 spoiler 块，下一行 ``` 结束（整块内容不参与题干/选项提取）
    if (/^```spoiler/i.test(line)) { inSpoiler = !inSpoiler; i++; continue }
    if (inSpoiler) { i++; continue }
    const om = OPTION_RE.exec(line)
    if (om) {
      if (cur) options.push(cur)
      cur = { key: om[1].toUpperCase(), text: om[2] }
      if (questionEnd === -1) questionEnd = i
      i++
    } else if (cur && !/^\s*$/.test(line) && !line.startsWith('---')) {
      cur.text += '\n' + line
      i++
    } else {
      i++
    }
  }
  if (cur) options.push(cur)

  // 只有"有选项 + 有答案"才判为选择题
  if (options.length < 2 || !answer) return null

  // 题干 = 题头行之后的选项前内容（去掉 `### 第 N 题` 行，徽标由卡片自行显示）
  let question = questionEnd >= 0 ? lines.slice(0, questionEnd).join('\n').trim() : ''
  if (question && question.startsWith('###')) {
    question = question.replace(/^###\s+第\s*\d+\s*题(?:\s*[（(]\s*\d+\s*分\s*[）)])?\s*\n?/, '').trim()
  }

  return { no, points, question, options, answer, explanation }
}

/** 旧格式块 → 新 quiz 围栏 JSON 文本 */
function toQuizFence(q: QuizItem): string {
  const json = JSON.stringify(q)
  return '```quiz\n' + json + '\n```'
}

/**
 * 内容预处理：把旧 408 格式的选择题块替换为 ```quiz 围栏；
 * 非选择题块（大题/无法识别）原样保留。
 */
export function preprocessContent(content: string): string {
  if (!content || !content.includes('第') || !content.includes('```')) return content
  return content.replace(blockRegex(), (full: string, lead: string, body: string) => {
    const quiz = parseQuestionBlock(body)
    return quiz ? lead + toQuizFence(quiz) : full
  })
}

/** 结构校验（解析与宽容修复共用）：有 options≥2 且 answer 非空才算题 */
function asQuizItem(raw: unknown): QuizItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const q = raw as QuizItem
  if (
    !Array.isArray(q.options) || q.options.length < 2 ||
    typeof q.answer !== 'string' || !q.answer
  ) return null
  return q
}

/** 解析 ```quiz 围栏内的 JSON → QuizItem；非法返回 null */
export function parseQuizFence(text: string): QuizItem | null {
  try {
    return asQuizItem(JSON.parse(text.trim()))
  } catch {
    return null
  }
}

/**
 * 反向修复（v3.1.1 条目13）：字符串**内部**未转义英文双引号（如题干写 "底分" → JSON 被截断）。
 * 字符级状态机：在字符串内遇到 `"` 时看其后第一个非空白字符——
 * 是合法结构字符（, } ] :）则视为正常收尾；否则判定为内容引号，替换为中文引号后保持字符串状态重试。
 * 已合法的 JSON 不进本函数（调用方先 JSON.parse 成功即返回），不会被误改。
 */
export function repairJsonQuotes(text: string): string {
  let out = ''
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (!inStr) {
      if (c === '"') inStr = true
      out += c
      continue
    }
    if (c === '\\') { out += c + (text[i + 1] ?? ''); i++; continue } // 转义对原样保留
    if (c === '"') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      const nxt = text[j]
      if (nxt === undefined || ',}]:'.includes(nxt)) { inStr = false; out += c }
      else out += '”'
      continue
    }
    out += c
  }
  return out
}

/**
 * 宽容 JSON 解析（quiz/ask 围栏共用）：直解 → 全角瑕疵修复（引号/逗号→半角、尾逗号去除）→
 * 字符串内引号反向修复，逐级降级。失败返回 null。
 */
export function looseJsonParse(text: string): unknown {
  const t0 = text.trim()
  if (!t0) return null
  try { return JSON.parse(t0) } catch { /* 降级 */ }
  const t = t0.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[，,]\s*([}\]])/g, '$1')
  try { return JSON.parse(t) } catch { /* 降级 */ }
  try { return JSON.parse(repairJsonQuotes(t)) } catch { return null }
}

/** 宽容解析：AI 输出常见 JSON 瑕疵修复（全角引号/逗号→半角、尾逗号、字符串内未转义引号） */
export function parseQuizFenceLoose(text: string): QuizItem | null {
  return asQuizItem(looseJsonParse(text))
}

/** 从页面 Markdown 中提取全部可判题选择题（供刷题模式与卡片渲染共用） */
export function extractQuizzes(content: string): QuizItem[] {
  if (!content) return []
  const processed = preprocessContent(content)
  const out: QuizItem[] = []
  const re = /```quiz\s*\n(\{[\s\S]*?\})\n```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(processed)) !== null) {
    const q = parseQuizFence(m[1])
    if (q) out.push(q)
  }
  return out
}

/** 仅用于调试：统计一页有多少选择题（工具函数，供 devbridge 或脚本调用） */
export function countQuizzes(content: string): number {
  return extractQuizzes(content).length
}
