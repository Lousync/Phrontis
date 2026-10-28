import { useState } from 'react'
import { Bot, ChevronRight, Lock, Search, Check, Sparkles } from 'lucide-react'
import type { RailChapterInput, RailRow, RailUnit } from './courseRailPure'
import { buildRailRows, reviewLabel } from './courseRailPure'

/**
 * AI教学 3.14 左栏课程树：课程助手 + 搜索 + 章手风琴（段 → 知识点 / 复习行）。
 * 段节点只用于分组展示；点段头打开该段对话，点知识点仍走既有聚焦 / 回看 / 开段逻辑。
 */

interface Props {
  chapters: RailChapterInput[]
  activeChapterId: string | null
  collapsed: Record<string, boolean>
  onToggleChapter: (chapterId: string) => void
  onActivateChapter?: (chapterId: string) => void
  onUnit: (chapterId: string, unitId: string) => void
  onReview: (chapterId: string) => void
  onSegment: (sessionId: string) => void
  activeSegmentId: string | null
  assistantActive: boolean
  onAssistant: () => void
  search: string
  onSearch: (v: string) => void
  hasOutline: boolean
}

export function CourseRail(props: Props) {
  const {
    chapters, activeChapterId, collapsed, onToggleChapter, onActivateChapter,
    onUnit, onReview, onSegment, activeSegmentId,
    assistantActive, onAssistant, search, onSearch, hasOutline,
  } = props
  const [segOverride, setSegOverride] = useState<Record<string, boolean>>({})
  const searching = !!search.trim()

  const segKey = (row: Extract<RailRow, { kind: 'segment' }>) => `${row.sessionId}:${row.status}`
  const isSegmentOpen = (row: Extract<RailRow, { kind: 'segment' }>) => {
    if (searching) return true
    const key = segKey(row)
    if (key in segOverride) return segOverride[key]
    return row.status === 'open'
  }
  const toggleSegment = (row: Extract<RailRow, { kind: 'segment' }>) => {
    if (searching) return
    const key = segKey(row)
    setSegOverride(prev => ({ ...prev, [key]: !isSegmentOpen(row) }))
  }

  const renderUnitButton = (ch: RailChapterInput, u: RailUnit) => {
    const dot = u.active
      ? 'bg-[var(--accent)]'
      : u.learned
        ? 'bg-[var(--success)]'
        : u.inSegment
          ? 'border border-[var(--accent)] bg-transparent'
          : 'bg-[var(--text-disabled)]'
    const title = u.active
      ? `${u.name} · 当前聚焦`
      : u.learned
        ? `${u.name} · 已学，点击回看`
        : u.inSegment
          ? `${u.name} · 本段内，点击切换聚焦`
          : `${u.name} · 点击开段`
    return (
      <button
        key={u.id}
        onClick={() => onUnit(ch.id, u.id)}
        title={title}
        className={`w-full flex items-center gap-1.5 pl-4 pr-2 py-1 rounded-md text-left transition-colors hover:bg-[var(--bg-hover)] ${u.active ? 'bg-[var(--bg-selected)]' : ''}`}
      >
        <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${dot}`} />
        <span className={`min-w-0 flex-1 truncate text-[11.5px] ${u.active ? 'text-[var(--accent)] font-medium' : u.learned ? 'text-[var(--text-muted)]' : 'text-[var(--text-secondary)]'}`}>{u.name}</span>
      </button>
    )
  }

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="shrink-0 px-2 pt-2 pb-1.5">
        <div className="relative">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="搜索章 / 知识点"
            className="w-full h-7 pl-6 pr-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] text-[11.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
        </div>
      </div>

      <button
        onClick={onAssistant}
        title="课程助手：建课 / 登记素材 / 改大纲 / 按章分配"
        className={`mx-1.5 mb-1 flex items-center gap-1.5 px-2 py-1.5 rounded-md text-left transition-colors ${assistantActive ? 'bg-[var(--bg-selected)] text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
      >
        <Bot size={13} className="shrink-0 text-[var(--accent)]" />
        <span className="min-w-0 flex-1 truncate text-[12px]">课程助手</span>
        {!hasOutline && <span className="shrink-0 text-[9.5px] text-[var(--text-muted)]">建课</span>}
      </button>

      <div className="flex-1 min-h-0 overflow-y-auto px-1.5 pb-2">
        {!hasOutline && (
          <div className="px-2 py-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
            还没有课程大纲。点上面的「课程助手」建课；也可以先在右栏「素材」登记资料，大纲生成后再按章分配。
          </div>
        )}
        {hasOutline && chapters.length === 0 && (
          <div className="px-2 py-3 text-[11px] text-[var(--text-muted)]">没有匹配的章 / 知识点。</div>
        )}
        {chapters.map((ch) => {
          const closed = !searching && !!collapsed[ch.id]
          const current = ch.id === activeChapterId
          const hasOpen = ch.units.some(u => u.segmentStatus === 'open')
          return (
            <div key={ch.id} className="mb-0.5">
              <button
                onClick={() => { if (closed) onActivateChapter?.(ch.id); onToggleChapter(ch.id) }}
                title={closed ? '展开本章' : '收起本章'}
                className={`w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-left transition-colors hover:bg-[var(--bg-hover)] ${current ? 'bg-[var(--bg-secondary)]' : ''}`}
              >
                <ChevronRight size={11} className={`shrink-0 text-[var(--text-muted)] kb-chevron ${closed ? '' : 'rotate-90'}`} />
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--text-primary)]">{ch.name}</span>
                {hasOpen && (
                  <span className="shrink-0 rounded-full border border-[var(--accent)]/25 bg-[var(--accent)]/10 px-1 text-[9px] leading-[15px] text-[var(--accent)]">进行中</span>
                )}
                <span className="shrink-0 text-[9.5px] text-[var(--text-muted)] tabular-nums">{ch.review.learned}/{ch.review.total}</span>
              </button>
              {!closed && (
                <div className="kb-collapse open">
                  <div className="min-h-0">
                    {buildRailRows(ch.units).map((row) => {
                      if (row.kind === 'unit') return renderUnitButton(ch, row.unit)
                      const open = isSegmentOpen(row)
                      return (
                        <div key={`seg:${row.sessionId}:${row.status}`} className="mb-0.5">
                          <div className={`flex items-center gap-0.5 pl-2 pr-1 rounded-md ${row.sessionId === activeSegmentId ? 'bg-[var(--bg-selected)] shadow-[inset_2px_0_0_var(--accent)]' : ''}`}>
                            <button
                              type="button"
                              onClick={() => toggleSegment(row)}
                              aria-expanded={open}
                              aria-label={open ? '收起该段' : '展开该段'}
                              disabled={searching}
                              title={searching ? '搜索时自动展开' : open ? '收起该段' : '展开该段'}
                              className="shrink-0 w-5 h-5 inline-flex items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <ChevronRight size={10} className={`kb-chevron ${open ? 'rotate-90' : ''}`} />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setSegOverride(prev => ({ ...prev, [segKey(row)]: true }))
                                onSegment(row.sessionId)
                              }}
                              className="min-w-0 flex-1 flex items-center gap-1.5 py-1 text-left"
                              title="打开该段对话"
                            >
                              <span className="shrink-0 text-[10px] text-[var(--text-muted)]">第{row.order}段</span>
                              <span className={`shrink-0 rounded-full border px-1 text-[9px] leading-[14px] ${row.status === 'open' ? 'border-[var(--accent)]/25 bg-[var(--accent)]/10 text-[var(--accent)]' : 'border-[var(--border-color)] text-[var(--text-muted)]'}`}>
                                {row.status === 'open' ? '进行中' : '已收尾'}
                              </span>
                              <span className="ml-auto shrink-0 text-[9px] text-[var(--text-muted)]">{row.units.length} 个</span>
                            </button>
                          </div>
                          <div className={`kb-collapse ${open ? 'open' : ''}`}>
                            <div className="min-h-0">
                              <div className="ml-4 border-l border-[var(--border-color)] pl-0.5">
                                {row.units.map((u) => renderUnitButton(ch, u))}
                              </div>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                    <button
                      onClick={() => onReview(ch.id)}
                      title={ch.review.state === 'locked' ? `本章还有 ${ch.review.remaining} 个知识点没学完` : ch.review.state === 'done' ? '查看复习讲义' : '开始章末复习'}
                      className={`w-full flex items-center gap-1.5 pl-4 pr-2 py-1 rounded-md text-left transition-colors hover:bg-[var(--bg-hover)] ${ch.review.state === 'locked' ? 'opacity-70' : ''}`}
                    >
                      {ch.review.state === 'done' ? <Check size={10} className="shrink-0 text-[var(--success)]" /> : ch.review.state === 'unlocked' ? <Sparkles size={10} className="shrink-0 text-[var(--accent)]" /> : <Lock size={10} className="shrink-0 text-[var(--text-muted)]" />}
                      <span className={`min-w-0 flex-1 truncate text-[11px] ${ch.review.state === 'unlocked' ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}>章末复习</span>
                      <span className="shrink-0 text-[9px] text-[var(--text-muted)]">{reviewLabel(ch.review)}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
