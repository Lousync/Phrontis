import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { dashboardGetMonth } from '../../lib/ipc'
import { buildMonthGrid, monthHead, shiftMonth } from './summary'

/**
 * 月历（2026-11-14 首页重做；同日第二轮：翻月 + 正方形格子）。
 *
 * 版面口径：
 * - **格子是正方形**（`aspect-square`）—— 旧的 `minmax(0,1fr)` 行高会让格子随卡片高度拉成长方形，
 *   看着不像日历。正方形意味着格子尺寸由**列宽**决定，所以整块在左列里**垂直居中**，
 *   多出来的高度留在上下，而不是把格子压扁 / 拉长。
 * - 今天填一个随格子缩放的圆（`inset-[10%]`，不再写死 26px —— 小窗口下会顶满格子）。
 * - 有安排的日期打点；点任意日期进日程。
 *
 * 翻月（2026-11-14 用户要求）：左右箭头 + 点标题回本月。
 * 当月数据来自快照（跟着看板一起刷新），其它月份走 `dashboard:getMonth` 单独取 ——
 * 只在翻过去那一刻取一次，本页不留缓存（快照一刷新，缓存就该作废，省得两处口径打架）。
 */

const DOW = ['一', '二', '三', '四', '五', '六', '日']

type DayCounts = Record<string, { total: number; done: number }>

interface Props {
  /** 当月 'YYYY-MM'（主进程给，避免两端算出不同的「今天」） */
  month: string
  /** 当月 'YYYY-MM-DD' → { total, done } */
  days: DayCounts
  today: string
  /** 点日期 → 进日程 */
  onOpenDay: () => void
}

export function MonthCalendar({ month, days, today, onOpenDay }: Props) {
  // 显示的月份：null = 跟快照当月（用户翻走后不再自动跟）
  const [view, setView] = useState(month)
  const [remote, setRemote] = useState<{ month: string; days: DayCounts } | null>(null)
  const [loading, setLoading] = useState(false)

  // 跨月了（快照的当月变了，例如挂机过零点）才把视图拉回当月；同月内的刷新不打乱用户翻月
  const monthPropRef = useRef(month)
  useEffect(() => {
    if (monthPropRef.current === month) return
    monthPropRef.current = month
    setView(month)
  }, [month])

  // 翻到别的月份 → 单独取一次；回到当月直接吃快照，不再请求
  useEffect(() => {
    if (view === month) { setRemote(null); setLoading(false); return }
    if (remote?.month === view) return
    let alive = true
    setLoading(true)
    dashboardGetMonth(view)
      .then((r) => { if (alive && r?.month === view) setRemote({ month: r.month, days: r.days ?? {} }) })
      .catch(() => { if (alive) setRemote({ month: view, days: {} }) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, month])

  const shownDays = view === month ? days : (remote?.month === view ? remote.days : {})
  const cells = buildMonthGrid(view)
  const head = monthHead(view)
  const isCurrent = view === month

  return (
    <div className="flex h-full w-full min-w-0 flex-col justify-center pr-[18px] @min-[720px]:border-r @min-[720px]:border-[var(--border-color)]">
      <div className="flex flex-none items-center gap-1 px-0.5 pb-2.5">
        <button
          type="button"
          onClick={() => setView(shiftMonth(view, -1))}
          aria-label="上个月"
          data-tip="上个月"
          className="grid h-5 w-5 place-items-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <ChevronLeft size={13} />
        </button>
        <button
          type="button"
          onClick={() => setView(month)}
          disabled={isCurrent}
          aria-label={isCurrent ? `${head.title}${head.year}` : `${head.title}${head.year}（点击回到本月）`}
          data-tip={isCurrent ? undefined : '回到本月'}
          className="flex items-baseline gap-1.5 rounded-md px-1 py-0.5 transition-colors enabled:hover:bg-[var(--bg-hover)]"
        >
          <b className="text-[14px] font-bold tracking-[-0.01em] text-[var(--text-primary)]">{head.title}</b>
          <span className="text-[9.5px] tabular-nums text-[var(--text-muted)]">{head.year}</span>
        </button>
        <button
          type="button"
          onClick={() => setView(shiftMonth(view, 1))}
          aria-label="下个月"
          data-tip="下个月"
          className="grid h-5 w-5 place-items-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <ChevronRight size={13} />
        </button>
        {/* 翻走之后才出现的回程票：标题本身也能点，但「点标题能回」不是自解释的 */}
        {!isCurrent && (
          <button
            type="button"
            onClick={() => setView(month)}
            aria-label="回到本月"
            className="kb-view-fade ml-auto rounded-md px-1.5 py-0.5 text-[9.5px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]"
          >
            回到本月
          </button>
        )}
      </div>

      <div className="grid flex-none grid-cols-7 gap-1">
        {DOW.map((d) => (
          <span key={d} className="grid h-4 place-items-center text-[8px] text-[var(--text-muted)] min-[2000px]:text-[9px]">{d}</span>
        ))}
      </div>

      {/* key = 月份：翻月时重放淡入（令牌见 docs/ui-animation-plan.md 的 .kb-view-fade） */}
      <div key={view} className={`kb-view-fade mt-1 grid min-h-0 grid-cols-7 gap-1 ${loading ? 'opacity-45' : ''} transition-opacity`}>
        {cells.map((date, i) => {
          if (!date) return <i key={`out-${i}`} className="invisible aspect-square" />
          const info = shownDays[date]
          const isToday = date === today
          const dayNum = Number(date.slice(8, 10))
          return (
            <button
              key={date}
              type="button"
              onClick={onOpenDay}
              aria-current={isToday ? 'date' : undefined}
              data-tip={`${Number(date.slice(5, 7))} 月 ${dayNum} 日${info ? ` · ${info.done}/${info.total} 件` : ''}`}
              aria-label={`${date}${info ? ` ${info.done}/${info.total} 件` : ''}`}
              className={`relative grid aspect-square place-items-center rounded-[7px] text-[11px] tabular-nums transition-colors min-[2000px]:text-[12px] ${
                isToday ? 'font-bold text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              {isToday && <span aria-hidden className="absolute inset-[9%] rounded-full bg-[var(--accent)]" />}
              <span className="relative">{dayNum}</span>
              {info && info.total > 0 && (
                <span
                  aria-hidden
                  className="absolute bottom-[13%] h-[3px] w-[3px] rounded-full"
                  style={{ background: isToday ? 'rgba(255,255,255,.9)' : 'color-mix(in srgb, var(--accent) 55%, transparent)' }}
                />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
