import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, BookOpen, ChevronRight, Loader2, Sparkles } from 'lucide-react'
import type { AiTeachChapterAssignment, AiTeachCourseChapter, AiTeachSource, AiTeachSegmentSource } from '../../types'
import {
  anchorLabel,
  buildPreflight,
  defaultUnitSelection,
  type PreflightUnit,
  type SourceEntry,
} from '../../lib/aiTeachingSourcesPure'

/**
 * AI教学 3.14 开段预检（中栏整页，不是弹窗）。
 * 选本段知识点 → 看本章素材的「精确 / 缩窄 / 整章」匹配 → 确认后把段快照交给 openSegment。
 */

interface Props {
  chapter: AiTeachCourseChapter
  units: PreflightUnit[]
  assignments: AiTeachChapterAssignment[]
  sources: AiTeachSource[]
  initialUnitId?: string
  prevHandoff: string
  busy: boolean
  onCancel: () => void
  onConfirm: (unitIds: string[], sources: AiTeachSegmentSource[]) => void
}

const MODE_LABEL: Record<'exact' | 'narrow' | 'fallback', string> = {
  exact: '精确',
  narrow: '缩窄',
  fallback: '整章',
}

const MODE_CLS: Record<'exact' | 'narrow' | 'fallback', string> = {
  exact: 'text-[var(--success)] bg-[var(--success)]/10',
  narrow: 'text-[var(--warning)] bg-[var(--warning)]/10',
  fallback: 'text-[var(--text-muted)] bg-[var(--bg-hover)]',
}

