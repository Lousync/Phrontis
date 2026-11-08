/**
 * 题单答题 summary 纯函数（零依赖，渲染层 store 与 Node 契约脚本共用）。
 *
 * B-50 背景：summary 是 useSyncExternalStore 的快照，rebuild() 每次都换新对象会把
 * 页面级订阅者拖进无谓重渲染 —— 统计与「是否变化」的判定收进纯函数，语义由
 * .AGENT/scripts/quiz-tools/verify-quiz-preview-stability.mjs 钉住。
 */

export interface QuizSummary {
  answered: number
  wrong: number
  drafts: number
}

/** 题单条统计口径：已答 = 有 lastResult；草稿 = 未判题且简答框有字 */
export function computeQuizSummary(records: Array<{ lastResult: number | null; draft: { text?: string } | null }>): QuizSummary {
  let answered = 0
  let wrong = 0
  let drafts = 0
  for (const r of records) {
    if (r.lastResult != null) answered++
    if (r.lastResult === 0) wrong++
    if (r.lastResult == null && (r.draft?.text ?? '')) drafts++
  }
  return { answered, wrong, drafts }
}

/**
 * summary 是否变化：逐字段比较而非引用比较 —— store.rebuild() 用它做结构共享，
 * 数字没变时复用上一份快照对象，避免 useSyncExternalStore 因「每次 rebuild 都换新对象」
 * 把页面级订阅者（PageEditor）拖进无谓重渲染，连带打穿 MarkdownPreview 的 memo。
 */
export function quizSummaryEqual(a: QuizSummary, b: QuizSummary): boolean {
  return a.answered === b.answered && a.wrong === b.wrong && a.drafts === b.drafts
}
