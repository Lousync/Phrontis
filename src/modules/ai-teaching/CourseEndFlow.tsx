import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowRight, Check, ChevronLeft, FileText, FolderOpen, Inbox, Loader2, ScrollText } from 'lucide-react'
import {
  aiTeachCourseCollectEndArtifacts,
  aiTeachCourseDepositEndArtifacts,
  aiTeachCourseEndCourse,
  aiTeachCourseGetEndState,
} from '../../lib/ipc'
import type { AiTeachEndArtifact, AiTeachEndArtifactGroup, AiTeachEndState, AiTeachEndTarget } from '../../types'
import { showToast } from '../../lib/toast'

/**
 * AI教学 · 结课流程（模块内整页视图，不是中央弹窗）。
 *
 * 三步：确认 → 挑选资料 → 整理沉淀；中途退出时暂存区可续。
 * 文案口径（AGENTS 铁律 26）：只用数据、路径、禁用态与步骤指示引导，不写解释性段落。
 */

const GROUP_LABEL: Record<AiTeachEndArtifactGroup, string> = {
  review: '章末复习讲义',
  lecture: '段讲义',
  summary: '阶段总结',
  mindmap: '思维导图',
  visual: '示意图',
}
const GROUP_ORDER: AiTeachEndArtifactGroup[] = ['review', 'lecture', 'summary', 'mindmap', 'visual']

function fmtSize(bytes: number): string {
  if (!bytes || bytes < 0) return '—'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function fmtDay(iso: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''))
  return m ? `${m[1]}-${m[2]}-${m[3]}` : ''
}

function groupArtifacts(list: AiTeachEndArtifact[]): Array<{ group: AiTeachEndArtifactGroup; items: AiTeachEndArtifact[] }> {
  return GROUP_ORDER.map((g) => ({ group: g, items: list.filter((a) => a.group === g) })).filter((x) => x.items.length > 0)
}

function baseName(rel: string): string {
  const parts = rel.split('/')
  return parts[parts.length - 1] ?? rel
}

interface Props {
  wsId: string
  initialStep?: 1 | 2 | 3
  onExit: () => void
  onEnded: () => void
  onEnterCourse: (wsId: string) => void
  onOpenReport: (wsId: string) => void
}

