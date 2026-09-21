import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronLeft, ChevronRight, ArrowLeft, ZoomIn, ZoomOut, Maximize as MaximizeIcon, MoveHorizontal,
  FileText, AlertTriangle, Loader2, Search, BookOpen, X,
  GalleryVertical, Square, Columns2, Bookmark, BookmarkPlus, Eye, EyeOff, ListTree,
} from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url'
import type { EventBus as PdfEventBus, PDFLinkService as PdfLinkServiceInstance, PDFViewer as PdfViewerInstance } from 'pdfjs-dist/web/pdf_viewer'
import { detachViewerDocument, loadPdfViewerKit, type PdfViewerKit } from './pdfViewerKit'
import { expandTextLayerHitAreas, markSearchMatches, pageNumberOf, paintExcerptOverlays, textLayerOf } from './pdfPageTools'
import { openExternal, copyText, excerptCreate, excerptList, pdfReaderGet, pdfReaderPatch, translateInvoke, workspaceReadRange } from '../../../lib/ipc'
import { useDataChanged } from '../../../lib/dataChanged'
import { showToast } from '../../../lib/toast'
import { resolveDegrade, DUO_MIN_WIDTH, type PdfLayoutMode } from '../../../lib/pdfLayout'
import { detectScanMode, resolveScanPages } from '../../../../electron/lib/kbStore/scanDetect'
import { TextSelectionBar, type SelectionRect, type TranslateState } from './TextSelectionBar'
import type { BookScanMode, ExcerptItem, ExcerptRect, PdfBookPatch, PdfBookState, ExcerptColor, ExcerptType } from '../../../types'

// 同源 worker（v3 classic，兼容 Electron 33 / Chromium 130——v4.5+ 依赖 toHex 未实现）
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const CHUNK = 128 * 1024 // range 块大小：128KB

/**
 * pdf.js 的 scale 口径：`页面 CSS 宽 = 页宽(pt) × currentScale × PDF_TO_CSS_UNITS`。
 * 自研渲染层当年的 zoom 是「viewport.scale」口径，两者差 1.333 倍（旧口径下 100% ≈ 75%）。
 * 迁移后统一用 pdf.js 口径 —— 100% = 96dpi 下 1:1，与其它 PDF 阅读器一致。
 */
const CSS_UNITS =
  (pdfjsLib as unknown as { PixelsPerInch?: { PDF_TO_CSS_UNITS?: number } }).PixelsPerInch?.PDF_TO_CSS_UNITS ?? 96 / 72

/** 缩放范围（pdf.js 口径）。下限取到 15% 以覆盖旧口径的 25%（0.25 × 0.75 = 0.1875） */
const MIN_ZOOM = 0.15
const MAX_ZOOM = 4

/**
 * 画布像素预算（4096² ≈ 16MP，与 pdf.js 缺省同值）。
 * 显式写出来的原因：不设限时 500% 缩放下单页后备位图 ≈ 96MB，4 页并发近 400MB。
 * 超限后 pdf.js 会自行降低后备位图分辨率、用 CSS 拉伸显示。
 */
const MAX_CANVAS_PIXELS = 4096 * 4096

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

/** 事件回调经 ref 转发：viewer 的创建 effect 依赖必须极小（否则每次 handler 换身份就重建 viewer） */
interface ViewerHandlers {
  onPagesInit: () => void
  onPageChanging: (pageNumber: number) => void
  onUpdateViewArea: () => void
  onTextLayerRendered: (pageNumber: number) => void
  onScaleChanging: (scale: number) => void
  onOpenExternal: (url: string) => void
  onLongPress?: never
}

/**
 * 共享 PDF 阅读器 v3（方案 A：自研渲染池 → **pdf.js 官方 viewer 组件**，2026-09-21）。
 *
 * 为什么换：自研那套（页槽占位 + IntersectionObserver 渲染池 + 双缓冲 + 陈旧丢弃 + 拉伸 +
 * 看门狗）每一项都在官方 `PDFRenderingQueue` / `PDFPageView` / `getVisibleElements` 里有
 * 久经考验的对应实现，而自研版两天里连爆「页面空白 / 缩放不跟手 / 一页大一页小 / 闪烁」
 * 一类问题 —— 这一层不该自己造。官方 viewer 与 `pdfjs-dist` **同包同版本、Apache-2.0**，
 * 不引入新依赖。
 *
 * 交给官方：页面装载与淘汰（PDFPageViewBuffer）、可视页判定与预取（getVisibleElements +
 * PDFRenderingQueue，**纯几何、不依赖 rAF** —— 顺带消灭「窗口被遮挡就渲染不出来」那类问题）、
 * 画布与文本层、链接注解层、缩放口径与重排。
 *
 * 保留自研外壳：懒加载 range transport（IPC 分段读，大文件不过 IPC）、大纲/缩略图/书签左栏、
 * 全文搜索、续读进度、划词 AI 工具条、摘录、护眼、沉浸、三模式、快捷键。
 *
 * 三模式映射（都用同一个 PDFViewer 实例，靠 scrollMode/spreadMode 组合，不销毁重建）：
 * - 竖滚：ScrollMode.VERTICAL + SpreadMode.NONE
 * - 单页：ScrollMode.PAGE + SpreadMode.NONE
 * - 双页：ScrollMode.PAGE + SpreadMode.ODD（官方跨页对 = [1,2] [3,4] ... 与旧口径一致，
 *   见 `#ensurePageViewVisible`：奇偶配对规则 parity = spreadMode − 1）
 */
