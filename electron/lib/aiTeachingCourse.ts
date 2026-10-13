import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'fs'
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
import {
  parseCourseMd,
  rewriteCourseMd,
  normalizeOutline,
  cleanField,
  sourceSnapshot,
  mergeOutlineAdditions,
  type CourseOutline,
  type CourseUnitProgress,
  type CourseUnitStatus,
  type OutlineAdditions,
  type SourceSnapshotEntry,
} from './aiTeachingCoursePure'
import { readWorkspaceSourceEntries, type SourceEntry } from './aiTeachingSources'

/**
 * AI教学 · 课程模式（docs/ai-teaching-course-mode-plan.md）
 *
 * - 课程模式 = 工作区可选开启；开启后该工作区多一条「学习主线」；
 * - 大纲 = 工作区文件夹内 `课程.md`（**人读人改的唯一真相源**，程序按固定行格式解析/重写）；
 *   行格式与纯函数 parseCourseMd / rewriteCourseMd 见 `aiTeachingCoursePure.ts`（供契约脚本 import）；
 * - 进度 = `.knowbase/modules/aiTeaching/progress.json`（机器维护，与 workspaces.json 同目录）：
 *     { v:1, workspaces:{ [wsId]: { enabled, sessions:{ sessionId->unitId }, units:{ unitId->{status,mastery,lastCheckedAt} } } } }
 * - 知识点与会话解耦：掌握度挂知识点；会话只记「当前在学哪个知识点」。
 * - 大纲可演进：AI 只提议，用户确认才写入（唯一写入口径 writeCourseOutline）。
 */

export { parseCourseMd, rewriteCourseMd, parseOutlineJson } from './aiTeachingCoursePure'
export type { CourseChapter, CourseOutline, CourseUnit, CourseUnitProgress, CourseUnitStatus } from './aiTeachingCoursePure'

/** 一节课（课时）：一条会话 + 一个产物夹，挂在某知识点下，线性推进 */
export interface LessonInfo {
  unitId: string
  /** 在该知识点内的顺序（1..N） */
  order: number
  /** 类型：精讲 / 习题 / 复习 / 测验 / 答疑 … */
  kind: string
  /** open=进行中（可续） / ended=已结束（只读） */
  status: 'open' | 'ended'
}

/** 章末复习课（每章一个；会话懒建，内容由与课程助手讨论得出） */
export interface ChapterReview {
  sessionId: string
  /** 复习讲义仓库相对路径（未生成为 null） */
  rel: string | null
}

export interface CourseState {
  enabled: boolean
  outline: CourseOutline | null
  progress: Record<string, CourseUnitProgress>
  lessons: Record<string, LessonInfo>
  /** 章末复习课：chapterId → 会话 id + 复习讲义相对路径 */
  reviews: Record<string, ChapterReview>
}

interface WsCourseState {
  enabled: boolean
  /** sessionId → 课时信息（新形状） */
  lessons: Record<string, LessonInfo>
  units: Record<string, CourseUnitProgress>
  /** 旧形状（sessionId → unitId）：仅读兼容，读到后迁移进 lessons */
  sessions?: Record<string, string>
  /** 上次写大纲时的 SOURCE.md 条目快照（课程修订算「素材变更」用；机器维护） */
  sourceBaseline?: SourceSnapshotEntry[]
  /** 课程助手会话 id（整门课唯一，懒建；不写入 lessons，故不计课时/进度） */
  assistantSessionId?: string
  /** 章末复习课：chapterId → 会话 id + 复习讲义相对路径（懒建；不写入 lessons，故不计课时/进度） */
  reviews?: Record<string, ChapterReview>
}

interface ProgressFile {
  v: 1
  workspaces: Record<string, WsCourseState>
}

const KEY = 'progress.json'
const MODULE = 'modules/aiTeaching'
const OUTLINE_FILE = '课程.md'
const STATUSES: CourseUnitStatus[] = ['todo', 'learning', 'check', 'mastered', 'review']

const DEFAULT_KIND = '精讲'

