import { useState } from 'react'
import { ChevronRight, FileText, LayoutGrid, List, Pencil, Trash2, X } from 'lucide-react'
import type { KnowledgePage, KnowledgeTopic } from '../../../types'
import {
  excerptOf, formatRelTime, groupPagesByDir, topicColorOf, topicDirCount,
} from '../topicsPure'

/**
 * 主题详情页（v3.27.0，docs/knowledge-feed-topics-plan.md §4.3）。
 *
 * 临时标签内容：同时只开一个主题，不持久化、不参与分屏/固定（总览才是常驻标签）。
 * 成员按目录分组；删除主题只解散集合（行内确认卡，中央模态只留给严重/不可逆操作）。
 */

export interface TopicDetailProps {
  /** null = 「未归类」页（虚拟视图，不能改名/删除） */
  topic: KnowledgeTopic | null
  pages: KnowledgePage[]
  onOpenPage: (page: KnowledgePage) => void
  onContextMenu: (e: React.MouseEvent, page: KnowledgePage) => void
  onRemoveMember: (pageId: string) => void
  /** 返回 null = 成功；字符串 = 错误文案 */
  onRename: (name: string) => Promise<string | null>
  onDelete: () => void | Promise<void>
  /** 从「未归类」页把笔记拖到主题 —— 这里只给一句指路，不做落点 */
  onGoTopics: () => void
}

export function TopicDetail({ topic, pages, onOpenPage, onContextMenu, onRemoveMember, onRename, onDelete, onGoTopics }: TopicDetailProps) {
  const isUnfiled = !topic
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  const name = topic?.name ?? '未归类'
  const color = topic ? topicColorOf(topic.color) : 'var(--text-muted)'
  const groups = groupPagesByDir(pages)
  const dirCount = topicDirCount(pages)

  const submitRename = async (): Promise<void> => {
    const v = draft.trim()
    if (!v || busy) return
    if (v === name) { setRenaming(false); return }
    setBusy(true)
    const err = await onRename(v)
    setBusy(false)
    if (err) { setError(err); return }
    setRenaming(false); setError(null)
  }

  return (
    <div className="kb-view-in flex-1 min-w-0 overflow-y-auto" data-wb="kbTopicDetail" style={{ '--sc': color } as React.CSSProperties}>
      <div className="mx-auto max-w-[860px] px-10 py-10">
        {/* ===== hero ===== */}
        <div className="mb-7">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
            {isUnfiled ? <List size={12} /> : <LayoutGrid size={12} style={{ color }} />}
            <span>{isUnfiled ? '未归类' : '主题'}</span>
            <span className="text-[var(--text-disabled)]">·</span>
            <span>{pages.length} 篇</span>
            <span className="text-[var(--text-disabled)]">·</span>
            <span>跨 {dirCount} 个目录</span>
          </div>
          {renaming ? (
            <div className="flex flex-col gap-1">
              <input
                autoFocus
                value={draft}
                onChange={(e) => { setDraft(e.target.value); setError(null) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void submitRename() }
                  if (e.key === 'Escape') { e.preventDefault(); setRenaming(false); setError(null) }
                }}
                onBlur={() => { if (!error) setRenaming(false) }}
                className="h-10 w-full max-w-[420px] rounded-md border border-[var(--accent)] bg-[var(--input-bg)] px-2.5 text-[24px] font-bold text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--accent)]/15"
              />
              {error && <span className="text-[11px] text-[var(--danger)]">{error}</span>}
            </div>
          ) : (
            <h1 className="text-[26px] font-bold leading-snug text-[var(--text-primary)]">{name}</h1>
          )}
          {(isUnfiled || (topic?.desc ?? '').trim()) && (
            <p className="mt-2 max-w-[640px] text-[13px] leading-relaxed text-[var(--text-secondary)]">
              {isUnfiled
                ? '还没有加入任何主题的笔记。切到「主题」视图，把笔记拖到主题卡上即可归类；拖动只改成员关系，不会移动文件。'
                : topic?.desc}
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {isUnfiled ? (
              <button
                type="button"
                onClick={onGoTopics}
                className="flex items-center gap-1.5 rounded-md border border-[var(--border-color)] px-2.5 py-1.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                去主题里归类 <ChevronRight size={13} />
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => { setRenaming(true); setDraft(name); setError(null) }}
                  className="flex items-center gap-1.5 rounded-md border border-[var(--border-color)] px-2.5 py-1.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                >
                  <Pencil size={13} /> 重命名
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="flex items-center gap-1.5 rounded-md border border-[var(--border-color)] px-2.5 py-1.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:border-[var(--danger)] hover:text-[var(--danger)]"
                >
                  <Trash2 size={13} /> 删除主题
                </button>
              </>
            )}
          </div>
          {confirmDelete && !isUnfiled && (
            <div className="kb-item-in mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/[0.07] px-3 py-2 text-[12px] text-[var(--text-secondary)]">
              <span>删除主题不会删除笔记，只是解散这个集合。<b className="text-[var(--text-primary)]">确认删除「{name}」？</b></span>
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => { setConfirmDelete(false); void onDelete() }}
                  className="rounded-md bg-[var(--danger)] px-2.5 py-1 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90"
                >
                  确认删除
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-md border border-[var(--border-color)] px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ===== 成员（按目录分组）===== */}
        {pages.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--border-color)] px-6 py-10 text-center text-[12.5px] leading-relaxed text-[var(--text-muted)]">
            {isUnfiled ? '所有笔记都已经归类了。' : '这个主题还没有笔记。把主题卡上的笔记拖进来即可加入；拖动不会移动文件。'}
          </div>
        ) : groups.map((g) => (
          <div key={g.key || '__root'} className="mb-5">
            <div className="mb-1.5 flex items-center gap-2 px-1 text-[11px]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--sc,var(--text-disabled))]" style={{ opacity: 0.85 }} />
              <b className="font-semibold text-[var(--text-secondary)]">{g.label}</b>
              <span className="rounded-full bg-[var(--bg-tertiary)] px-1.5 text-[9.5px] leading-[15px] tabular-nums text-[var(--text-disabled)]">{g.pages.length}</span>
              <span className="ml-0.5 h-px flex-1 bg-[var(--border-color)] opacity-55" />
            </div>
            <div className="overflow-hidden rounded-lg border border-[var(--border-color)]/70">
              {g.pages.map((p, i) => (
                <div
                  key={p.id}
                  onClick={() => onOpenPage(p)}
                  onContextMenu={(e) => onContextMenu(e, p)}
                  onKeyDown={(e) => { if (e.key === 'Enter') onOpenPage(p) }}
                  tabIndex={0}
                  role="button"
                  className={`group/t flex cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors hover:bg-[var(--bg-hover)] ${i > 0 ? 'border-t border-[var(--border-color)]/60' : ''}`}
                >
                  <FileText size={14} className="shrink-0 text-[var(--text-muted)]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-medium text-[var(--text-primary)]">{p.title || '无标题'}</div>
                    {excerptOf(p) && <div className="mt-0.5 truncate text-[10.5px] text-[var(--text-muted)]">{excerptOf(p)}</div>}
                  </div>
                  <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-disabled)] group-hover/t:hidden">{formatRelTime(p.updatedAt)}</span>
                  {!isUnfiled && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onRemoveMember(p.id) }}
                      data-tip="从主题移除（只解散关系，不删笔记）" aria-label="从主题移除"
                      className="hidden shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] group-hover/t:block"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
