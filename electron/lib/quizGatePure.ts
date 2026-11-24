/**
 * AI 教学 · 题单质量门 **接线层纯函数**（`course.organize.archive` 写盘前调用）
 *
 * 方案：`/home/lousync/Projects/DesginProcess/Phrontis/已实现设计文档/Phrontis-AI教学-技术方案-2026-11-19.md` §9
 *      `/home/lousync/Projects/DesginProcess/Phrontis/方案与调研/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md` E4（已拍板全做）
 *
 * 分工：四项能力（结构硬校验 / 字母指代 / 答案均衡 / 长度暗示）的实现全部在
 * `quizQualityPure.ts`（P0 契约面）。本文件只做「把 markdown 题单 → 题集 → 回写」的接线：
 *   · `extractQuizFences`     —— 按 ```quiz 围栏拆题（围栏外正文逐字保留）；
 *   · `applyQuizQualityGate`  —— 按设置档位产出「放行 / 退回重写 / 只告警」的结论；
 *   · `normalizeQuizQualityMode` —— 设置值归一（缺省 = strict，见 `src/lib/settings.ts`）。
 *
 * 三种档位（设置键 `aiTeachQuizQuality`）：
 *   · `strict`（默认）—— 结构硬校验不过 → **不写盘**，返回可被模型理解的重写提示；
 *     结构过了再均衡答案（确定性、幂等、只换选项文本与 answer）；最后检测长度暗示，
 *     命中 → 退回改写一次（重试上限由调用方 `allowRetry` 控制，见 `QUIZ_GATE_MAX_REWRITE`），
 *     第二次进来仍命中 → **放行 + 留轻提示**（方案原文「第二次放行并留轻提示」）。
 *   · `warn` —— 全部只检测：不拦、不改写，命中项进 `warnings`。
 *   · `off`  —— 直通：`content` 原样返回、`changed=false`、`warnings=[]`（旧行为逐字一致）。
 *
 * 保护规则（写死，本模块只对传入的**这一份**内容负责，不扫盘 = 旧卷不会被批量重排）：
 *   · 简答题跳过重排（`rebalanceAnswers` 内建）；
 *   · 题干 / 解析里有选项字母指代（「A 项」「选 B」）的题跳过重排但仍参与检测；
 *   · `recentKeys` 命中的题（records.json 里已有作答记录）不重排；
 *   · 幂等：同一份题单连过两遍质量门，第二遍 `changed=false` 且正文逐字不变。
 *
 * 零运行时依赖（只 import 同目录的 pure 模块），契约脚本 strip 类型后可直接跑。
 */

import type { QuizQuestion } from './quizQualityPure'
import { detectLengthBias, detectOptionLetterRefs, rebalanceAnswers, validateQuizDoc } from './quizQualityPure'
import { QUIZ_FENCE_RE, hasQuizFence } from './quizDocPure'

export type QuizQualityMode = 'strict' | 'warn' | 'off'

/** 设置值归一：只认 'warn' / 'off'，其余（含 undefined）一律 strict（与 settings 默认值一致）。 */
export function normalizeQuizQualityMode(value: unknown): QuizQualityMode {
  return value === 'warn' ? 'warn' : value === 'off' ? 'off' : 'strict'
}

/** strict 档「退回改写」上限：1 = 只退回一次，第二次必须放行（防无限循环）。 */
export const QUIZ_GATE_MAX_REWRITE = 1

export interface QuizGateWarning {
  /** structure=结构硬校验 / letter-ref=字母指代 / length-bias=长度暗示 / unbalanced=答案位置不均衡 / rewrite-exhausted=退回改写已用尽 */
  code: 'structure' | 'letter-ref' | 'length-bias' | 'unbalanced' | 'rewrite-exhausted'
  /** 命中的题号（全卷级问题为空） */
  nos?: number[]
  message: string
}

export interface QuizGateSummary {
  /** 围栏数量（```quiz 块数） */
  fences: number
  /** 成功解析出的题数 */
  total: number
  choice: number
  short: number
  /** 有选项字母指代的题号 */
  letterRefNos: number[]
  /** 本次实际发生重排的题数（warn 档 = 若均衡会动的题数） */
  rebalanced: number
}

export interface QuizGateInput {
  content: string
  mode?: QuizQualityMode
  /** 题号（字符串）→ 已记录答案 key；命中的题一律不重排 */
  recentKeys?: Record<string, string>
  /**
   * 本次是否还允许「退回重写」。调用方按会话 + 标题记次数，第一次 true、用尽后 false。
   * 缺省 true（纯函数默认允许一次退回）。
   */
  allowRetry?: boolean
}

export interface QuizGateResult {
  ok: boolean
  mode: QuizQualityMode
  /** 放行时要写盘的正文（off / 无围栏 / 被拦 → 原样返回） */
  content: string
  /** 正文是否被本模块改过（均衡 / 回写围栏） */
  changed: boolean
  /** true = 不写盘，把 `retryPrompt` 回给模型重出 */
  needsRewrite: boolean
  /** needsRewrite 或终止失败时给模型看的中文提示 */
  retryPrompt?: string
  /** 结构硬校验错误（strict 下 ∈ 拦截原因；warn 下只告警） */
  errors: string[]
  warnings: QuizGateWarning[]
  summary: QuizGateSummary
}

