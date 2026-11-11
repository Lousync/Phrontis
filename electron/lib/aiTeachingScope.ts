import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { ipcMain } from 'electron'
import { getCurrentVault } from 'phrontis-core/kbStore/vaultContext'
import { CONSTRAINTS_FILE, broadcastTreeRefresh, ensureGlobalConstraints, ensureWorkspaceConstraints, readConstraints, readGlobalConstraints, rootDirName, unitConstraintsRel, writeConstraints } from './aiTeachingFolders'
import { getWorkspaceOfSession, workspaceFolderRel } from './aiTeachingWorkspaces'
import { getSessionLessonBrief, getSessionUnitFolderRels, readCourseOutline, unitFolderRel } from './aiTeachingCourse'
import { parseSourceMd, unitSourceFileRel } from './aiTeachingSources'
import { broadcast, BROADCAST_CHANNEL } from '../main/windowBus'
import { cutScopeLayer, SCOPE_LAYER_MAX_CHARS, SCOPE_LAYER_MAX_ITEMS } from './scopePrompt'

/**
 * AI教学 · **分层「要求」通用 scope 读写**（方案 `ai-teaching-flow-v2-impl.md` §三-2，2026-10-17）
 *
 * 三层可编辑（**章层本层不做** —— 方案 §三-3「明确不做」）：
 * - `global`     → `{仓库}/{aiTeachRootDir}/CONSTRAINTS.md`（**复用** `aiTeachingFolders` 既有读点/ensure，不新造文件）
 * - `workspace`  → `{工作区文件夹}/CONSTRAINTS.md`（同上）
 * - `unit`       → `{工作区}/第N章 章名/知识点/{NN} 知识点/CONSTRAINTS.md`（可选层；只在用户保存时落）
 *
 * 铁律 1：写盘后**只复用既有广播** —— `aiTeach:tree-refresh`（文件树/资源管理器）+
 *   `aiTeach:course-refresh`（课程页/画布重拉），**不新增广播通道**。
 * 铁律 3：入参只有 `{ wsId, level, unitId }`，绝对路径不出主进程；返回值一律仓库相对路径。
 *
 * 分层语义与注入顺序（全局 → 工作区 → 知识点 → 课时，见 `scopePrompt.ts`）一致：
 * 越细的层覆盖越粗的层；存量「课时夹」那份 CONSTRAINTS.md 仍是**最细、优先级最高**的一层，**不迁移**。
 */

/** 分层取值；`chapter` 保留在契约里只为让右栏能显示「本层未启用」，主进程一律拒绝 */
export type AiTeachScopeLevel = 'global' | 'workspace' | 'chapter' | 'unit'

export interface AiTeachScopeRef {
  wsId: string
  level: AiTeachScopeLevel
  unitId?: string | null
}

export interface AiTeachScopeTextResult {
  ok: boolean
  relPath?: string | null
  text?: string
  created?: boolean
  error?: string
}

/** 知识点级两处计数（画布卡片「信息两级」用）：req=要求条数，src=素材条数 */
export interface AiTeachScopeCount {
  req: number
  src: number
}

export interface AiTeachScopeCountsResult {
  ok: boolean
  units: Record<string, AiTeachScopeCount>
  error?: string
}

/** 知识点级要求骨架：`# {层名} · 要求` + 一句说明 + 空条目区（**不写列表项**，条目由用户加） */
export const UNIT_CONSTRAINTS_SKELETON = [
  '# 知识点 · 要求',
  '',
  '（本文件是本知识点的「要求」：本段覆盖到该知识点时生效，叠加在「工作区要求」与「全局要求」之上，冲突时以本层为准。可选层，不会自动创建；一行一条，以「- 」开头，AI 每轮自动按此检查。）',
  '',
].join('\n')

