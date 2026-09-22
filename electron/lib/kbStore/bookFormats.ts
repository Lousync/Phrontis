/**
 * 书架支持的书籍扩展名（唯一真相源，方案 bookshelf-reader-upgrade-design §S1）。
 *
 * 零依赖纯函数文件 —— 刻意不 import 任何 electron / fs 模块：
 * 契约脚本 `.AGENT/scripts/pdf-reader/verify-reader-formats.mjs` 与
 * `verify-epub-formats.mjs` 用 `node --experimental-strip-types` 直接 import 本文件做用例验证。
 *
 * 一期 = pdf + txt；B 段（二期）加 '.epub'（阶段 1）、'.fb2' | '.fbz'（阶段 2a）；
 * 后续再加 '.cbz'（阶段 2b）与 '.mobi' | '.azw3'（阶段 3）。
 * ★ 加格式的动作 = ① `BOOK_EXTS` 补一项 ② 下面**三张**表各补一行
 *   ③ 同步 `src/types/index.ts` 的 `BookKind` 镜像。**不要**把「扩展名 → 种类」写回
 *   `if / 三元`（一期曾是三元，加第二个非 pdf 格式即静默错判，契约脚本有断言锁）。
 *
 * ★★ `BOOK_MIME_BY_EXT` 为什么必须在这里：vendored foliate 的 `makeBook()` **按 File 的
 *   name/type 分派**（`view.js:13-21`，`isCBZ`/`isFB2`/`isFBZ` 全是大小写敏感的 endsWith），
 *   **不看魔数**。渲染层若自己拼 MIME，就会重演「所有书都叫 xxx.epub」⇒ 裸 fb2 当场
 *   UnsupportedTypeError、fbz 被当 EPUB 解包炸掉。故映射与扩展名同源，渲染层只调用本函数。
 */

export const BOOK_EXTS = ['.pdf', '.txt', '.epub', '.fb2', '.fbz'] as const

export type BookExt = (typeof BOOK_EXTS)[number]
export type BookKind = 'pdf' | 'txt' | 'epub' | 'fb2' | 'fbz'

/** 阅读引擎（决定渲染层挂哪个阅读器；多个格式可共用一个引擎） */
export type BookEngine = 'pdf' | 'txt' | 'foliate'

/** 扩展名 → 书籍种类（唯一分支点，勿在别处再写 if/三元） */
const KIND_BY_EXT: Record<BookExt, BookKind> = {
  '.pdf': 'pdf',
  '.txt': 'txt',
  '.epub': 'epub',
  '.fb2': 'fb2',
  '.fbz': 'fbz',
}

/** 扩展名 → 阅读引擎（foliate 系 = epub / fb2 / fbz，见 src/vendor/foliate/README.md） */
const ENGINE_BY_EXT: Record<BookExt, BookEngine> = {
  '.pdf': 'pdf',
  '.txt': 'txt',
  '.epub': 'foliate',
  '.fb2': 'foliate',
  '.fbz': 'foliate',
}

/** 扩展名 → MIME（★ 喂给 `new File(...)` 的 type，决定 foliate 选哪个解码器，见文件头注） */
const MIME_BY_EXT: Record<BookExt, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.epub': 'application/epub+zip',
  '.fb2': 'application/x-fictionbook+xml',
  '.fbz': 'application/x-zip-compressed-fb2',
}

/** 命中末尾扩展名（不区分大小写）；未收录返回 null */
function matchExt(relPathOrExt: string): BookExt | null {
  const p = String(relPathOrExt ?? '').toLowerCase()
  for (const ext of BOOK_EXTS) {
    if (p.endsWith(ext)) return ext
  }
  return null
}

/** 路径（或裸扩展名）→ 书籍种类；未收录返回 null（调用方跳过，不抛错）。
 *  传入裸扩展名时须带点（`.epub`）；不带点的 `epub` 一律 null —— 免得把 `a.epub` 之外的
 *  字符串意外吞进来。 */
export function bookKindOf(relPath: string): BookKind | null {
  const ext = matchExt(relPath)
  return ext ? KIND_BY_EXT[ext] : null
}

/** 路径（或带点裸扩展名）→ 阅读引擎；未收录返回 null。渲染层据此分发阅读器组件。 */
export function bookEngineOf(relPathOrExt: string): BookEngine | null {
  const ext = matchExt(relPathOrExt)
  return ext ? ENGINE_BY_EXT[ext] : null
}

/** 命中哪个书籍扩展名（带点，均为小写）；未收录返回 null。渲染层构造 File 时用它取真扩展名 */
export function bookExtOf(relPathOrExt: string): BookExt | null {
  return matchExt(relPathOrExt)
}

/** 路径（或带点裸扩展名）→ MIME；未收录返回 null（调用方自行兜底） */
export function bookMimeOf(relPathOrExt: string): string | null {
  const ext = matchExt(relPathOrExt)
  return ext ? MIME_BY_EXT[ext] : null
}

/** 展示名：去掉书籍扩展名（无匹配扩展名时原样返回） */
export function bookDisplayName(relPath: string): string {
  const base = String(relPath ?? '').split('/').pop() ?? ''
  return bookKindOf(base) ? base.replace(/\.[^.]+$/, '') : base
}
