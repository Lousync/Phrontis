import type { StreamDraft } from '../../../lib/agentStreamCore'
export type { StreamDraft, ProcessItem } from '../../../lib/agentStreamCore'
import { applyStreamEvent, completeTool, createDraft } from '../../../lib/agentStreamCore'
import { useCallback, useEffect, useRef, useState } from 'react'
import { onAgentStep, onAgentStream } from '../../../lib/ipc'
import type { AgentTraceStep } from '../../../types'

/**
 * 流式过程状态（docs/ai-streaming-design.md §5.3.1）。
 *
 * 设计要点：
 * - **草稿独立于 messages 数组**：流式内容放这里，避免每个 delta 触发消息列表全量 diff
 * - **节流**：delta 只 mutate ref，60ms 才 setState 一次（主进程侧另已 40ms 合批）
 * - 用 setTimeout 而非 rAF：本项目是多 Tab display:none 常驻保活架构，rAF 在窗口不可见时会挂起
 *
 * ⚠️ N-3 之后本 hook 只服务 **chatId 单草稿** 的消费方（AiLearn / AI 教学侧栏，签名不变）；
 * 助手三宿主（悬浮侧栏 / 右栏 AI 态 / aiChat 整页）改走 `assistantRunStore` 的
 * **sessionId 分桶**（切会话不丢流、后台完成有角标）。草稿纯应用逻辑在 agentStreamCore 共用。
 */

const FLUSH_MS = 60

export function useAgentStream(chatIdRef: { current: string }): {
  draft: StreamDraft | null
  liveSteps: AgentTraceStep[]
  begin: () => void
  end: () => void
} {
  const draftRef = useRef<StreamDraft | null>(null)
  const liveRef = useRef<AgentTraceStep[]>([])
  const timerRef = useRef<number | null>(null)
  const [, setTick] = useState(0)

  const flushSoon = useCallback(() => {
    if (timerRef.current !== null) return
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setTick(t => (t + 1) % 1_000_000)
    }, FLUSH_MS)
  }, [])

  useEffect(() => {
    const offStream = onAgentStream(({ chatId, event }) => {
      if (chatId !== chatIdRef.current) return
      const d = draftRef.current
      if (!d) return
      applyStreamEvent(d, event)
      flushSoon()
    })
    const offStep = onAgentStep(({ chatId, step }) => {
      if (chatId !== chatIdRef.current) return
      liveRef.current = [...liveRef.current.slice(-19), step]
      const d = draftRef.current
      // durationMs=0 的是 visual.html 的「生成中」占位事件，不参与完成配对
      if (d && step.kind === 'tool' && step.durationMs > 0) completeTool(d, step)
      flushSoon()
    })
    return () => { offStream(); offStep() }
  }, [chatIdRef, flushSoon])

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  }, [])

  const begin = useCallback(() => {
    if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null }
    draftRef.current = createDraft()
    liveRef.current = []
    setTick(t => (t + 1) % 1_000_000)
  }, [])

  const end = useCallback(() => {
    if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null }
    draftRef.current = null
    liveRef.current = []
    setTick(t => (t + 1) % 1_000_000)
  }, [])

  return { draft: draftRef.current, liveSteps: liveRef.current, begin, end }
}
