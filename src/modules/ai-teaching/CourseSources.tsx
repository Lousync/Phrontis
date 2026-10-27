import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, BookOpen, Check, FilePlus2, FolderOpen, Link2, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import type { AiTeachCourseOutline, AiTeachLessonInfo, AiTeachSource, AiTeachSourcesPayload } from '../../types'
import {
  aiTeachCourseAssignSources, aiTeachCourseExtractSource, aiTeachCourseGetSources,
  aiTeachCourseRegisterSources, aiTeachCourseRemoveAssignment, aiTeachCourseRemoveSource,
  aiTeachSrcPick, aiTeachSrcPickDir, onAiTeachCourseRefresh,
} from '../../lib/ipc'
import { anchorLabel } from '../../lib/aiTeachingSourcesPure'
import { showToast } from '../../lib/toast'

/**
 * AI教学 3.14 右栏「素材」：本段快照 / 本章分配 / 未分配。
 * 登记（文件 / 目录 / URL）、章级分配、区间提取都在这里；不再有 SOURCE.md 分层与「上收」。
 */

interface Props {
  wsId: string
  outline: AiTeachCourseOutline
  activeChapterId: string | null
  activeSegment: AiTeachLessonInfo | null
  onOpenFile: (rel: string) => void
  onReloadCourse: () => void
}

const MODE_LABEL: Record<string, string> = { exact: '精确', narrow: '缩窄', fallback: '整章' }

function statusText(s: AiTeachSource['status']): string {
  return s === 'ready' ? '可读' : s === 'needs-extract' ? '待提取' : '异常'
}

