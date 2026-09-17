import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, CircleHelp, Star, ClipboardCheck } from 'lucide-react'
import type { QuizRecordDto } from '../../../types'
import { quizRecordList, quizRecordStats } from '../../../lib/ipc'
import { useDataChanged } from '../../../lib/dataChanged'
import { QUIZ_FOCUS_BOOK_EVENT } from '../../../lib/workbenchLayout'

/**
 * 错题本专属左栏（v3.4.0 第四轮拍板④：错题本从知识库目录树侧栏剥离）。
 *
 * 之前 quiz 模块态复用 knowledge 的目录树 portal（railModule==='quiz' 也传 sidebarEl），
 * 左栏显示的是知识库分类树——与错题本内容无关，逻辑不通。现在 quiz 态挂本组件：
 * 错题/收藏视图入口 + 科目（书）列表（点击 → QUIZ_FOCUS_BOOK_EVENT 让 QuizCollection
 * 聚焦该书）+ 统计概览。数据 = 现有 quiz.* IPC，零新增主进程面。
 */

type Stats = { wrong: number; mastered: number; todayWrong: number; correctRate: number }

export function QuizNavPanel() {
  const [records, setRecords] = useState<QuizRecordDto[]>([])
  const [stats, setStats] = useState<Stats | null>(null)

  const load = useCallback(async () => {
    try {
      const [list, st] = await Promise.all([quizRecordList({ kind: 'wrong' }), quizRecordStats()])
      setRecords(list)
      setStats(st ?? null)
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

  const focus = (detail: { kind?: 'wrong' | 'favorite'; book?: string | null }) =>
    window.dispatchEvent(new CustomEvent(QUIZ_FOCUS_BOOK_EVENT, { detail }))

  const statRow = (label: string, value: number | string) => (
    <div className="flex items-center justify-between rounded-md px-2.5 py-1 text-[12px] text-[var(--text-secondary)]">
      <span>{label}</span>
      <span className="font-medium text-[var(--text-primary)]">{value}</span>
    </div>
  )

  return (
    <div data-wb="quizNav" className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
        {/* 视图入口：点击切到 QuizCollection 对应 kind */}
        <button
          onClick={() => focus({ kind: 'wrong', book: null })}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <CircleHelp size={14} className="shrink-0 text-[var(--danger)]" />
          错题视图
        </button>
        <button
          onClick={() => focus({ kind: 'favorite', book: null })}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <Star size={14} className="shrink-0 text-[var(--warning)]" />
          收藏视图
        </button>

        {/* 统计概览（真实 vault 数据，与错题本界面同源） */}
        <div className="mt-2 flex flex-col gap-0.5 border-t border-[var(--border-color)] pt-2">
          <div className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-1 text-[10.5px] text-[var(--text-muted)]">
            <ClipboardCheck size={11} />
            概览
          </div>
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

        {/* 科目（书）列表：点击 → 错题本视图聚焦该书 */}
        <div className="mt-2 flex flex-col gap-0.5 border-t border-[var(--border-color)] pt-2">
          <div className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-1 text-[10.5px] text-[var(--text-muted)]">
            <BookOpen size={11} />
            科目
          </div>
          {books.length === 0 ? (
            <div className="px-2.5 py-1.5 text-[11.5px] text-[var(--text-muted)]">还没有错题记录</div>
          ) : (
            books.map(([name, count]) => (
              <button
                key={name}
                onClick={() => focus({ book: name })}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{count}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
