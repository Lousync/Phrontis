import { useEffect, useState, useMemo } from 'react'
import { BookMarked, Pencil, Trash2, Check, X, Copy, Crosshair, Info, NotebookPen } from 'lucide-react'
import { excerptDelete, excerptList, excerptPatch, excerptExportEntry, excerptExportNote, pdfReaderGet, readerStateGet, workspaceGetCurrent } from '../../lib/ipc'
import { useDataChanged } from '../../lib/dataChanged'
import { showToast } from '../../lib/toast'
import { KB_BOOKMARK_DELETE, KB_PDF_PAGE_CHANGED, KB_READER_STATE_CHANGED } from '../shared/pdf/pdfEvents'
import { bookEngineOf } from '../../../electron/lib/kbStore/bookFormats'
import type { BookBookmark, BookKind, ExcerptItem, ExcerptColor, ExcerptType, ExcerptExportEntry, PdfBookState } from '../../types'

/**
 * 右栏「阅读」侧栏（书架升级全格式阅读器一期 + 摘录先行批次 v3.5.0 重做）。
 *
 * 结构（对齐原型 renderReading / excCard）：
 *   书卡头（纯色块封面 + 书名 + 格式角标 + 位置信息 + 迷你进度条）
 *   → 双 Tab：摘录 / 时间线
 *   → 摘录 Tab：说明条 + 书签（pdf / txt；foliate 系 epub·fb2·fbz 一行中性说明）+ 卡片化条目
 *   → 时间线 Tab：按日期分组（组头「日期 + N 条」+ 同日卡片）
 *
 * 卡片化条目：色点 + 类型胶囊（摘录/想法/高亮）+ 来源（页码/段落/章节 · 日期）+ 引文（左侧色边框、3 行截断）
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

/** 来源标签（三分支，判据与 excerptExportSchema 的组标题同口径）：
 *  pdf → 第 N 页 / txt → 段 N / foliate 系（epub·fb2·fbz）→ 章节名（无章节名回落「正文」）。
 *  foliate 系的定位键是 CFI（不可读），所以来源显示**章节名**而不是位置号。 */
function sourceLabel(e: ExcerptItem): string {
  if (e.kind === 'pdf') return `第 ${e.page ?? '?'} 页`
  if (e.kind === 'txt') return `段 ${(e.paraIndex ?? 0) + 1}`
  return e.chapter?.trim() || '正文'
}

/**
 * 派发「删除该书签」给阅读器（**必须回派，右栏不能直接写盘**）。
 * 理由见 `pdfEvents.ts` 的 `KB_BOOKMARK_DELETE` 注释：阅读器持内存权威数组且是整数组覆盖写，
 * 右栏直接写盘会被阅读器下一次「加书签」静默复活。
 */
function emitBookmarkDelete(relPath: string, id: string): void {
  window.dispatchEvent(new CustomEvent(KB_BOOKMARK_DELETE, { detail: { relPath, id } }))
}

interface Props {
  reading: { relPath: string; name: string; kind: BookKind }
  onLocatePdfPage?: (page: number) => void
  /** 摘录定位回原文（App 统一：切回书架标签 + 派发对应跳转事件）；epub 走 cfi */
  onLocateExcerpt?: (loc: { kind: BookKind; page?: number; paraIndex?: number; cfi?: string }) => void
}

