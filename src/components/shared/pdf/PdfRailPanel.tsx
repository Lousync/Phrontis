import { useCallback, useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url'
import { BookMarked, BookOpen, LayoutGrid, ListTree } from 'lucide-react'
import { pdfReaderGet, pdfReaderPatch, workspaceGetCurrent, workspaceReadRange } from '../../../lib/ipc'
import { useDataChanged } from '../../../lib/dataChanged'
import { OutlineTree, destToPageNum, loadOutline, type OutlineNode } from './PdfOutlineTree'
import { PdfThumbGrid } from './PdfThumbGrid'
import { PdfBookmarkList } from './PdfBookmarkList'
import { KB_BOOKMARK_DELETE, KB_BOOKMARK_SECTION_SHOW, KB_PDF_PAGE_CHANGED, KB_PDF_GOTO_PAGE } from './pdfEvents'
// 事件常量已抽到零依赖的 pdfEvents.ts（防 pdfjs 被常量消费方拖进主包）；此处再导出保持既有 import 路径可用
export { KB_PDF_PAGE_CHANGED, KB_PDF_GOTO_PAGE } from './pdfEvents'

// 同源 worker（与阅读器同口径）
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const CHUNK = 128 * 1024

function b64ToU8(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 左栏专用 transport（方案 §11.3：每消费者独立 transport + 128KB chunk，内存可控） */
class RailRangeTransport extends pdfjsLib.PDFDataRangeTransport {
  constructor(length: number, initialData: Uint8Array | null, private read: (begin: number, end: number) => Promise<Uint8Array>) {
    super(length, initialData)
  }
  requestDataRange(begin: number, end: number): void {
    void this.read(begin, end).then(
      (chunk) => this.onDataRange(begin, chunk),
      () => this.onDataRange(begin, null),
    )
  }
}

/** 阅读器 → 左栏：当前页广播（阅读器在 pageNum/viewMode 变化时派发） */
interface Props {
  /** 当前编辑器激活文档（仅 PDF 时非空）——App 经 kb-editor-doc-changed 维护 */
  readerDoc: { relPath: string } | null
}

/**
 * 左栏 bookshelf 模块态「大纲三件套」（v3.4.0 批次 6，方案 §2/§0.6）：
 * 目录 / 缩略图 / 书签只在左栏渲染这一份（阅读器内嵌侧栏已删）。
 * 持独立 range transport 打开同一本书（与阅读器互不干扰）；跳页经事件送回阅读器执行。
 */
export function PdfRailPanel({ readerDoc }: Props) {
  const [rootId, setRootId] = useState<string | null>(null)
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [outline, setOutline] = useState<OutlineNode[]>([])
  const [bookmarks, setBookmarks] = useState<Array<{ page: number; note: string; at: string }>>([])
  const [current, setCurrent] = useState(1)
  const [duo, setDuo] = useState(false)
  const [section, setSection] = useState<'outline' | 'thumbs' | 'bookmarks'>('outline')
  const bookUpdatedRef = useRef<string | undefined>(undefined)

  const relPath = readerDoc?.relPath ?? null

  // 当前页跟随：阅读器 pageNum/viewMode 变化即广播
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as { relPath?: string; page?: number; mode?: string } | undefined
      if (!d?.relPath || d.relPath !== relPath) return
      if (typeof d.page === 'number') setCurrent(d.page)
      setDuo(d.mode === 'duo')
    }
    window.addEventListener(KB_PDF_PAGE_CHANGED, on)
    return () => window.removeEventListener(KB_PDF_PAGE_CHANGED, on)
  }, [relPath])

  // 阅读器新增书签 → 请求本面板切到书签区（否则用户在目录区点收藏「看不到反应」）
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as { relPath?: string } | undefined
      if (d?.relPath && d.relPath !== relPath) return
      setSection('bookmarks')
    }
    window.addEventListener(KB_BOOKMARK_SECTION_SHOW, on)
    return () => window.removeEventListener(KB_BOOKMARK_SECTION_SHOW, on)
  }, [relPath])

  // 书签随写盘广播刷新（阅读器增删书签 → patch → broadcastDataChanged）
  useEffect(() => {
    if (!rootId || !relPath) return
    void (async () => {
      try {
        const r = await pdfReaderGet(rootId, relPath)
        if (r.ok && r.state) {
          bookUpdatedRef.current = r.state.updatedAt
          setBookmarks(r.state.bookmarks ?? [])
        }
      } catch { /* ignore */ }
    })()
  }, [rootId, relPath])
  useDataChanged('pdfReader', () => {
    if (!rootId || !relPath) return
    void (async () => {
      try {
        const r = await pdfReaderGet(rootId, relPath)
        if (r.ok && r.state) setBookmarks(r.state.bookmarks ?? [])
      } catch { /* ignore */ }
    })()
  })

  // 打开自己的文档实例（独立 transport）+ 大纲
  useEffect(() => {
    if (!rootId || !relPath) { setPdf(null); setOutline([]); return }
    let alive = true
    void (async () => {
      try {
        const probe = await workspaceReadRange(rootId, relPath, 0, 4096)
        if ('error' in probe && probe.error) throw new Error(probe.error)
        const head = b64ToU8(probe.data)
        const transport = new RailRangeTransport(probe.size, head.length > 0 ? head : null, async (begin, end) => {
          const r = await workspaceReadRange(rootId, relPath, begin, Math.max(1, end - begin))
          if ('error' in r && r.error) throw new Error(r.error)
          return b64ToU8(r.data)
        })
        const task = pdfjsLib.getDocument({ range: transport, disableAutoFetch: true, rangeChunkSize: CHUNK })
        const doc = await task.promise
        if (!alive) { void task.destroy(); return }
        setPdf(doc)
        setOutline(await loadOutline(doc))
      } catch { if (alive) { setPdf(null); setOutline([]) } }
    })()
    return () => { alive = false }
  }, [rootId, relPath])

  useEffect(() => {
    void (async () => {
      const cur = await workspaceGetCurrent()
      setRootId(cur?.rootId ?? null)
    })()
  }, [])

  const goto = useCallback((page: number) => {
    if (!relPath) return
    window.dispatchEvent(new CustomEvent(KB_PDF_GOTO_PAGE, { detail: { relPath, page } }))
  }, [relPath])

  const jumpOutline = useCallback(async (node: OutlineNode) => {
    if (!pdf || node.dest === undefined) return
    const p = await destToPageNum(pdf, node.dest)
    // destToPageNum 返回 1 基；失败兜底同为 1（旧口径如此，保留 —— 跳第 1 页好过静默不跳）。
    // 守卫必须放行 1：dest 指向第 1 页（getPageIndex=0 → 返回 1）是**合法跳转**，
    // 若写成 p > 1 会把 F-9 的「点了没反应」原样复发（台账 F-9 修复批注）。
    if (p >= 1) goto(p)
  }, [goto, pdf])

  const onNote = useCallback((page: number, note: string) => {
    if (!rootId || !relPath) return
    const next = bookmarks.map((b) => (b.page === page ? { ...b, note } : b)).sort((a, b) => a.page - b.page)
    setBookmarks(next)
    void pdfReaderPatch(rootId, relPath, { bookmarks: next }, bookUpdatedRef.current).then((r) => {
      if (r.ok && r.state) bookUpdatedRef.current = r.state.updatedAt
    })
  }, [bookmarks, relPath, rootId])

  /**
   * 删除书签：**回派给阅读器执行**，本面板不写盘（见 pdfEvents 的 KB_BOOKMARK_DELETE）。
   * 阅读器写完 patch → broadcastDataChanged('pdfReader') → 上面那个 useDataChanged 把列表刷新。
   */
  const onDelete = useCallback((page: number) => {
    if (!relPath) return
    window.dispatchEvent(new CustomEvent(KB_BOOKMARK_DELETE, { detail: { relPath, id: String(page) } }))
  }, [relPath])

  if (!relPath) {
    return (
      <div data-wb="pdfRailPanel" data-wb-state="empty" className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-[var(--text-muted)]">
        <BookOpen size={26} strokeWidth={1.4} />
        <div className="text-[12px] leading-relaxed">从书架选一本书开始阅读<br />这里会显示它的目录、缩略图与书签</div>
      </div>
    )
  }

  const tabCls = (active: boolean) =>
    `flex flex-1 items-center justify-center gap-1 rounded px-1 py-1 text-[11px] ${active ? 'bg-[var(--bg-hover)] text-[var(--accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`

  return (
    <div data-wb="pdfRailPanel" data-wb-state="ready" className="flex h-full min-h-0 flex-col">
      {/* 三区切换。文字按容器宽度退化（styles/index.css 的 .kb-fit 段）：左栏收到 <178px 时
          「缩略图」三个字（理想 56px）塞不进 flex-1 均分出的 53px，会换行成竖排 → 只留图标。 */}
      <div className="kb-fit kb-fit-pdfrail mx-1.5 mb-1 flex shrink-0 items-center gap-0.5 rounded-md border border-[var(--border-color)] p-0.5">
        <button onClick={() => setSection('outline')} className={tabCls(section === 'outline')} title="目录"><ListTree size={12} /><span className="kb-l1">目录</span></button>
        <button onClick={() => setSection('thumbs')} className={tabCls(section === 'thumbs')} title="缩略图"><LayoutGrid size={12} /><span className="kb-l1">缩略图</span></button>
        <button onClick={() => setSection('bookmarks')} className={tabCls(section === 'bookmarks')} title="书签"><BookMarked size={12} /><span className="kb-l1">书签</span></button>
      </div>
      {section === 'outline' && (
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {outline.length === 0 && <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]">此 PDF 没有目录</div>}
          <OutlineTree nodes={outline} onJump={(n) => void jumpOutline(n)} depth={0} />
        </div>
      )}
      {section === 'thumbs' && (
        <PdfThumbGrid pdf={pdf} numPages={pdf?.numPages ?? 0} current={current} duo={duo} onJump={goto} />
      )}
      {section === 'bookmarks' && (
        <PdfBookmarkList bookmarks={bookmarks} current={current} duo={duo} onJump={goto} onNote={onNote} onDelete={onDelete} />
      )}
    </div>
  )
}
