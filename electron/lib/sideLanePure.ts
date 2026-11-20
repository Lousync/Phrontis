/**
 * AI 教学重构 · 旁问作用域（P0 契约面）
 *
 * 方案：`/home/lousync/桌面/Phrontis-AI教学-技术方案-2026-11-19.md`
 *   §2.11 旁问（AgentSessionRow.sideScope，旧数据按 anchor 读）
 *   §4.5 旁问 IPC（createSideLane 增加 sideScope；conversation 不固化快照）
 *   §6.4 旁问界面（header / badge / 去掉「升格为正式会话」）
 * 决策：内核文档 C8（问 Dito 与支线合并成一个「旁问」两种作用域）、
 *       C9（整段模式每轮重读主对话 24k / 单条 6k + 当前段简报）、
 *       C10（只读：不写回、不出题、不改文件）、C11（旧支线默认 anchor）。
 *
 * 纯函数、零运行时依赖；只允许 `import type` 与纯数据常量。
 * 本文件不读文件、不碰 Electron / DOM。
 *
 * 三档作用域：
 * - `conversation`（问整段对话）：每轮重读主对话，范围宽；
 * - `anchor`（针对这条回答，旧支线）：锚定一条回答，只答那一点，回答必须短；
 * - `selection`（后续）：只解释选中文字。
 */

import type { SideScope } from './aiTeachingTypesPure'
import {
  SIDE_CHAT_MESSAGE_MAX_CHARS,
  SIDE_CHAT_TRANSCRIPT_MAX_CHARS,
} from './aiTeachingTypesPure'

/** 主对话里的一条消息（只取旁问需要的两个字段） */
export interface ConversationMessage {
  role: string
  content: string
}

/* ============================== 作用域归一 ============================== */

/**
 * 归一 `sideScope`：三个合法值原样返回；其余（含 undefined / null / 旧数据）
 * 一律按 `anchor`（C11）。这是旁问唯一的默认值来源。
 */
export function normalizeSideScope(v: unknown): SideScope {
  if (v === 'conversation' || v === 'anchor' || v === 'selection') return v
  return 'anchor'
}

/* ============================== 模式提示 ============================== */

const DISCIPLINE_CONVERSATION = [
  '你是主对话之外的旁问助手。每一轮都重新读取主对话，主对话是这一问的共同背景；',
  '用户说「这个」「刚才」「上面」时，默认指主对话里最近的内容。',
  '只依据主对话与当前段简报回答，不臆造事实。',
  '旁问只读：不写回主对话、不改任何文件、不出题、不修改大纲、不读全局记忆。',
  '回答可以完整，但围绕被问的那一点，不重讲主线。',
  '用户要求记忆或出题时，说明这属于主线的工作，可以整理成引用发回主线。',
].join('')

const DISCIPLINE_ANCHOR = [
  '你是锚定在某一条回答上的旁问助手。',
  '只回答被锚定回答里被追问的那一点，最多三句；不重讲主线、不扩展话题。',
  '旁问只读：不写回主对话、不改任何文件、不出题、不修改大纲、不读全局记忆。',
  '信息不足时直说缺什么，不用推测补齐。',
].join('')

const DISCIPLINE_SELECTION = [
  '你是解释选中文字的旁问助手。',
  '只解释用户选中的这段文字，围绕这一个概念或句子作答；不扩展话题、不重讲主线。',
  '旁问只读：不写回主对话、不改任何文件、不出题、不读全局记忆。',
  '信息不足时直说缺什么，不用推测补齐。',
].join('')

/**
 * 面板 header + 注入 system 的纪律段。
 * `anchor` 的 header 里 `N` 由调用方替换为实际回答序号（如「第 3 条回答」）。
 */
export function sideLaneModePrompt(scope: SideScope): {
  header: string
  discipline: string
} {
  const normalized = normalizeSideScope(scope)

  if (normalized === 'conversation') {
    return {
      header: '已读整段对话',
      discipline: DISCIPLINE_CONVERSATION,
    }
  }
  if (normalized === 'selection') {
    return {
      header: '解释选中文字',
      discipline: DISCIPLINE_SELECTION,
    }
  }
  return {
    header: '锚定：第 N 条回答',
    discipline: DISCIPLINE_ANCHOR,
  }
}

/* ============================== 主对话转录 ============================== */

function copyCount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function roleLabel(role: string): string {
  if (role === 'user') return '学习者'
  if (role === 'assistant') return '导师'
  return role || '未知'
}

/**
 * 把主对话压成旁问可注入的转录文本（C9）。
 *
 * - 从最新往前累计；单条先按 `maxPerMsg`（默认 6000）截断（保留尾部）；
 * - 总量到 `maxTotal`（默认 24000）即停；早于截断点的消息计入 `omitted`；
 * - 输出按时间正序，角色标为「学习者」/「导师」；
 * - 有省略时在开头加一行「（更早的 messages 已省略）」。
 *
 * 纯函数：不修改 `messages`。
 */
export function buildConversationTranscript(
  messages: Array<{ role: string; content: string }>,
  opts?: { maxTotal?: number; maxPerMsg?: number }
): { text: string; omitted: number } {
  const list: ConversationMessage[] = Array.isArray(messages) ? messages : []
  const maxPerMsg = copyCount(opts?.maxPerMsg, SIDE_CHAT_MESSAGE_MAX_CHARS)
  const maxTotal = copyCount(opts?.maxTotal, SIDE_CHAT_TRANSCRIPT_MAX_CHARS)

  const picked: Array<{ role: string; text: string }> = []
  let total = 0
  let omitted = 0
  let stopped = false

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i]
    const raw = typeof item?.content === 'string' ? item.content : ''
    const role = typeof item?.role === 'string' ? item.role : ''
    let piece = raw.length > maxPerMsg ? raw.slice(-maxPerMsg) : raw
    const remaining = maxTotal - total

    if (remaining <= 0) {
      omitted = i + 1
      stopped = true
      break
    }
    if (piece.length > remaining) {
      piece = piece.slice(-remaining)
      if (piece.length > 0) picked.push({ role, text: piece })
      total = maxTotal
      omitted = i
      stopped = true
      break
    }

    if (piece.length > 0) picked.push({ role, text: piece })
    total += piece.length
  }

  if (!stopped) omitted = 0

  const body = picked
    .reverse()
    .map((item) => `${roleLabel(item.role)}：${item.text}`)
    .join('\n\n')

  let text = body
  if (omitted > 0) {
    text = body ? `（更早的 messages 已省略）\n\n${body}` : '（更早的 messages 已省略）'
  }

  return { text, omitted }
}

/**
 * UI 显示「已读约 N 字」用的粗估（**不是** token 估算）。
 * conversation：转录 + 纪律段；anchor / selection：只有纪律段。
 */
export function estimatePromptChars(scope: SideScope, transcript: { text: string }): number {
  const normalized = normalizeSideScope(scope)
  const { discipline } = sideLaneModePrompt(normalized)
  const transcriptChars =
    normalized === 'conversation' && typeof transcript?.text === 'string'
      ? transcript.text.length
      : 0
  return discipline.length + transcriptChars
}
