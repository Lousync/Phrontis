/**
 * 模型目录存储层（P3 · B1–B7 / B12）
 *
 * 职责边界：
 * - **纯推导**在 `modelCatalogPure.ts`（已由契约脚本锁定）；
 * - **本文件只做副作用**：读写设置、迁移旧槽位、删除引用保护、连通性测试、IPC 注册。
 *
 * 为什么单独一层而不是塞进 llmService：llmService 是请求链路，任何一处新增依赖都可能
 * 让「一轮对话」多走一次设置读取；目录是配置侧，调用时机只在开界面 / 切模型 / 迁移。
 *
 * 方案：`/home/lousync/桌面/Phrontis-AI教学-技术方案-2026-11-19.md` §2.9 / §4.3
 */
import { ipcMain } from 'electron'
import { broadcastDataChanged } from '../main/windowBus'
import { listAgentSessions } from './agentSessionRepo'
import { normalizeCatalog, findReferences, resolveSpec, dedupeBySpec } from './modelCatalogPure'
import type { ModelEntry, ModelSlotKey } from './aiTeachingTypesPure'

/** 8 个场景槽位（键名沿用现状，值可能是条目 id 或旧 providerId:modelId） */
const SLOT_KEYS: ModelSlotKey[] = [
  'defaultChatModel', 'assistantModelId', 'aiAssistantInlineSuggestModelId',
  'aiTranslateModelId', 'agentCompressModelId', 'aiTeachVisionModel',
  'aiImageModel', 'aiImageEditModel',
]

const SETTING_CATALOG = 'modelCatalogV1'
const SETTING_DEFAULT = 'defaultModelEntryId'
const SETTING_WORKSPACE = 'workspaceModelEntry'

export interface ModelCatalogDeps {
  getSettingValue: (key: string) => unknown
  setSettingValue: (key: string, value: unknown) => boolean
}

let deps: ModelCatalogDeps | null = null
let migrated = false

/* ============================== 读写 ============================== */

function readRaw(): unknown {
  const raw = deps?.getSettingValue(SETTING_CATALOG)
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return [] }
  }
  return raw
}

export function readCatalog(): ModelEntry[] {
  return normalizeCatalog(readRaw())
}

function writeCatalog(list: ModelEntry[]): boolean {
  const ok = !!deps?.setSettingValue(SETTING_CATALOG, JSON.stringify(list))
  if (ok) broadcastDataChanged('settings')
  return ok
}

