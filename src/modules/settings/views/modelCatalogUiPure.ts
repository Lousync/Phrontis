/**
 * 设置页「模型条目」的纯函数层（P3.2）。
 *
 * 为什么单拎一个文件：过滤 / 分组 / 校验 / 引用文案 / 排序都是「口径」而不是「界面」，
 * 口径散进组件就等于没法验证。这里**零运行时依赖**（只 `import type`），契约脚本
 * `.AGENT/scripts/ai-teaching/verify-model-catalog-ui.mjs` strip 类型后可直接 import 断言。
 *
 * 注意 `SLOT_ZH`：`src/lib/modelCatalog.ts` 的 `SLOT_LABEL` 是同一份文案，但那个模块
 * 运行时会拉进 react / ipc，纯模块不能依赖它 —— 因此此处**镜像一份**，由上面那个脚本
 * 逐条比对两份文案，漂移会直接变红。
 */
import type { LlmCapabilityState, LlmCatalogSlotKey, LlmModelEntry } from '../../../types'

/** 名称上限（与条目行就地改名的输入宽度同一口径） */
export const MODEL_NAME_MAX = 60

/** 镜像 `SLOT_LABEL`（顺序与键名必须一一对应；契约脚本比对） */
const SLOT_ZH: Record<LlmCatalogSlotKey, string> = {
  defaultChatModel: '对话默认模型',
  assistantModelId: 'AI 助手（侧栏）',
  aiAssistantInlineSuggestModelId: '编辑器内联续写',
  aiTranslateModelId: '划词翻译',
  agentCompressModelId: '长对话压缩摘要',
  aiTeachVisionModel: '图片视觉转写',
  aiImageModel: '文生图',
  aiImageEditModel: '改图重绘',
}

function asList(entries: LlmModelEntry[]): LlmModelEntry[] {
  return Array.isArray(entries) ? entries.filter((e): e is LlmModelEntry => !!e) : []
}

/** 按名称 / 真实 model id 过滤（大小写不敏感；空查询返回全部且**不改顺序**） */
export function filterEntries(entries: LlmModelEntry[], query: string): LlmModelEntry[] {
  const list = asList(entries)
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return list.slice()
  return list.filter((e) => {
    const name = String(e?.name ?? '').toLowerCase()
    const mid = String(e?.modelId ?? '').toLowerCase()
    return name.includes(q) || mid.includes(q)
  })
}

/**
 * 选择器分组：精选在前，其后「全部」。
 * 精选 = 全部时不重复出两组（两组内容一样只会让人以为漏了一半）。
 */
export function groupForPicker(entries: LlmModelEntry[]): Array<{ title: string; items: LlmModelEntry[] }> {
  const list = asList(entries)
  const curated = list.filter((e) => e.curated)
  const groups: Array<{ title: string; items: LlmModelEntry[] }> = []
  if (curated.length > 0 && curated.length < list.length) groups.push({ title: '精选', items: curated })
  groups.push({ title: '全部', items: list })
  return groups
}

/** 新建 / 改名 / 改窗口的统一校验；返回中文原因，通过返回 null */
export function validateSaveInput(input: {
  name?: string
  providerId: string
  modelId: string
  contextWindow?: number
}): string | null {
  const name = String(input?.name ?? '').trim()
  if (name.length > MODEL_NAME_MAX) return `名称最多 ${MODEL_NAME_MAX} 个字符`
  if (!String(input?.providerId ?? '').trim()) return '请选择供应商'
  if (!String(input?.modelId ?? '').trim()) return '请选择模型'
  const cw = input?.contextWindow
  if (cw !== undefined && cw !== null) {
    const n = Number(cw)
    if (!Number.isFinite(n) || n <= 0) return '上下文窗口必须是大于 0 的整数'
  }
  return null
}

/** `where` 说成人话：`slot:assistantModelId` → `场景「AI 助手（侧栏）」` */
function whereText(where: string): string {
  if (where === 'global:default') return '全局默认模型'
  if (where.startsWith('slot:')) {
    const key = where.slice('slot:'.length) as LlmCatalogSlotKey
    return `场景「${SLOT_ZH[key] ?? key}」`
  }
  const ws = /^workspace:([^:]+):(default|curated)$/.exec(where)
  if (ws) return `工作区「${ws[1]}」的${ws[2] === 'default' ? '默认模型' : '精选模型'}`
  return `其他位置（${where || '未注明'}）`
}

