import { randomUUID } from 'crypto'
import { join } from 'path'
import { readJson, writeJson, writeJsonOrThrow } from './kbStore/jsonStore'
import { getCurrentVault, getVaultKbRoot } from './kbStore/vaultContext'
import { globalDataDir } from './globalJsonStore'
import { writeAdoptNotice } from './agentAdoptNotice'
import { adoptLegacyGlobalAgentStore, type AdoptResult } from './agentSessionMigrate'
import { normalizeSessionFields } from './agentSessionNormalizePure'
// 类型专用导入（零运行时代价）：续跑现场的结构真源在 agentInterruptPure，仓库不另立一份
import type { SessionResume } from './agentInterruptPure'
import {
  appendMessage, deleteMessageById, deleteMessagesAfterId, deleteMessagesFile,
  getAllMessages, getMessagesPage, migrateLegacyMessages, readMessages, updateMessageContent as storeUpdateMessageContent,
  type AgentMessageRow,
} from './agentMessageStore'

export type { AgentMessageRow }

/**
 * AI 会话存储 —— **随仓库走**（2026-10-13 拍板，见 docs/agent-sessions-vault-plan.md）。
 *
 * 位置：`<仓库>/.knowbase/agent/`
 *   sessions.json               会话索引（小文件，全量重写可接受）
 *   messages/<sessionId>.jsonl  每会话一个文件，一行一条消息，追加写 = O(1)
 *
 * 沿革：R6 去库化（D9）把会话从 sqlite 表搬到 userData/data/*.json 时沿用了「全局」口径
 * （那正是原 knowledge.db 所在层），于是切仓库仍看得到别的仓库的对话；本条改为随仓库，
 * 与「Vault = 唯一真相源，换机 = 拷走文件夹」对齐。存量全局会话由
 * `agentSessionMigrate.adoptLegacyGlobalAgentStore()` 在首次进入仓库时认领。
 *
 * **不带 `rootId` 字段**：存储位置本身就是作用域，加一份冗余字段只会漂移。
 *
 * 消息层（agentMessageStore）按 baseDir 注入设计，换根本身只需换基目录；唯一另需同步的是它的
 * `MESSAGES_DIR` 常量（原 `'agent-messages'` → `'messages'`，两端不一致会「认领成功但消息读不出来」）。
 * v1 的 `agent-messages.json` 全量文件（每条消息 O(全部历史) 重写）在仓库目录内一次性拆分。
 * 删除会话级联清消息文件；首次消息操作触发 legacy 一次性迁移。
 *
 * 无当前仓库时：读静默返回空、写抛错（绝不静默丢消息）。
 *
 * 会话 + 消息两级（迁移 046）；行结构与原表列名（snake_case）一致；会话数组顺序即原
 * rowid 顺序（只 push / filter，不重排存储数组），用于平局排序；消息文件行序 = 会话内插入序。
 */

/** `.knowbase/agent` —— jsonStore 的 module 段 */
const AGENT_DIR = 'agent'
const SESSIONS_FILE = 'sessions.json'

/**
 * 当前仓库的 AI 会话目录（绝对路径）；无当前仓库返回 null。
 * 供主进程其他模块（如迁移器）与契约脚本定位存储。
 */
export function vaultAgentDir(): string | null {
  const kbRoot = getVaultKbRoot()
  return kbRoot ? join(kbRoot, AGENT_DIR) : null
}

/** 无仓库抛错的版本（写路径用：调用方会据此向用户汇报成功，静默失败等于骗人） */
function requireAgentDir(): string {
  const dir = vaultAgentDir()
  if (!dir) throw new Error('尚未打开仓库，无法读写 AI 会话')
  return dir
}

/**
 * 会话来源：用于把「通用 AI 助手」（侧栏 / AI 学堂）与「AI 教学」的会话列表互相隔离。
 * 二者共用同一张会话表（同一份存储、同一套 AgentRunner），只在列表展示上按来源分流。
 * 与 src/types 的 AgentSessionSource 同构（跨线各声明一次的仓规）；v3.12.0 加 'intel'（📡 情报助手）。
 */
export type AgentSessionSource = 'assistant' | 'aiTeaching' | 'schedule' | 'aiAssistant' | 'intel'

/**
 * 写入策略（统一 AI 助手，v3.11.0）：
 * - `direct`：写工具立即执行；
 * - `confirm`：所有可暂存写工具先进入 ChangePlan，用户确认后应用。
 */
