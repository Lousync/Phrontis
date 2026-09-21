import { useEffect, useState, useMemo } from 'react'
import { BookMarked, Pencil, Trash2, Check, X, Copy, Crosshair, Info } from 'lucide-react'
import { excerptDelete, excerptList, excerptPatch, pdfReaderGet, readerStateGet, workspaceGetCurrent } from '../../lib/ipc'
import { useDataChanged } from '../../lib/dataChanged'
import { KB_PDF_PAGE_CHANGED, KB_READER_STATE_CHANGED } from '../shared/pdf/pdfEvents'
import type { BookKind, ExcerptItem, ExcerptColor, ExcerptType, PdfBookState } from '../../types'

/**
 * 右栏「阅读」侧栏（书架升级全格式阅读器一期 + 摘录先行批次 v3.5.0 重做）。
 *
 * 结构（对齐原型 renderReading / excCard）：
 *   书卡头（纯色块封面 + 书名 + 格式角标 + 位置信息 + 迷你进度条）
 *   → 双 Tab：摘录 / 时间线
 *   → 摘录 Tab：说明条 + 书签（仅 pdf）+ 卡片化条目
 *   → 时间线 Tab：按日期分组（组头「日期 + N 条」+ 同日卡片）
 *
 * 卡片化条目：色点 + 类型胶囊（摘录/想法/高亮）+ 来源（页码/段落 · 日期）+ 引文（左侧色边框、3 行截断）
 *   + 备注块 + 操作行（定位原文 / 复制 / 编辑备注 / 删除）。
 *
 * ⚠️ 封面用纯色块（色相由 relPath 派生），**不引入 BookCover**（它带 pdfjs，右栏常驻会拖进主 chunk）。
 * ⚠️ 数据层 `type` 字段承载条目类型（highlight/excerpt/idea），**绝不能叫 kind**（kind 已被书籍格式占用）。
 */

/** 条目类型 → 中文胶囊 */
const TYPE_LABEL: Record<ExcerptType, string> = { highlight: '高亮', excerpt: '摘录', idea: '想法' }

