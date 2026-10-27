/**
 * 会话大纲摘要（单一真源）。
 *
 * 同一批会话会同时出现在 AI 对话页左栏（`AiChatSidebar`）与 AI 助手模块左栏
 * （`modules/ai-assistant`）—— 两处大纲必须同口径，否则同一条消息在两处显示不同标题。
 *
 * 口径：首行非空文本 → 去掉行首 markdown 标记 → 截 64 字 → 空内容回落「（空）」。
 * 以「——」开头的行通常是 AI 落款，不作为摘要。
 */
export const OUTLINE_SUMMARY_MAX = 64

export function msgSummary(content: string): string {
  const line = content.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('——')) ?? ''
  return line.replace(/^[#>*\-\s`]+/, '').slice(0, OUTLINE_SUMMARY_MAX) || '（空）'
}
