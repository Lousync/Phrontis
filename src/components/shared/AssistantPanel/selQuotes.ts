/**
 * 划词引用 —— 数据侧纯函数（渲染配套组件见 QuoteChips.tsx）。
 *
 * 三处宿主共用（引用胶囊 + prepareBody 合并）：
 *   - 悬浮侧栏（AssistantPanel/index.tsx）
 *   - 工作台右栏 docked AI 态（WorkbenchRightPanel.tsx，B-26 补入）
 *   - aiChat 中间标签整页（ChatBody.tsx 的 AiChatTab，正式版台账 F-8 补入）
 *
 * 独立成无 JSX 的 .ts：契约脚本（.AGENT/scripts/assistant-aichat/verify-aichat-f7-f8.mjs）
 * 以 --experimental-strip-types 直接 import 本文件做真函数断言（.tsx 内含 JSX 做不到）。
 * ★ 本文件保持零依赖，别往里加任何 import。
 */

/** 单条引用并入正文时的截断上限（防刷屏） */
export const QUOTE_MAX_CHARS = 600

/**
 * 引用合并进消息正文（各宿主 prepareBody 共用，格式单一真源）：
 * 每条引用一行 markdown 引用块「> 【引用 n】…」，随后接用户输入。
 * 纯函数、不清数据 —— 随发随清由宿主自己做。
 */
export function buildQuotedBody(quotes: string[], raw: string): string {
  const qs = quotes.map(q => q.replace(/\s+/g, ' ').trim()).filter(Boolean)
  if (qs.length === 0) return raw
  return qs
    .map((q, i) => `> 【引用 ${i + 1}】${q.slice(0, QUOTE_MAX_CHARS)}${q.length > QUOTE_MAX_CHARS ? '…' : ''}`)
    .join('\n') + (raw ? `\n\n${raw}` : '')
}
