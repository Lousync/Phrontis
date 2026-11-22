/**
 * AI 教学 · 上下文用量明细 **纯函数**（零运行时依赖）
 *
 * 方案：`docs/ai-teaching-module-rework.md` R26 §9（用量指示迁输入区）的续作 ——
 * 2026-11-20 用户提供明细示意图后，把「5 段 system 估算」扩成 9 个分类 + 剩余空间。
 *
 * 三件事（可被 `stripTypeScriptTypes` 后由 `.mjs` 契约脚本直接 import）：
 *   · `buildInjectionStats`  —— 把主进程的真实注入片段聚合成 `AiTeachInjectionStats`
 *                              （旧 5 字段口径不变，新字段是**互斥分区**，见下）；
 *   · `estimateTokensFromChars` —— 字符 → token 估算（口径 ≈2.6 字/token，沿用渲染层旧常量）；
 *   · `buildContextUsage`    —— 分类行 + 百分比 + 剩余空间，并对「估算和 > 真实 promptTokens」
 *                              做等比收敛（ASCII 工具 schema 的 chars/token 比中文高，直接除会高估）。
 *
 * ── 口径（改动必须同步 `.AGENT/scripts/ai-teaching/verify-context-usage.mjs`）──
 * 1. **旧 5 字段保持原语义**（`systemChars` / `constraintChars` / `profileChars` /
 *    `sourcesChars` / `ruleChars`），旧渲染层与旧契约脚本不受影响。
 * 2. **新 7 字段是 systemFull 的互斥分区**：任意两段不重叠，且
 *    `systemChars + sourcesChars + workspaceChars + ledgerChars + capabilityChars +
 *     skillChars + toolsListChars === systemFull.length`（AI 教学面）。
 *    `messagesChars` / `toolsDefChars` 不在 systemFull 内（分别来自 messages 与 tools 载荷）。
 * 3. 「系统提示词」= `buildSystemPrompt()` 的基础人设段（`baseSystem`），**不是** systemFull 全文；
 *    systemFull 其余的每段都归到上面 7 个新字段之一，故分区和恒等于 systemFull。
 * 4. `messagesChars` 只算**首轮发送**的非 system 消息（历史 + 纪要 + 首条 user 注入 +
 *    虚拟首轮 / 续跑注入）的 JSON 序列化长度；循环中追加的 tool 结果不计（那部分已体现在
 *    UI 使用的真实 `promptTokens` 里）。
 * 5. `toolsDefChars` = 本轮 `toolPayload` 的 `JSON.stringify` 长度（即实际传给模型的 tools 数组）；
 *    `toolsListChars` = 扩展工具提示（哪些 ondemand 工具需申请），**不是**工具名数组。
 * 6. `CHARS_PER_TOKEN = 2.6` 是展示用近似值，不是 tokenizer。分类行 token 之和若超过
 *    真实 `usedTokens`（promptTokens），`buildContextUsage` 等比收敛到 used；剩余空间
 *    恒取 `max(0, window - used)`，百分比恒夹取 0..100 —— 任何输入都不会出负数。
 */

/** 字符 → token 展示口径（与旧渲染层 `CHARS_PER_TOKEN` 同值；改这里要同步 UI 常量） */
export const CHARS_PER_TOKEN = 2.6

/**
 * 注入片段（主进程侧的真实字符串）。
 * 这里只做**归类与计数**，不读盘、不依赖 Electron。
 */
