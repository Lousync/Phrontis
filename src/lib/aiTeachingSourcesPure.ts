/**
 * AI教学 · 素材/段预检 —— 纯函数与类型（**零依赖**，主进程与渲染层共用，契约脚本直接 import）。
 *
 * 3.14.0 简化口径（docs/ai-teaching-simplify-plan.md）：
 *   · 一份 sources.json：登记（文件） / 章级分配（anchor） / 段级确认（快照）三分离；
 *   · 开段预检默认 B（按目录 / 文件名 / 标题缩窄），匹配失败回退 A（整章分配）；
 *   · 段快照只读，后续改章级分配不影响已开的段。
 */

export type SourceType =
  | 'md'
  | 'dir'
  | 'pdf'
  | 'pptx'
  | 'docx'
  | 'image'
  | 'url'
  | 'code'
  | 'other'

/** 素材区间。文件名 / 标题 / 页码 / 行号都是**闭区间**。 */
export type SourceAnchor =
  | { kind: 'whole' }
  | { kind: 'pages'; from: number; to: number }
  | { kind: 'headings'; from: string; to?: string }
  | { kind: 'files'; paths: string[] }
  | { kind: 'lines'; from: number; to: number }

export interface SourceIndexEntry {
  /** 标题 / 文件名 / 章节名（用于 B 匹配） */
  label: string
  anchor: SourceAnchor
  /** 标题层级（md），可选 */
  level?: number
}

export interface SourceEntry {
  id: string
  title: string
  type: SourceType
  /** 仓库相对路径；URL 素材用 url。禁止绝对路径。 */
  rel?: string
  url?: string
  /** 提取稿仓库相对路径（PDF/PPTX/图片/网页） */
  extractRel?: string | null
  /** 整份素材的默认区间 */
  anchor: SourceAnchor
  status: 'ready' | 'needs-extract' | 'error'
  /** 轻量索引；最多 200 条，不存正文 */
  index?: SourceIndexEntry[]
  indexUpdatedAt?: string
  note?: string
  createdAt: string
}

export interface ChapterAssignment {
  sourceId: string
  /** 本章内的短标签，如「第 3 章 进程」 */
  label: string
  /** 本章的范围；整章 = whole / 页码 / 标题区间 / 文件子集 */
  anchor: SourceAnchor
  addedAt: string
}

export interface SegmentSource {
  sourceId: string
  label: string
  /** 预检收窄后的实际区间 */
  anchor: SourceAnchor
  mode: 'exact' | 'narrow' | 'fallback'
}

export interface WorkspaceSources {
  sources: SourceEntry[]
  assignments: Record<string, ChapterAssignment[]>
  migratedAt?: string
}

export interface SourcesFile {
  v: 1
  workspaces: Record<string, WorkspaceSources>
}

export interface PreflightUnit {
  id: string
  name: string
  learned?: boolean
}

export interface PreflightCandidate {
  sourceId: string
  title: string
  label: string
  anchor: SourceAnchor
  mode: 'exact' | 'narrow' | 'fallback'
  matchedUnitIds: string[]
  reason: string
}

export interface PreflightResult {
  units: PreflightUnit[]
  selectedUnitIds: string[]
  candidates: PreflightCandidate[]
  /** 选中知识点里没有匹配到任何素材的 unit id */
  unmatchedUnitIds: string[]
}

// ===== 清洗 / 匹配 =====