/* ---------------------------------------------------------------- 围栏拆分 / 回写 */

export interface QuizFence {
  /** 围栏正文（JSON 文本） */
  body: string
  /** 围栏标记行（含换行），回写时原样保留 */
  head: string
  /** 在原文中的起止（含围栏标记） */
  start: number
  end: number
  /** 解析出的题目对象；解析失败 / 不是对象 → null */
  question: Record<string, unknown> | null
  parseError?: string
}

/** 按 ```quiz 围栏拆题；围栏外的正文不进返回值，调用方按 start/end 拼接即可逐字保留。 */
export function extractQuizFences(content: string): QuizFence[] {
  const src = String(content ?? '')
  const out: QuizFence[] = []
  const re = new RegExp(QUIZ_FENCE_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const whole = m[0]
    const nl = whole.indexOf('\n')
    const body = m[1]
    let question: Record<string, unknown> | null = null
    let parseError: string | undefined
    try {
      const value: unknown = JSON.parse(body.trim())
      if (value && typeof value === 'object' && !Array.isArray(value)) question = value as Record<string, unknown>
      else parseError = '围栏内容不是单个 JSON 对象'
    } catch {
      parseError = 'JSON 解析失败（可能存在未转义英文双引号）'
    }
    out.push({ body, head: whole.slice(0, nl + 1), start: m.index, end: m.index + whole.length, question, parseError })
  }
  return out
}

/** 回写单个围栏：markdown 标记原样保留，正文换成规范化 JSON（2 空格缩进，便于人读）。 */
export function renderQuizFence(fence: QuizFence, question: Record<string, unknown>): string {
  return `${fence.head}${JSON.stringify(question, null, 2)}\n\`\`\``
}

/* ---------------------------------------------------------------- 文案 */

const LENGTH_REASON_TEXT: Record<string, string> = {
  'correct-long': '正确项明显偏长',
  'correct-short': '正确项明显偏短',
  spread: '卷内选项长度差过大（最长项唯一）',
}

const STRUCTURE_RULES = '每题一个 ```quiz 围栏、no 从 1 连续编号、选择题至少 2 个选项且 key 不重复、answer 必须是某个选项 key、选择题必须有解析、简答题必须有参考答案'

function joinNos(nos: number[]): string {
  return nos.join('、')
}

function structureRetryPrompt(errors: string[], terminal: boolean): string {
  const head = terminal
    ? '题单未写入（结构硬校验未通过，已退回改写一次仍不合格）'
    : '题单未写入（结构硬校验未通过）'
  const body = errors.slice(0, 6).join('；')
  const tail = errors.length > 6 ? `…（共 ${errors.length} 处）` : ''
  return `${head}：${body}${tail}。请修正后整卷重新提交（调用 course.organize.archive，不要只发修正片段）：${STRUCTURE_RULES}。`
}

function lengthRetryPrompt(flags: Array<{ no: number; text: string }>): string {
  const items = flags.map((f) => `第 ${f.no} 题${f.text}`).join('；')
  return `题单未写入（长度暗示未通过）：${items}。请改写这些题的选项文本，让正确项与干扰项长度接近（不要靠拉长干扰项凑字数），再整卷重新提交；本卷只退回改写一次。`
}

/* ---------------------------------------------------------------- 质量门主函数 */

const EMPTY_SUMMARY: QuizGateSummary = { fences: 0, total: 0, choice: 0, short: 0, letterRefNos: [], rebalanced: 0 }

