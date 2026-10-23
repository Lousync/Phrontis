import { useCallback, useEffect, useReducer, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { showToast } from '../../../lib/toast'
import { handleChatCommand } from '../../../lib/chatCommands'
import { getAssistantContext } from '../../../lib/assistantContext'
import { useSettings } from '../../../lib/SettingsContext'
import {
  agentSessions, agentMessages, agentDeleteSession, agentSetSessionPinned,
  agentChat, agentRegenerate, agentResume, agentEditMessage, agentDeleteMessage,
  llmListProviders, agentAbortSession, aiToolsListSkills, onAssistantNotice,
  agentSetSessionScope, agentSetSessionPrefs, agentRenameSession, agentUsageGet,
  aiAssistantPlanGet, aiAssistantPlanApply, aiAssistantPlanReject, aiAssistantTaskRollback,
} from '../../../lib/ipc'
// 新建会话走包装层：会话随仓库走，无仓库时要给提示而不是静默失败
import { newAgentSession } from '../../../lib/agentSession'
import type { AgentSessionInfo, AgentStoredMessage, AgentTraceStep, AgentContextInfo, AgentChange, SkillInfo, AgentSessionSource, ResumeInfo, AiChangePlan } from '../../../types'
import type { StreamDraft } from '../../../lib/agentStreamCore'
import {
  MAX_PARALLEL, subscribeAssistantRunState, getRunBucket, isSessionRunning, runningSessionCount,
  runMarkOf, beginRun, endRun, markSessionViewed, unmarkSessionViewed, takeEndedFor,
} from '../../../lib/assistantRunStore'
import type { UiMessage } from './MessageList'

/**
 * AI 助手会话控制器（v3.4.0 批次5，v3.11.0 统一）：会话/流式/发送/编辑/删除/作用域/写入方式/变更方案
 * 全部内聚的 headless hook。
 *
 * 三处宿主共用（方案 workbench-shell-design §4「会话基建复用，不重造对话 UI」）：
 * - 悬浮侧栏（AssistantPanel，Ctrl+J）
 * - 工作台右栏 AI 态窄版（ChatBody docked + ⤢）
 * - aiChat 中间标签宽版（ChatBody page）
 *
 * 会话数据真源在主进程（agentSessions/agentMessages），多实例各自拉取；发送后以
 * refreshMessages 按会话库对齐，切换宿主不丢历史。宿主特有行为通过 options 注入：
 * 上下文优先级链、发送前正文预处理（划词引用）、chatCommand surface。
 *
 * N-3 多对话并行（docs/assistant-parallel-design.md）：运行态/流式草稿的真源上移 ——
 * 三宿主共享 assistantRunStore（sessionId 分桶），pending 从「hook 全局布尔」改为
 * 「目标会话是否在跑」；切走会话不终止运行，切回恢复实时流，后台完成/失败有角标与 Toast。
 */

export interface AssistantChatOptions {
  /** 宿主是否可见：可见时刷新供应商检查 / Skill 候选 / 会话列表 */
  active: boolean
  /**
   * 界面上下文解析（缺省 = 当前界面 getAssistantContext）。
   * ⚠️ 只会被**事件回调 / effect** 调用（发送、重生成、改写，以及徽章的提交后同步）——
   * 所以宿主可以安全闭包引用本组件里声明在 hook 之后的 ref；但**别在 render 期调用它**（TDZ 崩页）。
   */
  resolveContext?: () => AgentContextInfo | null
  /** / 指令的执行面（悬浮版随全屏态切换；其余宿主固定 assistant；日程助手传 'schedule'） */
  surfaceOf?: () => 'assistant' | 'aiLearn' | 'schedule'
  /** 发送前正文预处理（悬浮版并入划词引用块并清空；返回处理后正文） */
  prepareBody?: (body: string) => string
  /**
   * 会话来源（日程助手 P1）：缺省 = 通用助手（列表排除 aiTeaching）。
   * 传 'schedule' 时——会话列表只列 schedule 来源、新建会话带此来源、发送经 agentChat 透传
   * （主进程据此注入日程人设与工具面），与通用助手**物理隔离**、列表互不可见。
   */
  sessionSource?: AgentSessionSource
  /**
   * 「一天一个会话」（日程助手）：激活且当前无活动会话时，自动载入**今天创建**的会话
   * （按 createdAt 日期判定）；今天还没有就新建一条（标题 = 今天日期）。配合右栏 Tab 切走即卸载，
   * 实现「今天开的对话，下次打开还在」。
   */
  autoResumeToday?: boolean
  /**
   * 统一 AI 助手（v3.11.0）：启用文件作用域 / 写入策略 / 会话级模型与变更方案。
   * 缺省 true；日程助手传 false，保持原行为。
   */
  unified?: boolean
}

/** 对话 UI（ChatBody / 全屏学堂 bridge）消费的控制器面 */
export interface AssistantChatController {
  sessions: AgentSessionInfo[]
  providersOk: boolean | null
  activeId: string | null
  active: AgentSessionInfo | null
  messages: UiMessage[]
  input: string
  setInput: (v: string) => void
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  /** 激活会话是否在跑（N-3：会话级 pending —— 别的会话在跑不占本会话的锁） */
  pending: boolean
  liveSteps: AgentTraceStep[]
  draft: StreamDraft | null
  lastChanges: AgentChange[] | null
  compressing: boolean
  pickedSkill: SkillInfo | null
  setPickedSkill: Dispatch<SetStateAction<SkillInfo | null>>
  slashSkills: SkillInfo[]
  editing: { id: string; draft: string } | null
  setEditing: Dispatch<SetStateAction<{ id: string; draft: string } | null>>
  copiedIdx: number | null
  setCopiedIdx: Dispatch<SetStateAction<number | null>>
  deletingId: string | null
  /** 当前会话运行角标（running / failed / unread / null） */
  runMark: 'running' | 'failed' | 'unread' | null
  /** 统一助手：文件作用域（仓库相对前缀） */
  scope: string[]
  /** true = 整个仓库 */
  scopeAll: boolean
  setScope: (next: string[]) => void
  setScopeAll: (all: boolean) => void
  /** 写入策略 */
  writeMode: 'direct' | 'confirm'
  setWriteMode: (mode: 'direct' | 'confirm') => void
  /** 变更方案（confirm 模式） */
  plan: AiChangePlan | null
  pendingCount: number
  appliedCount: number
  refreshPlan: () => Promise<void>
  applyPlan: (ids: string[]) => Promise<void>
  rejectPlan: () => Promise<void>
  rollbackTask: () => Promise<void>
  /** 本会话累计 token（跨日聚合） */
  usage: { in: number; out: number }
  drawerMounted: boolean
  drawerOpen: boolean
  toggleDrawer: () => void
  closeDrawer: () => void
  send: (override?: string) => Promise<void>
  newSession: (title?: string) => Promise<AgentSessionInfo | null>
  loadSession: (id: string) => Promise<void>
  /** 切会话（兼容旧 AI助手模块的同步 API）：内部走 loadSession */
  setActiveId: (id: string | null) => void
  removeSession: (id: string) => Promise<void>
  /** 立即删除（旧 AI助手模块用；抽屉仍走 removeSession 的二次确认） */
  deleteSessionNow: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  /** 钉住 / 取消钉住会话（通用助手左栏「★ 收藏」分区）：乐观更新 + 落盘 */
  togglePin: (id: string) => Promise<void>
  regenerate: () => Promise<void>
  /**
   * 从断点继续（A 方案，2026-10-14）：中断卡上的「继续」。
   * 不追加用户消息；现场（含 carry）由主进程一次性 claim。仅 `resumeInfo` 指向的那条消息可触发。
   */
  resume: () => Promise<void>
  /** 本会话最近一次中断留下的可续现场（无 = null）；`resumeInfo.messageId` 就是挂按钮的那条消息 */
  resumeInfo: ResumeInfo | null
  editSubmit: (id: string, content: string) => Promise<void>
  deleteMessage: (id: string) => Promise<void>
  abort: () => Promise<void>
  dismissChanges: () => void
  /** 主动刷新会话列表（宿主切换等场景）；返回刷新后的列表供调用方同步使用 */
  refreshSessions: () => Promise<AgentSessionInfo[]>
  /** N-3 会话列表运行态标记（running=转圈 / unread=完成未读蓝点 / failed=失败红标） */
  runStateOf: (sid: string) => 'running' | 'failed' | 'unread' | null
  /** 对话模型（providerId:modelId 串；空 = 全局默认）——settings 持久化 */
  modelId: string
  setModelId: (v: string) => void
  /** 思考模式（开 = reasoning_effort:medium，慢而全面；关 = 快速回答）——会话级，缺省继承 settings */
  thinking: boolean
  setThinking: (v: boolean) => void
  /** 思考强度（完整档位；会话级，缺省继承 settings） */
  effort: 'off' | 'low' | 'medium' | 'high'
  setEffort: (v: 'off' | 'low' | 'medium' | 'high') => void
  /** 📎 附加文件（随消息上下文；发送后不清空，× 移除） */
  attachedFiles: Array<{ pageId: string; title: string; path: string }>
  setAttachedFiles: Dispatch<SetStateAction<Array<{ pageId: string; title: string; path: string }>>>
  /**
   * 当前界面上下文（与发送时解析同源，供输入区徽章显示）。
   * `contextRemoved` = 用户已把这个界面从附带里移除（发送时不附带；换界面自动恢复）。
   */
  contextInfo: AgentContextInfo | null
  contextRemoved: boolean
  dismissContext: () => void
  restoreContext: () => void
}

function nowLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 今天 YYYY-MM-DD（本地时区；「一天一个会话」按它判定） */
function todayYmd(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
/** 今天的会话默认标题（如「10月11日 周六」） */
function todayLabel(): string {
  const d = new Date()
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  return `${d.getMonth() + 1}月${d.getDate()}日 ${wd}`
}

/** 落库消息 → UI 消息（保留 id 供编辑/删除/重新生成定位） */
function toUi(m: AgentStoredMessage): UiMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    trace: m.traceJson ? (() => { try { return JSON.parse(m.traceJson) as AgentTraceStep[] } catch { return undefined } })() : undefined,
  }
}

