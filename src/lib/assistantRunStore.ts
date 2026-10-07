import { onAgentStep, onAgentStream, onAssistantRunState } from './ipc'
import { showToast } from './toast'
import { applyStreamEvent, completeTool, createDraft, type StreamDraft } from './agentStreamCore'
import type { AgentTraceStep, AgentRunStateEvent } from '../types'

/**
 * 助手会话运行态共享单例（N-3 多对话并行，docs/assistant-parallel-design.md）。
 *
 * 真源在主进程（agentService 每次 agent 调用开始/结束广播 assistant:runstate），
 * 本 store 是渲染进程内三个宿主（悬浮侧栏 / 右栏 AI 态 / aiChat 整页）共享的唯一投影：
 * - **流式草稿按 sessionId 分桶**：切走会话不丢流，切回即恢复实时流；
 * - **IPC 只订阅一次**（懒挂载）：失败 Toast 天然每窗口一次，不随宿主实例数翻倍；
 * - **unread / failed 角标**：后台完成亮蓝点、失败亮红标 + Toast；ABORTED 静默；
 * - **viewedIds 计数制**：同一会话可能同时被多个宿主查看，进/出对称增减，归零才算没人看。
 *
 * 边界：流式增量仍只发发起窗口（既有设计），跨窗口的桶不填充；角标跨窗口各自独立。
 */

/** 助手同时运行的对话上限（含 AI 教学占用 —— 同一 API key 的真实并发；教学自身入口不做此检查） */
export const MAX_PARALLEL = 3

interface RunBucket {
  draft: StreamDraft
  liveSteps: AgentTraceStep[]
}

const buckets = new Map<string, RunBucket>()
const runningIds = new Set<string>()
const unreadIds = new Set<string>()
const failedIds = new Set<string>()
const viewedCounts = new Map<string, number>()

/** 尚未被任何宿主消费的「结束」事件：查看中的宿主据此补一次 refreshMessages（它不是发起方、没有 finally 兜底） */
const pendingEnded: NonNullable<AgentRunStateEvent['ended']>[] = []

type Listener = () => void
const listeners = new Set<Listener>()
let notifyTimer: number | null = null
let subscribed = false

function notify(): void {
  if (notifyTimer !== null) return
  // 与 useAgentStream 同款 60ms 节流：delta 只 mutate 内部结构，这里只节流通知
  notifyTimer = window.setTimeout(() => {
    notifyTimer = null
    for (const l of [...listeners]) l()
  }, 60)
}

function isViewed(sid: string): boolean {
  return (viewedCounts.get(sid) ?? 0) > 0
}

function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  // 流式增量 / 步骤：按 sessionId 入桶（发起方切走也继续累积）
  onAgentStream(({ sessionId, event }) => {
    const b = buckets.get(sessionId)
    if (!b) return
    applyStreamEvent(b.draft, event)
    notify()
  })
  onAgentStep(({ sessionId, step }) => {
    const b = buckets.get(sessionId)
    if (b) {
      b.liveSteps = [...b.liveSteps.slice(-19), step]
      // durationMs=0 的是 visual.html 的「生成中」占位事件，不参与完成配对
      if (step.kind === 'tool' && step.durationMs > 0) completeTool(b.draft, step)
    }
    notify()
  })
  // 运行态：整体替换 running；ended 做角标 / 失败 Toast 分发
  onAssistantRunState((p) => {
    runningIds.clear()
    for (const sid of p.running) runningIds.add(sid)
    const ended = p.ended
    if (ended) {
      pendingEnded.push(ended)
      buckets.delete(ended.sessionId) // 流式卡退场；最终消息由 refreshMessages 落位
      if (!ended.ok && ended.code === 'ABORTED') {
        // 用户主动停止：静默
      } else if (!ended.ok) {
        if (!isViewed(ended.sessionId)) failedIds.add(ended.sessionId)
        showToast({ type: 'error', message: `后台对话失败：${ended.error ?? '未知错误'}` })
      } else if (!isViewed(ended.sessionId)) {
        unreadIds.add(ended.sessionId)
      }
    }
    notify()
  })
}

export function subscribeAssistantRunState(fn: Listener): () => void {
  ensureSubscribed()
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** 某会话的流式桶（含草稿与实时步骤）；不在跑 = null */
export const getRunBucket = (sid: string | null | undefined): RunBucket | null =>
  sid ? buckets.get(sid) ?? null : null

export const isSessionRunning = (sid: string | null | undefined): boolean => !!sid && runningIds.has(sid)

export const runningSessionCount = (): number => runningIds.size

/** 会话列表标记（优先级 running > failed > unread） */
export const runMarkOf = (sid: string): 'running' | 'failed' | 'unread' | null =>
  runningIds.has(sid) ? 'running' : failedIds.has(sid) ? 'failed' : unreadIds.has(sid) ? 'unread' : null

/** 发起运行（乐观）：建空桶 + 立即置 running，主进程广播随后对齐 */
export function beginRun(sid: string): void {
  buckets.set(sid, { draft: createDraft(), liveSteps: [] })
  runningIds.add(sid)
  notify()
}

/** 运行收尾（发起方 finally；幂等 —— ended 广播可能先到并已删桶） */
export function endRun(sid: string): void {
  if (buckets.delete(sid)) notify()
  runningIds.delete(sid)
}

/** 进入会话查看：清角标 + 登记查看中（计数制，多宿主对称进出） */
export function markSessionViewed(sid: string): void {
  viewedCounts.set(sid, (viewedCounts.get(sid) ?? 0) + 1)
  unreadIds.delete(sid)
  failedIds.delete(sid)
  notify()
}

/** 离开会话：撤销查看登记 */
export function unmarkSessionViewed(sid: string): void {
  const n = (viewedCounts.get(sid) ?? 0) - 1
  if (n <= 0) viewedCounts.delete(sid)
  else viewedCounts.set(sid, n)
}

/** 消费指向 sid 的结束事件（有则 true）；查看中的宿主据此补拉消息 */
export function takeEndedFor(sid: string): boolean {
  const i = pendingEnded.findIndex(e => e.sessionId === sid)
  if (i < 0) return false
  pendingEnded.splice(i, 1)
  return true
}