export type SessionWriteMode = 'direct' | 'confirm'

/** 思考强度档位（与 AI 教学 / agentService 同口径） */
export type SessionEffort = 'off' | 'low' | 'medium' | 'high'

/**
 * 会话通道（台账 N-1「手册通道」）：
 * - `'manual'` = 使用帮助通道（只检索官方手册、effort off、≤3 轮、不注入教学/感知规则）；
 * - `'agent'`（或未标记） = 通用助手通道。
 * 仅 assistant 来源适用；AI 教学（source=aiTeaching）恒走通用通道。
 * 未标记 = 尚未分类（等同 agent），首条用户消息时一次性分类后写入。
 */
export type AgentSessionMode = 'manual' | 'agent'

/** 会话压缩纪要（docs/conversation-compaction-design.md）：覆盖 upto_id 及之前的消息 */
export interface SessionDigest {
  /** 纪要正文（markdown，生成侧 ≤4000 chars 截断保护） */
  text: string
  /** 检查点：已纳入纪要的最后一条消息 id（之后的消息仍以原文进上下文） */
  upto_id: string
  /** 累计被折叠的消息条数（跨多次增量压缩累加） */
  covered: number
  updated_at: string
}

export interface AgentSessionRow {
  id: string
  title: string
  /** 会话级全局要求（056 迁移；空串=无） */
  instructions?: string
  /** 来源（缺省=assistant；存量老数据无此字段，由 backfillSessionSources 回填） */
  source?: AgentSessionSource
  /** 通道（N-1 手册通道）：'manual'=使用帮助通道；缺省/'agent'=通用助手。仅 assistant 来源适用 */
  mode?: AgentSessionMode
  created_at: string
  updated_at: string
  /** 钉住时间（「★ 收藏」分区）：有值 = 已钉住（值用于收藏内排序）；缺省 = 未钉住。仅通用助手用 */
  pinned_at?: string
  /** 会话压缩纪要（缺省=未压缩）。原消息永不删除，置 null 即回滚 */
  digest?: SessionDigest
  /**
   * 续跑现场（A 方案 §3.1，2026-10-14）：最近一次中断留下的断点。缺省 = 无可续点。
   *
   * 为什么放会话行、不放消息行：语义上「一个会话只有一个可续的断点（最近一次）」，天然幂等；
   * 且它带 6k 字符的 carry 正文，放消息行会被 `agent:messages` 全量发给渲染层。
   * 出口裁剪：`agent:sessions` 只发 toResumeInfo()（见 agentService），**绝不带 carry**。
   */
  resume?: SessionResume
  /**
   * 支线旁问（v3.1.2 条目11）：挂靠的主线会话 id。缺省 = 非支线。
   * 与主线物理隔离（独立 sessionId + 独立 .jsonl），删除主线时级联删除。
   */
  parentSessionId?: string
  /** 支线旁问：分叉点的主线消息 id（那个被追问的回答） */
  branchFromMessageId?: string
  /** 支线旁问：'side' = 支线（默认不进左栏会话列表）；缺省 / 'main' = 主线可见（升格后置 'main'） */
  lane?: 'main' | 'side'
  /** 支线旁问：固化上下文快照（分叉回答全文 + 主线前 K 轮），每轮注入 system。不参与摘要压缩 */
  sideContext?: string
  /** 支线旁问：运行态 'run' 进行中 / 'done' 已答 / 'cut' 已中断（缺省 run） */
  lane_status?: 'run' | 'done' | 'cut'
  /** 支线旁问：上次打开（已读）的本地时间串；缺省 = 从未打开 */
  lane_seen_at?: string
  /**
   * 统一 AI 助手（v3.11.0）文件作用域：归一化后的仓库相对前缀数组
   * （目录前缀 + 单文件路径）。`scopeAll=false` 时严格按它限制；空数组 = 不读取仓库文件。
   * 旧 `source='aiAssistant'` 会话迁移后保留原值。
   */
  scope?: string[]
  /**
   * 是否作用于整个仓库（v3.11.0）：
   * - `true`：整个仓库，`scope` 必须为空；
   * - `false`：严格按 `scope` 限制（空数组 = 不读取任何仓库文件）；
   * - 缺省：旧数据，读取时按来源补默认值（assistant → true，aiAssistant → false）。
   */
  scopeAll?: boolean
  /** 写入策略（v3.11.0）；缺省 = direct */
  writeMode?: SessionWriteMode
  /** 会话级模型（空 = 跟随全局设置） */
  modelId?: string
  /** 会话级思考强度（空 = 跟随全局设置） */
  effort?: SessionEffort
}

