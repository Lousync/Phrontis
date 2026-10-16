/**
 * AI助手变更方案（ChangePlan）与整任务事务（v3.9.0）。
 *
 * 主链路：AI助手会话里所有 vault.* 写操作经 `aiAssistantCommit.commitOrStage` **暂存**为
 * PlanOp，不直接落盘；渲染层拿到方案后逐条确认，`applyPlan` 才真正执行，`rollbackTask`
 * 逆序还原整任务。这样「先预览、后确认、可整任务回滚」在**主进程侧**闭环。
 *
 * 存储：进程内 Map + 落盘 `<vault>/.knowbase/assistant/tasks/<sessionId>.json`（跨重启可回滚）。
 * taskId = sessionId（一个会话同时只有一个在途任务）。
 */

import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { join, relative, dirname } from 'path'
import { getCurrentVault, getVaultKbRoot } from './kbStore/vaultContext'
import {
  resolveSafe, writeWorkspaceFile, renameWorkspacePath, trashWorkspacePath, invalidateIndexIfCurrentVault,
} from './workspaceManager'
import { broadcastDataChanged, broadcast, BROADCAST_CHANNEL } from '../main/windowBus'
import { broadcastTreeRefresh } from './aiTeachingFolders'
import { selectOps, actionForOp, type ChangePlan, type PlanOp, type PlanOpInput, type FsAction } from './aiAssistantPlanPure'

export type { PlanOpKind, PlanOp, ChangePlan, PlanOpInput, FsAction } from './aiAssistantPlanPure'

const memory = new Map<string, ChangePlan>()

function tasksDir(): string | null {
  const kb = getVaultKbRoot()
  return kb ? join(kb, 'assistant', 'tasks') : null
}

function taskFile(taskId: string): string | null {
  const dir = tasksDir()
  return dir ? join(dir, `${taskId}.json`) : null
}

function persist(plan: ChangePlan): void {
  const file = taskFile(plan.taskId)
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(plan, null, 2), 'utf-8')
  } catch { /* 落盘失败不影响内存态 */ }
}

function load(taskId: string): ChangePlan | null {
  if (memory.has(taskId)) return memory.get(taskId)!
  const file = taskFile(taskId)
  if (!file || !existsSync(file)) return null
  try {
    const plan = JSON.parse(readFileSync(file, 'utf-8')) as ChangePlan
    memory.set(taskId, plan)
    return plan
  } catch { return null }
}

/** 暂存一条写操作（propose 模式）。返回 op id。 */
export function stageOp(sessionId: string, input: PlanOpInput): string {
  const now = new Date().toISOString()
  let plan = memory.get(sessionId)
  if (!plan) {
    plan = { taskId: sessionId, sessionId, createdAt: now, updatedAt: now, ops: [] }
    memory.set(sessionId, plan)
  }
  const op: PlanOp = { ...input, id: randomUUID(), status: 'pending' }
  plan.ops.push(op)
  plan.updatedAt = now
  delete plan.appliedAt
  delete plan.rolledBackAt
  persist(plan)
  return op.id
}

export function getPlan(sessionId: string | undefined): ChangePlan | null {
  return sessionId ? load(sessionId) : null
}

function rootPathOrThrow(): { rootPath: string; rootId: string } {
  const cur = getCurrentVault()
  if (!cur || !cur.rootPath) throw new Error('仓库上下文未就绪')
  return { rootPath: cur.rootPath, rootId: cur.rootId }
}

function absOf(rootPath: string, rel: string): string {
  const abs = resolveSafe(rootPath, rel)
  if (!abs) throw new Error(`路径非法或越出仓库: ${rel}`)
  return abs
}

function refresh(rels: string[]): void {
  try {
    for (const rel of rels) {
      broadcast(BROADCAST_CHANNEL.wsExternalChange, { relPath: rel })
      const norm = rel.replace(/\\/g, '/')
      const i = norm.lastIndexOf('/')
      broadcastTreeRefresh(i > 0 ? norm.slice(0, i) : '')
    }
    invalidateIndexIfCurrentVault(getCurrentVault()?.rootId ?? '')
    broadcastDataChanged('knowledge')
  } catch { /* 广播失败不影响落盘 */ }
}

