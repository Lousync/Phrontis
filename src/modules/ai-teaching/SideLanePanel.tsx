import { useCallback, useEffect, useRef, useState } from 'react'
import { agentAbort, agentChat, agentCreateSideLane, agentDeleteSession, agentMessages, agentSessions } from '../../lib/ipc'
import { MarkdownPreview } from '../../components/shared/MarkdownPreview'
import { StreamBubble } from '../../components/shared/AssistantPanel/StreamBubble'
import { useAgentStream } from '../../components/shared/AssistantPanel/useAgentStream'
import { showToast } from '../../lib/toast'
import type { AgentStoredMessage, AgentTraceStep } from '../../types'
import { ArrowLeft, ArrowUp, Check, ChevronDown, Copy, Loader2, Maximize2, Minimize2, Send, Sparkles, X } from 'lucide-react'

/**
 * 支线旁问面板（v3.1.2 条目11）。
 *
 * 定位：主线对话里对某条回答的某一点有疑问时，开一条**独立的深挖线**，不打断主线节奏。
 * 关键设计（原型已定稿 2026-09-14）：
 * - **上下文就地装载**：面板打开的瞬间即调用 `agent:createSideLane` 固化快照并展示在顶部，
 *   「可见即可信」便于核对；**装载阶段零 LLM 请求**（天然避开「场景自动空发」的毛病）。
 * - **物理隔离**：支线 = 独立 sessionId + 独立 .jsonl，主线消息数与上下文**完全不变**。
 * - **轮数可调**：1 / 3 / 5，默认 3；**仅发送前生效**（发送后锁定，避免快照与既有对话不一致）。
 * - 双形态由父级容器决定（浮层 / 右栏宽轨），本组件只负责内容，填满容器高度。
 */

const TURNS_KEY = 'aiTeach.sideLaneTurns'
const TURN_OPTIONS = [1, 3, 5] as const

function readTurns(): number {
  try {
    const v = Number(localStorage.getItem(TURNS_KEY))
    return TURN_OPTIONS.includes(v as 1 | 3 | 5) ? v : 3
  } catch { return 3 }
}

export interface SideLanePanelProps {
  parentSessionId: string
  /** 主线标题（面板头展示「支线 · 来自 <主线>」） */
  parentTitle: string
  /** 分叉点消息 id（那个被追问的回答） */
  anchorMessageId: string
  /** 已存在的支线 id：给了它就**跳过创建**、直接载入该支线（从「查看支线」重新打开） */
  openLaneId?: string
  /** 关闭面板 */
  onClose: () => void
  /** 切换形态：浮层 ⇄ 右栏宽轨（两种呈现同一条支线，不重建会话、不丢内容） */
  onToggleWide?: () => void
  /** 支线就绪（拿到 laneSessionId 与标题）——父级用于「查看支线」映射与升格 */
  onLaneReady?: (laneSessionId: string, laneTitle: string) => void
  /** P3 带回主线：用户在编辑框确认后的最终文本 */
  onBringBack?: (laneSessionId: string, laneTitle: string, text: string) => void
  /** P4 升格为正式会话 */
  onPromote?: (laneSessionId: string) => void
  /** 宽轨形态（父级容器已决定宽度，这里只影响留白与折行） */
  wide?: boolean
}

interface PanelMsg {
  id?: string
  role: 'user' | 'assistant'
  content: string
  createdAt?: string
}

