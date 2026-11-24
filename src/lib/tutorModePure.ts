/**
 * AI 教学「对话」模式 · 自动路由（纯函数，零运行时依赖）。
 *
 * 规则见 `docs/ai-teaching-tutor-mode-plan.md` §2.2：
 *   solve（有图 / 题目词） > read（有资料且指向这页这段原文） > ask（低信息量短语） > chat
 * 路由只在渲染层发生（`auto` 不发给主进程）；命中结果不弹确认，只写进本轮请求的 `teachMode`。
 *
 * 本文件只允许 `import type`，保证契约脚本 strip 类型后可直接执行。
 */

export type TutorUiMode = 'auto' | 'chat' | 'read' | 'solve' | 'ask'

export interface TutorRouteInput {
  text: string
  /** 本轮带图片（题目照片 / 截图） */
  hasImages: boolean
  /** 右侧查看器有当前资料（PDF / EPUB / TXT / MD） */
  hasMaterial: boolean
  /** 文案指向「这页 / 这段 / 这份资料」（由调用方判定或由 text 关键词兜底） */
  readingQuestion: boolean
}

/** 五档方式的界面文案（默认「自动」） */
export const TUTOR_MODE_LABELS: Record<TutorUiMode, string> = {
  auto: '自动',
  chat: '对话',
  read: '讲解',
  solve: '解题',
  ask: '先问我',
}

/** 题目词：求… / 证明… / 这道题 / 怎么算（避免「请求 / 要求」误伤：求 需在开头或标点/空白后） */
const SOLVE_RE = /(证明|这道题|这题|怎么算|怎么解|求解|求证|求值|求导|求极限|算一下|解一下|答案是多少)|(^|[，。！？；：、\s])求/
/** 资料指向词：这页 / 这段 / 这份资料 / 原文 / 讲解 */
const READ_RE = /(这页|这一页|这段|这一段|这份资料|这个资料|这篇|原文|讲解|这一节|本章)/
/** 低信息量短语（除了这些词几乎没有可执行信息） */
const ASK_RE = /(帮我弄一下|帮我弄|弄一下|搞一下|帮我搞|随便|你看着办|看着办|帮我看看|帮我处理一下|该怎么办|怎么办|这个怎么弄|随便看看)/

/** 自动路由：`auto` → chat / read / solve / ask 四选一（纯函数、可穷举） */
export function resolveTutorMode(input: TutorRouteInput): 'chat' | 'read' | 'solve' | 'ask' {
  const text = String(input?.text ?? '').trim()
  const lower = text.toLowerCase()

  // 0. 空文本 + 无图 → 没有可路由的内容
  if (!text && !input?.hasImages) return 'chat'

  // 1. solve：有图，或出现题目词
  if (input?.hasImages || SOLVE_RE.test(lower)) return 'solve'

  // 2. read：有当前资料，且文案指向这页 / 这段 / 原文（readingQuestion 显式命中同样算）
  if (input?.hasMaterial && (input?.readingQuestion || READ_RE.test(lower))) return 'read'

  // 3. ask：低信息量短语（先用纯短语匹配，避免「帮我看看这页」被误判成 ask）
  if (ASK_RE.test(lower)) return 'ask'

  // 4. 其余：普通对话
  return 'chat'
}