/** 归一化人名/标题：去空白、标点，英文小写；中文保留。用于 B 匹配。 */
export function normMatchText(v: unknown): string {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[()[\]{}【】《》〈〉“”"'`·.,，。:：;；!！?？、/\\|_\-—–~～]+/g, '')
    .trim()
}

/** 标题/文件名是否与知识点名对得上（短名至少 2 字，避免「一」这种误命中）。 */
export function isNameMatch(unitName: unknown, label: unknown): boolean {
  const a = normMatchText(unitName)
  const b = normMatchText(label)
  if (!a || !b) return false
  if (a === b) return true
  if (a.length >= 2 && b.includes(a)) return true
  if (b.length >= 2 && a.includes(b)) return true
  return false
}

/** 区间的中文短标签（界面 / 注入共用）。 */
export function anchorLabel(a: SourceAnchor | null | undefined): string {
  if (!a) return '整份'
  switch (a.kind) {
    case 'pages':
      return a.from === a.to ? `第 ${a.from} 页` : `第 ${a.from}–${a.to} 页`
    case 'headings':
      return a.to && a.to !== a.from ? `标题 ${a.from}–${a.to}` : `标题 ${a.from}`
    case 'files':
      if (a.paths.length === 0) return '整份'
      if (a.paths.length === 1) return a.paths[0]
      return `${a.paths.length} 个文件`
    case 'lines':
      return a.from === a.to ? `第 ${a.from} 行` : `第 ${a.from}–${a.to} 行`
    default:
      return '整份'
  }
}

/** 默认选点：从被点的知识点开始，连续选最多 max 个未学点；遇到已学即停。 */
export function defaultUnitSelection(units: ReadonlyArray<PreflightUnit>, clickedUnitId: string, max = 3): string[] {
  const idx = units.findIndex((u) => u.id === clickedUnitId)
  if (idx < 0 || units[idx]?.learned) return []
  const out: string[] = []
  for (let i = idx; i < units.length && out.length < Math.max(1, max); i++) {
    if (units[i].learned) break
    out.push(units[i].id)
  }
  return out
}

function indexEntryForUnit(entry: SourceIndexEntry, unitName: string): boolean {
  return isNameMatch(unitName, entry.label)
}

function anchorFromMatchedEntries(entries: SourceIndexEntry[], fallback: SourceAnchor): SourceAnchor {
  if (!entries.length) return fallback
  const first = entries[0]?.anchor
  const last = entries[entries.length - 1]?.anchor
  if (!first || !last) return fallback
  if (first.kind === 'headings' && last.kind === 'headings') {
    return last.from && last.from !== first.from ? { kind: 'headings', from: first.from, to: last.from } : { kind: 'headings', from: first.from }
  }
  if (first.kind === 'files') {
    const paths = Array.from(new Set(entries.flatMap((e) => (e.anchor.kind === 'files' ? e.anchor.paths : []))))
    return { kind: 'files', paths }
  }
  if (first.kind === 'pages' && last.kind === 'pages') {
    return { kind: 'pages', from: Math.min(first.from, last.from), to: Math.max(first.to, last.to) }
  }
  if (first.kind === 'lines' && last.kind === 'lines') {
    return { kind: 'lines', from: Math.min(first.from, last.from), to: Math.max(first.to, last.to) }
  }
  return fallback
}

/**
 * 章级分配 → 段级候选（纯函数，预检用）。
 *
 * 匹配规则（B → A）：
 *   1. 用 source.index 的 label 与 unit 名归一化匹配；
 *   2. 全命中 = exact，部分命中 = narrow，全不命中 = fallback；
 *   3. fallback 一律使用本章分配 anchor；
 *   4. 没有章级分配的素材不会出现在候选里（UI 标「未分配」）。
 */
export function matchPreflight(input: {
  units: ReadonlyArray<PreflightUnit>
  assignments: ReadonlyArray<ChapterAssignment>
  sources: ReadonlyArray<SourceEntry>
  /** 只对选中的 unit 做匹配；缺省=全部 units */
  selectedUnitIds?: ReadonlyArray<string>
}): PreflightCandidate[] {
  const selected = new Set(
    (input.selectedUnitIds && input.selectedUnitIds.length
      ? input.selectedUnitIds
      : input.units.map((u) => u.id)
    ).map(String),
  )
  const units = input.units.filter((u) => selected.has(u.id))
  if (!units.length) return []
  const sourceById = new Map(input.sources.map((s) => [s.id, s] as const))
  const out: PreflightCandidate[] = []
  for (const asg of input.assignments) {
    const src = sourceById.get(asg.sourceId)
    if (!src) continue
    const index = Array.isArray(src.index) ? src.index : []
    const matchedEntries: SourceIndexEntry[] = []
    const matchedUnitIds: string[] = []
    for (const u of units) {
      let hit: SourceIndexEntry | null = null
      // 先找完全相等，再找包含；避免「进程」抢走「进程与线程」的标题
      for (const e of index) {
        if (normMatchText(e.label) === normMatchText(u.name)) { hit = e; break }
      }
      if (!hit) hit = index.find((e) => indexEntryForUnit(e, u.name)) ?? null
      if (hit) {
        matchedEntries.push(hit)
        matchedUnitIds.push(u.id)
      }
    }
    const matched = new Set(matchedUnitIds)
    const mode: PreflightCandidate['mode'] =
      matched.size === 0
        ? 'fallback'
        : matched.size === units.length
          ? 'exact'
          : 'narrow'
    const anchor = mode === 'fallback' ? asg.anchor : anchorFromMatchedEntries(matchedEntries, asg.anchor)
    const reason =
      mode === 'exact'
        ? `按标题/文件名逐知识点匹配（${matched.size}/${units.length}）`
        : mode === 'narrow'
          ? `只匹配到 ${matched.size}/${units.length} 个知识点，按首尾收窄`
          : '没有可匹配的标题/文件名，回退本章分配区间'
    out.push({
      sourceId: src.id,
      title: src.title,
      label: asg.label,
      anchor,
      mode,
      matchedUnitIds,
      reason,
    })
  }
  return out
}

/** 选中知识点里，哪些完全没被任何候选覆盖到。 */
export function unmatchedUnitIds(
  units: ReadonlyArray<PreflightUnit>,
  candidates: ReadonlyArray<PreflightCandidate>,
  selectedUnitIds: ReadonlyArray<string>,
): string[] {
  const covered = new Set(candidates.flatMap((c) => c.matchedUnitIds))
  const selected = new Set(selectedUnitIds.map(String))
  return units.filter((u) => selected.has(u.id) && !covered.has(u.id)).map((u) => u.id)
}

/** 预检一站式结果（渲染层直接用）。 */
export function buildPreflight(input: {
  units: ReadonlyArray<PreflightUnit>
  assignments: ReadonlyArray<ChapterAssignment>
  sources: ReadonlyArray<SourceEntry>
  clickedUnitId?: string
  selectedUnitIds?: ReadonlyArray<string>
  maxUnits?: number
}): PreflightResult {
  const selectedUnitIds =
    input.selectedUnitIds && input.selectedUnitIds.length
      ? [...input.selectedUnitIds]
      : input.clickedUnitId
        ? defaultUnitSelection(input.units, input.clickedUnitId, input.maxUnits ?? 3)
        : input.units.filter((u) => !u.learned).map((u) => u.id)
  const candidates = matchPreflight({
    units: input.units,
    assignments: input.assignments,
    sources: input.sources,
    selectedUnitIds,
  })
  return {
    units: [...input.units],
    selectedUnitIds,
    candidates,
    unmatchedUnitIds: unmatchedUnitIds(input.units, candidates, selectedUnitIds),
  }
}

/** 轻校验：anchor 是否可用（防写盘时塞进空对象）。 */
export function isValidAnchor(a: unknown): a is SourceAnchor {
  if (!a || typeof a !== 'object') return false
  const o = a as { kind?: unknown; from?: unknown; to?: unknown; paths?: unknown }
  switch (o.kind) {
    case 'whole':
      return true
    case 'pages':
    case 'lines':
      return Number.isFinite(Number(o.from)) && Number.isFinite(Number(o.to))
    case 'headings':
      return typeof o.from === 'string' && o.from.trim().length > 0 && (o.to == null || typeof o.to === 'string')
    case 'files':
      return Array.isArray(o.paths) && o.paths.every((p) => typeof p === 'string')
    default:
      return false
  }
}