export function applyQuizQualityGate(input: QuizGateInput): QuizGateResult {
  const content = String(input?.content ?? '')
  const mode = input?.mode ?? 'strict'
  const allowRetry = input?.allowRetry !== false
  const base = { mode, content, changed: false, needsRewrite: false, errors: [] as string[], warnings: [] as QuizGateWarning[] }

  // off：完全走旧路径（逐字返回，连围栏都不解析）
  if (mode === 'off') return { ...base, ok: true, summary: { ...EMPTY_SUMMARY } }

  const fences = extractQuizFences(content)
  if (!fences.length) {
    // 有围栏开头却一个都拆不出来（典型：漏写结尾 ```）：这是结构错误，不能静默放行。
    if (!hasQuizFence(content)) return { ...base, ok: true, summary: { ...EMPTY_SUMMARY } }
    const errors = ['题单围栏未闭合（缺少结尾 ```）']
    const summary = { ...EMPTY_SUMMARY }
    if (mode === 'warn') {
      return {
        ...base,
        ok: true,
        errors,
        warnings: [{ code: 'structure', message: `结构校验：${errors[0]}` }],
        summary,
      }
    }
    return {
      ...base,
      ok: false,
      needsRewrite: allowRetry,
      retryPrompt: structureRetryPrompt(errors, !allowRetry),
      errors,
      summary,
    }
  }

  // 1) 围栏解析失败 = 结构问题（模型给的不是合法 JSON 对象）
  const errors: string[] = []
  const questionFences: number[] = []
  fences.forEach((f, idx) => {
    if (!f.question) {
      const at = fences.length === 1 ? '题单围栏' : `第 ${idx + 1} 个 quiz 围栏`
      errors.push(`${at}：${f.parseError ?? '无法解析'}`)
      return
    }
    questionFences.push(idx)
  })
  const questions = questionFences.map((fi) => fences[fi].question as unknown as QuizQuestion)

  // 2) 结构硬校验（题号 1..N / 选项 / answer / 解析 / 参考答案）
  const validation = validateQuizDoc(questions)
  errors.push(...validation.errors)

  // 3) 字母指代（既影响重排安全，也影响解析正确性）
  const letterRefNos: number[] = []
  for (const q of questions) {
    const no = typeof q?.no === 'number' ? q.no : 0
    if (detectOptionLetterRefs(`${q?.question ?? ''}\n${q?.explanation ?? ''}`)) letterRefNos.push(no)
  }

  const summary: QuizGateSummary = {
    fences: fences.length,
    total: questions.length,
    choice: questions.filter((q) => q?.type !== 'short').length,
    short: questions.filter((q) => q?.type === 'short').length,
    letterRefNos,
    rebalanced: 0,
  }

  // 4) 均衡（幂等）：warn 档只算「会动几题」，不改内容
  const balanced = rebalanceAnswers(questions, { recentKeys: input?.recentKeys })
  const replacements = new Map<number, string>() // questionFences 下标 → 新围栏文本
  for (let i = 0; i < questions.length; i++) {
    if (JSON.stringify(balanced[i]) === JSON.stringify(questions[i])) continue
    summary.rebalanced += 1
    if (mode === 'strict') {
      replacements.set(i, renderQuizFence(fences[questionFences[i]], balanced[i] as unknown as Record<string, unknown>))
    }
  }

  // 5) 长度暗示（对均衡后的题集检测：重排只换文本位置，正确项文本长度不变）
  const lengthFlags = detectLengthBias(balanced).flagged.map((f) => ({
    no: f.no,
    reason: String(f.reason),
    text: LENGTH_REASON_TEXT[String(f.reason)] ?? String(f.reason),
  }))

  /* -------------------------------------------------- warn：只检测，不拦不改 */
  if (mode === 'warn') {
    const warnings: QuizGateWarning[] = []
    if (errors.length) warnings.push({ code: 'structure', message: `结构校验：${errors.slice(0, 6).join('；')}${errors.length > 6 ? `…（共 ${errors.length} 处）` : ''}` })
    if (letterRefNos.length) warnings.push({ code: 'letter-ref', nos: letterRefNos, message: `第 ${joinNos(letterRefNos)} 题题干/解析用选项字母指代（如「A 项」「选 B」），重排后指代会错` })
    for (const f of lengthFlags) warnings.push({ code: 'length-bias', nos: [f.no], message: `第 ${f.no} 题${f.text}` })
    if (summary.rebalanced) warnings.push({ code: 'unbalanced', message: `答案位置不均衡：${summary.rebalanced} 题可优化（strict 档会自动均衡）` })
    return { ...base, ok: true, errors, warnings, summary }
  }

  /* -------------------------------------------------- strict：先拦结构，再均衡，再拦长度 */
  if (errors.length) {
    const prompt = structureRetryPrompt(errors, !allowRetry)
    return { ...base, ok: false, needsRewrite: allowRetry, retryPrompt: prompt, errors, summary }
  }

  if (lengthFlags.length && allowRetry) {
    return { ...base, ok: false, needsRewrite: true, retryPrompt: lengthRetryPrompt(lengthFlags), errors: [], summary }
  }

  // 放行：把均衡结果写回围栏（没动的围栏原样保留，便于人读 / 幂等）
  let out = ''
  let cursor = 0
  let changed = false
  for (let i = 0; i < fences.length; i++) {
    const f = fences[i]
    const qi = questionFences.indexOf(i)
    const replacement = qi >= 0 ? replacements.get(qi) : undefined
    out += content.slice(cursor, f.start)
    out += replacement ?? content.slice(f.start, f.end)
    if (replacement) changed = true
    cursor = f.end
  }
  out += content.slice(cursor)

  const warnings: QuizGateWarning[] = []
  if (letterRefNos.length) warnings.push({ code: 'letter-ref', nos: letterRefNos, message: `第 ${joinNos(letterRefNos)} 题题干/解析用选项字母指代，已跳过重排；下次出题请改用内容指代` })
  if (lengthFlags.length) {
    for (const f of lengthFlags) warnings.push({ code: 'rewrite-exhausted', nos: [f.no], message: `第 ${f.no} 题${f.text}（已退回改写一次，本次放行）` })
  }

  return { ...base, ok: true, content: changed ? out : content, changed, errors, warnings, summary }
}
