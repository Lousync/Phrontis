import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Play, Plus, RotateCcw, Sparkles, Trash2, X } from 'lucide-react'
import type { AiTeachCourseOutline, AiTeachCourseState, AiTeachCourseUnit, AiTeachUnitQuizQuestion, AiTeachSourceItem, AiTeachOutlineAdditions } from '../../types'
import {
  aiTeachCourseGenerateOutlineStream, aiTeachCourseSaveOutline, aiTeachCourseMakeUnitQuiz, onAiTeachCourseGenProgress,
  aiTeachCourseGetSourceChanges, aiTeachCourseReviseOutlineStream, aiTeachCourseApplyAdditions,
} from '../../lib/ipc'
import { showToast } from '../../lib/toast'

/**
 * AI教学·课程模式前端（docs/ai-teaching-course-mode-plan.md）
 *
 * 定位（2026-09-30 拍板）：**课程模式 = 工作区主界面**。开启后：
 *   · 左栏「会话」区换成「课程大纲」树（index.tsx 渲染）；
 *   · 中栏在「课程主页」与「上课（会话）」之间切换（顶栏分段器，index.tsx 渲染）；
 *   · 本组件只负责**中栏内容**：无大纲 → 建课向导；有大纲 → 课程主页。
 * 数据全部走 IPC（主进程 aiTeachingCourse.ts）；本组件不直接碰盘。
 */

const ST_LABEL: Record<string, string> = { todo: '未开始', learning: '学习中', check: '待检验', mastered: '已掌握', review: '待复习' }
const ST_CLS: Record<string, string> = {
  todo: 'bg-[var(--bg-hover)] text-[var(--text-muted)]',
  learning: 'bg-[var(--accent)]/12 text-[var(--accent)]',
  check: 'bg-[var(--warning)]/15 text-[var(--warning)]',
  mastered: 'bg-[var(--success)]/15 text-[var(--success)]',
  review: 'bg-[var(--danger)]/12 text-[var(--danger)]',
}

const PHASE_LABEL: Record<string, string> = {
  request: '已发送请求，等待模型响应…',
  reasoning: '模型正在推理…',
  answer: '模型正在生成大纲…',
  parsing: '正在解析大纲 JSON…',
  done: '完成',
  failed: '失败',
}

export const COURSE_ST_LABEL = ST_LABEL

const SRC_MODES: Array<{ k: 'anchor' | 'materials' | 'mixed' | 'free'; t: string; d: string }> = [
  { k: 'anchor', t: '官方考纲 / 教材目录', d: '粘贴文本，AI 只做结构化、不发明' },
  { k: 'materials', t: '已有素材 / 提取稿', d: '勾选已登记素材，从其中抽知识点' },
  { k: 'mixed', t: '锚定 + 允许补充', d: '以依据/素材为主，缺的由 AI 补并标明' },
  { k: 'free', t: '只有目标，无来源', d: 'AI 自由生成，你事后审改（最不可控）' },
]

/** 素材键（与主进程 sourceKey 同口径）：name\0path —— 用于勾选回传 */
const srcKey = (it: { name: string; path: string }): string => `${String(it.name ?? '').trim()}\u0000${String(it.path ?? '').trim()}`
/** 是否提供正文：有提取稿，或本身是 md/code 文本素材、dir 目录素材（可读其文件/目录内文本） */
const hasBody = (it: AiTeachSourceItem): boolean => /^✓\s*→\s*.+/.test(String(it.extracted ?? '')) || it.type === 'md' || it.type === 'code' || it.type === 'dir'

interface Props {
  wsId: string
  wsName: string
  modelSpec?: string
  state: AiTeachCourseState
  onStartUnit: (unitId: string) => void
  onFinishUnit: (unitId: string, score?: { correct: number; total: number }) => void
  onReopenUnit: (unitId: string) => void
  onReload: () => void
}

