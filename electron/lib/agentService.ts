import { ipcMain } from 'electron'
import { broadcast, BROADCAST_CHANNEL } from '../main/windowBus'
import { randomUUID } from 'crypto'
import { listTools, invokeToolInternal, getSettingReader, checkModulePermission, checkVaultFilePermission } from './aiTools'
import { isConfirmModeHiddenTool } from './aiAssistantStageable'
import { isWithinVaultScope } from './kbStore/vaultScope'
import type { ToolDescription, AiToolInvokeResult } from './aiTools'
import { buildAttachedRefsInjection } from './aiAssistant/refSkeleton'
import { readVaultRefText } from './aiAssistant/refText'
import { runPerception } from './aiAssistant/perception'
import { buildPerceptionInjection } from './aiAssistant/perceptionBudget'
import { invokeLlmStreamInternal } from './llmService'
import {
  classifyFailure, friendlyReason, buildInterruptNotice, buildDiagnostics, suggestedActionText,
  interruptionDetailOf, rawFailure, configInterruptionOf,
  type RawFailure, type Interruption, type InterruptionDetail,
} from './llmFailurePure'
import { estimateTokens, trimHistoryByBudget } from './agentContextBudget'
import { compressAtTokens, composeContextWithDigest, rowsAfterDigest } from './agentCompressCore'
import { compressSession } from './agentCompress'
import type { SessionDigest, AgentMessageRow, AgentSessionRow } from './agentSessionRepo'
import { clampMaxRounds, clampMaxSessionWrites, clampRunTokenBudget, isParallelSafe, partitionToolBatches, PARALLEL_CHUNK, PARALLEL_HINT, FINAL_ROUND_NOTICE, FORCED_SUMMARY_NOTICE } from './agentLoopPolicy'
import {
  createAgentSession, listAgentSessions, renameAgentSession, deleteAgentSession,
  sessionExists, appendAgentMessage, ensureSessionTitle, getAgentMessages,
  getMessageById, updateMessageContent, deleteMessage, deleteMessagesAfter,
  getAgentSession, updateAgentSessionInstructions, updateAgentSessionScope, backfillSessionSources,
  createSideLaneSession, listSideLanes, promoteSideLane, setSessionMode, setSessionPinned,
  setSideLaneStatus, markSideLaneSeen, updateSessionResume, nowLocal,
  normalizeSessionScope, updateAgentSessionPreferences,
} from './agentSessionRepo'
// A 方案（断点续跑）：纯函数在 agentInterruptPure（零依赖，契约脚本直接 import）；文案真源在 llmFailurePure
import {
  buildInterruptContent, buildResumeCarry, buildResumeInjection, toResumeInfo,
  type CarryRow, type SessionResume, type InterruptFacts,
} from './agentInterruptPure'
import { takeAdoptNotice } from './agentAdoptNotice'
import { getCurrentVault } from './kbStore/vaultContext'
import { MANUAL_CHANNEL_TOOL, MANUAL_MAX_ROUNDS, buildManualSystemPrompt, classifyManualIntent, hasOperationIntent } from './manualChannel'
import { resolveConstraintsForInjection, readGlobalConstraints, readWorkspaceConstraintsForSession, resolveWriteOwnerRel, listSessionFolderIds } from './aiTeachingFolders'
import { readAssistantGlobalConstraints, readAssistantSessionConstraints, readAssistantGlossary } from './assistantConstraints'
import { resolveSourcesForInjection } from './aiTeachingSources'
import { readUnitConstraintsForSession } from './aiTeachingScope'
import { buildScopePrompt } from './scopePrompt'
import { resolveProfilesForInjection } from './aiTeachingProfile'
import { listWorkspaces, getWorkspaceOfSession, workspaceFolderRel } from './aiTeachingWorkspaces'
import { buildCourseInjection } from './aiTeachingCourse'
import { listFavorites } from './aiTeachingFavorites'
import { findSkillPrompt } from './skillService'
import { recordAiUsage, usageKeyOf, recordSessionFileChange, getAiUsageData, getAiUsageModels, getSessionChanges } from './agentUsage'
import { estimateCost } from './modelPricing'
import { vaultTodosAll } from './kbStore/scheduleVaultRepo'
import { intelItemsAll, intelReadMeta, intelPoolStats } from './intel/intelStore'
import { SECTION_META } from '../../src/lib/intelPure'
import type { IntelSection } from '../../src/types'
import { computeLaneUnread, deriveLaneStatus } from './sideLaneMeta'
import { buildScopeManifest } from './aiAssistantScope'
import { getPlan, applyPlan, rejectPlan, rollbackTask, listTasks } from './aiAssistantPlan'
import { getKnowledgeIndex } from './kbStore/knowledgeIndex'
import { suggestScope } from './aiAssistantScopeSuggestPure'
import { toolActionLabel } from '../../src/lib/toolLabels'

/**
 * 单轮估算费用（USD）：把 provider 的 prompt/completion/cached 拆成 `modelPricing` 的四桶
 * （i0 = prompt − cached，ir = cached，iw 恒 0 —— 上游不上报缓存写，out = completion）。
 * 无价目 / 无模型键 → null（界面只显 tokens）。与 `agentUsage.recordAiUsage` 的拆桶口径一致。
 */
function roundCostUsd(promptTokens?: number, completionTokens?: number, cachedTokens?: number, modelKey?: string): number | null {
  if (!modelKey) return null
  const prompt = Math.max(0, Math.round(Number(promptTokens ?? 0)))
  const cacheRead = Math.max(0, Math.round(Number(cachedTokens ?? 0)))
  const out = Math.max(0, Math.round(Number(completionTokens ?? 0)))
  return estimateCost({ i0: Math.max(0, prompt - cacheRead), ir: cacheRead, iw: 0, out, calls: 1 }, modelKey)
}

/**
 * 最小 AgentRunner —— 「用户消息 → LLM 决策 → ToolRegistry 执行 → 结果回喂」循环。
 * - 工具来源即统一注册表（builtin/mcp/skill 全量，禁用项自动排除）
 * - 每轮工具执行都走 invokeToolInternal：入参校验/审计/月度上限与手动调用完全一致
 * - 循环上限可配（settings: agentMaxRounds，缺省 16；另有 agentRunTokenBudget 累计 token 预算），
 *   耗尽后做一次无工具的强制总结轮（agentLoopPolicy 第 0 层优雅收场）；
 *   LLM 网关不代执行工具（职责分离），执行权只在这里
 */

/**
 * 单次请求内「写入类工具」调用次数上限（防失控循环刷盘；docs/agent-file-tools-design.md §5.5）。
 *
 * 判定不背硬编码名单（原 VAULT_WRITE_TOOLS 只含 4 个 vault.*，漏掉了 create-page/append-page/
 * create-entry/create-todo/check-habit 五个写工具，防刷盘在这几路上失效）：
 * 改为由 buildToolsPayload 按 tool.requires === 'write' 动态构造集合，
 * 覆盖全部 9 个内置写工具。外部 mcp.* / skill.* 不设 requires 字段，故不计入
 * （mcp 工具的 readOnly:false 是「不保证只读」的保守标记，不等于写操作，计入会大量误伤）。
 * 上限值自 v3.13.0 反馈 N-1 起为设置项 agentMaxSessionWrites（默认 20，见 agentLoopPolicy）。
 */

/**
 * 支线旁问纪律（v3.1.2 条目11 · 2026-09-14 定稿）。
 *
 * 定位：支线**唯一职责 = 解答主线某条回答里没讲透的零碎小知识点**。它不是「平行会话」——
 * 因此不承担重讲、不产生产物、不出题；疑问多说明主线本身没讲透，合合理的做法是回主线重讲。
 * 三条硬边界 = 不改文件 / 不出题 / 只答这一点，外加「回答要精简」。
 *
 * 声明为**最高优先级**：用于盖过工作区 CONSTRAINTS 骨架里「每节课结尾附 3 道自测题」这类
 * 针对主线课程的一般性要求（那类要求对支线不但无意义，还会把职责带偏）。
 * 与工具层的硬拦截（`buildToolsPayload` 对支线过滤写类工具）配套——提示词管「想不到」，
 * 工具层管「想到了也做不到」。
 */
const SIDE_LANE_DISCIPLINE =
  '\n\n【支线旁问纪律（最高优先级，覆盖下文一切与之冲突的要求）】本条对话是从主线会话某条回答分叉出来的**独立支线**。'
  + '你的唯一职责：解答用户就那一点提出的**零碎小知识点**问题。三条硬边界：'
  + '① **不改文件**——不调用任何写入类工具（你也确实未被授予），不产出文档 / 图示 / 题目；'
  + '② **不出题**——即使内容适合测验也不输出题卡；用户想做题时，提示回主线出题；'
  + '③ **只答这一点**——聚焦被追问的内容，不重讲主线、不展开主线其他部分、不做流程规划。'
  + '回答要**精简**：直给要点，不铺垫、不复述上下文、不写长篇；举例也用最短的。'

/** 注册表名含点号，OpenAI function name 仅允许 [a-zA-Z0-9_-] —— 双向映射 */
function toFnName(registryName: string): string {
  return registryName.replace(/\./g, '__')
}

interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  tool_calls?: unknown[]
  tool_call_id?: string
}

// ===== 工具结果的体积治理（2026-09-12，prompt cache 之后的第二轮） =====
//
// 为什么需要：prompt cache 只能覆盖**每轮逐字不变**的前缀（tools schema + system）。
// 而工具返回是 convo.push({role:'tool', content: JSON.stringify(exec.data)})，会随轮次
// 累积并被反复重发 —— 实测 quiz.list(limit=50) 一次约 16.7k 字符，在 8 轮任务里平均
// 被重发 4.5 次。这类开销 cache 帮不上忙，只能从「拿得少」与「丢得早」两个方向治。

/** 单条工具结果的字符硬上限（≈8k tok）。正常调用不会触及，兜住"拉全量"的极端情况 */
const MAX_TOOL_RESULT_CHARS = 24000
/** 触发硬上限时保留的预览字符数（让模型看清数据结构，但不足以占满上下文） */
const TOOL_RESULT_PREVIEW_CHARS = 4000
/** 发送前压缩：最近 N 条工具结果保持完整 */
const KEEP_RECENT_TOOL_RESULTS = 3
/** 更早的工具结果超过该字符数才压缩（小的不值得动） */
const COMPRESS_TOOL_RESULT_CHARS = 1200

/**
 * 单条工具结果的硬上限（保险丝）。超限时不返回半截 JSON —— 半截 JSON 既解析不了、
 * 又白占上下文 —— 而是换成合法摘要 + 预览 + 明确的收窄指引。
 * 预览取自**序列化后的文本**、再交给 JSON.stringify 重新转义，因此即使切在
 * `\uXXXX` 转义序列中间，产出的仍是合法 JSON。
 */
function capToolResult(raw: string, toolName: string): string {
  return JSON.stringify({
    ok: true,
    truncated: true,
    totalChars: raw.length,
    preview: raw.slice(0, TOOL_RESULT_PREVIEW_CHARS),
    hint: `工具 ${toolName} 的返回过大（${raw.length} 字符）已被系统截断。请缩小范围后重试：quiz.list 降低 limit 或加 tagNames 收窄；vault.read 降低 maxChars；vault.search 收窄关键词。`,
  })
}

/** 递归降级：标量与短文本原样保留，长文本/大数组降为占位说明 */
function shrinkValue(v: unknown, depth: number): unknown {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'string') return v.length <= 160 ? v : `…（${v.length} 字符已省略）`
  if (Array.isArray(v)) {
    // 小数组（如 tags）保留，大数组降级 —— AI 主要靠标量字段判断状态
    if (depth >= 2 || v.length > 3) return `…（${v.length} 项已省略）`
    return v.map(x => shrinkValue(x, depth + 1))
  }
  if (typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = shrinkValue(val, depth)
    return o
  }
  return null
}

/** 把一条工具结果压缩为摘要（保留标量，降级明细）。幂等：已是压缩结果则原样返回 */
function compressOneToolResult(raw: string): string {
  try {
    const parsed = JSON.parse(raw)
    // 幂等保护：否则 _originalChars 会被反复重写为新长度，同一段内容在不同轮次产出不同文本
    if (parsed !== null && typeof parsed === 'object'
      && (parsed as Record<string, unknown>)._compressed === true) return raw
    return JSON.stringify({
      ...(shrinkValue(parsed, 0) as Record<string, unknown>),
      _compressed: true,
      _originalChars: raw.length,
      _hint: '此工具结果已压缩以节省上下文。如需明细请重新调用该工具并缩小范围。',
    })
  } catch {
    return JSON.stringify({
      _compressed: true,
      _originalChars: raw.length,
      _hint: '此工具结果过大且非结构化，已压缩。如需明细请重新调用并缩小范围。',
    })
  }
}

/**
 * 历史工具结果的渐进压缩（发送前调用）。**必须是纯函数** —— 同一输入恒得同一输出，
 * 这样已被压缩的老消息在后续轮次逐字不变，prompt cache 的前缀才不会被反复打散。
 * 只压缩「较老的、且确实很大」的结果，并留下重新调用的指引。
 */
function compressStaleToolResults(convo: AgentMessage[]): AgentMessage[] {
  const toolIdx: number[] = []
  convo.forEach((m, i) => { if (m.role === 'tool') toolIdx.push(i) })
  const cutoff = toolIdx.length - KEEP_RECENT_TOOL_RESULTS
  if (cutoff <= 0) return convo
  const stale = new Set(toolIdx.slice(0, cutoff))
  return convo.map((m, i) => {
    if (!stale.has(i)) return m
    const c = String(m.content ?? '')
    if (c.length <= COMPRESS_TOOL_RESULT_CHARS) return m
    return { ...m, content: compressOneToolResult(c) }
  })
}

export interface AgentTraceStep {
  kind: 'llm' | 'tool'
  /** llm: 本轮模型; tool: 工具注册名 */
  name?: string
  ok: boolean
  durationMs: number
  tokens?: number
  /** 拆分用量（llm step） */
  promptTokens?: number
  completionTokens?: number
  /** 命中提示缓存的输入 token 数（观测用，已含在 promptTokens 内） */
  cachedTokens?: number
  /** 本轮估算费用（USD；llm step，按 `modelPricing` 折算）。无价目 / 失败 → null，渲染层只显 tokens */
  costUsd?: number | null
  summary?: string
  /** visual.html 实时占位事件（仅 agent:step 推送，不落库）：{slug,title}——渲染层据此开「生成中」页签 */
  args?: Record<string, unknown>
  /** 产物工具（visual.html / mindmap / image）成功产物（落库，随消息 trace 持久）：渲染层画工件卡 + 占位页签原地转正式 */
  artifact?: {
    rel: string
    title: string
    slug: string
    /** visual.html 行数；image 没有"行"这个概念，恒缺省（故可选） */
    lines?: number
    kind?: 'html' | 'mindmap' | 'image'
    nodes?: number
    /** image：像素尺寸 / 字节数 / 生图描述 / 参考图 / 模型 / 耗时（卡上元信息 + 版本切换用，见方案 §4.4） */
    w?: number
    h?: number
    bytes?: number
    prompt?: string
    ref?: string
    model?: string
    elapsedMs?: number
    /** image：改图槽未配置时退化为「按描述重画」（卡上据此标注，不静默降级） */
    downgraded?: boolean
  }
  /** 过程旁白：带工具轮次里模型输出的说明文本（落库供历史回看；
   *  最终轮正文是回复本体，已在消息 content 里，不重复存） */
  processText?: string
  /** 思考耗时（ms）。reasoning 全文**不落库**——会话文件全量读写，思考链长度常是正文数倍 */
  thinkingMs?: number
}

/**
 * 流式增量事件（docs/ai-streaming-design.md §4.1）。与 agent:step 刻意分工：
 * - `agent:step`：步骤**完成**事件（含耗时 / artifact，随 trace 落库）—— 保持零改动
 * - `agent:stream`：**增量与进行中**事件（不落库）—— 本次新增
 * 渲染层把两者合起来即完整过程时间线。
 */
export type AgentStreamEvent =
  | { kind: 'round-start'; round: number }
  | { kind: 'thinking'; delta: string }
  | { kind: 'text'; delta: string }
  | { kind: 'tool-start'; name: string; label: string; target?: string }

export interface AgentContextInfo {
  type: string
  label: string
  /** 上下文数据（如知识库页面正文），注入 system 时截断防 token 失控 */
  data?: Record<string, unknown>
}

export interface AgentChatRequest {
  sessionId: string
  /** 本轮用户消息（历史由服务端从会话库加载） */
  message: string
  /** 渲染层附带的当前上下文（如正在查看的知识库页面） */
  context?: AgentContextInfo
  /** 渲染层生成的调用标识——配合 agent:abort 实现停止生成 */
  chatId?: string
  /** 调用来源（P3a §3.8-2）：'aiTeaching' 时附加「每条回答带标题」等模块专属规则；轻问答不传 */
  source?: string
  /** P3b §3.8 第五轮：本对话临时换模（'providerId:modelId' 串，与 defaultChatModel 同格式；不传=全局默认） */
  modelId?: string
  /** P3b：思考强度（仅推理型模型实际透传 reasoning_effort，主进程侧守卫） */
  effort?: 'off' | 'low' | 'medium' | 'high'
  /** v3.1.1 条目10：/ 弹层显式选中的 Skill 注册名——本轮确定性注入其提示词（一次性，不落会话） */
  skillName?: string
}

/** 单次请求对用户数据的写改动（供 UI 列出「本次改了哪些文件/条目」） */
export interface AgentChange {
  /** 工具注册名（builtin.vault.edit 等） */
  tool: string
  /** 人类可读动作（编辑/新建/删除/打卡…） */
  action: string
  /** 目标：文件 relPath / 标题 / 日期等（取写工具关键入参） */
  target: string
  /** 可点击直达编辑器的仓库内文件 relPath（仅 vault 文件写类工具；trash 后文件已移走不设） */
  file?: string
}

