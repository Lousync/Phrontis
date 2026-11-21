/**
 * AI 教学重构 · 模型目录纯函数（P0）
 *
 * 负责「模型条目」这一层的全部**无副作用**推导：容错归一化、默认模型解析、
 * 能力三态查询、旧槽位 spec 兼容、引用清点、槽位候选软过滤、去重建议。
 *
 * 零运行时依赖：只用 `import type` 引共享类型（`./aiTeachingTypesPure`），
 * 可被 stripTypeScriptTypes 后直接 import（契约脚本
 * `.AGENT/scripts/ai-teaching/verify-model-catalog.mjs`）。不读设置、不碰文件系统、不发 IPC。
 *
 * 方案：`/home/lousync/桌面/Phrontis-AI教学-技术方案-2026-11-19.md` §2.9 / §4.3、
 * `/home/lousync/桌面/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md` §13–§15、B8 / B12
 */

import type {
  CapabilityKey,
  CapabilityState,
  ModelEntry,
  ModelSlotKey,
  ReasoningLevel,
} from './aiTeachingTypesPure'

/** 内置能力表适配器（`modelCapabilityTable.lookupCapability`）；表外一律返回 null */
export type CapabilityLookup = (modelId: string, key: CapabilityKey) => CapabilityState | null

const CAPABILITY_KEYS: CapabilityKey[] = ['tools', 'vision', 'json', 'imageGeneration', 'imageEdit', 'reasoning']
const REASONING_LEVELS: ReasoningLevel[] = ['off', 'low', 'medium', 'high']

/* ============================== 小工具 ============================== */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function posInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined
}

function isCapabilityKey(v: unknown): v is CapabilityKey {
  return typeof v === 'string' && (CAPABILITY_KEYS as string[]).includes(v)
}

/* ============================== 名称正则兜底 ============================== */

/**
 * 能力三态链的**第三段**：名称正则兜底。
 *
 * 只做**正向**提示（yes），从不因名字判 no —— 「猜成不支持」会让用户永远选不到模型，
 * 代价远大于猜错支持（后者由真实 API 报错兜底）。权威的已知模型表在
 * `modelCapabilityTable.ts`（由调用方以 `table` 传入）；这里只是没有表时的粗粒度线索。
 */
/**
 * 思考能力名称兜底：与主进程 `llmProtocolPure.REASONING_MODEL_RE` **同口径**。
 * 本文件零依赖（契约脚本直接 strip 后 import），所以只能镜像一份 ——
 * `.AGENT/scripts/ai-teaching/verify-model-catalog.mjs` 会比对两处源串，改动请同步。
 */
export const REASONING_NAME_RE =
  /(reasoner|r1|qwq|qwen3|o[134]-|o[134]$|thinking|research|smart|deepthink)/i

const NAME_HINTS: Array<{ re: RegExp; caps: Partial<Record<CapabilityKey, CapabilityState>> }> = [
  { re: REASONING_NAME_RE, caps: { reasoning: 'yes' } },
  { re: /(?:^|[^a-z0-9])(?:vision|vl)(?:[^a-z0-9]|$)/i, caps: { vision: 'yes' } },
  { re: /gpt-4o|gpt-4\.1|gpt-4-turbo|omni/i, caps: { vision: 'yes' } },
  { re: /gemini(?![-._]?embed)/i, caps: { vision: 'yes' } },
  { re: /claude-3|claude-(?:sonnet|opus|haiku)-[45]/i, caps: { vision: 'yes' } },
  { re: /glm-4(?:\.5)?v|qwen[\d.]*[-._]?vl|llava|internvl|pixtral/i, caps: { vision: 'yes' } },
  { re: /dall-e|gpt-image|flux|stable-diffusion|seedream|imagen-[34]/i, caps: { imageGeneration: 'yes' } },
]

function nameHint(modelId: string, key: CapabilityKey): CapabilityState | null {
  const raw = str(modelId)
  if (!raw) return null
  for (const hint of NAME_HINTS) {
    const state = hint.caps[key]
    if (state && hint.re.test(raw)) return state
  }
  return null
}

/* ============================== normalizeCatalog ============================== */

function makeAutoId(providerId: string, modelId: string): string {
  const slug = `${providerId}-${modelId}`
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `m_auto_${slug || 'model'}`
}

