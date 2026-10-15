import { useCallback, useMemo, useState } from 'react'
import { Check, ChevronDown, Play, Repeat, Sparkles, Trash2 } from 'lucide-react'
import type { AiTeachCourseState, AiTeachUnitQuizQuestion } from '../../types'
import { aiTeachCourseMakeUnitQuiz, aiTeachCourseRemoveUnit } from '../../lib/ipc'
import { showToast } from '../../lib/toast'

/**
 * AI教学·课程模式前端（docs/ai-teaching-course-mode-plan.md）
 *
 * 定位（2026-09-30 拍板）：**课程模式 = 工作区主界面**。开启后：
 *   · 左栏「会话」区换成「课程大纲」树（index.tsx 渲染）；
 *   · 中栏在「课程主页」与「上课（会话）」之间切换（顶栏分段器，index.tsx 渲染）；
 *   · 本组件只负责**中栏内容**：无大纲 → 引导回对话（跟教学助手说目标）；有大纲 → 课程主页。
 * 数据全部走 IPC（主进程 aiTeachingCourse.ts）；本组件不直接碰盘。
 *
 * 建课 / 改大纲一律走**提示词 + 工具**（跟教学助手说 → `course.outline.write(append=true)`）：
 * 原「建课向导」与「修订大纲抽屉」是两套没有任何渲染入口的平行实现，已于 2026-10-11 删除。
 */

const ST_LABEL: Record<string, string> = { todo: '未开始', learning: '学习中', check: '待检验', mastered: '已掌握', review: '待复习' }
const ST_CLS: Record<string, string> = {
  todo: 'bg-[var(--bg-hover)] text-[var(--text-muted)]',
  learning: 'bg-[var(--accent)]/12 text-[var(--accent)]',
  check: 'bg-[var(--warning)]/15 text-[var(--warning)]',
  mastered: 'bg-[var(--success)]/15 text-[var(--success)]',
  review: 'bg-[var(--danger)]/12 text-[var(--danger)]',
}

export const COURSE_ST_LABEL = ST_LABEL

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
}

