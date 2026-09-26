import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ipcMain } from 'electron'
import { getCurrentVault } from './kbStore/vaultContext'
import { broadcastDataChanged } from '../main/windowBus'

/**
 * AI 助手 · 独立要求与术语表（v3.4.0 台账 N-5 / N-7，2026-09-24 三轮拍板）。
 *
 * 与 AI 教学那套（aiTeachingFolders / aiTeachingProfile）**完全分开**（拍板①：独立第二份，不共用）：
 * - 存放 = 仓库根 `.assistant/`（拍板②，登记进 workspaceManager 的 SOFT_ENTRY_NAMES → 软件文件区可见）；
 * - 文件 = `.assistant/CONSTRAINTS.md`（全局要求，所有对话共用一层，拍板 A/D：不分层、无画像）；
 * - 会话层 = `.assistant/{会话id}/CONSTRAINTS.md`（**按需升格**：用户从助手面板入口手工创建，
 *   拍板「复杂任务 → 会话限制」；优先级链拍板 G：会话 > 全局）；
 * - 术语表 = `.assistant/glossary.json`（拍板：独立 JSON，预填骨架可改；别名制，全局一份）；
 * - 骨架 = 要求文件**不预填**（拍板 H：落空文件，用户自己写；别自作主张加示例条目）。
 *
 * 注入侧（agentService）每轮重读：改动保存后下一轮对话即生效（与教学约束同哲学）。
 * 编辑 = 渲染层 ensure 后派 kb-open-note 跳知识库 draft 页签（写入走编辑器既有 ws:writeFile，
 * 本模块只管 ensure 与读，不设写通道）。查询/写工具对点目录无权限（isAiWritableFile 恒 false），
 * AI 自己改不了这两个文件 —— 这是设计：要求与术语表只能由用户维护。
 */

const ASSISTANT_DIR = '.assistant'
const CONSTRAINTS_FILE = 'CONSTRAINTS.md'
const GLOSSARY_FILE = 'glossary.json'

export interface AssistantFileResult {
  ok: boolean
  /** 仓库根相对路径（渲染层拿它派 kb-open-note） */
  relPath?: string
  created?: boolean
  error?: string
}

/** 术语表行（别名制）：用户可能这么说 → 规范名 → 对应工具（可空） */
export interface GlossaryRow {
  alias: string
  name: string
  tools?: string
}

/** 术语表骨架（N-7 四·乙预填 8 行，拍板「预填可改」）：只收**有 AI 工具**的模块，
 *  工具名必须真实存在于 builtinTools 注册表（契约 verify-assistant-constraints.mjs 锁）。
 *  「博客 / 日志 / 日记 → 博客日记」这条承担弥合 UI（博客）与工具（日记）命名的缝，不可省（N-7 §六）。 */
const GLOSSARY_SKELETON: { 说明: string; rows: GlossaryRow[] } = {
  说明: 'AI 助手术语表：让 AI 与用户对同一功能的命名理解统一。alias=用户可能的说法；name=规范数据域名；tools=对应的 AI 工具（可省略）。直接编辑本文件，保存后下一轮对话生效。',
  rows: [
    { alias: '笔记 / 页面 / 笔记区 / 知识库', name: '知识库页面', tools: 'builtin.knowledge.search / builtin.knowledge.create-page' },
    { alias: '博客 / 日志 / 日记', name: '博客日记（每天一篇）', tools: 'builtin.blog.search / builtin.blog.create-entry' },
    { alias: '日程 / 待办 / 任务 / 计划', name: '日程待办', tools: 'builtin.schedule.list-todos / builtin.schedule.create-todo / builtin.schedule.update-todo' },
    { alias: '打卡 / 习惯', name: '习惯打卡', tools: 'builtin.habits.stats / builtin.checkin.check-habit' },
    { alias: '错题 / 题目 / 试卷', name: '错题本', tools: 'builtin.quiz.list / builtin.quiz.stats / builtin.quiz.gen-paper' },
    { alias: '专注 / 番茄钟', name: '番茄专注', tools: 'builtin.pomodoro.summary' },
    { alias: '书源 / 书市', name: '书市素材', tools: 'builtin.booksource.list / builtin.booksource.draft' },
    { alias: '文件 / 目录 / 仓库', name: '仓库文件', tools: 'builtin.vault.list / builtin.vault.read / builtin.vault.search / builtin.vault.write' },
  ],
}

function vaultRoot(): string | null {
  return getCurrentVault()?.rootPath ?? null
}

/** 会话 id 合法性：单段安全目录名（助手会话 id 来自 agentSessionRepo，uuid 形态；防拼接路径） */
function safeSessionId(sessionId: unknown): string | null {
  const id = String(sessionId ?? '').trim()
  if (!id || id === '.' || id === '..' || id.length > 64) return null
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : null
}

