import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, rmdirSync } from 'fs'
import { dirname, isAbsolute, join } from 'path'
import { ipcMain } from 'electron'
import { getCurrentVault } from './kbStore/vaultContext'
import { readJson, writeJson } from './kbStore/jsonStore'
import { getWorkspaceOfSession, workspaceFolderRel, assignSession } from './aiTeachingWorkspaces'
import { ensureSessionFolder, ensureSessionFolderAt, sessionFolder, setLessonFolderResolver, setAssistantFolderResolver, resolveWriteOwnerRel, sanitizeTitle } from './aiTeachingFolders'
import { writeInventoryIndex, todayLocal } from './aiTeachingInventory'
import { renameWorkspacePath, uniqueFileName } from './workspaceManager'
import { createAgentSession, getAgentMessages, getAgentSession, sessionExists } from './agentSessionRepo'
import { invokeLlmInternal, firstEnabledModelSpec } from './llmService'
import { broadcast, BROADCAST_CHANNEL } from '../main/windowBus'
import { ensureQuizDocFrontmatter } from './quizDocPure'
import {
  parseCourseMd,
  rewriteCourseMd,
  normalizeOutline,
  cleanField,
  mergeOutlineAdditions,
  moveUnitInOutline,
  normalizeProgressFile,
  isHandoffTitle,
  pickReusableHandoff,
  type CourseOutline,
  type CourseUnitProgress,
  type CourseUnitStatus,
  type CourseLessonInfoV2,
  type CourseWsV2,
  type OutlineAdditions,
} from './aiTeachingCoursePure'
import {
  getSources,
  getSourceSummary,
  resolveSegmentSources,
  chapterSourceTitles,
  assistantSourcesSummary,
  remapChapterAssignments,
  renderSourcesHint,
  rewriteSourcePathPrefixes,
  type SourceSummary,
} from './aiTeachingSourceRegistry'
import { rewriteFavoritePrefixes } from './aiTeachingFavorites'
import {
  buildCourseLayoutPlan,
  chapterFolderName,
  unitFolderName,
  legacyChapterFolderName,
  legacyUnitFolderName,
  REVIEW_FOLDER_NAME,
  LAYOUT_VERSION,
  rewriteRelPrefix,
  type LayoutChapter,
  type LayoutUnit,
} from './aiTeachingLayoutPure'
import {
  chapterSegments,
  lessonUnitIds,
  nextSegmentOrder,
  prevSegmentOf,
  reviewState,
  unitLearned,
} from '../../src/lib/aiTeachingProgressPure'
import type { SegmentSource } from '../../src/lib/aiTeachingSourcesPure'

/**
 * AI教学 · 课程模式（3.14.0 简化：课程 = 工作区；章 → 知识点；一段覆盖同章多个知识点）
 *
 * - 大纲 = 工作区文件夹内 `课程.md`（**人读人改的唯一真相源**，程序按固定行格式解析/重写）；
 * - 进度 = `.knowbase/modules/aiTeaching/progress.json`（机器维护）：v2 段模型；
 * - 素材 = `.knowbase/modules/aiTeaching/sources.json`（登记 / 章级分配 / 段级快照三分离）；
 * - 课程助手 / 复习课 / 段 = 三类 aiTeaching 会话；零散会话不再进入左栏。
 */

export { parseCourseMd, rewriteCourseMd, parseOutlineJson } from './aiTeachingCoursePure'
export type { CourseChapter, CourseOutline, CourseUnit, CourseUnitProgress, CourseUnitStatus } from './aiTeachingCoursePure'

/** 一段（历史键名 lesson）：一条会话 + 一个产物夹，覆盖同章 1..N 个知识点 */
export interface LessonInfo {
  unitIds: string[]
  /** 当前聚焦知识点（点击胶囊 / 右栏定位时更新） */
  activeUnitId?: string
  /** 在本章内的顺序（1..N） */
  order: number
  /** open=进行中（可续） / ended=已收尾（只读） */
  status: 'open' | 'ended'
  /** 开段预检确认的素材快照；后续改章级分配不影响它 */
  sources: SegmentSource[]
  /** 段末交接仓库相对路径（未生成为 null） */
  handoffRel: string | null
  startedAt?: string
  endedAt?: string | null
  /** 旧字段：仅迁移期读兼容，不再写 */
  unitId?: string
  /** 旧字段：仅迁移期读兼容，不再写 */
  kind?: string
}

/** 章末复习课（每章一个；会话懒建，内容由与课程助手讨论得出） */
export interface ChapterReview {
  sessionId: string
  /** 复习讲义仓库相对路径（未生成为 null） */
  rel: string | null
}

export interface CourseState {
  /** 3.13 兼容字段：3.14 恒 true；P4 删除 */
  enabled: boolean
  outline: CourseOutline | null
  progress: Record<string, CourseUnitProgress>
  lessons: Record<string, LessonInfo>
  /** 章末复习课：chapterId → 会话 id + 复习讲义相对路径 */
  reviews: Record<string, ChapterReview>
  /** 课程助手（教学助手）会话 id；未建课为 null */
  assistantSessionId: string | null
  /** 素材计数（完整列表走 aiTeachCourse:getSources 按需加载） */
  sourceCounts: SourceSummary
}

type WsCourseState = CourseWsV2

interface ProgressFile {
  v: 2
  workspaces: Record<string, WsCourseState>
}

const KEY = 'progress.json'
const MODULE = 'modules/aiTeaching'
const OUTLINE_FILE = '课程.md'
const STATUSES: CourseUnitStatus[] = ['todo', 'learning', 'check', 'mastered', 'review']

// ===== 进度文件读写 =====

let progressMigrated = false

function backupProgressOnce(): void {
  try {
    const vault = getCurrentVault()
    if (!vault) return
    const dirAbs = join(vault.rootPath, '.knowbase', MODULE)
    const abs = join(dirAbs, KEY)
    const bak = join(dirAbs, 'progress.v1.bak.json')
    if (!existsSync(abs) || existsSync(bak)) return
    copyFileSync(abs, bak)
  } catch { /* 备份失败不阻断读取 */ }
}

function readProgressFile(): ProgressFile {
  const raw = readJson<unknown>(MODULE, KEY, { v: 1, workspaces: {} })
  const { file, migrated } = normalizeProgressFile(raw)
  if (migrated && !progressMigrated) {
    progressMigrated = true
    backupProgressOnce()
    try { writeJson(MODULE, KEY, file) } catch { /* 下次写盘再试 */ }
  }
  return file
}

function persist(f: ProgressFile): void {
  writeJson(MODULE, KEY, f)
}

function wsState(f: ProgressFile, wsId: string): WsCourseState {
  if (!f.workspaces[wsId]) f.workspaces[wsId] = { lessons: {}, units: {}, reviews: {} }
  const s = f.workspaces[wsId]
  if (!s.units || typeof s.units !== 'object') s.units = {}
  if (!s.lessons || typeof s.lessons !== 'object') s.lessons = {}
  if (!s.reviews || typeof s.reviews !== 'object') s.reviews = {}
  return s
}

function broadcastCourse(wsId: string): void {
  broadcast(BROADCAST_CHANNEL.aiTeachCourseRefresh, { wsId })
}

// ===== 大纲文件读写 =====

function outlineRel(wsId: string, getSetting: (key: string) => unknown): { rel: string; dirRel: string } | null {
  const folder = workspaceFolderRel(wsId, getSetting)
  if (!folder) return null
  return { rel: `${folder}/${OUTLINE_FILE}`, dirRel: folder }
}

export function readCourseOutline(wsId: string, getSetting: (key: string) => unknown): CourseOutline | null {
  const vault = getCurrentVault()
  const loc = outlineRel(wsId, getSetting)
  if (!vault || !loc) return null
  const abs = join(vault.rootPath, loc.rel)
  if (!existsSync(abs)) return null
  try { return parseCourseMd(readFileSync(abs, 'utf-8')) } catch { return null }
}

/** 章 ID 重映射：按章名把 reviews 搬到新 id（找不到同名章的旧数据保留不显示）。 */
function remapReviewKeys(wsId: string, oldOutline: CourseOutline | null, newOutline: CourseOutline): void {
  if (!oldOutline) return
  try {
    const f = readProgressFile()
    const s = wsState(f, wsId)
    const byName = new Map(newOutline.chapters.map((c) => [cleanField(c.name), c.id] as const))
    let changed = false
    for (const oldCh of oldOutline.chapters) {
      const newId = byName.get(cleanField(oldCh.name))
      if (!newId || newId === oldCh.id) continue
      const cur = s.reviews[oldCh.id]
      if (!cur) continue
      if (!s.reviews[newId]) s.reviews[newId] = cur
      delete s.reviews[oldCh.id]
      changed = true
    }
    if (changed) persist(f)
  } catch { /* 重映射失败不阻断大纲保存 */ }
}

