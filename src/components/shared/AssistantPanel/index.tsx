import { useCallback, useEffect, useRef, useState } from 'react'
import { Sparkles, X, Menu, Quote, Languages, Maximize2, Radar, TriangleAlert } from 'lucide-react'
import { AiLearnShell, type AiLearnTab, type ChatBridge } from '../AiLearn'
import { useLearnProgress, learnStepContext } from '../AiLearn/useLearnProgress'
import { getLesson } from '../AiLearn/lessons'
import { useSettings } from '../../../lib/SettingsContext'
import { getSemanticStatus } from '../../../lib/ipc'
import { getSelectionAskHost, getAssistantContext } from '../../../lib/assistantContext'
import { TranslateCard } from '../TranslateCard'
import { ChatBody } from './ChatBody'
import { useAssistantChat } from './useAssistantChat'
import type { AgentContextInfo, TabName } from '../../../types'

/**
 * 全局 AI 助手侧栏（方案 B）：任意界面 Ctrl+J / 右下角按钮唤起，
 * 会话留存 + 上下文感知（正在查看的知识库页面自动附带）。
 * 拖拽左缘调宽；拖到 320px 以下松手 = 整体关闭（snap），不会误触下层模块侧栏。
 *
 * 也可原地扩张为全屏「AI 学堂」（Ctrl+Shift+J / 头部 ⊞），会话与侧栏共用同一份。
 *
 * v3.4.0 批次5 重构：会话/流式/发送逻辑抽为 useAssistantChat，消息区/输入区抽为
 * ChatBody（悬浮侧栏 = 工作台右栏 AI 态 = aiChat 标签三处同体）；本文件只保留
 * 悬浮形态的外壳——fixed 定位、拖宽/snap、全屏学堂、划词浮钮与引用胶囊。
 */

/** 选区矩形（viewport 坐标），供翻译卡片智能定位 */
interface SelRect { left: number; top: number; right: number; bottom: number }

/** 扩张/回缩动画总时长：宽度 320ms 与最晚一栏（delay 140 + 180ms）取齐，再留余量。
 *  动画结束靠定时器兜底而非 transitionend（见 state 声明处注释）。 */
const EXPAND_MS = 420
/** 扩张动画缓动（与 AiLearn 内三栏淡入保持一致） */
const EASE_EXPAND = 'cubic-bezier(.22,.68,.32,1)'

/**
 * @param shellLeft 全屏扩张时左侧需避让的宽度（活动栏占位，由 App 透传）。
 *   禅模式 Z2+ 活动栏不渲染 → 0；最大化 → 56；否则 56 + mx-1.5 两侧留白 = 68。
 * @param suspendShortcut 宿主接管了 Ctrl+J 时挂起本组件的 Ctrl+J 分支（2026-09-21 用户拍板：
 *   工作台内 Ctrl+J 唤出工作台右栏 AI 侧栏，整窗模块才唤出本悬浮助手 —— 路由由 App 做）。
 *   Ctrl+Shift+J（全屏学堂）不挂起，仍归本组件。
 * @param aiShortcutDisabled 本模块禁用 AI 助手快捷键（2026-09-22 拍板：AI 教学区自己就是 AI 对话区，
 *   在那里再唤起一个助手 = 同屏两块对话）—— **Ctrl+J 与 Ctrl+Shift+J 两条分支一起闸**，
 *   且不 preventDefault，行为就是「完全无反应」。清单真源 `AI_ASSISTANT_SHORTCUT_DISABLED`。
 */