/** 读全局要求（注入用）：文件缺失/读取失败 → 空串（不落盘，ensure 只由入口点击触发） */
export function readAssistantGlobalConstraints(): string {
  const root = vaultRoot()
  if (!root) return ''
  try {
    const p = join(root, ASSISTANT_DIR, CONSTRAINTS_FILE)
    return existsSync(p) ? readFileSync(p, 'utf-8') : ''
  } catch { return '' }
}

/** 读会话要求（注入用）：会话文件夹不存在 = 未升格 → 空串 */
export function readAssistantSessionConstraints(sessionId: unknown): string {
  const id = safeSessionId(sessionId)
  const root = vaultRoot()
  if (!id || !root) return ''
  try {
    const p = join(root, ASSISTANT_DIR, id, CONSTRAINTS_FILE)
    return existsSync(p) ? readFileSync(p, 'utf-8') : ''
  } catch { return '' }
}

/** ensure 全局要求（入口点击）：懒建 `.assistant/` + 空文件（拍板 H：不预填骨架） */
export function ensureAssistantGlobalConstraints(): AssistantFileResult {
  try {
    const root = vaultRoot()
    if (!root) return { ok: false, error: '尚未打开仓库' }
    const dirAbs = join(root, ASSISTANT_DIR)
    const relPath = `${ASSISTANT_DIR}/${CONSTRAINTS_FILE}`
    const p = join(dirAbs, CONSTRAINTS_FILE)
    if (existsSync(p)) return { ok: true, relPath, created: false }
    mkdirSync(dirAbs, { recursive: true })
    writeFileSync(p, '', 'utf-8')
    broadcastDataChanged('knowledge') // 新目录/文件要进软件文件区与文件树（铁律 1：写盘后广播）
    return { ok: true, relPath, created: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** ensure 会话要求（按需升格入口）：懒建 `.assistant/{会话id}/` + 空文件 */
export function ensureAssistantSessionConstraints(sessionId: unknown): AssistantFileResult {
  const id = safeSessionId(sessionId)
  if (!id) return { ok: false, error: '会话 id 非法' }
  try {
    const root = vaultRoot()
    if (!root) return { ok: false, error: '尚未打开仓库' }
    const dirAbs = join(root, ASSISTANT_DIR, id)
    const relPath = `${ASSISTANT_DIR}/${id}/${CONSTRAINTS_FILE}`
    const p = join(dirAbs, CONSTRAINTS_FILE)
    if (existsSync(p)) return { ok: true, relPath, created: false }
    mkdirSync(dirAbs, { recursive: true })
    writeFileSync(p, '', 'utf-8')
    broadcastDataChanged('knowledge')
    return { ok: true, relPath, created: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** ensure 术语表（N-7 拍板：预填骨架、可改） */
export function ensureAssistantGlossary(): AssistantFileResult {
  try {
    const root = vaultRoot()
    if (!root) return { ok: false, error: '尚未打开仓库' }
    const dirAbs = join(root, ASSISTANT_DIR)
    const relPath = `${ASSISTANT_DIR}/${GLOSSARY_FILE}`
    const p = join(dirAbs, GLOSSARY_FILE)
    if (existsSync(p)) return { ok: true, relPath, created: false }
    mkdirSync(dirAbs, { recursive: true })
    writeFileSync(p, JSON.stringify(GLOSSARY_SKELETON, null, 2) + '\n', 'utf-8')
    broadcastDataChanged('knowledge')
    return { ok: true, relPath, created: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 读术语表（注入用，N-7）：解析失败/形状不对 → null（注入段零，绝不因坏 JSON 打断对话） */
export function readAssistantGlossary(): GlossaryRow[] | null {
  const root = vaultRoot()
  if (!root) return null
  try {
    const p = join(root, ASSISTANT_DIR, GLOSSARY_FILE)
    if (!existsSync(p)) return null
    const data = JSON.parse(readFileSync(p, 'utf-8')) as { rows?: unknown }
    if (!Array.isArray(data?.rows)) return null
    const rows: GlossaryRow[] = []
    for (const r of data.rows) {
      const o = r as Record<string, unknown>
      const alias = typeof o?.alias === 'string' ? o.alias.trim() : ''
      const name = typeof o?.name === 'string' ? o.name.trim() : ''
      if (!alias || !name) continue
      rows.push({ alias, name, tools: typeof o?.tools === 'string' ? o.tools.trim() : undefined })
    }
    return rows
  } catch { return null }
}

export function registerAssistantConstraintsHandlers(): void {
  ipcMain.handle('assistantConstraints:ensureGlobal', () => ensureAssistantGlobalConstraints())
  ipcMain.handle('assistantConstraints:ensureSession', (_e, sessionId: unknown) => ensureAssistantSessionConstraints(sessionId))
  ipcMain.handle('assistantConstraints:ensureGlossary', () => ensureAssistantGlossary())
}
