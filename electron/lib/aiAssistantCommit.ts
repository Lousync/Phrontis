/**
 * 统一 AI 助手写操作岔口（v3.11.0）。
 *
 * vault.* 写工具在**最后一步落盘前**统一调用它：
 *   · `ctx.propose && ctx.sessionId`（先预览模式）→ 记入 ChangePlan 暂存，返回 staged 结果；
 *   · 其它来源 / 非暂存模式 → 直接执行原落盘逻辑（存量通道行为零改变）。
 *
 * 非 vault 的模块写工具由 `aiTools.invokeTool` 的通用暂存层拦截（见 aiAssistantStageable）；
 * 这里只保留需要读取 prev / 计算 diff 的文件操作岔口。
 */

import type { ToolInvokeCtx } from './aiTools'
import { stageOp, type PlanOpInput } from './aiAssistantPlan'

export interface StagedResult {
  ok: true
  staged: true
  opId: string
  kind: string
  path: string
  message: string
}

export function isPropose(ctx?: ToolInvokeCtx): boolean {
  return !!ctx?.propose && !!ctx.sessionId
}

/**
 * 暂存或执行。`makeOp` 只在 propose 模式下求值（避免无谓读盘）；
 * `run` 是原落盘逻辑，非 propose 时原样执行。
 */
export async function commitOrStage<R>(
  ctx: ToolInvokeCtx | undefined,
  makeOp: () => PlanOpInput,
  run: () => R | Promise<R>,
): Promise<R | StagedResult> {
  if (isPropose(ctx)) {
    const op = makeOp()
    const opId = stageOp(ctx!.sessionId as string, op)
    return {
      ok: true,
      staged: true,
      opId,
      kind: op.kind,
      path: op.relPath ?? op.to ?? '',
      message: '已记入变更方案（尚未落盘，等用户确认后应用）',
    }
  }
  return run()
}
