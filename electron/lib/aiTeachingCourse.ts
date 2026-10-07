import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'fs'
import { dirname, join } from 'path'
import { ipcMain } from 'electron'
import { getCurrentVault } from './kbStore/vaultContext'
import { readJson, writeJson } from './kbStore/jsonStore'
import { getWorkspaceOfSession, workspaceFolderRel, assignSession } from './aiTeachingWorkspaces'
import { ensureSessionFolder, ensureSessionFolderAt, sessionFolder, setLessonFolderResolver } from './aiTeachingFolders'
import { renameWorkspacePath } from './workspaceManager'
import { createAgentSession, getAgentMessages, getAgentSession } from './agentSessionRepo'
import { invokeLlmInternal, invokeLlmStreamInternal, firstEnabledModelSpec } from './llmService'
import { broadcast, BROADCAST_CHANNEL } from '../main/windowBus'
import {
  parseCourseMd,
  rewriteCourseMd,
  parseOutlineJson,
  type CourseOutline,
  type CourseUnitProgress,
  type CourseUnitStatus,
  type GenerateOutlineInput,
} from './aiTeachingCoursePure'

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
export type { CourseChapter, CourseOutline, CourseUnit, CourseUnitProgress, CourseUnitStatus, GenerateOutlineInput } from './aiTeachingCoursePure'

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

export interface CourseState {
  enabled: boolean
  outline: CourseOutline | null
  progress: Record<string, CourseUnitProgress>
  lessons: Record<string, LessonInfo>
}