export function writeCourseOutline(wsId: string, outline: CourseOutline, getSetting: (key: string) => unknown): { ok: boolean; relPath?: string; error?: string } {
  const vault = getCurrentVault()
  const loc = outlineRel(wsId, getSetting)
  if (!vault || !loc) return { ok: false, error: '尚未打开仓库或工作区不存在' }
  try {
    const old = readCourseOutline(wsId, getSetting)
    const abs = join(vault.rootPath, loc.rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, rewriteCourseMd(outline), 'utf-8')
    // v3.16.0：章名 / 章号 / 知识点名变化时先搬目录（旧 reviews 键还在，按 chapterId 能定位旧复习夹）
    migrateCourseLayoutTo(wsId, old, outline, getSetting)
    remapReviewKeys(wsId, old, outline)
    remapChapterAssignments(wsId, old, outline, getSetting)
    broadcast(BROADCAST_CHANNEL.aiTeachTreeRefresh, { dirRel: loc.dirRel.replace(/\\/g, '/') })
    broadcastCourse(wsId)
    return { ok: true, relPath: loc.rel }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ===== 课程状态 API =====

export function getCourseState(wsId: string, getSetting: (key: string) => unknown): CourseState {
  // v3.16.0：打开工作区时静默把旧扁平目录整理成「第N章 / NN 知识点 / 段N」。
  // 先迁移再读 progress，保证本次返回的 handoffRel / reviews.rel 已是新路径。
  ensureCourseLayout(wsId, getSetting)
  const f = readProgressFile()
  const s = wsState(f, wsId)
  return {
    enabled: true,
    outline: readCourseOutline(wsId, getSetting),
    progress: s.units,
    lessons: s.lessons as unknown as Record<string, LessonInfo>,
    reviews: s.reviews ?? {},
    assistantSessionId: s.assistantSessionId ?? null,
    sourceCounts: getSourceSummary(wsId, getSetting),
  }
}

// ===== v3.16.0：课程文件夹布局（章容器 / 知识点 / 章末复习）=====

const LAYOUT_KEY = 'layout.json'

interface LayoutStoreFile {
  v: 1
  workspaces: Record<string, {
    version: string
    migratedAt: string
    warnings?: string[]
  }>
}

interface LayoutMigrationResult {
  moved: number
  warnings: string[]
}

function readLayoutStore(): LayoutStoreFile {
  const raw = readJson<LayoutStoreFile>(MODULE, LAYOUT_KEY, { v: 1, workspaces: {} })
  if (!raw || typeof raw !== 'object') return { v: 1, workspaces: {} }
  if (!raw.workspaces || typeof raw.workspaces !== 'object') raw.workspaces = {}
  return raw
}

function isLayoutMigrated(wsId: string): boolean {
  return readLayoutStore().workspaces[wsId]?.version === LAYOUT_VERSION
}

function markLayoutMigrated(wsId: string, warnings: string[]): void {
  const store = readLayoutStore()
  store.workspaces[wsId] = {
    version: LAYOUT_VERSION,
    migratedAt: new Date().toISOString(),
    ...(warnings.length ? { warnings: warnings.slice(0, 50) } : {}),
  }
  writeJson(MODULE, LAYOUT_KEY, store)
}

/** 迁移前只备份元数据（progress / favorites），不复制用户大文件 */
function backupLayoutMeta(): void {
  try {
    const vault = getCurrentVault()
    if (!vault) return
    const dir = join(vault.rootPath, '.knowbase', MODULE, 'backup')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    for (const name of ['progress.json', 'favorites.json', 'sources.json']) {
      const src = join(vault.rootPath, '.knowbase', MODULE, name)
      if (existsSync(src)) copyFileSync(src, join(dir, `${name.replace(/\.json$/i, '')}.${stamp}.json`))
    }
  } catch { /* 备份失败不阻断迁移 */ }
}

function rewriteByPairs(value: string | null | undefined, pairs: Array<{ from: string; to: string }>): string | null {
  for (const p of pairs) {
    const next = rewriteRelPrefix(value, p.from, p.to)
    if (next) return next
  }
  return null
}

/** 找知识点夹当前实际位置：新路径 → 旧扁平路径 → 会话锚点反推（兼容用户手工改名） */
function resolveExistingUnitRel(wsId: string, unit: LayoutUnit, getSetting: (key: string) => unknown): string | null {
  const vault = getCurrentVault()
  if (!vault) return null
  for (const rel of [unit.unitRel, unit.legacyUnitRel]) {
    if (rel && existsSync(join(vault.rootPath, rel))) return rel
  }
  const f = readProgressFile()
  const s = wsState(f, wsId)
  for (const [sid, l] of Object.entries(s.lessons ?? {})) {
    if (!l.unitIds?.includes(unit.unitId)) continue
    // 段产物夹只挂在**段内第一个知识点**下；第二个知识点没有独立夹时不能反推成第一个的夹
    if (lessonUnitIds(l)[0] !== unit.unitId) continue
    const sf = sessionFolder(sid, getSetting)
    const rel = sf?.relPath
    if (!rel) continue
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    if (parent && parent !== unit.unitRel && parent !== unit.legacyUnitRel) return parent
  }
  return null
}

/** 找章末复习夹当前实际位置：新路径 → 旧扁平路径 → 复习会话锚点反推 */
function resolveExistingReviewRel(wsId: string, chapter: LayoutChapter, getSetting: (key: string) => unknown): string | null {
  const vault = getCurrentVault()
  if (!vault) return null
  for (const rel of [chapter.reviewRel, chapter.legacyReviewRel]) {
    if (rel && existsSync(join(vault.rootPath, rel))) return rel
  }
  const f = readProgressFile()
  const s = wsState(f, wsId)
  const review = s.reviews?.[chapter.chapterId]
  const sid = review?.sessionId
  if (!sid) return null
  const sf = sessionFolder(sid, getSetting)
  return sf?.relPath ?? null
}

/**
 * 把旧布局 / 旧章号 / 旧知识点名迁移到当前大纲对应的新路径。
 * - 初次迁移：oldOutline === newOutline；
 * - 大纲改名 / 调序：oldOutline 是保存前大纲，newOutline 是保存后大纲；
 * - 只移动已知的课程目录，不碰用户自建的其他文件夹。
 */
function migrateCourseLayoutTo(
  wsId: string,
  oldOutline: CourseOutline | null,
  newOutline: CourseOutline,
  getSetting: (key: string) => unknown,
  opts: { backup?: boolean } = {},
): LayoutMigrationResult {
  const vault = getCurrentVault()
  const wsRel = workspaceFolderRel(wsId, getSetting)
  if (!vault || !wsRel) return { moved: 0, warnings: ['工作区不存在或仓库未打开'] }
  if (!oldOutline) return { moved: 0, warnings: [] }

  const warnings: string[] = []
  const unitPairs: Array<{ from: string; to: string }> = []
  const reviewPairs: Array<{ from: string; to: string }> = []
  const sourcePairs: Array<{ from: string; to: string }> = []
  let moved = 0

  const oldPlan = buildCourseLayoutPlan(oldOutline, wsRel)
  const newPlan = buildCourseLayoutPlan(newOutline, wsRel)
  const oldUnits = new Map(oldPlan.units.map((u) => [u.unitId, u]))
  const oldChapters = new Map(oldPlan.chapters.map((c) => [c.chapterId, c]))

  type PlannedMove = { from: string; to: string; label: string; kind: 'unit' | 'review' | 'source' }
  const planned: PlannedMove[] = []
  const seenMoves = new Set<string>()
  const addMove = (m: PlannedMove): void => {
    if (!m.from || m.from === m.to) return
    const key = `${m.from}\0${m.to}`
    if (seenMoves.has(key)) return
    seenMoves.add(key)
    planned.push(m)
  }

  // 1) 知识点目录：章容器 + 本章序号
  for (const next of newPlan.units) {
    const prev = oldUnits.get(next.unitId)
    if (!prev) continue
    const from = resolveExistingUnitRel(wsId, prev, getSetting)
    if (from) addMove({ from, to: next.unitRel, label: `知识点「${next.unitName}」`, kind: 'unit' })
    // 2) SOURCES 仍平铺，但章号/知识点名变化时同步旧素材夹名，避免下次登记写丢
    const sourceOldCandidates = [
      `${wsRel}/SOURCES/${prev.legacySourceKey}`,
      `${wsRel}/SOURCES/${prev.sourceKey}`,
    ]
    const sourceFrom = sourceOldCandidates.find((rel) => existsSync(join(vault.rootPath, rel))) ?? null
    if (sourceFrom) addMove({
      from: sourceFrom,
      to: `${wsRel}/SOURCES/${next.sourceKey}`,
      label: `素材夹「${next.unitName}」`,
      kind: 'source',
    })
  }

  // 3) 章末复习目录：章容器下的「章末复习」
  for (const next of newPlan.chapters) {
    const prev = oldChapters.get(next.chapterId)
    if (!prev) continue
    const from = resolveExistingReviewRel(wsId, prev, getSetting)
    if (from) addMove({ from, to: next.reviewRel, label: `章末复习「${next.chapterName}」`, kind: 'review' })
  }

  // 4) 执行移动。章调序时目标可能正被另一个旧夹占用，先搬到隐藏暂存区，
  //    等所有源夹让位后再落目标；避免「第1章 ↔ 第2章」互换时互相报目标已存在。
  if (opts.backup && planned.length > 0) backupLayoutMeta()
  const stagingRel = `${wsRel}/.aiTeach-layout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const stagingAbs = join(vault.rootPath, stagingRel)
  const staged: Array<{ move: PlannedMove; tempRel: string }> = []
  const done: PlannedMove[] = []
  let stagingIndex = 0

  for (const m of planned) {
    const fromAbs = join(vault.rootPath, m.from)
    const toAbs = join(vault.rootPath, m.to)
    if (!existsSync(fromAbs)) continue
    if (!existsSync(toAbs)) {
      try {
        renameWorkspacePath(vault.rootId, m.from, m.to)
        moved++
        done.push(m)
      } catch (e) {
        warnings.push(`${m.label}：移动失败（${(e as Error).message}）`)
      }
      continue
    }
    // 目标被占用：暂存，稍后重试
    try {
      mkdirSync(stagingAbs, { recursive: true })
      const tempRel = `${stagingRel}/${stagingIndex++}-${m.from.split('/').pop() || 'item'}`
      renameWorkspacePath(vault.rootId, m.from, tempRel)
      staged.push({ move: m, tempRel })
    } catch (e) {
      warnings.push(`${m.label}：暂存失败（${(e as Error).message}）`)
    }
  }

  for (const s of staged) {
    const tempAbs = join(vault.rootPath, s.tempRel)
    const toAbs = join(vault.rootPath, s.move.to)
    if (existsSync(toAbs)) {
      // 目标仍被用户自建夹/未迁移夹占用：尽量放回原位，绝不覆盖
      try {
        const fromAbs = join(vault.rootPath, s.move.from)
        if (!existsSync(fromAbs)) renameWorkspacePath(vault.rootId, s.tempRel, s.move.from)
        else warnings.push(`${s.move.label}：目标与暂存原路径都已被占用，保留在 ${s.tempRel}`)
      } catch (e) {
        warnings.push(`${s.move.label}：回退失败（${(e as Error).message}）`)
      }
      warnings.push(`${s.move.label}：目标已存在，已保留原目录（${s.move.to}）`)
      continue
    }
    try {
      renameWorkspacePath(vault.rootId, s.tempRel, s.move.to)
      moved++
      done.push(s.move)
    } catch (e) {
      warnings.push(`${s.move.label}：落位失败（${(e as Error).message}）`)
    }
  }
  try { rmdirSync(stagingAbs) } catch { /* 非空/已删都不影响 */ }

  // 章调序 / 改名后，旧章容器若已空则收掉；非空（用户文件/未迁移会话）保留
  const newChapterRels = new Set(newPlan.chapters.map((c) => c.chapterRel))
  for (const oldChapter of oldPlan.chapters) {
    if (!oldChapter.chapterRel || newChapterRels.has(oldChapter.chapterRel)) continue
    try { rmdirSync(join(vault.rootPath, oldChapter.chapterRel)) } catch { /* 非空保留 */ }
  }

  for (const m of done) {
    if (m.kind === 'unit') unitPairs.push({ from: m.from, to: m.to })
    else if (m.kind === 'review') reviewPairs.push({ from: m.from, to: m.to })
    else sourcePairs.push({ from: m.from, to: m.to })
  }

  // 4b) 幂等修复：目录已经在新位置、旧位置已不存在，但元数据还停在旧路径（上次迁移中途失败 / 手工搬过）时，
  //     仍然把 prefix 对补上；目标与旧路径同时存在（冲突）则不动，避免把有效路径改成未迁移的目录。
  const addPair = (pairs: Array<{ from: string; to: string }>, from: string, to: string): void => {
    if (!from || from === to) return
    if (!existsSync(join(vault.rootPath, to))) return
    if (existsSync(join(vault.rootPath, from))) return
    if (!pairs.some((p) => p.from === from && p.to === to)) pairs.push({ from, to })
  }
  for (const next of newPlan.units) {
    const prev = oldUnits.get(next.unitId)
    if (!prev) continue
    addPair(unitPairs, prev.legacyUnitRel, next.unitRel)
    addPair(unitPairs, prev.unitRel, next.unitRel)
    addPair(sourcePairs, `${wsRel}/SOURCES/${prev.legacySourceKey}`, `${wsRel}/SOURCES/${next.sourceKey}`)
    addPair(sourcePairs, `${wsRel}/SOURCES/${prev.sourceKey}`, `${wsRel}/SOURCES/${next.sourceKey}`)
  }
  for (const next of newPlan.chapters) {
    const prev = oldChapters.get(next.chapterId)
    if (!prev) continue
    addPair(reviewPairs, prev.legacyReviewRel, next.reviewRel)
    addPair(reviewPairs, prev.reviewRel, next.reviewRel)
  }

  // 4) 元数据跟随目录一起改，避免「文件搬了、继续/复习入口还指旧路径」
  const allPairs = [...unitPairs, ...reviewPairs]
  if (allPairs.length > 0 || sourcePairs.length > 0) {
    const f = readProgressFile()
    const s = wsState(f, wsId)
    let changed = false
    for (const lesson of Object.values(s.lessons ?? {})) {
      const next = rewriteByPairs(lesson.handoffRel, unitPairs)
      if (next && next !== lesson.handoffRel) {
        lesson.handoffRel = next
        changed = true
      }
    }
    for (const unit of Object.values(s.units ?? {})) {
      const next = rewriteByPairs(unit.summaryRel, unitPairs)
      if (next && next !== unit.summaryRel) {
        unit.summaryRel = next
        changed = true
      }
    }
    for (const review of Object.values(s.reviews ?? {})) {
      const next = rewriteByPairs(review.rel, reviewPairs)
      if (next && next !== review.rel) {
        review.rel = next
        changed = true
      }
    }
    if (changed) persist(f)
    const pathPairs = [...allPairs, ...sourcePairs]
    rewriteFavoritePrefixes(wsId, pathPairs)
    rewriteSourcePathPrefixes(wsId, pathPairs)
  }

  if (moved > 0) {
    broadcast(BROADCAST_CHANNEL.aiTeachTreeRefresh, { dirRel: wsRel })
    broadcastCourse(wsId)
  }
  return { moved, warnings }
}

/**
 * 打开工作区时的自动整理入口：成功静默；失败只写日志，不阻断课程状态返回。
 * 由 getCourseState / openSegment / openChapterReview 调用，用户无需任何操作。
 */
export function ensureCourseLayout(wsId: string, getSetting: (key: string) => unknown): void {
  const id = String(wsId ?? '').trim()
  if (!id) return
  try {
    const vault = getCurrentVault()
    if (!vault) return
    const wsRel = workspaceFolderRel(id, getSetting)
    if (!wsRel) return
    // 工作区夹尚未创建（或根目录设置还没就绪）时不要把 marker 写死，等真正有目录再整理
    if (!existsSync(join(vault.rootPath, wsRel))) return
    if (isLayoutMigrated(id)) return
    const outline = readCourseOutline(id, getSetting)
    if (!outline) return
    const r = migrateCourseLayoutTo(id, outline, outline, getSetting, { backup: true })
    markLayoutMigrated(id, r.warnings)
    if (r.warnings.length > 0) console.warn('[aiTeaching] 课程文件夹自动整理有未完成项：', r.warnings)
  } catch (e) {
    console.warn('[aiTeaching] 课程文件夹自动整理失败，下次打开工作区会重试：', e)
  }
}


/** 3.13 兼容：3.14 课程 = 有 `课程.md` 即课程；开关不再生效。 */
export function setCourseEnabled(_wsId: string, _enabled: boolean): { ok: boolean; error?: string } {
  return { ok: true }
}

export function setUnitProgress(wsId: string, unitId: string, patch: Partial<CourseUnitProgress>): { ok: boolean; error?: string } {
  if (!wsId || !unitId) return { ok: false, error: '参数缺失' }
  const f = readProgressFile()
  const s = wsState(f, wsId)
  const cur: CourseUnitProgress = s.units[unitId] ?? { status: 'todo', mastery: 0, lastCheckedAt: null }
  const next: CourseUnitProgress = { ...cur }
  if (patch.status && STATUSES.includes(patch.status)) next.status = patch.status
  if (typeof patch.mastery === 'number' && Number.isFinite(patch.mastery)) next.mastery = Math.max(0, Math.min(1, patch.mastery))
  if (patch.lastCheckedAt !== undefined) next.lastCheckedAt = patch.lastCheckedAt
  if (typeof patch.finished === 'boolean') next.finished = patch.finished
  s.units[unitId] = next
  persist(f)
  broadcastCourse(wsId)
  return { ok: true }
}

// ===== 段（L2）：开段 / 聚焦 / 收尾 / 交接 =====

function lessonsOf(s: WsCourseState, unitId: string): Array<{ sid: string; info: LessonInfo }> {
  return Object.entries(s.lessons)
    .filter(([, l]) => lessonUnitIds(l).includes(unitId))
    .map(([sid, info]) => ({ sid, info: info as LessonInfo }))
    .sort((a, b) => a.info.order - b.info.order)
}

function chapterOfUnit(outline: CourseOutline | null, unitId: string): { chapter: CourseOutline['chapters'][number]; index: number } | null {
  if (!outline) return null
  for (let i = 0; i < outline.chapters.length; i++) {
    const c = outline.chapters[i]
    if (c.units.some((u) => u.id === unitId)) return { chapter: c, index: i }
  }
  return null
}

function chapterUnitIds(outline: CourseOutline | null, chapterId: string): string[] {
  return (outline?.chapters.find((c) => c.id === chapterId)?.units ?? []).map((u) => u.id)
}

export interface SegmentOpenResult {
  ok: boolean
  sessionId?: string
  order?: number
  status?: 'open' | 'ended'
  readonly?: boolean
  error?: string
}

/**
 * 开一段：同章 1..N 个知识点；同章同时只允许一个 open 段。
 * - 请求集合是现有 open 段的子集/相等 → 续上；
 * - 本章有别的 open 段 → 拒绝（先收尾）；
 * - 新段对每个 unit 做回炉（finished=false / learning）。
 */
export function openSegment(wsId: string, unitIdsRaw: string[], sources: SegmentSource[], getSetting: (key: string) => unknown): SegmentOpenResult {
  if (!getCurrentVault()) return { ok: false, error: '尚未打开仓库' }
  const id = String(wsId ?? '').trim()
  const unitIds = Array.from(new Set((unitIdsRaw ?? []).map((x) => String(x ?? '').trim()).filter(Boolean)))
  if (!id || !unitIds.length) return { ok: false, error: '缺少工作区或知识点' }
  const outline = readCourseOutline(id, getSetting)
  if (!outline) return { ok: false, error: '该工作区还没有课程大纲' }
  ensureCourseLayout(id, getSetting)
  const first = chapterOfUnit(outline, unitIds[0])
  if (!first) return { ok: false, error: '知识点不存在' }
  if (unitIds.some((uid) => chapterOfUnit(outline, uid)?.chapter.id !== first.chapter.id)) {
    return { ok: false, error: '一段只能覆盖同一章的知识点' }
  }
  const f = readProgressFile()
  const s = wsState(f, id)
  const chapterIds = new Set(first.chapter.units.map((u) => u.id))
  const open = Object.entries(s.lessons).find(([, l]) => l.status === 'open' && lessonUnitIds(l).some((uid) => chapterIds.has(uid)))
  if (open) {
    const existing = lessonUnitIds(open[1])
    if (unitIds.every((uid) => existing.includes(uid))) {
      return { ok: true, sessionId: open[0], order: open[1].order, status: 'open', readonly: false }
    }
    return { ok: false, error: '本章还有一段没收尾，先收尾再开新段' }
  }
  const order = nextSegmentOrder(s.lessons, [...chapterIds])
  const start = first.chapter.units.find((u) => u.id === unitIds[0])
  const end = first.chapter.units.find((u) => u.id === unitIds[unitIds.length - 1])
  const title = `第${first.index + 1}章 段${order}${start && end && start.id !== end.id ? ` · ${start.name}–${end.name}` : start ? ` · ${start.name}` : ''}`
  const row = createAgentSession(title, 'aiTeaching')
  assignSession(row.id, id)
  s.lessons[row.id] = {
    unitIds,
    activeUnitId: unitIds[0],
    order,
    status: 'open',
    sources: Array.isArray(sources) ? sources : [],
    handoffRel: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
  }
  for (const uid of unitIds) {
    const up = s.units[uid] ?? { status: 'todo' as CourseUnitStatus, mastery: 0, lastCheckedAt: null }
    s.units[uid] = { ...up, finished: false, status: 'learning' }
  }
  persist(f)
  broadcastCourse(id)
  return { ok: true, sessionId: row.id, order, status: 'open', readonly: false }
}

/** 3.13 兼容：打开单知识点 = 开一个只含该知识点的段。 */
export function openUnit(wsId: string, unitId: string, _kind: string | undefined, getSetting: (key: string) => unknown): SegmentOpenResult & { kind?: string } {
  const r = openSegment(wsId, [unitId], [], getSetting)
  return { ...r, kind: '精讲' }
}

/** 段内切换当前聚焦知识点（不新建会话）。 */
export function setActiveUnit(sessionId: string, unitId: string): { ok: boolean; error?: string } {
  const wsId = getWorkspaceOfSession(sessionId)
  if (!wsId) return { ok: false, error: '会话未归属工作区' }
  const f = readProgressFile()
  const s = wsState(f, wsId)
  const l = s.lessons[sessionId]
  if (!l) return { ok: false, error: '该会话不是一段' }
  if (l.status !== 'open') return { ok: false, error: '本段已收尾' }
  if (!lessonUnitIds(l).includes(unitId)) return { ok: false, error: '该知识点不在本段' }
  l.activeUnitId = unitId
  persist(f)
  broadcastCourse(wsId)
  return { ok: true }
}

/** 收尾一段：整段冻结；段内所有知识点置学完（不看掌握度）。 */
export function endSegment(sessionId: string): { ok: boolean; wsId?: string; unitIds?: string[]; error?: string } {
  const wsId = getWorkspaceOfSession(sessionId)
  if (!wsId) return { ok: false, error: '会话未归属工作区' }
  const f = readProgressFile()
  const s = wsState(f, wsId)
  const l = s.lessons[sessionId]
  if (!l) return { ok: false, error: '该会话不是一段' }
  const ids = lessonUnitIds(l)
  l.status = 'ended'
  l.endedAt = new Date().toISOString()
  const now = new Date().toISOString()
  for (const uid of ids) {
    const up = s.units[uid] ?? { status: 'todo' as CourseUnitStatus, mastery: 0, lastCheckedAt: null }
    s.units[uid] = { ...up, finished: true, status: 'mastered', lastCheckedAt: now }
  }
  persist(f)
  broadcastCourse(wsId)
  return { ok: true, wsId, unitIds: ids }
}

/** 3.13 兼容：结束单知识点课时。 */
export function endLesson(sessionId: string): { ok: boolean; wsId?: string; unitId?: string; error?: string } {
  const r = endSegment(sessionId)
  return { ...r, unitId: r.unitIds?.[0] }
}

/**
 * 打开/取「课程助手」会话：整门课唯一、懒建、不绑知识点。
 * - 已存在且会话仍在 → 直接返回；否则新建一条普通会话（source='aiTeaching'）并入工作区。
 * - 无大纲也可调用（冷启动即可和助手聊规划/整理素材）。
 * - 不写入 lessons（因此不计课时、不进 progress 的 units）。
 */
export function openCourseAssistant(wsId: string, _getSetting: (key: string) => unknown): { ok: boolean; sessionId?: string; error?: string } {
  if (!getCurrentVault()) return { ok: false, error: '尚未打开仓库' }
  const id = String(wsId ?? '').trim()
  if (!id) return { ok: false, error: '缺少工作区' }
  const f = readProgressFile()
  const s = wsState(f, id)
  const existing = s.assistantSessionId
  if (existing && sessionExists(existing)) return { ok: true, sessionId: existing }
  const row = createAgentSession('课程助手', 'aiTeaching')
  assignSession(row.id, id)
  s.assistantSessionId = row.id
  persist(f)
  broadcastCourse(id)
  return { ok: true, sessionId: row.id }
}

// ===== 章末复习课（每章一个；会话懒建，内容由与课程助手讨论得出）=====

/** 找会话是否为某章的复习课会话 → { wsId, chapterId } */
function findReviewBySession(sessionId: string): { wsId: string; chapterId: string } | null {
  if (!sessionId) return null
  const f = readProgressFile()
  for (const [wsId, st] of Object.entries(f.workspaces)) {
    const rs = st?.reviews
    if (!rs) continue
    for (const [chapterId, r] of Object.entries(rs)) if (r?.sessionId === sessionId) return { wsId, chapterId }
  }
  return null
}

/**
 * 打开/取某章的「复习课」会话：每章一个、懒建、不绑知识点（不计课时/进度）。
 * - 已存在且会话仍在 → 直接返回；否则新建普通会话（source='aiTeaching'）并入工作区。
 * - 内容由用户与课程助手讨论得出；结论落盘走 writeChapterReviewDoc。
 */
export function openChapterReview(wsId: string, chapterId: string, getSetting: (key: string) => unknown): { ok: boolean; sessionId?: string; error?: string } {
  if (!getCurrentVault()) return { ok: false, error: '尚未打开仓库' }
  const id = String(wsId ?? '').trim()
  const cid = String(chapterId ?? '').trim()
  if (!id || !cid) return { ok: false, error: '缺少参数' }
  const outline = readCourseOutline(id, getSetting)
  const chapter = (outline?.chapters ?? []).find((c) => c.id === cid)
  if (!chapter) return { ok: false, error: '章不存在' }
  ensureCourseLayout(id, getSetting)
  const f = readProgressFile()
  const s = wsState(f, id)
  if (!s.reviews) s.reviews = {}
  const existing = s.reviews[cid]
  const st = reviewState(cid, chapter.units.map((u) => u.id), s.units, s.lessons, s.reviews)
  if (st.state === 'locked') {
    return { ok: false, error: `本章还有 ${st.remaining} 个知识点没学完，学完自动解锁` }
  }
  if (existing?.sessionId && sessionExists(existing.sessionId)) return { ok: true, sessionId: existing.sessionId }
  const row = createAgentSession(`复习课·${chapter.name}`, 'aiTeaching')
  assignSession(row.id, id)
  s.reviews[cid] = { sessionId: row.id, rel: existing?.rel ?? null }
  persist(f)
  broadcastCourse(id)
  return { ok: true, sessionId: row.id }
}

/** 章容器相对路径：`{工作区}/第N章 章名`（知识点与章末复习都挂在这里） */
export function chapterFolderRel(wsId: string, chapterId: string, getSetting: (key: string) => unknown): string | null {
  const wsFolder = workspaceFolderRel(wsId, getSetting)
  if (!wsFolder) return null
  const outline = readCourseOutline(wsId, getSetting)
  const found = (outline?.chapters ?? []).findIndex((c) => c.id === chapterId)
  const chapter = found >= 0 ? outline?.chapters[found] : null
  return `${wsFolder}/${chapterFolderName(found >= 0 ? found : 0, chapter?.name ?? '复习')}`
}

/** 章末复习夹：`{工作区}/第N章 章名/章末复习`（迁移前回退旧 `{章号}·{章名}`） */
export function reviewFolderRel(wsId: string, chapterId: string, getSetting: (key: string) => unknown): string | null {
  const vault = getCurrentVault()
  const wsFolder = workspaceFolderRel(wsId, getSetting)
  if (!vault || !wsFolder) return null
  const outline = readCourseOutline(wsId, getSetting)
  const found = (outline?.chapters ?? []).findIndex((c) => c.id === chapterId)
  const idx = found >= 0 ? found : 0
  const chapter = found >= 0 ? outline?.chapters[found] : null
  const next = `${wsFolder}/${chapterFolderName(idx, chapter?.name ?? '复习')}/${REVIEW_FOLDER_NAME}`
  const legacy = `${wsFolder}/${legacyChapterFolderName(idx, chapter?.name ?? '复习')}`
  if (existsSync(join(vault.rootPath, next))) return next
  if (existsSync(join(vault.rootPath, legacy))) return legacy
  // 章名改过 / 用户手工改过目录时，按复习会话锚点找回实际夹（迁移或回退都能落到正确位置）
  const f = readProgressFile()
  const s = wsState(f, wsId)
  const sid = s.reviews?.[chapterId]?.sessionId
  if (sid) {
    const sf = sessionFolder(sid, getSetting)
    if (sf?.relPath) return sf.relPath
  }
  return next
}

/** 写「复习讲义」到本章的章末复习目录并记录 rel（会话须是复习课会话）。返回相对/绝对路径。 */
export function writeChapterReviewDoc(sessionId: string, content: unknown, getSetting: (key: string) => unknown): { ok: boolean; relPath?: string; absPath?: string; error?: string } {
  const vault = getCurrentVault()
  if (!vault) return { ok: false, error: '尚未打开仓库' }
  const hit = findReviewBySession(String(sessionId ?? ''))
  if (!hit) return { ok: false, error: '仅可在复习课会话中生成复习讲义' }
  const dirRel = reviewFolderRel(hit.wsId, hit.chapterId, getSetting)
  if (!dirRel) return { ok: false, error: '无法确定章目录' }
  try {
    const dirAbs = join(vault.rootPath, dirRel)
    mkdirSync(dirAbs, { recursive: true })
    const fname = '复习讲义.md'
    writeFileSync(join(dirAbs, fname), String(content ?? '').replace(/\r\n/g, '\n'), 'utf-8')
    const relPath = `${dirRel}/${fname}`
    const f = readProgressFile()
    const s = wsState(f, hit.wsId)
    if (!s.reviews) s.reviews = {}
    s.reviews[hit.chapterId] = { sessionId: s.reviews[hit.chapterId]?.sessionId ?? String(sessionId), rel: relPath }
    persist(f)
    broadcastCourse(hit.wsId)
    broadcast(BROADCAST_CHANNEL.aiTeachTreeRefresh, { dirRel })
    return { ok: true, relPath, absPath: join(dirAbs, fname) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 取本段同章上一段的交接内容（无则空串）。 */
export function readPrevHandoff(sessionId: string, getSetting: (key: string) => unknown): string {
  const wsId = getWorkspaceOfSession(sessionId)
  if (!wsId) return ''
  const f = readProgressFile()
  const s = wsState(f, wsId)
  const cur = s.lessons?.[sessionId]
  if (!cur) return ''
  const outline = readCourseOutline(wsId, getSetting)
  const ch = chapterOfUnit(outline, lessonUnitIds(cur)[0])
  if (!ch) return ''
  const prev = prevSegmentOf(s.lessons, sessionId, ch.chapter.units.map((u) => u.id))
  if (!prev) return ''
  const vault = getCurrentVault()
  if (!vault) return ''
  const rel = prev.lesson.handoffRel || (() => {
    const folder = lessonFolderRel(prev.sessionId, getSetting)
    return folder ? `${folder}/交接.md` : null
  })()
  if (!rel) return ''
  const abs = join(vault.rootPath, rel)
  if (!existsSync(abs)) return ''
  try { return readFileSync(abs, 'utf-8').slice(0, 4000) } catch { return '' }
}

function defaultModel(): { providerId?: string; modelId?: string } {
  return resolveOutlineModel({})
}

/** L1：段的物理文件夹相对路径 `{工作区}/第N章 章名/{NN} 知识点/段N`；非段返回 null。
 *  旧 `课时N·类型` 夹若已存在则继续用它（不搬用户文件）。 */
function lessonFolderRel(sessionId: string, getSetting: (key: string) => unknown): string | null {
  const wsId = getWorkspaceOfSession(sessionId)
  if (!wsId) return null
  const f = readProgressFile()
  const st = wsState(f, wsId)
  // 章末复习课会话：落章容器下的「章末复习」子目录
  const revChapter = Object.entries(st.reviews ?? {}).find(([, r]) => r?.sessionId === sessionId)?.[0]
  if (revChapter) return reviewFolderRel(wsId, revChapter, getSetting)
  const l = st.lessons[sessionId]
  if (!l) return null
  const firstUnitId = lessonUnitIds(l)[0]
  const unitDirRel = unitFolderRel(wsId, firstUnitId, getSetting)
  if (!unitDirRel) return null
  // 旧课时夹兼容：{unit}/课时{order}·{kind}
  try {
    const vault = getCurrentVault()
    if (vault) {
      const dirAbs = join(vault.rootPath, unitDirRel)
      const prefix = `课时${l.order}·`
      const old = readdirSync(dirAbs, { withFileTypes: true }).find((d) => d.isDirectory() && d.name.startsWith(prefix))
      if (old) return `${unitDirRel}/${old.name}`
    }
  } catch { /* 目录不存在 → 新段夹 */ }
  return `${unitDirRel}/段${l.order}`
}

// L1：注册课时文件夹解析器给 aiTeachingFolders（避免 folders↔course 循环 import）
setLessonFolderResolver(lessonFolderRel)

/** 课程助手物理文件夹相对路径 `{工作区}/课程助手`（**固定名、无日期**，一个工作区一个）；非助手返回 null。
 *  产物统一落其下 `output/`（由 aiTeachingFolders 的 write-owner 逻辑拼），元数据仍在夹顶层。 */
function assistantFolderRel(sessionId: string, getSetting: (key: string) => unknown): string | null {
  if (!sessionId) return null
  const f = readProgressFile()
  for (const [wsId, st] of Object.entries(f.workspaces)) {
    if (st?.assistantSessionId === sessionId) {
      const wsFolder = workspaceFolderRel(wsId, getSetting)
      return wsFolder ? `${wsFolder}/课程助手` : null
    }
  }
  return null
}
setAssistantFolderResolver(assistantFolderRel)

/** L5：会话所属知识点的文件夹相对路径 `{工作区}/第N章.../{NN} 知识点`（画像第三层落点）；非课时返回 null */
export function getSessionUnitFolderRel(sessionId: string, getSetting: (key: string) => unknown): string | null {
  if (findReviewBySession(sessionId)) return null // 复习课无「所属知识点」层
  const rel = lessonFolderRel(sessionId, getSetting)
  return rel ? rel.slice(0, rel.lastIndexOf('/')) : null
}

/** L1/L3：知识点文件夹相对路径 `{工作区}/第N章 章名/{NN} 知识点`（总结篇 / 三层要求落点）。
 *  迁移完成前若旧扁平目录仍存在，回退旧路径——保证脚本/迁移中断时课程不会失联。 */
export function unitFolderRel(wsId: string, unitId: string, getSetting: (key: string) => unknown): string | null {
  const vault = getCurrentVault()
  const wsFolder = workspaceFolderRel(wsId, getSetting)
  if (!vault || !wsFolder) return null
  const outline = readCourseOutline(wsId, getSetting)
  let chapterIndex = -1
  let unitIndex = -1
  let chapterName = ''
  let unitName = ''
  ;(outline?.chapters ?? []).forEach((c, ci) => {
    const ui = c.units.findIndex((u) => u.id === unitId)
    if (ui >= 0) {
      chapterIndex = ci
      unitIndex = ui
      chapterName = c.name
      unitName = c.units[ui].name
    }
  })
  if (chapterIndex < 0 || unitIndex < 0) return null
  const next = `${wsFolder}/${chapterFolderName(chapterIndex, chapterName)}/${unitFolderName(unitIndex, unitName)}`
  const legacy = `${wsFolder}/${legacyUnitFolderName(chapterIndex, unitName)}`
  if (existsSync(join(vault.rootPath, next))) return next
  if (existsSync(join(vault.rootPath, legacy))) return legacy
  // 用户手工改过知识点夹 / 迁移中断：按本知识点的段会话锚点反推实际父目录
  const f = readProgressFile()
  const s = wsState(f, wsId)
  for (const [sid, l] of Object.entries(s.lessons ?? {})) {
    if (!l.unitIds?.includes(unitId)) continue
    // 段产物夹只挂第一个知识点；其他知识点没有夹时不能借用第一个的父目录
    if (lessonUnitIds(l)[0] !== unitId) continue
    const sf = sessionFolder(sid, getSetting)
    if (!sf?.relPath) continue
    const parent = sf.relPath.includes('/') ? sf.relPath.slice(0, sf.relPath.lastIndexOf('/')) : ''
    if (parent && parent !== wsFolder) return parent
  }
  return next
}

function writeFolderFile(sessionId: string, name: string, content: string, getSetting: (key: string) => unknown): { ok: boolean; relPath?: string; error?: string } {
  const vault = getCurrentVault()
  if (!vault) return { ok: false, error: '尚未打开仓库' }
  const lessonRel = lessonFolderRel(sessionId, getSetting)
  const folder = lessonRel ? ensureSessionFolderAt(sessionId, lessonRel, getSetting) : ensureSessionFolder(sessionId, getSetting)
  if (!folder.ok || !folder.relPath) return { ok: false, error: folder.error ?? '会话文件夹创建失败' }
  const rel = `${folder.relPath}/${name}`
  try {
    writeFileSync(join(vault.rootPath, rel), content, 'utf-8')
    broadcast(BROADCAST_CHANNEL.aiTeachTreeRefresh, { dirRel: folder.relPath })
    return { ok: true, relPath: rel }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

function transcriptOf(sessionId: string, limit = 6000): string {
  const msgs = getAgentMessages(sessionId).filter((m) => m.role === 'user' || m.role === 'assistant')
  const text = msgs.map((m) => `${m.role === 'user' ? '学生' : '老师'}：${m.content}`).join('\n\n')
  return text.length > limit ? text.slice(-limit) : text
}

/** 段收尾后：生成 交接.md（固定四段）落本段夹，并写 handoffRel。
 *  幂等：已有交接（handoffRel 优先，标准路径兜底）直接复用，不重复调用模型或覆盖文件。 */
export async function finalizeSegment(sessionId: string, getSetting: (key: string) => unknown): Promise<{ ok: boolean; relPath?: string; error?: string; skipped?: boolean; reused?: boolean }> {
  const wsId = getWorkspaceOfSession(sessionId)
  if (!wsId) return { ok: false, error: '会话未归属工作区' }
  const vault = getCurrentVault()
  if (!vault) return { ok: false, error: '尚未打开仓库' }
  const f = readProgressFile()
  const s = wsState(f, wsId)
  const lesson = s.lessons[sessionId]
  const folderRel = lesson ? lessonFolderRel(sessionId, getSetting) : null
  const standardRel = folderRel ? `${folderRel}/交接.md` : null
  const existingRel = pickReusableHandoff(lesson?.handoffRel, standardRel, (rel) => existsSync(join(vault.rootPath, rel)))
  if (existingRel) {
    if (lesson && lesson.handoffRel !== existingRel) {
      lesson.handoffRel = existingRel
      persist(f)
    }
    return { ok: true, relPath: existingRel, reused: true }
  }
  // 空段（零消息）不生成占位交接
  const msgs = getAgentMessages(sessionId).filter((m) => m.role === 'user' || m.role === 'assistant')
  if (msgs.length === 0) return { ok: true, skipped: true }
  const { providerId, modelId } = defaultModel()
  const sys = '你是助教。根据这一段课程的对话，写一份交给同章下一段的「交接」。只输出四段 markdown，简体中文，简洁具体。'
  const user = `本段对话记录：\n${transcriptOf(sessionId) || '（本段没有对话）'}\n\n请严格按下面四段输出：\n- 本段要点：…\n- 掌握情况：…（哪里会了、哪里卡）\n- 遗留问题：…（没讲完/没搞懂的）\n- 下段建议：…（从哪继续、练什么）`
  const r = await invokeLlmInternal({ providerId, modelId, effort: 'off', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], sessionId })
  const body = r.ok ? r.content.trim() : `（交接自动生成失败：${r.error}——可手动补写）`
  const title = getAgentSession(sessionId)?.title ?? '本段'
  const w = writeFolderFile(sessionId, '交接.md', `# 交接 · ${title}\n\n${body}\n`, getSetting)
  if (w.ok && w.relPath) {
    try {
      if (s.lessons[sessionId]) {
        s.lessons[sessionId].handoffRel = w.relPath
        persist(f)
      }
    } catch { /* 交接已落盘；handoffRel 下次可再补 */ }
  }
  return w
}

/** 3.13 兼容：结束单知识点课时后的交接。 */
export async function finalizeLesson(sessionId: string, getSetting: (key: string) => unknown): Promise<{ ok: boolean; relPath?: string; error?: string; skipped?: boolean }> {
  return finalizeSegment(sessionId, getSetting)
}

/** 知识点收尾：汇总各课时 → 生成 总结·{知识点}.md，置 finished */
export async function finishUnit(wsId: string, unitId: string, getSetting: (key: string) => unknown, score?: { correct: number; total: number }): Promise<{ ok: boolean; summaryRel?: string; error?: string }> {
  const vault = getCurrentVault()
  if (!vault) return { ok: false, error: '尚未打开仓库' }
  const f = readProgressFile()
  const s = wsState(f, wsId)
  const outline = readCourseOutline(wsId, getSetting)
  const unit = outline?.chapters.flatMap((c) => c.units).find((u) => u.id === unitId)
  if (!unit) return { ok: false, error: '知识点不存在' }
  const arr = lessonsOf(s, unitId)
  if (arr.length === 0 || arr.some((l) => l.info.status !== 'ended')) {
    return { ok: false, error: '还有课时未结束，先把课时上完' }
  }
  const merged = arr.map((l) => `— 段${l.info.order} —\n${transcriptOf(l.sid, 2500)}`).join('\n\n').slice(-12000)
  const { providerId, modelId } = defaultModel()
  const sys = `你是课程助教。为知识点「${unit.name}」写一篇收尾总结（总结篇），用于日后回顾。`
  const user = `知识点：${unit.name}\n目标：${unit.goal || '（未设）'}\n\n各课时要点汇总：\n${merged || '（暂无）'}\n\n请输出 markdown：核心方法 / 易错点 / 关联知识 / 自检清单 四部分，简洁。`
  const r = await invokeLlmInternal({ providerId, modelId, effort: 'off', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], sessionId: `course:${wsId}:${unitId}:summary` })
  const body = r.ok ? r.content.trim() : `（总结自动生成失败：${r.error}——可手动补写）`
  const wsFolder = workspaceFolderRel(wsId, getSetting)
  if (!wsFolder) return { ok: false, error: '工作区不存在' }
  const unitDir = unitFolderRel(wsId, unitId, getSetting) ?? wsFolder
  const rel = `${unitDir}/总结·${unit.name}.md`
  try {
    mkdirSync(dirname(join(vault.rootPath, rel)), { recursive: true })
    writeFileSync(join(vault.rootPath, rel), `# 总结 · ${unit.name}\n\n${body}\n`, 'utf-8')
    broadcast(BROADCAST_CHANNEL.aiTeachTreeRefresh, { dirRel: wsFolder })
  } catch (e) { return { ok: false, error: (e as Error).message } }
  const cur = s.units[unitId] ?? { status: 'todo' as CourseUnitStatus, mastery: 0, lastCheckedAt: null }
  // F2：收尾接自测得分 → mastery / status（无得分时保持原掌握度、判 mastered）
  const scTotal = score && score.total > 0 ? score.total : 0
  const mastery = scTotal > 0 ? Math.max(0, Math.min(1, (score?.correct ?? 0) / scTotal)) : cur.mastery
  const status: CourseUnitStatus = scTotal > 0 ? (mastery >= 0.8 ? 'mastered' : 'review') : 'mastered'
  s.units[unitId] = { ...cur, finished: true, summaryRel: rel, status, mastery, lastCheckedAt: new Date().toISOString() }
  persist(f)
  broadcastCourse(wsId)
  return { ok: true, summaryRel: rel }
}

// ===== 注入上下文（agentService 每轮调用）=====

export function buildCourseInjection(sessionId: string, getSetting: (key: string) => unknown): string {
  const wsId = getWorkspaceOfSession(sessionId)
  if (!wsId) return ''
  const f = readProgressFile()
  const s = wsState(f, wsId)
  // 课程助手会话（整门课一个）走「顾问」分支：无大纲也可用
  const isAssistant = !!s.assistantSessionId && sessionId === s.assistantSessionId
  // 章末复习课会话：走「复习」分支
  const reviewHit = findReviewBySession(sessionId)
  const outline = readCourseOutline(wsId, getSetting)
  const hasOutline = !!outline && outline.chapters.length > 0
  if (!hasOutline && !isAssistant) return ''
  const units = hasOutline ? outline!.chapters.flatMap((c) => c.units.map((u) => ({ ...u, chapter: c.name }))) : []
  const total = units.length
  const done = units.filter((u) => unitLearned(u.id, s.units, s.lessons)).length
  const lines: string[] = []
  if (isAssistant) {
    lines.push('【教学助手上下文（AI 教学 · 课程助手）】')
    lines.push(`课程：${outline?.title || '未命名'} · 目标：${outline?.goal || '未设定'}`)
    lines.push('你是这门课的**课程助手**：负责跟用户定学习目标、登记素材、生成/调整课程大纲、按章分配素材、整理与答疑。**不要**逐知识点开讲（开讲由用户在左栏点知识点、进入开段预检后触发），也不要出课时或快检卡。')
    if (hasOutline) {
      lines.push('课程大纲（章 → 知识点 · 学完状态）：')
      for (const c of outline!.chapters) {
        const learned = c.units.filter((u) => unitLearned(u.id, s.units, s.lessons)).length
        lines.push(`- [${c.id}] ${c.name}（已学 ${learned}/${c.units.length}）`)
        for (const u of c.units) {
          lines.push(`  · [${u.id}] ${u.name}（${unitLearned(u.id, s.units, s.lessons) ? '已学完' : '未学'}${u.source ? `，来源：${u.source}` : ''}）`)
        }
      }
      lines.push(`课程进度：已学完 ${done}/${total}`)
    } else {
      lines.push('（本工作区还没有课程大纲。按流程引导：先聊清学习目标、登记素材，条件够就询问用户"是否生成大纲"，确认后再生成为草稿。）')
    }
    lines.push('【素材登记摘要】')
    lines.push(assistantSourcesSummary(wsId, getSetting))
    lines.push('【建课流程与工具】① 素材先登记：用户给出文件/目录/URL 时用 course.sources.register 批量登记（外部文件会复制进本课 SOURCES；仓库内文件只引用）；② pdf/pptx 需要时用 course.sources.extract 提取页码区间；③ 用 inventory 清点目录素材（先清点再分章，别把整目录硬读进上下文）；④ 与用户定好目标、素材就绪后，生成**全量**大纲草稿（章 → 知识点；不要"先只给第一章"）；用户确认后调 course.outline.write 落盘；⑤ 用 course.sources.assign 把素材按章分配（能判断区间就带 anchor；判断不了就整章 whole）；⑥ 不主动开讲；只提醒用户去左栏点知识点开段，开段前会做素材预检；⑦ 删知识点用 course.outline.remove-unit（已学过的会被拒绝，需先用 course.organize.archive 整理归档）；⑧ 落盘只走这些工具，不要另造文件；改大纲前先与用户确认。')
    lines.push('【大纲落盘后的终止规则】课程大纲写入 / 更新成功后，建课流程即结束：不要讲授知识点，不要问用户是否「开讲第 N 章」，也不要邀请用户继续在课程助手会话里听讲。只输出下一步引导：去左栏点知识点开段（会先做素材预检）、继续改大纲、查看 / 分配素材；用户主动问课程内容时可以答疑，但仍不进入逐知识点开讲。')
    return '\n\n' + lines.join('\n')
  }
  // 复习课分支：章末复习（本章知识点串讲 + 查漏补缺，不引入新知识点）
  if (reviewHit && reviewHit.wsId === wsId) {
    const chapter = outline!.chapters.find((c) => c.id === reviewHit.chapterId)
    lines.push('【复习课上下文（AI教学 · 章末复习）】')
    lines.push(`课程：${outline!.title || '未命名'} · 目标：${outline!.goal || '未设定'}`)
    lines.push(`这是针对「${chapter?.name ?? '本章'}」的**章末复习课**：帮学生把本章已学知识点串成体系、查漏补缺，**不引入新知识点**。`)
    if (chapter) {
      lines.push('本章知识点（全部已学完才解锁复习）：')
      for (const u of chapter.units) {
        lines.push(`  · [${u.id}] ${u.name}（${unitLearned(u.id, s.units, s.lessons) ? '已学完' : '未学'}${u.goal ? `，目标：${u.goal}` : ''}）`)
      }
      const segs = chapterSegments(s.lessons, chapter.units.map((u) => u.id))
      const handoffs = segs.map((x) => x.lesson.handoffRel).filter((x): x is string => !!x)
      if (handoffs.length) {
        const vault = getCurrentVault()
        const parts: string[] = []
        for (const rel of handoffs.slice(-6)) {
          if (!vault) break
          try {
            const abs = join(vault.rootPath, rel)
            if (existsSync(abs)) parts.push(readFileSync(abs, 'utf-8').slice(0, 1600))
          } catch { /* 单个交接读取失败不阻断 */ }
        }
        if (parts.length) lines.push(`\n【本章各段交接（节选）】\n${parts.join('\n\n---\n\n').slice(0, 6000)}`)
      }
      const srcTitles = chapterSourceTitles(wsId, reviewHit.chapterId, getSetting)
      if (srcTitles.length) lines.push(`\n【本章素材（章级分配）】\n${srcTitles.map((t) => `- ${t}`).join('\n')}`)
    }
    lines.push('复习方式**由你和学生讨论决定**：可按学生要求逐块回顾、出题检验、或把零散点串成体系。**先问学生想怎么过**，别自顾自开讲。')
    lines.push('当复习讨论到一定阶段、结论成型时，**主动提议**「把本次复习整理成《复习讲义》落盘」，学生同意后调用 course.review.write 写入本章目录；写好后把落盘路径告诉学生。')
    return '\n\n' + lines.join('\n')
  }
  // 教师分支：必须有段；旧零散会话不再注入教学推进规则
  const curLesson = s.lessons[sessionId]
  if (!curLesson) return ''
  const ids = lessonUnitIds(curLesson)
  const unitRows = ids
    .map((uid) => units.find((u) => u.id === uid))
    .filter((u): u is (typeof units)[number] => !!u)
  const active = units.find((u) => u.id === (curLesson.activeUnitId || ids[0])) ?? unitRows[0] ?? null
  lines.push('【课程上下文（AI教学·段）】')
  lines.push(`课程：${outline!.title || '未命名'} · 目标：${outline!.goal || '未设定'}`)
  if (outline!.anchor) lines.push(`大纲依据：${outline!.anchor}（你是这门课的老师，请围绕大纲推进，不要脱离本段知识点自由发散）`)
  lines.push(`本段：第${curLesson.order}段（${curLesson.status === 'ended' ? '已收尾·只读' : '进行中'}）· 覆盖 ${ids.length} 个知识点`)
  for (const u of unitRows) {
    const mark = u.id === active?.id ? '【当前聚焦】' : ''
    lines.push(`- ${mark}[${u.id}] ${u.name}（出自「${u.chapter}」，来源：${u.source || '未标注'}）${u.goal ? ` · 目标：${u.goal}` : ''}`)
  }
  const handoff = readPrevHandoff(sessionId, getSetting)
  if (handoff) lines.push(`\n【上一段交接（同章）】\n${handoff}`)
  lines.push(`课程进度：已学完 ${done}/${total}`)
  const finishedUnits = units.filter((u) => unitLearned(u.id, s.units, s.lessons))
  if (finishedUnits.length) {
    lines.push(`\n【已完成知识点（可被引用/跳转）】\n` + finishedUnits.map((u) => `- ${u.name}`).join('\n'))
    lines.push('当学生想「回顾/回看」某个已完成知识点，或你判断学生对某已完成知识点完全没有掌握/印象时，**另起一行**输出：`跳转：<知识点名>`；系统会把它渲染成可点击的跳转按钮（一句最多一个）。')
  }
  lines.push('交接纪律：交接文档只由用户点右上角「收尾本段」时由系统生成。你不要在对话中提供「生成交接文档 / 写交接 / 整理交接 / 输出交接」这类选项，也不要自行创建 `交接.md` 或任何交接文件；本段讲完只需在正文里建议用户点「收尾本段」。')
  lines.push('教学纪律：本段只讲上面列出的知识点，按用户节奏推进；当前聚焦哪个就先讲哪个，讲完可问用户是否继续下一个或换焦点；不要跳到本章其他段，也不要一次把整门课讲完。讲完一个新概念可就地出一道快检（走 quiz 协议，一条回答最多一张）。本段素材范围见下一段【本段确认素材】，不要扫描 SOURCES 下未确认的文件。')
  return '\n\n' + lines.join('\n')
}

// ===== 素材注入（agentService 每轮调用）=====

/** 按角色返回素材注入串：助手=摘要；复习=章级；段=段快照；其他=空。 */
export function buildAiTeachSourcesHint(sessionId: string, getSetting: (key: string) => unknown): string {
  const wsId = getWorkspaceOfSession(sessionId)
  if (!wsId) return ''
  const f = readProgressFile()
  const s = wsState(f, wsId)
  if (s.assistantSessionId === sessionId) {
    return renderSourcesHint({ role: 'assistant', summary: assistantSourcesSummary(wsId, getSetting) })
  }
  const reviewHit = findReviewBySession(sessionId)
  if (reviewHit) {
    return renderSourcesHint({ role: 'review', chapterSources: chapterSourceTitles(wsId, reviewHit.chapterId, getSetting) })
  }
  const lesson = s.lessons[sessionId]
  if (!lesson) return ''
  const items = resolveSegmentSources(wsId, (lesson.sources ?? []) as unknown as SegmentSource[], getSetting)
  return renderSourcesHint({ role: 'segment', items })
}

// ===== 模型解析（defaultModel 用）=====

/** 解析要用的模型：显式 spec（`pid:mid`）→ 全局 defaultChatModel（由 invoke 侧兜底）→ 第一个启用供应商 */
function resolveOutlineModel(input: { modelSpec?: string }): { providerId?: string; modelId?: string; label: string } {
  const spec = String(input?.modelSpec ?? '').trim()
  const ci = spec.indexOf(':')
  let providerId = ci > 0 ? spec.slice(0, ci) : undefined
  let modelId = ci > 0 ? spec.slice(ci + 1) : (spec || undefined)
  if (!providerId && !modelId) {
    const fb = firstEnabledModelSpec()
    if (fb) { providerId = fb.providerId; modelId = fb.modelId }
  }
  return { providerId, modelId, label: providerId && modelId ? `${providerId}:${modelId}` : (modelId || '默认配置') }
}

// ===== L3 收尾测验：一次性出题 =====

export interface UnitQuizQuestion { q: string; options: string[]; answer: number; explanation: string }

/** 从模型返回里抽题目 JSON 数组（容错 ```json 围栏与前后杂字） */
export function parseQuizJson(text: string): UnitQuizQuestion[] | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(String(text ?? ''))
  const body = fence ? fence[1] : String(text ?? '')
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const arr = JSON.parse(body.slice(start, end + 1)) as unknown
    if (!Array.isArray(arr)) return null
    const out: UnitQuizQuestion[] = []
    for (const o of arr) {
      const oo = (o ?? {}) as { q?: unknown; options?: unknown; answer?: unknown; explanation?: unknown }
      const q = String(oo.q ?? '').trim()
      const options = Array.isArray(oo.options) ? oo.options.map((x) => String(x)) : []
      if (q && options.length >= 2) out.push({ q, options, answer: Number(oo.answer) || 0, explanation: String(oo.explanation ?? '') })
    }
    return out.length ? out : null
  } catch { return null }
}

