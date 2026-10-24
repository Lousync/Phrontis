import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { ArrowDown, Check, Copy, Pencil, Play, RefreshCw, Trash2 } from 'lucide-react'
import { MarkdownPreview } from '../MarkdownPreview'
import { showToast } from '../../../lib/toast'
import { copyText } from '../../../lib/ipc'
import { StreamBubble } from './StreamBubble'
import { ProcessSummary, type TraceRowView } from './ProcessSummary'
import { ImageCard, imageGroupsOf } from './ImageCard'
import type { StreamDraft } from './useAgentStream'
import type { AgentTraceStep, ResumeInfo } from '../../../types'
import { toolActionLabel } from '../../../lib/toolLabels'

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
 *  排序在动作钮文字（`.kb-l2`）之前（N-6，阈值实测见 index.css ⑥）。
 *  v3.9.0：llm step 带 `costUsd`（主进程按价目表算好）时追加「· $x 估算」；无价目/旧 trace 只有 tokens。 */
function fmtCostUsd(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

function TokensOf({ trace }: { trace?: AgentTraceStep[] }): ReactNode {
  if (!trace || trace.length === 0) return null
  const llm = trace.filter(s => s.kind === 'llm')
  if (llm.length === 0) return null
  let p = 0, c = 0, hasSplit = false, t = 0, hasTotal = false, cost = 0, hasCost = false
  for (const s of llm) {
    if (typeof s.promptTokens === 'number') { p += s.promptTokens; hasSplit = true }
    if (typeof s.completionTokens === 'number') { c += s.completionTokens; hasSplit = true }
    if (typeof s.tokens === 'number') { t += s.tokens; hasTotal = true }
    if (typeof s.costUsd === 'number') { cost += s.costUsd; hasCost = true }
  }
  const costText = hasCost ? ` · ${fmtCostUsd(cost)} 估算` : ''
  if (hasSplit && (p > 0 || c > 0)) {
    return (
      <span className="kb-l1 text-[var(--text-muted)]" title="本次回复消耗 tokens（↑=上下文输入 ↓=生成输出）与估算费用（按内置价目表，非账单）">
        ↑{fmtTok(p)} ↓{fmtTok(c)} · {fmtTok(p + c)} tokens{costText}
      </span>
    )
  }
  if (hasTotal && t > 0) return <span className="kb-l1 text-[var(--text-muted)]">≈{fmtTok(t)} tokens{costText}</span>
  return null
}

/** 实时状态行（agent:step 驱动）：无步骤=思考中；最新为工具=正在调用；失败则显示重试中 */
function AgentLiveSteps({ steps }: { steps: AgentTraceStep[] }) {
  const last = steps[steps.length - 1]
  if (!last) return <>正在思考…</>
  const toolCount = steps.filter(s => s.kind === 'tool').length
  if (last.kind === 'tool') {
    if (!last.ok) return <>执行 {toolActionLabel(last.name)} 失败，正在调整策略…</>
    return <>正在调用 <span className="text-[var(--accent)]">{toolActionLabel(last.name)}</span>（第 {toolCount} 次工具调用）</>
  }
  return <>思考中…（已调用 {toolCount} 次工具）</>
}

/** trace → 完成态过程摘要的行视图（思考行只在有 thinkingMs 时出现） */
function traceRows(steps?: AgentTraceStep[]): TraceRowView[] {
  return (steps ?? []).flatMap((st, j): TraceRowView[] => {
    if (st.kind === 'tool') {
      return [{
        key: `${j}-${st.name ?? 'tool'}`,
        kind: 'tool' as const,
        label: toolActionLabel(st.name),
        ok: st.ok !== false,
        durationMs: st.durationMs,
      }]
    }
    if (!st.thinkingMs || st.thinkingMs <= 0) return []
    return [{
      key: `${j}-llm`,
      kind: 'think' as const,
      label: '思考',
      ok: st.ok !== false,
      durationMs: st.thinkingMs,
    }]
  })
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
  /**
   * A 方案（断点续跑）：本会话最近一次中断留下的可续现场（来自 useAssistantChat 的 resumeInfo）。
   * 只有 `resumeInfo.messageId === 那条消息 id` 才出「继续」—— 别的消息上没有可续的断点。
   */
  resumeInfo?: ResumeInfo | null
  onResume?: () => void
  onEditSubmit: (id: string, content: string) => void
  onDeleteMessage: (id: string) => void
  /** 空态提示（侧栏与全屏文案不同） */
  emptyHint?: ReactNode
  /** 内容区额外 class（全屏可放宽内边距/加 max-width 居中） */
  className?: string
  /** 「回到底部」浮标开关（正式版台账 F-7，2026-10-05 拍板：只开 aiChat 整页 = ChatBody
   *  variant='page'；悬浮侧栏 / 右栏 docked / AiLearn 不开 —— 开启时外层才包 relative 宿主） */
  jumpBottom?: boolean
  /** 生图卡「改图 / 重试」：把文本填回输入框（入口是对话，卡上没有插入按钮 —— 决策 D3） */
  onPrefillImage?: (text: string) => void
  /** 生图卡「停止生成」（C3 生成期常显；A6 = 前端断开 + 主进程 abort，不落盘） */
  onStopRun?: () => void
}

export function MessageList({
  messages, pending, liveSteps, draft, editing, setEditing, copiedIdx, setCopiedIdx,
  onRegenerate, resumeInfo, onResume, onEditSubmit, onDeleteMessage, emptyHint, className, jumpBottom = false,
  onPrefillImage, onStopRun,
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
  const draftSig = draft ? `${draft.text.length}|${draft.items.length}|${draft.rev}` : ''
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, pending, draftSig])

  /**
   * 生成中的生图卡（v3.6.0）：数据源是 `agent:step` 的**跑动事件**，不是 StreamBubble 的
   * ProcessItem —— 后者只有 name/label/state，拿不到 aspect/prompt，而占位框要靠 aspect
   * 与成品同比例（不跳版）、要靠 prompt 说明"在画什么"。
   *
   * 三种跑动事件在这里各归各位：占位（durationMs 0、无 artifact）→ 生成中卡；
   * 成功（带 artifact）→ 成品卡；失败（ok:false）→ 失败档。运行结束后 liveSteps 清空，
   * 同一批内容改由落库的 `m.trace` 渲染（两处不会同时出现，因为本轮消息在刷新前还不在 messages 里）。
   */
  const liveImages = useMemo(() => {
    const steps = liveSteps.filter((s) => s.name === 'image')
    const done = steps.filter((s) => s.durationMs > 0)
    const groups = imageGroupsOf(done.filter((s) => s.ok))
    const errors = done.filter((s) => !s.ok)
    let pendingArgs: { prompt?: string; aspect?: string; ref?: string } | null = null
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i]
      if (s.durationMs === 0 && !s.artifact) {
        pendingArgs = {
          prompt: typeof s.args?.prompt === 'string' ? s.args.prompt : '',
          aspect: typeof s.args?.aspect === 'string' ? s.args.aspect : '',
          ref: typeof s.args?.ref === 'string' ? s.args.ref : '',
        }
        break
      }
      break // 最后一条 image 步骤已经是完成态 ⇒ 没有"还在生成"的图
    }
    return { pendingArgs, groups, errors }
  }, [liveSteps])

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
              {/* 过程收起来（默认收起）：思考时长 + 工具清单折成一行，点开是事件流 */}
              <ProcessSummary rows={traceRows(m.trace)} />
              {/* 去气泡（docs/code-block-card-plan.md §2.2 末段 / §7-3 改后 B）：助手侧与 AI 教学一样
                 平铺 markdown 原生排版 —— 否则代码卡片自带 bg + 边框，在这一面变成「框中框」。
                 ★ 下面这几样**一个都不能顺手删**：select-text（body 全局 user-select:none，删了
                   整条消息选不中）、外层 group/msg（操作条 group-hover/msg 的宿主）、
                   data-msg-id（会话大纲定位选择器）、`[&_pre]…` 那组宽内容安全网、
                   .kb-l1 / .kb-l2 容器查询标记。删了都不报错，只会静默坏掉。 */}
              <div className="text-[12px] leading-relaxed break-words select-text cursor-text [&_.prose-content>:first-child]:mt-0 [&_.prose-content>:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_table]:block [&_table]:overflow-x-auto">
                <MarkdownPreview content={m.content} codeBlockChrome="card" />
              </div>
              {/* 生图卡（v3.6.0）：数据源 = 落库的 trace.artifact ⇒ 刷新 / 重启后卡片还在。
                  放在正文之后 —— 正文是"一句话交代"，图是产物本身（方案 §3.1） */}
              {imageGroupsOf(m.trace).map((group, gi) => (
                <div key={`img-${gi}`} className="mt-1.5">
                  <ImageCard artifact={group[group.length - 1]} versions={group} onPrefill={onPrefillImage} />
                </div>
              ))}
              {/* 失败档（A8）：图位留空 + 一行字 + 重试 —— 失败步骤落库时带了 args.prompt（见 agentService） */}
              {(m.trace ?? []).filter((s) => s.name === 'image' && s.ok === false).map((s, si) => (
                <div key={`imgerr-${si}`} className="mt-1.5">
                  <ImageCard error={String(s.summary ?? '生图失败')}
                    errorPrompt={typeof s.args?.prompt === 'string' ? s.args.prompt : ''}
                    onPrefill={onPrefillImage} />
                </div>
              ))}
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
              {/* A 方案：只有「挂着可续现场的那条中断消息」才有「继续」（现场由主进程 claim 一次） */}
              {m.role === 'assistant' && m.id && !pending && onResume && resumeInfo && resumeInfo.messageId === m.id && (
                <button onClick={onResume}
                  className="flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity hover:text-[var(--text-primary)]"
                  title={resumeInfo.reason ? `从断点继续（上次中断：${resumeInfo.reason}）` : '从断点继续'}>
                  <Play size={9} /> <span className="kb-l2">继续</span>
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

      {/* 生图（生成态）：占位框在**状态行下方**单独一档 —— 它是"图位"，不是过程文本的一部分。
          停止钮在图上常显（C3），与输入区那颗停止键并存（那颗停的是整轮）。 */}
      {pending && liveImages.pendingArgs && (
        <div className="mt-1">
          <ImageCard pending={liveImages.pendingArgs} onStop={onStopRun} />
        </div>
      )}
      {pending && liveImages.groups.map((group, gi) => (
        <div key={`live-img-${gi}`} className="mt-1">
          <ImageCard artifact={group[group.length - 1]} versions={group} onPrefill={onPrefillImage} />
        </div>
      ))}
      {pending && liveImages.errors.map((s, si) => (
        <div key={`live-imgerr-${si}`} className="mt-1">
          <ImageCard error={String(s.summary ?? '生图失败')}
            errorPrompt={typeof s.args?.prompt === 'string' ? s.args.prompt : ''}
            onPrefill={onPrefillImage} />
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
