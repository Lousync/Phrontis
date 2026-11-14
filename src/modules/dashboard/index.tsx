import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pencil } from 'lucide-react'
import { dashboardGetSnapshot, onAiTeachCourseRefresh, toggleHabitCheck } from '../../lib/ipc'
import { notifyDataChanged, useDataChanged } from '../../lib/dataChanged'
import { useSettings } from '../../lib/SettingsContext'
import { showToast } from '../../lib/toast'
import { burstConfetti, ensureFeedbackStyles } from '../../lib/confetti'
import { ThemeFxLayer } from '../../components/shared/ThemeFxLayer'
import type { DashboardSnapshot, TabName } from '../../types'
import { MonthCalendar } from './MonthCalendar'
import { DayTimeline } from './DayTimeline'
import { UsageHeatmap } from './UsageHeatmap'
import { AiCourseWindow, ReadingList, WorkbenchWindow } from './ModuleWindow'
import { dateLine, orderTimeline, verdictParts } from './summary'

/**
 * 看板 · 今日纸（2026-09-27 首版；**2026-11-14 首页重做**）。
 *
 * 定位：**应用顶层视图**，不是工作台里的一个书签页。图标条最上面那枚「看板」进入，
 * 激活时左右栏与页面条整体退场（`WORKBENCH_TABBAR_EXCLUDED`），也不产生标签页。
 * 回看板只走那枚图标 —— 这里没有返回箭头，工作台 / AI 教学里也没有「↑ 看板」。
 *
 * 版面（原型 `tmp/home-view-proto/index.html#e`）：
 *   一句话结论 + 左侧月历 / 右侧今天的时间线（打卡窄窗在时间轴下、宽窗转右列）
 *   → 近一年使用热力图
 *   → 右列：AI 教学窗口 / 工作台窗口 / 在读
 *
 * 数据：主进程一次聚合（`dashboard:getSnapshot`），任一相关域变化就整体重取 ——
 * 快照本身就是一次读，增量刷新没意义（见 database/repositories/dashboardRepo.ts）。
 */

/** 一次取全量；任一相关域变化就重取 */
function useDashboardSnapshot(): DashboardSnapshot | null {
  const [snap, setSnap] = useState<DashboardSnapshot | null>(null)
  const load = useCallback(() => {
    void dashboardGetSnapshot().then(setSnap).catch((e) => {
      console.error('[dashboard] 取快照失败', e)
      setSnap(null)
    })
  }, [])
  useEffect(() => { load() }, [load])
  // 时间线 / 月历 / 打卡 / 热力图 / 在读 —— 任一域变化都要重取
  useDataChanged('schedule', load)
  useDataChanged('habit', load)
  useDataChanged('knowledge', load)
  useDataChanged('pdfReader', load)
  useDataChanged('readerState', load)
  useDataChanged('pomodoro', load)
  // AI 教学没有 DataChangeScope，走它自己的课程广播（大纲 / 进度变化）
  useEffect(() => onAiTeachCourseRefresh(() => load()), [load])
  return snap
}

