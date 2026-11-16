/**
 * AI助手变更方案（ChangePlan）**纯逻辑**（v3.9.0）。
 *
 * 零依赖独立文件：类型 + 「选哪些 op / 每个 op 正反向该做什么文件动作」的规则，
 * 专为让契约脚本 `node --experimental-strip-types` 直接 import（同 releaseNotes/judge.ts 范式）。
 * 真实落盘（fs / workspaceManager / 广播）在 `aiAssistantPlan.ts`，只调这里选出的动作。
 */

import type { MovePair } from './vaultMovePure'

export type PlanOpKind = 'write' | 'edit' | 'rename' | 'trash' | 'mkdir' | 'tag' | 'tool' | 'move-batch' | 'write-batch'

/**
 * 文件编码元信息（P0-A §3.2）：暂存 / 回滚都要按**原文件的编码与换行**写回，
 * 否则确认模式「应用」一次就把 UTF-16 / CRLF 文件写坏，还看不出是谁干的。
 */
export interface FileCodecMeta {
  encoding?: 'utf-8' | 'utf-16le' | 'utf-16be'
  bom?: boolean
  eol?: '\n' | '\r\n'
  /** POSIX 权限位（回滚恢复可执行位） */
  mode?: number | null
}

/**
 * 批量写入的单文件记录（P1-7）：一份 op 里带多个文件的 before/after，
 * 应用正向写 `next`、回滚反向写 `prev`（prev=null = 该文件原本不存在，回滚要移除）。
 */
export interface PlanWriteEntry {
  relPath: string
  prev: string | null
  next: string
  codec?: FileCodecMeta
  /** 运行 journal 用：落盘后内容指纹（仅 journal 填） */
  nextHash?: string
}

/** 回滚方向：逆序 + 反向（与 vaultMovePure.reverseMoves 同口径；此处内联避免纯模块运行时互引） */
function reversePairs(moves: MovePair[]): MovePair[] {
  return moves.slice().reverse().map((m) => ({ from: m.to, to: m.from }))
}

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
  /** write/edit：原文件编码 / 换行 / 权限位（应用与回滚都按它写回） */
  codec?: FileCodecMeta
  /** kind='tool'：工具注册名（如 builtin.knowledge.create-page） */
  tool?: string
  /** kind='tool'：所属模块 */
  module?: string
  /** kind='tool'：调用参数（应用时按原样重放） */
  args?: Record<string, unknown>
  /** kind='tool'：给用户看的结构化摘要 */
  summary?: string
  /** kind='tool'：暂存阶段返回的临时 id（后续参数可引用，应用时替换） */
  tempId?: string
  /** kind='move-batch'：整批移动条目（已解析成 from/to 文件路径） */
  moves?: MovePair[]
  /** kind='write-batch'：整批写入条目（应用正向写 next，回滚反向写 prev） */
  writes?: PlanWriteEntry[]
  /** 应用后工具返回的原始结果（用于临时 id 映射与回滚提示） */
  result?: unknown
  /** 应用失败原因（status='failed'；失败项不再作为 pending 重放） */
  error?: string
  status: 'pending' | 'applied' | 'rejected' | 'failed'
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

/**
 * 方案卡上的人类可读摘要（v3.15.2）。
 *
 * 此前通用暂存层直接贴 `JSON.stringify(args)` 的前 200 字：英文参数名 + `\n` 转义，
 * 用户看不出「到底要建什么」。这里按工具做最小结构化，未知工具再回退到 JSON。
 */
export function summarizeToolOp(name: string, args: Record<string, unknown>): string {
  const s = (k: string): string => (typeof args[k] === 'string' ? String(args[k]).trim() : '')
  const firstLine = (text: string, max = 60): string => {
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat.length > max ? `${flat.slice(0, max)}…` : flat
  }
  const target = s('categoryPath') || s('categoryName') || '未分类'
  switch (name) {
    case 'builtin.knowledge.create-page': {
      const title = s('title') || '未命名页面'
      const body = s('contentMd')
      const preview = firstLine(body)
      return `新建知识页《${title}》· 目标 ${target} · 正文 ${body.length} 字${preview ? ` · ${preview}` : ''}`
    }
    case 'builtin.blog.create-entry': {
      const body = s('contentMd')
      return `${s('date') || '今天'} 的日记 · 正文 ${body.length} 字${body ? ` · ${firstLine(body)}` : ''}`
    }
    case 'builtin.quiz.gen-paper':
      return `组卷《${s('title') || '练习页'}》· 目标 ${target}`
    default: {
      let json: string
      try { json = JSON.stringify(args ?? {}) } catch { json = String(args) }
      return json.length > 200 ? `${json.slice(0, 200)}…` : json
    }
  }
}

/** 一个 op 正/反向对应的原子文件动作（真正执行交给 aiAssistantPlan 的 fs 层） */
export interface WriteBatchActionEntry {
  relPath: string
  /** 本方向要写入的内容；null = 该方向应移除这个文件 */
  content: string | null
  /** 本条失败时回到执行前的内容；null = 移除 */
  inverse: string | null
  codec?: FileCodecMeta
}

export interface FsAction {
  action: 'write' | 'rename' | 'trash' | 'mkdir' | 'move-batch' | 'write-batch'
  relPath: string
  /** write 专用：写入内容 */
  content?: string
  /** write 专用：编码 / 换行 / 权限位（缺省 = UTF-8 + LF + 不恢复 mode） */
  codec?: FileCodecMeta
  /** rename 专用：目标路径 */
  to?: string
  /** move-batch 专用：整批条目（回滚方向已逆序反向） */
  moves?: MovePair[]
  /** write-batch 专用：整批写入条目（回滚方向已逆序，content=prev） */
  writes?: WriteBatchActionEntry[]
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
      if (mode === 'apply') return { action: 'write', relPath: rel, content: op.next ?? '', codec: op.codec }
      // 回滚：文件原本不存在（prev === null）→ 回收；否则写回旧内容
      return op.prev === null
        ? { action: 'trash', relPath: rel }
        : { action: 'write', relPath: rel, content: op.prev ?? '', codec: op.codec }
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
    case 'move-batch': {
      const moves = op.moves ?? []
      return {
        action: 'move-batch',
        relPath: moves[0]?.from ?? rel,
        moves: mode === 'apply' ? moves : reversePairs(moves),
      }
    }
    case 'write-batch': {
      const writes = op.writes ?? []
      // 回滚方向：逆序 + 反向（prev=null = 原本不存在，回滚时移除）
      return mode === 'apply'
        ? {
            action: 'write-batch',
            relPath: writes[0]?.relPath ?? rel,
            writes: writes.map((w) => ({ relPath: w.relPath, content: w.next, inverse: w.prev, codec: w.codec })),
          }
        : {
            action: 'write-batch',
            relPath: writes[writes.length - 1]?.relPath ?? rel,
            writes: writes.slice().reverse().map((w) => ({ relPath: w.relPath, content: w.prev, inverse: w.next, codec: w.codec })),
          }
    }
    case 'tag':
      return null
    case 'tool':
      // 工具类变更由 aiAssistantPlan 按计划顺序重放工具调用，不产生文件动作
      return null
    default:
      return null
  }
}
