/**
 * AI 教学「对话」模式 · 每轮辅导协议（纯函数，零依赖）。
 *
 * 依据：`docs/deeptutor-teaching-modes-research.md` §5（Solve 提示阶梯 / Reading 三层地图 / Ask 一次澄清）。
 * 主进程在 `agentService` 里把 `buildTutorProtocolHint(本轮方式)` 并入现有 `teachStyleHint` 分区
 * （不改 `AiTeachInjectionStats` 的 7 段结构）；`chat` 返回空串 = 不加硬规则。
 *
 * 本文件不 import 任何模块（契约脚本 strip 类型后可直接执行）。
 */

/** 每轮辅导方式（'auto' 只在渲染层存在，主进程不识别） */
export type TutorTurnMode = 'chat' | 'read' | 'solve' | 'ask'

/** 渲染层随请求带的当前资料（主进程会再截一次 3000 字，双保险） */
export interface TutorReadingContext {
  relPath: string
  kind: 'pdf' | 'epub' | 'txt' | 'md'
  /** PDF 页码（1-based） */
  page?: number
  /** 章节 / 小节名 */
  label?: string
  /** 渲染层已截到 ≤3000 字的当前页文本 */
  text: string
}

const TUTOR_TURN_MODES: readonly TutorTurnMode[] = ['chat', 'read', 'solve', 'ask']

/** 白名单校验：非法 / 缺省 → 'chat'（主进程只认这四种） */
export function normalizeTutorTurnMode(value: unknown): TutorTurnMode {
  return TUTOR_TURN_MODES.includes(value as TutorTurnMode) ? (value as TutorTurnMode) : 'chat'
}

/** 当前资料正文上限：渲染层已截断，主进程再做一次（方案 §2.4 / §五 开放点 5） */
export const TUTOR_READING_TEXT_CAP = 3000

const ASK_HINT = [
  '',
  '',
  '【本轮方式：先问我】先澄清再回答，不硬猜：',
  '1. 只在确实缺关键约束时发问，最多一个 ```ask 围栏；给 2–6 个选项，并允许用户自由输入。',
  '2. 不问已经回答过的问题，也不问「要不要继续」这类低信息量问题。',
  '3. 用户在同一轮给出答案后，直接继续完成原请求，不要重复确认。',
  '4. 除澄清卡外的正文保持简短；答完按普通对话继续。',
].join('\n')

const SOLVE_HINT = [
  '',
  '',
  '【本轮方式：解题（提示优先）】按提示阶梯推进，不要一上来倒完整答案：',
  '1. 先问一句「你卡在哪一步」；用户说「直接给答案」就跳过这一步。',
  '2. 一级提示：只给方向与涉及的知识点，不给答案。',
  '3. 二级提示：给关键步骤或公式，仍不写最终结果。',
  '4. 用户仍要答案时再给完整解：步骤 + 考点 + 易错点。',
  '5. 最后附 2 道同类变式，写在 ```quiz 围栏里；题号从 1 重排为 1..N，不要沿用原页题号。',
  '6. 引用题目时保留题干关键条件；不要编造图中没有的数据。',
].join('\n')

const READ_HINT = [
  '',
  '',
  '【本轮方式：讲解（单份资料伴读）】按三层讲解协议：',
  '1. 开头先给三句地图：这份资料讲什么、整体结构、先知道什么。',
  '2. 问用户想听哪一层：直觉 / 推导 / 例题 / 考点；用户没选时从直觉层开始。',
  '3. 每次只讲一层，讲完给一个具体检查问题并停下等待回答，不要一次讲完所有层。',
  '4. 引用原文时带页码 `[p.N]` 或小节名；没有读到原文就明确说「这是通用解释，不是原文」。',
  '5. 不臆造资料没有的内容；资料没覆盖的地方直接说明缺口。',
].join('\n')

/** 每轮协议提示词：`chat` 为空串（零成本）；其余三种按调研 §5 的硬规则。 */
export function buildTutorProtocolHint(mode: TutorTurnMode): string {
  switch (mode) {
    case 'ask':
      return ASK_HINT
    case 'solve':
      return SOLVE_HINT
    case 'read':
      return READ_HINT
    default:
      return ''
  }
}

/**
 * 当前资料注入（**用户消息层**，由 agentService 放进 requestInjection，不进 system）：
 * 逐轮会变（翻页 / 换资料），进 system 会每轮作废 prompt cache 前缀。
 * `text` 为空 → 空串（逐字不变）；超过 3000 字截断并注明「只读了前 3000 字」。
 */
export function buildTutorReadingInjection(reading: TutorReadingContext | null | undefined): string {
  const raw = String(reading?.text ?? '').trim()
  if (!raw || !reading) return ''
  const clipped = raw.slice(0, TUTOR_READING_TEXT_CAP)
  const truncated = raw.length > TUTOR_READING_TEXT_CAP
  const where = reading.page
    ? `第 ${reading.page} 页`
    : (reading.label ? `章节「${reading.label}」` : '当前资料')
  return [
    '',
    '',
    `【当前资料】${String(reading.relPath ?? '')}（${where}）`,
    '以下是渲染层读取到的当前资料文本（可能只是本页 / 本节，也可能被截断）：',
    clipped,
    truncated ? `（只读了前 ${TUTOR_READING_TEXT_CAP} 字）` : '',
    '引用原文时带页码 `[p.N]` 或小节名，不要改写原文数字与符号；',
    '这段文本之外的内容没有读到：需要时先说明，或明确写「这是通用解释，不是原文」。',
  ].filter((line, idx) => line !== '' || idx < 2).join('\n')
}
