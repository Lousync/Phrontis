import { collapse } from '../vendor/foliate/epubcfi.js'

/**
 * 书签「同一处」的归一化键（B-22，见 `docs/pending-fixes.md`）。
 *
 * foliate 系的 relocate CFI 是**当前可见文本范围的 range CFI**（形如 `epubcfi(P,start,end)`）：
 * 换字号 / 拉窗口会重新分页，范围两端（尤其 `end`）随之漂移 —— 同一处的 CFI 不再全等，
 * 于是「回到同一处再点书签」会加出第二条。
 *
 * 判「同一处」统一折叠到**范围起点**（vendor `collapse`：range 取 start、点 CFI 原样返回）。
 * ★ 不能只折叠到**父路径**：`epubcfi(/6/6!/4,/2[c3],/12/1:55)` 的父路径是章节容器，
 *   那样等于「整章都算同一处」（见 B-22 的警示）。
 *
 * 存盘仍存**原始 CFI**（`goTo` 跳转语义不变），归一化只用于比较。
 */
export function bookmarkCfiKey(cfi: string | undefined | null): string {
  if (!cfi) return ''
  try {
    return collapse(cfi)
  } catch {
    return cfi
  }
}
