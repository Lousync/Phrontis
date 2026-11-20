/**
 * 统一 AI 助手输入区模型菜单的纯函数层（P3 收口）。
 *
 * 与 `modelMenuPure.ts` 的分工：那套是「本课程默认 / 本课程精选 / 全局精选 / 最近使用」
 * 四组的完整菜单（AI 教学侧），本文件只服务助手输入区这一枚浮层——它的外壳里还有
 * 「思考模式」开关，所以不复用 `ModelMenu` 组件，只把**分组规则**复用成同一口径：
 *   精选 → 最近使用（≤4）→ 全部模型，同一 entry.id 只出现在最靠前的一组。
 *
 * 为什么单独拆文件而不是写进 ChatBody：分组顺序 / 去重 / 搜索阈值 / 展示名三级兜底
 * 在组件里只能靠点开看，拆成零依赖纯函数后由
 * `.AGENT/scripts/ai-teaching/verify-chat-model-menu.mjs` 逐条钉死。
 *
 * ★ 只 `import type`：契约脚本用 `stripTypeScriptTypes` 直接跑本文件，
 *   任何运行时依赖（含 `src/lib/modelCatalog`）都会让脚本断在解析阶段。
 *   因此能力 chip 的标签顺序在这里镜像一份 `capabilityChips`（同序同文案、过滤 auto），
 *   组件侧仍用它自己的 `capabilityChips(entry)` 上色，两边口径由契约脚本对齐。
 */
import type { LlmCapabilityKey, LlmModelEntry } from '../../../types'

/** 一行：条目 + 免费标记 + 显式能力 chip 文案（auto 不占位，最多 2 枚） */
export interface ChatModelRow {
  entry: LlmModelEntry
  free: boolean
  chips: string[]
}

export interface ChatModelSection {
  id: 'curated' | 'recent' | 'all'
  title: string
  rows: ChatModelRow[]
}

/** 与 `capabilityChips` 同序同文案（改这里必须同步 `src/lib/modelCatalog.ts`） */
const CHIP_DEFS: Array<{ key: LlmCapabilityKey; label: string }> = [
  { key: 'vision', label: '视觉' },
  { key: 'tools', label: '工具' },
  { key: 'json', label: 'JSON' },
  { key: 'imageGeneration', label: '生图' },
  { key: 'imageEdit', label: '改图' },
]

/** 行内只留 2 枚：250px 宽的浮层里再多就把主名挤没了 */
const MAX_CHIPS = 2
/** 最近使用只留 4 条：它只是「刚才用过」的捷径，不是浏览入口 */
export const MAX_RECENT_ROWS = 4
/** 全部模型超过这个条数才值得给搜索框 */
export const SEARCH_THRESHOLD = 8

function toRow(entry: LlmModelEntry): ChatModelRow {
  const chips = CHIP_DEFS
    // auto = 未显式标注，不占视觉噪音；yes / no 都是用户明确表态过的信息
    .filter((d) => (entry.capabilities?.[d.key] ?? 'auto') !== 'auto')
    .slice(0, MAX_CHIPS)
    .map((d) => d.label)
  return { entry, free: entry.free === true, chips }
}

/**
 * 分组顺序固定：精选 → 最近使用 → 全部模型。
 *
 * 去重：同一 entryId 只出现在**最靠前**的一组（同一个模型在三个组里重复出现，
 * 只会让人怀疑「是不是不同的模型」）。空组不输出。
 */
export function buildChatModelSections(input: {
  entries: LlmModelEntry[]
  curated: LlmModelEntry[]
  recentSpecs: string[]
  resolve: (spec: string) => { entry?: LlmModelEntry } | null
}): ChatModelSection[] {
  const entries = Array.isArray(input.entries) ? input.entries : []
  const byId = new Map<string, LlmModelEntry>()
  for (const e of entries) if (e && e.id) byId.set(e.id, e)

  // spec 既可能是条目 id，也可能是旧 `providerId:modelId`（迁移期数据）
  const pick = (spec: string | undefined): LlmModelEntry | undefined => {
    const s = String(spec ?? '').trim()
    if (!s) return undefined
    const direct = byId.get(s)
    if (direct) return direct
    try {
      return input.resolve(s)?.entry
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

  const sections: ChatModelSection[] = []
  const push = (id: ChatModelSection['id'], title: string, kept: Array<LlmModelEntry | null>) => {
    const items = kept.filter((x): x is LlmModelEntry => !!x)
    if (items.length > 0) sections.push({ id, title, rows: items.map(toRow) })
  }

  // 1. 精选（显式 curated:true；无人精选时该组消失，让「全部模型」自然接管）
  push('curated', '精选', (input.curated ?? []).map((e) => take(e)))

  // 2. 最近使用：解析不到条目的 spec 直接丢（绝不显示裸 ID），最多 4 条
  const recents: LlmModelEntry[] = []
  for (const spec of input.recentSpecs ?? []) {
    if (recents.length >= MAX_RECENT_ROWS) break
    const entry = take(pick(spec))
    if (entry) recents.push(entry)
  }
  push('recent', '最近使用', recents)

  // 3. 全部模型：前面两组没露面的其余条目
  push('all', '全部模型', entries.map((e) => take(e)))

  return sections
}

/** 全部模型内的搜索：大小写不敏感，匹配名称 / 真实 modelId / 供应商 / 标签 */
export function filterChatModels(entries: LlmModelEntry[], query: string): LlmModelEntry[] {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : []
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

/** 搜索框只在「全部模型」超过 8 条时出现（否则一个下拉框反而多一层操作） */
export function shouldShowSearch(totalRows: number): boolean {
  const n = Number(totalRows)
  return Number.isFinite(n) && n > SEARCH_THRESHOLD
}

/**
 * 展示名三级兜底：空 → 默认模型；条目命中 → name；旧 spec → 冒号后段；其它原样。
 * 与 `resolveCatalogEntry` 同构（条目 id 精确命中优先，其次 `pid:mid` 找同 spec 条目），
 * 也就是说旧 spec 只要目录里还有对应条目，仍然显示用户起的名字。
 */
export function modelLabelOf(raw: string, entries: LlmModelEntry[]): string {
  const s = String(raw ?? '').trim()
  if (!s) return '默认模型'
  const list = Array.isArray(entries) ? entries : []

  const hit = list.find((e) => e && e.id === s)
  if (hit) return String(hit.name ?? '').trim() || String(hit.modelId ?? '').trim() || hit.id

  // `m_xxx` 是条目 id 的专有形态：拼错就是拼错，不要悄悄退化成一截字符串
  if (!s.startsWith('m_')) {
    const i = s.indexOf(':')
    if (i > 0 && i < s.length - 1) {
      const providerId = s.slice(0, i)
      const modelId = s.slice(i + 1)
      const same = list.find((e) => e && e.providerId === providerId && e.modelId === modelId)
      if (same) return String(same.name ?? '').trim() || modelId
      return modelId
    }
  }

  return s
}
