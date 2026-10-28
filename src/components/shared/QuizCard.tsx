import React, { useEffect, useRef, useState } from 'react'
import { Check, X, Star, RotateCcw } from 'lucide-react'
import { MarkdownPreview } from './MarkdownPreview'
import type { QuizItem } from './QuizParser'
import { useQuizRecord, useQuizStore, useQuizStoreActive } from './QuizRecordStore'

interface Props {
  quiz: QuizItem
  /** 页面内全局序号（0 起），仅用于调试标记，非必需 */
  index?: number
  /** 作答回调（供统计/刷题模式汇总） */
  onAnswered?: (correct: boolean) => void
  /** 来源页面 ID（保留兼容；状态/收藏由页面级 store 负责） */
  pageId?: string
  /** 来源页面标题（用于错题本快照） */
  pageTitle?: string
  /** 错题重做：带着上次选项重做，不自动展开解析 */
  redo?: boolean
}

/**
 * 选择题判题卡片：点选选项立即判题。
 * 答对 → 选项变绿并自动滚动到下一题；答错 → 选项变红 + 正确项高亮 + 展开解析。
 * 支持键盘 1-4 / A-D 作答（卡片聚焦时）。
 *
 * 状态真源是页面级 QuizRecordStore（picked / lastResult）；无 store（AI 聊天单题快检）
 * 时退化为本地状态，可判题但不落盘、不显示收藏。
 */
