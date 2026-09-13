import React, { useEffect, useRef, useState } from 'react'
import { Check, X, Star } from 'lucide-react'
import { MarkdownPreview } from './MarkdownPreview'
import type { QuizItem } from './QuizParser'
import { quizRecordGetByPage, quizRecordReport, quizRecordToggleFavorite } from '../../lib/ipc'

interface Props {
  quiz: QuizItem
  /** 页面内全局序号（0 起），仅用于调试标记，非必需 */
  index?: number
  /** 作答回调（供统计/刷题模式汇总） */
  onAnswered?: (correct: boolean) => void
  /** 来源页面 ID（传入后启用收藏 + 错题上报） */
  pageId?: string
  /** 来源页面标题（用于错题本快照） */
  pageTitle?: string
}

/**
 * 选择题判题卡片：点选选项立即判题。
 * 答对 → 选项变绿并自动滚动到下一题；答错 → 选项变红 + 正确项高亮 + 展开解析。
 * 支持键盘 1-4 / A-D 作答（卡片聚焦时）。
 */
export function QuizCard({ quiz, index, onAnswered, pageId, pageTitle }: Props) {
  const [picked, setPicked] = useState<string | null>(null)
  const [showExplanation, setShowExplanation] = useState(false)
  const [fav, setFav] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 初始化收藏状态（页面渲染时回显该题是否已收藏）
  useEffect(() => {
    if (!pageId) return
    let alive = true
    quizRecordGetByPage(pageId)
      .then(records => {
        if (!alive) return
        const r = records.find(x => x.quizNo === quiz.no)
        if (r) setFav(r.isFavorite)
      })
      .catch(() => { /* ignore */ })
    return () => { alive = false }
  }, [pageId, quiz.no])

  const snapshot = () => ({
    no: quiz.no,
    question: quiz.question,
    options: quiz.options,
    answer: quiz.answer,
    explanation: quiz.explanation,
  })

  const toggleFav = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!pageId) return
    quizRecordToggleFavorite(pageId, quiz.no, { pageTitle, snapshot: snapshot() })
      .then(r => setFav(r.isFavorite))
      .catch(() => { /* ignore */ })
  }

  const answered = picked !== null
  const isCorrect = picked === quiz.answer

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
    const ok = key === quiz.answer
    onAnswered?.(ok)
    if (pageId) {
      quizRecordReport(pageId, quiz.no, ok, { pageTitle, snapshot: snapshot() }).catch(() => { /* ignore */ })
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
      if (!isCorrect) scrollToNext()
    }
  }

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
            : 'border-[var(--border-color)] hover:border-[var(--border-color-secondary,var(--border-color))]'
      }`}
    >
      {/* 卡片头：题号 + 状态（条目15 追加：分值徽章按志岩拍板移除——解析仍容忍 points 字段，只是不渲染） */}
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
        <span className="text-[12px] font-medium text-[var(--text-primary)]">
          第 {quiz.no} 题
        </span>
        {pageId && (
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
        {answered && (
          <span
            className={`ml-auto inline-flex items-center gap-1 text-[11px] font-medium ${
              isCorrect ? 'text-[var(--success)]' : 'text-[var(--danger)]'
            }`}
          >
            {isCorrect ? <Check size={13} /> : <X size={13} />}
            {isCorrect ? '回答正确' : `正确答案 ${quiz.answer}`}
          </span>
        )}
      </div>

      {/* 题干（完整 Markdown 管线：公式/图片/wiki 链接） */}
      <div className="px-3 py-1.5 text-[14px] leading-relaxed text-[var(--text-primary)]">
        <MarkdownPreview content={quiz.question} />
      </div>

      {/* 选项 */}
      <div className="px-3 pb-2.5 pt-1 grid grid-cols-1 gap-1.5">
        {quiz.options.map(opt => {
          const isPicked = picked === opt.key
          const isAnswer = opt.key === quiz.answer
          let cls = 'border-[var(--border-color)] text-[var(--text-primary)] hover:border-[var(--accent)] hover:bg-[var(--bg-hover)] cursor-pointer'
          if (answered) {
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
              {answered && isAnswer && <Check size={15} className="shrink-0 mt-0.5 text-[var(--success)]" />}
              {answered && isPicked && !isAnswer && <X size={15} className="shrink-0 mt-0.5 text-[var(--danger)]" />}
            </button>
          )
        })}
      </div>

      {/* 解析：答错自动展开；答对可通过"查看解析"展开 */}
      {(showExplanation || (answered && !isCorrect)) && quiz.explanation && (
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

      {/* 键盘提示 */}
      <div className="px-3 pb-2 text-[10px] text-[var(--text-muted)]/70">
        {answered ? 'Enter 跳到下一题' : '点击选项或按 1-4 / A-D 作答'}
      </div>
    </div>
  )
}
