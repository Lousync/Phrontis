/**
 * Vault 内文件正文读取（B1/B2 共用）—— 从 `agentService.readVaultRefText` 抽出，
 * 因为 B2 的 `perception.ts` 也要读（不能从 agentService import：
 * 那个文件顶部 `import { ipcMain } from 'electron'`，且会把整个 Agent 循环拖进依赖）。
 *
 * 走 `resolveSafe` 路径守卫（拒绝对路径 / `..` 越界 / symlink 逃逸），
 * 读失败一律返回 undefined —— **逐篇容错**：一篇读不到不能炸整轮对话，
 * 该篇降级为「仅路径」的骨架（模型仍可 fileRead 自取）。
 */

import { readFileSync } from 'fs'
import { resolveSafe } from '../workspaceManager'
import { getCurrentVault } from '../kbStore/vaultContext'

export function readVaultRefText(relPath: string): string | undefined {
  if (!relPath) return undefined
  const root = getCurrentVault()?.rootPath
  if (!root) return undefined
  const abs = resolveSafe(root, relPath)
  if (!abs) return undefined
  try {
    return readFileSync(abs, 'utf-8')
  } catch {
    return undefined
  }
}
