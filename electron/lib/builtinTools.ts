import { randomUUID } from 'crypto'
import { readdirSync, lstatSync, readFileSync, statSync, mkdirSync } from 'fs'
import { join, relative, extname, sep, dirname } from 'path'
import { listTools, registerTool, getSettingReader, checkModulePermission } from './aiTools'
import { broadcastDataChanged, broadcast, BROADCAST_CHANNEL } from '../main/windowBus'
import { webSearch, webReadPage } from './webSearch'
import { writeVisual } from './aiTeachingSources'
import { broadcastTreeRefresh, ensureWriteOwnerFolder } from './aiTeachingFolders'
import type { ToolInvokeCtx } from './aiTools'
import { resolveSafe, detectConflict, writeWorkspaceFile, renameWorkspacePath, trashWorkspacePath, invalidateIndexIfCurrentVault } from './workspaceManager'
import { getCurrentVault } from './kbStore/vaultContext'
import { pomoSessionsAll } from './kbStore/pomoVaultRepo'
import { getKnowledgeIndex } from './kbStore/knowledgeIndex'
import { vaultGetPageById, vaultGetCategories, vaultCreatePage } from './kbStore/knowledgeVaultRepo'
import { searchKnowledge } from './knowledgeSearch'
import { searchHelp } from './helpService'
import { vaultCreateEntry } from './kbStore/blogVaultRepo'
import { vaultHabitsAll, vaultRecordsAll, vaultHabitRecordAddIfAbsent } from './kbStore/habitVaultRepo'
import { vaultTodosAll, vaultCreateTodo, vaultFindTodo, vaultUpdateTodo, vaultDeleteTodoCascade, type TodoRow } from './kbStore/scheduleVaultRepo'
// 日程「标记完成」要触发与 UI 完全相同的副作用：插件事件。
// 依赖方向已核：pluginEvents 的依赖树不反向 import 本模块，无循环。
import { emitPluginEvent } from './pluginEvents'
import { extractDocText } from './docsReader'
import {
  quizRecordList,
  quizRecordSetNote, quizRecordSetFavorite, quizRecordRemoveById,
  quizRecordAddTags, quizRecordSetTags, quizRecordSetCollections, quizRecordCollectionIds,
  quizTagList, quizTagResolveOrCreate,
  quizCollectionList, quizCollectionResolveOrCreate,
} from '../database/repositories/quizRepo'
import { bookSourceInfos } from './kbStore/bookSourceVaultRepo'
import { sanitizeBookSourcePatch, isAllowedSourceUrl, type BookSourceMapping } from './kbStore/bookMarketSchema'
import { quizDataStats } from './quizDataAdmin'
import { AI_TEXT_CODE_EXT_SET } from '../../src/lib/aiTextExts'
import type { ToolJsonSchema } from './aiTools'

/**
 * 内置 AI 工具清单：给 AgentRunner 与外部 MCP 客户端的稳定契约。
 * 原则：输出面向 LLM 的紧凑结构（控制 token），不是 UI 数据结构直通。
 *
 * ⚠️ 数据归属约定（R6 去库化收口）：
 * 全部模块数据已 vault/全局 JSON 化，工具一律走对应 kbStore vault repo
 * （与 UI 同一份磁盘数据），严禁直连 sqlite 旧表。
 * 统计口径与渲染层 habit-tracker/dateUtils.ts 同源（本地时区 YYYY-MM-DD、计划日跳过逻辑一致）。
 */

// ---- 习惯行按 sort_order ASC, created_at ASC（码位序）排序（P5c 消费方接线） ----
function sortHabitRows<T extends { sort_order?: number; created_at?: string }>(rows: T[]): T[] {
  const bin = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  return rows.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || bin(String(a.created_at ?? ''), String(b.created_at ?? '')))
}

// ---- 本地日期工具（与 src/modules/toolbox/components/habit-tracker/dateUtils.ts 语义一致） ----

function formatLocalDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  r.setDate(r.getDate() + n)
  return r
}

function todayLocal(): string {
  return formatLocalDate(new Date())
}

/** 定位首个命中词，取前后各 radius 字符的摘录 */
function buildExcerpt(plain: string, terms: string[], radius = 60): string {
  if (!plain) return ''
  const lower = plain.toLowerCase()
  let idx = -1
  for (const t of terms) {
    if (!t) continue
    idx = lower.indexOf(t.toLowerCase())
    if (idx >= 0) break
  }
  if (idx < 0) return ''
  const start = Math.max(0, idx - radius)
  const end = Math.min(plain.length, idx + radius)
  return (start > 0 ? '…' : '') + plain.slice(start, end).trim() + (end < plain.length ? '…' : '')
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

function parseDays(json: string): number[] {
  try {
    const v = JSON.parse(json)
    if (Array.isArray(v)) return v.map(Number)
  } catch { /* ignore */ }
  return [1, 2, 3, 4, 5]
}

/** habit 在 date 是否有打卡计划（flexible 视为每天可打卡） */
function isPlannedOn(ruleType: string, ruleDays: number[], d: Date): boolean {
  switch (ruleType) {
    case 'daily': return true
    case 'weekdays': return ruleDays.includes(d.getDay())
    case 'flexible': return true
    default: return true
  }
}

function currentStreak(ruleType: string, ruleDays: number[], done: Set<string>, today = new Date()): number {
  let streak = 0
  let d = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  if (isPlannedOn(ruleType, ruleDays, d) && !done.has(formatLocalDate(d))) d = addDays(d, -1)
  for (let i = 0; i < 3650; i++) {
    const ds = formatLocalDate(d)
    if (done.has(ds)) { streak++; d = addDays(d, -1); continue }
    if (!isPlannedOn(ruleType, ruleDays, d)) { d = addDays(d, -1); continue }
    break
  }
  return streak
}

function longestStreak(ruleType: string, ruleDays: number[], done: Set<string>, today = new Date()): number {
  const dates = [...done].sort()
  if (dates.length === 0) return 0
  let longest = 0
  let cur = 0
  const [y, m, dd] = dates[0].split('-').map(Number)
  let d = new Date(y, (m || 1) - 1, dd || 1)
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  while (d <= end) {
    const ds = formatLocalDate(d)
    if (done.has(ds)) { cur++; if (cur > longest) longest = cur }
    else if (isPlannedOn(ruleType, ruleDays, d)) cur = 0
    d = addDays(d, 1)
  }
  return longest
}

/** 区间完成率：计划日中已完成的占比（flexible 按打卡次数 / 天数计） */
function completionRate(ruleType: string, ruleDays: number[], done: Set<string>, daysWindow: number, today = new Date()): number {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const start = addDays(end, -(daysWindow - 1))
  let planned = 0
  let did = 0
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const ds = formatLocalDate(d)
    if (done.has(ds)) { planned++; did++ }
    else if (ruleType !== 'flexible' && isPlannedOn(ruleType, ruleDays, d)) planned++
  }
  if (planned === 0) return 0
  return Math.round((did / planned) * 100)
}

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']
function ruleSummary(ruleType: string, ruleDays: number[], weeklyTarget: number): string {
  if (ruleType === 'daily') return '每天'
  if (ruleType === 'flexible') return `每周 ${weeklyTarget} 次`
  const days = [...ruleDays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
  if (days.length === 0) return '未设置计划日'
  return '每周' + days.map(d => WEEKDAY_NAMES[d]).join('、')
}

// ===== vault.* 仓库文件工具（B1，F1 只读三件）：AI 视角文件系统 =====
// 可见性（2026-09-02 拍板）：仓库 .md/.txt 全可见；.knowbase/modules/*.json 只读可见（结构化数据）；
// .knowbase 其余（cache/config/plugins/密钥/_attachments 等）完全不可见；隐藏文件/目录不可见。
// 守卫复用 workspaceManager.resolveSafe（防越界/符号链接逃逸），越界与受限区一律拒。

const VAULT_DOT_DIR = '.knowbase'
const VAULT_MODULES_DIR = 'modules'
export const MAX_VAULT_FILE = 10 * 1024 * 1024 // read >10MB 拒
const MAX_VAULT_SEARCH_FILE = 1024 * 1024 // search 只扫 ≤1MB 文本
const MAX_VAULT_SEARCH_FILES = 400
export const MAX_VAULT_LIST_ENTRIES = 200

export function vaultRootPath(): string {
  const cur = getCurrentVault()
  if (!cur || !cur.rootPath) throw new Error('当前没有打开的仓库：请先在应用中打开知识仓库')
  return cur.rootPath
}

/** 取路径最后一段（兼容 / 与 \ 分隔，非文件系统语义，纯字符串） */
function baseNameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? p : p.slice(i + 1)
}

function vaultRelParts(root: string, abs: string): string[] {
  const rel = relative(root, abs)
  return rel ? rel.split(sep).filter(Boolean) : []
}

/** .knowbase/modules/.../<file>.json（AI 只读可见的结构化模块数据） */
function isModulesJson(parts: string[]): boolean {
  return parts.length >= 3 && parts[0] === VAULT_DOT_DIR && parts[1] === VAULT_MODULES_DIR &&
    parts[parts.length - 1].toLowerCase().endsWith('.json')
}

/** 子路径是否 AI 允许（目录枚举用）：点目录一律拒，.knowbase 仅 modules 子树放行 */
export function childAiAllowed(root: string, childAbs: string): boolean {
  const parts = vaultRelParts(root, childAbs)
  if (parts.length === 0) return false
  const first = parts[0]
  if (first.startsWith('.')) {
    if (first !== VAULT_DOT_DIR) return false
    return parts.length === 1 || parts[1] === VAULT_MODULES_DIR
  }
  return true
}

/** 读白名单：.md/.txt/文本类代码文件（可见区任意处）+ .json（仅 .knowbase/modules）。
 *  代码扩展名走单一真相源 src/lib/aiTextExts.ts（素材库 / 前端同源；配置类 json/yml/yaml/toml/ini 不放开） */
export function isAiReadableFile(root: string, abs: string): boolean {
  const parts = vaultRelParts(root, abs)
  if (parts.length === 0) return false
  if (!childAiAllowed(root, abs)) return false
  const ext = extname(abs).slice(1).toLowerCase()
  if (ext === 'json') return isModulesJson(parts)
  if (ext === 'md' || ext === 'txt') return true
  return AI_TEXT_CODE_EXT_SET.has(ext)
}

/** 搜索遍历忽略的目录（v3.2.0 条目 9）：依赖/产物目录会吃光 400 个文件预算 → search 静默失效。
 *  只影响 search 遍历；AI 明确给出路径时 vault.read 仍可读这些目录内的文件 */
const SEARCH_IGNORE_DIRS = new Set(['node_modules', 'dist', 'out', 'build'])

/** 递归收集可搜索文本文件（.knowbase 只深入 modules；隐藏区跳过；依赖/产物目录忽略；数量预算封顶） */
function walkAiFiles(root: string, dirAbs: string, out: string[], budget: { count: number }): void {
  if (budget.count >= MAX_VAULT_SEARCH_FILES) return
  let names: string[] = []
  try { names = readdirSync(dirAbs) } catch { return }
  for (const name of names) {
    if (budget.count >= MAX_VAULT_SEARCH_FILES) return
    const full = join(dirAbs, name)
    if (!childAiAllowed(root, full)) continue
    let st: ReturnType<typeof lstatSync>
    try { st = lstatSync(full) } catch { continue }
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) {
      if (!SEARCH_IGNORE_DIRS.has(name.toLowerCase())) walkAiFiles(root, full, out, budget)
      continue
    }
    if (!st.isFile()) continue
    if (st.size > MAX_VAULT_SEARCH_FILE) continue
    if (!isAiReadableFile(root, full)) continue
    budget.count++
    out.push(full)
  }
}

/** 写白名单（B2）：普通可见区 .md/.txt；.knowbase 全面禁写（modules/*.json 只读、cache/config 等本就不可见） */
export function isAiWritableFile(root: string, abs: string): boolean {
  const parts = vaultRelParts(root, abs)
  if (parts.length === 0) return false
  if (parts[0].startsWith('.')) return false // 含 .knowbase：任何写操作都拒
  const ext = extname(abs).slice(1).toLowerCase()
  return ext === 'md' || ext === 'txt'
}

/** 文档白名单（docs.read-text）：普通可见区 .pdf/.pptx（.knowbase 内部暂不开放） */
export function isAiDocFile(root: string, abs: string): boolean {
  const parts = vaultRelParts(root, abs)
  if (parts.length === 0) return false
  if (parts[0].startsWith('.')) return false
  const ext = extname(abs).slice(1).toLowerCase()
  return ext === 'pdf' || ext === 'pptx'
}

