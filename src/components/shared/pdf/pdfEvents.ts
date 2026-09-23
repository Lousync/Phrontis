/**
 * PDF 阅读器事件常量（零依赖——刻意与 PdfRailPanel / PdfReaderView 分离：
 * 这两个组件都静态拖着 pdfjs，任何模块想监听/派发阅读事件都从本文件 import，
 * 避免「为了拿一个字符串常量把 pdfjs 拖进主包」（Vite 分包铁律 20）。
 */

/** 阅读器 → 左栏：当前页广播（阅读器在 pageNum/viewMode 变化时派发） */
export const KB_PDF_PAGE_CHANGED = 'kb-pdf-page-changed'

/** 左栏 → 阅读器：跳页请求 */
export const KB_PDF_GOTO_PAGE = 'kb-pdf-goto-page'

/**
 * 右栏阅读侧栏 → 阅读器：**删除一条书签**（detail: `{ relPath, id }`）。
 *
 * ★ 为什么必须回派给阅读器、而不是右栏直接 patch：三个阅读器把书签存在**内存权威数组**里
 *   （`EpubReaderView.bkmRef` / `TxtReaderView.bkmRef` / `PdfReaderView.bookmarks`），而「加书签」
 *   是**整数组覆盖写**；三者又都不监听 readerState/pdfReader 去刷新书签。
 *   ⇒ 右栏若直接写盘，阅读器内存里的旧数组会在用户下一次加书签时把删掉的条目**写回去**（静默复活）。
 *   回派后由阅读器用自己的 ref + `patchReader`（含 expectedUpdatedAt 冲突重试）执行，内存与磁盘始终一致。
 *
 * `id` 口径：readerState 系（txt / foliate）用 `BookBookmark.id`；pdf 用 `String(page)`（PDF 书签身份即页码）。
 */
export const KB_BOOKMARK_DELETE = 'kb-bookmark-delete'

/** TXT 阅读器 → 右栏阅读侧栏：进度广播（detail: { relPath, kind:'txt', pct }） */
export const KB_READER_STATE_CHANGED = 'kb-reader-state-changed'

/** 右栏摘录面板 → TXT 阅读器：跳段请求（detail: { relPath, paraIndex }） */
export const KB_TXT_GOTO_PARA = 'kb-txt-goto-para'

/**
 * 右栏摘录面板 / 左栏目录 → foliate 系阅读器：跳位置请求（detail: { relPath, cfi }）。
 * `cfi` 取 foliate `goTo()` 的任意合法目标 —— 既接受 CFI 串（带界外偏移的
 * `epubcfi(/6/4!/4/2/1:0)` 也行），也接受目录项的 href（`chapter1.xhtml#sec2`）；
 * 值由 foliate 的 `resolveNavigation` 自行判别。字段名保留 cfi 是因为摘录定位是主要用途。
 * 与 KB_TXT_GOTO_PARA 同构：App 侧统一转发，阅读器只关心「是不是给我的书」。
 *
 * ★ `KB_EPUB_*` / `EpubTocItem` 是**引擎系**命名（foliate 引擎 = epub + fb2 + fbz，见
 *   `bookFormats.ENGINE_BY_EXT`），**不是格式限定** —— 阶段 2a 起 fb2 / fbz 复用同一套事件。
 *   名字里的 EPUB 是历史遗留（先有的 epub），改名的收益 < 全仓 diff 的风险，故冻结不改。
 */
export const KB_EPUB_GOTO_CFI = 'kb-epub-goto-cfi'

/**
 * 目录项（foliate `book.toc` 的节点形状，上游是裸 JS 对象，此处只取用到的字段）。
 * 同上是引擎系命名：epub / fb2 / fbz 三种格式的目录都走这个形状（FB2 的 label 更粗，
 * 只到 section 级 —— 上游 `fb2.js` 的 `book.toc` 就这么给的，不是本仓的取舍）。
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
 * foliate 系阅读器 → 左栏目录面板：状态广播。
 * detail: `{ relPath, cfi, chapterLabel, chapterHref, toc? }`。
 * `toc` **只在首次/被请求时带**（目录是静态数据，每翻页重发整棵树是纯浪费）；
 * 面板挂载时机晚于阅读器时，用 KB_EPUB_STATE_REQ 主动要一次。
 */
export const KB_EPUB_STATE = 'kb-epub-state'

/** 左栏目录面板 → foliate 系阅读器：请求重发一次状态（含目录树）。detail: `{ relPath }` */
export const KB_EPUB_STATE_REQ = 'kb-epub-state-req'

/**
 * 左栏缩略图网格（cbz）→ 阅读器：**按需**要一段页的缩略图。detail: `{ relPath, from, to }`（闭区间）。
 *
 * 方向刻意是「面板要 → 阅读器给」而不是阅读器主动全推：生成缩略图要解压页图 + 解码 + 画布，
 * 都在主线程（`view.js:26` 的 `configure({ useWebWorkers: false })` 让 zip 解包也在这里）。
 * 反向的话，没人看网格时也在烧 CPU，直接砸阅读体验。
 */
export const KB_CBZ_THUMB_REQ = 'kb-cbz-thumb-req'

/**
 * 阅读器 → 左栏缩略图网格：缩略图回广播。detail: `{ relPath, from, items }`。
 * `items[i]` 对应第 `from + i` 页，三种取值各有含义、**不可合并**：
 * - `string` —— data URL，可显示；
 * - `null` —— 这一页**生成失败**（解码器不认的格式等），保持占位即可，不会再有后续；
 * - `undefined` —— **还在队列里**，稍后会单独补一条同 index 的回广播（同一 index 迟到者可覆盖）。
 */
export const KB_CBZ_THUMBS = 'kb-cbz-thumbs'

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