/** 等价 datetime('now','localtime')：本地时间 "YYYY-MM-DD HH:MM:SS" */
export function nowLocal(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 读会话索引：无仓库 / 文件不存在 → 空数组（读路径不抛错）。
 * 统一助手字段迁移（v3.11.0）是幂等的；读路径顺带迁移用静默 writeJson：
 * 一次迁移失败不该让整个会话列表请求报错。
 */
function readSessions(): AgentSessionRow[] {
  const rows = readJson<AgentSessionRow[]>(AGENT_DIR, SESSIONS_FILE, [])
  let dirty = false
  for (const row of rows) if (normalizeSessionFields(row)) dirty = true
  if (dirty) writeJson(AGENT_DIR, SESSIONS_FILE, rows)
  return rows
}

/** 写会话索引：无仓库或写盘失败抛错（写路径必须让调用方知道没落盘） */
function writeSessions(rows: AgentSessionRow[]): void {
  writeJsonOrThrow(AGENT_DIR, SESSIONS_FILE, rows)
}

/** legacy 全量文件 → 分文件，进程内一次性（失败不置位，下次消息操作重试） */
let legacyMigrated = false
function ensureMigrated(): void {
  if (legacyMigrated) return
  const dir = vaultAgentDir()
  if (!dir) return // 无仓库：**不置位**——置了本进程就再也不会迁（切换仓库后即失效）
  try {
    const r = migrateLegacyMessages(dir)
    if (r) {
      console.log(`[AgentSessions] 旧版全量消息已迁移：${r.sessions} 会话 / ${r.messages} 条 → .knowbase/agent/messages/*.jsonl（原文件留存为 agent-messages.migrated.json）`)
    }
    legacyMigrated = true
  } catch (err) {
    console.error('[AgentSessions] 旧版消息迁移失败（原文件保留，下次操作重试；本次按 v2 读取）', err)
  }
}

/**
 * 进入仓库后的收尾：把升级前攒在全局目录里的存量会话**认领**进当前仓库。
 *
 * 由 workspaceManager 在「仓库成为当前仓库」时调用（启动恢复 / 打开仓库 / 导入仓库）。
 * 三条性质：
 * - **幂等**：认领成功的标志是全局 `agent-sessions.json` 被改名，再调直接返回
 *   `{ adopted: false }`，因此不会给第二个仓库复制一份；
 * - **进程内只试一次**：失败（如全局索引损坏）只打日志、不阻断进入仓库，也不反复重试 ——
 *   全局文件原样保留，下次启动再说；
 * - **无仓库不置位**：启动时还没有当前仓库（仓库选择页形态）不算「试过」，
 *   等真正进入仓库时再认领。
 */
let adoptTried = false
export function adoptLegacyAgentSessionsToVault(): AdoptResult | null {
  if (adoptTried) return null
  const dir = vaultAgentDir()
  const cur = getCurrentVault()
  if (!dir || !cur) return null
  adoptTried = true
  try {
    const r = adoptLegacyGlobalAgentStore({ globalDir: globalDataDir(), vaultAgentDir: dir })
    // v1 全量消息文件（若有）刚被原样拷进来：立刻拆分，让存储即刻正确、告知里的条数也准
    let messages = r.messages
    try {
      const legacy = migrateLegacyMessages(dir)
      if (legacy) {
        messages += legacy.messages
        legacyMigrated = true
      }
    } catch (err) {
      console.error('[AgentSessions] 认领后的 v1 消息拆分失败（原文件保留，下次消息操作重试）', err)
    }
    if (r.adopted) {
      console.log(`[AgentSessions] 存量会话已认领进仓库「${cur.name}」：${r.sessions} 会话 / ${messages} 条消息`)
      writeAdoptNotice({ sessions: r.sessions, messages, vaultName: cur.name })
    }
    return { ...r, messages }
  } catch (err) {
    console.error('[AgentSessions] 存量会话认领失败（全局文件原样保留，下次启动重试）', err)
    return null
  }
}

export function createAgentSession(title = '新会话', source: AgentSessionSource = 'assistant'): AgentSessionRow {
  const legacyAiAssistant = source === 'aiAssistant'
  const unified = source === 'assistant' || legacyAiAssistant
  const row: AgentSessionRow = {
    id: randomUUID(),
    title,
    instructions: '',
    // 新统一助手不再产生 aiAssistant 来源；兼容入口仍归一成 assistant
    source: legacyAiAssistant ? 'assistant' : source,
    ...(unified
      ? {
          scopeAll: !legacyAiAssistant,
          scope: [] as string[],
          writeMode: legacyAiAssistant ? 'confirm' : 'direct',
        }
      : {}),
    created_at: nowLocal(),
    updated_at: nowLocal(),
  }
  const sessions = readSessions()
  sessions.push(row)
  writeSessions(sessions)
  return row
}

/** 写会话通道（N-1 手册通道）：首条消息分类、或手册通道内检测到操作意图升格时调用。 */
export function setSessionMode(id: string, mode: AgentSessionMode): void {
  const sessions = readSessions()
  const row = sessions.find((s) => s.id === id)
  if (!row || row.mode === mode) return
  row.mode = mode
  writeSessions(sessions)
}

/**
 * 钉住 / 取消钉住会话（通用助手左栏「★ 收藏」分区）。
 * pinned=true 记当前时间（收藏内按钉住时间倒序）；false 清除字段。
 * 返回是否命中该会话。
 */
export function setSessionPinned(id: string, pinned: boolean): boolean {
  const sessions = readSessions()
  const row = sessions.find((s) => s.id === id)
  if (!row) return false
  if (pinned) row.pinned_at = nowLocal()
  else delete row.pinned_at
  writeSessions(sessions)
  return true
}

/**
 * 建一条支线旁问会话（v3.1.2 条目11）。
 *
 * 与主线**物理隔离**（独立 sessionId + 独立 .jsonl 消息文件）——这是「追问不污染主线」的
 * 根本保证，不靠提示词约束。上下文以**固化快照**（`sideContext`）携带，非每轮重算：
 * 主线后续改动不同步进支线（支线 = 分叉那一刻的快照），且 prompt cache 前缀稳定。
 *
 * `lane: 'side'` 表示默认不进左栏会话列表（升格 promoteSideLane 后置 'main'）。
 */
export function createSideLaneSession(opts: {
  parentSessionId: string
  branchFromMessageId: string
  /** 固化上下文快照（分叉回答全文 + 主线前 K 轮）；调用方负责截断 */
  sideContext: string
  title?: string
  source?: AgentSessionSource
}): AgentSessionRow {
  const row: AgentSessionRow = {
    id: randomUUID(),
    title: opts.title?.trim() || '支线旁问',
    instructions: '',
    source: opts.source ?? 'aiTeaching',
    created_at: nowLocal(),
    updated_at: nowLocal(),
    parentSessionId: opts.parentSessionId,
    branchFromMessageId: opts.branchFromMessageId,
    lane: 'side',
    sideContext: opts.sideContext,
    lane_status: 'run',
  }
  const sessions = readSessions()
  sessions.push(row)
  writeSessions(sessions)
  return row
}

/**
 * 列出挂靠在某主线会话下的全部支线（含已升格为 'main' 的）。
 * 供左栏缩进渲染与「删除主线前的支线计数」使用。
 */
export function listSideLanes(parentSessionId: string): AgentSessionRow[] {
  return readSessions().filter((s) => s.parentSessionId === parentSessionId)
}

/**
 * 升格支线为正式会话（单向，不可逆）：lane 置 'main' → 进入左栏会话列表显示。
 * 保留 parentSessionId 以便渲染缩进 + 「支线」徽章；无 parentSessionId 的普通会话返回 false。
 */
export function promoteSideLane(laneSessionId: string): boolean {
  const sessions = readSessions()
  const row = sessions.find((s) => s.id === laneSessionId)
  if (!row || !row.parentSessionId) return false
  row.lane = 'main'
  row.updated_at = nowLocal()
  writeSessions(sessions)
  return true
}

/**
 * 支线运行态：'done' 已答 / 'cut' 已中断（见 .claude/plans/ai-teaching-side-lane-center.md）。
 * 仅对挂靠主线的支线生效；普通会话 no-op。
 */
export function setSideLaneStatus(id: string, status: 'run' | 'done' | 'cut'): void {
  const sessions = readSessions()
  const row = sessions.find((s) => s.id === id)
  if (!row || !row.parentSessionId) return
  if (row.lane_status === status) return
  row.lane_status = status
  row.updated_at = nowLocal()
  writeSessions(sessions)
}

/**
 * 标记支线已读（打开详情时调）：只写 lane_seen_at，**不** bump updated_at
 * ——读一下不该把会话顶到列表最上。返回是否命中。
 */
export function markSideLaneSeen(id: string, at: string = nowLocal()): boolean {
  const sessions = readSessions()
  const row = sessions.find((s) => s.id === id)
  if (!row || row.lane === 'main') return false
  row.lane_seen_at = at
  writeSessions(sessions)
  return true
}

/**
 * 存量会话来源回填：老数据没有 source 字段，调用方传入推断函数。
 *
 * @param infer 返回 'aiTeaching' 表示判定为教学会话；返回 null 表示"判不出来"
 * @param overwrite 修正模式。默认 false（初始化）：source 缺省的一律定性，判不出来算 assistant。
 *   置 true（修正）：**允许覆盖已标记的条目**，但只在 infer 明确返回来源时才改 ——
 *   用于修复"上一轮回填判据不全、把教学会话误标成 assistant"的历史数据
 *   （2026-09-10 实况：只按工作区归属判定，漏掉了未分配工作区的教学会话）。
 * @returns 实际写入的条数
 */
export function backfillSessionSources(
  infer: (id: string, title: string) => AgentSessionSource | null,
  overwrite = false,
): number {
  const sessions = readSessions()
  let n = 0
  for (const s of sessions) {
    const src = infer(s.id, s.title)
    if (overwrite) {
      if (src && src !== s.source) { s.source = src; n++ }
    } else if (!s.source) {
      s.source = src ?? 'assistant'
      n++
    }
  }
  // 回填是**读路径顺带写**：用静默 writeJson —— 一次回填写失败不该让整个会话列表请求报错
  if (n > 0) writeJson(AGENT_DIR, SESSIONS_FILE, sessions)
  return n
}

export function listAgentSessions(): AgentSessionRow[] {
  // 原 SQL：ORDER BY updated_at DESC, rowid DESC LIMIT 200
  return readSessions()
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      if (a.s.updated_at !== b.s.updated_at) return a.s.updated_at < b.s.updated_at ? 1 : -1
      return b.i - a.i
    })
    .slice(0, 200)
    .map((x) => x.s)
}

