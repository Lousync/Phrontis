import { useMemo } from 'react'
import { CalendarCheck2, Check, ExternalLink, SlidersHorizontal } from 'lucide-react'
import { mondayOfWeek, dayFromMonday, toDateStr, WEEKDAY_LABELS } from './timetable'
import { requestSchedulePreviewConfirm, requestSchedulePreviewAdjust, requestScheduleOpenWeek } from './shared'
import type { SchedulePreviewData } from './previewPure'

/**
 * 排期预览卡（日程 AI 化 P1）——助手消息里的 ```schedule-preview 围栏渲染成「迷你周表」。
 *
 * 形态（窄栏友好，不塞 7 列网格）：顶部一条「一周速览」细刻度（有安排的段点亮）+
 * 下面按天列条目（色条 + 天 + 时段 + 任务名）+ 底部 确认排入 / 调整 / 打开周日程。
 * 确认/调整只派发 window 事件，由 ScheduleAssistantPanel 代发消息 —— 卡片与面板解耦。
 * 协议与 ```quiz / ```outline 围栏同源（铁律 19），由 agentService 的日程人设要求模型输出。
 */
const COLORS = ['#4f6ef2', '#c94f9a', '#4ec9b0', '#c5a332', '#e06c4f', '#8a7f5c']

function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function SchedulePreviewCard({ data }: { data: SchedulePreviewData }) {
  const { weekDays, litSet, rows } = useMemo(() => {
    const anchor = data.items[0]?.date || todayStr()
    const monday = mondayOfWeek(anchor, 0)
    const weekDays = Array.from({ length: 7 }, (_, i) => {
      const d = dayFromMonday(monday, i)
      return { date: toDateStr(d), day: d.getDate(), label: WEEKDAY_LABELS[i] }
    })
    const litSet = new Set(data.items.map((it) => it.date))
    const rows = data.items.map((it, i) => {
      const wd = weekDays.find((w) => w.date === it.date)
      return {
        ...it,
        color: COLORS[i % COLORS.length],
        dayLabel: wd ? `${wd.label} ${it.date.slice(5).replace('-', '/')}` : it.date,
      }
    })
    return { weekDays, litSet, rows }
  }, [data])

  return (
    <div
      className="my-2 rounded-lg border p-2.5"
      style={{ borderColor: 'color-mix(in srgb, var(--accent) 42%, transparent)', background: 'color-mix(in srgb, var(--accent) 7%, transparent)' }}
    >
      <div className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--text-primary)]">
        <CalendarCheck2 size={13} className="text-[var(--accent)]" />
        {data.title || '排期预览'}
        <span className="ml-auto text-[10.5px] font-normal text-[var(--text-muted)]">先预览 · 确认后落盘</span>
      </div>

      {/* 一周速览：有安排的段点亮（点亮的微动效走 .kb-micro-pop） */}
      <div className="mb-2 flex gap-[3px]">
        {weekDays.map((w) => {
          const has = litSet.has(w.date)
          return (
            <div key={w.date} className="min-w-0 flex-1 text-center">
              <div className={`text-[9.5px] leading-tight ${has ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]'}`}>
                {w.label.slice(1)}<br />{w.day}
              </div>
              <div className={`mt-1 h-1.5 rounded-[3px] ${has ? 'kb-micro-pop bg-[var(--accent)]' : 'bg-[var(--bg-hover)]'}`} />
            </div>
          )
        })}
      </div>

      {/* 按天条目 */}
      <div>
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2 border-t border-[var(--border-color)] py-1 text-[11.5px] first:border-t-0">
            <span className="w-[3px] shrink-0 self-stretch rounded-sm" style={{ background: r.color, minHeight: 16 }} />
            <span className="w-[74px] shrink-0 text-[10.5px] text-[var(--text-muted)]">{r.dayLabel}</span>
            {(r.start || r.end) && (
              <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">{r.start}{r.end ? `–${r.end}` : ''}</span>
            )}
            <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{r.title}</span>
          </div>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          onClick={requestSchedulePreviewConfirm}
          className="inline-flex items-center gap-1 rounded-md border border-[var(--accent)] bg-[var(--accent)] px-2.5 py-[3px] text-[11px] text-white transition-opacity hover:opacity-90"
        >
          <Check size={12} /> 确认排入
        </button>
        <button
          onClick={requestSchedulePreviewAdjust}
          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-[3px] text-[11px] text-[var(--accent)] transition-colors hover:bg-[var(--bg-hover)]"
          style={{ borderColor: 'color-mix(in srgb, var(--accent) 45%, transparent)' }}
        >
          <SlidersHorizontal size={12} /> 调整
        </button>
        <button
          onClick={requestScheduleOpenWeek}
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] underline transition-colors hover:text-[var(--accent)]"
        >
          打开周日程 <ExternalLink size={11} />
        </button>
      </div>
    </div>
  )
}
