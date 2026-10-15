import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * AI 会话消息存储 v2 —— 一个会话一个 JSONL 文件，追加写（feature/ai-plugin-upgrade B）。
 *
 * v1（两份全局全量 JSON：agent-sessions.json / agent-messages.json）的问题不是格式，
 * 而是读写粒度：每追加一条消息 = 全部历史 读+parse+序列化+重写 ×2 文件，成本 O(全部历史)。
 * 已造成实际妥协：reasoning 全文不落库（agentService.ts：「思考链长度常是正文数倍」）。
 *
 * v2 存储（baseDir 由调用方注入；2026-10-13 起 baseDir = 当前仓库的 `.knowbase/agent/`，
 * 会话随仓库走前是 userData/data/，布局未变）：
 *   sessions.json               会话索引（小文件，全量重写可接受；由 agentSessionRepo 管）
 *   messages/<id>.jsonl         每会话一个文件，一行一条消息，追加=O(1)
 *   agent-messages.json         v1 遗留：全体消息一个文件（仅认领时拷入仓库，随后拆分）
 *   agent-messages.migrated.json  v1 迁移完成后的原文件改名留存
 *
 * 纯逻辑模块（不 import electron）：baseDir 由调用方注入，node 冒烟可直接跑
 * （对标 pluginHostGateway 的依赖注入写法）。会话级 ops 语义（排序/截断/删后）
 * 与 v1 逐条对齐，见各函数注释。
 */

export interface AgentMessageRow {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  trace_json: string | null
  created_at: string
}

/**
 * 每会话消息文件所在子目录。
 * ★ 必须与 agentSessionMigrate 的 MESSAGES_DIR_DST 一致：认领把全局 `agent-messages/`
 *   里的文件拷到本名字下，读端从这里取 —— 两处不一致的后果是「认领成功但消息全看不见」
 *   （2026-10-13 契约脚本 verify-agent-session-migrate.mjs 的 §4 就是为这条设的）。
 */
const MESSAGES_DIR = 'messages'
const LEGACY_FILE = 'agent-messages.json'
const MIGRATED_FILE = 'agent-messages.migrated.json'

/** 会话 id = randomUUID；白名单字符防路径穿越（../、盘符、分隔符全部拒绝） */
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/

function sessionFilePath(baseDir: string, sessionId: string): string {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
    throw new Error(`非法会话 id: ${String(sessionId).slice(0, 64)}`)
  }
  return join(baseDir, MESSAGES_DIR, `${sessionId}.jsonl`)
}

function ensureDir(baseDir: string): void {
  const dir = join(baseDir, MESSAGES_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function parseLine(line: string): AgentMessageRow | null {
  if (!line.trim()) return null
  try {
    return JSON.parse(line) as AgentMessageRow
  } catch {
    // 单行损坏只跳过该行，不弃整个会话（对齐 globalJsonStore 的「损坏兜底不崩应用」语义，
    // 但 JSONL 粒度更细：v1 一处损坏丢全库，v2 最多丢一行）
    console.warn('[agentMessageStore] 跳过损坏行')
    return null
  }
}

/** 读单会话全部消息（行序 = 写入序）；文件不存在 = 空会话 */
export function readMessages(baseDir: string, sessionId: string): AgentMessageRow[] {
  const p = sessionFilePath(baseDir, sessionId)
  if (!existsSync(p)) return []
  const out: AgentMessageRow[] = []
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const row = parseLine(line)
    if (row) out.push(row)
  }
  return out
}

/** 追加一条消息（单行 appendFileSync，一次 write 调用，原子性同小文件写） */
export function appendMessage(baseDir: string, row: AgentMessageRow): void {
  if (!row?.id || !row?.session_id) throw new Error('消息缺 id/session_id')
  ensureDir(baseDir)
  appendFileSync(sessionFilePath(baseDir, row.session_id), JSON.stringify(row) + '\n', 'utf-8')
}

/** 整文件原子重写（tmp + rename，对齐 globalJsonStore 策略；Windows 先删旧文件再 rename 兜底） */
export function rewriteMessages(baseDir: string, sessionId: string, rows: AgentMessageRow[]): void {
  const p = sessionFilePath(baseDir, sessionId)
  ensureDir(baseDir)
  const tmp = p + '.tmp'
  const body = rows.map((r) => JSON.stringify(r)).join('\n')
  writeFileSync(tmp, rows.length > 0 ? body + '\n' : '', 'utf-8')
  try {
    renameSync(tmp, p)
  } catch {
    if (existsSync(p)) unlinkSync(p)
    renameSync(tmp, p)
  }
}

export function deleteMessagesFile(baseDir: string, sessionId: string): void {
  const p = sessionFilePath(baseDir, sessionId)
  if (existsSync(p)) unlinkSync(p)
}

/**
 * v1 排序语义（原 SQL：ORDER BY created_at ASC, rowid ASC）：
 * created_at 同秒内按写入序（行序）平局决胜，然后取最早 500 条。
 */
export function getMessagesPage(baseDir: string, sessionId: string, limit = 500): AgentMessageRow[] {
  return readMessages(baseDir, sessionId)
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      if (a.m.created_at !== b.m.created_at) return a.m.created_at < b.m.created_at ? -1 : 1
      return a.i - b.i
    })
    .slice(0, limit)
    .map((x) => x.m)
}

