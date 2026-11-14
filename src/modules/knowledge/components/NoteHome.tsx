import { useMemo } from 'react'
import { Clock, FileText, House, LayoutGrid, List, Plus, Tag } from 'lucide-react'
import type { KnowledgePage, KnowledgeTopic } from '../../../types'
import {
  excerptOf, filedPageIds, formatRelTime, resolveTopicPages, topicColorOf, unfiledPages,
} from '../topicsPure'

/**
 * 笔记区总览（v3.27.0，docs/knowledge-feed-topics-plan.md §4.2）。
 *
 * 常驻固定标签的内容：继续上次编辑 / 三个统计 / 最近修改 / 主题集合 / 标签 / 未归类。
 * 不做「让 AI 整理笔记」的强调（用户明确要求）——这里只呈现已有数据。
 */

export interface NoteHomeProps {
  pages: KnowledgePage[]
  topics: KnowledgeTopic[]
  /** 上次打开的页面（持久化恢复值），为空时退化为最近修改页 */
  lastPageId: string | null
  onOpenPage: (page: KnowledgePage) => void
  onOpenTopic: (topic: KnowledgeTopic) => void
  onOpenUnfiled: () => void
  onSetView: (view: 'recent' | 'topics' | 'tree') => void
  onNewNote: () => void
  onNewTopic: () => void
  onContextMenu: (e: React.MouseEvent, page: KnowledgePage) => void
  onBackToWorkbench?: () => void
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

function greeting(now: Date): string {
  const h = now.getHours()
  if (h < 6) return '夜深了'
  if (h < 12) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

export function NoteHome({
  pages, topics, lastPageId, onOpenPage, onOpenTopic, onOpenUnfiled, onSetView,
  onNewNote, onNewTopic, onContextMenu, onBackToWorkbench,
}: NoteHomeProps) {
  const now = Date.now()

  const byUpdated = useMemo(() => [...pages].sort((a, b) => {
    const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0
    const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0
    return tb - ta
  }), [pages])

  const continuePage = useMemo(() => {
    if (lastPageId) {
      const hit = pages.find((p) => p.id === lastPageId)
      if (hit) return hit
    }
    return byUpdated[0] ?? null
  }, [lastPageId, pages, byUpdated])

  const recent = byUpdated.slice(0, 8)

  const unfiled = useMemo(() => unfiledPages(pages, topics), [pages, topics])
  const filedCount = useMemo(() => {
    const filed = filedPageIds(topics)
    return pages.reduce((n, p) => n + (filed.has(p.id) ? 1 : 0), 0)
  }, [pages, topics])

  const thisWeek = useMemo(() => pages.filter((p) => {
    const t = p.createdAt ? Date.parse(p.createdAt) : NaN
    return Number.isFinite(t) && now - t < WEEK_MS
  }).length, [pages, now])

  const topTopics = useMemo(() => [...topics]
    .map((t) => ({ topic: t, pages: resolveTopicPages(t, pages) }))
    .sort((a, b) => b.pages.length - a.pages.length)
    .slice(0, 3), [topics, pages])

  const tags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of pages) for (const t of p.tags ?? []) counts.set(t.name, (counts.get(t.name) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  }, [pages])

  const dateText = new Date().toLocaleDateString('zh-CN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

  if (!pages.length) {
    return (
      <div className="kb-view-in flex-1 min-w-0 overflow-y-auto" data-wb="kbNoteHome">
        <div className="mx-auto max-w-[720px] px-10 py-20 text-center">
          <div className="mb-3 flex justify-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-muted)]">
              <FileText size={26} />
            </span>
          </div>
          <h1 className="text-[22px] font-bold text-[var(--text-primary)]">这个仓库还没有笔记</h1>
          <p className="mx-auto mt-2 max-w-[420px] text-[13px] leading-relaxed text-[var(--text-secondary)]">
            新建一篇笔记开始写；主题是虚拟集合，之后可以把笔记拖到主题卡上归类，不会移动文件。
          </p>
          <div className="mt-6 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={onNewNote}
              className="flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90"
            >
              <Plus size={14} /> 新建笔记
            </button>
            <button
              type="button"
              onClick={onNewTopic}
              className="flex items-center gap-1.5 rounded-md border border-[var(--border-color)] px-3 py-1.5 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              <LayoutGrid size={14} /> 新建主题
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="kb-view-in flex-1 min-w-0 overflow-y-auto" data-wb="kbNoteHome">
      <div className="mx-auto max-w-[980px] px-10 py-9">
        {/* hero */}
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-[22px] font-bold leading-snug text-[var(--text-primary)]">{greeting(new Date())}</h1>
            <div className="mt-1 text-[11.5px] text-[var(--text-muted)]">{dateText}</div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onNewNote}
              className="flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-2.5 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
            >
              <Plus size={13} /> 新建笔记
            </button>
            {onBackToWorkbench && (
              <button
                type="button"
                onClick={onBackToWorkbench}
                data-tip="回到工作台" aria-label="回到工作台"
                className="flex items-center gap-1.5 rounded-md border border-[var(--border-color)] px-2.5 py-1.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <House size={13} /> 回工作台
              </button>
            )}
          </div>
        </div>

        {/* 继续上次编辑 */}
        {continuePage && (
          <button
            type="button"
            onClick={() => onOpenPage(continuePage)}
            onContextMenu={(e) => onContextMenu(e, continuePage)}
            className="group mb-4 block w-full rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] px-5 py-4 text-left transition-colors hover:border-[var(--accent)]/60"
          >
            <div className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-muted)]">
              <Clock size={12} /> 继续上次编辑 · {formatRelTime(continuePage.updatedAt)}
            </div>
            <h3 className="mt-1 truncate text-[16px] font-semibold text-[var(--text-primary)]">{continuePage.title || '无标题'}</h3>
            <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">{excerptOf(continuePage, 160) || '（还没有正文）'}</p>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {(continuePage.tags ?? []).slice(0, 5).map((t) => (
                <span key={t.name} className="rounded px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]" style={{ background: 'var(--bg-tertiary)' }}>#{t.name}</span>
              ))}
              <span className="ml-auto text-[10.5px] text-[var(--text-disabled)] opacity-0 transition-opacity group-hover:opacity-100">打开 <kbd className="rounded border border-[var(--border-color)] px-1 text-[9.5px]">Enter</kbd></span>
            </div>
          </button>
        )}

        {/* 统计 */}
        <div className="mb-6 grid grid-cols-3 gap-2.5">
          <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5 py-3">
            <div className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-muted)]"><FileText size={12} /> 本周新增</div>
            <div className="mt-1 text-[22px] font-bold tabular-nums leading-none text-[var(--text-primary)]">{thisWeek}</div>
          </div>
          <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5 py-3">
            <div className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-muted)]"><LayoutGrid size={12} /> 已归类</div>
            <div className="mt-1 text-[22px] font-bold tabular-nums leading-none text-[var(--text-primary)]">{filedCount}</div>
          </div>
          <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5 py-3">
            <div className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-muted)]"><List size={12} /> 未归类</div>
            <div className="mt-1 text-[22px] font-bold tabular-nums leading-none text-[var(--text-primary)]">{unfiled.length}</div>
          </div>
        </div>

        {/* 最近修改 */}
        <section className="mb-6">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">最近修改</h2>
            <span className="h-px flex-1 bg-[var(--border-color)] opacity-60" />
            <button type="button" onClick={() => onSetView('recent')} className="text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]">在左栏查看全部</button>
          </div>
          <div className="overflow-hidden rounded-lg border border-[var(--border-color)]/70">
            {recent.map((p, i) => (
              <div
                key={p.id}
                onClick={() => onOpenPage(p)}
                onContextMenu={(e) => onContextMenu(e, p)}
                className={`flex cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors hover:bg-[var(--bg-hover)] ${i > 0 ? 'border-t border-[var(--border-color)]/60' : ''}`}
              >
                <FileText size={14} className="shrink-0 text-[var(--text-muted)]" />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text-primary)]">{p.title || '无标题'}</span>
                <span className="shrink-0 text-[10px] text-[var(--text-disabled)]">{formatRelTime(p.updatedAt)}</span>
              </div>
            ))}
          </div>
        </section>

        {/* 主题集合 */}
        <section className="mb-6">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">主题集合</h2>
            <span className="h-px flex-1 bg-[var(--border-color)] opacity-60" />
            <button type="button" onClick={() => onSetView('topics')} className="text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]">全部主题</button>
          </div>
          {!topTopics.length ? (
            <div className="rounded-lg border border-dashed border-[var(--border-color)] px-4 py-6 text-center text-[12px] text-[var(--text-muted)]">
              还没有主题。点左栏顶部「＋ → 新建主题」，再把笔记拖到主题卡上。
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2.5">
              {topTopics.map(({ topic, pages: tp }) => {
                const color = topicColorOf(topic.color)
                return (
                  <button
                    key={topic.id}
                    type="button"
                    onClick={() => onOpenTopic(topic)}
                    className="relative overflow-hidden rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5 text-left transition-colors hover:border-[var(--text-disabled)]"
                  >
                    <span aria-hidden className="absolute inset-y-0 left-0 w-[2.5px] opacity-80" style={{ background: color }} />
                    <div className="flex items-center gap-1.5">
                      <LayoutGrid size={13} style={{ color }} />
                      <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--text-primary)]">{topic.name}</span>
                      <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-muted)]">{tp.length} 篇</span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-[10.5px] leading-relaxed text-[var(--text-muted)]">{topic.desc || '（还没有描述）'}</div>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        {/* 标签 */}
        {tags.length > 0 && (
          <section className="mb-6">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">标签</h2>
              <span className="h-px flex-1 bg-[var(--border-color)] opacity-60" />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {tags.map(([name, n]) => (
                <span key={name} className="inline-flex items-center gap-1 rounded-md border border-[var(--border-color)] px-2 py-1 text-[11px] text-[var(--text-secondary)]">
                  <Tag size={10} className="text-[var(--text-disabled)]" />
                  {name}
                  <span className="tabular-nums text-[9.5px] text-[var(--text-disabled)]">{n}</span>
                </span>
              ))}
            </div>
          </section>
        )}

        {/* 未归类 */}
        <section className="mb-2">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">未归类</h2>
            <span className="h-px flex-1 bg-[var(--border-color)] opacity-60" />
            <button type="button" onClick={() => onSetView('topics')} className="text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]">去主题里归类</button>
          </div>
          {!unfiled.length ? (
            <div className="text-[11.5px] text-[var(--text-muted)]">所有笔记都已经归类了。</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {unfiled.slice(0, 6).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onOpenPage(p)}
                  onContextMenu={(e) => onContextMenu(e, p)}
                  className="max-w-[220px] truncate rounded-md border border-[var(--border-color)] px-2 py-1 text-[11px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  {p.title || '无标题'}
                </button>
              ))}
              {unfiled.length > 6 && (
                <button type="button" onClick={onOpenUnfiled} className="rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]">
                  还有 {unfiled.length - 6} 篇…
                </button>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