export interface AgentChatResult {
  ok: boolean
  sessionId?: string
  reply?: string
  error?: string
  code?: string
  trace: AgentTraceStep[]
  /** 中断归因（归因 P0）：ok=false 时必有；ok=true 但输出被截断时也有（提示可续写） */
  interruption?: Interruption
  /** 归因诊断细节（诊断块数据源；不含正文与 Key） */
  interruptDetail?: InterruptionDetail
  /** 本次执行真实发生的写改动（成功写入/创建类工具），供 UI 渲染改动清单 */
  changes?: AgentChange[]
  /** UI 优化条目9②：AI教学本轮 system 注入分段字符数（渲染层据此估算「上下文构成」摘要；其它来源不设） */
  injection?: AiTeachInjectionStats
  /** 上下文预算裁剪统计（agentContextBudget；渲染层暂不展示，诊断/后续 UI 预留） */
  contextBudget?: { totalTurns: number; keptTurns: number; estimatedHistoryTokens: number }
  /** 触达轮数/token 预算上限：本次回答来自强制总结轮（渲染层可提示「已达预算，以上为基于已获信息的总结」） */
  hitCap?: boolean
  /** 本次请求前自动压缩了历史（会话压缩 §6.1；渲染层据此 toast 告知） */
  compressed?: { covered: number; digestChars: number }
}

/** AI教学 system 注入分段字符数（基础人设 / CONSTRAINTS / 三层画像 / SOURCE 目录 / 教学规则） */
export interface AiTeachInjectionStats {
  systemChars: number
  constraintChars: number
  profileChars: number
  sourcesChars: number
  ruleChars: number
}

/** 进行中的对话 → 中断控制器（用户点击停止时触发） */
const activeChats = new Map<string, AbortController>()

/** N-3 多对话并行：进行中对话 → 所属会话（agent:abortSession 按会话停止 + 运行态广播按会话归并） */
const activeChatSessions = new Map<string, string>()

/** signal → 步骤事件推送器（withAbort 注入发起窗口 sender，仅目标窗口收流） */
const stepEmitters = new WeakMap<AbortSignal, (step: AgentTraceStep) => void>()

/** signal → 流式增量推送器（与 stepEmitters 同机制；WeakMap 随 signal 一并回收） */
const streamEmitters = new WeakMap<AbortSignal, (event: AgentStreamEvent) => void>()

/** N-3：当前在跑的会话 id 去重集合（一个会话同时只有一个循环在跑，防御性去重） */
function runningSessionIds(): string[] {
  return [...new Set(activeChatSessions.values())]
}

/** N-3：会话运行态广播（全窗口；开始/结束各一发，结束附 ended 结果供角标/失败 Toast 分发） */
function broadcastRunState(ended?: { sessionId: string; chatId: string; ok: boolean; code?: string; error?: string }): void {
  try {
    broadcast(BROADCAST_CHANNEL.assistantRunState, { running: runningSessionIds(), ...(ended ? { ended } : {}) })
  } catch { /* 广播失败不影响主流程 */ }
}

/**
 * 增量合批：**绝不每 token 一次 IPC**。
 * 一次 2000 字回答若按 delta 直发是数百次 send；40ms 或累计 64 字符 flush 一次
 * → 一次完整请求约 30~80 次事件（docs/ai-streaming-design.md §5.2.2）。
 */
class DeltaBatcher {
  private text = ''
  private reasoning = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(private readonly emit: (e: AgentStreamEvent) => void) {}

  push(kind: 'text' | 'thinking', delta: string): void {
    if (kind === 'text') this.text += delta
    else this.reasoning += delta
    if (this.text.length + this.reasoning.length >= 64) { this.flush(); return }
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 40)
  }

  /** 收尾必须显式调用一次：否则最后一段积压会丢（表现为回答结尾缺几个字） */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.reasoning) { const d = this.reasoning; this.reasoning = ''; this.emit({ kind: 'thinking', delta: d }) }
    if (this.text) { const d = this.text; this.text = ''; this.emit({ kind: 'text', delta: d }) }
  }
}

/** 工具入参 → 过程时间线的目标文案（正在读/写哪个对象）；取不到则留空 */
function argTarget(args: Record<string, unknown>): string {
  const v = args.path ?? args.relPath ?? args.title ?? args.name ?? args.date ?? args.query ?? args.slug
  if (typeof v === 'string') return v.trim().slice(0, 120)
  // image 没有 slug/title 这类短标签，用 prompt 首段当目标（截断，不整段塞进时间线）
  return typeof args.prompt === 'string' ? args.prompt.trim().slice(0, 60) : ''
}

/**
 * 本会话「最近生成的图」薄索引（v3.6.0 对话内生图，docs/ai-image-gen-plan.md §5.4）。
 *
 * 为什么需要它：结果侧只保最近 3 条工具结果不被摘要（铁律 17），更早的产物 `relPath` 会被
 * 压缩掉 —— 用户隔几轮说「把刚才那张图改成浅灰背景」时，模型手里已经没有路径了。
 *
 * 数据源 = 本会话消息 trace 里的 `artifact`（与 §4.4 落库的同一份数据，**不新增存储**）。
 * 最多取最近 5 张、按 rel 去重；更老的**刻意不做召回**（方案 §5.4：用户要点名"最早那张"时
 * 由模型反问，而不是把整段历史塞进上下文）。
 *
 * ★ 调用处把它并进 `requestInjection`（首条 user 消息层）而不是 system：见该处注释。
 */
function buildRecentImagesHint(sessionId: string): string {
  try {
    const rows = getAgentMessages(sessionId)
    const items: Array<{ rel: string; title: string }> = []
    for (let i = rows.length - 1; i >= 0 && items.length < 5; i--) {
      const raw = rows[i]?.trace_json
      if (!raw) continue
      let steps: unknown
      try { steps = JSON.parse(raw) } catch { continue } // 单条 trace 坏掉不该影响本轮发送
      if (!Array.isArray(steps)) continue
      for (let j = steps.length - 1; j >= 0 && items.length < 5; j--) {
        const a = (steps[j] as { artifact?: { kind?: string; rel?: string; title?: string } } | null)?.artifact
        if (a?.kind !== 'image' || !a.rel) continue
        if (items.some(x => x.rel === a.rel)) continue
        items.push({ rel: a.rel, title: String(a.title ?? '') })
      }
    }
    if (items.length === 0) return ''
    return '\n\n【本会话最近生成的图】用户说「刚才那张图 / 改一下这张 / 插到某页」时，ref 与插图源从这里取（仓库相对路径）：\n'
      + items.map(x => `— ${x.rel}${x.title ? `（${x.title}）` : ''}`).join('\n')
  } catch { return '' } // 读会话失败不该打断本轮请求
}

/**
 * 续跑 carry 的入参摘要（A 方案 §3.5）：紧凑截断，取不到就留空。
 * 它是纯展示/给模型看的现场线索，不参与任何判据 —— 序列化失败一律降级为空串，绝不抛。
 */
function carryArgsOf(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args ?? {})
    return !s || s === '{}' ? '' : s.slice(0, 200)
  } catch { return '' }
}

/** 写改动识别：工具 → 人类动作标签（成功执行后收集 target=path/title/date/name） */
const CHANGE_LABELS: Record<string, string> = {
  'builtin.vault.write': '写入文件',
  'builtin.vault.edit': '修改文件',
  'builtin.vault.rename': '重命名文件',
  'builtin.vault.trash': '移入回收站',
  'builtin.knowledge.create-page': '新建知识页',
  'builtin.blog.create-entry': '新建日记',
  'builtin.schedule.create-todo': '创建待办',
  'builtin.schedule.update-todo': '修改待办',
  'builtin.schedule.delete-todo': '删除待办',
  'builtin.schedule.create-workflow': '创建工作流',
  'builtin.schedule.update-workflow': '修改工作流',
  'builtin.schedule.delete-workflow': '删除工作流',
  'builtin.schedule.mutate-stage': '编辑工作流阶段',
  'builtin.schedule.reorder-stages': '重排工作流阶段',
  'builtin.schedule.mutate-checkpoint': '编辑工作流检查点',
  'builtin.checkin.check-habit': '习惯打卡',
  'visual.html': '生成示意图',
  'mindmap': '生成思维导图',
  'image': '生成图片',
}

/**
 * 会话内已启用的 ondemand 工具（P3）：key=sessionId。
 * tool.request 成功后写入，本会话后续所有请求持续可用；应用重启即清零（AI 重新申请即可）。
 */
const enabledOnDemand = new Map<string, Set<string>>()

function buildToolsPayload(sessionId?: string, only?: string[], modeOpts?: {
  /** 统一助手 confirm 模式：只保留可安全暂存的写工具 */
  confirmMode?: boolean
  /** 统一助手只读日程：隐藏所有日程写工具 */
  scheduleReadOnly?: boolean
  /** 统一助手只读情报池：隐藏 intel 写工具（筛选/推荐请用情报助手的 📡 面板，D8） */
  intelReadOnly?: boolean
}): {
  payload: unknown[]
  nameMap: Map<string, string>
  /** 本轮可用的写入类工具注册名集合（requires==='write'），供会话写上限计数 */
  writeTools: Set<string>
  /** 本轮可用的只读工具注册名集合（并行批次判定用，Agent 循环第 1 层） */
  readOnlyTools: Set<string>
  /** 因模块权限被过滤掉的工具所属模块（用于 system prompt 给出可操作指引） */
  deniedModules: Set<string>
  /** 是否有 vault.* 工具被 vaultFile 文件域权限拦截（指引文案用） */
  deniedVaultFile: boolean
  /** 是否存在被 tier=ondemand 折叠、且尚未启用的工具（system prompt 指引 tool.request 用） */
  hasOnDemandHidden: boolean
  /** 权限过滤后仍可用的 skill 清单（注入 system prompt，让 AI 感知已配置的能力包） */
  skills: Array<{ registryName: string; title: string; description: string }>
} {
  const reader = getSettingReader()
  // v3.1.2 条目11：本会话是否为支线旁问——决定写类工具是否进入模型视野
  const laneSession = sessionId ? getAgentSession(sessionId) : undefined
  const isSideLaneSession = !!(laneSession?.parentSessionId && laneSession.lane === 'side')
  // 本会话已启用的 ondemand 工具（tool.request 申请，会话内持久）
  const extraTools = sessionId ? enabledOnDemand.get(sessionId) : undefined
  // 按模块权限预过滤：AI 无权使用的操作不进入其视野（invoke 处另有硬校验兜底）
  const all = listTools().filter(t => t.enabled)
  const onlySet = only ? new Set(only) : null
  const deniedModules = new Set<string>()
  let deniedVaultFile = false
  let hasOnDemandHidden = false
  const tools: ToolDescription[] = all.filter(t => {
    // N-1 手册通道：只放行白名单工具（help.search），其余一律不进视野
    if (onlySet && !onlySet.has(t.name)) return false
    // v3.1.2 条目11：支线旁问**只解答、不改文件**——写类工具一律不进支线视野（硬拦截，非提示词约定）。
    // 与铁律 3 同一机制：requires==='write' 的工具被预过滤出模型视野。这条判定放在最前面，
    // 是为了让 tool.request 也绕不过（即便申请过写工具，支线这边照样 return false）。
    if (isSideLaneSession && t.requires === 'write') return false
    // 统一助手：日程只读（写工具交给日程助手），情报池只读（筛选/推荐交给情报助手 📡），确认模式隐藏不可安全预览的写工具
    if (modeOpts?.scheduleReadOnly && t.module === 'schedule' && t.requires === 'write') return false
    if (modeOpts?.intelReadOnly && t.module === 'intel' && t.requires === 'write') return false
    if (modeOpts?.confirmMode && isConfirmModeHiddenTool(t.name, t.requires)) return false
    const denied = checkModulePermission(t, reader)
    if (denied && t.module) deniedModules.add(t.module)
    if (!denied && t.vaultFile && checkVaultFilePermission(t, reader)) {
      deniedVaultFile = true
      return false
    }
    if (denied) return false
    // 终端模块总闸（docs/terminal-module-design.md §6）：terminalAiExec 关 = 执行工具完全不进视野。
    // 独立于 aiModulePermissions 的产品开关（默认 false），故在权限门之后单独判。
    if (t.module === 'terminal' && reader('terminal.aiExec') !== true) {
      deniedModules.add('terminal')
      return false
    }
    // P3 装载层：ondemand 工具仅在会话内被 tool.request 启用后才进入视野。
    // 例外：显式白名单（`only`，如手册通道 / 日程助手）内的工具视为「已启用」——
    // 白名单本身就是调用方对可见性的明确决定。
    if (t.tier === 'ondemand' && !onlySet?.has(t.name) && !extraTools?.has(t.name)) {
      hasOnDemandHidden = true
      return false
    }
    return true
  })
  const payload = tools.map(t => ({
    type: 'function',
    function: {
      name: toFnName(t.name),
      description: `${t.title} —— ${t.description}`,
      parameters: t.inputSchema,
    },
  }))
  const nameMap = new Map<string, string>()
  for (const t of tools) nameMap.set(toFnName(t.name), t.name)
  // 写入类工具集合：按注册声明的 requires 判定，不背名单（新增写工具自动纳入，无需同步此处）
  const writeTools = new Set(tools.filter(t => t.requires === 'write').map(t => t.name))
  // 只读工具集合：并行批次判定用（Agent 循环第 1 层单轮密度；写/特殊工具另有名字排除兜底）
  const readOnlyTools = new Set(tools.filter(t => t.readOnly && t.requires !== 'write').map(t => t.name))
  const skills = tools
    .filter(t => t.source === 'skill')
    .map(t => ({
      registryName: t.name,
      title: t.title,
      description: t.description.replace(/^\[Skill\]\s*/, ''),
    }))
  return { payload, nameMap, writeTools, readOnlyTools, deniedModules, deniedVaultFile, hasOnDemandHidden, skills }
}

/**
 * AI 教学场景模板的标题（与渲染层 src/modules/ai-teaching/index.tsx 的 `TEMPLATES[].label` 一致，
 * 新建会话时标题直接取 label）。仅用于「存量会话来源回填」的历史救济 ——
 * 会话文件夹机制落地前创建的教学会话既无工作区归属也无文件夹，只能靠标题认。
 * ⚠️ 渲染层改模板名时要同步这里，否则那批历史会话会重新混进助手列表。
 */
const LEGACY_TEACHING_TITLES = new Set(['跟我学（教学）', '深度研读（织网）', '周复盘', '画像诊断'])

const SYSTEM_PROMPT_BASE = [
  '你是本地知识管理应用 Phrontis 内置的 AI 助手。',
  '你可以调用工具读写用户的本地数据（知识库、博客日记、日程待办、习惯打卡、书签、番茄专注统计等）。',
  '规则：',
  '1. 需要数据时先调工具，不要编造；',
  '2. 可用的工具已按用户对各模块的授权过滤——列表里没有的模块即无权操作，直接如实告知即可，不要尝试绕过；',
  '3. 标注为写入类的工具会真实生效并留有审计记录，执行前确保理解了用户意图；',
  '4. 回答使用简体中文，简洁直接；',
  '5. 引用知识库内容时注明页面标题。',
  '6. 本次请求可用的工具列表以系统提供的 tools 为准：用户可能随时调整模块授权，即使历史对话中你曾表示缺少某工具，也必须先对照当前列表确认，不要沿用旧结论拒绝。',
].join('\n')

function buildSystemPrompt(context?: AgentContextInfo): string {
  if (!context) return SYSTEM_PROMPT_BASE
  let dataText = ''
  // ★ 前缀稳定红线（B2 纠正）：**这里只能放逐字稳定的内容**。
  // system + tools 是 prompt cache 前缀，一旦每轮变化（如 @ 引用骨架、感知素材）
  // 就会让整段 system + core 14 工具（≈7.7k tok）逐轮重算。
  // @ 引用骨架与感知素材已挪到 `composeContextWithDigest` 的 extraPrefix（首条 user 消息层）。
  // 本函数的入参 `context` 也由渲染层每轮现算，故只放「本轮正在看什么」这类
  // 短摘要 + 去重后的元数据（不含被引用笔记的正文骨架）。
  const refs = Array.isArray((context.data as Record<string, unknown> | undefined)?.attachedFiles)
    ? (context.data as Record<string, unknown>).attachedFiles as Array<{ title?: string; path?: string }>
    : []
  if (refs.length > 0) {
    // 只列标题与路径（告诉模型「用户引用了这几篇」，正文骨架走 extraPrefix）
    dataText = '用户为本轮对话引用了以下知识库笔记（其骨架见本轮消息开头的注入段）：\n' +
      refs.map((r) => `— 《${String(r?.title ?? '')}》（${String(r?.path ?? '')}）`).join('\n')
  } else {
    try {
      dataText = JSON.stringify(context.data ?? {}, null, 0)
    } catch { /* ignore */ }
  }
  if (dataText.length > 6000) dataText = dataText.slice(0, 6000) + '…(截断)'
  return SYSTEM_PROMPT_BASE +
    `\n\n【当前上下文】用户正在查看：${context.label}（类型 ${context.type}）。` +
    (dataText ? `\n上下文数据：\n${dataText}` : '') +
    '\n用户的问题大概率与该上下文相关；若需要更多数据仍应调用工具。'
}

// ===== 日程助手（source === 'schedule'）—— docs / .claude/plans/schedule-assistant-p1.md =====
/** 日程助手工具白名单：只把日程工具放进模型视野（与通用助手的宽工具面分化，铁律 16：少工具 = 少误触/少 token） */
const SCHEDULE_TOOL_NAMES = [
  'builtin.schedule.list-todos',
  'builtin.schedule.create-todo',
  'builtin.schedule.update-todo',
  'builtin.schedule.delete-todo',
  'builtin.schedule.list-workflows',
  'builtin.schedule.get-workflow',
  'builtin.schedule.create-workflow',
  'builtin.schedule.update-workflow',
  'builtin.schedule.delete-workflow',
  'builtin.schedule.mutate-stage',
  'builtin.schedule.reorder-stages',
  'builtin.schedule.mutate-checkpoint',
  'builtin.schedule.list-recurring',
  'builtin.schedule.create-recurring',
  'builtin.schedule.update-recurring',
  'builtin.schedule.delete-recurring',
]

