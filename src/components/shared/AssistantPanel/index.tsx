import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  Sparkles, X, Menu, Plus, Trash2, Wrench, FileText, Check, ArrowUpRight, Maximize2,
  Languages, Loader2, Bot, Quote,
} from 'lucide-react'
import { AiLearnShell, type AiLearnTab, type ChatBridge } from '../AiLearn'
import { useLearnProgress, learnStepContext } from '../AiLearn/useLearnProgress'
import { getLesson } from '../AiLearn/lessons'
import { useSettings } from '../../../lib/SettingsContext'
import { getAssistantContext, getSelectionAskHost } from '../../../lib/assistantContext'
import { showToast } from '../../../lib/toast'
import { handleChatCommand } from '../../../lib/chatCommands'
import { SlashCommandMenu, buildSlashItems, filterSlashItems, type SlashMenuItem } from '../SlashCommandMenu'
import { TranslateCard } from '../TranslateCard'
import { MessageList, fmtTime, type UiMessage } from './MessageList'
import { useAgentStream } from './useAgentStream'
import {
  agentSessions, agentNewSession, agentMessages, agentDeleteSession,
  agentChat, agentRegenerate, agentEditMessage, agentDeleteMessage,
  llmListProviders, agentAbort, aiToolsListSkills,
} from '../../../lib/ipc'
import type { AgentSessionInfo, AgentStoredMessage, AgentTraceStep, AgentContextInfo, AgentChange, TabName, SkillInfo } from '../../../types'

/**
 * 全局 AI 助手侧栏（方案 B）：任意界面 Ctrl+J / 右下角按钮唤起，
 * 会话留存 + 上下文感知（正在查看的知识库页面自动附带）。
 * 拖拽左缘调宽；拖到 320px 以下松手 = 整体关闭（snap），不会误触下层模块侧栏。
 *
 * 也可原地扩张为全屏「AI 学堂」（Ctrl+Shift+J / 头部 ⊞），会话与侧栏共用同一份。
 * 消息渲染抽在 ./MessageList.tsx，侧栏与学堂全屏对话共用，避免两套逻辑分叉。
 */

/** 选区矩形（viewport 坐标），供翻译卡片智能定位 */
interface SelRect { left: number; top: number; right: number; bottom: number }

/** 扩张/回缩动画总时长：宽度 320ms 与最晚一栏（delay 140 + 180ms）取齐，再留余量。
 *  动画结束靠定时器兜底而非 transitionend（见 state 声明处注释）。 */
const EXPAND_MS = 420
/** 扩张动画缓动（与 AiLearn 内三栏淡入保持一致） */
const EASE_EXPAND = 'cubic-bezier(.22,.68,.32,1)'

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

/**
 * @param shellLeft 全屏扩张时左侧需避让的宽度（活动栏占位，由 App 透传）。
 *   禅模式 Z2+ 活动栏不渲染 → 0；最大化 → 56；否则 56 + mx-1.5 两侧留白 = 68。
 */
