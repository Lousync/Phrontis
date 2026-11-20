import { useCallback, useEffect, useMemo, useState } from 'react'
import { agentCreateSideLane, agentListSideLanes, agentMarkSideLaneRead } from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'
import { SideLanePanel } from '../SideLanePanel'
import { Loader2, Plus, Search } from 'lucide-react'
import type { AgentSideLaneInfo } from '../../../types'
import type { AskPaneProps } from './paneContracts'
import {
  canQuoteFromLane, filterLanes, laneBadge, laneSubtitle, scopeFromRequest, sortLanes,
} from './askPanePure'

/**
 * 右侧查看器 · 旁问页签（方案 §6.4；内核 C8 / C10 / C11）。
 *
 * 把原「支线中心 + 支线面板」升级成统一旁问，两种作用域：
 *   · 整段对话 —— `agentCreateSideLane({ parentSessionId, anchorMessageId: '' })`（服务端把空锚点当整段）；
 *   · 锚定第 N 条回答 —— 由主线「追问」发起（request kind=create + anchorMessageId）。
 *
 * 只读边界（C10）：本面**不提供**任何「写文件 / 出题 / 改大纲 / 升格为会话」入口；
 * 「引用到主线」只把文字塞进主线输入框，绝不 `agentChat`、绝不自动发送。
 */

const BADGE_CLS: Record<string, string> = {
  conversation: 'text-[var(--accent)] bg-[var(--accent)]/10',
  anchor: 'text-[var(--text-secondary)] bg-[var(--bg-secondary)]',
  selection: 'text-[var(--warning)] bg-[var(--warning)]/10',
}

function fmtTime(s?: string): string {
  // 主进程给的是 "YYYY-MM-DD HH:MM:SS"（本地）→ "MM-DD HH:MM"
  if (!s || s.length < 16) return ''
  return `${s.slice(5, 10)} ${s.slice(11, 16)}`
}

