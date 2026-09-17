import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { showToast } from '../../../lib/toast'
import { handleChatCommand } from '../../../lib/chatCommands'
import { getAssistantContext } from '../../../lib/assistantContext'
import { useSettings } from '../../../lib/SettingsContext'
import {
  agentSessions, agentNewSession, agentMessages, agentDeleteSession,
  agentChat, agentRegenerate, agentEditMessage, agentDeleteMessage,
  llmListProviders, agentAbort, aiToolsListSkills,
} from '../../../lib/ipc'
import type { AgentSessionInfo, AgentStoredMessage, AgentTraceStep, AgentContextInfo, AgentChange, SkillInfo } from '../../../types'
import { useAgentStream } from './useAgentStream'
import type { UiMessage } from './MessageList'

/**
 * AI 助手会话控制器（v3.4.0 批次5）：会话/流式/发送/编辑/删除全部内聚的 headless hook。
 *
 * 三处宿主共用（方案 workbench-shell-design §4「会话基建复用，不重造对话 UI」）：
 * - 悬浮侧栏（AssistantPanel，Ctrl+J）
 * - 工作台右栏 AI 态窄版（ChatBody docked + ⤢）
 * - aiChat 中间标签宽版（ChatBody page）
 *
 * 会话数据真源在主进程（agentSessions/agentMessages），多实例各自拉取；发送后以
 * refreshMessages 按会话库对齐，切换宿主不丢历史。宿主特有行为通过 options 注入：
 * 上下文优先级链、发送前正文预处理（划词引用）、chatCommand surface。
 */

export interface AssistantChatOptions {
  /** 宿主是否可见：可见时刷新供应商检查 / Skill 候选 / 会话列表 */
  active: boolean
  /** 发送时的上下文解析（缺省 = 当前界面 getAssistantContext） */
  resolveContext?: () => AgentContextInfo | null
  /** / 指令的执行面（悬浮版随全屏态切换；其余宿主固定 assistant） */
  surfaceOf?: () => 'assistant' | 'aiLearn'
  /** 发送前正文预处理（悬浮版并入划词引用块并清空；返回处理后正文） */
  prepareBody?: (body: string) => string
}

/** 对话 UI（ChatBody / 全屏学堂 bridge）消费的控制器面 */
export interface AssistantChatController {
  sessions: AgentSessionInfo[]
  providersOk: boolean | null
  activeId: string | null
  messages: UiMessage[]
  input: string
  setInput: (v: string) => void
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  pending: boolean
  liveSteps: AgentTraceStep[]
  draft: ReturnType<typeof useAgentStream>['draft']
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
  drawerMounted: boolean
  drawerOpen: boolean
  toggleDrawer: () => void
  closeDrawer: () => void
  send: (override?: string) => Promise<void>
  newSession: () => Promise<void>
  loadSession: (id: string) => Promise<void>
  removeSession: (id: string) => Promise<void>
  regenerate: () => Promise<void>
  editSubmit: (id: string, content: string) => Promise<void>
  deleteMessage: (id: string) => Promise<void>
  abort: () => Promise<void>
  dismissChanges: () => void
  /** 主动刷新会话列表（宿主切换等场景） */
  refreshSessions: () => Promise<void>
  /** 对话模型（providerId:modelId 串；空 = 全局默认）——settings 持久化 */
  modelId: string
  setModelId: (v: string) => void
  /** 📎 附加文件（随消息上下文；发送后不清空，× 移除） */
  attachedFiles: Array<{ pageId: string; title: string; path: string }>
  setAttachedFiles: Dispatch<SetStateAction<Array<{ pageId: string; title: string; path: string }>>>
}

function nowLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
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