/** 相对路径的目录段（广播 dirRel 用；与 path.dirname 同语义但不引 path 依赖） */
function dirOfRel(rel: string): string {
  const s = rel.lastIndexOf('/')
  return s > 0 ? rel.slice(0, s) : rel
}

/** 入参归一（只做类型收窄；层级非法留给 resolveScopeFile 报错，不静默改层） */
function normalizeRef(ref: AiTeachScopeRef | null | undefined): AiTeachScopeRef {
  return {
    wsId: String(ref?.wsId ?? ''),
    level: (ref?.level ?? 'workspace') as AiTeachScopeLevel,
    unitId: ref?.unitId == null ? null : String(ref.unitId),
  }
}

interface ScopeFile { rel: string; dirRel: string; abs: string }

/** 层 → 文件（唯一解析点）：返回**仓库相对路径**；解析不出来给 `{ error }`，调用方据此原样回报 */
function resolveScopeFile(ref: AiTeachScopeRef, getSetting: (key: string) => unknown): ScopeFile | { error: string } {
  const level = ref.level
  if (level === 'chapter') return { error: '章层本层未启用' }
  const vault = getCurrentVault()
  if (!vault) return { error: '尚未打开仓库' }
  const wsId = String(ref.wsId ?? '').trim()
  if (level === 'global') {
    const dirRel = rootDirName(getSetting)
    const rel = `${dirRel}/${CONSTRAINTS_FILE}`
    return { rel, dirRel, abs: join(vault.rootPath, rel) }
  }
  if (level === 'workspace') {
    if (!wsId) return { error: '缺少工作区 id' }
    const wsRel = workspaceFolderRel(wsId, getSetting)
    if (!wsRel) return { error: '工作区不存在' }
    const rel = `${wsRel}/${CONSTRAINTS_FILE}`
    return { rel, dirRel: wsRel, abs: join(vault.rootPath, rel) }
  }
  if (level === 'unit') {
    if (!wsId) return { error: '缺少工作区 id' }
    const unitId = String(ref.unitId ?? '').trim()
    if (!unitId) return { error: '缺少知识点 id' }
    // 大纲存在时必须能在其中找到该知识点 —— 挡住脏 id 落进 `unitFolderRel` 的兜底路径
    const outline = readCourseOutline(wsId, getSetting)
    if (outline && outline.chapters.length > 0 && !outline.chapters.some((c) => c.units.some((u) => u.id === unitId))) {
      return { error: '知识点不存在' }
    }
    const rel = unitConstraintsRel(unitFolderRel(wsId, unitId, getSetting))
    if (!rel) return { error: '知识点不存在或未打开仓库' }
    return { rel, dirRel: dirOfRel(rel), abs: join(vault.rootPath, rel) }
  }
  return { error: `未知层级：${String(level ?? '')}` }
}

