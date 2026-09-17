import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Maximize as MaximizeIcon,
  FileText, AlertTriangle, Loader2, ListTree, Search, BookOpen, X,
  GalleryVertical, Square, Columns2, Bookmark, BookmarkPlus, LayoutGrid, Eye, EyeOff, BookMarked,
} from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import { renderTextLayer } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url'
import { openExternal, copyText, pdfReaderGet, pdfReaderPatch, translateInvoke, workspaceReadRange } from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'
import { normalizeSpreadStart, resolveDegrade, spreadPages, estimatePageHeight, DUO_MIN_WIDTH, type PdfLayoutMode } from '../../../lib/pdfLayout'
import { PdfThumbGrid } from './PdfThumbGrid'
import { PdfBookmarkList } from './PdfBookmarkList'
import { TextSelectionBar, type SelectionRect, type TranslateState } from './TextSelectionBar'
import type { PdfBookPatch, PdfBookState } from '../../../types'

// 同源 worker（v3 classic，兼容 Electron 33 / Chromium 130——v4.5+ 依赖 toHex 未实现）
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const CHUNK = 128 * 1024 // range 块大小：128KB
/** 竖滚渲染池并发上限（方案 §5.2：canvas 池 ≤4） */
const POOL_CONCURRENCY = 4
/** 渲染池预取缓冲：可视页 ±2 */
const POOL_BUFFER = 2

/** 文本层必要样式（pdf.js 官方 viewer.css 子集）+ 页内链接热区：一次性注入 */
let textLayerStyleInjected = false
function ensureTextLayerStyle(): void {
  if (textLayerStyleInjected) return
  textLayerStyleInjected = true
  const style = document.createElement('style')
  style.id = 'kb-pdf-textlayer-style'
  style.textContent = `
    .kb-pdf-text-layer { position: absolute; inset: 0; overflow: hidden; line-height: 1; text-align: initial; }
    .kb-pdf-text-layer span, .kb-pdf-text-layer br { position: absolute; white-space: pre; transform-origin: 0% 0%; color: transparent; }
    .kb-pdf-text-layer ::selection { background: rgba(0,120,255,0.35); color: transparent; }
    .kb-pdf-text-layer .kb-pdf-match { color: transparent; outline: 2px solid rgba(230,140,30,0.9); background: rgba(230,140,30,0.35); }
    .kb-pdf-link:hover { background: rgba(0,120,255,0.14); box-shadow: 0 0 0 1px rgba(0,120,255,0.25); }
  `
  document.head.appendChild(style)
}

