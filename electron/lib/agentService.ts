import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { listTools, invokeToolInternal, getSettingReader, checkModulePermission, checkVaultFilePermission } from './aiTools'
import type { ToolDescription, AiToolInvokeResult } from './aiTools'
import { invokeLlmStreamInternal } from './llmService'
import { estimateTokens, trimHistoryByBudget } from './agentContextBudget'
import { compressAtTokens, composeContextWithDigest, rowsAfterDigest } from './agentCompressCore'
import { compressSession } from './agentCompress'
import type { SessionDigest, AgentMessageRow } from './agentSessionRepo'
import { clampMaxRounds, clampRunTokenBudget, isParallelSafe, partitionToolBatches, PARALLEL_CHUNK, PARALLEL_HINT, FINAL_ROUND_NOTICE, FORCED_SUMMARY_NOTICE } from './agentLoopPolicy'
import {
  createAgentSession, listAgentSessions, renameAgentSession, deleteAgentSession,
  sessionExists, appendAgentMessage, ensureSessionTitle, getAgentMessages,
  getMessageById, updateMessageContent, deleteMessage, deleteMessagesAfter,
  getAgentSession, updateAgentSessionInstructions, backfillSessionSources,
  createSideLaneSession, listSideLanes, promoteSideLane,
} from './agentSessionRepo'
import { resolveConstraintsForInjection, readGlobalConstraints, readWorkspaceConstraintsForSession, resolveWriteOwnerRel, listSessionFolderIds } from './aiTeachingFolders'
import { resolveSourcesForInjection } from './aiTeachingSources'
import { resolveProfilesForInjection } from './aiTeachingProfile'
import { listWorkspaces, getWorkspaceOfSession, workspaceFolderRel } from './aiTeachingWorkspaces'
import { findSkillPrompt } from './skillService'
import { recordAiUsage, recordSessionFileChange, getAiUsageData, getSessionChanges } from './agentUsage'

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
 */
const MAX_SESSION_WRITES = 7

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
  summary?: string
  /** visual.html 实时占位事件（仅 agent:step 推送，不落库）：{slug,title}——渲染层据此开「生成中」页签 */
  args?: Record<string, unknown>
  /** visual.html 成功产物（落库，随消息 trace 持久）：渲染层画工件卡 + 占位页签原地转正式 */
  artifact?: { rel: string; title: string; lines: number; slug: string }
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

/** signal → 步骤事件推送器（withAbort 注入发起窗口 sender，仅目标窗口收流） */
const stepEmitters = new WeakMap<AbortSignal, (step: AgentTraceStep) => void>()

/** signal → 流式增量推送器（与 stepEmitters 同机制；WeakMap 随 signal 一并回收） */
const streamEmitters = new WeakMap<AbortSignal, (event: AgentStreamEvent) => void>()

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

/** 工具注册名 → 过程时间线的动作文案（"正在读取 …"）。未登记的取注册名末段兜底 */
const TOOL_ACTION_LABELS: Record<string, string> = {
  'builtin.vault.list': '浏览目录',
  'builtin.vault.read': '读取文件',
  'builtin.vault.search': '搜索内容',
  'builtin.vault.resolve-ref': '解析引用',
  'builtin.vault.write': '写入文件',
  'builtin.vault.edit': '修改文件',
  'builtin.vault.rename': '重命名',
  'builtin.vault.trash': '移入回收站',
  'builtin.knowledge.search': '检索知识库',
  'builtin.knowledge.create-page': '新建知识页',
  'builtin.blog.create-entry': '新建日记',
  'builtin.schedule.list-todos': '查看待办',
  'builtin.schedule.create-todo': '创建待办',
  'builtin.schedule.update-todo': '修改待办',
  'builtin.schedule.delete-todo': '删除待办',
  'builtin.checkin.check-habit': '习惯打卡',
  'builtin.habits.stats': '统计习惯',
  'builtin.pomodoro.summary': '统计番茄',
  'builtin.web.search': '联网搜索',
  'builtin.web.read': '读取网页',
  'builtin.help.search': '检索帮助',
  'builtin.tool.request': '申请工具',
  'visual.html': '生成示意图',
}

