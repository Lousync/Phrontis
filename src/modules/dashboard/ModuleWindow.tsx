import type { ReactNode } from 'react'
import { ArrowRight, GraduationCap, BookOpen } from 'lucide-react'
import type { DashboardSnapshot, TabName } from '../../types'
import { labelOf } from '../../lib/appModules'

/**
 * 看板右列的两个「模块窗口」+ 在读清单（2026-11-14 首页重做）。
 *
 * 为什么是「窗口」而不是入口条：首页上用户真正想做的是**回到刚才那一篇 / 那一段**，
 * 不是「进入工作台」这个动作。所以窗口里直接给出可点的内容（页签 / 当前课程），
 * 底部再留一整行进入模块本身 —— 一个组件同时承担预览与入口，不额外造一个按钮。
 */

/* ==================== 共用外壳 ==================== */

function WindowShell({ name, meta, children, footer, delay = 0 }: {
  name: string
  meta: string
  children: ReactNode
  footer?: ReactNode
  delay?: number
}) {
  return (
    <div
      className="kb-item-in flex flex-none flex-col overflow-hidden rounded-[14px] border border-[var(--border-color)] bg-[var(--card-bg)] shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-[color-mix(in_srgb,var(--accent)_34%,var(--border-color))] hover:shadow-[0_8px_22px_rgba(20,35,25,0.08)]"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-[11px] py-[7px]">
        <span aria-hidden className="flex gap-1">
          <i className="h-[7px] w-[7px] rounded-full bg-[color-mix(in_srgb,var(--text-primary)_16%,transparent)]" />
          <i className="h-[7px] w-[7px] rounded-full bg-[color-mix(in_srgb,var(--text-primary)_16%,transparent)]" />
          <i className="h-[7px] w-[7px] rounded-full bg-[color-mix(in_srgb,var(--text-primary)_16%,transparent)]" />
        </span>
        <span className="text-[9.5px] font-semibold tracking-[0.02em] text-[var(--text-secondary)]">{name}</span>
        <span className="ml-auto text-[8.5px] text-[var(--text-muted)]">{meta}</span>
      </div>
      {children}
      {footer}
    </div>
  )
}

/* ==================== AI 教学窗口 ==================== */

export function AiCourseWindow({ course, onOpen, delay }: {
  course: DashboardSnapshot['course']
  onOpen: () => void
  delay?: number
}) {
  if (!course) {
    return (
      <WindowShell name="AI 教学" meta="未开始" delay={delay}>
        <div className="flex flex-col gap-2 px-[11px] pb-[11px] pt-2.5">
          <p className="text-[10px] leading-relaxed text-[var(--text-muted)]">还没有课程大纲。建一门课，今天就能开始第一段。</p>
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex h-[25px] w-fit items-center gap-1.5 rounded-full bg-[var(--accent)] px-3 text-[9.5px] font-semibold text-white transition-transform hover:-translate-y-px"
          >
            <GraduationCap size={12} /> 打开 AI 教学
          </button>
        </div>
      </WindowShell>
    )
  }

  return (
    <WindowShell name="AI 教学" meta={`第 ${course.chapterIndex}/${course.chapterCount} 章`} delay={delay}>
      <button type="button" onClick={onOpen} className="flex flex-col gap-2 px-[11px] pb-[11px] pt-2.5 text-left">
        <span
          className="flex flex-col gap-0.5 rounded-[9px] px-2.5 pb-2.5 pt-2 text-white"
          style={{ background: 'linear-gradient(140deg, var(--accent), var(--accent-hover))' }}
        >
          <span className="text-[7.5px] uppercase tracking-[0.1em] opacity-80">{course.wsName} · {course.chapterTitle}</span>
          <b className="text-[13.5px] font-bold leading-snug tracking-[-0.01em]">{course.unitTitle}</b>
          <span className="text-[8.5px] opacity-85">已完成 {course.pct}%</span>
        </span>
        {course.unitGoal && (
          <span className="line-clamp-2 text-[9px] leading-[1.55] text-[var(--text-muted)]">{course.unitGoal}</span>
        )}
        <span className="mt-0.5 inline-flex h-[25px] w-fit items-center rounded-full bg-[var(--accent)] px-3 text-[9.5px] font-semibold text-white">
          继续这一段
        </span>
      </button>
    </WindowShell>
  )
}

/* ==================== 工作台窗口 ==================== */

