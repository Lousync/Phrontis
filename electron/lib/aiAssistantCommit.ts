/**
 * AI助手写操作岔口（v3.9.0）。
 *
 * vault.* 写工具在**最后一步落盘前**统一调用它：
 *   · `ctx.propose && ctx.sessionId`（AI助手主线）→ 记入 ChangePlan 暂存，返回 staged 结果；
 *   · 其它来源 / 非暂存模式 → 直接执行原落盘逻辑（存量通道行为零改变）。
 *
 * 为什么用岔口而不是复制一套 propose 专用工具：避免逻辑分叉与 schema 膨胀（铁律 16），
 * 也让「同一份校验」在暂存与落盘两侧天然一致。
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