/** 收尾前出一套单选题（依据本知识点各课时的学习记录） */
export async function makeUnitQuiz(wsId: string, unitId: string, getSetting: (key: string) => unknown): Promise<{ ok: boolean; questions?: UnitQuizQuestion[]; error?: string }> {
  const f = readProgressFile()
  const s = wsState(f, wsId)
  const outline = readCourseOutline(wsId, getSetting)
  const unit = outline?.chapters.flatMap((c) => c.units).find((u) => u.id === unitId)
  if (!unit) return { ok: false, error: '知识点不存在' }
  const arr = lessonsOf(s, unitId)
  const merged = arr.map((l) => transcriptOf(l.sid, 2500)).join('\n\n').slice(-10000)
  const { providerId, modelId } = defaultModel()
  const sys = '你是出题老师。根据给定知识点的学习记录，出 3 道单选题，只输出 JSON 数组，不要解释文字。'
  const user = `知识点：${unit.name}\n目标：${unit.goal || '（未设）'}\n学习记录：\n${merged || '（暂无）'}\n\n输出 JSON 数组，每项：{"q":"题干","options":["A项","B项","C项","D项"],"answer":0,"explanation":"解析"}（answer 是正确项的 0-based 下标）。只输出 JSON。`
  const r = await invokeLlmInternal({ providerId, modelId, effort: 'off', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], sessionId: `course:${wsId}:${unitId}:quiz` })
  if (!r.ok) return { ok: false, error: r.error }
  const q = parseQuizJson(r.content)
  if (!q) return { ok: false, error: '模型未返回可解析的题目 JSON' }
  return { ok: true, questions: q }
}

