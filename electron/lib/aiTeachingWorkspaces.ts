import { existsSync, mkdirSync, readdirSync, renameSync } from 'fs'
import { join, relative } from 'path'
import { ipcMain } from 'electron'
import { getCurrentVault } from 'phrontis-core/kbStore/vaultContext'
import { readJson, writeJson } from 'phrontis-core/kbStore/jsonStore'
import { listAgentSessions } from './agentSessionRepo'
import { broadcast, BROADCAST_CHANNEL } from '../main/windowBus'
import { classifyArtifact } from './aiTeachingCourseEndPure'
import { summarizeCourseWorkspace, type CourseSummary } from './aiTeachingCourseSummary'

/**
 * AI教学模块 · 工作区两层（总纲 §3.2-6 / §3.5，P5；决策点 3-6/3-8 按建议：元数据入仓库 `.knowbase/`，工作区跟随当前激活仓库）
 *
 * - 一个工作区 = 一门课程/一个主题，内含多个对话；产物目录结构 `AI教学/{工作区}/{MM-DD 标题}/`；
 * - 元数据 = `.knowbase/modules/aiTeaching/workspaces.json`（jsonStore 原子写；AI 只读可见，与去库化约定一致）；
 * - 会话归属：sessionWs 映射（真相源在此，不在锚点——锚点里的 workspaceId 仅作溯源快照）；
 * - 存量会话（未归属）不强行迁移：选择页以「未归一会话」入口呈现，文件夹留在产物根（findSessionFolderRel 双深度兼容）；
 * - 删除工作区只删元数据（文件夹与其中对话保留、转为未归一），破坏面最小。
 */

export interface AiWorkspace {
  id: string
  name: string
  createdAt: string
  /** 结课时间；null / 缺省 = 进行中。状态唯一真相源，不派生自进度（允许未学完结课） */
  endedAt?: string | null
}

interface WsMeta {
  v: 1
  workspaces: AiWorkspace[]
  /** sessionId → workspaceId（归属真相源） */
  sessionWs: Record<string, string>
  lastWorkspaceId: string | null
}

/** 选择页预览用：最近 2 条对话（只读摘要，不新增读盘——listAgentSessions 已在内存里） */
export interface WorkspaceRecentSession {
  id: string
  title: string
  updatedAt: string
}

export interface WorkspaceInfo extends AiWorkspace {
  sessionCount: number
  /** 工作区文件夹内课程产物数（五类可沉淀产物 + 题单；不含结构文件 / 素材 / 暂存区） */
  docCount: number
  folderRel: string
  lastActive: string | null
  /** 最近活跃的 2 条对话（按 updated_at 倒序；无对话为空数组） */
  recentSessions: WorkspaceRecentSession[]
  /** 结课时间（冗余便于渲染层直接判断；真相源仍是 `AiWorkspace.endedAt`） */
  endedAt: string | null
  /** 课程摘要；没有 `课程.md` 的主题工作区为 null */
  course: CourseSummary | null
}

const KEY = 'workspaces.json'
const MODULE = 'modules/aiTeaching'
const DEFAULT_ROOT_DIR = 'AI教学'

let cache: WsMeta | null = null
let cacheVault: string | null = null

function meta(): WsMeta | null {
  const vault = getCurrentVault()
  if (!vault) return null
  if (cache && cacheVault === vault.rootPath) return cache
  cache = readJson<WsMeta>(MODULE, KEY, { v: 1, workspaces: [], sessionWs: {}, lastWorkspaceId: null })
  if (!Array.isArray(cache.workspaces)) cache.workspaces = []
  if (!cache.sessionWs || typeof cache.sessionWs !== 'object') cache.sessionWs = {}
  cacheVault = vault.rootPath
  return cache
}

function persist(m: WsMeta): void {
  writeJson(MODULE, KEY, m)
}

