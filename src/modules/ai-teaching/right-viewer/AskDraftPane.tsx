/**
 * 右侧活动栏 · 旁问页签的**草稿态**（首问前不落库）
 *
 * 语义（PLAN §8.2）：草稿只在页签对象里，不调 `agent:createSideLane`、不写 sessions.json、
 * 不进历史列表、刷新即消失。**发出第一个问题**时才：
 *   1. `agentCreateSideLane(parentSessionId, anchorMessageId, sideScope, title)`（标题 = 首问截 16 字）；
 *   2. `beginRun(laneId)` 后 `agentChat`（复用 N-3 会话桶，消息流 / 停止按钮与详情态同一套）；
 *   3. `onLaneReady(laneId, title)` → 壳把 `laneId` / 标题写回页签并持久化，草稿置 null。
 * 关掉未提问的草稿 = 直接丢弃，不写库、无确认（草稿本来就可弃）。
 *
 * 为什么单独一个文件而不是塞进 `AskPane`：详情态是 `SideLanePanel`（既有组件、既有契约），
 * 草稿态是另一套生命周期（先建后发）。分开放，`AskPane` 只做二选一，两边都不会互相污染。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Sparkles } from 'lucide-react'
import { agentChat, agentCreateSideLane, agentMarkSideLaneRead } from '../../../lib/ipc'
import { beginRun, endRun } from '../../../lib/assistantRunStore'
import { showToast } from '../../../lib/toast'
import type { AskDraft } from './viewerTabs'
import { draftTitle, firstQuestionTitle } from './viewerTabs'

export interface AskDraftPaneProps {
  parentSessionId: string
  parentTitle: string
  draft: AskDraft
  rootId: string
  /** 首问落库成功 → 壳写回页签（laneId + 标题）并持久化 */
  onLaneReady: (laneId: string, title: string) => void
}

const SCOPE_LABEL: Record<string, string> = {
  conversation: '整段',
  anchor: '锚定',
  selection: '选区',
}

export function AskDraftPane({ parentSessionId, parentTitle, draft, rootId, onLaneReady }: AskDraftPaneProps) {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || sending) return
    if (!rootId || !parentSessionId) {
      showToast({ type: 'warning', message: '先进入一个 AI 教学对话' })
      return
    }
    setSending(true)
    const title = firstQuestionTitle(text)
    const created = await agentCreateSideLane(
      parentSessionId,
      draft.anchorMessageId || null,
      draft.sideScope,
      title,
    ).catch(() => null)
    if (!created || !created.ok || !created.laneSessionId) {
      setSending(false)
      showToast({ type: 'error', message: '旁问没能创建', detail: created?.error })
      return
    }
    const laneId = created.laneSessionId
    const laneTitle = (created.title ?? '').trim() || title
    // 先登记运行态再通知壳：详情态一挂上就能看到「正在等待模型响应」，不会闪一帧空态
    beginRun(laneId)
    void agentMarkSideLaneRead(laneId).catch(() => undefined)
    onLaneReady(laneId, laneTitle)
    const cid = crypto.randomUUID()
    setInput('')
    void agentChat(laneId, text, undefined, cid, 'aiTeaching')
      .then((r) => {
        if (r && !r.ok && r.code !== 'USER_ABORTED') {
          showToast({ type: 'error', message: `旁问调用失败：${r.error ?? ''}` })
        }
      })
      .catch((e) => {
        showToast({ type: 'error', message: `旁问调用失败：${(e as Error).message || ''}` })
      })
      .finally(() => { endRun(laneId) })
  }, [input, sending, rootId, parentSessionId, draft, onLaneReady])

  if (!parentSessionId) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-4">
        <div className="max-w-[260px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-3 text-center">
          <div className="text-[12px] font-medium text-[var(--text-primary)]">这条旁问没有来源对话</div>
          <div className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
            从回答下点「追问」，或从 <span className="text-[var(--text-secondary)]">+ → 旁问</span> 重新开一条。
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 动作行：作用域 badge + 来源对话（不加「草稿」标签 —— 铁律 26） */}
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[var(--border-color)] px-2">
        <span className="shrink-0 rounded-full bg-[var(--accent)]/10 px-1.5 py-px text-[9.5px] font-medium text-[var(--accent)]">
          {SCOPE_LABEL[draft.sideScope] ?? '整段'}
          {draft.sideScope === 'anchor' && draft.anchorOrdinal ? ` · 第 ${draft.anchorOrdinal} 条` : ''}
        </span>
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--text-muted)]" data-tip={parentTitle}>
          {parentTitle ? `来自：${parentTitle}` : draftTitle(draft)}
        </span>
      </div>

      {draft.excerpt && (
        <div className="shrink-0 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-1.5">
          <div className="line-clamp-3 break-words text-[10.5px] leading-[1.55] text-[var(--text-muted)]">
            {draft.excerpt}
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-5 text-center">
        <Sparkles size={22} strokeWidth={1.5} className="mb-2 text-[var(--text-muted)]" />
        <div className="text-[12.5px] font-medium text-[var(--text-primary)]">
          还没有提问
          <span className="ml-1.5 text-[10.5px] font-normal text-[var(--text-muted)]">· 发出后才会保存，关掉不留记录</span>
        </div>
      </div>

      {/* composer：与详情态同一条输入形态（贴底、Enter 发送） */}
      <div className="shrink-0 px-2.5 pt-1 pb-2.5">
        <div className="rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 pt-2 pb-1.5">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            rows={2}
            spellCheck={false}
            disabled={sending}
            placeholder="发出第一个问题…"
            aria-label="旁问输入"
            className="max-h-32 w-full resize-none bg-transparent px-0.5 py-1 text-[12.5px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none disabled:opacity-60"
          />
          <div className="mt-0.5 flex items-center justify-end">
            <button
              type="button"
              onClick={() => void send()}
              disabled={!input.trim() || sending}
              data-tip="发送"
              aria-label="发送"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-white transition-opacity hover:opacity-90 disabled:opacity-30"
            >
              <ArrowUp size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
