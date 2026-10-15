/**
 * 中断续跑纯函数（A 方案 §3.1；方案见 docs/agent-interrupt-resume-plan.md）。
 *
 * 三条硬约束（写之前先读，改之前再读一遍）：
 * 1. **零 import**：`.AGENT/scripts/agent-resume/verify-agent-resume.mjs` 用裸 node 直接 import 本文件
 *    （Node 24 类型剥离）——一旦 import 别的模块，specifier 就得带 `.ts` 后缀而 tsconfig 不接受，
 *    脚本立刻跑不起来。所以本模块只收**已经算好的字符串**，不自己去认错误、不自己造词。
 * 2. **文案真源仍是 llmFailurePure.ts**：原因白话（friendlyReason）/ 建议动作（suggestedActionText）/
 *    诊断块（buildDiagnostics）都在那边算好传进来 —— 两处各写一套 = 同一个现象两种说法。
 * 3. **纯函数、幂等**：同输入恒同输出（续跑 carry 会被反复构造，漂移就是打散 prompt cache）。
 */

/** 一处真实写改动（主进程 AgentChange 的归因侧镜像：只留卡片要展示的三个字段） */
export interface InterruptChange {
  action: string
  target: string
  file?: string
}

/** 中断现场的事实（**只装采集到的东西**，不允许在这里凭空推断） */
export interface InterruptFacts {
  /** 已本地化的原因串（friendlyReason 产出） */
  reason: string
  /** 用户主动停止 */
  aborted: boolean
  /** 本次 run 消耗的推理轮数 */
  rounds: number
  /** 本次 run 的工具调用次数 */
  toolCalls: number
  changes: InterruptChange[]
  /** 最后一次带工具轮次的旁白（trace 里已有，≤300 字符） */
  lastProcessText?: string
}

/** carry 的原始行（agentService 在每次工具执行后入账） */
export interface CarryRow {
  tool: string
  /** 关键入参的紧凑串（已截断；缺省 = 无参） */
  args?: string
  /** 工具结果原文（可能被 MAX_TOOL_RESULT_CHARS 摘要过） */
  result: string
  /** 失败的工具调用也要进 carry（「查过但没查成」同样是现场信息） */
  ok?: boolean
}

/** 会话行里的续跑现场（agentSessionRepo.AgentSessionRow.resume）——`carry` 只在续跑时注入，绝不发给渲染层 */
export interface SessionResume {
  /** 中断时刻（本地时间串，同 nowLocal 口径） */
  at: string
  /** 中断记录那条 assistant 消息的 id —— 「继续」按钮挂在它上面 */
  message_id: string
  /** 原因串（直接展示） */
  reason: string
  aborted: boolean
  tool_calls: number
  changes: InterruptChange[]
  /** 机器可读的现场（已获得的工具结果摘要，新→旧） */
  carry: string
}

/** 会话列表出口的摘要（**结构上就不含 carry**：负向断言锁 JSON.stringify 里搜不到 carry 正文） */
export interface ResumeInfo {
  at: string
  messageId: string
  reason: string
  aborted: boolean
  toolCalls: number
  changes: InterruptChange[]
}

/** 中断卡「白话段」上限（诊断块不计入：复制正文即可带走诊断，截掉它就等于把证据丢了） */
export const INTERRUPT_CONTENT_CAP = 600
/** 续跑 carry 总量上限（≈2.3k token，只付一次） */
export const CARRY_TOTAL_CAP = 6000
/** 续跑 carry 单条上限 */
export const CARRY_ITEM_CAP = 800
/** 中断卡尾句（有「继续」入口之后的说法；批次 1 的无按钮口径在 llmFailurePure.suggestedActionText 里） */
export const RESUMABLE_NOTE = '已获得的信息已保留，可点「继续」从断点接着做（未完成的查询不必重跑）。'
/** 续跑注入的首行标记（契约按它断言「注入确实拼进去了」） */
export const RESUME_NOTICE = '【继续上一次被中断的任务】'