export function QuizCard({ quiz, index, onAnswered, redo = false }: Props) {
  const store = useQuizStore()
  const record = useQuizRecord(store, quiz.no)
  const persist = useQuizStoreActive(store)
  const snapshot = () => ({
    no: quiz.no,
    type: 'choice' as const,
    question: quiz.question,
    options: quiz.options,
    answer: quiz.answer,
    explanation: quiz.explanation,
  })

  const [picked, setPicked] = useState<string | null>(null)
  const [fallbackCorrect, setFallbackCorrect] = useState<boolean | null>(null)
  const [showExplanation, setShowExplanation] = useState(false)
  const [redoLocal, setRedoLocal] = useState(false)
  const [redoDone, setRedoDone] = useState(false)
  const hydratedRef = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const isRedo = (redo || redoLocal) && !redoDone
  const storedCorrect = persist ? (record?.lastResult ?? null) : null
  const correct = isRedo
    ? null
    : (fallbackCorrect == null ? storedCorrect : (fallbackCorrect ? 1 : 0))
  const effectivePicked = isRedo ? null : (picked ?? record?.draft?.picked ?? null)
  const answered = !isRedo && (correct != null || effectivePicked != null)
  const isCorrect = correct === 1 || (correct == null && effectivePicked != null && effectivePicked === quiz.answer)

  // 首次载入记录：恢复上次选项/错题解析；只填一次，不覆盖用户刚点的选项
  useEffect(() => {
    if (hydratedRef.current || !record) return
    hydratedRef.current = true
    if (record.draft?.picked) setPicked(record.draft.picked)
    if (!redo && record.lastResult === 0) setShowExplanation(true)
  }, [record, redo])

  // 父级 redo：同一张卡可能被复用，重置本地判题/解析
  useEffect(() => {
    if (!redo) return
    setPicked(null)
    setFallbackCorrect(null)
    setShowExplanation(false)
    setRedoDone(false)
    setRedoLocal(false)
  }, [redo])

  const scrollToNext = () => {
    const root = rootRef.current
    if (!root) return
    const myTop = root.getBoundingClientRect().top
    const next = Array.from(document.querySelectorAll<HTMLElement>('[data-quiz-card]'))
      .filter(el => el !== root && el.getBoundingClientRect().top > myTop - 4)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]
    if (next) next.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const pick = (key: string) => {
    if (answered) return
    setPicked(key)
    setFallbackCorrect(key === quiz.answer)
    setRedoDone(true)
    setRedoLocal(false)
    const ok = key === quiz.answer
    onAnswered?.(ok)
    if (persist) {
      void store!.report(quiz.no, ok, snapshot(), key)
    }
    if (ok) {
      // 答对自动过掉：短暂反馈后滚动到下一题
      window.setTimeout(scrollToNext, 600)
    } else {
      setShowExplanation(true)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!answered) {
      const n = parseInt(e.key, 10)
      if (n >= 1 && n <= quiz.options.length) {
        e.preventDefault()
        pick(quiz.options[n - 1].key)
        return
      }
      const k = e.key.toUpperCase()
      const hit = quiz.options.find(o => o.key === k)
      if (hit) {
        e.preventDefault()
        pick(hit.key)
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      scrollToNext()
    }
  }

  const enterRedo = () => {
    setRedoLocal(true)
    setRedoDone(false)
    setPicked(null)
    setFallbackCorrect(null)
    setShowExplanation(false)
  }

  const toggleFav = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!persist) return
    void store!.toggleFavorite(quiz.no, snapshot())
  }

  const fav = record?.isFavorite ?? false
  const prevPicked = record?.draft?.picked ?? null

  return (
    <div
      ref={rootRef}
      data-quiz-card
      data-quiz-index={index}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={`my-3 rounded-lg border transition-colors select-none outline-none ${
        answered && isCorrect
          ? 'border-[var(--success)]/60'
          : answered
            ? 'border-[var(--danger)]/50'
            : isRedo
              ? 'border-[var(--warning)]/40'
              : 'border-[var(--border-color)] hover:border-[var(--border-color-secondary,var(--border-color))]'
      }`}
    >
      {/* 卡片头：题号 + 状态 */}
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
        <span className="text-[12px] font-medium text-[var(--text-primary)]">
          第 {quiz.no} 题
        </span>
        {persist && (
          <button
            onClick={toggleFav}
            title={fav ? '取消收藏' : '收藏此题'}
            className={`inline-flex items-center justify-center w-6 h-6 rounded transition-colors ${
              fav ? 'text-[#f5b301]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            <Star key={fav ? 'on' : 'off'} size={15} className="kb-micro-pop" fill={fav ? 'currentColor' : 'none'} />
          </button>
        )}
        {isRedo ? (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-[var(--warning)]">
            <RotateCcw size={12} />重做中
          </span>
        ) : answered ? (
          <span
            className={`ml-auto inline-flex items-center gap-1 text-[11px] font-medium ${
              isCorrect ? 'text-[var(--success)]' : 'text-[var(--danger)]'
            }`}
          >
            {isCorrect ? <Check size={13} /> : <X size={13} />}
            {isCorrect ? '回答正确' : `正确答案 ${quiz.answer}`}
          </span>
        ) : null}
      </div>

      {/* 题干（完整 Markdown 管线：公式/图片/wiki 链接） */}
      <div className="px-3 py-1.5 text-[14px] leading-relaxed text-[var(--text-primary)]">
        <MarkdownPreview content={quiz.question} />
      </div>

      {/* 选项 */}
      <div className="px-3 pb-2.5 pt-1 grid grid-cols-1 gap-1.5">
        {quiz.options.map(opt => {
          const isPicked = effectivePicked === opt.key
          const isAnswer = opt.key === quiz.answer
          const reveal = answered && !isRedo
          let cls = 'border-[var(--border-color)] text-[var(--text-primary)] hover:border-[var(--accent)] hover:bg-[var(--bg-hover)] cursor-pointer'
          if (reveal) {
            if (isAnswer) cls = 'border-[var(--success)] bg-[var(--success)]/10 text-[var(--text-primary)] cursor-default'
            else if (isPicked) cls = 'border-[var(--danger)] bg-[var(--danger)]/10 text-[var(--text-primary)] cursor-default'
            else cls = 'border-[var(--border-color)] text-[var(--text-muted)] cursor-default'
          }
          return (
            <button
              key={opt.key}
              onClick={() => pick(opt.key)}
              className={`flex items-start gap-2.5 text-left px-3 py-2 rounded-md border transition-colors ${cls}`}
              aria-pressed={isPicked}
            >
              <span className="shrink-0 mt-px inline-flex items-center justify-center w-5 h-5 rounded-full border border-current text-[11px] font-medium">
                {opt.key}
              </span>
              <span className="flex-1 min-w-0 text-[13.5px] leading-relaxed [&_.prose-content]:!m-0 [&_.prose-content>*:first-child]:mt-0 [&_.prose-content>*:last-child]:mb-0">
                <MarkdownPreview content={opt.text} />
              </span>
              {reveal && isAnswer && <Check size={15} className="shrink-0 mt-0.5 text-[var(--success)]" />}
              {reveal && isPicked && !isAnswer && <X size={15} className="shrink-0 mt-0.5 text-[var(--danger)]" />}
            </button>
          )
        })}
      </div>

      {/* 解析：答错自动展开；答对可通过"查看解析"展开 */}
      {(showExplanation || (answered && correct === 0)) && quiz.explanation && (
        <div className="mx-3 mb-3 px-3 py-2.5 rounded-md border border-dashed border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
            <span className="inline-block w-1 h-3 rounded-full bg-[var(--accent)]" />
            解析
          </div>
          <div className="text-[13.5px] leading-relaxed text-[var(--text-primary)] [&_.prose-content>*:first-child]:mt-0 [&_.prose-content>*:last-child]:mb-0">
            <MarkdownPreview content={quiz.explanation} />
          </div>
        </div>
      )}
      {answered && isCorrect && quiz.explanation && !showExplanation && (
        <div className="px-3 pb-2.5 -mt-1">
          <button
            onClick={() => setShowExplanation(true)}
            className="text-[11px] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
          >
            查看解析 ▸
          </button>
        </div>
      )}

      {/* 底部：键盘提示 / 重做 */}
      <div className="px-3 pb-2 flex items-center gap-2 text-[10px] text-[var(--text-muted)]/70">
        <span>
          {isRedo
            ? `上次选 ${prevPicked || '—'} · 重新选择一个答案`
            : answered
              ? 'Enter 跳到下一题'
              : '点击选项或按 1-4 / A-D 作答'}
        </span>
        {answered && !isRedo && (
          <button
            onClick={enterRedo}
            className="ml-auto inline-flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
          >
            <RotateCcw size={11} />重做本题
          </button>
        )}
      </div>
    </div>
  )
}
