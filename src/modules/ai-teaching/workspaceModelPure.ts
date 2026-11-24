/**
 * AI 教学 · 工作区（课程）模型绑定 —— 零运行时依赖的纯函数层。
 *
 * 方案：`/home/lousync/Projects/DesginProcess/Phrontis/已实现设计文档/Phrontis-AI教学-技术方案-2026-11-19.md` §2.9
 *       `/home/lousync/Projects/DesginProcess/Phrontis/方案与调研/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md` §15.1
 *
 * ⚠️ 本文件**只允许 `import type`** —— 类型导入会被 Node 的类型剥离整体擦除；
 * 一旦出现普通值导入，契约脚本（strip 后直接 import 真实实现）装载时会留下无法解析的裸 import。
 * 同理**不从 `src/lib/modelCatalog.ts` 取 `SLOT_CAPABILITY`**：那个文件带 React 运行时导入。
 * 槽位 → 能力的映射在本文件内留一份常量，与渲染层那份必须逐字相同 —— 契约脚本会读源码断言两边相等。
 *
 * 解析顺序与主进程 `resolveModelEntry`（`electron/lib/modelCatalogPure.ts`）同口径：
 * 对话覆盖 → 工作区默认 → 全局默认 → 工作区精选首个 → 全局精选首个 → 无。
 * 指向已删条目的 id **跳过继续往下找**，只提示不自动改绑定（B8 + B12）。
 */
import type { LlmCapabilityKey, LlmCatalogSlotKey, LlmModelEntry } from '../../types'

/**
 * 槽位 → 必需能力。
 * ★ 必须与 `src/lib/modelCatalog.ts` 的 `SLOT_CAPABILITY` 保持一致，契约脚本断言两边相等。
 */
const SLOT_CAPABILITY: Partial<Record<LlmCatalogSlotKey, LlmCapabilityKey>> = {
  aiTeachVisionModel: 'vision',
  aiImageModel: 'imageGeneration',
  aiImageEditModel: 'imageEdit',
}

export interface WorkspaceBinding {
  modelEntryId?: string
  curatedEntryIds?: string[]
}

export interface ResolvedWorkspaceModel {
  /** 最终生效的条目（可能来自工作区默认 / 全局默认 / 精选首个） */
  entry?: LlmModelEntry
  /** 来源，用于界面标「本课程默认 / 全局默认 / 精选」 */
  source: 'workspace' | 'global' | 'curated' | 'none'
  /** 绑定里指向了不存在 / 已删条目的情况（不静默改绑定） */
  staleBinding: boolean
  /** 给用户的提示（staleBinding 时非空） */
  hint?: string
  /**
   * 命中对话临时覆盖（`conversationOverrideId`）。
   * `source` 枚举里没有 conversation，故仍报 `'workspace'`；界面据此**抑制**「本课程默认」标签。
   */
  viaConversation?: boolean
}

/* ============================== 小工具 ============================== */

/** 统一取 id：非字符串 / 空白一律当「没填」 */
function asId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 目录索引：去重（先到先得）、丢掉没有 id 的脏行，保留原顺序 */
function validEntries(entries: LlmModelEntry[] | undefined): LlmModelEntry[] {
  const list: LlmModelEntry[] = []
  const seen = new Set<string>()
  if (!Array.isArray(entries)) return list
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string') continue
    const id = entry.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    list.push(entry)
  }
  return list
}

/** 选择器排序：curated 优先，其次名称（小写比较，纯码点序，跨端稳定），最后 id 兜底 */
function nameKey(entry: LlmModelEntry): string {
  return (String(entry.name ?? '').trim() || String(entry.modelId ?? '').trim() || entry.id).toLowerCase()
}

