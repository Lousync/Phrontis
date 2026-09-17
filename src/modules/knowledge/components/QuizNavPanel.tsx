import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, CircleHelp, Star, ClipboardCheck, Tag, Folder, FolderPlus, Trash2 } from 'lucide-react'
import type { QuizRecordDto, QuizCollectionDto, QuizTagDto } from '../../../types'
import {
  quizRecordList, quizRecordStats, quizTagList, quizTagDelete,
  quizCollectionList, quizCollectionCreate, quizCollectionDelete,
} from '../../../lib/ipc'
import { useDataChanged } from '../../../lib/dataChanged'
import { showToast } from '../../../lib/toast'
import { QUIZ_FOCUS_BOOK_EVENT } from '../../../lib/workbenchLayout'

/**
 * 错题本专属左栏（v3.4.0 第四轮拍板④剥离；批次5 反馈轮合并主体内置侧栏）。
 *
 * 反馈前主体 QuizCollection 还有一条内置筛选侧栏（来源/标签/分组）→ 与本面板双侧边栏。
 * 现整段合并到左栏：视图入口 + 概览 + 来源（书）+ 标签筛选 + 自定义分组，主体内不再渲染侧栏；
 * 筛选选择经 QUIZ_FOCUS_BOOK_EVENT 下发（已扩为筛选快照：kind/book/tagIds/collectionId，
 * QuizCollection 逐字段采用）。数据 = 现有 quiz.* IPC 直调，零新增主进程面。
 */

type Stats = { wrong: number; mastered: number; todayWrong: number; correctRate: number }

