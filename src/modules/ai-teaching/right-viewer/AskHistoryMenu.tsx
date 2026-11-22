/**
 * 右侧活动栏 · 旁问历史浮层（`+ → 旁问`）
 *
 * 一个旁问页签 = 一条旁问会话（lane）。这里只做「挑一条已有的 / 开一条新的」：
 * 数据来自冻结接口 `agentListAllSideLanes()`（跨对话，`updatedAt` 倒序，带 `parentTitle`）；
 * 从对话里「追问」进来的草稿**不进这个列表**（首问前不落库，见 PLAN §8.2）。
 */

import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, Loader2, Plus } from 'lucide-react'
import { agentListAllSideLanes } from '../../../lib/ipc'
import type { AgentSideLaneInfo } from '../../../types'

export interface AskHistoryMenuProps {
  onBack: () => void
  onNewWhole: () => void
  onOpenLane: (lane: AgentSideLaneInfo) => void
}

/** 主进程给的是 `YYYY-MM-DD HH:MM:SS`（本地） → `MM-DD HH:MM` */
function fmtTime(s?: string): string {
  if (!s || s.length < 16) return ''
  return `${s.slice(5, 10)} ${s.slice(11, 16)}`
}

export function AskHistoryMenu({ onBack, onNewWhole, onOpenLane }: AskHistoryMenuProps) {
  const [rows, setRows] = useState<AgentSideLaneInfo[] | null>(null)
  const [err, setErr] = useState('')
  const boxRef = useRef<HTMLDivElement | null>(null)

  /** ↑↓ / Home / End 在「问整段对话」与历史条目之间移动焦点 */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onBack()
      return
    }
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
    if (!keys.includes(e.key)) return
    const items = Array.from(boxRef.current?.querySelectorAll<HTMLElement>('[data-menu-row="1"]') ?? [])
      .filter((el) => !el.hasAttribute('disabled'))
    if (items.length === 0) return
    e.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : e.key === 'ArrowDown'
          ? (at < 0 ? 0 : (at + 1) % items.length)
          : (at <= 0 ? items.length - 1 : at - 1)
    items[next]?.focus()
  }

  useEffect(() => {
    let alive = true
    void agentListAllSideLanes()
      .then((list) => { if (alive) setRows(Array.isArray(list) ? list : []) })
      .catch((e) => {
        if (!alive) return
        setErr(String((e as Error)?.message || e))
        setRows([])
      })
    return () => { alive = false }
  }, [])

  return (
    <div
      ref={boxRef}
      role="dialog"
      aria-label="旁问历史"
      className="kb-pop absolute right-0 w-[300px] max-w-[calc(100vw-24px)] rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-1.5 shadow-[var(--tip-shadow)]"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-1 px-0.5 pb-1">
        <button
          type="button"
          aria-label="返回"
          data-tip="返回"
          onClick={onBack}
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <ChevronLeft size={12} />
        </button>
        <span className="flex-1 truncate text-[10.5px] text-[var(--text-muted)]">旁问历史</span>
      </div>

      <button
        type="button"
        data-menu-row="1"
        onClick={onNewWhole}
        className="mb-1 flex h-[30px] w-full items-center gap-1.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 text-left text-[11.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text-primary)] focus:border-[var(--accent)] focus:text-[var(--text-primary)] focus:outline-none"
      >
        <Plus size={12} className="shrink-0" />问整段对话
      </button>

      <div className="max-h-[300px] overflow-y-auto">
        {rows === null && (
          <div className="flex items-center justify-center gap-1.5 py-6 text-[11.5px] text-[var(--text-muted)]">
            <Loader2 size={13} className="animate-spin" />载入旁问…
          </div>
        )}
        {rows !== null && err !== '' && (
          <div className="px-2 py-4 text-center text-[11px] leading-relaxed text-[var(--text-muted)]">
            旁问历史读取失败：{err}
          </div>
        )}
        {rows !== null && err === '' && rows.length === 0 && (
          <div className="px-2 py-4 text-center text-[11px] leading-[1.65] text-[var(--text-muted)]">
            还没有旁问。在任意回答下点「追问」，或从这里问整段对话。
          </div>
        )}
        {rows !== null && rows.map((lane) => {
          const title = (lane.title || '').trim() || '旁问'
          const parent = (lane.parentTitle || '').trim()
          const time = fmtTime(lane.lastAssistantAt ?? lane.updatedAt)
          return (
            <button
              key={lane.id}
              type="button"
              data-menu-row="1"
              data-tip={parent ? `${title} · 来自 ${parent}` : title}
              onClick={() => onOpenLane(lane)}
              className="flex w-full items-start gap-2 rounded-md px-2 py-[7px] text-left transition-colors hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-hover)] focus:outline-none"
            >
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-[11.5px] ${lane.unread ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-primary)]'}`}>
                  {title}
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-[var(--text-muted)]">
                  {parent ? `来自：${parent}` : '来源对话已删除'}
                </span>
              </span>
              <span className="mt-0.5 shrink-0 text-[9.5px] tabular-nums text-[var(--text-muted)]">{time}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
