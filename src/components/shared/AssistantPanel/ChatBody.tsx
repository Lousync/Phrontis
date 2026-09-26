import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Menu, Plus, Trash2, Wrench, FileText, ArrowUpRight, ArrowUp, Maximize2,
  Loader2, Bot, X, Sparkles, Paperclip, Coins, ChevronDown, Check, Cpu, Radar, MessagesSquare, TriangleAlert,
  RotateCcw,
} from 'lucide-react'
import { showToast } from '../../../lib/toast'
import { useSettings } from '../../../lib/SettingsContext'
import { SettingSwitch } from '../../../components/shared/SettingSwitch'
import { useInputShell } from './inputShells'
import { getKnowledgePages, agentUsageGet, llmListProviders, getSemanticStatus } from '../../../lib/ipc'
import { SlashCommandMenu, buildSlashItems, filterSlashItems, type SlashMenuItem } from '../SlashCommandMenu'
import { MessageList, fmtTime } from './MessageList'
import { useAssistantChat } from './useAssistantChat'
import { AssistantEntryButton } from './AssistantEntry'
import { AiChatSidebar } from './AiChatSidebar'
import type { AssistantChatController } from './useAssistantChat'
import type { AiUsageDay, KnowledgePage } from '../../../types'

/**
 * AI 助手对话体（v3.4.0 批次5）：消息区 + 会话抽屉 + 改动卡 + 输入区的共用 UI。
 *
 * 三处宿主同体渲染（方案 §4）：悬浮侧栏（sidebar）/ 右栏 AI 态窄版（docked）/
 * aiChat 中间标签宽版（page）。会话状态来自 useAssistantChat 控制器（chat prop），
 * 本组件不持有会话逻辑——同一时刻多个宿主可各挂一份，数据真源在主进程。
 */

export type AssistantBodyVariant = 'sidebar' | 'docked' | 'page'

/**
 * chip 上限（篇）—— B1 上游 §3.1 拍板 4 篇。
 * 契约脚本 `verify-perception.mjs` C2/C3 断言此处**只此一份字面量**（list-drift 防线）。
 */
export const MAX_ATTACHED_REFS = 4

interface ChatBodyProps {
  chat: AssistantChatController
  variant: AssistantBodyVariant
  /** 宿主是否可见（上下文徽章只在可见时显示） */
  active: boolean
  /** 窄版 ⤢：扩大为中间标签宽版（右栏 AI 态专用） */
  onExpand?: () => void
  /** 未配模型引导跳设置（缺省 = 派发 settings:open 事件） */
  onGoSettings?: () => void
  /** 空态提示文案 */
  emptyHint?: ReactNode
  /** 输入容器顶部插槽（悬浮侧栏：划词引用胶囊） */
  inputTop?: ReactNode
  /** 工具行（📎/模型/消耗/发送 那一排）行首插槽 —— B-12 二次拍板（2026-09-22）：感知开关落这排 */
  inputBarLeft?: ReactNode
  /** 会话抽屉开关（默认开）。page 态传 false：会话导航交左栏 AI 会话侧栏（抽屉浮层
      遮空态文字、与输入区层次割裂——2026-09-17 实机反馈拍板）；docked/悬浮侧栏保留 */
  showDrawer?: boolean
  /** 左栏 AI 会话侧栏 portal 目标（AiChatTab 专用；传入即挂侧栏） */
  sidebarEl?: HTMLElement | null
}

/** 输入容器 padding 与最大宽（按形态） */
const INPUT_WRAP: Record<AssistantBodyVariant, string> = {
  sidebar: 'px-3 pb-2.5 pt-2 max-w-[820px] mx-auto w-full',
  docked: 'px-2 pb-2 pt-1.5 w-full',
  page: 'px-4 pb-3.5 pt-2 max-w-[860px] mx-auto w-full',
}

/** 消息区水平内边距（page 态居中限宽，与输入区对齐） */
const LIST_WRAP: Record<AssistantBodyVariant, string> = {
  sidebar: '',
  docked: '',
  page: 'mx-auto w-full max-w-[860px]',
}

/**
 * 输入卡外壳样式已抽至 inputShells.ts（与 AI 教学对话输入框共用，样式统一影响所有 AI 问答面）。
 */

