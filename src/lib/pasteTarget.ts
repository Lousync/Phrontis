/**
 * 粘贴接管判定（共享层，2026-09-20 自编辑器模块上移，随编辑器退役）：
 * 「Ctrl+V 粘贴外部文件进文件树」需要判断剪贴板里是不是文件、以及有没有更该接管的文本接收方。
 *
 * **绝不能写成「`e.target` 在文件树内才接管」**：非可编辑焦点的 target 恒为 BODY，
 * 那样等于永不进分支 —— Ctrl+V 永久静默失效且不报错（`verify-paste-external.mjs` 已把这条钉住）。
 *
 * 纯函数无需每轮重建，effect 依赖数组也不必为它破例。
 */
export function hasTextPasteTarget(e: ClipboardEvent): boolean {
  const t = e.target as Element | null
  if (t && t !== document.body && t !== document.documentElement) return true
  return isTextEditingTarget(document.activeElement)
}

/**
 * 焦点是否落在「能自己接文本」的元素里（判据 ② 的名单部分）。
 */
export function isTextEditingTarget(el: Element | null): boolean {
  if (!el) return false
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  if ((el as HTMLElement).isContentEditable) return true
  return !!el.closest?.('.monaco-editor')
}
