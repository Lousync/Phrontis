/**
 * AI教学 · 课程摘要（选择页 / 结课流程用）—— 纯函数 + 一个薄 fs 包装。
 *
 * 口径与章节 x/y 完全一致：`unitLearned()`（所在段未收尾的知识点不算学完）。
 * 本文件**零 electron 依赖**：契约脚本用 `summarizeCourseState()` 直接喂文本与 progress，
 * 主进程用 `summarizeCourseWorkspace()` 读盘。工作区数量少，和 countDocs 同量级，不做缓存。
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  normalizeProgressFile,
  parseCourseMd,
  type CourseOutline,
  type CourseWsV2,
  type ProgressFileV2,
} from './aiTeachingCoursePure'
import { courseProgressSummary, unitLearned } from '../../src/lib/aiTeachingProgressPure'

export interface CourseSummary {
  /** 大纲里的章数（含空章，用于展示） */
  chapters: number
  total: number
  learned: number
  /** 已生成复习讲义的章数（只算有知识点的章） */
  reviewsDone: number
  /** 全部知识点学完且每章复习讲义已生成；空章不计入 */
  ready: boolean
}

/**
 * 由大纲 + 本课程进度算摘要。
 * - 无大纲 / 空大纲 → null（主题工作区不提供结课入口）；
 * - 空章（无知识点）不参与 ready 判定，与 `chapterLearned()` 口径一致。
 */
export function summarizeCourseState(
  outline: CourseOutline | null,
  wsState: Pick<CourseWsV2, 'units' | 'lessons' | 'reviews'> | null,
): CourseSummary | null {
  if (!outline) return null
  const units = wsState?.units ?? {}
  const lessons = wsState?.lessons ?? {}
  const reviews = wsState?.reviews ?? {}
  const { learned, total } = courseProgressSummary(outline, units, lessons)
  const reviewable = outline.chapters.filter((c) => c.units.length > 0)
  const reviewsDone = reviewable.filter((c) => !!reviews[c.id]?.rel).length
  const ready = total > 0 && learned >= total && reviewsDone >= reviewable.length
  return { chapters: outline.chapters.length, total, learned, reviewsDone, ready }
}

/** 结课流程第 1 步的事实格：段数 / 已收尾段 / 未收尾段。 */
export function summarizeSegments(
  outline: CourseOutline | null,
  wsState: Pick<CourseWsV2, 'lessons'> | null,
): { segments: number; ended: number; open: number } {
  const chapterIds = new Set((outline?.chapters ?? []).map((c) => c.id))
  const unitToChapter = new Map<string, string>()
  for (const c of outline?.chapters ?? []) for (const u of c.units) unitToChapter.set(u.id, c.id)
  let segments = 0
  let ended = 0
  let open = 0
  for (const l of Object.values(wsState?.lessons ?? {})) {
    if (!l) continue
    // 只算属于本大纲章节的段（防止历史残留 / 换大纲后的孤儿段抬高分母）
    if (!l.unitIds.some((id) => chapterIds.has(unitToChapter.get(id) ?? ''))) continue
    segments++
    if (l.status === 'ended') ended++
    else open++
  }
  return { segments, ended, open }
}

/** 读盘包装：`{工作区绝对路径}` → 课程摘要（无课程.md 返回 null）。
 *  progress.json 是**仓库级**文件（`.knowbase/modules/aiTeaching/progress.json`，按 wsId 分键），
 *  不在工作区文件夹内；调用方传 `progressAbs` 或默认按仓库根推导。 */
export function summarizeCourseWorkspace(workspaceAbs: string, wsId: string, progressAbs?: string): CourseSummary | null {
  const outlineAbs = join(workspaceAbs, '课程.md')
  if (!existsSync(outlineAbs)) return null
  let outline: CourseOutline | null = null
  try { outline = parseCourseMd(readFileSync(outlineAbs, 'utf-8')) } catch { return null }
  let file: ProgressFileV2 | null = null
  try {
    const pAbs = progressAbs ?? ''
    const raw = pAbs && existsSync(pAbs) ? (JSON.parse(readFileSync(pAbs, 'utf-8')) as unknown) : null
    if (raw) file = normalizeProgressFile(raw).file
  } catch { file = null }
  return summarizeCourseState(outline, wsId ? (file?.workspaces?.[wsId] ?? null) : null)
}

/** 已学知识点 id 集合（结课报告 / 未完成章节用；口径同 unitLearned）。 */
export function learnedUnitIds(
  outline: CourseOutline | null,
  wsState: Pick<CourseWsV2, 'units' | 'lessons'> | null,
): Set<string> {
  const out = new Set<string>()
  const units = wsState?.units ?? {}
  const lessons = wsState?.lessons ?? {}
  for (const c of outline?.chapters ?? []) {
    for (const u of c.units) if (unitLearned(u.id, units, lessons)) out.add(u.id)
  }
  return out
}
