import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { ArrowDown, Check, Copy, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { MarkdownPreview } from '../MarkdownPreview'
import { showToast } from '../../../lib/toast'
import { copyText } from '../../../lib/ipc'
import { StreamBubble } from './StreamBubble'
import { ToolSummary, type TraceRowView } from './ToolSummary'
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

/** 聚合 assistant 回复的 llm trace 用量，渲染"↑输入 ↓输出 · 合计 tokens"小字。
 *  `.kb-l1` = 容器（ChatBody 根）窄于阈值时先隐它 —— 它是辅助统计，
 *  排序在动作钮文字（`.kb-l2`）之前（N-6，阈值实测见 index.css ⑥）。 */
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
      <span className="kb-l1 text-[var(--text-muted)]" title="本次回复消耗 tokens（↑=上下文输入 ↓=生成输出）">
        ↑{fmtTok(p)} ↓{fmtTok(c)} · {fmtTok(p + c)} tokens
      </span>
    )
  }
  if (hasTotal && t > 0) return <span className="kb-l1 text-[var(--text-muted)]">≈{fmtTok(t)} tokens</span>
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

/** trace → 工具摘要行可用的行视图（「用了 N 个工具」只数工具行，LLM 行以「思考」保留在展开体里） */
function traceRows(steps?: AgentTraceStep[]): TraceRowView[] {
  return (steps ?? []).map((st, j) => ({
    key: `${j}-${st.name ?? 'llm'}`,
    label: st.kind === 'tool' ? toolShortName(st.name) : '思考',
    isTool: st.kind === 'tool',
    ok: st.ok !== false,
    durationMs: st.durationMs,
  }))
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
  /** 空态提示（侧栏与全屏文案不同） */
  emptyHint?: ReactNode
  /** 内容区额外 class（全屏可放宽内边距/加 max-width 居中） */
  className?: string
  /** 「回到底部」浮标开关（正式版台账 F-7，2026-10-05 拍板：只开 aiChat 整页 = ChatBody
   *  variant='page'；悬浮侧栏 / 右栏 docked / AiLearn 不开 —— 开启时外层才包 relative 宿主） */
  jumpBottom?: boolean
}