export function renameAgentSession(id: string, title: string): void {
  const sessions = readSessions()
  const row = sessions.find((s) => s.id === id)
  if (!row) return
  row.title = title
  row.updated_at = nowLocal()
  writeSessions(sessions)
}

/** 会话级全局要求（≤800 字；空串=清除）：只在本会话的后续轮次注入 system */
export function updateAgentSessionInstructions(id: string, instructions: string): void {
  const text = String(instructions ?? '').trim().slice(0, 800)
  const sessions = readSessions()
  const row = sessions.find((s) => s.id === id)
  if (!row) return
  row.instructions = text
  row.updated_at = nowLocal()
  writeSessions(sessions)
}

/** 作用域归一：去空白、去空项、去重、上限 500（落库侧最后一道保护） */
export function normalizeSessionScope(scope: string[]): string[] {
  const seen = new Set<string>()
  const clean: string[] = []
  for (const raw of Array.isArray(scope) ? scope : []) {
    const s = String(raw ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!s || seen.has(s)) continue
    seen.add(s)
    clean.push(s)
    if (clean.length >= 500) break
  }
  return clean
}

/**
 * 统一 AI 助手作用域（归一：去空白、去空项、去重、限量）。
 *
 * **不动 `updated_at`** —— 勾选范围是编辑动作、不是对话活跃，改它会把任务无意义地顶到列表最上
 * （同 digest 口径）。
 *
 * `scopeAll`：
 * - true → 整个仓库，强制清空 scope；
 * - false → 严格按 scope（空数组 = 不读取仓库文件）；
 * - 缺省 → 兼容旧调用：scope 非空时视为缩窄，空数组保持当前值。
 */
