import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { ipcMain } from 'electron'
import { getCurrentVault } from './kbStore/vaultContext'
import { CONSTRAINTS_FILE, broadcastTreeRefresh, ensureGlobalConstraints, ensureWorkspaceConstraints, readGlobalConstraints, rootDirName, unitConstraintsRel } from './aiTeachingFolders'
import { workspaceFolderRel } from './aiTeachingWorkspaces'
import { getSessionUnitFolderRel, readCourseOutline, unitFolderRel } from './aiTeachingCourse'
import { parseSourceMd, unitSourceFileRel } from './aiTeachingSources'
import { broadcast, BROADCAST_CHANNEL } from '../main/windowBus'

/**
 * AI教学 · **分层「要求」通用 scope 读写**（方案 `ai-teaching-flow-v2-impl.md` §三-2，2026-10-17）
 *
 * 三层可编辑（**章层本层不做** —— 方案 §三-3「明确不做」）：
 * - `global`     → `{仓库}/{aiTeachRootDir}/CONSTRAINTS.md`（**复用** `aiTeachingFolders` 既有读点/ensure，不新造文件）
 * - `workspace`  → `{工作区文件夹}/CONSTRAINTS.md`（同上）
 * - `unit`       → `{工作区}/{章号}·{知识点}/CONSTRAINTS.md`（本次新增层；骨架由本文件落）
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
  '（本文件是本知识点的「要求」：只对本知识点下的课时生效，叠加在「工作区要求」与「全局要求」之上，冲突时以本层为准。一行一条，以「- 」开头；AI 每轮自动按此检查。）',
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
    // 大纲存在时必须能在其中找到该知识点 —— 挡住脏 id 落进 `unitFolderRel` 的兜底路径（`1·知识点`）
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

/** AgentRunner 注入用：本会话所属**知识点**层要求正文（非课时会话/无文件 → 空串，注入零段） */
export function readUnitConstraintsForSession(sessionId: string, getSetting: (key: string) => unknown): string {
  try {
    const vault = getCurrentVault()
    if (!vault) return ''
    const rel = unitConstraintsRel(getSessionUnitFolderRel(String(sessionId ?? ''), getSetting))
    if (!rel) return ''
    const abs = join(vault.rootPath, rel)
    return existsSync(abs) ? readFileSync(abs, 'utf-8').trim() : ''
  } catch {
    return ''
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
