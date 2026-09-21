/**
 * 书架支持的书籍扩展名（唯一真相源，方案 bookshelf-reader-upgrade-design §S1）。
 *
 * 零依赖纯函数文件 —— 刻意不 import 任何 electron / fs 模块：
 * 契约脚本 `.AGENT/scripts/pdf-reader/verify-reader-formats.mjs` 与
 * `verify-epub-formats.mjs` 用 `node --experimental-strip-types` 直接 import 本文件做用例验证。
 *
 * 一期 = pdf + txt；B 段（二期）加 '.epub'；后续再加 '.fb2' | '.fbz' | '.cbz' | '.mobi' | '.azw3'。
 * ★ 加格式的动作 = ① `BOOK_EXTS` 补一项 ② 下面两张表各补一行 ③ 同步 `src/types/index.ts` 的
 *   `BookKind` 镜像。**不要**把「扩展名 → 种类」写回 `if / 三元`（一期曾是三元，加第二个非 pdf
 *   格式即静默错判，契约脚本有断言锁）。
 */

export const BOOK_EXTS = ['.pdf', '.txt', '.epub'] as const

export type BookExt = (typeof BOOK_EXTS)[number]
export type BookKind = 'pdf' | 'txt' | 'epub'

/** 阅读引擎（决定渲染层挂哪个阅读器；多个格式可共用一个引擎） */
export type BookEngine = 'pdf' | 'txt' | 'foliate'

/** 扩展名 → 书籍种类（唯一分支点，勿在别处再写 if/三元） */
const KIND_BY_EXT: Record<BookExt, BookKind> = {
  '.pdf': 'pdf',
  '.txt': 'txt',
  '.epub': 'epub',
}

/** 扩展名 → 阅读引擎（epub 系走 vendored foliate，见 src/vendor/foliate/README.md） */
const ENGINE_BY_EXT: Record<BookExt, BookEngine> = {
  '.pdf': 'pdf',
  '.txt': 'txt',
  '.epub': 'foliate',
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

/** 展示名：去掉书籍扩展名（无匹配扩展名时原样返回） */
export function bookDisplayName(relPath: string): string {
  const base = String(relPath ?? '').split('/').pop() ?? ''
  return bookKindOf(base) ? base.replace(/\.[^.]+$/, '') : base
}
