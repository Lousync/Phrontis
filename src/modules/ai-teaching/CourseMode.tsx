import { useCallback, useState } from 'react'
import { Sparkles } from 'lucide-react'
import type { AiTeachCourseState, AiTeachUnitQuizQuestion } from '../../types'
import { aiTeachCourseMakeUnitQuiz, aiTeachCourseMoveUnit } from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { FLOW_ST_LABEL } from './flow/flowStatus'
import { FlowCanvas } from './flow/FlowCanvas'
import type { FlowScope } from './flow/flowLayout'

/**
 * AI教学·课程模式前端（docs/ai-teaching-course-mode-plan.md）。
 *
 * 定位（2026-09-30 拍板，2026-10-16 改版）：**课程模式 = 工作区主界面**。开启后：
 *   · 左栏「会话」区 + 知识点清单（index.tsx 渲染）；
 *   · 中栏在「对话」与「学习流」之间切换（中栏 chip，index.tsx 渲染）；
 *   · 本组件只负责**中栏内容**：无大纲 → 引导回对话；有大纲 → 学习流画布（`FlowCanvas`）。
 * 数据全部走 IPC（主进程 aiTeachingCourse.ts）；本组件不直接碰盘。
 *
 * 学习流画布把章渲染为背景分组框、知识点渲染为可拖卡片、连线表示推进顺序；
 * 三层配置（要求 / 画像 / 素材）收进右栏节点详情（P2）。
 */

export const COURSE_ST_LABEL = FLOW_ST_LABEL

interface Props {
  wsId: string
  wsName: string
  state: AiTeachCourseState
  onStartUnit: (unitId: string) => void
  onFinishUnit: (unitId: string, score?: { correct: number; total: number }) => void
  onReopenUnit: (unitId: string) => void
  /** 章末复习课：点进和课程助手讨论本章复习 */
  onOpenChapterReview: (chapterId: string) => void
  onReload: () => void
  /** 对话驱动建课：跳回对话（跟教学助手说目标/改大纲） */
  onGoChat?: () => void
  /** 选中作用域层变化（画布 → 上层；L3 右栏「层级」面据此显示该层的要求 / 画像 / 素材） */
  onSelectScope?: (scope: FlowScope) => void
  /** 「编辑这一层」——打开该层的要求 / 画像文档 */
  onOpenScopeDoc?: (scope: FlowScope) => void
}