/** 日程助手人设/规则（逐字稳定 → 进 system，命中 prompt cache 前缀） */
const SCHEDULE_PERSONA = [
  '\n\n【日程助手】你是 Phrontis 的「日程助手」——只负责日程/待办的排程、优先级与提醒，不处理知识库、记账、学习、博客等其它事务。规则：',
  '1. 只使用日程相关工具（schedule.*）；其它模块的工具不可用，也不要尝试。',
  // 任务类型（三类，务必建对；这是最容易出错的地方）
  '2. 任务分三类，按语义选对 taskType：',
  '   · deadline（截止类）——有「截止时刻」的任务（交报告、考试、报名/提交截止）。必须 taskType:"deadline" 且 time 用**完整时刻** "YYYY-MM-DD HH:mm"（说不出具体时刻就取当天 23:59）；**不要**传 scheduledStart/scheduledEnd（截止类不占时间格，只画一条红线）。',
  '   · plan（计划类 / 目标类）——要推进但无固定截止的目标（复习完第三章、写完论文初稿）。taskType:"plan"；可在 endCriteria 写「完成标准 / 目标」（如「能默写全部公式」）。',
  '   · daily（零碎）——当天随手完成的小事。taskType:"daily"；不传 time、不传 endCriteria。',
  // 两种「时间」严格区分
  '3. 两种时间语义严格分开：**排期时段** scheduledStart/scheduledEnd（当天分钟数，09:00=540；「X 点做 Y 小时」→ end = start + Y*60）是「排进日程表时间格」；**截止时刻** time 是「几点前必须完成」。一句话里两种都可能出现，按语义分别处理：「周五 23:59 前交报告」= 截止类（deadline+time）；「明天下午 3 点复习 2 小时」= 计划类 + 排期 15:00–17:00。',
  // 时间敏感：相对时间必须换算成具体日期
  '4. 对时间要敏感：系统在【日程数据】里给出了**当前日期、星期、时刻**（「现在：YYYY-MM-DD 周X HH:mm」）与本周一/下周一。以它为锚点把相对时间换算成**具体日期（必要时含时刻）**再动手——今天/明天/后天、本周X / 下周X / 下下周X、这周末、X 天后、月底；「过会儿 / 今晚 / 2 小时后」也按当前时刻算。上午≈09:00、中午≈12:00、下午≈14:00、晚上≈19:00（用户给了具体钟点就按用户的）。不要凭印象猜日期或现在几点；换算不确定就先问一句。',
  // 批量排期预览
  '5. 要把「待安排」批量排进周表时，先给一份**排期预览**：在正文里输出一个 ```schedule-preview 围栏代码块，块内是 JSON（不要注释）：{"title":"本周排期","items":[{"date":"YYYY-MM-DD","start":"HH:mm","end":"HH:mm","title":"任务名"}]}；再用一两句说明是否与已有安排冲突。等用户确认后再用 update-todo 逐条落盘；**只排非 deadline 的任务**（截止类不占格）。未经确认不要批量改期。',
  // 改期 / 改截止
  '6. 改期 / 取消排期用 update-todo 的 scheduledStart/scheduledEnd（传 null = 移除时段）；改截止时刻用 update-todo 的 time（并确保 taskType 仍为 "deadline"）。',
  // 固定日程（重复任务）
  '7. 固定日程（重复任务）：用户说「每周X / 每月X号 / 每N天 + 事项」（如「每周六下午洗衣服」「每月 1 号交房租」）时，用 **create-recurring** 建**重复规则**（freq + weekdays/day/intervalDays + start/end 时段），**不要**建成一次性待办；建之前可先用 list-recurring 看是否已存在同名规则。改规则用 update-recurring（先 list-recurring 取 id）；暂停传 enabled:false；取消用 delete-recurring。注意区分：改「规则」（以后每次都变）用 update-recurring，只改「某一次」的待办才用 update-todo。',
  // 工作流
  '8. 工作流：用户说「拆阶段 / 做计划 / 工作流 / 推进步骤」时，先 list-workflows 或 get-workflow 看现状；新建用 create-workflow（绑定任务时自动 1:1 校验），改阶段用 mutate-stage，调顺序用 reorder-stages，检查点用 mutate-checkpoint。不要自己计算阶段日期是否重叠——工具会自动归一化并顺延。删除任务会级联删除其工作流；删除工作流不会删除任务。',
  // 回答口径
  '9. 回答简洁，用简体中文。涉及时间用「周三 10/14 19:00–20:30」这类明确写法，便于用户对照日程表。',
].join('\n')

