import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ScheduleTodo } from '../../../types'
import {
  getBlogPeriodStats,
  getScheduleTags, createScheduleTag, createScheduleTodo, getScheduleTodos,
  listSummaries,
} from '../../../lib/ipc'
import type { PeriodStats } from '../../../lib/ipc'
import {
  addDaysStr, nextWindowOf, summaryWindowsAt, summaryLabel, SUMMARY_TAG_DEFS,
  type SummaryKind, type SummaryWindow,
} from '../../../lib/summary'
import { useDataChanged } from '../../../lib/dataChanged'

/* ==========================================================================
 * 层级总结的三块：统计 / 下期任务 / 日志尾部入口
 *
 * 窗口口径一律走「日历口径」（`summaryWindowsAt` 或调用方传入的 start-end）——
 * 与旧的 `getSummaryWindow`（总结日 −6 天）是两套，见 lib/summary.ts 头部说明。
 * ========================================================================== */

/**
 * 统计块：窗口内五项实时统计。
 *
 * **绝不落库**（DP v3.2.0 第 12 项拍板③）：补录了打卡、补写了日记之后，
 * 数字应当跟着变；需要持久化的只有正文（用户自己的复盘文字）。
 */
export function SummaryStats({ start, end }: { start: string; end: string }) {
  const [stats, setStats] = useState<PeriodStats | null>(null)

  useEffect(() => {
    let alive = true
    setStats(null) // 窗口变化先清空，绝不展示上一个窗口的数字
    void getBlogPeriodStats(start, end)
      .then((s) => { if (alive) setStats(s) })
      .catch(console.error)
    return () => { alive = false }
  }, [start, end])

  const rows: Array<{ label: string; value: string }> = [
    { label: '坚持打卡', value: `${stats?.checkins ?? '…'} 次` },
    { label: '博客文章', value: `${stats?.blogEntries ?? '…'} 篇` },
    { label: '新建知识页', value: `${stats?.knowledgePages ?? '…'} 个` },
    { label: '番茄钟专注', value: `${stats?.pomodoroMinutes ?? '…'} 分钟` },
    { label: '完成日程任务', value: `${stats?.scheduleDone ?? '…'} 项` },
  ]

  return (
    <div className="mt-4 border-y border-[var(--border-color)] divide-y divide-[var(--border-color)]">
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline justify-between py-2.5 text-[15px] leading-7">
          <span className="text-[var(--text-secondary)]">{r.label}</span>
          <span className="font-semibold tabular-nums text-[var(--text-primary)]">{r.value}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * 下期任务区：与日程模块联动（周 / 月 / 年任务标签）。
 *
 * 与改造前的差别只有窗口来源：落日 = 窗口结束的次日（原来是「总结日的下一天」），
 * DDL = 下一个同类窗口的倒数第二天 23:59（原来走 `getNextSummaryWindow` 扫总结日）。
 * 不再依赖「总结日」设置的原因：总结文件是日历口径，DDL 若还按总结日推，
 * 会出现「总结写的是这一周、任务却落到别的日子」。
 * 取 23:59 而非 00:00 —— 网格时间轴默认 07:00 起算，00:00 会算出负值被列容器裁掉，红线不可见。
 */
export function NextTasks({ kind, start, end }: { kind: SummaryKind; start: string; end: string }) {
  const [title, setTitle] = useState('')
  const [tasks, setTasks] = useState<ScheduleTodo[]>([])
  const [adding, setAdding] = useState(false)

  const nextDate = addDaysStr(end, 1)
  const tagDef = SUMMARY_TAG_DEFS[kind]
  const kindWord = kind === 'week' ? '周' : kind === 'month' ? '月' : '年'

  const load = useCallback(async (): Promise<void> => {
    try {
      const tags = await getScheduleTags()
      const tag = tags.find((t) => t.name === tagDef.name)
      if (!tag) { setTasks([]); return }
      const todos = await getScheduleTodos(nextDate)
      setTasks(todos.filter((t) => t.tagId === tag.id))
    } catch (e) { console.error(e) }
  }, [tagDef.name, nextDate])

  useEffect(() => { void load() }, [load])

  const addTask = useCallback(async (): Promise<void> => {
    const text = title.trim()
    if (!text || adding) return
    setAdding(true)
    try {
      const tags = await getScheduleTags()
      let tag = tags.find((t) => t.name === tagDef.name)
      if (!tag) tag = await createScheduleTag(tagDef.name, tagDef.color)

      const ddlDay = addDaysStr(nextWindowOf(kind, start, end).end, -1)
      const ddlTime = `${ddlDay} 23:59`

      await createScheduleTodo({
        title: text,
        date: nextDate,
        taskType: 'deadline',
        time: ddlTime,
        tagId: tag.id,
        description: `来自${kindWord}总结（${summaryLabel(kind, start, end)}），截止 ${ddlTime}，细节可在日程模块补充`,
      })
      setTitle('')
      await load()
    } catch (e) {
      console.error(e)
    } finally {
      setAdding(false)
    }
  }, [title, adding, tagDef, kind, start, end, nextDate, kindWord, load])

  return (
    <>
      <h3 className="mt-8 mb-1 text-[17px] font-semibold text-[var(--text-primary)]">
        下{kind === 'week' ? '一周' : kind === 'month' ? '一个月' : '一年'}的任务
      </h3>

      <ul className="mt-3 space-y-0.5">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-baseline gap-2.5 py-1.5 text-[15px] leading-7">
            <span className={'shrink-0 select-none ' + (t.status === 'done' ? 'text-[var(--success)]' : 'text-[var(--text-muted)]')}>
              {t.status === 'done' ? '☑' : '☐'}
            </span>
            <span className={'min-w-0 flex-1 break-words ' + (t.status === 'done' ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-primary)]')}>
              {t.title}
            </span>
          </li>
        ))}
      </ul>

      {/* 内联添加：无框输入，像在文档里续写一行 */}
      <div className="group mt-1 flex items-center gap-2.5 py-1.5">
        <span className="shrink-0 select-none text-[var(--text-muted)] transition-colors group-focus-within:text-[var(--accent)]">➕</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void addTask() }}
          placeholder="添加任务，回车确认"
          maxLength={60}
          className="min-w-0 flex-1 border-none bg-transparent text-[15px] leading-7 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
        />
        {title.trim() && (
          <button
            onClick={() => void addTask()}
            disabled={adding}
            className="shrink-0 rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40"
          >
            添加
          </button>
        )}
      </div>
    </>
  )
}