export function WorkbenchWindow({ tabs, lastTab, onOpenTab, onOpenWorkbench, delay }: {
  tabs: TabName[]
  lastTab: TabName | null
  onOpenTab: (tab: TabName) => void
  onOpenWorkbench: () => void
  delay?: number
}) {
  const shown = tabs.slice(0, 4)
  return (
    <WindowShell
      name="工作台"
      meta={tabs.length ? `${tabs.length} 个标签` : '空'}
      delay={delay}
      footer={(
        <button
          type="button"
          onClick={onOpenWorkbench}
          className="group/foot mt-auto flex items-center justify-between gap-2 border-t border-[var(--border-color)] px-[13px] py-[9px] text-[10px] font-semibold text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]"
        >
          打开工作台
          <ArrowRight size={13} className="text-[var(--text-muted)] transition-colors group-hover/foot:text-[var(--accent)]" />
        </button>
      )}
    >
      <div className="flex flex-col gap-px p-1.5">
        {shown.length === 0 && (
          <span className="px-2 py-2 text-[10px] text-[var(--text-muted)]">还没有打开的标签。</span>
        )}
        {shown.map((tab) => {
          const isLast = lastTab ? tab === lastTab : tab === shown[0]
          return (
            <button
              key={tab}
              type="button"
              onClick={() => onOpenTab(tab)}
              data-tip={`打开「${labelOf(tab)}」`} aria-label={`打开「${labelOf(tab)}」`}
              className={`flex w-full items-center gap-[7px] rounded-[7px] px-[7px] py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] ${isLast ? 'bg-[var(--bg-hover)]' : ''}`}
            >
              <i aria-hidden className={`h-[5px] w-[5px] flex-none rounded-full ${isLast ? 'bg-[var(--accent)]' : 'bg-[color-mix(in_srgb,var(--text-primary)_18%,transparent)]'}`} />
              <span className={`min-w-0 flex-1 truncate text-[10px] ${isLast ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                {labelOf(tab)}
              </span>
              {isLast && <span className="flex-none text-[8px] text-[var(--text-muted)]">上次</span>}
            </button>
          )
        })}
        {tabs.length > shown.length && (
          <span className="px-[7px] py-1 text-[8.5px] text-[var(--text-muted)]">还有 {tabs.length - shown.length} 个</span>
        )}
      </div>
    </WindowShell>
  )
}

/* ==================== 在读 ==================== */

export function ReadingList({ reading, onOpenBook, onOpenShelf, delay }: {
  reading: DashboardSnapshot['reading']
  onOpenBook: (relPath: string) => void
  onOpenShelf: () => void
  delay?: number
}) {
  return (
    <section
      className={`kb-item-in flex min-h-0 flex-col rounded-[16px] border border-[var(--border-color)] bg-[var(--card-bg)] px-[13px] py-[11px] ${reading.length > 0 ? 'flex-1' : 'flex-none'}`}
      style={{ animationDelay: `${delay ?? 0}ms` }}
    >
      <div className="mb-1 flex flex-none items-center justify-between gap-2">
        <span className="text-[8.5px] uppercase tracking-[0.12em] text-[var(--text-muted)]">在读</span>
        <button type="button" onClick={onOpenShelf} className="text-[9px] text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]">书架</button>
      </div>

      <div className={`flex min-h-0 flex-col ${reading.length > 0 ? 'flex-1 justify-evenly' : 'gap-1 justify-start'}`}>
        {reading.length === 0 && (
          <button type="button" onClick={onOpenShelf} className="flex items-center gap-2 rounded-md px-1 py-1 text-left text-[10.5px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)]">
            <BookOpen size={13} /> 书架还没有在读的书
          </button>
        )}
        {reading.map((b) => (
          <button
            key={b.relPath}
            type="button"
            onClick={() => onOpenBook(b.relPath)}
            data-tip={`继续读「${b.displayName}」`} aria-label={`继续读「${b.displayName}」`}
            className="flex items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-[var(--bg-hover)]"
          >
            <span
              aria-hidden
              className="grid h-6 w-[18px] flex-none place-items-center rounded-[4px] text-[6px] font-bold text-[var(--accent)]"
              style={{ background: 'color-mix(in srgb, var(--accent) 14%, var(--bg-secondary))' }}
            >
              {b.displayName.slice(0, 1)}
            </span>
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--text-primary)]">{b.displayName}</span>
            <span className="flex-none text-[8.5px] tabular-nums text-[var(--text-muted)]">{Math.round(b.pct)}%</span>
          </button>
        ))}
      </div>
    </section>
  )
}
