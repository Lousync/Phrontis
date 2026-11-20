/**
 * AI 教学 · 题单质量门 **纯函数**（P0 契约面）
 *
 * 方案：`/home/lousync/桌面/Phrontis-AI教学-技术方案-2026-11-19.md` §9
 *      `/home/lousync/桌面/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md` E4（已拍板全做）
 *
 * 四项能力（零运行时依赖，契约脚本 strip 类型后直接跑真实实现）：
 *   · `validateQuizDoc`       —— 4.4 结构硬校验（题号 1..N、选项 ≥2 且 key 唯一、answer 合法、
 *                                选择题解析非空、简答题参考答案非空、选项文本不重复）；
 *   · `detectOptionLetterRefs` —— 4.3 前置检测：题干 / 解析里出现「A 项 / 选 B / 选项 C / A.」；
 *   · `rebalanceAnswers`      —— 4.1 确定性、幂等答案均衡（跳过简答 / 字母指代 / recentKeys）；
 *   · `detectLengthBias`      —— 4.2 长度暗示（correct-long / correct-short / spread）。
 *
 * 重排口径（写死，避免实现漂移）：
 *   · 槽位 key 恒为原数组顺序（通常 A/B/C/D），**只交换选项文本**并重写 answer；
 *     这样渲染层按下标展示 key，不会出现「B. 排在第一行」的错位；
 *   · 跳过项完全不动（旧卷 / 已记录答案的题不被二次打乱）；
 *   · 旧卷不批量重排由调用方决定，本模块只对传入的题集负责。
 */

export interface QuizOption {
  key: string
  text: string
}

export interface QuizQuestion {
  no: number
  question: string
  options?: QuizOption[]
  answer?: string
  explanation?: string
  referenceAnswer?: string
  type?: 'short'
}

export type LengthBiasReason = 'correct-long' | 'correct-short' | 'spread'

export interface LengthBiasFlag {
  no: number
  reason: LengthBiasReason
}

/* ------------------------------------------------------------------ 结构校验 */

function isShort(q: QuizQuestion): boolean {
  return q.type === 'short'
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 结构硬校验。返回全部问题（不遇错即停），调用方可用 `ok` 决定是否退回让模型改写。
 * 空题集视为不通过（题单至少要有 1 题）。
 */
export function validateQuizDoc(qs: QuizQuestion[]): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  const list = Array.isArray(qs) ? qs : []
  if (!list.length) {
    errors.push('题单为空（至少 1 题）')
    return { ok: false, errors }
  }

  const seenNo = new Set<number>()
  for (let i = 0; i < list.length; i++) {
    const q = list[i]
    const at = `第 ${i + 1} 题`
    const no = typeof q?.no === 'number' && Number.isFinite(q.no) ? q.no : NaN
    if (!Number.isInteger(no) || no !== i + 1) {
      errors.push(`${at}：题号应为 ${i + 1}，实际为 ${String(q?.no)}`)
    } else if (seenNo.has(no)) {
      errors.push(`${at}：题号 ${no} 重复`)
    }
    if (Number.isInteger(no)) seenNo.add(no)

    if (!textOf(q?.question).trim()) errors.push(`${at}：题干为空`)

    if (isShort(q)) {
      if (!textOf(q.referenceAnswer).trim()) errors.push(`${at}：简答题缺少参考答案`)
      continue
    }

    const options = Array.isArray(q?.options) ? q.options : []
    if (options.length < 2) {
      errors.push(`${at}：选择题至少需要 2 个选项`)
    }
    const keys = new Set<string>()
    const texts = new Set<string>()
    for (const opt of options) {
      const key = textOf(opt?.key).trim()
      const text = textOf(opt?.text).trim()
      if (!key) errors.push(`${at}：存在空选项 key`)
      else if (keys.has(key)) errors.push(`${at}：选项 key ${key} 重复`)
      else keys.add(key)
      if (!text) errors.push(`${at}：选项 ${key || '?'} 文本为空`)
      else if (texts.has(text)) errors.push(`${at}：选项文本重复「${text}」`)
      else texts.add(text)
    }

    const answer = textOf(q?.answer).trim()
    if (!answer) {
      errors.push(`${at}：选择题缺少 answer`)
    } else if (!keys.has(answer)) {
      errors.push(`${at}：answer「${answer}」不在选项 key 中`)
    }

    if (!textOf(q?.explanation).trim()) errors.push(`${at}：选择题缺少解析`)
  }

  return { ok: errors.length === 0, errors }
}

/* ------------------------------------------------------------------ 字母指代 */

/**
 * 题干 / 解析里是否用选项字母指代内容。
 * 判据（宁可多报一次，让模型重写解析）：`A 项` / `选 B` / `选项 C` / `A.` / `(D)` / `答案：B`。
 * 不匹配普通英文缩写或 `ABC 猜想`（大写字母后必须跟中文量词或标点边界）。
 */
export function detectOptionLetterRefs(text: string): boolean {
  const src = String(text ?? '')
  if (!src) return false
  const patterns = [
    /选项\s*[A-H]{1,4}(?![A-Za-z])/,
    /[A-H]{1,4}\s*项(?![目])/,
    /(?:^|[^A-Za-z])选\s*[A-H]{1,4}(?![A-Za-z])/,
    /(?:答案|正确选项|应选)\s*[:：为是]?\s*[A-H]{1,4}(?![A-Za-z])/,
    /(?:^|[\s，。；：、（(【\[])[A-H]{1,4}\s*[.．、)）】\]]/,
  ]
  return patterns.some((re) => re.test(src))
}

/* ------------------------------------------------------------------ 答案均衡 */

