import React, { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, RotateCcw, X } from 'lucide-react'
import { MarkdownPreview } from './MarkdownPreview'
import { Collapsible } from './Collapsible'
import type { QuizItem } from './QuizParser'
import { useQuizRecord, useQuizStore, useQuizStoreActive } from './QuizRecordStore'

interface Props {
  quiz: QuizItem
  pageTitle?: string
  /** 错题重做：进入时收起参考答案、隐藏上次自评，带着旧文字重做 */
  redo?: boolean
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

/**
 * 简答题卡：题干 → 作答框（自动保存）→ 折叠参考答案 → 自评。
 *
 * 状态真源是页面级 QuizRecordStore；无 store（AI 聊天单题快检）时退化为本地状态，
 * 可作答/自评但不落盘。正式题单必须由 PageEditor / ArtifactsPane 提供 store。
 */
export function ShortAnswerCard({ quiz, redo = false }: Props) {
  const store = useQuizStore()
  const record = useQuizRecord(store, quiz.no)
  const persist = useQuizStoreActive(store)
  const snapshot = () => ({
    no: quiz.no,
    type: 'short' as const,
    question: quiz.question,
    options: [],
    answer: '',
    referenceAnswer: quiz.referenceAnswer,
    explanation: quiz.explanation,
  })

  const [text, setText] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [assessedText, setAssessedText] = useState('')
  const [fallbackCorrect, setFallbackCorrect] = useState<boolean | null>(null)
  const [redoLocal, setRedoLocal] = useState(false)
  const [redoDone, setRedoDone] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const textRef = useRef('')
  const savedRef = useRef('')
  const hydratedRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const isRedo = (redo || redoLocal) && !redoDone
  const storedCorrect = persist ? (record?.lastResult ?? null) : null
  const correct = isRedo
    ? null
    : (fallbackCorrect == null ? storedCorrect : (fallbackCorrect ? 1 : 0))
  const lastKnownCorrect = fallbackCorrect == null ? storedCorrect : (fallbackCorrect ? 1 : 0)

  // 首次载入记录：只填空，不覆盖用户已经打进去的字
  useEffect(() => {
    if (hydratedRef.current || !record) return
    hydratedRef.current = true
    const restored = record.draft?.text ?? ''
    setAssessedText(record.draft?.assessedText ?? '')
    setRevealed(redo ? false : !!record.draft?.revealed)
    if (!textRef.current) {
      textRef.current = restored
      savedRef.current = restored
      setText(restored)
      if (restored) setSaveState('saved')
    } else if (restored) {
      savedRef.current = restored
    }
  }, [record, redo])

  // 父级 redo 打开时收起参考答案（卡片可能复用，不重新 mount）
  useEffect(() => {
    if (!redo) return
    setRevealed(false)
    setRedoDone(false)
    setRedoLocal(false)
  }, [redo])

  const doSave = (value: string) => {
    if (!persist) { setSaveState('idle'); return }
    setSaveState('saving')
    void store!.saveDraft(quiz.no, { text: value }, snapshot()).then((ok) => {
      if (ok) {
        savedRef.current = value
        setSaveState('saved')
      } else {
        setSaveState('error')
      }
    })
  }

  const flush = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const value = textRef.current
    if (persist && value !== savedRef.current) doSave(value)
  }