function sortForPicker(a: LlmModelEntry, b: LlmModelEntry): number {
  const rankA = a.curated === true ? 0 : 1
  const rankB = b.curated === true ? 0 : 1
  if (rankA !== rankB) return rankA - rankB
  const keyA = nameKey(a)
  const keyB = nameKey(b)
  if (keyA !== keyB) return keyA < keyB ? -1 : 1
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/** 与 `modelCatalog.ts` 的 `slotIncompatibleReason` 同口径（soft filter，不抛错） */
function capabilityBlocked(entry: LlmModelEntry, slot: LlmCatalogSlotKey): boolean {
  const need = SLOT_CAPABILITY[slot]
  if (!need) return false
  const state = entry.capabilities ? entry.capabilities[need] : undefined
  if (state === 'no') return true
  if (state === 'yes') return false
  // auto：视觉槽允许「未检测」的条目（内置表 / 名称兜底由主进程判），生图 / 改图槽必须显式支持
  return need !== 'vision'
}

/* ============================== 绑定容错 ============================== */

/**
 * 把磁盘上 / IPC 传来的原始值收敛成合法绑定。
 * 非对象（含数组、数字、null）→ `{}`；`curatedEntryIds` 去重并丢非字符串；
 * `modelEntryId` 非字符串 / 空白则丢。输入是数组形式时保留空数组（= 明确清空）。
 */
export function normalizeWorkspaceBinding(raw: unknown): WorkspaceBinding {
  const out: WorkspaceBinding = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const row = raw as Record<string, unknown>

  const modelEntryId = asId(row.modelEntryId)
  if (modelEntryId) out.modelEntryId = modelEntryId

  if (Array.isArray(row.curatedEntryIds)) {
    const seen = new Set<string>()
    const ids: string[] = []
    for (const item of row.curatedEntryIds) {
      const id = asId(item)
      if (!id || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
    out.curatedEntryIds = ids
  }
  return out
}

/**
 * 局部更新用的差异：**只产出真的变了的字段**，供 `llmCatalogSetWorkspace` 打补丁。
 * 清空（字段被删 / 置空数组）给 `null` 而不是 `undefined` —— `undefined` 在 IPC 里等于「没这个字段」。
 */
export function bindingPatch(
  next: WorkspaceBinding,
  prev: WorkspaceBinding
): { modelEntryId?: string | null; curatedEntryIds?: string[] | null } {
  const before = normalizeWorkspaceBinding(prev)
  const after = normalizeWorkspaceBinding(next)
  const patch: { modelEntryId?: string | null; curatedEntryIds?: string[] | null } = {}

  const beforeDefault = asId(before.modelEntryId)
  const afterDefault = asId(after.modelEntryId)
  if (beforeDefault !== afterDefault) patch.modelEntryId = afterDefault || null

  const beforeCurated = before.curatedEntryIds ?? []
  const afterCurated = after.curatedEntryIds ?? []
  const same =
    beforeCurated.length === afterCurated.length &&
    beforeCurated.every((id, i) => id === afterCurated[i])
  if (!same) patch.curatedEntryIds = afterCurated.length > 0 ? [...afterCurated] : null

  return patch
}

/* ============================== 解析 ============================== */

/**
 * 本工作区最终生效的模型。
 * 顺序：对话覆盖 → 工作区默认 → 全局默认 → 工作区精选首个 → 全局精选首个 → none。
 * 指向已删条目的 id 跳过并置 `staleBinding`（同时给 hint），**不改绑定**。
 */
export function resolveWorkspaceModel(input: {
  entries: LlmModelEntry[]
  binding?: WorkspaceBinding
  globalDefaultId?: string
  conversationOverrideId?: string
}): ResolvedWorkspaceModel {
  const list = validEntries(input?.entries)
  const byId = new Map<string, LlmModelEntry>()
  for (const entry of list) byId.set(entry.id, entry)

  const binding = normalizeWorkspaceBinding(input?.binding)
  const wsDefaultId = asId(binding.modelEntryId)
  const curatedIds = binding.curatedEntryIds ?? []

  const curatedHits: LlmModelEntry[] = []
  let staleCurated = 0
  const seen = new Set<string>()
  for (const rawId of curatedIds) {
    const id = asId(rawId)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const hit = byId.get(id)
    if (hit) curatedHits.push(hit)
    else staleCurated += 1
  }

  const wsDefault = wsDefaultId ? byId.get(wsDefaultId) : undefined
  const wsDefaultStale = !!wsDefaultId && !wsDefault
  const staleBinding = wsDefaultStale || staleCurated > 0

  const conversation = asId(input?.conversationOverrideId)
    ? byId.get(asId(input?.conversationOverrideId))
    : undefined
  const globalDefault = asId(input?.globalDefaultId)
    ? byId.get(asId(input?.globalDefaultId))
    : undefined
  const globalCurated = list.find((entry) => entry.curated === true)

  let entry: LlmModelEntry | undefined
  let source: ResolvedWorkspaceModel['source'] = 'none'
  let viaConversation = false

  if (conversation) {
    entry = conversation
    source = 'workspace'
    viaConversation = true
  } else if (wsDefault) {
    entry = wsDefault
    source = 'workspace'
  } else if (globalDefault) {
    entry = globalDefault
    source = 'global'
  } else if (curatedHits.length > 0) {
    entry = curatedHits[0]
    source = 'curated'
  } else if (globalCurated) {
    entry = globalCurated
    source = 'curated'
  }

  let hint: string | undefined
  if (staleBinding) {
    const fallback = viaConversation
      ? '对话内临时选择的模型'
      : source === 'global'
        ? '全局默认模型'
        : source === 'curated'
          ? '精选模型'
          : ''
    if (wsDefaultStale) {
      hint = fallback
        ? `本课程默认模型已失效（原绑定条目已删除），当前暂用${fallback}。`
        : '本课程默认模型已失效（原绑定条目已删除），请重新选择模型。'
    } else {
      hint = `本课程精选里有 ${staleCurated} 个模型已失效，已跳过。`
    }
  }

  return { entry, source, staleBinding, hint, viaConversation }
}

/* ============================== 选择器分组 ============================== */

/**
 * 选择器三段数据：
 * - `workspace`：绑定精选命中的条目（**保持绑定顺序**，脏 id 跳过）；
 * - `global`：全局精选（`curated === true`）且不在 workspace 里；
 * - `all`：全部条目，curated 优先 + 名称排序。
 */
export function pickerEntriesForWorkspace(input: {
  entries: LlmModelEntry[]
  binding?: WorkspaceBinding
}): { workspace: LlmModelEntry[]; global: LlmModelEntry[]; all: LlmModelEntry[] } {
  const list = validEntries(input?.entries)
  const byId = new Map<string, LlmModelEntry>()
  for (const entry of list) byId.set(entry.id, entry)

  const binding = normalizeWorkspaceBinding(input?.binding)
  const workspace: LlmModelEntry[] = []
  const used = new Set<string>()
  for (const rawId of binding.curatedEntryIds ?? []) {
    const id = asId(rawId)
    const hit = id ? byId.get(id) : undefined
    if (!hit || used.has(hit.id)) continue
    used.add(hit.id)
    workspace.push(hit)
  }

  const global = list.filter((entry) => entry.curated === true && !used.has(entry.id)).sort(sortForPicker)
  const all = [...list].sort(sortForPicker)

  return { workspace, global, all }
}

/* ============================== 精选增删 ============================== */

/**
 * 工作区精选加 / 减一条：有则移除、无则追加到末尾，保持其它字段不动，返回新对象。
 * 幂等：连点两次回到原状态（顺序也回来）。
 */
export function toggleWorkspaceCurated(binding: WorkspaceBinding, entryId: string): WorkspaceBinding {
  const base = normalizeWorkspaceBinding(binding)
  const id = asId(entryId)
  const out: WorkspaceBinding = { ...base }
  if (!id) {
    if (base.curatedEntryIds) out.curatedEntryIds = [...base.curatedEntryIds]
    return out
  }

  const curated = base.curatedEntryIds ? [...base.curatedEntryIds] : []
  const at = curated.indexOf(id)
  if (at >= 0) curated.splice(at, 1)
  else curated.push(id)
  out.curatedEntryIds = curated
  return out
}

/* ============================== 槽位失效提示 ============================== */

/**
 * 场景槽位失效清点（只读提示，不自动替换）：
 * - 槽位值解析不到条目 → `missing-entry`（含旧 `providerId:modelId` 用法，按同口径查目录）；
 * - 解析到条目但能力不相容 → `incompatible`（vision / imageGeneration / imageEdit 三槽）。
 * 其它槽位（对话 / 翻译 / 压缩等代码类）不参与 —— 它们的兜底由 `llmService` 自己做。
 */
export function slotFallbackWarning(input: {
  entries: LlmModelEntry[]
  slots: Record<string, string>
}): Array<{ slot: LlmCatalogSlotKey; spec: string; reason: 'missing-entry' | 'incompatible' }> {
  const list = validEntries(input?.entries)
  const byId = new Map<string, LlmModelEntry>()
  const bySpec = new Map<string, LlmModelEntry>()
  for (const entry of list) {
    byId.set(entry.id, entry)
    const providerId = asId(entry.providerId)
    const modelId = asId(entry.modelId)
    if (!providerId || !modelId) continue
    const spec = `${providerId}:${modelId}`
    if (!bySpec.has(spec)) bySpec.set(spec, entry)
  }

  const slots = input?.slots && typeof input.slots === 'object' ? input.slots : {}
  const warnings: Array<{ slot: LlmCatalogSlotKey; spec: string; reason: 'missing-entry' | 'incompatible' }> = []

  // 键顺序固定（vision → 生图 → 改图），输出稳定
  for (const slot of Object.keys(SLOT_CAPABILITY) as LlmCatalogSlotKey[]) {
    const spec = asId((slots as Record<string, unknown>)[slot])
    if (!spec) continue
    const entry = byId.get(spec) ?? (spec.startsWith('m_') ? undefined : bySpec.get(spec))
    if (!entry) {
      warnings.push({ slot, spec, reason: 'missing-entry' })
      continue
    }
    if (capabilityBlocked(entry, slot)) warnings.push({ slot, spec, reason: 'incompatible' })
  }
  return warnings
}
