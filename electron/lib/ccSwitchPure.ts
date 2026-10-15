/**
 * CCswitch 导入 · 供应商类型判定（纯函数，零依赖——专供契约脚本 import）。
 *
 * ★ 修复（2026-10-11，用户报障）：原实现只按 URL 猜类型，导致 `app_type=claude` 的条目
 *   （Anthropic 协议端点）被误判成 `openai-compatible`。当该端点 URL 不含 "anthropic" 字样
 *   （如 `https://opencode.ai/zen/go`）时，请求会被打到 `{baseUrl}/chat/completions`
 *   （缺 `/v1`）→ HTTP 404。正确做法：`claude / claude-desktop` 一律判为 `anthropic`
 *   （anthropic 适配器自会补 `/v1/messages`）。
 */

export type CcSwitchProviderType = 'openai-compatible' | 'ollama' | 'anthropic'

/** URL 推断（保留原 inferType 语义）：localhost → ollama；含 anthropic → anthropic；否则 openai-compatible */
export function inferTypeFromUrl(baseUrl: string): CcSwitchProviderType {
  let host = ''
  try { host = new URL(baseUrl).hostname } catch { /* ignore */ }
  if (host === 'localhost' || host === '127.0.0.1') return 'ollama'
  if (/anthropic/i.test(baseUrl)) return 'anthropic'
  return 'openai-compatible'
}

/** CCswitch 条目 → 本应用供应商类型（app_type 优先，其次按 URL 推断）。 */
export function ccSwitchProviderType(appType: string, baseUrl: string): CcSwitchProviderType {
  const a = String(appType ?? '')
  if (a === 'claude' || a === 'claude-desktop') return 'anthropic'
  return inferTypeFromUrl(baseUrl)
}
