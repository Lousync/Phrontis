/**
 * 自定义斜杠指令（P2）：`.assistant/commands/*.md` 的读写与 IPC。
 *
 * 与 `.assistant/CONSTRAINTS.md` 同一套目录哲学：文件是普通 md，用户用知识库 / 编辑器维护；
 * 本模块只负责列目录、解析、ensure 骨架，不做内联编辑 UI、不让 AI 自行改写（点目录不在 AI 写白名单）。
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ipcMain } from 'electron'
import { getCurrentVault } from 'phrontis-core/kbStore/vaultContext'
import { broadcastDataChanged } from '../main/windowBus'
import {
  MAX_COMMAND_FILES, commandSkeleton, normalizeCommandName, parseCommandFile, renderCommandPrompt, sortCommandNames,
  type ParsedCommand,
} from './assistantCommandsPure'

const ASSISTANT_DIR = '.assistant'
const COMMANDS_DIR = 'commands'
/** 单个命令文件读取上限（提示词资产，20k 正文足够；超过视为数据文件） */
export const MAX_COMMAND_FILE_BYTES = 512 * 1024

export interface CommandMeta {
  name: string
  description: string
}

export interface CommandFileResult {
  ok: boolean
  relPath?: string
  created?: boolean
  error?: string
}

function vaultRoot(): string | null {
  return getCurrentVault()?.rootPath ?? null
}

function commandsRel(): string {
  return `${ASSISTANT_DIR}/${COMMANDS_DIR}`
}

function commandsAbs(root: string): string {
  return join(root, ASSISTANT_DIR, COMMANDS_DIR)
}

function commandRel(name: string): string {
  return `${commandsRel()}/${name}.md`
}

function safeStat(abs: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(abs) } catch { return null }
}

/** 确保命令目录存在（新建入口 / 文件树定位前调用） */
export function ensureAssistantCommandsDir(): CommandFileResult {
  try {
    const root = vaultRoot()
    if (!root) return { ok: false, error: '尚未打开仓库' }
    const dir = commandsAbs(root)
    if (existsSync(dir)) return { ok: true, relPath: commandsRel() }
    mkdirSync(dir, { recursive: true })
    broadcastDataChanged('knowledge')
    return { ok: true, relPath: commandsRel(), created: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 列出现有命令（给 `/` 弹层与新建校验用） */
export function listAssistantCommands(): { ok: boolean; commands: CommandMeta[]; error?: string } {
  const root = vaultRoot()
  if (!root) return { ok: true, commands: [] }
  const dir = commandsAbs(root)
  if (!existsSync(dir)) return { ok: true, commands: [] }
  const out: CommandMeta[] = []
  try {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= MAX_COMMAND_FILES) break
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.md')) continue
      const name = normalizeCommandName(ent.name.slice(0, -3))
      if (!name) continue
      const abs = join(dir, ent.name)
      const st = safeStat(abs)
      if (!st?.isFile() || st.size > MAX_COMMAND_FILE_BYTES) continue
      let parsed: ParsedCommand | null = null
      try { parsed = parseCommandFile(readFileSync(abs, 'utf-8'), name) } catch { parsed = null }
      if (!parsed) continue
      out.push({ name: parsed.name, description: parsed.description })
    }
  } catch (e) {
    return { ok: false, commands: [], error: (e as Error).message }
  }
  return { ok: true, commands: sortCommandNames(out) }
}

/** 读取一条命令（调用 `/name args` 时用）：返回**已替换参数**的提示词 */
export function readAssistantCommand(rawName: unknown, args?: unknown): { ok: boolean; command?: ParsedCommand; error?: string } {
  let name = normalizeCommandName(rawName)
  if (!name) return { ok: false, error: '命令名非法' }
  const root = vaultRoot()
  if (!root) return { ok: false, error: '尚未打开仓库' }
  let abs = join(commandsAbs(root), `${name}.md`)
  if (!existsSync(abs)) {
    // 跨平台大小写一致：Windows 文件名不区分大小写，Linux 区分；按列表做一次大小写不敏感匹配
    const hit = listAssistantCommands().commands.find((c) => c.name.toLowerCase() === name!.toLowerCase())
    if (hit) { name = hit.name; abs = join(commandsAbs(root), `${name}.md`) }
  }
  const st = safeStat(abs)
  if (!st?.isFile()) return { ok: false, error: `没有找到自定义指令 /${name}` }
  if (st.size > MAX_COMMAND_FILE_BYTES) return { ok: false, error: '指令文件过大' }
  try {
    const parsed = parseCommandFile(readFileSync(abs, 'utf-8'), name)
    if (!parsed) return { ok: false, error: `指令 /${name} 内容为空或格式非法` }
    return { ok: true, command: { ...parsed, prompt: renderCommandPrompt(parsed.prompt, String(args ?? '')) } }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 新建命令：已存在则原样返回（不覆盖用户内容） */
export function createAssistantCommand(rawName: unknown): CommandFileResult {
  const name = normalizeCommandName(rawName)
  if (!name) return { ok: false, error: '命令名只能含中文 / 字母 / 数字 / _ / -，且不超过 24 字' }
  const root = vaultRoot()
  if (!root) return { ok: false, error: '尚未打开仓库' }
  try {
    const dir = commandsAbs(root)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const abs = join(dir, `${name}.md`)
    const relPath = commandRel(name)
    if (existsSync(abs)) return { ok: true, relPath, created: false }
    writeFileSync(abs, commandSkeleton(name), 'utf-8')
    broadcastDataChanged('knowledge')
    return { ok: true, relPath, created: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function registerAssistantCommandsHandlers(): void {
  ipcMain.handle('assistantCommands:list', () => listAssistantCommands())
  ipcMain.handle('assistantCommands:read', (_e, name: unknown, args: unknown) => readAssistantCommand(name, args))
  ipcMain.handle('assistantCommands:create', (_e, name: unknown) => createAssistantCommand(name))
  ipcMain.handle('assistantCommands:ensureDir', () => ensureAssistantCommandsDir())
}