export function AskPane({
  rootId, sessionId, sessionTitle, request, requestSeq, anchorMessageId,
  onQuote, onFloat, onChanged,
}: AskPaneProps) {
  const [items, setItems] = useState<AgentSideLaneInfo[]>([])
  const [loading, setLoading] = useState(false)
  /** 本会话是否已成功列过一次 —— 请求带着 laneId 先到时，等列表回填再挂详情，避免锚点从空串闪成真值二次装载 */
  const [loadedOnce, setLoadedOnce] = useState(false)
  const [search, setSearch] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [creatingAnchor, setCreatingAnchor] = useState<string | null>(null)
  const [creatingWhole, setCreatingWhole] = useState(false)

  const load = useCallback(async () => {
    if (!sessionId) { setItems([]); setLoadedOnce(false); return }
    setLoading(true)
    const rows = await agentListSideLanes(sessionId).catch(() => [] as AgentSideLaneInfo[])
    setItems(rows.filter((r) => r.lane !== 'main')) // 已升格的从左栏看，旁问里不再出现
    setLoadedOnce(true)
    setLoading(false)
  }, [sessionId])

  useEffect(() => { void load() }, [load])
  // 会话切换 → 回列表（旧会话的支线不该留在详情里）
  useEffect(() => {
    setActiveId(null); setCreatingAnchor(null); setSearch(''); setLoadedOnce(false)
  }, [sessionId])

  const back = useCallback(() => {
    setActiveId(null)
    setCreatingAnchor(null)
    void load()
    onChanged?.()
  }, [load, onChanged])

  const openLane = useCallback((id: string) => {
    setCreatingAnchor(null)
    setActiveId(id)
    void agentMarkSideLaneRead(id).then(() => { void load(); onChanged?.() }).catch(() => {})
  }, [load, onChanged])

  /** 问整段对话：空锚点 = 整段（主进程已支持，不需要新 IPC） */
  const askWholeConversation = useCallback(async () => {
    if (!sessionId || creatingWhole) return
    setCreatingWhole(true)
    const r = await agentCreateSideLane({ parentSessionId: sessionId, anchorMessageId: '' }).catch(() => null)
    setCreatingWhole(false)
    if (!r || !r.ok || !r.laneSessionId) {
      showToast({ type: 'error', message: '问整段对话没能创建', detail: r?.error })
      return
    }
    setCreatingAnchor(null)
    setActiveId(r.laneSessionId) // 建完直接进详情，让用户马上能问
    void agentMarkSideLaneRead(r.laneSessionId).catch(() => {})
    await load()
    onChanged?.()
  }, [sessionId, creatingWhole, load, onChanged])

  // 壳 / 锚点 chip 的一次性请求：宽松解析，解析不出来就留在列表（壳已把页签切到旁问）
  useEffect(() => {
    if (!request) return
    const scope = scopeFromRequest(request)
    if (!scope) return
    const raw = request as { laneId?: unknown; anchorMessageId?: unknown }
    if (scope.kind === 'open') {
      const id = typeof raw.laneId === 'string' ? raw.laneId.trim() : ''
      if (id) openLane(id)
      return
    }
    if (scope.kind === 'create') {
      const anchor = typeof raw.anchorMessageId === 'string' ? raw.anchorMessageId.trim() : ''
      if (!anchor) { void askWholeConversation(); return }
      setActiveId(null)
      setCreatingAnchor(anchor)
      return
    }
    if (scope.kind === 'conversation' || scope.kind === 'whole' || scope.kind === 'new') {
      void askWholeConversation()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestSeq])

  const view = useMemo(() => {
    // 会话行给的是 updatedAt；纯函数按 updated_at（主进程原字段）做退化排序
    const rows = filterLanes(items, search).map((l) => ({ ...l, updated_at: l.updatedAt }))
    return sortLanes(rows)
  }, [items, search])

  // 没有仓库 / 没有会话：旁问依附于会话，出空态卡（不抛错、不空白）
  if (!rootId || !sessionId) {
    return (
      <div className="h-full min-h-0 flex items-center justify-center p-4">
        <div className="max-w-[260px] rounded-lg border border-[var(--border-color)] bg-[var(--panel-2)] px-3 py-3 text-center">
          <div className="text-[12px] font-medium text-[var(--text-primary)]">先进入一个 AI 教学对话</div>
          <div className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
            旁问依附于当前对话；进来后可以问整段，也可以在任意回答下点「追问」。
          </div>
        </div>
      </div>
    )
  }

  const activeLane = activeId ? items.find((i) => i.id === activeId) ?? null : null

  // ---- 详情：既有旁问 ----
  if (activeId) {
    // 列表还没回来（请求先到）：先占位，别拿空锚点挂一次面板
    if (!activeLane && !loadedOnce) {
      return (
        <div className="h-full flex items-center justify-center gap-1.5 text-[11.5px] text-[var(--text-muted)]">
          <Loader2 size={13} className="animate-spin" />载入旁问…
        </div>
      )
    }
    return (
      <div className="h-full min-h-0 flex flex-col kb-view-fade">
        <div className="shrink-0 px-2.5 pt-1.5 pb-1.5 border-b border-[var(--border-color)]">
          <div className="flex items-center gap-1.5">
            <span className={`shrink-0 px-1.5 py-px rounded-full text-[9.5px] font-medium ${BADGE_CLS[activeLane ? laneBadge(activeLane).tone : 'anchor']}`}>
              {activeLane ? laneBadge(activeLane).label : '旁问'}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-secondary)]">
              {activeLane ? laneSubtitle(activeLane) : '锚定'}
            </span>
          </div>
          {activeLane?.excerpt && (
            <div className="mt-0.5 text-[10.5px] leading-[1.5] text-[var(--text-muted)] line-clamp-2 break-words">
              {activeLane.excerpt}
            </div>
          )}
        </div>
        <div className="flex-1 min-h-0 min-w-0">
          <SideLanePanel
            key={activeId}
            parentSessionId={sessionId}
            parentTitle={sessionTitle}
            anchorMessageId={activeLane?.branchFromMessageId ?? ''}
            openLaneId={activeId}
            hideTurns
            quotePerMessage
            onBack={back}
            onClose={back}
            onQuote={canQuoteFromLane(activeLane ?? {}) ? onQuote : undefined}
            onFloat={onFloat ? () => onFloat(activeId) : undefined}
          />
        </div>
      </div>
    )
  }

  // ---- 详情：为该锚点新建（首条消息后回执，切到既有旁问详情）----
  if (creatingAnchor) {
    return (
      <div className="h-full min-h-0 flex flex-col kb-view-fade">
        <div className="shrink-0 px-2.5 py-1.5 border-b border-[var(--border-color)] text-[11px] text-[var(--text-secondary)]">
          锚定这条回答追问 · 主线不变
        </div>
        <div className="flex-1 min-h-0 min-w-0">
          <SideLanePanel
            key={`create:${creatingAnchor}`}
            parentSessionId={sessionId}
            parentTitle={sessionTitle}
            anchorMessageId={creatingAnchor}
            hideTurns
            quotePerMessage
            onBack={back}
            onClose={back}
            onQuote={onQuote}
            onLaneReady={(lid) => {
              setCreatingAnchor(null)
              setActiveId(lid)
              void load()
              onChanged?.()
            }}
          />
        </div>
      </div>
    )
  }

  // ---- 列表 ----
  return (
    <div className="h-full min-h-0 flex flex-col">
      {/* 动作行：问整段对话 + 检索 + 当前作用域 */}
      <div className="shrink-0 h-8 flex items-center gap-1.5 px-2 border-b border-[var(--border-color)]">
        <button
          onClick={() => { void askWholeConversation() }}
          disabled={creatingWhole}
          data-tip="读整段对话开一条旁问（不写入主线）"
          aria-label="问整段对话"
          className="shrink-0 inline-flex items-center gap-0.5 h-6 px-1.5 rounded-md text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {creatingWhole ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
          问整段对话
        </button>
        <div className="relative flex-1 min-w-0">
          <Search size={11} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索旁问…"
            spellCheck={false}
            className="w-full h-6 pl-6 pr-1.5 rounded-md border border-[var(--border-color)] bg-[var(--panel-2)] text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent)] transition-colors"
          />
        </div>
        <span
          className="shrink-0 text-[10px] text-[var(--text-muted)]"
          data-tip={anchorMessageId ? '主线有可锚定的回答：在那条回答下点「追问」' : '新开旁问默认读整段对话'}
          aria-label={anchorMessageId ? '可锚定某条回答' : '整段对话'}
        >
          {anchorMessageId ? '可锚定' : '整段'}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="h-full flex items-center justify-center gap-1.5 text-[11.5px] text-[var(--text-muted)]">
            <Loader2 size={13} className="animate-spin" />载入旁问…
          </div>
        ) : view.length === 0 ? (
          <div className="px-4 py-6 text-center">
            {items.length === 0 ? (
              <>
                <div className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                  还没有旁问。选中一条回答点「追问」，或直接问整段对话。
                </div>
                <button
                  onClick={() => { void askWholeConversation() }}
                  disabled={creatingWhole}
                  className="mt-2 inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--border-color)] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-40"
                >
                  <Plus size={11} />问整段对话
                </button>
              </>
            ) : (
              <div className="text-[11.5px] text-[var(--text-muted)]">没有匹配的旁问。</div>
            )}
          </div>
        ) : view.map((l) => {
          const badge = laneBadge(l)
          return (
            <button
              key={l.id}
              onClick={() => openLane(l.id)}
              className="kb-item-in w-full flex items-start gap-2 px-2.5 py-2 text-left border-b border-[var(--border-color)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              <span
                className={`mt-[6px] shrink-0 w-[7px] h-[7px] rounded-full ${l.unread ? 'bg-[var(--accent)]' : 'bg-transparent'}`}
                data-tip={l.unread ? '未读' : ''}
                aria-label={l.unread ? '未读' : ''}
              />
              <span className="min-w-0 flex-1">
                <span className={`block text-[12.5px] leading-[1.4] line-clamp-2 ${l.unread ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-primary)]'}`}>
                  {l.title || '旁问'}
                </span>
                <span className="mt-1 flex items-center gap-1.5">
                  <span className={`shrink-0 px-1.5 py-px rounded-full text-[9.5px] font-medium ${BADGE_CLS[badge.tone]}`}>
                    {badge.label}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-[var(--text-muted)] tabular-nums">
                    {fmtTime(l.lastAssistantAt ?? l.updatedAt)}
                  </span>
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