/** 引用清点 → 可读文案（去重、保持原顺序） */
export function refsText(refs: Array<{ entryId: string; where: string }>): string[] {
  const out: string[] = []
  for (const r of Array.isArray(refs) ? refs : []) {
    if (!r) continue
    const text = whereText(String(r.where ?? ''))
    if (!out.includes(text)) out.push(text)
  }
  return out
}

/** 列表顺序：curated 优先 → sortOrder（无值排后）→ 名称 → 输入顺序（保证稳定） */
export function sortEntries(entries: LlmModelEntry[]): LlmModelEntry[] {
  return asList(entries)
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      if (!!a.e.curated !== !!b.e.curated) return a.e.curated ? -1 : 1
      const ao = typeof a.e.sortOrder === 'number' && Number.isFinite(a.e.sortOrder) ? a.e.sortOrder : Number.MAX_SAFE_INTEGER
      const bo = typeof b.e.sortOrder === 'number' && Number.isFinite(b.e.sortOrder) ? b.e.sortOrder : Number.MAX_SAFE_INTEGER
      if (ao !== bo) return ao - bo
      const an = String(a.e.name ?? '')
      const bn = String(b.e.name ?? '')
      if (an !== bn) return an.localeCompare(bn, 'zh-Hans-CN')
      return a.i - b.i
    })
    .map((x) => x.e)
}

/** 选中一行后写回什么：条目模式写条目 id，旧模式写 `providerId:modelId` */
export function applyEntryPick(mode: 'spec' | 'entry', entry: LlmModelEntry): string {
  return mode === 'entry' ? entry.id : `${entry.providerId}:${entry.modelId}`
}

/* ============================== 槽位迁移计划（P3 收口 · 显式改写） ============================== */

/** 8 个场景槽位（键名与 SETTINGS 同名；顺序与 SLOT_ZH 一致） */
export const MODEL_SLOT_KEYS: LlmCatalogSlotKey[] = [
  'defaultChatModel',
  'assistantModelId',
  'aiAssistantInlineSuggestModelId',
  'aiTranslateModelId',
  'agentCompressModelId',
  'aiTeachVisionModel',
  'aiImageModel',
  'aiImageEditModel',
]

export interface SlotRewritePlan {
  slot: string
  slotLabel: string
  from: string
  to: string
  entryName: string
}

export interface SlotScanResult {
  plan: SlotRewritePlan[]
  skipped: Array<{ slot: string; reason: 'empty' | 'already-entry' | 'no-entry'; from: string }>
}

/**
 * 扫一遍槽位，得出「哪些旧 `providerId:modelId` 可以改写成条目 id」。
 *
 * 只做判断、不写任何东西 —— 写盘在组件里逐个 `setSettingRaw` 完成，
 * 这样用户能在行内确认卡里先看清「哪个槽位 → 哪个条目」再落手。
 *
 * 口径（spec 一切大小写敏感，不做任何 normalize）：
 *   · 空 → `empty`；
 *   · `m_` 开头：命中条目 = `already-entry`，找不到 = `no-entry`（**不要**猜别的条目替换）；
 *   · `pid:mid` 命中同 spec 条目 → 进 plan；未命中 = `no-entry`；
 *   · 不在 `allowed` 里的键完全不出现（不污染 skipped）。
 */
export function planSlotRewrite(input: {
  slots: Record<string, string>
  entries: Array<{ id: string; name?: string; providerId: string; modelId: string }>
  slotLabels: Record<string, string>
  allowed: string[]
}): SlotScanResult {
  const slots = (input?.slots ?? {}) as Record<string, unknown>
  const entries = Array.isArray(input?.entries) ? input.entries : []
  const labels = (input?.slotLabels ?? {}) as Record<string, string>
  const allowed = Array.isArray(input?.allowed) ? input.allowed : []

  const plan: SlotRewritePlan[] = []
  const skipped: SlotScanResult['skipped'] = []
  const seen = new Set<string>()

  for (const slot of allowed) {
    if (typeof slot !== 'string' || !slot || seen.has(slot)) continue
    seen.add(slot)

    const raw = String(slots[slot] ?? '').trim()
    const slotLabel = String(labels[slot] ?? '').trim() || slot
    if (!raw) { skipped.push({ slot, reason: 'empty', from: '' }); continue }

    const byId = entries.find((e) => !!e && e.id === raw)
    if (raw.startsWith('m_')) {
      skipped.push({ slot, reason: byId ? 'already-entry' : 'no-entry', from: raw })
      continue
    }

    const at = raw.indexOf(':')
    if (at <= 0 || at === raw.length - 1) { skipped.push({ slot, reason: 'no-entry', from: raw }); continue }
    const providerId = raw.slice(0, at)
    const modelId = raw.slice(at + 1)
    const hit = entries.find((e) => !!e && e.providerId === providerId && e.modelId === modelId)
    if (!hit) { skipped.push({ slot, reason: 'no-entry', from: raw }); continue }

    plan.push({
      slot,
      slotLabel,
      from: raw,
      to: String(hit.id ?? ''),
      entryName: String(hit.name ?? '').trim() || String(hit.modelId ?? ''),
    })
  }

  return { plan, skipped }
}

