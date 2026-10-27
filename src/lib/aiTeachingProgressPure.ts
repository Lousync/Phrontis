/**
 * AI教学 · 段进度 / 复习解锁 —— 纯函数（**零依赖**，主进程与渲染层共用）。
 *
 * 口径（docs/ai-teaching-simplify-plan.md §2.5）：
 *   · 知识点「学完」= 所在段已收尾（finished=true），不看掌握度；
 *   · 章末复习 = 本章所有知识点都学完才解锁；有讲义 rel 的历史产物始终可打开；
 *   · 复习行不计入章节 x/y。
 */

export type SegmentStatus = 'open' | 'ended'

export interface ProgressLessonLike {
  /** 新形状：一段覆盖多个知识点 */
  unitIds?: string[]
  /** 旧形状：单知识点课时（迁移期只读） */
  unitId?: string
  activeUnitId?: string
  order?: number
  status?: SegmentStatus
  handoffRel?: string | null
  sources?: unknown[]
  startedAt?: string
  endedAt?: string | null
}

export interface ProgressUnitLike {
  status?: string
  mastery?: number
  lastCheckedAt?: string | null
  finished?: boolean
  summaryRel?: string | null
}

export interface ReviewLike {
  sessionId?: string
  rel?: string | null
}

export type ChapterReviewState = 'locked' | 'unlocked' | 'done'

export interface ChapterReviewInfo {
  state: ChapterReviewState
  /** 还差几个知识点（locked 时 > 0） */
  remaining: number
  /** 本章知识点总数 */
  total: number
  /** 已学数 */
  learned: number
}

/** 取段的 unitIds（新字段优先；旧 unitId 兼容）。 */
export function lessonUnitIds(l: ProgressLessonLike | null | undefined): string[] {
  if (!l) return []
  if (Array.isArray(l.unitIds) && l.unitIds.length) return l.unitIds.map(String).filter(Boolean)
  if (l.unitId) return [String(l.unitId)]
  return []
}

/** 某知识点所在的进行中段（同章最多一个；旧数据可能多个，取第一个）。 */
export function openSegmentOfUnit(
  lessons: Record<string, ProgressLessonLike> | null | undefined,
  unitId: string,
): { sessionId: string; lesson: ProgressLessonLike } | null {
  if (!lessons) return null
  for (const [sessionId, l] of Object.entries(lessons)) {
    if (l?.status === 'open' && lessonUnitIds(l).includes(unitId)) return { sessionId, lesson: l }
  }
  return null
}

/**
 * 知识点是否学完。
 * 判定顺序：有进行中的段 → 未学完；finished=true → 学完；
 * 旧数据 status=mastered/review → 学完；有已结束段覆盖 → 学完。
 */
export function unitLearned(
  unitId: string,
  progress: Record<string, ProgressUnitLike> | null | undefined,
  lessons: Record<string, ProgressLessonLike> | null | undefined,
): boolean {
  const id = String(unitId ?? '')
  if (!id) return false
  const ls = lessons ?? {}
  if (openSegmentOfUnit(ls, id)) return false
  const p = progress?.[id]
  if (p?.finished === true) return true
  if (p?.finished === false) return false
  if (p?.status === 'mastered' || p?.status === 'review') return true
  return Object.values(ls).some((l) => l?.status === 'ended' && lessonUnitIds(l).includes(id))
}

/** 本章是否全部学完；空章（没有知识点）不算学完，不显示复习入口。 */
export function chapterLearned(
  unitIds: ReadonlyArray<string>,
  progress: Record<string, ProgressUnitLike> | null | undefined,
  lessons: Record<string, ProgressLessonLike> | null | undefined,
): boolean {
  if (!unitIds.length) return false
  return unitIds.every((id) => unitLearned(id, progress, lessons))
}

/**
 * 章末复习状态。
 * - done：已有讲义 rel（历史产物优先，始终可看）；
 * - unlocked：本章知识点全部学完；
 * - locked：还有未学完的知识点。
 */
export function reviewState(
  chapterId: string,
  unitIds: ReadonlyArray<string>,
  progress: Record<string, ProgressUnitLike> | null | undefined,
  lessons: Record<string, ProgressLessonLike> | null | undefined,
  reviews: Record<string, ReviewLike> | null | undefined,
): ChapterReviewInfo {
  const ids = [...unitIds]
  const total = ids.length
  const learned = ids.filter((id) => unitLearned(id, progress, lessons)).length
  const remaining = Math.max(0, total - learned)
  const rel = reviews?.[chapterId]?.rel
  if (rel) return { state: 'done', remaining, total, learned }
  if (total > 0 && remaining === 0) return { state: 'unlocked', remaining: 0, total, learned }
  return { state: 'locked', remaining, total, learned }
}

/** 同章上一段（按 order 取小于当前的最大者；只认已收尾段）。 */
export function prevSegmentOf(
  lessons: Record<string, ProgressLessonLike> | null | undefined,
  currentSessionId: string,
  chapterUnitIds: ReadonlyArray<string>,
): { sessionId: string; lesson: ProgressLessonLike } | null {
  const cur = lessons?.[currentSessionId]
  if (!cur) return null
  const chapter = new Set(chapterUnitIds.map(String))
  const curOrder = Number(cur.order) || 0
  let best: { sessionId: string; lesson: ProgressLessonLike } | null = null
  for (const [sessionId, l] of Object.entries(lessons ?? {})) {
    if (sessionId === currentSessionId) continue
    if (l?.status !== 'ended') continue
    if (!lessonUnitIds(l).some((id) => chapter.has(id))) continue
    const order = Number(l.order) || 0
    if (order >= curOrder) continue
    if (!best || order > (Number(best.lesson.order) || 0)) best = { sessionId, lesson: l }
  }
  return best
}

/** 本章下一段的 order。 */
export function nextSegmentOrder(
  lessons: Record<string, ProgressLessonLike> | null | undefined,
  chapterUnitIds: ReadonlyArray<string>,
): number {
  const chapter = new Set(chapterUnitIds.map(String))
  let max = 0
  for (const l of Object.values(lessons ?? {})) {
    if (!lessonUnitIds(l).some((id) => chapter.has(id))) continue
    max = Math.max(max, Number(l.order) || 0)
  }
  return max + 1
}

/** 某知识点最近一次被已结束段覆盖的会话（点已学知识点时打开它）。 */
export function latestEndedSegmentOfUnit(
  lessons: Record<string, ProgressLessonLike> | null | undefined,
  unitId: string,
): { sessionId: string; lesson: ProgressLessonLike } | null {
  let best: { sessionId: string; lesson: ProgressLessonLike } | null = null
  for (const [sessionId, l] of Object.entries(lessons ?? {})) {
    if (l?.status !== 'ended') continue
    if (!lessonUnitIds(l).includes(unitId)) continue
    if (!best || (Number(l.order) || 0) >= (Number(best.lesson.order) || 0)) best = { sessionId, lesson: l }
  }
  return best
}

/** 本章的段列表（按 order 升序；给右栏进度页签用）。 */
export function chapterSegments(
  lessons: Record<string, ProgressLessonLike> | null | undefined,
  chapterUnitIds: ReadonlyArray<string>,
): Array<{ sessionId: string; lesson: ProgressLessonLike }> {
  const chapter = new Set(chapterUnitIds.map(String))
  return Object.entries(lessons ?? {})
    .filter(([, l]) => lessonUnitIds(l).some((id) => chapter.has(id)))
    .map(([sessionId, lesson]) => ({ sessionId, lesson }))
    .sort((a, b) => (Number(a.lesson.order) || 0) - (Number(b.lesson.order) || 0))
}