// ===== 大纲增补（只增补合并）：助手工具 course.outline.write(append=true) 的落盘口径 =====

/** 写入增补（只增补合并，保留现有 id/进度） */
export function applyOutlineAdditions(wsId: string, additions: OutlineAdditions, getSetting: (key: string) => unknown): { ok: boolean; added?: number; error?: string } {
  const outline = readCourseOutline(wsId, getSetting)
  if (!outline) return { ok: false, error: '该工作区还没有课程大纲' }
  const { outline: merged, added } = mergeOutlineAdditions(outline, additions ?? { toExisting: [], newChapters: [] })
  if (added === 0) return { ok: false, error: '没有可写入的增补（可能都是重复项）' }
  const w = writeCourseOutline(wsId, merged, getSetting)
  if (!w.ok) return { ok: false, error: w.error }
  return { ok: true, added }
}

// ===== 对话驱动建课（Phase 2）：教学助手通过工具调用的业务函数 =====
// 原则：助手只做编排；落盘一律走这里（复用 writeCourseOutline / 进度文件 / 素材函数），
// 不开 .knowbase 白名单，写工具仍受 requires:'write' 权限过滤。

export interface InventoryToolResult {
  ok: boolean
  relPath?: string
  sourceName?: string
  classification?: 'organized' | 'flat' | 'empty'
  totalFiles?: number
  totalChars?: number
  subdirs?: { name: string; fileCount: number; chars: number }[]
  pendingTranscribe?: { rel: string; ext: string }[]
  fingerprint?: string
  error?: string
}

