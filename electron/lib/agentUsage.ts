/**
 * AI 用量统计与会话文件改动审计（v3.4.0 批次5，方案 workbench-shell-design §4 / §3.8）。
 *
 * 1. Token 用量：agentService 每轮 LLM 调用成功后记账（输入/输出/缓存命中），
 *    按日聚合落 `userData/data/ai-usage.json`（与 AI 会话同层，换机不迁移）。
 *    右栏 token 面板「今日消耗卡」与「会话消耗 TOP」经 IPC 只读。
 * 2. 会话文件改动：AI 写类工具落盘后在 agentService 收集 changes 处同步记入内存
 *    （按会话分桶，不落盘——重启即清，只服务当次运行内的右栏「改动文件」控件）。
 *    不改 plugin-audit.json（那是插件审计，本条是会话级文件变更新通道）。
 *
 * 写盘防抖：多轮工具循环可能在一秒内连续多笔 LLM 记账，合并为一次原子写。
 */

import { globalReadJson, globalWriteJson } from './globalJsonStore'

const USAGE_FILE = 'ai-usage.json'
const KEEP_DAYS = 30
const FLUSH_MS = 1500
const MAX_SESSION_CHANGES = 80

/** 单日聚合（in/out 为纯 token 数；cache 为提示缓存命中 token 数，只作展示参考） */
export interface AiUsageDay {
  in: number
  out: number
  cache: number
  calls: number
  /** 按会话分桶的当日消耗（会话消耗 TOP 数据源；title 为记账时快照） */
  sessions: Record<string, { title: string; in: number; out: number }>
}

interface AiUsageFile {
  version: 1
  days: Record<string, AiUsageDay>
}

/** 会话内一次 AI 文件写改动的审计条目（右栏「改动文件」行） */
export interface SessionFileChange {
  sessionId: string
  sessionTitle: string
  /** 工具注册名（builtin.vault.edit 等） */
  tool: string
  /** 人类可读动作（编辑/新建…，与 AgentChange.action 同源） */
  action: string
  /** 目标摘要（文件 relPath 或标题） */
  target: string
  /** 可直达编辑器的仓库内文件 relPath */
  file?: string
  /** M=修改 / A=新建（从工具名与动作词推导，尽力而为） */
  op: 'M' | 'A'
  at: string
}

export interface AiUsageRecordInput {
  sessionId: string
  sessionTitle?: string
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
}

function todayKey(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function emptyDay(): AiUsageDay {
  return { in: 0, out: 0, cache: 0, calls: 0, sessions: {} }
}

let usageCache: AiUsageFile | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null

function load(): AiUsageFile {
  if (usageCache) return usageCache
  usageCache = globalReadJson<AiUsageFile>(USAGE_FILE, { version: 1, days: {} })
  if (!usageCache || typeof usageCache !== 'object' || !usageCache.days) usageCache = { version: 1, days: {} }
  return usageCache
}

function flush(): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    if (!usageCache) return
    // 保留 KEEP_DAYS 天：写盘时顺手清理过期日桶
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000
    for (const key of Object.keys(usageCache.days)) {
      const t = new Date(`${key}T00:00:00`).getTime()
      if (Number.isFinite(t) && t < cutoff) delete usageCache.days[key]
    }
    globalWriteJson(USAGE_FILE, usageCache)
  }, FLUSH_MS)
}

/** agentService 每轮 LLM 成功后记账（多轮工具循环记多笔 = 真实成本） */
export function recordAiUsage(rec: AiUsageRecordInput): void {
  const file = load()
  const key = todayKey()
  const day = file.days[key] ?? (file.days[key] = emptyDay())
  const inTok = Math.max(0, Math.round(Number(rec.promptTokens ?? 0)))
  const outTok = Math.max(0, Math.round(Number(rec.completionTokens ?? 0)))
  day.in += inTok
  day.out += outTok
  day.cache += Math.max(0, Math.round(Number(rec.cachedTokens ?? 0)))
  day.calls += 1
  if (rec.sessionId) {
    const sid = rec.sessionId
    const bucket = day.sessions[sid] ?? (day.sessions[sid] = { title: rec.sessionTitle ?? '', in: 0, out: 0 })
    if (rec.sessionTitle) bucket.title = rec.sessionTitle
    bucket.in += inTok
    bucket.out += outTok
  }
  flush()
}

/** 全量日桶（渲染层自行聚合「今日 / 近 7 天」） */
export function getAiUsageData(): { days: Record<string, AiUsageDay> } {
  return { days: load().days }
}

// ---- 会话文件改动（内存，进程生命周期内有效） ----

const sessionChanges = new Map<string, SessionFileChange[]>()

/** op 推导（尽力而为）：动作词含新建/创建 → A；否则 M */
function deriveOp(tool: string, action: string): 'M' | 'A' {
  if (/新建|创建|新笔记|新文档/.test(action)) return 'A'
  if (/\.(create|write|new)/i.test(tool)) return 'A'
  return 'M'
}

/** agentService 收集到 vault 文件写改动时同步记入（供右栏「改动文件」控件拉取） */
export function recordSessionFileChange(sessionId: string, change: {
  tool: string; action: string; target: string; file?: string
}, sessionTitle = ''): void {
  const entry: SessionFileChange = {
    sessionId,
    sessionTitle,
    tool: change.tool,
    action: change.action,
    target: change.target,
    ...(change.file ? { file: change.file } : {}),
    op: deriveOp(change.tool, change.action),
    at: new Date().toISOString(),
  }
  let bucket = sessionChanges.get(sessionId)
  if (!bucket) { bucket = []; sessionChanges.set(sessionId, bucket) }
  bucket.push(entry)
  if (bucket.length > MAX_SESSION_CHANGES) bucket.splice(0, bucket.length - MAX_SESSION_CHANGES)
}

/**
 * 拉取会话文件改动：带 sessionId = 该会话的；不传 = 本次运行全部（按时间倒序）。
 * 主进程重启即清空（内存通道，方案 §3.8 拍板口径）。
 */
export function getSessionChanges(sessionId?: string): SessionFileChange[] {
  if (sessionId) return [...(sessionChanges.get(sessionId) ?? [])].reverse()
  const all: SessionFileChange[] = []
  for (const bucket of sessionChanges.values()) all.push(...bucket)
  return all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}
