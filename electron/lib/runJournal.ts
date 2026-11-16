/**
 * AI 运行 journal（P1-1）—— 直接执行模式下记录文件写操作，支持「撤销本次运行」。
 *
 * 存储（随仓库走，点目录不进索引）：
 *   <vault>/.knowbase/agent/journal/<runId>.json   运行日志（write/edit/rename/move-batch/trash）
 *   <vault>/.knowbase/agent/undo/<runId>/          删除前的原始字节快照（按 op 序号命名）
 *
 * 为什么只记「直接执行」：先预览模式的写操作已经进 ChangePlan，由「撤销本任务」负责；
 * 两套记录各管一段，不重复、不互相覆盖。快照保留上限见 `runJournalPure.expiredRunIds`
 * 与设置 `agentRunUndoKeepRuns` / `agentRunUndoKeepDays` / `agentRunUndoMaxMb`。
 */

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { getCurrentVault, getVaultKbRoot } from 'phrontis-core/kbStore/vaultContext'
import { vaultGetCategories, vaultRenameCategory } from 'phrontis-core/kbStore/knowledgeVaultRepo'
import { getSettingReader } from './aiTools'
import {
  resolveSafe, writeWorkspaceFile, writeWorkspaceFileBuffer, renameWorkspacePath,
  trashWorkspacePath, invalidateIndexIfCurrentVault,
} from './workspaceManager'
import { applyMoveBatch } from './aiAssistantPlan'
import { broadcast, broadcastDataChanged, BROADCAST_CHANNEL } from '../main/windowBus'
import { broadcastTreeRefresh } from './aiTeachingFolders'
import type { PlanOpInput, FileCodecMeta } from './aiAssistantPlanPure'
import type { MovePair } from './vaultMovePure'
import {
  expiredRunIds, isJournalableKind, journalOpLabel, snapshotFileName, undoBlockReason, undoOrder,
  type JournalOp, type JournalOpKind, type RetentionEntry, type RetentionPolicy, type RunJournal,
  type RunJournalSummary, type UndoProbe,
} from './runJournalPure'

interface ActiveRun {
  journal: RunJournal
  ops: JournalOp[]
}

/** 进程内当前运行的可写日志（运行结束即落盘并移出内存） */
const active = new Map<string, ActiveRun>()

const RUN_ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const MAX_OPS_PER_RUN = 500

function assertRunId(runId: string): string {
  const id = String(runId ?? '').trim()
  if (!RUN_ID_RE.test(id)) throw new Error('运行标识非法')
  return id
}

function kbRootOrNull(): string | null {
  return getVaultKbRoot()
}

function journalDir(): string | null {
  const kb = kbRootOrNull()
  return kb ? join(kb, 'agent', 'journal') : null
}

function undoRoot(): string | null {
  const kb = kbRootOrNull()
  return kb ? join(kb, 'agent', 'undo') : null
}

function journalFile(runId: string): string | null {
  const dir = journalDir()
  return dir ? join(dir, `${runId}.json`) : null
}

function undoDirOf(runId: string): string | null {
  const root = undoRoot()
  return root ? join(root, runId) : null
}

function sha256Of(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

function activeOrCreate(runId: string, sessionId: string, rootId: string): ActiveRun {
  let entry = active.get(runId)
  if (!entry) {
    const now = new Date().toISOString()
    entry = {
      journal: { version: 1, runId, sessionId, rootId, startedAt: now, finishedAt: now, ops: [] },
      ops: [],
    }
    active.set(runId, entry)
  }
  return entry
}

function persist(journal: RunJournal): boolean {
  const file = journalFile(journal.runId)
  if (!file) return false
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(journal, null, 2), 'utf-8')
    return true
  } catch { return false /* 日志写失败不影响文件操作本身，但不能向界面承诺可撤销 */ }
}

function loadJournal(runId: string): RunJournal | null {
  const entry = active.get(runId)
  if (entry) return { ...entry.journal, ops: entry.ops }
  const file = journalFile(runId)
  if (!file || !existsSync(file)) return null
  try {
    const j = JSON.parse(readFileSync(file, 'utf-8')) as RunJournal
    if (!j || j.version !== 1 || !Array.isArray(j.ops)) return null
    return j
  } catch { return null }
}