export function CourseHome({ wsId, wsName, state, onStartUnit, onFinishUnit, onReopenUnit, onOpenChapterReview, onReload, onGoChat }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
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

  const doRemoveUnit = useCallback(async (u: { id: string; name: string }) => {
    const st = state.progress[u.id]?.status ?? 'todo'
    if (st !== 'todo') { showToast({ type: 'warning', message: `「${u.name}」已学习：请先让教学助手把这段对话整理归档，再删除` }); return }
    const r = await aiTeachCourseRemoveUnit(wsId, u.id).catch(() => null)
    if (r?.ok) { showToast({ type: 'info', message: `已删除知识点：${u.name}` }); onReload() }
    else showToast({ type: 'error', message: `删除失败${r?.error ? `：${r.error}` : ''}` })
  }, [wsId, state.progress, onReload])

  const units = useMemo(() => (state.outline?.chapters ?? []).flatMap(c => c.units), [state.outline])
  const total = units.length
  const done = units.filter(u => state.progress[u.id]?.status === 'mastered').length
  const cont = units.find(u => state.progress[u.id]?.status === 'learning')
    ?? units.find(u => state.progress[u.id]?.status !== 'mastered')

  const toggleChapter = useCallback((id: string) => {
    setCollapsed(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }, [])

  if (!state.outline) {
    return (
      <div className="h-full min-h-0 flex items-center justify-center px-6">
        <div className="w-full max-w-[460px] text-center">
          <div className="mx-auto w-[46px] h-[46px] rounded-xl bg-[var(--accent)]/12 text-[var(--accent)] flex items-center justify-center"><Sparkles size={22} /></div>
          <h2 className="mt-4 text-[17px] font-semibold text-[var(--text-primary)]">还没有课程大纲</h2>
          <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">回到对话，跟<b>教学助手</b>说你的学习目标和素材——它会先清点素材、给你一份大纲草稿，你确认满意后再正式生成。</p>
          {onGoChat && (
            <button onClick={onGoChat}
              className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[var(--accent)] text-white text-[12px] hover:opacity-90 transition-opacity"><Sparkles size={13} />去和教学助手聊聊</button>
          )}
          <div className="mt-3 text-[11px] text-[var(--text-muted)]">也可以直接手动编辑 <code className="font-mono text-[var(--accent)]">课程.md</code></div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="kb-fit kb-fit-aicourse mx-auto w-full max-w-[880px] px-6 py-6">
        <div className="flex items-start gap-x-4 gap-y-3 flex-wrap">
          <div className="min-w-0 flex-1 basis-[220px]">
            <h1 className="text-[21px] font-semibold text-[var(--text-primary)] line-clamp-2" title={state.outline.title || wsName}>{state.outline.title || wsName}</h1>
            {state.outline.goal && <div className="mt-1.5 text-[12px] text-[var(--text-secondary)] line-clamp-2" title={state.outline.goal}>🎯 {state.outline.goal}</div>}
            {state.outline.anchor && (
              <div className="mt-2 flex items-center gap-2 text-[11.5px]">
                <span className="px-1.5 py-0.5 rounded bg-[var(--success)]/15 text-[var(--success)] font-semibold">来源锚定：{state.outline.anchor}</span>
              </div>
            )}
          </div>
          <div className="ml-auto flex items-center gap-4 shrink-0">
            <div className="kb-l2 text-right">
              <div className="text-[20px] font-bold text-[var(--accent)]">{done}<span className="text-[12px] font-normal text-[var(--text-muted)]"> / {total} 已掌握</span></div>
              <div className="kb-l1 mt-1.5 h-[5px] w-[130px] rounded-full bg-[var(--border-color)] overflow-hidden">
                <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
              </div>
            </div>
            {onGoChat && (
              <button onClick={onGoChat} title="改大纲 / 展开下一章 / 删知识点：对教学助手说"
                className="px-2.5 py-1 rounded-md border border-[var(--accent)]/45 text-[11.5px] text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors">改大纲（对助手说）</button>
            )}
          </div>
        </div>

        {cont && (
          <div className="mt-5 mb-5 flex items-center gap-3 rounded-xl border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-4 py-3.5">
            <div className="w-[38px] h-[38px] rounded-lg bg-[var(--accent)] text-white flex items-center justify-center shrink-0"><Play size={18} /></div>
            <div className="min-w-0 flex-1">
              <div className="text-[10.5px] font-semibold text-[var(--accent)] tracking-wide">继续学习</div>
              <div className="mt-0.5 text-[14.5px] font-semibold text-[var(--text-primary)] truncate">{cont.name}</div>
              <div className="mt-0.5 text-[11.5px] text-[var(--text-secondary)] truncate">{cont.goal || '（未设定目标）'} · 掌握度 {Math.round((state.progress[cont.id]?.mastery ?? 0) * 100)}%</div>
            </div>
            <button onClick={() => onStartUnit(cont.id)}
              className="shrink-0 px-3.5 py-2 rounded-lg bg-[var(--accent)] text-white text-[12px] hover:opacity-90 transition-opacity">继续上课</button>
          </div>
        )}

        {(state.outline.chapters ?? []).map(ch => {
          const cd = ch.units.filter(u => state.progress[u.id]?.status === 'mastered').length
          const closed = collapsed.has(ch.id)
          return (
            <div key={ch.id}>
              <button onClick={() => toggleChapter(ch.id)} className="w-full flex items-center gap-2 py-2 text-left">
                <ChevronDown size={13} className={`text-[var(--text-muted)] transition-transform ${closed ? '-rotate-90' : ''}`} />
                <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">{ch.name}</span>
                <span className="text-[11px] text-[var(--text-muted)]">{cd}/{ch.units.length}</span>
                <span className="flex-1 max-w-[140px] h-[4px] rounded-full bg-[var(--bg-hover)] overflow-hidden">
                  <span className="block h-full bg-[var(--accent)]" style={{ width: `${ch.units.length ? (cd / ch.units.length) * 100 : 0}%` }} />
                </span>
              </button>
              {!closed && ch.units.map((u, i) => {
                const st = state.progress[u.id]?.status ?? 'todo'
                const mastery = state.progress[u.id]?.mastery ?? 0
                const ai = (u.source || '').startsWith('AI')
                const uLessons = Object.values(state.lessons ?? {}).filter(l => l.unitId === u.id)
                const endedN = uLessons.filter(l => l.status === 'ended').length
                const allEnded = uLessons.length > 0 && endedN === uLessons.length
                const finished = !!state.progress[u.id]?.finished
                return (
                  <div key={u.id} className="flex items-center gap-3 rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] px-3.5 py-2.5 mb-2 hover:border-[var(--accent)]/40 transition-colors">
                    <span className={`w-[26px] h-[26px] rounded-lg flex items-center justify-center text-[11.5px] font-semibold shrink-0 ${ST_CLS[st] ?? ''}`}>
                      {st === 'mastered' ? <Check size={13} /> : i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13.5px] font-semibold text-[var(--text-primary)]">{u.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${ST_CLS[st] ?? ''}`}>{ST_LABEL[st] ?? st}</span>
                        {u.source && <span className={`text-[10px] px-1.5 py-0.5 rounded ${ai ? 'bg-[var(--warning)]/15 text-[var(--warning)]' : 'bg-[var(--bg-hover)] text-[var(--text-muted)]'}`}>{u.source}</span>}
                      </div>
                      {u.goal && <div className="mt-0.5 text-[11.5px] text-[var(--text-secondary)] truncate">{u.goal}</div>}
                    </div>
                    <div className="w-[84px] shrink-0">
                      <div className="h-[5px] rounded-full bg-[var(--bg-hover)] overflow-hidden"><div className="h-full bg-[var(--accent)]" style={{ width: `${mastery * 100}%` }} /></div>
                      <div className="mt-0.5 text-right text-[10px] text-[var(--text-muted)]">{Math.round(mastery * 100)}%</div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button onClick={() => onStartUnit(u.id)} className="px-2.5 py-1 rounded-md border border-[var(--border-color)] text-[11.5px] text-[var(--text-secondary)] hover:border-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors">
                        {finished ? '重温' : uLessons.length ? '继续' : '开始'}
                      </button>
                      {uLessons.length > 0 && <span className="text-[10px] text-[var(--text-muted)] tabular-nums">{endedN}/{uLessons.length} 课时</span>}
                      {!finished && allEnded && (
                        <button onClick={() => void startFinishQuiz(u.id)} className="px-2.5 py-1 rounded-md border border-[var(--success)]/40 text-[11.5px] text-[var(--success)] hover:bg-[var(--success)]/10 transition-colors">结束本知识点</button>
                      )}
                      {finished && (
                        <>
                          <span className="text-[10px] font-semibold text-[var(--success)]">已收尾</span>
                          <button onClick={() => onReopenUnit(u.id)} className="px-2.5 py-1 rounded-md border border-[var(--border-color)] text-[11.5px] text-[var(--text-secondary)] hover:border-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors">回炉复习</button>
                        </>
                      )}
                      <button onClick={() => void doRemoveUnit(u)} title={st !== 'todo' ? '已学习：需先让助手整理归档再删' : '删除知识点'}
                        className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--danger)] transition-colors"><Trash2 size={12} /></button>
                    </div>
                  </div>
                )
              })}
              {!closed && (
                <button onClick={() => onOpenChapterReview(ch.id)} title="点进和课程助手讨论本章复习"
                  className="mt-1 flex w-full items-center gap-3 rounded-xl border border-dashed border-[var(--accent)]/45 bg-[var(--accent)]/5 px-3.5 py-2.5 text-left transition-colors hover:border-[var(--accent)]/70 hover:bg-[var(--accent)]/10">
                  <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg bg-[var(--accent)]/15 text-[var(--accent)]"><Repeat size={13} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-[var(--text-primary)]">复习课</span>
                      <span className="rounded px-1.5 py-0.5 text-[9.5px] font-semibold bg-[var(--accent)]/12 text-[var(--accent)]">章末</span>
                    </span>
                    <span className="mt-0.5 block truncate text-[11.5px] text-[var(--text-secondary)]">回顾本章知识点 · 和课程助手讨论后生成复习讲义</span>
                  </span>
                  {state.reviews?.[ch.id]?.rel && (
                    <span className="shrink-0 text-[11px] font-medium text-[var(--accent)]">复习讲义 →</span>
                  )}
                </button>
              )}
            </div>
          )
        })}
        <div className="mt-3 rounded-xl border border-dashed border-[var(--border-color)] py-3 text-center text-[12px] text-[var(--text-muted)]">
          要加下一章？对<b>教学助手</b>说「展开下一章」即可（也可直接改 <code className="font-mono text-[var(--accent)]">课程.md</code>）
        </div>
        {quiz && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/35 p-4" onClick={() => setQuiz(null)}>
            <div className="w-[min(560px,94vw)] max-h-[86vh] overflow-y-auto rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              {quiz.done ? (
                <div>
                  <div className="text-[15px] font-semibold text-[var(--text-primary)]">自测完成：{quiz.score} / {quiz.qs.length}</div>
                  <div className="mt-2 text-[12.5px] text-[var(--text-secondary)]">接下来生成这个知识点的总结篇（进入引用网络）。</div>
                  <div className="mt-4 flex justify-end gap-2">
                    <button onClick={() => setQuiz(null)} className="px-3 py-1.5 rounded-lg border border-[var(--border-color)] text-[12px] text-[var(--text-secondary)] hover:border-[var(--accent)]/50">稍后</button>
                    <button onClick={() => { const id = quiz.unitId; const sc = { correct: quiz.score, total: quiz.qs.length }; setQuiz(null); onFinishUnit(id, sc) }} className="px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12px] hover:opacity-90">生成总结篇</button>
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
                      className="px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12px] hover:opacity-90 disabled:opacity-40">
                      {quiz.i < quiz.qs.length - 1 ? '下一题' : '提交'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