/**
 * 界面上下文的「身份」——给「已移除」记忆用。
 * 同 type + 同 data.id（无 id 时退化为 label）即视为同一个界面上下文：
 * 同一界面保持移除态，换界面（另一个页面/模块）自动恢复显示与附带。
 */
function contextKeyOf(c: AgentContextInfo | null): string | null {
  if (!c) return null
  const id = (c.data as Record<string, unknown> | undefined)?.['id']
  const tail = (typeof id === 'string' || typeof id === 'number') ? String(id) : c.label
  return `${c.type}|${tail}`
}

export function useAssistantChat(options: AssistantChatOptions): AssistantChatController {
  const { active, sessionSource } = options
  const unified = options.unified !== false && !sessionSource
  const autoResumeToday = options.autoResumeToday === true
  /**
   * 界面上下文解析（宿主可注入优先级链，缺省 = 当前界面）。
   *
   * ⚠️ **只能在事件回调 / effect 里调用，绝不能在 render 期调用**：宿主的 resolveContext 常闭包
   * 引用本组件里声明在 useAssistantChat **之后**的 ref（如 AssistantPanel 的 helpCtxRef），
   * render 期调用会直接撞 TDZ（`Cannot access 'helpCtxRef' before initialization`）→ 整页 error
   * boundary。2026-09-20 实践过，别重犯。发送路径在事件回调里，安全。
   */
  const resolveCtx = useCallback(
    () => (options.resolveContext ? options.resolveContext() : getAssistantContext()),
    [options.resolveContext],
  )
  /**
   * 「已移除的界面上下文」身份（2026-09-20 反馈：打开某个界面就被默认附加进对话，想不要都不行）。
   * 记身份而不是布尔量：同一界面保持移除，换界面自动恢复。仅由事件回调写入。
   */
  const [ctxOffKey, setCtxOffKey] = useState<string | null>(null)
  /**
   * 当前界面上下文（徽章显示用，与发送同源）。经 effect 同步而非 render 期解析（见 resolveCtx 警告），
   * 且只在「身份 + 标签」变化时落 state —— resolver 每次都返回新对象，无此闸会无限重渲染。
   */
  const [contextInfo, setContextInfo] = useState<AgentContextInfo | null>(null)
  const ctxSeenRef = useRef('')
  useEffect(() => {
    const c = resolveCtx()
    const seen = `${contextKeyOf(c) ?? ''}|${c?.label ?? ''}`
    if (seen === ctxSeenRef.current) return
    ctxSeenRef.current = seen
    setContextInfo(c)
  })
  const contextRemoved = contextInfo !== null && ctxOffKey !== null && ctxOffKey === contextKeyOf(contextInfo)
  const dismissContext = useCallback(() => {
    const k = contextKeyOf(contextInfo)
    if (k) setCtxOffKey(k)
  }, [contextInfo])
  const restoreContext = useCallback(() => setCtxOffKey(null), [])
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([])
  const [providersOk, setProvidersOk] = useState<boolean | null>(null)
  const [activeId, setActiveIdState] = useState<string | null>(null)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [input, setInput] = useState('')
  // / 弹层（指令 + 已装 Skill）与 Skill 显式调用 chip、压缩进行时占位
  const [slashSkills, setSlashSkills] = useState<SkillInfo[]>([])
  const [pickedSkill, setPickedSkill] = useState<SkillInfo | null>(null)
  const [compressing, setCompressing] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  /** 本次请求的真实改动清单（agentChat 返回 changes）→ 完成后卡片 */
  const [lastChanges, setLastChanges] = useState<AgentChange[] | null>(null)
  // 统一助手：文件作用域 / 写入策略 / 变更方案 / 会话级模型与思考强度
  const [scope, setScopeState] = useState<string[]>([])
  const [scopeAll, setScopeAllState] = useState(true)
  const [writeMode, setWriteModeState] = useState<'direct' | 'confirm'>('direct')
  const [plan, setPlan] = useState<AiChangePlan | null>(null)
  const [usage, setUsage] = useState<{ in: number; out: number }>({ in: 0, out: 0 })
  const activeSession = sessions.find(s => s.id === activeId) ?? null

  // 对话模型选择：新会话默认继承 settings；已有会话优先会话级 modelId
  const { s: assistantSettings, update: updateAssistantSetting } = useSettings()
  const defaultModelId = typeof assistantSettings.assistantModelId === 'string' ? assistantSettings.assistantModelId : ''
  const defaultEffort: 'off' | 'low' | 'medium' | 'high' = assistantSettings.assistantThinking !== false ? 'medium' : 'off'
  const modelId = unified ? (activeSession?.modelId || defaultModelId) : defaultModelId
  const effort = unified ? (activeSession?.effort ?? defaultEffort) : defaultEffort
  const thinking = effort !== 'off'
  const setModelId = useCallback((v: string) => {
    if (unified && activeId) {
      setSessions(prev => prev.map(s => s.id === activeId ? { ...s, modelId: v || undefined } : s))
      void agentSetSessionPrefs(activeId, { modelId: v }).catch(() => { /* 失败下一轮 refresh 对齐 */ })
      return
    }
    updateAssistantSetting('assistantModelId', v)
  }, [unified, activeId, updateAssistantSetting])
  const setEffort = useCallback((v: 'off' | 'low' | 'medium' | 'high') => {
    if (unified && activeId) {
      setSessions(prev => prev.map(s => s.id === activeId ? { ...s, effort: v } : s))
      void agentSetSessionPrefs(activeId, { effort: v }).catch(() => { /* 失败下一轮 refresh 对齐 */ })
      return
    }
    updateAssistantSetting('assistantThinking', v !== 'off')
  }, [unified, activeId, updateAssistantSetting])
  const setThinking = useCallback((v: boolean) => setEffort(v ? 'medium' : 'off'), [setEffort])

  /** 附加文件（输入区 📎 添加，随消息作为上下文；正文不注入，模型按 path 用文件读取工具自取） */
  const [attachedFiles, setAttachedFiles] = useState<Array<{ pageId: string; title: string; path: string }>>([])
  // 会话抽屉动画三态（Tailwind v4 translate 过渡的 transitionend 不可依赖，定时器兜底卸载）
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerMounted, setDrawerMounted] = useState(false)
  const drawerTimerRef = useRef<number | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  /** send 的自引用（提示型指令 /简报 的 onSend 用）：避免在 send 内部直接递归引用自身 */
  const sendRef = useRef<((override?: string) => Promise<void>) | null>(null)
  /** 当前会话 id 的实时镜像：回复返回时判断用户是否已切换会话 */
  const activeIdRef = useRef<string | null>(null)
  useEffect(() => { activeIdRef.current = activeId }, [activeId])
  /** 作用域落库防抖（400ms）；切会话前 flush，避免「刚勾完就切走」丢改动 */
  const scopeTimerRef = useRef<number | null>(null)
  const scopePendingRef = useRef<{ id: string; scope: string[]; scopeAll: boolean } | null>(null)
  const flushScope = useCallback(() => {
    if (scopeTimerRef.current !== null) {
      window.clearTimeout(scopeTimerRef.current)
      scopeTimerRef.current = null
    }
    const pending = scopePendingRef.current
    scopePendingRef.current = null
    if (pending) void agentSetSessionScope(pending.id, pending.scope, pending.scopeAll).catch(() => { /* 下次勾选会再写 */ })
  }, [])
  useEffect(() => () => flushScope(), [flushScope])

  // 切会话 / 会话行更新：把作用域、写入策略、方案、用量同步到当前视图
  useEffect(() => {
    if (!unified) return
    if (!activeId) {
      setScopeState([])
      setScopeAllState(true)
      setWriteModeState('direct')
      setPlan(null)
      setUsage({ in: 0, out: 0 })
      return
    }
    const row = sessions.find(s => s.id === activeId)
    // 防抖窗口内刚勾的范围还没落库：不要被一次 refreshSessions 打回旧值
    const scopePending = scopeTimerRef.current !== null && scopePendingRef.current?.id === activeId
    if (!scopePending) setScopeState(Array.isArray(row?.scope) ? row.scope.slice() : [])
    setScopeAllState(scopePending ? false : row?.scopeAll !== false)
    setWriteModeState(row?.writeMode === 'confirm' ? 'confirm' : 'direct')
  }, [unified, activeId, sessions])

  // ===== N-3 多对话并行：运行态/流式草稿来自共享 store（三宿主单例） =====
  // store 60ms 节流 notify → bump 重渲染，pending/draft/liveSteps 每次渲染按激活会话现读
  const [, bumpRunVersion] = useReducer((x: number) => x + 1, 0)
  /** refreshMessages 的稳定引用：store 订阅回调（声明在前）触达后定义的刷新函数用 */
  const refreshMessagesRef = useRef<((sid: string) => Promise<void>) | null>(null)
  /** 同上：会话列表（可续现场的出口）也要能在订阅回调里刷新 */
  const refreshSessionsRef = useRef<(() => Promise<AgentSessionInfo[]>) | null>(null)
  const refreshPlanRef = useRef<(() => Promise<void>) | null>(null)
  const refreshUsageRef = useRef<(() => Promise<void>) | null>(null)
  useEffect(() => subscribeAssistantRunState(() => {
    // 后台完成时正被本宿主查看（本宿主不是发起方、没有 finally 兜底）→ 补一次消息对齐
    const sid = activeIdRef.current
    if (sid && takeEndedFor(sid)) {
      void refreshMessagesRef.current?.(sid)
      // 中断现场写在会话行上：后台那一次是以别的宿主/窗口发起的，这里必须重拉才拿得到「继续」
      void refreshSessionsRef.current?.()
      void refreshPlanRef.current?.()
      void refreshUsageRef.current?.()
    }
    bumpRunVersion()
  }), [])
  const pending = isSessionRunning(activeId)
  const runBucket = getRunBucket(activeId)
  const draft = runBucket?.draft ?? null
  const liveSteps = runBucket?.liveSteps ?? []
  /**
   * 可续现场（A 方案）：真源在主进程会话行的 resume（出口已 toResumeInfo 裁剪，**不含 carry**）。
   * 只认本会话那一份 —— 别的会话的中断不该在当前视图冒出「继续」。
   */
  const resumeInfo = activeId ? (sessions.find(s => s.id === activeId)?.resumeInfo ?? null) : null

  // 查看登记（计数制，多宿主对称进出）：进入清角标，离开撤销「查看中」
  useEffect(() => {
    if (!activeId) return
    markSessionViewed(activeId)
    return () => unmarkSessionViewed(activeId)
  }, [activeId])

  // 卸载时清理抽屉定时器
  useEffect(() => {
    return () => { if (drawerTimerRef.current !== null) window.clearTimeout(drawerTimerRef.current) }
  }, [])

  // 可见性驱动刷新：供应商检查（每次变为可见都重查，避免「后配模型仍显示未配置」）、
  // Skill 候选、会话列表
  useEffect(() => {
    if (!active) return
    llmListProviders()
      .then(r => setProvidersOk(r.providers.some(p => p.enabled && p.models.length > 0)))
      .catch(() => setProvidersOk(false))
    aiToolsListSkills().then(r => setSlashSkills(r.skills)).catch(() => setSlashSkills([]))
  }, [active])

  const refreshSessions = useCallback(async (): Promise<AgentSessionInfo[]> => {
    try {
      // 按来源分流（同表存储）：日程助手只列 schedule；通用助手**只列 assistant**
      // （AI 教学有自己的会话列表）。三者列表互不可见。
      // ★ 2026-10-13（F-8）：默认分支原来是**排除法**（`!== 'aiTeaching'`）—— 第三来源 `schedule`
      //   落地时没回头补这一条 ⇒ 日程助手的会话混进了通用助手列表（三个宿主都不传 sessionSource，
      //   全走这个分支）。改成**白名单**语义：以后再加来源不会重犯，写 `!==` 就得记得回来加一条。
      //   `?? 'assistant'`：存量老数据无 source 字段（由 backfillSessionSources 回填），
      //   兜底按通用助手算，与 agentSessionRepo 的缺省口径一致。
      const all = await agentSessions()
      const list = sessionSource
        ? all.filter(x => x.source === sessionSource)
        : all.filter(x => (x.source ?? 'assistant') === 'assistant' || x.source === 'aiAssistant')
      setSessions(list)
      return list
    } catch { return [] }
  }, [sessionSource])

  useEffect(() => { if (active) void refreshSessions() }, [active, refreshSessions])
  refreshSessionsRef.current = refreshSessions

  // N-1 手册通道：主进程侧提示（手册→通用助手升格）→ Toast + 刷新会话列表（徽标随之变化）
  useEffect(() => onAssistantNotice((p) => {
    if (p?.message) showToast({ type: 'info', message: p.message })
    void refreshSessions()
  }), [refreshSessions])

  /** 以会话库为准刷新消息（发送/重新生成/编辑/删除后统一走这里，拿到落库 id 与 trace） */
  const refreshMessages = useCallback(async (sid: string) => {
    if (activeIdRef.current !== sid) return
    try {
      const rows: AgentStoredMessage[] = await agentMessages(sid)
      if (activeIdRef.current === sid) setMessages(rows.map(toUi))
    } catch { /* keep current */ }
  }, [])
  refreshMessagesRef.current = refreshMessages

  const refreshPlan = useCallback(async () => {
    const sid = activeIdRef.current
    if (!unified || !sid) { setPlan(null); return }
    try { setPlan(await aiAssistantPlanGet(sid)) } catch { setPlan(null) }
  }, [unified])

  const refreshUsage = useCallback(async () => {
    const sid = activeIdRef.current
    if (!sid) { setUsage({ in: 0, out: 0 }); return }
    try {
      const { days } = await agentUsageGet()
      let tin = 0
      let tout = 0
      for (const d of Object.values(days)) {
        const b = d.sessions?.[sid]
        if (b) { tin += b.in; tout += b.out }
      }
      setUsage({ in: tin, out: tout })
    } catch { /* 用量读取失败不影响主流程 */ }
  }, [])

  refreshPlanRef.current = refreshPlan
  refreshUsageRef.current = refreshUsage
  useEffect(() => {
    void refreshPlan()
    void refreshUsage()
  }, [activeId, refreshPlan, refreshUsage])

  const setScope = useCallback((next: string[]) => {
    if (!unified) {
      setScopeState(Array.isArray(next) ? next.slice() : [])
      return
    }
    const id = activeIdRef.current
    const clean = Array.isArray(next) ? next.slice() : []
    const wasAll = scopeAll
    if (id && plan?.ops.some(o => o.status === 'pending')) {
      showToast({ type: 'info', message: '有未处理的变更方案', detail: '先应用或丢弃，再改作用域' })
      return
    }
    if (id && isSessionRunning(id)) return
    // 首次发送前（尚无会话）也要把「缩窄」写进草稿：否则新会话仍按整仓 + 直接执行创建
    setScopeState(clean)
    setScopeAllState(false)
    if (wasAll) setWriteModeState('confirm')
    if (!id) return
    // 从「整个仓库」主动缩窄 → 自动切先预览；扩回整仓不会自动切回
    if (wasAll) {
      setSessions(prev => prev.map(s => s.id === id ? { ...s, scope: clean, scopeAll: false, writeMode: 'confirm' } : s))
      void agentSetSessionPrefs(id, { writeMode: 'confirm' }).catch(() => { /* 落库失败下一轮对齐 */ })
    } else {
      setSessions(prev => prev.map(s => s.id === id ? { ...s, scope: clean, scopeAll: false } : s))
    }
    if (scopeTimerRef.current !== null) window.clearTimeout(scopeTimerRef.current)
    scopePendingRef.current = { id, scope: clean, scopeAll: false }
    scopeTimerRef.current = window.setTimeout(() => {
      scopeTimerRef.current = null
      const pending = scopePendingRef.current
      scopePendingRef.current = null
      if (pending) void agentSetSessionScope(pending.id, pending.scope, pending.scopeAll).catch(() => { /* 下次勾选会再写 */ })
    }, 400)
  }, [unified, scopeAll, plan])

  const setScopeAll = useCallback((all: boolean) => {
    if (!unified) return
    if (plan?.ops.some(o => o.status === 'pending')) {
      showToast({ type: 'info', message: '有未处理的变更方案', detail: '先应用或丢弃，再改作用域' })
      return
    }
    const id = activeIdRef.current
    const wasAll = scopeAll
    setScopeAllState(all)
    if (all) setScopeState([])
    if (!id) {
      if (!all && wasAll) setWriteModeState('confirm')
      return
    }
    if (isSessionRunning(id)) return
    setSessions(prev => prev.map(s => s.id === id ? { ...s, scope: all ? [] : s.scope, scopeAll: all } : s))
    if (scopeTimerRef.current !== null) window.clearTimeout(scopeTimerRef.current)
    scopePendingRef.current = all ? null : scopePendingRef.current
    if (all) {
      void agentSetSessionScope(id, [], true).catch(() => { /* 下次勾选会再写 */ })
      return
    }
    const clean = scope
    scopePendingRef.current = { id, scope: clean, scopeAll: false }
    scopeTimerRef.current = window.setTimeout(() => {
      scopeTimerRef.current = null
      const pending = scopePendingRef.current
      scopePendingRef.current = null
      if (pending) void agentSetSessionScope(pending.id, pending.scope, pending.scopeAll).catch(() => { /* 下次勾选会再写 */ })
    }, 400)
  }, [unified, scope, scopeAll, plan])

  const setWriteMode = useCallback((mode: 'direct' | 'confirm') => {
    if (!unified) return
    if (plan?.ops.some(o => o.status === 'pending')) {
      showToast({ type: 'info', message: '有未处理的变更方案', detail: '先应用或丢弃，再改写入方式' })
      return
    }
    setWriteModeState(mode)
    const id = activeIdRef.current
    if (!id) return
    setSessions(prev => prev.map(s => s.id === id ? { ...s, writeMode: mode } : s))
    void agentSetSessionPrefs(id, { writeMode: mode }).catch(() => { /* 下一轮对齐 */ })
  }, [unified, plan])

  const openDrawer = useCallback(() => {
    if (drawerTimerRef.current !== null) {
      window.clearTimeout(drawerTimerRef.current)
      drawerTimerRef.current = null
    }
    setDrawerMounted(true)
    setDrawerOpen(true)
  }, [])

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false)
    // 滑出动画后卸载 DOM（240ms；事件卸载在 Tailwind v4 下会永久残留遮罩，见悬浮层注释）
    if (drawerTimerRef.current !== null) window.clearTimeout(drawerTimerRef.current)
    drawerTimerRef.current = window.setTimeout(() => {
      setDrawerMounted(false)
      drawerTimerRef.current = null
    }, 240)
  }, [])

  const toggleDrawer = useCallback(() => {
    if (drawerOpen) closeDrawer()
    else openDrawer()
  }, [drawerOpen, openDrawer, closeDrawer])

  const loadSession = useCallback(async (id: string) => {
    flushScope()
    setActiveIdState(id)
    setPlan(null)
    closeDrawer()
    try {
      const rows: AgentStoredMessage[] = await agentMessages(id)
      setMessages(rows.map(toUi))
    } catch { setMessages([]) }
  }, [closeDrawer, flushScope])

  const newSession = useCallback(async (title?: string): Promise<AgentSessionInfo | null> => {
    flushScope()
    // 从已有会话点「新建」= 回到默认整仓 + 直接执行；
    // 首次发送前（没有活动会话）创建 = 沿用户刚在输入区选好的草稿设置。
    const hadActive = !!activeIdRef.current
    const targetScopeAll = hadActive ? true : scopeAll
    const targetScope = targetScopeAll ? [] : scope
    const targetWriteMode = hadActive ? 'direct' : writeMode
    const targetModelId = hadActive ? '' : modelId
    const targetEffort = hadActive ? undefined : effort
    const sRow = await newAgentSession(title, sessionSource)
    if (!sRow) return null
    if (unified) {
      await agentSetSessionScope(sRow.id, targetScope, targetScopeAll).catch(() => null)
      if (targetWriteMode === 'confirm') await agentSetSessionPrefs(sRow.id, { writeMode: 'confirm' }).catch(() => null)
      if (targetModelId) await agentSetSessionPrefs(sRow.id, { modelId: targetModelId }).catch(() => null)
      if (targetEffort) await agentSetSessionPrefs(sRow.id, { effort: targetEffort }).catch(() => null)
      setSessions(prev => [{
        ...sRow,
        scope: targetScope,
        scopeAll: targetScopeAll,
        writeMode: targetWriteMode,
        modelId: targetModelId || undefined,
        effort: targetEffort,
      }, ...prev])
    } else {
      setSessions(prev => [sRow, ...prev])
    }
    setActiveIdState(sRow.id)
    activeIdRef.current = sRow.id
    setMessages([])
    setPlan(null)
    setScopeState(targetScope)
    setScopeAllState(targetScopeAll)
    setWriteModeState(targetWriteMode)
    closeDrawer()
    return sRow
  }, [closeDrawer, flushScope, sessionSource, unified, scopeAll, scope, writeMode, modelId, effort])

  const selectSession = useCallback((id: string | null) => {
    if (!id) { setActiveIdState(null); activeIdRef.current = null; setMessages([]); return }
    void loadSession(id)
  }, [loadSession])

  const deleteSessionNow = useCallback(async (id: string) => {
    await agentDeleteSession(id)
    setSessions(prev => prev.filter(x => x.id !== id))
    if (activeIdRef.current === id) { setActiveIdState(null); activeIdRef.current = null; setMessages([]) }
  }, [])

  const renameSession = useCallback(async (id: string, title: string) => {
    const t = title.trim().slice(0, 40)
    if (!t) return
    setSessions(prev => prev.map(s => s.id === id ? { ...s, title: t } : s))
    try { await agentRenameSession(id, t) } catch { /* 下方刷新拉回真值 */ }
    await refreshSessions()
  }, [refreshSessions])

  // 「一天一个会话」（日程助手）：激活且当前无活动会话时，自动载入今天创建的会话；没有则新建一条。
  // 右栏 Tab 切走即卸载（WorkbenchRightPanel 条件渲染）→ 再次打开时本效果重跑，回到今天的会话。
  useEffect(() => {
    if (!active || !autoResumeToday) return
    let cancelled = false
    void (async () => {
      const list = await refreshSessions()
      if (cancelled || activeIdRef.current) return
      const today = todayYmd()
      const mine = list.filter(s => (s.createdAt ?? '').slice(0, 10) === today)
      if (mine.length > 0) await loadSession(mine[0].id)
      else await newSession(todayLabel())
    })()
    return () => { cancelled = true }
  }, [active, autoResumeToday, refreshSessions, loadSession, newSession])

  const removeSession = useCallback(async (id: string) => {
    if (deletingId !== id) {
      setDeletingId(id)
      setTimeout(() => setDeletingId(cur => (cur === id ? null : cur)), 3000)
      return
    }
    setDeletingId(null)
    await agentDeleteSession(id)
    setSessions(prev => prev.filter(x => x.id !== id))
    if (activeIdRef.current === id) { setActiveIdState(null); activeIdRef.current = null; setMessages([]) }
  }, [deletingId])

  /** 钉住 / 取消钉住（通用助手「★ 收藏」分区）：乐观更新，落盘失败再拉库对齐 */
  const togglePin = useCallback(async (id: string) => {
    const cur = sessions.find(s => s.id === id)
    const next = !cur?.pinnedAt
    setSessions(prev => prev.map(s => (s.id === id ? { ...s, pinnedAt: next ? new Date().toISOString() : null } : s)))
    try {
      const ok = await agentSetSessionPinned(id, next)
      if (!ok) void refreshSessions()
    } catch {
      showToast({ type: 'error', message: '钉住失败' })
      void refreshSessions()
    }
  }, [sessions, refreshSessions])

  /** 路径是否在作用域内（前缀语义，仅用于附件过滤的保守判断） */
  const pathInScope = useCallback((path: string, list: string[]): boolean => {
    const p = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    return list.some(raw => {
      const s = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      return !!s && (p === s || p.startsWith(s + '/'))
    })
  }, [])

  /** 统一助手的上下文：作用域/写入方式必须随每轮请求进主进程 */
  const unifiedContextOf = useCallback((base: AgentContextInfo | null): AgentContextInfo | undefined => {
    if (!unified) return base ?? undefined
    return {
      type: base?.type ?? 'assistant',
      label: base?.label ?? 'AI 助手',
      data: {
        ...(base?.data ?? {}),
        scope,
        scopeAll,
        writeMode,
        unifiedAssistant: true,
      },
    }
  }, [unified, scope, scopeAll, writeMode])

  const send = useCallback(async (override?: string) => {
    const raw = (override ?? input).trim()
    // 宿主预处理（悬浮版：划词引用块并入正文并清空——body 为空但仍有引用时返回纯引用正文；
    // 其他宿主原样返回 raw）。返回空串 = 无可发送内容，取消本次发送
    const body = options.prepareBody ? options.prepareBody(raw) : raw
    if (!body) return
    flushScope()
    // N-3 会话级占锁：只有「本会话」在跑才拦（别的会话在跑互不影响，可并行）
    if (isSessionRunning(activeIdRef.current)) {
      showToast({ type: 'info', message: '本对话正在回复中，请等待完成或点击「停止」' })
      return
    }
    // N-3 并行上限：全进程（含 AI 教学占用）同时在跑 ≥ MAX_PARALLEL 时不再新开
    if (runningSessionCount() >= MAX_PARALLEL) {
      showToast({ type: 'info', message: `已有 ${MAX_PARALLEL} 个对话在运行，请等一个完成再发` })
      return
    }
    // 斜杠指令（/compress 等）：命中即拦截执行，不进对话（置于 pending 检查后，避免生成中并发压缩）
    if (body.startsWith('/')) {
      if (await handleChatCommand(body, {
        sessionId: activeIdRef.current ?? '',
        surface: options.surfaceOf ? options.surfaceOf() : 'assistant',
        onProgress: p => setCompressing(p.active),
        // 提示型指令（/简报 等）：命中即把 prompt 当作用户消息发出（走正常 send 流程）
        onSend: (t) => { void sendRef.current?.(t) },
      })) {
        if (!override) setInput('')
        return
      }
    }
    let sid = activeIdRef.current
    if (!sid) {
      const sRow = await newSession()
      if (!sRow) return
      sid = sRow.id
    }
    // 界面上下文：被用户在徽章上 × 移除时不附带；缩窄文件作用域时不注入当前页面上下文
    const baseCtx = (unified && !scopeAll) || contextRemoved ? null : resolveCtx()
    // 附加文件（📎）：缩窄作用域时只保留 scope 内附件，范围外直接丢弃并提示
    const allowedAttachments = unified && !scopeAll
      ? attachedFiles.filter(f => pathInScope(f.path, scope))
      : attachedFiles
    if (allowedAttachments.length !== attachedFiles.length) {
      showToast({ type: 'info', message: '已忽略作用域外的附件', detail: `只随本轮发送作用域内的 ${allowedAttachments.length} 个文件` })
    }
    // 附加文件合成进上下文：正文不注入，模型需要内容时用文件读取工具按 path 自取
    let finalCtx: AgentContextInfo | null = baseCtx
    if (allowedAttachments.length > 0) {
      finalCtx = {
        type: 'attachedFiles',
        label: (baseCtx ? baseCtx.label + ' + ' : '') + `附加 ${allowedAttachments.length} 个文件`,
        data: {
          ...(baseCtx?.data ?? {}),
          attachedFiles: allowedAttachments.map(f => ({ title: f.title, path: f.path })),
          附加上下文说明: '用户为本轮对话附加了以上知识库文件作为上下文；文件正文未注入，需要内容时用文件读取工具按 path 读取。',
        },
      }
    }
    const outgoingCtx = unifiedContextOf(finalCtx)
    setMessages(prev => [...prev, { role: 'user', content: body, createdAt: nowLocal() }])
    setInput('')
    beginRun(sid)
    setLastChanges(null)
    const cid = crypto.randomUUID()
    try {
      // Skill chip 随消息一次性消费，发出即清
      const sk = pickedSkill
      setPickedSkill(null)
      const r = await agentChat(sid, body, outgoingCtx, cid, sessionSource, modelId || undefined, effort, sk?.registryName)
      // 自动压缩告知（会话压缩 §6.1）：主进程发送前折叠旧轮为纪要，用户应知道上下文变了
      if (r.ok && r.compressed) showToast({ type: 'info', message: `上下文已自动压缩 ${r.compressed.covered} 条历史 → 纪要` })
      // 用户在等待期间切换了会话：回复已落库，但不注入当前视图
      if (activeIdRef.current !== sid) {
        showToast({ type: 'info', message: '回复已保存到原会话，可在会话列表中查看' })
        return
      }
      if (r.ok && r.reply !== undefined) {
        if (r.changes && r.changes.length > 0) setLastChanges(r.changes)
      } else if (r.code === 'USER_ABORTED') {
        showToast({ type: 'info', message: '已停止生成 · 可点「继续」接着做' })
      } else {
        // 有可续现场（几乎每种中断都有）：明确告诉用户按钮在哪，别让他以为只能重来
        const canResume = r.interruption?.resumable === true
        showToast({ type: 'error', message: `AI 调用失败：${r.error ?? '未知错误'}${canResume ? ' · 可点「继续」接着做' : ''}` })
      }
      // 以会话库为准刷新（拿到落库 id/trace；中止时仅剩用户消息也保持一致）
      await refreshMessages(sid)
    } catch (err) {
      // G8：主进程侧异常逃逸时此前完全静默（卡片消失 + 零 Toast + 零记录）——这里兜住并留日志
      console.error('[assistant] send 未捕获异常', err)
      showToast({ type: 'error', message: `AI 调用异常：${String((err as Error)?.message ?? err)}` })
      await refreshMessages(sid).catch(() => { /* 刷新失败不掩盖原始异常 */ })
    } finally {
      endRun(sid)
      void refreshSessions()
      void refreshPlan()
      void refreshUsage()
    }
  }, [input, pickedSkill, flushScope, refreshMessages, refreshSessions, refreshPlan, refreshUsage, options, attachedFiles, modelId, effort, contextRemoved, resolveCtx, sessionSource, unified, scopeAll, scope, writeMode, unifiedContextOf, newSession, pathInScope])
  sendRef.current = send

  /** 重新生成最后一条回复（末条为助手消息时可用） */
  const regenerate = useCallback(async () => {
    flushScope()
    const sid = activeIdRef.current
    if (!sid || isSessionRunning(sid)) return
    if (runningSessionCount() >= MAX_PARALLEL) {
      showToast({ type: 'info', message: `已有 ${MAX_PARALLEL} 个对话在运行，请等一个完成再试` })
      return
    }
    if (messages.length === 0 || messages[messages.length - 1].role !== 'assistant') return
    beginRun(sid)
    setLastChanges(null)
    const cid = crypto.randomUUID()
    try {
      const baseCtx = (unified && !scopeAll) || contextRemoved ? null : resolveCtx()
      const r = await agentRegenerate(sid, unifiedContextOf(baseCtx), cid, effort)
      if (r.code === 'USER_ABORTED') showToast({ type: 'info', message: '已停止生成 · 可点「继续」接着做' })
      else if (!r.ok) {
        const again = r.interruption?.resumable === true ? ' · 可点「继续」接着做' : ''
        showToast({ type: 'error', message: `重新生成失败：${r.error ?? '未知错误'}${again}` })
      }
      else if (r.changes && r.changes.length > 0) setLastChanges(r.changes)
      await refreshMessages(sid)
    } catch (err) {
      // G8：主进程侧异常逃逸时此前完全静默（卡片消失 + 零 Toast + 零记录）
      console.error('[assistant] regenerate 未捕获异常', err)
      showToast({ type: 'error', message: `重新生成异常：${String((err as Error)?.message ?? err)}` })
      await refreshMessages(sid).catch(() => { /* 刷新失败不掩盖原始异常 */ })
    } finally {
      endRun(sid)
      void refreshSessions()
      void refreshPlan()
      void refreshUsage()
    }
  }, [messages, flushScope, refreshMessages, refreshSessions, refreshPlan, refreshUsage, effort, contextRemoved, resolveCtx, unified, scopeAll, unifiedContextOf])

  /**
   * 从断点继续（A 方案）：不追加用户消息 —— 主进程用会话行里那份现场（含 carry）拼一次续跑注入，
   * 拼在 convo 末尾（前缀不变 → prompt cache 不受影响）。守卫与 send 同款：
   * 本会话在跑 / 全局并发上限都不发请求；现场由主进程 claim，重复点击第二次会如实报「没有可继续的中断点」。
   */
  const resume = useCallback(async () => {
    flushScope()
    const sid = activeIdRef.current
    if (!sid || isSessionRunning(sid)) return
    if (runningSessionCount() >= MAX_PARALLEL) {
      showToast({ type: 'info', message: `已有 ${MAX_PARALLEL} 个对话在运行，请等一个完成再试` })
      return
    }
    beginRun(sid)
    setLastChanges(null)
    const cid = crypto.randomUUID()
    try {
      const baseCtx = (unified && !scopeAll) || contextRemoved ? null : resolveCtx()
      const r = await agentResume(sid, unifiedContextOf(baseCtx), cid, sessionSource, modelId || undefined, effort)
      if (r.code === 'USER_ABORTED') showToast({ type: 'info', message: '已停止 · 可继续' })
      else if (!r.ok) {
        const again = r.interruption?.resumable === true ? ' · 可再点一次「继续」' : ''
        showToast({ type: 'error', message: `继续失败：${r.error ?? '未知错误'}${again}` })
      } else if (r.changes && r.changes.length > 0) setLastChanges(r.changes)
      await refreshMessages(sid)
    } catch (err) {
      // G8：主进程侧异常逃逸时此前完全静默（卡片消失 + 零 Toast + 零记录）
      console.error('[assistant] resume 未捕获异常', err)
      showToast({ type: 'error', message: `继续异常：${String((err as Error)?.message ?? err)}` })
      await refreshMessages(sid).catch(() => { /* 刷新失败不掩盖原始异常 */ })
    } finally {
      endRun(sid)
      // 现场写回会话行（成功即已清空）→ 重拉列表才能让「继续」正确消失/出现
      void refreshSessions()
      void refreshPlan()
      void refreshUsage()
    }
  }, [contextRemoved, flushScope, modelId, refreshMessages, refreshSessions, refreshPlan, refreshUsage, resolveCtx, sessionSource, effort, unified, scopeAll, unifiedContextOf])

  /** 改写用户消息并重推其后回复 */
  const editSubmit = useCallback(async (messageId: string, content: string) => {
    flushScope()
    const sid = activeIdRef.current
    if (!sid || isSessionRunning(sid)) return
    if (runningSessionCount() >= MAX_PARALLEL) {
      showToast({ type: 'info', message: `已有 ${MAX_PARALLEL} 个对话在运行，请等一个完成再试` })
      return
    }
    setEditing(null)
    beginRun(sid)
    setLastChanges(null)
    const cid = crypto.randomUUID()
    try {
      const baseCtx = (unified && !scopeAll) || contextRemoved ? null : resolveCtx()
      const r = await agentEditMessage(sid, messageId, content, unifiedContextOf(baseCtx), cid, effort)
      if (r.code === 'USER_ABORTED') showToast({ type: 'info', message: '已停止生成 · 可点「继续」接着做' })
      else if (!r.ok) {
        const again = r.interruption?.resumable === true ? ' · 可点「继续」接着做' : ''
        showToast({ type: 'error', message: `修改失败：${r.error ?? '未知错误'}${again}` })
      }
      else if (r.changes && r.changes.length > 0) setLastChanges(r.changes)
      await refreshMessages(sid)
    } catch (err) {
      // G8：主进程侧异常逃逸时此前完全静默（卡片消失 + 零 Toast + 零记录）
      console.error('[assistant] editSubmit 未捕获异常', err)
      showToast({ type: 'error', message: `修改异常：${String((err as Error)?.message ?? err)}` })
      await refreshMessages(sid).catch(() => { /* 刷新失败不掩盖原始异常 */ })
    } finally {
      endRun(sid)
      void refreshSessions()
      void refreshPlan()
      void refreshUsage()
    }
  }, [flushScope, refreshMessages, refreshSessions, refreshPlan, refreshUsage, effort, contextRemoved, resolveCtx, unified, scopeAll, unifiedContextOf])

  /** 删除单条消息（助手消息删除后可用「重新生成」补回） */
  const deleteMessage = useCallback(async (messageId: string) => {
    const sid = activeIdRef.current
    if (!sid) return
    await agentDeleteMessage(sid, messageId)
    await refreshMessages(sid)
  }, [refreshMessages])

  /**
   * 停止当前会话的运行（N-3：按会话中止 —— 该会话全部在跑调用一并停，别的会话不受影响）。
   * 确认模式：停止同时丢弃未应用方案；直接模式：只中断，不自动回滚。
   */
  const abort = useCallback(async () => {
    const sid = activeIdRef.current
    if (!sid) return
    await agentAbortSession(sid)
    if (unified && writeMode === 'confirm') {
      try { await aiAssistantPlanReject(sid) } catch { /* 无方案可丢弃 */ }
      await refreshPlan()
    }
  }, [unified, writeMode, refreshPlan])

  const applyPlanAction = useCallback(async (ids: string[]) => {
    const sid = activeIdRef.current ?? plan?.sessionId ?? null
    if (!sid) return
    try {
      const r = await aiAssistantPlanApply(sid, ids)
      showToast({ type: 'success', message: `已应用 ${r.applied} 项变更` })
      await refreshPlan()
    } catch (e) {
      showToast({ type: 'error', message: '应用变更失败', detail: String(e) })
    }
  }, [plan, refreshPlan])

  const rejectPlanAction = useCallback(async () => {
    const sid = activeIdRef.current ?? plan?.sessionId ?? null
    if (!sid) return
    try { await aiAssistantPlanReject(sid); await refreshPlan() } catch (e) {
      showToast({ type: 'error', message: '丢弃失败', detail: String(e) })
    }
  }, [plan, refreshPlan])

  const rollbackTaskAction = useCallback(async () => {
    const sid = activeIdRef.current ?? plan?.sessionId ?? null
    if (!sid) return
    try {
      const r = await aiAssistantTaskRollback(sid)
      const skipped = r.skipped ?? 0
      showToast({
        type: skipped > 0 ? 'info' : 'success',
        message: skipped > 0
          ? `文件已回滚 ${r.reverted} 项；${skipped} 项模块写入需手动撤销`
          : `已回滚 ${r.reverted} 项变更`,
      })
      await refreshPlan()
    } catch (e) {
      showToast({ type: 'error', message: '回滚失败', detail: String(e) })
    }
  }, [plan, refreshPlan])

  const runStateOf = useCallback((sid: string) => runMarkOf(sid), [])
  const runMark = activeId ? runStateOf(activeId) : null
  const pendingCount = plan?.ops.filter(o => o.status === 'pending').length ?? 0
  const appliedCount = plan?.ops.filter(o => o.status === 'applied').length ?? 0

  return {
    sessions,
    providersOk,
    activeId,
    active: activeSession,
    messages,
    input,
    setInput,
    inputRef,
    pending,
    liveSteps,
    draft,
    runStateOf,
    lastChanges,
    compressing,
    pickedSkill,
    setPickedSkill,
    slashSkills,
    editing,
    setEditing,
    copiedIdx,
    setCopiedIdx,
    deletingId,
    runMark,
    scope,
    scopeAll,
    setScope,
    setScopeAll,
    writeMode,
    setWriteMode,
    plan,
    pendingCount,
    appliedCount,
    refreshPlan,
    applyPlan: applyPlanAction,
    rejectPlan: rejectPlanAction,
    rollbackTask: rollbackTaskAction,
    usage,
    drawerMounted,
    drawerOpen,
    toggleDrawer,
    closeDrawer,
    send,
    newSession,
    loadSession,
    setActiveId: selectSession,
    removeSession,
    deleteSessionNow,
    renameSession,
    togglePin,
    regenerate,
    resume,
    resumeInfo,
    editSubmit,
    deleteMessage,
    abort,
    dismissChanges: () => setLastChanges(null),
    refreshSessions,
    modelId,
    setModelId,
    thinking,
    setThinking,
    effort,
    setEffort,
    attachedFiles,
    setAttachedFiles,
    contextInfo,
    contextRemoved,
    dismissContext,
    restoreContext,
  }
}