function pad2(n: number): string { return String(n).padStart(2, '0') }
function ymd(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }
function fmtMinOfDay(m: number): string { return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}` }
function weekdayZh(d: Date): string { return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()] }
/** 该日期所在周的周一（周一为一周之始） */
function mondayOf(d: Date): Date { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x }

/**
 * 日程数据快照（每轮现算）——今日 / 逾期 / 近 3 天 DDL / 待安排。
 * 逐字会变，故走**首条 user 消息层**（requestInjection）而非 system，避免打散 prompt cache。
 * 总条数截断 ≤ ~40 条，防上下文膨胀。
 */
function buildScheduleInjection(): string {
  const now = new Date()
  const today = ymd(now)
  const in3 = ymd(new Date(now.getTime() + 3 * 86400000))
  const rows = vaultTodosAll().filter(r => r.status !== 'done' && !r.parent_id)
  const when = (r: { scheduled_start?: number | null; scheduled_end?: number | null }): string =>
    r.scheduled_start != null ? ` ${fmtMinOfDay(r.scheduled_start)}–${fmtMinOfDay(r.scheduled_end ?? r.scheduled_start)}` : ''
  const fmt = (r: typeof rows[number]): string =>
    `— ${r.title}（${r.date}${when(r)}${r.task_type === 'deadline' ? ` · DDL${r.time ? ' ' + r.time : ''}` : ''}）`
  const todayRows = rows.filter(r => r.date === today)
  const overdue = rows.filter(r => typeof r.date === 'string' && r.date !== '' && r.date < today)
  const nearDdl = rows.filter(r => r.task_type === 'deadline' && r.date >= today && r.date <= in3)
  const unscheduled = rows.filter(r => r.scheduled_start == null && r.scheduled_end == null && r.task_type !== 'deadline')
  const cap = <T,>(arr: T[], n: number): T[] => arr.slice(0, n)
  // 时间锚点：当前日期 + 星期 + **时刻** + 本周一/下周一（消除「本周X / 下周X」歧义，模型据此推算相对时间）
  const thisMon = mondayOf(now)
  const nextMon = new Date(thisMon); nextMon.setDate(nextMon.getDate() + 7)
  const hhmm = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
  const parts: string[] = [`现在：${today} ${weekdayZh(now)} ${hhmm}（本周一 ${ymd(thisMon)} · 下周一 ${ymd(nextMon)}）`]
  parts.push(todayRows.length ? `【今天 ${todayRows.length} 项】\n${cap(todayRows, 15).map(fmt).join('\n')}` : '【今天】暂无待办')
  if (overdue.length) parts.push(`【逾期 ${overdue.length} 项】\n${cap(overdue, 10).map(fmt).join('\n')}`)
  if (nearDdl.length) parts.push(`【近 3 天 DDL ${nearDdl.length} 项】\n${cap(nearDdl, 10).map(fmt).join('\n')}`)
  if (unscheduled.length) parts.push(`【待安排 ${unscheduled.length} 项】\n${cap(unscheduled, 15).map(r => `— ${r.title}`).join('\n')}`)
  return '\n\n【日程数据（本轮快照）】\n' + parts.join('\n')
}

// ===== 情报助手（source === 'intel'）—— docs/intel-module-plan.md §7 =====
/** 情报助手工具白名单：只读池 + 两个写回动作（窄工具面 = 少误触少 token，铁律 16）。 */
const INTEL_TOOL_NAMES = [
  'builtin.intel.query',
  'builtin.intel.set-recommendations',
  'builtin.intel.set-filter',
  'builtin.time.now',
]

/** 情报助手人设/规则（逐字稳定 → 进 system，命中 prompt cache 前缀；语义要点见方案 §7.2） */
const INTEL_PERSONA = [
  '\n\n【情报助手】你是 Phrontis 的「情报助手」——只管情报池的查询、筛选与推荐（池覆盖科技 / 时政国内 / 国际 / 财经四个版面），不处理日程、知识库、记账等其它事务。规则：',
  '1. 只使用情报相关工具；其它模块的工具不可用，也不要尝试。',
  '2. 【情报数据】快照给出了当前日期与池子概况，一切以它为准——不凭印象编造条目；池内没有就直说没有。',
  // 推荐（写动作 → 左栏结果集）
  '3. 用户要「推荐」时：先 builtin.intel.query 取候选（可按用户兴趣拼关键词），挑 3~8 条，把 id 按推荐优先级传给 builtin.intel.set-recommendations（query 填用户原话），再用正文逐条简述推荐理由（一句话一条）。',
  // 找资料
  '4. 用户「找 X」时：builtin.intel.query 带 q 检索；命中多条先 set-recommendations 收进结果集再汇报；池内没有匹配就明说没有，不要编造。',
  // 筛选（写动作 → feed 顶部 pill）
  '5. 用户「只看论文 / 只看中文 / 只看某源」时：用 builtin.intel.set-filter（kind:"paper"=论文类；kind:"chinese"=中文来源；kw 可叠加关键词）；「恢复全部 / 清掉筛选」传 kind:"" 与空 kw。',
  // 回答口径
  '6. 回答简洁，用简体中文。提到条目时给「源 · 标题 · 一句话价值」格式，不贴长 URL（用户点卡片即可打开）。',
].join('\n')

/**
 * 情报数据快照（每轮现算）——池概况 + 按质量分前 30 条 + 当前推荐。
 * 逐字会变，故走**首条 user 消息层**（requestInjection）而非 system，避免打散 prompt cache（同 buildScheduleInjection）。
 */
function buildIntelInjection(): string {
  const now = new Date()
  const hhmm = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
  const pool = intelItemsAll()
  const meta = intelReadMeta()
  const stats = intelPoolStats()
  if (pool.length === 0) {
    return `\n\n【情报数据（本轮快照）】\n现在：${ymd(now)} ${weekdayZh(now)} ${hhmm}\n池：空（还没有抓取过任何情报；用户在情报模块点「刷新」后即有数据，本轮请如实告知池子为空）`
  }
  // v2：概况按版面统计（四版面一行说完；源级细节模型可 intel.query 查）
  const secLine = stats.perSection.map(([k, n]) => `${SECTION_META[k as IntelSection]?.label ?? k} ${n}`).join(' · ')
  const top = pool.slice(0, 30).map((it) => {
    const sum = (it.summary || '').slice(0, 60)
    return `— [${it.source}|${it.score}] ${it.title}${sum ? ` — ${sum}` : ''}（id:${it.id}${it.fav ? ' · 已收藏' : ''}）`
  }).join('\n')
  const rec = meta.aiRec && meta.aiRec.ids.length > 0
    ? `\n当前 AI 推荐：${meta.aiRec.ids.length} 条（来自「${meta.aiRec.query}」，${meta.aiRec.updatedAt.slice(0, 16).replace('T', ' ')}）`
    : '\n当前 AI 推荐：无（用户问过推荐后由 set-recommendations 生成）'
  const filter = meta.aiFilter && (meta.aiFilter.kind || meta.aiFilter.kw)
    ? `\n当前筛选态：${[meta.aiFilter.kind === 'paper' ? '仅论文' : meta.aiFilter.kind === 'chinese' ? '仅中文' : '', meta.aiFilter.kw ? `关键词「${meta.aiFilter.kw}」` : ''].filter(Boolean).join(' + ') || '无'}`
    : ''
  return [
    `\n\n【情报数据（本轮快照）】`,
    `现在：${ymd(now)} ${weekdayZh(now)} ${hhmm}`,
    `池：共 ${stats.total} 条（${secLine}；收藏 ${stats.fav}）`,
    `按质量分前 30：`,
    top,
    rec + filter,
  ].join('\n')
}

async function agentChat(req: AgentChatRequest, signal: AbortSignal, _chatId: string): Promise<AgentChatResult> {
  const trace: AgentTraceStep[] = []
  const message = String(req?.message ?? '').trim()
  if (!message) return { ok: false, error: '消息不能为空', trace }

  // ---- 会话保障 ----
  let sessionId = String(req.sessionId ?? '')
  if (sessionId && !sessionExists(sessionId)) sessionId = ''
  if (!sessionId) sessionId = createAgentSession('新会话', req.source === 'aiTeaching' ? 'aiTeaching' : req.source === 'schedule' ? 'schedule' : req.source === 'aiAssistant' ? 'aiAssistant' : req.source === 'intel' ? 'intel' : 'assistant').id

  // ---- 落库用户消息 + 自动标题 ----
  appendAgentMessage(sessionId, 'user', message)
  ensureSessionTitle(sessionId, message)

  // ---- N-1 手册通道：首条消息一次性分类；手册通道内出现操作意图即升格（只升不降） ----
  // 日程助手不走手册通道（req.source==='schedule' 恒走通用通道，见 runAgentLoop 的 manual 判定）
  // AI助手（aiAssistant）同理不走手册通道 —— 它是仓库整理任务，不是「软件怎么用」的答疑。
  // 情报助手（intel）同型：专属领域助手，恒走通用通道（v3.12.0）。
  if (req.source !== 'aiTeaching' && req.source !== 'schedule' && req.source !== 'aiAssistant' && req.source !== 'intel') {
    const row = getAgentSession(sessionId)
    if (row && row.mode === undefined) {
      // 三分类：manual 走手册通道；agent 与 tech（第三方/通用技术问答）都走通用助手
      const intent = await classifyManualIntent(message, req.modelId)
      setSessionMode(sessionId, intent === 'manual' ? 'manual' : 'agent')
    } else if (row?.mode === 'manual' && hasOperationIntent(message)) {
      setSessionMode(sessionId, 'agent')
      notifyAssistant(sessionId, '已从「使用帮助」切换到通用助手')
    }
  }

  const result = await runAgentLoop(sessionId, req.context, signal, trace, req.source, { modelId: req.modelId, effort: req.effort, skillName: req.skillName })
  // 支线旁问：按本轮结果落运行态（成功 done / 其余 cut）；普通会话 no-op
  setSideLaneStatus(sessionId, result.ok ? 'done' : 'cut')
  return result
}

/** N-1：向渲染层推一条助手提示（如手册通道→通用助手的升格 Toast） */
function notifyAssistant(sessionId: string, message: string): void {
  try { broadcast(BROADCAST_CHANNEL.assistantNotice, { sessionId, message }) } catch { /* 广播失败不影响主流程 */ }
}

/**
 * 历史装配（会话压缩改造）：digest 检查点之后的消息 → 条数硬上限（-40）→ token 轮级裁剪。
 * 检查点之前的旧轮已被纪要替代、不再进上下文；无 digest / 检查点失效时与原行为一致
 * （裁剪兜底语义不变：压缩失败/关闭时行为逐字节同改造前）。
 */
function assembleAgentHistory(sessionId: string): {
  digest: SessionDigest | null
  history: { role: 'user' | 'assistant'; content: string }[]
  budget: { totalTurns: number; keptTurns: number; estimatedHistoryTokens: number }
} {
  const rowsAll = getAgentMessages(sessionId).filter(m => m.role === 'user' || m.role === 'assistant')
  const digest = getAgentSession(sessionId)?.digest ?? null
  const baseRows = digest ? (rowsAfterDigest(rowsAll, digest.upto_id) ?? rowsAll) : rowsAll
  const historyAll = baseRows
    .slice(-40)
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  const budgetTokens = Math.floor(Number(getSettingReader()('agentContextBudgetTokens')) || 24000)
  const budget = trimHistoryByBudget(historyAll, budgetTokens)
  return {
    digest,
    history: budget.kept,
    budget: { totalTurns: budget.totalTurns, keptTurns: budget.totalTurns - budget.droppedTurns, estimatedHistoryTokens: budget.estimatedTokens },
  }
}

/**
 * 构建支线旁问的**固化上下文快照**（v3.1.2 条目11）。
 *
 * 内容 = 分叉点回答全文 + 主线此前 K 轮（每轮 = user + assistant）。
 * 截断口径：快照过长时**保留尾部**（分叉回答在末尾，必须留下），丢掉最早的前轮。
 * 纯函数、无副作用——只在 `agent:createSideLane` 建支线时算一次，之后随会话持久化。
 */
function buildSideLaneSnapshot(parentSessionId: string, anchor: AgentMessageRow | null, turns: number): string {
  const rows = getAgentMessages(parentSessionId).filter(m => m.role === 'user' || m.role === 'assistant')
  const fmt = (r: AgentMessageRow): string => `${r.role === 'user' ? '用户' : 'AI'}：${r.content}`
  let anchorIdx = anchor ? rows.findIndex(m => m.id === anchor.id) : rows.length - 1
  if (anchorIdx === -1) anchorIdx = rows.length - 1
  const before = rows.slice(Math.max(0, anchorIdx - turns * 2), anchorIdx)
  const parts: string[] = []
  if (before.length > 0) parts.push(`— 主线此前 ${Math.ceil(before.length / 2)} 轮 —\n` + before.map(fmt).join('\n\n'))
  if (anchor) parts.push(`— 被追问的回答（分叉点）—\n${anchor.content}`)
  const CAP = 6000
  const text = parts.join('\n\n')
  return text.length > CAP ? text.slice(-CAP) : text
}

/** 从会话库当前内容直接推理（不追加新用户消息）——重新生成/编辑重推共用 */
/** 中断出口的上下文（可选）：进度 / 改动清单 / carry / 是否写「继续」现场 */
interface InterruptContext {
  /** 本次真实写改动（此前只在成功分支返回，失败时「本次改动」面板拿不到已写的东西） */
  changes?: AgentChange[]
  /** 本次 run 消耗的轮数 */
  rounds?: number
  /** 本次 run 的工具调用次数 */
  toolCalls?: number
  /** 已获得的工具结果摘要（buildResumeCarry 产出；空串 = 没留下现场） */
  carry?: string
  /** 是否写会话 resume（支线旁问 / 手册通道传 false：重问成本低，不给「继续」） */
  writeResume?: boolean
}

/** 归因事实 → 卡片正文用的事实（改动清单只搬卡片要展示的字段；旁白取 trace 里最后一条带 processText 的轮次） */
function interruptFactsOf(
  it: Interruption,
  dt: InterruptionDetail,
  trace: AgentTraceStep[],
  ctx?: InterruptContext,
): InterruptFacts {
  const lastProcess = [...trace].reverse().find(s => !!s.processText)
  return {
    reason: friendlyReason(it, dt),
    aborted: it.code === 'USER_ABORTED',
    rounds: Math.max(0, Math.floor(Number(ctx?.rounds ?? dt.round ?? 0) || 0)),
    toolCalls: Math.max(0, Math.floor(Number(ctx?.toolCalls ?? 0) || 0)),
    changes: (ctx?.changes ?? []).map(c => ({ action: c.action, target: c.target, ...(c.file ? { file: c.file } : {}) })),
    ...(lastProcess?.processText ? { lastProcessText: lastProcess.processText } : {}),
  }
}

/** 写续跑现场（尽力而为：失败只留日志，**绝不**因为「记不上现场」而改变本次调用的返回结果） */
function persistResume(sessionId: string, messageId: string, facts: InterruptFacts, carry: string): void {
  try {
    updateSessionResume(sessionId, {
      at: nowLocal(),
      message_id: messageId,
      reason: facts.reason,
      aborted: facts.aborted,
      tool_calls: facts.toolCalls,
      changes: facts.changes,
      carry,
    })
  } catch (err) {
    console.error('[agent] 续跑现场落库失败', err)
  }
}

/**
 * 中断出口（归因 P0 + A 方案，2026-10-14）：失败 / 停止 / 预算耗尽统一在这里收口 ——
 * 写一条中断 assistant 消息（原因 + 建议 + 进度 + 改动清单 + 诊断块），把「继续」的现场写回会话行，
 * 并返回带归因码的结果。
 * 归因码的唯一真源是 electron/lib/llmFailurePure.ts（卡片文案 / 重试判定 / 审计统计 / 角标读同一个码）。
 */
function interruptResult(
  sessionId: string,
  trace: AgentTraceStep[],
  raw: RawFailure,
  interruption?: Interruption,
  detail?: InterruptionDetail,
  ctx?: InterruptContext,
): AgentChatResult {
  const it = interruption ?? classifyFailure(raw)
  const dt = detail ?? interruptionDetailOf(raw)
  const facts = interruptFactsOf(it, dt, trace, ctx)
  // 有现场才有「继续」按钮：没有按钮就不能在正文里提它
  const willResume = ctx?.writeResume !== false
  // 正文首行必须是人能看懂的原因：reason 就是 friendlyReason 的产出（契约源码级断言锁「文案只在这里产生」）
  const content = buildInterruptContent({
    reason: facts.reason,
    advice: suggestedActionText(it),
    rounds: facts.rounds,
    toolCalls: facts.toolCalls,
    changes: facts.changes,
    ...(facts.lastProcessText ? { lastProcessText: facts.lastProcessText } : {}),
    aborted: facts.aborted,
    canResume: willResume,
    // 「用户停止」不贴诊断块：原因自明，贴了反而像出故障
    ...(it.code === 'USER_ABORTED' ? {} : { diagnostics: buildDiagnostics(it, dt) }),
  })
  let messageId: string | undefined
  try {
    messageId = appendAgentMessage(sessionId, 'assistant', content, trace)
  } catch (err) {
    // 落库失败不能让「中断原因」也一起消失：至少留日志（异常不静默是归因 P0 的硬要求）
    console.error('[agent] 中断记录落库失败', err)
  }
  // 有中断卡才有可挂「继续」的锚点（缺锚点的现场按钮无处可挂，等于没有）
  if (ctx?.writeResume !== false && messageId) persistResume(sessionId, messageId, facts, ctx?.carry ?? '')
  return {
    ok: false,
    sessionId,
    reply: content,
    error: facts.reason,
    code: it.code,
    interruption: it,
    interruptDetail: dt,
    changes: ctx?.changes,
    trace,
  }
}

/** 输出被截断（G5 = B-29）：提示段落追加到正文末尾（ok=true，用户可见「被截断 + 可续写」） */
function withTruncationNotice(reply: string, it: Interruption, detail: InterruptionDetail): string {
  return reply + '\n' + buildInterruptNotice(it, detail, { separator: true, diagnostics: true })
}

async function runAgentLoop(
  sessionId: string,
  context: AgentContextInfo | undefined,
  signal: AbortSignal,
  trace: AgentTraceStep[],
  source?: string,
  llmOpts?: { modelId?: string; effort?: 'off' | 'low' | 'medium' | 'high'; skillName?: string },
  /**
   * allowEmptyHistory：场景/模板启动专用。会话刚建、尚无用户消息时放行，
   * 用一条**不落库**的虚拟首轮触发——聊天区第一条即 AI 回复，
   * 避免把程序化的场景开场白伪造成用户消息（2026-09-09 体验优化）。
   *
   * resumeInjection（A 方案 §3.4）：续跑专用。中断卡是一条 assistant 消息、排在历史末尾，
   * 所以守卫要放行「末条不是 user」；注入文本作为**一条不落库的合成 user 轮**追加在 convo 末尾
   * （不进 requestInjection 槽：续跑指令必须是「最近一条指令」才有牵引力）。
   */
  opts?: { allowEmptyHistory?: boolean; resumeInjection?: string }
): Promise<AgentChatResult> {
  // ---- 从会话库重建对话历史（仅 user/assistant 文本轮） ----
  // 会话压缩：检查点之前的旧轮已被纪要替代（assembleAgentHistory）；其后再做
  // 条数硬上限（-40）与 token 轮级裁剪——压缩失败/关闭时兜底，长会话不再全量进模型
  const runStarted = Date.now() // 归因 P0：中断卡的「耗时」与诊断块用它
  const resumeInjection = String(opts?.resumeInjection ?? '')
  let asm = assembleAgentHistory(sessionId)
  let history = asm.history
  const virtualKickoff = opts?.allowEmptyHistory === true && history.length === 0
  if (!virtualKickoff && (history.length === 0 || (history[history.length - 1].role !== 'user' && !resumeInjection))) {
    return { ok: false, sessionId, error: '没有可重新生成的用户消息', trace }
  }

  // N-1 手册通道：仅 assistant 来源、且会话已分类为 manual 时启用（AI 教学恒走通用通道）
  // 来源：显式传入优先；缺省按会话记录回推（regenerate / edit 等不带 source 的路径）——
  // 否则日程助手会话在这些路径会退化成通用助手（人设/工具面/摘要全丢）。
  if (!source && sessionId) source = getAgentSession(sessionId)?.source
  const runModeRow = getAgentSession(sessionId)
  const manual = source !== 'aiTeaching' && source !== 'schedule' && source !== 'intel' && runModeRow?.mode === 'manual'
  // ---- 统一 AI 助手（v3.11.0）：文件作用域 + 写入策略 ----
  // 旧 aiAssistant 来源只作为兼容入口；新会话一律 source='assistant'。
  // 缺省 source 也按通用助手处理（老会话 / 某些内部入口不带来源）；AI 教学与日程上面已回推
  const unifiedAssistant = !source || source === 'assistant' || source === 'aiAssistant'
  const ctxData = (context?.data ?? {}) as Record<string, unknown>
  const scopeAll = unifiedAssistant
    ? (typeof ctxData.scopeAll === 'boolean'
        ? ctxData.scopeAll
        : runModeRow?.scopeAll !== false)
    : true
  const writeMode: 'direct' | 'confirm' = unifiedAssistant
    ? (ctxData.writeMode === 'confirm' || ctxData.writeMode === 'direct'
        ? ctxData.writeMode
        : (runModeRow?.writeMode === 'confirm' ? 'confirm' : 'direct'))
    : 'direct'
  const rawScope = Array.isArray(ctxData.scope)
    ? ctxData.scope.filter((x): x is string => typeof x === 'string')
    : (runModeRow?.scope ?? [])
  const aiScope = unifiedAssistant && !scopeAll ? normalizeSessionScope(rawScope) : undefined
  const aiPropose = unifiedAssistant && writeMode === 'confirm'
  // 会话级模型 / 思考强度：请求没显式带时回落到会话行（regenerate / edit 等路径不传 modelId）
  if (llmOpts) {
    llmOpts = {
      ...llmOpts,
      modelId: llmOpts.modelId || runModeRow?.modelId || undefined,
      effort: llmOpts.effort ?? runModeRow?.effort,
    }
  }
  // P3 装载层：工具 payload 可能在循环中重建（tool.request 启用新工具后下一轮生效）
  let toolsState = buildToolsPayload(
    sessionId,
    manual ? [MANUAL_CHANNEL_TOOL] : source === 'schedule' ? SCHEDULE_TOOL_NAMES : source === 'intel' ? INTEL_TOOL_NAMES : undefined,
    { confirmMode: aiPropose, scheduleReadOnly: unifiedAssistant, intelReadOnly: unifiedAssistant },
  )
  let toolPayload = toolsState.payload
  const { nameMap, deniedModules, deniedVaultFile, skills } = toolsState
  // v3.1.2 条目11：支线写类工具**硬拦截**。模型视野里已经没有写工具（buildToolsPayload 已过滤），
  // 但 nameMap 命中不到时会 fallback 把 `__` 还原成 `.`——模型幻觉出的 builtin.vault.write 会被还原成
  // 真名并**真的落盘**。所以这里再兜一道：支线 + 写工具 → 直接拒绝，不执行。
  const runSessionRow = source === 'aiTeaching' ? getAgentSession(sessionId) : undefined
  const runIsSideLane = !!(runSessionRow?.parentSessionId && runSessionRow.lane === 'side')
  // 只在支线会话构造（不依赖可见性的写工具全集）——非支线时为 undefined，零开销
  const writeToolUniverse = runIsSideLane
    ? new Set(listTools().filter(t => t.requires === 'write').map(t => t.name))
    : undefined
  const deniedHint = deniedModules.size > 0
    ? `\n\n【权限提示】以下模块用户尚未授权 AI 操作：${[...deniedModules].join('、')}。若用户请求这些模块的操作，请如实说明当前未授权，并提示可在 设置 → AI → 权限 中开启后重试。`
    : ''
  const vaultFileHint = deniedVaultFile
    ? '\n\n【权限提示】仓库文件读写（vault.* 工具）当前被权限限制。若用户请求操作仓库内笔记文件（列目录/读文件/搜内容），请如实说明需在 设置 → AI → 权限 → 仓库文件 中开启后重试。'
    : ''
  // P3：存在被折叠的 ondemand 工具时，告知申请机制（写类工具默认不在视野）
  const toolsHint = toolsState.hasOnDemandHidden
    ? '\n\n【扩展工具提示】写入类工具（写文件/建页面/写日记/建待办/打卡等）默认不在上方工具列表中。需要执行写操作时，先调用 builtin.tool.request 申请（tools 传逗号分隔的工具注册名），确认后本会话内持续可用；申请通过后按工具描述使用。不要申请当前任务用不到的工具。'
    : ''
  // 执行纪律（2026-09-10 修）：写操作以"真实调用 + 拿到成功结果"为唯一完成判据。
  // 起因：日程模块权限为只读时，创建工具被预过滤出模型视野，模型无从调用却回复"创建成功"——
  // 用户看到的是一次静默失败被包装成了成功；同样，tool.request 若申请未通过也不得当作已可用。
  const executionHint = '\n\n【执行纪律】对「创建 / 修改 / 删除 / 打卡」这类写操作，只有**真正调用工具并收到成功结果**之后，才能告诉用户已完成。'
    + '若工具不在可用列表中、被权限拒绝、或返回失败，必须如实说明「未执行」及原因（含如何开放权限），'
    + '绝不用「已创建 / 已完成 / 已打卡」之类表述掩盖，也不要用文字描述代替工具调用、或编造 id、时间等执行细节。'
    + '工具返回 ok:false 时如实转述，不要改写为成功。'
  // 注入 skill 清单：让 AI 明确知道自己配置了多少个提示词能力包及其用途（描述截断防 token 膨胀）
  const skillHint = skills.length > 0
    ? `\n\n【已配置 Skill】当前共有 ${skills.length} 个提示词能力包（skill 工具）：\n` +
      skills.map(s => `- ${s.title}（${s.registryName}）：${s.description.slice(0, 120)}`).join('\n') +
      '\nSkill 是声明式提示词资产。当用户请求恰好对应某个 Skill 的能力时，调用该 skill 工具获取提示词并遵循执行；不确定时优先用通用内置工具。'
    : ''
  // v3.1.1 条目10：/ 弹层显式指定 Skill —— 本轮确定性注入其提示词（一次性，不落会话、不进缓存前缀之外的历史）。
  // 显式指定优先于「模型恰好对应才调 skill 工具」的自主判断；仍低于用户当下消息的直接指令。
  const explicitSkill = llmOpts?.skillName ? findSkillPrompt(llmOpts.skillName) : null
  const explicitSkillHint = !llmOpts?.skillName
    ? ''
    : explicitSkill
      ? `\n\n【用户显式指定 Skill：${explicitSkill.title}】用户发送本条消息时明确指定使用该 Skill，以下为其提示词全文，**优先遵循执行**（优先级高于你对 Skill 的自主选择判断，仍以用户消息中的直接指令为最高）：\n${explicitSkill.prompt.length > 6000 ? explicitSkill.prompt.slice(0, 6000) + '\n…（Skill 提示词过长已截断）' : explicitSkill.prompt}`
      : `\n\n（用户指定的 Skill「${llmOpts.skillName}」不存在或已停用，忽略该指定并正常回答。）`
  // P2（§2.3）：会话约束唯一真相源 = 会话文件夹 CONSTRAINTS.md，每轮发送即时重读（编辑器改动即刻生效）；
  // 2-6 读兼容：仅旧会话未落文件夹时回退 DB sessionInstructions。
  // N-5（2026-09-26）：分层约束是**教学**机制 —— 按 source 门控（此前全局层未门控，
  // 教学全局要求会漏进助手对话，与拍板「独立第二份，不共用」相悖；台账 N-5 前提澄清的本意即如此）。
  // L2（2026-10-17 学习流 v2 §八-1）：四层拼装收敛到零依赖纯函数 `scopePrompt.buildScopePrompt` ——
  // 顺序恒为 **全局 → 工作区 → 知识点 → 课时**（越细越优先），每层独立上限、空层不出标题行；
  // 契约脚本 `verify-scope-injection.mjs` 直接跑真实实现。存量「课时夹」那份是最细一层，**不迁移**。
  const scopeLayers = source === 'aiTeaching'
    ? {
        global: readGlobalConstraints(getSettingReader()).text ?? '',
        workspace: readWorkspaceConstraintsForSession(sessionId, getSettingReader()).text ?? '',
        unit: readUnitConstraintsForSession(sessionId, getSettingReader()),
        lesson: resolveConstraintsForInjection(sessionId, getSettingReader()),
      }
    : { global: '', workspace: '', unit: '', lesson: '' }
  const scopeInstHint = source === 'aiTeaching' ? buildScopePrompt(scopeLayers) : ''
  // N-5：助手**独立**要求注入（.assistant/，2026-09-24 三轮拍板）——与教学三层完全分开，措辞不复用教学口径。
  // 默认单层（全局），用户从助手面板入口按需升格出会话层；每轮重读，保存后下一轮生效。
  // 优先级链（拍板 G）：用户当下消息 > 本会话要求 > 全局要求。
  const assistantConstraintHint = source === 'aiTeaching' ? '' : (() => {
    const g = readAssistantGlobalConstraints().trim()
    const sess = readAssistantSessionConstraints(sessionId).trim()
    const parts: string[] = []
    if (g) parts.push(
      `【助手全局要求】（用户设定于仓库 .assistant/CONSTRAINTS.md，所有助手对话共同遵守；与本会话要求或用户当下消息冲突时以更细层为准）\n${g.length > 3000 ? g.slice(0, 3000) + '\n…（全局要求过长已截断）' : g}`,
    )
    if (sess) parts.push(
      `【本会话要求】（用户仅为本对话设定于 .assistant/ 会话文件夹的 CONSTRAINTS.md，优先于全局要求；与用户当下消息冲突时以用户消息为准）\n${sess.length > 4000 ? sess.slice(0, 4000) + '\n…（会话要求过长已截断）' : sess}`,
    )
    return parts.length ? '\n\n' + parts.join('\n\n') : ''
  })()
  // N-7：术语表注入（别名制，.assistant/glossary.json，预填可改）。解决「用户说博客、AI 乱翻日程」
  // 的理解层问题；检索能力缺口由 builtin.blog.search 补（两件分开修，见台账 N-7 §一）。
  // 改动低频 → 放 systemFull 稳定前缀合规（与教学约束同哲学）；文件缺失/坏 JSON → 零注入。
  const glossaryHint = source === 'aiTeaching' ? '' : (() => {
    const rows = readAssistantGlossary()
    if (!rows || rows.length === 0) return ''
    const lines = rows.map(r => `- ${r.alias} → ${r.name}${r.tools ? `（工具：${r.tools}）` : ''}`)
    return '\n\n【术语表（用户口径 ↔ 数据域对照）】用户可能用左列的口语称呼指代某类数据；需要检索或写入时按对应工具操作正确的数据域，不要到别的模块乱找（例如找博客日记要用博客的检索工具，不要翻日程或动态）：\n' + lines.join('\n')
  })()
  // v3.1.2 条目11：支线判定**提前**到规则装配之前——「不出题」与「写工具不可见」都要先知道是不是支线。
  // （原先在下面 laneRow 处才算，晚于本段的 quizRuleHint → 支线照常拿到出题协议。）
  const laneRow = source === 'aiTeaching' ? getAgentSession(sessionId) : undefined
  const isSideLane = !!(laneRow?.parentSessionId && laneRow.lane === 'side')
  // P3a（§3.8-2 标题规则，3-13 拍板）：AI教学会话每条回答首行带三级标题，供快速定位条取锚点标题
  const titleRuleHint = source === 'aiTeaching'
    ? '\n\n【回答标题规则（AI教学）】每条回答的第一行必须是一个简短标题，形如 `### 这里写标题`（不超过 20 字，概括本回答核心内容），标题后换行写正文；标题行之前不得有任何其他文字。该标题用于用户在对话流中快速定位每条回答。'
    : ''
  // v3.8.0（2026-10-16 用户拍板）：「题目视图」已删除，出题改为**落一篇「题目文档」**——
  // 整卷写成 .md（每题一个 ```quiz 围栏），在文档阅读视图 / 知识库作答（同一条判分/错题链路）。
  // v3.1.2 条目11：**支线不出题**（硬边界）——支线只解答零碎小知识点，出题是主线的职责。
  const quizRuleHint = source === 'aiTeaching' && !isSideLane
    ? '\n\n【出题规则（AI教学）】当用户要求出题/测验/练习时，把整卷写成**一篇 Markdown 题目文档**：调 course.organize.archive（不在工具列表时先 builtin.tool.request 申请）落盘，标题形如「练习·<主题>」；写完在回答里给出文件路径，并说明可在文档阅读视图/知识库里直接作答（题卡自动判分，错题进错题本）。不要在回答正文里贴整卷题目。\n' +
      '文档格式：开头一个标题 + 一行说明（覆盖范围 / 题量），之后每道题单独一个 ```quiz 围栏代码块，块内是一个 JSON 对象（不要注释、不要多个对象）：{"no":1,"question":"题干（支持 markdown）","options":[{"key":"A","text":"选项一"},{"key":"B","text":"选项二"},{"key":"C","text":"选项三"},{"key":"D","text":"选项四"}],"answer":"A","explanation":"答案解析（支持 markdown）"}。no 从 1 连续编号。不要输出 points 分值字段（客户端不渲染分值）。answer 的值必须是 options 中某个 key；默认四选一。\n' +
      '两个硬约束：① 围栏语言必须是 quiz（\u0060\u0060\u0060quiz），写成 json 或不带语言都不会被渲染成题卡；② JSON 字符串值内部禁止出现未转义的英文双引号——题干/选项/解析里需要引用术语时一律用中文引号『』或“”，否则 JSON 被截断、题目渲染失败。\n' +
      '例外：讲解过程中顺手的**单题快检**可以就地贴一个 ```quiz 围栏（一条回答最多一道），不必为一道题单独建文档；整卷练习一律走文档。'
    : ''
  // UI 优化条目11A（任务规划激活）：阶段推进时输出 ```plan 围栏 → 左栏「任务规划」渲染为带状态进度列表
  const planRuleHint = source === 'aiTeaching'
    ? '\n\n【任务规划协议（AI教学）】本会话有明确流程或阶段（如教学流程：通读资料→大纲→精讲→测验→笔记）时，你须在阶段发生推进的回答里输出一个 ```plan 围栏代码块，块内是一个 JSON 数组（不要注释）：[{"step":"步骤名（不超过12字）","status":"done|current|todo"}]。规则：status 恰好一个为 "current"，其余为 "done" 或 "todo"；每次输出完整最新清单（含全部步骤，未开始的也要列出）；步骤可按实际情况增删改名；阶段没有变化的普通回答不必输出。'
    : ''
  // UI 优化条目12/13（提问模式）：需要用户选择/澄清时输出 ```ask 围栏 → 输入区变形为选择卡
  const askRuleHint = source === 'aiTeaching'
    ? '\n\n【提问模式协议（AI教学）】当你需要用户做选择、澄清或确认才能继续时（方案二选一、参数不明确、流程确认等），在回答正文末尾输出一个 ```ask 围栏代码块，块内是一个 JSON 对象（不要注释）：{"question":"一句话问题","options":["选项一","选项二"],"allowCustom":true}。规则：选项 2~6 个、每项不超过 20 字且可直接作为用户的回答发出；allowCustom=true 表示也允许用户自由输入；一次回答最多一个 ask 块；客户端会把提问渲染成交互选择卡，正文里不要再重复罗列同样的选项。整卷式批量提问（如诊断问卷）时块内改为 JSON 数组，每个元素形如 {"question":"问题","options":["选项A","选项B","选项C"]}，用户会整卷作答后统一发回。正式出题仍走 ```quiz 协议，两者不得混用；无需用户确认时不要输出 ask。JSON 字符串值内部禁止未转义英文双引号——需要引用时一律用中文引号，否则 JSON 被截断、提问卡渲染失败。'
    : ''
  // 对话驱动建课：把课程大纲给用户过目时输出 ```outline 围栏 → 渲染成草稿卡（满意才「正式生成」落盘）
  const outlineRuleHint = source === 'aiTeaching'
    ? '\n\n【大纲草稿协议（AI教学）】当你把课程大纲给用户过目时，除正文说明外，输出一个 ```outline 围栏代码块，块内是一个 JSON 对象（不要注释）：{"title":"课程名","goal":"一句话目标","chapters":[{"name":"章名","units":[{"name":"知识点名","goal":"该点学习目标","source":"出处"}]}]}。规则：**分批**——先只展开第一章（其余章只给 name、units 用空数组表示未展开）；用户满意后由客户端「正式生成」按钮落盘（你也可调 course.outline.write）；用户要改就更新草稿、重新发这个围栏。围栏语言必须是 outline（\u0060\u0060\u0060outline）。JSON 字符串值内部禁止未转义英文双引号——需要引用时一律用中文引号『』或“”。另外，知识点粒度：拆到「一个可独立讲解、可出题检验的最小概念」为止（如一个定义、一条定理、一种方法）；依据里的一小节/一段通常对应多个知识点，**不要**把一整节压成一个。**不要**把章节导语、教学目标、考试目标 / 考情分析、重难点提示、学习要求、知识结构总览、复习建议这类元信息当作知识点——某份素材整篇只是导语 / 框架就跳过它，只从其余素材抽取实质内容。'
    : ''
  // P6（§3.13/3-29）：素材目录实时注入（SOURCE.md 条目+提取稿路径+编号引用规则）；无登记则零注入
  const sourcesHint = source === 'aiTeaching' ? (() => {
    const cat = resolveSourcesForInjection(sessionId, getSettingReader())
    return cat ? `\n\n${cat}` : ''
  })() : ''
  // 工件栏方案 §3.2：示意图生成门槛与产物约束（双路触发：命中门槛主动画 + 用户指令强制画）
  const visualHint = source === 'aiTeaching'
    ? '\n\n【示意图工具 visual.html（AI教学）】讲解命中以下四类内容且画图能显著帮助理解时，调用 visual.html 工具生成单文件 HTML 示意图：' +
      '① 抽象概念需具象化 ② 过程/演变有先后 ③ 结构/对比（多对象关系）④ 函数图像/几何图形。纯文字/表格够用的不要画。' +
      '用户明确说「画个示意图/图示一下」时必须调用。若工具列表中没有 visual.html，先用 builtin.tool.request（tools="visual.html"）申请。' +
      '产物约束：单文件自包含、CSS/SVG/JS 全内联、不引用任何外部资源（无 CDN/网络图片/外链字体）、不超过 150 行。配色对比度：正文与背景 ≥4.5:1（WCAG AA）——深底只配近白文字（#FFFFFF/#E5E7EB），浅底只配深灰/黑文字；禁止同色系深浅叠加（深蓝底配深灰字、白底配浅灰正文这类翻车形态）；强调色 ≤3 种。画幅：SVG 用 viewBox（如 680×400）定比例 + style="width:100%;height:auto" 自适应，禁止外层固定 px 宽度与 min-height/100vh——客户端按栏宽渲染并会自动等比放大到全屏，流式宽度才能铺满。中文标注、示意而非网页（无复杂交互/多页）。' +
      '文档内禁止写 <meta http-equiv> CSP 与 <base> 标签（宿主统一注入安全策略，自带 CSP 会因策略取交集禁掉脚本）。' +
      'slug 用 kebab-case 小写英文；title 给中文短标题。HTML 全文只作为工具参数传递，**绝不把 HTML 源码写进回答正文或 markdown 代码块**；生成后在回答里用一句话说明右侧工件栏已打开该图。'
    : ''
  // 思维导图（方案 .AGENT/.claude/plans/ai-teaching-mindmap.md）：整理结构的产物工具，与 visual.html 并列（串行）
  const mindmapHint = source === 'aiTeaching'
    ? '\n\n【思维导图工具 mindmap（AI教学）】用户明确要「思维导图 / 脑图 / 整理结构 / 知识框架」时，调用 mindmap 工具把内容整理成树状结构：' +
      'root 为递归节点 { text, ref?, children? }，text 用一行短短语；节点对应知识库里的某篇笔记（或另一张思维导图）时，ref 填其仓库相对路径（.md 笔记 / .json 导图），点击可跳转。' +
      '树深 ≤6、节点总数 ≤120，超出的先归纳再输出。只把结构交给工具，**绝不把 JSON 写进回答正文**；生成后用一句话说明右侧工件栏已打开。' +
      '若工具列表中没有 mindmap，先用 builtin.tool.request（tools="mindmap"）申请。'
    : ''
  // P8（§3.14）+ UI 优化条目8.2.2：三层学习者画像注入（全局 → 工作区 → 会话，细颗粒覆盖粗颗粒）
  // + 更新建议协议（3-33 Plan B）
  const profileHint = source === 'aiTeaching' ? resolveProfilesForInjection(sessionId, getSettingReader()) : ''
  // 课程模式（docs/ai-teaching-course-mode-plan.md）：工作区开启课程模式时注入「课程目标 + 当前知识点 + 掌握度 + 待复习」，
  // 让模型从「答完这一问」转为「上好这门课」。未开启/无大纲 → 空串（零成本）。
  const courseHint = source === 'aiTeaching' ? buildCourseInjection(sessionId, getSettingReader()) : ''
  // 收藏（v3.6.0）：让 AI 感知到当前工作区钉在左栏「收藏」的文档（只读注入，无工具；用户自己挑出来常看的）
  const favoritesHint = source === 'aiTeaching' ? (() => {
    const wsId = getWorkspaceOfSession(sessionId)
    if (!wsId) return ''
    const favs = listFavorites(wsId)
    if (favs.length === 0) return ''
    return '\n\n【收藏的文档（AI教学）】用户当前工作区钉在左栏顶部「收藏」的文档（用户自己挑出来常看的，区别于素材与产物；需要时可优先引用）：\n'
      + favs.map((f) => `— ${f.name.replace(/\.md$/i, '')}（${f.rel}）`).join('\n')
  })() : ''
  // v3.1.2 条目8+10：AI教学「取材范围」与「产物落点」两条纪律共用一次会话夹解析（避免重复 stat）
  // 条目11：支线的落点跟随**主线**会话夹（`{主线夹}/支线·{标题}/`），不新建自己的夹
  const aiTeachScope = source === 'aiTeaching' ? (() => {
    const wsId = getWorkspaceOfSession(sessionId)
    const wsRel = wsId ? workspaceFolderRel(wsId, getSettingReader()) : null
    const sessionRel = resolveWriteOwnerRel(sessionId, getSettingReader())
    return { wsRel, sessionRel }
  })() : null
  // v3.1.2 条目8：资料范围纪律（AI教学恒注入——无素材时更要防全仓乱扫，故不搭在 sourcesHint 上）。
  // 默认只读材料登记项 + 本工作区夹；用户当前消息明确点名时才放开。长度控制百字级，防缓存前缀膨胀。
  const scopeRuleHint = aiTeachScope ? (() => {
    const { wsRel, sessionRel } = aiTeachScope
    const scope1 = '① 素材目录（SOURCE.md）中登记的文件 / 提取稿 / 链接'
    const scope2 = wsRel
      ? `② 本工作区文件夹 \`${wsRel}/\` 内的内容（含本会话产物${sessionRel ? `，本会话文件夹为 \`${sessionRel}/\`` : ''}）`
      : '② 本会话产物所在文件夹'
    return '\n\n【资料范围纪律（AI教学）】取材默认只限两处：' + scope1 + '；' + scope2 + '。'
      + '除非用户在当前消息中明确要求扩大范围（如「在整个仓库找一下 X」「看看我仓库里有没有 Y」），'
      + '否则不要用 vault.search / vault.read 扫描整个仓库，也不要读工作区文件夹之外的仓库内容。'
      + '用户明确要求时按其指定范围放开；要引用范围内的其他内容时先说明意图，不要自行扩大检索面。'
  })() : ''
  // v3.1.2 条目10：产物落点纪律（与条目8 是同一枚硬币两面：一个管读哪、一个管写哪）。
  // 实时给出本会话文件夹相对路径；工具层还有一道归一化兜底（builtinTools.normalizeAiTeachingWritePath）。
  const writeScopeHint = aiTeachScope ? (() => {
    const { wsRel, sessionRel } = aiTeachScope
    const dest = sessionRel
      ? `\`${sessionRel}/\``
      : (wsRel ? `\`${wsRel}/\` 下本会话的文件夹` : '本会话对应的文件夹')
    return '\n\n【产物落点纪律（AI教学）】你创建或生成的一切文档（讲义、笔记、测验、总结等）统一写入本会话文件夹 ' + dest
      + '（调用工具时 path 要带上该目录前缀，不要只给裸文件名）。'
      + '禁止写入 `SOURCES/`（那是给你读的素材目录，不是放产物的）、禁止写仓库顶层或工作区文件夹根目录。'
      + '用户在当前消息里明确指定了路径时，以用户指定的路径为准。'
  })() : ''
  /**
   * 生图（v3.6.0 对话内生图 `/生图`，docs/ai-image-gen-plan.md §4.5）。
   *
   * 注入面 = 除日程助手以外的全部聊天面。判据取"不是日程"而不是 `source === 'assistant'`：
   *  ① 助手三宿主（悬浮侧栏 / 右栏 / aiChat 整页）与全屏 AI 学堂的 sessionSource 是 undefined，
   *     按 `=== 'assistant'` 卡会把最主力的那个面整个漏掉；
   *  ② §5.1 明确 `/生图` 要在 assistant 与 aiTeaching **两个面的 `/` 弹层**里可见，
   *     而弹层里有指令、system 里没有规则 = 模型不知道要调 image（"敲了没反应"）——
   *     故教学面同时注入；阶段二只改产物落点与工件栏，不再动注入面。
   * 日程助手不注入：它的工具面被刻意收窄（只有日程那几个），给生图规则是负担。
   */
  const imageHint = source !== 'schedule' && source !== 'intel'
    ? '\n\n【生图工具 image】用户敲 `/生图 <描述>`，或明确说「画一张 / 配个图 / 示意图 / 把这张改成…」时，调用 image 生图或改图：' +
      '① prompt 保持用户的语言与诉求原样（中文标注要求别翻成英文）；画幅不填=按内容定，要指定就在 prompt 里说。' +
      '② 改图：把目标图的仓库相对路径填进 ref（上一次 image 的返回里就有）；改图模型没配时工具会按描述重画，并把这一点写在结果里。' +
      '③ **不要为讲解主动配图** —— 只在用户要图时画。' +
      '④ 生成后只用一句话说明（图已显示在对话里），**绝不把 prompt / 返回的 JSON / 图片 base64 写进回答正文**。' +
      '⑤ 要把图插进某篇笔记：拿到产物 relPath 后再调写工具，按**目标页所在目录**算相对路径写成 `![](相对路径)`' +
      (source === 'aiTeaching'
        // 阶段二（方案 §6.1）：教学面产物落会话夹 outputs/，示例必须跟着换 —— 沿用阶段一那句
        // 「图在 .attachments/…」会让模型把图往仓库隐藏目录里找（那个目录在教学面根本不会有图）
        ? '（如页在 `算法/` 下、图在本会话文件夹的 `outputs/` 里，就从 `算法/` 出发算相对路径，该退几层就退几层）。'
        : '（如页在 `算法/` 下、图在 `.attachments/2026-10/x.png`，就写 `![](../.attachments/2026-10/x.png)`）。') +
      '扩位与 `-v2` 重名不要自己猜，一律以工具返回的 relPath 为准。' +
      (source === 'aiTeaching' ? '⑥ 产物落点：本面（AI 教学）落本会话文件夹的 `outputs/` 目录。' : '')
    : ''
  // v3.1.2 条目11：支线旁问上下文（仅带 sideContext 的会话注入）。快照在建支线时固化，跨轮稳定 → 不扰动缓存前缀。
  // 升格为正式会话（lane='main'）后仍保留来源快照，只是不再套「支线纪律」措辞。
  // laneRow / isSideLane 已在前面规则装配处算好（纪律必须早于出题协议，故提前）。
  const sideLaneHint = laneRow?.sideContext
    ? (isSideLane
        ? SIDE_LANE_DISCIPLINE + '\n\n【支线上下文快照（分叉时刻固化）】被追问的回答 + 主线前若干轮：\n'
        : '\n\n【来源上下文（快照）】本条对话由主线会话的一条回答升格而来，以下是其来源快照（仅供参考背景；后续进展以本对话自身历史为准）。\n')
      + laneRow.sideContext
    : ''
  // 日程助手（source==='schedule'）：人设进 system（逐字稳定）；数据快照进首条 user 消息层（每轮现算）
  const schedulePersona = source === 'schedule' ? SCHEDULE_PERSONA : ''
  const scheduleHint = source === 'schedule' ? buildScheduleInjection() : ''
  // 情报助手（source==='intel'）：人设进 system（逐字稳定）；池快照进首条 user 消息层（每轮现算，v3.12.0 §7.2）
  const intelPersona = source === 'intel' ? INTEL_PERSONA : ''
  const intelHint = source === 'intel' ? buildIntelInjection() : ''
  // 统一 AI 助手：作用域 + 写入策略（v3.11.0）
  const scopeHint = !unifiedAssistant
    ? ''
    : scopeAll
      ? '\n\n【统一助手·作用域】本次作用域是整个仓库。仍受仓库文件权限、模块权限与 .ignore 规则约束。'
      : aiScope && aiScope.length > 0
        ? '\n\n【统一助手·作用域】你只能读写本次作用域内的文件；作用域外文件仅当它们是范围内页面的 [[出链]] 目标时才可读取（其余读写调用会返回 ESCOPE 错误）。清单已给出范围内页面；正文按需用 vault.read 读取，不要试图通读整库。'
        : '\n\n【统一助手·作用域】本次没有选择任何仓库文件：不要读取/写入仓库文件（vault.* 调用会被拒绝）；仍可按用户请求使用受权限允许的模块工具。'
  const writeModeHint = !unifiedAssistant
    ? ''
    : writeMode === 'confirm'
      ? '\n【统一助手·暂存纪律】你的所有可暂存写操作会被**暂存**、不会立即落盘，等用户逐条确认后才应用。工具返回的 "staged" 表示已记入方案（不是已写入）。**不要**声称"已完成/已修改"——只有用户确认应用之后才算改动。不可安全预览的写工具已从工具面移除；需要时请让用户切换到「直接执行」。'
      : '\n【统一助手·直接执行】用户选择了「直接执行」：写工具会立即落盘。只有真正调用工具并拿到成功结果后，才能告诉用户已完成。'
  const scheduleReadOnlyHint = unifiedAssistant
    ? '\n【统一助手·日程只读】日程数据只读；不要创建/修改/删除日程。日程写入请让用户使用日程助手。'
    : ''
  // v3.12.0 D8：情报池对通用助手只读——写工具已被 buildToolsPayload 滤出视野，这里补一句指引防「我改不了」式回答
  const intelReadOnlyHint = unifiedAssistant
    ? '\n【统一助手·情报只读】情报池只读（可查询）；筛选与刷新「✨ AI 推荐」请用户打开情报模块的 📡 情报助手。'
    : ''
  const aiAssistantHint = scopeHint + writeModeHint + scheduleReadOnlyHint + intelReadOnlyHint
  const baseSystem = buildSystemPrompt(context)
  // UI 优化条目9②：教学会话的注入分段用量（字符数，渲染层按 ≈2.6 字/token 折算做构成摘要）
  const injection: AiTeachInjectionStats | undefined = source === 'aiTeaching'
    ? {
        systemChars: baseSystem.length,
        // 分层要求合计（四层原始正文长度；实际注入串还含分层标注与截断标记，见 scopePrompt.ts）
        constraintChars: scopeLayers.global.length + scopeLayers.workspace.length + scopeLayers.unit.length + scopeLayers.lesson.length,
        profileChars: profileHint.length,
        sourcesChars: sourcesHint.length,
        ruleChars: titleRuleHint.length + quizRuleHint.length + planRuleHint.length + askRuleHint.length + outlineRuleHint.length + visualHint.length + mindmapHint.length + scopeRuleHint.length + writeScopeHint.length + sideLaneHint.length,
      }
    : undefined
  // N-1 手册通道：system 只用手册提示词（不注入教学/感知/出题/工件/权限等规则）
  const systemFull = manual
    ? buildManualSystemPrompt()
    : baseSystem + schedulePersona + intelPersona + scopeInstHint + assistantConstraintHint + glossaryHint + profileHint + courseHint + favoritesHint + titleRuleHint + quizRuleHint + planRuleHint + askRuleHint + outlineRuleHint + visualHint + mindmapHint + imageHint + sourcesHint + scopeRuleHint + writeScopeHint + sideLaneHint + toolsHint + executionHint + deniedHint + vaultFileHint + skillHint + explicitSkillHint + PARALLEL_HINT + aiAssistantHint

  // ---- 每轮变化的上下文注入段（B1 @ 引用骨架 + B2 感知素材）----
  // ★ 必须走**首条 user 消息层**、不能进 system：system + tools 是 prompt cache 前缀，
  // 逐字稳定才命中（core 14 工具 ≈7.7k tok/轮）。B1 初版误放进 buildSystemPrompt，
  // 引用一变前缀就失效；B2 纠正（开发负责人 2026-09-18 拍板「一并纠正」）。
  // 本段只对**本轮**有效，也因此不该沉淀成系统的长期人设。
  const rawContextRefs = Array.isArray((context?.data as Record<string, unknown> | undefined)?.attachedFiles)
    ? (context!.data as Record<string, unknown>).attachedFiles as Array<{ pageId?: string; title?: string; path?: string }>
    : []
  // 缩窄作用域：只接受 scope 内附件；范围外附件直接丢弃（不静默注入越界内容）
  const contextRefs = unifiedAssistant && !scopeAll
    ? rawContextRefs.filter((r) => !!r?.path && !!aiScope && aiScope.length > 0 && isWithinVaultScope(String(r.path), aiScope))
    : rawContextRefs
  const refInjection = contextRefs.length > 0
    ? buildAttachedRefsInjection(contextRefs.map((r) => ({
        title: String(r?.title ?? ''),
        path: String(r?.path ?? ''),
        raw: readVaultRefText(String(r?.path ?? '')),
      })))
    : ''
  // 感知模式（B2）：开关开启时先检索知识库，把最相关素材注入。
  // 排除已 @ 引用的 pageId —— 同一篇不重复占两段预算。全路零命中 / 检索异常 → 空串，照常发请求。
  // 缩窄文件作用域时关闭感知：感知会检索全库，等于绕过用户圈定范围
  const perceptionOn = getSettingReader()('aiAssistantPerception') === true && !(unifiedAssistant && !scopeAll)
  let perceptionInjection = ''
  if (perceptionOn && !virtualKickoff) {
    const lastUser = [...history].reverse().find((m) => m.role === 'user')
    const pr = await runPerception(String(lastUser?.content ?? ''), {
      excludePageIds: contextRefs.map((r) => String(r?.pageId ?? '')).filter(Boolean),
    })
    if (pr && pr.items.length > 0) perceptionInjection = buildPerceptionInjection({ items: pr.items, dropped: pr.dropped })
  }
  // 生图：本会话「最近生成的图」薄索引（方案 §5.4）。与上面同一理由 —— 放首条 user 消息层，
  // 不放 system（它随会话内容递增而变，进 system 就是每生成一张图就把缓存前缀作废一次）
  const recentImagesHint = (!manual && source !== 'schedule' && source !== 'intel') ? buildRecentImagesHint(sessionId) : ''
  // 统一助手：缩窄作用域时把元数据清单进首条 user 消息层（不进 system —— 清单随任务变，进 system 会作废 prompt cache 前缀）。
  // 整仓不列清单（成本高且无边界意义），只由 system 的作用域提示说明。
  const aiManifestHint = unifiedAssistant && !scopeAll
    ? buildScopeManifest(aiScope, [...history].reverse().find((m) => m.role === 'user')?.content ?? '', false)
    : ''
  // 首条 user 消息层注入（每轮变化的数据快照）：日程 / 情报各自的数据快照 + 引用骨架 / 感知素材 ——
  // 逐字会变的内容都只进这一层，不进 system（防打散 prompt cache 前缀）
  const requestInjection = [scheduleHint, intelHint, refInjection, perceptionInjection, recentImagesHint, aiManifestHint].filter(Boolean).join('\n\n')

  // 纪要以首条 user 消息注入（composeContextWithDigest）——system+tools 是 prompt cache
  // 前缀必须逐字稳定，纪要变化只重建一次性前缀
  let convo: AgentMessage[] = [
    { role: 'system', content: systemFull },
    ...composeContextWithDigest(asm.digest?.text, history, requestInjection),
  ]

  // ---- 自动压缩预检（会话压缩 §6.1）：逼近触发线时先把旧轮折叠为纪要再发送 ----
  // 触发线 = 历史预算 × agentCompressAtPercent%（默认 80，设置可调，夹取 50-100）。
  // 估算面 = 实际发送串（system + 纪要 + 历史）+ tools payload。压缩后重装配
  // （检查点推进 → base 变小）；无可压段时 skipped 不调 LLM；失败静默回退现有裁剪。
  let compressed: { covered: number; digestChars: number } | undefined
  const budgetSetting = Math.floor(Number(getSettingReader()('agentContextBudgetTokens')) || 24000)
  // v3.1.2 条目11：支线不参与压缩——上下文 = 自己的历史 + 固化快照，压成纪要会打乱快照语义
  if (!virtualKickoff && !isSideLane && !manual && budgetSetting > 0 && getSettingReader()('agentCompressionEnabled') !== false) {
    const est = estimateTokens(convo.map(m => m.content ?? '').join('\n')) + estimateTokens(JSON.stringify(toolPayload))
    if (est > compressAtTokens(budgetSetting, Number(getSettingReader()('agentCompressAtPercent')))) {
      const cr = await compressSession({ sessionId, modelId: llmOpts?.modelId, effort: llmOpts?.effort })
      if (cr.ok && typeof cr.covered === 'number' && cr.covered > 0) {
        compressed = { covered: cr.covered, digestChars: cr.digestChars ?? 0 }
        asm = assembleAgentHistory(sessionId)
        history = asm.history
        convo = [{ role: 'system', content: systemFull }, ...composeContextWithDigest(asm.digest?.text, history, requestInjection)]
      }
    }
  }
  // 虚拟首轮：仅存在于本次请求的 convo，不写会话库、不渲染气泡。
  // 场景规则本身随 CONSTRAINTS.md 每轮注入（持久），这里只负责「让 AI 开口说第一句」。
  if (virtualKickoff) convo.push({ role: 'user', content: '（请按上述会话要求开始）' })
  // 续跑注入：同样只存在于本次请求（不落库、不进历史）。放在 convo 末尾 = 前缀（system+tools）逐字不变，
  // prompt cache 不受影响；且 carry 只付这一次（续跑成功即清现场）
  if (resumeInjection) convo.push({ role: 'user', content: resumeInjection })
  let sessionWrites = 0
  const changes: AgentChange[] = []
  /**
   * 续跑现场（A 方案 §3.5）：每次工具执行后入账，失败/停止时压成 carry 写进会话行。
   * 只留最近 40 条、单条结果先截到 4000 字符（carry 单条上限 800，留足余量又不用把 24k 全揣着）。
   */
  const carryRows: CarryRow[] = []
  /** 中断出口的上下文（每个失败/停止点都带上它：进度、改动清单、已获得的现场） */
  const interruptCtxOf = (round: number): InterruptContext => ({
    changes,
    rounds: round,
    toolCalls: carryRows.length,
    carry: buildResumeCarry(carryRows),
    // 支线旁问 / 手册通道不给「继续」：职责是答一点，重问成本低（方案 §3.7）
    writeResume: !isSideLane && !manual,
  })
  // P3b：本对话模型覆盖（'pid:mid' 串拆分）——解析一次，全轮次复用
  let providerId: string | undefined
  let modelOverride: string | undefined
  if (llmOpts?.modelId) {
    const ci = llmOpts.modelId.indexOf(':')
    providerId = ci > 0 ? llmOpts.modelId.slice(0, ci) : undefined
    modelOverride = ci > 0 ? llmOpts.modelId.slice(ci + 1) : llmOpts.modelId
  }
  // 用量记账的模型键（v3.9.0 §3.4）：本对话覆盖优先，否则全局默认；经 usageKeyOf 归一为 `providerId:modelId`
  const usageModel = (() => {
    const raw = String(llmOpts?.modelId || getSettingReader()('defaultChatModel') || '')
    const ci = raw.indexOf(':')
    return ci > 0 ? usageKeyOf(raw.slice(0, ci), raw.slice(ci + 1)) : usageKeyOf('', raw)
  })()

  // 流式增量出口（不落库）：思考链 / 正文 delta 经合批后推给发起窗口。
  // signal 全程不变，取一次即可。
  const emitStream = streamEmitters.get(signal)
  const batcher = new DeltaBatcher((e) => emitStream?.(e))

  // ---- 循环预算（Agent 第 0+2 层）：轮数可配 + 累计 token 预算，耗尽优雅收场而非报错 ----
  const maxRounds = manual ? MANUAL_MAX_ROUNDS : clampMaxRounds(getSettingReader()('agentMaxRounds'))
  const runTokenBudget = clampRunTokenBudget(getSettingReader()('agentRunTokenBudget'))
  // 写次数上限（v3.13.0 反馈 N-1）：作用域 = 本条消息触发的这次运行（非会话级配额，
  // 下一条消息重计）；7 次硬上限对「建任务+排期+工作流」式复杂任务不够用 → 设置化，默认 20
  const maxSessionWrites = clampMaxSessionWrites(getSettingReader()('agentMaxSessionWrites'))
  let runTokens = 0
  let softLanded = false
  /** token 预算触顶（或已到最后一轮）：本轮执行完后立即断出循环 → 强制总结轮 */
  let budgetCapped = false
  /** 触顶原因（归因 P0：AGENT_ROUND_CAP 与 AGENT_TOKEN_BUDGET 的用户动作不同，必须分开） */
  let capKind: 'round-cap' | 'token-budget' = 'round-cap'

  for (let i = 0; i < maxRounds; i++) {
    // ---- LLM 轮 ----
    if (signal.aborted) {
      // 归因 P0（B-0）：用户停止是一种**有名字**的中断 —— 此前报成「AI 调用失败」（审计里 12 条误报同源）
      return interruptResult(sessionId, trace, rawFailure({
        layer: 'agent-loop', raw: '用户停止（本轮开始前）', externalAborted: true,
        round: i + 1, runTokens, elapsedMs: Date.now() - runStarted,
      }), undefined, undefined, interruptCtxOf(i + 1))
    }
    // 预算将尽（最后一轮 / token 预算触顶）：注入收场提示，让模型用已有信息总结（第 0 层）
    if (!softLanded && (i === maxRounds - 1 || (runTokenBudget > 0 && runTokens >= runTokenBudget))) {
      softLanded = true
      budgetCapped = true
      capKind = (runTokenBudget > 0 && runTokens >= runTokenBudget) ? 'token-budget' : 'round-cap'
      convo.push({ role: 'user', content: FINAL_ROUND_NOTICE })
    }
    emitStream?.({ kind: 'round-start', round: i + 1 })
    const t0 = Date.now()
    // 思考时长统计（reasoning 全文不落库，只记时长，见 AgentTraceStep.thinkingMs）
    let thinkFrom = 0
    let thinkTo = 0
    const r = await invokeLlmStreamInternal(
      { messages: compressStaleToolResults(convo), tools: toolPayload, signal, providerId, modelId: modelOverride, effort: manual ? 'off' : llmOpts?.effort, sessionId, accounting: 'caller' },
      (e) => {
        if (e.type === 'text') batcher.push('text', e.delta)
        else if (e.type === 'reasoning') {
          if (!thinkFrom) thinkFrom = Date.now()
          thinkTo = Date.now()
          batcher.push('thinking', e.delta)
        }
      },
    )
    // 本轮收尾：确保积压的旁白/正文已推出（否则渲染层会缺最后一段）
    batcher.flush()
    const llmStep: AgentTraceStep = {
      kind: 'llm',
      ok: r.ok,
      durationMs: Date.now() - t0,
      tokens: r.ok ? r.tokens : undefined,
      promptTokens: r.ok ? r.promptTokens : undefined,
      completionTokens: r.ok ? r.completionTokens : undefined,
      cachedTokens: r.ok ? r.cachedTokens : undefined,
      // 本轮估算费用（USD）：主进程按内置价目表算好落库，渲染层只读（对话内「本轮消耗」小字用）
      costUsd: r.ok ? roundCostUsd(r.promptTokens, r.completionTokens, r.cachedTokens, usageModel) : null,
      // 带工具轮次的正文 = 过程旁白（落库供历史回看）。实时展示已由上面的 text delta 完成，
      // 这里只为「回看历史时仍能看到 AI 当时说了什么」
      ...(r.ok && r.toolCalls.length > 0 && r.content.trim()
        ? { processText: r.content.trim().slice(0, 1000) }
        : {}),
      ...(thinkFrom ? { thinkingMs: Math.max(1, thinkTo - thinkFrom) } : {}),
    }
    trace.push(llmStep)
    stepEmitters.get(signal)?.(llmStep) // 实时过程：渲染层活动气泡
    if (r.ok) {
      runTokens += r.tokens
      // token 用量记账（批次5，方案 §4）：每轮 LLM 一笔，按日落盘；会话分桶供「会话消耗 TOP」
      recordAiUsage({
        sessionId,
        sessionTitle: getAgentSession(sessionId)?.title ?? '',
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        cachedTokens: r.cachedTokens,
        model: usageModel,
        cacheReadTokens: r.cachedTokens,
      })
    }
    if (!r.ok) {
      // 归因 P0：LLM 侧已归一（code / interruption / detail）；配置类失败没有采集面 → 按「换模型」处置
      const baseRaw = rawFailure({
        layer: 'http', raw: r.error, round: i + 1, runTokens, elapsedMs: Date.now() - runStarted,
      })
      return interruptResult(
        sessionId, trace, baseRaw,
        r.interruption ?? configInterruptionOf(r.code),
        r.detail ?? interruptionDetailOf(baseRaw),
        interruptCtxOf(i + 1),
      )
    }

    if (!r.toolCalls || r.toolCalls.length === 0) {
      // 完成：把真实改动清单附在回复末尾（落库可见），并结构化返回给 UI
      const changesText = changes.length > 0
        ? '\n\n——\n本次改动：\n' + changes.map((c, idx) => `${idx + 1}. ${c.action}「${c.target}」`).join('\n')
        : ''
      // G5 = B-29：输出被截断（撞单次输出上限 / 未见结束帧）此前静默当成功 —— 正文追加提示且可续写
      if (r.interruption) {
        const dt = r.detail ?? interruptionDetailOf(rawFailure({
          layer: 'stream-eof', raw: r.interruption.matched, round: i + 1, runTokens, elapsedMs: Date.now() - runStarted,
        }))
        const reply = withTruncationNotice(r.content + changesText, r.interruption, dt)
        const msgId = appendAgentMessage(sessionId, 'assistant', reply, trace)
        // 截断 = 有断点可续（「接着往下写」）：现场与失败出口同款（支线/手册通道不写）
        const ictx = interruptCtxOf(i + 1)
        if (ictx.writeResume !== false) persistResume(sessionId, msgId, interruptFactsOf(r.interruption, dt, trace, ictx), ictx.carry ?? '')
        return {
          ok: true, sessionId, reply, changes, trace, injection,
          interruption: r.interruption, interruptDetail: dt,
          ...(compressed ? { compressed } : {}),
          contextBudget: asm.budget,
        }
      }
      const reply = r.content + changesText
      appendAgentMessage(sessionId, 'assistant', reply, trace)
      return {
        ok: true, sessionId, reply, changes, trace, injection,
        ...(compressed ? { compressed } : {}),
        contextBudget: asm.budget,
      }
    }

    // ---- 记录 assistant(带 tool_calls)：按「并行只读段 / 串行件」分批执行并回喂（第 1 层单轮密度）----
    convo.push(r.assistantMessage)

    /** 单个工具调用的执行后记账（tool.request 重建 / trace / 实时步骤 / 改动清单 / 结果回喂），按调用顺序执行 */
    const finishToolCall = (tc: { id: string }, realName: string, args: Record<string, unknown>, exec: AiToolInvokeResult, durationMs: number): void => {
      // P3：tool.request 成功 → 并入会话启用集合并重建工具 payload（下一轮 LLM 调用生效）
      if (realName === 'builtin.tool.request' && exec.ok) {
        const enabled = (typeof exec.data === 'object' && exec.data !== null && Array.isArray((exec.data as Record<string, unknown>).enabled))
          ? ((exec.data as Record<string, unknown>).enabled as unknown[]).filter((x): x is string => typeof x === 'string')
          : []
        if (enabled.length > 0) {
          const cur = enabledOnDemand.get(sessionId) ?? new Set<string>()
          const before = cur.size
          for (const n of enabled) cur.add(n)
          enabledOnDemand.set(sessionId, cur)
          if (cur.size !== before) {
            toolsState = buildToolsPayload(sessionId, undefined, { confirmMode: aiPropose, scheduleReadOnly: unifiedAssistant })
            toolPayload = toolsState.payload
          }
        }
      }
      const toolStep: AgentTraceStep = {
        kind: 'tool',
        name: realName,
        ok: exec.ok,
        durationMs,
        summary: exec.ok ? undefined : String(exec.message).slice(0, 200),
      }
      // visual.html / mindmap / image 成功产物落 trace（小字段，不含全文）：渲染层工件卡数据源 + 占位页签原地转正式
      if ((realName === 'visual.html' || realName === 'mindmap' || realName === 'image') && exec.ok && typeof exec.data === 'object' && exec.data !== null) {
        const d = exec.data as Record<string, unknown>
        if (realName === 'image') {
          // 生图没有 title/slug 必填参数：卡上的人可读标签取 prompt 首段，取不到再退回文件名
          const prompt = String(args?.prompt ?? '')
          toolStep.artifact = {
            rel: String(d.relPath ?? ''),
            title: prompt.slice(0, 80) || String(d.relPath ?? '').split('/').pop() || '生成的图片',
            slug: String(args?.slug ?? ''),
            kind: 'image',
            w: Number(d.w ?? 0) || undefined,
            h: Number(d.h ?? 0) || undefined,
            bytes: Number(d.bytes ?? 0) || undefined,
            prompt: prompt.slice(0, 500),
            ref: String(args?.ref ?? '').trim() || undefined,
            model: String(d.model ?? '').trim() || undefined,
            elapsedMs: Number(d.elapsedMs ?? 0) || undefined,
            downgraded: d.downgraded === true ? true : undefined,
          }
        } else {
          toolStep.artifact = {
            rel: String(d.relPath ?? ''),
            title: String(args?.title ?? '').slice(0, 80),
            lines: Number(d.lines ?? 0),
            slug: String(args?.slug ?? ''),
            kind: realName === 'mindmap' ? 'mindmap' : 'html',
            nodes: realName === 'mindmap' ? Number(d.nodes ?? 0) : undefined,
          }
        }
      }
      // 生图失败也要把 prompt/aspect/ref 带上（A8 的失败档要能「重试」——没有 prompt 就无处可重试；
      // 其余工具的失败步骤不带 args，因为它们的失败只给一行字）
      if (realName === 'image' && !exec.ok) {
        toolStep.args = {
          prompt: String(args?.prompt ?? '').slice(0, 500),
          aspect: String(args?.aspect ?? ''),
          ref: String(args?.ref ?? '').trim(),
          slug: String(args?.slug ?? ''),
        }
      }
      trace.push(toolStep)
      stepEmitters.get(signal)?.(toolStep) // 实时过程：渲染层活动气泡
      // 暂存结果不是「已改动」：confirm 模式下写工具只进方案，不能进改动清单
      const stagedResult = exec.ok && typeof exec.data === 'object' && exec.data !== null
        && (exec.data as Record<string, unknown>).staged === true
      if (exec.ok && !stagedResult) {
        // 收集真实写改动 → 完成时列为「本次改动」清单
        const label = CHANGE_LABELS[realName]
        if (label) {
          const data = (typeof exec.data === 'object' && exec.data !== null)
            ? exec.data as Record<string, unknown>
            : {}
          // vault 文件写类工具：目标=真实落盘路径（rename 取目标路径 to）；trash 后文件已移走不可跳转
          // visual.html：relPath 一并作 file（右栏「本次改动」条目可点击回工件栏渲染）
          // knowledge.create-page（F-11）：工具返回的 path 同为仓库内 .md，纳入 file 可点击直达编辑器
          const vaultPath = realName.startsWith('builtin.vault.')
            ? String(data?.to ?? data?.path ?? data?.trashed ?? '').trim()
            : (realName === 'visual.html' || realName === 'mindmap' || realName === 'image') ? String(data?.relPath ?? '').trim()
              : realName === 'builtin.knowledge.create-page' ? String(data?.path ?? '').trim()
                : ''
          const file = realName !== 'builtin.vault.trash' && vaultPath ? vaultPath : undefined
          // 参数里取不到可读目标时，回落到工具结果自带的标题（如 schedule.delete-todo
          // 只收 id，摘要里的 title 是唯一人能看懂的目标）—— 否则删除不会出现在「本次改动」清单里
          const target = vaultPath || String(args?.title ?? args?.date ?? args?.name ?? data?.title ?? '').trim().slice(0, 120)
          if (target) {
            const change = { tool: realName, action: label, target, ...(file ? { file } : {}) }
            changes.push(change)
            // 会话文件改动审计（批次5，方案 §3.8）：仅 vault 内文件写（file 非空可直达编辑器），
            // 内存按会话分桶，右栏 token 面板「改动文件」控件拉取
            if (file) recordSessionFileChange(sessionId, change, getAgentSession(sessionId)?.title ?? '')
          }
        }
      }
      // 单条结果超上限时截断为合法摘要（见 capToolResult 说明）
      const toolResultText = JSON.stringify(exec.ok ? { ok: true, data: exec.data } : { ok: false, error: exec.message })
      const toolContent = toolResultText.length > MAX_TOOL_RESULT_CHARS ? capToolResult(toolResultText, realName) : toolResultText
      convo.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: toolContent,
      })
      // 续跑现场入账（A 方案 §3.5）：成功与失败都记 ——「查过但没查成」同样是后面续跑要用的信息。
      // 单条先截到 4000（carry 单条上限 800，留足余量又不把 24k 全揣着）；只留最近 40 条
      carryRows.push({ tool: realName, args: carryArgsOf(args), result: toolContent.slice(0, 4000), ok: exec.ok })
      if (carryRows.length > 40) carryRows.shift()
    }

    /** 串行件：写上限判定 + visual 时序事件 + 执行 + 记账（原逐条路径，行为不变） */
    const runSingleToolCall = async (tc: { id: string }, realName: string, args: Record<string, unknown>): Promise<void> => {
      // v3.1.2 条目11：支线拒绝一切写入（含模型幻觉调用）——不执行、不落盘，直接回喂让模型改用文字回答
      if (writeToolUniverse?.has(realName)) {
        const laneDenyStep: AgentTraceStep = { kind: 'tool', name: realName, ok: false, durationMs: 0, summary: '支线旁问不允许写入' }
        trace.push(laneDenyStep)
        stepEmitters.get(signal)?.(laneDenyStep)
        convo.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ ok: false, error: '支线旁问不改文件：本条对话只解答问题、不执行任何写入操作。请直接用文字回答用户。' }),
        })
        return
      }
      // 写上限：本次运行内写入类工具最多 maxSessionWrites 次（防失控循环刷盘）。
      // 动态读 toolsState.writeTools——tool.request 启用新写工具后重建的集合要立即生效
      if (toolsState.writeTools.has(realName)) {
        if (sessionWrites >= maxSessionWrites) {
          const denyStep: AgentTraceStep = { kind: 'tool', name: realName, ok: false, durationMs: 0, summary: `本条消息写入上限 ${maxSessionWrites}` }
          trace.push(denyStep)
          stepEmitters.get(signal)?.(denyStep)
          convo.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ ok: false, error: `已达本条消息的写入操作上限（${maxSessionWrites} 次）。请停止写入类操作并总结已完成内容` }),
          })
          return
        }
        sessionWrites++
      }
      // visual.html / mindmap / image 生成时序 §3.4：调用前推「生成中」实时事件（仅 slug/title/prompt/aspect
      // 这类小字段，绝不带全文；不落库——渲染层据此开「生成中」占位（工件栏页签 / 生图卡），给即时反馈）
      if (realName === 'visual.html' || realName === 'mindmap') {
        stepEmitters.get(signal)?.({
          kind: 'tool', name: realName, ok: true, durationMs: 0,
          args: { slug: String(args?.slug ?? ''), title: String(args?.title ?? '') },
        })
      }
      // image 的占位事件要带 prompt/aspect/ref：生图卡靠 aspect 定占位框比例（不跳版），
      // 靠 prompt 在生成期就能显示"在画什么"，靠 ref 标注这是改图还是新画
      if (realName === 'image') {
        stepEmitters.get(signal)?.({
          kind: 'tool', name: realName, ok: true, durationMs: 0,
          args: {
            prompt: String(args?.prompt ?? '').slice(0, 500),
            aspect: String(args?.aspect ?? ''),
            ref: String(args?.ref ?? '').trim(),
            slug: String(args?.slug ?? ''),
          },
        })
      }
      // 过程时间线（§5.2.3）：在**调用前**先推「进行中」——现有 agent:step 是执行完才推，
      // 渲染层若只靠它会滞后一整轮生成时间。执行完由 agent:step 原地转 ✓ 并补耗时。
      emitStream?.({
        kind: 'tool-start',
        name: realName,
        label: toolActionLabel(realName),
        target: argTarget(args),
      })
      const t1 = Date.now()
      const exec = await invokeToolInternal(realName, args, '', {
        sessionId, source, signal,
        scope: aiScope, scopeAll, writeMode, propose: aiPropose, unifiedAssistant,
      })
      finishToolCall(tc, realName, args, exec, Date.now() - t1)
    }

    // 参数预解析一次；并行安全 = 注册只读 且 不在写集合（防误注册兜底）；
    // 特殊工具（tool.request / visual.html）按名字排除，保持串行时序
    const prepared = r.toolCalls.map(tc => {
      const realName = nameMap.get(tc.name) ?? tc.name.replace(/__/g, '.')
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(tc.arguments || '{}') } catch { /* 保持空对象 */ }
      return { tc, realName, args }
    })
    const batches = partitionToolBatches(prepared, c =>
      isParallelSafe(c.realName, toolsState.readOnlyTools.has(c.realName) && !toolsState.writeTools.has(c.realName)))
    for (const batch of batches) {
      if (signal.aborted) {
        return interruptResult(sessionId, trace, rawFailure({
          layer: 'agent-loop', raw: '用户停止（工具批次前）', externalAborted: true,
          round: i + 1, runTokens, elapsedMs: Date.now() - runStarted,
        }), undefined, undefined, interruptCtxOf(i + 1))
      }
      if (!batch.parallel) {
        const c = batch.items[0]
        await runSingleToolCall(c.tc, c.realName, c.args)
        continue
      }
      // 并行只读段：先按序推「进行中」事件 → 分块并发执行 → 按序记账回喂（trace/改动顺序与调用一致）
      for (const c of batch.items) {
        emitStream?.({
          kind: 'tool-start',
          name: c.realName,
          label: toolActionLabel(c.realName),
          target: argTarget(c.args),
        })
      }
      const execs: Array<{ exec: AiToolInvokeResult; durationMs: number }> = []
      for (let s = 0; s < batch.items.length; s += PARALLEL_CHUNK) {
        const chunk = batch.items.slice(s, s + PARALLEL_CHUNK)
        execs.push(...await Promise.all(chunk.map(async c => {
          const t1 = Date.now()
          const exec = await invokeToolInternal(c.realName, c.args, '', {
            sessionId, source, signal,
            scope: aiScope, scopeAll, writeMode, propose: aiPropose, unifiedAssistant,
          })
          return { exec, durationMs: Date.now() - t1 }
        })))
      }
      for (let idx = 0; idx < batch.items.length; idx++) {
        finishToolCall(batch.items[idx].tc, batch.items[idx].realName, batch.items[idx].args, execs[idx].exec, execs[idx].durationMs)
      }
    }
    // 收场轮的工具结果已回喂，不再进入下一轮 → 走循环后的强制总结（模型无视提示仍开工具时兜底）
    if (budgetCapped) break
  }

  // ---- 轮数/token 预算耗尽：做一次无工具的强制总结轮，把已获取的信息变成交付（第 0 层优雅收场）----
  convo.push({ role: 'user', content: FORCED_SUMMARY_NOTICE })
  const fr = await invokeLlmStreamInternal(
      { messages: convo, tools: [], signal, providerId, modelId: modelOverride, effort: manual ? 'off' : llmOpts?.effort, sessionId, accounting: 'caller' },
    (e) => { if (e.type === 'text') batcher.push('text', e.delta) },
  )
  batcher.flush()
  const frStep: AgentTraceStep = { kind: 'llm', ok: fr.ok, durationMs: 0, tokens: fr.ok ? fr.tokens : undefined, costUsd: fr.ok ? roundCostUsd(fr.promptTokens, fr.completionTokens, fr.cachedTokens, usageModel) : null, summary: fr.ok ? '预算耗尽总结轮' : undefined }
  trace.push(frStep)
  stepEmitters.get(signal)?.(frStep)
  if (fr.ok) {
    recordAiUsage({
      sessionId,
      sessionTitle: getAgentSession(sessionId)?.title ?? '',
      promptTokens: fr.promptTokens,
      completionTokens: fr.completionTokens,
      cachedTokens: fr.cachedTokens,
      model: usageModel,
      cacheReadTokens: fr.cachedTokens,
    })
  }
  if (fr.ok && fr.content.trim()) {
    const changesText = changes.length > 0
      ? '\n\n——\n本次改动：\n' + changes.map((c, idx) => `${idx + 1}. ${c.action}「${c.target}」`).join('\n')
      : ''
    // 预算触顶也是一种中断（归因 P0）：卡片说清是「轮数用尽」还是「token 触顶」，并可续跑
    const capRaw = rawFailure({
      layer: 'agent-loop',
      raw: capKind === 'token-budget' ? 'token 预算触顶' : '轮数用尽',
      loop: capKind,
      round: maxRounds, runTokens, elapsedMs: Date.now() - runStarted,
    })
    const capIt = classifyFailure(capRaw)
    const capDetail = interruptionDetailOf(capRaw)
    const ictx = interruptCtxOf(maxRounds)
    const facts = interruptFactsOf(capIt, capDetail, trace, ictx)
    // 正文用统一的卡片构造器（进度 + 可继续句）；改动清单已由上面的 changesText 列过，这里传空避免重复
    const reply = fr.content + changesText
      + '\n' + buildInterruptContent({
        reason: facts.reason,
        advice: suggestedActionText(capIt),
        rounds: facts.rounds,
        toolCalls: facts.toolCalls,
        changes: [],
        canResume: ictx.writeResume !== false,
        ...(facts.lastProcessText ? { lastProcessText: facts.lastProcessText } : {}),
      })
    const msgId = appendAgentMessage(sessionId, 'assistant', reply, trace)
    // 预算触顶 = 任务没做完（不是失败）：留现场让「继续」能带着已有信息接着跑
    if (ictx.writeResume !== false) persistResume(sessionId, msgId, facts, ictx.carry ?? '')
    return {
      ok: true, sessionId, reply, changes, trace, injection, hitCap: true,
      interruption: capIt, interruptDetail: capDetail,
      ...(compressed ? { compressed } : {}),
    }
  }
  // 收场总结也没跑成：按「预算已耗尽 + 总结失败」归因（但保留总结轮自身的失败细节，别把原因丢了）
  const sumRaw = rawFailure({
    layer: 'agent-loop', raw: `已达最大推理轮数（${maxRounds}）且总结失败`, loop: 'summary-failed',
    round: maxRounds, runTokens, elapsedMs: Date.now() - runStarted,
  })
  return interruptResult(sessionId, trace, sumRaw, classifyFailure(sumRaw), fr.detail ?? interruptionDetailOf(sumRaw), interruptCtxOf(maxRounds))
}