export function AssistantPanel({ shellLeft = 68 }: { shellLeft?: number }) {
  const { s, update } = useSettings()
  /** 上手路径进度（settings 落盘）；全屏学堂与提问上下文共用 */
  const learn = useLearnProgress()
  const [open, setOpen] = useState(false)
  // 动画三态: mounted=DOM 存在(含退场动画期间), shown=滑入到位
  const [mounted, setMounted] = useState(false)
  const [shown, setShown] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // 抽屉动画三态
  const [drawerMounted, setDrawerMounted] = useState(false)
  const [drawerShown, setDrawerShown] = useState(false)
  /** 全屏 AI 学堂（P0）：full=容器已扩张；fullMounted=全屏层已挂载；fullShown=阶梯淡入已触发；
   *  animating=扩张/回缩动画进行中（屏蔽点击 + contain 隔离），结束由定时器兜底（不可依赖 transitionend，
   *  Tailwind v4 下过渡属性名可能是 width/translate，历史上已踩过事件不触发的坑） */
  const [full, setFull] = useState(false)
  const [fullTab, setFullTab] = useState<AiLearnTab>('learn')
  const [fullMounted, setFullMounted] = useState(false)
  const [fullShown, setFullShown] = useState(false)
  const [animating, setAnimating] = useState(false)
  const animTimerRef = useRef<number | null>(null)
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([])
  const [providersOk, setProvidersOk] = useState<boolean | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  // v3.1.1 条目10：/ 弹层（指令 + 已装 Skill）与 Skill 显式调用 chip、压缩进行时占位
  const [slashSkills, setSlashSkills] = useState<SkillInfo[]>([])
  const [slashActive, setSlashActive] = useState(0)
  const [pickedSkill, setPickedSkill] = useState<SkillInfo | null>(null)
  const [compressing, setCompressing] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [dragW, setDragW] = useState<number | null>(null)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  /** 行内编辑用户消息：目标消息 id + 草稿 */
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null)
  /** 选中文本即问：浮动按钮状态与一次性选中上下文 */
  const [selFloat, setSelFloat] = useState<{ x: number; y: number; rect: SelRect; text: string } | null>(null)
  /** 划词引用（会话引用形式）：「问 AI」收进输入区上方引用胶囊（多条可累积），随消息以可见引用块发出 */
  const [selQuotes, setSelQuotes] = useState<string[]>([])
  const [selQuotesOpen, setSelQuotesOpen] = useState(false)
  const selQuotesRef = useRef<string[]>([])
  /** 划词翻译卡片（与「问 AI」浮钮共用选区检测） */
  const [transFloat, setTransFloat] = useState<{ rect: SelRect; text: string } | null>(null)
  /** 会话抽屉卸载兜底定时器（closeDrawer 240ms 后触发） */
  const drawerTimerRef = useRef<number | null>(null)
  const chatIdRef = useRef<string>('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const ctxVersionRef = useRef(0)
  /** 流式过程（思考链 / 工具时间线 / 正文增量）+ 步骤轨迹，仅当前 chatId 收流 */
  const { draft, liveSteps, begin: beginStream, end: endStream } = useAgentStream(chatIdRef)
  /** 本次请求的真实改动清单（agentChat 返回 changes）→ 完成后卡片 */
  const [lastChanges, setLastChanges] = useState<AgentChange[] | null>(null)
  /** 当前会话 id 的实时镜像：回复返回时判断用户是否已切换会话 */
  const activeIdRef = useRef<string | null>(null)
  useEffect(() => { activeIdRef.current = activeId }, [activeId])

  const savedWidth = Math.min(520, Math.max(320, Number(s.assistantWidth ?? 380)))
  // 拖拽中的实时宽度；低于 320 属于"拖拽关闭"区间，松手即关
  const width = dragW ?? savedWidth
  const snapClosing = dragW !== null && dragW < 320

  const openPanel = useCallback(() => {
    setMounted(true)
    setOpen(true)
    // 双 rAF 确保首帧以关闭位渲染, 再过渡到打开位
    requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)))
    setDrawerOpen(false); setDrawerMounted(false); setDrawerShown(false)
  }, [])

  // 卸载时清理抽屉定时器
  useEffect(() => {
    return () => {
      if (drawerTimerRef.current !== null) window.clearTimeout(drawerTimerRef.current)
    }
  }, [])

  const openDrawer = useCallback(() => {
    // 取消尚未触发的关闭卸载定时器，避免重开抽屉被旧定时器卸载
    if (drawerTimerRef.current !== null) {
      window.clearTimeout(drawerTimerRef.current)
      drawerTimerRef.current = null
    }
    setDrawerMounted(true)
    setDrawerOpen(true)
    requestAnimationFrame(() => requestAnimationFrame(() => setDrawerShown(true)))
  }, [])

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false)
    setDrawerShown(false) // 滑出动画后卸载 DOM
    // Tailwind v4 用 translate 属性过渡，transitionend 的 propertyName 是
    // 'translate' 而非 'transform'，依赖事件卸载会永久残留（透明遮罩挡住消息区
    // 导致滚轮/点击失效），改用定时器兜底卸载
    if (drawerTimerRef.current !== null) window.clearTimeout(drawerTimerRef.current)
    drawerTimerRef.current = window.setTimeout(() => {
      setDrawerMounted(false)
      drawerTimerRef.current = null
    }, 240)
  }, [])

  const closePanel = useCallback(() => {
    setOpen(false)
    setShown(false) // onTransitionEnd 后卸载 DOM
    closeDrawer()
  }, [closeDrawer])

  /** 侧栏 → 全屏学堂（原地扩张）。首帧以未展开渲染，双 rAF 后触发三栏阶梯淡入 */
  const expandToFull = useCallback((tab?: AiLearnTab) => {
    if (tab) setFullTab(tab)
    setFullMounted(true)
    setAnimating(true)
    setFull(true)
    requestAnimationFrame(() => requestAnimationFrame(() => setFullShown(true)))
    if (animTimerRef.current !== null) window.clearTimeout(animTimerRef.current)
    animTimerRef.current = window.setTimeout(() => {
      setAnimating(false)
      animTimerRef.current = null
    }, EXPAND_MS)
  }, [])

  /** 全屏 → 缩回侧栏（会话、滚动、输入草稿原样保留）；全屏层卸载延后到动画结束，避免回缩瞬间闪空 */
  const collapseToSidebar = useCallback(() => {
    setAnimating(true)
    setFullShown(false)
    setFull(false)
    if (animTimerRef.current !== null) window.clearTimeout(animTimerRef.current)
    animTimerRef.current = window.setTimeout(() => {
      setAnimating(false)
      setFullMounted(false)
      animTimerRef.current = null
    }, EXPAND_MS)
  }, [])

  /** 关闭整个面板（含全屏态） */
  const closeAll = useCallback(() => {
    if (animTimerRef.current !== null) { window.clearTimeout(animTimerRef.current); animTimerRef.current = null }
    setFull(false)
    setFullShown(false)
    setFullMounted(false)
    setAnimating(false)
    closePanel()
  }, [closePanel])

  // 卸载时清理扩张动画兜底定时器
  useEffect(() => {
    return () => { if (animTimerRef.current !== null) window.clearTimeout(animTimerRef.current) }
  }, [])

  const toggleDrawer = useCallback(() => {
    if (drawerOpen) closeDrawer()
    else openDrawer()
  }, [drawerOpen, openDrawer, closeDrawer])

  // Ctrl+J 开关侧栏 / Ctrl+Shift+J 全屏学堂切换 / Esc 退出全屏（第一层：先关会话抽屉）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (e.ctrlKey && e.shiftKey && !e.altKey && k === 'j') {
        e.preventDefault()
        if (full) collapseToSidebar()
        else { if (!open) openPanel(); expandToFull() }
        return
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && k === 'j') {
        e.preventDefault()
        if (full) collapseToSidebar()
        else if (open) closePanel()
        else openPanel()
        return
      }
      // Esc 只在全屏态接管：先收会话抽屉，再缩回侧栏（侧栏态原本无 Esc 行为，不新增）
      if (e.key === 'Escape' && full) {
        if (drawerOpen) closeDrawer()
        else collapseToSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, full, drawerOpen, openPanel, closePanel, closeDrawer, expandToFull, collapseToSidebar])

  // 主体卡片内 AI 按钮 → ai-assistant:toggle 事件（与 Ctrl+J 同一套开关逻辑）
  useEffect(() => {
    const onToggle = () => { if (open) closePanel(); else openPanel() }
    window.addEventListener('ai-assistant:toggle', onToggle)
    return () => window.removeEventListener('ai-assistant:toggle', onToggle)
  }, [open, openPanel, closePanel])

  // 检查是否有可用模型供应商（决定引导态）——每次打开面板时重新检查，
  // 避免用户先开面板、后去设置配好模型回来仍显示「未配置」的过期状态
  useEffect(() => {
    if (!open) return
    llmListProviders()
      .then(r => setProvidersOk(r.providers.some(p => p.enabled && p.models.length > 0)))
      .catch(() => setProvidersOk(false))
    // 弹层 Skill 组候选（v3.1.1 条目10）：面板打开时刷新一次即可
    aiToolsListSkills().then(r => setSlashSkills(r.skills)).catch(() => setSlashSkills([]))
  }, [open])

    const refreshSessions = useCallback(async () => {
    try {
      // 只列「通用助手」来源：AI 教学有自己的会话列表（同表存储，按 source 分流）
      setSessions((await agentSessions()).filter(x => x.source !== 'aiTeaching'))
    } catch { /* ignore */ }
  }, [])