/** 写前守卫：writable 判定 + 大小 + mtime 冲突（expectedMtimeMs 来自 vault.read 基线） */
export function assertAiWritable(root: string, abs: string, expectedMtimeMs: unknown): void {
  if (!isAiWritableFile(root, abs)) {
    throw new Error('该位置不可写：AI 仅可新建/修改仓库内普通 .md/.txt 文件（.knowbase 内部数据只读保护）')
  }
  let existing = false
  let size = 0
  try { const st = statSync(abs); existing = st.isFile(); size = st.size } catch { /* 新建 */ }
  if (existing && size > MAX_VAULT_FILE) throw new Error(`文件过大（${size} 字节 > 10MB），拒绝写入: ${abs}`)
  const expected = Number(expectedMtimeMs)
  if (existing && Number.isFinite(expected) && expected > 0) {
    const c = detectConflict(abs, expected)
    if (c.conflict) {
      throw new Error(`文件已被外部修改（磁盘 mtime ${Math.round(c.diskMtimeMs ?? 0)} 与基线不符）。请先 vault.read 重取最新内容再写入`)
    }
  }
}

/** 写入成功后广播「外部变更」（编辑器若正打开该文件会弹三选），沿用 plugin:installed-changed 模式 */
function broadcastExternalWrite(relPath: string, mtimeMs?: number): void {
  try {
    // v3.1.2 收敛：不再内联 for + require('electron')，走 windowBus 统一出口
    broadcast(BROADCAST_CHANNEL.wsExternalChange, { relPath, mtimeMs })
  } catch { /* 广播失败不影响写入结果 */ }
}

/**
 * v3.1.2 条目9：AI 落盘后的编辑区树联动（此前只有 organizeDoc / writeVisual 做对了）。
 * vault.write / edit / rename / trash 的成功分支统一调用——广播**受影响文件的父目录**，
 * 编辑区树与 AI教学自绘树据此重拉，新建/改名/删除的文件无需模块重挂载或手动展开目录即刻出现。
 * @param rel     变更后的仓库相对路径（trash 传原路径）
 * @param prevRel rename 专用：源路径的父目录也要刷新（旧条目消失）
 */
function notifyVaultTreeChange(rel: string, prevRel?: string): void {
  const parentOf = (p: string): string => {
    const norm = p.replace(/\\/g, '/')
    const i = norm.lastIndexOf('/')
    return i > 0 ? norm.slice(0, i) : ''
  }
  try {
    broadcastTreeRefresh(parentOf(rel))
    if (prevRel) broadcastTreeRefresh(parentOf(prevRel))
  } catch { /* 联动失败不影响写入结果 */ }
}

/**
 * v3.1.2 条目10：AI 教学会话的产物落点归一化（工具层兜底，防模型不听话）。
 *
 * 判据（两条任一命中即改写为 `{本会话文件夹}/{basename}`）：
 *  ① 无目录前缀 —— 裸文件名会直接落仓库顶层（用户实际报障现象）；
 *  ② 首段为 `SOURCES` —— 那是给 AI 读的素材目录，不放产物。
 * 其余路径（含模型/AI 给出的工作区夹内路径）原样保留；**非教学会话或会话夹不可解析时不改写**
 * （侧边助手/轻问答没有会话夹概念，强加归一化只会制造怪路径）。
 * 语义是纯函数（同一 path 反复调用结果一致），不打乱 prompt cache 前缀；会话夹不存在 = 懒建。
 */
function normalizeAiTeachingWritePath(rel: string, ctx?: ToolInvokeCtx): string {
  if (!ctx || ctx.source !== 'aiTeaching') return rel
  const sid = String(ctx.sessionId ?? '')
  if (!sid) return rel
  const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  const segs = norm.split('/').filter(Boolean)
  if (!segs.length) return rel
  const hasDir = segs.length > 1
  const hitsSources = (segs[0] ?? '').toUpperCase() === 'SOURCES'
  if (hasDir && !hitsSources) return rel
  try {
    const probe = ensureWriteOwnerFolder(sid, getSettingReader())
    if (!probe.ok || !probe.relPath) return rel
    return `${probe.relPath}/${segs[segs.length - 1]}`
  } catch { return rel }
}

// ===== 六个内置工具 =====

const SEARCH_LIMIT_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '检索词，空格分词（自然语言问句亦可，语义检索可用时按含义召回）' },
    limit: { type: 'number', description: '上限, 默认8' },
    mode: { type: 'string', enum: ['auto', 'keyword', 'semantic'], description: '检索方式：auto=可用则混合（默认）/ keyword=仅关键词 / semantic=仅语义' },
  },
  required: ['query'],
} satisfies ToolJsonSchema

// ---- 日程 AI 写工具的参数归一化（纯函数，供 .AGENT/scripts 抽取验证） ----

/** 待办状态白名单（与 UI 待办勾选同口径：pending ↔ done） */
const TODO_STATUSES = ['pending', 'done'] as const
/** 任务类型白名单（与 create-todo / TodoRow.task_type 同口径） */
const TODO_TASK_TYPES = ['plan', 'deadline', 'daily'] as const

/**
 * 把 `schedule.update-todo` 的入参归一化为交给 repo 的 patch（camelCase，
 * 列白名单由 vaultUpdateTodo 负责，本函数不重复一份字段映射 —— AGENTS.md#14）。
 *
 * 纯函数：只依赖入参 + 该行当前 task_type，不读盘、无副作用。
 *
 * 不变量（与 create-todo 同口径，防脏数据）：
 * - `time`（截止时刻）只对 deadline 类有意义 —— 非 deadline 即使误传也置 null；
 *   本次把 taskType 改成非 deadline 时，顺带清掉行上残留的旧截止时刻
 * - `scheduledStart/End` 是「当天分钟数」0..1440（1440 = 24:00 收尾），非整数/越界直接拒
 * - `status` / `taskType` 只接受白名单值，避免 AI 手滑写成 'complete' 之类
 * - `description` / `endCriteria` 的处理保留在此（口径统一、便于将来放开 schema），
 *   但 update-todo 的 inputSchema **不暴露**这两列：list-todos 不回传它们，
 *   AI 看不到现值，放行就是盲改覆盖用户写过的内容（静默数据丢失）
 * 抛错 = 参数非法，调用方原样回给模型（exec.ok=false），不落盘。
 */
export function normalizeTodoPatch(args: Record<string, unknown>, currentTaskType: string): Record<string, unknown> {
  const patch: Record<string, unknown> = {}

  if (args.title !== undefined) {
    const t = str(args.title).trim()
    if (!t) throw new Error('title 不能为空字符串')
    patch.title = t
  }
  // description / endCriteria 允许空串（= 清空该项）
  for (const key of ['description', 'endCriteria'] as const) {
    if (args[key] === undefined) continue
    if (typeof args[key] !== 'string') throw new Error(`${key} 必须是字符串`)
    patch[key] = args[key]
  }
  if (args.date !== undefined) {
    const d = str(args.date).trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('date 必须是 YYYY-MM-DD')
    patch.date = d
  }
  if (args.quadrant !== undefined) {
    if (typeof args.quadrant !== 'number' || !Number.isFinite(args.quadrant)) throw new Error('quadrant 必须是 0..3 的数字')
    patch.quadrant = clamp(Math.floor(args.quadrant), 0, 3)
  }
  if (args.status !== undefined) {
    const s = str(args.status).trim()
    if (!(TODO_STATUSES as readonly string[]).includes(s)) throw new Error(`status 只支持 ${TODO_STATUSES.join(' / ')}`)
    patch.status = s
  }
  if (args.taskType !== undefined) {
    const t = str(args.taskType).trim()
    if (!(TODO_TASK_TYPES as readonly string[]).includes(t)) throw new Error(`taskType 只支持 ${TODO_TASK_TYPES.join(' / ')}`)
    patch.taskType = t
  }
  if (args.tagId !== undefined) {
    // null / 空串 = 清掉标签（与 UI 的 tagId: null 同口径）
    const t = args.tagId === null ? '' : str(args.tagId).trim()
    patch.tagId = t || null
  }
  for (const key of ['scheduledStart', 'scheduledEnd'] as const) {
    if (args[key] === undefined) continue
    const v = args[key]
    if (v === null) { patch[key] = null; continue }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1440) {
      throw new Error(`${key} 必须是 0..1440 的整数分钟数（09:00 = 540；null = 取消排期）`)
    }
    patch[key] = v
  }

  // 截止时刻：只对 deadline 类有意义（与 create-todo 的 finalTime 同口径）
  const effectiveTaskType = (patch.taskType as string | undefined) ?? currentTaskType
  if (args.time !== undefined) {
    const raw = str(args.time).trim().replace('T', ' ')
    if (!raw) {
      patch.time = null
    } else {
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw)) throw new Error("time 必须是完整时刻 'YYYY-MM-DD HH:mm'")
      patch.time = effectiveTaskType === 'deadline' ? raw : null
    }
  } else if (patch.taskType !== undefined && effectiveTaskType !== 'deadline') {
    // 类型改成非 deadline：清掉旧截止时刻，避免 UI 继续按一个语义已失效的时刻排序/提醒
    patch.time = null
  }

  if (Object.keys(patch).length === 0) {
    throw new Error('没有可修改的字段：至少传一个（title/description/date/time/quadrant/taskType/tagId/status/endCriteria/scheduledStart/scheduledEnd）')
  }
  return patch
}

/**
 * 删除前摘出被删行摘要（标题/日期/时段 + 将被子任务数）—— 误删后的重建线索。
 * 纯函数：vaultDeleteTodoCascade 是**级联删除且无回收站快照**，行一删就再也读不回来，
 * 所以摘要必须在删除前算好并回给模型。
 */
export function summarizeDeletedTodos(target: TodoRow, rows: TodoRow[]): {
  id: string; title: string; date: string; time: string
  scheduledStart: number | null; scheduledEnd: number | null; subtasks: number
} {
  const subtasks = rows.filter(r => r.parent_id === target.id).length
  return {
    id: target.id,
    title: target.title,
    date: target.date,
    time: target.time ?? '',
    scheduledStart: target.scheduled_start ?? null,
    scheduledEnd: target.scheduled_end ?? null,
    subtasks,
  }
}