export function Preflight(props: Props) {
  const { chapter, units, assignments, sources, initialUnitId, prevHandoff, busy, onCancel, onConfirm } = props
  const [selectedUnits, setSelectedUnits] = useState<string[]>(() => defaultUnitSelection(units, initialUnitId ?? '', 3))
  const [sourcePick, setSourcePick] = useState<string[] | null>(null)

  useEffect(() => {
    setSelectedUnits(defaultUnitSelection(units, initialUnitId ?? '', 3))
    setSourcePick(null)
  }, [chapter.id, initialUnitId]) // eslint-disable-line react-hooks/exhaustive-deps

  const preflight = useMemo(
    () => buildPreflight({ units, assignments, sources: sources as unknown as SourceEntry[], selectedUnitIds: selectedUnits, clickedUnitId: initialUnitId }),
    [units, assignments, sources, selectedUnits, initialUnitId],
  )

  const autoSources = useMemo(() => {
    const exact = preflight.candidates.filter((c) => c.mode !== 'fallback')
    const pool = exact.length ? exact : preflight.candidates
    return pool.map((c) => c.sourceId)
  }, [preflight.candidates])
  const picked = new Set(sourcePick ?? autoSources)
  const selectedUnitSet = new Set(selectedUnits)

  const toggleUnit = (id: string): void => {
    const u = units.find((x) => x.id === id)
    if (!u || u.learned) return
    setSourcePick(null)
    setSelectedUnits((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }
  const toggleSource = (id: string): void => {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSourcePick([...next])
  }

  const confirm = (): void => {
    const orderedUnits = chapter.units.map((u) => u.id).filter((id) => selectedUnitSet.has(id))
    if (!orderedUnits.length) return
    const segs: AiTeachSegmentSource[] = preflight.candidates
      .filter((c) => picked.has(c.sourceId))
      .map((c) => ({ sourceId: c.sourceId, label: c.label, anchor: c.anchor, mode: c.mode }))
    onConfirm(orderedUnits, segs)
  }

  const unlearned = units.filter((u) => !u.learned)
  const selectedCount = selectedUnits.length
  const sourceCount = preflight.candidates.filter((c) => picked.has(c.sourceId)).length

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-[820px] mx-auto px-5 py-5">
        <div className="flex items-start gap-2">
          <Sparkles size={16} className="mt-0.5 shrink-0 text-[var(--accent)]" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-[var(--text-primary)]">开一段 · {chapter.name}</div>
            <div className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
              选本段要学的知识点（同章、可多选），再确认这一段用哪些素材。开段后这一段只围绕选中的知识点推进。
            </div>
          </div>
        </div>

        <section className="mt-5">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-[var(--text-primary)]">本段知识点</span>
            <span className="text-[10.5px] text-[var(--text-muted)]">已选 {selectedCount} 个 · 已学 {units.length - unlearned.length} 个</span>
          </div>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {units.map((u) => {
              const on = selectedUnitSet.has(u.id)
              const disabled = !!u.learned
              return (
                <button
                  key={u.id}
                  onClick={() => toggleUnit(u.id)}
                  disabled={disabled}
                  className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border text-left transition-colors ${disabled ? 'opacity-45 cursor-not-allowed border-[var(--border-color)]' : on ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-[var(--border-color)] hover:bg-[var(--bg-hover)]'}`}
                >
                  <span className={`shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center text-[9px] ${on ? 'bg-[var(--accent)] border-[var(--accent)] text-white' : 'border-[var(--border-color)] text-transparent'}`}>✓</span>
                  <span className={`min-w-0 flex-1 truncate text-[12px] ${u.learned ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>{u.name}</span>
                  {u.learned && <span className="shrink-0 text-[9.5px] text-[var(--text-muted)]">已学</span>}
                </button>
              )
            })}
          </div>
          {unlearned.length === 0 && (
            <div className="mt-2 text-[11px] text-[var(--text-muted)]">本章知识点都学完了。可以去章末复习，或点已学知识点回看。</div>
          )}
        </section>

        <section className="mt-5">
          <div className="flex items-center gap-2">
            <BookOpen size={13} className="text-[var(--accent)]" />
            <span className="text-[12px] font-medium text-[var(--text-primary)]">本段素材</span>
            <span className="text-[10.5px] text-[var(--text-muted)]">已选 {sourceCount} 条 · 默认按文件名 / 标题缩窄，匹配不到回退整章</span>
          </div>
          {preflight.candidates.length === 0 ? (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/5 px-3 py-2 text-[11.5px] text-[var(--text-secondary)]">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--warning)]" />
              本章还没有分配素材，本段只能按大纲讲。可以先去右栏「素材」登记 / 分配，或让课程助手分配。
            </div>
          ) : (
            <div className="mt-2 flex flex-col gap-1.5">
              {preflight.candidates.map((c) => {
                const on = picked.has(c.sourceId)
                return (
                  <div key={c.sourceId} className={`rounded-lg border px-3 py-2 transition-colors ${on ? 'border-[var(--border-color)] bg-[var(--bg-primary)]' : 'border-[var(--border-color)] opacity-60'}`}>
                    <div className="flex items-center gap-2">
                      <button onClick={() => toggleSource(c.sourceId)} className={`shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center text-[9px] ${on ? 'bg-[var(--accent)] border-[var(--accent)] text-white' : 'border-[var(--border-color)] text-transparent'}`}>✓</button>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">{c.title}</span>
                      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[9.5px] ${MODE_CLS[c.mode]}`}>{MODE_LABEL[c.mode]}</span>
                    </div>
                    <div className="mt-1 pl-5 text-[10.5px] text-[var(--text-muted)]">
                      {c.label} · {anchorLabel(c.anchor)} · {c.reason}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {preflight.unmatchedUnitIds.length > 0 && (
            <div className="mt-2 text-[10.5px] text-[var(--warning)]">
              {preflight.unmatchedUnitIds.length} 个选中的知识点没有匹配到素材，会按大纲讲。
            </div>
          )}
        </section>

        {prevHandoff && (
          <details className="mt-5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
            <summary className="cursor-pointer select-none px-3 py-2 text-[11.5px] text-[var(--text-secondary)]">
              上一段交接（同章）
            </summary>
            <pre className="max-h-[220px] overflow-y-auto px-3 pb-3 whitespace-pre-wrap font-[var(--font-family)] text-[11px] leading-relaxed text-[var(--text-secondary)]">{prevHandoff}</pre>
          </details>
        )}

        <div className="mt-6 flex items-center gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-[var(--border-color)] px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            取消
          </button>
          <div className="flex-1" />
          <button
            onClick={confirm}
            disabled={busy || selectedCount === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-4 py-1.5 text-[12px] text-white hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            开始本段
          </button>
        </div>
      </div>
    </div>
  )
}
