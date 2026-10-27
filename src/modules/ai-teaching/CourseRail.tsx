import { Bot, ChevronRight, Lock, Search, Check, Sparkles } from 'lucide-react'
import type { RailChapterInput } from './courseRail'
import { reviewLabel } from './courseRail'

/**
 * AI教学 3.14 左栏课程树：课程助手 + 搜索 + 章手风琴（知识点 / 复习行）。
 * 不再列会话、没有零散对话 / 课时行 / 升格支线。
 */

interface Props {
  chapters: RailChapterInput[]
  activeChapterId: string | null
  collapsed: Record<string, boolean>
  onToggleChapter: (chapterId: string) => void
  onActivateChapter?: (chapterId: string) => void
  onUnit: (chapterId: string, unitId: string) => void
  onReview: (chapterId: string) => void
  assistantActive: boolean
  onAssistant: () => void
  search: string
  onSearch: (v: string) => void
  hasOutline: boolean
}

export function CourseRail(props: Props) {
  const { chapters, activeChapterId, collapsed, onToggleChapter, onActivateChapter, onUnit, onReview, assistantActive, onAssistant, search, onSearch, hasOutline } = props
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
            还没有课程大纲。点上面的「课程助手」，把资料和目标交给它，先建课。
          </div>
        )}
        {hasOutline && chapters.length === 0 && (
          <div className="px-2 py-3 text-[11px] text-[var(--text-muted)]">没有匹配的章 / 知识点。</div>
        )}
        {chapters.map((ch) => {
          const closed = !search.trim() && !!collapsed[ch.id]
          const current = ch.id === activeChapterId
          return (
            <div key={ch.id} className="mb-0.5">
              <button
                onClick={() => { if (closed) onActivateChapter?.(ch.id); onToggleChapter(ch.id) }}
                title={closed ? '展开本章' : '收起本章'}
                className={`w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-left transition-colors hover:bg-[var(--bg-hover)] ${current ? 'bg-[var(--bg-secondary)]' : ''}`}
              >
                <ChevronRight size={11} className={`shrink-0 text-[var(--text-muted)] kb-chevron ${closed ? '' : 'rotate-90'}`} />
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--text-primary)]">{ch.name}</span>
                <span className="shrink-0 text-[9.5px] text-[var(--text-muted)] tabular-nums">{ch.review.learned}/{ch.review.total}</span>
              </button>
              {!closed && (
                <div className="kb-collapse open">
                  <div className="min-h-0">
                    {ch.units.map((u) => {
                      const dot = u.learned ? 'var(--success)' : u.inSegment ? 'var(--accent)' : 'var(--text-disabled)'
                      return (
                        <button
                          key={u.id}
                          onClick={() => onUnit(ch.id, u.id)}
                          title={u.learned ? `${u.name} · 已学，点击回看` : u.inSegment ? `${u.name} · 本段聚焦` : `${u.name} · 点击开段`}
                          className={`w-full flex items-center gap-1.5 pl-4 pr-2 py-1 rounded-md text-left transition-colors hover:bg-[var(--bg-hover)] ${u.active ? 'bg-[var(--bg-selected)]' : ''}`}
                        >
                          <span className="shrink-0 w-1.5 h-1.5 rounded-full" style={{ background: dot }} />
                          <span className={`min-w-0 flex-1 truncate text-[11.5px] ${u.learned ? 'text-[var(--text-muted)]' : 'text-[var(--text-secondary)]'}`}>{u.name}</span>
                          {u.inSegment && <span className="shrink-0 px-1 rounded bg-[var(--accent)]/10 text-[9px] text-[var(--accent)]">本段</span>}
                        </button>
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
