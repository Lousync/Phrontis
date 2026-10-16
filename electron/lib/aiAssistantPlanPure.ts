/**
 * AI助手变更方案（ChangePlan）**纯逻辑**（v3.9.0）。
 *
 * 零依赖独立文件：类型 + 「选哪些 op / 每个 op 正反向该做什么文件动作」的规则，
 * 专为让契约脚本 `node --experimental-strip-types` 直接 import（同 releaseNotes/judge.ts 范式）。
 * 真实落盘（fs / workspaceManager / 广播）在 `aiAssistantPlan.ts`，只调这里选出的动作。
 */

export type PlanOpKind = 'write' | 'edit' | 'rename' | 'trash' | 'mkdir' | 'tag'

export interface PlanOp {
  id: string
  kind: PlanOpKind
  /** write/edit/trash/tag：目标文件；rename：源 */
  relPath?: string
  /** rename 专用：目标路径 */
  to?: string
  /** 变更前内容（null = 文件原本不存在） */
  prev?: string | null
  /** 变更后内容（rename/trash 无） */
  next?: string | null
  status: 'pending' | 'applied' | 'rejected'
}

export interface ChangePlan {
  taskId: string
  sessionId: string
  createdAt: string
  updatedAt: string
  ops: PlanOp[]
  appliedAt?: string
  rolledBackAt?: string
}

/** 暂存输入（无需 id/status，由 stageOp 补齐） */
export type PlanOpInput = Omit<PlanOp, 'id' | 'status'>

/** 一个 op 正/反向对应的原子文件动作（真正执行交给 aiAssistantPlan 的 fs 层） */
export interface FsAction {
  action: 'write' | 'rename' | 'trash' | 'mkdir'
  relPath: string
  /** write 专用：写入内容 */
  content?: string
  /** rename 专用：目标路径 */
  to?: string
}

/**
 * 选出本方向要作用、且顺序正确的 op 列表。
 * - apply：正向；只取 `status==='pending'` 且在 acceptedIds 里的。
 * - rollback：逆序；只取 `status==='applied'` 的（逆序还原才不会被后一 op 覆盖前一 op 的前提）。
 */
export function selectOps(ops: PlanOp[], acceptedIds: string[], mode: 'apply' | 'rollback'): PlanOp[] {
  if (mode === 'apply') {
    const accepted = new Set(acceptedIds)
    return ops.filter((o) => o.status === 'pending' && accepted.has(o.id))
  }
  const out: PlanOp[] = []
  for (let i = ops.length - 1; i >= 0; i--) if (ops[i].status === 'applied') out.push(ops[i])
  return out
}

/** 单个 op 在该方向的文件动作；`null` = 无需文件动作（如 mkdir 回滚不主动删目录、tag 另路处理） */
export function actionForOp(op: PlanOp, mode: 'apply' | 'rollback'): FsAction | null {
  const rel = op.relPath ?? ''
  switch (op.kind) {
    case 'write':
    case 'edit':
      if (mode === 'apply') return { action: 'write', relPath: rel, content: op.next ?? '' }
      // 回滚：文件原本不存在（prev === null）→ 回收；否则写回旧内容
      return op.prev === null
        ? { action: 'trash', relPath: rel }
        : { action: 'write', relPath: rel, content: op.prev ?? '' }
    case 'rename':
      return mode === 'apply'
        ? { action: 'rename', relPath: rel, to: op.to ?? '' }
        : { action: 'rename', relPath: op.to ?? '', to: rel }
    case 'trash':
      return mode === 'apply'
        ? { action: 'trash', relPath: rel }
        : { action: 'write', relPath: rel, content: op.prev ?? '' }
    case 'mkdir':
      return mode === 'apply' ? { action: 'mkdir', relPath: rel } : null
    case 'tag':
      return null
    default:
      return null
  }
}
