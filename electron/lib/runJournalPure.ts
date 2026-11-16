/**
 * AI 运行 journal（P1-1）**纯逻辑**。
 *
 * 每次统一助手运行（一条用户消息触发的 Agent 循环）把**直接执行**的文件写操作记进一条 journal，
 * 运行结束后面板上可「撤销本次运行」。先预览（confirm）模式的写操作已经由 ChangePlan 记录、
 * 走「撤销本任务」，不重复记这里。
 *
 * 零依赖独立文件：类型 + 撤销顺序 / 冲突判定 / 保留期选择，专为让契约脚本直接 import
 * （同 `aiAssistantPlanPure.ts` / `releaseNotes/judge.ts` 范式）。真实读写盘在 `runJournal.ts`。
 */

import type { FileCodecMeta } from './aiAssistantPlanPure'
import type { MovePair } from './vaultMovePure'

/** journal 记录的文件操作种类（与 vault 写工具一一对应；mkdir 不参与撤销，不记） */
export type JournalOpKind = 'write' | 'edit' | 'rename' | 'move-batch' | 'trash' | 'write-batch'

/** write-batch 的单文件记录（只留撤销所需：写前内容 + 落盘后指纹） */
export interface JournalWriteEntry {
  relPath: string
  prev: string | null
  nextHash?: string
  codec?: FileCodecMeta
}

export interface JournalOp {
  /** 运行内序号（从 1 递增；快照文件名也用它） */
  seq: number
  kind: JournalOpKind
  /** write/edit/trash/rename：目标文件（rename 为源） */
  relPath?: string
  /** rename：目标路径 */
  to?: string
  /** write/edit：写前内容（null = 文件原本不存在） */
  prev?: string | null
  /** write/edit：落盘后内容指纹（sha256，用于检测运行后是否又被改过） */
  nextHash?: string
  /** write/edit：原文件编码 / 换行 / 权限位 */
  codec?: FileCodecMeta
  /** move-batch：整批移动条目（正向顺序） */
  moves?: MovePair[]
  /** write-batch：整批写入条目（正向顺序；prev=null = 原本不存在） */
  writes?: JournalWriteEntry[]
  /** trash：原文件原始字节快照文件名（相对 `undo/<runId>/`） */
  snapshot?: string
  /** trash：原文件权限位（POSIX；Windows 忽略） */
  mode?: number | null
  /** 已撤销 */
  undone?: boolean
  /** 撤销时的跳过 / 失败原因 */
  error?: string
}

export interface RunJournal {
  version: 1
  runId: string
  sessionId: string
  rootId: string
  startedAt: string
  finishedAt: string
  /** 已整体撤销的时间 */
  undoneAt?: string
  ops: JournalOp[]
}

/** 交给渲染层的最小摘要（不携带 prev/next 正文） */
export interface RunJournalSummary {
  runId: string
  ops: number
}

export interface UndoProbe {
  exists: (rel: string) => boolean
  /** 当前文件内容的 sha256；读不到返回 null */
  hash: (rel: string) => string | null
}

/** 撤销顺序：逆序（后写先撤），已撤销的跳过 */
export function undoOrder(ops: JournalOp[]): JournalOp[] {
  const out: JournalOp[] = []
  for (let i = ops.length - 1; i >= 0; i--) if (!ops[i].undone) out.push(ops[i])
  return out
}

function moveBlocker(moves: MovePair[], probe: UndoProbe): string | null {
  for (const m of moves) {
    if (!probe.exists(m.to)) return `「${m.to}」已不在运行后的位置`
    if (probe.exists(m.from)) return `原位置「${m.from}」已有同名文件`
  }
  return null
}

/**
 * 某一项能不能安全撤销。返回 null = 可以；返回字符串 = 跳过原因（如实告知用户）。
 *
 * 冲突口径（用户拍板）：运行后文件又被改过就**跳过**，绝不覆盖用户后续修改。
 */
function writeBlocker(rel: string, prev: string | null | undefined, nextHash: string | undefined, probe: UndoProbe): string | null {
  if (!rel) return '记录缺少文件路径'
  const exists = probe.exists(rel)
  // 运行前不存在（新建）：撤销 = 移除当前文件，必须确认它仍是本次运行写下的内容
  if (prev === null) {
    if (!exists) return '文件已不在原位置'
    if (!nextHash) return '缺少运行后的内容指纹'
    const h = probe.hash(rel)
    if (!h) return '无法读取当前内容'
    return h === nextHash ? null : '运行后文件已被修改'
  }
  // 运行前已存在：文件若在运行后又被改过 / 删掉 → 跳过（删掉也是用户后续修改，不擅自复活）
  if (!exists) return '文件已被删除'
  if (!nextHash) return '缺少运行后的内容指纹'
  const h = probe.hash(rel)
  if (!h) return '无法读取当前内容'
  return h === nextHash ? null : '运行后文件已被修改'
}

