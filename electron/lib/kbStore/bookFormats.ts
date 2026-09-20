/**
 * 书架支持的书籍扩展名（唯一真相源，方案 bookshelf-reader-upgrade-design §S1）。
 *
 * 零依赖纯函数文件 —— 刻意不 import 任何 electron / fs 模块：
 * 契约脚本 `.AGENT/scripts/pdf-reader/verify-reader-formats.mjs` 用
 * `node --experimental-strip-types` 直接 import 本文件做用例验证。
 *
 * 一期 = pdf + txt；二期追加 '.epub' | '.mobi' | '.azw3' | '.fb2' | '.fbz' | '.cbz'
 * （同时补 bookKindOf 分支，二期不许改一期签名）。
 */

export const BOOK_EXTS = ['.pdf', '.txt'] as const

export type BookExt = (typeof BOOK_EXTS)[number]
export type BookKind = 'pdf' | 'txt'

/** 扩展名 → 阅读引擎种类；未收录返回 null（调用方跳过，不抛错） */
export function bookKindOf(relPath: string): BookKind | null {
  const p = String(relPath ?? '').toLowerCase()
  for (const ext of BOOK_EXTS) {
    if (!p.endsWith(ext)) continue
    return ext === '.pdf' ? 'pdf' : 'txt'
  }
  return null
}

/** 展示名：去掉书籍扩展名（无匹配扩展名时原样返回） */
export function bookDisplayName(relPath: string): string {
  const base = String(relPath ?? '').split('/').pop() ?? ''
  return bookKindOf(base) ? base.replace(/\.[^.]+$/, '') : base
}