function statusLabel(s: CourseUnitStatus | undefined): string {
  switch (s) {
    case 'learning': return '学习中'
    case 'check': return '待检验'
    case 'mastered': return '已掌握'
    case 'review': return '待复习'
    default: return '未开始'
  }
}

// ===== 进度文件读写 =====

function readProgressFile(): ProgressFile {
  const f = readJson<ProgressFile>(MODULE, KEY, { v: 1, workspaces: {} })
  if (!f.workspaces || typeof f.workspaces !== 'object') f.workspaces = {}
  return f
}

function persist(f: ProgressFile): void {
  writeJson(MODULE, KEY, f)
}

function wsState(f: ProgressFile, wsId: string): WsCourseState {
  if (!f.workspaces[wsId]) f.workspaces[wsId] = { enabled: false, lessons: {}, units: {} }
  const s = f.workspaces[wsId]
  if (!s.units || typeof s.units !== 'object') s.units = {}
  if (!s.lessons || typeof s.lessons !== 'object') {
    s.lessons = {}
    // 旧形状迁移：sessions(sessionId→unitId) → lessons（order 按出现次序；status 保守置 open）
    if (s.sessions && typeof s.sessions === 'object') {
      const perUnit: Record<string, number> = {}
      for (const [sid, uid] of Object.entries(s.sessions)) {
        const n = (perUnit[uid] = (perUnit[uid] ?? 0) + 1)
        s.lessons[sid] = { unitId: uid, order: n, kind: DEFAULT_KIND, status: 'open' }
      }
    }
  }
  delete s.sessions
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

/** 该工作区主库（SOURCE.md）的素材条目（课程修订 / 快照用；不依赖会话） */
function wsSources(wsId: string, getSetting: (key: string) => unknown): SourceEntry[] {
  const vault = getCurrentVault()
  if (!vault) return []
  const folder = workspaceFolderRel(wsId, getSetting)
  if (!folder) return []
  return readWorkspaceSourceEntries(folder, vault.rootPath)
}

/** 写大纲成功后刷新 SOURCE 快照（机器维护，失败不阻断）。
 *  ★ 当前**只写不读** —— 比对「素材变更」的唯一读者是 2026-10-11 删除的「修订大纲」抽屉；
 *  保留快照是为将来做「素材变更提醒」时不必重建。 */
function refreshSourceBaseline(wsId: string, getSetting: (key: string) => unknown): void {
  try {
    const f = readProgressFile()
    wsState(f, wsId).sourceBaseline = sourceSnapshot(wsSources(wsId, getSetting))
    persist(f)
  } catch { /* 快照失败不阻断大纲保存 */ }
}

export function writeCourseOutline(wsId: string, outline: CourseOutline, getSetting: (key: string) => unknown): { ok: boolean; relPath?: string; error?: string } {
  const vault = getCurrentVault()
  const loc = outlineRel(wsId, getSetting)
  if (!vault || !loc) return { ok: false, error: '尚未打开仓库或工作区不存在' }
  try {
    const abs = join(vault.rootPath, loc.rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, rewriteCourseMd(outline), 'utf-8')
    migrateUnitFolderPrefixes(wsId, getSetting) // F4：章号/章名变更 → 同步重命名知识点夹
    refreshSourceBaseline(wsId, getSetting) // 刷新素材快照（当前只写不读，见该函数头注）
    broadcast(BROADCAST_CHANNEL.aiTeachTreeRefresh, { dirRel: loc.dirRel.replace(/\\/g, '/') })
    broadcastCourse(wsId)
    return { ok: true, relPath: loc.rel }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ===== 课程状态 API =====

export function getCourseState(wsId: string, getSetting: (key: string) => unknown): CourseState {
  const f = readProgressFile()
  const s = wsState(f, wsId)
  return {
    enabled: !!s.enabled,
    outline: readCourseOutline(wsId, getSetting),
    progress: s.units,
    lessons: s.lessons,
    reviews: s.reviews ?? {},
  }
}

export function setCourseEnabled(wsId: string, enabled: boolean): { ok: boolean; error?: string } {
  const f = readProgressFile()
  wsState(f, wsId).enabled = !!enabled
  persist(f)
  broadcastCourse(wsId)
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

// ===== 课时（L2）：打开即续课 / 结束 / 交接 =====

function lessonsOf(s: WsCourseState, unitId: string): Array<{ sid: string; info: LessonInfo }> {
  return Object.entries(s.lessons)
    .filter(([, l]) => l.unitId === unitId)
    .map(([sid, info]) => ({ sid, info }))
    .sort((a, b) => a.info.order - b.info.order)
}

function nextLessonOrder(s: WsCourseState, unitId: string): number {
  const arr = lessonsOf(s, unitId)
  return arr.length ? arr[arr.length - 1].info.order + 1 : 1
}

export interface LessonOpenResult {
  ok: boolean
  sessionId?: string
  order?: number
  kind?: string
  status?: 'open' | 'ended'
  readonly?: boolean
  error?: string
}

/** 打开知识点：无课时→建课时1；最后一节进行中→续上；已结束→建下一节。 */
export function openUnit(wsId: string, unitId: string, kind: string | undefined, getSetting: (key: string) => unknown): LessonOpenResult {
  if (!getCurrentVault()) return { ok: false, error: '尚未打开仓库' }
  const f = readProgressFile()
  const s = wsState(f, wsId)
  const arr = lessonsOf(s, unitId)
  const last = arr[arr.length - 1]
  if (last && last.info.status === 'open') {
    return { ok: true, sessionId: last.sid, order: last.info.order, kind: last.info.kind, status: 'open', readonly: false }
  }
  const order = nextLessonOrder(s, unitId)
  const k = (kind && String(kind).trim()) || DEFAULT_KIND
  const row = createAgentSession(`课时${order}·${k}`, 'aiTeaching')
  assignSession(row.id, wsId)
  // 懒创建：不在开课时就建夹（空课时不建夹；真产生文件时由 writeFolderFile/ensureSessionFolder 建）
  s.lessons[row.id] = { unitId, order, kind: k, status: 'open' }
  // F7：该知识点此前若已收尾，再开课时自动回炉（重置 finished / 状态）
  const up = s.units[unitId]
  if (up?.finished) { s.units[unitId] = { ...up, finished: false, status: 'learning' } }
  persist(f)
  broadcastCourse(wsId)
  return { ok: true, sessionId: row.id, order, kind: k, status: 'open', readonly: false }
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
  const f = readProgressFile()
  const s = wsState(f, id)
  if (!s.reviews) s.reviews = {}
  const existing = s.reviews[cid]
  if (existing?.sessionId && sessionExists(existing.sessionId)) return { ok: true, sessionId: existing.sessionId }
  const row = createAgentSession(`复习课·${chapter.name}`, 'aiTeaching')
  assignSession(row.id, id)
  s.reviews[cid] = { sessionId: row.id, rel: existing?.rel ?? null }
  persist(f)
  broadcastCourse(id)
  return { ok: true, sessionId: row.id }
}

/** 章级文件夹相对路径 `{工作区}/{章号}·{章名}`（复习讲义落点） */
export function chapterFolderRel(wsId: string, chapterId: string, getSetting: (key: string) => unknown): string | null {
  const wsFolder = workspaceFolderRel(wsId, getSetting)
  if (!wsFolder) return null
  const outline = readCourseOutline(wsId, getSetting)
  const safe = (t: string) => String(t).replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || '未命名'
  let no = 1
  let name = '复习'
  ;(outline?.chapters ?? []).forEach((c, ci) => { if (c.id === chapterId) { no = ci + 1; name = c.name } })
  return `${wsFolder}/${no}·${safe(name)}`
}

/** 写「复习讲义」到本章目录并记录 rel（会话须是复习课会话）。返回相对/绝对路径。 */
export function writeChapterReviewDoc(sessionId: string, content: unknown, getSetting: (key: string) => unknown): { ok: boolean; relPath?: string; absPath?: string; error?: string } {
  const vault = getCurrentVault()
  if (!vault) return { ok: false, error: '尚未打开仓库' }
  const hit = findReviewBySession(String(sessionId ?? ''))
  if (!hit) return { ok: false, error: '仅可在复习课会话中生成复习讲义' }
  const dirRel = chapterFolderRel(hit.wsId, hit.chapterId, getSetting)
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

/** 结束课时：本节冻结（只读） */
export function endLesson(sessionId: string): { ok: boolean; wsId?: string; unitId?: string; error?: string } {
  const wsId = getWorkspaceOfSession(sessionId)
  if (!wsId) return { ok: false, error: '会话未归属工作区' }
  const f = readProgressFile()
  const s = wsState(f, wsId)
  const l = s.lessons[sessionId]
  if (!l) return { ok: false, error: '该会话不是一节课' }
  l.status = 'ended'
  persist(f)
  broadcastCourse(wsId)
  return { ok: true, wsId, unitId: l.unitId }
}

/** 取本会话的上一节交接内容（无则空串） */
export function readPrevHandoff(sessionId: string, getSetting: (key: string) => unknown): string {
  const wsId = getWorkspaceOfSession(sessionId)
  if (!wsId) return ''
  const f = readProgressFile()
  const s = wsState(f, wsId) // 迁移兼容 + 保证 lessons 结构存在
  const cur = s.lessons?.[sessionId]
  if (!cur) return ''
  const arr = lessonsOf(s, cur.unitId)
  const prev = arr.filter((l) => l.info.order < cur.order).pop()
  if (!prev) return ''
  const vault = getCurrentVault()
  if (!vault) return ''
  const folder = sessionFolder(prev.sid, getSetting)
  if (!folder.ok || !folder.relPath) return ''
  const abs = join(vault.rootPath, folder.relPath, '交接.md')
  if (!existsSync(abs)) return ''
  try { return readFileSync(abs, 'utf-8').slice(0, 4000) } catch { return '' }
}

function defaultModel(): { providerId?: string; modelId?: string } {
  return resolveOutlineModel({})
}

/** L1：本课时的物理文件夹相对路径 `{工作区}/{章号}·{知识点}/课时N·类型`；非课时返回 null */
function lessonFolderRel(sessionId: string, getSetting: (key: string) => unknown): string | null {
  const wsId = getWorkspaceOfSession(sessionId)
  if (!wsId) return null
  const wsFolder = workspaceFolderRel(wsId, getSetting)
  if (!wsFolder) return null
  const f = readProgressFile()
  const st = wsState(f, wsId)
  // 章末复习课会话：落章级文件夹 {工作区}/{章号}·{章名}（无 课时N 子夹）
  const revChapter = Object.entries(st.reviews ?? {}).find(([, r]) => r?.sessionId === sessionId)?.[0]
  if (revChapter) return chapterFolderRel(wsId, revChapter, getSetting)
  const l = st.lessons[sessionId]
  if (!l) return null
  const outline = readCourseOutline(wsId, getSetting)
  let chapterNo = 1
  let unitName = '知识点'
  const chapters = outline?.chapters ?? []
  chapters.forEach((c, ci) => { for (const u of c.units) if (u.id === l.unitId) { chapterNo = ci + 1; unitName = u.name } })
  const safe = (t: string) => String(t).replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || '未命名'
  return `${wsFolder}/${chapterNo}·${safe(unitName)}/课时${l.order}·${safe(l.kind)}`
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

/** L5：会话所属知识点的文件夹相对路径 `{工作区}/{章号}·{知识点}`（画像第三层落点）；非课时返回 null */
export function getSessionUnitFolderRel(sessionId: string, getSetting: (key: string) => unknown): string | null {
  if (findReviewBySession(sessionId)) return null // 复习课无「所属知识点」层
  const rel = lessonFolderRel(sessionId, getSetting)
  return rel ? rel.slice(0, rel.lastIndexOf('/')) : null
}

/** L1/L3：知识点文件夹相对路径 `{工作区}/{章号}·{知识点}`（总结篇落点，F1 修正） */
export function unitFolderRel(wsId: string, unitId: string, getSetting: (key: string) => unknown): string | null {
  const wsFolder = workspaceFolderRel(wsId, getSetting)
  if (!wsFolder) return null
  const outline = readCourseOutline(wsId, getSetting)
  let chapterNo = 1
  let unitName = '知识点'
  ;(outline?.chapters ?? []).forEach((c, ci) => { for (const u of c.units) if (u.id === unitId) { chapterNo = ci + 1; unitName = u.name } })
  const safe = (t: string) => String(t).replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || '未命名'
  return `${wsFolder}/${chapterNo}·${safe(unitName)}`
}

/** F4：大纲保存后，把已有知识点夹 `{旧章号}·{知识点}` 迁移成新的 `{新章号}·{知识点}`（章名/章序变更时） */
function migrateUnitFolderPrefixes(wsId: string, getSetting: (key: string) => unknown): void {
  try {
    const vault = getCurrentVault()
    if (!vault) return
    const wsFolder = workspaceFolderRel(wsId, getSetting)
    if (!wsFolder) return
    const outline = readCourseOutline(wsId, getSetting)
    if (!outline) return
    const safe = (t: string) => String(t).replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || '未命名'
    const desired = new Map<string, string>() // safeUnitName -> `${章号}·${safeUnitName}`
    outline.chapters.forEach((c, ci) => { for (const u of c.units) desired.set(safe(u.name), `${ci + 1}·${safe(u.name)}`) })
    const rootAbs = join(vault.rootPath, wsFolder)
    if (!existsSync(rootAbs)) return
    let entries: import('fs').Dirent[]
    try { entries = readdirSync(rootAbs, { withFileTypes: true }) } catch { return }
    let changed = false
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const m = /^(\d+)·(.+)$/.exec(e.name)
      if (!m) continue
      const want = desired.get(m[2].trim())
      if (!want || want === e.name) continue
      if (existsSync(join(rootAbs, want))) continue
      try {
        renameWorkspacePath(vault.rootId, `${wsFolder}/${e.name}`, `${wsFolder}/${want}`)
        const so = `${wsFolder}/SOURCES/${e.name}`
        const sn = `${wsFolder}/SOURCES/${want}`
        if (existsSync(join(vault.rootPath, so)) && !existsSync(join(vault.rootPath, sn))) {
          try { renameSync(join(vault.rootPath, so), join(vault.rootPath, sn)) } catch { /* 素材夹同步失败不阻断 */ }
        }
        changed = true
      } catch { /* 单夹改名失败不阻断大纲保存 */ }
    }
    if (changed) broadcast(BROADCAST_CHANNEL.aiTeachTreeRefresh, { dirRel: wsFolder })
  } catch { /* 迁移失败不阻断大纲保存 */ }
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

/** 结束课时后：生成 交接.md（固定四段）落本课时夹 */
export async function finalizeLesson(sessionId: string, getSetting: (key: string) => unknown): Promise<{ ok: boolean; relPath?: string; error?: string; skipped?: boolean }> {
  const wsId = getWorkspaceOfSession(sessionId)
  if (!wsId) return { ok: false, error: '会话未归属工作区' }
  // F6：空课时（零消息）不生成占位交接
  const msgs = getAgentMessages(sessionId).filter((m) => m.role === 'user' || m.role === 'assistant')
  if (msgs.length === 0) return { ok: true, skipped: true }
  const { providerId, modelId } = defaultModel()
  const sys = '你是助教。根据这一节课的对话，写一份交给下一节课的「交接」。只输出四段 markdown，简体中文，简洁具体。'
  const user = `本课对话记录：\n${transcriptOf(sessionId) || '（本节没有对话）'}\n\n请严格按下面四段输出：\n- 本节要点：…\n- 掌握情况：…（哪里会了、哪里卡）\n- 遗留问题：…（没讲完/没搞懂的）\n- 下节建议：…（从哪继续、练什么）`
  const r = await invokeLlmInternal({ providerId, modelId, effort: 'off', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], sessionId })
  const body = r.ok ? r.content.trim() : `（交接自动生成失败：${r.error}——可手动补写）`
  const title = getAgentSession(sessionId)?.title ?? '本课'
  return writeFolderFile(sessionId, '交接.md', `# 交接 · ${title}\n\n${body}\n`, getSetting)
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
  const merged = arr.map((l) => `— ${l.info.kind}（课时${l.info.order}）—\n${transcriptOf(l.sid, 2500)}`).join('\n\n').slice(-12000)
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
  if (!s.enabled) return ''
  // 课程助手会话（整门课一个）走「顾问」分支：**无大纲也可用**（冷启动即可聊规划/整理素材）
  const isAssistant = !!s.assistantSessionId && sessionId === s.assistantSessionId
  // 章末复习课会话：走「复习」分支（本章知识点 + 掌握度 + 复习人设）
  const reviewHit = findReviewBySession(sessionId)
  const outline = readCourseOutline(wsId, getSetting)
  const hasOutline = !!outline && outline.chapters.length > 0
  if (!hasOutline && !isAssistant) return ''
  const units = hasOutline ? outline!.chapters.flatMap((c) => c.units.map((u) => ({ ...u, chapter: c.name }))) : []
  const total = units.length
  const done = units.filter((u) => s.units[u.id]?.status === 'mastered').length
  const lines: string[] = []
  if (isAssistant) {
    lines.push('【教学助手上下文（AI 教学 · 对话驱动建课）】')
    lines.push(`课程：${outline?.title || '未命名'} · 目标：${outline?.goal || '未设定'}`)
    lines.push('你是这门课的**教学助手**：负责跟用户定学习目标、清点与分章素材、生成/展开课程大纲、整理与答疑。**不要**逐知识点开讲（那是上课时的事），也不要出课时或快检卡。')
    if (hasOutline) {
      lines.push('课程大纲（章 → 知识点 · 掌握度/状态）：')
      for (const c of outline!.chapters) {
        lines.push(`- ${c.name}`)
        for (const u of c.units) {
          const p = s.units[u.id]
          lines.push(`  · ${u.name}（${statusLabel(p?.status)}，掌握度 ${Math.round((p?.mastery ?? 0) * 100)}%${u.source ? `，来源：${u.source}` : ''}）`)
        }
      }
      lines.push(`课程进度：已掌握 ${done}/${total}`)
      const review = units.filter((u) => s.units[u.id]?.status === 'review')
      if (review.length) lines.push(`待复习（薄弱）：${review.map((u) => u.name).join('、')}`)
    } else {
      lines.push('（本工作区还没有课程大纲。按流程引导：先聊清学习目标、清点素材，条件够就询问用户"是否生成大纲"，确认后再生成为草稿。）')
    }
    lines.push('【建课流程与工具】① 素材里若有 pdf/pptx，先提醒用户把它们转写成 md（可在素材库对该素材做「提取稿」），确认后再继续；② 用 inventory 清点目录素材（**先清点再分章**，别把整个目录硬读进上下文）；③ 与用户定好目标、素材就绪后，问「是否生成大纲」；④ 生成的大纲**先作为对话里的草稿给用户看**，用户满意后才调 course.outline.write 落盘（**分批**：先只给第一章，用户学完再说「展开下一章」用 append=true 追加）；⑤ 删知识点用 course.outline.remove-unit（已学过的会被拒绝，需先用 course.organize.archive 整理归档、给用户看后再删）；⑥ course.organize.archive 的归档位置默认会话 output/，也可由用户/你指定目录，归档后必须把**绝对路径**告诉用户。落盘只走这些工具，不要另造文件；改大纲前先与用户确认。')
    return '\n\n' + lines.join('\n')
  }
  // 复习课分支：章末复习（本章知识点串讲 + 查漏补缺，不引入新知识点）
  if (reviewHit && reviewHit.wsId === wsId) {
    const chapter = outline!.chapters.find((c) => c.id === reviewHit.chapterId)
    lines.push('【复习课上下文（AI教学 · 章末复习）】')
    lines.push(`课程：${outline!.title || '未命名'} · 目标：${outline!.goal || '未设定'}`)
    lines.push(`这是针对「${chapter?.name ?? '本章'}」的**章末复习课**：帮学生把本章已学知识点串成体系、查漏补缺，**不引入新知识点**。`)
    if (chapter) {
      lines.push('本章知识点（含掌握度/状态）：')
      for (const u of chapter.units) {
        const p = s.units[u.id]
        lines.push(`  · ${u.name}（${statusLabel(p?.status)}，掌握度 ${Math.round((p?.mastery ?? 0) * 100)}%${u.goal ? `，目标：${u.goal}` : ''}）`)
      }
      const weak = chapter.units.filter((u) => s.units[u.id]?.status === 'review')
      if (weak.length) lines.push(`本章薄弱（待复习）：${weak.map((u) => u.name).join('、')}`)
    }
    lines.push('复习方式**由你和学生讨论决定**：可按学生要求逐块回顾、出题检验、或把零散点串成体系。**先问学生想怎么过**，别自顾自开讲。')
    lines.push('当复习讨论到一定阶段、结论成型时，**主动提议**「把本次复习整理成《复习讲义》落盘」，学生同意后调用 course.review.write 写入本章目录；写好后把落盘路径告诉学生。')
    return '\n\n' + lines.join('\n')
  }
  // 教师分支（上课 / 课时）：仅当有大纲（上面已挡）
  const curLesson = s.lessons[sessionId]
  const cur = curLesson ? units.find((u) => u.id === curLesson.unitId) ?? null : null
  lines.push('【课程上下文（AI教学·课程模式）】')
  lines.push(`课程：${outline!.title || '未命名'} · 目标：${outline!.goal || '未设定'}`)
  if (outline!.anchor) lines.push(`大纲依据：${outline!.anchor}（你是这门课的老师，请围绕大纲推进，不要脱离知识点自由发散）`)
  if (cur) {
    const p = s.units[cur.id]
    lines.push(`当前知识点：${cur.name}（出自「${cur.chapter}」，来源：${cur.source || '未标注'}，掌握度 ${Math.round((p?.mastery ?? 0) * 100)}%，状态：${statusLabel(p?.status)}）`)
    if (cur.goal) lines.push(`本知识点目标：${cur.goal}`)
    if (curLesson) lines.push(`当前课时：课时${curLesson.order}·${curLesson.kind}（${curLesson.status === 'ended' ? '已结束·只读' : '进行中'}）`)
    const handoff = readPrevHandoff(sessionId, getSetting)
    if (handoff) lines.push(`\n【上一节交接（本知识点内）】\n${handoff}`)
  }
  lines.push(`课程进度：已掌握 ${done}/${total}`)
  const review = units.filter((u) => s.units[u.id]?.status === 'review')
  if (review.length) lines.push(`待复习（薄弱）：${review.map((u) => u.name).join('、')}`)
  // 引用网络（L4）：已完成知识点目录 + 跳转协议
  const finishedUnits = units.filter((u) => s.units[u.id]?.finished)
  if (finishedUnits.length) {
    lines.push(`\n【已完成知识点（可被引用/跳转）】\n` + finishedUnits.map((u) => `- ${u.name}`).join('\n'))
    lines.push('当学生想「回顾/回看」某个已完成知识点，或你判断学生对某已完成知识点完全没有掌握/印象时，**另起一行**输出：`跳转：<知识点名>`；系统会把它渲染成可点击的跳转按钮（一句最多一个）。')
  }
  lines.push('教学纪律：每轮围绕当前知识点组织讲解；讲完一个新概念可就地出一道快检（走 quiz 协议，一条回答最多一张）；不要一次性把整门课讲完，按知识点推进。')
  return '\n\n' + lines.join('\n')
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
  const all = wsSources(String(wsId ?? ''), getSetting)
  if (!all.length) return { ok: false, error: '本工作区还没有登记素材；先在素材库添加' }
  const raw = String(ref ?? '').trim()
  const no = /^#?(\d+)$/.exec(raw)?.[1]
  const e = no ? all.find((x) => x.no === Number(no)) : all.find((x) => x.name === raw) ?? all.find((x) => x.name.includes(raw))
  if (!e) return { ok: false, error: `找不到素材「${raw}」。现有：${all.map((x) => `#${x.no} ${x.name}`).join('、')}` }
  if (e.type !== 'dir') return { ok: false, error: `「${e.name}」不是目录素材（${e.type}）。单个 pdf/pptx 请先转写为 md 再使用` }
  const dirAbs = !e.path || e.path === '-' ? '' : (isAbsolute(e.path) ? e.path : join(vault.rootPath, e.path))
  if (!dirAbs) return { ok: false, error: `素材「${e.name}」未登记路径` }
  const w = writeInventoryIndex(join(vault.rootPath, folder), e.name, e.path, dirAbs, todayLocal())
  if (!w.ok) return { ok: false, error: w.error }
  return {
    ok: true, relPath: w.relPath, sourceName: e.name,
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

/** 助手写入/展开课程大纲：append=false 首次生成（覆盖）；append=true 按章名合并增补（保留既有 id/进度）。 */
export function writeOutlineFromAssistant(wsId: string, draft: OutlineDraft, getSetting: (key: string) => unknown): { ok: boolean; mode?: 'create' | 'append'; added?: number; chapters?: number; relPath?: string; error?: string } {
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
    return w.ok ? { ok: true, mode: 'create', chapters: outline.chapters.length, relPath: w.relPath } : { ok: false, error: w.error }
  }
  // 增补：章名对齐现有章 → 追加其知识点；否则整章新增
  const additions: OutlineAdditions = { toExisting: [], newChapters: [] }
  for (const ch of norm.chapters) {
    const ex = existing!.chapters.find((c) => cleanField(c.name) === cleanField(ch.name))
    if (ex) for (const u of ch.units) additions.toExisting.push({ chapterId: ex.id, name: u.name, goal: u.goal, source: u.source })
    else additions.newChapters.push({ name: ch.name, units: ch.units.map((u) => ({ name: u.name, goal: u.goal, source: u.source })) })
  }
  const r = applyOutlineAdditions(id, additions, getSetting)
  return r.ok ? { ok: true, mode: 'append', added: r.added } : { ok: false, error: r.error }
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

/** 整理页归档：写入 target（仓库相对目录）或默认会话 output/；返回相对路径与**绝对路径**。 */
export function archiveOrganizedPage(sessionId: string, title: unknown, content: unknown, target: unknown, getSetting: (key: string) => unknown): { ok: boolean; relPath?: string; absPath?: string; error?: string } {
  const vault = getCurrentVault()
  if (!vault) return { ok: false, error: '尚未打开仓库' }
  let rel = String(target ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!rel) { const owner = resolveWriteOwnerRel(String(sessionId ?? ''), getSetting); if (!owner) return { ok: false, error: '无法确定归档目录' }; rel = owner }
  if (rel.split('/').some((s) => s.startsWith('.'))) return { ok: false, error: '归档目录非法（不能写入隐藏/点目录）' }
  try {
    const dirAbs = join(vault.rootPath, rel)
    mkdirSync(dirAbs, { recursive: true })
    const base = sanitizeTitle(String(title ?? '整理'))
    const fname = uniqueFileName(dirAbs, base.endsWith('.md') ? base : `${base}.md`)
    writeFileSync(join(dirAbs, fname), String(content ?? '').replace(/\r\n/g, '\n'), 'utf-8')
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
  ipcMain.handle('aiTeachCourse:setUnitProgress', (_e, wsId: string, unitId: string, patch: Partial<CourseUnitProgress>) =>
    setUnitProgress(String(wsId ?? ''), String(unitId ?? ''), patch ?? {}))
  // L2 课时
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