/** 同 id 冲突：第一个保留，其后加 `-dup` / `-dup2` / `-dup3`（不丢数据） */
function uniqueId(base: string, seen: Set<string>): string {
  if (!seen.has(base)) {
    seen.add(base)
    return base
  }
  let n = 1
  let candidate = `${base}-dup`
  while (seen.has(candidate)) {
    n += 1
    candidate = `${base}-dup${n}`
  }
  seen.add(candidate)
  return candidate
}

function normalizeReasoning(v: unknown): ModelEntry['reasoning'] {
  if (!isRecord(v)) return { supported: false, default: 'off' }
  const rawDefault = str(v.default)
  const level = (REASONING_LEVELS as string[]).includes(rawDefault)
    ? (rawDefault as ReasoningLevel)
    : 'off'
  return { supported: v.supported === true, default: level }
}

/**
 * 能力归一：**只保留显式的 yes / no**。
 * 缺省 = `auto`（由 `lookupCapability` 在查询时决定），不在这里写死任何判断；
 * 用户显式设成 `auto` 也等同缺省 —— auto 的语义是「交给系统判断」，不是「显式未知」。
 */
function normalizeCapabilities(v: unknown): Partial<Record<CapabilityKey, CapabilityState>> {
  const out: Partial<Record<CapabilityKey, CapabilityState>> = {}
  if (!isRecord(v)) return out
  for (const key of CAPABILITY_KEYS) {
    const state = v[key]
    if (state === 'yes' || state === 'no') out[key] = state
  }
  return out
}

function normalizeLastTest(v: unknown): ModelEntry['lastTest'] | undefined {
  if (!isRecord(v)) return undefined
  if (typeof v.ok !== 'boolean') return undefined
  const out: NonNullable<ModelEntry['lastTest']> = { ok: v.ok, at: str(v.at) }
  const latency = posInt(v.latencyMs)
  if (latency !== undefined) out.latencyMs = latency
  const error = str(v.error)
  if (error) out.error = error
  return out
}

function sortRank(e: ModelEntry): number {
  return typeof e.sortOrder === 'number' && Number.isFinite(e.sortOrder)
    ? e.sortOrder
    : Number.POSITIVE_INFINITY
}

function compareCreated(a: string, b: string): number {
  if (a === b) return 0
  if (!a) return 1
  if (!b) return -1
  return a < b ? -1 : 1
}

/**
 * 容错归一化：非法条目丢弃；缺字段补默认；id 重复加后缀；按 sortOrder / createdAt 稳定排序。
 * 入参是磁盘上的未知 JSON，任何形状都不抛错。
 */
export function normalizeCatalog(raw: unknown): ModelEntry[] {
  if (!Array.isArray(raw)) return []
  const seenIds = new Set<string>()
  const rows: Array<{ entry: ModelEntry; index: number }> = []

  raw.forEach((item, index) => {
    if (!isRecord(item)) return
    const providerId = str(item.providerId)
    const modelId = str(item.modelId)
    // 没有 provider / model 的条目无法解析到上游，属非法条目
    if (!providerId || !modelId) return

    const baseId = str(item.id) || makeAutoId(providerId, modelId)
    const entry: ModelEntry = {
      id: uniqueId(baseId, seenIds),
      name: str(item.name),
      providerId,
      modelId,
      reasoning: normalizeReasoning(item.reasoning),
      capabilities: normalizeCapabilities(item.capabilities),
      curated: item.curated === true,
      source: item.source === 'user' ? 'user' : 'auto',
      createdAt: str(item.createdAt),
      updatedAt: str(item.updatedAt),
    }

    const accountId = str(item.accountId)
    if (accountId) entry.accountId = accountId
    const contextWindow = posInt(item.contextWindow)
    if (contextWindow !== undefined) entry.contextWindow = contextWindow
    const maxOutputTokens = posInt(item.maxOutputTokens)
    if (maxOutputTokens !== undefined) entry.maxOutputTokens = maxOutputTokens
    if (typeof item.free === 'boolean') entry.free = item.free
    const sortOrder = item.sortOrder
    if (typeof sortOrder === 'number' && Number.isFinite(sortOrder)) entry.sortOrder = sortOrder
    const lastTest = normalizeLastTest(item.lastTest)
    if (lastTest) entry.lastTest = lastTest
    if (Array.isArray(item.tags)) {
      const tags = item.tags.map(str).filter(Boolean)
      if (tags.length > 0) entry.tags = tags
    }

    rows.push({ entry, index })
  })

  rows.sort((a, b) => {
    const rankA = sortRank(a.entry)
    const rankB = sortRank(b.entry)
    if (rankA !== rankB) return rankA < rankB ? -1 : 1
    const created = compareCreated(a.entry.createdAt, b.entry.createdAt)
    if (created !== 0) return created
    return a.index - b.index
  })

  return rows.map((row) => row.entry)
}

