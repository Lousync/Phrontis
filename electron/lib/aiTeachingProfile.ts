import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app, ipcMain } from 'electron'
import { getCurrentVault } from './kbStore/vaultContext'
import { broadcastTreeRefresh, rootDirName, ensureSessionFolder } from './aiTeachingFolders'
import { getWorkspaceOfSession, workspaceFolderRel } from './aiTeachingWorkspaces'
import { applyProfileEntries } from './profilePatch'
import type { ProfileApplyOutcome, ProfileApplySkipped, ProfileEntry } from './profilePatch'

/**
 * AI教学模块 · 用户画像（总纲 docs/ai-teaching-module-rework.md §3.14，P8；UI 优化 §13.2 分层入口 / 第三轮「C 移入仓库」）
 *
 * 三层画像，完全复用「md 文件即真相源」哲学——**三层全部是仓库内文件**，编辑=跳编辑区打开对应 md：
 * - 全局 PROFILE.md：{仓库}/{aiTeachRootDir}/PROFILE.md（原 userData 位置已迁移入仓库，见 readGlobalProfile 迁移逻辑）；
 * - 工作区 PROFILE.md：{仓库}/{aiTeachRootDir}/{工作区文件夹}/PROFILE.md；
 * - 会话 PROFILE.md：{仓库}/{aiTeachRootDir}/{会话文件夹}/PROFILE.md。
 * 注入规则：全局 + 工作区 + 会话三层进 system，冲突时以更细颗粒为准；画像=「我是谁/我会什么」，约束=「你要怎么做」。
 * 维护策略 Plan B（3-33）：AI 在回答里给 ```profile 围栏建议块 → 用户逐条勾选后写文件（渲染层做卡片）。
 * v3.2.0 第 20 项起，围栏内容是**相对本主题画像的变化条目**（`[{field,op,text}]`）而不是整篇全文，
 * 落盘走 `applyProfilePatch`（合并语义；上层 `mergeOnly` 只接受追加）——`writeXxxProfile` 保留给
 * 「编辑画像」这类用户直存场景（整篇写入）。
 */

export const PROFILE_FILE = 'PROFILE.md'

/** 会话画像骨架（3-36 建议字段含「学习目标」；未正式拍板，按 §3.5 建议执行） */
export const SESSION_PROFILE_SKELETON = [
  '# 学习者画像 · 本主题',
  '',
  '（叠加在「全局画像」之上；可在对话里跑「诊断问答」生成，或直接编辑本文件；AI 建议须经你确认后才会写到这里。）',
  '',
  '## 当前水平',
  '- ',
  '',
  '## 薄弱点',
  '- ',
  '',
  '## 学习进度',
  '- ',
  '',
  '## 学习目标',
  '- ',
  '',
  '## 偏好',
  '- ',
  '',
].join('\n')

export const GLOBAL_PROFILE_SKELETON = [
  '# 学习者画像 · 全局',
  '',
  '（跨工作区/跨仓库共享；描述“我是谁、我会什么、我怎么学舒服”。可在 AI教学 选择页「👤 全局画像」里跑诊断问答生成。）',
  '',
  '## 身份与背景',
  '- ',
  '',
  '## 已知基础',
  '- ',
  '',
  '## 通用学习偏好',
  '- ',
  '',
].join('\n')

function globalProfilePath(getSetting: (key: string) => unknown): string {
  const vault = getCurrentVault()
  if (!vault) return join(app.getPath('userData'), 'AI教学', PROFILE_FILE)
  return join(vault.rootPath, rootDirName(getSetting), PROFILE_FILE)
}

/** 旧 userData 全局画像一次性迁移：仓库内不存在而 userData 存在 → 内容拷入（不删除旧文件） */
function migrateLegacyGlobalProfile(vaultPath: string, getSetting: (key: string) => unknown): void {
  try {
    const legacy = join(app.getPath('userData'), 'AI教学', PROFILE_FILE)
    const target = join(vaultPath, rootDirName(getSetting), PROFILE_FILE)
    if (existsSync(legacy) && !existsSync(target)) {
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, readFileSync(legacy, 'utf-8'), 'utf-8')
    }
  } catch { /* 迁移失败不阻塞读取 */ }
}

/** UI 优化条目8.2.2：工作区画像第三层——{产物根}/{工作区文件夹}/PROFILE.md（课程目标/整体进度/跨会话薄弱点） */
export const WORKSPACE_PROFILE_SKELETON = [
  '# 学习者画像 · 工作区',
  '',
  '（本工作区＝一门课程：整体学习目标、当前进度、跨会话的薄弱点汇总。叠加在「全局画像」之上，会话画像再叠加在其上——冲突时以更细颗粒为准。）',
  '',
  '## 课程目标',
  '- ',
  '',
  '## 整体进度',
  '- ',
  '',
  '## 跨会话薄弱点',
  '- ',
  '',
].join('\n')

