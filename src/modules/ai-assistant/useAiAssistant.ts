import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { AgentSessionInfo, AgentStoredMessage, AgentContextInfo, AgentTraceStep, AiChangePlan, ResumeInfo } from '../../types'
import { agentSessions, agentNewSession, agentDeleteSession, agentMessages, agentChat, agentAbortSession, agentUsageGet, agentRegenerate, agentResume, agentEditMessage, agentDeleteMessage, agentRenameSession, agentSetSessionScope, aiAssistantPlanGet, aiAssistantPlanApply, aiAssistantPlanReject, aiAssistantTaskRollback, llmListProviders } from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { beginRun, endRun, getRunBucket, isSessionRunning, markSessionViewed, unmarkSessionViewed, runMarkOf, subscribeAssistantRunState, takeEndedFor } from '../../lib/assistantRunStore'
import type { StreamDraft } from '../../lib/agentStreamCore'
import { type UiMessage } from '../../components/shared/AssistantPanel/MessageList'

/**
 * AI助手模块的会话/消息状态（v3.9.0）。
 *
 * 与 aiChat 的 `useAssistantChat` 分开：本 hook 只服务 source='aiAssistant' 的任务型会话，
 * 不做 @引用 / 附件 / 技能选择 —— 那些是对话式助手的能力。会话列表按 source 过滤，
 * 与 aiChat 在存储与列表两侧都不混。
 *
 * 但**消息渲染与运行态复用共享资产**（外观对齐决策，2026-10-16）：
 * - 消息渲染走共享 `MessageList`（AI 去气泡 + 工具摘要 + 用户带尾角气泡）；
 * - 流式草稿 / 实时步骤 / 运行角标走 `assistantRunStore`（按 sessionId 分桶的单例，与 aiChat 不冲突）；
 * - 变更方案（ChangePlan）也在此 hook 收口：getPlan / apply / reject / rollback。
 */

/** 思考强度档位（与 AI 教学同口径） */
export type Effort = 'off' | 'low' | 'medium' | 'high'

/** 落库消息 → UI 消息（traceJson 容错解析，供 MessageList 的工具摘要/token 行） */
function toUi(m: AgentStoredMessage): UiMessage {
  let trace: AgentTraceStep[] | undefined
  if (m.traceJson) { try { trace = JSON.parse(m.traceJson) as AgentTraceStep[] } catch { trace = undefined } }
  return { id: m.id, role: m.role, content: m.content, createdAt: m.createdAt, trace }
}

export interface AiAssistantApi {
  sessions: AgentSessionInfo[]
  activeId: string | null
  active: AgentSessionInfo | null
  messages: UiMessage[]
  /** 当前任务是否在跑（共享运行态 store） */
  pending: boolean
  /** 流式过程草稿 + 实时步骤（共享运行态 store；切走会话不丢） */
  draft: StreamDraft | null
  liveSteps: AgentTraceStep[]
  /** 任务列表运行角标（running / failed / unread） */
  runMark: 'running' | 'failed' | 'unread' | null
  plan: AiChangePlan | null
  pendingCount: number
  appliedCount: number
  /** 本任务累计消耗（跨日聚合 sessionId 分桶） */
  usage: { in: number; out: number }
  /** 本任务模型（'' = 跟随设置默认）与思考强度 */
  modelId: string
  effort: Effort
  setModelId: (v: string) => void
  setEffort: (v: Effort) => void
  editing: { id: string; draft: string } | null
  setEditing: Dispatch<SetStateAction<{ id: string; draft: string } | null>>
  copiedIdx: number | null
  setCopiedIdx: Dispatch<SetStateAction<number | null>>
  resumeInfo: ResumeInfo | null
  /** 任务级作用域（随会话走：切会话载入、改动防抖持久化到会话行） */
  scope: string[]
  setScope: (next: string[]) => void
  setActiveId: (id: string | null) => void
  newSession: () => Promise<AgentSessionInfo | null>
  deleteSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  send: (message: string) => Promise<void>
  stop: () => Promise<void>
  reloadSessions: () => Promise<void>
  refreshPlan: () => Promise<void>
  applyAccepted: (ids: string[]) => Promise<void>
  rejectPlan: () => Promise<void>
  rollbackTask: () => Promise<void>
  onEditSubmit: (id: string, content: string) => Promise<void>
  onRegenerate: () => Promise<void>
  onDeleteMessage: (id: string) => Promise<void>
  onResume: () => Promise<void>
}