/* ============================== resolveModelEntry ============================== */

/**
 * 默认模型解析（唯一实现）：
 * 对话覆盖 → 工作区默认 → 全局默认 → 工作区精选首个 → 全局精选首个 → null。
 * 命中的 id 已不在目录里（被删 / 改名）时**跳过继续往下找**，不直接返回 null。
 */
export function resolveModelEntry(input: {
  catalog: ModelEntry[]
  globalDefaultId?: string
  workspaceEntryId?: string
  conversationEntryId?: string
  workspaceCuratedIds?: string[]
}): ModelEntry | null {
  const catalog = Array.isArray(input?.catalog) ? input.catalog.filter((e) => !!e) : []
  const byId = new Map<string, ModelEntry>()
  for (const entry of catalog) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue
    if (!byId.has(entry.id)) byId.set(entry.id, entry)
  }

  const pick = (id: unknown): ModelEntry | null => {
    const key = str(id)
    return key ? byId.get(key) ?? null : null
  }

  const direct =
    pick(input?.conversationEntryId) ?? pick(input?.workspaceEntryId) ?? pick(input?.globalDefaultId)
  if (direct) return direct

  const curatedIds = Array.isArray(input?.workspaceCuratedIds) ? input.workspaceCuratedIds : []
  for (const id of curatedIds) {
    const hit = pick(id)
    if (hit) return hit
  }

  for (const entry of catalog) {
    if (entry && entry.curated === true) return entry
  }
  return null
}

/* ============================== lookupCapability ============================== */

/**
 * 能力三态解析：条目显式 yes/no → 内置表 → 名称正则兜底 → { auto, resolved:false }。
 * `resolved` 表示「有依据」，供 UI 区分「已知不支持」与「未检测」。
 */
export function lookupCapability(
  entry: ModelEntry,
  key: CapabilityKey,
  table?: CapabilityLookup
): { state: CapabilityState; resolved: boolean } {
  if (!entry || !isCapabilityKey(key)) return { state: 'auto', resolved: false }

  const explicit = entry.capabilities ? entry.capabilities[key] : undefined
  if (explicit === 'yes' || explicit === 'no') return { state: explicit, resolved: true }

  const spec = str(entry.modelId) || str(entry.name)
  if (typeof table === 'function' && spec) {
    const hit = table(spec, key)
    if (hit === 'yes' || hit === 'no') return { state: hit, resolved: true }
  }

  const hinted = nameHint(spec, key)
  if (hinted === 'yes' || hinted === 'no') return { state: hinted, resolved: true }

  return { state: 'auto', resolved: false }
}

/* ============================== 旧槽位 spec 兼容 ============================== */

/** 旧格式 `providerId:modelId`（非空、含 `:`、不是条目 id） */
export function isLegacySpec(v: unknown): boolean {
  if (typeof v !== 'string') return false
  const spec = v.trim()
  if (!spec || spec.startsWith('m_')) return false
  return spec.includes(':')
}

/** 以**第一个** `:` 切分；两段都非空才算合法；条目 id（`m_*`）返回 null */
export function parseLegacySpec(v: unknown): { providerId: string; modelId: string } | null {
  if (!isLegacySpec(v)) return null
  const spec = (v as string).trim()
  const at = spec.indexOf(':')
  if (at <= 0) return null
  const providerId = spec.slice(0, at).trim()
  const modelId = spec.slice(at + 1).trim()
  if (!providerId || !modelId) return null
  return { providerId, modelId }
}

/* ============================== findReferences（B12） ============================== */