export function updateAgentSessionScope(id: string, scope: string[], scopeAll?: boolean): void {
  const clean = normalizeSessionScope(scope)
  const sessions = readSessions()
  const row = sessions.find((s) => s.id === id)
  if (!row) return
  if (scopeAll === true) {
    row.scopeAll = true
    row.scope = []
  } else if (scopeAll === false) {
    row.scopeAll = false
    row.scope = clean
  } else if (row.scopeAll === true) {
    // 旧调用只传了 scope：非空 = 用户明确缩窄；空数组保持「整个仓库」
    if (clean.length > 0) {
      row.scopeAll = false
      row.scope = clean
    }
  } else {
    row.scope = clean
  }
  writeSessions(sessions)
}

/**
 * 会话级偏好（写入策略 / 模型 / 思考强度）。
 * 与作用域同口径：不碰 `updated_at`，改设置不是对话活跃。
 */
export function updateAgentSessionPreferences(id: string, patch: {
  writeMode?: SessionWriteMode
  modelId?: string
  effort?: SessionEffort
}): void {
  const sessions = readSessions()
  const row = sessions.find((s) => s.id === id)
  if (!row) return
  if (patch.writeMode === 'direct' || patch.writeMode === 'confirm') row.writeMode = patch.writeMode
  if (patch.modelId !== undefined) {
    const modelId = String(patch.modelId ?? '').trim()
    if (modelId) row.modelId = modelId
    else delete row.modelId
  }
  if (patch.effort !== undefined) {
    const effort = patch.effort
    if (effort === 'off' || effort === 'low' || effort === 'medium' || effort === 'high') row.effort = effort
  }
  writeSessions(sessions)
}