const clean = (s: unknown, n: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const count = (n: unknown): number => Math.max(0, Math.floor(Number(n) || 0))

export interface InterruptContentInput {
  /** friendlyReason 的产出（白话原因） */
  reason: string
  /** suggestedActionText 的产出（可为空串：该码没有建议动作） */
  advice?: string
  rounds: number
  toolCalls: number
  changes?: InterruptChange[]
  lastProcessText?: string
  aborted?: boolean
  /**
   * 本次是否真的留下了可续现场（有现场才有「继续」按钮）。
   * false（支线旁问 / 手册通道）时**不能**说「可点继续」—— 指向不存在的入口比不说更糟。
   */
  canResume?: boolean
  /** buildDiagnostics 的产出；缺省 = 不带诊断块（如「用户停止」不值得贴诊断） */
  diagnostics?: string
}

/**
 * 中断卡正文 = 白话段（≤600）+ 可选诊断块。
 * 结构：首行原因 → 建议动作 → 进度（轮数/工具数）→ 已完成的改动清单 → 可继续句 → ```诊断。
 */
export function buildInterruptContent(input: InterruptContentInput): string {
  const reason = clean(input.reason, 200) || '本次任务被中断，未收到任何错误说明'
  const parts: string[] = [`本次任务被中断：${reason}。`]
  const advice = clean(input.advice ?? '', 160)
  if (advice) parts.push(advice)
  const body: string[] = [
    `已进行 ${count(input.rounds)} 轮推理 / ${count(input.toolCalls)} 次工具调用。`,
  ]
  const changes = input.changes ?? []
  if (changes.length > 0) {
    body.push(`已完成的改动（${changes.length} 处）：`)
    changes.slice(0, 20).forEach((c, i) => body.push(`${i + 1}. ${clean(c.action, 20)}「${clean(c.target, 80)}」`))
    if (changes.length > 20) body.push(`…另有 ${changes.length - 20} 处（见「本次改动」面板）`)
  }
  if (input.lastProcessText) body.push(`中断前最后一步：${clean(input.lastProcessText, 160)}`)
  if (input.canResume !== false) body.push(RESUMABLE_NOTE)
  parts.push(body.join('\n'))
  let human = parts.join('\n\n')
  if (human.length > INTERRUPT_CONTENT_CAP) human = human.slice(0, INTERRUPT_CONTENT_CAP) + '\n…（正文过长，已截断）'
  const diagnostics = String(input.diagnostics ?? '')
  return diagnostics ? `${human}\n\n\`\`\`诊断\n${diagnostics}\n\`\`\`` : human
}

/**
 * 工具结果 → 一行摘要（标量保留、长文本/大数组降级）。
 * 与 agentService.compressOneToolResult 同思路但更狠（压成单行），且必须**确定性**。
 */
function compact(value: unknown): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const head = value.slice(0, 3).map(v => compact(v)).join(' | ')
    return `[${value.length} 项] ${head}`
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>
    const keys = Object.keys(o)
    const head = keys.slice(0, 8).map(k => `${k}=${compact(o[k])}`).join(', ')
    return `{${head}${keys.length > 8 ? `, …+${keys.length - 8}` : ''}}`
  }
  return String(value)
}

/** 单条 carry 行：`工具名(入参) [失败] → 结果摘要` */
function carryLineOf(row: CarryRow): string {
  const args = clean(row.args ?? '', 120)
  let summary = ''
  try {
    const parsed: unknown = JSON.parse(row.result)
    const boxed = (parsed && typeof parsed === 'object' && 'data' in (parsed as Record<string, unknown>))
      ? (parsed as Record<string, unknown>)['data']
      : parsed
    summary = compact(boxed)
  } catch {
    // 非 JSON（或已被截断的 JSON）：原样降级，不假装能解析
    summary = clean(row.result, 400)
  }
  const head = `${clean(row.tool, 40) || '工具'}${args ? `(${args})` : ''}${row.ok === false ? ' [失败]' : ''}`
  const line = `${head} → ${clean(summary, 400)}`
  return line.length > CARRY_ITEM_CAP ? `${line.slice(0, CARRY_ITEM_CAP - 1)}…` : line
}

/**
 * 续跑 carry：把本次已获得的工具结果压成「已获得的信息」。
 * 规则（§3.5）：新→旧；单条 ≤800；总量 ≤6000，超了丢最老的；同输入恒同输出。
 */
export function buildResumeCarry(rows: CarryRow[]): string {
  const lines: string[] = []
  let total = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const line = carryLineOf(rows[i])
    if (!line) continue
    if (total + line.length + 1 > CARRY_TOTAL_CAP) break
    lines.push(line)
    total += line.length + 1
  }
  return lines.join('\n')
}

/** 续跑注入（一次性、不落库：只作为 convo 末尾的合成 user 轮，不进会话历史） */
export function buildResumeInjection(f: InterruptFacts, carry: string): string {
  const lines: string[] = [
    RESUME_NOTICE,
    `上一次执行到一半被中断（原因：${clean(f.reason, 160) || '未收到任何错误说明'}）。已经完成的部分不要重做。`,
    `进度：${count(f.rounds)} 轮推理 / ${count(f.toolCalls)} 次工具调用。`,
  ]
  if (f.changes.length > 0) {
    lines.push('已完成的改动：\n' + f.changes.slice(0, 20).map((c, i) => `${i + 1}. ${clean(c.action, 20)}「${clean(c.target, 80)}」`).join('\n'))
  }
  lines.push(carry
    ? `已获得的信息（新→旧，直接复用，不要再查一遍）：\n${carry}`
    : '已获得的信息：无（上一次没有留下成功的工具结果）。')
  return lines.join('\n')
}

/**
 * 会话行 → 渲染层摘要。**逐字段显式搬运**（绝不 spread）：spread 会把 6k 字符的 carry 一并塞进
 * `agent:sessions` 的返回值，每次刷新会话列表都白传一遍。
 */
export function toResumeInfo(r: SessionResume): ResumeInfo {
  return {
    at: String(r.at ?? ''),
    messageId: String(r.message_id ?? ''),
    reason: String(r.reason ?? ''),
    aborted: r.aborted === true,
    toolCalls: count(r.tool_calls),
    changes: Array.isArray(r.changes)
      ? r.changes.map(c => ({ action: String(c?.action ?? ''), target: String(c?.target ?? ''), ...(c?.file ? { file: String(c.file) } : {}) }))
      : [],
  }
}
