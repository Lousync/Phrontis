import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { ipcMain } from 'electron'
import { getCurrentVault } from './kbStore/vaultContext'
import { readJson, writeJson } from './kbStore/jsonStore'
import { getWorkspaceOfSession, workspaceFolderRel } from './aiTeachingWorkspaces'
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

export interface CourseState {
  enabled: boolean
  outline: CourseOutline | null
  progress: Record<string, CourseUnitProgress>
}

interface WsCourseState {
  enabled: boolean
  sessions: Record<string, string>
  units: Record<string, CourseUnitProgress>
}

interface ProgressFile {
  v: 1
  workspaces: Record<string, WsCourseState>
}

const KEY = 'progress.json'
const MODULE = 'modules/aiTeaching'
const OUTLINE_FILE = '课程.md'
const STATUSES: CourseUnitStatus[] = ['todo', 'learning', 'check', 'mastered', 'review']

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
  if (!f.workspaces[wsId]) f.workspaces[wsId] = { enabled: false, sessions: {}, units: {} }
  const s = f.workspaces[wsId]
  if (!s.sessions || typeof s.sessions !== 'object') s.sessions = {}
  if (!s.units || typeof s.units !== 'object') s.units = {}
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
  const s = f.workspaces[wsId]
  return {
    enabled: !!s?.enabled,
    outline: readCourseOutline(wsId, getSetting),
    progress: s?.units ?? {},
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
  s.units[unitId] = next
  persist(f)
  broadcastCourse(wsId)
  return { ok: true }
}

export function setSessionUnit(sessionId: string, unitId: string | null): { ok: boolean; error?: string } {
  const wsId = getWorkspaceOfSession(sessionId)
  if (!wsId) return { ok: false, error: '会话未归属工作区' }
  const f = readProgressFile()
  const s = wsState(f, wsId)
  if (unitId) s.sessions[sessionId] = unitId
  else delete s.sessions[sessionId]
  persist(f)
  broadcastCourse(wsId)
  return { ok: true }
}

// ===== 注入上下文（agentService 每轮调用）=====

export function buildCourseInjection(sessionId: string, getSetting: (key: string) => unknown): string {
  const wsId = getWorkspaceOfSession(sessionId)
  if (!wsId) return ''
  const f = readProgressFile()
  const s = f.workspaces[wsId]
  if (!s?.enabled) return ''
  const outline = readCourseOutline(wsId, getSetting)
  if (!outline || outline.chapters.length === 0) return ''
  const units = outline.chapters.flatMap((c) => c.units.map((u) => ({ ...u, chapter: c.name })))
  if (units.length === 0) return ''
  const total = units.length
  const done = units.filter((u) => s.units[u.id]?.status === 'mastered').length
  const curId = s.sessions[sessionId]
  const cur = units.find((u) => u.id === curId) ?? null
  const lines: string[] = ['【课程上下文（AI教学·课程模式）】']
  lines.push(`课程：${outline.title || '未命名'} · 目标：${outline.goal || '未设定'}`)
  if (outline.anchor) lines.push(`大纲依据：${outline.anchor}（你是这门课的老师，请围绕大纲推进，不要脱离知识点自由发散）`)
  if (cur) {
    const p = s.units[cur.id]
    lines.push(`当前知识点：${cur.name}（出自「${cur.chapter}」，来源：${cur.source || '未标注'}，掌握度 ${Math.round((p?.mastery ?? 0) * 100)}%，状态：${statusLabel(p?.status)}）`)
    if (cur.goal) lines.push(`本知识点目标：${cur.goal}`)
  }
  lines.push(`课程进度：已掌握 ${done}/${total}`)
  const review = units.filter((u) => s.units[u.id]?.status === 'review')
  if (review.length) lines.push(`待复习（薄弱）：${review.map((u) => u.name).join('、')}`)
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
function resolveOutlineModel(input: GenerateOutlineInput): { providerId?: string; modelId?: string; label: string } {
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

// ===== IPC 注册 =====

export function registerAiTeachingCourseHandlers(getSetting: (key: string) => unknown): void {
  ipcMain.handle('aiTeachCourse:getState', (_e, wsId: string) => getCourseState(String(wsId ?? ''), getSetting))
  ipcMain.handle('aiTeachCourse:setEnabled', (_e, wsId: string, enabled: boolean) => setCourseEnabled(String(wsId ?? ''), !!enabled))
  ipcMain.handle('aiTeachCourse:saveOutline', (_e, wsId: string, outline: CourseOutline) => writeCourseOutline(String(wsId ?? ''), outline, getSetting))
  ipcMain.handle('aiTeachCourse:setUnitProgress', (_e, wsId: string, unitId: string, patch: Partial<CourseUnitProgress>) =>
    setUnitProgress(String(wsId ?? ''), String(unitId ?? ''), patch ?? {}))
  ipcMain.handle('aiTeachCourse:setSessionUnit', (_e, sessionId: string, unitId: string | null) =>
    setSessionUnit(String(sessionId ?? ''), unitId ? String(unitId) : null))
  ipcMain.handle('aiTeachCourse:generateOutline', (_e, input: GenerateOutlineInput) =>
    generateCourseOutline(input ?? { goal: '', mode: 'free' }))
  ipcMain.handle('aiTeachCourse:generateOutlineStream', (_e, id: string, input: GenerateOutlineInput) =>
    generateCourseOutlineStream(String(id ?? ''), input ?? { goal: '', mode: 'free' }, (p) => broadcast(BROADCAST_CHANNEL.aiTeachCourseGenProgress, p)))
}