function rootDirName(getSetting: (key: string) => unknown): string {
  const v = getSetting('aiTeachRootDir')
  const name = typeof v === 'string' ? v.trim() : ''
  return name && !/[\\/:*?"<>|]/.test(name) && name !== '.' && name !== '..' ? name : DEFAULT_ROOT_DIR
}

/** 工作区名 → 文件夹段（清洗规则与会话文件夹一致：非法字符→空格、截 40） */
export function wsFolderName(name: string): string {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .replace(/[. ]+$/, '')
  return cleaned || '工作区'
}

/** 会话归属的工作区 id（无归属返回 null） */
export function getWorkspaceOfSession(sessionId: string): string | null {
  return meta()?.sessionWs[sessionId] ?? null
}

/** 工作区元数据（不存在返回 null） */
export function getWorkspace(wsId: string): AiWorkspace | null {
  const m = meta()
  return m?.workspaces.find((w) => w.id === wsId) ?? null
}

/** 结课时间（null = 进行中 / 工作区不存在） */
export function getWorkspaceEndedAt(wsId: string): string | null {
  const ws = getWorkspace(wsId)
  const v = ws?.endedAt
  return typeof v === 'string' && v ? v : null
}

/** 写结课状态（`endedAt=null` = 重新开课）；不改其他字段 */
export function setWorkspaceEndedAt(wsId: string, endedAt: string | null): { ok: boolean; error?: string } {
  const m = meta()
  const ws = m?.workspaces.find((w) => w.id === wsId)
  if (!m || !ws) return { ok: false, error: '工作区不存在' }
  ws.endedAt = endedAt || null
  persist(m)
  return { ok: true }
}

/** 工作区文件夹相对路径（不建目录；工作区不存在返回 null） */
export function workspaceFolderRel(wsId: string, getSetting: (key: string) => unknown): string | null {
  const m = meta()
  const ws = m?.workspaces.find((w) => w.id === wsId)
  return ws ? `${rootDirName(getSetting)}/${wsFolderName(ws.name)}` : null
}

/**
 * 产物计数（选择页「产物」统计）：五类可沉淀产物 + 题单。
 * 口径与结课盘点共用 `classifyArtifact()` —— 课程.md / 交接 / 要求 / 画像 / 素材 / 暂存区都不再抬高数字。
 */
function countDocs(dirAbs: string): number {
  let n = 0
  const stack: Array<{ abs: string; depth: number }> = [{ abs: dirAbs, depth: 0 }]
  let guard = 0
  while (stack.length && n < 500 && guard++ < 2000) {
    const cur = stack.pop() as { abs: string; depth: number }
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(cur.abs, { withFileTypes: true })
    } catch { continue }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (e.isDirectory()) {
        if (cur.depth >= 5) continue
        if (e.name === '_templates' || e.name === '待整理' || e.name === 'SOURCES' || e.name === 'node_modules' || e.name === '教材' || e.name === '_extracts') continue
        stack.push({ abs: join(cur.abs, e.name), depth: cur.depth + 1 })
        continue
      }
      if (!e.isFile()) continue
      const rel = relative(dirAbs, join(cur.abs, e.name)).replace(/\\/g, '/')
      const group = classifyArtifact(rel)
      if (group !== 'excluded') n++
    }
  }
  return n
}

export function listWorkspaces(getSetting: (key: string) => unknown): { workspaces: WorkspaceInfo[]; sessionWs: Record<string, string>; unassignedCount: number; lastWorkspaceId: string | null } {
  const m = meta()
  if (!m) return { workspaces: [], sessionWs: {}, unassignedCount: 0, lastWorkspaceId: null }
  const rootDir = rootDirName(getSetting)
  const vault = getCurrentVault()
  const sessions = listAgentSessions()
  const progressAbs = vault ? join(vault.rootPath, '.knowbase', 'modules', 'aiTeaching', 'progress.json') : undefined
  const workspaces = m.workspaces.map((w) => {
    const own = sessions.filter((s) => m.sessionWs[s.id] === w.id)
    const folderRel = `${rootDir}/${wsFolderName(w.name)}`
    const wsAbs = vault ? join(vault.rootPath, folderRel) : null
    let lastActive: string | null = null
    for (const s of own) if (!lastActive || s.updated_at > lastActive) lastActive = s.updated_at
    // 选择页预览的「最近对话」：own 已在内存里，排序取 2 条不产生额外读盘
    const recentSessions = [...own]
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      .slice(0, 2)
      .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updated_at ?? '' }))
    return {
      ...w,
      endedAt: typeof w.endedAt === 'string' && w.endedAt ? w.endedAt : null,
      sessionCount: own.length,
      docCount: wsAbs ? countDocs(wsAbs) : 0,
      folderRel,
      lastActive,
      recentSessions,
      course: wsAbs ? summarizeCourseWorkspace(wsAbs, w.id, progressAbs) : null,
    }
  })
  const unassignedCount = sessions.filter((s) => !m.sessionWs[s.id]).length
  return { workspaces, sessionWs: m.sessionWs, unassignedCount, lastWorkspaceId: m.lastWorkspaceId && m.workspaces.some((w) => w.id === m.lastWorkspaceId) ? m.lastWorkspaceId : null }
}

