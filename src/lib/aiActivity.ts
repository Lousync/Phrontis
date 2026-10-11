import { useEffect, useState } from 'react'
import { onAgentStep, onAssistantRunState } from './ipc'

/**
 * 全局 AI 活动状态（.claude/plans/ai-composer-mascot.md §4.1）。
 *
 * 归一成一组状态，供 AI 输入区吉祥物（`AiMascotAnchor` / `MascotPlayer`）决定演哪个动作。
 * 状态名对齐 `dsh-claude-style` 的状态机：idle / thinking / working / sweeping /
 * notification / error / attention（其 `juggling` 是子代理，Phrontis 无，省略）。
 *
 * 数据源（宿主已有，全局广播）：
 * - `assistant:runstate`（N-3）→ 在跑会话集：空=idle，非空=thinking/working；结束帧给 error/attention 一刻。
 * - `agent:step` → 步骤类型（llm / tool）区分 thinking 与 working。
 *
 * `useAiBusy()` 另给「同时在跑的会话数」，供吉祥物「工作分档」（忙 1/2/≥3）用。
 * 本版尚未产生 `sweeping`（压缩）与 `notification`（等你操作）——类型先留位。
 */

export type AiActivity =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'sweeping'
  | 'notification'
  | 'error'
  | 'attention'

let current: AiActivity = 'idle'
let busy = 0
const listeners = new Set<(a: AiActivity) => void>()
const busyListeners = new Set<(n: number) => void>()
let started = false
let momentTimer: ReturnType<typeof setTimeout> | null = null
let lastStepKind: 'llm' | 'tool' = 'llm'

function emit(a: AiActivity): void {
  if (a === current) return
  current = a
  for (const l of listeners) l(a)
}

function emitBusy(n: number): void {
  if (n === busy) return
  busy = n
  for (const l of busyListeners) l(n)
}

/** 一次性「时刻」（出错 / 完成）：独占一小段时间后回落到常态 */
function moment(a: 'error' | 'attention', ms: number): void {
  if (momentTimer) clearTimeout(momentTimer)
  emit(a)
  momentTimer = setTimeout(() => { momentTimer = null; recompute() }, ms)
}

/** 常态：在跑 → thinking/working；否则 idle。（时刻进行中不打扰） */
function recompute(): void {
  if (momentTimer) return
  if (busy > 0) emit(lastStepKind === 'tool' ? 'working' : 'thinking')
  else emit('idle')
}

function ensureStarted(): void {
  if (started) return
  started = true
  onAssistantRunState((p) => {
    emitBusy(p.running.length)
    const e = p.ended
    if (e) {
      if (!e.ok && e.code !== 'ABORTED') { moment('error', 2600); return }
      if (e.ok) { moment('attention', 2400); return }
    }
    recompute()
  })
  onAgentStep((p) => {
    lastStepKind = p.step.kind
    if (!momentTimer && busy > 0) recompute()
  })
}

/** 读当前状态（非订阅） */
export function getAiActivity(): AiActivity { return current }

/** 订阅当前 AI 活动状态（首次调用挂全局监听，进程内常驻） */
export function useAiActivity(): AiActivity {
  const [a, setA] = useState<AiActivity>(current)
  useEffect(() => {
    ensureStarted()
    setA(current)
    listeners.add(setA)
    return () => { listeners.delete(setA) }
  }, [])
  return a
}

/** 订阅「同时在跑的会话数」（>=0） */
export function useAiBusy(): number {
  const [n, setN] = useState(busy)
  useEffect(() => {
    ensureStarted()
    setN(busy)
    busyListeners.add(setN)
    return () => { busyListeners.delete(setN) }
  }, [])
  return n
}
