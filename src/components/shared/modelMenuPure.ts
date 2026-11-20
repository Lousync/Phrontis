/**
 * 对话侧模型菜单的纯函数层（P3.2）。
 *
 * 为什么单独拆出来：分组顺序 / 跨组去重 / 最近使用过滤 / 键盘循环这些规则，
 * 在菜单组件里只能靠点开看；拆成零依赖纯函数后，契约脚本可以逐条钉死
 * （`.AGENT/scripts/ai-teaching/verify-model-menu.mjs`），日后改分组不会悄悄改坏。
 *
 * 方案：`/home/lousync/桌面/Phrontis-AI教学-技术方案-2026-11-19.md` §6.1
 * 展示口径：`/home/lousync/桌面/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md` §15.3
 *
 * ★ 只 `import type`：契约脚本用 `stripTypeScriptTypes` 直接跑本文件，
 *   任何运行时依赖（含 `src/lib/modelCatalog`）都会让脚本断在解析阶段。
 */
import type { LlmModelEntry } from '../../types'

export interface MenuSection {
  id: string
  title: string
  items: LlmModelEntry[]
}

export interface MenuSectionsInput {
  /** 目录里的全部条目（用于按 id 找回精选 / 默认指向的条目） */
  entries: LlmModelEntry[]
  /** 全局精选（`curated: true`）；组件侧不要传 `useModelCatalog().curated` 的兜底结果 */
  curated: LlmModelEntry[]
  /** 本课程默认（工作区绑定值，可能是条目 id，迁移期也可能是旧 `pid:mid`） */
  workspaceDefaultId?: string
  /**
   * 全局默认条目 id。用于「本课程默认 === 全局默认」时不重复出组。
   * 缺省 = 无法判定，按「有绑定就展示」处理。
   */
  globalDefaultId?: string
  /** 本课程精选条目 id 列表 */
  workspaceCuratedIds?: string[]
  /** 最近使用（条目 id / 旧 spec 混排，能解析成条目才显示） */
  recentSpecs: string[]
  /** spec → 条目；由调用方注入 `resolveCatalogEntry(spec, entries)`，保持与设置页同一口径 */
  resolve: (spec: string) => { entry?: LlmModelEntry } | null
}

/**
 * 分组顺序固定：本课程默认 → 本课程精选 → 全局精选 → 最近使用。
 *
 * 去重规则：同一 entryId 只出现在**最靠前**的一组（用户越可能点的组越靠前，
 * 同一个模型在四个组里重复出现只会让人怀疑「是不是不同的模型」）。空组不输出。
 */
export function buildMenuSections(input: MenuSectionsInput): MenuSection[] {
  const {
    entries, curated, workspaceDefaultId, globalDefaultId,
    workspaceCuratedIds, recentSpecs, resolve,
  } = input

  const byId = new Map<string, LlmModelEntry>()
  for (const e of entries) if (e && e.id) byId.set(e.id, e)

  // spec 既可能是条目 id，也可能是旧 `providerId:modelId`（迁移期数据）
  const pick = (spec: string | undefined): LlmModelEntry | undefined => {
    const s = String(spec ?? '').trim()
    if (!s) return undefined
    const direct = byId.get(s)
    if (direct) return direct
    try {
      return resolve(s)?.entry
    } catch {
      return undefined
    }
  }

  const seen = new Set<string>()
  const take = (entry: LlmModelEntry | undefined): LlmModelEntry | null => {
    if (!entry || !entry.id || seen.has(entry.id)) return null
    seen.add(entry.id)
    return entry
  }

  const sections: MenuSection[] = []
  const push = (id: string, title: string, items: Array<LlmModelEntry | null>) => {
    const kept = items.filter((x): x is LlmModelEntry => !!x)
    if (kept.length > 0) sections.push({ id, title, items: kept })
  }

  // 1. 本课程默认：只有与全局默认不同才单列（相同时它已在全局精选里，且打了勾）
  const sameAsGlobal = !!workspaceDefaultId && !!globalDefaultId && workspaceDefaultId === globalDefaultId
  push('workspaceDefault', '本课程默认', sameAsGlobal ? [] : [take(pick(workspaceDefaultId))])

  // 2. 本课程精选
  push('workspaceCurated', '本课程精选', (workspaceCuratedIds ?? []).map((id) => take(pick(id))))

  // 3. 全局精选
  push('curated', '全局精选', (curated ?? []).map((e) => take(e)))

  // 4. 最近使用（解析不到条目的 spec 直接丢，不显示裸 ID）
  push('recent', '最近使用', (recentSpecs ?? []).map((spec) => take(pick(spec))))

  return sections
}

/** 浏览全部模型时的搜索：大小写不敏感，匹配名称 / 真实 modelId / 供应商 / 标签 */
export function filterMenuEntries(entries: LlmModelEntry[], query: string): LlmModelEntry[] {
  const list = Array.isArray(entries) ? entries : []
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return list.slice()
  return list.filter((e) => {
    if (!e) return false
    const hay = [e.name, e.modelId, e.providerId, e.id, ...(e.tags ?? [])]
      .filter((x) => typeof x === 'string' && x)
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  })
}

/**
 * 键盘上下移动的循环导航：结果恒落在 `0..total-1`。
 * `total <= 0` 时返回 0（空列表也要有一个合法游标，避免调用方各自兜底）。
 */
export function nextIndex(current: number, delta: number, total: number): number {
  const n = Math.floor(Number(total))
  if (!Number.isFinite(n) || n <= 0) return 0
  const start = Number.isFinite(current) ? Math.trunc(current) : 0
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0
  return (((start + step) % n) + n) % n
}

/**
 * 行主文本：名称 → 真实 modelId → 条目 id（三级兜底）。
 * 供应商只在**名称缺失**时拼进来（那时光看 modelId 分不清是哪家），
 * 名称存在时供应商走行内小字，由组件渲染 —— 主文本保持短，不挤掉能力 chip。
 */
export function menuLabel(entry: LlmModelEntry, providerName?: string): string {
  if (!entry) return ''
  const name = String(entry.name ?? '').trim()
  if (name) return name
  const base = String(entry.modelId ?? '').trim() || String(entry.id ?? '').trim()
  if (!base) return '未命名模型'
  const p = String(providerName ?? '').trim()
  return p ? `${base} · ${p}` : base
}
