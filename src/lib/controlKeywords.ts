/**
 * 控制流关键字 —— highlight.js 只产出 `hljs-keyword`，不区分「分支/循环/异常」与普通关键字。
 * 预览侧由 `rehypeControlKeywords` 补 `hljs-control`，写作面在 highlight 后对 DOM 补同一个类；
 * 两边共用本文件的集合，颜色因此不会漂移。
 *
 * 只收「控制结构」词：return / break / continue / throw / await / async 仍走普通关键字蓝色，
 * 与原型里 `if` 紫色、`async` 蓝色的观感一致。
 */
const CONTROL_KEYWORDS = new Set([
  // JS / TS / Java / C / C# / PHP
  'if', 'else', 'elseif', 'for', 'while', 'do', 'switch', 'case', 'default',
  'try', 'catch', 'finally',
  // Python / Ruby / Lua
  'elif', 'except', 'with', 'unless', 'until', 'rescue', 'ensure', 'repeat',
  // Rust / Kotlin / Swift / Go
  'match', 'when', 'loop', 'guard', 'select', 'fallthrough', 'goto',
])

export function isControlKeyword(text: string): boolean {
  return CONTROL_KEYWORDS.has(String(text ?? '').trim().toLowerCase())
}