export function CourseHome({ wsId, state, onStartUnit, onFinishUnit, onOpenChapterReview, onGoChat, onSelectScope, onOpenScopeDoc }: Props) {
  const [selScope, setSelScope] = useState<FlowScope>({ level: 'workspace' })
  // L3 收尾自测：先出题 → 作答 → 再生成总结篇
  const [quiz, setQuiz] = useState<{ unitId: string; qs: AiTeachUnitQuizQuestion[]; i: number; picked: number | null; score: number; done: boolean } | null>(null)
  const [quizBusy, setQuizBusy] = useState(false)

  const startFinishQuiz = useCallback(async (unitId: string) => {
    if (quizBusy) return
    setQuizBusy(true)
    const r = await aiTeachCourseMakeUnitQuiz(wsId, unitId).catch(() => null)
    setQuizBusy(false)
    if (!r?.ok || !r.questions?.length) {
      showToast({ type: 'warning', message: `出题失败（${r?.error ?? ''}）· 直接生成总结篇` })
      onFinishUnit(unitId)
      return
    }
    setQuiz({ unitId, qs: r.questions, i: 0, picked: null, score: 0, done: false })
  }, [quizBusy, wsId, onFinishUnit])

  // 画布选层：本地记住 + 上报上层（L3 右栏「层级」面用）
  const selectScope = useCallback((scope: FlowScope) => {
    setSelScope(scope)
    onSelectScope?.(scope)
  }, [onSelectScope])

  // 画布拖拽落点：跨章/同章搬移知识点（保留 id 与进度；主进程写盘后广播刷新）
  const moveUnit = useCallback(async (unitId: string, targetChapterId: string, beforeUnitId: string | null) => {
    const r = await aiTeachCourseMoveUnit(wsId, unitId, targetChapterId, beforeUnitId).catch(() => null)
    if (!r?.ok) showToast({ type: 'warning', message: `移动知识点失败（${r?.error ?? '未知错误'}）` })
  }, [wsId])

  if (!state.outline) {
    return (
      <div className="h-full min-h-0 flex items-center justify-center px-6">
        <div className="w-full max-w-[460px] text-center">
          <div className="mx-auto w-[46px] h-[46px] rounded-xl bg-[var(--accent)]/12 text-[var(--accent)] flex items-center justify-center"><Sparkles size={22} /></div>
          <h2 className="mt-4 text-[17px] font-semibold text-[var(--text-primary)]">还没有课程大纲</h2>
          <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">回到对话，跟<b>教学助手</b>说你的学习目标和素材——它会先清点素材、给你一份大纲草稿，你确认满意后再正式生成。</p>
          {onGoChat && (
            <button onClick={onGoChat}
              className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[var(--accent)] text-white text-[12px] hover:opacity-90 kb-press"><Sparkles size={13} />去和教学助手聊聊</button>
          )}
          <div className="mt-3 text-[11px] text-[var(--text-muted)]">也可以直接手动编辑 <code className="font-mono text-[var(--accent)]">课程.md</code></div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 flex flex-col">
      <FlowCanvas
        outline={state.outline}
        progress={state.progress}
        lessons={state.lessons}
        reviews={state.reviews}
        selScope={selScope}
        onSelectScope={selectScope}
        onOpenScopeDoc={onOpenScopeDoc}
        onStartUnit={onStartUnit}
        onOpenChapterReview={onOpenChapterReview}
        onFinishQuiz={(id) => void startFinishQuiz(id)}
        onMoveUnit={(unitId, chapterId, beforeId) => void moveUnit(unitId, chapterId, beforeId)}
        layoutKey={wsId}
      />
      {quiz && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/35 p-4" onClick={() => setQuiz(null)}>
          <div className="w-[min(560px,94vw)] max-h-[86vh] overflow-y-auto rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] p-5 shadow-2xl kb-pop" onClick={(e) => e.stopPropagation()}>
            {quiz.done ? (
              <div>
                <div className="text-[15px] font-semibold text-[var(--text-primary)]">自测完成：{quiz.score} / {quiz.qs.length}</div>
                <div className="mt-2 text-[12.5px] text-[var(--text-secondary)]">接下来生成这个知识点的总结篇（进入引用网络）。</div>
                <div className="mt-4 flex justify-end gap-2">
                  <button onClick={() => setQuiz(null)} className="px-3 py-1.5 rounded-lg border border-[var(--border-color)] text-[12px] text-[var(--text-secondary)] hover:border-[var(--accent)]/50">稍后</button>
                  <button onClick={() => { const id = quiz.unitId; const sc = { correct: quiz.score, total: quiz.qs.length }; setQuiz(null); onFinishUnit(id, sc) }} className="px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12px] hover:opacity-90 kb-press">生成总结篇</button>
                </div>
              </div>
            ) : (
              <div>
                <div className="text-[11px] text-[var(--text-muted)]">收尾自测 · {quiz.i + 1} / {quiz.qs.length}</div>
                <div className="mt-2 text-[14px] font-semibold text-[var(--text-primary)]">{quiz.qs[quiz.i].q}</div>
                <div className="mt-3 space-y-2">
                  {quiz.qs[quiz.i].options.map((o, k) => (
                    <button key={k} onClick={() => setQuiz((s) => (s ? { ...s, picked: k } : s))}
                      className={`w-full text-left rounded-lg border px-3 py-2 text-[12.5px] transition-colors ${quiz.picked === k ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]' : 'border-[var(--border-color)] hover:border-[var(--accent)]/40'}`}>
                      {'ABCD'[k] ?? k + 1}. {o}
                    </button>
                  ))}
                </div>
                <div className="mt-4 flex justify-end">
                  <button disabled={quiz.picked === null}
                    onClick={() => setQuiz((s) => {
                      if (!s || s.picked === null) return s
                      const ok = s.picked === s.qs[s.i].answer
                      const score = s.score + (ok ? 1 : 0)
                      return s.i < s.qs.length - 1 ? { ...s, i: s.i + 1, picked: null, score } : { ...s, done: true, score }
                    })}
                    className="px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12px] hover:opacity-90 disabled:opacity-40 kb-press">
                    {quiz.i < quiz.qs.length - 1 ? '下一题' : '提交'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