/**
 * 日志尾部的「本期总结」入口卡片。
 *
 * 2026-09-15 改造（DP v3.2.0 第 12 项）：周/月/年总结从「日志正文里的虚拟附页」改为
 * **各自单独成文** —— 统计与下期任务都搬进了总结文档视图，日志里只留入口，
 * 免得同一份统计在日志里显示一次、在总结文件里又显示一次。
 *
 * 三档一律给出（本周 / 本月 / 今年），不再判断「今天是不是总结日」：
 * 想什么时候回顾就什么时候点，没写过就按需生成。
 */
export function SummaryPanel({ date }: { date: string }) {
  const wins = useMemo(() => summaryWindowsAt(date), [date])
  const [existing, setExisting] = useState<Set<string>>(new Set())

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await listSummaries()
      setExisting(new Set(list.map((s) => `${s.kind}|${s.start}|${s.end}`)))
    } catch { /* 仓库未打开时静默 */ }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useDataChanged('blog', () => { void refresh() })

  const openSummary = (w: SummaryWindow): void => {
    window.dispatchEvent(new CustomEvent('blog-open-summary', { detail: { kind: w.kind, start: w.start, end: w.end } }))
  }

  return (
    <div className="mt-12 border-t border-[var(--border-color)] pt-8">
      <h2 className="text-[22px] font-bold text-[var(--text-primary)]">📊 本期总结</h2>
      <p className="mt-2 text-[13px] leading-6 text-[var(--text-muted)]">
        周 / 月 / 年总结各自单独成文，点开时按需生成。
      </p>
      <div className="mt-4 border-y border-[var(--border-color)] divide-y divide-[var(--border-color)]">
        {wins.map((w) => {
          const has = existing.has(`${w.kind}|${w.start}|${w.end}`)
          return (
            <div key={w.kind} className="flex items-center gap-3 py-2.5 text-[15px] leading-7">
              <span className="text-[var(--text-secondary)]">{w.label}</span>
              <span className="text-[11.5px] tabular-nums text-[var(--text-muted)]">{w.start} ~ {w.end}</span>
              <button
                onClick={() => openSummary(w)}
                title={has ? '打开这一期的总结' : '生成并打开这一期的总结'}
                className={`ml-auto shrink-0 rounded border px-2.5 py-[3px] text-[12px] transition-colors ${
                  has
                    ? 'border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]'
                    : 'border-dashed border-[var(--border-color)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]'
                }`}
              >
                {has ? '打开' : '生成'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