export function PdfReaderView({ rootId, relPath, name, backLabel, onBack }: Props) {
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null)

  // ===== 文档态 =====
  const [numPages, setNumPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /** 首页基准尺寸（「宽度是否瓶颈」判定与整页适配的基准） */
  const firstPageRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 })

  // ===== 视图态 =====
  const [viewMode, setViewMode] = useState<PdfLayoutMode>('scroll')
  const [pageNum, setPageNum] = useState(1)
  /** 当前缩放（**pdf.js currentScale 口径**，见 MIN_ZOOM 上方注释）；fitWidth 为真时由 pdf.js 现算后回读 */
  const [zoom, setZoom] = useState(1)
  const [fitWidth, setFitWidth] = useState(true)
  /** 整页适配开关（2026-09-18 书架反馈）。**默认 false = 适宽**：页面宽铺满容器，字最大最清晰，
      纵向滚动看完整页 —— 「整页可见」是可选口径、不强制，因为强制缩小会让字变小，
      而且窄容器下宽度是瓶颈时页高必然填不满容器高（大片底部留白，2026-09-18 实机反馈）。
      打开后缩放取 `min(容器可用宽/页宽, 容器可用高/页高)`（工具栏「适合页面」按钮切）。
      仅在 fitWidth（自动适配）为真时生效；手动缩放/滚轮缩放会把 fitWidth 置 false 走自定义 zoom。 */
  const [fitPage, setFitPage] = useState(false)

  // 镜像 ref（事件回调要读最新值，而这些回调挂在官方 eventBus 上、不宜频繁重挂）
  const pageNumRef = useRef(1)
  const zoomRef = useRef(1)
  const viewModeRef = useRef<PdfLayoutMode>('scroll')
  const fitWidthRef = useRef(true)
  const fitPageRef = useRef(false)
  const numPagesRef = useRef(0)
  const excerptsRef = useRef<ExcerptItem[]>([])
  const searchQueryRef = useRef('')

  // ===== 容器可用宽/高（宽度是否瓶颈的判定基准 + 双页防呆降级）=====
  const [availW, setAvailW] = useState(800)
  const [availH, setAvailH] = useState(600)
  const availWRef = useRef(800)

  // ===== 划词浮条 / 翻译（声明位置靠前：官方事件桥要读 setSelInfo）=====
  const [selInfo, setSelInfo] = useState<{ rect: SelectionRect; text: string; page: number; rects?: ExcerptRect[] } | null>(null)
  const [translate, setTranslate] = useState<TranslateState | null>(null)
  const closeSelBar = useCallback(() => { setSelInfo(null); setTranslate(null) }, [])

  // ===== 官方 viewer =====
  /** 官方 PDFViewer 的 container：必须是**绝对定位**的 DIV（构造时会校验），且是滚动宿主 */
  const containerRef = useRef<HTMLDivElement>(null)
  /** 「viewer 元素」= container.firstElementChild，必须是 DIV；页盒都挂在这里 */
  const viewerElRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<PdfViewerInstance | null>(null)
  const eventBusRef = useRef<PdfEventBus | null>(null)
  const linkServiceRef = useRef<PdfLinkServiceInstance | null>(null)
  const kitRef = useRef<PdfViewerKit | null>(null)
  const [viewerReady, setViewerReady] = useState(false)
  /**
   * 页面已 init（官方 `pagesinit`）。**这是一道硬闸门**：在那之前对 viewer 的写操作
   * （scrollMode / spreadMode / currentScaleValue / currentPageNumber）都会炸 ——
   * 例如 `set scrollMode` 会立刻走 `_updateScrollMode(currentPageNumber)` →
   * `#ensurePageViewVisible()` → `this._pages[0].div`，而 `_pages` 此刻还是空数组 → TypeError。
   * 所以：**所有对 viewer 的写操作都以它为前置条件**，而不是以「viewer 已创建」为条件。
   */
  const [pagesReady, setPagesReady] = useState(false)
  const pagesReadyRef = useRef(false)

  const rootRef = useRef<HTMLDivElement>(null)

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
  /** 续读意图（pdfReaderGet 的结果）；`bookLoadedRef` 标记它是否已就绪 */
  const bookStateRef = useRef<PdfBookState | null>(null)
  const bookLoadedRef = useRef(false)
  /** 续读只应用一次（pagesinit 与 bookState 到达的顺序不确定，两边都来敲这扇门） */
  const restoredRef = useRef(false)

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

  // ===== 容器可用宽/高测量（防呆降级 + 「宽度是否瓶颈」判定）=====
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      availWRef.current = Math.max(120, el.clientWidth)
      setAvailW(availWRef.current)
      setAvailH(Math.max(120, el.clientHeight))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
    // 依赖里带 loading：文档就绪前容器还没挂上，早退后再不会重测
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading])

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

  // ===== 缩放口径（统一到官方 viewer 的 currentScaleValue）=====
  /** 把 pdf.js 的真实 scale 回读到 UI（pdf.js 会按 MIN/MAX 与实际页宽自行决定最终值） */
  const syncZoomFromViewer = useCallback(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const s = viewer.currentScale
    if (!Number.isFinite(s) || s <= 0) return
    zoomRef.current = s
    setZoom(s)
  }, [])

  /** 自动适配口径：整页可见 / 适宽 —— 由 pdf.js 自己按 container 尺寸算（含 spread 对半） */
  const applyAutoScale = useCallback(() => {
    const viewer = viewerRef.current
    if (!viewer || !viewer.pdfDocument) return
    viewer.currentScaleValue = fitPageRef.current ? 'page-fit' : 'page-width'
    syncZoomFromViewer()
  }, [syncZoomFromViewer])

  /** 手动缩放口径（数值 scale） */
  const applyZoomScale = useCallback((z: number) => {
    const viewer = viewerRef.current
    if (!viewer || !viewer.pdfDocument) return
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
    viewer.currentScaleValue = String(next)
    syncZoomFromViewer()
  }, [syncZoomFromViewer])

  const syncScaleNow = useCallback(() => {
    if (fitWidthRef.current) applyAutoScale()
    else applyZoomScale(zoomRef.current)
  }, [applyAutoScale, applyZoomScale])

  /** 模式 → 官方 scrollMode/spreadMode（幂等：同值赋值在 PDFViewer 里直接 return） */
  const applyModeToViewer = useCallback((m: PdfLayoutMode, page?: number) => {
    const viewer = viewerRef.current
    const kit = kitRef.current
    if (!viewer || !kit) return
    viewer.scrollMode = m === 'scroll' ? kit.ScrollMode.VERTICAL : kit.ScrollMode.PAGE
    viewer.spreadMode = m === 'duo' ? kit.SpreadMode.ODD : kit.SpreadMode.NONE
    if (page && page >= 1) viewer.currentPageNumber = page
  }, [])

  // ===== 续读应用（pagesinit 与 bookState 到达顺序不定，两边都来敲这扇门）=====
  const applyBookState = useCallback(() => {
    if (restoredRef.current || !bookLoadedRef.current || !pagesReadyRef.current) return
    const viewer = viewerRef.current
    if (!viewer) return
    restoredRef.current = true
    const st = bookStateRef.current
    const total = viewer.pagesCount || numPagesRef.current || 1
    const page = st?.lastPage && st.lastPage >= 1 ? Math.min(st.lastPage, total) : 1
    // 1) 缩放口径
    if (st?.zoom && st.zoom !== 1) {
      fitWidthRef.current = false
      setFitWidth(false)
      zoomRef.current = st.zoom
      setZoom(st.zoom)
    }
    // 2) 视图模式（不满足宽度的 duo 直接落回 scroll，与旧口径一致）
    const mode: PdfLayoutMode =
      st?.mode && st.mode !== 'scroll' && resolveDegrade(availWRef.current, st.mode) === st.mode ? st.mode : 'scroll'
    viewModeRef.current = mode
    setViewMode(mode)
    applyModeToViewer(mode)
    // 3) 口径与页码（直接作用到 viewer，不依赖 state 传播时序）
    syncScaleNow()
    viewer.currentPageNumber = page
    pageNumRef.current = page
    setPageNum(page)
    // 4) 竖滚模式按「整文档滚动比例」恢复页内位置（旧口径存的 scrollRatio 就是整文档比例）
    const ratio = st?.scrollRatio ?? 0
    if (mode === 'scroll' && ratio > 0.005) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const host = containerRef.current
        if (!host) return
        const max = host.scrollHeight - host.clientHeight
        if (max > 40) host.scrollTop = ratio * max
      }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyModeToViewer, syncScaleNow])

  // ===== 官方 viewer 事件回调（经 ref 转发，见 ViewerHandlers 注释）=====
  const handlersRef = useRef<ViewerHandlers>({
    onPagesInit: () => {},
    onPageChanging: () => {},
    onUpdateViewArea: () => {},
    onTextLayerRendered: () => {},
    onScaleChanging: () => {},
    onOpenExternal: () => {},
  })

  /**
   * 事件桥接线（**无依赖数组 = 每次提交后刷新一遍闭包**）。
   * 为什么不在 render 期直接赋值：render 期写 ref 是 React 明确不鼓励的副作用。
   * 放在 effect 里也不会漏事件 —— viewer 的创建 effect 先 `await` 一次模块装载，
   * 官方事件最早也要到下一个微任务之后才可能派发，那时本轮所有 effect 都跑完了。
   */
  useEffect(() => {
    handlersRef.current = {
      /** 竖滚模式的「整文档滚动比例」与页码都由官方 updateviewarea/pagechanging 驱动（内部已 rAF 节流） */
      onPagesInit: () => {
        pagesReadyRef.current = true
        setPagesReady(true)
        syncScaleNow()
        const viewer = viewerRef.current
        if (viewer) viewer.currentPageNumber = Math.max(1, Math.min(pageNumRef.current || 1, viewer.pagesCount || 1))
        applyBookState()
      },
      onPageChanging: (pageNumber: number) => {
        // 双页：官方 currentPageNumber 可能是跨页对的第二页（[1,2] 里报 2），对外统一归一到对首
        const shown = viewModeRef.current === 'duo' && pageNumber % 2 === 0 ? pageNumber - 1 : pageNumber
        if (shown === pageNumRef.current) return
        pageNumRef.current = shown
        setPageNum(shown)
        if (restoredRef.current) scheduleProgress({ lastPage: shown })
      },
      onUpdateViewArea: () => {
        if (!restoredRef.current) return
        // 滚动即失效划词浮条锚点
        setSelInfo((prev) => (prev ? null : prev))
        if (viewModeRef.current !== 'scroll') return
        const host = containerRef.current
        if (!host) return
        const max = host.scrollHeight - host.clientHeight
        if (max <= 40) return
        const ratio = Math.min(1, Math.max(0, host.scrollTop / max))
        scheduleProgress({ lastPage: pageNumRef.current, scrollRatio: ratio })
      },
      onScaleChanging: (scale: number) => {
        if (!Number.isFinite(scale) || scale <= 0) return
        zoomRef.current = scale
        setZoom(scale)
      },
      onTextLayerRendered: (pageNumber: number) => {
        const pageEl = viewerRef.current?.getPageView(pageNumber - 1)?.div as HTMLElement | undefined
        const layer = pageEl?.querySelector<HTMLElement>('.textLayer') ?? null
        if (!layer) return
        // 文本层每次重建都会经过这里：命中盒 / 搜索命中 / 摘录叠加都在此重挂（都是幂等的）
        expandTextLayerHitAreas(layer)
        if (searchQueryRef.current.trim()) markSearchMatches(layer, searchQueryRef.current)
        paintExcerptOverlays(layer, pageNumber, excerptsRef.current)
      },
      onOpenExternal: (url: string) => { void openExternal(url) },
    }
  })

  /** 只读探针（devbridge 取证口）：替代旧自研池的 `__kbPdfProbe` */
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__kbPdf = {
      get state() {
        const v = viewerRef.current
        const host = containerRef.current
        return {
          ready: !!v,
          pagesReady: pagesReadyRef.current,
          pages: v?.pagesCount ?? 0,
          scale: v?.currentScale ?? 0,
          scaleValue: v?.currentScaleValue ?? null,
          page: v?.currentPageNumber ?? 0,
          mode: viewModeRef.current,
          scrollMode: v?.scrollMode ?? null,
          spreadMode: v?.spreadMode ?? null,
          fitWidth: fitWidthRef.current,
          fitPage: fitPageRef.current,
          pagesInDom: host?.querySelectorAll('.page').length ?? 0,
          canvases: host?.querySelectorAll('.page canvas').length ?? 0,
          textSpans: host?.querySelectorAll('.textLayer span').length ?? 0,
          scrollTop: host ? Math.round(host.scrollTop) : 0,
          scrollWidth: host?.scrollWidth ?? 0,
          clientWidth: host?.clientWidth ?? 0,
        }
      },
    }
  }, [])

  // ===== 创建官方 viewer（文档就绪 + 容器挂载后一次）=====
  useEffect(() => {
    if (loading || error || !pdfDoc) return
    const container = containerRef.current
    const viewerEl = viewerElRef.current
    if (!container || !viewerEl) return
    let alive = true
    let created: PdfViewerInstance | null = null
    let bus: PdfEventBus | null = null
    pagesReadyRef.current = false
    void (async () => {
      try {
        const kit = await loadPdfViewerKit()
        if (!alive) return
        kitRef.current = kit
        bus = new kit.EventBus()
        const linkService = new kit.PDFLinkService({
          eventBus: bus,
          // 外链不在应用内导航：target=_blank 触发主进程 setWindowOpenHandler → shell.openExternal
          // （主进程另有 will-navigate 守卫兜底），内部 dest 由 AnnotationLayer 自己的 onclick 走
          // PDFLinkService.goToDestination
          externalLinkTarget: kit.LinkTarget.BLANK,
        })
        const viewer = new kit.PDFViewer({
          container,
          viewer: viewerEl,
          eventBus: bus,
          linkService,
          textLayerMode: 1, // TextLayerMode.ENABLE（划选/翻译/摘录的前提）
          annotationMode: 1, // AnnotationMode.ENABLE（只要链接热区，不要可交互表单件）
          maxCanvasPixels: MAX_CANVAS_PIXELS,
        })
        created = viewer
        linkService.setDocument(pdfDoc, null)
        linkService.setViewer(viewer)
        eventBusRef.current = bus
        linkServiceRef.current = linkService
        viewerRef.current = viewer

        // 事件桥：一律经 handlersRef 转发（见其注释）
        bus.on('pagesinit', () => handlersRef.current.onPagesInit())
        bus.on('pagechanging', (e: { pageNumber: number }) => handlersRef.current.onPageChanging(e.pageNumber))
        bus.on('updateviewarea', () => handlersRef.current.onUpdateViewArea())
        bus.on('scalechanging', (e: { scale: number }) => handlersRef.current.onScaleChanging(e.scale))
        bus.on('textlayerrendered', (e: { pageNumber: number }) => handlersRef.current.onTextLayerRendered(e.pageNumber))

        viewer.setDocument(pdfDoc)
        if (!alive) { detachViewerDocument(viewer); return }
        setViewerReady(true)
      } catch (e) {
        if (alive) setError(`阅读器组件装载失败：${String((e as Error)?.message || e)}`)
      }
    })()
    return () => {
      alive = false
      setViewerReady(false)
      setPagesReady(false)
      pagesReadyRef.current = false
      try { detachViewerDocument(created) } catch { /* 卸载期忽略 */ }
      viewerRef.current = null
      eventBusRef.current = null
      linkServiceRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, error, pdfDoc])

  // 模式 → viewer（同一实例切组合，不销毁重建）。⚠️ 必须等 pagesinit（见 pagesReady 注释）
  useEffect(() => {
    if (!pagesReady) return
    viewModeRef.current = viewMode
    applyModeToViewer(viewMode)
    // duo 的跨页对会把可用宽对半（#pageWidthScaleFactor=2），模式一变必须重算口径
    if (fitWidthRef.current) applyAutoScale()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, pagesReady, applyModeToViewer, applyAutoScale])

  // 自动适配口径变化（容器尺寸 / 整页↔适宽切换）→ 重新算 scale
  useEffect(() => {
    if (!pagesReady || !fitWidth) return
    fitWidthRef.current = true
    fitPageRef.current = fitPage
    applyAutoScale()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitWidth, fitPage, availW, availH, pagesReady, applyAutoScale])

  // 手动缩放（数值 scale）
  useEffect(() => {
    if (!pagesReady || fitWidth) return
    fitWidthRef.current = false
    applyZoomScale(zoomRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, fitWidth, pagesReady, applyZoomScale])

  // ===== 加载文档 =====
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    setSearchHits([])
    setSearchQuery('')
    // 换文档：续读/页就绪标记一律重置（否则新文档会套用旧文档的续读结果）
    bookLoadedRef.current = false
    bookStateRef.current = null
    restoredRef.current = false
    pagesReadyRef.current = false
    setPagesReady(false)
    setViewerReady(false)
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
        numPagesRef.current = pdf.numPages
        const p1 = await pdf.getPage(1)
        const base1 = p1.getViewport({ scale: 1 })
        // 只用于「宽度是否瓶颈」判定（availW/页宽 vs availH/页高）—— 该比较对整体缩放系数不敏感，
        // 所以这里存未换算的原始尺寸即可，不必与 CSS_UNITS 口径对齐
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

  // 加载完 → 读书级状态（进度/模式/缩放/护眼/书签）→ 交给 applyBookState 落到 viewer
  useEffect(() => {
    if (loading || numPages === 0) return
    let alive = true
    void (async () => {
      let restored: PdfBookState | null = null
      try {
        const r = await pdfReaderGet(rootId, relPath)
        if (r.ok && r.state) {
          restored = r.state
          bookUpdatedRef.current = r.state.updatedAt
          if (!alive) return
          setBookmarks(r.state.bookmarks ?? [])
          if (r.state.scan) setScanMode(r.state.scan)
          if (r.state.scanPages) setScanPages(r.state.scanPages)
          if (r.state.eyeCare) setEyeCare(true)
        }
      } catch { /* 无进度/读取失败 → 从头看 */ }
      if (!alive) return
      bookStateRef.current = restored
      bookLoadedRef.current = true
      // 首读登记总页数（书架侧栏进度条分母）；文件更换页数变化时顺手校正
      if (restored?.totalPages !== numPages) {
        bookUpdatedRef.current = restored?.updatedAt
        void doPatch({ totalPages: numPages })
      }
      applyBookState()
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, numPages])

  // ===== 扫描版探测（轻量方案）：均匀抽样 ≤6 页 getTextContent 字符计数 → full/partial/no。
  // 结论落盘一次（pdfReader.scan，书架角标复用）；'full' 不落盘（缺省即 full）。
  const [scanMode, setScanMode] = useState<BookScanMode | null>(null)
  /** 页级降级（A5）：逐页 scanned 布尔；null = 未探测/无需（scanMode==='full'） */
  const [scanPages, setScanPages] = useState<boolean[] | null>(null)
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

  // ===== 页级扫描降级（A5）：仅 scanMode!=='full' 时逐页 getTextContent（分片空闲执行 200ms）=====
  // 结论落盘 pdfReader.scanPages；禁止阻塞首屏。
  useEffect(() => {
    if (loading || numPages === 0) return
    if (!scanMode || scanMode === 'full') return
    if (scanPages !== null) return // 已探测（持久化或本次已测）
    let alive = true
    void (async () => {
      const pdf = pdfRef.current
      if (!pdf) return
      const texty: boolean[] = new Array(numPages).fill(false)
      for (let n = 1; n <= numPages; n++) {
        if (!alive) return
        try {
          const p = await pdf.getPage(n)
          const tc = await p.getTextContent()
          const chars = tc.items.reduce((s, it) => s + (typeof (it as { str?: unknown }).str === 'string' ? ((it as { str: string }).str).trim().length : 0), 0)
          texty[n - 1] = chars >= 20
        } catch { texty[n - 1] = false }
        // 分片空闲：每页之间让出 200ms，避免几百页探测卡死主线程
        await new Promise((res) => setTimeout(res, 200))
      }
      if (!alive) return
      const scanned = resolveScanPages(texty)
      setScanPages(scanned)
      try { await doPatch({ scanPages: scanned }) } catch { /* 落盘失败不影响阅读 */ }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, numPages, scanMode, scanPages])

  // 页级扫描标记：扫描页（无文本层）右上角挂「扫描页」角标（懒渲染页面出现即装饰，防御式）
  useEffect(() => {
    if (scanPages === null) return
    const viewer = viewerElRef.current
    if (!viewer) return
    const decorate = () => {
      try {
        viewer.querySelectorAll('.page[data-page-number]').forEach((el) => {
          const n = Number((el as HTMLElement).getAttribute('data-page-number'))
          if (!Number.isFinite(n)) return
          const scanned = scanPages[n - 1]
          const has = el.querySelector('.kb-scan-badge')
          if (scanned && !has) {
            const badge = document.createElement('div')
            badge.className = 'kb-scan-badge'
            badge.textContent = '扫描页'
            el.appendChild(badge)
          } else if (!scanned && has) {
            has.remove()
          }
        })
      } catch { /* 装饰失败忽略 */ }
    }
    decorate()
    const mo = new MutationObserver(() => decorate())
    mo.observe(viewer, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [scanPages])

  // 扫描版提示条（无文本层的页划选/摘录不可用——管理预期，见 bookshelf-reader-upgrade-design §5）
  const effectiveScan: BookScanMode = scanMode ?? 'full'

  // ===== 进入阅读时请求「阅读空间」（2026-09-18 书架反馈；只发一次）=====
  // 判据：`availW/页宽 < availH/页高` ⇒ **宽度是瓶颈** —— 页面被容器宽度卡住，
  // 收掉左右侧栏能显著把页面放大；反之高度是瓶颈，收侧栏对页面大小毫无帮助，就不打扰用户。
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

  const zoomBy = useCallback((delta: number) => {
    const base = viewerRef.current?.currentScale ?? zoomRef.current ?? 1
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, base * delta))
    fitWidthRef.current = false
    setFitWidth(false)
    zoomRef.current = next
    setZoom(next)
    scheduleProgress({ zoom: next })
  }, [scheduleProgress])

  /** 复位整页适配（Ctrl+0 与「适合页面」按钮同款口径） */
  const resetFit = useCallback(() => {
    fitWidthRef.current = true
    fitPageRef.current = true
    setFitWidth(true)
    setFitPage(true)
    scheduleProgress({ zoom: 1 })
  }, [scheduleProgress])

  /** 适合宽度（默认口径） */
  const fitToWidth = useCallback(() => {
    fitWidthRef.current = true
    fitPageRef.current = false
    setFitWidth(true)
    setFitPage(false)
    scheduleProgress({ zoom: 1 })
  }, [scheduleProgress])

  // ===== 统一跳页 / 翻页（交给官方 viewer：跨页对、滚动模式的差异它自己处理）=====
  const goPage = useCallback((num: number) => {
    const viewer = viewerRef.current
    if (!viewer || !pagesReadyRef.current) return
    const total = viewer.pagesCount || numPagesRef.current || 1
    const target = Math.max(1, Math.min(Math.round(num), total))
    if (viewModeRef.current === 'scroll') viewer.scrollPageIntoView({ pageNumber: target })
    else viewer.currentPageNumber = target
    const shown = viewModeRef.current === 'duo' && target % 2 === 0 ? target - 1 : target
    pageNumRef.current = shown
    setPageNum(shown)
    if (restoredRef.current) scheduleProgress({ lastPage: shown })
  }, [scheduleProgress])

  /** 翻页步长由官方决定（单页 ±1、双页 ±2、竖滚滚到下一页） */
  const stepPage = useCallback((dir: 1 | -1) => {
    const viewer = viewerRef.current
    if (!viewer || !pagesReadyRef.current) return
    if (dir === 1) viewer.nextPage()
    else viewer.previousPage()
  }, [])

  // ===== 模式切换 =====
  const switchMode = useCallback((m: PdfLayoutMode) => {
    if (m === viewModeRef.current) return
    if (m === 'duo' && availW < DUO_MIN_WIDTH) {
      showToast({ type: 'warning', message: `容器宽度不足 ${DUO_MIN_WIDTH}px，已自动切回单页` })
      m = 'single'
    }
    // 竖滚 ↔ 翻页：官方 viewer 自己按当前页码重建视图（重建后按该页定位）
    const keep = pageNumRef.current
    viewModeRef.current = m
    setViewMode(m)
    applyModeToViewer(m, keep)
    scheduleProgress({ mode: m }, true)
  }, [applyModeToViewer, availW, scheduleProgress])

  // ===== 书签（方案 §5.6：当页增删 + 列表备注）=====
  const currentPageForBookmark = () => pageNumRef.current

  const toggleBookmark = useCallback(() => {
    const page = currentPageForBookmark()
    const has = bookmarks.some((b) => b.page === page)
    const next = has
      ? bookmarks.filter((b) => b.page !== page)
      : [...bookmarks, { page, note: '', at: new Date().toISOString() }].sort((a, b) => a.page - b.page)
    setBookmarks(next)
    setHasProgressBook(next.length > 0)
    scheduleProgress({ bookmarks: next }, true)
  }, [bookmarks, scheduleProgress])

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

  // Ctrl/Cmd + 滚轮缩放：必须 native 监听 + passive:false —— React 合成 onWheel 是 passive，
  // preventDefault 无效，拦不掉 Chromium 的整页缩放（2026-09-20 反馈：阅读器加 Ctrl+滚轮）。
  // ★ 依赖必须含 loading：挂载时 loading 分支未渲染根 div（rootRef=null），若只依赖 zoomBy
  //   监听将永不挂载 —— Ctrl+滚轮完全失效的根因（ref 时序，React #310 同族）
  useEffect(() => {
    if (loading) return
    const root = rootRef.current
    if (!root) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1)
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [zoomBy, loading, numPages])

  // 外链拦截：官方 annotationLayer 的 <a> 是**真链接**（href=http...），放它走会触发导航/新窗口。
  // 主进程虽有 will-navigate 守卫 + setWindowOpenHandler（都会转 shell.openExternal），
  // 但这里显式接管更确定：失败还能给用户一个反馈。
  useEffect(() => {
    if (loading) return
    const root = rootRef.current
    if (!root) return
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.('.annotationLayer a[href]') as HTMLAnchorElement | null
      if (!a) return
      const href = a.getAttribute('href') ?? ''
      if (!/^https?:\/\//i.test(href)) return // 内部 dest（#…）交给 pdf.js 自己的 onclick
      e.preventDefault()
      e.stopPropagation()
      handlersRef.current.onOpenExternal(href)
    }
    root.addEventListener('click', onClick, true)
    return () => root.removeEventListener('click', onClick, true)
  }, [loading, numPages])

  // ===== 划词 AI 工具条（方案 §6）+ 划选摘录（摘录先行批次）=====
  // （selInfo / translate / closeSelBar 三个声明的位次上提到「划词浮条」段：官方事件桥要读 setSelInfo）
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
    // 页码：从官方页盒的 data-page-number 解析；拿不到就回退当前页
    const page = pageNumberOf(anchorEl) || pageNumRef.current
    // 摘录用：选区矩形归一化到文本层容器（百分比，zoom 无关）；clamp 到 0..1（schema 白名单）
    let rects: ExcerptRect[] | undefined
    const layer = textLayerOf(anchorEl)
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
  }, [])

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
  useEffect(() => { excerptsRef.current = excerpts }, [excerpts])
  useEffect(() => { searchQueryRef.current = searchQuery }, [searchQuery])
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

  const onCreateExcerpt = useCallback((color: ExcerptColor, type: ExcerptType, note?: string) => {
    if (!selInfo) return
    void excerptCreate(rootId, relPath, { kind: 'pdf', text: selInfo.text, page: selInfo.page, rects: selInfo.rects, color, type, note }).catch(() => { /* 创建失败不打扰阅读 */ })
    closeSelBar()
    window.getSelection()?.removeAllRanges()
  }, [rootId, relPath, closeSelBar, selInfo])

  /** 摘录高亮叠加：把摘录 rects（文本层百分比）画进各页 .textLayer（官方结构）。 */
  const applyExcerptOverlays = useCallback(() => {
    const host = containerRef.current
    if (!host) return
    for (const pageEl of host.querySelectorAll<HTMLElement>('.page')) {
      const page = Number(pageEl.dataset.pageNumber)
      paintExcerptOverlays(pageEl.querySelector<HTMLElement>('.textLayer'), page, excerpts)
    }
  }, [excerpts])
  useEffect(() => {
    applyExcerptOverlays()
  }, [applyExcerptOverlays, zoom, viewMode, loading, fitWidth, fitPage, numPages, viewerReady])

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

  /** 讲题（2026-09-21 反馈：阅读器不出题 —— 原 intent='quiz' 分支已整条删除，不留不可达代码） */
  const doAsk = useCallback(() => {
    if (!selInfo) return
    const excerpt = selInfo.text.trim().slice(0, 1200)
    const head = `我正在阅读 PDF《${name}》第 ${selInfo.page} 页，选了下面这段内容：\n\n「${excerpt}」\n\n`
    const question = head + '请讲解这段内容：先讲清涉及的概念/公式，再给一个可操作的例子或推演步骤。'
    // state+props 范式（ISS-2026-09-04-07）：事件只送意图，payload 由 App 落 state 后经 props 下发
    window.dispatchEvent(new CustomEvent('kb-ai-teaching-ask', {
      detail: { question, source: { type: 'pdf', relPath, page: selInfo.page, excerpt } },
    }))
    closeSelBar()
    showToast({ type: 'info', message: '已跳转 AI 教学并带上选段上下文' })
  }, [closeSelBar, name, relPath, selInfo])

  /** 全文搜索：逐页取文本（v1 保留；与渲染层无关，直接走 PDFDocumentProxy） */
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
      if (hits.length) goPage(hits[0].page)
    } finally {
      setSearching(false)
    }
  }, [goPage])

  /** 搜索命中高亮：文本层重建与关键词变化时都要重挂（幂等） */
  useEffect(() => {
    if (loading) return
    const host = containerRef.current
    if (!host) return
    for (const layer of host.querySelectorAll<HTMLElement>('.textLayer')) {
      markSearchMatches(layer, searchQuery)
    }
  }, [searchQuery, pageNum, loading, viewMode])

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

  /**
   * 中键拖动平移（2026-09-20 反馈：放大后要能把页面横向挪动）。
   * 用中键而不是左键，是因为左键要留给划选（摘录/翻译的前提）；等价的键鼠路径还有
   * Shift + 滚轮（浏览器原生横滚）与触控板横向滑动，三者共用同一套 overflow 溢出。
   * 未溢出时 scrollLeft/scrollTop 由浏览器自行夹取，不必额外判空。
   */
  const startPan = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 1) return
    const host = e.currentTarget
    e.preventDefault() // 压掉中键的兼容 mousedown → 不触发 Chromium 自动滚动
    const prevCursor = host.style.cursor
    host.style.cursor = 'grabbing'
    let lx = e.clientX
    let ly = e.clientY
    // capture：指针移到页面之外（甚至工件 iframe 之上）也能继续收到 move
    try { host.setPointerCapture(e.pointerId) } catch { /* 不支持则退回普通监听 */ }
    const move = (ev: PointerEvent) => {
      host.scrollLeft -= ev.clientX - lx
      host.scrollTop -= ev.clientY - ly
      lx = ev.clientX
      ly = ev.clientY
    }
    const end = () => {
      host.style.cursor = prevCursor
      host.removeEventListener('pointermove', move)
      host.removeEventListener('pointerup', end)
      host.removeEventListener('pointercancel', end)
      host.removeEventListener('lostpointercapture', end)
    }
    host.addEventListener('pointermove', move)
    host.addEventListener('pointerup', end)
    host.addEventListener('pointercancel', end)
    host.addEventListener('lostpointercapture', end)
  }, [])

  // 快捷键：PageUp/Down、←→ 翻页、Ctrl+F 搜索、Esc 逐级退出（INPUT 焦点守卫）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (e.key === 'PageDown' || e.key === 'ArrowRight' || (e.key === ' ' && !immersive)) { e.preventDefault(); stepPage(1) }
      else if (e.key === 'PageUp' || e.key === 'ArrowLeft') { e.preventDefault(); stepPage(-1) }
      // 缩放：Ctrl/Cmd + =（放大）/ -（缩小）/ 0（复位整页适配）
      else if ((e.key === '=' || e.key === '+') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); zoomBy(1.2) }
      else if ((e.key === '-' || e.key === '_') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); zoomBy(1 / 1.2) }
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
      goPage(d.page)
    }
    window.addEventListener('kb-pdf-goto-page', on)
    return () => window.removeEventListener('kb-pdf-goto-page', on)
  }, [goPage, relPath])

  // ===== 渲染 =====
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
        <button onClick={() => switchMode('scroll')} title="竖滚模式"
          className={`flex items-center gap-1 px-1.5 py-0.5 ${viewMode === 'scroll' ? 'bg-[var(--bg-hover)] text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)]'}`}>
          <GalleryVertical size={12} /><span className="kb-l2">竖滚</span>
        </button>
        <button onClick={() => switchMode('single')} title="单页模式"
          className={`flex items-center gap-1 border-x border-[var(--border-color)] px-1.5 py-0.5 ${viewMode === 'single' ? 'bg-[var(--bg-hover)] text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)]'}`}>
          <Square size={12} /><span className="kb-l2">单页</span>
        </button>
        <button onClick={() => switchMode('duo')} title="双页模式（需宽 ≥1240px）"
          className={`flex items-center gap-1 px-1.5 py-0.5 ${viewMode === 'duo' ? 'bg-[var(--bg-hover)] text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)]'}`}>
          <Columns2 size={12} /><span className="kb-l2">双页</span>
        </button>
      </div>
      <div className="mx-1 h-4 w-px bg-[var(--border-color)]" />
      <button onClick={() => stepPage(-1)} disabled={pageNum <= 1} title="上一页 (PageUp / ←)"
        className="rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40">
        <ChevronLeft size={15} />
      </button>
      <input
        value={pageNum}
        onChange={(e) => { const n = parseInt(e.target.value, 10); if (!Number.isNaN(n)) goPage(n) }}
        className="w-11 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] px-1 py-0.5 text-center text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
      />
      <span className="kb-l3 text-[var(--text-tertiary)]">/ {numPages}</span>
      <button onClick={() => stepPage(1)} disabled={viewMode !== 'duo' && pageNum >= numPages} title="下一页 (PageDown / →)"
        className="rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40">
        <ChevronRight size={15} />
      </button>
      <div className="mx-1 h-4 w-px bg-[var(--border-color)]" />
      {/* 适配口径二选一（2026-09-18）：整页适配 = 整页完整可见；适合宽度 = 页面宽铺满容器、
          纵向滚动看完整页。放大/缩小会脱离自动适配（fitWidth=false）。 */}
      <button onClick={resetFit} title="适合页面（整页完整可见，Ctrl+0）"
        className={`rounded p-0.5 ${fitWidth && fitPage ? 'text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
        <MaximizeIcon size={14} />
      </button>
      <button onClick={fitToWidth} title="适合宽度（页面宽铺满，纵向滚动）"
        className={`rounded p-0.5 ${fitWidth && !fitPage ? 'text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
        <MoveHorizontal size={14} />
      </button>
      <button onClick={() => zoomBy(1.2)} title="放大 (Ctrl + 滚轮 / Ctrl + =)" className="rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><ZoomIn size={14} /></button>
      <button onClick={() => zoomBy(1 / 1.2)} title="缩小 (Ctrl + 滚轮 / Ctrl + -)" className="rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><ZoomOut size={14} /></button>
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
              <button key={`${h.page}-${i}`} onClick={() => goPage(h.page)}
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
        <button onClick={() => stepPage(-1)} className="rounded p-0.5 hover:bg-[var(--bg-hover)]"><ChevronLeft size={14} /></button>
        <button onClick={() => stepPage(1)} className="rounded p-0.5 hover:bg-[var(--bg-hover)]"><ChevronRight size={14} /></button>
        <div className="mx-1 h-4 w-px bg-[var(--border-color)]" />
        <button onClick={() => zoomBy(1.2)} className="rounded p-0.5 hover:bg-[var(--bg-hover)]"><ZoomIn size={14} /></button>
        <button onClick={() => zoomBy(1 / 1.2)} className="rounded p-0.5 hover:bg-[var(--bg-hover)]"><ZoomOut size={14} /></button>
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

  return (
    <div ref={rootRef} data-sel-float-ignore className={`kb-pdf-scope relative flex h-full min-h-0 flex-col bg-[var(--bg-tertiary)] ${immersive ? 'kb-pdf-scope-immersive' : ''}`}>
      {toolbar}
      {effectiveScan !== 'full' && (
        <div className="shrink-0 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-1 text-[11px] text-[var(--text-tertiary)]" data-wb="scanHint">
          {effectiveScan === 'no'
            ? '本册为扫描版（页面是图片），划选 / 摘录不可用'
            : `本册部分页为扫描件（无文字层），这些页划选 / 摘录不可用${scanPages ? `（共 ${scanPages.filter(Boolean).length} 页）` : ''}`}
        </div>
      )}
      <div className="flex min-h-0 flex-1 items-stretch" style={eyeCare ? { filter: 'sepia(0.32) brightness(0.97) saturate(0.92)' } : undefined}>
        {sidePanel}
        {/* 官方 viewer 的硬要求（PDFViewer 构造时校验）：
            · container 必须是 **绝对定位** 的 DIV；
            · viewer 必须存在且是 DIV（= container.firstElementChild）。
            页面与文本层全部由官方 PDFPageView 生成（.page[data-page-number] > .canvasWrapper/.textLayer）。 */}
        <div className="relative min-h-0 flex-1">
          <div ref={containerRef} onPointerDown={startPan} className="kb-pdf-scroll absolute inset-0 overflow-auto">
            <div ref={viewerElRef} className="pdfViewer" />
          </div>
          {/* 页边悬浮箭头（翻页模式；沉浸时隐藏） */}
          {!immersive && viewMode !== 'scroll' && (
            <>
              <button onClick={() => stepPage(-1)} disabled={pageNum <= 1} title="上一页"
                className="kb-pop absolute left-2 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)]/90 text-[var(--text-secondary)] opacity-60 shadow transition-opacity hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] hover:opacity-100 disabled:opacity-0">
                <ChevronLeft size={17} />
              </button>
              <button onClick={() => stepPage(1)} disabled={viewMode === 'single' && pageNum >= numPages} title="下一页"
                className="kb-pop absolute right-2 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)]/90 text-[var(--text-secondary)] opacity-60 shadow transition-opacity hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] hover:opacity-100 disabled:opacity-0">
                <ChevronRight size={17} />
              </button>
            </>
          )}
          {!viewerReady && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-[12px] text-[var(--text-muted)]">
              <Loader2 size={16} className="animate-spin text-[var(--accent)]" />正在准备阅读器…
            </div>
          )}
        </div>
      </div>
      {immersive && <button onClick={toggleImmersive} title="退出沉浸 (Esc)"
        className="fixed top-3 right-3 z-50 flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)]/90 text-[var(--text-secondary)] shadow hover:text-[var(--text-primary)]"><X size={14} /></button>}
      {floatingBar}
      <TextSelectionBar rect={selInfo?.rect ?? null} translate={translate} onCopy={doCopySel} onTranslate={() => void doTranslateSel()} onAsk={doAsk} onClose={closeSelBar} onCreateExcerpt={selInfo && rootId ? onCreateExcerpt : undefined} />
    </div>
  )
}