/**
 * 清点一个条目在哪些地方被引用（删除保护用）。
 *
 * 返回值形如 `{ entryId, where }`，where：
 * - `slot:<ModelSlotKey>`            场景槽位
 * - `workspace:<wsId>:default`       工作区默认
 * - `workspace:<wsId>:curated`       工作区精选
 * - `global:default`                 全局默认
 *
 * 去重口径：同一 entryId + 同一 where 只出现一次。旧格式 `providerId:modelId`
 * 会按目录里的 spec 映射回条目 id（迁移完成前也能抓到引用）；目录里不存在的 id 忽略。
 */
export function findReferences(input: {
  catalog: ModelEntry[]
  slots: Partial<Record<ModelSlotKey, string>>
  workspaceEntry: Record<string, { modelEntryId?: string; curatedEntryIds?: string[] }>
  defaultEntryId?: string
}): Array<{ entryId: string; where: string }> {
  const catalog = Array.isArray(input?.catalog) ? input.catalog : []
  const knownIds = new Set<string>()
  const specToId = new Map<string, string>()
  for (const entry of catalog) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue
    knownIds.add(entry.id)
    const spec = `${str(entry.providerId)}:${str(entry.modelId)}`
    if (!specToId.has(spec)) specToId.set(spec, entry.id)
  }

  const out: Array<{ entryId: string; where: string }> = []
  const seen = new Set<string>()

  const push = (value: unknown, where: string): void => {
    const raw = str(value)
    if (!raw) return
    const entryId = knownIds.has(raw) ? raw : specToId.get(raw)
    if (!entryId) return
    const dedupeKey = `${entryId}\u0000${where}`
    if (seen.has(dedupeKey)) return
    seen.add(dedupeKey)
    out.push({ entryId, where })
  }

  const slots = isRecord(input?.slots) ? (input.slots as Record<string, unknown>) : {}
  for (const key of Object.keys(slots)) push(slots[key], `slot:${key}`)

  const workspaces = isRecord(input?.workspaceEntry)
    ? (input.workspaceEntry as Record<string, unknown>)
    : {}
  for (const wsId of Object.keys(workspaces)) {
    const row = workspaces[wsId]
    if (!isRecord(row)) continue
    push(row.modelEntryId, `workspace:${wsId}:default`)
    const curated = Array.isArray(row.curatedEntryIds) ? row.curatedEntryIds : []
    for (const id of curated) push(id, `workspace:${wsId}:curated`)
  }

  push(input?.defaultEntryId, 'global:default')
  return out
}

/* ============================== pickSlotCandidates ============================== */

/** 槽位 → 能力要求；其余槽位不限制（tools 不参与槽位过滤） */
const SLOT_CAPABILITY: Partial<Record<ModelSlotKey, CapabilityKey>> = {
  aiTeachVisionModel: 'vision',
  aiImageModel: 'imageGeneration',
  aiImageEditModel: 'imageEdit',
}

const CAPABILITY_BLOCK_REASON: Partial<Record<CapabilityKey, string>> = {
  vision: '该模型不支持视觉输入（图片理解）',
  imageGeneration: '该模型不支持生图',
  imageEdit: '该模型不支持改图',
}

/**
 * 槽位候选软过滤：只有**已知不支持**（state === 'no'）才进 blocked，并给中文原因；
 * `auto`（未检测）照常可选 —— 不静默把用户能用的模型藏起来，也不抛错。
 */
export function pickSlotCandidates(
  catalog: ModelEntry[],
  key: ModelSlotKey,
  lookup?: CapabilityLookup
): { usable: ModelEntry[]; blocked: Array<{ entry: ModelEntry; reason: string }> } {
  const list = Array.isArray(catalog) ? catalog.filter((e) => !!e) : []
  const capability = SLOT_CAPABILITY[key]
  if (!capability) return { usable: list, blocked: [] }

  const usable: ModelEntry[] = []
  const blocked: Array<{ entry: ModelEntry; reason: string }> = []
  for (const entry of list) {
    const { state } = lookupCapability(entry, capability, lookup)
    if (state === 'no') {
      blocked.push({ entry, reason: CAPABILITY_BLOCK_REASON[capability] ?? '该模型不支持此场景' })
    } else {
      usable.push(entry)
    }
  }
  return { usable, blocked }
}

