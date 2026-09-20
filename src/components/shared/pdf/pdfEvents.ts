/**
 * PDF 阅读器事件常量（零依赖——刻意与 PdfRailPanel / PdfReaderView 分离：
 * 这两个组件都静态拖着 pdfjs，任何模块想监听/派发阅读事件都从本文件 import，
 * 避免「为了拿一个字符串常量把 pdfjs 拖进主包」（Vite 分包铁律 20）。
 */

/** 阅读器 → 左栏：当前页广播（阅读器在 pageNum/viewMode 变化时派发） */
export const KB_PDF_PAGE_CHANGED = 'kb-pdf-page-changed'

/** 左栏 → 阅读器：跳页请求 */
export const KB_PDF_GOTO_PAGE = 'kb-pdf-goto-page'

/** TXT 阅读器 → 右栏阅读侧栏：进度广播（detail: { relPath, kind:'txt', pct }） */
export const KB_READER_STATE_CHANGED = 'kb-reader-state-changed'

/** 右栏摘录面板 → TXT 阅读器：跳段请求（detail: { relPath, paraIndex }） */
export const KB_TXT_GOTO_PARA = 'kb-txt-goto-para'
