import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Trash2, MessageSquare, ListTree, FileEdit } from 'lucide-react'
import { agentSessionChanges } from '../../../lib/ipc'
import { fmtTime } from './MessageList'
import type { AssistantChatController } from './useAssistantChat'
import type { SessionFileChange } from '../../../types'

/**
 * 左栏 AI 会话侧栏（v3.4.0 批次5 反馈轮，开发负责人 drawio 简图排版）：
 * aiChat 标签激活时左栏模块态原位挂载（portal 进 wbModSlot，返回/锁定复用左栏头部）。
 *
 * 结构 = 双 Tab（会话列表 / 会话大纲）+ 主体 + 底部「文件改动」卡（本会话 AI 写审计）。
 * 取代 page 态对话区内的 overlay 抽屉（实机反馈：抽屉浮层遮空态文字、层次混乱）。
 * 会话数据复用 AiChatTab 的 useAssistantChat 控制器（真源在主进程）。
 */

const POLL_MS = 30_000

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
}

export function AiChatSidebar({ chat, active, container }: Props) {
  const [tab, setTab] = useState<'sessions' | 'outline'>('sessions')
  const [changes, setChanges] = useState<SessionFileChange[]>([])
  const { sessions, activeId, messages, pending } = chat

  // 文件改动（本会话）：activeId 变化 / 轮询 / 回复完成后刷新
  const refreshChanges = useCallback(async () => {
    if (!activeId) { setChanges([]); return }
    try { setChanges(await agentSessionChanges(activeId)) } catch { /* 保持旧数据 */ }
  }, [activeId])
  useEffect(() => { void refreshChanges() }, [refreshChanges, messages.length])
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => void refreshChanges(), POLL_MS)
    return () => window.clearInterval(t)
  }, [active, refreshChanges])

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
      {/* 双 Tab（会话列表 / 会话大纲） */}
      <div className="flex shrink-0 gap-1 px-2 pb-1.5 pt-1">
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
                  className={`kb-item-in group flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-[12px] transition-colors ${
                    activeId === sess.id
                      ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{sess.title}</span>
                    <span className="block text-[10px] text-[var(--text-disabled)]">{fmtTime(sess.updatedAt)}</span>
                  </span>
                  <button
                    onClick={e => { e.stopPropagation(); void chat.removeSession(sess.id) }}
                    className={`shrink-0 rounded p-0.5 ${chat.deletingId === sess.id ? 'text-red-400' : 'text-[var(--text-disabled)] opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100'}`}
                    title={chat.deletingId === sess.id ? '再点一次确认删除' : '删除会话'}
                  >
                    <Trash2 size={11} />
                  </button>
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

      {/* 底部：文件改动（本会话 AI 写审计，方案 §3.8；点击直达编辑器） */}
      <div data-wb="aiSideChanges" className="shrink-0 border-t border-[var(--border-color)] px-2 py-1.5">
        <div className="flex items-center gap-1.5 pb-1 text-[10.5px] text-[var(--text-muted)]">
          <FileEdit size={10} />
          文件改动
          <span className="ml-auto">{activeId ? '本会话' : '未选会话'}</span>
        </div>
        {changes.length === 0 ? (
          <div className="pb-0.5 text-[11px] text-[var(--text-muted)]">暂无改动</div>
        ) : (
          <div className="max-h-[132px] space-y-0.5 overflow-y-auto">
            {changes.slice(0, 8).map((c, i) => (
              <button
                key={`${c.at}-${i}`}
                onClick={() => c.file && window.dispatchEvent(new CustomEvent('kb-open-in-editor', { detail: { relPath: c.file } }))}
                disabled={!c.file}
                title={c.file ? `${c.action} · ${c.file}` : c.action}
                className="group/cf flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors enabled:hover:bg-[var(--bg-hover)]"
              >
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9.5px] font-semibold ${
                  c.op === 'A'
                    ? 'bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent)]'
                    : 'bg-[var(--bg-hover)] text-[var(--text-secondary)]'
                }`}>{c.op}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-primary)]">{c.target}</span>
                <span className="shrink-0 text-[9px] text-[var(--text-disabled)]">{c.at.slice(11, 16)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    container,
  )
}