export interface InjectionParts {
  /** systemFull 的实际拼接结果（契约脚本用它验证分区完整性；本身不变成字段） */
  systemFull: string
  /** `buildSystemPrompt(context)` 的基础人设 */
  systemPrompt: string
  /** 四层 CONSTRAINTS 原始正文合计（旧 `constraintChars` 口径：各层 `.length` 相加） */
  constraintsRaw: string
  /** 四层要求**实际注入串**（`buildScopePrompt`，含抬头与截断标记） */
  scopeInjected: string
  /** 仓库规则文件（AGENTS.md / CLAUDE.md）注入串 */
  repoRules: string
  /** 工作区「收藏」文档注入串 */
  favorites: string
  /** 素材 / 来源注入串（`buildAiTeachSourcesHint`） */
  sources: string
  /** 三层学习者画像注入串 */
  profile: string
  /** 课程 / 复习上下文注入串（`buildCourseInjection`，含课程进度与已学完知识点） */
  course: string
  /** 已配置 Skill 清单注入串 */
  skillList: string
  /** 用户显式指定 Skill 的提示词注入串 */
  explicitSkill: string
  /** 扩展工具提示（`toolsHint`） */
  toolsHint: string
  /** 教学协议规则：标题 / 出题 / 规划 / 提问 / 大纲 / 讲课口径 / 示意图 / 导图 / 要求文档 / 支线 */
  protocols: string
  /** AI 教学取材范围纪律（`scopeRuleHint`） */
  scopeRule: string
  /** AI 教学产物落点纪律（`writeScopeHint`） */
  writeScope: string
  /** 权限与执行纪律：denied / vaultFile / vaultScope / execution */
  permissions: string
  /** 运行期提示：人设（日程 / 情报）、长任务、生图、并行、统一助手、钩子 */
  runtime: string
  /** 首轮非 system 消息的 JSON 序列化串 */
  messagesJson: string
  /** 本轮 tools 载荷的 JSON 序列化串 */
  toolsJson: string
}

/** AI 教学 system 注入分段字符数（旧字段 + 新分类字段；两端类型定义保持镜像） */
export interface AiTeachInjectionStats {
  /** 基础人设（`buildSystemPrompt`）字符数 —— 旧字段 / 「系统提示词」行 */
  systemChars: number
  /** 四层 CONSTRAINTS 原始正文合计 —— 旧字段（新分类里归入「工作区」） */
  constraintChars: number
  /** 三层学习者画像 —— 旧字段（新分类里归入「学习画像与课程」） */
  profileChars: number
  /** 素材 / 来源清单 —— 旧字段 / 「来源」行 */
  sourcesChars: number
  /** 教学规则合计 —— 旧字段（新分类里归入「教学协议」，口径见 buildInjectionStats） */
  ruleChars: number
  /** 「对话消息」：首轮非 system 消息 JSON 长度 */
  messagesChars?: number
  /** 「内置工具定义」：本轮 tools 载荷 JSON 长度 */
  toolsDefChars?: number
  /** 「工具装载提示」：扩展工具提示（ondemand 申请说明）长度 */
  toolsListChars?: number
  /** 「技能」：Skill 清单 + 显式指定 Skill 提示词长度 */
  skillChars?: number
  /** 「工作区」：四层要求注入 + 仓库规则 + 收藏 + 取材 / 落点纪律长度 */
  workspaceChars?: number
  /** 「学习画像与课程」：三层画像 + 课程 / 复习上下文长度 */
  ledgerChars?: number
  /** 「教学协议」：教学协议 + 权限执行纪律 + 运行期提示长度 */
  capabilityChars?: number
}

/** 数字兜底：非有限数 / 负数 → 0（纯函数不抛错，界面不会因缺字段崩） */
function toCount(n: unknown): number {
  const v = Number(n)
  return Number.isFinite(v) && v > 0 ? v : 0
}

function len(s: string | undefined | null): number {
  return typeof s === 'string' ? s.length : 0
}

/**
 * 把真实注入片段聚合成统计对象。
 *
 * 旧字段口径**逐字保持**（`ruleChars` = protocols + scopeRule + writeScope，
 * 与 agentService 旧实现列出的 12 个 hint 一致；`constraintChars` 用原始正文合计）。
 */
