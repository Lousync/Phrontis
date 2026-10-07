export function isEditingInput(e: KeyboardEvent): boolean {
  // 合成事件（如程序化 dispatch）的 target 可能是 window 等非元素对象
  const el = e.target instanceof HTMLElement ? e.target : null
  const tag = el?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable === true) return true
  // Monaco editor: don't steal Ctrl+C/X/V/A from the editor
  if (el?.closest('.monaco-editor')) return true
  return false
}

/**
 * 工作台级快捷键（如 Ctrl+B 收展左栏）应优先于宿主透传的元素。
 *
 * 背景（正式版台账 F-9）：`isEditingInput` 是粗粒度闸门，本意是「别抢编辑器里 Ctrl+C/V 类组合键」，
 * 但终端（xterm 常驻隐藏 textarea）与聊天输入框里 **Ctrl+B 没有本地语义**，闸门把它们一并吞了。
 * 这两个宿主显式声明「工作台键优先」：
 *   - 终端：`.xterm` 内（xterm 侧配 attachCustomKeyEventHandler 放行，不再向 shell 发 ^B）；
 *   - 聊天输入区：标 `data-wb-keys` 的元素（ChatBody 文本框）。
 * 返回 true 时，调用方可跳过 isEditingInput 的早退、让工作台快捷键生效。
 * ★ Monaco 刻意不在列（编辑器内组合键语义保持）。
 */
export function allowsWorkbenchShortcut(e: KeyboardEvent): boolean {
  const el = e.target instanceof HTMLElement ? e.target : null
  if (!el) return false
  return Boolean(el.closest('.xterm') || el.closest('[data-wb-keys]'))
}