/** base64 → Uint8Array（渲染层无 Buffer） */
function b64ToU8(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * 走 ws:readRange 的自定义 transport（plugin-pdf-reader-design §4）：
 * pdf.js 渲染层发起 range 请求 → IPC 精确读段 → onDataRange 回传。
 * 大 PDF 只拉可见字节，不整文件过 IPC。
 */
class KbRangeTransport extends pdfjsLib.PDFDataRangeTransport {
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

/** outline dest → 页码（v3 dest 结构：数组首元素是 {num,gen} ref；字符串需 getDestination 解析） */
async function destToPageNum(pdf: pdfjsLib.PDFDocumentProxy, dest: unknown): Promise<number> {
  try {
    let d = dest
    if (typeof d === 'string') d = await pdf.getDestination(d)
    if (Array.isArray(d) && d[0] && typeof d[0] === 'object' && typeof (d[0] as { num?: unknown }).num === 'number') {
      return (d[0] as { num: number }).num
    }
  } catch { /* 解析失败回第 1 页 */ }
  return 1
}

/**
 * 页内链接热区（方案 §5.8）：/Link 注解 rect → viewport 矩形 → 透明热区。
 * 内部 dest 跳页；URI 型走 app:openExternal（主进程白名单 http/https）。
 * goPage 经 ref 注入避免渲染闭包环。
 */
async function attachLinks(
  pdf: pdfjsLib.PDFDocumentProxy,
  page: pdfjsLib.PDFPageProxy,
  viewport: { convertToViewportRectangle: (r: number[]) => number[] },
  host: HTMLElement,
  onJumpPage: (n: number) => void,
): Promise<void> {
  try {
    const annots = await page.getAnnotations()
    for (const a of annots) {
      if (!a || a.subtype !== 'Link') continue
      const url = typeof (a as { url?: unknown }).url === 'string' ? (a as { url: string }).url : ''
      let destPage: number | null = null
      if (!url && (a as { dest?: unknown }).dest !== undefined) {
        const n = await destToPageNum(pdf, (a as { dest: unknown }).dest)
        if (n >= 1) destPage = n
      }
      if (!url && !destPage) continue
      const rect = viewport.convertToViewportRectangle((a as { rect?: number[] }).rect ?? [0, 0, 0, 0])
      const left = Math.min(rect[0], rect[2])
      const top = Math.min(rect[1], rect[3])
      const w = Math.abs(rect[2] - rect[0])
      const h = Math.abs(rect[3] - rect[1])
      if (w <= 1 || h <= 1) continue
      const div = document.createElement('div')
      div.className = 'kb-pdf-link'
      div.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px;cursor:pointer;`
      div.title = url || `跳转到第 ${destPage} 页`
      div.addEventListener('click', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        if (url) {
          if (/^https?:\/\//i.test(url)) void openExternal(url)
        } else if (destPage) {
          onJumpPage(destPage)
        }
      })
      host.appendChild(div)
    }
  } catch { /* 注解读取失败不影响页面渲染 */ }
}

interface OutlineNode {
  title: string
  dest?: unknown
  items: OutlineNode[]
}

interface Props {
  rootId: string
  relPath: string
  name: string
}

/**
 * 共享 PDF 阅读器 v2（v3.4.0 PDF 整包批次 3：PdfReaderView 自 editor 迁入 + 三模式 + 渲染池）。
 *
 * 三模式（方案 §5.2）：
 * - 竖滚（默认）：全页占位（首页宽高比估高）+ IntersectionObserver 可视页 ±2 进渲染池
 *   （并发 ≤4，离开即回收 canvas）；文本层只挂可视页（方案 §11.2 口径）。
 * - 单页：一次一屏（v1 行为保持，不回归）。
 * - 双页：跨页对 (p, p+1)，起始页归一化 normalizeSpreadStart；容器 <1240px 自动降级单页 + toast。
 * 保留 v1：懒加载 range transport、文本层、大纲（批次 6 迁左栏）、全文搜索、沉浸、快捷键。
 */
export function PdfReaderView({ rootId, relPath, name }: Props) {
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null)

  // ===== 文档态 =====
  const [numPages, setNumPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [outline, setOutline] = useState<OutlineNode[]>([])
  /** 首页基准尺寸（占位估算用） */
  const firstPageRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 })

  // ===== 视图态 =====
  const [viewMode, setViewMode] = useState<PdfLayoutMode>('scroll')
  const [pageNum, setPageNum] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [fitWidth, setFitWidth] = useState(true)
  const pageNumRef = useRef(1)
  const zoomRef = useRef(1)
  /** goPage 经 ref 供 attachLinks 热区调用（避免渲染闭包环） */
  const goPageRef = useRef<((n: number) => void) | null>(null)
  /** 容器可用宽（去内边距；duo 再对半） */
  const [availW, setAvailW] = useState(800)
  const containerRef = useRef<HTMLDivElement>(null)

  // ===== 单页/双页渲染 refs =====
  const singleCanvasRef = useRef<HTMLCanvasElement>(null)
  const singleTextRef = useRef<HTMLDivElement>(null)
  const duoCanvasARef = useRef<HTMLCanvasElement>(null)
  const duoCanvasBRef = useRef<HTMLCanvasElement>(null)
  const duoTextARef = useRef<HTMLDivElement>(null)
  const duoTextBRef = useRef<HTMLDivElement>(null)
  const duoStartRef = useRef(1)
  const pageHostRef = useRef<HTMLDivElement>(null)

  // ===== 侧栏 / 搜索 / 沉浸（v1 保留） =====
  const [sideTab, setSideTab] = useState<'outline' | 'search' | 'thumbs' | 'bookmarks' | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchHits, setSearchHits] = useState<Array<{ page: number; preview: string }>>([])
  const [immersive, setImmersive] = useState(false)
  const [barHidden, setBarHidden] = useState(false)

  // ===== 书级状态（批次 4：书签 / 续读 / 护眼，方案 §3/§5.6/§5.7）=====
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [bookmarks, setBookmarks] = useState<Array<{ page: number; note: string; at: string }>>([])
  const [eyeCare, setEyeCare] = useState(false)
  /** 冲突检测基准（pdfReader.json 的 updatedAt） */
  const bookUpdatedRef = useRef<string | undefined>(undefined)
  const [hasProgressBook, setHasProgressBook] = useState(false)

  const readRange = useCallback(async (begin: number, end: number): Promise<Uint8Array> => {
    const r = await workspaceReadRange(rootId, relPath, begin, Math.max(1, end - begin))
    if ('error' in r && r.error) throw new Error(r.error)
    return b64ToU8(r.data)
  }, [rootId, relPath])

  // ===== 续读写回（方案 §5.7：翻页/滚动节流 800ms patch；关标签/切 Tab/切文档立即 flush）=====
  const pendingRef = useRef<{ patch: PdfBookPatch } | null>(null)
  const flushTimerRef = useRef(0)

  const doPatch = useCallback(async (patch: PdfBookPatch): Promise<void> => {
    try {
      const r = await pdfReaderPatch(rootId, relPath, patch, bookUpdatedRef.current)
      if (r.ok && r.state) {
        bookUpdatedRef.current = r.state.updatedAt
        if (r.state.bookmarks) setBookmarks(r.state.bookmarks)
      } else if (r.conflict && r.state) {
        // 冲突 → 以服务端为基底、本地意图覆盖（进度语义 = 最新一次阅读位置胜出），带新基准重试一次
        bookUpdatedRef.current = r.state.updatedAt
        const merged: PdfBookPatch = { ...patch, lastPage: patch.lastPage ?? r.state.lastPage }
        const r2 = await pdfReaderPatch(rootId, relPath, merged, r.state.updatedAt)
        if (r2.ok && r2.state) {
          bookUpdatedRef.current = r2.state.updatedAt
          if (r2.state.bookmarks) setBookmarks(r2.state.bookmarks)
        }
      }
    } catch { /* 写回失败静默：进度属可再生数据 */ }
  }, [relPath, rootId])

  const scheduleProgress = useCallback((patch: PdfBookPatch, immediate = false) => {
    pendingRef.current = { patch: { ...(pendingRef.current?.patch ?? {}), ...patch } }
    window.clearTimeout(flushTimerRef.current)
    flushTimerRef.current = window.setTimeout(() => {
      const p = pendingRef.current?.patch
      pendingRef.current = null
      if (p) void doPatch(p)
    }, immediate ? 0 : 800)
  }, [doPatch])

  /** 卸载/隐藏/卸载前兜底 flush（保活层切 Tab 不卸载 → 用 visibilitychange 兜底） */
  useEffect(() => {
    const flush = () => {
      const p = pendingRef.current?.patch
      pendingRef.current = null
      window.clearTimeout(flushTimerRef.current)
      if (p) void doPatch(p)
    }
    const onVis = () => { if (document.visibilityState === 'hidden') flush() }
    const onBeforeUnload = () => flush()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('beforeunload', onBeforeUnload)
      flush()
    }
  }, [doPatch])

  // ===== 容器宽测量（防呆降级 + 适宽基准）=====
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      const pad = immersive ? 0 : 48
      setAvailW(Math.max(120, el.clientWidth - pad))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [immersive])

  // ===== 双页防呆降级（方案 §5.3：低于 1240px 自动降级 + toast）=====
  const degradeToastedRef = useRef(false)
  useEffect(() => {
    const effective = resolveDegrade(availW, viewMode)
    if (effective !== viewMode && viewMode === 'duo') {
      setViewMode('single')
      if (!degradeToastedRef.current) {
        degradeToastedRef.current = true
        showToast({ type: 'warning', message: `容器宽度不足 ${DUO_MIN_WIDTH}px，已自动切回单页` })
      }
    } else if (viewMode !== 'duo') {
      degradeToastedRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availW, viewMode])

  // ===== 渲染一页到指定 canvas（single / duo / scroll 池共用；textHost 同时承载链接热区）=====
  const renderPageTo = useCallback(async (
    num: number,
    canvas: HTMLCanvasElement,
    textHost: HTMLDivElement | null,
    scale: number,
    opts?: { withText?: boolean },
  ): Promise<void> => {
    const pdf = pdfRef.current
    if (!pdf) return
    const page = await pdf.getPage(num)
    const viewport = page.getViewport({ scale })
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.floor(viewport.width * dpr)
    canvas.height = Math.floor(viewport.height * dpr)
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    await page.render({ canvasContext: ctx, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise
    if (textHost) {
      textHost.innerHTML = ''
      // 竖滚池：文本层只挂可视页（方案 §11.2）；链接热区总是挂
      if (opts?.withText !== false) {
        const textContent = await page.getTextContent()
        await renderTextLayer({ textContentSource: textContent, container: textHost, viewport }).promise
      }
      await attachLinks(pdf, page, viewport, textHost, (n) => goPageRef.current?.(n))
    }
  }, [])

  /** 当前页缩放系数由各 render 分支按 fitWidth/zoom 现算；这里不再集中（duo/单页/滚动池口径不同） */

  // ===== 单页渲染 =====
  const renderSingle = useCallback(async (num: number) => {
    const pdf = pdfRef.current
    const canvas = singleCanvasRef.current
    const textHost = singleTextRef.current
    if (!pdf || !canvas) return
    try {
      const page = await pdf.getPage(num)
      const base = page.getViewport({ scale: 1 })
      const scale = fitWidth ? Math.max(0.2, availW / base.width) : zoomRef.current
      await renderPageTo(num, canvas, textHost, scale)
      setZoom(scale)
    } catch (e) {
      const msg = String((e as Error)?.message || e)
      if (!msg.includes('cancel')) setError(msg)
    }
  }, [availW, fitWidth, renderPageTo])

  // ===== 双页渲染（跨页对，起始归一化）=====
  const renderDuo = useCallback(async (startRaw: number) => {
    const pdf = pdfRef.current
    if (!pdf) return
    const start = normalizeSpreadStart(Math.min(Math.max(1, startRaw), pdf.numPages))
    const pages = spreadPages(start, pdf.numPages)
    duoStartRef.current = start
    setPageNum(start)
    pageNumRef.current = start
    try {
      const pageA = await pdf.getPage(pages[0])
      const baseA = pageA.getViewport({ scale: 1 })
      const slots = pages.length === 2 ? 2 : 1
      const scale = fitWidth ? Math.max(0.2, (availW - (pages.length === 2 ? 16 : 0)) / slots / baseA.width) : zoomRef.current
      const canvasA = duoCanvasARef.current
      const textA = duoTextARef.current
      if (canvasA) await renderPageTo(pages[0], canvasA, textA, scale)
      if (pages.length === 2) {
        const canvasB = duoCanvasBRef.current
        const textB = duoTextBRef.current
        if (canvasB) await renderPageTo(pages[1], canvasB, textB, scale)
      }
      setZoom(scale)
    } catch (e) {
      const msg = String((e as Error)?.message || e)
      if (!msg.includes('cancel')) setError(msg)
    }
  }, [availW, fitWidth, renderPageTo])

  // ===== 竖滚渲染池 =====
  const scrollHostRef = useRef<HTMLDivElement>(null)
  const slotElsRef = useRef(new Map<number, HTMLDivElement>())
  /** 已渲染页集合（canvas 已插入） */
  const poolRenderedRef = useRef(new Set<number>())
  const poolInflightRef = useRef(new Set<number>())
  /** 渲染池目标（近视页 ±2） */
  const poolWantedRef = useRef(new Set<number>())
  /** 文本层只挂可视页（小半径集合） */
  const tightVisibleRef = useRef(new Set<number>())
  const [slotH, setSlotH] = useState(600)

  const setSlotRef = useCallback((n: number, el: HTMLDivElement | null) => {
    if (el) slotElsRef.current.set(n, el)
    else slotElsRef.current.delete(n)
  }, [])

  const poolPumpRef = useRef<(() => void) | null>(null)
  const renderIntoSlot = useCallback(async (n: number) => {
    const pdf = pdfRef.current
    const slot = slotElsRef.current.get(n)
    if (!pdf || !slot || poolRenderedRef.current.has(n)) return
    poolInflightRef.current.add(n)
    try {
      const page = await pdf.getPage(n)
      const base = page.getViewport({ scale: 1 })
      const scale = fitWidth ? Math.max(0.2, availW / base.width) : zoomRef.current
      // 就绪前 slot 可能已被回收（翻滚离开）
      if (!slotElsRef.current.get(n) || !poolWantedRef.current.has(n)) return
      slot.innerHTML = ''
      const canvas = document.createElement('canvas')
      canvas.className = 'block bg-[var(--bg-primary)] shadow-sm'
      slot.appendChild(canvas)
      const frame = document.createElement('div')
      frame.className = 'kb-pdf-text-layer absolute inset-0'
      await renderPageTo(n, canvas, frame, scale, { withText: tightVisibleRef.current.has(n) })
      // 渲染完按真实高度校正占位（估高只对首页可信）
      slot.style.height = `${canvas.style.height}`
      poolRenderedRef.current.add(n)
    } catch { /* 单页失败不进 error 全局态，滚动重试 */ }
    finally {
      poolInflightRef.current.delete(n)
      poolPumpRef.current?.()
    }
  }, [availW, fitWidth, renderPageTo])

  poolPumpRef.current = () => {
    let running = poolInflightRef.current.size
    for (const n of poolWantedRef.current) {
      if (running >= POOL_CONCURRENCY) return
      if (poolRenderedRef.current.has(n) || poolInflightRef.current.has(n)) continue
      void renderIntoSlot(n)
      running++
    }
  }

  /** 池窗口变化：wanted = nearSet ±2；离开窗口的页回收 canvas */
  const syncPool = useCallback(() => {
    const wanted = new Set<number>()
    for (const n of tightVisibleRef.current) wanted.add(n)
    for (const n of new Set(tightVisibleRef.current)) {
      for (let d = 1; d <= POOL_BUFFER; d++) {
        if (n - d >= 1) wanted.add(n - d)
        if (n + d <= numPages) wanted.add(n + d)
      }
    }
    poolWantedRef.current = wanted
    for (const n of [...poolRenderedRef.current]) {
      if (!wanted.has(n)) {
        poolRenderedRef.current.delete(n)
        const slot = slotElsRef.current.get(n)
        if (slot) slot.innerHTML = ''
      }
    }
    poolPumpRef.current?.()
  }, [numPages])

  // 竖滚观察器：紧集合（文本层挂载/当前页）+ 渲染窗口
  useEffect(() => {
    if (viewMode !== 'scroll' || loading || numPages === 0) return
    const host = scrollHostRef.current
    if (!host) return
    const tight = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const n = Number((en.target as HTMLElement).dataset.pg)
        if (!n) continue
        if (en.isIntersecting) tightVisibleRef.current.add(n)
        else tightVisibleRef.current.delete(n)
      }
      if (tightVisibleRef.current.size > 0) {
        const cur = Math.min(...tightVisibleRef.current)
        if (cur !== pageNumRef.current) { pageNumRef.current = cur; setPageNum(cur) }
      }
      syncPool()
    }, { root: host, rootMargin: '140px 0px' })
    const near = new IntersectionObserver(() => syncPool(), { root: host, rootMargin: '900px 0px' })
    for (const el of slotElsRef.current.values()) { tight.observe(el); near.observe(el) }
    syncPool()
    return () => { tight.disconnect(); near.disconnect() }
  }, [viewMode, loading, numPages, syncPool])

  // 竖滚：当前页跟踪（视口中心线所在 slot，rect 基准不依赖 offsetParent）+ rAF 节流 + 滚动比例写回
  const scrollRafRef = useRef(0)
  const onScrollHost = useCallback(() => {
    if (scrollRafRef.current) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0
      const host = scrollHostRef.current
      if (!host) return
      const hostRect = host.getBoundingClientRect()
      const center = hostRect.top + hostRect.height / 2
      let best = 1
      for (const [n, el] of slotElsRef.current) {
        if (el.getBoundingClientRect().top <= center) best = Math.max(best, n)
        else break
      }
      if (best !== pageNumRef.current) { pageNumRef.current = best; setPageNum(best) }
      setSelInfo(null) // 滚动即失效浮条锚点
      // 续读：页内滚动比例（0..1，两极端不写避免污染）
      const max = host.scrollHeight - host.clientHeight
      if (max > 40) {
        const ratio = Math.min(1, Math.max(0, host.scrollTop / max))
        scheduleProgress({ lastPage: best, scrollRatio: ratio })
      }
    })
  }, [scheduleProgress])

  /** 竖滚跳页：滚到 slot 顶（rect 基准） */
  const scrollGoPage = useCallback((n: number) => {
    const host = scrollHostRef.current
    const slot = slotElsRef.current.get(n)
    if (!host || !slot) return
    const top = slot.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop
    host.scrollTo({ top: Math.max(0, top - 12) })
  }, [])

  // ===== 统一跳页 =====
  const goPage = useCallback(async (num: number) => {
    const pdf = pdfRef.current
    if (!pdf) return
    const target = Math.max(1, Math.min(num, pdf.numPages))
    if (viewMode === 'scroll') {
      pageNumRef.current = target
      setPageNum(target)
      scrollGoPage(target)
      scheduleProgress({ lastPage: target })
      return
    }
    if (viewMode === 'duo') {
      await renderDuo(target)
      scheduleProgress({ lastPage: normalizeSpreadStart(Math.min(target, pdf.numPages)) })
      return
    }
    if (target === pageNumRef.current) {
      await renderSingle(target)
      return
    }
    pageNumRef.current = target
    setPageNum(target)
    await renderSingle(target)
    scheduleProgress({ lastPage: target })
  }, [renderDuo, renderSingle, scheduleProgress, scrollGoPage, viewMode])
  goPageRef.current = (n) => { void goPage(n) }

  // ===== 模式切换 =====
  const switchMode = useCallback(async (m: PdfLayoutMode) => {
    if (m === viewMode) return
    const from = viewMode
    setViewMode(m)
    scheduleProgress({ mode: m }, true)
    if (m === 'scroll') {
      // 从翻页模式进来：滚到当前页
      requestAnimationFrame(() => scrollGoPage(pageNumRef.current))
      return
    }
    if (m === 'duo') {
      if (availW < DUO_MIN_WIDTH) {
        showToast({ type: 'warning', message: `容器宽度不足 ${DUO_MIN_WIDTH}px，已自动切回单页` })
        setViewMode('single')
        await renderSingle(pageNumRef.current)
        scheduleProgress({ mode: 'single' }, true)
        return
      }
      const start = from === 'scroll' ? normalizeSpreadStart(pageNumRef.current) : pageNumRef.current
      requestAnimationFrame(() => { void renderDuo(start) })
      return
    }
    // single
    const target = from === 'duo' ? duoStartRef.current : pageNumRef.current
    pageNumRef.current = target
    setPageNum(target)
    requestAnimationFrame(() => { void renderSingle(target) })
  }, [availW, renderDuo, renderSingle, scheduleProgress, scrollGoPage, viewMode])

  // ===== 加载文档 =====
  useEffect(() => {
    ensureTextLayerStyle()
    let alive = true
    setLoading(true)
    setError('')
    setSearchHits([])
    setSearchQuery('')
    void (async () => {
      try {
        const probe = await workspaceReadRange(rootId, relPath, 0, 4096)
        if ('error' in probe && probe.error) throw new Error(probe.error)
        if (!alive) return
        const head = b64ToU8(probe.data)
        const transport = new KbRangeTransport(probe.size, head.length > 0 ? head : null, readRange)
        const task = pdfjsLib.getDocument({ range: transport, disableAutoFetch: false, rangeChunkSize: CHUNK })
        const pdf = await task.promise
        if (!alive) { void task.destroy(); return }
        pdfRef.current = pdf
        setPdfDoc(pdf)
        setNumPages(pdf.numPages)
        const p1 = await pdf.getPage(1)
        const base1 = p1.getViewport({ scale: 1 })
        firstPageRef.current = { w: base1.width, h: base1.height }
        try {
          const raw = await pdf.getOutline()
          if (raw && raw.length) {
            const walk = (list: typeof raw): OutlineNode[] => list.map((it) => ({
              title: it.title ?? '',
              dest: it.dest,
              items: it.items?.length ? walk(it.items) : [],
            }))
            setOutline(walk(raw))
          }
        } catch { setOutline([]) }
        setLoading(false)
        pageNumRef.current = 1
        setPageNum(1)
      } catch (e) {
        if (alive) setError(String((e as Error)?.message || e))
      }
    })()
    return () => {
      alive = false
      pdfRef.current?.destroy().catch(() => {})
      pdfRef.current = null
      setPdfDoc(null)
      bookUpdatedRef.current = undefined
      setBookmarks([])
      setHasProgressBook(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId, relPath])

  // 加载完 → 读书级状态（进度/模式/缩放/护眼/书签）→ 按恢复位置首渲（方案 §5.7 续读）
  useEffect(() => {
    if (loading || numPages === 0) return
    void (async () => {
      let restored: PdfBookState | null = null
      try {
        const r = await pdfReaderGet(rootId, relPath)
        if (r.ok && r.state) {
          restored = r.state
          bookUpdatedRef.current = r.state.updatedAt
          setBookmarks(r.state.bookmarks ?? [])
          if (r.state.eyeCare) setEyeCare(true)
          if (r.state.zoom && r.state.zoom !== 1) {
            setFitWidth(false)
            zoomRef.current = r.state.zoom
            setZoom(r.state.zoom)
          }
          if (r.state.mode && r.state.mode !== 'scroll' && resolveDegrade(availW, r.state.mode) === r.state.mode) {
            setViewMode(r.state.mode)
          }
        }
      } catch { /* 无进度/读取失败 → 从头看 */ }
      const page = restored?.lastPage && restored.lastPage >= 1 ? Math.min(restored.lastPage, numPages) : 1
      pageNumRef.current = page
      setPageNum(page)
      const modeNow = restored?.mode && restored.mode !== 'scroll' && resolveDegrade(availW, restored.mode) === restored.mode ? restored.mode : 'scroll'
      if (modeNow === 'scroll') {
        const { w, h } = firstPageRef.current
        setSlotH(estimatePageHeight(w, h, Math.max(120, availW)))
        requestAnimationFrame(() => {
          if (restored && restored.scrollRatio > 0.005) {
            const host = scrollHostRef.current
            if (host) {
              // 占位已挂载 → 按比例恢复页内滚动位置
              const max = host.scrollHeight - host.clientHeight
              if (max > 40) host.scrollTop = restored.scrollRatio * max
              return
            }
          }
          scrollGoPage(page)
        })
      } else if (modeNow === 'duo') {
        void renderDuo(page)
      } else {
        void renderSingle(page)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, numPages])

  // 适宽 / 容器变化 → 重绘当前视图（竖滚：重估占位 + 清池重渲）
  const availKey = `${availW}-${fitWidth ? 'fit' : zoom.toFixed(2)}`
  useEffect(() => {
    if (loading || numPages === 0) return
    if (viewMode === 'scroll') {
      const { w, h } = firstPageRef.current
      setSlotH(estimatePageHeight(w, h, Math.max(120, availW)))
      poolRenderedRef.current.clear()
      for (const slot of slotElsRef.current.values()) slot.innerHTML = ''
      syncPool()
    } else if (viewMode === 'single') {
      void renderSingle(pageNumRef.current)
    } else {
      void renderDuo(duoStartRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availKey, viewMode])

  const zoomBy = useCallback(async (delta: number) => {
    setFitWidth(false)
    zoomRef.current = Math.max(0.25, Math.min(5, (zoomRef.current || 1) * delta))
    setZoom(zoomRef.current)
    scheduleProgress({ zoom: zoomRef.current })
  }, [scheduleProgress])

  // ===== 书签（方案 §5.6：当页增删 + 列表备注）=====
  const currentPageForBookmark = () => (viewMode === 'duo' ? duoStartRef.current : pageNumRef.current)

  const toggleBookmark = useCallback(() => {
    const page = currentPageForBookmark()
    const has = bookmarks.some((b) => b.page === page)
    const next = has
      ? bookmarks.filter((b) => b.page !== page)
      : [...bookmarks, { page, note: '', at: new Date().toISOString() }].sort((a, b) => a.page - b.page)
    setBookmarks(next)
    setHasProgressBook(next.length > 0)
    scheduleProgress({ bookmarks: next }, true)
  }, [bookmarks, scheduleProgress, viewMode])

  const setBookmarkNote = useCallback((page: number, note: string) => {
    const next = bookmarks
      .map((b) => (b.page === page ? { ...b, note } : b))
      .sort((a, b) => a.page - b.page)
    setBookmarks(next)
    scheduleProgress({ bookmarks: next }, true)
  }, [bookmarks, scheduleProgress])

  // ===== 护眼（方案 §5.9：容器级 filter，书级记忆；不碰全局主题变量）=====
  const toggleEyeCare = useCallback(() => {
    setEyeCare((v) => {
      const next = !v
      scheduleProgress({ eyeCare: next }, true)
      return next
    })
  }, [scheduleProgress])

  // ===== 划词 AI 工具条（方案 §6）=====
  const rootRef = useRef<HTMLDivElement>(null)
  const [selInfo, setSelInfo] = useState<{ rect: SelectionRect; text: string; page: number } | null>(null)
  const [translate, setTranslate] = useState<TranslateState | null>(null)
  const closeSelBar = useCallback(() => { setSelInfo(null); setTranslate(null) }, [])

  const evalSelection = useCallback(() => {
    const sel = window.getSelection()
    const root = rootRef.current
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !root) {
      setSelInfo((prev) => (prev ? null : prev))
      return
    }
    const text = String(sel)
    if (!text.trim()) { setSelInfo((prev) => (prev ? null : prev)); return }
    const range = sel.getRangeAt(0)
    const anchorEl = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
    if (!anchorEl || !root.contains(anchorEl)) return
    const r0 = range.getBoundingClientRect()
    if (!r0 || (r0.width === 0 && r0.height === 0)) return
    // 页码：竖滚从页槽 data-pg 解析；翻页模式回退当前页
    const pgEl = anchorEl.closest('[data-pg]')
    let page = pgEl ? Number((pgEl as HTMLElement).dataset.pg) : 0
    if (!page || Number.isNaN(page)) page = viewMode === 'duo' ? duoStartRef.current : pageNumRef.current
    setSelInfo({ rect: { left: r0.left, top: r0.top, width: r0.width, height: r0.height }, text, page })
  }, [viewMode])

  useEffect(() => {
    const onMouseUp = () => { window.setTimeout(evalSelection, 0) }
    const onSelChange = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) closeSelBar()
    }
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('selectionchange', onSelChange)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('selectionchange', onSelChange)
    }
  }, [evalSelection, closeSelBar])

  const doCopySel = useCallback(() => {
    if (!selInfo) return
    void copyText(selInfo.text).then((ok) => {
      showToast(ok ? { type: 'success', message: '已复制选中文本' } : { type: 'warning', message: '复制失败' })
    })
  }, [selInfo])

  const doTranslateSel = useCallback(async () => {
    if (!selInfo || translate?.loading) return
    const text = selInfo.text.trim().slice(0, 4000)
    setTranslate({ loading: true, text: '' })
    try {
      // translationRepo 缓存通道（方案 §1.5）：命中缓存零 token，结果纯展示
      const r = await translateInvoke({ text })
      if (r.ok) setTranslate({ loading: false, text: r.markdown, cached: r.cached })
      else setTranslate({ loading: false, text: '', error: r.error })
    } catch (e) {
      setTranslate({ loading: false, text: '', error: String((e as Error)?.message || e) })
    }
  }, [selInfo, translate])

  const doAsk = useCallback((intent: 'explain' | 'quiz') => {
    if (!selInfo) return
    const excerpt = selInfo.text.trim().slice(0, 1200)
    const head = `我正在阅读 PDF《${name}》第 ${selInfo.page} 页，选了下面这段内容：\n\n「${excerpt}」\n\n`
    const question = intent === 'explain'
      ? head + '请讲解这段内容：先讲清涉及的概念/公式，再给一个可操作的例子或推演步骤。'
      : head + '请根据这段内容出一组练习题帮助我巩固（用 ```quiz 围栏输出，题号从 1 开始连续编号），覆盖它的核心考点。'
    // state+props 范式（ISS-2026-09-04-07）：事件只送意图，payload 由 App 落 state 后经 props 下发
    window.dispatchEvent(new CustomEvent('kb-ai-teaching-ask', {
      detail: { question, source: { type: 'pdf', relPath, page: selInfo.page, excerpt } },
    }))
    closeSelBar()
    showToast({ type: 'info', message: '已跳转 AI 教学并带上选段上下文' })
  }, [closeSelBar, name, relPath, selInfo])

  /** 大纲点击 → 跳页 */
  const jumpOutline = useCallback(async (node: OutlineNode) => {
    const pdf = pdfRef.current
    if (!pdf || node.dest === undefined) return
    const p = await destToPageNum(pdf, node.dest)
    if (p >= 1 && p <= pdf.numPages) {
      await goPage(p)
      if (viewMode !== 'scroll') containerRef.current?.scrollTo({ top: 0 })
    }
  }, [goPage, viewMode])

  /** 全文搜索：逐页取文本（v1 保留） */
  const searchText = useCallback(async (q: string) => {
    const pdf = pdfRef.current
    if (!pdf || !q.trim()) { setSearchHits([]); return }
    const needle = q.trim().toLowerCase()
    setSearching(true)
    try {
      const hits: Array<{ page: number; preview: string }> = []
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n)
        const tc = await page.getTextContent()
        const text = tc.items.map((it) => ('str' in it ? it.str : '')).join(' ')
        const idx = text.toLowerCase().indexOf(needle)
        if (idx >= 0) {
          const s = Math.max(0, idx - 20)
          hits.push({ page: n, preview: text.slice(s, idx + needle.length + 40).replace(/\s+/g, ' ') })
        }
      }
      setSearchHits(hits)
      if (hits.length) await goPage(hits[0].page)
    } finally {
      setSearching(false)
    }
  }, [goPage])

  /** 沉浸：进入/退出重置悬浮条显示 */
  const toggleImmersive = useCallback(() => {
    setImmersive((v) => {
      const next = !v
      if (next) { setSideTab(null); setBarHidden(false) }
      return next
    })
  }, [])

  /** 沉浸模式 30s 无操作 → 悬浮条淡出；动鼠标唤出 */
  const barTimer = useRef<number>(0)
  useEffect(() => {
    if (!immersive) return
    const wake = () => { setBarHidden(false); window.clearTimeout(barTimer.current); barTimer.current = window.setTimeout(() => setBarHidden(true), 30000) }
    wake()
    window.addEventListener('mousemove', wake)
    window.addEventListener('keydown', wake)
    return () => { window.clearTimeout(barTimer.current); window.removeEventListener('mousemove', wake); window.removeEventListener('keydown', wake) }
  }, [immersive])

  /** 翻页步长：duo 一次 2 页（跨页对），其余 1 页 */
  const stepPage = useCallback(async (dir: 1 | -1) => {
    const pdf = pdfRef.current
    if (!pdf) return
    if (viewMode === 'duo') {
      const next = Math.max(1, Math.min(duoStartRef.current + dir * 2, pdf.numPages))
      await renderDuo(next)
      return
    }
    await goPage(pageNumRef.current + dir)
  }, [goPage, renderDuo, viewMode])

  // 快捷键：PageUp/Down、←→ 翻页、Ctrl+F 搜索、Esc 逐级退出（INPUT 焦点守卫）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (e.key === 'PageDown' || e.key === 'ArrowRight' || (e.key === ' ' && !immersive)) { e.preventDefault(); void stepPage(1) }
      else if (e.key === 'PageUp' || e.key === 'ArrowLeft') { e.preventDefault(); void stepPage(-1) }
      else if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setSideTab('search')
        const input = document.getElementById('kb-pdf-search-input') as HTMLInputElement | null
        input?.focus()
        input?.select()
      } else if (e.key === 'Escape') {
        if (document.getElementById('kb-pdf-search-input') === document.activeElement) {
          ;(document.activeElement as HTMLInputElement).blur()
        } else if (selInfo) {
          closeSelBar()
        } else if (sideTab !== null) {
          setSideTab(null)
        } else if (immersive) {
          toggleImmersive()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeSelBar, immersive, selInfo, sideTab, stepPage, toggleImmersive])

  // 渲染时高亮本页搜索命中（single/duo：文本层 refs）
  useEffect(() => {
    if (!searchQuery.trim() || loading) return
    const hosts = [singleTextRef.current, duoTextARef.current, duoTextBRef.current]
    const needle = searchQuery.trim().toLowerCase()
    let matched = false
    for (const host of hosts) {
      if (!host) continue
      const spans = Array.from(host.querySelectorAll('span')) as HTMLElement[]
      for (const span of spans) {
        if (span.textContent?.toLowerCase().includes(needle)) { span.classList.add('kb-pdf-match'); matched = true }
      }
    }
    if (matched) setBarHidden(false)
  }, [pageNum, loading, searchQuery, viewMode])

  // ===== 渲染 =====
  const isPaging = viewMode !== 'scroll'

  const toolbar = (
    <div className={`flex shrink-0 items-center gap-1.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 text-[12px] text-[var(--text-secondary)] ${immersive ? 'hidden' : ''}`}>
      <FileText size={13} className="text-[var(--text-tertiary)]" />
      <span className="max-w-[220px] truncate text-[var(--text-primary)]">{name}</span>
      <span className="text-[var(--text-tertiary)]">{numPages} 页</span>
      <div className="mx-1 h-4 w-px bg-[var(--border-color)]" />
      {/* 三模式切换（方案 §5.2：竖滚默认） */}
      <div className="flex items-center overflow-hidden rounded border border-[var(--border-color)]">
        <button onClick={() => void switchMode('scroll')} title="竖滚模式"
          className={`flex items-center gap-1 px-1.5 py-0.5 ${viewMode === 'scroll' ? 'bg-[var(--bg-hover)] text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)]'}`}>
          <GalleryVertical size={12} />竖滚
        </button>
        <button onClick={() => void switchMode('single')} title="单页模式"
          className={`flex items-center gap-1 border-x border-[var(--border-color)] px-1.5 py-0.5 ${viewMode === 'single' ? 'bg-[var(--bg-hover)] text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)]'}`}>
          <Square size={12} />单页
        </button>
        <button onClick={() => void switchMode('duo')} title="双页模式（需宽 ≥1240px）"
          className={`flex items-center gap-1 px-1.5 py-0.5 ${viewMode === 'duo' ? 'bg-[var(--bg-hover)] text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)]'}`}>
          <Columns2 size={12} />双页
        </button>
      </div>
      <div className="mx-1 h-4 w-px bg-[var(--border-color)]" />
      <button onClick={() => void stepPage(-1)} disabled={pageNum <= 1} title="上一页 (PageUp / ←)"
        className="rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40">
        <ChevronLeft size={15} />
      </button>
      <input
        value={pageNum}
        onChange={(e) => { const n = parseInt(e.target.value, 10); if (!Number.isNaN(n)) void goPage(n) }}
        className="w-11 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] px-1 py-0.5 text-center text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
      />
      <span className="text-[var(--text-tertiary)]">/ {numPages}</span>
      <button onClick={() => void stepPage(1)} disabled={viewMode !== 'duo' && pageNum >= numPages} title="下一页 (PageDown / →)"
        className="rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40">
        <ChevronRight size={15} />
      </button>
      <div className="mx-1 h-4 w-px bg-[var(--border-color)]" />
      <button onClick={() => { setFitWidth(true); zoomRef.current = 1; setZoom(1) }} title="适合宽度"
        className={`rounded p-0.5 ${fitWidth ? 'text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
        <MaximizeIcon size={14} />
      </button>
      <button onClick={() => void zoomBy(1.2)} title="放大" className="rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><ZoomIn size={14} /></button>
      <button onClick={() => void zoomBy(1 / 1.2)} title="缩小" className="rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><ZoomOut size={14} /></button>
      <div className="mx-1 h-4 w-px bg-[var(--border-color)]" />
      <button onClick={() => setSideTab((v) => (v === 'outline' ? null : 'outline'))} title="大纲"
        className={`flex items-center gap-1 rounded p-0.5 ${sideTab === 'outline' ? 'text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
        <ListTree size={14} />大纲
      </button>
      <button onClick={() => setSideTab((v) => (v === 'search' ? null : 'search'))} title="搜索 (Ctrl+F)"
        className={`flex items-center gap-1 rounded p-0.5 ${sideTab === 'search' ? 'text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
        <Search size={14} />搜索
      </button>
      <button onClick={() => setSideTab((v) => (v === 'thumbs' ? null : 'thumbs'))} title="缩略图"
        className={`flex items-center gap-1 rounded p-0.5 ${sideTab === 'thumbs' ? 'text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
        <LayoutGrid size={14} />缩略图
      </button>
      <button onClick={toggleBookmark} title={bookmarks.some((b) => b.page === currentPageForBookmark()) ? '移除本页书签' : '收藏本页书签'}
        className={`flex items-center gap-1 rounded p-0.5 ${bookmarks.some((b) => b.page === currentPageForBookmark()) ? 'text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
        {bookmarks.some((b) => b.page === currentPageForBookmark()) ? <Bookmark size={14} /> : <BookmarkPlus size={14} />}书签
      </button>
      <button onClick={() => setSideTab((v) => (v === 'bookmarks' ? null : 'bookmarks'))} title="书签列表"
        className={`flex items-center gap-1 rounded p-0.5 ${sideTab === 'bookmarks' ? 'text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
        <BookMarked size={14} />
      </button>
      <button onClick={toggleEyeCare} title="护眼模式（书级记忆）"
        className={`flex items-center gap-1 rounded p-0.5 ${eyeCare ? 'text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
        {eyeCare ? <Eye size={14} /> : <EyeOff size={14} />}护眼
      </button>
      <button onClick={toggleImmersive} title="沉浸阅读（隐藏全部 UI，Esc 退出）"
        className={`ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 ${immersive ? 'text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
        <BookOpen size={14} />沉浸
      </button>
      <span className="text-[11px] text-[var(--text-tertiary)]">{Math.round(zoom * 100)}%</span>
    </div>
  )

  const sidePanel = (
    <div className={`kb-view-fade flex w-64 shrink-0 flex-col border-r border-[var(--border-color)] bg-[var(--bg-secondary)] ${immersive || sideTab === null ? 'hidden' : ''}`}>
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--text-primary)]">
        {sideTab === 'outline' ? <><ListTree size={13} />大纲</>
          : sideTab === 'search' ? <><Search size={13} />搜索</>
          : sideTab === 'thumbs' ? <><LayoutGrid size={13} />缩略图</>
          : <><BookMarked size={13} />书签</>}
        <button onClick={() => setSideTab(null)} className="ml-auto rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><X size={12} /></button>
      </div>
      {sideTab === 'thumbs' && (
        <PdfThumbGrid pdf={pdfDoc} numPages={numPages} current={pageNum} duo={viewMode === 'duo'} onJump={(n) => void goPage(n)} />
      )}
      {sideTab === 'bookmarks' && (
        <PdfBookmarkList bookmarks={bookmarks} current={pageNum} duo={viewMode === 'duo'} onJump={(n) => void goPage(n)} onNote={setBookmarkNote} />
      )}
      {sideTab === 'outline' && (
        <div className="kb-view-in min-h-0 flex-1 overflow-auto py-1">
          {outline.length === 0 && <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]">此 PDF 没有书签</div>}
          <OutlineTree nodes={outline} onJump={(n) => void jumpOutline(n)} depth={0} />
        </div>
      )}
      {sideTab === 'search' && (
        <div className="kb-view-in flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1.5 p-2">
            <input
              id="kb-pdf-search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void searchText(searchQuery) }}
              placeholder="搜索全文…"
              className="min-w-0 flex-1 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
            <button onClick={() => void searchText(searchQuery)} disabled={searching || !searchQuery.trim()}
              className="rounded border border-[var(--border-color)] px-2 py-1 text-[12px] hover:bg-[var(--bg-hover)] disabled:opacity-40">
              {searching ? '…' : '搜索'}
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
            {searchHits.length === 0 && !searching && searchQuery && (
              <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]">无匹配</div>
            )}
            {searchHits.map((h, i) => (
              <button key={`${h.page}-${i}`} onClick={() => void goPage(h.page)}
                className="block w-full rounded-md px-2.5 py-1.5 text-left hover:bg-[var(--bg-hover)]">
                <div className="text-[11px] text-[var(--accent)]">第 {h.page} 页</div>
                <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-[var(--text-secondary)]">{h.preview}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )

  const floatingBar = (
    <div className={`pointer-events-none fixed inset-x-0 bottom-3 z-50 flex justify-center transition-opacity duration-500 ${immersive && !barHidden ? 'opacity-100' : 'opacity-0'}`}>
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)]/95 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] shadow-lg backdrop-blur">
        <span className="text-[var(--text-primary)]">{viewMode === 'duo' ? `${pageNum}-${Math.min(pageNum + 1, numPages)}` : pageNum} / {numPages} 页</span>
        <button onClick={() => void stepPage(-1)} className="rounded p-0.5 hover:bg-[var(--bg-hover)]"><ChevronLeft size={14} /></button>
        <button onClick={() => void stepPage(1)} className="rounded p-0.5 hover:bg-[var(--bg-hover)]"><ChevronRight size={14} /></button>
        <div className="mx-1 h-4 w-px bg-[var(--border-color)]" />
        <button onClick={() => void zoomBy(1.2)} className="rounded p-0.5 hover:bg-[var(--bg-hover)]"><ZoomIn size={14} /></button>
        <button onClick={() => void zoomBy(1 / 1.2)} className="rounded p-0.5 hover:bg-[var(--bg-hover)]"><ZoomOut size={14} /></button>
        <button onClick={toggleImmersive} title="退出沉浸 (Esc)" className="rounded px-1.5 py-0.5 text-[var(--accent)] hover:bg-[var(--bg-hover)]">退出</button>
      </div>
    </div>
  )

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-[var(--text-secondary)]">
        <AlertTriangle size={28} className="text-[var(--text-warning)]" />
        <div className="max-w-md text-center text-[13px] leading-relaxed">PDF 打开失败：{error}</div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-[var(--text-secondary)]">
        <Loader2 size={26} className="animate-spin text-[var(--accent)]" />
        <span className="text-[12.5px]">正在加载 {name}…（懒加载模式）</span>
      </div>
    )
  }

  // 竖滚 slots
  const slots = useMemo(() => {
    if (viewMode !== 'scroll') return null
    const out: React.ReactNode[] = []
    for (let n = 1; n <= numPages; n++) {
      out.push(
        <div
          key={n}
          data-pg={n}
          ref={(el) => setSlotRef(n, el)}
          className="relative w-full overflow-hidden bg-[var(--bg-primary)] shadow-sm"
          style={{ height: slotH }}
        />,
      )
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, numPages, slotH])

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 flex-col bg-[var(--bg-tertiary)]">
      {toolbar}
      <div className="flex min-h-0 flex-1 items-stretch" style={eyeCare ? { filter: 'sepia(0.32) brightness(0.97) saturate(0.92)' } : undefined}>
        {sidePanel}
        {viewMode === 'scroll' ? (
          <div ref={scrollHostRef} onScroll={onScrollHost} className="min-h-0 flex-1 overflow-auto">
            <div className={`mx-auto flex flex-col items-center gap-3 ${immersive ? 'py-0' : 'py-4'}`} style={{ width: availW }}>
              {slots}
            </div>
          </div>
        ) : (
          <div ref={containerRef} className="relative min-h-0 flex-1 overflow-auto">
            <div className={`flex min-h-full w-full items-start justify-center ${immersive ? 'p-0' : 'p-6'}`}>
              {viewMode === 'single' ? (
                <div ref={pageHostRef} className="relative inline-block">
                  <canvas ref={singleCanvasRef} className="block bg-[var(--bg-primary)] shadow-sm" />
                  <div ref={singleTextRef} className="kb-pdf-text-layer" style={{ top: 0, left: 0 }} />
                </div>
              ) : (
                <div className="flex items-start justify-center gap-4">
                  <div ref={pageHostRef} className="relative inline-block">
                    <canvas ref={duoCanvasARef} className="block bg-[var(--bg-primary)] shadow-sm" />
                    <div ref={duoTextARef} className="kb-pdf-text-layer" style={{ top: 0, left: 0 }} />
                  </div>
                  <div className="relative inline-block">
                    <canvas ref={duoCanvasBRef} className="block bg-[var(--bg-primary)] shadow-sm" />
                    <div ref={duoTextBRef} className="kb-pdf-text-layer" style={{ top: 0, left: 0 }} />
                  </div>
                </div>
              )}
            </div>
            {/* 页边悬浮箭头（翻页模式；沉浸时隐藏） */}
            {!immersive && (
              <>
                <button onClick={() => void stepPage(-1)} disabled={pageNum <= 1} title="上一页"
                  className="kb-pop absolute left-2 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)]/90 text-[var(--text-secondary)] opacity-60 shadow transition-opacity hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] hover:opacity-100 disabled:opacity-0">
                  <ChevronLeft size={17} />
                </button>
                <button onClick={() => void stepPage(1)} disabled={viewMode === 'single' && pageNum >= numPages} title="下一页"
                  className="kb-pop absolute right-2 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)]/90 text-[var(--text-secondary)] opacity-60 shadow transition-opacity hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] hover:opacity-100 disabled:opacity-0">
                  <ChevronRight size={17} />
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {immersive && <button onClick={toggleImmersive} title="退出沉浸 (Esc)"
        className="fixed top-3 right-3 z-50 flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)]/90 text-[var(--text-secondary)] shadow hover:text-[var(--text-primary)]"><X size={14} /></button>}
      {floatingBar}
      <TextSelectionBar rect={selInfo?.rect ?? null} translate={translate} onCopy={doCopySel} onTranslate={() => void doTranslateSel()} onAsk={doAsk} onClose={closeSelBar} />
    </div>
  )
}

/** 大纲递归树 */
function OutlineTree({ nodes, onJump, depth }: { nodes: OutlineNode[]; onJump: (n: OutlineNode) => void; depth: number }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  return (
    <div className={depth > 0 ? 'ml-3 border-l border-[var(--border-color)]' : ''}>
      {nodes.map((n, i) => {
        const key = `${depth}-${i}-${n.title}`
        const isCollapsed = collapsed.has(key)
        const hasKids = n.items.length > 0
        return (
          <div key={key}>
            <div className="group flex items-center gap-0.5 pr-1 hover:bg-[var(--bg-hover)]">
              {hasKids ? (
                <button onClick={() => setCollapsed((s) => { const n2 = new Set(s); if (n2.has(key)) n2.delete(key); else n2.add(key); return n2 })}
                  className="w-4 shrink-0 pl-0.5 text-center text-[10px] text-[var(--text-tertiary)]">{isCollapsed ? '▸' : '▾'}</button>
              ) : <span className="w-4 shrink-0" />}
              <button onClick={() => onJump(n)}
                className="min-w-0 flex-1 truncate py-0.5 pr-2 text-left text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                style={{ paddingLeft: depth > 0 ? 0 : 2 }}
                title={n.title}>
                {n.title}
              </button>
            </div>
            {hasKids && !isCollapsed && <OutlineTree nodes={n.items} onJump={onJump} depth={depth + 1} />}
          </div>
        )
      })}
    </div>
  )
}
