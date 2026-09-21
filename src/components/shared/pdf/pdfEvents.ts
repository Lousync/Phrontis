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

/**
 * 右栏摘录面板 / 左栏目录 → EPUB 阅读器：跳位置请求（detail: { relPath, cfi }）。
 * `cfi` 取 foliate `goTo()` 的任意合法目标 —— 既接受 CFI 串（带界外偏移的
 * `epubcfi(/6/4!/4/2/1:0)` 也行），也接受目录项的 href（`chapter1.xhtml#sec2`）；
 * 值由 foliate 的 `resolveNavigation` 自行判别。字段名保留 cfi 是因为摘录定位是主要用途。
 * 与 KB_TXT_GOTO_PARA 同构：App 侧统一转发，阅读器只关心「是不是给我的书」。
 */
export const KB_EPUB_GOTO_CFI = 'kb-epub-goto-cfi'

/**
 * EPUB 目录项（foliate `book.toc` 的节点形状，上游是裸 JS 对象，此处只取用到的字段）。
 *
 * ★ 放在本文件而**不是** `src/types/index.ts`：它是「阅读器 ↔ 左栏」这一对组件之间的私有载荷，
 * 与事件常量同生共死，放一起才不会两边各写一份（本项目已有「合法 kind 列表被复制三份」的教训）。
 * 本文件保持零依赖 —— 只加类型，不引入任何 import。
 */
export interface EpubTocItem {
  label?: string
  href?: string
  subitems?: EpubTocItem[]
}

/**
 * EPUB 阅读器 → 左栏目录面板：状态广播。
 * detail: `{ relPath, cfi, chapterLabel, chapterHref, toc? }`。
 * `toc` **只在首次/被请求时带**（目录是静态数据，每翻页重发整棵树是纯浪费）；
 * 面板挂载时机晚于阅读器时，用 KB_EPUB_STATE_REQ 主动要一次。
 */
export const KB_EPUB_STATE = 'kb-epub-state'

/** 左栏目录面板 → EPUB 阅读器：请求重发一次状态（含目录树）。detail: `{ relPath }` */
export const KB_EPUB_STATE_REQ = 'kb-epub-state-req'

/**
 * 知识库「读书笔记」页 → 书架：回到摘录原文（detail: { href }，href 形如 `kbloc:<bookKey>#<excerptId>`）。
 *
 * 由 MarkdownPreview 统一拦截 `kbloc:` 链接后派发（**单点拦截**：知识库预览 / 沉浸阅读 / 博客 /
 * AI 侧栏等所有渲染面共用，不必给每个调用方各接一次 onLinkClick）；App 侧监听：解出书 → 打开该书 →
 * 再派发 KB_PDF_GOTO_PAGE / KB_TXT_GOTO_PARA。
 * ⚠️ 必须拦在 MarkdownPreview 内部，否则会落到 `handleLinkClick` 默认分支 →
 * `window.api.openExternal('kbloc:…')` 交给系统（报错且有安全风险）。
 */
export const KB_OPEN_EXCERPT_LOC = 'kb-open-excerpt-loc'
