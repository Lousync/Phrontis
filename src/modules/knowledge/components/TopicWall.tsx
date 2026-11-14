import { useMemo, useRef, useState } from 'react'
import { ChevronDown, FileText, LayoutGrid, List, Plus, X } from 'lucide-react'
import type { KnowledgePage, KnowledgeTopic } from '../../../types'
import {
  dirLabelOfPath, formatRelTime, latestUpdatedMs, resolveTopicPages, topicColorOf, topicDirCount,
} from '../topicsPure'

/**
 * 左栏「主题」视图（v3.27.0，docs/knowledge-feed-topics-plan.md §4.1/§4.6）。
 *
 * 主题 = 虚拟集合：卡片只展示成员与「跨 N 个目录」，**不移动文件**。
 * 拖拽用 pointer 自实现（铁律 9：HTML5 拖拽在真实手势下会静默失败）：
 * 成员行 pointerdown → 位移过阈值进入拖拽 → elementFromPoint 找 `[data-topic-drop]` → pointerup 落成员。
 */

export interface TopicWallProps {
  topics: KnowledgeTopic[]
  pages: KnowledgePage[]
  unfiled: KnowledgePage[]
  /** 内联新建是否展开（由模块层控制：头部 ＋ → 新建主题也走这条） */
  creating: boolean
  onStartCreate: () => void
  onCancelCreate: () => void
  /** 返回 null = 成功；返回字符串 = 错误文案（同名 / 过长），就地显示 */
  onCreate: (name: string) => Promise<string | null>
  onOpenTopic: (topic: KnowledgeTopic) => void
  onOpenUnfiled: () => void
  onOpenPage: (page: KnowledgePage) => void
  onContextMenu: (e: React.MouseEvent, page: KnowledgePage) => void
  onAddMember: (topicId: string, pageId: string) => void
  onRemoveMember: (topicId: string, pageId: string) => void
}

const MAX_PREVIEW = 3