/** 封面色相：由 relPath 派生（稳定哈希 → hue），避免引入 pdfjs 封面 */
function coverColor(relPath: string): string {
  let h = 0
  for (let i = 0; i < relPath.length; i++) h = (h * 31 + relPath.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 52% 52%)`
}

/** ISO → YYYY-MM-DD（来源日期） */
function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** ISO → M月D日（时间线组头） */
function fmtDayGroup(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '未知日期'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 来源标签：pdf 第 N 页 / txt 段 N */
function sourceLabel(e: ExcerptItem): string {
  return e.kind === 'pdf' ? `第 ${e.page ?? '?'} 页` : `段 ${(e.paraIndex ?? 0) + 1}`
}

interface Props {
  reading: { relPath: string; name: string; kind: BookKind }
  onLocatePdfPage?: (page: number) => void
  /** 摘录定位回原文（App 统一：切回书架标签 + 派发对应跳转事件） */
  onLocateExcerpt?: (loc: { kind: BookKind; page?: number; paraIndex?: number }) => void
}

export function ReadingSidePanel({ reading, onLocatePdfPage, onLocateExcerpt }: Props) {
  const [rootId, setRootId] = useState('')
  const [pdfState, setPdfState] = useState<PdfBookState | null>(null)
  const [txtPct, setTxtPct] = useState(0)
  const [bookmarks, setBookmarks] = useState<PdfBookState['bookmarks']>([])
  const [excerpts, setExcerpts] = useState<ExcerptItem[]>([])
  const [noteEdit, setNoteEdit] = useState<{ id: string; draft: string } | null>(null)
  const [tab, setTab] = useState<'excerpt' | 'timeline'>('excerpt')

  // 当前仓库 rootId（书签/进度请求必带）
  useEffect(() => {
    let alive = true
    void workspaceGetCurrent().then((cur) => {
      if (alive) setRootId(cur?.rootId ?? '')
    }).catch(() => { /* 忽略 */ })
    return () => { alive = false }
  }, [])

  // 初值：按 kind 拉一次状态（书切换 / 首挂时重跑）
  useEffect(() => {
    let alive = true
    if (!rootId) return
    if (reading.kind === 'pdf') {
      void pdfReaderGet(rootId, reading.relPath).then((r) => {
        if (!alive) return
        const st = r.ok ? r.state ?? null : null
        setPdfState(st)
        setBookmarks(st?.bookmarks ?? [])
      }).catch(() => { /* 状态读取失败不阻塞侧栏 */ })
    } else {
      void readerStateGet(rootId, reading.relPath).then((r) => {
        if (!alive) return
        setTxtPct(r.ok ? r.state?.pct ?? 0 : 0)
      }).catch(() => { /* 同上 */ })
    }
    return () => { alive = false }
  }, [rootId, reading.kind, reading.relPath])

  // 实时跟随：阅读器在书的阅读过程中派发页码/进度广播
  useEffect(() => {
    const onPage = (e: Event) => {
      const d = (e as CustomEvent).detail as { relPath?: string; page?: number }
      if (d?.relPath === reading.relPath && typeof d.page === 'number') setPdfState((prev) => (prev ? { ...prev, lastPage: d.page! } : prev))
    }
    const onPct = (e: Event) => {
      const d = (e as CustomEvent).detail as { relPath?: string; kind?: string; pct?: number }
      if (d?.relPath === reading.relPath && d.kind === 'txt' && typeof d.pct === 'number') setTxtPct(d.pct)
    }
    window.addEventListener(KB_PDF_PAGE_CHANGED, onPage)
    window.addEventListener(KB_READER_STATE_CHANGED, onPct)
    return () => {
      window.removeEventListener(KB_PDF_PAGE_CHANGED, onPage)
      window.removeEventListener(KB_READER_STATE_CHANGED, onPct)
    }
  }, [reading.relPath])

  // 书签集刷新（仅 pdf）：阅读器内增删书签后广播 pdfReader scope
  const refreshBookmarks = () => {
    if (reading.kind !== 'pdf' || !rootId) return
    void pdfReaderGet(rootId, reading.relPath).then((r) => {
      const st = r.ok ? r.state ?? null : null
      setPdfState(st)
      setBookmarks(st?.bookmarks ?? [])
    }).catch(() => { /* 忽略 */ })
  }
  useDataChanged('pdfReader', refreshBookmarks)

  // 摘录列表：书/rootId 就绪后拉一次 + excerpt 广播刷新（阅读器划选创建/删除实时反映）
  useEffect(() => {
    let alive = true
    setExcerpts([])
    if (!rootId) return
    void excerptList(rootId, reading.relPath).then((r) => {
      if (alive && r.ok) setExcerpts(r.excerpts ?? [])
    }).catch(() => { /* 忽略 */ })
    return () => { alive = false }
  }, [rootId, reading.relPath])
  useDataChanged('excerpt', () => {
    if (!rootId) return
    void excerptList(rootId, reading.relPath).then((r) => {
      if (r.ok) setExcerpts(r.excerpts ?? [])
    }).catch(() => { /* 忽略 */ })
  })

  const saveNote = (e: ExcerptItem) => {
    if (!rootId || !noteEdit || noteEdit.id !== e.id) return
    void excerptPatch(rootId, reading.relPath, e.id, { note: noteEdit.draft }, e.updatedAt).catch(() => { /* 忽略 */ })
    setNoteEdit(null)
  }

  const isPdf = reading.kind === 'pdf'
  const progressPct = isPdf
    ? (pdfState && pdfState.totalPages > 0 ? Math.round(((pdfState.lastPage || 0) / pdfState.totalPages) * 100) : 0)
    : txtPct
  const progressLabel = isPdf
    ? (pdfState && pdfState.totalPages > 0 ? `第 ${pdfState.lastPage} / ${pdfState.totalPages} 页` : '未开始')
    : `${txtPct}%`

  const onDelete = (e: ExcerptItem) => {
    if (!rootId) return
    void excerptDelete(rootId, reading.relPath, e.id).catch(() => { /* 忽略 */ })
  }
  const onCopy = (e: ExcerptItem) => {
    try { void navigator.clipboard?.writeText(e.text) } catch { /* 忽略 */ }
  }

  // 时间线分组（按日）
  const timelineGroups = useMemo(() => {
    const map = new Map<string, ExcerptItem[]>()
    for (const e of excerpts) {
      const day = fmtDayGroup(e.at)
      if (!map.has(day)) map.set(day, [])
      map.get(day)!.push(e)
    }
    return [...map.entries()]
  }, [excerpts])

  return (
    <div data-wb="readingPanel" className="h-full flex flex-col overflow-hidden">
      {/* 书卡头：纯色块封面 + 书名 + 格式角标 + 位置信息 + 迷你进度条 */}
      <div className="shrink-0 border-b border-[var(--border-color)] px-3 py-2">
        <div className="flex items-center gap-2.5">
          <div className="h-12 w-9 shrink-0 rounded-md shadow-sm" style={{ background: coverColor(reading.relPath) }} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--text-primary)]">{reading.name}</span>
              <span className="shrink-0 rounded bg-[var(--bg-hover)] px-1 py-0.5 text-[9.5px] text-[var(--text-tertiary)]">{isPdf ? 'PDF' : 'TXT'}</span>
            </div>
            <div className="mt-1 text-[11px] text-[var(--text-tertiary)]">{progressLabel}</div>
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--bg-hover)]">
              <div className="h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        </div>
      </div>

      {/* 双 Tab：摘录 / 时间线 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border-color)] px-2 py-1">
        <button onClick={() => setTab('excerpt')}
          className={`rounded px-2 py-1 text-[11.5px] ${tab === 'excerpt' ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'}`}>
          摘录{excerpts.length > 0 && <span className="ml-1 text-[var(--text-tertiary)]">{excerpts.length}</span>}
        </button>
        <button onClick={() => setTab('timeline')}
          className={`rounded px-2 py-1 text-[11.5px] ${tab === 'timeline' ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'}`}>
          时间线
        </button>
      </div>

      <div key={tab} className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5 kb-view-in">
        {tab === 'excerpt' ? (
          <>
            {/* 说明条（help-disclosure：只收不删，常驻低调） */}
            <div className="flex items-start gap-1 px-1.5 py-1 text-[10.5px] leading-relaxed text-[var(--text-disabled)]">
              <Info size={11} className="mt-0.5 shrink-0" />
              <span>摘录落在 Vault 笔记里。点「定位」跳回原文，正文点高亮也能跳回这里。点色即按该色高亮。</span>
            </div>

            {/* 书签（仅 pdf） */}
            {isPdf && (
              <div className="mb-2">
                <div className="flex items-center gap-1 px-1.5 py-1 text-[11px] text-[var(--text-muted)]">
                  <BookMarked size={11} />
                  书签
                  {bookmarks.length > 0 && <span className="text-[var(--text-tertiary)]">{bookmarks.length}</span>}
                </div>
                {bookmarks.length === 0 ? (
                  <div className="px-2 py-1.5 text-[11px] leading-relaxed text-[var(--text-tertiary)]">在阅读器工具栏加书签后，这里可以快速跳页</div>
                ) : (
                  bookmarks.map((b, i) => (
                    <button
                      key={`${b.page}-${i}`}
                      onClick={() => onLocatePdfPage?.(b.page)}
                      className="kb-item-in group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--bg-hover)]"
                      title={b.note ? `第 ${b.page} 页 · ${b.note}` : `第 ${b.page} 页`}
                    >
                      <span className="shrink-0 rounded bg-[var(--bg-hover)] px-1 py-0.5 text-[10px] text-[var(--text-secondary)]">P{b.page}</span>
                      <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">{b.note || ' '}</span>
                    </button>
                  ))
                )}
              </div>
            )}

            {/* 摘录卡片 */}
            {excerpts.length === 0 ? (
              <div className="px-2 py-1.5 text-[11px] leading-relaxed text-[var(--text-tertiary)]">划选正文即可创建摘录</div>
            ) : (
              excerpts.map((e) => (
                <ExcCard key={e.id} e={e} noteEdit={noteEdit} setNoteEdit={setNoteEdit} saveNote={saveNote} onLocate={onLocateExcerpt} onCopy={onCopy} onDelete={onDelete} />
              ))
            )}
          </>
        ) : (
          excerpts.length === 0 ? (
            <div className="px-2 py-1.5 text-[11px] leading-relaxed text-[var(--text-tertiary)]">还没有摘录</div>
          ) : (
            timelineGroups.map(([day, items]) => (
              <div key={day}>
                <div className="flex items-center gap-2 px-1.5 py-1 text-[11px] text-[var(--text-muted)]">
                  <span className="font-medium">{day}</span>
                  <span className="text-[var(--text-tertiary)]">{items.length} 条</span>
                </div>
                {items.map((e) => (
                  <ExcCard key={e.id} e={e} noteEdit={noteEdit} setNoteEdit={setNoteEdit} saveNote={saveNote} onLocate={onLocateExcerpt} onCopy={onCopy} onDelete={onDelete} />
                ))}
              </div>
            ))
          )
        )}
      </div>
    </div>
  )
}

