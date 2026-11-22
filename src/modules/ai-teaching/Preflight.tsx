import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, BookOpen, ChevronDown, ChevronRight, Loader2, Search, Sparkles } from 'lucide-react'
import type { AiTeachChapterAssignment, AiTeachCourseChapter, AiTeachSource, AiTeachSegmentSource } from '../../types'
import {
  anchorLabel,
  buildPreflight,
  defaultUnitSelection,
  type PreflightUnit,
  type SourceEntry,
} from '../../lib/aiTeachingSourcesPure'
import { AnchoredLayer } from '../../components/shared/AnchoredLayer'
import { orderSelectedUnits } from '../../lib/courseOutlineTopo'
import { useModelCatalog } from '../../lib/modelCatalog'
import { llmCatalogSetWorkspace } from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { bindingPatch, pickerEntriesForWorkspace, resolveWorkspaceModel } from './workspaceModelPure'
import { modelLineView, pickerSections } from './preflightModelPure'

/**
 * AI教学 3.14 开段预检（中栏整页，不是弹窗）。
 * 选本段知识点 → 看本章素材的「精确 / 缩窄 / 整章」匹配 → 确认后把段快照交给 openSegment。
 *
 * 段内顺序（2026-11-22）：确认时把选中集合按**章内先修拓扑序**重排（`orderSelectedUnits`），
 * 因为 `lesson.unitIds` 的顺序就是讲解顺序（注入清单 / 「当前聚焦第 X/N」/ `activeUnitId` 都跟着它）。
 * 无 `requires` / 有环 / 缺先修时输出 = 大纲行序，与改造前逐字一致；选中集合不变。
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
  /** 所属课程（工作区）id；不传 → 不渲染「本课程模型」行，行为与改造前一致 */
  workspaceId?: string
  /** 主线会话已单独选过的模型 id；非空 → 本行只提示不给改 */
  conversationModelId?: string
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
  const { chapter, units, assignments, sources, initialUnitId, prevHandoff, busy, onCancel, onConfirm, workspaceId, conversationModelId } = props
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
    // 段内讲解顺序 = 章内先修拓扑序（无 requires / 有环 → 与大纲行序逐字一致）
    const orderedUnits = orderSelectedUnits(chapter.units, selectedUnits).map((u) => u.id)
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
    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
      <div className="w-full max-w-[820px] mx-auto px-5 py-5 my-auto">
        <div className="flex items-start gap-2">
          <Sparkles size={16} className="mt-0.5 shrink-0 text-[var(--accent)]" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-[var(--text-primary)]">开一段 · {chapter.name}</div>
            <div className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
              选本段要学的知识点（同章、可多选），再确认这一段用哪些素材。开段后这一段只围绕选中的知识点推进。
            </div>
          </div>
        </div>

        {workspaceId && <PreflightModelRow workspaceId={workspaceId} conversationModelId={conversationModelId} />}

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

/**
 * 预检里的「本课程模型」一行（2026-11-19，B2 工作区默认）。
 *
 * 为什么只占一行、不新开分区：开段预检的主目标是「选知识点 + 认素材」，
 * 模型是顺带确认的上下文，给一整块面板会把主流程挤下去。所以左侧一行小字报当前生效模型 +
 * 来源，点开才出选择器（锚定浮层，不进正文），改完立刻生效 —— 用布局表达层级，不加说明行。
 *
 * 生效顺序与主进程同口径（`resolveWorkspaceModel`）：对话覆盖 → 本课程默认 → 全局默认 → 精选。
 * 绑定指向已删条目时**只提示不自动改**（B12）：行首发一枚警告点，说明放 `data-tip`。
 */
