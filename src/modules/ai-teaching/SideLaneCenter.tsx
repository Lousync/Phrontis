import { useCallback, useEffect, useMemo, useState } from 'react'
import { agentListSideLanes, agentMarkSideLaneRead } from '../../lib/ipc'
import { SideLanePanel } from './SideLanePanel'
import { GitBranch, Loader2, Search } from 'lucide-react'
import type { AgentSideLaneInfo } from '../../types'

/**
 * 右栏「支线中心」（.claude/plans/ai-teaching-side-lane-center.md）。
 *
 * 给支线旁问一个「家」：把当前会话的支线**按自身标题/时间列出来**（不再靠锚点回答那枚 chip），
 * 打开即已读、可搜索、可引用回主线 / 浮出窗口 / 升格。
 * 详情直接复用 `SideLanePanel`（同一套流式/输入/动作），`onBack` 触发「← 列表」内嵌形态。
 */

type CenterRequest =
  | { kind: 'open'; laneId: string }
  | { kind: 'create'; anchorMessageId: string }

export interface SideLaneCenterProps {
  parentSessionId: string
  parentTitle: string
  /** 打开请求：open=打开既有支线（锚点 chip「已开」）；create=为该锚点新建（锚点 chip「就这点追问」）。
   *  requestSeq 每次变化即重新响应（同一请求可重复触发）。 */
  request?: CenterRequest | null
  requestSeq?: number
  /** 浮出为窗口（与右栏同一条支线） */
  onFloat?: (laneId: string) => void
  /** 引用到主线（把末条 AI 回答交给父级放进主线输入框） */
  onQuote?: (text: string) => void
  /** 升格为正式会话 */
  onPromote?: (laneId: string) => void
  /** 列表数据变化（已读 / 升格 / 新建）→ 父级刷新锚点与计数 */
  onChanged?: () => void
  /** 该支线当前在浮窗 / 宽轨里显示 —— 右栏详情让位回列表，避免同一条内容两处并存 */
  suppressLaneId?: string | null
}

const ST: Record<string, { label: string; cls: string }> = {
  run: { label: '进行中', cls: 'text-[var(--warning)] bg-[var(--warning)]/10' },
  done: { label: '已答', cls: 'text-[var(--success)] bg-[var(--success)]/10' },
  cut: { label: '已中断', cls: 'text-[var(--danger)] bg-[var(--danger)]/10' },
}

function fmtTime(s?: string): string {
  // updatedAt = "YYYY-MM-DD HH:MM:SS"（本地）→ "MM-DD HH:MM"
  if (!s || s.length < 16) return ''
  return `${s.slice(5, 10)} ${s.slice(11, 16)}`
}