export function getAgentSession(id: string): AgentSessionRow | undefined {
  return readSessions().find((s) => s.id === id)
}

/**
 * 写回/清除会话压缩纪要（null = 清除，即回滚到未压缩态）。
 * 不动 updated_at：会话列表排序由消息活跃驱动，压缩本身不应把会话顶到最上。
 */
export function updateSessionDigest(id: string, digest: SessionDigest | null): void {
  const sessions = readSessions()
  const row = sessions.find((s) => s.id === id)
  if (!row) return
  if (digest) row.digest = digest
  else delete row.digest
  writeSessions(sessions)
}

export function deleteAgentSession(id: string): void {
  // 显式先删子消息（不依赖原 SQL 外键级联；v2 = 删整个会话消息文件）
  ensureMigrated()
  deleteMessagesFile(requireAgentDir(), id)
  const sessions = readSessions()
  const keptSessions = sessions.filter((s) => s.id !== id)
  if (keptSessions.length !== sessions.length) writeSessions(keptSessions)
}

/**
 * 写回/清除续跑现场（null = 清除）。
 * 与 updateSessionDigest 同款：**不动 updated_at**（中断不该把会话顶到列表最上）。
 * 调用方（agentService.interruptResult）用 try/catch 包住：记不上现场不能改变本次调用的返回结果。
 */
export function updateSessionResume(id: string, resume: SessionResume | null): void {
  const sessions = readSessions()
  const row = sessions.find((s) => s.id === id)
  if (!row) return
  if (resume) row.resume = resume
  else delete row.resume
  writeSessions(sessions)
}

/**
 * 消息删改 → 续跑现场作废（与 invalidateDigestOnMutation 同构，但**更宽**）。
 *
 * 为什么宽：断点绑在**具体那条中断消息**上（resume.message_id），而删改任何一条消息都可能让
 * 「现场」与实际历史对不上（改了用户消息 = 任务本身变了；删了中断卡 = 按钮挂的消息没了）。
 * 作废的代价只是「继续」消失（用户可重新发消息），留着错的代价是续跑一个已经变了的任务。
 */
function invalidateResumeOnMutation(sessionId: string): void {
  try {
    if (!getAgentSession(sessionId)?.resume) return
    updateSessionResume(sessionId, null)
  } catch { /* 作废失败不阻断消息操作本身 */ }
}

export function sessionExists(id: string): boolean {
  return readSessions().some((s) => s.id === id)
}

/**
 * 追加消息并刷新会话活跃时间（消息落盘 = 单行 append，O(本条消息)）。
 * 返回新消息 id（A 方案：中断卡要把「继续」按钮挂在自己的 id 上）。
 * `role==='user'` 时**清空续跑现场**：用户改主意发了新消息 = 旧现场作废（中断卡保留为历史）。
 */