/** 工具入参 → 过程时间线的目标文案（正在读/写哪个对象）；取不到则留空 */
function argTarget(args: Record<string, unknown>): string {
  const v = args.path ?? args.relPath ?? args.title ?? args.name ?? args.date ?? args.query ?? args.slug
  return typeof v === 'string' ? v.trim().slice(0, 120) : ''
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
  'builtin.checkin.check-habit': '习惯打卡',
  'visual.html': '生成示意图',
}

/**
 * 会话内已启用的 ondemand 工具（P3）：key=sessionId。
 * tool.request 成功后写入，本会话后续所有请求持续可用；应用重启即清零（AI 重新申请即可）。
 */
const enabledOnDemand = new Map<string, Set<string>>()

function buildToolsPayload(sessionId?: string): {
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
  const deniedModules = new Set<string>()
  let deniedVaultFile = false
  let hasOnDemandHidden = false
  const tools: ToolDescription[] = all.filter(t => {
    // v3.1.2 条目11：支线旁问**只解答、不改文件**——写类工具一律不进支线视野（硬拦截，非提示词约定）。
    // 与铁律 3 同一机制：requires==='write' 的工具被预过滤出模型视野。这条判定放在最前面，
    // 是为了让 tool.request 也绕不过（即便申请过写工具，支线这边照样 return false）。
    if (isSideLaneSession && t.requires === 'write') return false
    const denied = checkModulePermission(t, reader)
    if (denied && t.module) deniedModules.add(t.module)
    if (!denied && t.vaultFile && checkVaultFilePermission(t, reader)) {
      deniedVaultFile = true
      return false
    }
    if (denied) return false
    // P3 装载层：ondemand 工具仅在会话内被 tool.request 启用后才进入视野
    if (t.tier === 'ondemand' && !extraTools?.has(t.name)) {
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
  try {
    dataText = JSON.stringify(context.data ?? {}, null, 0)
  } catch { /* ignore */ }
  if (dataText.length > 6000) dataText = dataText.slice(0, 6000) + '…(截断)'
  return SYSTEM_PROMPT_BASE +
    `\n\n【当前上下文】用户正在查看：${context.label}（类型 ${context.type}）。` +
    (dataText ? `\n上下文数据：\n${dataText}` : '') +
    '\n用户的问题大概率与该上下文相关；若需要更多数据仍应调用工具。'
}

async function agentChat(req: AgentChatRequest, signal: AbortSignal, _chatId: string): Promise<AgentChatResult> {
  const trace: AgentTraceStep[] = []
  const message = String(req?.message ?? '').trim()
  if (!message) return { ok: false, error: '消息不能为空', trace }

  // ---- 会话保障 ----
  let sessionId = String(req.sessionId ?? '')
  if (sessionId && !sessionExists(sessionId)) sessionId = ''
  if (!sessionId) sessionId = createAgentSession('新会话', req.source === 'aiTeaching' ? 'aiTeaching' : 'assistant').id

  // ---- 落库用户消息 + 自动标题 ----
  appendAgentMessage(sessionId, 'user', message)
  ensureSessionTitle(sessionId, message)

  return runAgentLoop(sessionId, req.context, signal, trace, req.source, { modelId: req.modelId, effort: req.effort, skillName: req.skillName })
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
   */
  opts?: { allowEmptyHistory?: boolean }
): Promise<AgentChatResult> {
  // ---- 从会话库重建对话历史（仅 user/assistant 文本轮） ----
  // 会话压缩：检查点之前的旧轮已被纪要替代（assembleAgentHistory）；其后再做
  // 条数硬上限（-40）与 token 轮级裁剪——压缩失败/关闭时兜底，长会话不再全量进模型
  let asm = assembleAgentHistory(sessionId)
  let history = asm.history
  const virtualKickoff = opts?.allowEmptyHistory === true && history.length === 0
  if (!virtualKickoff && (history.length === 0 || history[history.length - 1].role !== 'user')) {
    return { ok: false, sessionId, error: '没有可重新生成的用户消息', trace }
  }

  // P3 装载层：工具 payload 可能在循环中重建（tool.request 启用新工具后下一轮生效）
  let toolsState = buildToolsPayload(sessionId)
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
    ? `\n\n【权限提示】以下模块用户尚未授权 AI 操作：${[...deniedModules].join('、')}。若用户请求这些模块的操作，请如实说明当前未授权，并提示可在 设置 → AI 工具 → 权限 中开启后重试。`
    : ''
  const vaultFileHint = deniedVaultFile
    ? '\n\n【权限提示】仓库文件读写（vault.* 工具）当前被权限限制。若用户请求操作仓库内笔记文件（列目录/读文件/搜内容），请如实说明需在 设置 → AI 工具 → 权限 → 仓库文件 中开启后重试。'
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
  // 2-6 读兼容：仅旧会话未落文件夹时回退 DB sessionInstructions。注入截断防 token 失控。
  const rawConstraints = resolveConstraintsForInjection(sessionId, getSettingReader())
  const sessionInst = rawConstraints.length > 4000
    ? rawConstraints.slice(0, 4000) + '\n…（约束文件过长已截断，全文见会话文件夹 CONSTRAINTS.md）'
    : rawConstraints
  const instHint = sessionInst
    ? `\n\n【本会话要求】（用户为此对话单独设定于 CONSTRAINTS.md，是约束链中最细、优先级最高的一层；与用户消息冲突时以用户当下消息为准）\n${sessionInst}`
    : ''
  // 工作区约束层（v3.1.2 条目6：三层约束补中间档）：{AI教学}/{工作区}/CONSTRAINTS.md 每轮重读，
  // 本工作区所有会话共同遵守；未归属工作区的会话本层零段。截断 3500 取全局层与会话层之间的中间档。
  const rawWs = readWorkspaceConstraintsForSession(sessionId, getSettingReader()).text ?? ''
  const wsInst = rawWs.length > 3500
    ? rawWs.slice(0, 3500) + '\n…（工作区要求过长已截断，全文见工作区文件夹 CONSTRAINTS.md）'
    : rawWs
  const wsInstHint = wsInst.trim()
    ? `\n\n【工作区要求】（用户为本工作区所有会话共同设定于 {工作区}/CONSTRAINTS.md，次于本会话要求、优先于全局要求；与更细颗粒层或用户当下消息冲突时以更细层为准）\n${wsInst}`
    : ''
  // 全局约束层（.claude/plans/global-constraints.md）：{产物根}/CONSTRAINTS.md 每轮重读，跨工作区/跨会话共同遵守；
  // 冲突裁决链写进提示词：用户当下消息 > 会话层 > 工作区层 > 全局层 > 内置人设。截断 3000 与画像段同量级。
  const rawGlobal = readGlobalConstraints(getSettingReader()).text ?? ''
  const globalInst = rawGlobal.length > 3000
    ? rawGlobal.slice(0, 3000) + '\n…（全局要求过长已截断，全文见 AI教学产物根 CONSTRAINTS.md）'
    : rawGlobal
  const globalInstHint = globalInst.trim()
    ? `\n\n【全局要求】（用户设定于 AI教学产物根的 CONSTRAINTS.md，跨工作区所有会话共同遵守，是约束链中最粗、优先级最低的一层；与更细颗粒层或用户当下消息冲突时以更细层为准）\n${globalInst}`
    : ''
  // v3.1.2 条目11：支线判定**提前**到规则装配之前——「不出题」与「写工具不可见」都要先知道是不是支线。
  // （原先在下面 laneRow 处才算，晚于本段的 quizRuleHint → 支线照常拿到出题协议。）
  const laneRow = source === 'aiTeaching' ? getAgentSession(sessionId) : undefined
  const isSideLane = !!(laneRow?.parentSessionId && laneRow.lane === 'side')
  // P3a（§3.8-2 标题规则，3-13 拍板）：AI教学会话每条回答首行带三级标题，供快速定位条取锚点标题
  const titleRuleHint = source === 'aiTeaching'
    ? '\n\n【回答标题规则（AI教学）】每条回答的第一行必须是一个简短标题，形如 `### 这里写标题`（不超过 20 字，概括本回答核心内容），标题后换行写正文；标题行之前不得有任何其他文字。该标题用于用户在对话流中快速定位每条回答。'
    : ''
  // P7（§3.2-7 题目视图）：AI教学出题走知识库 quiz 围栏协议，题目面板/答题组件直接解析复用。
  // v3.1.2 条目11：**支线不出题**（硬边界）——支线只解答零碎小知识点，出题是主线的职责。
  const quizRuleHint = source === 'aiTeaching' && !isSideLane
    ? '\n\n【出题格式规则（AI教学）】当用户要求出题/测验/练习时，除开场说明与收尾提示外，每道题单独输出一个 ```quiz 围栏代码块，块内是一个 JSON 对象（不要注释、不要多个对象）：{"no":1,"question":"题干（支持 markdown）","options":[{"key":"A","text":"选项一"},{"key":"B","text":"选项二"},{"key":"C","text":"选项三"},{"key":"D","text":"选项四"}],"answer":"A","explanation":"答案解析（支持 markdown）"}。不要输出 points 分值字段（客户端不渲染分值）。answer 的值必须是 options 中某个 key；默认四选一。围栏块之间可换行连续排列，客户端会自动收集进「题目」视图供答题。注意：围栏语言必须是 quiz（\u0060\u0060\u0060quiz），写成 json 或不带语言都不会被渲染成题卡。JSON 字符串值内部禁止出现未转义的英文双引号——题干/选项/解析里需要引用术语时一律用中文引号『』或“”，否则 JSON 被截断、题目渲染失败。'
    : ''
  // UI 优化条目11A（任务规划激活）：阶段推进时输出 ```plan 围栏 → 左栏「任务规划」渲染为带状态进度列表
  const planRuleHint = source === 'aiTeaching'
    ? '\n\n【任务规划协议（AI教学）】本会话有明确流程或阶段（如教学流程：通读资料→大纲→精讲→测验→笔记）时，你须在阶段发生推进的回答里输出一个 ```plan 围栏代码块，块内是一个 JSON 数组（不要注释）：[{"step":"步骤名（不超过12字）","status":"done|current|todo"}]。规则：status 恰好一个为 "current"，其余为 "done" 或 "todo"；每次输出完整最新清单（含全部步骤，未开始的也要列出）；步骤可按实际情况增删改名；阶段没有变化的普通回答不必输出。'
    : ''
  // UI 优化条目12/13（提问模式）：需要用户选择/澄清时输出 ```ask 围栏 → 输入区变形为选择卡
  const askRuleHint = source === 'aiTeaching'
    ? '\n\n【提问模式协议（AI教学）】当你需要用户做选择、澄清或确认才能继续时（方案二选一、参数不明确、流程确认等），在回答正文末尾输出一个 ```ask 围栏代码块，块内是一个 JSON 对象（不要注释）：{"question":"一句话问题","options":["选项一","选项二"],"allowCustom":true}。规则：选项 2~6 个、每项不超过 20 字且可直接作为用户的回答发出；allowCustom=true 表示也允许用户自由输入；一次回答最多一个 ask 块；客户端会把提问渲染成交互选择卡，正文里不要再重复罗列同样的选项。整卷式批量提问（如诊断问卷）时块内改为 JSON 数组，每个元素形如 {"question":"问题","options":["选项A","选项B","选项C"]}，用户会整卷作答后统一发回。正式出题仍走 ```quiz 协议，两者不得混用；无需用户确认时不要输出 ask。JSON 字符串值内部禁止未转义英文双引号——需要引用时一律用中文引号，否则 JSON 被截断、提问卡渲染失败。'
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
  // P8（§3.14）+ UI 优化条目8.2.2：三层学习者画像注入（全局 → 工作区 → 会话，细颗粒覆盖粗颗粒）
  // + 更新建议协议（3-33 Plan B）
  const profileHint = source === 'aiTeaching' ? resolveProfilesForInjection(sessionId, getSettingReader()) : ''
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
  // v3.1.2 条目11：支线旁问上下文（仅带 sideContext 的会话注入）。快照在建支线时固化，跨轮稳定 → 不扰动缓存前缀。
  // 升格为正式会话（lane='main'）后仍保留来源快照，只是不再套「支线纪律」措辞。
  // laneRow / isSideLane 已在前面规则装配处算好（纪律必须早于出题协议，故提前）。
  const sideLaneHint = laneRow?.sideContext
    ? (isSideLane
        ? SIDE_LANE_DISCIPLINE + '\n\n【支线上下文快照（分叉时刻固化）】被追问的回答 + 主线前若干轮：\n'
        : '\n\n【来源上下文（快照）】本条对话由主线会话的一条回答升格而来，以下是其来源快照（仅供参考背景；后续进展以本对话自身历史为准）。\n')
      + laneRow.sideContext
    : ''
  const baseSystem = buildSystemPrompt(context)
  // UI 优化条目9②：教学会话的注入分段用量（字符数，渲染层按 ≈2.6 字/token 折算做构成摘要）
  const injection: AiTeachInjectionStats | undefined = source === 'aiTeaching'
    ? {
        systemChars: baseSystem.length,
        constraintChars: sessionInst.length,
        profileChars: profileHint.length,
        sourcesChars: sourcesHint.length,
        ruleChars: titleRuleHint.length + quizRuleHint.length + planRuleHint.length + askRuleHint.length + visualHint.length + scopeRuleHint.length + writeScopeHint.length + sideLaneHint.length,
      }
    : undefined
  const systemFull = baseSystem + globalInstHint + wsInstHint + instHint + profileHint + titleRuleHint + quizRuleHint + planRuleHint + askRuleHint + visualHint + sourcesHint + scopeRuleHint + writeScopeHint + sideLaneHint + toolsHint + executionHint + deniedHint + vaultFileHint + skillHint + explicitSkillHint + PARALLEL_HINT
  // 纪要以首条 user 消息注入（composeContextWithDigest）——system+tools 是 prompt cache
  // 前缀必须逐字稳定，纪要变化只重建一次性前缀
  let convo: AgentMessage[] = [
    { role: 'system', content: systemFull },
    ...composeContextWithDigest(asm.digest?.text, history),
  ]

  // ---- 自动压缩预检（会话压缩 §6.1）：逼近触发线时先把旧轮折叠为纪要再发送 ----
  // 触发线 = 历史预算 × agentCompressAtPercent%（默认 80，设置可调，夹取 50-100）。
  // 估算面 = 实际发送串（system + 纪要 + 历史）+ tools payload。压缩后重装配
  // （检查点推进 → base 变小）；无可压段时 skipped 不调 LLM；失败静默回退现有裁剪。
  let compressed: { covered: number; digestChars: number } | undefined
  const budgetSetting = Math.floor(Number(getSettingReader()('agentContextBudgetTokens')) || 24000)
  // v3.1.2 条目11：支线不参与压缩——上下文 = 自己的历史 + 固化快照，压成纪要会打乱快照语义
  if (!virtualKickoff && !isSideLane && budgetSetting > 0 && getSettingReader()('agentCompressionEnabled') !== false) {
    const est = estimateTokens(convo.map(m => m.content ?? '').join('\n')) + estimateTokens(JSON.stringify(toolPayload))
    if (est > compressAtTokens(budgetSetting, Number(getSettingReader()('agentCompressAtPercent')))) {
      const cr = await compressSession({ sessionId, modelId: llmOpts?.modelId, effort: llmOpts?.effort })
      if (cr.ok && typeof cr.covered === 'number' && cr.covered > 0) {
        compressed = { covered: cr.covered, digestChars: cr.digestChars ?? 0 }
        asm = assembleAgentHistory(sessionId)
        history = asm.history
        convo = [{ role: 'system', content: systemFull }, ...composeContextWithDigest(asm.digest?.text, history)]
      }
    }
  }
  // 虚拟首轮：仅存在于本次请求的 convo，不写会话库、不渲染气泡。
  // 场景规则本身随 CONSTRAINTS.md 每轮注入（持久），这里只负责「让 AI 开口说第一句」。
  if (virtualKickoff) convo.push({ role: 'user', content: '（请按上述会话要求开始）' })
  let sessionWrites = 0
  const changes: AgentChange[] = []
  // P3b：本对话模型覆盖（'pid:mid' 串拆分）——解析一次，全轮次复用
  let providerId: string | undefined
  let modelOverride: string | undefined
  if (llmOpts?.modelId) {
    const ci = llmOpts.modelId.indexOf(':')
    providerId = ci > 0 ? llmOpts.modelId.slice(0, ci) : undefined
    modelOverride = ci > 0 ? llmOpts.modelId.slice(ci + 1) : llmOpts.modelId
  }

  // 流式增量出口（不落库）：思考链 / 正文 delta 经合批后推给发起窗口。
  // signal 全程不变，取一次即可。
  const emitStream = streamEmitters.get(signal)
  const batcher = new DeltaBatcher((e) => emitStream?.(e))

  // ---- 循环预算（Agent 第 0+2 层）：轮数可配 + 累计 token 预算，耗尽优雅收场而非报错 ----
  const maxRounds = clampMaxRounds(getSettingReader()('agentMaxRounds'))
  const runTokenBudget = clampRunTokenBudget(getSettingReader()('agentRunTokenBudget'))
  let runTokens = 0
  let softLanded = false
  /** token 预算触顶（或已到最后一轮）：本轮执行完后立即断出循环 → 强制总结轮 */
  let budgetCapped = false

  for (let i = 0; i < maxRounds; i++) {
    // ---- LLM 轮 ----
    if (signal.aborted) return { ok: false, sessionId, code: 'ABORTED', error: '已停止生成', trace }
    // 预算将尽（最后一轮 / token 预算触顶）：注入收场提示，让模型用已有信息总结（第 0 层）
    if (!softLanded && (i === maxRounds - 1 || (runTokenBudget > 0 && runTokens >= runTokenBudget))) {
      softLanded = true
      budgetCapped = true
      convo.push({ role: 'user', content: FINAL_ROUND_NOTICE })
    }
    emitStream?.({ kind: 'round-start', round: i + 1 })
    const t0 = Date.now()
    // 思考时长统计（reasoning 全文不落库，只记时长，见 AgentTraceStep.thinkingMs）
    let thinkFrom = 0
    let thinkTo = 0
    const r = await invokeLlmStreamInternal(
      { messages: compressStaleToolResults(convo), tools: toolPayload, signal, providerId, modelId: modelOverride, effort: llmOpts?.effort },
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
      })
    }
    if (!r.ok) return { ok: false, sessionId, error: r.error, code: r.code, trace }

    if (!r.toolCalls || r.toolCalls.length === 0) {
      // 完成：把真实改动清单附在回复末尾（落库可见），并结构化返回给 UI
      const changesText = changes.length > 0
        ? '\n\n——\n本次改动：\n' + changes.map((c, idx) => `${idx + 1}. ${c.action}「${c.target}」`).join('\n')
        : ''
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
            toolsState = buildToolsPayload(sessionId)
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
      // visual.html 成功产物落 trace（小字段，不含 HTML）：渲染层工件卡数据源 + 占位页签原地转正式
      if (realName === 'visual.html' && exec.ok && typeof exec.data === 'object' && exec.data !== null) {
        const d = exec.data as Record<string, unknown>
        toolStep.artifact = {
          rel: String(d.relPath ?? ''),
          title: String(args?.title ?? '').slice(0, 80),
          lines: Number(d.lines ?? 0),
          slug: String(args?.slug ?? ''),
        }
      }
      trace.push(toolStep)
      stepEmitters.get(signal)?.(toolStep) // 实时过程：渲染层活动气泡
      if (exec.ok) {
        // 收集真实写改动 → 完成时列为「本次改动」清单
        const label = CHANGE_LABELS[realName]
        if (label) {
          const data = (typeof exec.data === 'object' && exec.data !== null)
            ? exec.data as Record<string, unknown>
            : {}
          // vault 文件写类工具：目标=真实落盘路径（rename 取目标路径 to）；trash 后文件已移走不可跳转
          // visual.html：relPath 一并作 file（右栏「本次改动」条目可点击回工件栏渲染）
          const vaultPath = realName.startsWith('builtin.vault.')
            ? String(data?.to ?? data?.path ?? data?.trashed ?? '').trim()
            : realName === 'visual.html' ? String(data?.relPath ?? '').trim() : ''
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
      convo.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: toolResultText.length > MAX_TOOL_RESULT_CHARS ? capToolResult(toolResultText, realName) : toolResultText,
      })
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
      // 会话写上限：单次请求内写入类工具最多 MAX_SESSION_WRITES 次（防失控循环刷盘）。
      // 动态读 toolsState.writeTools——tool.request 启用新写工具后重建的集合要立即生效
      if (toolsState.writeTools.has(realName)) {
        if (sessionWrites >= MAX_SESSION_WRITES) {
          const denyStep: AgentTraceStep = { kind: 'tool', name: realName, ok: false, durationMs: 0, summary: `会话写入上限 ${MAX_SESSION_WRITES}` }
          trace.push(denyStep)
          stepEmitters.get(signal)?.(denyStep)
          convo.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ ok: false, error: `已达本次会话写入操作上限（${MAX_SESSION_WRITES} 次）。请停止写入类操作并总结已完成内容` }),
          })
          return
        }
        sessionWrites++
      }
      // visual.html 生成时序 §3.4：调用前推「生成中」实时事件（仅 slug/title 小字段，绝不带 html 全文；
      // 不落库——渲染层据此在工件栏开占位页签，给即时反馈）
      if (realName === 'visual.html') {
        stepEmitters.get(signal)?.({
          kind: 'tool', name: 'visual.html', ok: true, durationMs: 0,
          args: { slug: String(args?.slug ?? ''), title: String(args?.title ?? '') },
        })
      }
      // 过程时间线（§5.2.3）：在**调用前**先推「进行中」——现有 agent:step 是执行完才推，
      // 渲染层若只靠它会滞后一整轮生成时间。执行完由 agent:step 原地转 ✓ 并补耗时。
      emitStream?.({
        kind: 'tool-start',
        name: realName,
        label: TOOL_ACTION_LABELS[realName] ?? (realName.startsWith('builtin.') ? realName.slice(8) : realName),
        target: argTarget(args),
      })
      const t1 = Date.now()
      const exec = await invokeToolInternal(realName, args, '', { sessionId, source })
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
      if (signal.aborted) return { ok: false, sessionId, code: 'ABORTED', error: '已停止生成', trace }
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
          label: TOOL_ACTION_LABELS[c.realName] ?? (c.realName.startsWith('builtin.') ? c.realName.slice(8) : c.realName),
          target: argTarget(c.args),
        })
      }
      const execs: Array<{ exec: AiToolInvokeResult; durationMs: number }> = []
      for (let s = 0; s < batch.items.length; s += PARALLEL_CHUNK) {
        const chunk = batch.items.slice(s, s + PARALLEL_CHUNK)
        execs.push(...await Promise.all(chunk.map(async c => {
          const t1 = Date.now()
          const exec = await invokeToolInternal(c.realName, c.args, '', { sessionId, source })
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
    { messages: convo, tools: [], signal, providerId, modelId: modelOverride, effort: llmOpts?.effort },
    (e) => { if (e.type === 'text') batcher.push('text', e.delta) },
  )
  batcher.flush()
  const frStep: AgentTraceStep = { kind: 'llm', ok: fr.ok, durationMs: 0, tokens: fr.ok ? fr.tokens : undefined, summary: fr.ok ? '预算耗尽总结轮' : undefined }
  trace.push(frStep)
  stepEmitters.get(signal)?.(frStep)
  if (fr.ok) {
    recordAiUsage({
      sessionId,
      sessionTitle: getAgentSession(sessionId)?.title ?? '',
      promptTokens: fr.promptTokens,
      completionTokens: fr.completionTokens,
      cachedTokens: fr.cachedTokens,
    })
  }
  if (fr.ok && fr.content.trim()) {
    const changesText = changes.length > 0
      ? '\n\n——\n本次改动：\n' + changes.map((c, idx) => `${idx + 1}. ${c.action}「${c.target}」`).join('\n')
      : ''
    const reply = fr.content + changesText
    appendAgentMessage(sessionId, 'assistant', reply, trace)
    return { ok: true, sessionId, reply, changes, trace, injection, hitCap: true, ...(compressed ? { compressed } : {}) }
  }
  return { ok: false, sessionId, error: `已达最大推理轮数（${maxRounds}）且总结失败，请缩小问题范围后重试`, code: 'MAX_ITERATIONS', trace }
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

export function registerAgentHandlers(): void {
  // 仅向发起窗口推送 agent:step 过程事件（chatId 过滤由渲染层做），复用 activeChats 生命周期
  const withAbort = async (
    chatId: string,
    sender: Electron.WebContents | undefined,
    fn: (signal: AbortSignal) => Promise<AgentChatResult>
  ) => {
    const ctrl = new AbortController()
    activeChats.set(chatId, ctrl)
    if (sender && !sender.isDestroyed()) {
      stepEmitters.set(ctrl.signal, (step) => {
        if (!sender.isDestroyed()) sender.send('agent:step', { chatId, step })
      })
      // 流式增量：与 agent:step 平行，只发发起窗口（多窗口下另一窗口看不到流，与同类产品一致）
      streamEmitters.set(ctrl.signal, (event) => {
        if (!sender.isDestroyed()) sender.send('agent:stream', { chatId, event })
      })
    }
    try {
      return await fn(ctrl.signal)
    } finally {
      activeChats.delete(chatId)
      stepEmitters.delete(ctrl.signal)
      streamEmitters.delete(ctrl.signal)
    }
  }
  ipcMain.handle('agent:chat', (e, req: AgentChatRequest) =>
    withAbort(String(req?.chatId ?? '') || randomUUID(), e.sender, signal => agentChat(req, signal, String(req?.chatId ?? ''))))
  ipcMain.handle('agent:regenerate', (e, req: AgentChatRequest) =>
    withAbort(String(req?.chatId ?? '') || randomUUID(), e.sender, signal => agentRegenerate(req, signal)))
  ipcMain.handle('agent:startScene', (e, req: AgentChatRequest) =>
    withAbort(String(req?.chatId ?? '') || randomUUID(), e.sender, signal => agentStartScene(req, signal)))
  ipcMain.handle('agent:editMessage', (e, req: AgentChatRequest & { messageId: string }) =>
    withAbort(String(req?.chatId ?? '') || randomUUID(), e.sender, signal => agentEditAndRegen(req, signal)))
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
  ipcMain.handle('agent:sessions', () => {
    ensureSessionSources()
    return listAgentSessions().map(camelRow)
  })
  ipcMain.handle('agent:newSession', (_e, title?: string, source?: string) =>
    camelRow(createAgentSession(
      typeof title === 'string' && title.trim() ? title.trim() : '新会话',
      source === 'aiTeaching' ? 'aiTeaching' : 'assistant',
    )))
  ipcMain.handle('agent:messages', (_e, id: string) => getAgentMessages(String(id ?? '')).map(camelRow))
  // AI 用量 / 会话文件改动（v3.4.0 批次5，方案 §4/§3.8）：右栏 token 面板只读
  ipcMain.handle('agent:usage:get', () => getAiUsageData())
  ipcMain.handle('agent:sessionChanges:get', (_e, sessionId?: string) =>
    getSessionChanges(typeof sessionId === 'string' && sessionId ? sessionId : undefined))
  ipcMain.handle('agent:renameSession', (_e, id: string, title: string) => {
    if (typeof id === 'string' && typeof title === 'string' && title.trim()) renameAgentSession(id, title.trim())
    return true
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
  // 列某主线下的支线（含已升格）：左栏缩进渲染 + 删除前计数
  ipcMain.handle('agent:listSideLanes', (_e, parentSessionId: string) =>
    listSideLanes(String(parentSessionId ?? '')).map(camelRow))
  // 升格支线为正式会话（单向）：lane 置 'main' → 进左栏列表
  ipcMain.handle('agent:promoteSideLane', (_e, laneSessionId: string) =>
    promoteSideLane(String(laneSessionId ?? '')))
}