function choiceKeys(q: QuizQuestion): string[] {
  const opts = Array.isArray(q.options) ? q.options : []
  return opts.map((o) => textOf(o?.key).trim()).filter(Boolean)
}

function optionLengths(q: QuizQuestion): number[] {
  const opts = Array.isArray(q.options) ? q.options : []
  return opts.map((o) => textOf(o?.text).trim().length)
}

/**
 * 确定性答案均衡：按 no 顺序把正确项轮换到各槽位，目标分布尽量均分且不出现连续 3 题同答案。
 * 幂等（同输入跑两次结果完全相同）；跳过简答题 / 字母指代题 / `recentKeys` 已记录的题。
 *
 * @param recentKeys 题号（字符串）→ 已记录答案 key；命中的题一律不动。
 */
export function rebalanceAnswers(
  qs: QuizQuestion[],
  opts?: { recentKeys?: Record<string, string> },
): QuizQuestion[] {
  const list = Array.isArray(qs) ? qs : []
  const recent = opts?.recentKeys ?? {}
  const counts = new Map<string, number>()
  let lastKey: string | null = null
  let run = 0
  let eligibleIndex = 0

  const bumped = (key: string, has: boolean) => {
    if (!has) return
    if (key === lastKey) run += 1
    else {
      lastKey = key
      run = 1
    }
  }

  return list.map((q) => {
    const copy: QuizQuestion = { ...q, options: Array.isArray(q.options) ? q.options.map((o) => ({ ...o })) : q.options }
    if (isShort(q)) {
      // 简答题不参与均衡，也不打断选择题的「连续同答案」判断之外的逻辑
      return copy
    }
    const keys = choiceKeys(q)
    if (keys.length < 2) return copy

    const answer = textOf(q.answer).trim()
    const refs = detectOptionLetterRefs(`${textOf(q.question)}\n${textOf(q.explanation)}`)
    const protectedByRecent = Object.prototype.hasOwnProperty.call(recent, String(q.no))

    if (refs || protectedByRecent) {
      // 冻结：保留原顺序与答案，但仍计入分布 / 连号统计，避免后面的题撞出 3 连
      const frozenKey = keys.includes(answer) ? answer : keys[0]
      counts.set(frozenKey, (counts.get(frozenKey) ?? 0) + 1)
      bumped(frozenKey, true)
      return copy
    }

    const start = eligibleIndex % keys.length
    eligibleIndex += 1

    const ordered = keys
      .map((key, idx) => ({ key, idx, dist: (idx - start + keys.length) % keys.length }))
      .sort((a, b) => a.dist - b.dist)

    const candidates = ordered.filter((c) => !(c.key === lastKey && run >= 2))
    const pool = candidates.length ? candidates : ordered
    let target = pool[0].key
    let minCount = Number.POSITIVE_INFINITY
    for (const c of pool) {
      const n = counts.get(c.key) ?? 0
      if (n < minCount) {
        minCount = n
        target = c.key
      }
    }

    const targetIdx = keys.indexOf(target)
    const correctIdx = keys.indexOf(answer)
    if (correctIdx >= 0 && correctIdx !== targetIdx) {
      const targetOption = copy.options![targetIdx]
      const correctOption = copy.options![correctIdx]
      const tmp = targetOption.text
      targetOption.text = correctOption.text
      correctOption.text = tmp
    }
    if (correctIdx >= 0) copy.answer = target

    counts.set(target, (counts.get(target) ?? 0) + 1)
    bumped(target, true)
    return copy
  })
}

/* ------------------------------------------------------------------ 长度偏置 */

function median(nums: number[]): number {
  if (!nums.length) return 0
  const sorted = nums.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * 4.2 长度暗示检测（只标不改，调用方决定「先拒绝一次」）。
 *   · 单题：正确项长度 / 其余选项中位数 > 1.35 → correct-long；< 0.75 → correct-short；
 *   · 全卷：所有选项文本 最长 / 最短 > 2.2 且最长项唯一 → 该题标 spread（简答题不参与）。
 */
export function detectLengthBias(qs: QuizQuestion[]): {
  flagged: Array<{ no: number; reason: LengthBiasReason }>
} {
  const flagged: LengthBiasFlag[] = []
  const list = Array.isArray(qs) ? qs : []
  const allLengths: Array<{ no: number; len: number }> = []

  for (const q of list) {
    if (!q || isShort(q)) continue
    const opts = Array.isArray(q.options) ? q.options : []
    if (opts.length < 2) continue
    const lengths = optionLengths(q)
    allLengths.push(...lengths.map((len) => ({ no: q.no, len })))

    const keys = choiceKeys(q)
    const answer = textOf(q.answer).trim()
    const correctIdx = keys.indexOf(answer)
    if (correctIdx < 0) continue
    const correctLen = lengths[correctIdx] ?? 0
    const others = lengths.filter((_, idx) => idx !== correctIdx)
    const othersMedian = median(others)
    if (othersMedian <= 0) continue
    const ratio = correctLen / othersMedian
    if (ratio > 1.35) flagged.push({ no: q.no, reason: 'correct-long' })
    else if (ratio < 0.75) flagged.push({ no: q.no, reason: 'correct-short' })
  }

  if (allLengths.length >= 2) {
    let min = Number.POSITIVE_INFINITY
    let max = 0
    let maxCount = 0
    let maxNo: number | null = null
    for (const item of allLengths) {
      if (item.len < min) min = item.len
      if (item.len > max) {
        max = item.len
        maxCount = 1
        maxNo = item.no
      } else if (item.len === max) {
        maxCount += 1
      }
    }
    if (maxNo !== null && min > 0 && maxCount === 1 && max / min > 2.2) {
      flagged.push({ no: maxNo, reason: 'spread' })
    }
  }

  return { flagged }
}