/** 重新生成最后一条回复：删掉末尾助手消息后按原用户消息重推 */
async function agentRegenerate(req: AgentChatRequest, signal: AbortSignal): Promise<AgentChatResult> {
  const trace: AgentTraceStep[] = []
  const sessionId = String(req?.sessionId ?? '')
  if (!sessionId || !sessionExists(sessionId)) return { ok: false, error: '会话不存在', trace }
  const msgs = getAgentMessages(sessionId)
  const lastUser = [...msgs].reverse().find(m => m.role === 'user')
  if (!lastUser) return { ok: false, sessionId, error: '没有可重新生成的用户消息', trace }
  deleteMessagesAfter(sessionId, lastUser.id)
  return runAgentLoop(sessionId, req.context, signal, trace, req.source, { modelId: req.modelId, effort: req.effort })
}

/**
 * A 方案：从断点续跑（不追加用户消息、不新建会话，2026-10-14）。
 *
 * 装配（§3.4）：会话历史末尾是「中断卡」（一条 assistant 消息），续跑指令作为**一条不落库的合成 user 轮**
 * 追加在 convo 末尾 —— 前缀（system + tools）逐字不变，prompt cache 不受影响；carry 只付一次。
 * claim 顺序：**先清现场再跑** —— 连点两次「继续」时第二次拿不到现场，直接如实返回（不给重复消费的机会）。
 */
