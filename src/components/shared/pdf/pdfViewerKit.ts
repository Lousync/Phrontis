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
 */
export function detachViewerDocument(viewer: unknown): void {
  const v = viewer as { setDocument?: (doc: unknown) => void } | null | undefined
  v?.setDocument?.(null)
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