export function readWorkspaceModel(): Record<string, { modelEntryId?: string; curatedEntryIds?: string[] }> {
  const raw = deps?.getSettingValue(SETTING_WORKSPACE)
  const obj = typeof raw === 'string' ? safeParse(raw) : raw
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
  const out: Record<string, { modelEntryId?: string; curatedEntryIds?: string[] }> = {}
  for (const [wsId, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const rec = v as Record<string, unknown>
    out[wsId] = {
      modelEntryId: typeof rec.modelEntryId === 'string' && rec.modelEntryId ? rec.modelEntryId : undefined,
      curatedEntryIds: Array.isArray(rec.curatedEntryIds)
        ? rec.curatedEntryIds.filter((x): x is string => typeof x === 'string' && !!x)
        : undefined,
    }
  }
  return out
}

/**
 * 工作区（课程）默认模型条目 id；没有绑定 / 绑定已失效的条目返回空串。
 *
 * 为什么单独开一个出口：请求链路（agentService 每轮取模型）与设置页读到的是同一份
 * `workspaceModelEntry`，但不该各自去解析 JSON —— 两处口径一旦分叉，就会出现
 * 「设置页显示本课程默认、对话里仍走全局默认」这种静默错配。
 */
export function getWorkspaceModelEntryId(wsId: string | null | undefined): string {
  const id = String(wsId ?? '').trim()
  if (!id) return ''
  const binding = readWorkspaceModel()[id]
  const entryId = String(binding?.modelEntryId ?? '').trim()
  if (!entryId) return ''
  // 绑定指向已删条目 → 按未绑定处理（上层退回全局默认）；界面侧用 staleBinding 把「原绑定已失效」说出来，
  // 不在这里偷偷改绑定 —— 用户可能只是临时删掉条目，静默改写会让意图丢失。
  return readCatalog().some((e) => e.id === entryId) ? entryId : ''
}

function writeWorkspaceModel(next: Record<string, { modelEntryId?: string; curatedEntryIds?: string[] }>): boolean {
  const ok = !!deps?.setSettingValue(SETTING_WORKSPACE, JSON.stringify(next))
  if (ok) broadcastDataChanged('settings')
  return ok
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

/* ============================== 迁移（B6） ============================== */

/**
 * 扫「8 个槽位 + 全局默认 + 最近使用过的会话模型」，为每个被引用的旧 spec 建 `source:'auto'` 条目。
 *
 * 三条硬约束：
 * 1. **幂等**：已存在的 (providerId, modelId) 不重复建；
 * 2. **只建被引用的**：供应商库存里没被用过的模型不建条目（否则用户一开界面就被塞一屏）；
 * 3. **旧键不动**：调用方继续按 `providerId:modelId` 读也成立（回滚只需删 `modelCatalogV1`）。
 */
export function ensureModelCatalogMigrated(recentSpecs: string[] = []): { created: number; total: number } {
  if (!deps || migrated) return { created: 0, total: readCatalog().length }
  const catalog = readCatalog()
  const seen = new Set(catalog.map((e) => `${e.providerId}:${e.modelId}`))
  const now = new Date().toISOString()
  let created = 0

  // 最近使用：调用方没给就从会话库派生（模型覆盖是按会话持久化的，不能再靠内存 map）
  const recent = recentSpecs.length > 0 ? recentSpecs : deriveRecentSpecs()

  const add = (spec: string) => {
    const parsed = resolveSpec(spec, catalog)
    if (!parsed || parsed.entry) return
    const { providerId, modelId } = parsed
    const key = `${providerId}:${modelId}`
    if (seen.has(key)) return
    seen.add(key)
    created += 1
    catalog.push({
      id: `m_${hash12(key)}`,
      name: prettyName(modelId),
      providerId,
      modelId,
      reasoning: { supported: false, default: 'off' },
      capabilities: {},
      curated: true,
      source: 'auto',
      createdAt: now,
      updatedAt: now,
    })
  }

  for (const k of SLOT_KEYS) add(String(deps.getSettingValue(k) ?? ''))
  for (const s of recent) add(String(s ?? ''))
  add(String(deps.getSettingValue('defaultChatModel') ?? ''))

  // 同一 provider+model 可能被多处引用：去重后再落盘
  const deduped = dedupeBySpec(catalog)
  if (created > 0) writeCatalog(deduped)
  migrated = true
  return { created, total: deduped.length }
}

/** 从会话库派生「最近用过的模型」（只取持久化的 modelId，去重、最多 30 条） */
function deriveRecentSpecs(): string[] {
  try {
    // 会话库依赖仓库上下文：未打开仓库时 listAgentSessions 自己返回空数组，不会抛错
    const rows = listAgentSessions()
    const out: string[] = []
    for (const row of rows.slice(0, 200)) {
      const spec = String(row.modelId ?? '').trim()
      if (spec && !out.includes(spec)) out.push(spec)
      if (out.length >= 30) break
    }
    return out
  } catch { return [] }
}

/** 12 位稳定 hash（id 用；同一 spec 迁移两次得到同一个 id，幂等） */function hash12(s: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x1000193
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    h1 = (h1 ^ c) * 0x01000193
    h2 = (h2 + c * 131) | 0
  }
  const a = (h1 >>> 0).toString(36).padStart(7, '0')
  const b = (h2 >>> 0).toString(36).padStart(5, '0')
  return (a + b).slice(0, 12)
}

/** 「opencode/deepseek-v4.1-flash」→「Deepseek V4.1 Flash」；只影响显示名，随时可改 */
function prettyName(modelId: string): string {
  const base = modelId.includes('/') ? modelId.slice(modelId.lastIndexOf('/') + 1) : modelId
  return base
    .replace(/[-_.]+/g, ' ')
    .replace(/\b([a-z])/g, (_m, c: string) => c.toUpperCase())
    .trim() || modelId
}

/* ============================== CRUD ============================== */

export interface SaveEntryInput {
  id?: string
  name?: string
  providerId: string
  accountId?: string
  modelId: string
  /** null / 0 / '' = 显式清空（否则沿用旧值） */
  contextWindow?: number | null
  /**
   * @deprecated 思考能力判定以 `capabilities.reasoning` 为准。
   * 字段保留只为兼容旧调用点；保存时会被派生覆盖（= capabilities.reasoning === 'yes'）。
   */
  reasoningSupported?: boolean
  reasoningDefault?: 'off' | 'low' | 'medium' | 'high'
  capabilities?: Record<string, 'auto' | 'yes' | 'no'>
  curated?: boolean
  tags?: string[]
  free?: boolean
}

export function saveEntry(input: SaveEntryInput): { ok: boolean; entry?: ModelEntry; error?: string } {
  if (!deps) return { ok: false, error: '模型目录尚未初始化' }
  const providerId = String(input.providerId ?? '').trim()
  const modelId = String(input.modelId ?? '').trim()
  if (!providerId || !modelId) return { ok: false, error: '供应商与模型 id 都不能为空' }

  const list = readCatalog()
  const now = new Date().toISOString()
  const dup = list.find((e) => e.providerId === providerId && e.modelId === modelId && e.id !== input.id)
  if (dup) return { ok: false, error: `已存在同一模型的条目：${dup.name}`, entry: dup }

  if (input.id) {
    const i = list.findIndex((e) => e.id === input.id)
    if (i < 0) return { ok: false, error: '条目不存在' }
    const prev = list[i]
    const nextCaps = { ...prev.capabilities, ...(input.capabilities ?? {}) }
    list[i] = {
      ...prev,
      name: String(input.name ?? prev.name).trim() || prev.name,
      providerId,
      modelId,
      accountId: input.accountId ?? prev.accountId,
      // 显式给了 contextWindow（哪怕是 null / '' / 0）= 用户要改或要清空；没给才沿用旧值。
      // 之前的 `numOrUndef(...) ?? prev` 让「清空」永远无效 —— 清空后仍显示老数字。
      contextWindow: Object.prototype.hasOwnProperty.call(input, 'contextWindow')
        ? numOrUndef(input.contextWindow)
        : prev.contextWindow,
      reasoning: {
        // 仅兼容旧数据：判定以 capabilities.reasoning 为准；写盘时同步派生，旧读取方不会看到矛盾值
        supported: nextCaps.reasoning === 'yes',
        default: input.reasoningDefault ?? prev.reasoning.default,
      },
      capabilities: nextCaps,
      curated: input.curated ?? prev.curated,
      tags: input.tags ?? prev.tags,
      free: input.free ?? prev.free,
      updatedAt: now,
    }
    return writeCatalog(list) ? { ok: true, entry: list[i] } : { ok: false, error: '写入设置失败' }
  }

  const caps = (input.capabilities ?? {}) as ModelEntry['capabilities']
  const entry: ModelEntry = {
    id: `m_${hash12(`${providerId}:${modelId}`)}`,
    name: String(input.name ?? '').trim() || prettyName(modelId),
    providerId,
    accountId: input.accountId,
    modelId,
    contextWindow: numOrUndef(input.contextWindow),
    reasoning: {
      // 仅兼容旧数据：判定以 capabilities.reasoning 为准（字段 deprecated，见 SaveEntryInput）
      supported: caps.reasoning === 'yes',
      default: input.reasoningDefault ?? 'off',
    },
    capabilities: caps,
    curated: input.curated !== false,
    tags: input.tags,
    free: input.free,
    source: 'user',
    createdAt: now,
    updatedAt: now,
  }
  list.push(entry)
  return writeCatalog(list) ? { ok: true, entry } : { ok: false, error: '写入设置失败' }
}

function numOrUndef(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** 删除条目：被任何槽位 / 工作区默认 / 精选 / 全局默认引用时拒绝（B12） */
export function removeEntry(id: string): { ok: boolean; refs?: Array<{ entryId: string; where: string }>; error?: string } {
  if (!deps) return { ok: false, error: '模型目录尚未初始化' }
  const list = readCatalog()
  if (!list.some((e) => e.id === id)) return { ok: false, error: '条目不存在' }
  const refs = collectRefs(list)
  const hit = refs.filter((r) => r.entryId === id)
  if (hit.length > 0) return { ok: false, refs: hit, error: '该模型仍被引用，先改掉引用再删除' }
  return writeCatalog(list.filter((e) => e.id !== id)) ? { ok: true } : { ok: false, error: '写入设置失败' }
}

export function collectRefs(list: ModelEntry[] = readCatalog()): Array<{ entryId: string; where: string }> {
  if (!deps) return []
  const slots: Partial<Record<ModelSlotKey, string>> = {}
  for (const k of SLOT_KEYS) {
    const v = String(deps.getSettingValue(k) ?? '').trim()
    if (v) slots[k] = v
  }
  return findReferences({
    catalog: list,
    slots,
    workspaceEntry: readWorkspaceModel(),
    defaultEntryId: String(deps.getSettingValue(SETTING_DEFAULT) ?? '').trim() || undefined,
  })
}

/** 批量把引用从旧条目改到新条目（删除前的显式操作；B12 的配套） */
export function adoptRefs(fromEntryId: string, toEntryId: string): { ok: boolean; changed: number; error?: string } {
  if (!deps) return { ok: false, changed: 0, error: '模型目录尚未初始化' }
  const list = readCatalog()
  const target = list.find((e) => e.id === toEntryId)
  if (!target) return { ok: false, changed: 0, error: '目标条目不存在' }
  let changed = 0
  for (const k of SLOT_KEYS) {
    if (String(deps.getSettingValue(k) ?? '').trim() === fromEntryId) {
      deps.setSettingValue(k, toEntryId)
      changed += 1
    }
  }
  if (String(deps.getSettingValue(SETTING_DEFAULT) ?? '').trim() === fromEntryId) {
    deps.setSettingValue(SETTING_DEFAULT, toEntryId)
    changed += 1
  }
  const ws = readWorkspaceModel()
  let wsChanged = false
  for (const [wsId, v] of Object.entries(ws)) {
    if (v.modelEntryId === fromEntryId) { v.modelEntryId = toEntryId; wsChanged = true; changed += 1 }
    if (v.curatedEntryIds?.includes(fromEntryId)) {
      v.curatedEntryIds = Array.from(new Set(v.curatedEntryIds.map((x) => (x === fromEntryId ? toEntryId : x))))
      wsChanged = true
      changed += 1
    }
    void wsId
  }
  if (wsChanged) writeWorkspaceModel(ws)
  broadcastDataChanged('settings')
  return { ok: true, changed }
}

/* ============================== 测试（B11） ============================== */

/**
 * 连通性测试：**只返回结果，不写回条目**（B11 已拍板）。
 * 用 `accounting:'caller'` 跳过记账，避免每次点「测试」都在用量里留一条噪音记录。
 */
export async function testEntry(id: string): Promise<{
  ok: boolean
  latencyMs?: number
  error?: string
  contextWindow?: number
}> {
  const entry = readCatalog().find((e) => e.id === id)
  if (!entry) return { ok: false, error: '条目不存在' }
  const started = Date.now()
  try {
    const { invokeLlmInternal } = await import('./llmService')
    const r = await invokeLlmInternal({
      providerId: entry.providerId,
      modelId: entry.modelId,
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 1,
      accounting: 'caller',
      sessionId: 'model-test',
    })
    const latencyMs = Date.now() - started
    if (!r.ok) return { ok: false, latencyMs, error: r.error }
    return { ok: true, latencyMs }
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: (e as Error).message }
  }
}

/* ============================== 工作区绑定 ============================== */

export function setWorkspaceModel(wsId: string, patch: { modelEntryId?: string | null; curatedEntryIds?: string[] | null }): { ok: boolean } {
  const id = String(wsId ?? '').trim()
  if (!id) return { ok: false }
  const ws = readWorkspaceModel()
  const cur = ws[id] ?? {}
  if (patch.modelEntryId !== undefined) {
    if (patch.modelEntryId) cur.modelEntryId = String(patch.modelEntryId)
    else delete cur.modelEntryId
  }
  if (patch.curatedEntryIds !== undefined) {
    if (patch.curatedEntryIds) cur.curatedEntryIds = Array.from(new Set(patch.curatedEntryIds.filter(Boolean)))
    else delete cur.curatedEntryIds
  }
  ws[id] = cur
  return { ok: writeWorkspaceModel(ws) }
}

export function setDefaultEntry(id: string | null): { ok: boolean } {
  return { ok: !!deps?.setSettingValue(SETTING_DEFAULT, id ? String(id) : '') }
}

/* ============================== IPC ============================== */

export function registerModelCatalogHandlers(d: ModelCatalogDeps): void {
  deps = d
  migrated = false

  ipcMain.handle('llm:catalog:list', () => {
    // 首次打开界面即做一次幂等迁移（只建「被引用过的」条目），失败不影响返回值
    try { ensureModelCatalogMigrated() } catch { /* 迁移失败不阻断列表 */ }
    const catalog = readCatalog()
    return {
      catalog,
      defaultEntryId: String(d.getSettingValue(SETTING_DEFAULT) ?? ''),
      workspaceEntry: readWorkspaceModel(),
      slots: Object.fromEntries(SLOT_KEYS.map((k) => [k, String(d.getSettingValue(k) ?? '')])),
      refs: collectRefs(catalog),
    }
  })

  ipcMain.handle('llm:catalog:migrate', (_e, recentSpecs?: string[]) => {
    migrated = false
    return ensureModelCatalogMigrated(Array.isArray(recentSpecs) ? recentSpecs.map(String) : [])
  })

  ipcMain.handle('llm:catalog:save', (_e, input: SaveEntryInput) => saveEntry(input ?? ({} as SaveEntryInput)))
  ipcMain.handle('llm:catalog:remove', (_e, id: string) => removeEntry(String(id ?? '')))
  ipcMain.handle('llm:catalog:adoptRefs', (_e, from: string, to: string) => adoptRefs(String(from ?? ''), String(to ?? '')))
  ipcMain.handle('llm:catalog:test', (_e, id: string) => testEntry(String(id ?? '')))
  ipcMain.handle('llm:catalog:setDefault', (_e, id: string | null) => setDefaultEntry(id))
  ipcMain.handle('llm:catalog:setWorkspace', (_e, wsId: string, patch: { modelEntryId?: string | null; curatedEntryIds?: string[] | null }) =>
    setWorkspaceModel(wsId, patch ?? {}))
}
