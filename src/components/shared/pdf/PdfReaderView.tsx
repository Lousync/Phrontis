import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft, ChevronRight, ArrowLeft, ZoomIn, ZoomOut, Maximize as MaximizeIcon, MoveHorizontal,
  FileText, AlertTriangle, Loader2, Search, BookOpen, X,
  GalleryVertical, Square, Columns2, Bookmark, BookmarkPlus, Eye, EyeOff, ListTree,
} from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import { renderTextLayer } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url'
import { openExternal, copyText, excerptCreate, excerptList, pdfReaderGet, pdfReaderPatch, translateInvoke, workspaceReadRange } from '../../../lib/ipc'
import { useDataChanged } from '../../../lib/dataChanged'
import { showToast } from '../../../lib/toast'
import { normalizeSpreadStart, resolveDegrade, spreadPages, estimatePageHeight, DUO_MIN_WIDTH, type PdfLayoutMode } from '../../../lib/pdfLayout'
import { destToPageNum } from './PdfOutlineTree'
import { detectScanMode } from '../../../../electron/lib/kbStore/scanDetect'
import { TextSelectionBar, type SelectionRect, type TranslateState } from './TextSelectionBar'
import type { BookScanMode, ExcerptItem, ExcerptRect, PdfBookPatch, PdfBookState } from '../../../types'

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

/** outline dest → 页码逻辑已迁 PdfOutlineTree.tsx（批次 6），此处 import 复用 */

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

interface Props {
  rootId: string
  relPath: string
  name: string
  /** 工具栏最左的返回入口（书架阅读态用）：把「返回书架」并进阅读器工具栏，
      省掉模块自己那行标题 —— 否则书名会在模块顶行与阅读器工具栏各显示一次，白占一行阅读高度。
      不传则不渲染该按钮（编辑器打开 PDF 的路径即如此）。 */
  backLabel?: string
  onBack?: () => void
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
export function PdfReaderView({ rootId, relPath, name, backLabel, onBack }: Props) {
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null)