export interface ProfileResult { ok: boolean; text?: string; relPath?: string | null; skeleton?: string; error?: string }
export interface ProfileEnsureResult { ok: boolean; relPath?: string; created?: boolean; error?: string }

/** 全局画像读取（仓库内 {aiTeachRootDir}/PROFILE.md；不存在=返回空文本；首次触发 userData 旧文件迁移） */
export function readGlobalProfile(getSetting: (key: string) => unknown): ProfileResult {
  try {
    const vault = getCurrentVault()
    if (!vault) return { ok: false, error: '尚未打开仓库' }
    migrateLegacyGlobalProfile(vault.rootPath, getSetting)
    const p = globalProfilePath(getSetting)
    return { ok: true, text: existsSync(p) ? readFileSync(p, 'utf-8') : '', relPath: `${rootDirName(getSetting)}/${PROFILE_FILE}`, skeleton: GLOBAL_PROFILE_SKELETON }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 全局画像写入（仓库内，mkdir 幂等） */
export function writeGlobalProfile(text: string, getSetting: (key: string) => unknown): ProfileResult {
  try {
    const vault = getCurrentVault()
    if (!vault) return { ok: false, error: '尚未打开仓库' }
    const p = globalProfilePath(getSetting)
    mkdirSync(join(p, '..'), { recursive: true })
    const body = String(text ?? '').replace(/\r\n/g, '\n')
    writeFileSync(p, body, 'utf-8')
    broadcastTreeRefresh(rootDirName(getSetting))
    return { ok: true, text: body, relPath: `${rootDirName(getSetting)}/${PROFILE_FILE}` }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 全局画像编辑前确保文件存在（不存在=落骨架）——UI 优化第三轮「编辑画像=跳编辑区」 */
export function ensureGlobalProfile(getSetting: (key: string) => unknown): ProfileEnsureResult {
  try {
    const vault = getCurrentVault()
    if (!vault) return { ok: false, error: '尚未打开仓库' }
    migrateLegacyGlobalProfile(vault.rootPath, getSetting)
    const rel = `${rootDirName(getSetting)}/${PROFILE_FILE}`
    const p = globalProfilePath(getSetting)
    if (!existsSync(p)) {
      const r = writeGlobalProfile(GLOBAL_PROFILE_SKELETON, getSetting)
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, relPath: rel, created: true }
    }
    return { ok: true, relPath: rel, created: false }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 工作区画像编辑前确保文件存在（懒建文件夹 + 骨架落盘） */
export function ensureWorkspaceProfile(wsId: string, getSetting: (key: string) => unknown): ProfileEnsureResult {
  try {
    const cur = readWorkspaceProfile(wsId, getSetting)
    if (!cur.ok) return { ok: false, error: cur.error }
    if (existsSync(join(getCurrentVault()!.rootPath, cur.relPath ?? ''))) return { ok: true, relPath: cur.relPath!, created: false }
    const r = writeWorkspaceProfile(wsId, WORKSPACE_PROFILE_SKELETON, getSetting)
    if (!r.ok) return { ok: false, error: r.error }
    return { ok: true, relPath: r.relPath!, created: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 会话画像编辑前确保文件存在（懒建会话文件夹 + 骨架落盘） */
export function ensureSessionProfile(sessionId: string, getSetting: (key: string) => unknown): ProfileEnsureResult {
  try {
    const cur = readSessionProfile(sessionId, getSetting)
    if (!cur.ok) return { ok: false, error: cur.error }
    if (cur.relPath && existsSync(join(getCurrentVault()!.rootPath, cur.relPath))) return { ok: true, relPath: cur.relPath, created: false }
    const r = writeSessionProfile(sessionId, SESSION_PROFILE_SKELETON, getSetting)
    if (!r.ok) return { ok: false, error: r.error }
    return { ok: true, relPath: r.relPath!, created: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 工作区画像路径（{产物根}/{工作区文件夹}/PROFILE.md；懒建目录，未生成不落盘）——UI 优化条目8.2.2 第三层 */
export function readWorkspaceProfile(wsId: string, getSetting: (key: string) => unknown): ProfileResult {
  try {
    const folderRel = workspaceFolderRel(wsId, getSetting)
    if (!folderRel) return { ok: false, error: '工作区不存在或未打开仓库' }
    const vault = getCurrentVault()
    if (!vault) return { ok: false, error: '尚未打开仓库' }
    const p = join(vault.rootPath, folderRel, PROFILE_FILE)
    return { ok: true, text: existsSync(p) ? readFileSync(p, 'utf-8') : '', relPath: `${folderRel}/${PROFILE_FILE}`, skeleton: WORKSPACE_PROFILE_SKELETON }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function writeWorkspaceProfile(wsId: string, text: string, getSetting: (key: string) => unknown): ProfileResult {
  try {
    const folderRel = workspaceFolderRel(wsId, getSetting)
    if (!folderRel) return { ok: false, error: '工作区不存在或未打开仓库' }
    const vault = getCurrentVault()
    if (!vault) return { ok: false, error: '尚未打开仓库' }
    const dirAbs = join(vault.rootPath, folderRel)
    mkdirSync(dirAbs, { recursive: true })
    const body = String(text ?? '').replace(/\r\n/g, '\n')
    writeFileSync(join(dirAbs, PROFILE_FILE), body, 'utf-8')
    broadcastTreeRefresh(folderRel)
    return { ok: true, text: body, relPath: `${folderRel}/${PROFILE_FILE}` }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 会话画像路径（懒建会话文件夹后 PROFILE.md；不存在=未生成） */
export function readSessionProfile(sessionId: string, getSetting: (key: string) => unknown): ProfileResult {
  try {
    const ensured = ensureSessionFolder(sessionId, getSetting)
    if (!ensured.ok || !ensured.relPath) return { ok: false, error: ensured.error ?? '会话文件夹不可用' }
    const vault = getCurrentVault()
    if (!vault) return { ok: false, error: '尚未打开仓库' }
    const p = join(vault.rootPath, ensured.relPath, PROFILE_FILE)
    return { ok: true, text: existsSync(p) ? readFileSync(p, 'utf-8') : '', relPath: `${ensured.relPath}/${PROFILE_FILE}`, skeleton: SESSION_PROFILE_SKELETON }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function writeSessionProfile(sessionId: string, text: string, getSetting: (key: string) => unknown): ProfileResult {
  try {
    const ensured = ensureSessionFolder(sessionId, getSetting)
    if (!ensured.ok || !ensured.relPath) return { ok: false, error: ensured.error ?? '会话文件夹不可用' }
    const vault = getCurrentVault()
    if (!vault) return { ok: false, error: '尚未打开仓库' }
    const body = String(text ?? '').replace(/\r\n/g, '\n')
    writeFileSync(join(vault.rootPath, ensured.relPath, PROFILE_FILE), body, 'utf-8')
    // 画像文件即时可见：广播树刷新（与 CONSTRAINTS/SOURCE 同通道语义）
    broadcastTreeRefresh(ensured.relPath)
    return { ok: true, text: body, relPath: `${ensured.relPath}/${PROFILE_FILE}` }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * AgentRunner 注入（§3.14 注入规则）：全局 + 工作区 + 会话三层画像合成一个提示块；
 * 每轮重读（与 CONSTRAINTS/SOURCE 同哲学）；三层皆空 → 零注入。
 * 同时携带「更新建议协议」（v3.2.0 第 20 项改口径）：AI 只输出**相对本主题画像的变化条目**
 * （`[{field,op,text}]`，不是整篇全文），且**没有新信息就不要输出**；
 * 用户在卡片上逐条勾选后才由 `applyProfilePatch` 落文件 —— AI 不得直接写画像文件。
 */
export function resolveProfilesForInjection(sessionId: string, getSetting: (key: string) => unknown): string {
  try {
    const g = readGlobalProfile(getSetting)
    const wsId = getWorkspaceOfSession(sessionId)
    const w = wsId ? readWorkspaceProfile(wsId, getSetting) : null
    const s = readSessionProfile(sessionId, getSetting)
    const gt = g.ok && g.text ? g.text.trim() : ''
    const wt = w && w.ok && w.text ? w.text.trim() : ''
    const st = s.ok && s.text ? s.text.trim() : ''
    if (!gt && !wt && !st) return ''
    const cut = (t: string, n: number) => (t.length > n ? t.slice(0, n) + '\n…（画像过长已截断）' : t)
    const parts = ['【学习者画像】以下是关于当前用户的学习者画像（“我是谁/我会什么”），讲解深浅、例子与节奏须适配画像；同字段冲突时**以更细颗粒层为准**（会话 > 工作区 > 全局）；与用户当下消息冲突时以用户消息为准。']
    if (gt) parts.push(`■ 全局画像（跨工作区稳定）：\n${cut(gt, 2000)}`)
    if (wt) parts.push(`■ 工作区画像（本课程目标/进度/薄弱点，覆盖全局）：\n${cut(wt, 2000)}`)
    if (st) parts.push(`■ 本主题画像（会话级，覆盖以上两层）：\n${cut(st, 2000)}`)
    parts.push('当对话出现**明确的新信息**（新掌握的知识点 / 新暴露的薄弱点 / 进度推进）时，不要直接改画像文件——在回答末尾追加一个 ```profile 围栏，内容是**相对本主题画像的变化条目**（严格 JSON 数组，不要注释与多余文字）：[{"field":"薄弱点","op":"add","text":"…"},{"field":"学习进度","op":"update","from":"被替换的原文","text":"新写法"},{"field":"偏好","op":"remove","text":"要删掉的原文"}]。field 取本主题画像里已有的二级标题名，op 取 add / update / remove。**没有新信息就不要输出这个块**，不要为了更新而更新；同一件事不要重复登记；上面「全局 / 工作区」两层已经写过的内容不要在本主题层再写一遍。客户端会渲染成可逐条勾选的卡片，用户确认后才落文件。')
    return '\n\n' + parts.join('\n\n')
  } catch {
    return ''
  }
}

export interface ProfilePatchResult {
  ok: boolean
  relPath?: string | null
  applied?: ProfileApplyOutcome[]
  skipped?: ProfileApplySkipped[]
  error?: string
}

/**
 * 合并写入画像（v3.2.0 第 20 项）：把「变化条目」应用到指定层，**不再整篇覆盖**。
 *
 * - 上层（workspace / global）传 `mergeOnly: true` —— `update` / `remove` 由 `profilePatch`
 *   在函数入口拒绝并逐条回报，这是「不许整篇覆盖上层」的红线落点（不靠调用方自觉过滤）。
 * - 文件不存在（或内容为空）时以该层骨架为底，保证 `add` 有落点（等价 ensure + 应用）。
 * - 返回 `applied` / `skipped` 供卡片转结果态（哪几条真落了、哪几条为什么没落）。
 */
export function applyProfilePatch(
  layer: 'global' | 'workspace' | 'session',
  id: string | null,
  entries: ProfileEntry[],
  getSetting: (key: string) => unknown,
): ProfilePatchResult {
  try {
    const list = Array.isArray(entries) ? entries : []
    const read = layer === 'global'
      ? readGlobalProfile(getSetting)
      : layer === 'workspace'
        ? readWorkspaceProfile(String(id ?? ''), getSetting)
        : readSessionProfile(String(id ?? ''), getSetting)
    if (!read.ok) return { ok: false, error: read.error }

    const base = read.text && read.text.trim() ? read.text : (read.skeleton ?? '')
    const res = applyProfileEntries(base, list, { mergeOnly: layer !== 'session' })

    const write = layer === 'global'
      ? writeGlobalProfile(res.text, getSetting)
      : layer === 'workspace'
        ? writeWorkspaceProfile(String(id ?? ''), res.text, getSetting)
        : writeSessionProfile(String(id ?? ''), res.text, getSetting)
    if (!write.ok) return { ok: false, error: write.error }

    return { ok: true, relPath: write.relPath ?? null, applied: res.applied, skipped: res.skipped }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** IPC 注册（main/index.ts） */
export function registerAiTeachingProfileHandlers(getSetting: (key: string) => unknown): void {
  ipcMain.handle('aiTeachProfile:readGlobal', () => readGlobalProfile(getSetting))
  ipcMain.handle('aiTeachProfile:writeGlobal', (_e, text: string) => writeGlobalProfile(String(text ?? ''), getSetting))
  ipcMain.handle('aiTeachProfile:readSession', (_e, sessionId: string) => readSessionProfile(String(sessionId ?? ''), getSetting))
  ipcMain.handle('aiTeachProfile:writeSession', (_e, sessionId: string, text: string) => writeSessionProfile(String(sessionId ?? ''), String(text ?? ''), getSetting))
  ipcMain.handle('aiTeachProfile:readWorkspace', (_e, wsId: string) => readWorkspaceProfile(String(wsId ?? ''), getSetting))
  ipcMain.handle('aiTeachProfile:writeWorkspace', (_e, wsId: string, text: string) => writeWorkspaceProfile(String(wsId ?? ''), String(text ?? ''), getSetting))
  ipcMain.handle('aiTeachProfile:ensureGlobal', () => ensureGlobalProfile(getSetting))
  ipcMain.handle('aiTeachProfile:ensureSession', (_e, sessionId: string) => ensureSessionProfile(String(sessionId ?? ''), getSetting))
  ipcMain.handle('aiTeachProfile:ensureWorkspace', (_e, wsId: string) => ensureWorkspaceProfile(String(wsId ?? ''), getSetting))
  /** v3.2.0 第 20 项：按「变化条目」合并写入（add / update / remove；上层 mergeOnly 只追加） */
  ipcMain.handle('aiTeachProfile:applyPatch', (_e, layer: string, id: string | null, entries: unknown) => {
    if (layer !== 'global' && layer !== 'workspace' && layer !== 'session') return { ok: false, error: '未知写入层级' }
    return applyProfilePatch(layer, id ? String(id) : null, (Array.isArray(entries) ? entries : []) as ProfileEntry[], getSetting)
  })
}
