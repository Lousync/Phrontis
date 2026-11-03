import type { QuizItem } from './QuizParser'
import type { QuizRecordDto } from '../../types'

/**
 * 题单「提取答案」的纯函数：把当前作答整理成一段可直接粘给 AI 判题的文本。
 *
 * 口径（2026-11-03 拍板）：
 * - 只导出「作答」，不导出正确答案 / 解析 / 自评 / 错题次数；
 * - 题号升序，未作答也列出；
 * - 选择题只写选项 key；简答题保留原始换行；
 * - 头部带一句判分指令，带题单标题，不带页码。
 */
export interface AnswerExportInput {
  title?: string
  quizzes: QuizItem[]
  records: QuizRecordDto[]
}

export interface AnswerExportResult {
  text: string
  /** 有作答的题数（选择 + 简答） */
  answered: number
  choiceAnswered: number
  shortAnswered: number
  total: number
}

export function buildAnswerExport(input: AnswerExportInput): AnswerExportResult {
  const byNo = new Map<number, QuizRecordDto>()
  for (const r of input.records ?? []) byNo.set(r.quizNo, r)
  const quizzes = [...(input.quizzes ?? [])].sort((a, b) => a.no - b.no)
  const title = String(input.title ?? '').trim() || '当前题单'
  const lines = [
    `【题单作答】《${title}》`,
    '请对照本题单判分，逐题给出对错与解析；简答题按要点给分。',
    '',
  ]
  let answered = 0
  let choiceAnswered = 0
  let shortAnswered = 0

  for (const q of quizzes) {
    const r = byNo.get(q.no)
    if (q.type === 'short') {
      const raw = String(r?.draft?.text ?? '').replace(/\r\n/g, '\n')
      if (raw.trim()) {
        answered++
        shortAnswered++
        // 保留原始缩进与内部换行；只去掉尾部空白，避免复制块末尾空行
        lines.push(`${q.no}. [简答]`, raw.replace(/\s+$/, ''))
      } else {
        lines.push(`${q.no}. [简答] 未作答`)
      }
      continue
    }
    const picked = String(r?.draft?.picked ?? '').trim()
    if (picked) {
      answered++
      choiceAnswered++
      lines.push(`${q.no}. [选择] ${picked}`)
    } else {
      lines.push(`${q.no}. [选择] 未作答`)
    }
  }

  return {
    text: lines.join('\n'),
    answered,
    choiceAnswered,
    shortAnswered,
    total: quizzes.length,
  }
}