export function useAssistantChat(options: AssistantChatOptions): AssistantChatController {
  const { active } = options
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([])
  const [providersOk, setProvidersOk] = useState<boolean | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  // / 弹层（指令 + 已装 Skill）与 Skill 显式调用 chip、压缩进行时占位
  const [slashSkills, setSlashSkills] = useState<SkillInfo[]>([])
  const [pickedSkill, setPickedSkill] = useState<SkillInfo | null>(null)
  const [compressing, setCompressing] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  /** 本次请求的真实改动清单（agentChat 返回 changes）→ 完成后卡片 */
  const [lastChanges, setLastChanges] = useState<AgentChange[] | null>(null)
  // 对话模型选择（settings 持久化；空串 = 全局默认模型）。agentChat 的 modelId 形参
  const { s: assistantSettings, update: updateAssistantSetting } = useSettings()
  const modelId = typeof assistantSettings.assistantModelId === 'string' ? assistantSettings.assistantModelId : ''
  const setModelId = useCallback((v: string) => { updateAssistantSetting('assistantModelId', v) }, [updateAssistantSetting])
  /** 附加文件（输入区 📎 添加，随消息作为上下文；正文不注入，模型按 path 用文件读取工具自取） */
  const [attachedFiles, setAttachedFiles] = useState<Array<{ pageId: string; title: string; path: string }>>([])
  // 会话抽屉动画三态（Tailwind v4 translate 过渡的 transitionend 不可依赖，定时器兜底卸载）
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerMounted, setDrawerMounted] = useState(false)
  const drawerTimerRef = useRef<number | null>(null)
  const chatIdRef = useRef<string>('')
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  /** 当前会话 id 的实时镜像：回复返回时判断用户是否已切换会话 */
  const activeIdRef = useRef<string | null>(null)
  useEffect(() => { activeIdRef.current = activeId }, [activeId])
  const { draft, liveSteps, begin: beginStream, end: endStream } = useAgentStream(chatIdRef)

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

  const refreshSessions = useCallback(async () => {
    try {
      // 只列「通用助手」来源：AI 教学有自己的会话列表（同表存储，按 source 分流）
      setSessions((await agentSessions()).filter(x => x.source !== 'aiTeaching'))
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { if (active) void refreshSessions() }, [active, refreshSessions])

  /** 以会话库为准刷新消息（发送/重新生成/编辑/删除后统一走这里，拿到落库 id 与 trace） */
  const refreshMessages = useCallback(async (sid: string) => {
    if (activeIdRef.current !== sid) return
    try {
      const rows: AgentStoredMessage[] = await agentMessages(sid)
      if (activeIdRef.current === sid) setMessages(rows.map(toUi))
    } catch { /* keep current */ }
  }, [])

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
    setActiveId(id)
    closeDrawer()
    try {
      const rows: AgentStoredMessage[] = await agentMessages(id)
      setMessages(rows.map(toUi))
    } catch { setMessages([]) }
  }, [closeDrawer])

  const newSession = useCallback(async () => {
    const sRow = await agentNewSession().catch(() => null)
    if (!sRow) return
    setSessions(prev => [sRow, ...prev])
    setActiveId(sRow.id)
    setMessages([])
    closeDrawer()
  }, [closeDrawer])

  const removeSession = useCallback(async (id: string) => {
    if (deletingId !== id) {
      setDeletingId(id)
      setTimeout(() => setDeletingId(cur => (cur === id ? null : cur)), 3000)
      return
    }
    setDeletingId(null)
    await agentDeleteSession(id)
    setSessions(prev => prev.filter(x => x.id !== id))
    if (activeIdRef.current === id) { setActiveId(null); setMessages([]) }
  }, [deletingId])

  const send = useCallback(async (override?: string) => {
    const raw = (override ?? input).trim()
    // 宿主预处理（悬浮版：划词引用块并入正文并清空——body 为空但仍有引用时返回纯引用正文；
    // 其他宿主原样返回 raw）。返回空串 = 无可发送内容，取消本次发送
    const body = options.prepareBody ? options.prepareBody(raw) : raw
    if (!body) return
    // 排队请求不静默丢弃：明确告知正在回复中（可点停止）
    if (pending) {
      showToast({ type: 'info', message: '正在回复上一条消息，请等待完成或点击「停止」' })
      return
    }
    // 斜杠指令（/compress 等）：命中即拦截执行，不进对话（置于 pending 检查后，避免生成中并发压缩）
    if (body.startsWith('/')) {
      if (await handleChatCommand(body, {
        sessionId: activeIdRef.current ?? '',
        surface: options.surfaceOf ? options.surfaceOf() : 'assistant',
        onProgress: p => setCompressing(p.active),
      })) {
        if (!override) setInput('')
        return
      }
    }
    let sid = activeIdRef.current
    if (!sid) {
      const sRow = await agentNewSession().catch(() => null)
      if (!sRow) return
      sid = sRow.id
      setActiveId(sid)
    }
    const ctx = options.resolveContext ? options.resolveContext() : getAssistantContext()
    // 附加文件（📎）合成进上下文：正文不注入，模型需要内容时用文件读取工具按 path 自取
    let finalCtx: AgentContextInfo | null = ctx
    if (attachedFiles.length > 0) {
      finalCtx = {
        type: 'attachedFiles',
        label: (ctx ? ctx.label + ' + ' : '') + `附加 ${attachedFiles.length} 个文件`,
        data: {
          ...(ctx?.data ?? {}),
          attachedFiles: attachedFiles.map(f => ({ title: f.title, path: f.path })),
          附加上下文说明: '用户为本轮对话附加了以上知识库文件作为上下文；文件正文未注入，需要内容时用文件读取工具按 path 读取。',
        },
      }
    }
    setMessages(prev => [...prev, { role: 'user', content: body, createdAt: nowLocal() }])
    setInput('')
    setPending(true)
    beginStream()
    setLastChanges(null)
    const cid = crypto.randomUUID()
    chatIdRef.current = cid
    try {
      // Skill chip 随消息一次性消费，发出即清
      const sk = pickedSkill
      setPickedSkill(null)
      const r = await agentChat(sid, body, finalCtx ?? undefined, cid, undefined, modelId || undefined, undefined, sk?.registryName)
      // 自动压缩告知（会话压缩 §6.1）：主进程发送前折叠旧轮为纪要，用户应知道上下文变了
      if (r.ok && r.compressed) showToast({ type: 'info', message: `上下文已自动压缩 ${r.compressed.covered} 条历史 → 纪要` })
      // 用户在等待期间切换了会话：回复已落库，但不注入当前视图
      if (activeIdRef.current !== sid) {
        showToast({ type: 'info', message: '回复已保存到原会话，可在会话列表中查看' })
        return
      }
      if (r.ok && r.reply !== undefined) {
        if (r.changes && r.changes.length > 0) setLastChanges(r.changes)
      } else if (r.code === 'ABORTED') {
        showToast({ type: 'info', message: '已停止生成' })
      } else {
        showToast({ type: 'error', message: `AI 调用失败：${r.error ?? '未知错误'}` })
      }
      // 以会话库为准刷新（拿到落库 id/trace；中止时仅剩用户消息也保持一致）
      await refreshMessages(sid)
    } finally {
      endStream()
      setPending(false)
      void refreshSessions()
    }
  }, [input, pending, pickedSkill, refreshMessages, refreshSessions, beginStream, endStream, options, attachedFiles, modelId])

  /** 重新生成最后一条回复（末条为助手消息时可用） */
  const regenerate = useCallback(async () => {
    const sid = activeIdRef.current
    if (!sid || pending) return
    if (messages.length === 0 || messages[messages.length - 1].role !== 'assistant') return
    setPending(true)
    beginStream()
    setLastChanges(null)
    const cid = crypto.randomUUID()
    chatIdRef.current = cid
    try {
      const r = await agentRegenerate(sid, getAssistantContext() ?? undefined, cid)
      if (r.code === 'ABORTED') showToast({ type: 'info', message: '已停止生成' })
      else if (!r.ok) showToast({ type: 'error', message: `重新生成失败：${r.error ?? '未知错误'}` })
      else if (r.changes && r.changes.length > 0) setLastChanges(r.changes)
      await refreshMessages(sid)
    } finally {
      endStream()
      setPending(false)
      void refreshSessions()
    }
  }, [pending, messages, refreshMessages, refreshSessions, beginStream, endStream])

  /** 改写用户消息并重推其后回复 */
  const editSubmit = useCallback(async (messageId: string, content: string) => {
    const sid = activeIdRef.current
    if (!sid || pending) return
    setEditing(null)
    setPending(true)
    beginStream()
    setLastChanges(null)
    const cid = crypto.randomUUID()
    chatIdRef.current = cid
    try {
      const r = await agentEditMessage(sid, messageId, content, getAssistantContext() ?? undefined, cid)
      if (r.code === 'ABORTED') showToast({ type: 'info', message: '已停止生成' })
      else if (!r.ok) showToast({ type: 'error', message: `修改失败：${r.error ?? '未知错误'}` })
      else if (r.changes && r.changes.length > 0) setLastChanges(r.changes)
      await refreshMessages(sid)
    } finally {
      endStream()
      setPending(false)
      void refreshSessions()
    }
  }, [pending, refreshMessages, refreshSessions, beginStream, endStream])

  /** 删除单条消息（助手消息删除后可用「重新生成」补回） */
  const deleteMessage = useCallback(async (messageId: string) => {
    const sid = activeIdRef.current
    if (!sid) return
    await agentDeleteMessage(sid, messageId)
    await refreshMessages(sid)
  }, [refreshMessages])

  const abort = useCallback(async () => {
    await agentAbort(chatIdRef.current)
  }, [])

  return {
    sessions,
    providersOk,
    activeId,
    messages,
    input,
    setInput,
    inputRef,
    pending,
    liveSteps,
    draft,
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
    drawerMounted,
    drawerOpen,
    toggleDrawer,
    closeDrawer,
    send,
    newSession,
    loadSession,
    removeSession,
    regenerate,
    editSubmit,
    deleteMessage,
    abort,
    dismissChanges: () => setLastChanges(null),
    refreshSessions,
    modelId,
    setModelId,
    attachedFiles,
    setAttachedFiles,
  }
}
