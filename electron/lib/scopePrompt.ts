/**
 * AI教学 · 「分层要求」注入串拼装 —— **零 import 纯函数**（专为契约脚本直接 import）。
 *
 * 方案 `E:\Projects\KnowledgeRecorder\.AGENT\.claude\plans\ai-teaching-flow-v2-impl.md` §五
 * `verify-scope-injection` / §八-1（L2 只补「知识点级要求」这一层 + 分层标注）。
 *
 * 口径（2026-10-17 拍板，全部由本文件的契约脚本锁定）：
 *   · 顺序恒为 **全局 → 工作区 → 知识点 → 课时**（由粗到细，冲突时以更细层为准）；
 *   · 每层带分层标注标题（`■ 层名（…）`），**空层不输出标题行**（零段，不留空壳）；
 *   · 每层独立上限：≤ 12 条（非空行）且 ≤ 1200 字符，超出截断并追加「（已截断）」；
 *   · 四层全空 → 返回空串（零注入，零 token 成本）。
 *
 * 为什么把纯函数单独拿出来：注入串以前是 agentService 里三段内联拼接，顺序与截断都没有
 * 可执行契约（改坏了只是「AI 忽然不听要求」，没有任何报错）。这里剥成零依赖文件后，
 * 契约脚本可以 strip 类型后直接跑真实实现。
 */

/** 每层条数上限（非空行计；超出截断） */
export const SCOPE_LAYER_MAX_ITEMS = 12
/** 每层字符上限（超出截断） */
export const SCOPE_LAYER_MAX_CHARS = 1200
/** 截断标记（追加在被截断的那一层末尾） */
export const SCOPE_TRUNCATED_MARK = '（已截断）'

/** 注入入参：四层的原始文件正文（缺省/空串 = 该层零段） */
export interface ScopePromptParts {
  /** 全局 CONSTRAINTS.md（{AI教学产物根}/CONSTRAINTS.md） */
  global?: string
  /** 工作区 CONSTRAINTS.md（{工作区}/CONSTRAINTS.md） */
  workspace?: string
  /** 知识点级 CONSTRAINTS.md（{工作区}/{章号}·{知识点}/CONSTRAINTS.md，本次新增层） */
  unit?: string
  /** 课时级 CONSTRAINTS.md（存量「课时夹/会话夹」那份，细颗粒最高优先级，**不迁移**） */
  lesson?: string
}

/** 层序与标注（唯一真相源：顺序改动只改这里） */
const LAYERS: Array<{ key: keyof ScopePromptParts; title: string }> = [
  { key: 'global', title: '全局要求（所有工作区、所有会话共同遵守；最粗一层）' },
  { key: 'workspace', title: '工作区要求（本工作区所有会话共同遵守）' },
  { key: 'unit', title: '知识点要求（本知识点＝一个学习单元；覆盖以上两层）' },
  { key: 'lesson', title: '本段要求（本段＝本对话；最细一层，优先级最高）' },
]

/** 注入串抬头（只在至少一层非空时输出） */
const HEADER = '【分层要求（AI教学）】以下要求按「全局 → 工作区 → 知识点 → 本段」由粗到细排列；'
  + '各层叠加生效，某条与更细层冲突时以更细层为准，与用户当下消息冲突时以用户消息为准。'

/**
 * 单层裁剪：先按条数（非空行）截，再按字符数截；任一截断都追加「（已截断）」。
 * 返回 `{ text, truncated }`（text 已去首尾空白、行尾换行已清）。
 */
export function cutScopeLayer(
  text: string,
  maxItems: number = SCOPE_LAYER_MAX_ITEMS,
  maxChars: number = SCOPE_LAYER_MAX_CHARS,
): { text: string; truncated: boolean } {
  const norm = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!norm.trim()) return { text: '', truncated: false }
  const lines = norm.split('\n')
  const kept: string[] = []
  let items = 0
  let truncated = false
  for (const ln of lines) {
    if (!ln.trim()) {
      // 层内空行原样保留（骨架里小节之间就有空行），但不在条数预算内继续堆积尾部空行
      if (kept.length && items > 0 && items < maxItems) kept.push(ln)
      continue
    }
    if (items >= maxItems) { truncated = true; break }
    kept.push(ln)
    items++
  }
  let body = kept.join('\n').replace(/\s+$/, '')
  if (body.length > maxChars) {
    body = body.slice(0, maxChars)
    // 不切半个代理对（emoji 等增补面字符），否则注入串里会出现孤立代理项
    if (/[\uD800-\uDBFF]$/.test(body)) body = body.slice(0, -1)
    body = body.replace(/\s+$/, '')
    truncated = true
  }
  return { text: body, truncated }
}

/**
 * 拼装注入串。四层全空（或全为空白）→ 返回 `''`（零注入）。
 * 每层形状：`■ 层名（标注）\n<正文>[（已截断）]`，层与层之间空一行。
 */
export function buildScopePrompt(parts: ScopePromptParts): string {
  const blocks: string[] = []
  for (const layer of LAYERS) {
    const cut = cutScopeLayer(parts?.[layer.key] ?? '')
    if (!cut.text) continue // 空层不输出标题行
    blocks.push(`■ ${layer.title}\n${cut.text}${cut.truncated ? `\n${SCOPE_TRUNCATED_MARK}` : ''}`)
  }
  if (!blocks.length) return ''
  return `\n\n${HEADER}\n\n${blocks.join('\n\n')}`
}