/** 确认按钮文案：0 也要说人话，别渲染成「改写 0 个槽位」 */
export function rewriteSummary(plan: SlotRewritePlan[]): string {
  const n = Array.isArray(plan) ? plan.filter((p) => !!p && !!p.slot && !!p.to).length : 0
  return n === 0 ? '没有需要改写的槽位' : `改写 ${n} 个槽位`
}

/* ============================== 条目行展示口径（2026-11-20 重做） ============================== */

/**
 * 上下文窗口按**千 token** 展示（原型口径：128 = 128,000）。
 *
 * 为什么不四舍五入成整数：落盘的是 token 数，用户可能填过 100500。
 * 显示成 100 再保存回去会**静默改值**。所以保留小数（100500 → '100.5'），
 * 只有真正的整千才去掉小数点。
 */
export function contextWindowToK(tokens?: number | null): string {
  const n = Number(tokens)
  if (!Number.isFinite(n) || n <= 0) return ''
  return String(n / 1000)
}

/** 上下文窗口的悬停说明：未设置要说清「跟随全局判断」，不要只显示空白 */
export function contextWindowTitle(tokens?: number | null): string {
  const n = Number(tokens)
  if (!Number.isFinite(n) || n <= 0) return '未设置 · 跟随全局判断'
  return `${n.toLocaleString('en-US')} tokens`
}

export type ContextWindowParse =
  | { ok: true; tokens: number | null }
  | { ok: false; reason: string }

/** 解析千 token 输入：空 = 显式清空（tokens: null）；非正数 / 非数字 = 拒绝 */
export function parseContextWindowK(raw: string): ContextWindowParse {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: true, tokens: null }
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false, reason: '上下文窗口必须是大于 0 的数字（单位：千 token）' }
  const k = Number(text)
  if (!Number.isFinite(k) || k <= 0) return { ok: false, reason: '上下文窗口必须是大于 0 的数字（单位：千 token）' }
  // 千 token → token；保留整数（0.5K 这类小数在 token 尺度上没有意义，四舍五入到整数）
  const tokens = Math.round(k * 1000)
  if (tokens <= 0) return { ok: false, reason: '上下文窗口必须是大于 0 的数字（单位：千 token）' }
  return { ok: true, tokens }
}

/** 能力三态循环：跟随 → 支持 → 不支持 → 跟随（与既有交互一致） */
export function nextCapabilityState(cur: LlmCapabilityState): LlmCapabilityState {
  return cur === 'auto' ? 'yes' : cur === 'yes' ? 'no' : 'auto'
}

export interface CatalogTestOutcome {
  ok: boolean
  latencyMs?: number
  /** 失败原因（原样展示，不做二次包装） */
  error?: string
  /** 测完的时间点（ms）。结果只在本会话存在，不写回条目 */
  at: number
}

/** 行尾胶囊文案：成功给延迟，失败只给「失败」（详情里才展开原始错误） */
export function testPillLabel(outcome: CatalogTestOutcome | null): string {
  if (!outcome) return ''
  if (!outcome.ok) return '失败'
  const ms = Number(outcome.latencyMs)
  return Number.isFinite(ms) && ms >= 0 ? `${ms}ms` : '可用'
}

/** 「2 分钟前」——测试详情里的时间。纯函数，便于契约固定口径 */
export function testTimeText(at: number, now: number): string {
  const diff = Number(now) - Number(at)
  if (!Number.isFinite(diff) || diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/** 本地搜索右侧计数：过滤中要同时给出「命中 / 总数」，否则用户不知道是过滤了还是真没有 */
export function entriesCountText(shown: number, total: number, query: string): string {
  const s = Number.isFinite(shown) ? Math.max(0, Math.floor(shown)) : 0
  const t = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0
  return String(query ?? '').trim() ? `${s} / ${t} 条` : `${t} 条`
}
