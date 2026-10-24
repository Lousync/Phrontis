import type { AgentStreamEvent, AgentTraceStep } from '../types'

/**
 * Agent 流式草稿的**纯应用逻辑**（自 useAgentStream.ts 迁出，N-3 多对话并行拆层）：
 * 主进程事件 → 草稿的推导零副作用，供两条订阅链共用 ——
 * ① useAgentStream（chatId 单草稿，AiLearn / AI 教学侧栏在用，签名不变）；
 * ② assistantRunStore（sessionId 分桶，助手三宿主共享，切回运行中会话即恢复实时流）。
 *
 * v3.10.0 事件流：思考按 **LLM 轮次**分段（不再把所有 reasoning 拼成一个块），
 * 工具与旁白也进同一个有序数组 —— 渲染层按 `items` 原序画事件流即可。
 */

export type ProcessItem =
  | {
      kind: 'think'; key: string; round: number; text: string
      state: 'active' | 'done'; /** Date.now() 起点，供进行中的秒数显示 */ startedAt: number
      /** 本轮思考耗时（来自 agent:step.llm.thinkingMs，完成态口径） */ durationMs?: number
    }
  | { kind: 'narr'; key: string; text: string }
  | {
      kind: 'tool'; key: string; name: string; label: string; target?: string
      state: 'running' | 'done' | 'fail'; durationMs?: number
    }

export interface StreamDraft {
  text: string
  /** 按发生顺序排列的过程事件（think / narr / tool） */
  items: ProcessItem[]
  /** Date.now() 起点，供总耗时显示 */
  startedAt: number
  round: number
  /** 每次事件自增：MessageList / AI 教学的 draftSig 用它判断是否需要贴底 */
  rev: number
}

/** 单段思考只保留尾部（滚动展示用），避免长思考把内存与渲染成本拉高 */
export const MAX_THINKING = 4000

export function createDraft(): StreamDraft {
  return { text: '', items: [], startedAt: Date.now(), round: 0, rev: 0 }
}

/** 把当前 active 的思考段收口（正文 / 工具 / 新一轮开始都算本轮思考结束） */
function finishActiveThink(d: StreamDraft): void {
  for (let i = d.items.length - 1; i >= 0; i--) {
    const it = d.items[i]
    if (it.kind === 'think' && it.state === 'active') {
      d.items[i] = {
        ...it,
        state: 'done',
        // 权威时长随后由 completeThink 用 thinkingMs 覆盖；这里只是先给个可见的收口值
        durationMs: it.durationMs ?? Math.max(1, Date.now() - it.startedAt),
      }
      return
    }
  }
}

/** 增量的纯应用逻辑：主进程事件 → 草稿（保持无副作用，便于排查） */
export function applyStreamEvent(d: StreamDraft, e: AgentStreamEvent): void {
  d.rev++
  if (e.kind === 'round-start') {
    d.round = e.round
    // 防御：上一轮若因空回复等原因没被正文/工具收口，新一轮开始先收掉
    finishActiveThink(d)
    return
  }
  if (e.kind === 'thinking') {
    let cur: Extract<ProcessItem, { kind: 'think' }> | null = null
    for (let i = d.items.length - 1; i >= 0; i--) {
      const it = d.items[i]
      if (it.kind === 'think' && it.state === 'active') { cur = it; break }
    }
    // 同一轮才续写；跨轮一定新建（一个 LLM 轮次 = 一段思考）
    if (!cur || cur.round !== d.round) {
      cur = {
        kind: 'think', key: `k${d.items.length}`, round: d.round,
        text: '', state: 'active', startedAt: Date.now(),
      }
      d.items.push(cur)
    }
    cur.text = (cur.text + e.delta).slice(-MAX_THINKING)
    return
  }
  if (e.kind === 'text') {
    // A 的收口：正文（或工具前旁白）开始输出 → 本轮思考立刻收起
    finishActiveThink(d)
    d.text += e.delta
    return
  }
  // 工具开始：本轮已有正文 → 那是模型动工具前说的话，降级为「过程旁白」挪进时间线
  // （这样中间轮文本自动变成旁白，最终轮正文留在 d.text 作为回答本体，无需额外协议）
  finishActiveThink(d)
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
  d.rev++
  for (let i = d.items.length - 1; i >= 0; i--) {
    const it = d.items[i]
    if (it.kind === 'tool' && it.state === 'running' && it.name === step.name) {
      d.items[i] = { ...it, state: step.ok ? 'done' : 'fail', durationMs: step.durationMs }
      return
    }
  }
}

/**
 * agent:step 的 LLM 完成事件 → 给本轮思考段补权威耗时。
 * 主进程只落库 thinkingMs、不落 reasoning 正文，所以完成态只能显示「思考 · Ns」。
 */
export function completeThink(d: StreamDraft, step: AgentTraceStep): void {
  if (step.kind !== 'llm' || !step.thinkingMs || step.thinkingMs <= 0) return
  d.rev++
  for (let i = d.items.length - 1; i >= 0; i--) {
    const it = d.items[i]
    if (it.kind !== 'think' || it.round !== d.round) continue
    d.items[i] = { ...it, state: 'done', durationMs: step.thinkingMs }
    return
  }
}