export function QuizNavPanel() {
  const [records, setRecords] = useState<QuizRecordDto[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [tags, setTags] = useState<QuizTagDto[]>([])
  const [collections, setCollections] = useState<QuizCollectionDto[]>([])
  // 筛选本地镜像（权威源在 QuizCollection；本面板每次选择即下发快照，主体内无筛选 UI）
  const [book, setBook] = useState<string | null>(null)
  const [tagIds, setTagIds] = useState<Set<string>>(new Set())
  const [collectionId, setCollectionId] = useState<string | null>(null)
  const [newCollection, setNewCollection] = useState('')

  const load = useCallback(async () => {
    try {
      const [list, st, tg, cols] = await Promise.all([
        quizRecordList({ kind: 'wrong' }), quizRecordStats(), quizTagList(), quizCollectionList(),
      ])
      setRecords(list)
      setStats(st ?? null)
      setTags(tg ?? [])
      setCollections(cols ?? [])
    } catch { /* 无数据/未就绪：区留空 */ }
  }, [])
  useEffect(() => { void load() }, [load])
  // AI 整理错题本（打标/备注/分组/移除）→ 主进程广播 scope='quiz'，左栏计数同步刷新
  useDataChanged('quiz', () => { void load() })

  /** 科目（书）列表：全局口径按来源空间分书（同 QuizCollection bookKeyOf 全局分支） */
  const books = useMemo(() => {
    const m = new Map<string, number>()
    records.forEach((r) => {
      const k = r.sourceSpace || '未分类'
      m.set(k, (m.get(k) ?? 0) + 1)
    })
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1])
  }, [records])

  /** 筛选快照下发（逐字段可选：未携带的字段主体侧保持不动） */
  const apply = (patch: { kind?: 'wrong' | 'favorite'; book?: string | null; tagIds?: string[]; collectionId?: string | null }) =>
    window.dispatchEvent(new CustomEvent(QUIZ_FOCUS_BOOK_EVENT, { detail: patch }))

  const pickBook = (name: string | null) => { setBook(name); apply({ book: name }) }
  const toggleTag = (id: string) => {
    setTagIds(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      apply({ tagIds: [...n] })
      return n
    })
  }
  const pickCollection = (id: string | null) => { setCollectionId(id); apply({ collectionId: id }) }

  const createCol = async () => {
    const name = newCollection.trim()
    if (!name) return
    try {
      await quizCollectionCreate(name)
      setNewCollection('')
      showToast({ type: 'success', message: '分组已创建' })
    } catch { showToast({ type: 'error', message: '创建分组失败' }) }
  }
  const removeCol = async (id: string) => {
    try { await quizCollectionDelete(id) } catch { showToast({ type: 'error', message: '删除分组失败' }) }
  }
  const removeTag = async (id: string) => {
    try { await quizTagDelete(id) } catch { /* ignore */ }
  }

  const statRow = (label: string, value: number | string) => (
    <div className="flex items-center justify-between rounded-md px-2.5 py-1 text-[12px] text-[var(--text-secondary)]">
      <span>{label}</span>
      <span className="font-medium text-[var(--text-primary)]">{value}</span>
    </div>
  )

  const sectionHead = (icon: React.ReactNode, label: string) => (
    <div className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-1 text-[10.5px] text-[var(--text-muted)]">
      {icon}
      {label}
    </div>
  )

  return (
    <div data-wb="quizNav" className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
        {/* 视图入口：点击切到 QuizCollection 对应 kind（并重置书目聚焦） */}
        <button
          onClick={() => { setBook(null); apply({ kind: 'wrong', book: null }) }}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <CircleHelp size={14} className="shrink-0 text-[var(--danger)]" />
          错题视图
        </button>
        <button
          onClick={() => { setBook(null); apply({ kind: 'favorite', book: null }) }}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <Star size={14} className="shrink-0 text-[var(--warning)]" />
          收藏视图
        </button>

        {/* 统计概览（真实 vault 数据，与错题本界面同源） */}
        <div className="mt-2 flex flex-col gap-0.5 border-t border-[var(--border-color)] pt-2">
          {sectionHead(<ClipboardCheck size={11} />, '概览')}
          {stats ? (
            <>
              {statRow('待复习', stats.wrong)}
              {statRow('已掌握', stats.mastered)}
              {statRow('今日错题', stats.todayWrong)}
              {statRow('正确率', `${stats.correctRate}%`)}
            </>
          ) : (
            <div className="px-2.5 py-1.5 text-[11.5px] text-[var(--text-muted)]">暂无数据</div>
          )}
        </div>

        {/* 来源（书）列表：点击聚焦该书（原主体内置侧栏第一段，合并至此） */}
        <div className="mt-2 flex flex-col gap-0.5 border-t border-[var(--border-color)] pt-2">
          {sectionHead(<BookOpen size={11} />, '来源')}
          <button
            onClick={() => pickBook(null)}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
              book === null ? 'bg-[var(--bg-selected)] font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
            }`}
          >
            <span className="min-w-0 flex-1 truncate">全部</span>
            <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{records.length}</span>
          </button>
          {books.map(([name, count]) => (
            <button
              key={name}
              onClick={() => pickBook(name === book ? null : name)}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                book === name ? 'bg-[var(--bg-selected)] font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{count}</span>
            </button>
          ))}
          {books.length === 0 && (
            <div className="px-2.5 py-1.5 text-[11.5px] text-[var(--text-muted)]">还没有错题记录</div>
          )}
        </div>

        {/* 标签筛选：多选任一命中（原主体内置侧栏第二段，合并至此；右键删除标签） */}
        <div className="mt-2 flex flex-col gap-0.5 border-t border-[var(--border-color)] pt-2">
          {sectionHead(<Tag size={11} />, '按标签')}
          {tags.length === 0 ? (
            <div className="px-2.5 py-1.5 text-[11.5px] text-[var(--text-muted)]">暂无标签，展开题目可添加</div>
          ) : (
            <div className="flex flex-wrap gap-1 px-2 pt-0.5">
              {tags.map(t => {
                const on = tagIds.has(t.id)
                return (
                  <button
                    key={t.id}
                    onClick={() => toggleTag(t.id)}
                    onContextMenu={e => { e.preventDefault(); void removeTag(t.id) }}
                    title={on ? '取消筛选（右键删除标签）' : '按此标签筛选（右键删除标签）'}
                    className={`rounded-full border px-1.5 py-0.5 text-[11px] transition-colors ${
                      on ? 'text-white' : 'bg-transparent'
                    }`}
                    style={on
                      ? { borderColor: t.color, background: t.color }
                      : { borderColor: t.color, color: t.color }}
                  >
                    {t.name}
                  </button>
                )
              })}
            </div>
          )}
          {tagIds.size > 0 && (
            <button
              onClick={() => { setTagIds(new Set()); apply({ tagIds: [] }) }}
              className="mx-2.5 mt-1.5 rounded px-2 py-0.5 text-left text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              清除标签筛选 ({tagIds.size})
            </button>
          )}
        </div>

        {/* 自定义分组：单选 + 删除 + 新建（原主体内置侧栏第三段，合并至此） */}
        <div className="mt-2 flex flex-col gap-0.5 border-t border-[var(--border-color)] pt-2 pb-1">
          {sectionHead(<Folder size={11} />, '自定义分组')}
          <button
            onClick={() => pickCollection(null)}
            className={`w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
              collectionId === null ? 'bg-[var(--bg-selected)] font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
            }`}
          >
            全部分组
          </button>
          {collections.map(c => (
            <div key={c.id} className="group flex items-center gap-1 pr-1.5">
              <button
                onClick={() => pickCollection(c.id === collectionId ? null : c.id)}
                className={`min-w-0 flex-1 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                  collectionId === c.id ? 'bg-[var(--bg-selected)] font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                }`}
              >
                <span className="block truncate">{c.name}<span className="ml-1 text-[11px] font-normal text-[var(--text-muted)]">（{c.count}）</span></span>
              </button>
              <button
                onClick={() => void removeCol(c.id)}
                className="hidden shrink-0 rounded p-0.5 text-[var(--text-muted)] transition-colors hover:text-[var(--danger)] group-hover:block"
                title="删除分组"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
          <div className="mx-2.5 mt-1.5 flex items-center gap-1">
            <input
              value={newCollection}
              onChange={e => setNewCollection(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void createCol() }}
              placeholder="新建分组"
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
            />
            <button onClick={() => void createCol()} className="shrink-0 p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]" title="新建分组">
              <FolderPlus size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
