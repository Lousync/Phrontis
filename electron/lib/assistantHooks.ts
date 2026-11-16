/**
 * 提示型 hooks（P2）：`.assistant/hooks.json` 的读取与 ensure。
 *
 * 只读给 agentService 注入用；文件缺失 / 坏 JSON / 非法条目一律降级为空（不打断对话）。
 * 不执行任何命令 —— 这是与 shell hooks 的硬边界。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ipcMain } from 'electron'
import { getCurrentVault } from 'phrontis-core/kbStore/vaultContext'
import { broadcastDataChanged } from '../main/windowBus'
import { parsePromptHooks, type PromptHook } from './assistantHooksPure'

const ASSISTANT_DIR = '.assistant'
const HOOKS_FILE = 'hooks.json'
export const MAX_HOOKS_FILE_BYTES = 512 * 1024

export interface HooksReadResult {
  hooks: PromptHook[]
  warnings: string[]
}

/** 骨架：示例全部 enabled=false，创建文件不改变现有行为 */
function hooksSkeleton(): string {
  const data = {
    _说明: '提示型钩子：只把 prompt 注入模型上下文，不执行命令、不改文件。event: run-start | after-tool；tools 仅 after-tool 使用，支持 builtin.vault.* 通配。',
    hooks: [
      {
        event: 'run-start',
        enabled: false,
        prompt: '示例：开始前先看一遍任务清单；跨文件改动先用 builtin.plan.todo 列出步骤。',
      },
      {
        event: 'after-tool',
        enabled: false,
        tools: ['builtin.vault.write', 'builtin.vault.write-batch', 'builtin.vault.edit'],
        prompt: '示例：刚改过文件；如果涉及代码或配置，提醒用户跑一次校验，不要直接说完成。',
      },
    ],
  }
  return JSON.stringify(data, null, 2) + '\n'
}

function vaultRoot(): string | null {
  return getCurrentVault()?.rootPath ?? null
}

function hooksRel(): string {
  return `${ASSISTANT_DIR}/${HOOKS_FILE}`
}

/** 读钩子（每轮运行读一次）：无文件 / 坏 JSON / 超限 → 空 + warnings */
export function readAssistantHooks(): HooksReadResult {
  const root = vaultRoot()
  if (!root) return { hooks: [], warnings: [] }
  const abs = join(root, ASSISTANT_DIR, HOOKS_FILE)
  if (!existsSync(abs)) return { hooks: [], warnings: [] }
  try {
    const st = statSync(abs)
    if (!st.isFile() || st.size > MAX_HOOKS_FILE_BYTES) return { hooks: [], warnings: ['hooks.json 过大或不是文件，已忽略'] }
    const raw = readFileSync(abs, 'utf-8').replace(/^\uFEFF/, '')
    return parsePromptHooks(JSON.parse(raw))
  } catch (e) {
    return { hooks: [], warnings: [`hooks.json 解析失败：${(e as Error).message}`] }
  }
}

/** ensure 钩子文件（入口点击时懒建；不覆盖已有文件） */
export function ensureAssistantHooks(): { ok: boolean; relPath?: string; created?: boolean; error?: string } {
  try {
    const root = vaultRoot()
    if (!root) return { ok: false, error: '尚未打开仓库' }
    const dir = join(root, ASSISTANT_DIR)
    const abs = join(dir, HOOKS_FILE)
    const relPath = hooksRel()
    if (existsSync(abs)) return { ok: true, relPath, created: false }
    mkdirSync(dir, { recursive: true })
    writeFileSync(abs, hooksSkeleton(), 'utf-8')
    broadcastDataChanged('knowledge')
    return { ok: true, relPath, created: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function registerAssistantHooksHandlers(): void {
  ipcMain.handle('assistantHooks:ensure', () => ensureAssistantHooks())
}
