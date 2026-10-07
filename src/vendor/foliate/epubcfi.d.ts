/**
 * `epubcfi.js` 的最小类型面（vendored foliate-js，见同目录 README）。
 *
 * ★ 为什么要 `.d.ts`：与 `view.d.ts` / `overlayer.d.ts` 同理 —— `tsconfig.web.json` 没开
 * `allowJs`，从 `.ts` 里 `import { collapse } from '.../epubcfi.js'` 会报 TS7016「模块隐式 any」；
 * TS 对 `.js` 说明符会回退解析同名 `.d.ts`。
 *
 * 只声明本应用实际用到的 API（书签「同一处」归一化，见 `src/lib/bookmarkCfi.ts` 与
 * `docs/pending-fixes.md` B-22）—— 不是完整上游 API，加用法时按需补。
 */

/** 把范围 CFI 折叠到**起点**（`parent,start,end` → `parent+start`）；点 CFI 原样返回。
 *  实现在 `epubcfi.js` 的同名导出函数。 */
export function collapse(cfi: string, toEnd?: boolean): string