async function agentResume(req: AgentChatRequest, signal: AbortSignal): Promise<AgentChatResult> {
  const trace: AgentTraceStep[] = []
  const sessionId = String(req?.sessionId ?? '')
  if (!sessionId || !sessionExists(sessionId)) return { ok: false, error: '会话不存在', trace }
  const rs = getAgentSession(sessionId)?.resume
  if (!rs) return { ok: false, sessionId, error: '这个会话没有可继续的中断点', trace }
  const facts: InterruptFacts = {
    reason: String(rs.reason ?? ''),
    aborted: rs.aborted === true,
    rounds: 0,
    toolCalls: Number(rs.tool_calls ?? 0) || 0,
    changes: Array.isArray(rs.changes) ? rs.changes : [],
  }
  const injection = buildResumeInjection(facts, String(rs.carry ?? ''))
  updateSessionResume(sessionId, null) // claim：现场只消费一次
  const result = await runAgentLoop(
    sessionId, req.context, signal, trace, req.source,
    { modelId: req.modelId, effort: req.effort },
    { resumeInjection: injection },
  )
  // 支线旁问：按本轮结果落运行态（成功 done / 其余 cut）；普通会话 no-op
  setSideLaneStatus(sessionId, result.ok ? 'done' : 'cut')
  return result
}