function dirBytes(dir: string): number {
  let total = 0
  try {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      try {
        const st = statSync(abs)
        total += st.isDirectory() ? dirBytes(abs) : st.size
      } catch { /* 忽略无法统计的条目 */ }
    }
  } catch { /* 目录不存在 */ }
  return total
}

function retentionPolicy(): RetentionPolicy {
  const read = getSettingReader()
  const num = (key: string, fallback: number): number => {
    const n = Number(read(key))
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  return {
    keepRuns: num('agentRunUndoKeepRuns', 20),
    keepDays: num('agentRunUndoKeepDays', 7),
    maxBytes: num('agentRunUndoMaxMb', 50) * 1024 * 1024,
  }
}

/** 清理超过保留上限的旧运行（最新一次永远保留；失败静默，不影响当前运行） */
export function pruneRunJournals(nowMs = Date.now()): void {
  try {
    const dir = journalDir()
    const undoRootDir = undoRoot()
    if (!dir || !existsSync(dir)) return
    const entries: RetentionEntry[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const runId = name.slice(0, -5)
      const file = join(dir, name)
      let finishedAt = ''
      let bytes = 0
      try {
        const st = statSync(file)
        bytes += st.size
        const j = JSON.parse(readFileSync(file, 'utf-8')) as RunJournal
        finishedAt = String(j?.finishedAt ?? '')
      } catch { continue }
      const undo = undoRootDir ? join(undoRootDir, runId) : ''
      if (undo && existsSync(undo)) bytes += dirBytes(undo)
      entries.push({ runId, finishedAt, bytes })
    }
    for (const runId of expiredRunIds(entries, retentionPolicy(), nowMs)) {
      try { rmSync(join(dir, `${runId}.json`), { force: true }) } catch { /* ignore */ }
      const undo = undoRootDir ? join(undoRootDir, runId) : ''
      if (undo) { try { rmSync(undo, { recursive: true, force: true }) } catch { /* ignore */ } }
    }
  } catch { /* 保留期清理失败不阻塞运行 */ }
}

export interface PendingRunOp {
  runId: string
  op: JournalOp
  /** trash：运行前写下的快照绝对路径（运行失败时删掉，避免留孤儿） */
  snapshotAbs?: string
}

/**
 * 落盘前登记（commitOrStage 调用）。返回 null = 本次不记（mkdir / 非统一助手 / 非直接执行）。
 *
 * trash 必须在这里先快照：`run()` 一执行文件就没了，事后没有内容可救。
 */
export function beginRunOp(runId: string, sessionId: string, input: PlanOpInput): PendingRunOp | null {
  if (!runId || !isJournalableKind(input.kind)) return null
  const cur = getCurrentVault()
  if (!cur?.rootId || !cur.rootPath) return null
  const entry = activeOrCreate(assertRunId(runId), sessionId, cur.rootId)
  if (entry.ops.length >= MAX_OPS_PER_RUN) return null
  const seq = entry.ops.length + 1
  const op: JournalOp = {
    seq,
    kind: input.kind as JournalOpKind,
    relPath: input.relPath ?? undefined,
    to: input.to ?? undefined,
    prev: input.kind === 'write' || input.kind === 'edit' ? input.prev ?? null : undefined,
    codec: input.codec as FileCodecMeta | undefined,
    moves: (input.moves as MovePair[] | undefined)?.map((m) => ({ from: m.from, to: m.to })),
  }
  const pending: PendingRunOp = { runId: assertRunId(runId), op }
  if (op.kind !== 'trash') return pending

  // trash：读原始字节 → 写快照；读不到就不记（撤销时如实说没有快照）
  const rel = op.relPath ?? ''
  const abs = rel ? resolveSafe(cur.rootPath, rel) : null
  if (!abs || !existsSync(abs)) return null
  try {
    if (!statSync(abs).isFile()) return null
    const buf = readFileSync(abs)
    const name = snapshotFileName(seq, rel)
    const dir = undoDirOf(pending.runId)
    if (!dir) return null
    mkdirSync(dir, { recursive: true })
    const snapAbs = join(dir, name)
    writeFileSync(snapAbs, buf)
    op.snapshot = name
    op.mode = statSync(abs).mode & 0o777
    pending.snapshotAbs = snapAbs
    return pending
  } catch {
    return null
  }
}

/**
 * 落盘成功后记账。write/edit 的内容指纹必须在**写完之后**从磁盘读取，
 * 才能覆盖 `writeWorkspaceFile` 的额外处理（如手机笔记 frontmatter updated 钩子）。
 */
export function commitRunOp(pending: PendingRunOp | null): void {
  if (!pending) return
  const entry = active.get(pending.runId)
  if (!entry) return
  const op = pending.op
  if (op.kind === 'write' || op.kind === 'edit') {
    const cur = getCurrentVault()
    const rel = op.relPath ?? ''
    const abs = cur?.rootPath && rel ? resolveSafe(cur.rootPath, rel) : null
    if (!abs || !existsSync(abs)) return
    try { op.nextHash = sha256Of(readFileSync(abs)) } catch { return }
  }
  entry.ops.push(op)
  entry.journal.finishedAt = new Date().toISOString()
}

/** 落盘失败：删掉刚写的快照，不记账 */
export function abortRunOp(pending: PendingRunOp | null): void {
  if (!pending?.snapshotAbs) return
  try { rmSync(pending.snapshotAbs, { force: true }) } catch { /* ignore */ }
}

/**
 * 运行结束：有操作才落盘并做一次保留期清理；返回给渲染层的摘要（无操作 → null）。
 */
export function finishRun(runId: string): RunJournalSummary | null {
  const id = String(runId ?? '')
  const entry = active.get(id)
  active.delete(id)
  if (!entry || entry.ops.length === 0) return null
  const journal: RunJournal = {
    ...entry.journal,
    ops: entry.ops,
    finishedAt: new Date().toISOString(),
  }
  if (!persist(journal)) return null
  pruneRunJournals()
  return { runId: id, ops: entry.ops.length }
}

export interface RunUndoResult {
  ok: boolean
  runId: string
  reverted: number
  skipped: number
  failed: number
  errors: string[]
}

function refresh(rels: string[]): void {
  const rootId = getCurrentVault()?.rootId ?? ''
  try {
    for (const rel of rels) {
      if (!rel) continue
      broadcast(BROADCAST_CHANNEL.wsExternalChange, { relPath: rel })
      const norm = rel.replace(/\\/g, '/')
      const i = norm.lastIndexOf('/')
      broadcastTreeRefresh(i > 0 ? norm.slice(0, i) : '')
    }
    invalidateIndexIfCurrentVault(rootId)
    broadcastDataChanged('knowledge')
  } catch { /* 广播失败不影响恢复结果 */ }
}

function reverseMoves(moves: MovePair[]): MovePair[] {
  return moves.slice().reverse().map((m) => ({ from: m.to, to: m.from }))
}

/**
 * 撤销一次运行：逆序回放。
 *
 * 冲突口径（用户拍板）：运行后文件又被改过 → 跳过并如实告知，绝不覆盖用户后续修改。
 * 目录删除没有快照（P1 先覆盖文件级），记账时就不会产生 trash 快照，这里会跳过。
 */
export async function undoRun(runId: string): Promise<RunUndoResult> {
  const id = String(runId ?? '').trim()
  if (!RUN_ID_RE.test(id)) throw new Error('运行标识非法')
  const journal = loadJournal(id)
  if (!journal) throw new Error('没有可撤销的运行记录（可能已超出保留期）')
  const cur = getCurrentVault()
  if (!cur?.rootId || !cur.rootPath) throw new Error('仓库上下文未就绪')
  if (journal.rootId !== cur.rootId) throw new Error('该次运行属于另一个仓库，无法在当前仓库撤销')
  if (journal.undoneAt) throw new Error('本次运行已经撤销过了')

  const rootPath = cur.rootPath
  const rootId = cur.rootId
  const probe: UndoProbe = {
    exists: (rel) => {
      const abs = resolveSafe(rootPath, rel)
      return !!abs && existsSync(abs)
    },
    hash: (rel) => {
      const abs = resolveSafe(rootPath, rel)
      if (!abs) return null
      try {
        const st = statSync(abs)
        if (!st.isFile()) return null
        return sha256Of(readFileSync(abs))
      } catch { return null }
    },
  }

  const touched: string[] = []
  const errors: string[] = []
  let reverted = 0
  let skipped = 0
  let failed = 0

  for (const op of undoOrder(journal.ops)) {
    const blocker = undoBlockReason(op, probe)
    if (blocker) {
      op.error = blocker
      skipped++
      errors.push(`${journalOpLabel(op)}：${blocker}`)
      continue
    }
    try {
      const rel = op.relPath ?? ''
      if (op.kind === 'write' || op.kind === 'edit') {
        const abs = rel ? resolveSafe(rootPath, rel) : null
        if (!abs) throw new Error(`路径非法: ${rel}`)
        if (op.prev === null) {
          await trashWorkspacePath(rootId, rel)
        } else {
          mkdirSync(dirname(abs), { recursive: true })
          writeWorkspaceFile(abs, op.prev ?? '', {
            encoding: op.codec?.encoding,
            bom: op.codec?.bom,
            eol: op.codec?.eol,
            relPath: rel,
            mode: op.codec?.mode ?? undefined,
          })
        }
        touched.push(rel)
      } else if (op.kind === 'rename') {
        if (!op.to) throw new Error('记录缺少目标路径')
        // 目录纯改名当时走的是分类通道（保住 space / notebook 与排序），撤销也要走回去，
        // 否则文件系统回去了、categories.json 里还留着新名字。
        const toAbs = resolveSafe(rootPath, op.to)
        const isDir = !!toAbs && existsSync(toAbs) && statSync(toAbs).isDirectory()
        const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
        const cat = isDir ? vaultGetCategories().find((c) => norm(String(c.path ?? '')) === norm(op.to!)) : undefined
        if (cat) vaultRenameCategory(cat.id, basename(rel))
        else renameWorkspacePath(rootId, op.to, rel)
        touched.push(rel, op.to)
      } else if (op.kind === 'move-batch') {
        const moves = reverseMoves(op.moves ?? [])
        applyMoveBatch(rootPath, rootId, moves)
        for (const m of moves) touched.push(m.from, m.to)
      } else if (op.kind === 'trash') {
        if (!op.snapshot) throw new Error('缺少删除前的快照')
        const dir = undoDirOf(id)
        const snapAbs = dir ? join(dir, op.snapshot) : ''
        if (!snapAbs || !existsSync(snapAbs)) throw new Error('删除快照已不存在')
        const abs = resolveSafe(rootPath, rel)
        if (!abs) throw new Error(`路径非法: ${rel}`)
        mkdirSync(dirname(abs), { recursive: true })
        writeWorkspaceFileBuffer(abs, readFileSync(snapAbs), op.mode ?? undefined)
        touched.push(rel)
      }
      op.undone = true
      reverted++
    } catch (e) {
      failed++
      op.error = e instanceof Error ? e.message : String(e)
      errors.push(`${journalOpLabel(op)}：${op.error}`)
    }
  }

  // 全部还原成功才标记整体已撤销；有跳过/失败时保留记录，允许用户处理后重试（已撤销的项不会重放）
  if (failed === 0 && skipped === 0) journal.undoneAt = new Date().toISOString()
  persist(journal)
  // 全部撤销成功后清掉字节快照（journal 本身保留，供界面回看/防重复撤销）
  if (failed === 0 && skipped === 0) {
    const dir = undoDirOf(id)
    if (dir) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } }
  }
  refresh(touched)
  return { ok: failed === 0 && skipped === 0, runId: id, reverted, skipped, failed, errors }
}

/** 供设置页 / 契约脚本查看某次运行的记录（不含 prev/next 正文） */
export function getRunJournal(runId: string): RunJournal | null {
  if (!RUN_ID_RE.test(String(runId ?? '').trim())) return null
  return loadJournal(String(runId).trim())
}