export function CourseEndFlow({ wsId, initialStep = 1, onExit, onEnded, onEnterCourse, onOpenReport }: Props) {
  const [state, setState] = useState<AiTeachEndState | null>(null)
  const [loading, setLoading] = useState(true)
  const [step, setStep] = useState<1 | 2 | 3 | 'result'>(initialStep)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [staged, setStaged] = useState<Set<string>>(new Set())
  const [target, setTarget] = useState<AiTeachEndTarget>({ space: '', notebook: '', subfolder: '结课资料', keepChapter: true })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState<{ deposited: number; kept: number; targetRel: string | null; days: number } | null>(null)

  const load = useCallback(async () => {
    const s = await aiTeachCourseGetEndState(wsId).catch(() => null)
    setState(s)
    setLoading(false)
    if (s) {
      setTarget(s.targets.lastTarget ?? s.targets.defaults)
      if (initialStep === 3 && s.staging.length) {
        const ids = s.staging.map((x) => x.id)
        setStaged(new Set(ids))
        setSelected(new Set(ids))
      } else {
        if (initialStep === 3) setStep(2)
        setSelected(new Set(s.artifacts.map((x) => x.id)))
      }
    }
    return s
  }, [wsId, initialStep])

  useEffect(() => { void load() }, [load])

  const artifacts = state?.artifacts ?? []
  const groups = useMemo(() => groupArtifacts(artifacts), [artifacts])
  const stagedList = state?.staging ?? []
  const stagedGroups = useMemo(() => groupArtifacts(stagedList), [stagedList])
  const selectedSize = useMemo(() => artifacts.filter((a) => selected.has(a.id)).reduce((n, a) => n + a.sizeBytes, 0), [artifacts, selected])

  const completion = state?.completion
  const ready = !!completion?.ready
  const days = (() => {
    if (!state?.startedAt) return 0
    const a = Date.parse(state.startedAt)
    const b = Date.now()
    return Number.isFinite(a) ? Math.max(0, Math.floor((b - a) / 86400000)) : 0
  })()

  const next = () => { setErr(''); setStep(2) }
  const cancel = () => { if (!busy) onExit() }

  const directEnd = async () => {
    setBusy(true); setErr('')
    const r = await aiTeachCourseEndCourse(wsId).catch(() => null)
    setBusy(false)
    if (!r?.ok) { setErr(r?.error ?? '结课失败'); return }
    const s = await load()
    setResult({ deposited: s?.deposit.count ?? 0, kept: s?.totals.kept ?? 0, targetRel: s?.deposit.target ? [s.deposit.target.space, s.deposit.target.notebook, s.deposit.target.subfolder].filter(Boolean).join('/') : null, days })
    setStep('result')
    onEnded()
  }

  const collect = async () => {
    const ids = [...selected]
    if (!ids.length) return
    setBusy(true); setErr('')
    const r = await aiTeachCourseCollectEndArtifacts(wsId, ids).catch(() => null)
    if (!r?.ok) { setBusy(false); setErr(r?.error ?? '收集失败'); return }
    const s = await load()
    setBusy(false)
    setStaged(new Set((s?.staging ?? []).map((x) => x.id)))
    setStep(3)
  }

  const deposit = async () => {
    const ids = [...staged]
    if (!ids.length) return
    setBusy(true); setErr('')
    const r = await aiTeachCourseDepositEndArtifacts(wsId, ids, target).catch(() => null)
    setBusy(false)
    if (!r) { setErr('沉淀失败'); return }
    if (r.failed > 0) { setErr(`${r.failed} 份沉淀失败，其余 ${r.deposited} 份已写入`); return }
    const s = await load()
    setResult({ deposited: r.deposited + r.skipped, kept: s?.totals.kept ?? 0, targetRel: r.targetRel, days })
    setStep('result')
    onEnded()
    showToast({ type: 'success', message: `已结课 · ${state?.name ?? ''}` })
  }

  const toggle = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string, on: boolean) => {
    setter(prev => {
      const n = new Set(prev)
      if (on) n.add(id); else n.delete(id)
      return n
    })
  }

  const header = (
    <div className="shrink-0 border-b border-[var(--border-color)] px-5 pt-4 pb-3">
      <button onClick={cancel} disabled={busy}
        className="flex items-center gap-1 text-[11.5px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-50">
        <ChevronLeft size={12} />课程列表
      </button>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h1 className="text-[18px] font-semibold text-[var(--text-primary)]">结课 · {state?.name ?? ''}</h1>
        <span className="text-[11px] text-[var(--text-muted)]">
          {completion ? `${completion.chapters} 章 · ${completion.learned}/${completion.total} 知识点 · ${state?.segments.segments ?? 0} 个学习段` : ''}
        </span>
      </div>
      {step !== 'result' && (
        <div className="mt-3 flex items-center gap-2 text-[11.5px] select-none">
          {(['确认结课', '挑选资料', '整理沉淀'] as const).map((label, i) => {
            const n = (i + 1) as 1 | 2 | 3
            const on = step === n
            const done = typeof step === 'number' && step > n
            return (
              <div key={label} className="flex items-center gap-2">
                <span className={`flex items-center gap-1.5 ${on ? 'text-[var(--accent)]' : done ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]'}`}>
                  <span className={`flex h-4 w-4 items-center justify-center rounded-full border text-[9.5px] ${on ? 'border-[var(--accent)] bg-[var(--accent)]/12' : done ? 'border-[var(--success)] text-[var(--success)]' : 'border-[var(--border-color)]'}`}>
                    {done ? <Check size={9} /> : n}
                  </span>
                  {label}
                </span>
                {i < 2 && <span className="h-px w-6 bg-[var(--border-color)]" />}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )

  if (loading) {
    return <div className="flex h-full items-center justify-center text-[12px] text-[var(--text-muted)]"><Loader2 size={14} className="mr-2 animate-spin" />加载中</div>
  }
  if (!state) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[12px] text-[var(--text-muted)]">
        <div>课程不可用</div>
        <button onClick={onExit} className="rounded-md border border-[var(--border-color)] px-2.5 py-1 text-[11.5px] hover:bg-[var(--bg-hover)]">返回课程列表</button>
      </div>
    )
  }

  return (
    <div className="kb-view-in flex h-full min-h-0 flex-col">
      {header}
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        <div className="mx-auto w-full max-w-[760px]">
          {step === 1 && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Fact value={`${completion?.chapters ?? 0}`} unit="章" label={completion ? `${completion.learned}/${completion.total} 个知识点` : '—'} />
                <Fact value={`${state.segments.ended}/${state.segments.segments}`} unit="段" label="已收尾" />
                <Fact value={`${days}`} unit="天" label={fmtDay(state.startedAt) ? `${fmtDay(state.startedAt)} 起` : '学习跨度'} />
                <Fact value={state.quiz ? `${state.quiz.avgScore}` : '—'} unit={state.quiz ? '分' : ''} label={state.quiz ? `${state.quiz.quizzes} 次测验 · ${state.quiz.wrong} 道错题` : '暂无测验'} />
              </div>
              {!ready && (
                <div className="flex items-center gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-3 py-2 text-[12px] text-[var(--text-secondary)]">
                  <FileText size={12} className="shrink-0 text-[var(--text-muted)]" />
                  <span className="tabular-nums">{completion?.learned ?? 0}/{completion?.total ?? 0} · {completion?.reviewsDone ?? 0}/{completion?.chapters ?? 0}</span>
                </div>
              )}
              <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)]">
                <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-3.5 py-2 text-[12px] font-medium text-[var(--text-primary)]">
                  <ScrollText size={12} className="text-[var(--accent)]" />结课报告
                  <span className="ml-auto text-[10px] font-normal text-[var(--text-muted)]">结课报告.md</span>
                </div>
                <div className="space-y-1 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
                  <div>完成情况：{ready ? '知识点全部学完，章末复习讲义已生成。' : `已学 ${completion?.learned ?? 0}/${completion?.total ?? 0} 个知识点。`}</div>
                  <div>测验：{state.quiz ? `${state.quiz.quizzes} 次，平均 ${state.quiz.avgScore} 分；${state.quiz.wrong} 道错题。` : '—'}</div>
                  <div>资料：{artifacts.length} 份可沉淀；题单与错题留在课程内。</div>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2">
                <span className="text-[11.5px] text-[var(--text-secondary)]">已选 <b className="text-[var(--text-primary)]">{selected.size}</b> 份 · 约 {fmtSize(selectedSize)}</span>
                <span className="flex-1" />
                <button onClick={() => setSelected(new Set(artifacts.map((a) => a.id)))}
                  className="rounded-md px-2 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]">全选</button>
                <button onClick={() => setSelected(new Set())}
                  className="rounded-md px-2 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]">全不选</button>
              </div>
              {groups.length === 0 && <div className="px-1 py-6 text-center text-[12px] text-[var(--text-muted)]">本课程还没有可沉淀资料</div>}
              {groups.map(({ group, items }) => {
                const all = items.every((a) => selected.has(a.id))
                const some = items.some((a) => selected.has(a.id))
                const size = items.reduce((n, a) => n + a.sizeBytes, 0)
                return (
                  <div key={group} className="overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)]">
                    <label className="flex cursor-pointer items-center gap-2 border-b border-[var(--border-color)] px-3 py-2">
                      <input type="checkbox" checked={all} ref={(el) => { if (el) el.indeterminate = !all && some }}
                        onChange={(e) => {
                          setSelected(prev => {
                            const n = new Set(prev)
                            for (const a of items) { if (e.target.checked) n.add(a.id); else n.delete(a.id) }
                            return n
                          })
                        }} className="accent-[var(--accent)]" />
                      <span className="text-[12px] font-medium text-[var(--text-primary)]">{GROUP_LABEL[group]}</span>
                      <span className="text-[10.5px] text-[var(--text-muted)]">{items.length} 份 · {fmtSize(size)}</span>
                    </label>
                    <div className="divide-y divide-[var(--border-color)]/60">
                      {items.map((a) => (
                        <label key={a.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 transition-colors hover:bg-[var(--bg-hover)]">
                          <input type="checkbox" checked={selected.has(a.id)} onChange={(e) => toggle(setSelected, a.id, e.target.checked)} className="accent-[var(--accent)]" />
                          <FileText size={11} className="shrink-0 text-[var(--text-muted)]" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[11.5px] text-[var(--text-primary)]">{a.title}</span>
                            <span className="block truncate text-[10px] text-[var(--text-muted)]">{a.relInWs}</span>
                          </span>
                          <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-muted)]">{fmtSize(a.sizeBytes)}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {step === 3 && (
            <div className="grid gap-2.5 lg:grid-cols-[minmax(0,1fr)_280px]">
              <div className="overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)]">
                <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-3 py-2 text-[12px] font-medium text-[var(--text-primary)]">
                  <Inbox size={12} className="text-[var(--accent)]" />待整理 · {state.name}
                  <span className="ml-auto text-[10px] font-normal text-[var(--text-muted)]">{staged.size} 份</span>
                </div>
                <div className="max-h-[46vh] overflow-y-auto px-3 py-2">
                  {stagedGroups.length === 0 && <div className="py-4 text-center text-[11.5px] text-[var(--text-muted)]">暂存区为空</div>}
                  {stagedGroups.map(({ group, items }) => (
                    <div key={group} className="mb-2">
                      <div className="mb-1 text-[10.5px] text-[var(--text-muted)]">{GROUP_LABEL[group]} · {items.length} 份</div>
                      {items.map((a) => (
                        <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-[var(--bg-hover)]">
                          <input type="checkbox" checked={staged.has(a.id)} onChange={(e) => toggle(setStaged, a.id, e.target.checked)} className="accent-[var(--accent)]" />
                          <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-primary)]">{a.title}</span>
                          <span className="min-w-0 max-w-[45%] truncate text-[10px] text-[var(--text-muted)]">{a.relInWs}</span>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5">
                <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-[var(--text-primary)]">
                  <FolderOpen size={12} className="text-[var(--accent)]" />沉淀到笔记区
                </div>
                <Field label="目标区域">
                  <input list="aiteach-space-list" value={target.space} onChange={(e) => setTarget(t => ({ ...t, space: e.target.value }))}
                    className="w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 text-[11.5px] outline-none focus:border-[var(--accent)]" />
                  <datalist id="aiteach-space-list">{state.targets.spaces.map(s => <option key={s.id} value={s.name} />)}</datalist>
                </Field>
                <Field label="笔记本">
                  <input list="aiteach-notebook-list" value={target.notebook} onChange={(e) => setTarget(t => ({ ...t, notebook: e.target.value }))}
                    className="w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 text-[11.5px] outline-none focus:border-[var(--accent)]" />
                  <datalist id="aiteach-notebook-list">
                    {(state.targets.spaces.find(s => s.name === target.space)?.notebooks ?? []).map(n => <option key={n.id} value={n.name} />)}
                  </datalist>
                </Field>
                <Field label="子文件夹">
                  <input value={target.subfolder} onChange={(e) => setTarget(t => ({ ...t, subfolder: e.target.value }))}
                    className="w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 text-[11.5px] outline-none focus:border-[var(--accent)]" />
                </Field>
                <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                  <input type="checkbox" checked={target.keepChapter} onChange={(e) => setTarget(t => ({ ...t, keepChapter: e.target.checked }))} className="accent-[var(--accent)]" />
                  保留章目录结构
                </label>
                <div className="mt-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
                  <div className="text-[var(--text-secondary)]">{target.space} › {target.notebook}{target.subfolder ? ` › ${target.subfolder}` : ''}</div>
                  <div className="truncate">
                    {(() => {
                      const first = stagedList.find(a => staged.has(a.id))
                      return `${target.keepChapter && first?.chapterRel ? `${first.chapterRel} › ` : ''}${first ? baseName(first.relInWs) : '—'}`
                    })()}
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 'result' && (
            <div className="flex flex-col items-center py-6 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--success)]/12 text-[var(--success)]"><Check size={22} /></span>
              <h2 className="mt-3 text-[17px] font-semibold text-[var(--text-primary)]">{state.name} · 已结课</h2>
              <div className="mt-3 grid w-full max-w-[420px] grid-cols-3 gap-2">
                <Stat value={result?.deposited ?? 0} label="份已沉淀" />
                <Stat value={result?.kept ?? 0} label="份留在课程内" />
                <Stat value={result?.days ?? days} label="天学习跨度" />
              </div>
              {result?.targetRel && (
                <div className="mt-3 text-[11.5px] text-[var(--text-secondary)]">
                  <span className="text-[var(--text-muted)]">沉淀到 </span>{result.targetRel}
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <button onClick={() => onOpenReport(wsId)}
                  className="flex items-center gap-1 rounded-lg border border-[var(--border-color)] px-3 py-1.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]">
                  <ScrollText size={12} />查看结课报告
                </button>
                <button onClick={() => onEnterCourse(wsId)}
                  className="flex items-center gap-1 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[12px] text-white transition-opacity hover:opacity-90">
                  <ArrowRight size={12} />进入课程
                </button>
                <button onClick={onExit}
                  className="rounded-lg px-3 py-1.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">返回课程列表</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {step !== 'result' && (
        <div className="shrink-0 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] px-5 py-2.5">
          <div className="mx-auto flex w-full max-w-[760px] items-center gap-2">
            <div className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-muted)]">
              {err ? <span className="text-red-400">{err}</span>
                : step === 2 ? <span>已选 <b className="text-[var(--text-secondary)]">{selected.size}</b> 份 · 约 {fmtSize(selectedSize)} · 收集到 {state.name}/待整理/</span>
                : step === 3 ? <span><b className="text-[var(--text-secondary)]">{staged.size}</b> 份 → {target.space} / {target.notebook} / {target.subfolder}</span>
                : <span className="tabular-nums">{completion?.learned ?? 0}/{completion?.total ?? 0} · {completion?.reviewsDone ?? 0}/{completion?.chapters ?? 0}</span>}
            </div>
            <button onClick={cancel} disabled={busy}
              className="rounded-md px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50">取消</button>
            {step === 1 && (
              <>
                <button onClick={() => void directEnd()} disabled={busy}
                  className="rounded-md px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50">直接结课</button>
                <button onClick={next} disabled={busy}
                  className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1 text-[12px] text-white transition-opacity hover:opacity-90 disabled:opacity-50">
                  下一步：挑选资料<ArrowRight size={12} />
                </button>
              </>
            )}
            {step === 2 && (
              <>
                <button onClick={() => { setErr(''); setStep(1) }} disabled={busy}
                  className="rounded-md px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50">上一步</button>
                <button onClick={() => void directEnd()} disabled={busy}
                  className="rounded-md px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50">直接结课</button>
                <button onClick={() => void collect()} disabled={busy || selected.size === 0}
                  className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1 text-[12px] text-white transition-opacity hover:opacity-90 disabled:opacity-50">
                  {busy ? <Loader2 size={12} className="animate-spin" /> : null}收集并继续<ArrowRight size={12} />
                </button>
              </>
            )}
            {step === 3 && (
              <>
                <button onClick={() => { setErr(''); setStep(2) }} disabled={busy}
                  className="rounded-md px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50">上一步</button>
                <button onClick={() => void deposit()} disabled={busy || staged.size === 0}
                  className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1 text-[12px] text-white transition-opacity hover:opacity-90 disabled:opacity-50">
                  {busy ? <Loader2 size={12} className="animate-spin" /> : null}沉淀到笔记区<ArrowRight size={12} />
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Fact({ value, unit, label }: { value: string; unit: string; label: string }) {
  return (
    <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-2">
      <div className="text-[15px] font-semibold text-[var(--text-primary)]">{value}{unit && <small className="ml-0.5 text-[10px] font-normal text-[var(--text-muted)]">{unit}</small>}</div>
      <div className="mt-0.5 truncate text-[10px] text-[var(--text-muted)]">{label}</div>
    </div>
  )
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-2">
      <div className="text-[15px] font-semibold text-[var(--text-primary)]">{value}</div>
      <div className="mt-0.5 text-[10px] text-[var(--text-muted)]">{label}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-1.5 block">
      <span className="mb-0.5 block text-[10px] text-[var(--text-muted)]">{label}</span>
      {children}
    </label>
  )
}
