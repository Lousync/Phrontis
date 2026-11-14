import { buildMonthGrid, monthHead } from './summary'

/**
 * 月历（2026-11-14 首页重做）：**只显示当月**，周一起排，今天填色、有记录的日期打点。
 *
 * 刻意没有翻月箭头（v1）：看板的日历是「这个月我过得怎么样」的一瞥，
 * 真要翻月份是去日程模块的事 —— 点任意日期就是进日程那一天。
 *
 * 行高走 `minmax(0, 1fr)` 而不是固定 62px：矮窗口时整张纸不滚动，日历自己压扁。
 */

const DOW = ['一', '二', '三', '四', '五', '六', '日']

interface Props {
  /** 'YYYY-MM' */
  month: string
  /** 'YYYY-MM-DD' → { total, done } */
  days: Record<string, { total: number; done: number }>
  today: string
  /** 点日期 → 进日程（App 侧切标签；v1 不带日期参数） */
  onOpenDay: () => void
}

export function MonthCalendar({ month, days, today, onOpenDay }: Props) {
  const cells = buildMonthGrid(month)
  const head = monthHead(month)

  return (
    <div className="flex w-full min-w-0 min-h-0 flex-col pr-[18px] @min-[720px]:border-r @min-[720px]:border-[var(--border-color)]">
      <div className="flex flex-none items-baseline gap-1.5 px-0.5 pb-2.5">
        <b className="text-[14px] font-bold tracking-[-0.01em] text-[var(--text-primary)]">{head.title}</b>
        <span className="text-[9.5px] text-[var(--text-muted)]">{head.year}</span>
      </div>

      <div className="grid min-h-0 max-h-[420px] flex-1 grid-cols-7 grid-rows-[18px_repeat(6,minmax(0,1fr))] gap-[2px]">
        {DOW.map((d) => (
          <span key={d} className="grid place-items-center text-[8px] text-[var(--text-muted)] min-[2000px]:text-[9px]">{d}</span>
        ))}
        {cells.map((date, i) => {
          if (!date) return <i key={`out-${i}`} className="invisible" />
          const info = days[date]
          const isToday = date === today
          return (
            <button
              key={date}
              type="button"
              onClick={onOpenDay}
              data-tip={`${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日${info ? ` · ${info.done}/${info.total} 件` : ''}`}
              aria-label={`${date}${info ? ` ${info.done}/${info.total} 件` : ''}`}
              className={`relative grid place-items-center rounded-[8px] text-[11px] tabular-nums transition-colors min-[2000px]:text-[12px] ${
                isToday
                  ? 'font-bold text-white'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              {isToday && <span aria-hidden className="absolute left-1/2 top-1/2 h-[26px] w-[26px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--accent)]" />}
              <span className="relative">{Number(date.slice(8, 10))}</span>
              {info && info.total > 0 && (
                <span
                  aria-hidden
                  className="absolute bottom-[4px] h-[3px] w-[3px] rounded-full"
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