export function TopicWall({
  topics, pages, unfiled, creating, onStartCreate, onCancelCreate, onCreate,
  onOpenTopic, onOpenUnfiled, onOpenPage, onContextMenu, onAddMember, onRemoveMember,
}: TopicWallProps) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dragPageId, setDragPageId] = useState<string | null>(null)
  const [overTopicId, setOverTopicId] = useState<string | null>(null)
  const dragRef = useRef<{ pageId: string; x: number; y: number; pointerId: number; active: boolean } | null>(null)
  const dragEndAtRef = useRef(0)

  const memberPages = useMemo(
    () => new Map(topics.map((t) => [t.id, resolveTopicPages(t, pages)])),
    [topics, pages],
  )

  const submitCreate = async (): Promise<void> => {
    const name = draft.trim()
    if (!name || busy) return
    setBusy(true)
    const err = await onCreate(name)
    setBusy(false)
    if (err) { setError(err); return }
    setDraft(''); setError(null); onCancelCreate()
  }

  const handlePointerDown = (e: React.PointerEvent, pageId: string): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { pageId, x: e.clientX, y: e.clientY, pointerId: e.pointerId, active: false }
  }

  const handlePointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    if (!d.active) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return
      d.active = true
      setDragPageId(d.pageId)
    }
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const card = el instanceof Element ? el.closest<HTMLElement>('[data-topic-drop]') : null
    setOverTopicId(card?.getAttribute('data-topic-drop') ?? null)
  }

  const handlePointerUp = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    dragRef.current = null
    setOverTopicId(null)
    setDragPageId(null)
    if (!d.active) return
    dragEndAtRef.current = Date.now()
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const card = el instanceof Element ? el.closest<HTMLElement>('[data-topic-drop]') : null
    const target = card?.getAttribute('data-topic-drop')
    if (target) onAddMember(target, d.pageId)
  }

  const openIfNotDragging = (page: KnowledgePage): void => {
    if (Date.now() - dragEndAtRef.current < 250) return
    onOpenPage(page)
  }

  return (
    <div className="px-2 pb-3" data-wb="kbTopicWall">
      <div className="px-1.5 pb-2.5 pt-1 text-[10.5px] tracking-wide text-[var(--text-muted)]">
        <b className="font-semibold text-[var(--text-secondary)]">{topics.length}</b> 个主题 · {pages.length} 篇笔记 ·{' '}
        <b className="font-semibold text-[var(--text-secondary)]">{unfiled.length}</b> 篇未归类
      </div>

      {creating ? (
        <div className="kb-item-in relative mb-2 overflow-hidden rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 pb-2 pt-2.5" style={{ '--sc': 'var(--accent)' } as React.CSSProperties}>
          <div className="mb-2 mt-0.5 flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--text-primary)]">
            <LayoutGrid size={14} className="text-[var(--accent)]" />
            <span>新建主题</span>
          </div>
          <input
            autoFocus
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setError(null) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void submitCreate() }
              if (e.key === 'Escape') { e.preventDefault(); setDraft(''); setError(null); onCancelCreate() }
            }}
            placeholder="输入主题名，Enter 创建"
            className="h-[26px] w-full rounded border border-[var(--accent)] bg-[var(--input-bg)] px-2 text-[12px] text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--accent)]/15"
          />
          {error && <div className="mt-1 text-[10.5px] text-[var(--danger)]">{error}</div>}
        </div>
      ) : (
        <button
          type="button"
          onClick={onStartCreate}
          className="mb-2 flex w-full items-center gap-1.5 rounded-lg border border-dashed border-[var(--border-color)] px-2.5 py-1.5 text-[11px] text-[var(--text-muted)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.06] hover:text-[var(--accent)]"
        >
          <Plus size={13} /> 新建主题
        </button>
      )}

      {topics.map((t) => {
        const members = memberPages.get(t.id) ?? []
        const isOver = overTopicId === t.id
        const open = expanded.has(t.id)
        const shown = open ? members : members.slice(0, MAX_PREVIEW)
        const color = topicColorOf(t.color)
        return (
          <div
            key={t.id}
            data-topic-drop={t.id}
            className={`kb-item-in relative mb-2 overflow-hidden rounded-[10px] border bg-[var(--bg-secondary)] px-3 pb-2 pt-2.5 transition-colors ${
              isOver ? 'border-[var(--accent)] bg-[var(--accent)]/[0.09]' : 'border-[var(--border-color)] hover:border-[var(--text-disabled)]'
            }`}
            style={{ '--sc': color } as React.CSSProperties}
          >
            <span aria-hidden className="absolute inset-y-0 left-0 w-[2.5px] opacity-80" style={{ background: color }} />
            <button
              type="button"
              onClick={() => onOpenTopic(t)}
              className="flex w-full items-center gap-1.5 text-left"
              data-tip="打开主题" aria-label={`打开主题 ${t.name}`}
            >
              <LayoutGrid size={14} className="shrink-0 opacity-90" style={{ color }} />
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-[var(--text-primary)]">{t.name}</span>
              <span className="shrink-0 rounded-full bg-[var(--bg-tertiary)] px-1.5 text-[9.5px] leading-4 tabular-nums text-[var(--text-muted)]">{members.length}</span>
            </button>
            {members.length > 0 && (
              <div className="mb-1.5 mt-0.5 pl-[22px] text-[10.5px] text-[var(--text-disabled)]">
                跨 {topicDirCount(members)} 个目录 · 最后更新 {formatRelTime(latestUpdatedMs(members))}
              </div>
            )}
            <div className="flex flex-col gap-px">
              {shown.map((p) => (
                <div
                  key={p.id}
                  draggable={false}
                  onPointerDown={(e) => handlePointerDown(e, p.id)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onClick={() => openIfNotDragging(p)}
                  onContextMenu={(e) => onContextMenu(e, p)}
                  data-kb-topic-member={p.id}
                  className={`group/m flex cursor-pointer touch-none select-none items-center gap-[7px] overflow-hidden whitespace-nowrap rounded px-1.5 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ${
                    dragPageId === p.id ? 'opacity-40' : ''
                  }`}
                  title={p.title}
                >
                  <span className="h-[3px] w-[3px] shrink-0 rounded-full bg-[var(--text-disabled)]" />
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">{p.title || '无标题'}</span>
                  <span className="max-w-[42%] shrink-0 overflow-hidden text-ellipsis text-[9.5px] text-[var(--text-disabled)] opacity-90">
                    {dirLabelOfPath(p.path)}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onRemoveMember(t.id, p.id) }}
                    onPointerDown={(e) => e.stopPropagation()}
                    data-tip="从主题移除（只解散关系，不删笔记）" aria-label="从主题移除"
                    className="hidden shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] group-hover/m:block"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
              {members.length > MAX_PREVIEW && (
                <button
                  type="button"
                  onClick={() => setExpanded((prev) => {
                    const next = new Set(prev)
                    if (next.has(t.id)) next.delete(t.id)
                    else next.add(t.id)
                    return next
                  })}
                  className="mt-0.5 inline-flex items-center gap-1.5 self-start rounded px-1.5 py-1 text-[10.5px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]"
                >
                  <ChevronDown size={11} className={`kb-chevron ${open ? 'rotate-180' : ''}`} />
                  {open ? '收起' : `另外 ${members.length - MAX_PREVIEW} 篇`}
                </button>
              )}
              {!members.length && (
                <div className="px-1.5 py-1 text-[10.5px] text-[var(--text-disabled)]">拖到这里加入主题</div>
              )}
            </div>
          </div>
        )
      })}

      {!topics.length && !creating && (
        <div className="px-2 pb-3 text-center text-[11.5px] leading-relaxed text-[var(--text-muted)]">
          还没有主题。点顶部「＋ → 新建主题」，或把笔记右键「加入主题…」。
        </div>
      )}

      {/* 未归类：不是主题、也不是落点（避免误以为「拖进来 = 移出全部主题」） */}
      <div className="relative mt-1 overflow-hidden rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 pb-2 pt-2.5">
        <button
          type="button"
          onClick={onOpenUnfiled}
          className="flex w-full items-center gap-1.5 text-left"
          data-tip="查看未归类笔记" aria-label="查看未归类笔记"
        >
          <List size={14} className="shrink-0 text-[var(--text-muted)]" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-[var(--text-primary)]">未归类</span>
          <span className="shrink-0 rounded-full bg-[var(--bg-tertiary)] px-1.5 text-[9.5px] leading-4 tabular-nums text-[var(--text-muted)]">{unfiled.length}</span>
        </button>
        <div className="mt-1" />
        {unfiled.slice(0, MAX_PREVIEW).map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onOpenPage(p)}
            onContextMenu={(e) => onContextMenu(e, p)}
            className="flex w-full items-center gap-[7px] overflow-hidden whitespace-nowrap rounded px-1.5 py-1 text-left text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <FileText size={12} className="shrink-0 text-[var(--text-muted)]" />
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">{p.title || '无标题'}</span>
            <span className="max-w-[42%] shrink-0 overflow-hidden text-ellipsis text-[9.5px] text-[var(--text-disabled)]">{dirLabelOfPath(p.path)}</span>
          </button>
        ))}
        {unfiled.length > MAX_PREVIEW && (
          <button type="button" onClick={onOpenUnfiled} className="mt-0.5 inline-flex rounded px-1.5 py-1 text-[10.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]">
            还有 {unfiled.length - MAX_PREVIEW} 篇…
          </button>
        )}
      </div>
    </div>
  )
}
