import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Menu, Plus, Trash2, Wrench, FileText, ArrowUpRight, ArrowUp, Maximize2,
  Loader2, Bot, X, Sparkles,
} from 'lucide-react'
import { getAssistantContext } from '../../../lib/assistantContext'
import { SlashCommandMenu, buildSlashItems, filterSlashItems, type SlashMenuItem } from '../SlashCommandMenu'
import { MessageList, fmtTime } from './MessageList'
import { useAssistantChat } from './useAssistantChat'
import { AiChatSidebar } from './AiChatSidebar'
import type { AssistantChatController } from './useAssistantChat'

/**
 * AI 助手对话体（v3.4.0 批次5）：消息区 + 会话抽屉 + 改动卡 + 输入区的共用 UI。
 *
 * 三处宿主同体渲染（方案 §4）：悬浮侧栏（sidebar）/ 右栏 AI 态窄版（docked）/
 * aiChat 中间标签宽版（page）。会话状态来自 useAssistantChat 控制器（chat prop），
 * 本组件不持有会话逻辑——同一时刻多个宿主可各挂一份，数据真源在主进程。
 */

export type AssistantBodyVariant = 'sidebar' | 'docked' | 'page'

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

export function ChatBody({ chat, variant, active, onExpand, onGoSettings, emptyHint, inputTop, showDrawer = true, sidebarEl }: ChatBodyProps) {
  const {
    sessions, providersOk, activeId, messages, input, setInput, inputRef, pending,
    liveSteps, draft, lastChanges, compressing, pickedSkill, setPickedSkill,
    slashSkills, editing, setEditing, copiedIdx, setCopiedIdx, deletingId,
    drawerMounted, drawerOpen, toggleDrawer, closeDrawer,
    send, newSession, loadSession, removeSession, regenerate, editSubmit, deleteMessage,
    abort, dismissChanges,
  } = chat

  const isNarrow = variant === 'docked'

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

  const ctx = active ? getAssistantContext() : null

  const goSettings = () => {
    if (onGoSettings) { onGoSettings(); return }
    window.dispatchEvent(new CustomEvent('settings:open', { detail: { section: 'aiTools', aiTab: 'models' } }))
  }

  return (
    /* 根节点必须 h-full 不能 flex-1（铁律 11）：page 态槽位容器（renderMounted div）是块级，
       flex-1 在里面不生效 → 高度塌成内容高，输入框跟着消息区飘到面板中上部（2026-09-17 实机反馈） */
    <div className="flex h-full min-h-0 flex-col" data-assistant-variant={variant}>
      {/* 轻头部（悬浮侧栏的头部在其外壳上）：抽屉 + 标题 + ⤢（仅窄版）。
          page 态 showDrawer=false：Menu 钮不渲染（会话导航在左栏 AI 会话侧栏） */}
      {variant !== 'sidebar' && (
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
          {isNarrow && onExpand && (
            <button onClick={onExpand} title="扩大为完整对话页"
              className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] hover:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] transition-colors">
              <Maximize2 size={12} />
              <span className="text-[10.5px]">扩大</span>
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
                  <div className="pt-8 text-center text-[12px] text-[var(--text-muted)] leading-relaxed px-4">
                    在这里可以直接询问你正在查看的内容。<br />
                    例如打开一篇知识库页面后问：「总结一下这一页」。
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

            {/* 输入区（上下文徽章 + / 弹层 + 压缩占位 + Skill chip） */}
            <div className={`shrink-0 mx-auto ${INPUT_WRAP[variant]} pb-2.5 pt-2`}>
              <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-lg px-2.5 pt-2 pb-2 focus-within:border-[var(--accent)]/60">
                {ctx && (
                  <span className="mb-1 inline-flex items-center gap-1 max-w-full px-2 py-0.5 rounded-md bg-[var(--bg-selected)] border border-[var(--border-color)] text-[11px] text-[var(--text-secondary)]">
                    <FileText size={10} className="shrink-0 text-[var(--accent)]" />
                    <span className="truncate">{ctx.label}</span>
                    <span className="text-[var(--text-disabled)]">·将随提问附带</span>
                  </span>
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
                    onChange={e => { setInput(e.target.value); setSlashActive(0) }}
                    onKeyDown={e => { onSlashKeys(e); if (!e.defaultPrevented && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
                    rows={isNarrow ? 2 : 3}
                    placeholder="问问任何事…(Enter 发送，/ 唤起指令)"
                    className="w-full px-0.5 py-1 rounded-none border-0 bg-transparent text-[12px] resize-none outline-none"
                  />
                </div>
                <div className="flex items-center justify-end mt-0.5">
                  <button onClick={() => { void send() }} disabled={pending || compressing || !input.trim()} title="发送"
                    className="w-8 h-8 rounded-full bg-[var(--accent)] text-white flex items-center justify-center hover:opacity-90 disabled:opacity-30 transition-all">
                    {pending ? <Loader2 size={13} className="animate-spin" /> : <ArrowUp size={15} />}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
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
