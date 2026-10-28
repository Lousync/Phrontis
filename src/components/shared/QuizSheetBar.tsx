import { useMemo } from 'react'
import { ListChecks, RotateCcw } from 'lucide-react'
import type { QuizItem } from './QuizParser'
import { useQuizRecords, type QuizRecordStore } from './QuizRecordStore'

/**
 * 题单状态条：阅读态标题下的一条紧凑栏。
 * 计数按当前文档里的 quizzes 过滤，避免题目从文档删掉后旧记录把数字撑大。
 */
export function QuizSheetBar({ quizzes, store, onReview }: {
  quizzes: QuizItem[]
  store: QuizRecordStore
  onReview: () => void
}) {
  const records = useQuizRecords(store)
  const byNo = useMemo(() => new Map(records.map(r => [r.quizNo, r])), [records])
  const total = quizzes.length
  const answered = quizzes.filter(q => byNo.get(q.no)?.lastResult != null).length
  const wrong = quizzes.filter(q => byNo.get(q.no)?.lastResult === 0).length
  const drafts = quizzes.filter(q => {
    if (q.type !== 'short') return false
    const r = byNo.get(q.no)
    return r?.lastResult == null && !!(r?.draft?.text ?? '')
  }).length

  return (
    <div className="mb-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 flex items-center gap-3 kb-view-in">
      <span className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-md bg-[var(--accent)]/10 text-[var(--accent)]">
        <ListChecks size={14} />
      </span>
      <div className="min-w-0 flex items-center gap-2 text-[11.5px] text-[var(--text-secondary)] flex-wrap">
        <span className="font-medium text-[var(--text-primary)]">题单</span>
        <span>已答 {answered}/{total}</span>
        {wrong > 0 && <span className="text-[var(--danger)]">错题 {wrong}</span>}
        {drafts > 0 && <span className="text-[var(--text-muted)]">草稿 {drafts}</span>}
      </div>
      <div className="flex-1" />
      <button
        onClick={onReview}
        disabled={wrong === 0}
        className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-[var(--border-color)] text-[11.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:cursor-default transition-colors"
        title={wrong === 0 ? '当前没有判错的题' : '只重做当前题单判错的题，带着上次答案'}
      >
        <RotateCcw size={12} />
        错题重做 ({wrong})
      </button>
    </div>
  )
}