export function SideLaneCenter({
  parentSessionId, parentTitle, request, requestSeq,
  onFloat, onQuote, onPromote, onChanged, suppressLaneId,
}: SideLaneCenterProps) {
  const [items, setItems] = useState<AgentSideLaneInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [creatingAnchor, setCreatingAnchor] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!parentSessionId) { setItems([]); return }
    setLoading(true)
    const rows = await agentListSideLanes(parentSessionId).catch(() => [] as AgentSideLaneInfo[])
    setItems(rows.filter(r => r.lane !== 'main')) // 已升格的从左栏看，右栏移除
    setLoading(false)
  }, [parentSessionId])

  useEffect(() => { void load() }, [load])
  // 会话切换 → 回列表
  useEffect(() => { setActiveId(null); setCreatingAnchor(null); setSearch('') }, [parentSessionId])

  // 父级打开请求（锚点 chip）
  useEffect(() => {
    if (!request) return
    if (request.kind === 'open') { setCreatingAnchor(null); setActiveId(request.laneId) }
    else { setActiveId(null); setCreatingAnchor(request.anchorMessageId) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestSeq])

  // 该支线已在浮窗 / 宽轨中 → 右栏详情让位回列表（同一条支线不在两处并存）
  useEffect(() => {
    if (suppressLaneId && activeId === suppressLaneId) setActiveId(null)
  }, [suppressLaneId, activeId])

  const back = useCallback(() => { setActiveId(null); setCreatingAnchor(null); void load(); onChanged?.() }, [load, onChanged])

  const openLane = useCallback((id: string) => {
    setActiveId(id)
    void agentMarkSideLaneRead(id).then(() => { void load(); onChanged?.() }).catch(() => {})
  }, [load, onChanged])

  const view = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter(l => (l.title + ' ' + (l.anchorTitle ?? '') + ' ' + (l.excerpt ?? '')).toLowerCase().includes(q))
  }, [items, search])

  // ---- 详情：既有支线 ----
  if (activeId) {
    const hit = items.find(i => i.id === activeId)
    return (
      <div className="h-full min-h-0 flex flex-col">
        <SideLanePanel
          key={activeId}
          parentSessionId={parentSessionId}
          parentTitle={parentTitle}
          anchorMessageId={hit?.branchFromMessageId ?? ''}
          openLaneId={activeId}
          hideTurns
          onBack={back}
          onClose={back}
          onFloat={onFloat ? () => onFloat(activeId) : undefined}
          onQuote={onQuote}
          onPromote={onPromote ? () => onPromote(activeId) : undefined}
        />
      </div>
    )
  }

  // ---- 详情：新建（为该锚点创建支线，SideLanePanel 内部建会话，首条消息后回执）----
  if (creatingAnchor) {
    return (
      <div className="h-full min-h-0 flex flex-col">
        <SideLanePanel
          key={`create:${creatingAnchor}`}
          parentSessionId={parentSessionId}
          parentTitle={parentTitle}
          anchorMessageId={creatingAnchor}
          hideTurns
          onBack={back}
          onClose={back}
          onLaneReady={(lid) => { setCreatingAnchor(null); setActiveId(lid); void load(); onChanged?.() }}
        />
      </div>
    )
  }

  // ---- 列表 ----
  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 p-2 border-b border-[var(--border-color)]">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索本会话的支线…"
            spellCheck={false}
            className="w-full pl-7 pr-2 py-1 rounded-md border border-[var(--border-color)] bg-[var(--panel-2)] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] transition-colors"
          />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="h-full flex items-center justify-center gap-1.5 text-[11.5px] text-[var(--text-muted)]">
            <Loader2 size={13} className="animate-spin" />载入支线…
          </div>
        ) : view.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11.5px] text-[var(--text-muted)] leading-relaxed">
            {items.length === 0
              ? '本会话还没有支线记录。\n在任意回答下点「就这点追问」即可开一条。'
              : '没有匹配的支线。'}
          </div>
        ) : view.map(l => {
          const st = ST[l.laneStatus ?? 'done'] ?? ST.done
          return (
            <button
              key={l.id}
              onClick={() => openLane(l.id)}
              className="kb-item-in w-full flex items-start gap-2 px-2.5 py-2 text-left border-b border-[var(--border-color)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              <span className={`mt-[5px] shrink-0 w-[7px] h-[7px] rounded-full ${l.unread ? 'bg-[var(--accent)]' : 'bg-transparent'}`} title={l.unread ? '未读' : ''} />
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-[12.5px] font-medium ${l.unread ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>{l.title}</span>
                {l.anchorTitle && (
                  <span className="mt-0.5 flex items-center gap-1 text-[10.5px] text-[var(--text-muted)]">
                    <GitBranch size={10} className="shrink-0" />来自：{l.anchorTitle}
                  </span>
                )}
                <span className="mt-1 flex items-center gap-1.5">
                  <span className={`px-1.5 py-px rounded-full text-[9.5px] font-medium ${st.cls}`}>{st.label}</span>
                  <span className="ml-auto text-[10px] text-[var(--text-muted)] tabular-nums">{fmtTime(l.updatedAt)}</span>
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