interface WsCourseState {
  enabled: boolean
  /** sessionId → 课时信息（新形状） */
  lessons: Record<string, LessonInfo>
  units: Record<string, CourseUnitProgress>
  /** 旧形状（sessionId → unitId）：仅读兼容，读到后迁移进 lessons */
  sessions?: Record<string, string>
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

export function writeCourseOutline(wsId: string, outline: CourseOutline, getSetting: (key: string) => unknown): { ok: boolean; relPath?: string; error?: string } {
  const vault = getCurrentVault()
  const loc = outlineRel(wsId, getSetting)
  if (!vault || !loc) return { ok: false, error: '尚未打开仓库或工作区不存在' }
  try {
    const abs = join(vault.rootPath, loc.rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, rewriteCourseMd(outline), 'utf-8')
    migrateUnitFolderPrefixes(wsId, getSetting) // F4：章号/章名变更 → 同步重命名知识点夹
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
  const l = wsState(f, wsId).lessons[sessionId]
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

/** L5：会话所属知识点的文件夹相对路径 `{工作区}/{章号}·{知识点}`（画像第三层落点）；非课时返回 null */
export function getSessionUnitFolderRel(sessionId: string, getSetting: (key: string) => unknown): string | null {
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
  const r = await invokeLlmInternal({ providerId, modelId, effort: 'off', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] })
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
  const r = await invokeLlmInternal({ providerId, modelId, effort: 'off', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] })
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
  const outline = readCourseOutline(wsId, getSetting)
  if (!outline || outline.chapters.length === 0) return ''
  const units = outline.chapters.flatMap((c) => c.units.map((u) => ({ ...u, chapter: c.name })))
  if (units.length === 0) return ''
  const total = units.length
  const done = units.filter((u) => s.units[u.id]?.status === 'mastered').length
  const curLesson = s.lessons[sessionId]
  const cur = curLesson ? units.find((u) => u.id === curLesson.unitId) ?? null : null
  const lines: string[] = ['【课程上下文（AI教学·课程模式）】']
  lines.push(`课程：${outline.title || '未命名'} · 目标：${outline.goal || '未设定'}`)
  if (outline.anchor) lines.push(`大纲依据：${outline.anchor}（你是这门课的老师，请围绕大纲推进，不要脱离知识点自由发散）`)
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

// ===== AI 生成大纲（一次性 LLM 调用，接真模型）=====

// ===== AI 生成大纲（接真模型；支持流式过程反馈）=====

/** 生成过程事件（经广播通道回渲染层，供建课向导显示「卡在哪一步」） */
export interface CourseGenProgress {
  id: string
  phase: 'request' | 'reasoning' | 'answer' | 'parsing' | 'done' | 'failed'
  /** 流式增量（reasoning / answer 阶段） */
  delta?: string
  model?: string
  chars?: number
  error?: string
}

function buildOutlinePrompt(input: GenerateOutlineInput): { sys: string; user: string } {
  const goal = String(input?.goal ?? '').trim()
  const anchorText = String(input?.anchorText ?? '').trim()
  const mode = input?.mode ?? 'free'
  const sys = '你是课程设计助手。把用户提供的学习目标/依据拆成「章 → 知识点」两级大纲。只输出一个 JSON 对象（可用 ```json 围栏包裹），不要任何解释文字。'
  const schema = 'JSON 结构：{"title":"课程名","goal":"一句话学习目标","anchor":"依据名称（无则空串）","chapters":[{"name":"章名","units":[{"name":"知识点名","goal":"该知识点的学习目标","source":"出处，如 考纲 §2.1，或 AI 补充"}]}]}'
  const modeHint = mode === 'free'
    ? '本次无权威依据：请依据学科通识生成，宁多勿缺；每个知识点的 source 写「AI 补充」。'
    : '本次有权威依据：请**只**依据下面给出的依据文本拆分知识点，不要发明依据里没有的内容；source 写出它在依据中的位置。'
  const user = `学习目标：${goal || '（见依据）'}\n\n依据名称：${String(input?.anchorLabel ?? '').trim() || '（无）'}\n依据文本：\n${anchorText.slice(0, 12000) || '（无）'}\n\n${schema}\n${modeHint}`
  return { sys, user }
}

/** 解析模型返回内容 → 大纲；失败时给出可读原因（含原文片段） */
function finishOutline(rawContent: string, input: GenerateOutlineInput, model: string): { ok: boolean; outline?: CourseOutline; error?: string } {
  const content = String(rawContent ?? '')
  const outline = parseOutlineJson(content)
  if (!outline) {
    const snippet = content.replace(/\s+/g, ' ').slice(0, 160)
    return { ok: false, error: `模型未返回可解析的大纲 JSON（${model || '未知模型'}）。原文片段：${snippet || '（空回复）'}` }
  }
  const goal = String(input?.goal ?? '').trim()
  if (goal && !outline.goal) outline.goal = goal
  if (!outline.anchor && input?.anchorLabel) outline.anchor = String(input.anchorLabel)
  return { ok: true, outline }
}

/** 解析本次要用的模型：优先对话模型 → 全局 defaultChatModel（由 invoke 侧兜底）→ 第一个启用供应商 */
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

export async function generateCourseOutline(input: GenerateOutlineInput): Promise<{ ok: boolean; outline?: CourseOutline; error?: string }> {
  const goal = String(input?.goal ?? '').trim()
  const anchorText = String(input?.anchorText ?? '').trim()
  if (!goal && !anchorText) return { ok: false, error: '请先填写学习目标，或提供考纲/目录文本' }
  const { sys, user } = buildOutlinePrompt(input)
  const { providerId, modelId } = resolveOutlineModel(input)
  try {
    const r = await invokeLlmInternal({ providerId, modelId, effort: 'off', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] })
    if (!r.ok) return { ok: false, error: r.error }
    return finishOutline(r.content, input, r.model)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 流式生成：把「请求/推理/回答/解析/完成/失败」逐段回传（emit），便于 UI 显示过程与定位失败点 */
export async function generateCourseOutlineStream(
  id: string,
  input: GenerateOutlineInput,
  emit: (p: CourseGenProgress) => void,
): Promise<{ ok: boolean; outline?: CourseOutline; error?: string }> {
  const goal = String(input?.goal ?? '').trim()
  const anchorText = String(input?.anchorText ?? '').trim()
  if (!goal && !anchorText) {
    const error = '请先填写学习目标，或提供考纲/目录文本'
    emit({ id, phase: 'failed', error })
    return { ok: false, error }
  }
  const { sys, user } = buildOutlinePrompt(input)
  const { providerId, modelId, label } = resolveOutlineModel(input)
  emit({ id, phase: 'request', model: label })
  let content = ''
  try {
    const r = await invokeLlmStreamInternal(
      { providerId, modelId, effort: 'off', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] },
      (e) => {
        if (e.type === 'text') { content += e.delta; emit({ id, phase: 'answer', delta: e.delta }) }
        else if (e.type === 'reasoning') { emit({ id, phase: 'reasoning', delta: e.delta }) }
      },
    )
    if (!r.ok) { emit({ id, phase: 'failed', error: r.error }); return { ok: false, error: r.error } }
    emit({ id, phase: 'parsing', chars: r.content.length, model: r.model })
    const result = finishOutline(r.content, input, r.model)
    emit(result.ok
      ? { id, phase: 'done', model: r.model }
      : { id, phase: 'failed', error: result.error })
    return result
  } catch (e) {
    const error = (e as Error).message
    emit({ id, phase: 'failed', error })
    return { ok: false, error }
  }
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
  const r = await invokeLlmInternal({ providerId, modelId, effort: 'off', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] })
  if (!r.ok) return { ok: false, error: r.error }
  const q = parseQuizJson(r.content)
  if (!q) return { ok: false, error: '模型未返回可解析的题目 JSON' }
  return { ok: true, questions: q }
}

// ===== IPC 注册 =====

export function registerAiTeachingCourseHandlers(getSetting: (key: string) => unknown): void {
  ipcMain.handle('aiTeachCourse:getState', (_e, wsId: string) => getCourseState(String(wsId ?? ''), getSetting))
  ipcMain.handle('aiTeachCourse:setEnabled', (_e, wsId: string, enabled: boolean) => setCourseEnabled(String(wsId ?? ''), !!enabled))
  ipcMain.handle('aiTeachCourse:saveOutline', (_e, wsId: string, outline: CourseOutline) => writeCourseOutline(String(wsId ?? ''), outline, getSetting))
  ipcMain.handle('aiTeachCourse:setUnitProgress', (_e, wsId: string, unitId: string, patch: Partial<CourseUnitProgress>) =>
    setUnitProgress(String(wsId ?? ''), String(unitId ?? ''), patch ?? {}))
  ipcMain.handle('aiTeachCourse:generateOutline', (_e, input: GenerateOutlineInput) =>
    generateCourseOutline(input ?? { goal: '', mode: 'free' }))
  ipcMain.handle('aiTeachCourse:generateOutlineStream', (_e, id: string, input: GenerateOutlineInput) =>
    generateCourseOutlineStream(String(id ?? ''), input ?? { goal: '', mode: 'free' }, (p) => broadcast(BROADCAST_CHANNEL.aiTeachCourseGenProgress, p)))
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
}
