/**
 * 工作区信任（P0-B）—— 用户是否允许 AI 在当前仓库写文件 / 执行命令。
 *
 * 存储刻意**不放在 `.knowbase` 里**：`%APPDATA%/knowbase/data/workspace-trust.json`，按 `rootId` 索引。
 * 于是「拷走仓库」不会带走授权，「换一台机器」会重新问一次。
 * 同一台机器上复制仓库（rootId 相同）会继承信任——已知且可接受（rootId 跟 meta.json 走）。
 *
 * 三层模型里的第二层，纯计算在 `aiPermissionPure.evaluatePermission`，这里只管存取。
 */

import { globalReadJson, globalWriteJson } from 'phrontis-core/globalJsonStore'
import { getCurrentVault } from 'phrontis-core/kbStore/vaultContext'
import {
  DEFAULT_WORKSPACE_TRUST,
  evaluatePermission,
  normalizeWorkspaceTrust,
  type PermissionState,
  type TrustLevel,
  type WorkspaceTrust,
} from './aiPermissionPure'

const TRUST_FILE = 'workspace-trust.json'

interface TrustRow extends WorkspaceTrust {
  updatedAt: string
}

interface TrustStore {
  version: 1
  vaults: Record<string, TrustRow>
}

/**
 * 进程内缓存：权限预过滤会为每个工具调用一次 checkVaultFilePermission（每轮 ~20 次），
 * 每次都读盘没有意义。写路径（set / revoke）直接覆盖缓存。
 */
let storeCache: TrustStore | null = null

function readStore(): TrustStore {
  if (storeCache) return storeCache
  const raw = globalReadJson<TrustStore>(TRUST_FILE, { version: 1, vaults: {} })
  storeCache = (!raw || raw.version !== 1 || typeof raw.vaults !== 'object' || raw.vaults === null)
    ? { version: 1, vaults: {} }
    : raw
  return storeCache
}

function writeStore(store: TrustStore): void {
  storeCache = store
  globalWriteJson(TRUST_FILE, store)
}

/** 当前仓库的 rootId（没有打开仓库时 null） */
export function currentVaultRootId(): string | null {
  const cur = getCurrentVault()
  return cur?.rootId ? String(cur.rootId) : null
}

/** 读某仓库的信任（缺省 = 未表态） */
export function readWorkspaceTrust(rootId: string | null = currentVaultRootId()): WorkspaceTrust {
  if (!rootId) return { ...DEFAULT_WORKSPACE_TRUST }
  const row = readStore().vaults[rootId]
  return row ? normalizeWorkspaceTrust(row) : { ...DEFAULT_WORKSPACE_TRUST }
}

export interface CurrentTrustState {
  rootId: string | null
  trust: WorkspaceTrust
  updatedAt: string | null
}

export function getCurrentTrust(): CurrentTrustState {
  const rootId = currentVaultRootId()
  if (!rootId) return { rootId: null, trust: { ...DEFAULT_WORKSPACE_TRUST }, updatedAt: null }
  const row = readStore().vaults[rootId]
  return {
    rootId,
    trust: row ? normalizeWorkspaceTrust(row) : { ...DEFAULT_WORKSPACE_TRUST },
    updatedAt: row?.updatedAt ?? null,
  }
}

/** 更新当前仓库信任（未给的字段保持不变） */
export function setCurrentTrust(patch: Partial<WorkspaceTrust>): CurrentTrustState {
  const rootId = currentVaultRootId()
  if (!rootId) return getCurrentTrust()
  const store = readStore()
  const prev = normalizeWorkspaceTrust(store.vaults[rootId])
  const next: TrustRow = {
    fileWrite: normalizeLevel(patch.fileWrite, prev.fileWrite),
    shellExec: normalizeLevel(patch.shellExec, prev.shellExec),
    updatedAt: new Date().toISOString(),
  }
  store.vaults[rootId] = next
  writeStore(store)
  return { rootId, trust: { fileWrite: next.fileWrite, shellExec: next.shellExec }, updatedAt: next.updatedAt }
}

/** 撤销：整条记录删除，回到「未表态」（下次使用会再次询问） */
export function revokeCurrentTrust(): CurrentTrustState {
  const rootId = currentVaultRootId()
  if (!rootId) return getCurrentTrust()
  const store = readStore()
  delete store.vaults[rootId]
  writeStore(store)
  return { rootId, trust: { ...DEFAULT_WORKSPACE_TRUST }, updatedAt: null }
}

function normalizeLevel(next: TrustLevel | undefined, prev: TrustLevel): TrustLevel {
  return next === 'allow' || next === 'deny' || next === null ? next : prev
}

/** 供权限计算：当前仓库的信任 + 全局设置 → 生效状态 */
export function permissionStateOf(
  globalFilePerm: 'off' | 'read' | 'write',
  globalExec: boolean,
  terminalModuleOff: boolean,
): PermissionState & { rootId: string | null } {
  const { rootId, trust } = getCurrentTrust()
  const state = evaluatePermission({ globalFilePerm, globalExec, trust, terminalModuleOff })
  return { ...state, rootId }
}