/** 清点某工作区的登记素材（按名称或 `#编号`）→ 写 `SOURCES/{素材名}.index.md`，返回摘要。 */
export function inventoryWorkspaceSource(wsId: string, ref: unknown, getSetting: (key: string) => unknown): InventoryToolResult {
  const vault = getCurrentVault()
  if (!vault) return { ok: false, error: '尚未打开仓库' }
  const folder = workspaceFolderRel(String(wsId ?? ''), getSetting)
  if (!folder) return { ok: false, error: '工作区不存在' }
  const all = getSources(String(wsId ?? ''), getSetting).sources
  if (!all.length) return { ok: false, error: '本工作区还没有登记素材；先在素材库添加' }
  const raw = String(ref ?? '').trim()
  const e = all.find((x) => x.id === raw) ?? all.find((x) => x.title === raw) ?? all.find((x) => x.title.includes(raw))
  if (!e) return { ok: false, error: `找不到素材「${raw}」。现有：${all.map((x) => x.title).join('、')}` }
  if (e.type !== 'dir') return { ok: false, error: `「${e.title}」不是目录素材（${e.type}）。单个 pdf/pptx 请先提取为 md 再使用` }
  const dirAbs = e.rel ? join(vault.rootPath, e.rel) : ''
  if (!dirAbs) return { ok: false, error: `素材「${e.title}」未登记路径` }
  const w = writeInventoryIndex(join(vault.rootPath, folder), e.title, e.rel || '', dirAbs, todayLocal())
  if (!w.ok) return { ok: false, error: w.error }
  return {
    ok: true, relPath: w.relPath, sourceName: e.title,
    classification: w.scan?.classification, totalFiles: w.scan?.totalFiles, totalChars: w.scan?.totalChars,
    subdirs: w.scan?.subdirs, pendingTranscribe: w.scan?.pendingTranscribe, fingerprint: w.fingerprint,
  }
}