/**
 * 场景/模板启动（2026-09-09 体验优化）：新建场景会话后不再把开场白伪装成用户消息发送。
 * 场景规则由前端播种进会话 CONSTRAINTS.md（每轮重读注入、用户可编辑），
 * 这里不落任何用户消息，只用虚拟首轮触发 → 聊天区第一条即 AI 回复。
 */
async function agentStartScene(req: AgentChatRequest, signal: AbortSignal): Promise<AgentChatResult> {
  const trace: AgentTraceStep[] = []
  const sessionId = String(req?.sessionId ?? '')
  if (!sessionId || !sessionExists(sessionId)) return { ok: false, error: '会话不存在', trace }
  return runAgentLoop(sessionId, req.context, signal, trace, req.source, { modelId: req.modelId, effort: req.effort }, { allowEmptyHistory: true })
}

/** 改写某条用户消息并重新生成其后的回复 */
async function agentEditAndRegen(req: AgentChatRequest & { messageId: string }, signal: AbortSignal): Promise<AgentChatResult> {
  const trace: AgentTraceStep[] = []
  const sessionId = String(req?.sessionId ?? '')
  const content = String(req?.message ?? '').trim()
  if (!content) return { ok: false, error: '内容不能为空', trace }
  if (!sessionId || !sessionExists(sessionId)) return { ok: false, error: '会话不存在', trace }
  const msg = getMessageById(sessionId, String(req.messageId ?? ''))
  if (!msg || msg.session_id !== sessionId) return { ok: false, sessionId, error: '消息不存在', trace }
  if (msg.role !== 'user') return { ok: false, sessionId, error: '只能编辑用户消息', trace }
  updateMessageContent(sessionId, msg.id, content)
  deleteMessagesAfter(sessionId, msg.id)
  return runAgentLoop(sessionId, req.context, signal, trace, req.source, { modelId: req.modelId, effort: req.effort })
}