export function AssistantPanel({ shellLeft = 68, suspendShortcut = false, aiShortcutDisabled = false }: { shellLeft?: number; suspendShortcut?: boolean; aiShortcutDisabled?: boolean }) {
  const { s, update } = useSettings()
  /** 上手路径进度（settings 落盘）；全屏学堂与提问上下文共用 */
  const learn = useLearnProgress()
  // 感知模式（B2）：开关态 + 语义索引可用性（未配置 → 头部下方弱提示）
  const perceptionOn = s.aiAssistantPerception === true
  const [semanticOk, setSemanticOk] = useState<boolean | null>(null)
  useEffect(() => {
    if (!perceptionOn) return
    getSemanticStatus().then(st => setSemanticOk(st?.configured === true)).catch(() => setSemanticOk(false))
  }, [perceptionOn])
  const [open, setOpen] = useState(false)
  // 动画三态: mounted=DOM 存在(含退场动画期间), shown=滑入到位
  const [mounted, setMounted] = useState(false)
  const [shown, setShown] = useState(false)
  /** 全屏 AI 学堂（P0）：full=容器已扩张；fullMounted=全屏层已挂载；fullShown=阶梯淡入已触发；
   *  animating=扩张/回缩动画进行中（屏蔽点击 + contain 隔离），结束由定时器兜底（不可依赖 transitionend，
   *  Tailwind v4 下过渡属性名可能是 width/translate，历史上已踩过事件不触发的坑） */
  const [full, setFull] = useState(false)
  const [fullTab, setFullTab] = useState<AiLearnTab>('learn')
  const [fullMounted, setFullMounted] = useState(false)
  const [fullShown, setFullShown] = useState(false)
  const [animating, setAnimating] = useState(false)
  const animTimerRef = useRef<number | null>(null)
  const [dragW, setDragW] = useState<number | null>(null)
  /** 选中文本即问：浮动按钮状态与一次性选中上下文 */
  const [selFloat, setSelFloat] = useState<{ x: number; y: number; rect: SelRect; text: string } | null>(null)
  /** 划词引用（会话引用形式）：「问 AI」收进输入区上方引用胶囊（多条可累积），随消息以可见引用块发出 */
  const [selQuotes, setSelQuotes] = useState<string[]>([])
  const [selQuotesOpen, setSelQuotesOpen] = useState(false)
  const selQuotesRef = useRef<string[]>([])
  /** 划词翻译卡片（与「问 AI」浮钮共用选区检测） */
  const [transFloat, setTransFloat] = useState<{ rect: SelRect; text: string } | null>(null)

  // ---- 会话控制器（批次5 抽出）：状态与方法，ChatBody 与全屏学堂 bridge 共用 ----
  const chat = useAssistantChat({
    active: open,
    resolveContext: useCallback((): AgentContextInfo | null => {
      // 上下文优先级：帮助页正在读的手册 > 学堂当前步骤（仅全屏时） > 当前所在界面
      return helpCtxRef.current ?? (full ? learnStepContext(getLesson(learn.last)) : null) ?? getAssistantContext()
    }, [full, learn.last]),
    surfaceOf: useCallback(() => (full ? 'aiLearn' : 'assistant'), [full]),
    prepareBody: useCallback((raw: string) => {
      // 划词引用（会话引用形式）：以可见的 markdown 引用块并入消息正文，随发随清（单条截断 600 字防刷屏）
      const qs = [...selQuotesRef.current]
      if (qs.length > 0) { selQuotesRef.current = []; setSelQuotes([]); setSelQuotesOpen(false) }
      const text = qs.length > 0
        ? qs.map((q, i) => `> 【引用 ${i + 1}】${q.replace(/\s+/g, ' ').trim().slice(0, 600)}${q.replace(/\s+/g, ' ').trim().length > 600 ? '…' : ''}`).join('\n') + (raw ? `\n\n${raw}` : '')
        : raw
      return text
    }, []),
  })

  const savedWidth = Math.min(520, Math.max(320, Number(s.assistantWidth ?? 380)))
  // 拖拽中的实时宽度；低于 320 属于"拖拽关闭"区间，松手即关
  const width = dragW ?? savedWidth
  const snapClosing = dragW !== null && dragW < 320

  const openPanel = useCallback(() => {
    setMounted(true)
    setOpen(true)
    // 双 rAF 确保首帧以关闭位渲染, 再过渡到打开位
    requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)))
  }, [])

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
    setOpen(false)
    setShown(false) // onTransitionEnd 后卸载 DOM
  }, [])

  // 卸载时清理扩张动画兜底定时器
  useEffect(() => {
    return () => { if (animTimerRef.current !== null) window.clearTimeout(animTimerRef.current) }
  }, [])

  // Ctrl+J 开关侧栏 / Ctrl+Shift+J 全屏学堂切换 / Esc 退出全屏（第一层：先关会话抽屉）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (e.ctrlKey && e.shiftKey && !e.altKey && k === 'j') {
        // AI 教学区等禁用模块：**两条分支一起闸**（原来这里不查任何闸门 → 「只禁一半」）
        if (aiShortcutDisabled) return
        e.preventDefault()
        if (full) collapseToSidebar()
        else { if (!open) openPanel(); expandToFull() }
        return
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && k === 'j') {
        // 宿主接管（工作台内 App 路由到右栏 AI 侧栏）：本组件不响应、不 preventDefault
        if (suspendShortcut || aiShortcutDisabled) return
        e.preventDefault()
        if (full) collapseToSidebar()
        else if (open) closeAll()
        else openPanel()
        return
      }
      // Esc 只在全屏态接管：先收会话抽屉，再缩回侧栏（侧栏态原本无 Esc 行为，不新增）
      if (e.key === 'Escape' && full) {
        if (chat.drawerOpen) chat.closeDrawer()
        else collapseToSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, full, suspendShortcut, aiShortcutDisabled, chat.drawerOpen, chat.closeDrawer, openPanel, closeAll, expandToFull, collapseToSidebar])

  // ai-assistant:toggle 监听已删（2026-09-22，B-8 顺带清）：右下浮钮 2026-09-16 移除后
  // 全仓已无派发方，属与 kb-editor-doc-changed 同类的死监听。

  // ai-assistant:close → 只收不叠（工作台 Ctrl+J 路由用：唤出右栏 AI 前先把浮层收掉，避免双对话叠加）
  useEffect(() => {
    const onClose = () => closeAll()
    window.addEventListener('ai-assistant:close', onClose)
    return () => window.removeEventListener('ai-assistant:close', onClose)
  }, [closeAll])

  // 进入禁用模块（AI 教学区）时**自动收掉浮层**（2026-09-22 拍板）：
  // 只禁快捷键不够 —— 「工作台 Ctrl+Shift+J 唤起 → 收起 → 切到 AI 教学区」这条路上浮层仍在
  // （fixed z-40，切 Tab 不自动收），与其自带对话区并排 = 同屏两块 AI 对话，换个入口又回来了。
  // 幂等：面板本就关着时 closeAll() 是空操作；也不做边沿限制（启动即停教学区的场景同样该收）。
  useEffect(() => {
    if (aiShortcutDisabled) closeAll()
  }, [aiShortcutDisabled, closeAll])

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
          // 阅读域排除（2026-09-20 反馈「两个勾画菜单」）：阅读器有自己的选区浮条（摘录/翻译/问AI 全量），
          // 标 data-sel-float-ignore 的子树内全局浮钮让位——否则同一选区弹两排菜单
          if (anchorEl?.closest('[data-sel-float-ignore]')) { setSelFloat(null); return }
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
    setTimeout(() => chat.inputRef.current?.focus(), 120)
  }, [openPanel, chat.inputRef])

  /** 从选中片段发起翻译（携带选区矩形，卡片据此智能定位） */
  const translateSelection = useCallback((pos: { rect: SelRect }, text: string) => {
    window.getSelection()?.removeAllRanges()
    setSelFloat(null)
    setTransFloat({ rect: pos.rect, text })
  }, [])

  // 阅读器浮条桥（2026-09-20「两个勾画菜单」合并）：阅读域内全局浮钮让位，
  // 但「问 AI / 翻译」能力不丢——TXT 选区浮条经本事件借用这里的问答/翻译链路
  useEffect(() => {
    const onAction = (e: Event) => {
      const d = (e as CustomEvent).detail as { action?: 'ask' | 'translate'; text?: string; rect?: SelRect } | undefined
      const text = String(d?.text ?? '')
      if (!text) return
      if (d?.action === 'translate') {
        translateSelection({ rect: d.rect ?? { left: 0, top: 0, right: 0, bottom: 0 } }, text)
      } else {
        askSelection(text)
      }
    }
    window.addEventListener('ai-assistant:selection-action', onAction)
    return () => window.removeEventListener('ai-assistant:selection-action', onAction)
  }, [askSelection, translateSelection])

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

  /** 会话桥接：把控制器 + 侧栏特有状态原样交给全屏学堂 —— 两边是同一份会话，扩张不丢上下文 */
  const chatBridge: ChatBridge = {
    messages: chat.messages, pending: chat.pending, liveSteps: chat.liveSteps, draft: chat.draft,
    lastChanges: chat.lastChanges, sessions: chat.sessions, activeId: chat.activeId, selQuotes,
    editing: chat.editing, setEditing: chat.setEditing, copiedIdx: chat.copiedIdx, setCopiedIdx: chat.setCopiedIdx,
    send: text => { void chat.send(text) },
    newSession: () => { void chat.newSession() },
    loadSession: id => { void chat.loadSession(id) },
    deleteSession: id => { void chat.removeSession(id) },
    onAbort: () => { void chat.abort() },
    onRegenerate: () => { void chat.regenerate() },
    onEditSubmit: (id, content) => { void chat.editSubmit(id, content) },
    onDeleteMessage: id => { void chat.deleteMessage(id) },
    onDismissChanges: chat.dismissChanges,
    providerMissing: chat.providersOk === false,
    onGoSettings: () => {
      setOpen(false)
      window.dispatchEvent(new CustomEvent('settings:open', { detail: { section: 'aiTools', aiTab: 'models' } }))
    },
  }

  /** 感知模式开关 + 弱提示（B2 §4.1；B-12 自头部下移，2026-09-22 二次拍板：落**输入卡底部工具行**
   *  （📎 / 模型 / 消耗那排）行首，与触发按钮同排同款交互）。
   *  ★ JSX 刻意**留在本文件**（不搬进 ChatBody）：契约 `verify-perception.mjs` 的 H3b / H4a 是按
   *  **文件**断言的（`data-wb="perceptionToggle"` / `语义索引未配置` 各须在本文件出现一次），
   *  换文件即破契约；只挪渲染位置则两条断言原样成立。 */
  const perceptionRow = (
    <div className="flex items-center gap-1 pr-0.5">
      <button onClick={() => { void update('aiAssistantPerception', !perceptionOn) }}
        aria-pressed={perceptionOn} data-wb="perceptionToggle"
        title={perceptionOn
          ? '感知模式：已开启 —— 发送前自动检索知识库，把最相关的笔记素材注入本轮上下文（纯本地检索，不消耗对话 token）'
          : '感知模式：已关闭 —— 点击开启后，发送前会自动检索知识库并注入相关笔记素材'}
        className={`flex items-center rounded-md px-1.5 py-1 transition-colors ${perceptionOn
          ? 'text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] hover:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]'
          : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-selected)]'}`}>
        <Radar size={12} />
      </button>
    </div>
  )

  /** 弱提示升格：暖色提示条（B-12 四次拍板 2026-09-22，方案 A）——从开关旁的小字升为
   *  输入卡顶部的独立提示条：琥珀底 + 警告图标 + 「去配置」直达（跳设置 → AI 工具 → 模型，
   *  嵌入模型就在那里配）。仍然只描述当前状态：不阻断发送、无「知道了」记忆（契约 H5）。
   *  色板用主题 token `--warning` / `--warning-bg`（明暗主题各有一份，勿写死色值）。 */
  const perceptionHintStrip = perceptionOn && semanticOk === false ? (
    <div data-wb="perceptionHint"
      className="mb-1.5 flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px]"
      style={{ borderColor: 'color-mix(in srgb, var(--warning) 35%, transparent)', background: 'var(--warning-bg)', color: 'var(--warning)' }}>
      <TriangleAlert size={12} className="shrink-0" />
      <span className="truncate">语义索引未配置，感知模式当前按关键词匹配</span>
      <button onClick={() => window.dispatchEvent(new CustomEvent('settings:open', { detail: { section: 'aiTools', aiTab: 'models' } }))}
        className="ml-auto shrink-0 font-medium hover:underline">去配置</button>
    </div>
  ) : null

  /** 划词引用胶囊（会话引用形式，悬浮侧栏特有） */
  const quoteRow = selQuotes.length > 0 ? (
    <div className="mb-1 flex items-center gap-1.5">
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
      {selQuotesOpen && (
        <div className="mt-1 space-y-1 w-full">
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
    </div>
  ) : null

  /** 输入区顶部插槽：暖色提示条在上、划词引用胶囊在下（感知开关已改走工具行插槽 inputBarLeft） */
  const inputTop = <>{perceptionHintStrip}{quoteRow}</>

  return (
    <>
      {/* 悬浮入口 / 右下浮钮均已移除（2026-09-16）：AI 对话入口 = 中间栏 aiChat 标签 + Ctrl+J。
          原「主体卡片按钮 → ai-assistant:toggle 事件」链路随浮钮一并废除（2026-09-22 清理死监听） */}

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
            <button onClick={chat.toggleDrawer} title="会话列表"
              className={`p-1.5 rounded-md transition-colors ${chat.drawerOpen ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'}`}>
              <Menu size={14} />
            </button>
            <span className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-primary)]">
              <Sparkles size={13} className="text-[var(--accent)]" /> AI 助手
            </span>
            {/* 感知模式开关（B2）自本头部**下移**到输入框上方（B-12，2026-09-21 拍板：
                输入卡内顶部 · 只动侧边栏 · 弱提示跟着走）——见下方 inputTop 的渲染。
                头部只留导航类控件（会话列表 / 全屏 / 收起），开关贴着它作用的输入区。 */}
            <button onClick={() => expandToFull()} title="全屏展开 (Ctrl+Shift+J)"
              className="ml-auto p-1.5 rounded-md text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] hover:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] transition-colors">
              <Maximize2 size={14} />
            </button>
            <button onClick={closeAll} title="收起 (Ctrl+J)"
              className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
              <X size={14} />
            </button>
          </div>

          {/* 弱提示（B2 §4.1）随开关下移到输入框上方（B-12）：它描述的是那个开关的状态，
              留在头部会与开关分家（提示在这儿、开关在一屏之外）。见下方 inputTop。 */}

          {/* 对话体（批次5 抽出，与右栏 AI 态 / aiChat 标签同体） */}
          <ChatBody
            chat={chat}
            variant="sidebar"
            active={open}
            inputTop={inputTop}
          inputBarLeft={perceptionRow}
          />

          {/* 宽度拖拽条：向左拖缩小；低于 320px 松手 = 整体关闭（snap）
              面板为悬浮层且置顶，打开期间本拖拽条独占该边缘，
              不会误触下层（如知识库大纲侧栏）的拖拽条。全屏态不需要调宽 → 隐藏。
              v3.2.0 条目 ⑤ 同源修法（全应用第三套手柄）：① 4px dead-zone（掠过/轻点不再改宽度、
              也不再落盘）；② `setPointerCapture` 保证指针移到工件 iframe 之上时事件仍能送达
              （capture 后事件照旧冒泡到 window，故处理路径仍是单一路径）；③ 收尾走
              pointerup / pointercancel 双路 + 真拖过才落盘。 */}
          <div
            className={`absolute top-0 left-[-3px] w-1.5 h-full cursor-ew-resize hover:bg-[var(--accent)]/30 ${full ? 'hidden' : ''}`}
            title="拖拽调整宽度（拖到 320px 以内松手即关闭）"
            onPointerDown={e => {
              if (e.button !== 0) return
              e.preventDefault()
              const el = e.currentTarget
              const startX = e.clientX
              const startW = savedWidth
              let latest = startW
              let moved = false
              // capture 只为「送达保证」：指针进入工件 iframe 后事件不再丢失
              try { el.setPointerCapture(e.pointerId) } catch { /* 不支持则退回普通 window 监听 */ }
              const move = (ev: PointerEvent) => {
                if (!moved && Math.abs(ev.clientX - startX) < 4) return
                moved = true
                latest = Math.min(520, Math.max(260, startW + (startX - ev.clientX)))
                setDragW(latest)
              }
              const finish = () => {
                window.removeEventListener('pointermove', move)
                window.removeEventListener('pointerup', finish)
                window.removeEventListener('pointercancel', finish)
                setDragW(null)
                if (!moved) return // 误触：不改宽度、不落盘、也不做 snap 判定
                if (latest < 320) {
                  setOpen(false) // snap 关闭
                } else {
                  void update('assistantWidth', latest)
                }
              }
              window.addEventListener('pointermove', move)
              window.addEventListener('pointerup', finish)
              window.addEventListener('pointercancel', finish)
            }}
            onLostPointerCapture={() => setDragW(null)}
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
