/**
 * AI教学 · 课程文件夹迁移计划（零 fs / 零 electron）。
 *
 * 输入是一份工作区文件树快照 + 会话锚点 + 大纲/进度；输出是确定的移动计划。
 * 主进程只负责「收集快照 → 调本文件 → 执行移动」，契约脚本可直接跑本文件。
 *
 * 目标：把 v3.16 的 `第N章 章名/{NN} 知识点/段N` 整理成
 *   `第N章 章名/段N` + 可选 `第N章 章名/知识点/{NN} 知识点/`
 * 并处理历史错位段（段被写到章根或错误知识点下）。
 */

import type { CourseOutline } from './aiTeachingCoursePure'
import {
  REVIEW_FOLDER_NAME,
  UNIT_META_FOLDER_NAME,
  chapterFolderName,
  chapterFolderNameV316,
  segmentFolderName,
  unitFolderName,
} from './aiTeachingLayoutPure'

export interface LayoutMigrationEntry {
  /** 仓库相对路径 */
  rel: string
  name: string
  isDir: boolean
}

export interface LayoutMigrationAnchor {
  /** 含 `.session.json` 的文件夹仓库相对路径 */
  rel: string
  sessionId: string
}

export interface LayoutMigrationLesson {
  sessionId: string
  order: number
  chapterId: string
}

export interface LayoutMigrationInput {
  wsRel: string
  outline: CourseOutline
  lessons: LayoutMigrationLesson[]
  entries: LayoutMigrationEntry[]
  anchors: LayoutMigrationAnchor[]
  /** 非段会话（课程助手 / 复习课）的 sessionId：它们的锚点夹不能被当孤儿回收 */
  keepSessionIds?: string[]
}

export type LayoutMoveKind = 'chapter' | 'unit' | 'segment' | 'trash'

export interface LayoutMove {
  from: string
  to: string
  kind: LayoutMoveKind
  label: string
  /** true = 目标已存在时按文件/目录递归合并，而不是整目录 rename */
  merge?: boolean
  /** true = 同名文件冲突时自动加 (n)，不覆盖 */
  unique?: boolean
}

export interface LayoutMigrationPlan {
  moves: LayoutMove[]
  /** 移动完成后可尝试删除的空目录（深路径在前） */
  removeEmpty: string[]
  warnings: string[]
  chapterPairs: Array<{ from: string; to: string }>
  unitPairs: Array<{ from: string; to: string }>
  segmentPairs: Array<{ from: string; to: string }>
  reviewPairs: Array<{ from: string; to: string }>
}