export interface OutlineDraft {
  title?: string
  goal?: string
  anchor?: string
  chapters?: { name?: string; units?: { name?: string; goal?: string; source?: string }[] }[]
  /** true=追加进现大纲（展开新章/补知识点）；缺省/false=首次生成（覆盖） */
  append?: boolean
}

/** 落盘成功后的唯一推荐下一步；作为工具结果回给模型，防止它接着问「开讲第 N 章」。 */
const OUTLINE_NEXT_STEP = '大纲已落盘。下一步只引导用户去左栏点知识点开段（会先做素材预检）；不要问是否开讲，也不要在课程助手会话里直接开讲。'

/** 助手写入/展开课程大纲：append=false 首次生成（覆盖）；append=true 按章名合并增补（保留既有 id/进度）。 */
export function writeOutlineFromAssistant(wsId: string, draft: OutlineDraft, getSetting: (key: string) => unknown): { ok: boolean; mode?: 'create' | 'append'; added?: number; chapters?: number; relPath?: string; nextStep?: string; error?: string } {
  const id = String(wsId ?? '')
  if (!id) return { ok: false, error: '缺少工作区' }
  if (!getCurrentVault()) return { ok: false, error: '尚未打开仓库' }
  const norm = normalizeOutline(draft) // { title, goal, anchor, chapters[with ids] }
  if (!norm) return { ok: false, error: '大纲为空或不合法（需含 chapters[].units[].name）' }
  const existing = readCourseOutline(id, getSetting)
  const hasExisting = !!existing && existing.chapters.length > 0 && draft?.append !== false
  if (!hasExisting) {
    const outline: CourseOutline = {
      title: norm.title || existing?.title || '',
      goal: norm.goal || existing?.goal || '',
      anchor: norm.anchor || existing?.anchor || '',
      chapters: norm.chapters,
    }
    const w = writeCourseOutline(id, outline, getSetting)
    return w.ok ? { ok: true, mode: 'create', chapters: outline.chapters.length, relPath: w.relPath, nextStep: OUTLINE_NEXT_STEP } : { ok: false, error: w.error }
  }
  // 增补：章名对齐现有章 → 追加其知识点；否则整章新增
  const additions: OutlineAdditions = { toExisting: [], newChapters: [] }
  for (const ch of norm.chapters) {
    const ex = existing!.chapters.find((c) => cleanField(c.name) === cleanField(ch.name))
    if (ex) for (const u of ch.units) additions.toExisting.push({ chapterId: ex.id, name: u.name, goal: u.goal, source: u.source })
    else additions.newChapters.push({ name: ch.name, units: ch.units.map((u) => ({ name: u.name, goal: u.goal, source: u.source })) })
  }
  const r = applyOutlineAdditions(id, additions, getSetting)
  // 落盘路径**两条分支都要给**：草稿卡的「打开课程」靠它跳编辑区打开 课程.md。
  // append 分支此前只回 added（2026-10-14 补）—— 否则「展开下一章」后落盘的卡拿不到路径。
  const rel = outlineRel(id, getSetting)?.rel
  return r.ok ? { ok: true, mode: 'append', added: r.added, relPath: rel, nextStep: OUTLINE_NEXT_STEP } : { ok: false, error: r.error }
}