/**
 * 支线清单投影（.claude/plans/ai-teaching-side-lane-center.md §4.3）：
 * 在原会话行上补「未读 / 运行态 / 末条 AI 时间 / 正文摘要」等派生字段，供右栏支线中心使用。
 * 支线数量少（每主线个位数），逐条读 .jsonl 计算可接受。
 */
function buildSideLaneInfo(row: AgentSessionRow): Record<string, unknown> {
  const msgs = getAgentMessages(row.id)
  const last = msgs[msgs.length - 1]
  const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
  const excerpt = msgs.map((m) => m.content).join('\n').replace(/\s+/g, ' ').trim().slice(0, 200)
  // 来源回答标题（分叉点那条主线回答的首行）：仅用于展示与搜索，缺锚点则空
  const anchorMsg = row.branchFromMessageId && row.parentSessionId ? getMessageById(row.parentSessionId, row.branchFromMessageId) : null
  const anchorTitle = (anchorMsg?.content ?? '').replace(/^#{1,6}\s*/gm, '').replace(/\s+/g, ' ').trim().slice(0, 40)
  return {
    ...row,
    // camel 别名（与 camelRow 口径一致，渲染层按 camel 消费）
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 支线派生
    laneStatus: deriveLaneStatus(row.lane_status, last ? (last.role as 'user' | 'assistant') : '', false),
    laneSeenAt: row.lane_seen_at ?? null,
    lastAssistantAt: lastAssistant?.created_at ?? '',
    unread: computeLaneUnread({ hasMessages: msgs.length > 0, lastAssistantAt: lastAssistant?.created_at, laneSeenAt: row.lane_seen_at }),
    excerpt,
    anchorTitle,
  }
}

export function registerAgentHandlers(): void {
  // 仅向发起窗口推送 agent:step 过程事件（chatId 过滤由渲染层做），复用 activeChats 生命周期。
  // N-3 多对话并行：载荷补 sessionId（渲染层按会话分桶，切回运行中会话即恢复实时流）；
  // 运行态则全窗口广播（三个宿主 + 会话列表的转圈/角标都以此为准，真源在主进程）。
  const withAbort = async (
    chatId: string,
    sessionId: string,
    sender: Electron.WebContents | undefined,
    fn: (signal: AbortSignal) => Promise<AgentChatResult>
  ) => {
    const ctrl = new AbortController()
    activeChats.set(chatId, ctrl)
    activeChatSessions.set(chatId, sessionId)
    broadcastRunState()
    if (sender && !sender.isDestroyed()) {
      stepEmitters.set(ctrl.signal, (step) => {
        if (!sender.isDestroyed()) sender.send('agent:step', { chatId, sessionId, step })
      })
      // 流式增量：与 agent:step 平行，只发发起窗口（多窗口下另一窗口看不到流，与同类产品一致）
      streamEmitters.set(ctrl.signal, (event) => {
        if (!sender.isDestroyed()) sender.send('agent:stream', { chatId, sessionId, event })
      })
    }
    let result: AgentChatResult | undefined
    try {
      result = await fn(ctrl.signal)
      return result
    } catch (err) {
      // G8（归因 P0）：这里此前**只有 try/finally、没有 catch** —— 主进程里任何没被 runAgentLoop
      // 收住的异常（工具执行器抛错 / 写盘抛错 / IPC 反序列化）都会让「卡片消失 + 零 Toast + 零记录」。
      console.error('[agent] 任务异常逃逸（withAbort 兜底）', err)
      result = interruptResult(sessionId, [], rawFailure({
        layer: 'agent-loop', raw: String((err as Error)?.message ?? err), elapsedMs: 0,
      }))
      return result
    } finally {
      activeChats.delete(chatId)
      activeChatSessions.delete(chatId)
      const res = result as AgentChatResult | undefined
      broadcastRunState({
        sessionId,
        chatId,
        ok: !!res?.ok,
        ...(res?.code ? { code: res.code } : {}),
        ...(res && !res.ok ? { error: res.error } : {}),
      })
      stepEmitters.delete(ctrl.signal)
      streamEmitters.delete(ctrl.signal)
    }
  }
  ipcMain.handle('agent:chat', (e, req: AgentChatRequest) =>
    withAbort(String(req?.chatId ?? '') || randomUUID(), String(req?.sessionId ?? ''), e.sender, signal => agentChat(req, signal, String(req?.chatId ?? ''))))
  ipcMain.handle('agent:regenerate', (e, req: AgentChatRequest) =>
    withAbort(String(req?.chatId ?? '') || randomUUID(), String(req?.sessionId ?? ''), e.sender, signal => agentRegenerate(req, signal)))
  // A 方案：从断点续跑（中断卡上的「继续」）。同样挂在 withAbort 上 = 可停止、有运行态、异常不静默
  ipcMain.handle('agent:resume', (e, req: AgentChatRequest) =>
    withAbort(String(req?.chatId ?? '') || randomUUID(), String(req?.sessionId ?? ''), e.sender, signal => agentResume(req, signal)))
  ipcMain.handle('agent:startScene', (e, req: AgentChatRequest) =>
    withAbort(String(req?.chatId ?? '') || randomUUID(), String(req?.sessionId ?? ''), e.sender, signal => agentStartScene(req, signal)))
  ipcMain.handle('agent:editMessage', (e, req: AgentChatRequest & { messageId: string }) =>
    withAbort(String(req?.chatId ?? '') || randomUUID(), String(req?.sessionId ?? ''), e.sender, signal => agentEditAndRegen(req, signal)))
  ipcMain.handle('agent:deleteMessage', (_e, payload: { sessionId?: unknown; messageId?: unknown }) => {
    // v2 存储按会话分文件：删除需定位会话文件，渲染层随消息一并传 sessionId
    const p = (payload ?? {}) as { sessionId?: unknown; messageId?: unknown }
    deleteMessage(String(p.sessionId ?? ''), String(p.messageId ?? ''))
    return true
  })
  ipcMain.handle('agent:abort', (_e, chatId: string) => {
    activeChats.get(String(chatId ?? ''))?.abort()
    return true
  })
  // N-3：按会话停止（渲染层「停止」按钮以激活会话语义调用；该会话的全部在跑调用一并中止）
  ipcMain.handle('agent:abortSession', (_e, sessionId: string) => {
    const sid = String(sessionId ?? '')
    for (const [cid, s] of activeChatSessions) {
      if (s === sid) activeChats.get(cid)?.abort()
    }
    return true
  })
  // R26 真机验证发现的跨层缺口（agent:* 出口未做 snake_case→camelCase 映射）：
  // 渲染层契约是 AgentSessionInfo.createdAt/updatedAt 与 AgentStoredMessage.createdAt/traceJson，
  // 而仓库返回 SQLite 原始行（created_at/updated_at/trace_json）→ 前端读到 undefined：
  // 消息时间戳不显示（条目4）、用量统计恒 0 与 trace 折叠区不出现（条目9）、
  // AI教学 enterWs 按 updatedAt 排序直接抛 TypeError 把整个模块打崩（条目6B 复现路径）。
  // 这里补「保留原字段 + 追加 camel 别名」的零破坏映射（既有按 snake_case 消费的代码不受影响）。
  const camelRow = <T extends object>(r: T): T => {
    const row = r as unknown as Record<string, unknown>
    return {
      ...row,
      createdAt: typeof row.created_at === 'string' && row.created_at ? row.created_at : (row.createdAt ?? ''),
      updatedAt: typeof row.updated_at === 'string' && row.updated_at ? row.updated_at : (row.updatedAt ?? ''),
      pinnedAt: typeof row.pinned_at === 'string' && row.pinned_at ? row.pinned_at : (row.pinnedAt ?? null),
      laneStatus: row.lane_status ?? row.laneStatus,
      laneSeenAt: row.lane_seen_at ?? row.laneSeenAt ?? null,
      sessionId: typeof row.session_id === 'string' ? row.session_id : (row.sessionId ?? ''),
      traceJson: typeof row.trace_json === 'string' ? row.trace_json : (row.traceJson ?? null),
    } as T
  }
  /**
   * 存量会话来源回填（每个进程只跑一次，用内存标记兜底，避免每列一次会话就扫盘）。
   *
   * 判据双保险：① 归属过 AI 教学工作区；② 产物根下存在对应的会话文件夹。
   * 只用 ① 会漏（2026-09-10 用户实测：新建的教学会话已隔离，但历史会话仍混在助手列表里）——
   * 那批会话未被分配工作区，但**都有会话文件夹**，后者才是可靠特征。
   *
   * 两种情况分开处理：有 source 缺省的走初始化；全都有 source 的走**修正模式**
   * （上一轮用不全的判据跑过，误标的 assistant 需要被改回来）。
   */
  let sourceBackfillDone = false
  const ensureSessionSources = (): void => {
    if (sourceBackfillDone) return
    sourceBackfillDone = true
    try {
      const rows = listAgentSessions()
      if (rows.length === 0) return
      const sessionWs = listWorkspaces(getSettingReader()).sessionWs ?? {}
      const folderIds = listSessionFolderIds(getSettingReader())
      const infer = (id: string, title: string): 'aiTeaching' | null => {
        if (sessionWs[id] || folderIds.has(id)) return 'aiTeaching'
        // 历史救济：会话文件夹机制落地之前创建的教学会话，既无工作区归属也无文件夹，
        // 只能靠标题特征识别（标题 = 教学场景模板名，见渲染层 TEMPLATES 的 label）
        const t = title.trim()
        if (LEGACY_TEACHING_TITLES.has(t) || /（教学）$/.test(t)) return 'aiTeaching'
        return null
      }
      backfillSessionSources(infer, !rows.some(r => !r.source))
    } catch { /* 回填失败不影响列表本身 */ }
  }
  /**
   * 会话行出口（A 方案 §3.1）：续跑现场只发摘要 —— `resume.carry` 有 6k 字符，全量发给渲染层
   * 等于每次列会话都白传一遍；「继续」按钮只需要 messageId / reason / resumable 这点信息。
   */
  const sessionOut = (row: AgentSessionRow): Record<string, unknown> => {
    const out = camelRow(row) as unknown as Record<string, unknown>
    const rs = out.resume as SessionResume | undefined
    delete out.resume
    out.resumeInfo = rs ? toResumeInfo(rs) : null
    return out
  }
  ipcMain.handle('agent:sessions', () => {
    ensureSessionSources()
    return listAgentSessions().map(sessionOut)
  })
  ipcMain.handle('agent:newSession', (_e, title?: string, source?: string) => {
    // 会话随仓库走（2026-10-13）：没有当前仓库就没有可写的位置。
    // 渲染层 4 个调用点都是 `.catch(() => null)`，这里抛出即退化为「建不了会话」+ 我们给的提示。
    if (!getCurrentVault()) throw new Error('尚未打开仓库，无法新建对话')
    return camelRow(createAgentSession(
      typeof title === 'string' && title.trim() ? title.trim() : '新会话',
      source === 'aiTeaching' ? 'aiTeaching' : source === 'schedule' ? 'schedule' : source === 'aiAssistant' ? 'aiAssistant' : source === 'intel' ? 'intel' : 'assistant',
    ))
  })
  ipcMain.handle('agent:messages', (_e, id: string) => getAgentMessages(String(id ?? '')).map(camelRow))
  // 存量会话认领的一次性告知（会话随仓库走）：取走即删，只会被展示一次
  ipcMain.handle('agent:takeAdoptNotice', () => takeAdoptNotice())
  // AI 用量 / 会话文件改动（v3.4.0 批次5，方案 §4/§3.8）：右栏 token 面板只读
  ipcMain.handle('agent:usage:get', () => getAiUsageData())
  ipcMain.handle('agent:usage:models', () => getAiUsageModels())
  ipcMain.handle('agent:sessionChanges:get', (_e, sessionId?: string) =>
    getSessionChanges(typeof sessionId === 'string' && sessionId ? sessionId : undefined))
  // ===== AI助手变更方案（v3.9.0）：先预览、后确认、可整任务回滚 =====
  ipcMain.handle('aiAssistant:plan:get', (_e, sessionId: string) => getPlan(String(sessionId ?? '')))
  ipcMain.handle('aiAssistant:plan:apply', (_e, sessionId: string, acceptedIds: string[]) =>
    applyPlan(String(sessionId ?? ''), Array.isArray(acceptedIds) ? acceptedIds.map(String) : []))
  ipcMain.handle('aiAssistant:plan:reject', (_e, sessionId: string) => {
    rejectPlan(String(sessionId ?? ''))
    return true
  })
  ipcMain.handle('aiAssistant:task:rollback', (_e, sessionId: string) => rollbackTask(String(sessionId ?? '')))
  ipcMain.handle('aiAssistant:tasks', () => listTasks())
  ipcMain.handle('aiAssistant:scope:suggest', (_e, query: string, limit?: number) => {
    const pages = getKnowledgeIndex().pages.map((p) => ({ relPath: p.path, title: p.title, tags: p.tags, entryKind: p.entryKind }))
    return suggestScope(String(query ?? ''), pages, typeof limit === 'number' && limit > 0 ? limit : 8)
  })
  ipcMain.handle('agent:renameSession', (_e, id: string, title: string) => {
    if (typeof id === 'string' && typeof title === 'string' && title.trim()) renameAgentSession(id, title.trim())
    return true
  })
  // 统一 AI 助手：会话级文件作用域（scopeAll=true 时整个仓库；false 时严格按 scope）
  ipcMain.handle('agent:setSessionScope', (_e, id: string, scope: string[], scopeAll?: boolean) => {
    if (typeof id !== 'string' || !id) return { ok: false, error: '会话 id 非法' }
    updateAgentSessionScope(id, Array.isArray(scope) ? scope : [], typeof scopeAll === 'boolean' ? scopeAll : undefined)
    return { ok: true }
  })
  // 统一 AI 助手：会话级写入策略 / 模型 / 思考强度
  ipcMain.handle('agent:setSessionPrefs', (_e, id: string, patch: {
    writeMode?: 'direct' | 'confirm'
    modelId?: string
    effort?: 'off' | 'low' | 'medium' | 'high'
  }) => {
    if (typeof id !== 'string' || !id) return { ok: false, error: '会话 id 非法' }
    updateAgentSessionPreferences(id, patch && typeof patch === 'object' ? patch : {})
    return { ok: true }
  })
  ipcMain.handle('agent:setSessionInstructions', (_e, id: string, instructions: string) => {
    if (typeof id !== 'string' || !id) return { ok: false, error: '会话 id 非法' }
    if (typeof instructions !== 'string') return { ok: false, error: '内容非法' }
    updateAgentSessionInstructions(id, instructions)
    return { ok: true }
  })
  ipcMain.handle('agent:deleteSession', (_e, id: string) => {
    const sid = String(id ?? '')
    // v3.1.2 条目11：级联删除挂在该会话下的**未升格**支线（连同各自 .jsonl 消息文件）。
    // 已升格（lane='main'）的支线是用户明确要留下来的正式会话，不该跟着主线陪葬。
    // 渲染层在删除前用 agent:listSideLanes 取支线数做确认文案，确认后才调到这里。
    for (const lane of listSideLanes(sid)) if (lane.lane === 'side') deleteAgentSession(lane.id)
    deleteAgentSession(sid)
    return true
  })
  // 钉住 / 取消钉住会话（通用助手左栏「★ 收藏」分区）
  ipcMain.handle('agent:setSessionPinned', (_e, id: string, pinned: boolean) => {
    if (typeof id !== 'string' || !id) return false
    return setSessionPinned(id, pinned === true)
  })

  // ===== v3.1.2 条目11：支线旁问（sidetrack）=====
  // 建支线：只做「固化上下文快照 + 建独立会话」，**不调 LLM**（点按钮与装载阶段零请求）。
  ipcMain.handle('agent:createSideLane', (_e, payload: { parentSessionId?: unknown; anchorMessageId?: unknown; contextTurns?: unknown }) => {
    const p = (payload ?? {}) as { parentSessionId?: unknown; anchorMessageId?: unknown; contextTurns?: unknown }
    const parentSessionId = String(p.parentSessionId ?? '')
    if (!parentSessionId || !sessionExists(parentSessionId)) return { ok: false, error: '主线会话不存在' }
    const anchorMessageId = String(p.anchorMessageId ?? '')
    const anchor = anchorMessageId ? getMessageById(parentSessionId, anchorMessageId) : null
    const turns = Math.min(5, Math.max(1, Math.floor(Number(p.contextTurns)) || 3))
    const snapshotText = buildSideLaneSnapshot(parentSessionId, anchor, turns)
    const titleCore = (anchor?.content ?? '').replace(/^#{1,6}\s*/gm, '').replace(/\s+/g, ' ').trim().slice(0, 16)
    const lane = createSideLaneSession({
      parentSessionId,
      branchFromMessageId: anchor?.id ?? '',
      sideContext: snapshotText,
      title: titleCore ? `支线·${titleCore}` : '支线旁问',
      source: 'aiTeaching',
    })
    return { ok: true, laneSessionId: lane.id, title: lane.title, snapshotText, turns }
  })
  // 列某主线下的支线（含已升格）：右栏支线中心 + 左栏缩进渲染 + 删除前计数；带派生字段（unread/laneStatus/excerpt）
  ipcMain.handle('agent:listSideLanes', (_e, parentSessionId: string) =>
    listSideLanes(String(parentSessionId ?? '')).map(buildSideLaneInfo))
  // 升格支线为正式会话（单向）：lane 置 'main' → 进左栏列表
  ipcMain.handle('agent:promoteSideLane', (_e, laneSessionId: string) =>
    promoteSideLane(String(laneSessionId ?? '')))
  // 打开支线详情即已读：写 lane_seen_at（不 bump updated_at）
  ipcMain.handle('agent:markSideLaneRead', (_e, laneId: string) =>
    markSideLaneSeen(String(laneId ?? '')))
}