  // ===== 文档态 =====
  const [numPages, setNumPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /** 首页基准尺寸（占位估算用） */
  const firstPageRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 })

  // ===== 视图态 =====
  const [viewMode, setViewMode] = useState<PdfLayoutMode>('scroll')
  const [pageNum, setPageNum] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [fitWidth, setFitWidth] = useState(true)
  /** 整页适配开关（2026-09-18 书架反馈）。**默认 false = 适宽**：页面宽铺满容器，字最大最清晰，
      纵向滚动看完整页 —— 「整页可见」是可选口径、不强制，因为强制缩小会让字变小，
      而且窄容器下宽度是瓶颈时页高必然填不满容器高（大片底部留白，2026-09-18 实机反馈）。
      打开后缩放取 `min(容器可用宽/页宽, 容器可用高/页高)`（工具栏「适合页面」按钮切）。
      仅在 fitWidth（自动适配）为真时生效；手动缩放/滚轮缩放会把 fitWidth 置 false 走自定义 zoom。 */
  const [fitPage, setFitPage] = useState(false)
  const pageNumRef = useRef(1)
  const zoomRef = useRef(1)
  /** goPage 经 ref 供 attachLinks 热区调用（避免渲染闭包环） */
  const goPageRef = useRef<((n: number) => void) | null>(null)
  /** 容器可用宽/高（去内边距；duo 再对半）——高是整页适配的新增依据 */
  const [availW, setAvailW] = useState(800)
  const [availH, setAvailH] = useState(600)
  const containerRef = useRef<HTMLDivElement>(null)
  /** 竖滚模式的滚动宿主（测量亦用；声明提前，供尺寸测量 effect 引用） */
  const scrollHostRef = useRef<HTMLDivElement>(null)

  // ===== 单页/双页渲染 refs =====
  const singleCanvasRef = useRef<HTMLCanvasElement>(null)
  const singleTextRef = useRef<HTMLDivElement>(null)
  const duoCanvasARef = useRef<HTMLCanvasElement>(null)
  const duoCanvasBRef = useRef<HTMLCanvasElement>(null)
  const duoTextARef = useRef<HTMLDivElement>(null)
  const duoTextBRef = useRef<HTMLDivElement>(null)
  const duoStartRef = useRef(1)
  const pageHostRef = useRef<HTMLDivElement>(null)

  // ===== 侧栏 / 搜索 / 沉浸（v1 保留；目录/缩略图/书签三件套已迁左栏 bookshelf 模块态，§0.6）=====
  const [sideTab, setSideTab] = useState<'search' | null>(null)
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

  // ===== 容器可用宽/高测量（防呆降级 + 适宽 / 整页适配的基准）=====
  useEffect(() => {
    const el = viewMode === 'scroll' ? scrollHostRef.current : containerRef.current
    if (!el) return
    const measure = () => {
      const pad = immersive ? 0 : 48
      setAvailW(Math.max(120, el.clientWidth - pad))
      setAvailH(Math.max(120, el.clientHeight - pad))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
    // viewMode 切换会换挂容器 ref（竖滚用 scrollHostRef、翻页模式用 containerRef）——观察器须随模式重挂；
    // 依赖里带 loading：文档就绪前容器还没挂上，早退后再不会重测（availH 会一直停在初值）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [immersive, viewMode, loading])

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
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null)
  const renderPageTo = useCallback(async (
    num: number,
    canvas: HTMLCanvasElement,
    textHost: HTMLDivElement | null,
    scale: number,
    opts?: { withText?: boolean; track?: boolean },
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
    // 翻页渲染可被打断（track）：同一 canvas 连续两次 render 会抛 "Cannot use the same canvas"，
    // 先取消上一帧再开（v1 同款守卫；竞态错误信息不含 cancel → 会误进 error 全局态把页面打成「打开失败」）
    if (opts?.track && renderTaskRef.current) { try { renderTaskRef.current.cancel() } catch { /* 忽略 */ } }
    const task = page.render({ canvasContext: ctx, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined })
    if (opts?.track) renderTaskRef.current = task
    await task.promise
    if (textHost) {
      // pdf.js 要求容器带 --scale-factor（=viewport.scale），否则每次 renderTextLayer 都刷一条 console error
      textHost.style.setProperty('--scale-factor', String(viewport.scale))
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

  // ===== 自动适配的缩放口径（整页适配 / 适宽）=====
  /** fitPage=true → `min(容器宽/页宽, 容器高/页高)` = 整页可见；false → 适宽（页面宽铺满容器）。
      duo 并排时传入"单页可用宽"（availWOverride）参与比较，高仍用容器高。 */
  const fitScaleFor = useCallback((w: number, h: number, availWOverride?: number) => {
    const aw = availWOverride ?? availW
    return fitPage ? Math.min(aw / w, availH / h) : aw / w
  }, [availW, availH, fitPage])

  /** 竖滚占位高度：按**实际渲染页宽**估。整页适配下页宽可能小于容器宽（两侧留白），
      若仍用容器宽估高，占位会偏高 → 滚动条长度跳变（渲染完成后虽会按真实高度校正，首次进入最好一次到位）。 */
  const estimateSlotH = useCallback((w: number, h: number) => {
    const renderW = fitWidth && fitPage && w > 0 && h > 0
      ? Math.min(availW, availH * (w / h))
      : Math.max(120, availW)
    return estimatePageHeight(w, h, renderW)
  }, [availW, availH, fitWidth, fitPage])

  // ===== 单页渲染 =====
  const renderSingle = useCallback(async (num: number) => {
    const pdf = pdfRef.current
    const canvas = singleCanvasRef.current
    const textHost = singleTextRef.current
    if (!pdf || !canvas) return
    try {
      const page = await pdf.getPage(num)
      const base = page.getViewport({ scale: 1 })
      const scale = fitWidth ? Math.max(0.2, fitScaleFor(base.width, base.height)) : zoomRef.current
      await renderPageTo(num, canvas, textHost, scale, { track: true })
      setZoom(scale)
    } catch (e) {
      const msg = String((e as Error)?.message || e)
      if (!msg.includes('cancel')) setError(msg)
    }
  }, [fitWidth, fitScaleFor, renderPageTo])

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
      // 并排时"单页可用宽"要扣掉中间 16px 间隙再对半；高仍按容器高比较 —— 整页适配要两轴都装得下
      const slotW = (availW - (pages.length === 2 ? 16 : 0)) / slots
      const scale = fitWidth ? Math.max(0.2, fitScaleFor(baseA.width, baseA.height, slotW)) : zoomRef.current
      const canvasA = duoCanvasARef.current
      const textA = duoTextARef.current
      if (canvasA) await renderPageTo(pages[0], canvasA, textA, scale, { track: true })
      const canvasB = duoCanvasBRef.current
      const textB = duoTextBRef.current
      if (pages.length === 2) {
        if (canvasB) {
          canvasB.style.display = 'block'
          await renderPageTo(pages[1], canvasB, textB, scale)
        }
      } else if (canvasB) {
        // 末页单收：隐藏 B 帧（残留上一跨页的旧页会误导页码）
        canvasB.style.display = 'none'
        if (textB) textB.innerHTML = ''
      }
      setZoom(scale)
    } catch (e) {
      const msg = String((e as Error)?.message || e)
      if (!msg.includes('cancel')) setError(msg)
    }
  }, [availW, fitWidth, fitScaleFor, renderPageTo])

  // ===== 竖滚渲染池 =====
  const slotElsRef = useRef(new Map<number, HTMLDivElement>())
  /** 已渲染页集合（canvas 已插入） */
  const poolRenderedRef = useRef(new Set<number>())
  const poolInflightRef = useRef(new Set<number>())
  /** 渲染池目标（近视页 ±2） */
  const poolWantedRef = useRef(new Set<number>())
  /** 文本层只挂可视页（小半径集合） */
  const tightVisibleRef = useRef(new Set<number>())
  /** 待补文本页：渲染 inflight 期间被观察器标记「要文本」的页——首渲染落盘后立即带文本重渲（堵竞态） */
  const forceTextRef = useRef(new Set<number>())
  // 探针取证口（只读快照，无副作用）：CDP 探针读渲染池状态定位文本层缺失环节
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__kbPdfProbe = {
      get state() {
        return {
          tight: [...tightVisibleRef.current], rendered: [...poolRenderedRef.current],
          inflight: [...poolInflightRef.current], wanted: [...poolWantedRef.current],
          slots: slotElsRef.current.size,
        }
      },
    }
  }, [])
  const [slotH, setSlotH] = useState(600)

  const setSlotRef = useCallback((n: number, el: HTMLDivElement | null) => {
    if (el) slotElsRef.current.set(n, el)
    else slotElsRef.current.delete(n)
  }, [])

  const poolPumpRef = useRef<(() => void) | null>(null)
  const renderIntoSlot = useCallback(async (n: number, forceText = false) => {
    const pdf = pdfRef.current
    const slot = slotElsRef.current.get(n)
    if (!pdf || !slot) return
    if (poolInflightRef.current.has(n)) {
      // 渲染中也要登记「要文本」——首渲染落盘后由下方补课重渲（否则竞态窗口永久丢文本层）
      if (forceText) forceTextRef.current.add(n)
      return
    }
    if (poolRenderedRef.current.has(n)) {
      // forceText = 可见性观察器发现「画布已渲染但文本层缺失」的补课路径（首标竞态：渲染池先跑、
      // tight 观察器后标，withText 曾被跳过且永不补——正文不可选的根因之二）
      if (!forceText && !forceTextRef.current.has(n)) return
      poolRenderedRef.current.delete(n)
    }
    poolInflightRef.current.add(n)
    try {
      const page = await pdf.getPage(n)
      const base = page.getViewport({ scale: 1 })
      const scale = fitWidth ? Math.max(0.2, fitScaleFor(base.width, base.height)) : zoomRef.current
      // 就绪前 slot 可能已被回收（翻滚离开）
      if (!slotElsRef.current.get(n) || !poolWantedRef.current.has(n)) return
      slot.innerHTML = ''
      const canvas = document.createElement('canvas')
      canvas.className = 'block bg-[var(--bg-primary)] shadow-[0_2px_8px_rgba(0,0,0,0.18)]'
      slot.appendChild(canvas)
      const frame = document.createElement('div')
      frame.className = 'kb-pdf-text-layer absolute inset-0'
      // ★ 文本层必须挂进 DOM（2026-09-20 取证：frames=0——frame 只创建未挂载，renderTextLayer
      //   往游离节点渲染不报错，画布正常但正文永远不可选：划选/翻译/摘录全灭）
      slot.appendChild(frame)
      const withText = forceText || forceTextRef.current.has(n) || tightVisibleRef.current.has(n)
      await renderPageTo(n, canvas, frame, scale, { withText })
      // 首渲染无文本、但随后被标记「要文本」→ 原地再渲一次（inflight 已释放，本轮必带文本）
      if (!withText && (forceTextRef.current.has(n) || tightVisibleRef.current.has(n))) {
        poolRenderedRef.current.delete(n)
        void renderIntoSlot(n)
        return
      }
      forceTextRef.current.delete(n)
      // 渲染完按真实高度校正占位（估高只对首页可信）
      slot.style.height = `${canvas.style.height}`
      poolRenderedRef.current.add(n)
    } catch { /* 单页失败不进 error 全局态，滚动重试 */ }
    finally {
      poolInflightRef.current.delete(n)
      poolPumpRef.current?.()
    }
  }, [fitWidth, fitScaleFor, renderPageTo])

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
        if (en.isIntersecting) {
          tightVisibleRef.current.add(n)
          // 补课（见 renderIntoSlot forceText/forceTextRef）：画布已在但文本层缺失 → 带文本重渲；
          // 若还在渲染 inflight，则登记待补，首渲染落盘后自动补
          const slot = slotElsRef.current.get(n)
          if (slot?.querySelector('canvas') && !slot.querySelector('.kb-pdf-text-layer span')) {
            void renderIntoSlot(n, true)
          } else if (slot && !slot.querySelector('canvas') && poolInflightRef.current.has(n)) {
            forceTextRef.current.add(n)
          }
        }
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
  }, [viewMode, loading, numPages, syncPool, renderIntoSlot])

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
  // 渲染统一交给 availKey effect（viewMode/availW/zoom 变化时执行）——
  // 此处若再 rAF 直渲，会和 effect 的渲染并发打同一个 canvas（"Cannot use the same canvas" → 误进「打开失败」态）。
  const switchMode = useCallback((m: PdfLayoutMode) => {
    if (m === viewMode) return
    if (m === 'duo' && availW < DUO_MIN_WIDTH) {
      showToast({ type: 'warning', message: `容器宽度不足 ${DUO_MIN_WIDTH}px，已自动切回单页` })
      m = 'single'
    }
    if (m === 'scroll') {
      setViewMode('scroll')
      scheduleProgress({ mode: 'scroll' }, true)
      // availKey effect 重建页槽后滚到当前页
      requestAnimationFrame(() => scrollGoPage(pageNumRef.current))
      return
    }
    if (m === 'duo') {
      // 先落跨页起始（effect 渲染时读 duoStartRef）
      duoStartRef.current = normalizeSpreadStart(Math.min(Math.max(1, pageNumRef.current), pdfRef.current?.numPages ?? 1))
    } else if (viewMode === 'duo') {
      pageNumRef.current = duoStartRef.current
      setPageNum(pageNumRef.current)
    }
    setViewMode(m)
    scheduleProgress({ mode: m }, true)
  }, [availW, scheduleProgress, scrollGoPage, viewMode])

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
          if (r.state.scan) setScanMode(r.state.scan)
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
      // 首读登记总页数（书架侧栏进度条分母）；文件更换页数变化时顺手校正
      if (restored?.totalPages !== numPages) {
        bookUpdatedRef.current = restored?.updatedAt
        void doPatch({ totalPages: numPages })
      }
      const page = restored?.lastPage && restored.lastPage >= 1 ? Math.min(restored.lastPage, numPages) : 1
      pageNumRef.current = page
      setPageNum(page)
      const modeNow = restored?.mode && restored.mode !== 'scroll' && resolveDegrade(availW, restored.mode) === restored.mode ? restored.mode : 'scroll'
      if (modeNow === 'scroll') {
        const { w, h } = firstPageRef.current
        setSlotH(estimateSlotH(w, h))
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

  // ===== 扫描版探测（轻量方案）：均匀抽样 ≤6 页 getTextContent 字符计数 → full/partial/no。
  // 结论落盘一次（pdfReader.scan，书架角标复用）；'full' 不落盘（缺省即 full）。
  const [scanMode, setScanMode] = useState<BookScanMode | null>(null)
  useEffect(() => {
    if (loading || numPages === 0) return
    if (scanMode) return // 已有结论（持久化或本次已测）
    let alive = true
    void (async () => {
      const pdf = pdfRef.current
      if (!pdf) return
      const k = Math.min(6, numPages)
      const chars: number[] = []
      for (let i = 0; i < k; i++) {
        const n = k === 1 ? 1 : 1 + Math.round(i * (numPages - 1) / (k - 1))
        try {
          const p = await pdf.getPage(Math.min(numPages, Math.max(1, n)))
          const tc = await p.getTextContent()
          chars.push(tc.items.reduce((s, it) => s + (typeof (it as { str?: unknown }).str === 'string' ? ((it as { str: string }).str).trim().length : 0), 0))
        } catch { chars.push(0) }
      }
      if (!alive) return
      const mode = detectScanMode(chars)
      setScanMode(mode)
      if (mode !== 'full') {
        try { await doPatch({ scan: mode }) } catch { /* 落盘失败不影响阅读 */ }
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, numPages, scanMode])

  // 扫描版提示条（无文本层的页划选/摘录不可用——管理预期，见 bookshelf-reader-upgrade-design §5）
  const effectiveScan: BookScanMode = scanMode ?? 'full'

  // 适配口径 / 容器尺寸变化 → 重绘当前视图（竖滚：重估占位 + 清池重渲）
  // 键里必须含 fitPage 与 availH：切「整页 / 适宽」或容器变高都要重排，否则按钮点了不生效
  const availKey = `${availW}x${availH}-${fitWidth ? (fitPage ? 'page' : 'fit') : zoom.toFixed(2)}`
  useEffect(() => {
    if (loading || numPages === 0) return
    if (viewMode === 'scroll') {
      const { w, h } = firstPageRef.current
      setSlotH(estimateSlotH(w, h))
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

  // ===== 进入阅读时请求「阅读空间」（2026-09-18 书架反馈；只发一次）=====
  // 判据：整页适配下 `availW/页宽 < availH/页高` ⇒ **宽度是瓶颈** —— 页面被容器宽度卡住，
  // 收掉左右侧栏能显著把页面放大；反之高度是瓶颈，收侧栏对页面大小毫无帮助，就不打扰用户。
  // 侧栏收起后本 effect 会因 availW 变化重跑，但 ref 保证只派发一次（用户手动展开后也不会被反复收走）。
  const spaceAskedRef = useRef(false)
  useEffect(() => {
    if (spaceAskedRef.current || loading || numPages === 0) return
    const { w, h } = firstPageRef.current
    if (!w || !h) return
    spaceAskedRef.current = true
    if (availW / w < availH / h) {
      window.dispatchEvent(new CustomEvent('kb-reader-request-space'))
    }
  }, [loading, numPages, availW, availH])

  const zoomBy = useCallback(async (delta: number) => {
    setFitWidth(false)
    zoomRef.current = Math.max(0.25, Math.min(5, (zoomRef.current || 1) * delta))
    setZoom(zoomRef.current)
    scheduleProgress({ zoom: zoomRef.current })
  }, [scheduleProgress])

  /** 复位整页适配（Ctrl+0 与「适合页面」按钮同款口径） */
  const resetFit = useCallback(() => {
    setFitWidth(true)
    setFitPage(true)
    zoomRef.current = 1
    setZoom(1)
    scheduleProgress({ zoom: 1 })
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

  // ===== 划词 AI 工具条（方案 §6）+ 划选摘录（摘录先行批次）=====
  const rootRef = useRef<HTMLDivElement>(null)

  // Ctrl/Cmd + 滚轮缩放：必须 native 监听 + passive:false——React 合成 onWheel 是 passive，
  // preventDefault 无效，拦不掉 Chromium 的整页缩放（2026-09-20 反馈：阅读器加 Ctrl+滚轮）。
  // ★ 依赖必须含 loading：挂载时 loading 分支未渲染根 div（rootRef=null），若只依赖 zoomBy
  //   监听将永不挂载——Ctrl+滚轮完全失效的根因（ref 时序，React #310 同族）
  useEffect(() => {
    if (loading) return
    const root = rootRef.current
    if (!root) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      void zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1)
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [zoomBy, loading, numPages])

  const [selInfo, setSelInfo] = useState<{ rect: SelectionRect; text: string; page: number; rects?: ExcerptRect[] } | null>(null)
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
    // 摘录用：选区矩形归一化到文本层容器（百分比，zoom 无关）；clamp 到 0..1（schema 白名单）
    let rects: ExcerptRect[] | undefined
    const layer = anchorEl.closest('.kb-pdf-text-layer') as HTMLElement | null
    if (layer) {
      const lc = layer.getBoundingClientRect()
      if (lc.width > 0 && lc.height > 0) {
        const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
        rects = [...range.getClientRects()]
          .filter((rr) => rr.width > 0.5 && rr.height > 0.5)
          .slice(0, 60)
          .map((rr) => ({
            l: clamp01((rr.left - lc.left) / lc.width),
            t: clamp01((rr.top - lc.top) / lc.height),
            w: clamp01(rr.width / lc.width),
            h: clamp01(rr.height / lc.height),
          }))
        if (rects.length === 0) rects = undefined
      }
    }
    setSelInfo({ rect: { left: r0.left, top: r0.top, width: r0.width, height: r0.height }, text, page, rects })
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

  // ===== 摘录（摘录先行批次）：列表 + 正文高亮叠加 =====
  const [excerpts, setExcerpts] = useState<ExcerptItem[]>([])
  useEffect(() => {
    let alive = true
    setExcerpts([])
    void excerptList(rootId, relPath).then((r) => {
      if (alive && r.ok) setExcerpts(r.excerpts ?? [])
    }).catch(() => { /* 摘录读取失败不阻塞阅读 */ })
    return () => { alive = false }
  }, [rootId, relPath])
  useDataChanged('excerpt', () => {
    void excerptList(rootId, relPath).then((r) => {
      if (r.ok) setExcerpts(r.excerpts ?? [])
    }).catch(() => { /* 忽略 */ })
  })

  const onCreateExcerpt = useCallback((info: { text: string; page: number; rects?: ExcerptRect[] }) => {
    void excerptCreate(rootId, relPath, { kind: 'pdf', text: info.text, page: info.page, rects: info.rects }).catch(() => { /* 创建失败不打扰阅读 */ })
    closeSelBar()
    window.getSelection()?.removeAllRanges()
  }, [rootId, relPath, closeSelBar])

  /**
   * 高亮叠加：把摘录 rects（文本层百分比）画进每页 .kb-pdf-text-layer。
   * 幂等：以 data-ehl 标记去重/清陈旧——文本层重建（zoom/翻页）后重跑即可补画；
   * 滚动不重建文本层，已画的 overlay 随层存在，无需每页重跑。
   */
  const applyExcerptOverlays = useCallback(() => {
    const root = rootRef.current
    if (!root) return
    const layers = root.querySelectorAll<HTMLElement>('.kb-pdf-text-layer')
    for (const layer of layers) {
      const pgEl = layer.closest('[data-pg]') as HTMLElement | null
      let page = pgEl ? Number(pgEl.dataset.pg) : 0
      if (!page || Number.isNaN(page)) page = viewMode === 'duo' ? duoStartRef.current : pageNumRef.current
      const wanted = new Set<string>()
      const hits = excerpts.filter((e) => e.kind === 'pdf' && e.page === page && e.rects?.length)
      for (const e of hits) {
        (e.rects ?? []).forEach((r, idx) => wanted.add(`${e.id}:${idx}`))
      }
      layer.querySelectorAll<HTMLElement>('.kb-excerpt-hl').forEach((d) => {
        if (!wanted.has(d.dataset.ehl ?? '')) d.remove()
      })
      for (const e of hits) {
        (e.rects ?? []).forEach((r, idx) => {
          const mark = `${e.id}:${idx}`
          if (layer.querySelector(`.kb-excerpt-hl[data-ehl="${mark}"]`)) return
          const d = document.createElement('div')
          d.className = 'kb-excerpt-hl'
          d.dataset.ehl = mark
          d.style.cssText = `position:absolute;left:${(r.l * 100).toFixed(3)}%;top:${(r.t * 100).toFixed(3)}%;width:${(r.w * 100).toFixed(3)}%;height:${(r.h * 100).toFixed(3)}%;background:rgba(255,196,0,0.32);border-radius:2px;pointer-events:none;`
          layer.appendChild(d)
        })
      }
    }
  }, [excerpts, viewMode])
  useEffect(() => { applyExcerptOverlays() }, [applyExcerptOverlays, zoom, viewMode, loading, fitWidth, fitPage, numPages])

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
      // 缩放：Ctrl/Cmd + =（放大）/ -（缩小）/ 0（复位整页适配）
      else if ((e.key === '=' || e.key === '+') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void zoomBy(1.2) }
      else if ((e.key === '-' || e.key === '_') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void zoomBy(1 / 1.2) }
      else if (e.key === '0' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); resetFit() }
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
  }, [closeSelBar, immersive, selInfo, sideTab, stepPage, toggleImmersive, zoomBy, resetFit])

  // 批次 6：当前页广播（左栏大纲态跟随高亮）+ 左栏跳页请求承接
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('kb-pdf-page-changed', { detail: { relPath, page: pageNum, mode: viewMode } }))
  }, [pageNum, viewMode, relPath])
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as { relPath?: string; page?: number } | undefined
      if (!d?.relPath || d.relPath !== relPath || typeof d.page !== 'number') return
      void goPage(d.page)
    }
    window.addEventListener('kb-pdf-goto-page', on)
    return () => window.removeEventListener('kb-pdf-goto-page', on)
  }, [goPage, relPath])

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
    <div className={`kb-fit kb-fit-pdfread flex shrink-0 items-center gap-1.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 text-[12px] text-[var(--text-secondary)] ${immersive ? 'hidden' : ''}`}>
      {onBack && (
        <>
          <button onClick={onBack} title={backLabel ?? '返回书架'}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <ArrowLeft size={13} /><span className="kb-l1">{backLabel ?? '返回书架'}</span>
          </button>
          <div className="mx-1 h-4 w-px bg-[var(--border-color)]" />
        </>
      )}
      <FileText size={13} className="text-[var(--text-tertiary)]" />
      <span className="max-w-[220px] truncate text-[var(--text-primary)]">{name}</span>
      <span className="kb-l3 text-[var(--text-tertiary)]">{numPages} 页</span>
      <div className="mx-1 h-4 w-px bg-[var(--border-color)]" />
      {/* 三模式切换（方案 §5.2：竖滚默认）。
          文字按容器宽度退化（见 styles/index.css 的 .kb-fit 段）：容器 <770px 隐模式名、<668px 隐计数、
          <920px 先隐右侧功能按钮文字。title 保留 → 隐去后悬停仍可读。 */}
      <div className="flex items-center overflow-hidden rounded border border-[var(--border-color)]">
        <button onClick={() => void switchMode('scroll')} title="竖滚模式"
          className={`flex items-center gap-1 px-1.5 py-0.5 ${viewMode === 'scroll' ? 'bg-[var(--bg-hover)] text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)]'}`}>
          <GalleryVertical size={12} /><span className="kb-l2">竖滚</span>
        </button>
        <button onClick={() => void switchMode('single')} title="单页模式"
          className={`flex items-center gap-1 border-x border-[var(--border-color)] px-1.5 py-0.5 ${viewMode === 'single' ? 'bg-[var(--bg-hover)] text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)]'}`}>
          <Square size={12} /><span className="kb-l2">单页</span>
        </button>
        <button onClick={() => void switchMode('duo')} title="双页模式（需宽 ≥1240px）"
          className={`flex items-center gap-1 px-1.5 py-0.5 ${viewMode === 'duo' ? 'bg-[var(--bg-hover)] text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)]'}`}>
          <Columns2 size={12} /><span className="kb-l2">双页</span>
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
      <span className="kb-l3 text-[var(--text-tertiary)]">/ {numPages}</span>
      <button onClick={() => void stepPage(1)} disabled={viewMode !== 'duo' && pageNum >= numPages} title="下一页 (PageDown / →)"
        className="rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40">
        <ChevronRight size={15} />
      </button>
      <div className="mx-1 h-4 w-px bg-[var(--border-color)]" />
      {/* 适配口径二选一（2026-09-18）：整页适配 = 整页完整可见（默认，书架诉求）；
          适合宽度 = 页面宽铺满容器、纵向滚动看完整页。放大/缩小会脱离自动适配（fitWidth=false）。 */}
      <button onClick={resetFit} title="适合页面（整页完整可见，Ctrl+0）"
        className={`rounded p-0.5 ${fitWidth && fitPage ? 'text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
        <MaximizeIcon size={14} />
      </button>
      <button onClick={() => { setFitWidth(true); setFitPage(false); zoomRef.current = 1; setZoom(1) }} title="适合宽度（页面宽铺满，纵向滚动）"
        className={`rounded p-0.5 ${fitWidth && !fitPage ? 'text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
        <MoveHorizontal size={14} />
      </button>
      <button onClick={() => void zoomBy(1.2)} title="放大 (Ctrl + 滚轮 / Ctrl + =)" className="rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><ZoomIn size={14} /></button>
      <button onClick={() => void zoomBy(1 / 1.2)} title="缩小 (Ctrl + 滚轮 / Ctrl + -)" className="rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><ZoomOut size={14} /></button>
      <div className="mx-1 h-4 w-px bg-[var(--border-color)]" />
      {/* 大纲 = 左栏 bookshelf 模块态（批次 6：内嵌大纲侧栏已删）：解锁左栏并切过去（兜底入口） */}
      <button onClick={() => window.dispatchEvent(new CustomEvent('kb-rail-show-bookshelf-outline'))} title="在左栏打开目录/缩略图/书签"
        className="flex items-center gap-1 rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
        <ListTree size={14} /><span className="kb-l1">大纲</span>
      </button>
      <button onClick={() => setSideTab((v) => (v === 'search' ? null : 'search'))} title="搜索 (Ctrl+F)"
        className={`flex items-center gap-1 rounded p-0.5 ${sideTab === 'search' ? 'text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
        <Search size={14} /><span className="kb-l1">搜索</span>
      </button>
      <button onClick={toggleBookmark} title={bookmarks.some((b) => b.page === currentPageForBookmark()) ? '移除本页书签' : '收藏本页书签'}
        className={`flex items-center gap-1 rounded p-0.5 ${bookmarks.some((b) => b.page === currentPageForBookmark()) ? 'text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
        {bookmarks.some((b) => b.page === currentPageForBookmark()) ? <Bookmark size={14} /> : <BookmarkPlus size={14} />}<span className="kb-l1">书签</span>
      </button>
      <button onClick={toggleEyeCare} title="护眼模式（书级记忆）"
        className={`flex items-center gap-1 rounded p-0.5 ${eyeCare ? 'text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
        {eyeCare ? <Eye size={14} /> : <EyeOff size={14} />}<span className="kb-l1">护眼</span>
      </button>
      <button onClick={toggleImmersive} title="沉浸阅读（隐藏全部 UI，Esc 退出）"
        className={`ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 ${immersive ? 'text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
        <BookOpen size={14} /><span className="kb-l1">沉浸</span>
      </button>
      <span data-wb="pdfZoom" className="kb-l3 text-[11px] text-[var(--text-tertiary)]">{Math.round(zoom * 100)}%</span>
    </div>
  )

  const sidePanel = (
    <div className={`kb-view-fade flex w-64 shrink-0 flex-col border-r border-[var(--border-color)] bg-[var(--bg-secondary)] ${immersive || sideTab === null ? 'hidden' : ''}`}>
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--text-primary)]">
        <><Search size={13} />搜索</>
        <button onClick={() => setSideTab(null)} className="ml-auto rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><X size={12} /></button>
      </div>
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

  // 竖滚页槽 —— ⚠️ Hook 必须在下方 error/loading 早退**之前**调用：
  // 首渲染走 loading 早退时若跳过本 useMemo，加载完成后 Hook 数量变化 → React #310 直接崩（RootErrorBoundary 兜底）。
  const slots = useMemo(() => {
    if (viewMode !== 'scroll') return null
    const out: React.ReactNode[] = []
    for (let n = 1; n <= numPages; n++) {
      out.push(
        <div
          key={n}
          data-pg={n}
          ref={(el) => setSlotRef(n, el)}
          className="relative flex w-full justify-center overflow-hidden bg-[var(--bg-primary)] shadow-[0_2px_8px_rgba(0,0,0,0.18)]"
          style={{ height: slotH }}
        />,
      )
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, numPages, slotH])

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

  return (
    <div ref={rootRef} data-sel-float-ignore className="relative flex h-full min-h-0 flex-col bg-[var(--bg-tertiary)]">
      {toolbar}
      {effectiveScan !== 'full' && (
        <div className="shrink-0 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-1 text-[11px] text-[var(--text-tertiary)]" data-wb="scanHint">
          {effectiveScan === 'no' ? '本册为扫描版（页面是图片），划选 / 摘录不可用' : '本册部分页为扫描件（无文字层），这些页划选 / 摘录不可用'}
        </div>
      )}
      <div className="flex min-h-0 flex-1 items-stretch" style={eyeCare ? { filter: 'sepia(0.32) brightness(0.97) saturate(0.92)' } : undefined}>
        {sidePanel}
        {viewMode === 'scroll' ? (
          <div ref={scrollHostRef} onScroll={onScrollHost} className="min-h-0 flex-1 overflow-auto">
            {/* 页间距 gap-4（16px）：连续阅读时相邻页有清晰的分隔，不再糊成一片 */}
            <div className={`mx-auto flex flex-col items-center gap-4 ${immersive ? 'py-0' : 'py-4'}`} style={{ width: availW }}>
              {slots}
            </div>
          </div>
        ) : (
          <div ref={containerRef} className="relative min-h-0 flex-1 overflow-auto">
            {/* safe center：页面比容器小时垂直居中（留白上下均分，不再全堆在底部）；
                页面比容器大时退回顶对齐 —— 否则溢出后顶部会被裁掉且滚不回去 */}
            <div className={`flex min-h-full w-full items-[safe_center] justify-center ${immersive ? 'p-0' : 'p-6'}`}>
              {viewMode === 'single' ? (
                <div ref={pageHostRef} className="relative inline-block">
                  <canvas ref={singleCanvasRef} className="block bg-[var(--bg-primary)] shadow-[0_2px_8px_rgba(0,0,0,0.18)]" />
                  <div ref={singleTextRef} className="kb-pdf-text-layer" style={{ top: 0, left: 0 }} />
                </div>
              ) : (
                <div className="flex items-start justify-center gap-4">
                  <div ref={pageHostRef} className="relative inline-block">
                    <canvas ref={duoCanvasARef} className="block bg-[var(--bg-primary)] shadow-[0_2px_8px_rgba(0,0,0,0.18)]" />
                    <div ref={duoTextARef} className="kb-pdf-text-layer" style={{ top: 0, left: 0 }} />
                  </div>
                  <div className="relative inline-block">
                    <canvas ref={duoCanvasBRef} className="block bg-[var(--bg-primary)] shadow-[0_2px_8px_rgba(0,0,0,0.18)]" />
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
      <TextSelectionBar rect={selInfo?.rect ?? null} translate={translate} onCopy={doCopySel} onTranslate={() => void doTranslateSel()} onAsk={doAsk} onClose={closeSelBar} onCreateExcerpt={selInfo && rootId ? () => onCreateExcerpt({ text: selInfo.text, page: selInfo.page, rects: selInfo.rects }) : undefined} />
    </div>
  )
}
