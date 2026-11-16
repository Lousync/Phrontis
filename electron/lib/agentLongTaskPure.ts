/**
 * 长任务档（P1-5）**纯逻辑**：续跑档位判定 + 注入文案。
 *
 * 背景：常任务的预算（16 轮 / 20 写 / 24k 历史）对「整理整个目录」「跨多篇重构」这类
 * 多步骤任务不够用。与其让用户去设置里逐项调大，不如在**点「继续」时自动升档**：
 * 第一次运行仍按常规预算跑，触顶后用户点继续，续跑及后续续跑都用长任务档
 * （60 轮 / 150 写 / 64k 历史 / 3M token）。
 *
 * 零依赖独立文件：契约脚本 `verify-long-task.mjs` 直接 import。
 */

export type AgentRunProfileId = 'normal' | 'long' | 'long-128k' | 'long-1m'

/** 长任务档的档位 id（与 agentService 的 LOOP_BUDGET_PROFILES 同口径） */
export const LONG_TASK_PROFILE: AgentRunProfileId = 'long'

/**
 * 续跑该用哪个档：
 * - 现场里已经记了长档 → 原样沿用（第二次、第三次「继续」不会掉回常规档）；
 * - AI 教学 → 返回 undefined，交给长资料自动检测（否则会把教学会话按通用长任务档跑）；
 * - 其余（统一助手 / 日程 / 情报）→ 长任务档。
 *
 * @param stored 会话行 `resume.profile`（旧现场没有这个字段）
 * @param source 会话来源（req.source 缺省时按会话行回推）
 */
export function resolveResumeProfile(stored: unknown, source: unknown): AgentRunProfileId | undefined {
  const s = typeof stored === 'string' ? stored : ''
  if (s === 'long' || s === 'long-128k' || s === 'long-1m') return s
  if (source === 'aiTeaching') return undefined
  return LONG_TASK_PROFILE
}

/**
 * 长任务档注入（仅 profileId === 'long' 时进 system）：
 * 告诉模型预算比常规宽，鼓励先规划、批量取证、完成一步更新清单 —— 但不得因此跳步或虚报完成。
 */
export const LONG_TASK_HINT = '\n\n【长任务档】本次运行使用更长的预算（最多 60 轮推理 / 150 次写入 / 64k 历史），适合跨多篇、多步骤的任务。请先用 builtin.plan.todo 列出完整清单再动手；互相独立的读取/检索可以同轮并行；每完成一步就更新清单状态。预算宽不等于可以跳步：仍然只有真正调用工具并拿到成功结果后才能说已完成。'