export function ReadingSidePanel({ reading, onLocatePdfPage, onLocateExcerpt }: Props) {
  const [rootId, setRootId] = useState('')
  const [pdfState, setPdfState] = useState<PdfBookState | null>(null)
  const [plainPct, setPlainPct] = useState(0)
  const [bookmarks, setBookmarks] = useState<PdfBookState['bookmarks']>([])
  const [plainBookmarks, setPlainBookmarks] = useState<BookBookmark[]>([])
  const [excerpts, setExcerpts] = useState<ExcerptItem[]>([])
  const [noteEdit, setNoteEdit] = useState<{ id: string; draft: string } | null>(null)
  const [tab, setTab] = useState<'excerpt' | 'timeline'>('excerpt')
  // 导出映射（每本书一篇「读书笔记」页；重复导出覆盖重写同一篇）
  const [exportEntry, setExportEntry] = useState<ExcerptExportEntry | null>(null)
  const [exporting, setExporting] = useState(false)

  // 当前仓库 rootId（书签/进度请求必带）
  useEffect(() => {
    let alive = true
    void workspaceGetCurrent().then((cur) => {
      if (alive) setRootId(cur?.rootId ?? '')
    }).catch(() => { /* 忽略 */ })
    return () => { alive = false }
  }, [])

  // 初值：按 kind 拉一次状态（书切换 / 首挂时重跑）。非 PDF（txt / epub）共用 readerState.json 一份状态
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
        setPlainPct(r.ok ? r.state?.pct ?? 0 : 0)
        setPlainBookmarks(r.ok && Array.isArray(r.state?.bookmarks) ? (r.state!.bookmarks as BookBookmark[]) : [])
      }).catch(() => { /* 同上 */ })
    }
    return () => { alive = false }
  }, [rootId, reading.kind, reading.relPath])

  // 书签集刷新（readerState 那条路）：readerState 变化时重拉。
  // ★ 判据是「**非 pdf**」而不是「=== 'txt'」—— 2026-09-22 起 foliate 系（epub/fb2/fbz）的书签
  //   也在这个字段里，条件写死 'txt' 会让阅读器里刚加的书签在右栏不出现（正是铁律 18 说的
  //   「AI 说改好了、界面没反应」的同款表现，只是这里是阅读器与右栏之间）。
  const refreshPlainBookmarks = () => {
    if (reading.kind === 'pdf' || !rootId) return
    void readerStateGet(rootId, reading.relPath).then((r) => {
      setPlainBookmarks(r.ok && Array.isArray(r.state?.bookmarks) ? (r.state!.bookmarks as BookBookmark[]) : [])
    }).catch(() => { /* 忽略 */ })
  }
  useDataChanged('readerState', refreshPlainBookmarks)

  // 实时跟随：阅读器在书的阅读过程中派发页码/进度广播
  useEffect(() => {
    const onPage = (e: Event) => {
      const d = (e as CustomEvent).detail as { relPath?: string; page?: number }
      if (d?.relPath === reading.relPath && typeof d.page === 'number') setPdfState((prev) => (prev ? { ...prev, lastPage: d.page! } : prev))
    }
    const onPct = (e: Event) => {
      const d = (e as CustomEvent).detail as { relPath?: string; kind?: string; pct?: number }
      // 判据 `!== 'pdf'`：pct 口径覆盖 txt 与 epub（写成 `=== 'txt'` 则 epub 的进度广播被丢）
      if (d?.relPath === reading.relPath && d.kind !== 'pdf' && typeof d.pct === 'number') setPlainPct(d.pct)
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

  // 导出映射：书/rootId 就绪后拉一次；knowledge 广播时刷新（页面可能在外部被删 → 自愈状态要跟上）
  const refreshExportEntry = () => {
    if (!rootId) return
    void excerptExportEntry(rootId, reading.relPath).then((r) => {
      if (r.ok) setExportEntry(r.entry ?? null)
    }).catch(() => { /* 忽略 */ })
  }
  useEffect(() => {
    setExportEntry(null)
    refreshExportEntry()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId, reading.relPath])
  useDataChanged('knowledge', refreshExportEntry)

  /** 导出为知识库「读书笔记」页（幂等：重复导出覆盖重写同一篇、保留页面 id） */
  const doExport = () => {
    if (!rootId || exporting) return
    if (excerpts.length === 0) {
      showToast({ type: 'info', message: '这本书还没有摘录，先划选正文创建几条' })
      return
    }
    setExporting(true)
    void excerptExportNote(rootId, reading.relPath).then(async (r) => {
      if (!r.ok) {
        showToast({ type: 'error', message: r.error || '导出失败' })
        return
      }
      showToast({
        type: 'success',
        message: r.created ? `已导出为笔记 · ${r.count} 条摘录` : `笔记已同步更新 · ${r.count} 条摘录`,
      })
      await excerptExportEntry(rootId, reading.relPath).then((e) => { if (e.ok) setExportEntry(e.entry ?? null) }).catch(() => { /* 忽略 */ })
    }).catch((e) => {
      showToast({ type: 'error', message: String((e as Error)?.message || e) })
    }).finally(() => setExporting(false))
  }

  const saveNote = (e: ExcerptItem) => {
    if (!rootId || !noteEdit || noteEdit.id !== e.id) return
    void excerptPatch(rootId, reading.relPath, e.id, { note: noteEdit.draft }, e.updatedAt).catch(() => { /* 忽略 */ })
    setNoteEdit(null)
  }

  const isPdf = reading.kind === 'pdf'
  // 进度口径二分支：pdf 按页码，**其余格式（txt / epub）一律按 pct** —— 新格式天然走 else
  const progressPct = isPdf
    ? (pdfState && pdfState.totalPages > 0 ? Math.round(((pdfState.lastPage || 0) / pdfState.totalPages) * 100) : 0)
    : plainPct
  const progressLabel = isPdf
    ? (pdfState && pdfState.totalPages > 0 ? `第 ${pdfState.lastPage} / ${pdfState.totalPages} 页` : '未开始')
    : `${plainPct}%`

  const onDelete = (e: ExcerptItem) => {
    if (!rootId) return
    void excerptDelete(rootId, reading.relPath, e.id).catch(() => { /* 忽略 */ })
  }
  const onCopy = (e: ExcerptItem) => {
    try { void navigator.clipboard?.writeText(e.text) } catch { /* 忽略 */ }
  }

  /**
   * 书签区渲染数据 —— 按**引擎**归一成一个列表再渲染。
   * 为什么不写三份 JSX：pdf / txt / foliate 三种书签的徽标与跳法不同，但外壳完全一样；
   * 三份并列时「漏改一处」的表现是**静默少一块**（这正是本块上一版对 foliate 只留一行说明的由来）。
   * ★ 判据用**引擎**（`bookEngineOf`）而不是 `kind === 'epub'`：写死 epub 会让 fb2 / fbz 两头都不命中。
   * ★ cbz 到不了这里（`App.tsx` 对 `kind === 'cbz'` 直接给右栏传 `null`，Tab 不出现），故不设分支。
   */
  const markItems = useMemo(() => {
    const eng = bookEngineOf(reading.relPath)
    if (eng === 'foliate') {
      // 定位键是 CFI ⇒ 走 onLocateExcerpt 的既有 foliate 分支（App 侧按在读那本书的引擎派发跳转事件）
      return plainBookmarks
        .filter((b) => typeof b.cfi === 'string' && b.cfi)
        .map((b) => ({
          id: b.id,
          badge: '§',
          label: b.chapter?.trim() || b.label || ' ',
          title: `跳到 ${b.label || b.chapter || '该书签'}`,
          go: () => onLocateExcerpt?.({ kind: reading.kind, cfi: b.cfi }),
          del: () => emitBookmarkDelete(reading.relPath, b.id),
        }))
    }
    if (isPdf) {
      return bookmarks.map((bm) => ({
        id: `${bm.page}-${bm.at}`,
        badge: `P${bm.page}`,
        label: bm.note || ' ',
        title: bm.note ? `第 ${bm.page} 页 · ${bm.note}` : `第 ${bm.page} 页`,
        go: () => onLocatePdfPage?.(bm.page),
        // PDF 书签身份即页码 ⇒ id 用页码串（与 PdfReaderView 的监听口径一致）
        del: () => emitBookmarkDelete(reading.relPath, String(bm.page)),
      }))
    }
    return plainBookmarks
      // 本书是 txt ⇒ 条条都有 paraIndex；类型谓词只为把「定位字段可选」收窄回数字
      .filter((b): b is BookBookmark & { paraIndex: number } => typeof b.paraIndex === 'number')
      .map((b) => ({
        id: b.id,
        badge: `¶${b.paraIndex + 1}`,
        label: b.label || ' ',
        title: `跳到 ${b.label || `段落 ${b.paraIndex + 1}`}`,
        go: () => onLocateExcerpt?.({ kind: 'txt', paraIndex: b.paraIndex }),
        del: () => emitBookmarkDelete(reading.relPath, b.id),
      }))
  }, [reading.relPath, reading.kind, isPdf, bookmarks, plainBookmarks, onLocatePdfPage, onLocateExcerpt])

  /** 书签空态提示（按引擎；help-disclosure 形态 B 的 hover 展开） */
  const markEmptyHint = bookEngineOf(reading.relPath) === 'foliate'
    ? '在阅读器工具栏加书签后，这里可以快速跳回该处'
    : isPdf ? '在阅读器工具栏加书签后，这里可以快速跳页' : '在 TXT 阅读器工具栏加书签后，这里可以快速跳段'

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
              {/* 角标直接取 kind（新增格式不必再改这里） */}
              <span className="shrink-0 rounded bg-[var(--bg-hover)] px-1 py-0.5 text-[9.5px] text-[var(--text-tertiary)]">{reading.kind.toUpperCase()}</span>
            </div>
            <div className="mt-1 text-[11px] text-[var(--text-tertiary)]">{progressLabel}</div>
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--bg-hover)]">
              <div className="h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: `${progressPct}%` }} />
            </div>
            {/* 导出为笔记：每本书一篇（重复导出覆盖重写同一篇、保留页面 id） */}
            <button
              onClick={doExport}
              disabled={exporting}
              data-wb="excerptExportBtn"
              title={exportEntry ? `已导出到 ${exportEntry.pagePath}（再次点击同步更新）` : '把这本书的摘录导出成一篇知识库「读书笔记」页'}
              className="kb-micro-pop mt-1.5 inline-flex items-center gap-1 rounded border border-[var(--border-color)] px-1.5 py-0.5 text-[10.5px] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)] disabled:opacity-50"
            >
              <NotebookPen size={10.5} />
              {exporting ? '导出中…' : exportEntry ? `笔记已更新 · ${exportEntry.count} 条` : '导出为笔记'}
            </button>
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
            {/* 书签（按引擎取源：pdf 在 pdfReader.json；txt 与 foliate 系共用 readerState.json 的同一字段，
                定位字段按 kind 分支 —— 见 BookBookmark / markItems 的注释）。
                空态说明按 help-disclosure 形态 B：标题旁 ⓘ，悬停整块平滑展开（docs/help-disclosure-pattern.md） */}
            <div className="group mb-2" data-wb="readingMarks" data-wb-marks={markItems.length}>
              <div className="flex items-center gap-1 px-1.5 py-1 text-[11px] text-[var(--text-muted)]">
                <BookMarked size={11} />
                书签
                {markItems.length > 0 && <span className="text-[var(--text-tertiary)]">{markItems.length}</span>}
                {markItems.length === 0 && <Info size={11} className="shrink-0 text-[var(--text-disabled)]" />}
              </div>
              {markItems.length === 0 ? (
                <div className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-300 group-hover:grid-rows-[1fr]">
                  <div className="overflow-hidden">
                    <div className="px-2 py-1.5 text-[11px] leading-relaxed text-[var(--text-tertiary)]">{markEmptyHint}</div>
                  </div>
                </div>
              ) : (
                markItems.map((m) => (
                  <div
                    key={m.id}
                    role="button"
                    tabIndex={0}
                    onClick={m.go}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); m.go() } }}
                    data-wb="readingMark"
                    className="kb-item-in group/row flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--bg-hover)]"
                    title={m.title}
                  >
                    <span className="shrink-0 rounded bg-[var(--bg-hover)] px-1 py-0.5 text-[10px] text-[var(--text-secondary)]">{m.badge}</span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-secondary)] group-hover/row:text-[var(--text-primary)]">{m.label}</span>
                    {/* 删除书签：hover 才出（与摘录卡的操作行同款）。外层是 div（不能嵌套 button），
                        ✕ 上 stopPropagation 防止误触发跳转。用具名 group/row —— 外层书签区还挂着
                        `group`（空态提示的 hover 展开用），不具名会让「悬停整块时所有 ✕ 一起冒出来」。 */}
                    <button
                      onClick={(e) => { e.stopPropagation(); m.del() }}
                      data-wb="readingMarkDel"
                      title="删除书签"
                      className="shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 hover:bg-[var(--bg-hover)] hover:text-[var(--danger)] group-hover/row:opacity-100"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))
              )}
            </div>

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
  onLocate?: (loc: { kind: BookKind; page?: number; paraIndex?: number; cfi?: string }) => void
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
      <button onClick={() => onLocate?.({ kind: e.kind, page: e.page, paraIndex: e.paraIndex, cfi: e.cfi })}
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
          <button onClick={() => onLocate?.({ kind: e.kind, page: e.page, paraIndex: e.paraIndex, cfi: e.cfi })} title="定位原文" className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Crosshair size={10.5} /></button>
          <button onClick={() => onCopy(e)} title="复制" className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Copy size={10.5} /></button>
          <button onClick={() => setNoteEdit({ id: e.id, draft: e.note })} title="编辑备注" className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Pencil size={10.5} /></button>
          <button onClick={() => onDelete(e)} title="删除摘录" className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-warning)]"><Trash2 size={10.5} /></button>
        </div>
      )}
    </div>
  )
}