export function CourseHome({ wsId, wsName, modelSpec, state, onStartUnit, onFinishUnit, onReopenUnit, onReload }: Props) {
  const [view, setView] = useState<'home' | 'wizard'>('home')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // L3 收尾自测：先出题 → 作答 → 再生成总结篇
  const [quiz, setQuiz] = useState<{ unitId: string; qs: AiTeachUnitQuizQuestion[]; i: number; picked: number | null; score: number; done: boolean } | null>(null)
  const [quizBusy, setQuizBusy] = useState(false)
  const [showRevise, setShowRevise] = useState(false)

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

  const units = useMemo(() => (state.outline?.chapters ?? []).flatMap(c => c.units), [state.outline])
  const total = units.length
  const done = units.filter(u => state.progress[u.id]?.status === 'mastered').length
  const cont = units.find(u => state.progress[u.id]?.status === 'learning')
    ?? units.find(u => state.progress[u.id]?.status !== 'mastered')

  const toggleChapter = useCallback((id: string) => {
    setCollapsed(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }, [])

  if (view === 'wizard') {
    return <Wizard wsName={wsName} wsId={wsId} modelSpec={modelSpec} outline={state.outline} onSaved={() => { onReload(); setView('home') }} onCancel={() => setView('home')} />
  }
  if (!state.outline) {
    return (
      <div className="h-full min-h-0 flex items-center justify-center px-6">
        <div className="w-full max-w-[440px] text-center">
          <div className="mx-auto w-[46px] h-[46px] rounded-xl bg-[var(--accent)]/12 text-[var(--accent)] flex items-center justify-center"><Sparkles size={22} /></div>
          <h2 className="mt-4 text-[17px] font-semibold text-[var(--text-primary)]">这个工作区还没有课程大纲</h2>
          <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">先定「学什么」。生成一份课程大纲（章 → 知识点），之后按知识点上课、检验，进度会自己沉淀。</p>
          <button onClick={() => setView('wizard')}
            className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[var(--accent)] text-white text-[12px] hover:opacity-90 transition-opacity"><Sparkles size={13} />生成课程大纲</button>
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
            <button onClick={() => setView('wizard')}
              className="px-2.5 py-1 rounded-md border border-[var(--border-color)] text-[11.5px] text-[var(--text-secondary)] hover:border-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors">编辑大纲</button>
            <button onClick={() => setShowRevise(true)}
              className="px-2.5 py-1 rounded-md border border-[var(--accent)]/45 text-[11.5px] text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors">＋ 修订大纲</button>
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
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}
        <div className="mt-3 rounded-xl border border-dashed border-[var(--border-color)] py-3 text-center text-[12px] text-[var(--text-muted)] cursor-pointer hover:border-[var(--accent)]/50" onClick={() => setView('wizard')}>
          ＋ 编辑大纲 / 添加知识点（也直接改 课程.md）
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
        {showRevise && state.outline && (
          <ReviseDrawer wsId={wsId} modelSpec={modelSpec} onClose={() => setShowRevise(false)} onApplied={onReload} />
        )}
      </div>
    </div>
  )
}

/**
 * 修订大纲抽屉：① 素材变更（比对 SOURCE.md 快照）② 新要求 → AI 只增补 → 勾选确认写回。
 * 产出形状 = 增补清单（非整份大纲），从数据上杜绝改动现有条目；写入保留现有 id/进度。
 */
function ReviseDrawer({ wsId, modelSpec, onClose, onApplied }: { wsId: string; modelSpec?: string; onClose: () => void; onApplied: () => void }) {
  const [items, setItems] = useState<AiTeachSourceItem[] | null>(null)
  const [req, setReq] = useState('')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState('')
  const [err, setErr] = useState('')
  const [additions, setAdditions] = useState<AiTeachOutlineAdditions | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)
  const genIdRef = useRef<string | null>(null)

  useEffect(() => {
    let alive = true
    void aiTeachCourseGetSourceChanges(wsId)
      .then(r => { if (alive) setItems(r.ok && r.items ? r.items : []) })
      .catch(() => { if (alive) setItems([]) })
    return () => { alive = false }
  }, [wsId])

  useEffect(() => onAiTeachCourseGenProgress((p) => {
    if (!p || p.id !== genIdRef.current) return
    setPhase(p.phase)
    if (p.phase === 'failed') setErr(p.error ?? '生成失败')
  }), [])

  const changed = (items ?? []).filter(i => i.change)
  const canGen = !!req.trim() || changed.length > 0
  const PH: Record<string, string> = { request: '已发送请求，等待模型响应…', reasoning: '模型正在推理…', answer: '模型正在生成增补建议…', parsing: '正在解析增补 JSON…' }

  const gen = useCallback(async () => {
    if (busy || !canGen) return
    const id = crypto.randomUUID(); genIdRef.current = id
    setBusy(true); setPhase('request'); setErr(''); setAdditions(null); setPicked(new Set())
    try {
      const r = await aiTeachCourseReviseOutlineStream(id, { wsId, requirement: req.trim(), useSources: true, modelSpec })
      if (!r.ok || !r.additions) { setErr(r.error ?? '生成失败'); return }
      setAdditions(r.additions)
      const keys = new Set<string>()
      r.additions.toExisting.forEach((_, i) => keys.add('to:' + i))
      r.additions.newChapters.forEach((c, ci) => c.units.forEach((_, ui) => keys.add(`ch:${ci}:${ui}`)))
      setPicked(keys)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false); setPhase('') }
  }, [busy, canGen, wsId, req, modelSpec])

  const toggle = useCallback((k: string) => setPicked(prev => {
    const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n
  }), [])

  const apply = useCallback(async () => {
    if (!additions || applying) return
    const filtered: AiTeachOutlineAdditions = {
      toExisting: additions.toExisting.filter((_, i) => picked.has('to:' + i)),
      newChapters: additions.newChapters
        .map((c, ci) => ({ name: c.name, units: c.units.filter((_, ui) => picked.has(`ch:${ci}:${ui}`)) }))
        .filter(c => c.units.length > 0),
    }
    const n = filtered.toExisting.length + filtered.newChapters.reduce((a, c) => a + c.units.length, 0)
    if (n === 0) { showToast({ type: 'warning', message: '没有勾选任何增补项' }); return }
    setApplying(true)
    const r = await aiTeachCourseApplyAdditions(wsId, filtered).catch(() => null)
    setApplying(false)
    if (!r?.ok) { showToast({ type: 'error', message: r?.error ?? '写入失败' }); return }
    showToast({ type: 'success', message: `已增补 ${r.added} 个知识点 → 课程.md` })
    onApplied(); onClose()
  }, [additions, picked, applying, wsId, onApplied, onClose])

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/35 kb-overlay" onClick={onClose} />
      <div className="fixed right-0 top-0 z-[61] h-full w-[560px] max-w-[94vw] flex flex-col bg-[var(--bg-primary)] border-l border-[var(--border-color)] shadow-2xl kb-pop">
        <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-[var(--border-color)]">
          <span className="text-[15px] font-semibold text-[var(--text-primary)]">修订大纲</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--warning)]/15 text-[var(--warning)] font-semibold">只增补</span>
          <button onClick={onClose} className="ml-auto text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">✕</button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
          <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
            以<strong className="text-[var(--text-primary)]">现有大纲为基础</strong>：AI 先比对 SOURCE.md 找出新增/变更的素材，再结合你的新要求，只<strong className="text-[var(--accent)]">新增</strong>知识点/章，<strong>不动</strong>现有条目，已有掌握度/课时不受影响。
          </div>

          <div className="mt-4 text-[12.5px] font-semibold text-[var(--text-primary)]">① 素材变更 <span className="font-normal text-[var(--text-muted)]">— 比对 SOURCE.md</span></div>
          <div className="mt-2 rounded-lg border border-[var(--border-color)] overflow-hidden">
            {items === null ? (
              <div className="px-3 py-2.5 text-[11.5px] text-[var(--text-muted)]">读取中…</div>
            ) : items.length === 0 ? (
              <div className="px-3 py-2.5 text-[11.5px] text-[var(--text-muted)]">工作区还没有登记素材</div>
            ) : items.map(it => (
              <div key={`${it.no}-${it.name}`} className="flex items-center gap-2 px-3 py-1.5 border-b last:border-b-0 border-[var(--border-color)] text-[11.5px]">
                <span className="font-mono text-[var(--text-muted)] w-7 shrink-0">#{it.no}</span>
                <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{it.name}</span>
                {it.change === 'new' && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent)]/12 text-[var(--accent)] font-semibold">新增</span>}
                {it.change === 'updated' && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-[var(--warning)]/15 text-[var(--warning)] font-semibold">已更新</span>}
                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-muted)]">{it.type}</span>
              </div>
            ))}
          </div>
          <div className="mt-1.5 text-[10.5px] text-[var(--text-muted)]">
            {changed.length
              ? `检测到 ${changed.length} 项变更（${changed.filter(c => c.change === 'new').length} 新增 · ${changed.filter(c => c.change === 'updated').length} 更新）`
              : '未检测到素材变更'}
          </div>

          <div className="mt-4 text-[12.5px] font-semibold text-[var(--text-primary)]">② 新的要求 / 想补充什么</div>
          <textarea value={req} onChange={e => setReq(e.target.value)} rows={3}
            placeholder={'例如：\n· 内存管理太薄，想要更细的虚存专题\n· 多加点调度算法的例题单元'}
            className="mt-2 w-full rounded-lg border border-[var(--border-color)] bg-[var(--input-bg)] px-3 py-2 text-[12.5px] text-[var(--text-primary)] outline-none resize-y focus:border-[var(--accent)]" />

          {busy && (
            <div className="mt-3 flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
              <span className="w-[14px] h-[14px] rounded-full border-2 border-[var(--border-color)] border-t-[var(--accent)] animate-spin" />
              {PH[phase] ?? '处理中…'}
            </div>
          )}
          {err && !busy && <div className="mt-3 text-[11.5px] text-[var(--danger)] break-all">{err}</div>}

          {additions && !busy && (
            <div className="mt-4">
              {additions.toExisting.length > 0 && (
                <div className="mb-3">
                  <div className="text-[12px] font-semibold text-[var(--text-secondary)] mb-1.5">在现有章节新增 · {additions.toExisting.length} 项</div>
                  {additions.toExisting.map((a, i) => {
                    const k = 'to:' + i; const on = picked.has(k)
                    return (
                      <button key={k} onClick={() => toggle(k)}
                        className={`w-full text-left flex items-start gap-2.5 rounded-lg border px-3 py-2 mb-1.5 transition-colors ${on ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border-color)] hover:border-[var(--accent)]/40'}`}>
                        <span className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center text-[10px] shrink-0 ${on ? 'bg-[var(--accent)] border-[var(--accent)] text-white' : 'border-[var(--text-muted)]'}`}>{on ? '✓' : ''}</span>
                        <span className="min-w-0">
                          <span className="block text-[12.5px] font-semibold text-[var(--text-primary)]">{a.name}
                            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-muted)] font-normal">{a.chapterName || a.chapterId || '现有章'}</span>
                          </span>
                          {a.why && <span className="block text-[10.5px] text-[var(--text-muted)] mt-0.5">{a.why}</span>}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
              {additions.newChapters.map((c, ci) => (
                <div key={'nc' + ci} className="mb-3">
                  <div className="text-[12px] font-semibold text-[var(--text-secondary)] mb-1.5">新增章节「{c.name}」· {c.units.length} 项</div>
                  {c.units.map((u, ui) => {
                    const k = `ch:${ci}:${ui}`; const on = picked.has(k)
                    return (
                      <button key={k} onClick={() => toggle(k)}
                        className={`w-full text-left flex items-start gap-2.5 rounded-lg border px-3 py-2 mb-1.5 transition-colors ${on ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border-color)] hover:border-[var(--accent)]/40'}`}>
                        <span className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center text-[10px] shrink-0 ${on ? 'bg-[var(--accent)] border-[var(--accent)] text-white' : 'border-[var(--text-muted)]'}`}>{on ? '✓' : ''}</span>
                        <span className="min-w-0">
                          <span className="block text-[12.5px] font-semibold text-[var(--text-primary)]">{u.name}</span>
                          {u.why && <span className="block text-[10.5px] text-[var(--text-muted)] mt-0.5">{u.why}</span>}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))}
              <div className="text-[10.5px] text-[var(--text-muted)]">✻ 未勾选的建议不会写入；现有条目一律不动。</div>
            </div>
          )}
        </div>

        <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-t border-[var(--border-color)] bg-[var(--bg-secondary)]">
          {!additions ? (
            <button onClick={() => void gen()} disabled={busy || !canGen}
              className="px-3.5 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12px] hover:opacity-90 disabled:opacity-40 transition-opacity">
              {busy ? '生成中…' : '生成增补建议'}
            </button>
          ) : (
            <>
              <button onClick={() => { setAdditions(null); void gen() }} disabled={busy}
                className="px-2.5 py-1.5 rounded-lg border border-[var(--border-color)] text-[12px] text-[var(--text-secondary)] hover:border-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors">重新生成</button>
              <button onClick={() => void apply()} disabled={applying || picked.size === 0}
                className="ml-auto px-3.5 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12px] hover:opacity-90 disabled:opacity-40 transition-opacity">
                {applying ? '写入中…' : `确认写入（${picked.size}）`}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  )
}

/** 建课向导：依据锚定 + AI 流式生成（过程可见）+ 可编辑确认 */
function Wizard({ wsName, wsId, modelSpec, outline, onSaved, onCancel }: { wsName: string; wsId: string; modelSpec?: string; outline: AiTeachCourseOutline | null; onSaved: () => void; onCancel?: () => void }) {
  const [goal, setGoal] = useState(outline?.goal ?? '')
  const [mode, setMode] = useState<'anchor' | 'materials' | 'mixed' | 'free'>(outline?.anchor ? 'anchor' : 'free')
  const [anchorLabel, setAnchorLabel] = useState(outline?.anchor ?? '')
  const [anchorText, setAnchorText] = useState('')
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<AiTeachCourseOutline | null>(outline)
  // 登记素材清单 + 勾选（materials / mixed 模式）
  const [srcItems, setSrcItems] = useState<AiTeachSourceItem[] | null>(null)
  const [pickedSrc, setPickedSrc] = useState<Set<string>>(new Set())
  // 生成过程（流式）：让用户看到「走到哪一步」，失败也能看到模型原文与错误点
  const [genPhase, setGenPhase] = useState('')
  const [genModel, setGenModel] = useState('')
  const [genReasoning, setGenReasoning] = useState('')
  const [genAnswer, setGenAnswer] = useState('')
  const [genErr, setGenErr] = useState('')
  /** 过程输出（推理+回答）是否展开：流式时展开，完成后自动收起（可点标题栏展开重看） */
  const [genOpen, setGenOpen] = useState(true)
  const genIdRef = useRef<string | null>(null)

  useEffect(() => { setDraft(outline) }, [outline])

  // 拉登记素材（默认全选）
  useEffect(() => {
    let alive = true
    void aiTeachCourseGetSourceChanges(wsId)
      .then(r => {
        if (!alive) return
        const list = r.ok && r.items ? r.items : []
        setSrcItems(list)
        setPickedSrc(new Set(list.map(srcKey)))
      })
      .catch(() => { if (alive) { setSrcItems([]); setPickedSrc(new Set()) } })
    return () => { alive = false }
  }, [wsId])

  useEffect(() => {
    const off = onAiTeachCourseGenProgress((p) => {
      if (!p || p.id !== genIdRef.current) return
      setGenPhase(p.phase)
      if (p.model) setGenModel(p.model)
      if (p.phase === 'reasoning' && p.delta) setGenReasoning((t) => t + p.delta)
      if (p.phase === 'answer' && p.delta) setGenAnswer((t) => t + p.delta)
      if (p.phase === 'failed') setGenErr(p.error ?? '生成失败')
      if (p.phase === 'done') setGenOpen(false)
    })
    return off
  }, [])

  const needsAnchor = mode === 'anchor' || mode === 'mixed'
  const needsSources = mode === 'materials' || mode === 'mixed'
  const toggleSrc = useCallback((k: string) => setPickedSrc(prev => {
    const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n
  }), [])

  const gen = useCallback(async () => {
    if (busy) return
    const hasBasis = (needsAnchor && anchorText.trim()) || (needsSources && pickedSrc.size > 0)
    if (!goal.trim() && !hasBasis) {
      showToast({ type: 'warning', message: needsSources ? '请填写学习目标，或勾选依据素材' : '请先填写学习目标，或粘贴考纲/目录文本' })
      return
    }
    const id = crypto.randomUUID()
    genIdRef.current = id
    setGenPhase('request'); setGenModel(''); setGenReasoning(''); setGenAnswer(''); setGenErr(''); setGenOpen(true)
    setBusy(true)
    try {
      const r = await aiTeachCourseGenerateOutlineStream(id, {
        goal: goal.trim(),
        mode,
        anchorText: needsAnchor ? anchorText.trim() : '',
        anchorLabel: mode === 'materials' ? '已登记素材' : anchorLabel.trim(),
        wsId,
        sourceKeys: needsSources ? [...pickedSrc] : undefined,
        modelSpec,
      })
      if (!r.ok || !r.outline) { setGenErr(r.error ?? '生成失败'); setGenPhase('failed'); showToast({ type: 'error', message: r.error ?? '生成失败' }); return }
      if (!r.outline.title) r.outline.title = wsName
      setDraft(r.outline)
      showToast({ type: 'info', message: `已生成 ${r.outline.chapters.length} 章 / ${r.outline.chapters.reduce((n, c) => n + c.units.length, 0)} 个知识点，请核对` })
    } finally { setBusy(false) }
  }, [busy, goal, mode, anchorText, anchorLabel, needsAnchor, needsSources, pickedSrc, wsId, wsName, modelSpec])

  const save = useCallback(async () => {
    if (!draft) return
    const r = await aiTeachCourseSaveOutline(wsId, { ...draft, title: draft.title || wsName })
    if (!r.ok) { showToast({ type: 'error', message: r.error ?? '保存失败' }); return }
    showToast({ type: 'success', message: '大纲已写入 课程.md' })
    onSaved()
  }, [draft, wsId, wsName, onSaved])

  const setUnitName = (ci: number, ui: number, name: string) => setDraft(d => {
    if (!d) return d
    const chapters = d.chapters.map((c, i) => i !== ci ? c : { ...c, units: c.units.map((u, j) => j !== ui ? u : { ...u, name }) })
    return { ...d, chapters }
  })
  const rmUnit = (ci: number, ui: number) => setDraft(d => d ? { ...d, chapters: d.chapters.map((c, i) => i !== ci ? c : { ...c, units: c.units.filter((_, j) => j !== ui) }) } : d)
  const addUnit = (ci: number) => setDraft(d => {
    if (!d) return d
    const n = d.chapters.reduce((a, c) => a + c.units.length, 0) + 1
    return { ...d, chapters: d.chapters.map((c, i) => i !== ci ? c : { ...c, units: [...c.units, { id: `u${n}`, name: '新知识点', goal: '', source: '手动添加' }] }) }
  })
  const addChapter = () => setDraft(d => d ? { ...d, chapters: [...d.chapters, { id: `c${d.chapters.length + 1}`, name: `第${d.chapters.length + 1}章`, units: [] }] } : d)

  const srcCount = srcItems?.length ?? 0
  const extractedCount = (srcItems ?? []).filter(hasBody).length

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-[700px] px-8 py-8">
        <div className="flex items-center gap-2">
          <h1 className="text-[20px] font-semibold text-[var(--text-primary)]">{outline ? '编辑课程大纲' : '生成课程大纲'}</h1>
          {onCancel && <button onClick={onCancel} className="ml-auto text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">返回主页</button>}
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">先定「依据」再生成：锚定来源时 AI 只做结构化、不发明，这样你才敢信它给的知识点正好是你需要的。</p>

        <div className="mt-7 flex gap-3">
          <span className="w-6 h-6 rounded-full bg-[var(--accent)]/12 text-[var(--accent)] flex items-center justify-center text-[11.5px] font-semibold shrink-0">2</span>
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold text-[var(--text-primary)]">大纲的依据是什么？</div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {SRC_MODES.map(o => (
                <button key={o.k} onClick={() => setMode(o.k)}
                  className={`text-left rounded-lg border px-3 py-2.5 transition-colors ${mode === o.k ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border-color)] hover:border-[var(--accent)]/40'}`}>
                  <div className="flex items-center gap-2 text-[12.5px] font-semibold text-[var(--text-primary)]">
                    <span className={`w-[14px] h-[14px] rounded-full border shrink-0 ${mode === o.k ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--text-muted)]'}`} />
                    {o.t}
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--text-secondary)] leading-snug">{o.d}</div>
                </button>
              ))}
            </div>

            {needsAnchor && (
              <input value={anchorLabel} onChange={e => setAnchorLabel(e.target.value)} placeholder="依据名称，如 考研 408 考纲"
                className="mt-3 w-full rounded-lg border border-[var(--border-color)] bg-[var(--input-bg)] px-3 py-2 text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
            )}

            {/* 素材勾选表（materials / mixed）：默认全选 */}
            {needsSources && (
              <div className="mt-3">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="font-semibold text-[var(--text-primary)]">依据素材</span>
                  <span className="text-[11px] text-[var(--text-muted)]">{pickedSrc.size}/{srcCount}{extractedCount ? ` · ${extractedCount} 份有正文` : ''}</span>
                  <button
                    onClick={() => setPickedSrc(pickedSrc.size === srcCount ? new Set() : new Set((srcItems ?? []).map(srcKey)))}
                    className="ml-auto text-[11.5px] text-[var(--accent)] hover:underline">
                    {pickedSrc.size === srcCount && srcCount > 0 ? '全不选' : '全选'}
                  </button>
                </div>
                <div className="mt-1.5 rounded-lg border border-[var(--border-color)] overflow-hidden">
                  {srcItems === null ? (
                    <div className="px-3 py-2.5 text-[11.5px] text-[var(--text-muted)]">读取登记素材…</div>
                  ) : srcItems.length === 0 ? (
                    <div className="px-3 py-2.5 text-[11.5px] text-[var(--text-muted)]">工作区还没有登记素材，请先到素材库登记（或改用「官方考纲/教材目录」粘贴文本）</div>
                  ) : srcItems.map(it => {
                    const k = srcKey(it); const on = pickedSrc.has(k); const ex = hasBody(it)
                    return (
                      <button key={k} onClick={() => toggleSrc(k)}
                        className="w-full flex items-center gap-2.5 px-3 py-2 border-b last:border-b-0 border-[var(--border-color)] text-left hover:bg-[var(--bg-hover)] transition-colors">
                        <span className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] shrink-0 ${on ? 'bg-[var(--accent)] border-[var(--accent)] text-white' : 'border-[var(--text-muted)]'}`}>{on ? '✓' : ''}</span>
                        <span className="font-mono text-[var(--text-muted)] text-[11px] w-7 shrink-0">#{it.no}</span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-secondary)]">{it.name}</span>
                        {ex
                          ? <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-[var(--success)]/15 text-[var(--success)] font-semibold">有正文</span>
                          : <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-muted)]">{it.type}·仅清单</span>}
                      </button>
                    )
                  })}
                </div>
                <div className="mt-1 text-[10.5px] text-[var(--text-muted)]">「有正文」= 有提取稿，或本身就是 md/文本素材、目录素材（AI 会直接读其内容）；其余仅提供清单信息，AI 不会据此臆造。</div>
              </div>
            )}

            <textarea value={goal} onChange={e => setGoal(e.target.value)} placeholder="学习目标，如：备考 408 操作系统，三轮过完，重点虚存与调度" rows={2}
              className="mt-2 w-full rounded-lg border border-[var(--border-color)] bg-[var(--input-bg)] px-3 py-2 text-[12.5px] text-[var(--text-primary)] outline-none resize-y focus:border-[var(--accent)]" />

            {needsAnchor && (
              <textarea value={anchorText} onChange={e => setAnchorText(e.target.value)} placeholder="粘贴考纲 / 教材目录文本（AI 只据此拆分，不发明）" rows={4}
                className="mt-2 w-full rounded-lg border border-[var(--border-color)] bg-[var(--input-bg)] px-3 py-2 text-[12.5px] text-[var(--text-primary)] outline-none resize-y focus:border-[var(--accent)]" />
            )}

            <button onClick={() => void gen()} disabled={busy}
              className="mt-3 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[var(--accent)] text-white text-[12px] hover:opacity-90 disabled:opacity-50 transition-opacity">
              {busy ? <><RotateCcw size={13} className="animate-spin" /> 正在拆解…</> : <><Sparkles size={13} /> {draft ? '重新生成大纲' : '生成课程大纲'}</>}
            </button>

            {(busy || genPhase || genErr) && (
              <div className="mt-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] overflow-hidden kb-view-in">
                <button onClick={() => setGenOpen(v => !v)} disabled={!genReasoning && !genAnswer}
                  className="w-full flex items-center gap-2 px-3 py-2 text-[12px] border-b border-[var(--border-color)] text-left transition-colors enabled:hover:bg-[var(--bg-hover)] disabled:cursor-default">
                  {genPhase === 'failed'
                    ? <span className="w-2 h-2 rounded-full bg-[var(--danger)] shrink-0" />
                    : busy
                      ? <RotateCcw size={12} className="animate-spin text-[var(--accent)] shrink-0" />
                      : <span className="w-2 h-2 rounded-full bg-[var(--success)] shrink-0" />}
                  <span className={genPhase === 'failed' ? 'text-[var(--danger)] font-medium' : 'text-[var(--text-primary)]'}>{PHASE_LABEL[genPhase] ?? '准备中…'}</span>
                  {!busy && (genReasoning || genAnswer) && (
                    <span className="text-[10.5px] text-[var(--text-muted)]">{genOpen ? '收起' : `查看输出（${(genReasoning + genAnswer).length} 字）`}</span>
                  )}
                  {genModel && <span className="ml-auto text-[10.5px] text-[var(--text-muted)] font-mono truncate max-w-[200px]" title={genModel}>{genModel}</span>}
                  {(genReasoning || genAnswer) && <ChevronDown size={13} className={`shrink-0 text-[var(--text-muted)] transition-transform ${genOpen ? '' : '-rotate-90'}`} />}
                </button>
                {genOpen && (genReasoning || genAnswer) && (
                  <pre className="px-3 py-2 text-[11.5px] leading-relaxed whitespace-pre-wrap break-words max-h-[240px] overflow-y-auto m-0">
                    {genReasoning && <span className="text-[var(--text-muted)]">{genReasoning}</span>}
                    {genAnswer && <span className="text-[var(--text-primary)]">{genAnswer}</span>}
                  </pre>
                )}
                {genErr && (
                  <div className="px-3 py-2 text-[11.5px] text-[var(--danger)] border-t border-[var(--border-color)] break-words">{genErr}</div>
                )}
              </div>
            )}
          </div>
        </div>

        {draft && (
          <div className="mt-7 flex gap-3">
            <span className="w-6 h-6 rounded-full bg-[var(--accent)]/12 text-[var(--accent)] flex items-center justify-center text-[11.5px] font-semibold shrink-0">3</span>
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-semibold text-[var(--text-primary)]">确认两级大纲（章 → 知识点）</div>
              <div className="mt-3 rounded-lg border border-[var(--border-color)] overflow-hidden">
                {draft.chapters.map((ch, ci) => (
                  <div key={ch.id}>
                    <div className="px-3 py-2 bg-[var(--bg-secondary)] text-[11.5px] font-semibold text-[var(--text-secondary)]">{ch.name}</div>
                    {ch.units.map((u, ui) => (
                      <div key={u.id} className="flex items-center gap-2 px-3 py-2 border-t border-[var(--border-color)]">
                        <span className="text-[10.5px] font-mono text-[var(--text-muted)] w-10 shrink-0">{u.id}</span>
                        <input value={u.name} onChange={e => setUnitName(ci, ui, e.target.value)}
                          className="flex-1 min-w-0 bg-transparent text-[12.5px] text-[var(--text-primary)] outline-none" />
                        {u.source && <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${u.source.startsWith('AI') ? 'bg-[var(--warning)]/15 text-[var(--warning)]' : 'bg-[var(--bg-hover)] text-[var(--text-muted)]'}`}>{u.source}</span>}
                        <button onClick={() => rmUnit(ci, ui)} className="text-[var(--text-muted)] hover:text-[var(--danger)] shrink-0"><Trash2 size={12} /></button>
                      </div>
                    ))}
                    <button onClick={() => addUnit(ci)} className="w-full flex items-center gap-1.5 px-3 py-2 border-t border-[var(--border-color)] text-[12px] text-[var(--accent)] hover:bg-[var(--bg-hover)]">
                      <Plus size={12} /> 在本章添加知识点
                    </button>
                  </div>
                ))}
                <button onClick={addChapter} className="w-full flex items-center gap-1.5 px-3 py-2 bg-[var(--bg-secondary)] border-t border-[var(--border-color)] text-[12px] text-[var(--accent)] hover:bg-[var(--bg-hover)]">
                  <Plus size={12} /> 添加章节
                </button>
              </div>
              <div className="mt-3 rounded-lg border border-dashed border-[var(--border-color)] px-3 py-2.5 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
                将写入 <code className="font-mono text-[var(--accent)]">AI教学/{wsName}/课程.md</code>（大纲）与 <code className="font-mono text-[var(--accent)]">.knowbase/modules/aiTeaching/progress.json</code>（进度）。
              </div>
              <div className="mt-3 flex gap-2">
                <button onClick={() => void save()} className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-[12.5px] hover:opacity-90 transition-opacity">确认，进入课程主页</button>
                <button onClick={() => setDraft(null)} className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-[var(--border-color)] text-[12px] text-[var(--text-secondary)] hover:border-[var(--danger)]/50 hover:text-[var(--danger)]"><X size={12} /> 清空重来</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