export function MessageList({
  messages, pending, liveSteps, draft, editing, setEditing, copiedIdx, setCopiedIdx,
  onRegenerate, onEditSubmit, onDeleteMessage, emptyHint, className, jumpBottom = false,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 是否贴底（用户上滚阅读时不再强制拉回）。初始 true：新会话从底部开始 */
  const stickRef = useRef(true)
  /** 不贴底时显示「回到底部」浮标（仅 jumpBottom 开启时消费） */
  const [offBottom, setOffBottom] = useState(false)

  // 跟踪「是否贴底」。流式高频注入下，只有贴底才跟随滚动
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
      stickRef.current = atBottom
      if (jumpBottom) setOffBottom(!atBottom)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [jumpBottom])

  /** 浮标点击 → 回底。instant 而非 smooth：流式下会与贴底跟随 effect 互相打断（抽搐，
   *  同 ai-teaching jumpToBottom 的结论）；末尾补一帧 rAF 兜末条消息尚未提交 DOM 的少滚 */
  const jumpToBottom = (): void => {
    stickRef.current = true
    setOffBottom(false)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => { const c = scrollRef.current; if (c) c.scrollTop = c.scrollHeight })
  }

  // 内容变化 → 贴底才跟随，且**用 instant 而非 smooth**：
  // 流式下这个 effect 每 60ms 触发一次，smooth 动画会与下一次调用互相打断（表现为滚动抽搐）
  const draftSig = draft ? `${draft.text.length}|${draft.items.length}|${draft.thinking.length}` : ''
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, pending, draftSig])

  const list = (
    <div
      ref={scrollRef}
      className={className ?? 'h-full overflow-y-auto px-3 py-3 space-y-2'}
    >
      {messages.length === 0 && !pending && emptyHint}
      {messages.map((m, i) => (
        <div key={m.id ?? `live-${i}`} data-msg-id={m.id ?? undefined} className="group/msg">
          {m.role === 'assistant' ? (
            <>
              {/* 过程收起来（R8）：工具清单折成一行摘要，默认收起 —— 原先这里是消息下方的
                  「调用轨迹（N 步）」虚线框，生成中已经完全不显示工具了，完成后再铺回来是重复 */}
              <ToolSummary rows={traceRows(m.trace)} />
              {/* 去气泡（docs/code-block-card-plan.md §2.2 末段 / §7-3 改后 B）：助手侧与 AI 教学一样
                 平铺 markdown 原生排版 —— 否则代码卡片自带 bg + 边框，在这一面变成「框中框」。
                 ★ 下面这几样**一个都不能顺手删**：select-text（body 全局 user-select:none，删了
                   整条消息选不中）、外层 group/msg（操作条 group-hover/msg 的宿主）、
                   data-msg-id（会话大纲定位选择器）、`[&_pre]…` 那组宽内容安全网、
                   .kb-l1 / .kb-l2 容器查询标记。删了都不报错，只会静默坏掉。 */}
              <div className="text-[12px] leading-relaxed break-words select-text cursor-text [&_.prose-content>:first-child]:mt-0 [&_.prose-content>:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_table]:block [&_table]:overflow-x-auto">
                <MarkdownPreview content={m.content} codeBlockChrome="card" />
              </div>
            </>
          ) : (
            /* 改后 B：用户气泡也换成 AI 教学那套（accent 底 + 右对齐 + 圆角小尾角 + max-w-86%），
               两面完全一致。**字号不跟 AI 教学抬到 13px** —— 这一面整条排版尺度低一档
               （正文 12px / 消息间距 8px），单独把用户气泡抬成最大字反而更不协调。 */
            <div className="flex justify-end">
              <div className="max-w-[86%] min-w-0 select-text bg-[var(--accent)] text-white rounded-xl rounded-br-sm px-3 py-2 text-[12px] leading-relaxed break-words whitespace-pre-wrap">
                {m.content}
              </div>
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
            <div className={`flex items-center gap-1.5 px-1 mt-0.5 text-[10px] text-[var(--text-disabled)] ${m.role === 'user' ? 'justify-end' : 'justify-start -ml-1.5'}`}>
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
                <span className="kb-l2">{copiedIdx === i ? '已复制' : '复制'}</span>
              </button>
              {m.role === 'user' && m.id && !pending && (
                <button onClick={() => setEditing({ id: m.id!, draft: m.content })}
                  className="flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity hover:text-[var(--text-primary)]"
                  title="编辑并重新生成">
                  <Pencil size={10} /> <span className="kb-l2">编辑</span>
                </button>
              )}
              {m.role === 'assistant' && i === messages.length - 1 && !pending && m.id && (
                <button onClick={onRegenerate}
                  className="flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity hover:text-[var(--text-primary)]"
                  title="重新生成">
                  <RefreshCw size={10} /> <span className="kb-l2">重新生成</span>
                </button>
              )}
              {m.role === 'assistant' && m.id && !pending && (
                <button onClick={() => onDeleteMessage(m.id!)}
                  className="flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity hover:text-red-400"
                  title="删除该回复">
                  <Trash2 size={10} /> <span className="kb-l2">删除</span>
                </button>
              )}
            </div>
          )}
        </div>
      ))}

      {pending && (draft ? (
        /* 流式过程（生成态）：状态行 + 下滑条 + 思考行 + 正文增量（docs/ai-reply-loading-plan.md §3） */
        <StreamBubble draft={draft} />
      ) : (
        /* 兜底：无流式草稿时（如流式被设置关闭）沿用**同一套状态行**，否则过程中会闪一下旧样式。
           旧版这里还有一个停止按钮，一并去掉 —— 停止入口只在输入区（R7）。 */
        <div className="kb-gen-row">
          <span className="kb-stage">
            <span className="stage-label"><AgentLiveSteps steps={liveSteps} /></span>
            <span className="kb-sweep" />
          </span>
        </div>
      ))}

      {/* 浮标占位（F-7）：浮标 absolute 不占流，底部预留 12（py-3）+ 36 = 48px，对齐 AI 教学款 */}
      {jumpBottom && <div className="h-9" aria-hidden />}
    </div>
  )

  // 「回到底部」浮标宿主：只有 jumpBottom 开启（page 态）才包 relative 层 ——
  // AiLearn 把本组件根直接当 flex 子项用（flex-1 写在 className 里），无条件包会断它的高度链。
  if (!jumpBottom) return list
  return (
    <div className="relative h-full">
      {list}
      {offBottom && (
        <button type="button" onClick={jumpToBottom} title="回到底部" aria-label="回到底部"
          className="kb-pop absolute right-3 bottom-3 z-20 w-9 h-9 rounded-full flex items-center justify-center bg-[var(--bg-primary)] text-[var(--text-secondary)] shadow-lg hover:text-[var(--text-primary)] transition-colors">
          <ArrowDown size={16} strokeWidth={1.75} />
        </button>
      )}
    </div>
  )
}
