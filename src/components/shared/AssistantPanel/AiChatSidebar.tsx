import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Trash2, MessageSquare, ListTree, Pencil } from 'lucide-react'
import { agentRenameSession } from '../../../lib/ipc'
import { fmtTime } from './MessageList'
import { SessionRunMark } from './SessionRunMark'
import { AssistantEntryButton } from './AssistantEntry'
import type { AssistantChatController } from './useAssistantChat'

/**
 * 左栏 AI 会话侧栏（v3.4.0 批次5 反馈轮，开发负责人 drawio 简图排版）：
 * aiChat 标签激活时左栏模块态原位挂载（portal 进 wbModSlot，返回/锁定复用左栏头部）。
 *
 * 结构 = 双 Tab（会话列表 / 会话大纲）+ 主体。
 * （2026-10-05 用户拍板：底部「文件改动」卡删除 —— 与右栏「改动文件」卡重复；本会话写审计
 * 数据仍在主进程 agentUsage 会话分桶，右栏卡与「本次已改动」卡继续消费。）
 * 取代 page 态对话区内的 overlay 抽屉（实机反馈：抽屉浮层遮空态文字、层次混乱）。
 * 会话数据复用 AiChatTab 的 useAssistantChat 控制器（真源在主进程）。
 */

/** 大纲节点摘要：首行非空文本，去 markdown 标记，截 64 字 */
function msgSummary(content: string): string {
  const line = content.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('——')) ?? ''
  return line.replace(/^[#>*\-\s`]+/, '').slice(0, 64) || '（空）'
}

interface Props {
  chat: AssistantChatController
  active: boolean
  /** portal 目标 = 左栏模块态 slot（wbModSlotEl）；null 时不渲染 */
  container: HTMLElement | null
  /** F-2：左栏模块态头部动作槽（wbModActionsEl）——「助手定制」按钮移到这里（与 🏠/🔒 同排） */
  modActionsEl?: HTMLElement | null
}

export function AiChatSidebar({ chat, container, modActionsEl }: Props) {
  const [tab, setTab] = useState<'sessions' | 'outline'>('sessions')
  const { sessions, activeId, messages, pending, runStateOf } = chat

  // ---- 右键菜单（重命名/删除）：portal + 原生事件委托（React 对 body-portal 首个菜单的
  //      合成 click 分发会话内首次失效——🔖 菜单同坑同修，见 WorkbenchLeftPanel 注释）----
  const [menu, setMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  /** 行内重命名：目标会话 + 草稿 */
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null)
  const renameRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return
      setMenu(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [menu])

  // 菜单项点击走容器原生事件委托（合成事件坑，见上）
  useEffect(() => {
    if (!menu) return
    const el = menuRef.current
    if (!el) return
    const onClick = (e: MouseEvent) => {
      const t = (e.target as HTMLElement | null)?.closest?.('[data-ai-menu-item]') as HTMLElement | null
      if (!t?.dataset.aiMenuItem) return
      setMenu(null)
      if (t.dataset.aiMenuItem === 'rename') {
        const sess = sessions.find(s => s.id === menu.sessionId)
        setRenaming({ id: menu.sessionId, draft: sess?.title ?? '' })
        requestAnimationFrame(() => renameRef.current?.select())
        return
      }
      if (t.dataset.aiMenuItem === 'delete') {
        // 走 controller 的双击确认语义：第一次 = 进入确认态（条目删除钮变红提示），再点执行
        void chat.removeSession(menu.sessionId)
      }
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [menu, sessions, chat])

  const submitRename = useCallback(async () => {
    if (!renaming) return
    const title = renaming.draft.trim()
    setRenaming(null)
    if (!title) return
    try {
      await agentRenameSession(renaming.id, title)
      await chat.refreshSessions()
    } catch { /* 重命名失败静默（标题保持旧值） */ }
  }, [renaming, chat])

  // 大纲数据 = 当前会话已落库消息（乐观插入未落库的不列）
  const outline = useMemo(
    () => messages.filter(m => m.id).map(m => ({ id: m.id!, role: m.role, text: msgSummary(m.content), createdAt: m.createdAt })),
    [messages],
  )

  /** 大纲点击 → 消息区滚动定位（消息行带 data-msg-id 锚点，跨容器无需 ref 穿透） */
  const jumpTo = (id: string) => {
    const el = document.querySelector(`[data-assistant-variant="page"] [data-msg-id="${id}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  if (!container) return null

  return createPortal(
    <div data-wb="aiChatSidebar" className="flex min-h-0 flex-1 flex-col">
      {/* 双 Tab（会话列表 / 会话大纲）+ 助手定制入口（N-5/N-7 拍板④：page 态的面板头部） */}
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1.5 pt-1">
        {([
          { key: 'sessions', label: '会话列表', icon: <MessageSquare size={11} /> },
          { key: 'outline', label: '会话大纲', icon: <ListTree size={11} /> },
        ] as const).map(t => (
          <button
            key={t.key}
            data-wb="aiSideTab"
            data-wb-ai-side-tab={t.key}
            data-wb-ai-side-active={tab === t.key ? '1' : '0'}
            onClick={() => setTab(t.key)}
            className={`flex flex-1 items-center justify-center gap-1 rounded-md py-1 text-[11.5px] transition-colors ${
              tab === t.key
                ? 'bg-[var(--bg-selected)] font-medium text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* 主体 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {tab === 'sessions' ? (
          <>
            <button
              data-wb="aiSideNew"
              onClick={() => { void chat.newSession() }}
              className="mb-1 flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] px-2 py-1.5 text-[12px] text-white transition-opacity hover:opacity-90"
            >
              <Plus size={12} /> 新会话
            </button>
            <div className="space-y-0.5">
              {sessions.map(sess => (
                <div
                  key={sess.id}
                  data-wb="aiSideSession"
                  data-wb-ai-session={sess.id}
                  onClick={() => { void chat.loadSession(sess.id) }}
                  onContextMenu={e => {
                    e.preventDefault()
                    setMenu({ sessionId: sess.id, x: e.clientX, y: e.clientY })
                  }}
                  className={`kb-item-in group flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-[12px] transition-colors ${
                    activeId === sess.id
                      ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  {renaming?.id === sess.id ? (
                    <input
                      ref={renameRef}
                      value={renaming.draft}
                      onChange={e => setRenaming({ id: sess.id, draft: e.target.value })}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void submitRename() }
                        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(null) }
                      }}
                      onBlur={() => { void submitRename() }}
                      onClick={e => e.stopPropagation()}
                      spellCheck={false}
                      className="min-w-0 flex-1 rounded border border-[var(--accent)]/60 bg-[var(--bg-primary)] px-1 py-0.5 text-[12px] text-[var(--text-primary)] outline-none"
                    />
                  ) : (
                    <>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">
                          {sess.mode === 'manual' && (
                            <span className="mr-1 rounded bg-[var(--accent)]/12 px-1 py-px text-[9px] font-medium text-[var(--accent)] align-middle">使用帮助</span>
                          )}
                          {sess.title}
                        </span>
                        <span className="block text-[10px] text-[var(--text-disabled)]">{fmtTime(sess.updatedAt)}</span>
                      </span>
                      <SessionRunMark mark={runStateOf(sess.id)} />
                      <button
                        onClick={e => { e.stopPropagation(); void chat.removeSession(sess.id) }}
                        className={`shrink-0 rounded p-0.5 ${chat.deletingId === sess.id ? 'text-red-400' : 'text-[var(--text-disabled)] opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100'}`}
                        title={chat.deletingId === sess.id ? '再点一次确认删除' : '删除会话（右键更多操作）'}
                      >
                        <Trash2 size={11} />
                      </button>
                    </>
                  )}
                </div>
              ))}
              {sessions.length === 0 && (
                <div className="px-2 py-6 text-center text-[11.5px] text-[var(--text-muted)]">暂无会话</div>
              )}
            </div>
          </>
        ) : (
          <>
            {outline.length === 0 ? (
              <div className="px-2 py-6 text-center text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                {activeId ? (pending ? '正在思考，回复后将出现在大纲' : '当前会话还没有消息') : '先选择或新建一个会话'}
              </div>
            ) : (
              <div className="space-y-0.5">
                {outline.map(n => (
                  <button
                    key={n.id}
                    data-wb="aiOutlineNode"
                    onClick={() => jumpTo(n.id)}
                    title="点击定位到该消息"
                    className={`flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] ${
                      n.role === 'user' ? '' : 'pl-5'
                    }`}
                  >
                    <span
                      className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${n.role === 'user' ? 'bg-[var(--accent)]' : 'bg-[var(--text-disabled)]'}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-[11.5px] leading-[1.5] ${n.role === 'user' ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                        {n.text}
                      </span>
                      {n.createdAt && (
                        <span className="block text-[9.5px] text-[var(--text-disabled)]">{fmtTime(n.createdAt)}</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* F-2：把「助手定制」按钮移到左栏模块态头部（与 🏠/🔒 同排），不再挤在双 Tab 行 */}
      {modActionsEl && createPortal(<AssistantEntryButton activeId={activeId} />, modActionsEl)}

      {/* 右键菜单（fixed portal 到 body；菜单项点击走容器原生委托，见上方 useEffect） */}
      {menu && container && createPortal(
        <div
          ref={menuRef}
          data-wb="aiSessionMenu"
          className="fixed z-[130] w-[150px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] py-1 shadow-xl"
          style={{ left: Math.min(menu.x, window.innerWidth - 160), top: Math.min(menu.y, window.innerHeight - 90) }}
        >
          <button
            data-ai-menu-item="rename"
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <Pencil size={12} className="shrink-0" /> 重命名
          </button>
          <button
            data-ai-menu-item="delete"
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-red-400"
          >
            <Trash2 size={12} className="shrink-0" /> 删除会话
          </button>
        </div>,
        document.body,
      )}
    </div>,
    container,
  )
}