async function runAction(a: FsAction, rootPath: string, rootId: string): Promise<void> {
  switch (a.action) {
    case 'write':
      writeWorkspaceFile(absOf(rootPath, a.relPath), a.content ?? '')
      return
    case 'rename':
      renameWorkspacePath(rootId, a.relPath, a.to ?? '')
      return
    case 'trash':
      await trashWorkspacePath(rootId, a.relPath)
      return
    case 'mkdir':
      mkdirSync(absOf(rootPath, a.relPath), { recursive: true })
      return
  }
}

/** 应用被接受的写操作（按计划顺序）；返回落盘清单 */
export async function applyPlan(sessionId: string, acceptedIds: string[]): Promise<{ applied: number; opIds: string[] }> {
  const plan = load(sessionId)
  if (!plan) throw new Error('没有可应用的变更方案')
  const { rootPath, rootId } = rootPathOrThrow()
  const accepted = new Set(acceptedIds)
  const rels: string[] = []
  const done: string[] = []
  for (const op of plan.ops) {
    if (op.status !== 'pending') continue
    if (!accepted.has(op.id)) { op.status = 'rejected'; continue }
    const action = actionForOp(op, 'apply')
    if (action) await runAction(action, rootPath, rootId)
    op.status = 'applied'
    done.push(op.id)
    rels.push(op.relPath ?? op.to ?? '')
  }
  plan.appliedAt = new Date().toISOString()
  plan.updatedAt = plan.appliedAt
  persist(plan)
  refresh(rels.filter(Boolean))
  return { applied: done.length, opIds: done }
}

/** 整任务回滚：逆序还原所有已应用的操作 */
export async function rollbackTask(sessionId: string): Promise<{ reverted: number }> {
  const plan = load(sessionId)
  if (!plan) throw new Error('没有可回滚的任务')
  const { rootPath, rootId } = rootPathOrThrow()
  const rels: string[] = []
  let n = 0
  for (const op of selectOps(plan.ops, [], 'rollback')) {
    const action = actionForOp(op, 'rollback')
    if (action) await runAction(action, rootPath, rootId)
    op.status = 'rejected'
    rels.push(op.relPath ?? op.to ?? '')
    n++
  }
  plan.rolledBackAt = new Date().toISOString()
  plan.updatedAt = plan.rolledBackAt
  persist(plan)
  refresh(rels.filter(Boolean))
  return { reverted: n }
}

/** 丢弃未应用的方案 */
export function rejectPlan(sessionId: string): void {
  const plan = load(sessionId)
  if (!plan) return
  for (const op of plan.ops) if (op.status === 'pending') op.status = 'rejected'
  plan.updatedAt = new Date().toISOString()
  persist(plan)
}

/** 任务列表（磁盘上有方案的会话），按更新时间倒序 */
export function listTasks(): Array<Pick<ChangePlan, 'taskId' | 'createdAt' | 'updatedAt' | 'appliedAt' | 'rolledBackAt'> & { opCount: number; pendingCount: number }> {
  const dir = tasksDir()
  const out: Array<Pick<ChangePlan, 'taskId' | 'createdAt' | 'updatedAt' | 'appliedAt' | 'rolledBackAt'> & { opCount: number; pendingCount: number }> = []
  if (!dir || !existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const plan = load(name.slice(0, -5))
    if (!plan) continue
    out.push({
      taskId: plan.taskId, createdAt: plan.createdAt, updatedAt: plan.updatedAt,
      appliedAt: plan.appliedAt, rolledBackAt: plan.rolledBackAt,
      opCount: plan.ops.length, pendingCount: plan.ops.filter((o) => o.status === 'pending').length,
    })
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** 供测试 / 路径推导复用的仓库相对路径 */
export function relOf(rootPath: string, abs: string): string {
  return relative(rootPath, abs).replace(/\\/g, '/')
}
