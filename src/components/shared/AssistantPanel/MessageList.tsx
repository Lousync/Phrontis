import { useEffect, useRef, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { Bot, Check, Copy, Loader2, Pencil, RefreshCw, Square, Trash2, Wrench } from 'lucide-react'
import { MarkdownPreview } from '../MarkdownPreview'
import { showToast } from '../../../lib/toast'
import { copyText } from '../../../lib/ipc'
import { StreamBubble } from './StreamBubble'
import type { StreamDraft } from './useAgentStream'
import type { AgentTraceStep } from '../../../types'

/**
 * 共用消息流（侧栏 AI 与 AI 学堂全屏对话同一份渲染，避免两套逻辑分叉）。
 *
 * 从 AssistantPanel/index.tsx 抽出（2026-09-10 P1）。调用方负责给足高度的父容器；
 * 本组件自带滚动条与「新消息滚到底」行为。
 */

export interface UiMessage {
  id?: string
  role: 'user' | 'assistant'
  content: string
  trace?: AgentTraceStep[]
  createdAt?: string
}

/** 'YYYY-MM-DD HH:MM:SS' → 今天只显示 HH:mm，更早显示 MM-DD HH:mm */
export function fmtTime(raw?: string | null): string {
  if (!raw) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(raw)
  if (!m) return raw.slice(5, 16)
  const d = new Date()
  const sameDay = Number(m[1]) === d.getFullYear() && Number(m[2]) === d.getMonth() + 1 && Number(m[3]) === d.getDate()
  return sameDay ? `${m[4]}:${m[5]}` : `${m[2]}-${m[3]} ${m[4]}:${m[5]}`
}

/** 数字 → 友好 token 文本（≥1k 显示 k） */
function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)
}

/** 聚合 assistant 回复的 llm trace 用量，渲染"↑输入 ↓输出 · 合计 tokens"小字 */
function TokensOf({ trace }: { trace?: AgentTraceStep[] }): ReactNode {
  if (!trace || trace.length === 0) return null
  const llm = trace.filter(s => s.kind === 'llm')
  if (llm.length === 0) return null
  let p = 0, c = 0, hasSplit = false, t = 0, hasTotal = false
  for (const s of llm) {
    if (typeof s.promptTokens === 'number') { p += s.promptTokens; hasSplit = true }
    if (typeof s.completionTokens === 'number') { c += s.completionTokens; hasSplit = true }
    if (typeof s.tokens === 'number') { t += s.tokens; hasTotal = true }
  }
  if (hasSplit && (p > 0 || c > 0)) {
    return (
      <span className="text-[var(--text-muted)]" title="本次回复消耗 tokens（↑=上下文输入 ↓=生成输出）">
        ↑{fmtTok(p)} ↓{fmtTok(c)} · {fmtTok(p + c)} tokens
      </span>
    )
  }
  if (hasTotal && t > 0) return <span className="text-[var(--text-muted)]">≈{fmtTok(t)} tokens</span>
  return null
}

/** 工具名可读化：builtin.vault.read → vault.read */
function toolShortName(name?: string): string {
  const s = String(name ?? '')
  return s.startsWith('builtin.') ? s.slice(8) : s || '工具'
}

/** 实时状态行（agent:step 驱动）：无步骤=思考中；最新为工具=正在调用；失败则显示重试中 */
function AgentLiveSteps({ steps }: { steps: AgentTraceStep[] }) {
  const last = steps[steps.length - 1]
  if (!last) return <>正在思考…</>
  const toolCount = steps.filter(s => s.kind === 'tool').length
  if (last.kind === 'tool') {
    if (!last.ok) return <>执行 {toolShortName(last.name)} 失败，正在调整策略…</>
    return <>正在调用 <span className="text-[var(--accent)]">{toolShortName(last.name)}</span>（第 {toolCount} 次工具调用）</>
  }
  return <>思考中…（已调用 {toolCount} 次工具）</>
}