export function CourseSources(props: Props) {
  const { wsId, outline, activeChapterId, activeSegment, onOpenFile, onReloadCourse } = props
  const [payload, setPayload] = useState<AiTeachSourcesPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [regOpen, setRegOpen] = useState(false)
  const [regPath, setRegPath] = useState('')
  const [regTitle, setRegTitle] = useState('')
  const [regBusy, setRegBusy] = useState(false)
  const [extractFor, setExtractFor] = useState<{ sourceId: string; from: string; to: string } | null>(null)
  const [anchorEdit, setAnchorEdit] = useState<{ sourceId: string; label: string; from: string; to: string; kind: 'pages' | 'lines' } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  const chapterId = activeChapterId ?? outline.chapters[0]?.id ?? ''
  const chapter = outline.chapters.find((c) => c.id === chapterId) ?? null

  const reload = useCallback(async () => {
    setLoading(true)
    const r = await aiTeachCourseGetSources(wsId).catch(() => null)
    setPayload(r ?? null)
    setLoading(false)
  }, [wsId])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => { setAnchorEdit(null); setExtractFor(null) }, [chapterId])
  useEffect(() => {
    const off = onAiTeachCourseRefresh((p) => { if (p.wsId === wsId) void reload() })
    return off
  }, [wsId, reload])

  const sources = payload?.sources ?? []
  const assignments = payload?.assignments ?? {}
  const chapterAssignments = assignments[chapterId] ?? []
  const assignedIds = useMemo(() => new Set(Object.values(assignments).flat().map((a) => a.sourceId)), [assignments])
  const unassigned = sources.filter((s) => !assignedIds.has(s.id))
  const byId = useMemo(() => new Map(sources.map((s) => [s.id, s] as const)), [sources])

  const segmentItems = (activeSegment?.sources ?? []).map((seg) => {
    const src = byId.get(seg.sourceId)
    return { seg, src }
  })

  const openSource = (src: AiTeachSource): void => {
    if (src.extractRel && !/\/$/.test(src.extractRel)) { onOpenFile(src.extractRel); return }
    if (src.rel && (/\.(md|markdown|txt|html?|png|jpe?g|webp|gif|svg)$/i.test(src.rel))) { onOpenFile(src.rel); return }
    if (src.url) { showToast({ type: 'info', message: '网页素材：让 AI 用网页读取工具打开，或先抓取为 md（后续入口）' }); return }
    showToast({ type: 'info', message: '该素材还没有可打开的提取稿，先点「提取」' })
  }

  const register = async (): Promise<void> => {
    const path = regPath.trim()
    if (!path) return
    setRegBusy(true)
    const r = await aiTeachCourseRegisterSources(wsId, [{ path, title: regTitle.trim() || undefined }]).catch(() => null)
    setRegBusy(false)
    if (!r?.ok) {
      showToast({ type: 'error', message: r?.error ?? r?.errors?.[0]?.error ?? '登记素材失败' })
      return
    }
    const bad = r.sources.find((s) => s.status === 'error')
    showToast({ type: bad ? 'warning' : 'success', message: bad ? `已登记，但文件读取异常：${bad.title}` : `已登记 ${r.sources.length} 条素材` })
    setRegOpen(false); setRegPath(''); setRegTitle('')
    await reload(); onReloadCourse()
  }

  const pick = async (dir: boolean): Promise<void> => {
    const r = dir ? await aiTeachSrcPickDir().catch(() => null) : await aiTeachSrcPick().catch(() => null)
    if (r?.ok && r.path) setRegPath(r.path)
    else if (r && !r.ok && r.error) showToast({ type: 'warning', message: r.error })
  }

  const assignToChapter = async (src: AiTeachSource): Promise<void> => {
    if (!chapterId) return
    setBusyId(src.id)
    const r = await aiTeachCourseAssignSources(wsId, chapterId, [{ sourceId: src.id, label: src.title, anchor: src.anchor }]).catch(() => null)
    setBusyId(null)
    if (!r?.ok) { showToast({ type: 'error', message: r?.error ?? r?.errors?.[0] ?? '分配失败' }); return }
    showToast({ type: 'success', message: `已分配到「${chapter?.name ?? '本章'}」` })
    await reload(); onReloadCourse()
  }

  const unassign = async (sourceId: string): Promise<void> => {
    if (!chapterId) return
    setBusyId(sourceId)
    const r = await aiTeachCourseRemoveAssignment(wsId, chapterId, sourceId).catch(() => null)
    setBusyId(null)
    if (!r?.ok) { showToast({ type: 'error', message: r?.error ?? '取消分配失败' }); return }
    await reload(); onReloadCourse()
  }

  const beginExtract = (src: AiTeachSource): void => {
    const asg = chapterAssignments.find((a) => a.sourceId === src.id)
    const a = asg?.anchor ?? src.anchor
    const from = a.kind === 'pages' || a.kind === 'lines' ? String(a.from) : '1'
    const to = a.kind === 'pages' || a.kind === 'lines' ? String(a.to) : '1'
    setExtractFor({ sourceId: src.id, from, to })
  }

  const extract = async (): Promise<void> => {
    if (!extractFor) return
    const src = byId.get(extractFor.sourceId)
    if (!src) return
    const from = Math.max(1, Math.floor(Number(extractFor.from) || 1))
    const to = Math.max(from, Math.floor(Number(extractFor.to) || from))
    const anchor = src.type === 'code' ? { kind: 'lines' as const, from, to } : { kind: 'pages' as const, from, to }
    setBusyId(src.id)
    const r = await aiTeachCourseExtractSource(wsId, src.id, anchor).catch(() => null)
    setBusyId(null)
    if (!r?.ok) { showToast({ type: 'error', message: r?.error ?? '提取失败' }); return }
    showToast({ type: 'success', message: r.skipped ? '该素材不需要提取' : '提取完成' })
    setExtractFor(null)
    await reload(); onReloadCourse()
    if (r.relPath) onOpenFile(r.relPath)
  }

  const removeSource = async (id: string): Promise<void> => {
    if (confirmRemove !== id) { setConfirmRemove(id); return }
    setConfirmRemove(null)
    setBusyId(id)
    const r = await aiTeachCourseRemoveSource(wsId, id).catch(() => null)
    setBusyId(null)
    if (!r?.ok) { showToast({ type: 'error', message: r?.error ?? '删除失败' }); return }
    showToast({ type: 'info', message: '已删除素材登记（原文件不删）' })
    await reload(); onReloadCourse()
  }

  const saveAnchor = async (): Promise<void> => {
    if (!anchorEdit || !chapterId) return
    const from = Math.max(1, Math.floor(Number(anchorEdit.from) || 1))
    const to = Math.max(from, Math.floor(Number(anchorEdit.to) || from))
    setBusyId(anchorEdit.sourceId)
    const r = await aiTeachCourseAssignSources(wsId, chapterId, [{
      sourceId: anchorEdit.sourceId,
      label: anchorEdit.label,
      anchor: anchorEdit.kind === 'lines' ? { kind: 'lines', from, to } : { kind: 'pages', from, to },
    }]).catch(() => null)
    setBusyId(null)
    if (!r?.ok) { showToast({ type: 'error', message: r?.error ?? r?.errors?.[0] ?? '改区间失败' }); return }
    setAnchorEdit(null)
    await reload(); onReloadCourse()
  }

  const sourceRow = (src: AiTeachSource, opts: { assigned?: boolean; seg?: { label: string; anchor: unknown; mode: string } } = {}) => {
    const busy = busyId === src.id
    const openable = !!(src.extractRel || src.url || (src.rel && /\.(md|markdown|txt|html?|png|jpe?g|webp|gif|svg)$/i.test(src.rel)))
    return (
      <div key={src.id} className="rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <BookOpen size={10} className="shrink-0 text-[var(--text-muted)]" />
          <button onClick={() => openSource(src)} disabled={!openable} title={openable ? '打开提取稿 / 原件' : '还没有可打开的提取稿'}
            className={`min-w-0 flex-1 truncate text-left text-[11px] ${openable ? 'text-[var(--text-primary)] hover:underline' : 'text-[var(--text-muted)]'}`}>
            {src.title}
          </button>
          <span className={`shrink-0 rounded px-1 text-[9px] ${src.status === 'ready' ? 'bg-[var(--success)]/10 text-[var(--success)]' : src.status === 'needs-extract' ? 'bg-[var(--warning)]/10 text-[var(--warning)]' : 'bg-[var(--danger)]/10 text-[var(--danger)]'}`}>
            {statusText(src.status)}
          </span>
        </div>
        <div className="mt-0.5 pl-4 text-[9.5px] text-[var(--text-muted)]">
          {src.type} · {opts.seg ? `${anchorLabel(opts.seg.anchor as never)} · ${MODE_LABEL[opts.seg.mode] ?? opts.seg.mode}` : anchorLabel(src.anchor)}
        </div>
        <div className="mt-1 pl-4 flex items-center gap-1.5 text-[10px]">
          {opts.seg ? (
            <span className="text-[var(--text-muted)]">本段确认</span>
          ) : opts.assigned ? (
            <button onClick={() => void unassign(src.id)} disabled={busy} className="text-[var(--text-muted)] hover:text-[var(--danger)] transition-colors">取消分配</button>
          ) : (
            <button onClick={() => void assignToChapter(src)} disabled={busy || !chapterId} className="text-[var(--accent)] hover:underline transition-colors">分配到本章</button>
          )}
          {(src.type === 'pdf' || src.type === 'pptx' || src.type === 'docx' || src.type === 'code') && (
            <button onClick={() => beginExtract(src)} disabled={busy} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">提取</button>
          )}
          {!opts.seg && (
            <button onClick={() => void removeSource(src.id)} disabled={busy} title={confirmRemove === src.id ? '再点一次确认删除登记（原文件不删）' : '删除素材登记'}
              className={`ml-auto transition-colors ${confirmRemove === src.id ? 'text-[var(--danger)]' : 'text-[var(--text-muted)] hover:text-[var(--danger)]'}`}>
              {busy ? <Loader2 size={10} className="animate-spin" /> : confirmRemove === src.id ? <span className="text-[9px]">确认删除</span> : <Trash2 size={10} />}
            </button>
          )}
        </div>
        {extractFor?.sourceId === src.id && (
          <div className="mt-1.5 pl-4 flex items-center gap-1 text-[10px]">
            <span className="text-[var(--text-muted)]">{src.type === 'code' ? '行' : '页'}</span>
            <input value={extractFor.from} onChange={(e) => setExtractFor({ ...extractFor, from: e.target.value.replace(/\D/g, '') })}
              className="w-11 h-6 px-1 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] text-[10px] outline-none" />
            <span className="text-[var(--text-muted)]">–</span>
            <input value={extractFor.to} onChange={(e) => setExtractFor({ ...extractFor, to: e.target.value.replace(/\D/g, '') })}
              className="w-11 h-6 px-1 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] text-[10px] outline-none" />
            <button onClick={() => void extract()} disabled={busy} className="text-[var(--accent)] hover:underline">开始</button>
            <button onClick={() => setExtractFor(null)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">取消</button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 px-2 py-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-semibold text-[var(--text-secondary)]">素材</span>
        <span className="text-[9.5px] text-[var(--text-muted)]">{sources.length} 条 · 未分配 {unassigned.length}</span>
        <div className="flex-1" />
        <button onClick={() => void reload()} title="刷新素材" className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
        <button onClick={() => setRegOpen((v) => !v)} title="登记素材" className="p-0.5 text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors">
          <Plus size={12} />
        </button>
      </div>

      {regOpen && (
        <div className="rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] p-2 flex flex-col gap-1.5">
          <div className="flex items-center gap-1">
            <input value={regPath} onChange={(e) => setRegPath(e.target.value)} placeholder="文件 / 目录 / https://…"
              className="min-w-0 flex-1 h-6 px-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] text-[10.5px] outline-none" />
            <button onClick={() => void pick(false)} title="选择文件" className="p-1 rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><FilePlus2 size={11} /></button>
            <button onClick={() => void pick(true)} title="选择目录" className="p-1 rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><FolderOpen size={11} /></button>
          </div>
          <input value={regTitle} onChange={(e) => setRegTitle(e.target.value)} placeholder="显示名（可选）"
            className="h-6 px-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] text-[10.5px] outline-none" />
          <div className="flex items-center gap-1.5">
            <span className="text-[9.5px] text-[var(--text-muted)]">仓库外文件会复制进 SOURCES/</span>
            <div className="flex-1" />
            <button onClick={() => setRegOpen(false)} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">取消</button>
            <button onClick={() => void register()} disabled={regBusy || !regPath.trim()}
              className="inline-flex items-center gap-1 rounded bg-[var(--accent)] px-2 py-0.5 text-[10px] text-white disabled:opacity-40">
              {regBusy && <Loader2 size={9} className="animate-spin" />}登记
            </button>
          </div>
        </div>
      )}

      <section>
        <div className="flex items-center gap-1 px-0.5 py-1 text-[10px] font-medium text-[var(--text-secondary)]">
          <span>本段</span>
          <span className="text-[var(--text-muted)]">{segmentItems.length}</span>
        </div>
        {!activeSegment ? (
          <div className="px-1 text-[10px] text-[var(--text-muted)]">还没有开段；点左栏知识点开段后，这里显示本段确认的素材。</div>
        ) : segmentItems.length === 0 ? (
          <div className="px-1 text-[10px] text-[var(--text-muted)]">本段没有确认素材（按大纲讲）。</div>
        ) : (
          <div className="flex flex-col gap-1">
            {segmentItems.map(({ seg, src }) => src ? sourceRow(src, { seg: { label: seg.label, anchor: seg.anchor, mode: seg.mode } }) : (
              <div key={seg.sourceId} className="rounded-md border border-[var(--warning)]/40 px-2 py-1 text-[10px] text-[var(--warning)]">
                {seg.label}（素材已移除）
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center gap-1 px-0.5 py-1 text-[10px] font-medium text-[var(--text-secondary)]">
          <span>本章</span>
          <span className="truncate text-[var(--text-muted)]">{chapter?.name ?? '未选章'}</span>
          <span className="text-[var(--text-muted)]">{chapterAssignments.length}</span>
        </div>
        {chapterAssignments.length === 0 ? (
          <div className="px-1 text-[10px] text-[var(--text-muted)]">本章还没有分配素材。可从下面「未分配」里分配，或让课程助手分配。</div>
        ) : (
          <div className="flex flex-col gap-1">
            {chapterAssignments.map((a) => {
              const src = byId.get(a.sourceId)
              if (!src) return <div key={a.sourceId} className="px-1 text-[10px] text-[var(--warning)]">{a.label}（素材已移除）</div>
              const rg = a.anchor.kind === 'pages' || a.anchor.kind === 'lines' ? a.anchor : null
              return (
                <div key={a.sourceId}>
                  {sourceRow(src, { assigned: true })}
                  {rg && anchorEdit?.sourceId !== src.id && (
                    <button onClick={() => setAnchorEdit({
                      sourceId: src.id, label: a.label,
                      kind: rg.kind === 'lines' ? 'lines' : 'pages',
                      from: String(rg.from), to: String(rg.to),
                    })} className="ml-4 mt-0.5 text-[9.5px] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors">改区间</button>
                  )}
                  {anchorEdit?.sourceId === src.id && (
                    <div className="ml-4 mt-1 flex items-center gap-1 text-[10px]">
                      <span className="text-[var(--text-muted)]">{anchorEdit.kind === 'lines' ? '行' : '页'}</span>
                      <input value={anchorEdit.from} onChange={(e) => setAnchorEdit({ ...anchorEdit, from: e.target.value.replace(/\D/g, '') })}
                        className="w-11 h-6 px-1 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] text-[10px] outline-none" />
                      <span className="text-[var(--text-muted)]">–</span>
                      <input value={anchorEdit.to} onChange={(e) => setAnchorEdit({ ...anchorEdit, to: e.target.value.replace(/\D/g, '') })}
                        className="w-11 h-6 px-1 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] text-[10px] outline-none" />
                      <button onClick={() => void saveAnchor()} disabled={busyId === src.id} className="text-[var(--accent)] hover:underline">保存</button>
                      <button onClick={() => setAnchorEdit(null)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">取消</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center gap-1 px-0.5 py-1 text-[10px] font-medium text-[var(--text-secondary)]">
          <span>未分配</span>
          <span className="text-[var(--text-muted)]">{unassigned.length}</span>
        </div>
        {unassigned.length === 0 ? (
          <div className="px-1 text-[10px] text-[var(--text-muted)]">没有未分配素材。</div>
        ) : (
          <div className="flex flex-col gap-1">
            {unassigned.map((src) => sourceRow(src))}
          </div>
        )}
      </section>

      {payload && !payload.ok && (
        <div className="flex items-start gap-1 text-[10px] text-[var(--danger)]"><AlertTriangle size={10} className="mt-0.5" />{payload.error}</div>
      )}
    </div>
  )
}
