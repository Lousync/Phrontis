import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, X, RotateCcw, Star } from 'lucide-react'
import { MarkdownPreview } from './MarkdownPreview'
import type { QuizItem } from './QuizParser'
import { quizRecordReport, quizRecordToggleFavorite } from '../../lib/ipc'

interface Props {
  quizzes: QuizItem[]
  pageTitle: string
  onClose: () => void
  /** 来源页面 ID（传入后启用收藏 + 错题上报） */
  pageId?: string
  /** P7（AI教学）：整套答完时回调成绩摘要（用于测验报告落盘等）；再来一遍会再次触发 */
  onFinish?: (summary: { total: number; correctCount: number; records: Array<{ no: number; correct: boolean; picked: string }> }) => void
}

interface Record {
  no: number
  correct: boolean
  picked: string
}

/**
 * 沉浸刷题模式：一题一屏，答对自动下一题，答错展示解析后手动/Enter 继续，
 * 全部答完显示得分与错题清单。键盘：1-4/A-D 作答，Enter 下一题，Esc 退出。
 * 用捕获阶段监听并 stopPropagation，避免与页面级快捷键（如 Esc 返回列表）冲突。
 */
export function QuizMode({ quizzes, pageTitle, onClose, pageId, onFinish }: Props) {
  const [idx, setIdx] = useState(0)
  const [picked, setPicked] = useState<string | null>(null)
  const [records, setRecords] = useState<Record[]>([])
  const [finished, setFinished] = useState(false)
  const [showHint, setShowHint] = useState(true)
  const [favMap, setFavMap] = useState<{ [no: number]: boolean }>({})

  // 刷题模式只跑选择题；调用方可能把整页（含简答）直接传进来，这里兜底过滤。
  const choiceQuizzes = useMemo(
    () => quizzes.filter(q => q.type === 'choice' && q.options.length >= 2),
    [quizzes],
  )
  const quiz = choiceQuizzes[idx]
  const total = choiceQuizzes.length
  const answered = picked !== null
  const isCorrect = picked === quiz?.answer
  const correctCount = records.filter(r => r.correct).length

  const snapshot = (q: QuizItem) => ({
    no: q.no,
    type: 'choice' as const,
    question: q.question,
    options: q.options,
    answer: q.answer,
    explanation: q.explanation,
  })

  const toggleFav = () => {
    if (!pageId || !quiz) return
    quizRecordToggleFavorite(pageId, quiz.no, { pageTitle, snapshot: snapshot(quiz) })
      .then(r => setFavMap(m => ({ ...m, [quiz.no]: r.isFavorite })))
      .catch(() => { /* ignore */ })
  }

  const goNext = useCallback(() => {
    if (idx + 1 >= total) {
      setFinished(true)
    } else {
      setIdx(i => i + 1)
      setPicked(null)
    }
  }, [idx, total])

  const pick = useCallback(
    (key: string) => {
      if (!quiz || picked !== null) return
      setPicked(key)
      const ok = key === quiz.answer
      setRecords(rs => [...rs, { no: quiz.no, correct: ok, picked: key }])
      if (pageId) {
        quizRecordReport(pageId, quiz.no, ok, { pageTitle, snapshot: snapshot(quiz), picked: key }).catch(() => { /* ignore */ })
      }
      if (ok) window.setTimeout(goNext, 500)
    },
    [quiz, picked, goNext, pageId, pageTitle],
  )

  const restart = () => {
    setIdx(0)
    setPicked(null)
    setRecords([])
    setFinished(false)
    setShowHint(true)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (finished) {
        if (e.key === 'r' || e.key === 'R') { e.preventDefault(); restart() }
        return
      }
      if (!quiz) return
      if (picked === null) {
        const n = parseInt(e.key, 10)
        if (n >= 1 && n <= quiz.options.length) { e.preventDefault(); pick(quiz.options[n - 1].key); return }
        const k = e.key.toUpperCase()
        const hit = quiz.options.find(o => o.key === k)
        if (hit) { e.preventDefault(); pick(hit.key); return }
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        goNext()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [quiz, picked, finished, pick, goNext, onClose])

  // 切换题目时隐藏提示
  useEffect(() => setShowHint(true), [idx])

  // P7（AI教学）：每轮 finished 触发一次完成回调；重启（再来一遍）后可再次触发
  const reportedRef = useRef(false)
  useEffect(() => {
    if (finished && !reportedRef.current) {
      reportedRef.current = true
      onFinish?.({ total, correctCount: records.filter(r => r.correct).length, records: records.map(r => ({ no: r.no, correct: r.correct, picked: r.picked })) })
    } else if (!finished) {
      reportedRef.current = false
    }
  }, [finished, records, total, onFinish])

  const wrongList = useMemo(() => records.filter(r => !r.correct), [records])
  const rightList = useMemo(() => records.filter(r => r.correct), [records])

  return (
    <div className="kb-view-fade absolute inset-0 z-50 bg-[var(--bg-primary)] flex flex-col" role="dialog" aria-label="刷题模式">
      {/* 顶栏 */}
      <div className="shrink-0 flex items-center gap-3 px-4 h-11 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]">
        <button
          onClick={onClose}
          className="flex items-center gap-1 px-2 py-1 rounded text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          title="退出刷题 (Esc)"
        >
          <X size={14} />
          退出
        </button>
        <span className="text-[13px] font-medium text-[var(--text-primary)] truncate min-w-0 flex-1">
          刷题 · {pageTitle}
        </span>
        <span className="shrink-0 text-[12px] text-[var(--text-muted)]">
          {finished ? `${total}/${total}` : `${idx + 1}/${total}`}
        </span>
      </div>

      {/* 进度条 */}
      <div className="shrink-0 h-1 bg-[var(--bg-hover)]">
        <div
          className="h-full bg-[var(--accent)] transition-all duration-300"
          style={{ width: `${total ? ((finished ? total : idx + (answered ? 1 : 0)) / total) * 100 : 0}%` }}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* 内容垂直居中：窗口高时题目/结果居中，内容超长时可正常滚动 */}
        <div className="min-h-full flex flex-col justify-center">
        {finished ? (
          /* ===== 完成页 ===== */
          <div className="max-w-[680px] mx-auto w-full px-6 py-10">
            <div className="text-center mb-8">
              <div className="text-[40px] font-semibold text-[var(--text-primary)]">
                {correctCount}<span className="text-[22px] text-[var(--text-muted)]">/{total}</span>
              </div>
              <div className="mt-1 text-[13px] text-[var(--text-secondary)]">
                答对 {correctCount} 题 · 答错 {total - correctCount} 题 · 正确率 {total ? Math.round((correctCount / total) * 100) : 0}%
              </div>
              <div className="mt-4 flex items-center justify-center gap-2">
                <button
                  onClick={restart}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-[var(--accent)] text-white text-[12px] hover:opacity-90 transition-opacity"
                >
                  <RotateCcw size={13} />
                  再来一遍
                </button>
                <button
                  onClick={onClose}
                  className="px-3.5 py-1.5 rounded-md border border-[var(--border-color)] text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  退出
                </button>
              </div>
            </div>

            {wrongList.length > 0 && (
              <div>
                <div className="mb-2 text-[12px] font-medium text-[var(--text-secondary)]">错题回顾</div>
                <div className="space-y-3">
                  {wrongList.map(r => {
                    const q = choiceQuizzes.find(x => x.no === r.no)
                    if (!q) return null
                    return (
                      <div key={r.no} className="rounded-lg border border-[var(--danger)]/40 bg-[var(--bg-secondary)] px-4 py-3">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-[12px] font-medium text-[var(--text-primary)]">第 {r.no} 题</span>
                          <span className="text-[11px] text-[var(--danger)]">
                            你选了 {r.picked} · 正确答案 {q.answer}
                          </span>
                        </div>
                        <div className="text-[13px] leading-relaxed text-[var(--text-primary)] mb-1">
                          <MarkdownPreview content={q.question} />
                        </div>
                        {q.explanation && (
                          <details className="mt-1">
                            <summary className="text-[11px] text-[var(--text-muted)] cursor-pointer select-none">
                              查看解析
                            </summary>
                            <div className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-primary)] [&_.prose-content>*:first-child]:mt-0">
                              <MarkdownPreview content={q.explanation} />
                            </div>
                          </details>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {rightList.length > 0 && (
              <div className="mt-6 text-[12px] text-[var(--text-muted)]">
                已答对 {rightList.length} 题：第 {rightList.map(r => r.no).join('、')} 题
              </div>
            )}
          </div>
        ) : quiz ? (
          /* ===== 逐题页 ===== */
          <div className="max-w-[680px] mx-auto w-full px-6 py-8">
            {/* 题号 + 分值 */}
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[15px] font-medium text-[var(--text-primary)]">第 {quiz.no} 题</span>
              {quiz.points && (
                <span className="px-1.5 py-px rounded bg-[var(--bg-hover)] text-[10px] text-[var(--text-muted)]">
                  {quiz.points} 分
                </span>
              )}
              {pageId && (
                <button
                  onClick={toggleFav}
                  title={favMap[quiz.no] ? '取消收藏' : '收藏此题'}
                  className={`ml-auto inline-flex items-center justify-center w-7 h-7 rounded transition-colors ${
                    favMap[quiz.no] ? 'text-[#f5b301]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  <Star key={favMap[quiz.no] ? 'on' : 'off'} size={17} className="kb-micro-pop" fill={favMap[quiz.no] ? 'currentColor' : 'none'} />
                </button>
              )}
            </div>

            {/* 题干 */}
            <div className="text-[15px] leading-[1.9] text-[var(--text-primary)] mb-5">
              <MarkdownPreview content={quiz.question} />
            </div>

            {/* 选项 */}
            <div className="grid grid-cols-1 gap-2">
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
                    className={`flex items-start gap-2.5 text-left px-4 py-3 rounded-lg border transition-colors ${cls}`}
                  >
                    <span className="shrink-0 mt-px inline-flex items-center justify-center w-5 h-5 rounded-full border border-current text-[12px] font-medium">
                      {opt.key}
                    </span>
                    <span className="flex-1 min-w-0 text-[14px] leading-relaxed [&_.prose-content]:!m-0 [&_.prose-content>*:first-child]:mt-0 [&_.prose-content>*:last-child]:mb-0">
                      <MarkdownPreview content={opt.text} />
                    </span>
                    {answered && isAnswer && <Check size={16} className="shrink-0 mt-0.5 text-[var(--success)]" />}
                    {answered && isPicked && !isAnswer && <X size={16} className="shrink-0 mt-0.5 text-[var(--danger)]" />}
                  </button>
                )
              })}
            </div>

            {/* 判题反馈 + 解析 */}
            {answered && (
              <div className="mt-5">
                <div
                  className={`flex items-center gap-2 text-[14px] font-medium ${
                    isCorrect ? 'text-[var(--success)]' : 'text-[var(--danger)]'
                  }`}
                >
                  {isCorrect ? <Check size={17} /> : <X size={17} />}
                  {isCorrect ? '回答正确' : `答错了 · 正确答案是 ${quiz.answer}`}
                </div>
                {!isCorrect && quiz.explanation && (
                  <div className="mt-3 px-4 py-3 rounded-lg border border-dashed border-[var(--border-color)] bg-[var(--bg-secondary)]">
                    <div className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-secondary)]">
                      <span className="inline-block w-1 h-3 rounded-full bg-[var(--accent)]" />
                      解析
                    </div>
                    <div className="text-[14px] leading-[1.8] text-[var(--text-primary)] [&_.prose-content>*:first-child]:mt-0 [&_.prose-content>*:last-child]:mb-0">
                      <MarkdownPreview content={quiz.explanation} />
                    </div>
                  </div>
                )}
                <div className="mt-4 flex items-center justify-between">
                  <button
                    onClick={goNext}
                    disabled={idx + 1 >= total && !isCorrect && !quiz.explanation}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-[var(--accent)] text-white text-[13px] hover:opacity-90 transition-opacity disabled:opacity-40"
                  >
                    {idx + 1 >= total ? '完成' : '下一题'}
                    <ChevronRight size={14} />
                  </button>
                  <span className="text-[11px] text-[var(--text-muted)]">Enter 快速下一题</span>
                </div>
              </div>
            )}
          </div>
        ) : null}
        </div>
      </div>

      {/* 底部键盘提示 */}
      {!finished && showHint && (
        <div className="shrink-0 px-4 py-2 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] flex items-center justify-center gap-4 text-[11px] text-[var(--text-muted)]">
          <span><b className="text-[var(--text-secondary)]">1-4 / A-D</b> 作答</span>
          <span><b className="text-[var(--text-secondary)]">Enter</b> 下一题</span>
          <span><b className="text-[var(--text-secondary)]">Esc</b> 退出</span>
        </div>
      )}
      {finished && (
        <div className="shrink-0 px-4 py-2 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] text-center text-[11px] text-[var(--text-muted)]">
          <b className="text-[var(--text-secondary)]">R</b> 再来一遍 · <b className="text-[var(--text-secondary)]">Esc</b> 退出
        </div>
      )}
    </div>
  )
}
