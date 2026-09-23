/**
 * pdf.js 官方阅读器组件装载器（方案 A：自研渲染池 → 官方 PDFViewer）。
 *
 * ⚠️ 集成要害（读 `pdf_viewer.js` 源码确认，2026-09-21）：
 * `web/pdf_viewer.js` 是 **webpack UMD 包**，它并不打包 pdf.js 本体，而是靠
 *
 *     /* 4 *\/ module.exports = globalThis.pdfjsLib
 *
 * 去拿 PDF API（AnnotationLayer / PixelsPerInch / PromiseCapability ...），并且在
 * `PDFViewer` 构造时校验 `_pdfjsLib.version === viewerVersion`，不一致**直接 throw**。
 * 所以 `globalThis.pdfjsLib` 必须在 viewer 模块**被求值之前**就指向同一份
 * `pdfjs-dist@3.11.174` 的 UMD 构建。
 *
 * `build/pdf.js` 的 UMD 包装本身会顺带 `module.exports = root.pdfjsLib = factory()`，
 * 但求值顺序不该靠运气 —— 本模块用**动态 import**制造一个异步边界：先静态 import pdfjs
 * （求值 → 全局就位），再等 viewer。esbuild 实测：viewer 的 webpack 模块表被原样保留、
 * 具名导出全部可解析，且它唯一的运行时前置就是 DOM（`document.documentElement`）。
 */
import * as pdfjsLib from 'pdfjs-dist'
// 上游样式（.pdfViewer / .page / .textLayer / .annotationLayer）——必须一起引，
// 否则页面盒尺寸、文本层定位、链接热区全部错位。
import 'pdfjs-dist/web/pdf_viewer.css'
// 我方主题适配层（必须在上游之后，见文件内注释）
import './pdfViewerTheme.css'

const g = globalThis as unknown as { pdfjsLib?: unknown }
if (!g.pdfjsLib) {
  // UMD 副作用没生效时的兜底：CJS 互操作下真身是 default（= module.exports）
  g.pdfjsLib = (pdfjsLib as unknown as { default?: unknown }).default ?? pdfjsLib
}

/** 官方 viewer 模块的命名空间类型（PDFViewer / EventBus / ScrollMode / ...） */
export type PdfViewerKit = typeof import('pdfjs-dist/web/pdf_viewer')

let pending: Promise<PdfViewerKit> | null = null

/**
 * 拆掉 viewer 当前文档。官方 viewer **没有 destroy()** —— 按官方 app 的口径，
 * `setDocument(null)` 就是卸载：内部走 `_cancelRendering()` + `_resetView()`（清空 viewer DOM、
 * 回收页视图）。但类型声明只收 `PDFDocumentProxy`、运行期才接受 null，所以在这一处集中断言，
 * 免得每个调用点各写一遍 as。
 *
 * ⚠️ `setDocument(null)` **不碰** `PDFViewer` 构造器里自建的那个内部 `ResizeObserver`
 * （pdf_viewer.js:6003 建、:6021 `observe(this.container)`，全文件找不到任何 `disconnect()`
 * 或 `destroy()`）—— 而活动观察会**拴住**目标容器，目标又被 viewer 引用 ⇒ 每开一次 PDF 就
 * 永久留一整套 viewer 图。补偿手段是第二参 `observers`：宿主用 `withRoCapture` 收下的实例，
 * 在这里逐个断开。**两件事分工不同、都要做**：`setDocument(null)` 清视图，`disconnect()` 断观察。
 *
 * ★ 两件事还要**解耦**：`setDocument(null)` 在 pdfjs 3.11 下可能同步抛（实测见下方注释），
 *   所以本函数先断观察者再清视图，且各自独立 try/catch —— 视图清理失败绝不能连累观察者断开。
 */
export function detachViewerDocument(viewer: unknown, observers?: readonly ResizeObserver[] | null): void {
  // ★ 顺序要害（B-24 收尾实测，2026-09-23）：`setDocument(null)` 在 pdfjs 3.11 下**会同步抛**
  //   （本仓实测 "Cannot read properties of null (reading 'destroy')"）。两件事分工不同，必须解耦：
  //   **先断观察者、再清视图** —— 若按旧序（先 setDocument）来写，一次抛就把 disconnect 整段跳过，
  //   B-24 的补偿当场失效；而上层 try/catch 会把异常吞掉，表象只是「静默继续漏」，极难发现。
  if (observers) {
    for (const ro of observers) {
      // 幂等：重复 disconnect 是合法 no-op；单个失败不该拖累其余实例
      try { ro.disconnect() } catch { /* 忽略 */ }
    }
  }
  const v = viewer as { setDocument?: (doc: unknown) => void } | null | undefined
  // pdfjs 的视图清理可能抛（见上）；观察者已断，这里不该再把异常抛给调用方
  try { v?.setDocument?.(null) } catch { /* 忽略 */ }
}

/**
 * 在 `fn` 的**同步执行窗口**内把 `globalThis.ResizeObserver` 换成捕获版，收集这段时间内
 * `new ResizeObserver(...)` 出来的实例，然后原样还原（try/finally，异常也还原）。
 * 下一次宏/微任务之后构造的实例**收不到** —— 这正是我们要的边界：
 * pdfjs 的 `PDFViewer` 那个内部 RO 全文件只出现在三处（字段初始化 / 构造器 observe / 回调），
 * 即**只可能建在构造期**，所以「只包 `new PDFViewer(...)` 这一句」足够。
 *
 * ★ 若将来升级 pdfjs 后它把 RO 建到构造期之外（比如首次 setDocument 时懒建），这里会**漏收**，
 *   而漏收不报错、只是那件图又留下来了 —— 靠 `probe-ro-noise.mjs` 的「连开 N 次残留恒 0」兜底。
 */
export function withRoCapture<T>(fn: () => T): { result: T; observers: ResizeObserver[] } {
  const g = globalThis as unknown as { ResizeObserver: typeof ResizeObserver }
  const Real = g.ResizeObserver
  const captured: ResizeObserver[] = []
  class CapturingResizeObserver extends Real {
    constructor(cb: ResizeObserverCallback) {
      super(cb)
      captured.push(this)
    }
  }
  g.ResizeObserver = CapturingResizeObserver as unknown as typeof ResizeObserver
  try {
    return { result: fn(), observers: captured }
  } finally {
    g.ResizeObserver = Real
  }
}

/** 装载官方 viewer 模块（同一 Promise 复用；失败不缓存，允许重试） */
export function loadPdfViewerKit(): Promise<PdfViewerKit> {
  pending ??= import('pdfjs-dist/web/pdf_viewer')
    .then((m) => m as unknown as PdfViewerKit)
    .catch((e: unknown) => {
      pending = null
      throw e
    })
  return pending
}
