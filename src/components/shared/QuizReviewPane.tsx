import { RotateCcw, X } from 'lucide-react'
import type { QuizItem } from './QuizParser'
import { QuizCard } from './QuizCard'
import { ShortAnswerCard } from './ShortAnswerCard'

/**
 * 题单内错题重做子视图（不是中央模态）。
 * 进入时由 PageEditor 冻结错题号；重做过程中卡片状态实时更新，退出后题单条按最新记录重算。
 */
export function QuizReviewPane({ quizzes, onExit }: {
  quizzes: QuizItem[]
  onExit: () => void
}) {
  const list = [...quizzes].sort((a, b) => a.no - b.no)
  return (
    <div className="kb-view-in">
      <div className="mb-3 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/5 px-3 py-2 flex items-center gap-3">
        <span className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-md bg-[var(--warning)]/15 text-[var(--warning)]">
          <RotateCcw size={14} />
        </span>
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-[var(--text-primary)]">
            错题重做<span className="ml-1.5 text-[var(--text-muted)]">{list.length} 题</span>
          </div>
          <div className="text-[10.5px] text-[var(--text-muted)]">只显示当前题单判错的题；带着上次答案重做，参考答案默认收起。</div>
        </div>
        <div className="flex-1" />
        <button
          onClick={onExit}
          className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-[var(--border-color)] text-[11.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
        >
          <X size={12} />
          退出重做
        </button>
      </div>
      {list.length === 0 ? (
        <div className="py-8 text-center text-[12px] text-[var(--text-muted)]">当前题单没有需要重做的错题。</div>
      ) : (
        list.map(q => q.type === 'short'
          ? <ShortAnswerCard key={`short-${q.no}`} quiz={q} redo />
          : <QuizCard key={`choice-${q.no}`} quiz={q} redo />)
      )}
    </div>
  )
}