export function buildInjectionStats(parts: InjectionParts): AiTeachInjectionStats {
  const p = parts ?? ({} as InjectionParts)
  const scopeRule = len(p.scopeRule)
  const writeScope = len(p.writeScope)
  return {
    systemChars: len(p.systemPrompt),
    constraintChars: len(p.constraintsRaw),
    profileChars: len(p.profile),
    sourcesChars: len(p.sources),
    // 旧口径：标题 / 出题 / 规划 / 提问 / 大纲 / 讲课口径 / 示意图 / 导图 /
    // 取材范围 / 产物落点 / 要求文档 / 支线 —— 共 12 段
    ruleChars: len(p.protocols) + scopeRule + writeScope,
    messagesChars: len(p.messagesJson),
    toolsDefChars: len(p.toolsJson),
    toolsListChars: len(p.toolsHint),
    skillChars: len(p.skillList) + len(p.explicitSkill),
    // 工作区 = 用户当前工作区的「规则 / 要求 / 收藏 / 取材与落点」
    workspaceChars: len(p.scopeInjected) + len(p.repoRules) + len(p.favorites) + scopeRule + writeScope,
    // 学习画像与课程 = 学习者画像 + 课程进度（含复习上下文）
    ledgerChars: len(p.profile) + len(p.course),
    // 教学协议 = 教学协议 + 权限执行纪律 + 运行期提示（人设 / 长任务 / 生图 / 并行 / 钩子）
    capabilityChars: len(p.protocols) + len(p.permissions) + len(p.runtime),
  }
}

/** systemFull 分区字段（顺序固定；`sumClassifiedSystemChars` 用） */
export const SYSTEM_SIDE_FIELDS = [
  'systemChars',
  'sourcesChars',
  'workspaceChars',
  'ledgerChars',
  'capabilityChars',
  'skillChars',
  'toolsListChars',
] as const

/** 7 个 systemFull 分区字段之和（应与 systemFull.length 相等） */
export function sumClassifiedSystemChars(stats: AiTeachInjectionStats | null | undefined): number {
  if (!stats) return 0
  let sum = 0
  for (const key of SYSTEM_SIDE_FIELDS) sum += toCount(stats[key])
  return sum
}

/** 明细行 key（顺序即示意图自上而下的顺序） */
export type ContextUsageKey =
  | 'messages'
  | 'toolsDef'
  | 'toolsList'
  | 'skills'
  | 'system'
  | 'sources'
  | 'workspace'
  | 'ledger'
  | 'capability'

export interface ContextUsageCategory {
  key: ContextUsageKey
  label: string
  field: keyof AiTeachInjectionStats
}

/** 9 个内容分类（「剩余空间」由 buildContextUsage 单独给出，不属于字符字段） */
export const CONTEXT_USAGE_CATEGORIES: ContextUsageCategory[] = [
  { key: 'messages', label: '对话消息', field: 'messagesChars' },
  { key: 'toolsDef', label: '内置工具定义', field: 'toolsDefChars' },
  { key: 'toolsList', label: '工具装载提示', field: 'toolsListChars' },
  { key: 'skills', label: '技能', field: 'skillChars' },
  { key: 'system', label: '系统提示词', field: 'systemChars' },
  { key: 'sources', label: '来源', field: 'sourcesChars' },
  { key: 'workspace', label: '工作区', field: 'workspaceChars' },
  { key: 'ledger', label: '学习画像与课程', field: 'ledgerChars' },
  { key: 'capability', label: '教学协议', field: 'capabilityChars' },
]

/** 字符 → token（展示用近似；<=0 / 非数 → 0） */
export function estimateTokensFromChars(chars: number): number {
  const n = toCount(chars)
  return n > 0 ? Math.round(n / CHARS_PER_TOKEN) : 0
}

export interface ContextUsageOptions {
  /** 模型上下文窗口（tokens）；<=0 / 未设 = 不算百分比（与设置 `ctxWindow` 一致） */
  windowTokens?: number
  /** 最近一次调用的真实输入 tokens（promptTokens）；<=0 时退回分类估算和 */
  usedTokens?: number
}

export interface ContextUsageRow extends ContextUsageCategory {
  chars: number
  tokens: number
  /** 占上下文窗口百分比（0..100；未设窗口恒 0） */
  pct: number
}