function norm(v: unknown): string {
  return String(v ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function joinRel(...parts: string[]): string {
  return parts.map(norm).filter(Boolean).join('/')
}

function parentRel(rel: string): string {
  const r = norm(rel)
  const i = r.lastIndexOf('/')
  return i >= 0 ? r.slice(0, i) : ''
}

function baseName(rel: string): string {
  const r = norm(rel)
  const i = r.lastIndexOf('/')
  return i >= 0 ? r.slice(i + 1) : r
}

function isUnder(rel: string, prefix: string): boolean {
  const r = norm(rel)
  const p = norm(prefix)
  return !!p && (r === p || r.startsWith(`${p}/`))
}

function directChildren(entries: LayoutMigrationEntry[], dirRel: string): LayoutMigrationEntry[] {
  const prefix = `${norm(dirRel)}/`
  return entries.filter((e) => e.rel.startsWith(prefix) && !e.rel.slice(prefix.length).includes('/'))
}

function segmentOrderFromName(name: string): number | null {
  const m = /^(?:段|课时)(\d+)(?:·.*)?$/.exec(String(name ?? ''))
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

function isSegmentDirName(name: string): boolean {
  return segmentOrderFromName(name) !== null
}

function pushPair(list: Array<{ from: string; to: string }>, from: string, to: string): void {
  const f = norm(from)
  const t = norm(to)
  if (!f || !t || f === t) return
  if (list.some((p) => p.from === f && p.to === t)) return
  list.push({ from: f, to: t })
}

/**
 * 生成迁移计划。只处理大纲里已知的章 / 知识点；用户自建的其他文件夹原样保留。
 */
export function planCourseLayoutMigration(input: LayoutMigrationInput): LayoutMigrationPlan {
  const wsRel = norm(input.wsRel)
  let entries = (input.entries ?? []).map((e) => ({ ...e, rel: norm(e.rel) }))
  let entryMap = new Map(entries.map((e) => [e.rel, e]))
  let anchors = (input.anchors ?? []).map((a) => ({ ...a, rel: norm(a.rel) }))
  const anchorBySession = new Map<string, LayoutMigrationAnchor>()
  for (const a of anchors) {
    if (a.sessionId && !anchorBySession.has(a.sessionId)) anchorBySession.set(a.sessionId, a)
  }
  const lessonSessionIds = new Set((input.lessons ?? []).map((l) => l.sessionId))
  const keepSessionIds = new Set((input.keepSessionIds ?? []).filter(Boolean))
  const plan: LayoutMigrationPlan = {
    moves: [],
    removeEmpty: [],
    warnings: [],
    chapterPairs: [],
    unitPairs: [],
    segmentPairs: [],
    reviewPairs: [],
  }
  const addMove = (m: LayoutMove): void => {
    if (!m.from || m.from === m.to) return
    if (plan.moves.some((x) => x.from === m.from && x.to === m.to && x.kind === m.kind)) return
    plan.moves.push(m)
  }
  const addRemoveEmpty = (rel: string): void => {
    const r = norm(rel)
    if (r && !plan.removeEmpty.includes(r)) plan.removeEmpty.push(r)
  }

  const chapters = input.outline?.chapters ?? []
  const chapterPrefixes: string[] = []

  chapters.forEach((chapter, ci) => {
    const newChapterRel = joinRel(wsRel, chapterFolderName(ci, chapter.name))
    const oldChapterRel = joinRel(wsRel, chapterFolderNameV316(ci, chapter.name))
    const chapterRel = newChapterRel
    chapterPrefixes.push(chapterRel)
    if (oldChapterRel !== newChapterRel) chapterPrefixes.push(oldChapterRel)

    // 1) 章容器：旧名 -> 新名；新旧同时存在则保留新、提示人工确认
    let chapterMoved = false
    if (oldChapterRel !== newChapterRel && entryMap.has(oldChapterRel)) {
      if (!entryMap.has(newChapterRel)) {
        addMove({ from: oldChapterRel, to: newChapterRel, kind: 'chapter', label: `章目录「${chapter.name}」` })
        pushPair(plan.chapterPairs, oldChapterRel, newChapterRel)
        const oldReview = joinRel(oldChapterRel, REVIEW_FOLDER_NAME)
        const newReview = joinRel(newChapterRel, REVIEW_FOLDER_NAME)
        if (entryMap.has(oldReview)) pushPair(plan.reviewPairs, oldReview, newReview)
        chapterMoved = true
      } else {
        plan.warnings.push(`章目录新旧同时存在，未自动合并：${oldChapterRel} / ${newChapterRel}`)
      }
    }

    // 执行顺序是「章目录先改名」：先把快照里的旧章前缀归一到新章，后续子项计划才能命中
    if (chapterMoved) {
      const normalize = (rel: string): string =>
        isUnder(rel, oldChapterRel) ? `${newChapterRel}${rel.slice(oldChapterRel.length)}` : rel
      entries = entries.map((e) => ({ ...e, rel: normalize(e.rel) }))
      entryMap = new Map(entries.map((e) => [e.rel, e]))
      anchors = anchors.map((a) => ({ ...a, rel: normalize(a.rel) }))
      anchorBySession.clear()
      for (const a of anchors) {
        if (a.sessionId && !anchorBySession.has(a.sessionId)) anchorBySession.set(a.sessionId, a)
      }
    }

    if (!entryMap.has(chapterRel)) return
    // 元数据里的旧路径仍带旧章名：pair 同时登记「旧章前缀」和「归一后前缀」两种 from
    const oldChapterVariant = (rel: string): string =>
      chapterMoved && isUnder(rel, newChapterRel) ? `${oldChapterRel}${rel.slice(newChapterRel.length)}` : rel
    const addUnitPair = (from: string, to: string): void => {
      pushPair(plan.unitPairs, from, to)
      pushPair(plan.unitPairs, oldChapterVariant(from), to)
    }
    const addSegmentPair = (from: string, to: string): void => {
      pushPair(plan.segmentPairs, from, to)
      pushPair(plan.segmentPairs, oldChapterVariant(from), to)
    }

    // 2) 知识点元数据：旧知识点夹里的非段内容 -> 知识点/{NN}；单元级 PROFILE.md 直接回收
    const unitSegmentDirs: Array<{ rel: string; order: number; unitId: string }> = []
    for (const [ui, unit] of (chapter.units ?? []).entries()) {
      const folder = unitFolderName(ui, unit.name)
      const oldUnitRel = joinRel(chapterRel, folder)
      const newUnitMetaRel = joinRel(chapterRel, UNIT_META_FOLDER_NAME, folder)
      if (!entryMap.has(oldUnitRel)) continue
      addUnitPair(oldUnitRel, newUnitMetaRel)
      for (const child of directChildren(entries, oldUnitRel)) {
        if (child.isDir && isSegmentDirName(child.name)) {
          const order = segmentOrderFromName(child.name)
          if (order != null) unitSegmentDirs.push({ rel: child.rel, order, unitId: unit.id })
          continue
        }
        if (!child.isDir && child.name === 'PROFILE.md') {
          addMove({ from: child.rel, to: '', kind: 'trash', label: `知识点画像「${unit.name}」` })
          continue
        }
        addMove({
          from: child.rel,
          to: joinRel(newUnitMetaRel, child.name),
          kind: 'unit',
          label: `知识点资料「${unit.name}」`,
          merge: true,
          unique: true,
        })
      }
      addRemoveEmpty(oldUnitRel)
    }

    // 3) 章根上的段夹也是候选（历史错位段）
    const rootSegmentDirs: Array<{ rel: string; order: number }> = []
    for (const child of directChildren(entries, chapterRel)) {
      if (!child.isDir) continue
      const order = segmentOrderFromName(child.name)
      if (order != null) rootSegmentDirs.push({ rel: child.rel, order })
    }

    // 4) 逐段归位：锚点优先；目标已存在则把源内容合并进目标
    const chapterLessons = (input.lessons ?? []).filter((l) => l.chapterId === chapter.id).sort((a, b) => a.order - b.order)
    for (const lesson of chapterLessons) {
      const newSegmentRel = joinRel(chapterRel, segmentFolderName(lesson.order))
      const targetExists = entryMap.has(newSegmentRel)
      const targetAnchor = anchors.find((a) => a.rel === newSegmentRel)
      if (targetAnchor && targetAnchor.sessionId !== lesson.sessionId) {
        plan.warnings.push(`段${lesson.order} 的目标目录已被另一个会话占用，未自动移动：${newSegmentRel}`)
        continue
      }

      const allCandidates = [
        ...unitSegmentDirs.filter((d) => d.order === lesson.order).map((d) => ({ rel: d.rel, order: d.order })),
        ...rootSegmentDirs.filter((d) => d.order === lesson.order).map((d) => ({ rel: d.rel, order: d.order })),
      ]
      const seen = new Set<string>()
      const candidates = allCandidates.filter((c) => {
        if (seen.has(c.rel) || c.rel === newSegmentRel) return false
        seen.add(c.rel)
        return true
      })
      const anchor = anchorBySession.get(lesson.sessionId)
      const anchorRel = anchor && isUnder(anchor.rel, chapterRel) ? anchor.rel : null

      let canonical: string | null = anchorRel && entryMap.has(anchorRel) ? anchorRel : null
      if (!canonical && targetExists) canonical = newSegmentRel
      if (!canonical && candidates.length) canonical = candidates[0].rel

      if (canonical && canonical !== newSegmentRel) {
        addSegmentPair(canonical, newSegmentRel)
        if (targetExists) {
          // 目标已有内容（常见：历史错位段正好落在章根/段N）—— 把源逐项合并进目标
          for (const child of directChildren(entries, canonical)) {
            addMove({
              from: child.rel,
              to: joinRel(newSegmentRel, child.name),
              kind: 'segment',
              label: `段${lesson.order}产物`,
              merge: true,
              unique: true,
            })
          }
          addRemoveEmpty(canonical)
        } else {
          addMove({
            from: canonical,
            to: newSegmentRel,
            kind: 'segment',
            label: `段${lesson.order}`,
            merge: false,
          })
        }
      }

      // 其他同序号段夹（错位副本）合并进目标
      for (const c of candidates) {
        if (c.rel === canonical) continue
        addSegmentPair(c.rel, newSegmentRel)
        for (const child of directChildren(entries, c.rel)) {
          addMove({
            from: child.rel,
            to: joinRel(newSegmentRel, child.name),
            kind: 'segment',
            label: `段${lesson.order}错位产物`,
            merge: true,
            unique: true,
          })
        }
        addRemoveEmpty(c.rel)
      }

      if (!canonical && !targetExists && candidates.length === 0) {
        // 没有旧目录 = 还没开过段，交给正常懒创建
      }
    }

    // 5) 复习夹：章目录改名时随章移动；单独存在旧路径时也归位
    const oldReviewRel = joinRel(oldChapterRel, REVIEW_FOLDER_NAME)
    const newReviewRel = joinRel(chapterRel, REVIEW_FOLDER_NAME)
    if (oldReviewRel !== newReviewRel && entryMap.has(oldReviewRel) && !entryMap.has(newReviewRel)) {
      addMove({ from: oldReviewRel, to: newReviewRel, kind: 'unit', label: `章末复习「${chapter.name}」`, merge: true, unique: true })
      pushPair(plan.reviewPairs, oldReviewRel, newReviewRel)
    }
  })

  // 6) 工作区根上的旧会话夹：只回收“只有 .session.json”的孤儿
  for (const anchor of anchors) {
    if (lessonSessionIds.has(anchor.sessionId) || keepSessionIds.has(anchor.sessionId)) continue
    if (!anchor.rel) continue
    if (chapterPrefixes.some((p) => isUnder(anchor.rel, p))) continue
    const children = directChildren(entries, anchor.rel)
    const onlyAnchor = children.every((c) => !c.isDir && c.name === '.session.json')
    if (onlyAnchor) {
      addMove({ from: anchor.rel, to: '', kind: 'trash', label: `旧会话夹「${baseName(anchor.rel)}」` })
      const parent = parentRel(anchor.rel)
      if (parent && parent !== wsRel) addRemoveEmpty(parent)
    } else if (children.length > 0) {
      plan.warnings.push(`旧会话夹有内容，未自动回收：${anchor.rel}`)
    }
  }

  // 7) 执行顺序：章 -> 段整目录移动 -> 段内容合并 / 知识点资料 -> 回收
  const rank = (m: LayoutMove): number => {
    if (m.kind === 'chapter') return 0
    if (m.kind === 'segment' && !m.merge) return 1
    if (m.kind === 'segment') return 2
    if (m.kind === 'unit') return 3
    return 4
  }
  plan.moves.sort((a, b) => rank(a) - rank(b))
  plan.removeEmpty.sort((a, b) => b.length - a.length)
  return plan
}