  // 卸载时尽量把最后一个防抖窗口写盘（不 setState，避免卸载后更新）
  useEffect(() => () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    const value = textRef.current
    if (persist && value !== savedRef.current) {
      void store!.saveDraft(quiz.no, { text: value }, snapshot())
    }
  }, [persist, store, quiz.no])

  const onChange = (value: string) => {
    setText(value)
    textRef.current = value
    setSaveState('saving')
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      doSave(value)
    }, 500)
  }

  const toggleReveal = () => {
    flush()
    const next = !revealed
    setRevealed(next)
    if (persist) void store!.saveDraft(quiz.no, { revealed: next }, snapshot())
  }

  const assess = (ok: boolean) => {
    flush()
    setFallbackCorrect(ok)
    setAssessedText(textRef.current)
    setRedoDone(true)
    setRedoLocal(false)
    if (persist) {
      void (async () => {
        await store!.saveDraft(quiz.no, { assessedText: textRef.current, revealed: true }, snapshot())
        await store!.report(quiz.no, ok, snapshot())
      })()
    }
  }

  const enterRedo = () => {
    setRedoLocal(true)
    setRedoDone(false)
    setRevealed(false)
    setFallbackCorrect(null)
  }

  const status = isRedo
    ? { label: '重做中', cls: 'text-[var(--warning)] bg-[var(--warning)]/10' }
    : correct === 1
      ? { label: '答对', cls: 'text-[var(--success)] bg-[var(--success)]/10' }
      : correct === 0
        ? { label: '答错', cls: 'text-[var(--danger)] bg-[var(--danger)]/10' }
        : text
          ? { label: '草稿', cls: 'text-[var(--text-secondary)] bg-[var(--bg-hover)]' }
          : { label: '未作答', cls: 'text-[var(--text-muted)] bg-[var(--bg-hover)]' }

  const dirty = correct != null && !isRedo && text !== assessedText

  return (
    <div
      data-quiz-card
      data-quiz-no={quiz.no}
      className={`my-3 rounded-lg border transition-colors ${
        correct === 1 && !isRedo
          ? 'border-[var(--success)]/60'
          : correct === 0 && !isRedo
            ? 'border-[var(--danger)]/50'
            : 'border-[var(--border-color)]'
      }`}
    >
      {/* 卡片头：题号 + 题型 + 状态 */}
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
        <span className="text-[12px] font-medium text-[var(--text-primary)]">第 {quiz.no} 题</span>
        <span className="px-1.5 py-px rounded bg-[var(--accent)]/10 text-[10px] text-[var(--accent)]">简答</span>
        <span className={`ml-auto px-1.5 py-0.5 rounded text-[10px] font-medium ${status.cls}`} aria-live="polite">
          {status.label}
        </span>
      </div>

      {/* 题干 */}
      <div className="px-3 py-1.5 text-[14px] leading-relaxed text-[var(--text-primary)]">
        <MarkdownPreview content={quiz.question} />
      </div>

      {/* 作答框 */}
      <div className="px-3 pb-2">
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => onChange(e.target.value)}
            onBlur={flush}
            rows={4}
            placeholder="写下你的答案…（自动保存）"
            aria-label={`第 ${quiz.no} 题作答`}
            className="w-full resize-y min-h-[96px] px-3 py-2.5 pb-6 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13.5px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent)] transition-colors"
          />
          <span className="absolute right-2.5 bottom-1.5 text-[10px] text-[var(--text-muted)] tabular-nums">
            {text.length} 字
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between text-[10.5px] text-[var(--text-muted)]">
          <span>
            {!persist
              ? '未绑定知识库页面，本次作答不会保存'
              : saveState === 'saving'
                ? '保存中…'
                : saveState === 'saved'
                  ? '已保存'
                  : saveState === 'error'
                    ? '保存失败'
                    : '草稿自动保存'}
          </span>
          {dirty && <span className="text-[var(--warning)]">答案已修改，建议重新自评</span>}
        </div>
      </div>

      {/* 参考答案折叠 + 自评 */}
      <div className="px-3 pb-2.5">
        <div className="flex items-center gap-2">
          <button
            onClick={toggleReveal}
            aria-expanded={revealed}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-[var(--border-color)] text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <span className={`kb-chevron ${revealed ? 'rotate-180' : ''}`}><ChevronDown size={13} /></span>
            {revealed ? '收起参考答案' : '显示参考答案'}
          </button>
          {isRedo && lastKnownCorrect != null && (
            <span className="text-[11px] text-[var(--text-muted)]">上次自评：{lastKnownCorrect === 1 ? '答对' : '答错'}</span>
          )}
          {revealed && (correct == null || isRedo) && (
            <div className="ml-auto flex items-center gap-1.5">
              <button
                onClick={() => assess(true)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-[var(--success)]/50 text-[var(--success)] text-[12px] hover:bg-[var(--success)]/10 transition-colors"
              >
                <Check size={13} />答对了
              </button>
              <button
                onClick={() => assess(false)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-[var(--danger)]/50 text-[var(--danger)] text-[12px] hover:bg-[var(--danger)]/10 transition-colors"
              >
                <X size={13} />答错了
              </button>
            </div>
          )}
        </div>

        <Collapsible open={revealed} innerClassName="">
          {() => (
            <div className="mt-2 rounded-md border border-dashed border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
                <span className="inline-block w-1 h-3 rounded-full bg-[var(--accent)]" />
                参考答案
              </div>
              <div className="text-[13.5px] leading-relaxed text-[var(--text-primary)] [&_.prose-content>*:first-child]:mt-0 [&_.prose-content>*:last-child]:mb-0">
                <MarkdownPreview content={quiz.referenceAnswer} />
              </div>
              {quiz.explanation && (
                <div className="mt-2 pt-2 border-t border-[var(--border-color)]/60 text-[12.5px] leading-relaxed text-[var(--text-secondary)] [&_.prose-content>*:first-child]:mt-0 [&_.prose-content>*:last-child]:mb-0">
                  <MarkdownPreview content={quiz.explanation} />
                </div>
              )}
            </div>
          )}
        </Collapsible>

        {correct != null && !isRedo && (
          <div className="mt-2 flex items-center justify-end">
            <button
              onClick={enterRedo}
              className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
            >
              <RotateCcw size={12} />重做本题
            </button>
          </div>
        )}
        {!revealed && correct == null && !isRedo && (
          <div className="mt-1 text-[10.5px] text-[var(--text-muted)]">展开参考答案后，可自评「答对了 / 答错了」</div>
        )}
      </div>
    </div>
  )
}