/* ============================== entryLabel ============================== */

/** 选择器显示名：名称 → `provider / model` → modelId → providerId → id */
export function entryLabel(e: ModelEntry): string {
  const name = str(e?.name)
  if (name) return name
  const providerId = str(e?.providerId)
  const modelId = str(e?.modelId)
  if (providerId && modelId) return `${providerId} / ${modelId}`
  return modelId || providerId || str(e?.id)
}

/* ============================== dedupeBySpec ============================== */

function preferEntry(a: ModelEntry, b: ModelEntry): boolean {
  if (a.curated !== b.curated) return a.curated
  const ua = str(a.updatedAt)
  const ub = str(b.updatedAt)
  if (ua !== ub) return ua > ub
  return false
}

/**
 * 同 `providerId + modelId` 的重复条目给出**去重建议**（不修改入参）：
 * 每组保留 `curated` 优先、其次 `updatedAt` 最新者；返回保留者，顺序沿用目录顺序。
 */
export function dedupeBySpec(catalog: ModelEntry[]): ModelEntry[] {
  const list = Array.isArray(catalog) ? catalog.filter((e) => !!e) : []
  const groups = new Map<string, ModelEntry[]>()
  const order: string[] = []
  for (const entry of list) {
    const key = `${str(entry.providerId)}\u0000${str(entry.modelId)}`
    const group = groups.get(key)
    if (group) group.push(entry)
    else {
      groups.set(key, [entry])
      order.push(key)
    }
  }

  const keep = new Set<ModelEntry>()
  for (const key of order) {
    const group = groups.get(key)
    if (!group || group.length === 0) continue
    let best = group[0]
    for (const entry of group) {
      if (entry !== best && preferEntry(entry, best)) best = entry
    }
    keep.add(best)
  }
  return list.filter((entry) => keep.has(entry))
}

/* ============================== 槽位值解析（P3 接线用） ============================== */

/**
 * 把一个「槽位值」解析成可用的模型目标。
 *
 * 槽位值有两种历史形态（B6 迁移期并存）：
 * - `m_xxx`  → 模型条目 id（新写入，唯一推荐形态）
 * - `pid:mid` → 旧 `providerId:modelId`（迁移期继续可读）
 *
 * 为什么单独抽成纯函数：`resolveLlmTarget` / 视觉能力判定 / 生图槽 / 场景分配
 * 五处都要做同一件事，散落实现必然漂移（其中一处忘了兼容旧值就是「模型突然不可用」）。
 */
export function resolveSpec(
  raw: unknown,
  catalog: ModelEntry[],
  lookup?: CapabilityLookup,
): {
  /** 命中条目时为该条目；旧 spec 且目录里没有对应条目时为空 */
  entry?: ModelEntry
  providerId: string
  modelId: string
  /** true = 旧 `providerId:modelId` 形态（含「目录里有同 spec 条目」的情况） */
  legacy: boolean
  /** 条目上声明的上下文窗口；旧 spec 恒为 undefined，由调用方回退全局 */
  contextWindow?: number
} | null {
  const s = String(raw ?? '').trim()
  if (!s) return null

  const fromEntry = (entry: ModelEntry, legacy: boolean) => ({
    entry,
    providerId: entry.providerId,
    modelId: entry.modelId,
    legacy,
    contextWindow: entry.contextWindow,
  })

  if (!isLegacySpec(s)) {
    // 形如 m_xxx：只认目录里真实存在的条目（拼错的 id 不能悄悄退化成别的东西）
    const hit = catalog.find((e) => e.id === s)
    return hit ? fromEntry(hit, false) : null
  }

  const parsed = parseLegacySpec(s)
  if (!parsed) return null
  // 旧 spec 命中同 provider+model 的条目时，直接把条目带出来（能力 / 窗口都能用上）
  const hit = catalog.find((e) => e.providerId === parsed.providerId && e.modelId === parsed.modelId)
  if (hit) return fromEntry(hit, true)
  // 目录里还没有条目：退回原始 spec，行为与旧版本一致（迁移未跑完也不会坏）
  void lookup
  return { providerId: parsed.providerId, modelId: parsed.modelId, legacy: true }
}
