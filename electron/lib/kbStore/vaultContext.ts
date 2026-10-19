import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

/**
 * 当前仓库上下文（去库化地基）。
 *
 * 概念对标 Obsidian 的 Vault：应用启动打开一个「当前仓库」，所有模块的数据
 * 都从当前仓库根的隐藏目录 `.knowbase/` 读写；切换仓库 = 整套数据切换。
 *
 * - 当前仓库 id 持久化在 userData/settings.json 的 `currentVaultId` 字段（全局数据）
 * - workspaceManager 在 openDir/openById 成功时调用 setCurrentVault 同步
 * - 启动时由 workspaceManager 用 readCurrentVaultId + roots 恢复
 */

export interface VaultInfo {
  rootId: string
  name: string
  rootPath: string
}

let current: VaultInfo | null = null

const KB_DIR = '.knowbase'
export const KB_SCHEMA_VERSION = 1
/** 系统目录（相对仓库根，收在 .knowbase 内）：未分类页收件箱 */
export const KB_INBOX_DIR = '.knowbase/_inbox'
/** 系统目录：工具草稿区（Web 剪藏落点等）——软件侧工具类文件夹统一 `_` 前缀，与用户内容目录区分 */
export const KB_DRAFT_DIR = '.knowbase/_draft'
/** 旧附件目录（历史遗留，只读兼容；D1 定稿后不再新增内容） */
export const KB_ATTACHMENTS_DIR = '.knowbase/_attachments'
/** ★ 附件区（D1 定稿）：仓库根下顶层 `.attachments/`，408 图片/编辑器插图/博客图统一入此 */
export const ATTACHMENTS_DIR = '.attachments'

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/** 读 settings.json（不存在/损坏返回 {}） */
function readSettingsFile(): Record<string, unknown> {
  try {
    const p = settingsPath()
    if (!existsSync(p)) return {}
    return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** 写 settings.json（原子写，防损坏） */
function writeSettingsFile(patch: (s: Record<string, unknown>) => void): void {
  try {
    const p = settingsPath()
    const s = readSettingsFile()
    patch(s)
    const dir = join(p, '..')
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `.${randomUUID()}.tmp`)
    writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8')
    try {
      renameSync(tmp, p)
    } catch {
      if (existsSync(p)) unlinkSync(p)
      renameSync(tmp, p)
    }
  } catch {
    /* settings 不可写时静默（当前仓库仅内存态） */
  }
}

export function readCurrentVaultId(): string | null {
  const v = readSettingsFile()['currentVaultId']
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** P8（D8）：设备级最近仓库列表（settings.json.recentVaults，切换器/注册自愈的数据源） */
export interface RecentVault {
  rootId: string
  name: string
  path: string
  updatedAt: string
  /** 删除墓碑（2026-09-08）：仓库目录已进回收站但保留最近列表记录——用户从系统回收站
   *  恢复目录后，重启 loadVaults 自愈发现磁盘目录回来即自动复活登记并清标记 */
  deleted?: boolean
}

export function readRecentVaults(includeDeleted = false): RecentVault[] {
  const raw = readSettingsFile()['recentVaults']
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is RecentVault => !!x && typeof x === 'object' && typeof (x as RecentVault).rootId === 'string' && typeof (x as RecentVault).path === 'string')
    .filter((x) => includeDeleted || !x.deleted)
}

/** 删除仓库时的墓碑（2026-09-08）：不直接忘掉最近记录，标记 deleted——
 *  用户从系统回收站恢复目录后，重启 loadVaults 自愈自动复活登记（清标记） */
export function markRecentDeleted(rootId: string): void {
  writeSettingsFile((s) => {
    if (Array.isArray(s['recentVaults'])) {
      s['recentVaults'] = (s['recentVaults'] as RecentVault[]).map((x) => x.rootId === rootId ? { ...x, deleted: true } : x)
    }
  })
}

/** 墓碑复活：清 deleted 标记（loadVaults 自愈发现目录回归时调用） */
export function clearRecentDeleted(rootId: string): void {
  writeSettingsFile((s) => {
    if (Array.isArray(s['recentVaults'])) {
      s['recentVaults'] = (s['recentVaults'] as RecentVault[]).map((x) => x.rootId === rootId ? { ...x, deleted: false } : x)
    }
  })
}

/** 把仓库从最近列表移除（删除仓库时调用，防切换器列出死条目） */
export function forgetRecentVault(rootId: string): void {
  writeSettingsFile((s) => {
    if (Array.isArray(s['recentVaults'])) s['recentVaults'] = (s['recentVaults'] as RecentVault[]).filter((x) => x.rootId !== rootId)
  })
}

/** 设置当前仓库（内存态 + 持久化 currentVaultId + 刷新最近列表置顶） */
export function setCurrentVault(v: VaultInfo | null): void {
  current = v
  writeSettingsFile((s) => {
    if (v) {
      s['currentVaultId'] = v.rootId
      const rest = (Array.isArray(s['recentVaults']) ? (s['recentVaults'] as RecentVault[]) : []).filter((x) => x.rootId !== v.rootId && x.path !== v.rootPath)
      s['recentVaults'] = [
        { rootId: v.rootId, name: v.name, path: v.rootPath, updatedAt: new Date().toISOString() },
        ...rest,
      ].slice(0, 8)
    } else {
      delete s['currentVaultId']
    }
  })
}

export function getCurrentVault(): VaultInfo | null {
  return current
}

/** 当前仓库的 .knowbase 绝对路径；无当前仓库返回 null */
export function getVaultKbRoot(): string | null {
  return current ? join(current.rootPath, KB_DIR) : null
}

/** 当前仓库的附件区（根级 .attachments）绝对路径；无当前仓库返回 null */
export function getVaultAttachmentsRoot(): string | null {
  return current ? join(current.rootPath, ATTACHMENTS_DIR) : null
}

/** 确保附件区目录存在（懒建：首次插图/导入时调用） */
export function ensureAttachmentsDir(): boolean {
  const dir = getVaultAttachmentsRoot()
  if (!dir) return false
  try {
    mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

/**
 * 确保当前仓库的 .knowbase 存在并写入 meta.json（P8：name = 仓库展示名，默认文件夹名由调用方给）。
 * 返回是否就绪。目录树天然隐藏「.」开头目录，无需额外处理。
 */
export function ensureKbRoot(name?: string): boolean {
  const root = getVaultKbRoot()
  if (!root) return false
  const vaultId = current?.rootId
  try {
    mkdirSync(root, { recursive: true })
    const metaPath = join(root, 'meta.json')
    if (!existsSync(metaPath)) {
      writeFileSync(
        metaPath,
        JSON.stringify({ schemaVersion: KB_SCHEMA_VERSION, id: vaultId, name: name || undefined, createdAt: new Date().toISOString() }, null, 2),
        'utf-8'
      )
    } else if (name || vaultId) {
      // 存量 meta：回填 name / id 一次（幂等：已有不覆盖）
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as Record<string, unknown>
        let dirty = false
        if (name && (typeof meta.name !== 'string' || !meta.name)) {
          meta.name = name
          dirty = true
        }
        if (vaultId && (typeof meta.id !== 'string' || !meta.id)) {
          meta.id = vaultId
          dirty = true
        }
        if (dirty) writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
      } catch { /* meta 损坏不重写（读路径各自有兜底） */ }
    }
    return true
  } catch {
    return false
  }
}

/** P8 改名：写仓库根 .knowbase/meta.json 的 name（存在即改，不新建） */
export function setVaultMetaName(rootPath: string, name: string): void {
  try {
    const metaPath = join(rootPath, '.knowbase', 'meta.json')
    if (!existsSync(metaPath)) return
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as Record<string, unknown>
    meta.name = name
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
  } catch { /* ignore */ }
}
