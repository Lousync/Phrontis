/**
 * AI 文件策略（主进程侧）—— P0-A。
 *
 * 职责边界：
 *  · 读 `.knowbase/config.json#aiPolicy`（仓库覆盖，只能收窄）；
 *  · 与默认预设合成有效策略（`aiFilePolicyPure.resolveAiFilePolicy`）；
 *  · 给工具层提供 fs 感知的断言（stat / 符号链接 / 二进制探测），判定本身仍在纯模块里。
 *
 * 为什么不并进 builtinTools：`vault.search` / `vault.find` / `vault.list` / 目录工具与
 * `pluginRegistry` 的插件 fs API 需要不同语义（插件保持旧白名单），单独一层才能各自演进。
 */

import { openSync, readSync, closeSync, lstatSync, statSync } from 'fs'
import { relative } from 'path'
import { readAiPolicyConfig, updateAiPolicyConfig, type AiPolicyConfig } from 'phrontis-core/kbStore/repoConfig'
import {
  DEFAULT_AI_FILE_POLICY,
  evaluateAiDir,
  evaluateAiFile,
  relToPosix,
  resolveAiFilePolicy,
  type AiFileDecision,
  type AiFileOp,
  type AiFilePolicy,
} from './aiFilePolicyPure'

export type { AiFilePolicy, AiFilePreset, AiFileDecision } from './aiFilePolicyPure'
export {
  AI_PRESET_LABELS,
  AI_PRESET_WRITE_EXTS,
  DEFAULT_AI_FILE_POLICY,
  evaluateAiFile,
  evaluateAiDir,
  resolveAiFilePolicy,
} from './aiFilePolicyPure'

/** 仓库覆盖段（无则 null） */
export function getAiPolicyOverrides(): AiPolicyConfig | null {
  try { return readAiPolicyConfig() } catch { return null }
}

/** 有效策略 = 应用默认 ← 仓库覆盖（收窄） */
export function getAiFilePolicy(): AiFilePolicy {
  return resolveAiFilePolicy(getAiPolicyOverrides())
}

export interface AiPolicyState {
  effective: AiFilePolicy
  overrides: AiPolicyConfig | null
  /** 默认策略（UI 展示「跟随默认」） */
  defaults: AiFilePolicy
}

export function getAiPolicyState(): AiPolicyState {
  return { effective: getAiFilePolicy(), overrides: getAiPolicyOverrides(), defaults: { ...DEFAULT_AI_FILE_POLICY } }
}

/** 写仓库覆盖段（null = 清除，回落到应用默认） */
export function setAiPolicyOverrides(patch: AiPolicyConfig | null): AiPolicyState {
  updateAiPolicyConfig(patch)
  return getAiPolicyState()
}

export function vaultRelOf(root: string, abs: string): string {
  return relative(root, abs).replace(/\\/g, '/')
}

/** 前 512 字节含 NUL → 视作二进制（不整读大文件） */
function probeBinary(abs: string): boolean {
  let fd = -1
  try {
    fd = openSync(abs, 'r')
    const buf = Buffer.alloc(512)
    const n = readSync(fd, buf, 0, 512, 0)
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true
    return false
  } catch {
    return false
  } finally {
    if (fd >= 0) { try { closeSync(fd) } catch { /* ignore */ } }
  }
}

export interface VaultFileEvaluation extends AiFileDecision {
  rel: string
  /** 文件是否存在（写工具据此区分新建 / 覆写） */
  exists: boolean
  size?: number
  mtimeMs?: number
}

/** 带 fs 事实的准入判定（读 / 写共用；不存在按新建处理） */
export function evaluateVaultPath(root: string, abs: string, op: AiFileOp, policy = getAiFilePolicy()): VaultFileEvaluation {
  const rel = relToPosix(vaultRelOf(root, abs))
  let exists = false
  let size: number | undefined
  let mtimeMs: number | undefined
  let isSymlink = false
  try {
    const st = lstatSync(abs)
    isSymlink = st.isSymbolicLink()
    if (st.isFile()) { exists = true; size = st.size; mtimeMs = st.mtimeMs }
  } catch { /* 不存在 = 新建 */ }
  const decision = evaluateAiFile({
    rel,
    op,
    size,
    isSymlink: isSymlink || undefined,
    binary: op === 'read' && exists && (size ?? 0) > 0 ? probeBinary(abs) : undefined,
  }, policy)
  return { ...decision, rel, exists, size, mtimeMs }
}

/** 读断言：不通过直接抛（工具层统一错误出口） */
export function assertAiReadable(root: string, abs: string): VaultFileEvaluation {
  const v = evaluateVaultPath(root, abs, 'read')
  if (!v.allow) throw new Error(`${v.reason ?? '该文件不可读'}: ${v.rel}`)
  return v
}

/** 写断言：不通过直接抛；`extraSize` 用于「将要写入的字节数」预检 */
export function assertAiWritable(root: string, abs: string, extraSize?: number): VaultFileEvaluation {
  const v = evaluateVaultPath(root, abs, 'write')
  if (!v.allow) throw new Error(`${v.reason ?? '该位置不可写'}: ${v.rel}`)
  if (extraSize !== undefined) {
    const policy = getAiFilePolicy()
    if (extraSize > policy.maxWriteBytes) {
      throw new Error(`内容过大（${extraSize} 字节 > ${policy.maxWriteBytes} 上限），拒绝写入: ${v.rel}`)
    }
  }
  return v
}

/** 目录操作断言（建目录 / 整目录删除 / 目录改名） */
export function assertAiDirWritable(root: string, rel: string, policy = getAiFilePolicy()): string {
  const d = evaluateAiDir(rel, policy)
  if (!d.allow) throw new Error(`${d.reason ?? '目录路径不可写'}: ${rel}`)
  return d.rel
}

/** 目录是否存在（含「路径是文件」的情形，由调用方分辨） */
export function statKind(abs: string): 'file' | 'dir' | 'none' {
  try {
    const st = statSync(abs)
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'none'
  } catch {
    return 'none'
  }
}