/** 删除知识点：未学习(todo/无进度) 直接删；已学/学一半 → 拒绝并要求先「整理对话并归档」。 */
export function removeCourseUnit(wsId: string, ref: unknown, getSetting: (key: string) => unknown): { ok: boolean; removed?: string; needOrganize?: boolean; unitId?: string; unitName?: string; status?: string; error?: string } {
  const id = String(wsId ?? '')
  const outline = readCourseOutline(id, getSetting)
  if (!outline) return { ok: false, error: '该工作区还没有课程大纲' }
  const raw = String(ref ?? '').trim()
  let hit: { chapterId: string; unitId: string; name: string } | null = null
  for (const c of outline.chapters) for (const u of c.units) if (u.id === raw || u.name === raw) { hit = { chapterId: c.id, unitId: u.id, name: u.name }; break }
  if (!hit) return { ok: false, error: `找不到知识点「${raw}」` }
  const f = readProgressFile()
  const st = wsState(f, id)
  const status = st.units[hit.unitId]?.status ?? 'todo'
  if (status !== 'todo') {
    return { ok: false, needOrganize: true, unitId: hit.unitId, unitName: hit.name, status, error: `知识点「${hit.name}」已学习（${status}），直接删会丢学习记录：请先用「整理对话并归档」把这段对话存档，再删除` }
  }
  const next: CourseOutline = { ...outline, chapters: outline.chapters.map((c) => ({ ...c, units: c.units.filter((u) => u.id !== hit!.unitId) })) }
  const w = writeCourseOutline(id, next, getSetting)
  if (!w.ok) return { ok: false, error: w.error }
  delete st.units[hit.unitId]
  persist(f)
  broadcastCourse(id)
  return { ok: true, removed: hit.name }
}

