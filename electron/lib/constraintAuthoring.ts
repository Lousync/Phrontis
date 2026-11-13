/**
 * AI教学「分层要求」（CONSTRAINTS.md）写作规范 —— **单一真相源**。
 *
 * 为什么单独一个零 import 文件：契约脚本
 * `.AGENT/scripts/ai-teaching/verify-constraint-authoring.mjs` 要 strip 类型后直接 import 真实常量；
 * `agentService`（常驻提示）与 `builtinTools`（工具契约）都从这里取，
 * 避免两处各写一份字面量后静默漂移。
 *
 * 分配口径（2026-11-13 拍板，方案 A+B）：
 *   · A 段 `CONSTRAINT_AUTHORING_PROMPT` → 常驻提示，管「判定 / 忠实转写 / 去重 / 预算 / 回执」；
 *   · B 段 `CONSTRAINT_AUTHORING_TOOL_RULES` → 工具 description，管「落笔形式 / 内容边界」；
 *   · B 段 `CONSTRAINT_AUTHORING_TEXT_PARAM` → text 参数说明；
 *   · B 段 `CONSTRAINT_LAYER_HINTS` → level 枚举说明（四层各自适合写什么）。
 *
 * 约束：要求层是**每轮注入的规则清单**，不是文章；注入硬上限仍是 12 条 / 1200 字符
 * （见 `scopePrompt.ts`，本文件不改那个上限）。
 */

/** A 段：常驻提示（agentService → constraintsToolHint） */
export const CONSTRAINT_AUTHORING_PROMPT = '写要求时按「规则清单」而非文章：只写用户明确说过的规则，不擅自加码或编造数字/阈值；表述模糊（如「通俗点」「别太长」）时先问一句再写。append 前先用 course.constraints.read 读同层，同义条目不重复；改旧条目先读全文再 replace。目标 ≤8 条、单条 ≤50 字；写完看返回的 items/chars/truncated，超限先压缩。回执写清层、相对路径、条数、字符数。'

/** B 段：工具 description 追加（course.constraints.write） */
export const CONSTRAINT_AUTHORING_TOOL_RULES = '只写条目：一行一条「- 」，动词开头、可判定；不写背景/大纲/教材内容/「以下是要求」类抬头；不写与系统硬边界冲突的条目。'

/** B 段：text 参数说明 */
export const CONSTRAINT_AUTHORING_TEXT_PARAM = 'markdown 条目正文：一行一条「- 」，只写规则，不写说明/大纲/教材内容；单条尽量 ≤50 字。'

/** B 段：四层适用范围（level 枚举说明） */
export const CONSTRAINT_LAYER_HINTS: Record<'global' | 'workspace' | 'unit' | 'segment', string> = {
  global: '所有课程共同遵守（语言/口吻/诚实等跨课程习惯）',
  workspace: '本课程所有会话（教学节奏/难度/例子风格）',
  unit: '本知识点（术语/前置知识/易错点处理）',
  segment: '本次对话（临时要求，优先级最高）',
}