export function SideLanePanel({ parentSessionId, parentTitle, anchorMessageId, openLaneId, onClose, onToggleWide, onLaneReady, onBringBack, onPromote, wide }: SideLanePanelProps) {
  const chatIdRef = useRef('')
  const { draft: streamDraft, begin: beginStream, end: endStream } = useAgentStream(chatIdRef)

  const [laneId, setLaneId] = useState<string | null>(openLaneId ?? null)
  const [laneTitle, setLaneTitle] = useState('')
  const [snapshot, setSnapshot] = useState('')
  const [turns, setTurns] = useState<number>(() => readTurns())
  const [messages, setMessages] = useState<PanelMsg[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [ctxOpen, setCtxOpen] = useState(false)
  const [err, setErr] = useState('')
  const [backOpen, setBackOpen] = useState(false)
  const [backDraft, setBackDraft] = useState('')

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /** 已发送过消息 = 上下文锁定（轮数不可再调、快照不再重建） */
  const lockedRef = useRef(false)

  const refresh = useCallback(async (sid: string) => {
    const rows = await agentMessages(sid).catch(() => [] as AgentStoredMessage[])
    setMessages(rows.map(m => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt })))
  }, [])

  // ---- 装载：① 新建支线（纯本地拼快照，不调 LLM）② 或载入既有支线 ----
  useEffect(() => {
    let alive = true
    void (async () => {
      setLoading(true)
      if (openLaneId) {
        // 重新打开既有支线：从会话索引取标题与来源快照（无新 IPC —— listAgentSessions 已带回 sideContext）
        const rows = await agentSessions().catch(() => [])
        const row = rows.find(r => r.id === openLaneId)
        if (!alive) return
        if (!row) { setErr('支线已不存在'); setLoading(false); return }
        setLaneId(openLaneId)
        setLaneTitle(row.title)
        setSnapshot(row.sideContext ?? '')
        lockedRef.current = (await agentMessages(openLaneId).catch(() => [])).length > 0
        await refresh(openLaneId)
        setLoading(false)
        return
      }
      const r = await agentCreateSideLane({ parentSessionId, anchorMessageId, contextTurns: readTurns() })
      if (!alive) return
      if (!r.ok || !r.laneSessionId) {
        setErr(r.error || '支线创建失败')
        setLoading(false)
        return
      }
      setLaneId(r.laneSessionId)
      setLaneTitle(r.title ?? '')
      setSnapshot(r.snapshotText ?? '')
      lockedRef.current = false
      await refresh(r.laneSessionId)
      setLoading(false)
      onLaneReady?.(r.laneSessionId, r.title ?? '')
      inputRef.current?.focus()
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentSessionId, anchorMessageId, openLaneId, refresh])

  // 新消息 / 流式内容 → 滚到底
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, streamDraft?.text, streamDraft?.items.length])

  /** 切轮数：仅**新建支线且未发送**时生效（既有支线的快照已固化，不再重建） */
  const changeTurns = useCallback(async (t: number) => {
    if (openLaneId || lockedRef.current || pending) return
    setTurns(t)
    try { localStorage.setItem(TURNS_KEY, String(t)) } catch { /* ignore */ }
    const old = laneId
    const r = await agentCreateSideLane({ parentSessionId, anchorMessageId, contextTurns: t })
    if (r.ok && r.laneSessionId) {
      setLaneId(r.laneSessionId)
      setSnapshot(r.snapshotText ?? '')
      if (old && old !== r.laneSessionId) void agentDeleteSession(old)
    }
  }, [laneId, pending, parentSessionId, anchorMessageId, openLaneId])

  const doSend = useCallback(async () => {
    const text = input.trim()
    if (!text || pending || !laneId) return
    lockedRef.current = true
    const cid = crypto.randomUUID()
    chatIdRef.current = cid
    setInput('')
    setPending(true)
    beginStream()
    setMessages(prev => [...prev, { role: 'user', content: text, createdAt: new Date().toISOString() }])
    const r = await agentChat(laneId, text, undefined, cid, 'aiTeaching')
    if (r && !r.ok && r.code !== 'ABORTED') showToast({ type: 'error', message: `支线调用失败：${r.error ?? ''}` })
    await refresh(laneId)
    endStream()
    setPending(false)
    inputRef.current?.focus()
  }, [input, pending, laneId, beginStream, endStream, refresh])

  const stopped = err !== '' || (!loading && !laneId)

  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--bg-primary)]">
      {/* 顶栏：支线标识 + 轮数切换 + 关闭 */}
      <div className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-[var(--border-color)]">
        <Sparkles size={13} className="shrink-0 text-[var(--accent)]" />
        <span className="shrink-0 text-[12px] font-medium text-[var(--text-primary)]">支线旁问</span>
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--text-muted)]" title={parentTitle}>来自「{parentTitle}」</span>
        {/* 轮数切换：新建且未发送时可调；既有支线快照已固化，不可调 */}
        <div className="shrink-0 flex items-center gap-0.5 rounded-md bg-[var(--bg-secondary)] p-0.5">
          {TURN_OPTIONS.map(t => (
            <button key={t} disabled={!!openLaneId || lockedRef.current || pending} onClick={() => { void changeTurns(t) }}
              title={openLaneId ? '既有支线的上下文已固化' : lockedRef.current ? '已发送，上下文已锁定' : `带入主线最近 ${t} 轮`}
              className={`px-1.5 py-0.5 rounded text-[10.5px] tabular-nums transition-colors ${turns === t ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] font-medium' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'} disabled:opacity-40 disabled:cursor-not-allowed`}>
              {t}轮
            </button>
          ))}
        </div>
        {onToggleWide && (
          <button onClick={onToggleWide} title={wide ? '收回为浮层' : '贴到右栏（宽轨，并列占宽不遮挡中栏）'}
            className="shrink-0 p-1 rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
            {wide ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        )}
        <button onClick={onClose} title="关闭支线（内容保留在支线会话里）"
          className="shrink-0 p-1 rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
          <X size={13} />
        </button>
      </div>

      {/* 上下文摘录条：就地装载的可见证据（默认折叠，一眼可核） */}
      <button onClick={() => setCtxOpen(o => !o)}
        className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] text-left hover:bg-[var(--bg-hover)] transition-colors">
        <ChevronDown size={12} className={`shrink-0 text-[var(--text-muted)] kb-chevron ${ctxOpen ? 'rotate-180' : ''}`} />
        <span className="text-[10.5px] text-[var(--text-secondary)]">已带入上下文</span>
        <span className="text-[10.5px] text-[var(--text-muted)]">· 分叉回答 + 主线前 {turns} 轮</span>
        {snapshot && <Check size={11} className="shrink-0 text-[var(--success)]" />}
        <span className="ml-auto text-[10px] text-[var(--text-muted)]">{ctxOpen ? '收起' : '核对'}</span>
      </button>
      {ctxOpen && (
        <div className="shrink-0 max-h-[32%] overflow-y-auto px-3 py-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <pre className="whitespace-pre-wrap break-words text-[10.5px] leading-[1.6] text-[var(--text-secondary)] font-mono select-text">{snapshot || '（无上下文）'}</pre>
        </div>
      )}

      {/* 消息流 */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
        {loading && (
          <div className="h-full flex items-center justify-center gap-1.5 text-[11.5px] text-[var(--text-muted)]">
            <Loader2 size={13} className="animate-spin" />正在装载上下文…
          </div>
        )}
        {stopped && (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-center">
            <div className="text-[11.5px] text-[var(--text-secondary)]">{err || '支线未能创建'}</div>
            <button onClick={onClose} className="px-2.5 py-1 rounded-md border border-[var(--border-color)] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">关闭</button>
          </div>
        )}
        {!loading && !stopped && messages.length === 0 && !pending && (
          <div className="h-full flex flex-col items-center justify-center gap-1.5 text-center px-4">
            <div className="text-[11.5px] text-[var(--text-secondary)]">就这一点继续追问吧</div>
            <div className="text-[10.5px] text-[var(--text-muted)] leading-[1.6]">这里的内容<b className="font-medium text-[var(--text-secondary)]">不会进入主线</b>，主线节奏不受影响。</div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={m.id ?? i} className={m.role === 'user' ? 'group relative flex justify-end' : 'min-w-0'}>
            {m.role === 'user' ? (
              <>
                <div className="max-w-[90%] min-w-0 select-text bg-[var(--accent)] text-white rounded-xl rounded-br-sm px-3 py-1.5 text-[12.5px] leading-relaxed break-words whitespace-pre-wrap">{m.content}</div>
                <button onClick={() => { void navigator.clipboard.writeText(m.content).then(() => showToast({ type: 'info', message: '已复制' })).catch(() => null) }}
                  title="复制" className="absolute right-full top-1/2 -translate-y-1/2 mr-1 px-1 py-0.5 rounded text-[10.5px] text-[var(--text-muted)] opacity-0 group-hover:opacity-100 hover:bg-[var(--bg-hover)] transition-opacity">
                  <Copy size={10} />
                </button>
              </>
            ) : (
              <div className="min-w-0 group relative">
                <MarkdownPreview content={m.content} />
                <button onClick={() => { void navigator.clipboard.writeText(m.content).then(() => showToast({ type: 'info', message: '已复制' })).catch(() => null) }}
                  title="复制" className="absolute right-0 -top-1 px-1 py-0.5 rounded text-[10.5px] text-[var(--text-muted)] opacity-0 group-hover:opacity-100 hover:bg-[var(--bg-hover)] transition-opacity">
                  <Copy size={10} />
                </button>
              </div>
            )}
          </div>
        ))}
        {pending && (streamDraft ? (
          <div className="min-w-0">
            <StreamBubble draft={streamDraft} />
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-muted)]">
            <Loader2 size={12} className="animate-spin" />思考中…
          </div>
        ))}
      </div>

      {/* 底部动作条（v3.1.2 条目11）：带回主线（P3）/ 升格为正式会话（P4）。
          两条都要有支线内容才有意义；带回归属「手动决定」——预填结论摘要，用户编辑确认才追加。 */}
      {laneId && !pending && (onBringBack || onPromote) && (
        <div className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 border-t border-[var(--border-color)]">
          {onBringBack && (
            <button onClick={() => {
              const last = [...messages].reverse().find(m => m.role === 'assistant')
              setBackDraft((last?.content ?? '').trim().slice(0, 4000))
              setBackOpen(true)
            }} disabled={!messages.some(m => m.role === 'assistant')}
              title="把这条支线的结论带回主线（确认前不会写入主线）"
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
              <ArrowLeft size={11} />带回主线
            </button>
          )}
          {onPromote && (
            <button onClick={() => onPromote(laneId)}
              title="把支线升格为正式会话（进左栏会话列表，可独立续聊；单向不可逆）"
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
              <ArrowUp size={11} />升格为会话
            </button>
          )}
        </div>
      )}

      {/* 输入区（带回编辑框打开时原地替换输入框） */}
      {backOpen ? (
        <div className="shrink-0 border-t border-[var(--border-color)] p-2.5 kb-pop">
          <div className="mb-1 text-[10.5px] text-[var(--text-muted)]">确认后追加到主线（原对话不受影响，可在上方直接改写）</div>
          <textarea value={backDraft} onChange={e => setBackDraft(e.target.value)} rows={5} spellCheck={false}
            onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setBackOpen(false) } }}
            className="w-full px-2.5 py-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent)]/60 resize-none" />
          <div className="mt-1.5 flex items-center justify-end gap-1.5">
            <button onClick={() => setBackOpen(false)}
              className="px-2 py-0.5 rounded-md text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">取消</button>
            <button onClick={() => { if (laneId && backDraft.trim()) { onBringBack?.(laneId, laneTitle, backDraft.trim()); setBackOpen(false); showToast({ type: 'info', message: '已带回主线' }) } }}
              disabled={!backDraft.trim()}
              className="px-2 py-0.5 rounded-md text-[11px] bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-40 transition-colors">确认带回</button>
          </div>
        </div>
      ) : (
      <div className="shrink-0 border-t border-[var(--border-color)] p-2.5">
        <div className="flex items-end gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--input-bg)] px-2.5 py-1.5 focus-within:border-[var(--accent)]/60 transition-colors">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void doSend() }
            }}
            rows={wide ? 2 : 2}
            spellCheck={false}
            placeholder="就这一点追问…（Enter 发送 · Shift+Enter 换行）"
            className="flex-1 min-w-0 resize-none bg-transparent text-[12.5px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none max-h-32"
            disabled={stopped}
          />
          {pending ? (
            <button onClick={() => { void agentAbort(chatIdRef.current) }} title="停止生成"
              className="shrink-0 p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">
              <X size={13} />
            </button>
          ) : (
            <button onClick={() => { void doSend() }} disabled={!input.trim() || stopped} title="发送"
              className="shrink-0 p-1.5 rounded-md text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
              <Send size={13} />
            </button>
          )}
        </div>
      </div>
      )}
    </div>
  )
}