/** 视口矮档：整页按比例收一档（标题 / 热力图 / 卡片内边距） */
function useCompactTier(): boolean {
  const [compact, setCompact] = useState(() => window.innerHeight < 940)
  useEffect(() => {
    const onResize = () => setCompact(window.innerHeight < 940)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return compact
}

function greetingOf(hour: number): string {
  if (hour < 6) return '夜深了'
  if (hour < 12) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function DashboardModule({ openTabs, lastTab, onOpenTab, onOpenWorkbench, onOpenBook, onJumpSchedule }: {
  /** 工作台当前打开的模块标签（右列「工作台窗口」列它们） */
  openTabs: TabName[]
  /** 最近停留过的那个标签（标「上次」） */
  lastTab: TabName | null
  onOpenTab: (tab: TabName) => void
  onOpenWorkbench: () => void
  onOpenBook?: (relPath: string) => void
  onJumpSchedule?: () => void
}) {
  const { s, update } = useSettings()
  const snap = useDashboardSnapshot()
  const compact = useCompactTier()
  // 主题氛围特效画布 + 打卡彩纸的样式（懒注入，挂载即保证）
  useEffect(() => { ensureFeedbackStyles() }, [])

  // 「现在」每分钟刷新一次：时间线上那一行的位置与时刻
  const [now, setNow] = useState(() => hhmm(new Date()))
  useEffect(() => {
    const id = window.setInterval(() => setNow(hhmm(new Date())), 60_000)
    return () => window.clearInterval(id)
  }, [])

  // 称呼（dashboardUserName）：入口就在 hero 的名字上（点一下行内改）
  const userName = s.dashboardUserName || ''
  const [nameEdit, setNameEdit] = useState<{ draft: string } | null>(null)
  const commitUserName = () => {
    if (!nameEdit) return
    const v = nameEdit.draft.trim()
    setNameEdit(null)
    if (v !== userName) void update('dashboardUserName', v)
  }

  const timeline = useMemo(
    () => orderTimeline(snap?.todos.today ?? [], now),
    [snap?.todos.today, now],
  )
  const verdict = useMemo(
    () => verdictParts({ openCount: timeline.openCount, lateCount: timeline.lateCount, nextAt: timeline.nextAt }),
    [timeline],
  )

  const toggleHabit = async (habitId: string, pos?: { x: number; y: number }) => {
    if (!snap) return
    try {
      await toggleHabitCheck(habitId, snap.today)
      if (pos) burstConfetti(pos.x, pos.y)
      notifyDataChanged('habit')
    } catch (e) {
      showToast({ type: 'error', message: '打卡失败', detail: (e as Error).message })
    }
  }

  // ⛔ 早退必须在全部 hook 之后（React #310）
  if (!snap) {
    return (
      <div className="grid h-full place-items-center text-[13px] text-[var(--text-muted)]">
        正在载入看板…
      </div>
    )
  }

  const greet = userName ? `${greetingOf(new Date().getHours())}，` : greetingOf(new Date().getHours())

  return (
    <div className="kb-theme-surface relative h-full">
      <ThemeFxLayer />
      <div className="relative z-[1] flex h-full flex-col overflow-y-auto px-6 pb-5 pt-4">
        <div className="mx-auto flex min-h-[560px] w-full max-w-[1800px] flex-1 flex-col min-[2000px]:max-w-[2000px]">

          {/* ---------- 顶部：一句话结论 + 两个 KPI ---------- */}
          <header className="flex flex-none items-end justify-between gap-6 px-0.5">
            <div className="min-w-0">
              <span className="block text-[9px] uppercase tracking-[0.14em] text-[var(--text-muted)]">{dateLine(snap.today)}</span>
              <h1 className={`mt-[7px] font-bold leading-[1.08] tracking-[-0.035em] text-[var(--text-primary)] ${compact ? 'text-[26px]' : 'text-[clamp(26px,2.1vw,36px)] min-[2000px]:text-[42px]'}`}>
                {nameEdit ? (
                  <input
                    autoFocus
                    value={nameEdit.draft}
                    onChange={(e) => setNameEdit({ draft: e.target.value })}
                    onBlur={commitUserName}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitUserName()
                      else if (e.key === 'Escape') setNameEdit(null)
                    }}
                    placeholder="称呼（留空则不显示）"
                    spellCheck={false}
                    className="block w-[260px] rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-1 text-[22px] font-normal tracking-normal text-[var(--text-primary)] outline-none transition-colors placeholder:text-[12px] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
                  />
                ) : (
                  <span
                    className="group inline-flex cursor-pointer items-baseline gap-1.5"
                    onClick={() => setNameEdit({ draft: userName })}
                    data-tip="点击修改称呼" aria-label="点击修改称呼"
                  >
                    <span
                      className="px-0.5"
                      style={{ background: 'linear-gradient(transparent 56%, color-mix(in srgb, var(--accent) 26%, transparent) 56%, color-mix(in srgb, var(--accent) 26%, transparent) 96%, transparent 96%)' }}
                    >
                      {userName ? <>{greet}<span>{userName}</span></> : greet}
                    </span>
                    <Pencil size={14} className="self-center opacity-0 transition-opacity duration-150 group-hover:opacity-40" />
                  </span>
                )}
              </h1>
              <p className={`mb-0 mt-[9px] text-[var(--text-secondary)] ${compact ? 'text-[11.5px]' : 'text-[12.5px] min-[2000px]:text-[14px]'} leading-[1.55]`}>
                {verdict.map((p, i) => p.strong ? <b key={i} className="font-semibold text-[var(--text-primary)]">{p.text}</b> : <span key={i}>{p.text}</span>)}
              </p>
            </div>

            <div className="flex flex-none items-end gap-[22px] pb-[3px]">
              {/* 专注 = 番茄钟场次分钟（pomodoro.days），不是 app 使用时长 ——
                  使用时长已经由下面那张热力图表达，这里再放一遍「专注」会是两个口径同名 */}
              <Kpi value={String(snap.pomodoro.days[snap.today] ?? 0)} label="分钟专注" compact={compact} />
              <Kpi value={String(snap.habit.streak)} label="天连续" compact={compact} />
            </div>
          </header>

          {/* ---------- 主体：左（纸 + 热力图）/ 右（两个窗口 + 在读） ---------- */}
          <div className="mt-3 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_330px] grid-rows-[minmax(0,1fr)] gap-3.5 min-[1500px]:grid-cols-[minmax(0,1fr)_420px] min-[2000px]:grid-cols-[minmax(0,1fr)_460px] max-[1080px]:grid-cols-1 max-[1080px]:grid-rows-none">
            <div className="flex min-h-0 min-w-0 flex-col gap-3 max-[1080px]:min-h-[520px]">
              {/* 今日纸：左月历 / 右今天 */}
              <section
                className="kb-view-in flex min-h-0 flex-1 flex-col rounded-[18px] border border-[var(--border-color)] bg-[var(--card-bg)] px-4 pb-3 pt-3.5 shadow-[0_2px_10px_rgba(20,35,25,0.045)]"
                style={{ animationDelay: '60ms' }}
              >
                <div className="@container min-h-0 flex-1">
                  <div className="grid h-full min-h-0 grid-cols-1 gap-3.5 @min-[720px]:grid-cols-[minmax(200px,300px)_minmax(0,1fr)] @min-[720px]:gap-[18px]">
                    <div className="hidden min-h-0 @min-[720px]:flex">
                      <MonthCalendar
                        month={snap.calendar.month}
                        days={snap.calendar.days}
                        today={snap.today}
                        onOpenDay={() => onJumpSchedule?.()}
                      />
                    </div>

                    {/* 今天：头 + 时间线 + 打卡（宽窗打卡转右列） */}
                    <div className="@container min-h-0">
                      <div className="grid h-full min-h-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto] @min-[660px]:grid-cols-[minmax(0,1fr)_176px] @min-[660px]:grid-rows-[auto_minmax(0,1fr)] @min-[660px]:gap-x-[22px] @min-[1080px]:grid-cols-[minmax(0,1fr)_210px]">
                        <div className="col-span-1 flex flex-none items-baseline gap-2.5 border-b border-[var(--border-color)] px-1 pb-[11px] @min-[660px]:col-span-2">
                          <b className="text-[14px] font-bold tracking-[-0.01em] text-[var(--text-primary)] min-[2000px]:text-[15.5px]">今天</b>
                          <span className="text-[9.5px] text-[var(--text-muted)]">{snap.todos.doneToday}/{snap.todos.totalToday} 件</span>
                          <span className="flex-1" />
                          <button
                            type="button"
                            onClick={() => onJumpSchedule?.()}
                            className="text-[10px] text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
                          >
                            打开日程 →
                          </button>
                        </div>

                        <div className="flex min-h-0 w-full max-w-[760px] flex-col @min-[1080px]:max-w-[900px]">
                          <DayTimeline model={timeline} now={now} onOpenSchedule={() => onJumpSchedule?.()} />
                        </div>

                        {snap.habit.items.length > 0 && (
                        <div className="flex flex-none flex-wrap items-center gap-1.5 border-t border-[var(--border-color)] px-1 pt-[11px] @min-[660px]:col-start-2 @min-[660px]:row-start-2 @min-[660px]:flex-col @min-[660px]:items-stretch @min-[660px]:gap-[7px] @min-[660px]:border-l @min-[660px]:border-t-0 @min-[660px]:pb-1 @min-[660px]:pl-[18px] @min-[660px]:pt-0.5">
                          {snap.habit.items.map((h) => (
                            <button
                              key={h.id}
                              type="button"
                              onClick={(e) => {
                                if (h.done) { void toggleHabit(h.id); return }
                                const r = e.currentTarget.getBoundingClientRect()
                                void toggleHabit(h.id, { x: r.left + 12, y: r.top + r.height / 2 })
                              }}
                              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[9.5px] transition-colors min-[2000px]:px-3 min-[2000px]:py-1.5 min-[2000px]:text-[10.5px] ${
                                h.done
                                  ? 'border-[color-mix(in_srgb,var(--accent)_34%,var(--border-color))] bg-[color-mix(in_srgb,var(--accent)_8%,var(--card-bg))] text-[var(--text-primary)]'
                                  : 'border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[color-mix(in_srgb,var(--text-primary)_18%,transparent)]'
                              }`}
                            >
                              <i aria-hidden className="h-[5px] w-[5px] flex-none rounded-[2px]" style={{ background: h.color }} />
                              {h.name}
                            </button>
                          ))}
                          <span className="ml-auto text-[8.5px] tabular-nums text-[var(--text-muted)] @min-[660px]:ml-0.5 @min-[660px]:mt-2">
                            {/* 分母用快照里的真实习惯总数，不是被 20 条上限截断的 items.length */}
                            {snap.habit.doneToday}/{snap.habit.habits}
                          </span>
                        </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              <UsageHeatmap days={snap.usage.days} today={snap.today} todayMinutes={snap.usage.todayMinutes} compact={compact} />
            </div>

            {/* 右列：两个模块窗口 + 在读 */}
            <aside className="flex min-h-0 flex-col gap-3">
              <AiCourseWindow course={snap.course} onOpen={() => onOpenTab('aiTeaching')} delay={90} />
              <WorkbenchWindow
                tabs={openTabs}
                lastTab={lastTab}
                onOpenTab={onOpenTab}
                onOpenWorkbench={onOpenWorkbench}
                delay={140}
              />
              <ReadingList
                reading={snap.reading}
                onOpenBook={(relPath) => onOpenBook?.(relPath)}
                onOpenShelf={() => onOpenTab('bookshelf')}
                delay={190}
              />
            </aside>
          </div>
        </div>
      </div>
    </div>
  )
}

function Kpi({ value, label, compact }: { value: string; label: string; compact: boolean }) {
  return (
    <span className="flex flex-col items-end gap-px">
      <b className={`font-bold leading-none tracking-[-0.02em] tabular-nums text-[var(--text-primary)] ${compact ? 'text-[20px]' : 'text-[22px] min-[2000px]:text-[26px]'}`}>{value}</b>
      <span className="text-[9px] text-[var(--text-muted)]">{label}</span>
    </span>
  )
}
