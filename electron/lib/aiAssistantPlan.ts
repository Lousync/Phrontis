/**
 * AI助手变更方案（ChangePlan）与整任务事务（v3.9.0）。
 *
 * 主链路：统一助手「先预览」下，文件写操作经 `aiAssistantCommit.commitOrStage`、模块写工具经
 * `aiTools` 的通用暂存层记入 PlanOp，不直接落盘；渲染层拿到方案后逐条确认，`applyPlan` 才真正执行。
 * `rollbackTask` 逆序还原文件操作；模块工具写入目前没有统一逆操作，会跳过并计入 skipped。
 *
 * 存储：进程内 Map + 落盘 `<vault>/.knowbase/assistant/tasks/<sessionId>.json`（跨重启可回滚）。
 * taskId = sessionId（一个会话同时只有一个在途任务）。
 */

import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { join, relative, dirname } from 'path'
import { getCurrentVault, getVaultKbRoot } from 'phrontis-core/kbStore/vaultContext'
import {
  resolveSafe, writeWorkspaceFile, renameWorkspacePath, trashWorkspacePath, invalidateIndexIfCurrentVault,
} from './workspaceManager'
import { broadcastDataChanged, broadcast, BROADCAST_CHANNEL } from '../main/windowBus'
import { broadcastTreeRefresh } from './aiTeachingFolders'
import { appendAgentMessage, sessionExists } from './agentSessionRepo'
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

function replaceTempIds(value: unknown, resolved: Map<string, string>): unknown {
  if (typeof value === 'string') return resolved.get(value) ?? value
  if (Array.isArray(value)) return value.map((v) => replaceTempIds(v, resolved))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = replaceTempIds(v, resolved)
    return out
  }
  return value
}

function resultIdOf(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const d = data as Record<string, unknown>
  for (const key of ['id', 'pageId', 'entryId', 'recordId', 'habitId']) {
    const v = d[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  return ''
}

/**
 * 应用被接受的写操作（按计划顺序）；返回落盘清单。
 *
 * `kind='tool'` 的 op 通过动态 import 重放工具调用（避免 aiTools ↔ aiAssistantPlan 静态环）。
 * 工具返回的 id 会登记为临时 id：同一计划里后续参数引用暂存时拿到的 opId，可在此替换成真实 id。
 */
export interface PlanFailure {
  id: string
  tool?: string
  summary?: string
  error: string
}

/**
 * 应用被接受的写操作（按计划顺序）；返回落盘清单与失败项。
 *
 * `kind='tool'` 的 op 通过动态 import 重放工具调用（避免 aiTools ↔ aiAssistantPlan 静态环）。
 * 工具返回的 id 会登记为临时 id：同一计划里后续参数引用暂存时拿到的 opId，可在此替换成真实 id。
 *
 * v3.15.2：失败不再只抛给渲染层 ——
 *   · 失败 op 标 `failed` + `error`（不再留在 pending 里反复重放）；
 *   · `appliedAt` 只在真的应用成功过时写（此前 0 成功也会写）；
 *   · 失败摘要以 assistant 消息写回会话，下一轮模型能看到并自我修正。
 */
export async function applyPlan(
  sessionId: string,
  acceptedIds: string[],
): Promise<{ applied: number; opIds: string[]; failures: PlanFailure[] }> {
  const plan = load(sessionId)
  if (!plan) throw new Error('没有可应用的变更方案')
  const { rootPath, rootId } = rootPathOrThrow()
  const accepted = new Set(acceptedIds)
  const rels: string[] = []
  const done: string[] = []
  const failures: PlanFailure[] = []
  const resolved = new Map<string, string>()
  try {
    for (const op of plan.ops) {
      if (op.status !== 'pending') continue
      if (!accepted.has(op.id)) { op.status = 'rejected'; continue }
      try {
        if (op.kind === 'tool') {
          if (!op.tool) throw new Error('变更方案缺少工具名')
          const { invokeToolInternal } = await import('./aiTools')
          const args = replaceTempIds(op.args ?? {}, resolved) as Record<string, unknown>
          const exec = await invokeToolInternal(op.tool, args, '', {
            sessionId,
            source: 'assistant',
            apply: true,
            unifiedAssistant: true,
          })
          if (!exec.ok) throw new Error(exec.message)
          op.result = exec.data
          const resultId = resultIdOf(exec.data)
          if (resultId) resolved.set(op.id, resultId)
          // 工具若返回文件路径，纳入刷新清单（模块工具自己会广播）
          if (exec.data && typeof exec.data === 'object') {
            const d = exec.data as Record<string, unknown>
            const p = String(d.path ?? d.relPath ?? '').trim()
            if (p) rels.push(p)
          }
        } else {
          const action = actionForOp(op, 'apply')
          if (action) await runAction(action, rootPath, rootId)
          rels.push(op.relPath ?? op.to ?? '')
        }
        op.status = 'applied'
        delete op.error
        done.push(op.id)
      } catch (err) {
        const msg = String((err as Error)?.message ?? err)
        op.status = 'failed'
        op.error = msg
        failures.push({ id: op.id, tool: op.tool, summary: op.summary, error: msg })
        // 后续 op 可能依赖本条的前提（临时 id / 目标目录），停在第一条失败，其余留给用户重试
        break
      }
    }
  } finally {
    const now = new Date().toISOString()
    if (done.length > 0) plan.appliedAt = now
    plan.updatedAt = now
    persist(plan)
    refresh(rels.filter(Boolean))
  }
  if (failures.length > 0 && sessionExists(sessionId)) {
    const remaining = plan.ops.filter((o) => o.status === 'pending').length
    const lines = failures.map((f, i) => `${i + 1}. ${f.summary || f.tool || '写操作'}：${f.error}`)
    const note = [
      '（变更未应用）执行变更方案时失败：',
      ...lines,
      remaining > 0 ? `另有 ${remaining} 项尚未执行，可在变更方案里重试。` : '',
      '请修正参数后重新提交；如果目标目录不存在，请先在知识库创建该目录。',
    ].filter(Boolean).join('\n')
    // 写回会话 = 下一轮模型能看到失败原因并自我修正；会话不可写不掩盖应用失败本身
    try { appendAgentMessage(sessionId, 'assistant', note) } catch { /* 忽略 */ }
  }
  return { applied: done.length, opIds: done, failures }
}

/**
 * 整任务回滚：逆序还原所有已应用的文件操作。
 *
 * 模块工具（kind='tool'）目前没有统一的逆操作：跳过并计入 `skipped`，
 * UI 必须如实告知「文件已还原，模块写入需手动撤销」，不能假装全回滚。
 */
export async function rollbackTask(sessionId: string): Promise<{ reverted: number; skipped: number }> {
  const plan = load(sessionId)
  if (!plan) throw new Error('没有可回滚的任务')
  const { rootPath, rootId } = rootPathOrThrow()
  const rels: string[] = []
  let n = 0
  let skipped = 0
  for (const op of selectOps(plan.ops, [], 'rollback')) {
    if (op.kind === 'tool') {
      op.status = 'rejected'
      skipped++
      continue
    }
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
  return { reverted: n, skipped }
}

/** 丢弃未应用的方案（pending 与 failed 一并清掉；failed 保留在会话消息里可回看） */
export function rejectPlan(sessionId: string): void {
  const plan = load(sessionId)
  if (!plan) return
  for (const op of plan.ops) if (op.status === 'pending' || op.status === 'failed') op.status = 'rejected'
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