export function createWorkspace(name: string, getSetting?: (key: string) => unknown): { ok: boolean; workspace?: AiWorkspace; error?: string } {
  const m = meta()
  if (!m) return { ok: false, error: '尚未打开仓库' }
  const clean = wsFolderName(name)
  if (!name || !name.trim()) return { ok: false, error: '工作区名称不能为空' }
  if (m.workspaces.some((w) => wsFolderName(w.name) === clean)) return { ok: false, error: `工作区「${clean}」已存在` }
  const ws: AiWorkspace = { id: `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: clean, createdAt: new Date().toISOString() }
  m.workspaces.push(ws)
  persist(m)
  // 素材夹预建（2026-09-08 用户拍板）：建工作区即建 `{产物根}/{工作区}/SOURCES/`，
  // 对话素材目录 `SOURCES/{对话名}/` 由 ensureSessionFolder 预建播种——不再等首次登记懒建
  try {
    const vault = getCurrentVault()
    if (vault && getSetting) {
      const rootDir = rootDirName(getSetting)
      mkdirSync(join(vault.rootPath, rootDir, clean, 'SOURCES'), { recursive: true })
    }
  } catch { /* 预建失败不阻断工作区创建（懒建兜底仍在） */ }
  return { ok: true, workspace: ws }
}

/** 改名：元数据 + 工作区文件夹同步 rename（目标占用则拒绝，不产生半改状态） */
export function renameWorkspace(id: string, name: string, getSetting: (key: string) => unknown): { ok: boolean; error?: string } {
  const m = meta()
  const vault = getCurrentVault()
  if (!m || !vault) return { ok: false, error: '尚未打开仓库' }
  const ws = m.workspaces.find((w) => w.id === id)
  if (!ws) return { ok: false, error: '工作区不存在' }
  const clean = wsFolderName(name)
  if (m.workspaces.some((w) => w.id !== id && wsFolderName(w.name) === clean)) return { ok: false, error: `工作区「${clean}」已存在` }
  const rootDir = rootDirName(getSetting)
  const oldRel = `${rootDir}/${wsFolderName(ws.name)}`
  const newRel = `${rootDir}/${clean}`
  if (oldRel !== newRel) {
    const oldAbs = join(vault.rootPath, oldRel)
    if (existsSync(oldAbs)) {
      if (existsSync(join(vault.rootPath, newRel))) return { ok: false, error: `目标文件夹「${clean}」已存在` }
      try {
        renameSync(oldAbs, join(vault.rootPath, newRel))
      } catch (e) {
        return { ok: false, error: `文件夹改名失败：${(e as Error).message}` }
      }
    }
  }
  ws.name = clean
  persist(m)
  return { ok: true }
}

/** 删除工作区（只删元数据；文件夹与对话保留、转未归一——不可逆动作留给渲染层确认） */
export function deleteWorkspace(id: string): { ok: boolean; error?: string } {
  const m = meta()
  if (!m) return { ok: false, error: '尚未打开仓库' }
  const before = m.workspaces.length
  m.workspaces = m.workspaces.filter((w) => w.id !== id)
  if (m.workspaces.length === before) return { ok: false, error: '工作区不存在' }
  for (const [sid, wid] of Object.entries(m.sessionWs)) if (wid === id) delete m.sessionWs[sid]
  if (m.lastWorkspaceId === id) m.lastWorkspaceId = null
  persist(m)
  return { ok: true }
}

export function assignSession(sessionId: string, wsId: string): { ok: boolean; error?: string } {
  const m = meta()
  if (!m) return { ok: false, error: '尚未打开仓库' }
  if (!wsId || !m.workspaces.some((w) => w.id === wsId)) return { ok: false, error: '工作区不存在' }
  m.sessionWs[sessionId] = wsId
  persist(m)
  return { ok: true }
}

/** 解除归属（会话转「未归一」，文件夹原地不动） */
export function unassignSession(sessionId: string): { ok: boolean; error?: string } {
  const m = meta()
  if (!m) return { ok: false, error: '尚未打开仓库' }
  delete m.sessionWs[sessionId]
  persist(m)
  return { ok: true }
}

export function setLastWorkspace(wsId: string | null): { ok: boolean; error?: string } {
  const m = meta()
  if (!m) return { ok: false, error: '尚未打开仓库' }
  m.lastWorkspaceId = wsId && m.workspaces.some((w) => w.id === wsId) ? wsId : null
  persist(m)
  return { ok: true }
}

/** 树刷新广播：走 windowBus 统一出口 + 通道常量（**不 import aiTeachingFolders 的语义包装** ——
 *  后者反向 import 本模块，会形成 folders↔workspaces 循环 import） */
function broadcastTree(dirRel: string): void {
  broadcast(BROADCAST_CHANNEL.aiTeachTreeRefresh, { dirRel })
}

export function registerAiTeachingWorkspaceHandlers(getSetting: (key: string) => unknown): void {
  ipcMain.handle('aiTeach:listWorkspaces', () => listWorkspaces(getSetting))
  ipcMain.handle('aiTeach:createWorkspace', (_e, name: string) => {
    const r = createWorkspace(String(name ?? ''), getSetting)
    if (r.ok) broadcastTree(rootDirName(getSetting))
    return r
  })
  ipcMain.handle('aiTeach:renameWorkspace', (_e, id: string, name: string) => {
    const r = renameWorkspace(String(id ?? ''), String(name ?? ''), getSetting)
    if (r.ok) broadcastTree(rootDirName(getSetting))
    return r
  })
  ipcMain.handle('aiTeach:deleteWorkspace', (_e, id: string) => deleteWorkspace(String(id ?? '')))
  ipcMain.handle('aiTeach:assignSession', (_e, sessionId: string, wsId: string) => assignSession(String(sessionId ?? ''), String(wsId ?? '')))
  ipcMain.handle('aiTeach:unassignSession', (_e, sessionId: string) => unassignSession(String(sessionId ?? '')))
  ipcMain.handle('aiTeach:setLastWorkspace', (_e, wsId: string | null) => setLastWorkspace(wsId == null ? null : String(wsId)))
}