/** 摘录/想法/高亮 单卡片（摘录 Tab 与时间线 Tab 复用） */
function ExcCard({
  e, noteEdit, setNoteEdit, saveNote, onLocate, onCopy, onDelete,
}: {
  e: ExcerptItem
  noteEdit: { id: string; draft: string } | null
  setNoteEdit: (v: { id: string; draft: string } | null) => void
  saveNote: (e: ExcerptItem) => void
  onLocate?: (loc: { kind: BookKind; page?: number; paraIndex?: number }) => void
  onCopy: (e: ExcerptItem) => void
  onDelete: (e: ExcerptItem) => void
}) {
  const editing = noteEdit?.id === e.id
  const color: ExcerptColor = e.color
  return (
    <div className="kb-item-in group rounded-md px-1.5 py-1.5 hover:bg-[var(--bg-hover)]">
      {/* 顶行：色点 + 类型胶囊 + 来源 · 日期 */}
      <div className="flex items-center gap-1.5">
        <span className={`kb-exc-dot kb-exc-${color}`} />
        <span className="rounded bg-[var(--bg-hover)] px-1 py-0.5 text-[10px] text-[var(--text-secondary)]">{TYPE_LABEL[e.type]}</span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--text-tertiary)]">{sourceLabel(e)} · {fmtDate(e.at)}</span>
      </div>

      {/* 引文：左侧色边框、3 行截断；点击定位原文 */}
      <button onClick={() => onLocate?.({ kind: e.kind, page: e.page, paraIndex: e.paraIndex })}
        className="mt-1 block w-full text-left">
        <span className={`kb-exc-bd kb-exc-${color} block rounded-r border-l-[3px] px-1.5 py-1 text-[11.5px] leading-relaxed text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]`}
          style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {e.text}
        </span>
      </button>

      {/* 备注块 */}
      {e.note && !editing && (
        <div className="mt-1 rounded bg-[var(--bg-hover)]/60 px-1.5 py-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">{e.note}</div>
      )}

      {/* 操作行 / 备注编辑 */}
      {editing ? (
        <div className="mt-1 flex items-center gap-1">
          <input
            autoFocus
            value={noteEdit?.draft ?? ''}
            onChange={(ev) => setNoteEdit({ id: e.id, draft: ev.target.value })}
            onKeyDown={(ev) => { if (ev.key === 'Enter') saveNote(e); if (ev.key === 'Escape') setNoteEdit(null) }}
            placeholder="一句话备注"
            className="min-w-0 flex-1 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <button onClick={() => saveNote(e)} title="保存备注" className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Check size={11} /></button>
          <button onClick={() => setNoteEdit(null)} title="取消" className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><X size={11} /></button>
        </div>
      ) : (
        <div className={`mt-1 flex items-center gap-0.5 ${e.note ? '' : 'opacity-0 group-hover:opacity-100'}`}>
          <button onClick={() => onLocate?.({ kind: e.kind, page: e.page, paraIndex: e.paraIndex })} title="定位原文" className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Crosshair size={10.5} /></button>
          <button onClick={() => onCopy(e)} title="复制" className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Copy size={10.5} /></button>
          <button onClick={() => setNoteEdit({ id: e.id, draft: e.note })} title="编辑备注" className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Pencil size={10.5} /></button>
          <button onClick={() => onDelete(e)} title="删除摘录" className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-warning)]"><Trash2 size={10.5} /></button>
        </div>
      )}
    </div>
  )
}
