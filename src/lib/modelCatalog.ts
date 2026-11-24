/**
 * 模型条目（P3）渲染层基座。
 *
 * 分工：主进程 `modelCatalogStore.ts` 负责落盘与安全，`modelCatalogPure.ts` 负责推导；
 * 本文件只做两件事 —— 把快照取到渲染层，以及给 UI 提供**同一个**解析口径。
 *
 * 为什么 UI 也要一份解析：设置页、对话选择器、槽位行三处都要回答
 * 「这个值是条目还是旧 spec / 这个槽位能不能选它」。口径散开必然出现
 * 「设置里可选、对话里报错」的裂缝，所以统一走 `resolveCatalogEntry`。
 *
 * 方案：`/home/lousync/Projects/DesginProcess/Phrontis/已实现设计文档/Phrontis-AI教学-技术方案-2026-11-19.md` §6.1
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { llmCatalogList } from './ipc'
import { useDataChanged } from './dataChanged'
import type {
  LlmCatalogSlotKey,
  LlmCatalogSnapshot,
  LlmCapabilityKey,
  LlmModelEntry,
} from '../types'

/** 槽位 → 必需能力（与主进程 `pickSlotCandidates` 同口径） */
export const SLOT_CAPABILITY: Partial<Record<LlmCatalogSlotKey, LlmCapabilityKey>> = {
  aiTeachVisionModel: 'vision',
  aiImageModel: 'imageGeneration',
  aiImageEditModel: 'imageEdit',
}

export const SLOT_LABEL: Record<LlmCatalogSlotKey, string> = {
  defaultChatModel: '对话默认模型',
  assistantModelId: 'AI 助手（侧栏）',
  aiAssistantInlineSuggestModelId: '编辑器内联续写',
  aiTranslateModelId: '划词翻译',
  agentCompressModelId: '长对话压缩摘要',
  aiTeachVisionModel: '图片视觉转写',
  aiImageModel: '文生图',
  aiImageEditModel: '改图重绘',
}

/** 能力三态的展示口径：auto 是「跟随内置表 / 名称」，不是「未知」 */
export function capabilityChips(entry: LlmModelEntry): Array<{ key: LlmCapabilityKey; label: string; state: 'yes' | 'no' | 'auto' }> {
  const defs: Array<{ key: LlmCapabilityKey; label: string }> = [
    { key: 'vision', label: '视觉' },
    { key: 'tools', label: '工具' },
    { key: 'json', label: 'JSON' },
    { key: 'imageGeneration', label: '生图' },
    { key: 'imageEdit', label: '改图' },
  ]
  return defs
    .map((d) => ({ ...d, state: (entry.capabilities?.[d.key] ?? 'auto') as 'yes' | 'no' | 'auto' }))
    // auto 不占视觉噪音：只有显式 yes/no 才值得一枚 chip
    .filter((d) => d.state !== 'auto')
}

export interface ResolvedEntry {
  entry?: LlmModelEntry
  providerId: string
  modelId: string
  legacy: boolean
}

/**
 * 与主进程 `resolveSpec` 完全同构的渲染层版本（纯函数，便于单测）。
 * - `m_xxx` → 只认目录里存在的条目，拼错返回 null（不悄悄退化）
 * - `pid:mid` → 命中同 spec 条目则带出条目，否则返回原始 spec（迁移期兼容）
 */
export function resolveCatalogEntry(raw: string, entries: LlmModelEntry[]): ResolvedEntry | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const hit = entries.find((e) => e.id === s)
  if (hit) return { entry: hit, providerId: hit.providerId, modelId: hit.modelId, legacy: false }
  if (s.startsWith('m_')) return null
  const i = s.indexOf(':')
  if (i <= 0 || i === s.length - 1) return null
  const providerId = s.slice(0, i)
  const modelId = s.slice(i + 1)
  const same = entries.find((e) => e.providerId === providerId && e.modelId === modelId)
  return { entry: same, providerId, modelId, legacy: true }
}

/** 槽位是否可接受该条目（软过滤；只回答"不能"，不抛错） */
export function slotIncompatibleReason(entry: LlmModelEntry, slot: LlmCatalogSlotKey): string | null {
  const need = SLOT_CAPABILITY[slot]
  if (!need) return null
  const state = entry.capabilities?.[need]
  if (state === 'no') return `该模型已标记为不支持「${need}」`
  if (state === 'yes') return null
  // auto：视觉槽允许「未检测」的条目（内置表 / 名称兜底由主进程判），生图槽必须显式支持
  if (need === 'vision') return null
  return `该槽位需要模型明确支持「${need}」`
}

/** 选择器展示名：名称 + 供应商（同名条目在不同供应商下才不会认错） */
export function entryLabel(entry: LlmModelEntry, providerName?: string): string {
  const name = entry.name?.trim() || entry.modelId
  return providerName ? `${name} · ${providerName}` : name
}

/** 最近使用（渲染层本地，最多 8 条；只用 spec / 条目 id 字符串） */
const RECENT_KEY = 'ai.modelCatalog.recent'

export function readRecentSpecs(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, 8) : []
  } catch { return [] }
}

export function pushRecentSpec(spec: string): void {
  const s = String(spec ?? '').trim()
  if (!s) return
  try {
    const next = [s, ...readRecentSpecs().filter((x) => x !== s)].slice(0, 8)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch { /* 隐私模式忽略 */ }
}

export interface ModelCatalogApi {
  snapshot: LlmCatalogSnapshot | null
  loading: boolean
  reload: () => Promise<void>
  entries: LlmModelEntry[]
  /** 进「日常选择器」的条目：curated 优先，没人精选时退回全部 */
  curated: LlmModelEntry[]
  byId: (id: string) => LlmModelEntry | undefined
  /** 槽位当前指向的条目（旧 spec 且没有对应条目时为空，此时 UI 显示原始 spec） */
  entryForSlot: (slot: LlmCatalogSlotKey) => LlmModelEntry | undefined
  /** 工作区绑定：默认 + 精选 */
  workspace: (wsId: string) => { modelEntryId?: string; curatedEntryIds?: string[] }
}

export function useModelCatalog(): ModelCatalogApi {
  const [snapshot, setSnapshot] = useState<LlmCatalogSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const aliveRef = useRef(true)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const s = await llmCatalogList()
      if (aliveRef.current) setSnapshot(s)
    } catch {
      if (aliveRef.current) setSnapshot(null)
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    void reload()
    return () => { aliveRef.current = false }
  }, [reload])

  // 任何模型配置写入都会广播 settings；订阅它，避免两个窗口各改一半后界面不一致
  useDataChanged('settings', () => { void reload() })

  const entries = snapshot?.catalog ?? []
  const curated = useMemo(() => {
    const c = entries.filter((e) => e.curated)
    return c.length > 0 ? c : entries
  }, [entries])

  const byId = useCallback((id: string) => entries.find((e) => e.id === id), [entries])

  const entryForSlot = useCallback((slot: LlmCatalogSlotKey) => {
    const raw = snapshot?.slots?.[slot] ?? ''
    return resolveCatalogEntry(raw, entries)?.entry
  }, [entries, snapshot])

  const workspace = useCallback((wsId: string) => snapshot?.workspaceEntry?.[wsId] ?? {}, [snapshot])

  return { snapshot, loading, reload, entries, curated, byId, entryForSlot, workspace }
}