export function ChatBody({ chat, variant, active, onExpand, onGoSettings, emptyHint, inputTop, inputBarLeft, showDrawer = true, sidebarEl }: ChatBodyProps) {
  const {
    sessions, providersOk, activeId, messages, input, setInput, inputRef, pending,
    liveSteps, draft, lastChanges, compressing, pickedSkill, setPickedSkill,
    slashSkills, editing, setEditing, copiedIdx, setCopiedIdx, deletingId,
    drawerMounted, drawerOpen, toggleDrawer, closeDrawer,
    send, newSession, loadSession, removeSession, regenerate, editSubmit, deleteMessage,
    abort, dismissChanges,
    modelId, setModelId, thinking, setThinking, attachedFiles, setAttachedFiles,
    contextInfo, contextRemoved, dismissContext, restoreContext,
  } = chat

  const isNarrow = variant === 'docked'

  // 输入卡外壳样式（设置 → 外观 →「AI 助手输入样式」；未知值回落 v1）
  const shell = useInputShell()

  // ---- 感知模式（B2）：开关本体在主进程读（检索发生在主进程），渲染层只做「显示 + 切换」----
  // 默认 false（上游 §4.1 拍板）：用户主动开启才检索，绝不替用户多花检索开销。
  const { s: chatSettings, update: updateChatSetting } = useSettings()
  const perceptionOn = chatSettings.aiAssistantPerception === true
  const togglePerception = () => { void updateChatSetting('aiAssistantPerception', !perceptionOn) }
  /** 语义索引是否已配置（未配置 → 开启后显示弱提示「当前按关键词匹配」） */
  const [semanticOk, setSemanticOk] = useState<boolean | null>(null)
  useEffect(() => {
    if (!perceptionOn) return
    getSemanticStatus().then(st => setSemanticOk(st?.configured === true)).catch(() => setSemanticOk(false))
  }, [perceptionOn])

  // ---- 输入区工具浮层（📎 附加文件 / 模型选择 / 消耗查看）：互斥单开，外部点击关闭 ----
  const [pop, setPop] = useState<'files' | 'model' | 'usage' | null>(null)
  const inputCardRef = useRef<HTMLDivElement | null>(null)
  // 📎 浮层检索词 / @ 唤起光标位（两者共用同一浮层，故状态同层声明）
  const [fileQuery, setFileQuery] = useState('')
  const atPosRef = useRef<number | null>(null)
  useEffect(() => {
    if (!pop) return
    const onDown = (e: PointerEvent) => {
      if (inputCardRef.current?.contains(e.target as Node)) return
      setPop(null)
      atPosRef.current = null
      setFileQuery('')
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setPop(null)
      atPosRef.current = null
      setFileQuery('')
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [pop])

  // 📎 附加文件候选：打开时拉知识库索引，标题/路径即时过滤（不含已附加）
  const [allPages, setAllPages] = useState<KnowledgePage[]>([])
  useEffect(() => {
    if (pop !== 'files') return
    getKnowledgePages().then(ps => setAllPages(ps ?? [])).catch(() => setAllPages([]))
  }, [pop])
  const fileCandidates = useMemo(() => {
    const q = fileQuery.trim().toLowerCase()
    return allPages
      .filter(p => !attachedFiles.some(f => f.pageId === p.id))
      .filter(p => !q || (p.title || '').toLowerCase().includes(q) || (p.path ?? '').toLowerCase().includes(q))
      .slice(0, 20)
  }, [allPages, fileQuery, attachedFiles])
  const attachFile = (p: KnowledgePage) => {
    if (!p.path) return
    // chip 上限（B1，上游 §3.1 拍板 4 篇）：读常量不写死数字，
    // 与 refSkeleton.MAX_ATTACHED_REFS 同值，契约脚本 C2/C3 守着「不得有第二份字面量」
    if (attachedFiles.length >= MAX_ATTACHED_REFS) {
      showToast({ type: 'info', message: `最多引用 ${MAX_ATTACHED_REFS} 篇笔记` })
      return
    }
    setAttachedFiles(prev => [...prev, { pageId: p.id, title: p.title || p.path || p.id, path: p.path! }])
    setFileQuery('')
  }

  // ---- @ 唤起（B1）：与 📎 共用同一套浮层与候选状态，差异只在触发方式与收尾 ----
  // atPosRef 记录输入框中 `@` 的位置；选中后要把 `@query` 从正文删掉（📎 无此步骤）
  const [atActive, setAtActive] = useState(0)
  const pickFileAndCleanAt = (p: KnowledgePage) => {
    attachFile(p)
    setPop(null)
    const pos = atPosRef.current
    atPosRef.current = null
    if (pos === null) return
    // 删掉 `@` 到光标之间的检索词（光标可能已被方向键移动，取 max 兜底）
    const ta = inputRef.current
    const caret = ta ? ta.selectionStart : pos + 1 + fileQuery.length
    setInput(input.slice(0, pos) + input.slice(Math.max(caret, pos + 1)))
  }
  /** @ 唤起键控：与 slash 弹层同款形态（↑↓ 选择 / Enter 确认 / Esc 关闭），不另造一套 */
  const onAtKeys = (e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (pop !== 'files' || atPosRef.current === null) return false
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setPop(null); atPosRef.current = null; return true }
    if (fileCandidates.length === 0) return false
    if (e.key === 'ArrowDown') {
      e.preventDefault(); setAtActive(i => (i + 1) % fileCandidates.length); return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault(); setAtActive(i => (i - 1 + fileCandidates.length) % fileCandidates.length); return true
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault(); pickFileAndCleanAt(fileCandidates[atActive]); return true
    }
    return false
  }
  /** 输入变化时同步 @ 检索词：光标退回 `@` 之前则视为已放弃，关闭浮层 */
  const syncAtQuery = (value: string, caret: number) => {
    const pos = atPosRef.current
    if (pos === null) return
    if (caret <= pos) { atPosRef.current = null; setPop(null); setFileQuery(''); return }
    const seg = value.slice(pos + 1, caret)
    // 检索词里出现空白 = 用户在写别的话，不再是 @ 引用
    if (/[\s\n]/.test(seg)) { atPosRef.current = null; setPop(null); setFileQuery(''); return }
    setFileQuery(seg)
  }

  // 模型候选：打开时拉启用供应商的模型清单（扁平 pid:model 串；「默认模型」置顶）
  const [providers, setProviders] = useState<Array<{ id: string; name: string; models: string[] }>>([])
  useEffect(() => {
    if (pop !== 'model') return
    llmListProviders()
      .then(r => setProviders(r.providers.filter(p => p.enabled && p.models.length > 0).map(p => ({ id: p.id, name: p.name, models: p.models }))))
      .catch(() => setProviders([]))
  }, [pop])
  const modelLabel = modelId ? modelId.split(':').slice(1).join(':') || modelId : '默认模型'

  // 消耗浮层：今日用量 + 当前会话当日消耗（agentUsageGet 只读）
  const [usage, setUsage] = useState<AiUsageDay | null>(null)
  useEffect(() => {
    if (pop !== 'usage') return
    const key = (() => { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` })()
    agentUsageGet().then(u => setUsage(u.days?.[key] ?? null)).catch(() => setUsage(null))
  }, [pop])
  const sessionUsage = activeId ? usage?.sessions?.[activeId] : null

  // ---- / 弹层派生态：输入为「/ + 无空格词」时弹，带空格/换行即视为正文 ----
  const [slashActive, setSlashActive] = useState(0)
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

  // 界面上下文徽章：与发送时同源（控制器解析），不再各算一份
  const ctx = active ? contextInfo : null

  const goSettings = () => {
    if (onGoSettings) { onGoSettings(); return }
    window.dispatchEvent(new CustomEvent('settings:open', { detail: { section: 'aiTools', aiTab: 'models' } }))
  }

  return (
    /* 根节点必须 h-full 不能 flex-1（铁律 11）：page 态槽位容器（renderMounted div）是块级，
       flex-1 在里面不生效 → 高度塌成内容高，输入框跟着消息区飘到面板中上部（2026-09-17 实机反馈）
       .kb-fit/-aichat（N-6）：本根同时是**容器查询容器** —— 容器窄于阈值时隐「会话消耗」，
       更窄再隐动作钮文字（三级退化，阈值与依据见 index.css ⑥）。三处宿主（悬浮/右栏/整页）同源受益。 */
    <div className="kb-fit kb-fit-aichat flex h-full min-h-0 flex-col" data-assistant-variant={variant}>
      {/* 轻头部：仅在**有控件可放**时才渲染（2026-09-18 反馈轮）。
          悬浮侧栏的头部在其外壳上（本组件不渲染）；感知开关 2026-09-22 二次拍板**改落输入卡
          底部工具行**（与主仓侧栏同位，page / docked 态都在工具行行首）——头部回归纯导航。
          page 态 2026-09-18 的「不放开关」口径就此作废：当时是因头部不渲染而无处安放，
          现开关跟工具行走，page 态自然有。
          docked 态保留（Menu 会话列表 + 标题 + ⤢ 扩大）。 */}
      {variant !== 'sidebar' && (showDrawer || (isNarrow && onExpand)) && (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--border-color)] px-2">
          {showDrawer && (
            <button onClick={toggleDrawer} title="会话列表"
              className={`p-1.5 rounded-md transition-colors ${drawerOpen ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'}`}>
              <Menu size={14} />
            </button>
          )}
          <span className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-primary)]">
            <Sparkles size={13} className="text-[var(--accent)]" /> AI 助手
          </span>
          {/* N-5/N-7 拍板④：助手要求与术语表常驻入口（右栏 AI 态头部与悬浮侧栏同位） */}
          <AssistantEntryButton activeId={activeId} />
          {isNarrow && onExpand && (
            <button onClick={onExpand} title="扩大为完整对话页"
              className="ml-auto rounded p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
              <Maximize2 size={13} />
            </button>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {providersOk === false ? (
          <NoProviderHint onGoSettings={goSettings} />
        ) : (
          <>
            {/* 抽屉容器：仅包住消息列表，不遮挡上下文徽章与输入框 */}
            <div className={`flex-1 min-h-0 relative ${LIST_WRAP[variant]}`}>
              {/* 遮罩：点击空白处收起抽屉（page 态不渲染——showDrawer=false） */}
              {showDrawer && drawerMounted && (
                <div
                  className={`absolute inset-0 z-[5] bg-black/20 transition-opacity duration-200 ${drawerOpen ? 'opacity-100' : 'opacity-0'}`}
                  onClick={closeDrawer}
                />
              )}
              {showDrawer && drawerMounted && (
                <div
                  className={`absolute inset-y-0 left-0 ${isNarrow ? 'w-48' : 'w-52'} z-10 bg-[var(--bg-secondary)] border-r border-[var(--border-color)] flex flex-col transition-transform duration-200 ease-out ${drawerOpen ? 'translate-x-0' : '-translate-x-full'}`}
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
                onRegenerate={() => { void regenerate() }}
                onEditSubmit={(id, content) => { void editSubmit(id, content) }}
                onDeleteMessage={id => { void deleteMessage(id) }}
                onAbort={() => { void abort() }}
                emptyHint={emptyHint ?? (
                  /* 三态统一：空态在滚动区高度内垂直+水平居中。2026-09-19 反馈：两行引导文字收敛为
                     一个聊天气泡图案（入口语义自明，冗余文案按铁律 12 只收不增）。 */
                  <div className="flex h-full items-center justify-center">
                    <MessagesSquare size={22} strokeWidth={1.5} className="text-[var(--text-disabled)]" />
                  </div>
                )}
              />
            </div>

            {/* 本次改动卡片（AI 执行完成的写操作清单，可一键关闭） */}
            {lastChanges && lastChanges.length > 0 && (
              <div className={isNarrow ? 'px-2 pb-1 shrink-0' : 'px-3 pb-1 shrink-0'}>
                <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] overflow-hidden">
                  <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-[var(--text-secondary)] border-b border-[var(--border-color)]">
                    <Wrench size={10} className="text-[var(--accent)]" />
                    <span className="flex-1">本次已改动 {lastChanges.length} 项</span>
                    <button onClick={dismissChanges} title="关闭"
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
                              onClick={() => window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: c.file } }))}
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

            {/* 输入区（宿主插槽 + 上下文徽章 + 附件 chips + 工具行 📎/模型/消耗 + 发送）。
                输入卡 = 无边框浅底大圆角（参考主流 AI 输入框：底色分层替代描边，聚焦时加深） */}
            <div className={`shrink-0 mx-auto ${INPUT_WRAP[variant]} pb-2.5 pt-2`}>
              <div ref={inputCardRef} className={`relative px-2.5 pt-2 pb-2 ${shell.wrap}`}>
                {/* 弱提示升格（B-12 四次拍板 2026-09-22，方案 A）：暖色提示条，与悬浮侧栏同款
                    —— 琥珀底 + 警告图标 + 「去配置」直达；只描述当前状态，不阻断、无「知道了」记忆（H5）。
                    色板走主题 token `--warning` / `--warning-bg`，勿写死色值 */}
                {variant !== 'sidebar' && perceptionOn && semanticOk === false && (
                  <div data-wb="perceptionHint"
                    className="mb-1.5 flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px]"
                    style={{ borderColor: 'color-mix(in srgb, var(--warning) 35%, transparent)', background: 'var(--warning-bg)', color: 'var(--warning)' }}>
                    <TriangleAlert size={12} className="shrink-0" />
                    <span className="truncate">语义索引未配置，感知模式当前按关键词匹配</span>
                    <button onClick={goSettings} className="ml-auto shrink-0 font-medium hover:underline">去配置</button>
                  </div>
                )}
                {inputTop}
                {/* 界面上下文徽章（2026-09-20 反馈）：打开某界面默认就附带，原先没有退出口。
                    × = 本轮不附带该界面（虚线灰显 = 已移除态），点 ↺ 收回。移除只对「这个界面」生效，
                    换界面自动恢复；与发送路径同一真源（controller 的 contextRemoved）。 */}
                {ctx && (
                  <span
                    data-wb="ctxBadge"
                    data-wb-ctx-removed={contextRemoved ? '1' : '0'}
                    className={`mb-1 inline-flex items-center gap-1 max-w-full px-2 py-0.5 rounded-md border text-[11px] ${contextRemoved
                      ? 'border-dashed border-[var(--border-color)] text-[var(--text-muted)]'
                      : 'border-[var(--border-color)] bg-[var(--bg-selected)] text-[var(--text-secondary)]'}`}
                  >
                    <FileText size={10} className={`shrink-0 ${contextRemoved ? 'text-[var(--text-muted)]' : 'text-[var(--accent)]'}`} />
                    <span className="truncate">{ctx.label}</span>
                    {/* 尾注 shrink-0：窄面板里让标签先省略，尾注与按钮不被压到换行 */}
                    <span className="shrink-0 text-[var(--text-disabled)]">{contextRemoved ? '·已移除' : '·将随提问附带'}</span>
                    <button
                      data-wb={contextRemoved ? 'ctxRestoreBtn' : 'ctxDismissBtn'}
                      onClick={contextRemoved ? restoreContext : dismissContext}
                      onMouseDown={e => e.preventDefault()}
                      title={contextRemoved ? '恢复：把当前界面作为上下文附带' : '移除：本轮提问不附带当前界面上下文'}
                      className="shrink-0 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                    >
                      {contextRemoved ? <RotateCcw size={10} /> : <X size={10} />}
                    </button>
                  </span>
                )}

                {attachedFiles.length > 0 && (
                  <div className="mb-1 flex flex-wrap gap-1">
                    {attachedFiles.map(f => (
                      <span key={f.pageId} className="inline-flex max-w-full items-center gap-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10.5px] text-[var(--text-secondary)]">
                        <FileText size={9} className="shrink-0 text-[var(--accent)]" />
                        <span className="max-w-[160px] truncate">{f.title}</span>
                        <button
                          onClick={() => setAttachedFiles(prev => prev.filter(x => x.pageId !== f.pageId))}
                          className="shrink-0 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]" title="移除附件"
                        ><X size={9} /></button>
                      </span>
                    ))}
                  </div>
                )}

                {compressing && (
                  <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[var(--bg-secondary)] text-[11px] text-[var(--text-secondary)] kb-pop">
                    <Loader2 size={12} className="animate-spin shrink-0 text-[var(--accent)]" />
                    正在压缩对话历史…（可能数十秒，期间暂不能发送）
                  </div>
                )}
                {pickedSkill && (
                  <span className="mb-1 inline-flex items-center gap-1 max-w-full px-2 py-0.5 rounded-md bg-[var(--bg-selected)] border border-[var(--border-color)] text-[11px] text-[var(--text-secondary)]">
                    <Sparkles size={10} className="shrink-0 text-[var(--accent)]" />
                    <span className="truncate">Skill：{pickedSkill.title} · 本轮显式生效</span>
                    <button onClick={() => setPickedSkill(null)} title="移除该 Skill"
                      className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"><X size={10} /></button>
                  </span>
                )}
                <div className="relative">
                  {slashOpen && (
                    <SlashCommandMenu items={slashItems} activeIndex={slashActive} onHover={setSlashActive} onPick={pickSlash} />
                  )}
                  <textarea
                    ref={inputRef}
                    spellCheck={false}
                    value={input}
                    onChange={e => {
                      const v = e.target.value
                      setInput(v); setSlashActive(0)
                      // @ 唤起：本次输入**新插入了一个 `@`**，且它落在行首或空白之后
                      // （`@` 是 ASCII 直输、不进 composition，中文输入法场景天然安全）
                      if (atPosRef.current === null && v.length === input.length + 1) {
                        const caret = e.target.selectionStart
                        const at = caret - 1
                        if (v[at] === '@' && (at === 0 || /\s/.test(v[at - 1]))) {
                          atPosRef.current = at
                          setFileQuery('')
                          setAtActive(0)
                          setPop('files')
                          return
                        }
                      }
                      // @ 唤起态：同步检索词（光标退回 @ 之前或打入空白即关闭）
                      if (atPosRef.current !== null) syncAtQuery(v, e.target.selectionStart)
                    }}
                    onKeyDown={e => {
                      // 回车等键序：@ 浮层优先 → slash 弹层 → 发送（各层自己 stopPropagation）
                      if (onAtKeys(e)) return
                      onSlashKeys(e)
                      if (!e.defaultPrevented && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
                    }}
                    onKeyUp={e => {
                      // 方向键移动光标后重算 @ 检索词（↑↓ 被浮层拦下时不会走到这里）
                      if (atPosRef.current !== null) syncAtQuery(e.currentTarget.value, e.currentTarget.selectionStart)
                    }}
                    rows={isNarrow ? 2 : 3}
                    placeholder="问问任何事…（@ 引用笔记 / Enter 发送）"
                    className={`w-full appearance-none px-0.5 py-1 text-[12px] resize-none outline-none bg-transparent! border-0! rounded-none! ${shell.ta ?? ''}`}
                  />
                  {/* ↑ bg-transparent! 等 Tailwind v4 important 修饰符：styles/index.css 的全局
                      textarea 规则（var(--input-bg) 白底 + 1px 边框）是未分层样式，按 cascade
                      规范压过 layered utilities——不加 ! 每个样式方案里都嵌着一个白框 */}
                </div>

                {/* 工具行：行首插槽（侧栏感知开关，B-12）→ 感知开关（docked/page 态，B-12 2026-09-22 二次拍板同位）
                    → 📎 附加文件 / 对话模型 / 消耗查看 —— 发送钮右置 */}
                <div className="relative flex items-center gap-0.5 mt-1">
                  {inputBarLeft}
                  {variant !== 'sidebar' && (
                    <PerceptionToggle on={perceptionOn} onToggle={togglePerception} />
                  )}
                  <button
                    onClick={() => setPop(p => (p === 'files' ? null : 'files'))}
                    title="添加文件作为上下文（模型按需读取全文）"
                    data-wb="aiAttachBtn"
                    className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors ${
                      pop === 'files' || attachedFiles.length > 0
                        ? 'bg-[var(--bg-selected)] text-[var(--accent)]'
                        : 'text-[var(--text-muted)] hover:bg-[var(--bg-selected)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    <Paperclip size={12} />
                    {!isNarrow && <span className="leading-none">附件</span>}
                    {attachedFiles.length > 0 && <span className="leading-none">{attachedFiles.length}</span>}
                  </button>
                  <button
                    onClick={() => setPop(p => (p === 'model' ? null : 'model'))}
                    title="对话模型"
                    data-wb="aiModelBtn"
                    className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors ${
                      pop === 'model' ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-selected)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    <Cpu size={12} />
                    <span className={`leading-none ${isNarrow ? 'max-w-[80px] truncate' : 'max-w-[120px] truncate'}`}>{modelLabel}</span>
                    <ChevronDown size={10} />
                  </button>
                  <button
                    onClick={() => setPop(p => (p === 'usage' ? null : 'usage'))}
                    title="Token 消耗"
                    data-wb="aiUsageBtn"
                    className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors ${
                      pop === 'usage' ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-selected)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    <Coins size={12} />
                    {!isNarrow && <span className="leading-none">消耗</span>}
                  </button>
                  <span className="flex-1" />
                  <button onClick={() => { void send() }} disabled={pending || compressing || !input.trim()} title="发送"
                    className="h-7 w-7 shrink-0 rounded-full bg-[var(--accent)] text-white flex items-center justify-center hover:opacity-90 disabled:opacity-30 transition-all">
                    {pending ? <Loader2 size={12} className="animate-spin" /> : <ArrowUp size={14} />}
                  </button>
                </div>

                {/* ── 工具行浮层（📎 / 模型 / 消耗，三者同构）──
                    宽度必须自适应宿主：面板最窄 240（工作台右栏 ResizablePanel minWidth），
                    docked 态输入卡实宽只有 ~210 → 原先写死的 230~280 会被右栏根节点
                    `overflow-hidden` 从右侧裁掉（2026-09-20 反馈：右栏拖到最窄时模型菜单右侧被切、
                    开关被啃掉一半）。规则：固定宽只作上限，`max-w-full` 按输入卡宽度收缩，
                    行内文案本就有 truncate 兜底，不会溢出。 */}
                {pop === 'files' && (
                  <div data-wb="aiAttachPop" className="absolute bottom-full left-0 mb-2 w-[280px] max-w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-xl overflow-hidden z-20">
                    <div className="border-b border-[var(--border-color)] p-1.5">
                      <input
                        value={fileQuery}
                        onChange={e => setFileQuery(e.target.value)}
                        onKeyDown={e => e.stopPropagation()}
                        placeholder={atPosRef.current !== null ? '在输入框继续打字即可筛选…' : '搜索知识库页面…'}
                        spellCheck={false}
                        /* @ 唤起态不夺焦点——用户还在输入框里连续打字（夺焦会让后续字符全丢） */
                        autoFocus={atPosRef.current === null}
                        readOnly={atPosRef.current !== null}
                        className="w-full rounded-md bg-[var(--bg-tertiary)] px-2 py-1.5 text-[11.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
                      />
                    </div>
                    <div className="max-h-[220px] overflow-y-auto p-1">
                      {fileCandidates.length === 0 ? (
                        <div className="px-2 py-4 text-center text-[11px] text-[var(--text-muted)]">{fileQuery ? '未找到匹配页面' : '知识库还没有页面'}</div>
                      ) : fileCandidates.map((p, idx) => (
                        <button
                          key={p.id}
                          onClick={() => (atPosRef.current !== null ? pickFileAndCleanAt(p) : attachFile(p))}
                          data-at-active={atPosRef.current !== null && idx === atActive ? '1' : undefined}
                          className={`w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] ${
                            atPosRef.current !== null && idx === atActive ? 'bg-[var(--bg-selected)]' : ''
                          }`}
                          title={p.path ?? p.title}
                        >
                          <span className="block truncate text-[11.5px] text-[var(--text-primary)]">{p.title || p.path || '无标题'}</span>
                          {p.path && <span className="block truncate text-[10px] text-[var(--text-disabled)]">{p.path}</span>}
                        </button>
                      ))}
                    </div>
                    <div className="border-t border-[var(--border-color)] px-2.5 py-1.5 text-[9.5px] text-[var(--text-muted)]">
                      {atPosRef.current !== null
                        ? `↑↓ 选择 · Enter 引用 · Esc 取消（最多 ${MAX_ATTACHED_REFS} 篇）`
                        : '附加后模型按需读取文件内容（不整篇注入）'}
                    </div>
                  </div>
                )}

                {/* ── 模型浮层 ── */}
                {pop === 'model' && (
                  <div data-wb="aiModelPop" className="absolute bottom-full left-0 mb-2 w-[250px] max-w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-xl overflow-hidden z-20">
                    {/* 思考模式：开 = 深度思考（reasoning_effort 仅思考型透传）；关 = 快速回答。
                        仅对具备思考能力的模型有差异 */}
                    <label className="flex items-center justify-between gap-2 border-b border-[var(--border-color)] px-2.5 py-2 cursor-pointer">
                      <span className="text-[12px] text-[var(--text-primary)]">思考模式</span>
                      <SettingSwitch checked={thinking} onChange={setThinking} />
                    </label>
                    <div className="max-h-[240px] overflow-y-auto p-1">
                      <button
                        onClick={() => setModelId('')}
                        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                      >
                        <Check size={12} className={`shrink-0 ${modelId === '' ? 'text-[var(--accent)]' : 'opacity-0'}`} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] text-[var(--text-primary)]">默认模型</span>
                          <span className="block text-[10px] text-[var(--text-muted)]">设置里的全局默认对话模型</span>
                        </span>
                      </button>
                      {providers.map(p => p.models.map(m => {
                        const id = `${p.id}:${m}`
                        const on = modelId === id
                        return (
                          <button
                            key={id}
                            onClick={() => setModelId(id)}
                            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                          >
                            <Check size={12} className={`shrink-0 ${on ? 'text-[var(--accent)]' : 'opacity-0'}`} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[12px] text-[var(--text-primary)]">{m}</span>
                              <span className="block text-[10px] text-[var(--text-muted)]">{p.name}</span>
                            </span>
                          </button>
                        )
                      }))}

                      {providers.length === 0 && (
                        <div className="px-2 py-4 text-center text-[11px] text-[var(--text-muted)]">没有已启用的模型供应商</div>
                      )}
                    </div>
                  </div>
                )}

                {/* ── 消耗浮层 ── */}
                {pop === 'usage' && (
                  <div data-wb="aiUsagePop" className="absolute bottom-full left-0 mb-2 w-[230px] max-w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-xl overflow-hidden z-20">
                    <div className="border-b border-[var(--border-color)] px-2.5 py-2">
                      <div className="text-[10.5px] text-[var(--text-muted)]">今日消耗</div>
                      <div className="mt-0.5 text-[15px] font-semibold text-[var(--text-primary)]">
                        {usage ? (usage.in + usage.out).toLocaleString() : '0'}
                        <span className="ml-1 text-[10px] font-normal text-[var(--text-muted)]">tokens</span>
                      </div>
                      {usage && (
                        <div className="mt-0.5 text-[10px] text-[var(--text-muted)]">
                          输入 {usage.in.toLocaleString()} · 输出 {usage.out.toLocaleString()} · {usage.calls} 次调用
                          {usage.cache > 0 && ` · 缓存命中 ${usage.cache.toLocaleString()}`}
                        </div>
                      )}
                    </div>
                    <div className="px-2.5 py-2">
                      <div className="text-[10.5px] text-[var(--text-muted)]">当前会话（今日）</div>
                      {sessionUsage ? (
                        <div className="mt-0.5 text-[12px] text-[var(--text-primary)]">
                          {(sessionUsage.in + sessionUsage.out).toLocaleString()}
                          <span className="ml-1 text-[10px] text-[var(--text-muted)]">tokens（输入 {sessionUsage.in.toLocaleString()} / 输出 {sessionUsage.out.toLocaleString()}）</span>
                        </div>
                      ) : (
                        <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">本会话今日还没有消耗</div>
                      )}
                    </div>
                    <div className="border-t border-[var(--border-color)] px-2.5 py-1.5 text-[9.5px] text-[var(--text-muted)]">
                      按日落盘近 30 天 · 右栏扩大页可看会话排行
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 感知模式开关（B2 §4.1；2026-09-22 B-12 二次拍板：落输入卡底部工具行行首）。
 *
 * 读写同一个 settings 键 `aiAssistantPerception`（悬浮侧栏 / 右栏 AI 态 / 设置页三处同源，
 * 不存在第二份状态）。开启时主进程在发送前检索知识库、注入最相关的笔记素材。
 *
 * 视觉：开启态用 accent 染色，关闭态走普通 muted；规格对齐工具行同排按钮
 * （📎 / 模型 / 消耗：px-1.5 py-1 + 12px 图标），不新增动效（`transition-colors`，铁律 13 允许）。
 */
function PerceptionToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-pressed={on}
      data-wb="perceptionToggle"
      title={on
        ? '感知模式：已开启 —— 发送前自动检索知识库，把最相关的笔记素材注入本轮上下文（纯本地检索，不消耗对话 token）'
        : '感知模式：已关闭 —— 点击开启后，发送前会自动检索知识库并注入相关笔记素材'}
      className={`flex items-center rounded-md px-1.5 py-1 transition-colors ${on
        ? 'text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] hover:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]'
        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-selected)]'}`}>
      <Radar size={12} />
    </button>
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

/** aiChat 中间标签的页面态宿主（v3.4.0 批次5）：自带会话控制器，App.tsx 槽位直接渲染本组件。
 *  display:none 保活期间 active=false（不刷新供应商/会话），切回标签自动恢复。
 *  会话导航不放对话区抽屉（实机反馈层次混乱）——sidebarEl 传入时把左栏 AI 会话侧栏
 *  （AiChatSidebar：会话列表/会话大纲 + 底部文件改动）portal 进左栏模块态 slot。 */
export function AiChatTab({ active, sidebarEl }: { active: boolean; sidebarEl?: HTMLElement | null }) {
  const chat = useAssistantChat({ active })
  return (
    <>
      <ChatBody chat={chat} variant="page" active={active} showDrawer={false} />
      {sidebarEl && <AiChatSidebar chat={chat} active={active} container={sidebarEl} />}
    </>
  )
}