export function appendAgentMessage(sessionId: string, role: 'user' | 'assistant', content: string, trace?: unknown): string {
  ensureMigrated()
  const id = randomUUID()
  appendMessage(requireAgentDir(), {
    id,
    session_id: sessionId,
    role,
    content,
    trace_json: trace ? JSON.stringify(trace) : null,
    created_at: nowLocal(),
  })
  const sessions = readSessions()
  const row = sessions.find((s) => s.id === sessionId)
  if (row) {
    row.updated_at = nowLocal()
    // 新用户消息 = 现场作废（顺序无所谓：同一次写入里一起落盘）
    if (role === 'user') delete row.resume
    writeSessions(sessions)
  }
  return id
}

/** 首条用户消息自动成为会话标题（仅当仍是默认标题时） */
export function ensureSessionTitle(sessionId: string, firstUserMessage: string): void {
  const row = getAgentSession(sessionId)
  if (!row) return
  if (!row.title || row.title === '新会话') {
    const title = firstUserMessage.replace(/\s+/g, ' ').trim().slice(0, 20) || '新会话'
    renameAgentSession(sessionId, title)
  }
}

export function getAgentMessages(sessionId: string): AgentMessageRow[] {
  // 原 SQL：WHERE session_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 500（取最早 500 条）
  // ★ 这是 **agent 上下文路径** 的口径（压缩 / 注入预算都按它算），别改成全量。
  ensureMigrated()
  const dir = vaultAgentDir()
  // 读路径：无仓库 = 空（调用方拿到的就是「这个仓库没这条会话」，与跨仓库陈旧 id 同一表现）
  return dir ? getMessagesPage(dir, sessionId) : []
}

/**
 * UI 读路径：全量消息（不截断）。
 *
 * 渲染层需要完整历史来画会话大纲、跳回旧消息、整任务回滚；「只挂最近 N 轮」由
 * `MessageList` 的渲染窗口负责，不是在这里截数据。超过 500 条的会话此前会从最新处
 * 被截掉（旧 SQL LIMIT 语义只给 agent 上下文保留）。
 */
export function getAgentMessagesAll(sessionId: string): AgentMessageRow[] {
  ensureMigrated()
  const dir = vaultAgentDir()
  return dir ? getAllMessages(dir, sessionId) : []
}

export function getMessageById(sessionId: string, id: string): AgentMessageRow | null {
  ensureMigrated()
  const dir = vaultAgentDir()
  if (!dir) return null
  return readMessages(dir, sessionId).find((m) => m.id === id) ?? null
}

/**
 * 消息删改与纪要一致性（压缩设计 §13）：删改命中纪要覆盖范围时作废 digest，
 * 下次压缩自动重建。mode 'at' = 目标消息本身被删/改（位置 ≤ 检查点即作废）；
 * mode 'after' = 目标之后的消息被删（检查点被删才作废，即检查点位置 > 锚点位置）。
 */
function invalidateDigestOnMutation(sessionId: string, targetId: string, mode: 'at' | 'after'): void {
  try {
    const row = getAgentSession(sessionId)
    if (!row?.digest) return
    const rows = getAgentMessages(sessionId)
    const uptoIdx = rows.findIndex((m) => m.id === row.digest!.upto_id)
    if (uptoIdx === -1) {
      updateSessionDigest(sessionId, null)
      return
    }
    const tIdx = rows.findIndex((m) => m.id === targetId)
    if (tIdx === -1) return
    const covered = mode === 'at' ? tIdx <= uptoIdx : tIdx < uptoIdx
    if (covered) updateSessionDigest(sessionId, null)
  } catch { /* 一致性作废失败不阻断消息操作本身 */ }
}

/** 编辑消息内容（仅用于用户消息改写后重推） */
export function updateMessageContent(sessionId: string, id: string, content: string): void {
  ensureMigrated()
  storeUpdateMessageContent(requireAgentDir(), sessionId, id, content)
  invalidateDigestOnMutation(sessionId, id, 'at')
  invalidateResumeOnMutation(sessionId)
}

export function deleteMessage(sessionId: string, id: string): void {
  ensureMigrated()
  deleteMessageById(requireAgentDir(), sessionId, id)
  invalidateDigestOnMutation(sessionId, id, 'at')
  invalidateResumeOnMutation(sessionId)
}

/** 删除某条消息之后的所有消息（重新生成/编辑重推时清掉旧回复） */
export function deleteMessagesAfter(sessionId: string, messageId: string): void {
  ensureMigrated()
  deleteMessagesAfterId(requireAgentDir(), sessionId, messageId)
  invalidateDigestOnMutation(sessionId, messageId, 'after')
  invalidateResumeOnMutation(sessionId)
}
