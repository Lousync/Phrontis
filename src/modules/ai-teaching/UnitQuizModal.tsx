import type { AiTeachUnitQuizQuestion } from '../../types'

/**
 * 收尾自测弹窗（L3「结束本知识点」的唯一形态）。
 *
 * 为什么独立成组件：入口有两个 —— 画布底部浮动条 / 右栏「层级」面的「推进」页签。
 * 弹窗状态与出题请求由 index.tsx 持有（一次只开一个），两个入口都调同一个
 * `startFinishQuiz(unitId)`，避免两处各写一份弹窗（那份重复必然长歪）。
 *
 * 注意：这里的作答只统计得分，**掌握度不在这里写**（§15 掌握度只读）；
 * 得分随 `onFinishUnit(unitId, {correct,total})` 交给主进程，由它写 progress 与总结篇。
 */
export interface FinishQuizState {
  unitId: string
  qs: AiTeachUnitQuizQuestion[]
  i: number
  picked: number | null
  score: number
  done: boolean
}

interface Props {
  state: FinishQuizState
  /** 作答推进（父组件持有状态，这里只算分） */
  onChange: (next: FinishQuizState) => void
  /** 关掉弹窗（稍后 / 点遮罩） */
  onClose: () => void
  /** 生成总结篇：把分数交给主进程 */
  onFinishUnit: (unitId: string, score: { correct: number; total: number }) => void
}

export function UnitQuizModal({ state: quiz, onChange, onClose, onFinishUnit }: Props) {
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/35 p-4" onClick={onClose}>
      <div className="w-[min(560px,94vw)] max-h-[86vh] overflow-y-auto rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] p-5 shadow-2xl kb-pop" onClick={(e) => e.stopPropagation()}>
        {quiz.done ? (
          <div>
            <div className="text-[15px] font-semibold text-[var(--text-primary)]">自测完成：{quiz.score} / {quiz.qs.length}</div>
            <div className="mt-2 text-[12.5px] text-[var(--text-secondary)]">接下来生成这个知识点的总结篇（进入引用网络）。</div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-[var(--border-color)] text-[12px] text-[var(--text-secondary)] hover:border-[var(--accent)]/50">稍后</button>
              <button onClick={() => { const id = quiz.unitId; const sc = { correct: quiz.score, total: quiz.qs.length }; onClose(); onFinishUnit(id, sc) }}
                className="px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12px] hover:opacity-90 kb-press">生成总结篇</button>
            </div>
          </div>
        ) : (
          <div>
            <div className="text-[11px] text-[var(--text-muted)]">收尾自测 · {quiz.i + 1} / {quiz.qs.length}</div>
            <div className="mt-2 text-[14px] font-semibold text-[var(--text-primary)]">{quiz.qs[quiz.i].q}</div>
            <div className="mt-3 space-y-2">
              {quiz.qs[quiz.i].options.map((o, k) => (
                <button key={k} onClick={() => onChange({ ...quiz, picked: k })}
                  className={`w-full text-left rounded-lg border px-3 py-2 text-[12.5px] transition-colors ${quiz.picked === k ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]' : 'border-[var(--border-color)] hover:border-[var(--accent)]/40'}`}>
                  {'ABCD'[k] ?? k + 1}. {o}
                </button>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <button disabled={quiz.picked === null}
                onClick={() => {
                  if (quiz.picked === null) return
                  const ok = quiz.picked === quiz.qs[quiz.i].answer
                  const score = quiz.score + (ok ? 1 : 0)
                  onChange(quiz.i < quiz.qs.length - 1 ? { ...quiz, i: quiz.i + 1, picked: null, score } : { ...quiz, done: true, score })
                }}
                className="px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12px] hover:opacity-90 disabled:opacity-40 kb-press">
                {quiz.i < quiz.qs.length - 1 ? '下一题' : '提交'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default UnitQuizModal
