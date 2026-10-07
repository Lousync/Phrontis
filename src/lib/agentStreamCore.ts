import type { AgentStreamEvent, AgentTraceStep } from '../types'

/**
 * Agent 流式草稿的**纯应用逻辑**（自 useAgentStream.ts 迁出，N-3 多对话并行拆层）：
 * 主进程事件 → 草稿的推导零副作用，供两条订阅链共用 ——
 * ① useAgentStream（chatId 单草稿，AiLearn / AI 教学侧栏在用，签名不变）；
 * ② assistantRunStore（sessionId 分桶，助手三宿主共享，切回运行中会话即恢复实时流）。
 */

export type ProcessItem =
  | { kind: 'narr'; key: string; text: string }
  | {
      kind: 'tool'; key: string; name: string; label: string; target?: string
      state: 'running' | 'done' | 'fail'; durationMs?: number
    }

export interface StreamDraft {
  thinking: string
  text: string
  items: ProcessItem[]
  /** performance.now() 起点，供计时显示 */
  startedAt: number
  round: number
}

/** 思考链只保留尾部（滚动展示用），避免长思考把内存与渲染成本拉高 */
export const MAX_THINKING = 4000

export function createDraft(): StreamDraft {
  return { thinking: '', text: '', items: [], startedAt: Date.now(), round: 0 }
}

/** 增量的纯应用逻辑：主进程事件 → 草稿（保持无副作用，便于排查） */
export function applyStreamEvent(d: StreamDraft, e: AgentStreamEvent): void {
  if (e.kind === 'round-start') {
    d.round = e.round
    return
  }
  if (e.kind === 'thinking') {
    d.thinking = (d.thinking + e.delta).slice(-MAX_THINKING)
    return
  }
  if (e.kind === 'text') {
    d.text += e.delta
    return
  }
  // 工具开始：本轮已有正文 → 那是模型动工具前说的话，降级为「过程旁白」挪进时间线
  // （这样中间轮文本自动变成旁白，最终轮正文留在 d.text 作为回答本体，无需额外协议）
  if (d.text.trim()) {
    d.items.push({ kind: 'narr', key: `n${d.items.length}`, text: d.text.trim() })
    d.text = ''
  }
  d.items.push({
    kind: 'tool', key: `t${d.items.length}`, name: e.name,
    label: e.label, target: e.target, state: 'running',
  })
}

/** agent:step 的工具完成事件 → 与「最近一个同名 running」配对原地转 ✓ / ✕ */
export function completeTool(d: StreamDraft, step: AgentTraceStep): void {
  for (let i = d.items.length - 1; i >= 0; i--) {
    const it = d.items[i]
    if (it.kind === 'tool' && it.state === 'running' && it.name === step.name) {
      d.items[i] = { ...it, state: step.ok ? 'done' : 'fail', durationMs: step.durationMs }
      return
    }
  }
}