export function useAiAssistant(isActive: boolean): AiAssistantApi {
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([])
  const [activeId, setActiveIdState] = useState<string | null>(null)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [plan, setPlan] = useState<AiChangePlan | null>(null)
  const [usage, setUsage] = useState<{ in: number; out: number }>({ in: 0, out: 0 })
  const [modelId, setModelId] = useState('')
  const [effort, setEffort] = useState<Effort>('off')
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  /** 任务级作用域（随会话走；新建但未落库前是「草稿」，首次发送时写进会话） */
  const [scope, setScopeState] = useState<string[]>([])
  const scopeRef = useRef<string[]>([])
  const sessionsRef = useRef<AgentSessionInfo[]>([])
  /**
   * 作用域落库防抖 + **每个会话的最新值缓存**。
   *
   * 缓存是必需的：防抖窗口内切走再切回，`sessions` 里那一行还是旧值，
   * 只读会话行会让用户「刚勾的全没了」（改动其实 400ms 后照样落库，只是界面骗人）。
   * 切会话先 `flushScope()` 落上一个、再从缓存取下一个，读写两侧都不靠窗口期。
   */
  const scopeCache = useRef<Map<string, string[]>>(new Map())
  /** 落库在途的作用域写入（id → Promise）；在途期间 reload 不回填该会话缓存 */
  const scopeInflight = useRef<Map<string, Promise<unknown>>>(new Map())
  const scopeTimer = useRef<number | null>(null)
  /** 防抖计时器归属的会话 id（`null` = 没有待落库改动） */
  const scopeTimerId = useRef<string | null>(null)
  /** 运行态版本号：store notify 时自增以触发重渲染 */
  const [, setRunVersion] = useState(0)
  const busyRef = useRef(false)
  const activeIdRef = useRef<string | null>(null)
  useEffect(() => { activeIdRef.current = activeId }, [activeId])
  useEffect(() => { sessionsRef.current = sessions }, [sessions])
  /** 默认模型（llmListProviders 返回的 defaultChatModel），用于菜单显示「默认」 */
  const [, setDefaultModel] = useState('')

  useEffect(() => {
    void llmListProviders().then((r) => setDefaultModel(r.defaultChatModel ?? '')).catch(() => null)
  }, [])

  const reloadSessions = useCallback(async () => {
    try {
      const all = await agentSessions()
      const mine = all.filter((s) => s.source === 'aiAssistant')
      setSessions(mine)
      // 会话行回填缓存；**带未落库 / 在途写入的会话跳过**（否则会把刚勾的范围打回旧值）
      for (const s of mine) {
        if (scopeTimerId.current === s.id || scopeInflight.current.has(s.id)) continue
        scopeCache.current.set(s.id, Array.isArray(s.scope) ? s.scope.slice() : [])
      }
    } catch { /* 仓库未打开等，忽略 */ }
  }, [])

  useEffect(() => { if (isActive) void reloadSessions() }, [isActive, reloadSessions])

  /** 立即写会话作用域（无防抖）；失败静默（下次勾选或发送会再写） */
  const persistScope = useCallback((id: string, next: string[]): void => {
    scopeCache.current.set(id, next.slice())
    const p = agentSetSessionScope(id, next).catch(() => { /* 静默 */ })
    // 记录在途写入：写还没落地时若来一次 reload，会把缓存打回旧值（切回该任务就显示错范围）。
    // 在途期间让 reloadSessions 跳过这个会话，落地后自然恢复回填。
    scopeInflight.current.set(id, p)
    void p.finally(() => { if (scopeInflight.current.get(id) === p) scopeInflight.current.delete(id) })
  }, [])

  /** 把防抖窗口里的改动立刻落库（切会话 / 新建会话前调用） */
  const flushScope = useCallback((): void => {
    const id = scopeTimerId.current
    if (!id) return
    if (scopeTimer.current) { window.clearTimeout(scopeTimer.current); scopeTimer.current = null }
    scopeTimerId.current = null
    // 缓存缺失就什么都不写：宁可漏这一次落库，也不能用空数组把会话已圈好的范围静默清掉
    const next = scopeCache.current.get(id)
    if (next) persistScope(id, next)
  }, [persistScope])

  /**
   * 改作用域：更新本地 + 防抖 400ms 落库到当前会话。
   *
   * **运行中拒绝改动**（2026-10-16 拍板）：本轮的工具调用已按运行开头的快照跑完
   * （`agentService.ts:1154` 取 `context.data.scope`），中途改勾选不会影响本轮 ——
   * 与其让用户以为「换了范围却不生效」，不如直接锁住，跑完再解禁（UI 侧同步置灰）。
   * 未落库的新任务（activeId=null）只留作草稿，首次发送时由 newSession 写进会话。
   */
  const setScope = useCallback((next: string[]) => {
    const id = activeIdRef.current
    if (id && isSessionRunning(id)) return
    const clean = Array.isArray(next) ? next.slice() : []
    setScopeState(clean)
    scopeRef.current = clean
    if (!id) return
    if (scopeTimerId.current && scopeTimerId.current !== id) flushScope()
    scopeCache.current.set(id, clean)
    if (scopeTimer.current) window.clearTimeout(scopeTimer.current)
    scopeTimerId.current = id
    scopeTimer.current = window.setTimeout(() => {
      scopeTimer.current = null
      scopeTimerId.current = null
      persistScope(id, clean)
    }, 400)
  }, [flushScope, persistScope])

  /** 切换任务：先把上一个任务的作用域落库，再连同消息 / 方案 / 用量一起切（scope 缓存优先，缺省空） */
  const setActiveId = useCallback((id: string | null) => {
    flushScope()
    setActiveIdState(id)
    activeIdRef.current = id
    const s = sessionsRef.current.find((x) => x.id === id)
    const sc = id
      ? (scopeCache.current.get(id) ?? (Array.isArray(s?.scope) ? s!.scope!.slice() : []))
      : []
    setScopeState(sc)
    scopeRef.current = sc
  }, [flushScope])

  const refreshMessages = useCallback(async (id: string | null) => {
    if (!id) { setMessages([]); return }
    try { setMessages((await agentMessages(id)).map(toUi)) } catch { setMessages([]) }
  }, [])

  useEffect(() => { void refreshMessages(activeId) }, [activeId, refreshMessages])

  const refreshPlan = useCallback(async () => {
    if (!activeId) { setPlan(null); return }
    try { setPlan(await aiAssistantPlanGet(activeId)) } catch { setPlan(null) }
  }, [activeId])

  useEffect(() => { void refreshPlan() }, [refreshPlan])

  const refreshUsage = useCallback(async () => {
    if (!activeId) { setUsage({ in: 0, out: 0 }); return }
    try {
      const { days } = await agentUsageGet()
      let tin = 0
      let tout = 0
      for (const d of Object.values(days)) {
        const b = d.sessions?.[activeId]
        if (b) { tin += b.in; tout += b.out }
      }
      setUsage({ in: tin, out: tout })
    } catch { /* 用量读取失败不影响主流程 */ }
  }, [activeId])

  useEffect(() => { void refreshUsage() }, [refreshUsage])

  // 共享运行态：草稿/步骤/角标 → 版本号 bump；结束事件 → 补拉消息与会话行（后台完成对齐）
  useEffect(() => subscribeAssistantRunState(() => {
    const sid = activeIdRef.current
    if (sid && takeEndedFor(sid)) {
      void refreshMessages(sid)
      void reloadSessions()
      void refreshPlan()
      void refreshUsage()
    }
    setRunVersion((v) => (v + 1) % 1_000_000)
  }), [refreshMessages, reloadSessions, refreshPlan, refreshUsage])

  // 查看登记（多宿主对称进出）：进入会话清角标，离开撤销
  useEffect(() => {
    if (!activeId) return
    markSessionViewed(activeId)
    return () => unmarkSessionViewed(activeId)
  }, [activeId])

  const active = sessions.find((s) => s.id === activeId) ?? null
  const pending = isSessionRunning(activeId)
  const bucket = getRunBucket(activeId)
  const draft = bucket?.draft ?? null
  const liveSteps = bucket?.liveSteps ?? []
  const runMark = activeId ? runMarkOf(activeId) : null
  const resumeInfo = active?.resumeInfo ?? null

  const newSession = useCallback(async (): Promise<AgentSessionInfo | null> => {
    try {
      const s = await agentNewSession('新任务', 'aiAssistant')
      await reloadSessions()
      setActiveIdState(s.id)
      activeIdRef.current = s.id
      // 保留发送前圈好的「草稿」作用域：新建即写进这个会话（不重置用户已选的范围）
      scopeCache.current.set(s.id, scopeRef.current.slice())
      if (scopeRef.current.length) persistScope(s.id, scopeRef.current)
      return s
    } catch (e) {
      showToast({ type: 'error', message: '新建任务失败', detail: String(e) })
      return null
    }
  }, [reloadSessions, persistScope])

  const deleteSession = useCallback(async (id: string) => {
    try {
      await agentDeleteSession(id)
      scopeCache.current.delete(id)
      if (activeId === id) setActiveId(null)
      await reloadSessions()
    } catch (e) {
      showToast({ type: 'error', message: '删除任务失败', detail: String(e) })
    }
  }, [activeId, reloadSessions, setActiveId])

  /** 重命名任务（乐观更新 + 落库；失败时由随后的 reload 拉回真值，不静默骗人） */
  const renameSession = useCallback(async (id: string, title: string) => {
    const t = title.trim().slice(0, 40)
    if (!t) return
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: t } : s)))
    try {
      await agentRenameSession(id, t)
    } catch { /* 静默：下面的 reload 会把标题拉回服务端真值 */ }
    await reloadSessions()
  }, [reloadSessions])

  /** 收尾：刷新消息/会话/方案/用量（发送与各动作共用） */
  const settle = useCallback(async (sid: string) => {
    await refreshMessages(sid)
    await reloadSessions()
    await refreshPlan()
    await refreshUsage()
  }, [refreshMessages, reloadSessions, refreshPlan, refreshUsage])

  /** 任务上下文（作用域取当前任务的实时值；运行开头被主进程快照，故运行中改勾选不影响本轮） */
  const ctxOf = useCallback((): AgentContextInfo => ({ type: 'aiAssistant', label: 'AI助手', data: { scope: scopeRef.current } }), [])

  const send = useCallback(async (message: string) => {
    const text = message.trim()
    if (!text || busyRef.current) return
    let id = activeIdRef.current
    if (!id) {
      const s = await newSession()
      if (!s) return
      id = s.id
    }
    busyRef.current = true
    beginRun(id)
    // 乐观显示用户消息
    setMessages((prev) => [...prev, { id: `local-${Date.now()}`, role: 'user', content: text, createdAt: new Date().toISOString() }])
    try {
      const res = await agentChat(id, text, ctxOf(), undefined, 'aiAssistant', modelId || undefined, effort === 'off' ? undefined : effort)
      if (!res.ok && res.error) showToast({ type: 'error', message: '任务失败', detail: res.error })
    } catch (e) {
      showToast({ type: 'error', message: '任务失败', detail: String(e) })
    } finally {
      busyRef.current = false
      endRun(id)
      await settle(id)
    }
  }, [newSession, modelId, effort, ctxOf, settle])

  const onRegenerate = useCallback(async () => {
    if (!activeId || busyRef.current) return
    busyRef.current = true
    beginRun(activeId)
    try {
      const res = await agentRegenerate(activeId, ctxOf(), undefined, effort === 'off' ? undefined : effort)
      if (!res.ok && res.error) showToast({ type: 'error', message: '重新生成失败', detail: res.error })
    } catch (e) {
      showToast({ type: 'error', message: '重新生成失败', detail: String(e) })
    } finally {
      busyRef.current = false
      endRun(activeId)
      await settle(activeId)
    }
  }, [activeId, effort, ctxOf, settle])

  const onEditSubmit = useCallback(async (id: string, content: string) => {
    if (!activeId || busyRef.current || !content.trim()) return
    busyRef.current = true
    setEditing(null)
    beginRun(activeId)
    try {
      const res = await agentEditMessage(activeId, id, content.trim(), ctxOf(), undefined, effort === 'off' ? undefined : effort)
      if (!res.ok && res.error) showToast({ type: 'error', message: '重新生成失败', detail: res.error })
    } catch (e) {
      showToast({ type: 'error', message: '重新生成失败', detail: String(e) })
    } finally {
      busyRef.current = false
      endRun(activeId)
      await settle(activeId)
    }
  }, [activeId, effort, ctxOf, settle])

  const onDeleteMessage = useCallback(async (id: string) => {
    if (!activeId || busyRef.current) return
    try {
      await agentDeleteMessage(activeId, id)
      await refreshMessages(activeId)
    } catch (e) {
      showToast({ type: 'error', message: '删除失败', detail: String(e) })
    }
  }, [activeId, refreshMessages])

  /** 继续被中断的任务（作用域取本会话当前值，由 ctxOf 从 scopeRef 读；调用方不再传参） */
  const onResume = useCallback(async () => {
    if (!activeId || busyRef.current) return
    busyRef.current = true
    beginRun(activeId)
    try {
      const res = await agentResume(activeId, ctxOf(), undefined, 'aiAssistant', modelId || undefined, effort === 'off' ? undefined : effort)
      if (!res.ok && res.error) showToast({ type: 'error', message: '继续失败', detail: res.error })
    } catch (e) {
      showToast({ type: 'error', message: '继续失败', detail: String(e) })
    } finally {
      busyRef.current = false
      endRun(activeId)
      await settle(activeId)
    }
  }, [activeId, modelId, effort, ctxOf, settle])

  const stop = useCallback(async () => {
    if (!activeId) return
    try { await agentAbortSession(activeId) } catch { /* ignore */ }
    // 设计（§3.3）：Stop = 回滚整任务 —— 撤销本次已应用的改动（未应用的暂存方案一并作废）
    try {
      const r = await aiAssistantTaskRollback(activeId)
      if (r.reverted > 0) showToast({ type: 'info', message: `已停止并回滚 ${r.reverted} 项改动` })
    } catch { /* 无方案可回滚，忽略 */ }
    await refreshPlan()
    await refreshUsage()
  }, [activeId, refreshPlan, refreshUsage])

  const applyAccepted = useCallback(async (ids: string[]) => {
    if (!activeId) return
    try {
      const r = await aiAssistantPlanApply(activeId, ids)
      showToast({ type: 'success', message: `已应用 ${r.applied} 项变更` })
      await refreshPlan()
    } catch (e) {
      showToast({ type: 'error', message: '应用变更失败', detail: String(e) })
    }
  }, [activeId, refreshPlan])

  const rejectPlanAction = useCallback(async () => {
    if (!activeId) return
    try { await aiAssistantPlanReject(activeId); await refreshPlan() } catch (e) {
      showToast({ type: 'error', message: '丢弃失败', detail: String(e) })
    }
  }, [activeId, refreshPlan])

  const rollbackTaskAction = useCallback(async () => {
    if (!activeId) return
    try {
      const r = await aiAssistantTaskRollback(activeId)
      showToast({ type: 'success', message: `已回滚 ${r.reverted} 项变更` })
      await refreshPlan()
    } catch (e) {
      showToast({ type: 'error', message: '回滚失败', detail: String(e) })
    }
  }, [activeId, refreshPlan])

  const pendingCount = plan?.ops.filter((o) => o.status === 'pending').length ?? 0
  const appliedCount = plan?.ops.filter((o) => o.status === 'applied').length ?? 0

  return {
    sessions, activeId, active, messages, pending, draft, liveSteps, runMark, plan, pendingCount, appliedCount,
    usage, modelId, effort, setModelId, setEffort, editing, setEditing, copiedIdx, setCopiedIdx, resumeInfo,
    scope, setScope,
    setActiveId, newSession, deleteSession, renameSession, send, stop, reloadSessions,
    refreshPlan, applyAccepted, rejectPlan: rejectPlanAction, rollbackTask: rollbackTaskAction,
    onEditSubmit, onRegenerate, onDeleteMessage, onResume,
  }
}
