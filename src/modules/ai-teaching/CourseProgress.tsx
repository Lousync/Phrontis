import { Check, ChevronRight, Lock, Sparkles } from 'lucide-react'
import type { AiTeachCourseOutline, AiTeachCourseUnitProgress, AiTeachLessonInfo, AiTeachChapterReview } from '../../types'
import { chapterSegments, lessonUnitIds, reviewState, unitLearned } from '../../lib/aiTeachingProgressPure'
import { reviewLabel } from './courseRailPure'

/** 右栏「进度」页签：章 → 段列表 → 复习行。 */

interface Props {
  outline: AiTeachCourseOutline | null
  progress: Record<string, AiTeachCourseUnitProgress>
  lessons: Record<string, AiTeachLessonInfo>
  reviews: Record<string, AiTeachChapterReview>
  activeSegmentSid: string | null
  onOpenSegment: (sessionId: string) => void
  onOpenReview: (chapterId: string) => void
}

export function CourseProgress({ outline, progress, lessons, reviews, activeSegmentSid, onOpenSegment, onOpenReview }: Props) {
  const chapters = outline?.chapters ?? []
  if (!chapters.length) {
    return <div className="px-3 py-3 text-[11px] text-[var(--text-muted)]">还没有课程大纲。</div>
  }
  return (
    <div className="flex flex-col gap-1 px-2 py-2">
      {chapters.map((ch) => {
        const ids = ch.units.map((u) => u.id)
        const learned = ids.filter((id) => unitLearned(id, progress, lessons)).length
        const segs = chapterSegments(lessons, ids)
        const st = reviewState(ch.id, ids, progress, lessons, reviews)
        return (
          <div key={ch.id} className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] overflow-hidden">
            <div className="flex items-center gap-1.5 px-2.5 py-2 bg-[var(--bg-secondary)]">
              <ChevronRight size={11} className="shrink-0 rotate-90 text-[var(--text-muted)]" />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--text-primary)]">{ch.name}</span>
              <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-muted)]">{learned}/{ids.length}</span>
            </div>
            <div className="px-1.5 py-1">
              {segs.length === 0 && <div className="px-1.5 py-1 text-[10.5px] text-[var(--text-muted)]">还没有开段。</div>}
              {segs.map(({ sessionId, lesson }) => {
                const uids = lessonUnitIds(lesson)
                const first = ch.units.find((u) => u.id === uids[0])?.name ?? '知识点'
                const last = ch.units.find((u) => u.id === uids[uids.length - 1])?.name ?? first
                const label = uids.length > 1 ? `${first} – ${last}` : first
                const on = sessionId === activeSegmentSid
                const ended = lesson.status === 'ended'
                return (
                  <button
                    key={sessionId}
                    onClick={() => onOpenSegment(sessionId)}
                    className={`w-full flex items-center gap-1.5 px-1.5 py-1 rounded-md text-left transition-colors hover:bg-[var(--bg-hover)] ${on ? 'bg-[var(--bg-selected)]' : ''}`}
                  >
                    <span className="shrink-0 w-1.5 h-1.5 rounded-full" style={{ background: ended ? 'var(--success)' : 'var(--accent)' }} />
                    <span className="shrink-0 text-[10px] text-[var(--text-muted)]">第{lesson.order}段</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-secondary)]">{label}</span>
                    <span className="shrink-0 text-[9.5px] text-[var(--text-muted)]">{ended ? '已收尾' : '进行中'}</span>
                  </button>
                )
              })}
              <button
                onClick={() => onOpenReview(ch.id)}
                className={`w-full flex items-center gap-1.5 px-1.5 py-1 rounded-md text-left transition-colors hover:bg-[var(--bg-hover)] ${st.state === 'locked' ? 'opacity-70' : ''}`}
              >
                {st.state === 'done' ? <Check size={10} className="shrink-0 text-[var(--success)]" /> : st.state === 'unlocked' ? <Sparkles size={10} className="shrink-0 text-[var(--accent)]" /> : <Lock size={10} className="shrink-0 text-[var(--text-muted)]" />}
                <span className={`min-w-0 flex-1 truncate text-[11px] ${st.state === 'unlocked' ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}>章末复习</span>
                <span className="shrink-0 text-[9px] text-[var(--text-muted)]">{reviewLabel(st)}</span>
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