/** 编辑消息内容并清 trace（编辑重推语义：旧回复链随之作废） */
export function updateMessageContent(baseDir: string, sessionId: string, id: string, content: string): boolean {
  const rows = readMessages(baseDir, sessionId)
  const row = rows.find((m) => m.id === id)
  if (!row) return false
  row.content = content
  row.trace_json = null
  rewriteMessages(baseDir, sessionId, rows)
  return true
}

export function deleteMessageById(baseDir: string, sessionId: string, id: string): boolean {
  const rows = readMessages(baseDir, sessionId)
  const kept = rows.filter((m) => m.id !== id)
  if (kept.length === rows.length) return false
  rewriteMessages(baseDir, sessionId, kept)
  return true
}

/**
 * 删除某条消息之后的所有消息（重新生成/编辑重推清旧回复）。
 * v1 是全局数组下标比较；v2 会话文件内行序即该会话的插入序，删 idx 之后全部行，语义等价。
 */
export function deleteMessagesAfterId(baseDir: string, sessionId: string, messageId: string): number {
  const rows = readMessages(baseDir, sessionId)
  const idx = rows.findIndex((m) => m.id === messageId)
  if (idx === -1) return 0
  rewriteMessages(baseDir, sessionId, rows.slice(0, idx + 1))
  return rows.length - (idx + 1)
}

export interface LegacyMigrationResult { sessions: number; messages: number }

/**
 * v1 → v2 一次性迁移：把 agent-messages.json 按 session_id 拆成 .jsonl，
 * 校验无丢失后把原文件改名留存（不删用户数据）。
 *
 * 幂等 + 合并语义：重跑时读取已存在的 v2 文件，按消息 id 去重后排在 legacy 行之后——
 * 覆盖「上次迁移写盘成功但改名失败，期间又有新消息追加」的窗口，重试不丢新数据。
 * 迁移中 ensureMigrated 标志不置位，消息操作照常走 v2 读（空/部分文件兜底，与 v1 损坏时返回空等价）。
 */
export function migrateLegacyMessages(baseDir: string): LegacyMigrationResult | null {
  const legacyPath = join(baseDir, LEGACY_FILE)
  if (!existsSync(legacyPath)) return null
  const raw: unknown = JSON.parse(readFileSync(legacyPath, 'utf-8'))
  if (!Array.isArray(raw)) throw new Error('legacy agent-messages.json 不是数组，拒绝迁移')
  const rows = raw.filter((r): r is AgentMessageRow =>
    !!r && typeof r === 'object' && typeof (r as AgentMessageRow).id === 'string' && typeof (r as AgentMessageRow).session_id === 'string')
  const bySession = new Map<string, AgentMessageRow[]>()
  for (const r of rows) {
    const list = bySession.get(r.session_id)
    if (list) list.push(r)
    else bySession.set(r.session_id, [r])
  }
  ensureDir(baseDir)
  let messages = 0
  const migratedIds = new Set<string>()
  for (const [sid, legacyRows] of bySession) {
    const existing = readMessages(baseDir, sid)
    const seen = new Set(legacyRows.map((r) => r.id))
    const merged = [...legacyRows, ...existing.filter((r) => !seen.has(r.id))]
    rewriteMessages(baseDir, sid, merged)
    for (const r of merged) migratedIds.add(r.id)
    messages += merged.length
  }
  // 校验：每一条 legacy 行都必须出现在落盘结果里（缺一条即失败，原文件不动）
  for (const r of rows) {
    if (!migratedIds.has(r.id)) throw new Error(`迁移校验失败：消息 ${r.id} 未落盘`)
  }
  const target = join(baseDir, MIGRATED_FILE)
  try {
    renameSync(legacyPath, target)
  } catch {
    if (existsSync(target)) unlinkSync(target)
    renameSync(legacyPath, target)
  }
  return { sessions: bySession.size, messages }
}