useEffect(() => { if (open) void refreshSessions() }, [open, refreshSessions])

  /** 以会话库为准刷新消息（发送/重新生成/编辑/删除后统一走这里，拿到落库 id 与 trace） */
  const refreshMessages = useCallback(async (sid: string) => {
    if (activeIdRef.current !== sid) return
    try {
      const rows: AgentStoredMessage[] = await agentMessages(sid)
      if (activeIdRef.current === sid) setMessages(rows.map(toUi))
    } catch { /* keep current */ }
  }, [])

  const loadSession = useCallback(async (id: string) => {
    setActiveId(id)
    closeDrawer()
    try {
      const rows: AgentStoredMessage[] = await agentMessages(id)
      setMessages(rows.map(toUi))
    } catch { setMessages([]) }
  }, [])

  const newSession = useCallback(async () => {
    const sRow = await agentNewSession().catch(() => null)
    if (!sRow) return
    setSessions(prev => [sRow, ...prev])
    setActiveId(sRow.id)
    setMessages([])
    closeDrawer()
  }, [])

  const removeSession = async (id: string) => {
    if (deletingId !== id) {
      setDeletingId(id)
      setTimeout(() => setDeletingId(cur => (cur === id ? null : cur)), 3000)
      return
    }
    setDeletingId(null)
    await agentDeleteSession(id)
    setSessions(prev => prev.filter(x => x.id !== id))
    if (activeId === id) { setActiveId(null); setMessages([]) }
  }

  // 选中文本即问：mouseup 捕获主内容区（面板外）的非折叠选区 → 浮动按钮
  useEffect(() => {
    const onMouseUp = () => {
      setTimeout(() => {
        try {
          const sel = window.getSelection()
          const text = sel?.toString().trim() ?? ''
          if (!sel || sel.isCollapsed || !text || text.length < 2 || text.length > 2000) { setSelFloat(null); return }
          // 面板内部的选择不触发
          const anchorEl = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement
          if (anchorEl?.closest('#assistant-panel-root')) { setSelFloat(null); return }
          const rect = sel.getRangeAt(0).getBoundingClientRect()
          if (!rect || (rect.width === 0 && rect.height === 0)) { setSelFloat(null); return }
          setSelFloat({
            x: Math.min(rect.right + 8, window.innerWidth - 170),
            y: Math.min(rect.bottom + 6, window.innerHeight - 44),
            rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
            text,
          })
        } catch { setSelFloat(null) }
      }, 10)
    }
    const onClear = (e?: Event) => {
      const target = e?.target as Element | undefined
      if (target?.closest?.('[data-sel-float]')) return // 点浮动按钮本身不清除
      setSelFloat(null)
    }
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('mousedown', onClear as EventListener)
    window.addEventListener('scroll', onClear, true)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('mousedown', onClear as EventListener)
      window.removeEventListener('scroll', onClear, true)
    }
  }, [])

  /** 从选中片段发起提问 */
  const askSelection = useCallback((text: string) => {
    window.getSelection()?.removeAllRanges()
    setSelFloat(null)
    // 模块接管优先（如 AI 教学：提问要落进它自己的「当前对话」往后答，而不是另开侧边栏对话）
    const host = getSelectionAskHost()
    if (host) {
      try {
        if (host.accept()) { host.ask(text); return }
      } catch { /* 宿主异常 → 回退侧边栏，不阻断用户 */ }
    }
    // 会话引用形式：收进侧栏输入区上方引用胶囊（多条可累积），随消息以可见引用块发出
    setSelQuotes(prev => {
      const next = prev.includes(text) ? prev : [...prev, text].slice(-5)
      selQuotesRef.current = next
      return next
    })
    setSelQuotesOpen(true)
    openPanel()
    setTimeout(() => inputRef.current?.focus(), 120)
  }, [openPanel])

  /** 从选中片段发起翻译（携带选区矩形，卡片据此智能定位） */
  const translateSelection = useCallback((pos: { rect: SelRect }, text: string) => {
    window.getSelection()?.removeAllRanges()
    setSelFloat(null)
    setTransFloat({ rect: pos.rect, text })
  }, [])

  // ---- / 弹层派生态（v3.1.1 条目10）：输入为「/ + 无空格词」时弹，带空格/换行即视为正文 ----
  const slashQuery = input.startsWith('/') && !/[\s\n]/.test(input.slice(1)) && input.length > 1 ? input.slice(1) : (input === '/' ? '' : null)
  const slashItems = useMemo(
    () => filterSlashItems(buildSlashItems(slashSkills), slashQuery ?? ''),
    [slashSkills, slashQuery],
  )
  const slashOpen = slashQuery !== null
  /** 弹层选中：指令 → 补全到输入框（回车执行走既有拦截链）；Skill → 挂 chip、清输入继续写正文 */
  const pickSlash = (it: SlashMenuItem) => {
    if (it.kind === 'command') {
      setInput('/' + it.name + ' ')
      setSlashActive(0)
      inputRef.current?.focus()
      return
    }
    const sk = slashSkills.find(s => s.registryName === it.name)
    if (sk) { setPickedSkill(sk); setInput(''); setSlashActive(0) }
  }
  /** 弹层键控：局部拦截并 stopPropagation，不进全局 Esc 浮层链 */
  const onSlashKeys = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!slashOpen || slashItems.length === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setSlashActive(i => (i + 1) % slashItems.length); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSlashActive(i => (i - 1 + slashItems.length) % slashItems.length); return }
    if (e.key === 'Tab') { e.preventDefault(); pickSlash(slashItems[slashActive]); return }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); pickSlash(slashItems[slashActive]); return }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setInput(''); setSlashActive(0) }
  }

  const send = useCallback(async (override?: string) => {
    // 划词引用（会话引用形式）：以可见的 markdown 引用块并入消息正文，随发随清（单条截断 600 字防刷屏）
    const qs = [...selQuotesRef.current]
    if (qs.length > 0) { selQuotesRef.current = []; setSelQuotes([]); setSelQuotesOpen(false) }
    const body = (override ?? input).trim()
    if (!body && qs.length === 0) return
    const text = qs.length > 0
      ? qs.map((q, i) => `> 【引用 ${i + 1}】${q.replace(/\s+/g, ' ').trim().slice(0, 600)}${q.replace(/\s+/g, ' ').trim().length > 600 ? '…' : ''}`).join('\n') + (body ? `\n\n${body}` : '')
      : body
    // 排队请求不静默丢弃：明确告知正在回复中（可点停止）
    if (pending) {
      showToastSafe('正在回复上一条消息，请等待完成或点击「停止」', 'info')
      return
    }
    // 斜杠指令（/compress 等）：命中即拦截执行，不进对话（置于 pending 检查后，避免生成中并发压缩）
    if (body.startsWith('/')) {
      if (await handleChatCommand(body, {
        sessionId: activeId ?? '',
        surface: full ? 'aiLearn' : 'assistant',
        onProgress: p => setCompressing(p.active),
      })) {
        if (!override) setInput('')
        return
      }
    }
    let sid = activeId
    if (!sid) {
      const sRow = await agentNewSession().catch(() => null)
      if (!sRow) return
      sid = sRow.id
      setActiveId(sid)
    }
    // 上下文优先级：帮助页正在读的手册 > 学堂当前步骤（仅全屏时） > 当前所在界面
    // （划词引用已改为可见引用块并入消息正文，不再占用上下文位）
    const learnCtx = full ? learnStepContext(getLesson(learn.last)) : null
    const ctx = helpCtxRef.current ?? learnCtx ?? getAssistantContext()
    setMessages(prev => [...prev, { role: 'user', content: text, createdAt: nowLocal() }])
    setInput('')
    setPending(true)
    beginStream()
    setLastChanges(null)
    ctxVersionRef.current++
    const cid = crypto.randomUUID()
    chatIdRef.current = cid
    try {
      // v3.1.1 条目10：显式指定 Skill（chip 随消息一次性消费，发出即清）
      const sk = pickedSkill
      setPickedSkill(null)
      const r = await agentChat(sid, text, ctx ?? undefined, cid, undefined, undefined, undefined, sk?.registryName)
      // 自动压缩告知（会话压缩 §6.1）：主进程发送前折叠旧轮为纪要，用户应知道上下文变了
      if (r.ok && r.compressed) showToastSafe(`上下文已自动压缩 ${r.compressed.covered} 条历史 → 纪要`, 'info')
      // 用户在等待期间切换了会话：回复已落库，但不注入当前视图
      if (activeIdRef.current !== sid) {
        showToastSafe('回复已保存到原会话，可在会话列表中查看', 'info')
        return
      }
      if (r.ok && r.reply !== undefined) {
        setLastChanges(r.changes && r.changes.length > 0 ? r.changes : null)
        if (selQuotesRef.current.length > 0) { selQuotesRef.current = []; setSelQuotes([]); setSelQuotesOpen(false) } // 引用一次性消费（正常已在上方清空，兜底）
      } else if (r.code === 'ABORTED') {
        showToast({ type: 'info', message: '已停止生成' })
      } else {
        showToastSafe(`AI 调用失败：${r.error ?? '未知错误'}`)
      }
      // 以会话库为准刷新（拿到落库 id/trace；中止时仅剩用户消息也保持一致）
      await refreshMessages(sid)
    } finally {
      endStream()
      setPending(false)
      void refreshSessions()
    }
  }, [input, pending, activeId, refreshSessions, refreshMessages, full, learn.last, pickedSkill])

  /** 重新生成最后一条回复（末条为助手消息时可用） */
  const runRegenerate = useCallback(async () => {
    const sid = activeId
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
      else if (!r.ok) showToastSafe(`重新生成失败：${r.error ?? '未知错误'}`)
      else if (r.changes && r.changes.length > 0) setLastChanges(r.changes)
      await refreshMessages(sid)
    } finally {
      endStream()
      setPending(false)
      void refreshSessions()
    }
  }, [activeId, pending, messages, refreshMessages, refreshSessions])

  /** 改写用户消息并重推其后回复 */
  const runEdit = useCallback(async (messageId: string, content: string) => {
    const sid = activeId
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
      else if (!r.ok) showToastSafe(`修改失败：${r.error ?? '未知错误'}`)
      else if (r.changes && r.changes.length > 0) setLastChanges(r.changes)
      await refreshMessages(sid)
    } finally {
      endStream()
      setPending(false)
      void refreshSessions()
    }
  }, [activeId, pending, refreshMessages, refreshSessions])

  /** 删除单条消息（助手消息删除后可用「重新生成」补回） */
  const handleDeleteMessage = useCallback(async (messageId: string) => {
    const sid = activeId
    if (!sid) return
    await agentDeleteMessage(sid, messageId)
    await refreshMessages(sid)
  }, [activeId, refreshMessages])

  const ctx = open ? getAssistantContext() : null

  /** 帮助页当前阅读的手册（AiLearnShell 回传）→ 提问时优先于「第几步」作为上下文 */
  const helpCtxRef = useRef<AgentContextInfo | null>(null)
  const onHelpDocChange = useCallback((doc: { title: string; md: string } | null) => {
    helpCtxRef.current = doc
      ? {
          type: 'helpDoc',
          label: `帮助手册 · ${doc.title}`,
          data: {
            手册标题: doc.title,
            手册正文: doc.md.slice(0, 4000),
            说明: '用户正在阅读这篇手册并就其提问，回答请以该手册内容为准，并注明手册标题。',
          },
        }
      : null
  }, [])

  /** 「动手做」跳模块：先收起全屏（浮层会压住目标模块），再派发事件由 App 切换 */
  const gotoModule = useCallback((tab: TabName) => {
    collapseToSidebar()
    window.dispatchEvent(new CustomEvent('ai-learn:goto', { detail: { tab } }))
  }, [collapseToSidebar])

  /** 会话桥接：把侧栏这套状态与方法原样交给全屏学堂 —— 两边是同一份会话，扩张不丢上下文 */
  const chatBridge: ChatBridge = {
    messages, pending, liveSteps, draft, lastChanges, sessions, activeId, selQuotes,
    editing, setEditing, copiedIdx, setCopiedIdx,
    send: text => { void send(text) },
    newSession: () => { void newSession() },
    loadSession: id => { void loadSession(id) },
    deleteSession: id => { void removeSession(id) },
    onAbort: () => { void agentAbort(chatIdRef.current) },
    onRegenerate: () => { void runRegenerate() },
    onEditSubmit: (id, content) => { void runEdit(id, content) },
    onDeleteMessage: id => { void handleDeleteMessage(id) },
    onDismissChanges: () => setLastChanges(null),
    providerMissing: providersOk === false,
    onGoSettings: () => {
      setOpen(false)
      window.dispatchEvent(new CustomEvent('settings:open', { detail: { section: 'aiTools', aiTab: 'models' } }))
    },
  }

  return (
    <>
      {/* 悬浮入口已移至主体卡片内（App.tsx 渲染，相对主体定位，任务栏展开不遮挡）。
          主体按钮点击时派发 ai-assistant:toggle，由下方 useEffect 统一处理 */}

      {/* 选中文本浮动按钮：主内容区框选任意文字后出现（问 AI / 翻译） */}
      {selFloat && (
        <div
          data-sel-float
          className="fixed z-50 flex items-center gap-0.5 rounded-md bg-[var(--accent)] text-white shadow-lg overflow-hidden"
          style={{ left: selFloat.x, top: selFloat.y }}
          onMouseDown={e => e.preventDefault()}
        >
          <button
            onClick={() => askSelection(selFloat.text)}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] hover:bg-black/10 transition-colors"
          >
            <Sparkles size={11} /> 问 AI
          </button>
          <span className="w-px self-stretch bg-white/30" />
          <button
            onClick={() => translateSelection(selFloat, selFloat.text)}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] hover:bg-black/10 transition-colors"
          >
            <Languages size={11} /> 翻译
          </button>
        </div>
      )}

      {/* 划词翻译卡片 */}
      {transFloat && (
        <TranslateCard
          rect={transFloat.rect}
          text={transFloat.text}
          onClose={() => setTransFloat(null)}
        />
      )}

      {/* 侧栏面板 */}
      {open && (
        <div
          id="assistant-panel-root"
          className={`fixed z-40 right-0 flex flex-col bg-[var(--bg-primary)] border-l border-[var(--border-color)] ${full ? 'shadow-none' : 'shadow-2xl'} ${snapClosing ? 'opacity-60' : ''} ${animating ? 'pointer-events-none' : ''}`}
          style={{
            top: full ? 36 : 48,
            bottom: full ? 0 : 40,
            // 宽度必须始终是具体长度：px ↔ calc() 之间才能过渡（CSS 无法过渡到 auto）
            width: full ? `calc(100% - ${shellLeft}px)` : width,
            transition: `top 320ms ${EASE_EXPAND}, bottom 320ms ${EASE_EXPAND}, width ${full ? 320 : 280}ms ${EASE_EXPAND}, opacity 160ms linear`,
            contain: animating ? 'layout paint' : undefined,
          }}
        >
          {/* 侧栏层：全屏态下淡出但不卸载 —— 保住滚动位置、输入草稿与正在进行的请求 */}
          <div
            className="flex min-h-0 flex-1 flex-col"
            style={{
              opacity: full ? 0 : 1,
              // 扩张：先让侧栏淡出、再铺开三栏；回缩：等三栏淡出得差不多侧栏再回来，避免两套内容同屏
              transition: full ? 'opacity 120ms linear' : 'opacity 160ms linear 140ms',
              pointerEvents: full ? 'none' : undefined,
            }}
          >
          {/* 头部 */}
          <div className="h-9 shrink-0 px-2.5 flex items-center gap-1 border-b border-[var(--border-color)]">
            <button onClick={toggleDrawer} title="会话列表"
              className={`p-1.5 rounded-md transition-colors ${drawerOpen ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'}`}>
              <Menu size={14} />
            </button>
            <span className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-primary)]">
              <Sparkles size={13} className="text-[var(--accent)]" /> AI 助手
            </span>
            <button onClick={() => expandToFull()} title="全屏展开 (Ctrl+Shift+J)"
              className="ml-auto p-1.5 rounded-md text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] hover:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] transition-colors">
              <Maximize2 size={14} />
            </button>
            <button onClick={closeAll} title="收起 (Ctrl+J)"
              className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
              <X size={14} />
            </button>
          </div>

          <div className="flex-1 min-h-0 relative flex">
            {/* 消息区 */}
            <div className="flex-1 min-w-0 flex flex-col">
              {providersOk === false ? (
                <NoProviderHint onGoSettings={() => { setOpen(false); window.dispatchEvent(new CustomEvent('settings:open', { detail: { section: 'aiTools', aiTab: 'models' } })) }} />
              ) : (
                <>
                  {/* 抽屉容器：仅包住消息列表，不遮挡上下文徽章与输入框 */}
                  <div className="flex-1 min-h-0 relative">
                    {/* 遮罩：点击空白处收起抽屉 */}
                    {drawerMounted && (
                      <div
                        className={`absolute inset-0 z-[5] bg-black/20 transition-opacity duration-200 ${drawerShown ? 'opacity-100' : 'opacity-0'}`}
                        onClick={closeDrawer}
                      />
                    )}
                    {drawerMounted && (
                      <div
                        className={`absolute inset-y-0 left-0 w-52 z-10 bg-[var(--bg-secondary)] border-r border-[var(--border-color)] flex flex-col transition-transform duration-200 ease-out ${drawerShown ? 'translate-x-0' : '-translate-x-full'}`}
                      >
                        <button onClick={() => { void newSession() }}
                          className="flex items-center gap-1.5 m-2 px-2.5 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:opacity-90 transition-opacity">
                          <Plus size={12} /> 新会话
                        </button>
                        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
                          {sessions.map(sess => (
                            <div key={sess.id}
                              onClick={() => { void loadSession(sess.id) }}
                              className={`kb-item-in group flex items-center gap-1 px-2 py-1.5 rounded-md cursor-pointer text-[12px] transition-colors ${
                                activeId === sess.id ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                              }`}>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate">{sess.title}</span>
                                <span className="block text-[10px] text-[var(--text-disabled)]">{fmtTime(sess.updatedAt)}</span>
                              </span>
                              <button
                                onClick={e => { e.stopPropagation(); void removeSession(sess.id) }}
                                className={`shrink-0 p-0.5 rounded ${deletingId === sess.id ? 'text-red-400' : 'text-[var(--text-disabled)] opacity-0 group-hover:opacity-100 hover:text-red-400'}`}
                                title={deletingId === sess.id ? '再点一次确认删除' : '删除会话'}>
                                <Trash2 size={11} />
                              </button>
                            </div>
                          ))}
                          {sessions.length === 0 && (
                            <p className="text-[11px] text-[var(--text-muted)] text-center pt-3">暂无历史会话</p>
                          )}
                        </div>
                      </div>
                    )}
                    <MessageList
                      messages={messages}
                      pending={pending}
                      liveSteps={liveSteps}
                      draft={draft}
                      editing={editing}
                      setEditing={setEditing}
                      copiedIdx={copiedIdx}
                      setCopiedIdx={setCopiedIdx}
                      onRegenerate={() => { void runRegenerate() }}
                      onEditSubmit={(id, content) => { void runEdit(id, content) }}
                      onDeleteMessage={id => { void handleDeleteMessage(id) }}
                      onAbort={() => { void agentAbort(chatIdRef.current) }}
                      emptyHint={(
                        <div className="pt-8 text-center text-[12px] text-[var(--text-muted)] leading-relaxed px-4">
                          在这里可以直接询问你正在查看的内容。<br />
                          例如打开一篇知识库页面后问：「总结一下这一页」。
                        </div>
                      )}
                    />
                  </div>

                  {/* 本次改动卡片（AI 执行完成的写操作清单，可一键关闭） */}
                  {lastChanges && lastChanges.length > 0 && (
                    <div className="px-3 pb-1 shrink-0">
                      <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] overflow-hidden">
                        <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-[var(--text-secondary)] border-b border-[var(--border-color)]">
                          <Wrench size={10} className="text-[var(--accent)]" />
                          <span className="flex-1">本次已改动 {lastChanges.length} 项</span>
                          <button onClick={() => setLastChanges(null)} title="关闭"
                            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                            <X size={11} />
                          </button>
                        </div>
                        <ul className="py-1 max-h-32 overflow-y-auto">
                          {lastChanges.map((c, i) => {
                            const canOpen = Boolean(c.file)
                            const row = (
                              <>
                                <FileText size={10} className={`shrink-0 ${canOpen ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`} />
                                <span className="shrink-0 text-[var(--accent)]">{c.action}</span>
                                <span className="truncate">{c.target}</span>
                                {canOpen && <ArrowUpRight size={11} className="ml-auto shrink-0 text-[var(--text-muted)] group-hover/item:text-[var(--accent)]" />}
                              </>
                            )
                            return (
                              <li key={i}>
                                {canOpen ? (
                                  <button
                                    onClick={() => window.dispatchEvent(new CustomEvent('kb-open-in-editor', { detail: { relPath: c.file } }))}
                                    title="在编辑器中打开该文件"
                                    className="w-full flex items-center gap-1.5 px-2.5 py-1 text-left text-[11.5px] text-[var(--text-primary)] group/item transition-colors hover:bg-[var(--bg-hover)]"
                                  >
                                    {row}
                                  </button>
                                ) : (
                                  <div className="flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] text-[var(--text-primary)]">{row}</div>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    </div>
                  )}

                  {/* 引用胶囊（会话引用形式）+ 上下文徽章（帮助页/学堂/当前界面，将随提问附带） */}
                  {(selQuotes.length > 0 || ctx) && (
                    <div className="px-3 pb-1 shrink-0 space-y-1">
                      {selQuotes.length > 0 && (
                        <>
                          <div className="flex items-center gap-1.5">
                            <button onClick={() => setSelQuotesOpen(o => !o)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                              title="点击查看/管理引用片段">
                              <Quote size={10} className="text-[var(--accent)]" />
                              <span>{selQuotes.length} 条对话引用</span>
                            </button>
                            <button onClick={() => { selQuotesRef.current = []; setSelQuotes([]); setSelQuotesOpen(false) }} title="移除全部引用"
                              className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
                              <X size={10} />
                            </button>
                          </div>
                          {selQuotesOpen && (
                            <div className="space-y-1">
                              {selQuotes.map((q, i) => (
                                <div key={`${i}-${q.slice(0, 16)}`} className="flex items-start gap-1.5 px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)]">
                                  <Quote size={10} className="mt-[3px] shrink-0 text-[var(--accent)]" />
                                  <span className="flex-1 min-w-0 text-[11px] leading-[1.5] text-[var(--text-secondary)] line-clamp-3">【引用 {i + 1}】{q}</span>
                                  <button onClick={() => setSelQuotes(prev => { const next = prev.filter((_, j) => j !== i); selQuotesRef.current = next; return next })} title="移除此引用"
                                    className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                                    <X size={10} />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                      {ctx && (
                        <span className="inline-flex items-center gap-1 max-w-full px-2 py-0.5 rounded-md bg-[var(--bg-selected)] border border-[var(--border-color)] text-[11px] text-[var(--text-secondary)]">
                          <FileText size={10} className="shrink-0 text-[var(--accent)]" />
                          <span className="truncate">{ctx.label}</span>
                          <span className="text-[var(--text-disabled)]">·将随提问附带</span>
                        </span>
                      )}
                    </div>
                  )}

                  {/* 输入区（v3.1.1 条目10：/ 弹层 + 压缩占位 + Skill chip） */}
                  <div className="p-2.5 shrink-0 border-t border-[var(--border-color)] space-y-1.5">
                    {compressing && (
                      <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[var(--bg-secondary)] text-[11px] text-[var(--text-secondary)] kb-pop">
                        <Loader2 size={12} className="animate-spin shrink-0 text-[var(--accent)]" />
                        正在压缩对话历史…（可能数十秒，期间暂不能发送）
                      </div>
                    )}
                    {pickedSkill && (
                      <span className="inline-flex items-center gap-1 max-w-full px-2 py-0.5 rounded-md bg-[var(--bg-selected)] border border-[var(--border-color)] text-[11px] text-[var(--text-secondary)]">
                        <Sparkles size={10} className="shrink-0 text-[var(--accent)]" />
                        <span className="truncate">Skill：{pickedSkill.title} · 本轮显式生效</span>
                        <button onClick={() => setPickedSkill(null)} title="移除该 Skill"
                          className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"><X size={10} /></button>
                      </span>
                    )}
                    <div className="relative flex items-end gap-2">
                      {slashOpen && (
                        <SlashCommandMenu items={slashItems} activeIndex={slashActive} onHover={setSlashActive} onPick={pickSlash} />
                      )}
                      <textarea
                        ref={inputRef}
                        spellCheck={false}
                        value={input}
                        onChange={e => { setInput(e.target.value); setSlashActive(0) }}
                        onKeyDown={e => { onSlashKeys(e); if (!e.defaultPrevented && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
                        rows={2}
                        placeholder="问问任何事…(Enter 发送，/ 唤起指令)"
                        className="flex-1 px-2.5 py-2 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] resize-none outline-none focus:border-[var(--accent)]"
                      />
                      <button onClick={() => { void send() }} disabled={pending || compressing || !input.trim()}
                        className="p-2 rounded-md bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity">
                        {pending ? <Loader2 size={14} className="animate-spin" /> : <SendIcon />}
                      </button>
                    </div>
                  </div>
                  {/* 条目7：AI 生成内容合规提示——常驻一行弱化小字（AGENTS.md#12：禁醒目标签/图标轰炸）；本组件多模块共用，改一处全局生效 */}
                  <div className="px-3 pb-1.5 -mt-0.5 shrink-0 text-[10.5px] leading-none text-[var(--text-disabled)] select-none">AI 生成内容，请注意甄别</div>
                </>
              )}
            </div>
          </div>

          {/* 宽度拖拽条：向左拖缩小；低于 320px 松手 = 整体关闭（snap）
              面板为悬浮层且置顶，打开期间本拖拽条独占该边缘，
              不会误触下层（如知识库大纲侧栏）的拖拽条。全屏态不需要调宽 → 隐藏 */}
          <div
            className={`absolute top-0 left-[-3px] w-1.5 h-full cursor-ew-resize hover:bg-[var(--accent)]/30 ${full ? 'hidden' : ''}`}
            onMouseDown={e => {
              e.preventDefault()
              const startX = e.clientX
              const startW = savedWidth
              let latest = startW
              const move = (ev: MouseEvent) => {
                latest = Math.min(520, Math.max(260, startW + (startX - ev.clientX)))
                setDragW(latest)
              }
              const up = () => {
                window.removeEventListener('mousemove', move)
                window.removeEventListener('mouseup', up)
                setDragW(null)
                if (latest < 320) {
                  setOpen(false) // snap 关闭
                } else {
                  void update('assistantWidth', latest)
                }
              }
              window.addEventListener('mousemove', move)
              window.addEventListener('mouseup', up)
            }}
          />
          </div>

          {/* 全屏层：AI 学堂（三页签）。挂载后常驻，靠 opacity 切换，回缩动画结束后才卸载 */}
          {fullMounted && (
            <div
              className="absolute inset-0 flex flex-col"
              style={{ opacity: full ? 1 : 0, transition: 'opacity 140ms linear', pointerEvents: full ? undefined : 'none' }}
            >
              <AiLearnShell
                tab={fullTab}
                onTabChange={setFullTab}
                onCollapse={collapseToSidebar}
                onClose={closeAll}
                active={fullShown}
                progress={learn}
                chat={chatBridge}
                onGoto={gotoModule}
                onHelpDocChange={onHelpDocChange}
              />
            </div>
          )}
        </div>
      )}
    </>
  )
}

function NoProviderHint({ onGoSettings }: { onGoSettings: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="text-center">
        <Bot size={28} className="mx-auto text-[var(--text-muted)]" />
        <p className="text-[13px] text-[var(--text-primary)] mt-3">还没有可用的模型供应商</p>
        <p className="text-[12px] text-[var(--text-muted)] mt-1 leading-relaxed">
          推荐本机安装 <b>CC Switch</b> 并配好 Key 后一键导入。
        </p>
        <button onClick={onGoSettings}
          className="mt-4 px-3 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:opacity-90 transition-opacity">
          去配置模型
        </button>
      </div>
    </div>
  )
}

function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" />
    </svg>
  )
}

function showToastSafe(message: string, type: 'error' | 'info' = 'error'): void {
  showToast({ type, message })
}