/** 读某层要求：文件不存在 → `text: ''`（不报错、不建文件）；relPath 恒为**应落路径**（面板据此显示/打开） */
export function readScopeText(ref: AiTeachScopeRef, getSetting: (key: string) => unknown): AiTeachScopeTextResult {
  try {
    const r = normalizeRef(ref)
    // 全局层复用既有读点（`aiTeachingFolders.readGlobalConstraints`），不另拼一份逻辑
    if (r.level === 'global') {
      const g = readGlobalConstraints(getSetting)
      if (!g.ok) return { ok: false, error: g.error }
      return { ok: true, relPath: `${rootDirName(getSetting)}/${CONSTRAINTS_FILE}`, text: String(g.text ?? '') }
    }
    const f = resolveScopeFile(r, getSetting)
    if ('error' in f) return { ok: false, error: f.error }
    return { ok: true, relPath: f.rel, text: existsSync(f.abs) ? readFileSync(f.abs, 'utf-8') : '' }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * 写某层要求（右栏「要求」页签的编辑入口）：CRLF 归一为 LF、父目录懒建、写完复用既有两条广播。
 * 空文本=写空文件（保留编辑入口，与 `writeConstraints` 同口径）。
 */
export function writeScopeText(ref: AiTeachScopeRef, text: string, getSetting: (key: string) => unknown): AiTeachScopeTextResult {
  try {
    const r = normalizeRef(ref)
    const f = resolveScopeFile(r, getSetting)
    if ('error' in f) return { ok: false, error: f.error }
    const body = String(text ?? '').replace(/\r\n/g, '\n')
    mkdirSync(dirname(f.abs), { recursive: true })
    writeFileSync(f.abs, body, 'utf-8')
    broadcastTreeRefresh(f.dirRel)
    const wsId = String(r.wsId ?? '').trim()
    // 全局层跨工作区：没有具体 wsId 时不发课程刷新（避免让渲染层去重拉一个空工作区的课程态）
    if (wsId) broadcast(BROADCAST_CHANNEL.aiTeachCourseRefresh, { wsId })
    return { ok: true, relPath: f.rel, text: body }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * 确保某层要求文件存在，缺则落骨架并返回 `created: true`。
 * global / workspace 复用 `aiTeachingFolders` 既有 ensure（同一份骨架，避免同一个文件两套骨架）；
 * unit 用本文件的骨架（既有代码没有这一层）。
 */
export function ensureScopeText(ref: AiTeachScopeRef, getSetting: (key: string) => unknown): AiTeachScopeTextResult {
  try {
    const r = normalizeRef(ref)
    if (r.level === 'chapter') return { ok: false, error: '章层本层未启用' }
    if (r.level === 'global') {
      const g = ensureGlobalConstraints(getSetting)
      return g.ok ? { ok: true, relPath: g.relPath, text: g.text, created: !!g.created } : { ok: false, error: g.error }
    }
    if (r.level === 'workspace') {
      const w = ensureWorkspaceConstraints(String(r.wsId ?? ''), getSetting)
      return w.ok ? { ok: true, relPath: w.relPath, text: w.text, created: !!w.created } : { ok: false, error: w.error }
    }
    const f = resolveScopeFile(r, getSetting)
    if ('error' in f) return { ok: false, error: f.error }
    if (existsSync(f.abs)) return { ok: true, relPath: f.rel, text: readFileSync(f.abs, 'utf-8'), created: false }
    mkdirSync(dirname(f.abs), { recursive: true })
    writeFileSync(f.abs, UNIT_CONSTRAINTS_SKELETON, 'utf-8')
    broadcastTreeRefresh(f.dirRel)
    const wsId = String(r.wsId ?? '').trim()
    if (wsId) broadcast(BROADCAST_CHANNEL.aiTeachCourseRefresh, { wsId })
    return { ok: true, relPath: f.rel, text: UNIT_CONSTRAINTS_SKELETON, created: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * 「要求」条目计数（`- ` 开头的行；**允许前置缩进**，标题与说明段一律不计）。
 * 只读不改，供画布卡片显示「要求 N」。
 *
 * ★ 与渲染层 `src/modules/ai-teaching/constraintsParse.ts` 的 `ITEM_RE` **必须同口径**：
 *   那边允许缩进条目（且编辑时会归一为顶格），这里若只数顶格行，用户手写的缩进条目
 *   会在卡片上显示「要求 0」、而右栏「要求」页签里明明看得见 —— 同一份文档两处读数打架。
 */
export function countConstraintItems(text: string): number {
  let n = 0
  for (const line of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*-\s+\S/.test(line)) n++
  }
  return n
}

/**
 * 一次扫描给出**所有**知识点的两处计数（画布卡片「信息两级」用）：
 * - `req` = 该知识点文件夹 `CONSTRAINTS.md` 的条目数（不存在 → 0）；
 * - `src` = 该知识点级 `SOURCE.md` 的素材条目数（复用既有 `parseSourceMd`，不存在 → 0）。
 *
 * **只读，不建任何文件**；`units` 的 key 覆盖大纲里全部知识点（缺失层填 0），画布不必兜底。
 */
export function scopeCounts(wsId: string, getSetting: (key: string) => unknown): AiTeachScopeCountsResult {
  try {
    const id = String(wsId ?? '').trim()
    if (!id) return { ok: false, units: {}, error: '缺少工作区 id' }
    const vault = getCurrentVault()
    if (!vault) return { ok: false, units: {}, error: '尚未打开仓库' }
    const outline = readCourseOutline(id, getSetting)
    if (!outline) return { ok: true, units: {} }
    const units: Record<string, AiTeachScopeCount> = {}
    for (const c of outline.chapters) {
      for (const u of c.units) {
        let req = 0
        let src = 0
        const folder = unitFolderRel(id, u.id, getSetting)
        const cRel = unitConstraintsRel(folder)
        if (cRel) {
          const abs = join(vault.rootPath, cRel)
          if (existsSync(abs)) { try { req = countConstraintItems(readFileSync(abs, 'utf-8')) } catch { req = 0 } }
        }
        const sRel = unitSourceFileRel(folder)
        if (sRel) {
          const abs = join(vault.rootPath, sRel)
          if (existsSync(abs)) { try { src = parseSourceMd(readFileSync(abs, 'utf-8')).length } catch { src = 0 } }
        }
        units[u.id] = { req, src }
      }
    }
    return { ok: true, units }
  } catch (e) {
    return { ok: false, units: {}, error: (e as Error).message }
  }
}

/** AgentRunner 注入用：本段覆盖的**可选知识点**要求正文（非课时会话/无文件 → 空串，注入零段）。
 *  知识点级文件不再自动创建；存在才读。一段覆盖多个知识点时按顺序带标签拼接，沿用 scopePrompt 的层上限。 */
export function readUnitConstraintsForSession(sessionId: string, getSetting: (key: string) => unknown): string {
  try {
    const vault = getCurrentVault()
    if (!vault) return ''
    const blocks: string[] = []
    for (const u of getSessionUnitFolderRels(String(sessionId ?? ''), getSetting)) {
      const rel = unitConstraintsRel(u.rel)
      if (!rel) continue
      const abs = join(vault.rootPath, rel)
      if (!existsSync(abs)) continue
      const text = readFileSync(abs, 'utf-8').trim()
      if (text) blocks.push(`【${u.name}】\n${text}`)
    }
    return blocks.join('\n\n')
  } catch {
    return ''
  }
}

// ===== AI 工具 course.constraints.write 的业务实现（docs/ai-teaching-constraints-write-plan.md）=====

/** 工具层四层（与 UI「要求」抽屉一致；chapter 不开放） */
export type AiTeachConstraintLevel = 'global' | 'workspace' | 'unit' | 'segment'

export interface AiTeachConstraintWriteInput {
  level: AiTeachConstraintLevel
  text: string
  mode?: 'append' | 'replace'
  unit?: string | null
}

export interface AiTeachConstraintWriteResult {
  ok: boolean
  level?: AiTeachConstraintLevel
  relPath?: string
  mode?: 'append' | 'replace'
  chars?: number
  items?: number
  truncated?: boolean
  warning?: string
  hint?: string
  error?: string
}

export interface AiTeachConstraintReadInput {
  level: AiTeachConstraintLevel
  unit?: string | null
}

export interface AiTeachConstraintReadResult {
  ok: boolean
  level?: AiTeachConstraintLevel
  relPath?: string | null
  text?: string
  chars?: number
  items?: number
  truncated?: boolean
  hint?: string
  error?: string
}

const AI_CONSTRAINT_TEXT_MAX = 20000
const AI_CONSTRAINT_LEVELS = new Set<AiTeachConstraintLevel>(['global', 'workspace', 'unit', 'segment'])

function normalizeConstraintText(value: unknown): string {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** append 语义：保留原内容，空行 + 新内容，末尾一个换行；不制造三连空行。 */
function appendConstraintText(existing: string, text: string): string {
  const cur = normalizeConstraintText(existing).trimEnd()
  const add = normalizeConstraintText(text).trim()
  return cur ? `${cur}\n\n${add}\n` : `${add}\n`
}

/** replace 语义：整篇覆盖，末尾一个换行。 */
function replaceConstraintText(text: string): string {
  return `${normalizeConstraintText(text).trim()}\n`
}

/** unit 层解析：显式名称/id → 当前聚焦 → 本段第一个；只在本段知识点范围内匹配。 */
function resolveConstraintUnit(
  sessionId: string,
  unitArg: unknown,
  getSetting: (key: string) => unknown,
): { unitId?: string; error?: string } {
  const brief = getSessionLessonBrief(sessionId)
  if (!brief) return { error: '当前会话不是段会话；课程助手 / 复习课请用 workspace 或 global' }
  const units = getSessionUnitFolderRels(sessionId, getSetting)
  if (units.length === 0) return { error: '本段没有可写的知识点；请用 workspace 或 global' }
  const query = String(unitArg ?? '').trim()
  let hit = query
    ? (units.find((u) => u.unitId === query) ?? units.find((u) => u.name === query))
    : undefined
  if (!query) {
    const active = String(brief.activeUnitId ?? '').trim()
    hit = (active ? units.find((u) => u.unitId === active) : undefined) ?? units[0]
  }
  if (!hit) return { error: '该知识点不在本段；请到对应段或知识点层写入' }
  return { unitId: hit.unitId }
}

interface ResolvedConstraintLayer {
  level: AiTeachConstraintLevel
  wsId: string
  unitId: string | null
}

/**
 * 四层要求解析（write / read 共用）：只做归属与层级校验，不读写盘。
 * 课程助手 / 复习课没有段层 → segment / unit 明确拒绝，由调用方原样回报。
 */
function resolveConstraintLayer(
  sessionId: string,
  level: AiTeachConstraintLevel,
  unitArg: unknown,
  getSetting: (key: string) => unknown,
): { ok: true; layer: ResolvedConstraintLayer } | { ok: false; error: string } {
  const sid = String(sessionId ?? '').trim()
  if (!sid) return { ok: false, error: '仅可在 AI 教学对话中使用' }
  if (!AI_CONSTRAINT_LEVELS.has(level)) return { ok: false, error: `未知要求层：${String(level ?? '')}` }
  if (!getCurrentVault()) return { ok: false, error: '尚未打开仓库' }
  const wsId = String(getWorkspaceOfSession(sid) ?? '').trim()
  if (level === 'global') return { ok: true, layer: { level, wsId, unitId: null } }
  if (level === 'segment') {
    const brief = getSessionLessonBrief(sid)
    if (!brief) return { ok: false, error: '当前会话不是段会话；课程助手 / 复习课请用 workspace 或 global' }
    return { ok: true, layer: { level, wsId, unitId: null } }
  }
  if (!wsId) return { ok: false, error: '当前对话未归属工作区' }
  if (level === 'unit') {
    const resolved = resolveConstraintUnit(sid, unitArg, getSetting)
    if (!resolved.unitId) return { ok: false, error: resolved.error ?? '无法确定知识点' }
    return { ok: true, layer: { level, wsId, unitId: resolved.unitId } }
  }
  return { ok: true, layer: { level: 'workspace', wsId, unitId: null } }
}

/** 非段层 → aiTeachScope 的层级引用（段层走 readConstraints/writeConstraints，不进这里） */
function scopeRefOf(layer: ResolvedConstraintLayer): AiTeachScopeRef {
  const level: 'global' | 'workspace' | 'unit' =
    layer.level === 'global' ? 'global' : layer.level === 'unit' ? 'unit' : 'workspace'
  return { wsId: layer.wsId, level, unitId: level === 'unit' ? layer.unitId : null }
}

/**
 * `course.constraints.write` 的唯一业务实现。
 * 写入后**下一轮用户消息**才重新注入（system 前缀在一轮 runAgentLoop 开始时已固定）。
 */
export function writeConstraintsForAiTeaching(
  sessionId: string,
  input: AiTeachConstraintWriteInput,
  getSetting: (key: string) => unknown,
): AiTeachConstraintWriteResult {
  try {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return { ok: false, error: '仅可在 AI 教学对话中使用' }
    const level = String(input?.level ?? '') as AiTeachConstraintLevel
    if (!AI_CONSTRAINT_LEVELS.has(level)) return { ok: false, error: `未知要求层：${String(input?.level ?? '')}` }
    const text = normalizeConstraintText(input?.text).trim()
    if (!text) return { ok: false, error: 'text 不能为空' }
    if (text.length > AI_CONSTRAINT_TEXT_MAX) return { ok: false, error: `text 过长（上限 ${AI_CONSTRAINT_TEXT_MAX} 字符）` }
    if (text.includes('\u0000')) return { ok: false, error: '内容含 NUL 字符，拒绝写入' }
    const mode: 'append' | 'replace' = input?.mode === 'replace' ? 'replace' : 'append'
    const resolved = resolveConstraintLayer(sid, level, input?.unit, getSetting)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    const { layer } = resolved

    let existing = ''
    let body = ''
    let relPath = ''

    if (layer.level === 'segment') {
      const cur = readConstraints(sid, getSetting)
      if (!cur.ok) return { ok: false, error: cur.error ?? '读取本段要求失败' }
      existing = cur.text ?? ''
      body = mode === 'replace' ? replaceConstraintText(text) : appendConstraintText(existing, text)
      const w = writeConstraints(sid, body, getSetting)
      if (!w.ok) return { ok: false, error: w.error ?? '写入本段要求失败' }
      relPath = String(w.relPath ?? cur.relPath ?? '')
      // writeConstraints 只发 tree-refresh；段层写完补课程刷新，画布/右栏计数同步。
      if (layer.wsId) broadcast(BROADCAST_CHANNEL.aiTeachCourseRefresh, { wsId: layer.wsId })
    } else {
      const ref = scopeRefOf(layer)
      const cur = readScopeText(ref, getSetting)
      if (!cur.ok) return { ok: false, error: cur.error ?? '读取要求失败' }
      existing = cur.text ?? ''
      body = mode === 'replace' ? replaceConstraintText(text) : appendConstraintText(existing, text)
      const w = writeScopeText(ref, body, getSetting)
      if (!w.ok) return { ok: false, error: w.error ?? '写入要求失败' }
      relPath = String(w.relPath ?? cur.relPath ?? '')
    }

    // 注入侧上限是 12 条 / 1200 字符；写盘成功不等于进 AI 上下文。
    const cut = cutScopeLayer(body)
    const beforeCut = cutScopeLayer(existing)
    let warning: string | undefined
    if (mode === 'append' && beforeCut.truncated) {
      warning = '原有内容已超过注入上限，追加内容可能不生效；建议用 replace 写一份精炼版'
    } else if (mode === 'replace' && existing.trim()) {
      warning = cut.truncated
        ? '已覆盖本层原有内容；内容仍超过注入上限，超出部分不会注入'
        : '已覆盖本层原有内容'
    } else if (cut.truncated) {
      warning = '内容超过注入上限，超出部分不会注入'
    }

    return {
      ok: true,
      level,
      relPath,
      mode,
      chars: body.length,
      items: countConstraintItems(body),
      truncated: cut.truncated,
      ...(warning ? { warning } : {}),
      ...(cut.truncated
        ? { hint: `本层注入上限 ${SCOPE_LAYER_MAX_ITEMS} 条 / ${SCOPE_LAYER_MAX_CHARS} 字符；超出部分不会进入 AI 上下文` }
        : {}),
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * `course.constraints.read` 的唯一业务实现：返回某层 **全文**。
 * 注入侧每层只取 12 条 / 1200 字符；读工具不受此限，但会用 `truncated` 提示注入侧仍会截断。
 */
export function readConstraintsForAiTeaching(
  sessionId: string,
  input: AiTeachConstraintReadInput,
  getSetting: (key: string) => unknown,
): AiTeachConstraintReadResult {
  try {
    const sid = String(sessionId ?? '').trim()
    const level = String(input?.level ?? '') as AiTeachConstraintLevel
    const resolved = resolveConstraintLayer(sid, level, input?.unit, getSetting)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    const { layer } = resolved

    let text = ''
    let relPath: string | null = null
    if (layer.level === 'segment') {
      const cur = readConstraints(sid, getSetting)
      if (!cur.ok) return { ok: false, error: cur.error ?? '读取本段要求失败' }
      text = cur.text ?? ''
      relPath = cur.relPath ?? null
    } else {
      const cur = readScopeText(scopeRefOf(layer), getSetting)
      if (!cur.ok) return { ok: false, error: cur.error ?? '读取要求失败' }
      text = cur.text ?? ''
      relPath = cur.relPath ?? null
    }

    const cut = cutScopeLayer(text)
    return {
      ok: true,
      level,
      relPath,
      text,
      chars: text.length,
      items: countConstraintItems(text),
      truncated: cut.truncated,
      ...(cut.truncated
        ? { hint: `注入时每层只取前 ${SCOPE_LAYER_MAX_ITEMS} 条 / ${SCOPE_LAYER_MAX_CHARS} 字符；本工具返回的是全文` }
        : {}),
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ===== 素材登记落点（`addSource` 的 target 归一）=====

export interface AiTeachSourceTarget {
  level: 'workspace' | 'unit'
  wsId?: string | null
  unitId?: string | null
}

export interface AiTeachSourceTargetNormalized {
  level: 'workspace' | 'unit'
  wsId: string | null
  unitId: string | null
}

/**
 * `addSource` 的落点归一：**缺省（不传 target）= 工作区主库**——旧调用点与旧契约一律不破。
 * `level: 'unit'` 但没有 unitId → 降级为工作区主库（不给脏 id 落进知识点夹的机会）。
 * 纯函数，负向断言由 `verify-scope-files.mjs` 直接驱动。
 */
export function normalizeSourceTarget(target?: AiTeachSourceTarget | null): AiTeachSourceTargetNormalized {
  const wsId = String(target?.wsId ?? '').trim() || null
  const unitId = String(target?.unitId ?? '').trim() || null
  if (target?.level === 'unit' && unitId) return { level: 'unit', wsId, unitId }
  return { level: 'workspace', wsId, unitId: null }
}

/**
 * IPC 注册（`aiTeachScope:*` 四通道）。**由 `aiTeachingSources.registerAiTeachingSourceHandlers` 调用**
 * （原因见那边的注释：scope 依赖 sources 的解析函数，反向注册会把 folders↔course 拖成环）。
 */
export function registerAiTeachingScopeHandlers(getSetting: (key: string) => unknown): void {
  ipcMain.handle('aiTeachScope:read', (_e, ref: AiTeachScopeRef) => readScopeText(ref ?? ({} as AiTeachScopeRef), getSetting))
  ipcMain.handle('aiTeachScope:writeText', (_e, ref: AiTeachScopeRef, text: string) => writeScopeText(ref ?? ({} as AiTeachScopeRef), String(text ?? ''), getSetting))
  ipcMain.handle('aiTeachScope:ensure', (_e, ref: AiTeachScopeRef) => ensureScopeText(ref ?? ({} as AiTeachScopeRef), getSetting))
  ipcMain.handle('aiTeachScope:counts', (_e, wsId: string) => scopeCounts(String(wsId ?? ''), getSetting))
}
