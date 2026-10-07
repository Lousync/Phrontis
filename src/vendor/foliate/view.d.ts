/**
 * `view.js` 的最小类型面（vendored foliate-js，见同目录 README）。
 *
 * ★ 为什么需要这个文件：`tsconfig.web.json` 没有开 `allowJs`，从 `.tsx` 里
 * `import { View } from '.../view.js'` 会因「模块隐式 any」报 TS7016。TS 对以 `.js`
 * 结尾的说明符会回退解析同名的 `.d.ts`，所以在这里声明即可，**不必**开 allowJs
 * （开了会把整个 foliate 源码拖进类型检查，且它自带 `#private` 字段与 JS 惯用法，噪音极大）。
 *
 * 只声明本应用实际用到的 API —— 不是完整上游 API，加用法时按需补。
 */
import type { Overlayer } from './overlayer.js'

export interface FoliateTOCItem {
  label?: string
  href?: string
  subitems?: FoliateTOCItem[]
  [key: string]: unknown
}

export interface FoliateBook {
  toc?: FoliateTOCItem[]
  metadata?: { title?: string | null; language?: string | null; [key: string]: unknown }
  sections: Array<{ id?: string; cfi?: string; linear?: string; [key: string]: unknown }>
  /** `spread: 'none'` ⇒ 一节一跨页（固定版式单页显示）；拼版规则见 `fixed-layout.js:208-241` */
  rendition?: { layout?: string; spread?: string }
  /** ★ 本仓 patch ⑤（`comic-book.js`）新增：取**页图原始字节**。
   *  上游只有 `getCover()`（第 1 页）与 `section.load()`（包好 `<img>` 的**文档** URL）。
   *  仅 cbz 的 book 有它；未命中条目返回 null。 */
  getPageBlob?(name: string): Promise<Blob | null>
  [key: string]: unknown
}

/** relocate 事件 detail（view.js `#onRelocate`）：进度 + 当前目录项 + CFI */
export interface FoliateRelocateDetail {
  /** 全书进度 0..1（SectionProgress 的 sizeTotal 口径，非当前章节内比例） */
  fraction: number
  cfi: string
  tocItem?: FoliateTOCItem | null
  pageItem?: FoliateTOCItem | null
  range?: Range
  section?: { current: number; total: number }
  location?: { current: number; next: number; total: number }
}

/** 内容文档（同源 blob:，可直读 contentDocument / selection） */
export interface FoliateContent {
  index: number
  /** 分页渲染器挂的高亮层（无注释层时为 null）；`hitTest({x,y})` 按坐标判是否命中已有高亮 */
  overlayer: Overlayer | null
  doc: Document
}

export interface FoliateRenderer {
  setStyles(styles: string | [string, string]): void
  getContents(): FoliateContent[]
  /** ★ 它是 HTMLElement（`view.js:243/246` 的 `document.createElement`）。本仓只用到一个属性：
   *  固定版式的缩放档 —— `fixed-layout.js:35/64-72` 认自身 `zoom`（`'fit-page'|'fit-width'|数字`），
   *  而 `view.js` 全程不转发它，故宿主直接写在 renderer 元素上（无需 vendor patch）。 */
  setAttribute(name: string, value: string): void
  next(distance?: number): Promise<void>
  prev(distance?: number): Promise<void>
  destroy(): void
  remove(): void
}

export class View extends HTMLElement {
  book: FoliateBook | null
  renderer: FoliateRenderer
  lastLocation: FoliateRelocateDetail | null
  isFixedLayout: boolean
  open(book: File | FoliateBook): Promise<void>
  close(): void
  init(opts?: { lastLocation?: string | number | { fraction: number }; showTextStart?: boolean }): Promise<void>
  goTo(target: string | number | { fraction: number }): Promise<unknown>
  goToFraction(fraction: number): Promise<void>
  next(distance?: number): Promise<void>
  prev(distance?: number): Promise<void>
  getCFI(index: number, range?: Range): string
  resolveCFI(cfi: string): { index: number; anchor: (doc: Document) => Range }
  /** ★ 刻意**不**声明 `getContents()`：`View` 本身没有这个方法（内容列表在 `renderer` 上，
   *  见 `view.js:390`）。曾经错声明过，结果把 `view.getContents()` 的 TypeError 藏到运行时
   *  （2026-09-21 探针在点击路径上抓到）。要用请走 `view.renderer.getContents()`。 */
  getSectionFractions(): number[]
  getProgressOf(index: number, range?: Range): { tocItem?: FoliateTOCItem | null; pageItem?: FoliateTOCItem | null }
  getTOCItemOf(target: string | number | { fraction: number }): Promise<FoliateTOCItem | null>
  addAnnotation(annotation: { value: string; [key: string]: unknown }, remove?: boolean): Promise<{ index: number; label: string } | undefined>
  deleteAnnotation(annotation: { value: string; [key: string]: unknown }): Promise<{ index: number; label: string } | undefined>
  deselect(): void
}

export const makeBook: (file: File | string | FileSystemDirectoryHandle) => Promise<FoliateBook>
export class ResponseError extends Error {}
export class NotFoundError extends Error {}
export class UnsupportedTypeError extends Error {}