export function registerBuiltinTools(): void {

  // 1. builtin.knowledge.search —— 知识库混合检索（关键词 + 语义，knowledge-index-design §9）
  registerTool({
    name: 'builtin.knowledge.search',
    title: '搜索知识库页面',
    description: '搜索知识库页面，返回 id/标题/摘录/相关度。配好嵌入模型后支持语义检索（问句/换述也能命中），结果 via 字段标注命中方式',
    inputSchema: SEARCH_LIMIT_SCHEMA,
    source: 'builtin',
    enabled: true,
    readOnly: true,
    module: 'knowledge',
  }, async args => {
    const q = str(args.query).trim()
    const limit = clamp(Math.floor(num(args.limit, 8)), 1, 50)
    const mode = args.mode === 'keyword' || args.mode === 'semantic' ? args.mode : 'auto'
    if (!q) return []
    // 与知识库 UI 同一份磁盘 .md（vault 唯一真相源）；未配嵌入模型时 auto 自动降级纯关键词
    try {
      const r = await searchKnowledge({ query: q, topK: limit, mode })
      return r.hits.map(h => ({
        id: h.pageId,
        title: h.title,
        excerpt: h.excerpt || h.title,
        updatedAt: h.updatedAt,
        score: h.score,
        via: h.via,
      }))
    } catch (err) {
      throw new Error(`知识库搜索失败（仓库未就绪？）：${String((err as Error)?.message ?? err)}`)
    }
  })

  // 2. builtin.knowledge.read 已退役（2026-09-09 P2）：vault.read(path|id) 收编（id=knowledge.search 返回的页面 id）

  // 3. builtin.habits.list 已退役（2026-09-09 P1）：并入 habits.stats(mode='list')

  // 4. builtin.habits.stats —— 习惯查询与统计（P1 收编原 habits.list：mode 二选一）
  registerTool({
    name: 'builtin.habits.stats',
    title: '习惯查询与统计',
    description: "mode='list' 列出全部习惯与今日打卡状态；mode='stats'（默认）习惯连续天数/最长连续/完成率/累计次数",
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['stats', 'list'], description: 'stats=统计（默认）/ list=列表' },
        habitId: { type: 'string', description: '习惯 id, 缺省全部' },
        days: { type: 'number', description: '统计窗口天数, 默认30（仅 stats 用）' },
      },
    },
    source: 'builtin',
    enabled: true,
    readOnly: true,
    module: 'checkin',
  }, args => {
    // list 模式（原 habits.list 输出）：全部习惯与今日打卡状态
    if (str(args.mode, 'stats') === 'list') {
      const today = formatLocalDate(new Date())
      const checkedToday = new Set(vaultRecordsAll().filter(r => r.date === today).map(r => r.habit_id))
      return sortHabitRows(vaultHabitsAll()).map(h => {
        const ruleType = str(h.rule_type, 'daily')
        const ruleDays = parseDays(str(h.rule_days, '[]'))
        return {
          id: h.id,
          name: h.name,
          rule: ruleSummary(ruleType, ruleDays, num(h.weekly_target, 3)),
          plannedToday: !h.archived && isPlannedOn(ruleType, ruleDays, new Date()),
          checkedToday: checkedToday.has(h.id),
          archived: !!h.archived,
        }
      })
    }
    // stats（默认）：连续天数/最长连续/完成率/累计次数
    const windowDays = clamp(Math.floor(num(args.days, 30)), 1, 365)
    const wantedIds = typeof args.habitId === 'string' && args.habitId ? [args.habitId] : null
    const statHabits = sortHabitRows(vaultHabitsAll()).filter(h => !wantedIds || wantedIds.includes(h.id))
    if (wantedIds && statHabits.length === 0) throw new Error(`习惯不存在: ${str(args.habitId)}`)
    const allRecords = vaultRecordsAll()
    return statHabits.map(h => {
      const done = new Set<string>()
      for (const rec of allRecords) {
        if (rec.habit_id === h.id) done.add(rec.date)
      }
      const ruleType = str(h.rule_type, 'daily')
      const ruleDays = parseDays(str(h.rule_days, '[]'))
      return {
        id: str(h.id),
        name: str(h.name),
        rule: ruleSummary(ruleType, ruleDays, num(h.weekly_target, 3)),
        currentStreak: currentStreak(ruleType, ruleDays, done),
        longestStreak: longestStreak(ruleType, ruleDays, done),
        completionRatePct: completionRate(ruleType, ruleDays, done, windowDays),
        totalCount: done.size,
        windowDays,
      }
    })
  })

  // 5-6. builtin.habits.list / builtin.bookmarks.search 已退役（2026-09-09 P1）：
  //     habits.list → habits.stats(mode='list')；bookmarks.search → vault.search（书签 JSON 本身结构化且 modules 子树可搜）

  // 6. builtin.pomodoro.summary —— 近 N 天专注统计
  registerTool({
    name: 'builtin.pomodoro.summary',
    title: '番茄钟专注统计',
    description: '近 N 天每日专注分钟与场次',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '最近天数, 默认7' },
      },
    },
    source: 'builtin',
    enabled: true,
    readOnly: true,
    module: 'pomodoro',
  }, args => {
    const days = clamp(Math.floor(num(args.days, 7)), 1, 365)
    const end = new Date()
    const start = addDays(end, -(days - 1))
    // R6 去库化：pomodoro 场次读 .knowbase/modules/pomodoro/sessions.json
    const sessions = pomoSessionsAll().filter((r) => r.date >= formatLocalDate(start) && r.date <= formatLocalDate(end))
    const byDate = new Map<string, { sessions: number; minutes: number }>()
    for (const r of sessions) {
      const hit = byDate.get(r.date) ?? { sessions: 0, minutes: 0 }
      hit.sessions += 1
      hit.minutes += Number(r.minutes) || 0
      byDate.set(r.date, hit)
    }
    const out: { date: string; minutes: number; sessions: number }[] = []
    let totalMinutes = 0
    let totalSessions = 0
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const ds = formatLocalDate(d)
      const hit = byDate.get(ds)
      const minutes = hit ? num(hit.minutes, 0) : 0
      const sessions = hit ? num(hit.sessions, 0) : 0
      out.push({ date: ds, minutes, sessions })
      totalMinutes += minutes
      totalSessions += sessions
    }
    return { windowDays: days, totalMinutes, totalSessions, days: out }
  })

  // 7. builtin.schedule.list-todos —— 日程待办查询（读）
  registerTool({
    name: 'builtin.schedule.list-todos',
    title: '查询日程待办',
    description: '按日期区间查询待办',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: '开始日期 YYYY-MM-DD，默认今天' },
        end: { type: 'string', description: '结束日期 YYYY-MM-DD，默认与 start 相同' },
      },
    },
    source: 'builtin',
    enabled: true,
    readOnly: true,
    module: 'schedule',
  }, args => {
    const start = /^\d{4}-\d{2}-\d{2}$/.test(str(args.start)) ? str(args.start) : todayLocal()
    const end = /^\d{4}-\d{2}-\d{2}$/.test(str(args.end)) ? str(args.end) : start
    // 读 .knowbase/modules/schedule/todos.json（date BETWEEN + 排序 + LIMIT 100 同 SQL）
    const rows = vaultTodosAll()
      .filter(r => typeof r.date === 'string' && r.date >= start && r.date <= end)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.sort_order ?? 0) - (b.sort_order ?? 0)))
      .slice(0, 100)
    const QUADRANT = ['紧急重要', '重要不紧急', '紧急不重要', '不重要不紧急']
    return rows.map(r => {
      const q = num(r.quadrant, 1)
      return {
        id: r.id,
        title: r.title,
        date: r.date,
        time: r.time ?? '',
        quadrant: q,
        quadrantLabel: QUADRANT[q] ?? '重要不紧急',
        status: str(r.status, 'pending'),
        // 以下 5 项是 schedule.update-todo 的「编辑正确性」前提（2026-09-13 补齐）：
        // 看不到已占时段 → 排新任务会撞车；看不到 parentId → 会误编辑/误删子任务；
        // 看不到 taskType → 分不清 time 字段（deadline 才带）是否还有语义；
        // 看不到 tagId → create/update 的 tagId 参数根本没有取值来源。
        taskType: str(r.task_type, 'plan'),
        tagId: r.tag_id ?? null,
        scheduledStart: r.scheduled_start ?? null,
        scheduledEnd: r.scheduled_end ?? null,
        parentId: r.parent_id ?? null,
      }
    })
  })

  // ===== 以下为写入类工具（requires:'write'，受模块权限开关控制，操作真实生效并留审计） =====

  // 8. builtin.knowledge.create-page
  registerTool({
    name: 'builtin.knowledge.create-page',
    title: '创建知识库页面',
    description: '新建知识库页面(可指定分类名)',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '标题' },
        contentMd: { type: 'string', description: 'Markdown 正文' },
        categoryName: { type: 'string', description: '分类名(精确, 可选)' },
      },
      required: ['title', 'contentMd'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: false,
    requires: 'write',
    tier: 'ondemand',
    module: 'knowledge',
  }, args => {
    const title = str(args.title).trim()
    const contentMd = str(args.contentMd)
    if (!title) throw new Error('标题不能为空')
    let categoryId: string | null = null
    const catName = str(args.categoryName).trim()
    if (catName) {
      const cat = vaultGetCategories().find(c => c.name === catName && c.categoryType !== 'space')
      if (!cat) throw new Error(`未找到分类「${catName}」，可省略 categoryName 存入未分类`)
      categoryId = cat.id
    }
    // 受控写层：与 UI 同一份磁盘 .md（frontmatter id 由 repo 生成并登记索引）
    const page = vaultCreatePage({ title, contentMd, categoryId })
    // 与 vault.write 同规则：.md 落盘即失效索引（页面立刻进入列表/图谱/AI 检索），
    // 并广播通知渲染层重取 —— 知识库是保活模块，不通知就看不到（2026-09-10 修）
    invalidateIndexIfCurrentVault(getCurrentVault()?.rootId ?? '')
    broadcastDataChanged('knowledge')
    notifyVaultTreeChange(page.path) // v3.1.2 条目9：页面落在可见分类目录，编辑区树同步刷新
    return { ok: true, id: page.id, title }
  })

  // 9. builtin.knowledge.append-page 已退役（2026-09-09 P2）：vault.edit(append=true) 收编
  //    （先 knowledge.search 或 vault.read(id=) 定位页面 path，再 vault.edit append）

  // 10. builtin.blog.create-entry
  registerTool({
    name: 'builtin.blog.create-entry',
    title: '写一篇日记',
    description: '新建日记(日期默认今天,每天一篇)',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '日记标题（可为空字符串）' },
        contentMd: { type: 'string', description: 'Markdown 正文' },
        date: { type: 'string', description: 'YYYY-MM-DD, 默认今天' },
      },
      required: ['contentMd'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: false,
    requires: 'write',
    tier: 'ondemand',
    module: 'blog',
  }, args => {
    const contentMd = str(args.contentMd)
    if (!contentMd.trim()) throw new Error('正文不能为空')
    const date = /^\d{4}-\d{2}-\d{2}$/.test(str(args.date)) ? str(args.date) : todayLocal()
    // 与 UI 同一份 .knowbase/blog/*.md（vaultCreateEntry 自带每天一篇防重）
    const e = vaultCreateEntry({ title: str(args.title).trim(), contentMd, date })
    if (e.contentMd !== contentMd) throw new Error(`${date} 已存在日记（应用限制每天一篇），可改用其他日期`)
    // 同 knowledge.create-page：日记也是仓库内 .md，落盘即失效索引并通知博客列表重取
    invalidateIndexIfCurrentVault(getCurrentVault()?.rootId ?? '')
    broadcastDataChanged('blog')
    return { ok: true, id: e.id, date }
  })

  // 11. builtin.schedule.create-todo
  registerTool({
    name: 'builtin.schedule.create-todo',
    title: '创建日程待办',
    description: '创建待办',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD, 默认今天' },
        title: { type: 'string', description: '待办内容' },
        quadrant: { type: 'number', description: '0紧急重要/1重要不紧急/2紧急不重要/3不重要, 默认1' },
        taskType: { type: 'string', enum: ['plan', 'deadline', 'daily'], description: "任务类型：plan 计划 / deadline 截止类 / daily 零碎当天完成，默认 plan" },
        time: { type: 'string', description: "截止时刻，完整格式 'YYYY-MM-DD HH:mm'（deadline 类才带）；仅当文本里识别出明确时间承诺才传，否则不传、不编造" },
        tagId: { type: 'string', description: '标签 ID（来自 schedule:getTags 或列表结果），可选' },
        scheduledStart: { type: 'number', description: '排期起点（当天分钟数 0-1439，如 09:00=540），配合 date 与 scheduledEnd 落格；可选' },
        scheduledEnd: { type: 'number', description: '排期终点（当天分钟数），可选' },
      },
      required: ['title'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: false,
    requires: 'write',
    tier: 'ondemand',
    module: 'schedule',
  }, args => {
    const title = str(args.title).trim()
    if (!title) throw new Error('待办内容不能为空')
    const date = /^\d{4}-\d{2}-\d{2}$/.test(str(args.date)) ? str(args.date) : todayLocal()
    const quadrant = clamp(Math.floor(num(args.quadrant, 1)), 0, 3)
    const taskType = (['plan', 'deadline', 'daily'] as const).includes(str(args.taskType) as 'plan' | 'deadline' | 'daily')
      ? (str(args.taskType) as 'plan' | 'deadline' | 'daily')
      : 'plan'
    // 修正真 bug：旧校验 /^\d{1,2}:\d{2}$/ 只认 HH:mm，但 ScheduleTodo.time 实际是 'YYYY-MM-DD HH:mm'，
    // 放开 AI 写 DDL 会立刻产出畸形数据（各处取得时分用的是 slice(11,13)/slice(14,16)）。
    const rawTime = str(args.time).trim()
    const time = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(rawTime) ? rawTime.replace('T', ' ') : null
    // 截止时刻只在 deadline 类带；其他类型即便误传也丢弃，避免脏数据
    const finalTime = taskType === 'deadline' ? time : null
    const tagId = str(args.tagId).trim() ? str(args.tagId).trim() : null
    const scheduledStart = typeof args.scheduledStart === 'number' && Number.isFinite(args.scheduledStart) ? args.scheduledStart : null
    const scheduledEnd = typeof args.scheduledEnd === 'number' && Number.isFinite(args.scheduledEnd) ? args.scheduledEnd : null
    const id = randomUUID()
    // 写 .knowbase/modules/schedule/todos.json（默认值同表列：plan/pending/sort 0）
    const now = new Date().toISOString()
    vaultCreateTodo({
      id, title, description: '', date, time: finalTime, quadrant,
      task_type: taskType, tag_id: tagId, status: 'pending', sort_order: 0,
      end_criteria: '', parent_id: null,
      // AI 建的任务默认不排期（除非显式传 scheduledStart/End），落进「待安排」栏等着被拖进日程表
      scheduled_start: scheduledStart, scheduled_end: scheduledEnd,
      snooze_until: null,
      created_at: now, updated_at: now,
    })
    // 主进程写盘后必须主动广播：日程模块是保活的（切 Tab 不重载），
    // 不通知就只能靠切月份/重启才能看到（2026-09-10 修）
    broadcastDataChanged('schedule')
    return { ok: true, id, date, quadrant }
  })

  // 11b. builtin.schedule.update-todo —— 按 id 编辑待办（改期/改时段/改象限/标记完成）
  //      补写闭环：此前 AI 只有 list-todos(读) + create-todo(写)，建错了改不了、只能人工修。
  registerTool({
    name: 'builtin.schedule.update-todo',
    title: '修改日程待办',
    description: '按 id 修改待办：改标题/日期/截止时刻/象限/任务类型/标签/完成状态/排期时段。id 必须先由 list-todos 取到。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '待办 id' },
        title: { type: 'string', description: '标题' },
        date: { type: 'string', description: '日期 YYYY-MM-DD' },
        time: { type: 'string', description: "截止时刻 'YYYY-MM-DD HH:mm'，仅 deadline 类" },
        quadrant: { type: 'number', description: '象限 0紧急重要/1重要不紧急/2紧急不重要/3不紧急不重要' },
        taskType: { type: 'string', enum: ['plan', 'deadline', 'daily'], description: '任务类型' },
        tagId: { type: 'string', description: '标签 id，空串=清空' },
        status: { type: 'string', enum: ['pending', 'done'], description: 'pending 未完成 / done 已完成' },
        scheduledStart: { type: 'number', description: '排期起点（当天分钟数，09:00=540）' },
        scheduledEnd: { type: 'number', description: '排期终点（当天分钟数）' },
        // 刻意不暴露 description / end_criteria：list-todos 不回传这两列，
        // AI 看不到现值 → 允许改就是「盲改覆盖用户写过的备注」，属静默数据丢失。
        // （单工具 schema 有 800 字符红线，AGENTS.md#16；这两项省下的正好也是大头）
      },
      required: ['id'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: false,
    requires: 'write',
    tier: 'ondemand',
    module: 'schedule',
  }, args => {
    const id = str(args.id).trim()
    if (!id) throw new Error('缺少必填参数: id')
    const existing = vaultFindTodo(id)
    if (!existing) throw new Error(`未找到待办 id=${id}：请先用 list-todos 确认（id 可能已被删除或本就输错）`)
    // 归一化交给纯函数（含「非 deadline 不带截止时刻」「排期分钟数范围」等不变量），
    // 字段白名单由 vaultUpdateTodo 兜底 —— 这里不重复一份映射表
    const patch = normalizeTodoPatch(args, existing.task_type)
    const updated = vaultUpdateTodo(id, patch, new Date().toISOString())
    if (!updated) throw new Error(`待办 id=${id} 更新失败（写入期间已被删除？）`)
    // 与 UI 的 schedule:updateTodo 同口径：只有 pending → done 才算「完成」事件。
    // 漏了这步的后果是「AI 标记完成的任务，插件收不到 schedule:todoCompleted」。
    if (existing.status !== 'done' && updated.status === 'done') {
      emitPluginEvent('schedule:todoCompleted', { todoId: id, title: updated.title ?? '' })
    }
    // 主进程写盘后必须广播：日程模块保活（切 Tab 不重载），不通知界面看不到
    broadcastDataChanged('schedule')
    return { ok: true, id, title: updated.title, date: updated.date, status: updated.status, fields: Object.keys(patch) }
  })

  // 11c. builtin.schedule.delete-todo —— 按 id 删除待办（级联删子任务，无回收站）
  registerTool({
    name: 'builtin.schedule.delete-todo',
    title: '删除日程待办',
    description: '按 id 删除待办（不可恢复，且会连同其全部子任务一起删除）。必须先 list-todos 确认 id 与标题相符再调用，禁止凭记忆或推测删除。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '待办 id（来自 list-todos）' },
      },
      required: ['id'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: false,
    requires: 'write',
    tier: 'ondemand',
    module: 'schedule',
  }, args => {
    const id = str(args.id).trim()
    if (!id) throw new Error('缺少必填参数: id')
    const rows = vaultTodosAll()
    const target = rows.find(r => r.id === id)
    if (!target) throw new Error(`未找到待办 id=${id}：请先用 list-todos 确认（可能已被删除，不要重复删除）`)
    // 摘要必须在删除前算：cascade 删完行就没了，且 UI 的 schedule:deleteTodo 同样无回收站快照
    const summary = summarizeDeletedTodos(target, rows)
    vaultDeleteTodoCascade(id)
    broadcastDataChanged('schedule')
    return { ok: true, ...summary }
  })

  // 12. builtin.checkin.check-habit
  registerTool({
    name: 'builtin.checkin.check-habit',
    title: '习惯打卡',
    description: '按名称为今天打卡(支持部分匹配,幂等)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '习惯名(可部分匹配)' },
      },
      required: ['name'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: false,
    requires: 'write',
    tier: 'ondemand',
    module: 'checkin',
  }, args => {
    const q = str(args.name).trim().toLowerCase()
    if (!q) throw new Error('习惯名称不能为空')
    const date = todayLocal()
    // 查/写 .knowbase/modules/checkin/*.json（幂等=UNIQUE(habit_id,date) 语义）
    const hs = sortHabitRows(vaultHabitsAll().filter(h => !h.archived))
    const hit = hs.find(h => h.name.toLowerCase() === q) ?? hs.find(h => h.name.toLowerCase().includes(q))
    if (!hit) throw new Error(`未找到匹配的习惯「${str(args.name)}」`)
    const isNew = vaultHabitRecordAddIfAbsent(hit.id, date, 'manual')
    // 真的新增了才广播（已打卡是幂等空操作，数据未变无需刷新）
    if (isNew) broadcastDataChanged('habit')
    return isNew
      ? { ok: true, habitId: hit.id, name: hit.name, checked: true }
      : { ok: true, habitId: hit.id, name: hit.name, alreadyChecked: true }
  })

  // 13. builtin.web.search —— 联网搜索（跨模块通用能力，不设 module：不受 aiModulePermissions 限制）
  registerTool({
    name: 'builtin.web.search',
    title: '联网搜索',
    description: '搜索互联网（DuckDuckGo / Bing），返回标题/链接/摘要。用于需要时效性信息、本地知识库之外的内容、或用户询问实时事实时',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，越具体越好（可带引号或日期）' },
        limit: { type: 'number', description: '返回条数，默认 8，最大 20' },
      },
      required: ['query'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: true,
    // 不设 module：联网搜索不归属任何业务模块
  }, async args => {
    const q = str(args.query)
    const limit = clamp(Math.floor(num(args.limit, 8)), 1, 20)
    const { source, results } = await webSearch(q, limit)
    return { source, count: results.length, results }
  })

  // 14. builtin.help.search —— Phrontis 官方手册检索（跨模块通用，不设 module）
  //     背景：帮助文档原先只在渲染层 bundle 里，AI 完全读不到 → 答不了「知识库为什么看不到我的文件」。
  //     迁到 resources/help 后由本工具按需检索（见 docs/ai-learn-center-design.md §7.5）。
  registerTool({
    name: 'builtin.help.search',
    title: '检索 Phrontis 使用手册',
    description: '检索本软件（Phrontis）的官方使用手册。当用户询问「这个软件怎么用 / 某功能在哪 / 为什么某个行为不符合预期 / 怎么备份 / 权限怎么设 / 快捷键是什么」这类关于软件自身的问题时，先调用本工具查手册再回答，不要凭猜测描述软件行为。也可用 id 参数直接读取某一篇全文',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词，用用户的原话即可（如「知识库看不到文件」「怎么备份」）；指定 id 读全文时传任意非空串占位' },
        limit: { type: 'number', description: '返回条数，默认 3，最大 5' },
        id: { type: 'string', description: '可选：手册 id 或标题，直接返回该篇全文（如「快速上手」）' },
      },
      required: ['query'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: true,
    // 不设 module：手册检索是跨模块通用能力，不受 aiModulePermissions 限制
  }, args => {
    const q = str(args.query)
    if (!q) throw new Error('缺少必填参数: query')
    const id = str(args.id).trim() || undefined
    const limit = clamp(Math.floor(num(args.limit, 3)), 1, 5)
    const { hits, total, hint } = searchHelp(q, limit, id)
    return { count: hits.length, totalDocs: total, hits, ...(hint ? { hint } : {}) }
  })

  // ===== P3 装载层元工具：写类（tier='ondemand'）默认不在视野，需申请启用 =====

  // builtin.tool.request —— 申请启用按需工具（本会话内持久；启用集合由 agentService 按会话维护）
  registerTool({
    name: 'builtin.tool.request',
    title: '申请启用扩展工具',
    description: "写入类工具（vault.write / vault.edit / vault.rename / vault.trash / knowledge.create-page / blog.create-entry / schedule.create-todo / schedule.update-todo / schedule.delete-todo / checkin.check-habit / quiz.set-note / quiz.tag / quiz.collect / quiz.favorite / quiz.remove / quiz.gen-paper / booksource.draft）默认不在工具列表中。需要执行写操作时调用本工具申请（逗号分隔工具名），确认后本会话内持续可用。只申请确实需要的，不要一次全申请",
    inputSchema: {
      type: 'object',
      properties: {
        tools: { type: 'string', description: "逗号分隔的工具注册名，如 'builtin.vault.write,builtin.checkin.check-habit'" },
      },
      required: ['tools'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: true,
    tier: 'core',
  }, args => {
    const raw = str(args.tools)
    const names = raw.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
    if (names.length === 0) throw new Error('缺少必填参数: tools')
    const all = listTools()
    const reader = getSettingReader()
    const enabled: string[] = []
    const unknown: string[] = []
    const denied: Array<{ name: string; module: string; reason: string }> = []
    for (const n of names) {
      const t = all.find(x => x.name === n)
      if (!t) { unknown.push(n); continue }
      // 权限不足的工具不能"申请成功"（2026-09-10 修）：
      // 否则模型会误以为已启用，进而向用户宣称操作完成 —— 而下一轮它依然不在工具列表里，
      // 结果是"AI 说创建成功、实际上什么都没发生"。
      const permErr = checkModulePermission(t, reader)
      if (permErr) {
        denied.push({
          name: n,
          module: t.module ?? '',
          reason: permErr === 'MODULE_READONLY' ? '对 AI 只读' : '已对 AI 关闭',
        })
        continue
      }
      enabled.push(n)
    }
    const deniedHint = denied.length
      ? `以下工具未启用：${denied.map(d => `${d.name}（模块「${d.module}」${d.reason}）`).join('；')}。`
        + '请在回答中如实告知用户该操作未执行，并提示可在 设置 → AI 工具 → 权限 中把对应模块调为「读写」后重试；不要声称已完成。'
      : undefined
    return {
      ok: true,
      enabled,
      ...(unknown.length ? { unknown, hint: '以下工具名不存在（命名规则 builtin.<域>.<动作>，可用工具以系统列表为准）' } : {}),
      ...(denied.length ? { denied, deniedHint } : {}),
      message: enabled.length
        ? `已启用 ${enabled.length} 个工具（本会话内持续可用），下一轮起生效。写操作会真实生效并留审计记录，执行前确认用户意图`
        : '本次没有工具被启用，请根据 deniedHint 如实告知用户未执行的原因',
    }
  })

  // ===== vault.* 仓库文件只读工具（B1）：受 vaultFile 权限域（设置 → AI 工具 → 权限 → 仓库文件）控制 =====

  // 14. builtin.vault.list —— 列仓库目录（AI 视角，禁区自动隐藏）
  registerTool({
    name: 'builtin.vault.list',
    title: '列仓库目录',
    description: '列当前知识仓库某目录下的条目（目录与可读文本/代码文件）；隐藏区(.knowbase 内部非 modules)不出现。用于让 AI 了解仓库结构',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '仓库内相对目录路径，省略或空串 = 仓库根目录' },
      },
    },
    source: 'builtin',
    enabled: true,
    readOnly: true,
    requires: 'read',
    vaultFile: 'read',
  }, args => {
    const rel = str(args.path).trim()
    const root = vaultRootPath()
    const abs = resolveSafe(root, rel)
    if (!abs) throw new Error(`路径非法或越出仓库: ${rel || '.'}`)
    let isDir = false
    try { isDir = statSync(abs).isDirectory() } catch { throw new Error(`路径不存在: ${rel || '.'}`) }
    if (!isDir) throw new Error('vault.list 只接受目录路径（读文件请用 vault.read）')
    const entries: Array<{ name: string; type: 'dir' | 'file'; size?: number }> = []
    let names: string[] = []
    try { names = readdirSync(abs) } catch { throw new Error('目录读取失败') }
    for (const name of names) {
      if (entries.length >= MAX_VAULT_LIST_ENTRIES) break
      const full = join(abs, name)
      if (!childAiAllowed(root, full)) continue
      let st: ReturnType<typeof lstatSync>
      try { st = lstatSync(full) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) entries.push({ name, type: 'dir' })
      // P1：文档文件（pdf/pptx）一并可见（vault.read 已收编其读取），否则 AI 无法发现它们
      else if (st.isFile() && (isAiReadableFile(root, full) || isAiDocFile(root, full))) entries.push({ name, type: 'file', size: st.size })
    }
    entries.sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'zh-Hans-CN'))
    return { path: rel || '.', total: entries.length, entries }
  })

  // 15. builtin.vault.read —— 读仓库内文本文件与文档（P1 收编原 docs.read-text，按扩展名分派）
  registerTool({
    name: 'builtin.vault.read',
    title: '读仓库文件',
    description: '读取仓库内文件：.md/.txt 与文本类代码文件（.html/.js/.py 等）全文（.knowbase/modules/*.json 结构化数据只读）与 .pdf/.pptx 文本提取（扫描版提取为空属预期）。path 与 id 二选一：传 id（knowledge.search 返回的知识页 frontmatter id）可直接读知识页全文。返回 mtimeMs 供后续写回冲突校验。图片/>10MB/保护区文件拒绝',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '仓库内相对文件路径（如 笔记/内存管理.md 或 资料/课件.pptx）；与 id 二选一' },
        id: { type: 'string', description: '知识页 frontmatter id（与 path 二选一，knowledge.search 返回的即此 id）' },
        maxChars: { type: 'number', description: '最多返回字符，文本默认 8000，pdf/pptx 默认 12000' },
      },
      required: [],
    },
    source: 'builtin',
    enabled: true,
    readOnly: true,
    requires: 'read',
    vaultFile: 'read',
  }, async args => {
    // P2 收编原 knowledge.read：path 与 id 二选一；id 走知识索引定位页面文件
    let rel = str(args.path).trim()
    const pageId = str(args.id).trim()
    if (!rel && !pageId) throw new Error('缺少必填参数: path 或 id（二选一）')
    if (!rel && pageId) {
      const page = vaultGetPageById(pageId)
      if (!page) throw new Error(`页面不存在: ${pageId}`)
      rel = page.path
    }
    const root = vaultRootPath()
    const abs = resolveSafe(root, rel)
    if (!abs) throw new Error(`路径非法或越出仓库: ${rel}`)
    let st: ReturnType<typeof statSync>
    try { st = statSync(abs) } catch { throw new Error(`文件不存在: ${rel}`) }
    if (!st.isFile()) throw new Error('vault.read 只接受文件路径（列目录请用 vault.list）')
    if (st.size > MAX_VAULT_FILE) throw new Error(`文件过大（${st.size} 字节 > 10MB），拒绝读取: ${rel}`)
    // 文档分派（P1）：pdf/pptx 走异步文本提取，输出字段与文本路径对齐（content/truncated/totalChars + kind/pages）
    if (isAiDocFile(root, abs)) {
      const maxChars = clamp(Math.floor(num(args.maxChars, 12000)), 200, 50000)
      let out: { kind: 'pdf' | 'pptx'; text: string; pages: number; totalChars: number }
      try {
        out = await extractDocText(abs)
      } catch (err) {
        throw new Error(`文档解析失败：${String((err as Error)?.message ?? err).slice(0, 200)}`)
      }
      const truncated = out.totalChars > maxChars
      return {
        path: rel,
        kind: out.kind,
        pages: out.pages,
        size: st.size,
        mtimeMs: st.mtimeMs,
        content: truncated ? out.text.slice(0, maxChars) : out.text,
        truncated,
        totalChars: out.totalChars,
      }
    }
    if (!isAiReadableFile(root, abs)) {
      throw new Error(`文件不可读：仅支持 .md/.txt 与文本类代码文件（仓库内）与 .knowbase/modules/*.json（只读）；图片、配置与保护区拒绝: ${rel}`)
    }
    const maxChars = clamp(Math.floor(num(args.maxChars, 8000)), 200, 50000)
    const text = readFileSync(abs, 'utf-8')
    const truncated = text.length > maxChars
    return {
      path: rel,
      size: st.size,
      mtimeMs: st.mtimeMs,
      content: truncated ? text.slice(0, maxChars) : text,
      truncated,
      totalChars: text.length,
    }
  })

  // 16. builtin.vault.search —— 仓库内内容搜索（文本 grep 语义）
  registerTool({
    name: 'builtin.vault.search',
    title: '搜索仓库内容',
    description: '在当前知识仓库内按关键词搜索可读文本文件（.md/.txt/文本类代码文件与 .knowbase/modules/*.json）内容，返回命中文件与上下文摘录。用于在仓库内定位内容',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，空格分隔为 AND' },
        limit: { type: 'number', description: '命中上限, 默认20' },
      },
      required: ['query'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: true,
    requires: 'read',
    vaultFile: 'read',
  }, args => {
    const q = str(args.query).trim()
    const limit = clamp(Math.floor(num(args.limit, 20)), 1, 50)
    const terms = q.split(/\s+/).filter(Boolean)
    if (terms.length === 0) throw new Error('缺少关键词 query')
    const root = vaultRootPath()
    const files: string[] = []
    const budget = { count: 0 }
    walkAiFiles(root, root, files, budget)
    const hits: Array<{ relPath: string; excerpt: string; size: number }> = []
    for (const f of files) {
      let text = ''
      try { text = readFileSync(f, 'utf-8') } catch { continue }
      const lower = text.toLowerCase()
      if (!terms.every(t => lower.includes(t.toLowerCase()))) continue
      hits.push({
        relPath: vaultRelParts(root, f).join('/'),
        excerpt: buildExcerpt(text.replace(/\s+/g, ' '), terms) || text.replace(/\s+/g, ' ').slice(0, 100),
        size: text.length,
      })
      if (hits.length >= limit) break
    }
    return { query: q, total: hits.length, scannedFiles: budget.count, hits }
  })

  // ===== vault.* 写工具（B2/F2）：受 vaultFile=write 权限 + AgentRunner 会话写上限控制 =====

  // 17. builtin.vault.write —— 新建/整文件覆写 .md/.txt
  registerTool({
    name: 'builtin.vault.write',
    title: '写入仓库文件',
    description: '新建/覆写仓库内 .md/.txt（原子写；覆写需带 vault.read 的 expectedMtimeMs）。小改动优先 vault.edit。注意：要在知识库列表/图谱出现的知识页，内容必须以 frontmatter 开头且含稳定 id:（缺失则仅作为普通文件存在，不进库）——格式可先 vault.read 一个既有 .md 参考',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '仓库内相对文件路径（父目录须已存在或为已读目录）' },
        content: { type: 'string', description: '完整文件内容（Markdown）' },
        expectedMtimeMs: { type: 'number', description: '覆写已存在文件时的 mtime 基线（来自 vault.read），省略则不做冲突校验' },
      },
      required: ['path', 'content'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: false,
    requires: 'write',
    tier: 'ondemand',
    vaultFile: 'write',
  }, (args, ctx) => {
    // v3.1.2 条目10：教学会话下产物落点归一化（裸文件名 / 仓库顶层 / SOURCES → 改写进本会话文件夹）
    const rel = normalizeAiTeachingWritePath(str(args.path).trim(), ctx)
    const content = str(args.content)
    if (!rel) throw new Error('缺少必填参数: path')
    if (content.length > 2_000_000) throw new Error('内容过大（>2MB），拒绝写入')
    const root = vaultRootPath()
    const abs = resolveSafe(root, rel)
    if (!abs) throw new Error(`路径非法或越出仓库: ${rel}`)
    if (content.includes('\u0000')) throw new Error('内容含 NUL 字符，拒绝写入')
    let existing = false
    try { existing = statSync(abs).isFile() } catch { /* 新建 */ }
    assertAiWritable(root, abs, existing ? args.expectedMtimeMs : null)
    if (!existing) {
      try { mkdirSync(dirname(abs), { recursive: true }) } catch { /* 目录已存在 */ }
    }
    writeWorkspaceFile(abs, content)
    if (rel.toLowerCase().endsWith('.md')) {
      invalidateIndexIfCurrentVault(getCurrentVault()?.rootId ?? '') // 与 ws:writeFile 同规则：.md 落盘即失效，知识列表/图谱立即可见
      broadcastDataChanged('knowledge') // v3.1.2 条目9：对齐 knowledge.create-page 口径，带 frontmatter 的页即时进列表
    }
    const st = statSync(abs)
    broadcastExternalWrite(rel, st.mtimeMs)
    notifyVaultTreeChange(rel) // v3.1.2 条目9：编辑区树即时刷新（此前只发 external-change，新文件树上不出现）
    return { ok: true, path: rel, created: !existing, size: st.size, mtimeMs: st.mtimeMs }
  })

  // 18. builtin.vault.edit —— 精确替换（oldText→newText）+ 末尾追加（P2 收编原 knowledge.append-page）
  registerTool({
    name: 'builtin.vault.edit',
    title: '编辑文件片段',
    description: '两种模式：① 替换（默认）在仓库内 .md/.txt 中做一次精确替换（oldText 必须唯一命中；newText 空串即删除片段，可解除 [[双链]]）；② 追加（append=true）把 newText 追加到文件末尾。改动局部内容请用本工具而非 vault.write。需带 vault.read 返回的 expectedMtimeMs 防冲突',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '仓库内相对文件路径' },
        oldText: { type: 'string', description: '要被替换的原文片段（必须唯一命中）；append=true 时省略', allowEmpty: true },
        newText: { type: 'string', description: '替换后的文本；替换模式下空串即删除片段（如解除 [[双链]] 引用）；append 模式下为要追加的内容', allowEmpty: true },
        append: { type: 'boolean', description: 'true=在文件末尾追加 newText（忽略 oldText；追加前自动去掉文末多余空行）' },
        expectedMtimeMs: { type: 'number', description: 'mtime 基线（来自 vault.read）' },
      },
      required: ['path', 'newText'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: false,
    requires: 'write',
    tier: 'ondemand',
    vaultFile: 'write',
  }, args => {
    const rel = str(args.path).trim()
    const oldText = str(args.oldText)
    const newText = str(args.newText)
    const append = args.append === true
    if (!rel) throw new Error('缺少必填参数: path')
    if (!append && !oldText) throw new Error('缺少必填参数: oldText（append=true 时可省略）')
    if (append && !newText.trim()) throw new Error('追加内容不能为空')
    const root = vaultRootPath()
    const abs = resolveSafe(root, rel)
    if (!abs) throw new Error(`路径非法或越出仓库: ${rel}`)
    let st: ReturnType<typeof statSync>
    try { st = statSync(abs) } catch { throw new Error(`文件不存在: ${rel}`) }
    if (!st.isFile()) throw new Error('vault.edit 只接受文件路径')
    assertAiWritable(root, abs, args.expectedMtimeMs)
    const text = readFileSync(abs, 'utf-8')
    let next: string
    if (append) {
      // 原 knowledge.append-page 语义：文末多余空行归一后换行追加
      next = text.replace(/\s*$/, '') + '\n' + newText + '\n'
    } else {
      const first = text.indexOf(oldText)
      if (first < 0) throw new Error(`未找到待替换片段（截取前 60 字符）: ${oldText.slice(0, 60)}… 可先 vault.read 确认当前内容`)
      if (text.indexOf(oldText, first + oldText.length) >= 0) throw new Error('待替换片段在文件中出现多处，请提供更长更精确的 oldText（本工具一次只替换一处）')
      next = text.slice(0, first) + newText + text.slice(first + oldText.length)
    }
    writeWorkspaceFile(abs, next)
    if (rel.toLowerCase().endsWith('.md')) {
      invalidateIndexIfCurrentVault(getCurrentVault()?.rootId ?? '') // 同上：edit 后索引/图谱同步刷新
      broadcastDataChanged('knowledge') // v3.1.2 条目9：知识库列表/图谱同步重读
    }
    const after = statSync(abs)
    broadcastExternalWrite(rel, after.mtimeMs)
    notifyVaultTreeChange(rel) // v3.1.2 条目9：编辑区树即时刷新
    return {
      ok: true,
      path: rel,
      mtimeMs: after.mtimeMs,
      oldChars: oldText.length,
      newChars: newText.length,
    }
  })

  // 19. builtin.vault.resolve-ref —— 校验知识页引用名（场景 A：AI 写 [[链接]] 前确认目标标题）
  registerTool({
    name: 'builtin.vault.resolve-ref',
    title: '校验页面引用名',
    description: '输入拟引用的标题（可带 [[ ]]），返回知识库中存在的页面标题/id 与是否精确命中。写 [[链接]] 前先调用本工具确认，避免死链',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '拟引用标题，如 内存管理 或 [[内存管理]]' },
      },
      required: ['ref'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: true,
    requires: 'read',
    vaultFile: 'read',
  }, args => {
    const raw = str(args.ref).trim()
    if (!raw) throw new Error('缺少必填参数: ref')
    const want = raw.replace(/^\[\[|\]\]$/g, '').split('|')[0].trim()
    if (!want) throw new Error('引用名为空')
    let pages: Array<{ id: string; title: string; path: string }> = []
    try {
      pages = getKnowledgeIndex().pages
        .filter(p => p.entryKind !== 'file') // 引用锚只指向 md 知识页（非 md 文件无标题锚语义）
        .map(p => ({ id: p.id, title: p.title, path: p.path }))
    } catch { /* 索引未就绪时按空处理 */ }
    const exact = pages.filter(p => p.title === want)
    const fuzzy = pages.filter(p => p.title.includes(want)).slice(0, 10)
    const matched = exact.length > 0 ? exact.slice(0, 5) : fuzzy
    return {
      ref: want,
      exact: exact.length > 0,
      totalPages: pages.length,
      matches: matched,
      hint: matched.length === 0 ? '未找到匹配页面标题；可用 vault.search 搜内容定位后用其标题作为引用' : undefined,
    }
  })

  // ===== vault.* 高危整理工具（B3/F3）：rename/trash 走回收站语义，全程审计 =====

  // 20. builtin.vault.rename —— 重命名/移动 .md/.txt（跨目录；目标已存在拒绝）
  registerTool({
    name: 'builtin.vault.rename',
    title: '重命名/移动仓库文件',
    description: '重命名或移动仓库内 .md/.txt 文件（同 ws:rename 语义）。若 newPath 是已存在目录则移入该目录；否则按新文件名改名。危险操作：全程审计且不可自动回滚（回收站可恢复需先 trash）',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '当前仓库内相对文件路径' },
        newPath: { type: 'string', description: '目标：新相对路径（含新文件名），或已存在目录（表示移入）' },
      },
      required: ['path', 'newPath'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: false,
    requires: 'write',
    tier: 'ondemand',
    vaultFile: 'write',
  }, args => {
    const rel = str(args.path).trim()
    const newRel = str(args.newPath).trim()
    if (!rel || !newRel) throw new Error('缺少必填参数: path / newPath')
    const root = vaultRootPath()
    const oldAbs = resolveSafe(root, rel)
    if (!oldAbs) throw new Error(`源路径非法或越出仓库: ${rel}`)
    const newAbs = resolveSafe(root, newRel)
    if (!newAbs) throw new Error(`目标路径非法或越出仓库: ${newRel}`)
    // 源必须是普通区 .md/.txt（目录或 .knowbase 内一律不开放 AI rename）
    if (!isAiWritableFile(root, oldAbs)) throw new Error('仅可重命名/移动仓库内普通 .md/.txt 文件（.knowbase 内部数据禁动）')
    let targetIsDir = false
    try { targetIsDir = statSync(newAbs).isDirectory() } catch { /* 目标不存在=改名 */ }
    let finalNewRel = newRel
    if (targetIsDir) {
      // 移入目录：保持文件名
      finalNewRel = join(relative(root, newAbs), baseNameOf(rel)).replace(/\\/g, '/')
      if (!finalNewRel) throw new Error('目标目录与源在同一位置')
    } else {
      // 改名/移动到新文件名：目标也须普通区 .md/.txt
      const probe = newAbs
      if (!isAiWritableFile(root, probe)) throw new Error('目标须为仓库内普通 .md/.txt 路径')
    }
    const finalAbs = resolveSafe(root, finalNewRel)
    if (!finalAbs) throw new Error('目标路径非法')
    const rootId = getCurrentVault()?.rootId
    if (!rootId) throw new Error('仓库上下文未就绪')
    try { mkdirSync(dirname(finalAbs), { recursive: true }) } catch { /* 目录已存在 */ }
    renameWorkspacePath(rootId, rel, finalNewRel)
    // v3.1.2 条目9：rename/trash 此前连 external-change 都不发；这里补树刷新（源 + 目标父目录）
    if (finalNewRel.toLowerCase().endsWith('.md') || rel.toLowerCase().endsWith('.md')) broadcastDataChanged('knowledge')
    notifyVaultTreeChange(finalNewRel, rel)
    return { ok: true, from: rel, to: finalNewRel }
  })

  // 21. builtin.vault.trash —— 移入系统回收站（绝不删除）
  registerTool({
    name: 'builtin.vault.trash',
    title: '移入回收站',
    description: '把仓库内 .md/.txt 移入系统回收站（可恢复，非永久删除）。危险操作：全程审计；执行前确认用户明确要求删除该文件',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '仓库内相对文件路径' },
      },
      required: ['path'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: false,
    requires: 'write',
    tier: 'ondemand',
    vaultFile: 'write',
  }, async args => {
    const rel = str(args.path).trim()
    if (!rel) throw new Error('缺少必填参数: path')
    const root = vaultRootPath()
    const abs = resolveSafe(root, rel)
    if (!abs) throw new Error(`路径非法或越出仓库: ${rel}`)
    if (!isAiWritableFile(root, abs)) throw new Error('仅可移入回收站普通区 .md/.txt 文件（.knowbase 内部数据禁动）')
    let isFile = false
    try { isFile = statSync(abs).isFile() } catch { throw new Error(`文件不存在: ${rel}`) }
    if (!isFile) throw new Error('vault.trash 仅支持文件（目录整理请用编辑器）')
    const rootId = getCurrentVault()?.rootId
    if (!rootId) throw new Error('仓库上下文未就绪')
    await trashWorkspacePath(rootId, rel)
    // v3.1.2 条目9：删除后编辑区树与知识库同步（此前无任何广播，文件树上条目还在）
    if (rel.toLowerCase().endsWith('.md')) broadcastDataChanged('knowledge')
    notifyVaultTreeChange(rel)
    return { ok: true, trashed: rel }
  })

  // ===== web.read：通读 https 网页正文（场景 B「吃资料」，跨模块通用，不设 module） =====

  // 22. builtin.web.read —— 读指定网页全文（防 SSRF：仅 https，拒内网/IP）
  registerTool({
    name: 'builtin.web.read',
    title: '读取网页全文',
    description: '打开用户指定的 https 网页并读取正文 Markdown（Defuddle 清洗：保留标题/列表/表格/代码围栏，自动去导航/广告）。附同域页内链接清单（≤30），目录/导航页可据此选读子页跟读。仅 https；内网/私网/IP 直连一律拒绝',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整网页地址（必须以 https:// 开头）' },
        maxChars: { type: 'number', description: '最多返回字符，默认 8000' },
      },
      required: ['url'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: true,
  }, async args => {
    const url = str(args.url).trim()
    if (!url) throw new Error('缺少必填参数: url')
    const maxChars = clamp(Math.floor(num(args.maxChars, 8000)), 200, 50000)
    const out = await webReadPage(url, maxChars)
    return {
      url: out.url,
      title: out.title,
      content: out.content,
      truncated: out.truncated,
      totalChars: out.totalChars,
      links: out.links,
    }
  })

  // 23. builtin.docs.read-text 已退役（2026-09-09 P1）：并入 vault.read（pdf/pptx 按扩展名分派）

  // ===== visual.html：AI 教学示意图生成（docs/ai-teaching-artifacts-pane-design.md §3） =====

  // 24. visual.html —— 生成单文件 HTML 示意图写入会话 visuals/（工件栏页签预览）
  registerTool({
    name: 'visual.html',
    title: '生成 HTML 示意图',
    description: '生成单文件 HTML 示意图辅助讲解，写入本会话文件夹 visuals/<slug>.html 并自动在右栏工件栏打开。html 为完整自包含单文件：CSS/SVG/JS 全内联、不引用任何外部资源（无 CDN/网络图片/外链字体）、建议 ≤150 行、画幅 680×400 比例 SVG 为主、中文标注。配色：文字与背景对比度 ≥4.5:1（深底近白字、浅底深字，禁同色系深浅叠加）。重名不覆盖（自动 -v2/-v3 递增）。仅限 AI教学对话会话内使用',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '文件名（kebab-case 小写英文/数字，如 parabola-open-width；不带 .html 后缀）' },
        title: { type: 'string', description: '示意图中文标题（工件卡与页签展示，如「开口大小与 a 的关系」）' },
        html: { type: 'string', description: '完整 HTML 全文（自包含单文件，无任何外部依赖）' },
      },
      required: ['slug', 'title', 'html'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: false,
    requires: 'write',
    tier: 'ondemand',
    // 不设 module：产物固定落 AI教学会话目录，权限由 sessionId 归属兜底（无会话即拒绝）
  }, (args, ctx) => {
    const sid = String(ctx?.sessionId ?? '')
    if (!sid) throw new Error('visual.html 仅可在 AI教学对话中使用（当前会话无归属文件夹）')
    const r = writeVisual(sid, str(args.slug), String(args.html ?? ''), getSettingReader())
    if (!r.ok) throw new Error(r.error ?? '示意图写入失败')
    return { relPath: r.relPath, lines: r.lines }
  })

  // =====================================================================
  // ===== quiz 错题本工具（2026-09-12）：AI 整理错题本 + 按错误类型组卷 =====
  //
  // 落点约定：数据层一律走 quizRepo 抽出的业务函数（与界面同一条受控写路径）。
  // 既不撬开 vault 文件白名单（.knowbase 仍全面禁写），也禁止 AI 直接改
  // .knowbase/modules/quiz/*.json —— 直改 JSON 会绕过关联行同步与快照不变量。
  //
  // 装载层：读工具 tier=core（整理错题本每轮都要先看清数据）；写工具 tier=ondemand
  // （写是低频高危动作，须经 builtin.tool.request 申请 + quiz 模块的 write 权限）。
  // =====================================================================

  const splitCsv = (v: unknown): string[] =>
    str(v).split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)

  /** 错次档位（与 QuizCollection 的 WRONG_BANDS / quizDataAdmin 的 BANDS 同口径） */
  const QUIZ_BAND_LABEL: Record<string, string> = {
    stubborn: '顽固错（4 次以上）', mid: '中错（2–3 次）', light: '轻错（1 次）',
  }
  const quizBandKeyOf = (wrongCount: number): string =>
    wrongCount >= 4 ? 'stubborn' : wrongCount >= 2 ? 'mid' : 'light'

  // 25. builtin.quiz.list —— 查错题本（整理前的第一步）
  registerTool({
    name: 'builtin.quiz.list',
    title: '查错题本',
    description: '按条件查错题本记录。kind：wrong=尚未掌握的错题（默认）/ favorite=已收藏 / all=两者并集。可按学习空间、标签名、自定义分组名筛选。返回的 id 供 quiz.set-note / quiz.tag / quiz.collect / quiz.favorite / quiz.remove 使用。整理错题本的第一步：先看清有什么，再动手',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['wrong', 'favorite', 'all'], description: 'wrong=错题(默认) / favorite=收藏 / all=并集' },
        sourceSpace: { type: 'string', description: '限定学习空间名，省略=全部空间' },
        tagNames: { type: 'string', description: '标签名筛选，多个用逗号分隔，命中任一即算匹配' },
        collectionName: { type: 'string', description: '自定义分组名筛选，可省略' },
        limit: { type: 'number', description: '最多返回条数，默认 20，上限 100。返回体较占上下文：先用小 limit 看概况，确有必要再提高或配合 tagNames/collectionName 收窄' },
        withQuestion: { type: 'boolean', description: '是否返回题干（默认 true）；只要 id 清单时可传 false 省 token' },
      },
    },
    source: 'builtin',
    enabled: true,
    readOnly: true,
    requires: 'read',
    tier: 'core',
    module: 'quiz',
  }, args => {
    const rawKind = str(args.kind, 'wrong')
    const kind: 'wrong' | 'favorite' | 'all' = rawKind === 'favorite' || rawKind === 'all' ? rawKind : 'wrong'
    const tags = quizTagList()
    const cols = quizCollectionList()
    const tagNameById = new Map(tags.map(t => [t.id, t.name]))
    const colNameById = new Map(cols.map(c => [c.id, c.name]))
    // 标签名 → id：查询刻意不自动建标签（查询不该有副作用），未命中的名字如实回报
    const wantedTagNames = splitCsv(args.tagNames)
    const tagIds: string[] = []
    const unknownTags: string[] = []
    for (const n of wantedTagNames) {
      const hit = tags.find(t => t.name === n)
      if (hit) tagIds.push(hit.id); else unknownTags.push(n)
    }
    const wantedCol = str(args.collectionName).trim()
    const colHit = wantedCol ? cols.find(c => c.name === wantedCol) : undefined
    // 阈值下调（2026-09-12）：limit=50 时返回体约 16.7k 字符（≈7k tok），而 agent loop
    // 每轮重发整个 convo，一次拉取会在整任务里被重发数倍。默认降到 20（≈6.3k 字符）
    const limit = clamp(Math.floor(num(args.limit, 20)), 1, 100)
    const withQuestion = args.withQuestion !== false
    const rows = quizRecordList({
      kind,
      sourceSpace: str(args.sourceSpace).trim(),
      collectionId: wantedCol ? (colHit?.id ?? '__no_such_collection__') : '',
      tagIds,
    })
    return {
      total: rows.length,
      returned: Math.min(rows.length, limit),
      ...(unknownTags.length
        ? { unknownTags, unknownTagsHint: '这些标签名不存在（查询不会自动新建标签）。请核对名称，或用 quiz.stats 查看现有标签清单' }
        : {}),
      ...(wantedCol && !colHit ? { unknownCollection: wantedCol, unknownCollectionHint: '该分组名不存在' } : {}),
      items: rows.slice(0, limit).map(r => ({
        id: r.id,
        pageTitle: r.pageTitle,
        quizNo: r.quizNo,
        ...(withQuestion ? { question: (r.snapshot?.question ?? '').slice(0, 300) } : {}),
        wrongCount: r.wrongCount,
        correctCount: r.correctCount,
        streakCorrect: r.streakCorrect,
        isFavorite: r.isFavorite,
        ...(r.note ? { note: r.note } : {}),
        tags: r.tagIds.map(id => tagNameById.get(id) ?? id),
        collections: r.collectionIds.map(id => colNameById.get(id) ?? id),
        source: [r.sourceSpace, r.sourceNotebook, r.sourceChapter].filter(Boolean).join(' / '),
      })),
    }
  })

  // 26. builtin.quiz.stats —— 错题本概览 + 按标签（错误类型）的薄弱分布
  registerTool({
    name: 'builtin.quiz.stats',
    title: '错题本统计',
    description: '错题本概览统计 + 按标签（考点／错误类型）聚合的薄弱分布：每个标签下待复习错题数、累计错次、正确率，按累计错次降序。用来判断"哪类错误最集中"，再决定整理方向或组卷范围。概览口径与「数据」面板完全一致（同一实现，不会两套数字打架）',
    inputSchema: {
      type: 'object',
      properties: {
        sourceSpace: { type: 'string', description: '限定学习空间名，省略=全部空间' },
      },
    },
    source: 'builtin',
    enabled: true,
    readOnly: true,
    requires: 'read',
    tier: 'core',
    module: 'quiz',
  }, args => {
    const space = str(args.sourceSpace).trim()
    const overall = quizDataStats(space) // 与「数据」面板同一实现
    const tagById = new Map(quizTagList().map(t => [t.id, t]))
    const rows = quizRecordList({ kind: 'wrong', sourceSpace: space })
    const agg = new Map<string, { name: string; kind: string; wrongRecords: number; wrongSum: number; correctSum: number }>()
    let untaggedWrong = 0
    for (const r of rows) {
      if (r.tagIds.length === 0) { untaggedWrong += 1; continue }
      for (const tid of r.tagIds) {
        const t = tagById.get(tid)
        if (!agg.has(tid)) {
          agg.set(tid, { name: t?.name ?? tid, kind: t?.kind ?? 'custom', wrongRecords: 0, wrongSum: 0, correctSum: 0 })
        }
        const a = agg.get(tid)!
        a.wrongRecords += 1
        a.wrongSum += r.wrongCount
        a.correctSum += r.correctCount
      }
    }
    const byTag = [...agg.values()]
      .map(a => ({
        ...a,
        correctRate: a.wrongSum + a.correctSum > 0 ? Math.round((a.correctSum / (a.wrongSum + a.correctSum)) * 100) : 0,
      }))
      .sort((x, y) => y.wrongSum - x.wrongSum || y.wrongRecords - x.wrongRecords)
    return {
      scope: space || '全部学习空间',
      overall: {
        total: overall.total,
        wrong: overall.wrong,
        mastered: overall.mastered,
        favorite: overall.favorite,
        notes: overall.notes,
        todayWrong: overall.todayWrong,
        correctRate: overall.correctRate,
        tags: overall.tags,
        collections: overall.collections,
      },
      byBand: overall.byBand,
      byNotebook: overall.byBook,
      byTag,
      untaggedWrong,
      ...(untaggedWrong > 0
        ? { hint: `有 ${untaggedWrong} 道错题没有任何标签（byTag 统计不到）。建议先 quiz.list 取出这些题，按错误类型归类后用 quiz.tag 批量打标` }
        : {}),
    }
  })

  // 27. builtin.quiz.set-note —— 写错因备注
  registerTool({
    name: 'builtin.quiz.set-note',
    title: '写错题备注',
    description: '给一道错题写备注（≤500 字），如错因分析、正确思路、易错点提醒。整条覆盖：传空串即清空备注',
    inputSchema: {
      type: 'object',
      properties: {
        recordId: { type: 'string', description: '错题记录 id（来自 quiz.list）' },
        note: { type: 'string', description: '备注正文；传空串=清空备注', allowEmpty: true },
      },
      required: ['recordId', 'note'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: false,
    requires: 'write',
    tier: 'ondemand',
    module: 'quiz',
  }, args => {
    const recordId = str(args.recordId).trim()
    if (!recordId) throw new Error('recordId 不能为空')
    quizRecordSetNote(recordId, str(args.note))
    broadcastDataChanged('quiz')
    return { ok: true, recordId }
  })

  // 28. builtin.quiz.tag —— 批量打标签（AI 整理错题本的核心动作）
  registerTool({
    name: 'builtin.quiz.tag',
    title: '给错题打标签',
    description: '给错题批量打标签，即"按错误类型归类"。标签按名字指定，不存在会自动新建（无须先建标签）；查找按名字去重，不会因换类别建出同名重复标签。mode=add（默认，追加，保留原有标签）/ set（整体覆盖该题的标签）。这是 AI 整理错题本的核心动作',
    inputSchema: {
      type: 'object',
      properties: {
        recordIds: { type: 'string', description: '错题记录 id，多个用逗号分隔' },
        tags: { type: 'string', description: '标签名，多个用逗号分隔，如 "二叉树遍历,递归"' },
        tagKind: { type: 'string', enum: ['topic', 'type', 'difficulty', 'custom'], description: '标签类别：topic 考点(默认) / type 题型 / difficulty 难度 / custom 关键词。仅对新建的标签生效' },
        mode: { type: 'string', enum: ['add', 'set'], description: 'add=追加(默认) / set=整体覆盖' },
      },
      required: ['recordIds', 'tags'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: false,
    requires: 'write',
    tier: 'ondemand',
    module: 'quiz',
  }, args => {
    const rids = splitCsv(args.recordIds)
    const names = splitCsv(args.tags)
    if (rids.length === 0) throw new Error('recordIds 不能为空')
    if (names.length === 0) throw new Error('tags 不能为空')
    const kind = ['topic', 'type', 'difficulty', 'custom'].includes(str(args.tagKind)) ? str(args.tagKind) : 'topic'
    const mode = str(args.mode) === 'set' ? 'set' : 'add'
    const tagIds = names.map(n => quizTagResolveOrCreate(n, kind).id)
    if (mode === 'set') {
      for (const rid of rids) quizRecordSetTags(rid, tagIds)
    } else {
      quizRecordAddTags(rids, tagIds)
    }
    broadcastDataChanged('quiz')
    return { ok: true, records: rids.length, tags: names, tagKind: kind, mode }
  })

  // 29. builtin.quiz.collect —— 加入自定义分组
  registerTool({
    name: 'builtin.quiz.collect',
    title: '错题加入分组',
    description: '把错题批量放进自定义分组（如"考前冲刺""二刷错题"）。分组按名字指定，不存在会自动新建。mode=add（默认，追加）/ set（整体覆盖该题的分组）',
    inputSchema: {
      type: 'object',
      properties: {
        recordIds: { type: 'string', description: '错题记录 id，多个用逗号分隔' },
        collection: { type: 'string', description: '分组名（不存在则新建）' },
        mode: { type: 'string', enum: ['add', 'set'], description: 'add=追加(默认) / set=整体覆盖' },
      },
      required: ['recordIds', 'collection'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: false,
    requires: 'write',
    tier: 'ondemand',
    module: 'quiz',
  }, args => {
    const rids = splitCsv(args.recordIds)
    const name = str(args.collection).trim()
    if (rids.length === 0) throw new Error('recordIds 不能为空')
    if (!name) throw new Error('collection 不能为空')
    const mode = str(args.mode) === 'set' ? 'set' : 'add'
    const col = quizCollectionResolveOrCreate(name)
    if (mode === 'set') {
      for (const rid of rids) quizRecordSetCollections(rid, [col.id])
    } else {
      for (const rid of rids) {
        const cur = quizRecordCollectionIds(rid)
        if (cur.includes(col.id)) continue
        quizRecordSetCollections(rid, [...cur, col.id])
      }
    }
    broadcastDataChanged('quiz')
    return { ok: true, collection: col.name, collectionId: col.id, records: rids.length, mode }
  })

  // 30. builtin.quiz.favorite —— 收藏 / 取消收藏
  registerTool({
    name: 'builtin.quiz.favorite',
    title: '收藏或取消收藏错题',
    description: '设置某道错题的收藏状态（收藏的题会出现在错题本的「收藏」页签，便于单独拎出来复习）',
    inputSchema: {
      type: 'object',
      properties: {
        recordId: { type: 'string', description: '错题记录 id' },
        favorite: { type: 'boolean', description: 'true=收藏 / false=取消收藏' },
      },
      required: ['recordId', 'favorite'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: false,
    requires: 'write',
    tier: 'ondemand',
    module: 'quiz',
  }, args => {
    const recordId = str(args.recordId).trim()
    if (!recordId) throw new Error('recordId 不能为空')
    const r = quizRecordSetFavorite(recordId, args.favorite === true)
    if (!r) throw new Error(`错题记录不存在: ${recordId}`)
    broadcastDataChanged('quiz')
    return { ok: true, recordId, isFavorite: r.isFavorite }
  })

  // 31. builtin.quiz.remove —— 从错题本移除（破坏性）
  registerTool({
    name: 'builtin.quiz.remove',
    title: '移除错题',
    description: '从错题本移除若干条记录（连同其标签、分组关联一并清理）。破坏性、不可撤销：执行前必须先用 quiz.list 核对 id 无误并征得用户同意。若只是想说明"为什么错"，请改用 quiz.set-note 写备注，不要删',
    inputSchema: {
      type: 'object',
      properties: {
        recordIds: { type: 'string', description: '错题记录 id，多个用逗号分隔' },
      },
      required: ['recordIds'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: false,
    requires: 'write',
    tier: 'ondemand',
    module: 'quiz',
  }, args => {
    const rids = splitCsv(args.recordIds)
    if (rids.length === 0) throw new Error('recordIds 不能为空')
    let removed = 0
    const missing: string[] = []
    for (const rid of rids) {
      if (quizRecordRemoveById(rid)) removed += 1; else missing.push(rid)
    }
    broadcastDataChanged('quiz')
    return { ok: true, removed, ...(missing.length ? { missing, missingHint: '这些 id 在错题本中不存在（可能已被移除）' } : {}) }
  })

  // 32. builtin.quiz.gen-paper —— 按错误类型组卷成知识库练习页
  registerTool({
    name: 'builtin.quiz.gen-paper',
    title: '按错误类型组卷成练习页',
    description: '从错题本按条件抽题，生成一份知识库练习页（.md）。页内每道题是一个 quiz 围栏，因此可以直接在该页作答——答错的题会自动回流错题本、答对两次视为掌握，形成"错题 → 组卷 → 重练 → 回流"闭环。支持按学习空间／标签名／错次档位／题量／排序筛题',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '练习页标题，缺省按日期自动命名' },
        sourceSpace: { type: 'string', description: '限定学习空间名，省略=全部空间' },
        tagNames: { type: 'string', description: '标签名筛选，多个用逗号分隔，命中任一即算匹配' },
        band: { type: 'string', enum: ['all', 'stubborn', 'mid', 'light'], description: '错次档位：all=不限(默认) / stubborn=顽固错(≥4次) / mid=中错(2-3次) / light=轻错(1次)' },
        limit: { type: 'number', description: '最多出题数，默认 20，上限 100' },
        order: { type: 'string', enum: ['wrong', 'recent', 'random'], description: 'wrong=按错次降序(默认) / recent=按最近更新 / random=随机' },
        categoryName: { type: 'string', description: '存入的知识库分类名（精确匹配）；省略则存入默认收件箱' },
      },
    },
    source: 'builtin',
    enabled: true,
    readOnly: false,
    requires: 'write',
    tier: 'ondemand',
    module: 'quiz',
  }, args => {
    const space = str(args.sourceSpace).trim()
    const tags = quizTagList()
    const tagIds: string[] = []
    const unknownTags: string[] = []
    for (const n of splitCsv(args.tagNames)) {
      const hit = tags.find(t => t.name === n)
      if (hit) tagIds.push(hit.id); else unknownTags.push(n)
    }
    const rawBand = str(args.band)
    const band = ['all', 'stubborn', 'mid', 'light'].includes(rawBand) ? rawBand : 'all'
    const rawOrder = str(args.order)
    const order = ['wrong', 'recent', 'random'].includes(rawOrder) ? rawOrder : 'wrong'
    const limit = clamp(Math.floor(num(args.limit, 20)), 1, 100)

    // 抽题：kind='wrong' = 尚未掌握的错题；无快照（题干）的旧记录出不了卷，先剔除并如实回报
    const candidates = quizRecordList({ kind: 'wrong', sourceSpace: space, tagIds })
      .filter(r => !!r.snapshot && (r.snapshot.question ?? '').trim() !== '')
    const matched = band === 'all' ? candidates : candidates.filter(r => quizBandKeyOf(r.wrongCount) === band)
    if (matched.length === 0) {
      const bandText = band === 'all' ? '不限档位' : QUIZ_BAND_LABEL[band]
      throw new Error(
        `没有符合条件的错题可组卷（空间「${space || '全部'}」· 标签「${tagIds.length ? splitCsv(args.tagNames).join('、') : '不限'}」· ${bandText}）。`
        + '可先调 quiz.stats 看现有错题的分布，再调整筛选条件',
      )
    }
    if (order === 'wrong') matched.sort((a, b) => b.wrongCount - a.wrongCount || b.correctCount - a.correctCount)
    else if (order === 'recent') matched.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    else matched.sort(() => Math.random() - 0.5)
    const picked = matched.slice(0, limit)

    const dateStr = todayLocal()
    const cond = [
      space || '全部学习空间',
      tagIds.length ? `标签：${splitCsv(args.tagNames).join('、')}` : '',
      band === 'all' ? '' : QUIZ_BAND_LABEL[band],
    ].filter(Boolean).join(' · ')
    const title = str(args.title).trim() || `错题重练 · ${dateStr}`

    const lines: string[] = []
    lines.push(`# ${title}`)
    lines.push('')
    lines.push(`> 由错题本自动组卷（${cond}），共 ${picked.length} 题，生成于 ${dateStr}。`)
    lines.push('> 直接在本页作答：答错的题会自动回流到错题本，答对两次即视为已掌握。')
    lines.push('')
    picked.forEach((r, i) => {
      const snap = r.snapshot!
      // 重排题号：记录里的 quiz_no 是它在原页面的序号，在本卷里必须重新从 1 排，
      // 否则答题回报 (pageId, quizNo) 会与页面上的题序对不上（2026-09-12）
      lines.push('```quiz')
      lines.push(JSON.stringify({
        no: i + 1,
        points: '',
        question: snap.question,
        options: snap.options,
        answer: snap.answer,
        explanation: snap.explanation || '',
      }))
      lines.push('```')
      lines.push('')
    })

    // 建页走知识库受控写层：与手工新建页面同一条路径（自动生成 frontmatter id 并登记索引）
    let categoryId: string | null = null
    const catName = str(args.categoryName).trim()
    if (catName) {
      const cat = vaultGetCategories().find(c => c.name === catName && c.categoryType !== 'space')
      if (!cat) throw new Error(`未找到分类「${catName}」；可省略 categoryName 以存入默认收件箱`)
      categoryId = cat.id
    }
    const page = vaultCreatePage({ title, contentMd: lines.join('\n'), categoryId })
    // 同 knowledge.create-page：.md 落盘即失效索引并广播，否则列表/搜索里看不到新练习页
    invalidateIndexIfCurrentVault(getCurrentVault()?.rootId ?? '')
    broadcastDataChanged('knowledge')
    broadcastDataChanged('quiz')
    return {
      ok: true,
      pageId: page.id,
      title,
      path: page.path,
      questions: picked.length,
      matched: matched.length,
      ...(unknownTags.length ? { unknownTags } : {}),
      hint: '练习页已生成，用户可直接打开该页答题；答错的题会自动记入错题本',
    }
  })

  // ===== 书市工具（2026-09-23，S5）：AI 把口述地址/响应样例整理成书源草案 → 预填表单 =====
  //
  // 落点约定（设计文档 §4.2/§4.3、施工方案 §十三）：草案**不落库** —— 工具只做
  // 「整理 + 广播」，用户在表单里核对字段、亲手填写凭据、点「添加」之后才写盘；
  // 凭据**永不进 AI 侧**（draft 的 schema 没有 username / password / token，
  // list 只回「凭据是否已存」布尔，取自 bookSourceInfos 那份出渲染层的同一口径）。
  // 草案校验复用 repo 的 sanitizeBookSourcePatch / isAllowedSourceUrl —— 不为 AI
  // 单开一套判定（铁律 2 的同一条理由：同一业务只有一处实现）。
  //
  // 装载层：两枚均 ondemand —— 书源配置是低频动作，常驻等于让每个会话每轮白付 token。
  // ★ 可达性链（写码时核过：全仓**没有** read+ondemand 的先例，而 ondemand 的发现路径
  //   只有 builtin.tool.request 的写工具清单与 system prompt 的泛化提示 ⇒ 只读工具
  //   若无人提及就永远进不了模型视野）：tool.request 清单里提 draft → 模型申请后
  //   draft 进视野 → **draft 的 description 里指一句 list** → 模型需要时再申请 list。
  //   多一跳，换来两枚的常驻成本都是零。

  // enum 入参严格化：静默降级（如 authType 'Bearer' 被丢弃）会造出「配了但连不上」的源，
  // 而用户与模型都看不出哪里不对 —— 明确报错才能让模型自我纠正
  const bookSourceEnum = <T extends string>(v: unknown, allowed: readonly T[], def: T, label: string): T => {
    const s = str(v).trim().toLowerCase()
    if (!s) return def
    if (!(allowed as readonly string[]).includes(s)) throw new Error(`${label} 只能是 ${allowed.join(' / ')}：${str(v)}`)
    return s as T
  }

  // 33. builtin.booksource.list —— 查已配置书源（起草前的第一步）
  registerTool({
    name: 'builtin.booksource.list',
    title: '查书源清单',
    description: '列出用户已配置的书源：名称 / 类型 / 地址 / 检索模板 / 是否需要凭据 / 凭据是否已存 / 启用态 / 是否预置。永远不含凭据内容。起草新书源前可先看这里，避免与已有源重复',
    inputSchema: { type: 'object', properties: {} },
    source: 'builtin',
    enabled: true,
    readOnly: true,
    requires: 'read',
    tier: 'ondemand',
    module: 'bookMarket',
  }, () => {
    const rootId = getCurrentVault()?.rootId ?? ''
    if (!rootId) throw new Error('当前没有打开的仓库：请先在应用中打开知识仓库')
    const sources = bookSourceInfos(rootId).map(s => ({
      name: s.name,
      kind: s.kind,
      url: s.url,
      ...(s.searchUrl ? { searchUrl: s.searchUrl } : {}),
      needsAuth: s.authType !== null,
      hasCredential: s.hasCredential,
      enabled: s.enabled,
      builtin: s.builtin,
      ...(s.mapping ? { mapping: s.mapping } : {}),
    }))
    return { count: sources.length, sources }
  })

  // 34. builtin.booksource.draft —— 起草书源配置（送进「新建书源」表单预填；本工具不落库）
  registerTool({
    name: 'builtin.booksource.draft',
    title: '起草书源配置',
    description: '把用户口述的地址（或一段响应样例）整理成一份书源配置草案，送进「新建书源」表单并预填，界面会切到书市 —— 本工具不落库：用户核对字段、自己填写凭据、点「添加」之后才算配好（它既拿不到也不需要凭据）。custom 源的字段映射是主战场：mappingJson 传 JSON 文本，形如 {"list":"data.books[*]","title":"title","download":"files[0].url"}。想先看用户已有书源时，可申请 builtin.booksource.list',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '书源名，如「我家 Calibre」' },
        url: { type: 'string', description: '源地址（http/https）' },
        kind: { type: 'string', enum: ['opds', 'custom'], description: 'opds=OPDS 目录（默认）/ custom=JSON 接口' },
        searchUrl: { type: 'string', description: '检索模板，变量 {base} {query} {page}；省略=用 url' },
        responseType: { type: 'string', enum: ['json', 'atom'], description: '仅 custom，默认 json' },
        authType: { type: 'string', enum: ['none', 'basic', 'bearer'], description: '免登录的源填 none（或省略）；仅确实要登录时才填 basic / bearer，凭据由用户手输' },
        mappingJson: { type: 'string', description: '仅 custom 必填：字段映射的 JSON 文本，键为 list / title / author / cover / summary / download / format，值为取值路径（a.b[*] 数组展开 / a.b[0] 定下标）；list、title、download 必给，下载直链无扩展名时另给 format' },
      },
      required: ['name', 'url'],
    },
    source: 'builtin',
    enabled: true,
    readOnly: false,
    requires: 'write',
    tier: 'ondemand',
    module: 'bookMarket',
  }, args => {
    const name = str(args.name).trim()
    if (!name) throw new Error('缺少必填参数: name')
    const url = str(args.url).trim()
    if (!url) throw new Error('缺少必填参数: url')
    // 地址非法要**明确报错**（与 bookSourceUpsert 同口径）：模型据此纠正后重试，
    // 而不是把一条坏地址送进表单等用户去发现
    if (!isAllowedSourceUrl(url)) throw new Error(`地址必须是 http/https 开头：${url}`)

    const kind = bookSourceEnum(args.kind, ['opds', 'custom'] as const, 'opds', 'kind')
    const authRaw = bookSourceEnum(args.authType, ['basic', 'bearer', 'none'] as const, 'none', 'authType')
    const authType: 'basic' | 'bearer' | null = authRaw === 'none' ? null : authRaw
    const searchUrl = str(args.searchUrl).trim()
    // 映射：schema 里是 `mappingJson` 字符串（800 字符红线的退化形状，见施工方案 §13.2），
    // 到这里先解析再交给 repo 的校验器 —— 界面 / IPC / AI 三条路共用同一套判定（铁律 2 同理）。
    // 「源配好了但解析不出结果」正是本需求要消灭的痛点（§4.1），拿不到合法映射就不放行。
    let mapping: BookSourceMapping | null = null
    if (kind === 'custom') {
      const raw = str(args.mappingJson).trim()
      if (!raw) throw new Error('custom 源必须给出 mappingJson（至少含 list / title / download 三条取值路径）。可让用户提供一段该源的检索响应样例，据此填写')
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { throw new Error(`mappingJson 不是合法 JSON：${raw.slice(0, 120)}`) }
      mapping = sanitizeBookSourcePatch({ mapping: parsed })?.mapping ?? null
      if (!mapping) throw new Error('mappingJson 里 list / title / download 三条取值路径必须都是非空字符串（如 {"list":"data.books[*]","title":"title","download":"files[0].url"}），请修正后重试')
    }
    const responseType = bookSourceEnum(args.responseType, ['json', 'atom'] as const, 'json', 'responseType')

    // 草案形状 = 渲染层 BookSourceDraft（预填表单用），**不含任何凭据字段**
    const draft = {
      name,
      kind,
      url,
      ...(searchUrl ? { searchUrl } : {}),
      ...(kind === 'custom' ? { responseType } : {}),
      ...(authType ? { authType } : {}),
      ...(mapping ? { mapping } : {}),
    }
    // 广播是「主进程 → 渲染层自定义事件」的唯一出口：渲染层据此切到书市模块并预填表单。
    // 这里**不发 broadcastDataChanged** —— 草案没有写盘，数据变更 scope 一条都不该动。
    broadcast(BROADCAST_CHANNEL.bookMarketSourceDraft, { draft })
    return {
      ok: true,
      draft,
      hint: '草案已送进「新建书源」表单并预填，界面已切到书市。请让用户核对字段、自己填写凭据后点「添加」——本工具不落库，不要说「已添加 / 已保存」',
    }
  })
}
