import type { TimelineModel } from './summary'

/**
 * 今天的时间线（2026-11-14 首页重做）。
 *
 * 一条竖线 + 每件事一个节点：**逾期的红点、完成的划线**，中间插一行「现在」。
 * 行本身可点（= 去日程），所以这里不用 `<table>` 之类的语义，直接是按钮。
 *
 * ★ 行宽上限 760 由外层给（`max-w`），行内是 `minmax(0,1fr) auto` ——
 *   标题吃掉剩余宽度、状态标签贴右缘。窗口再宽也不会把标签推到很远，
 *   这是上一版「标题和标签之间空一大片」的根治点。
 */

interface Props {
  model: TimelineModel
  /** 当前时刻 'HH:mm'（父级每分钟刷新，用来画「现在」那一行） */
  now: string
  onOpenSchedule: () => void
}

export function DayTimeline({ model, now, onOpenSchedule }: Props) {
  const { rows, nowIndex } = model

  return (
    <div className="relative flex min-h-0 flex-1 flex-col justify-evenly overflow-hidden py-1">
      {/* 时间轴竖线：穿过节点列（46 时间列 + 10 gap + 16 节点列的一半 = 64）。没有条目时不画 */}
      {rows.length > 0 && (
        <span aria-hidden className="absolute bottom-[18px] left-[64px] top-[18px] w-px bg-[var(--border-color)]" />
      )}

      {rows.length === 0 && (
        <div className="flex flex-1 flex-col items-start justify-center gap-2 px-2 text-[12px] text-[var(--text-muted)]">
            <span>今天还没有安排。</span>
          <button type="button" onClick={onOpenSchedule} className="text-[var(--accent)] transition-colors hover:underline">
            去日程排一件事 →
          </button>
        </div>
      )}

      {rows.map((t, i) => (
        <div key={t.id}>
          {i === nowIndex && <NowRow now={now} />}
          <button
            type="button"
            onClick={onOpenSchedule}
            data-tip="打开日程" aria-label={`${t.time ?? '未排时间'} ${t.title}`}
            data-done={t.done ? '1' : undefined}
            className="group relative grid w-full grid-cols-[46px_16px_minmax(0,1fr)_auto] items-center gap-[10px] rounded-[9px] py-[9px] pr-2 text-left transition-colors hover:bg-[var(--bg-hover)] min-[2000px]:py-[13px]"
          >
            <span className="text-right text-[10px] tabular-nums text-[var(--text-muted)] min-[2000px]:text-[11px]">{t.time ?? '·'}</span>
            <span
              aria-hidden
              className={`h-[9px] w-[9px] justify-self-center rounded-full border-[1.5px] transition-colors ${
                t.done
                  ? 'border-[var(--accent)] bg-[var(--accent)]'
                  : t.late
                    ? 'border-[#c0563f] bg-[color-mix(in_srgb,#c0563f_22%,var(--bg-primary))]'
                    : 'border-[color-mix(in_srgb,var(--text-primary)_22%,transparent)] bg-[var(--bg-primary)]'
              }`}
            />
            <span className={`truncate text-[12.5px] transition-colors min-[2000px]:text-[14px] ${t.done ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-primary)]'}`}>
              {t.title}
            </span>
            <span className={`whitespace-nowrap text-[9px] min-[2000px]:text-[10px] ${t.late ? 'text-[#c0563f]' : 'text-[var(--text-muted)]'}`}>
              {t.done ? '已完成' : t.late ? '已过时间' : ''}
            </span>
          </button>
        </div>
      ))}

      {rows.length > 0 && nowIndex >= rows.length && <NowRow now={now} />}
    </div>
  )
}

function NowRow({ now }: { now: string }) {
  return (
    <div className="grid grid-cols-[46px_16px_minmax(0,1fr)] items-center gap-[10px] py-[3px] pr-2">
      <span className="text-right text-[9.5px] font-bold tabular-nums text-[var(--accent)]">{now}</span>
      <span
        aria-hidden
        className="h-[9px] w-[9px] justify-self-center rounded-full bg-[var(--accent)] shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent)_16%,transparent)]"
      />
      <span className="text-[8.5px] uppercase tracking-[0.16em] text-[var(--accent)]">现在</span>
    </div>
  )
}