/** 画布拖拽重排：把知识点移到目标章（可同章）的 beforeUnitId 之前；null=追加到章末。
 *  ★ 必须走这里而不是 writeOutlineDraft —— 后者按章重建、unit id 会按顺序重生成，
 *    progress.json 以 unit id 为键，重排即丢进度。本函数原位搬移、id 与进度都保留。 */
export function moveCourseUnit(wsId: string, unitId: string, targetChapterId: string, beforeUnitId: string | null, getSetting: (key: string) => unknown): { ok: boolean; error?: string } {
  const id = String(wsId ?? '')
  const outline = readCourseOutline(id, getSetting)
  if (!outline) return { ok: false, error: '该工作区还没有课程大纲' }
  const r = moveUnitInOutline(outline, unitId, targetChapterId, beforeUnitId)
  if (!r.ok) return { ok: false, error: r.error }
  if (r.outline === outline) return { ok: true } // 无操作（拖到自己前面）
  const w = writeCourseOutline(id, r.outline, getSetting)
  if (!w.ok) return { ok: false, error: w.error }
  return { ok: true }
}

/** 整理页归档：写入 target（仓库相对目录）或默认会话 output/；返回相对路径与**绝对路径**。 */
export function archiveOrganizedPage(sessionId: string, title: unknown, content: unknown, target: unknown, getSetting: (key: string) => unknown): { ok: boolean; relPath?: string; absPath?: string; error?: string } {
  const vault = getCurrentVault()
  if (!vault) return { ok: false, error: '尚未打开仓库' }
  if (isHandoffTitle(title)) return { ok: false, error: '交接由「收尾本段」统一生成，不能用整理归档创建。' }
  let rel = String(target ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!rel) { const owner = resolveWriteOwnerRel(String(sessionId ?? ''), getSetting); if (!owner) return { ok: false, error: '无法确定归档目录' }; rel = owner }
  if (rel.split('/').some((s) => s.startsWith('.'))) return { ok: false, error: '归档目录非法（不能写入隐藏/点目录）' }
  try {
    const dirAbs = join(vault.rootPath, rel)
    mkdirSync(dirAbs, { recursive: true })
    const base = sanitizeTitle(String(title ?? '整理'))
    const fname = uniqueFileName(dirAbs, base.endsWith('.md') ? base : `${base}.md`)
    // 题单落盘即写 frontmatter id（同 organizeDoc；非 quiz 文档原样返回）
    const body = ensureQuizDocFrontmatter(String(title ?? '整理'), String(content ?? '').replace(/\r\n/g, '\n'))
    writeFileSync(join(dirAbs, fname), body, 'utf-8')
    broadcast(BROADCAST_CHANNEL.aiTeachTreeRefresh, { dirRel: rel })
    return { ok: true, relPath: `${rel}/${fname}`, absPath: join(dirAbs, fname) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ===== IPC 注册 =====

export function registerAiTeachingCourseHandlers(getSetting: (key: string) => unknown): void {
  ipcMain.handle('aiTeachCourse:getState', (_e, wsId: string) => getCourseState(String(wsId ?? ''), getSetting))
  ipcMain.handle('aiTeachCourse:setEnabled', (_e, wsId: string, enabled: boolean) => setCourseEnabled(String(wsId ?? ''), !!enabled))
  // 对话驱动建课：草稿卡「正式生成」→ 助手同款写入口径（append 增补 / 首次覆盖）
  ipcMain.handle('aiTeachCourse:writeOutlineDraft', (_e, wsId: string, draft: OutlineDraft) =>
    writeOutlineFromAssistant(String(wsId ?? ''), draft ?? {}, getSetting))
  // 对话驱动建课：删知识点（已学的会被拒绝，需先整理归档）——与助手工具同口径
  ipcMain.handle('aiTeachCourse:removeUnit', (_e, wsId: string, unit: string) =>
    removeCourseUnit(String(wsId ?? ''), unit, getSetting))
  // 画布拖拽重排：跨章/同章搬移知识点（保留 id 与进度）
  ipcMain.handle('aiTeachCourse:moveUnit', (_e, wsId: string, unitId: string, targetChapterId: string, beforeUnitId: string | null) =>
    moveCourseUnit(String(wsId ?? ''), unitId, targetChapterId, beforeUnitId ?? null, getSetting))
  ipcMain.handle('aiTeachCourse:setUnitProgress', (_e, wsId: string, unitId: string, patch: Partial<CourseUnitProgress>) =>
    setUnitProgress(String(wsId ?? ''), String(unitId ?? ''), patch ?? {}))
  // L2 段（3.14 新口径）
  ipcMain.handle('aiTeachCourse:openSegment', (_e, wsId: string, unitIds: string[], sources: SegmentSource[]) =>
    openSegment(String(wsId ?? ''), unitIds ?? [], sources ?? [], getSetting))
  ipcMain.handle('aiTeachCourse:setActiveUnit', (_e, sessionId: string, unitId: string) =>
    setActiveUnit(String(sessionId ?? ''), String(unitId ?? '')))
  ipcMain.handle('aiTeachCourse:endSegment', (_e, sessionId: string) => endSegment(String(sessionId ?? '')))
  ipcMain.handle('aiTeachCourse:finalizeSegment', (_e, sessionId: string) => finalizeSegment(String(sessionId ?? ''), getSetting))
  // L2 兼容（旧 UI / 旧会话）
  ipcMain.handle('aiTeachCourse:openUnit', (_e, wsId: string, unitId: string, kind?: string) =>
    openUnit(String(wsId ?? ''), String(unitId ?? ''), kind, getSetting))
  ipcMain.handle('aiTeachCourse:endLesson', (_e, sessionId: string) => endLesson(String(sessionId ?? '')))
  ipcMain.handle('aiTeachCourse:finalizeLesson', (_e, sessionId: string) => finalizeLesson(String(sessionId ?? ''), getSetting))
  // L3 收尾
  ipcMain.handle('aiTeachCourse:finishUnit', (_e, wsId: string, unitId: string, score?: { correct: number; total: number }) => finishUnit(String(wsId ?? ''), String(unitId ?? ''), getSetting, score))
  // 上节交接（界面条）：读本会话所属知识点的上一节 交接.md
  ipcMain.handle('aiTeachCourse:readPrevHandoff', (_e, sessionId: string) => ({ ok: true, text: readPrevHandoff(String(sessionId ?? ''), getSetting) }))
  // L3 收尾测验：一次性出题
  ipcMain.handle('aiTeachCourse:makeUnitQuiz', (_e, wsId: string, unitId: string) => makeUnitQuiz(String(wsId ?? ''), String(unitId ?? ''), getSetting))
  // 课程助手（整门课唯一会话；无大纲也可用）
  ipcMain.handle('aiTeachCourse:openAssistant', (_e, wsId: string) => openCourseAssistant(String(wsId ?? ''), getSetting))
  // 章末复习课（每章一个，懒建）
  ipcMain.handle('aiTeachCourse:openChapterReview', (_e, wsId: string, chapterId: string) =>
    openChapterReview(String(wsId ?? ''), String(chapterId ?? ''), getSetting))
}