export interface ContextUsageView {
  windowTokens: number
  /** 权威「已用」：优先 promptTokens；没有时取分类估算和 */
  usedTokens: number
  usedPct: number
  /** 分类行 token 之和（收敛后恒 <= usedTokens） */
  classifiedTokens: number
  /** 已用但没被任何分类覆盖的 token（用于「其他」兜底行；恒 >= 0） */
  unclassifiedTokens: number
  /** 剩余空间 = max(0, window - used)；未设窗口恒 0 */
  freeTokens: number
  freePct: number
  rows: ContextUsageRow[]
}

/**
 * 等比收敛：估算和超预算时按比例压到预算内（floor + 余数从大到小补 1）。
 * 只减不增；预算 <=0 全 0；返回数组长度与输入一致。
 */
export function scaleTokensToBudget(values: number[], budget: number): number[] {
  const safe = Array.isArray(values) ? values.map(toCount) : []
  const sum = safe.reduce((a, b) => a + b, 0)
  const cap = toCount(budget)
  if (sum <= cap) return safe
  if (cap <= 0) return safe.map(() => 0)
  const out = safe.map((v) => Math.floor((v * cap) / sum))
  let rest = cap - out.reduce((a, b) => a + b, 0)
  const order = safe
    .map((v, i) => ({ i, v, raw: (v * cap) / sum }))
    .filter((x) => out[x.i] < x.v)
    .sort((a, b) => (b.raw - Math.floor(b.raw)) - (a.raw - Math.floor(a.raw)) || a.i - b.i)
  for (let k = 0; k < order.length && rest > 0; k++) {
    out[order[k].i] += 1
    rest -= 1
  }
  return out
}

/**
 * 分类行 + 百分比 + 剩余空间。
 *
 * - 估算和 > 真实 used 时**等比收敛**（ASCII 工具 schema 的 chars/token 比中文高，
 *   直接除会假装比真实占得还多）；收敛后 `classifiedTokens <= usedTokens` 恒成立。
 * - `freeTokens = max(0, window - used)`；窗口未设 / used 超窗 / 空 stats 都不出负数。
 */
export function buildContextUsage(
  stats: AiTeachInjectionStats | null | undefined,
  opts?: ContextUsageOptions,
): ContextUsageView {
  const windowTokens = toCount(opts?.windowTokens)
  const rows: ContextUsageRow[] = CONTEXT_USAGE_CATEGORIES.map((c) => {
    const chars = toCount(stats ? stats[c.field] : 0)
    return { ...c, chars, tokens: estimateTokensFromChars(chars), pct: 0 }
  })
  const rawUsed = toCount(opts?.usedTokens)
  let estimated = rows.reduce((a, r) => a + r.tokens, 0)
  let usedTokens = rawUsed > 0 ? rawUsed : estimated
  if (estimated > usedTokens) {
    const scaled = scaleTokensToBudget(rows.map((r) => r.tokens), usedTokens)
    for (let i = 0; i < rows.length; i++) rows[i].tokens = toCount(scaled[i])
    estimated = rows.reduce((a, r) => a + r.tokens, 0)
  }
  for (const row of rows) {
    row.pct = windowTokens > 0 ? Math.min(100, Math.max(0, Math.round((row.tokens / windowTokens) * 100))) : 0
  }
  const freeTokens = windowTokens > 0 ? Math.max(0, windowTokens - usedTokens) : 0
  return {
    windowTokens,
    usedTokens,
    usedPct: windowTokens > 0 ? Math.min(100, Math.max(0, Math.round((usedTokens / windowTokens) * 100))) : 0,
    classifiedTokens: estimated,
    unclassifiedTokens: Math.max(0, usedTokens - estimated),
    freeTokens,
    freePct: windowTokens > 0 ? Math.min(100, Math.max(0, Math.round((freeTokens / windowTokens) * 100))) : 0,
    rows,
  }
}
