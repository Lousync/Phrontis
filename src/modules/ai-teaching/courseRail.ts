/**
 * AI教学 · 左栏课程树（章 → 知识点 → 复习行）—— 零依赖纯函数，契约脚本直接 import。
 *
 * 3.14.0 左栏口径：只列课程结构，不再列会话；零散对话 / 课时行 / 已升格支线都不出现。
 * 学完状态与复习解锁由 `aiTeachingProgressPure.ts` 算好传进来，这里只做分组、搜索与排序。
 */

export interface RailUnit {
  id: string
  name: string
  learned: boolean
  /** 当前段内的聚焦知识点 */
  active: boolean
  /** 属于当前 open 段 */
  inSegment: boolean
}

export interface RailReview {
  state: 'locked' | 'unlocked' | 'done'
  remaining: number
  total: number
  learned: number
}

export interface RailChapter {
  id: string
  name: string
  units: RailUnit[]
  review: RailReview
}

export interface RailChapterInput extends RailChapter {
  /** 章本身命中搜索（true 时保留全部知识点） */
  chapterMatch?: boolean
}

function norm(v: unknown): string {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[()[\]{}【】《》〈〉“”"'`·.,，。:：;；!！?？、/\\|_\-—–~～]+/g, '')
    .trim()
}

/**
 * 按搜索词过滤课程树。
 * - 空搜索：原样返回（保持大纲顺序）；
 * - 章名命中：保留该章全部知识点；
 * - 仅知识点命中：只保留命中的知识点（章头仍显示 x/y 全量）；
 * - 没有任何命中：返回空数组。
 */
export function buildCourseRail(chapters: ReadonlyArray<RailChapterInput>, search?: string): RailChapter[] {
  const q = norm(search)
  const out: RailChapter[] = []
  for (const c of chapters ?? []) {
    const chapterMatch = !!q && norm(c.name).includes(q)
    if (!q) {
      out.push({ id: c.id, name: c.name, units: [...c.units], review: c.review })
      continue
    }
    if (chapterMatch) {
      out.push({ id: c.id, name: c.name, units: [...c.units], review: c.review })
      continue
    }
    const units = c.units.filter((u) => norm(u.name).includes(q))
    if (units.length) out.push({ id: c.id, name: c.name, units, review: c.review })
  }
  return out
}

/** 当前应自动展开的章：有 open 段/聚焦点的章 → 第一个未学完的章 → 第一章。 */
export function activeChapterId(
  chapters: ReadonlyArray<RailChapterInput>,
  preferred?: string | null,
): string | null {
  if (preferred && chapters.some((c) => c.id === preferred)) return preferred
  const withActive = chapters.find((c) => c.units.some((u) => u.active || u.inSegment))
  if (withActive) return withActive.id
  const withTodo = chapters.find((c) => c.review.learned < c.review.total)
  return withTodo?.id ?? chapters[0]?.id ?? null
}

/** 章头文案：`已学 x / y`；复习行文案：锁定 / 已解锁 / 已生成。 */
export function reviewLabel(r: RailReview): string {
  if (r.state === 'done') return '已生成讲义'
  if (r.state === 'unlocked') return '已解锁'
  return `还差 ${r.remaining} 个`
}