function TraceBlock({ steps }: { steps: AgentTraceStep[] }) {
  return (
    <details className="mr-6 mt-1 text-[11px] px-2.5 py-1.5 rounded-md border border-dashed border-[var(--border-color)] text-[var(--text-muted)]">
      <summary className="cursor-pointer select-none">调用轨迹（{steps.length} 步）</summary>
      <ul className="mt-1.5 space-y-1">
        {steps.map((st, j) => (
          <li key={j} className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${st.ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
            {st.kind === 'tool' ? <Wrench size={10} /> : <Bot size={10} />}
            <code className="truncate">{st.name ?? 'LLM'}</code>
            <span className="ml-auto tabular-nums shrink-0">{st.durationMs}ms{st.tokens ? ` · ${st.tokens}tok` : ''}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

export interface MessageListProps {
  messages: UiMessage[]
  pending: boolean
  liveSteps: AgentTraceStep[]
  /** 流式过程草稿（思考链 / 过程时间线 / 正文增量）。为空时回落到旧的固定文案气泡 */
  draft?: StreamDraft | null
  /** 行内编辑用户消息：目标 id + 草稿 */
  editing: { id: string; draft: string } | null
  setEditing: (v: { id: string; draft: string } | null) => void
  copiedIdx: number | null
  setCopiedIdx: Dispatch<SetStateAction<number | null>>
  onRegenerate: () => void
  onEditSubmit: (id: string, content: string) => void
  onDeleteMessage: (id: string) => void
  onAbort: () => void
  /** 空态提示（侧栏与全屏文案不同） */
  emptyHint?: ReactNode
  /** 内容区额外 class（全屏可放宽内边距/加 max-width 居中） */
  className?: string
}

export function MessageList({
  messages, pending, liveSteps, draft, editing, setEditing, copiedIdx, setCopiedIdx,
  onRegenerate, onEditSubmit, onDeleteMessage, onAbort, emptyHint, className,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 是否贴底（用户上滚阅读时不再强制拉回）。初始 true：新会话从底部开始 */
  const stickRef = useRef(true)

  // 跟踪「是否贴底」。流式高频注入下，只有贴底才跟随滚动
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // 内容变化 → 贴底才跟随，且**用 instant 而非 smooth**：
  // 流式下这个 effect 每 60ms 触发一次，smooth 动画会与下一次调用互相打断（表现为滚动抽搐）
  const draftSig = draft ? `${draft.text.length}|${draft.items.length}|${draft.thinking.length}` : ''
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, pending, draftSig])

  return (
    <div
      ref={scrollRef}
      className={className ?? 'h-full overflow-y-auto px-3 py-3 space-y-2'}
    >
      {messages.length === 0 && !pending && emptyHint}
      {messages.map((m, i) => (
        <div key={m.id ?? `live-${i}`} data-msg-id={m.id ?? undefined} className="group/msg">
          {m.role === 'assistant' ? (
            <div className="mr-6 px-3 py-2 rounded-lg text-[12px] leading-relaxed break-words select-text cursor-text bg-[var(--bg-secondary)] border border-[var(--border-color)] [&_.prose-content>:first-child]:mt-0 [&_.prose-content>:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_table]:block [&_table]:overflow-x-auto">
              <MarkdownPreview content={m.content} />
            </div>
          ) : (
            <div className="ml-6 px-3 py-2 rounded-lg text-[12px] leading-relaxed whitespace-pre-wrap break-words select-text cursor-text bg-[var(--bg-selected)] border border-[var(--border-color)]">
              {m.content}
            </div>
          )}

          {editing != null && editing.id != null && editing.id === m.id ? (
            <div className="ml-6 mt-1 space-y-1.5">
              <textarea
                value={editing.draft}
                onChange={e => setEditing({ ...editing, draft: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (editing.draft.trim()) onEditSubmit(m.id!, editing.draft.trim()) } }}
                rows={3}
                autoFocus
                className="w-full px-2.5 py-2 rounded-md border border-[var(--accent)] bg-[var(--input-bg)] text-[12px] resize-none outline-none"
              />
              <div className="flex items-center gap-1.5">
                <button onClick={() => { if (editing.draft.trim()) onEditSubmit(m.id!, editing.draft.trim()) }}
                  className="px-2 py-0.5 rounded text-[11px] bg-[var(--accent)] text-white hover:opacity-90 transition-opacity">保存并重新生成</button>
                <button onClick={() => setEditing(null)}
                  className="px-2 py-0.5 rounded text-[11px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">取消</button>
              </div>
            </div>
          ) : (
            <div className={`flex items-center gap-1.5 px-1 mt-0.5 text-[10px] text-[var(--text-disabled)] ${m.role === 'user' ? 'justify-end ml-6' : 'justify-start mr-6'}`}>
              {m.createdAt && <span>{fmtTime(m.createdAt)}</span>}
              {m.role === 'assistant' && <TokensOf trace={m.trace} />}
              <button
                onClick={async () => {
                  const okFlag = await copyText(m.content)
                  if (okFlag) {
                    setCopiedIdx(i)
                    setTimeout(() => setCopiedIdx(cur => (cur === i ? null : cur)), 1500)
                  } else showToast({ type: 'error', message: '复制失败' })
                }}
                className={`flex items-center gap-0.5 transition-opacity hover:text-[var(--text-primary)] ${copiedIdx === i ? 'opacity-100' : 'opacity-0 group-hover/msg:opacity-100'}`}
                title="复制">
                {copiedIdx === i ? <Check size={10} className="text-emerald-400" /> : <Copy size={10} />}
                {copiedIdx === i ? '已复制' : '复制'}
              </button>
              {m.role === 'user' && m.id && !pending && (
                <button onClick={() => setEditing({ id: m.id!, draft: m.content })}
                  className="flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity hover:text-[var(--text-primary)]"
                  title="编辑并重新生成">
                  <Pencil size={10} /> 编辑
                </button>
              )}
              {m.role === 'assistant' && i === messages.length - 1 && !pending && m.id && (
                <button onClick={onRegenerate}
                  className="flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity hover:text-[var(--text-primary)]"
                  title="重新生成">
                  <RefreshCw size={10} /> 重新生成
                </button>
              )}
              {m.role === 'assistant' && m.id && !pending && (
                <button onClick={() => onDeleteMessage(m.id!)}
                  className="flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity hover:text-red-400"
                  title="删除该回复">
                  <Trash2 size={10} /> 删除
                </button>
              )}
            </div>
          )}

          {m.trace && m.trace.length > 0 && <TraceBlock steps={m.trace} />}
        </div>
      ))}

      {pending && (draft ? (
        /* 流式过程气泡：思考区 + 工具时间线 + 正文增量（docs/ai-streaming-design.md §5.3.4） */
        <StreamBubble draft={draft} onAbort={onAbort} />
      ) : (
        /* 兜底：无流式草稿时（如流式被设置关闭）沿用固定文案气泡 */
        <div className="mr-6 px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)] flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
          <Loader2 size={13} className="animate-spin shrink-0" />
          <span className="flex-1 min-w-0"><AgentLiveSteps steps={liveSteps} /></span>
          <button
            onClick={onAbort}
            className="flex items-center gap-1 px-2 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-red-400 hover:border-red-400/50 transition-colors shrink-0"
            title="中断当前请求与工具循环">
            <Square size={9} className="fill-current" /> 停止
          </button>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