export function undoBlockReason(op: JournalOp, probe: UndoProbe): string | null {
  const rel = op.relPath ?? ''
  switch (op.kind) {
    case 'write':
    case 'edit':
      return writeBlocker(rel, op.prev, op.nextHash, probe)
    case 'write-batch': {
      const writes = op.writes ?? []
      if (writes.length === 0) return '记录缺少文件清单'
      // 整批同进同退：任一条被改过就整批跳过，避免只回滚一半
      for (const w of writes) {
        const blocker = writeBlocker(w.relPath, w.prev, w.nextHash, probe)
        if (blocker) return `「${w.relPath}」${blocker}`
      }
      return null
    }
    case 'rename':
      if (!op.to) return '记录缺少目标路径'
      if (!probe.exists(op.to)) return `「${op.to}」已不在运行后的位置`
      if (probe.exists(rel)) return `原位置「${rel}」已有同名文件`
      return null
    case 'move-batch':
      return moveBlocker(op.moves ?? [], probe)
    case 'trash':
      if (!op.snapshot) return '缺少删除前的快照，无法恢复'
      if (probe.exists(rel)) return `原位置「${rel}」已有同名文件`
      return null
    default:
      return '不支持的操作类型'
  }
}

/** 一项操作在面板上的人类可读标签（撤销回执用） */
export function journalOpLabel(op: JournalOp): string {
  const rel = op.relPath ?? ''
  switch (op.kind) {
    case 'write': return `写入「${rel}」`
    case 'edit': return `编辑「${rel}」`
    case 'rename': return `移动「${rel}」→「${op.to ?? ''}」`
    case 'move-batch': return `批量移动 ${op.moves?.length ?? 0} 项`
    case 'write-batch': return `批量写入 ${op.writes?.length ?? 0} 个文件`
    case 'trash': return `删除「${rel}」`
    default: return rel || '文件操作'
  }
}

export interface RetentionPolicy {
  /** 保留最近多少次运行 */
  keepRuns: number
  /** 保留多少天 */
  keepDays: number
  /** 快照总字节上限 */
  maxBytes: number
}

export interface RetentionEntry {
  runId: string
  finishedAt: string
  /** 该次运行的 journal + 快照目录总字节 */
  bytes: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 选出该清理的 runId（从最旧开始）。
 *
 * 规则：按 finishedAt 倒序保留；超过条数 / 天数 / 总字节任一上限即清理。
 * **最新一次永远保留**（否则刚跑完就撤销不了）。
 */
export function expiredRunIds(entries: RetentionEntry[], policy: RetentionPolicy, nowMs: number): string[] {
  const sorted = entries.slice().sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
  const keepRuns = Math.max(1, Math.floor(policy.keepRuns) || 1)
  const drop: string[] = []
  let keptBytes = 0
  sorted.forEach((entry, idx) => {
    const bytes = Math.max(0, Number(entry.bytes) || 0)
    if (idx === 0) {
      keptBytes += bytes
      return
    }
    const t = Date.parse(entry.finishedAt)
    const ageDays = Number.isFinite(t) ? (nowMs - t) / DAY_MS : Number.POSITIVE_INFINITY
    const tooOld = ageDays > policy.keepDays
    const tooMany = idx >= keepRuns
    const tooBig = keptBytes + bytes > policy.maxBytes
    if (tooOld || tooMany || tooBig) drop.push(entry.runId)
    else keptBytes += bytes
  })
  return drop
}

/** 快照文件名：序号补零 + 原文件名（只保留基名，避免目录穿越） */
export function snapshotFileName(seq: number, relPath: string): string {
  const base = String(relPath ?? '').replace(/\\/g, '/').split('/').pop() || 'file'
  return `${String(Math.max(0, Math.floor(seq))).padStart(4, '0')}-${base}`
}

/** 是否为可撤销的文件操作（mkdir 不记；未知不记） */
export function isJournalableKind(kind: string): kind is JournalOpKind {
  return kind === 'write' || kind === 'edit' || kind === 'rename' || kind === 'move-batch' || kind === 'trash' || kind === 'write-batch'
}