function PreflightModelRow({ workspaceId, conversationModelId }: { workspaceId: string; conversationModelId?: string }) {
  const { snapshot, entries } = useModelCatalog()
  const [open, setOpen] = useState(false)
  const [allOpen, setAllOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)

  const binding = useMemo(() => snapshot?.workspaceEntry?.[workspaceId] ?? {}, [snapshot, workspaceId])
  const overridden = !!String(conversationModelId ?? '').trim()
  const resolved = useMemo(
    () => resolveWorkspaceModel({
      entries,
      binding,
      globalDefaultId: snapshot?.defaultEntryId,
      conversationOverrideId: conversationModelId,
    }),
    [entries, binding, snapshot?.defaultEntryId, conversationModelId],
  )
  const view = modelLineView({ resolved, conversationOverridden: overridden })

  const sections = useMemo(() => {
    const groups = pickerEntriesForWorkspace({ entries, binding })
    return pickerSections({ workspace: groups.workspace, global: groups.global, all: groups.all, query })
  }, [entries, binding, query])

  /** 本课程默认 = 绑定里的 modelEntryId；只有它仍能解析到条目才算「已设」（失效时开关显示关，点一下即修复绑定） */
  const wsDefaultId = binding.modelEntryId ?? ''
  const isWsDefault = !!wsDefaultId && wsDefaultId === resolved.entry?.id
  /** 有搜索词就强制展开「全部模型」；此时折叠头退化成静态组头，避免「点了没反应」 */
  const forcedAll = !!query.trim()
  const showAll = allOpen || forcedAll

  const save = async (modelEntryId: string | null): Promise<void> => {
    if (saving) return
    const patch = bindingPatch({ ...binding, modelEntryId: modelEntryId ?? undefined }, binding)
    if (Object.keys(patch).length === 0) { setOpen(false); return }
    setSaving(true)
    try {
      const r = await llmCatalogSetWorkspace(workspaceId, patch)
      if (!r || r.ok === false) { showToast({ type: 'error', message: '没能保存本课程模型，请重试' }); return }
      setOpen(false)
      showToast({ type: 'info', message: modelEntryId ? '已设为本课程默认' : '已改回跟随全局默认' })
    } catch {
      showToast({ type: 'error', message: '没能保存本课程模型，请重试' })
    } finally {
      setSaving(false)
    }
  }

  const openPicker = (): void => {
    if (overridden) {
      showToast({ type: 'info', message: '本对话已单独选过模型，去输入区模型菜单改' })
      return
    }
    setOpen((v) => !v)
    setQuery('')
  }

  return (
    <div className="mt-3 flex items-center gap-2">
      <span className="shrink-0 text-[11px] text-[var(--text-muted)]">本课程模型</span>
      <div className="flex-1" />
      <button
        ref={btnRef}
        type="button"
        onClick={openPicker}
        aria-expanded={open}
        aria-haspopup="menu"
        className="min-w-0 flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11.5px] hover:bg-[var(--bg-hover)] transition-colors"
      >
        {view.warn && (
          <span
            role="img"
            aria-label={view.warnText}
            data-tip={view.warnText}
            className="shrink-0 w-1.5 h-1.5 rounded-full bg-[var(--warning)]"
          />
        )}
        <span className={`min-w-0 truncate ${resolved.entry ? 'text-[var(--text-primary)]' : 'text-[var(--text-disabled)]'}`}>{view.label}</span>
        {view.sourceLabel && (
          <span className="shrink-0 rounded bg-[var(--bg-hover)] px-1 text-[10px] text-[var(--text-secondary)]">{view.sourceLabel}</span>
        )}
        {overridden ? (
          <span className="shrink-0 text-[10px] text-[var(--text-muted)]">本对话已覆盖</span>
        ) : (
          <ChevronDown size={11} className={`kb-chevron shrink-0 text-[var(--text-muted)] ${open ? 'rotate-180' : ''}`} />
        )}
      </button>

      <AnchoredLayer
        anchorRef={btnRef}
        open={open}
        onClose={() => setOpen(false)}
        align="end"
        role="menu"
        className="w-[280px] max-h-[320px] flex flex-col overflow-hidden rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-lg"
      >
        <div className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 border-b border-[var(--border-color)]">
          <Search size={12} className="shrink-0 text-[var(--text-muted)]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模型"
            className="flex-1 min-w-0 bg-transparent text-[12px] outline-none text-[var(--text-primary)] placeholder:text-[var(--text-disabled)]"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          <button
            onClick={() => void save(isWsDefault ? null : resolved.entry?.id ?? null)}
            disabled={saving || !resolved.entry}
            data-tip={isWsDefault ? '取消后跟随全局默认' : '把当前生效的模型设为本课程默认'}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors"
          >
            <span className={`shrink-0 w-3.5 h-3.5 rounded-full border flex items-center justify-center ${isWsDefault ? 'border-[var(--accent)]' : 'border-[var(--border-color)]'}`}>
              {isWsDefault && <span className="kb-micro-pop w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />}
            </span>
            <span className="min-w-0 flex-1 truncate text-left">设为本课程默认</span>
          </button>

          {sections.map((sec) => (
            <div key={sec.id}>
              {sec.id === 'all' && !forcedAll ? (
                <button
                  type="button"
                  onClick={() => setAllOpen((v) => !v)}
                  aria-expanded={showAll}
                  className="w-full flex items-center gap-1 px-2.5 py-1 text-[10.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  <ChevronRight size={10} className={`kb-chevron shrink-0 ${showAll ? 'rotate-90' : ''}`} />
                  <span className="min-w-0 flex-1 truncate text-left">{sec.title}</span>
                  <span className="shrink-0 text-[var(--text-disabled)]">{sec.items.length}</span>
                </button>
              ) : (
                <div className="flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] text-[var(--text-muted)]">
                  <span className="min-w-0 flex-1 truncate">{sec.title}</span>
                  <span className="shrink-0 text-[var(--text-disabled)]">{sec.items.length}</span>
                </div>
              )}
              {(sec.id !== 'all' || showAll) && sec.items.map((item) => {
                const cur = item.id === resolved.entry?.id
                return (
                  <button
                    key={item.id}
                    onClick={() => void save(item.id)}
                    disabled={saving}
                    className={`w-full flex items-center gap-1.5 px-2.5 py-1 text-[12px] transition-colors ${cur ? 'bg-[var(--accent)]/10' : 'hover:bg-[var(--bg-hover)]'}`}
                  >
                    <span className="min-w-0 flex-1 truncate text-left text-[var(--text-primary)]">{item.name?.trim() || item.id}</span>
                    {cur && <span className="shrink-0 text-[11px] text-[var(--accent)]">✓</span>}
                  </button>
                )
              })}
            </div>
          ))}

          {sections.length === 0 && (
            <div className="px-2.5 py-3 text-[11.5px] text-[var(--text-muted)]">
              {query.trim() ? `没有匹配「${query.trim()}」的模型` : '还没有模型条目 —— 先去设置的模型页添加一个'}
            </div>
          )}
        </div>
      </AnchoredLayer>
    </div>
  )
}
