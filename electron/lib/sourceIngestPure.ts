/**
 * AI 教学重构 · 素材解析（P0 契约面，纯函数、零运行时依赖）
 *
 * 维护方：素材解析线。集成方与其他并行开发线**只读**本文件（AGENTS.md 铁律 21：
 * 同一文件禁止并行编辑）；要改语义先改契约脚本 `.AGENT/scripts/ai-teaching/verify-source-ingest.mjs`
 * 的用例表，再回来改实现。
 *
 * 只放四类东西，对应的落盘契约见方案
 * `/home/lousync/Projects/DesginProcess/Phrontis/已实现设计文档/Phrontis-AI教学-技术方案-2026-11-19.md`：
 *   · §2.2 `sources.json` v2 —— 素材登记与 `ingest.status`；
 *   · §2.3 解析缓存 —— `<cacheRoot>/parse/<contentHash>/<engineSig>/`；
 *   · §4.1 素材 IPC —— `material.read` 的 `offset / maxChars / anchor` 切片语义；
 *   · §9 契约脚本 —— 本文件被 `verify-source-ingest.mjs` strip 类型后直接 import。
 *
 * 硬约束：**不 import 任何运行时模块**（fs / path / electron / npm 包一律禁止），
 * 路径一律正斜杠字符串拼装；不用 enum / namespace / 装饰器 / 参数属性
 * （`stripTypeScriptTypes` 只认可擦除语法）。类型只以 `import type` 引入，strip 后完全消失。
 *
 * 错误策略：只有「会让缓存目录撞车 / 读到别的引擎结果」的两处（`cacheKeyFor` 空段、
 * `engineSignature` 缺 id 或 version）显式抛错 —— 静默兜底值比崩溃更危险。
 * 其余输入（脏 JSON、越界 offset、坏页标记）一律**返回可用值，不抛错**。
 */

import type {
  IngestStatus,
  SourceAnchor,
  SourceBlock,
  SourcePage,
  SourceStructure,
  TextLayer,
} from './aiTeachingTypesPure'

/** `material.read` 单次返回字符数缺省值（方案 §4.1） */
export const DEFAULT_SLICE_MAX_CHARS = 12_000
/** 单次返回字符数硬上限（防模型传 10^9 把主进程卡住） */
export const MAX_SLICE_MAX_CHARS = 400_000
/** 缓存键单段长度上限（两层目录，Windows 路径总长受限） */
export const MAX_KEY_SEGMENT_CHARS = 160

/* ============================== 键与路径 ============================== */

/** 允许原样进入目录名的字符：字母 / 数字（含中文）/ 点 / 下划线 / 连字符 */
const SEGMENT_SAFE_CHAR_RE = /[\p{L}\p{N}._-]/u
/** Windows 保留设备名，做目录名会被系统拒绝或行为异常 */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * 不安全字符按码位转义（`/` → `%002F`），**不做等价替换**：
 * 若把 `a/b` 和 `a:b` 都替换成 `a-b`，两个不同引擎签名会落到同一个缓存目录，
 * 表现为「换了引擎却读到旧解析结果」且无任何报错。转义保持一一对应。
 */
function escapeSegment(raw: string): string {
  let out = ''
  for (const ch of raw) {
    if (SEGMENT_SAFE_CHAR_RE.test(ch)) {
      out += ch
      continue
    }
    const cp = ch.codePointAt(0)
    out += '%' + (cp === undefined ? '003F' : cp.toString(16).toUpperCase().padStart(4, '0'))
  }
  return out
}

/**
 * 单段归零：去首尾空白；非法字符码位转义；`..`（以及开头 / 结尾的点）也转义，
 * 保证输出里既无路径分隔符也无 `..` 穿越片段。全空白 → 空串（由调用方决定是否报错）。
 */
function sanitizeSegment(raw: unknown): string {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return ''
  const escaped = escapeSegment(trimmed)
    .replace(/\.{2,}/g, (run) => run.replace(/\./g, '%002E'))
    .replace(/^\.+/, (run) => run.replace(/\./g, '%002E'))
    .replace(/\.+$/, (run) => run.replace(/\./g, '%002E'))
  const capped = escaped.slice(0, MAX_KEY_SEGMENT_CHARS)
  return WINDOWS_RESERVED_RE.test(capped) ? `_${capped}` : capped
}

/**
 * 解析缓存键：`<contentHash>/<engineSig>`（方案 §2.3，`PARSE_CACHE_VERSION` 同源）。
 * 两段都必须非空 —— 空段会让所有素材挤进同一个目录，宁可立刻抛错。
 */
export function cacheKeyFor(contentHash: string, engineSig: string): string {
  const hash = sanitizeSegment(contentHash)
  const sig = sanitizeSegment(engineSig)
  if (!hash) throw new Error('cacheKeyFor: contentHash 不能为空')
  if (!sig) throw new Error('cacheKeyFor: engineSig 不能为空')
  return `${hash}/${sig}`
}

function toForwardSlash(raw: string): string {
  return String(raw).replace(/\\/g, '/').replace(/\/{2,}/g, '/')
}

/** 去尾部斜杠，但保留 `C:/` 与 `/` 这种根形式 */
function trimTrailingSlash(forward: string): string {
  if (forward === '/' || /^[A-Za-z]:\/$/.test(forward)) return forward
  return forward.replace(/\/+$/, '')
}

function appendSeg(base: string, seg: string): string {
  return base.endsWith('/') ? `${base}${seg}` : `${base}/${seg}`
}

/**
 * 解析缓存根（方案 §2.3）：设置项 `aiTeaching.parseCacheDir` 非空则用它，
 * 否则跟随课程目录 `<课程>/.cache`。统一正斜杠、去掉重复与尾部斜杠。
 * 两者都为空 = 调用方漏传课程目录，抛错（否则会静默写到进程 cwd）。
 */
export function cacheRootFor(configured: string | null | undefined, courseDirAbs: string): string {
  const cfg = typeof configured === 'string' && configured.trim() ? trimTrailingSlash(toForwardSlash(configured.trim())) : ''
  if (cfg) return cfg
  const course = typeof courseDirAbs === 'string' && courseDirAbs.trim()
    ? trimTrailingSlash(toForwardSlash(courseDirAbs.trim()))
    : ''
  if (!course) throw new Error('cacheRootFor: configured 与 courseDirAbs 不能同时为空')
  return appendSeg(course, '.cache')
}

/* ============================== 状态机 ============================== */

/** 解析状态事件（方案 §4.1 `aiTeach:material:ingest` 的进度信号） */
export type IngestEvent = 'index' | 'queue' | 'start' | 'chunk' | 'done' | 'fail' | 'stale' | 'ocr'

const INGEST_STATUSES: readonly string[] = ['indexed', 'queued', 'parsing', 'ready', 'partial', 'failed', 'stale']
const INGEST_EVENTS: readonly string[] = ['index', 'queue', 'start', 'chunk', 'done', 'fail', 'stale', 'ocr']

/**
 * 合法迁移表。**不在表里的 (prev, event) 一律「拒绝」：返回原状态，不抛错、不记日志**
 * （纯函数不碰 I/O；调用方若需要审计，自己比对返回值与 prev）。
 *
 * 语义取舍（与方案 §2.2 的 `partial` / A8 `needsOcr` 对齐）：
 * · `index` 是「重新登记」：从任何状态都回到 indexed，用来丢弃旧解析结果；
 * · `start` 只从 indexed / queued / partial / failed / stale 出发 —— **`ready -> parsing` 非法**，
 *   已解析好的素材必须显式先 `queue`（或 `index`）才会重跑；
 * · `chunk` 只在 parsing 内自环，其他状态收到进度事件视为乱序丢弃；
 * · `ocr` 表示「存在需视觉转写的页」，落到 partial，且 **partial 有粘性**：
 *   `partial + done` 仍是 partial，否则「先 ocr 后 done」会把待转写事实抹掉；
 *   回到 ready 的唯一路径是重新解析（`partial -> start -> parsing -> done`）。
 */
const TRANSITIONS: Record<IngestStatus, Partial<Record<IngestEvent, IngestStatus>>> = {
  indexed: { index: 'indexed', queue: 'queued', start: 'parsing', fail: 'failed', stale: 'stale' },
  queued: { index: 'indexed', queue: 'queued', start: 'parsing', fail: 'failed', stale: 'stale' },
  parsing: { index: 'indexed', chunk: 'parsing', done: 'ready', ocr: 'partial', fail: 'failed', stale: 'stale' },
  ready: { index: 'indexed', queue: 'queued', done: 'ready', ocr: 'partial', fail: 'failed', stale: 'stale' },
  partial: {
    index: 'indexed', queue: 'queued', start: 'parsing',
    done: 'partial', ocr: 'partial', fail: 'failed', stale: 'stale',
  },
  failed: { index: 'indexed', queue: 'queued', start: 'parsing', fail: 'failed', stale: 'stale' },
  stale: { index: 'indexed', queue: 'queued', start: 'parsing', fail: 'failed', stale: 'stale' },
}

function isIngestStatus(v: unknown): v is IngestStatus {
  return typeof v === 'string' && INGEST_STATUSES.includes(v)
}

function isIngestEvent(v: unknown): v is IngestEvent {
  return typeof v === 'string' && INGEST_EVENTS.includes(v)
}

/**
 * 状态机推进。非法迁移返回 `prev`（原状态）；`prev` 本身不是合法状态时按 `indexed` 起算
 * （脏数据不能让整条素材线卡死）；未知事件同样返回原状态。
 */
export function nextIngestStatus(prev: IngestStatus, event: IngestEvent): IngestStatus {
  const from: IngestStatus = isIngestStatus(prev) ? prev : 'indexed'
  if (!isIngestEvent(event)) return from
  return TRANSITIONS[from][event] ?? from
}

/* ============================== 文本层判定 ============================== */

/**
 * 文本层判定（方案 §2.2 `textLayer` + A8）：整篇没字 -> empty；
 * 有任何空页 -> partial（`emptyPages` 里的页进 `needsOcr`）；否则 text。
 * `emptyPages` 先清洗（去重、丢非正整数、超出 `pages` 的丢弃），且不修改入参数组。
 */
export function classifyTextLayer(input: { pages: number; emptyPages: number[]; chars: number }): TextLayer {
  const chars = typeof input?.chars === 'number' && Number.isFinite(input.chars) ? input.chars : 0
  const pagesRaw = typeof input?.pages === 'number' && Number.isFinite(input.pages) ? Math.floor(input.pages) : 0
  const pages = pagesRaw > 0 ? pagesRaw : 0
  if (!(chars > 0)) return 'empty'
  if (pages === 0) return 'text'
  const seen = new Set<number>()
  const rawEmpty = Array.isArray(input?.emptyPages) ? input.emptyPages : []
  for (const item of rawEmpty) {
    if (typeof item !== 'number' || !Number.isFinite(item)) continue
    const n = Math.floor(item)
    if (n < 1 || n > pages) continue
    seen.add(n)
  }
  if (seen.size >= pages) return 'empty'
  return seen.size > 0 ? 'partial' : 'text'
}

/* ============================== 页标记与切片 ============================== */

export interface SourcePageMarker {
  n: number
  startChar: number
  endChar: number
}

/**
 * 拆 `<!-- page N -->` 标记（方案 §2.3 `content.md` 的分页约定）。
 *
 * · `N < 1` 的标记忽略（页码从 1 起，0 是脏数据）；
 * · 大小写不敏感、标记内空白随意，CRLF 不影响（正则按字节扫，不按行）；
 * · **重复页码只认第一次出现的标记**，其区间延伸到下一个「新页码」标记之前 ——
 *   即重复标记之后的内容并入首次区域（不丢正文，重复标记的原始注释留在正文里）；
 * · 无标记返回空数组；结尾标记之后无正文时该页区间退化为零长度。
 *
 * `startChar` 是标记注释**之后**的位置，`endChar` 是下一个标记注释**之前**的位置，
 * 因此 `content.slice(startChar, endChar)` 不含标记本身。
 */
export function splitPageMarkers(content: string): SourcePageMarker[] {
  const text = typeof content === 'string' ? content : ''
  const re = /<!--\s*page\s+(\d+)\s*-->/gi
  const found: Array<{ n: number; tagStart: number; bodyStart: number }> = []
  let m: RegExpExecArray | null = re.exec(text)
  while (m) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n >= 1) {
      found.push({ n: Math.floor(n), tagStart: m.index, bodyStart: m.index + m[0].length })
    }
    m = re.exec(text)
  }
  const kept: Array<{ n: number; tagStart: number; bodyStart: number }> = []
  const seen = new Set<number>()
  for (const item of found) {
    if (seen.has(item.n)) continue
    seen.add(item.n)
    kept.push(item)
  }
  return kept.map((item, i) => ({
    n: item.n,
    startChar: item.bodyStart,
    endChar: i + 1 < kept.length ? kept[i + 1].tagStart : text.length,
  }))
}

function toFiniteInt(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.floor(v) : null
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? Math.floor(n) : null
  }
  return null
}

function clampInt(v: number, min: number, max: number): number {
  if (v < min) return min
  if (v > max) return max
  return v
}

function resolveMaxChars(raw: unknown): number {
  const n = toFiniteInt(raw)
  if (n === null || n < 1) return DEFAULT_SLICE_MAX_CHARS
  return Math.min(n, MAX_SLICE_MAX_CHARS)
}

/**
 * 素材正文切片（方案 §4.1 `material.read`）。
 *
 * · `anchor.kind === 'page'`：按页标记取区间 —— `from` 缺省取 `to`、再缺省取第一页；
 *   找不到 `from` 页（含整篇无标记）时**退化为整篇**；`to` 按「文档顺序里最后一个 n <= to 的页」
 *   收敛，`to` 超过末页即读到文末；`endChar` 是下一页标记之前，不会把标记带进正文。
 * · 其他锚点（chapter / heading / char / sheet）**不在这里解释**：上游先把书签解析成
 *   `offset`（或 page 锚点）再传入，避免两套定位逻辑漂移。
 * · 多页区间（`from` < `to`）**保留区间内部的 `<!-- page N -->` 标记**：正文格式本身就用它
 *   分隔页，切掉会破坏 `nextOffset` 与字符偏移的一致性（标记也是正文字符）。区间两侧的标记仍被切掉。
 * · `offset` 是相对**切片起点**（整篇或页区间起点）的字符偏移，负数 / NaN 按 0，
 *   超过区间长度按区间末尾（返回空串，`hasMore=false`）。
 * · 返回的 `nextOffset` 恒等于「已消费的相对偏移」= `offset + 本次返回长度`，
 *   配合同一个 anchor 反复调用即可分页读到底；`totalChars` 恒为整篇字符数（不随锚点变）。
 */
export function sliceContent(
  content: string,
  opts: { anchor?: SourceAnchor; offset?: number; maxChars?: number } = {},
): { content: string; nextOffset: number; hasMore: boolean; totalChars: number } {
  const text = typeof content === 'string' ? content : ''
  const totalChars = text.length
  const maxChars = resolveMaxChars(opts?.maxChars)
  const anchor = opts?.anchor
  let regionStart = 0
  let regionEnd = totalChars

  if (anchor && anchor.kind === 'page') {
    const markers = splitPageMarkers(text)
    if (markers.length) {
      const fromRaw = toFiniteInt(anchor.from)
      const toRaw = toFiniteInt(anchor.to)
      const from = fromRaw !== null && fromRaw >= 1 ? fromRaw : null
      const to = toRaw !== null && toRaw >= 1 ? toRaw : null
      let startIdx = -1
      if (from !== null) startIdx = markers.findIndex((x) => x.n === from)
      else if (to !== null) startIdx = markers.findIndex((x) => x.n === to)
      if (startIdx < 0 && from === null) startIdx = 0
      if (startIdx >= 0) {
        const limit = to !== null ? to : markers[startIdx].n
        let endIdx = startIdx
        for (let i = startIdx; i < markers.length; i++) {
          if (markers[i].n <= limit) endIdx = i
        }
        regionStart = markers[startIdx].startChar
        regionEnd = markers[endIdx].endChar
      }
    }
  }

  const regionLen = Math.max(0, regionEnd - regionStart)
  const rawOffset = toFiniteInt(opts?.offset)
  const offset = clampInt(rawOffset === null ? 0 : rawOffset, 0, regionLen)
  const start = regionStart + offset
  const end = Math.min(start + maxChars, regionEnd)
  const slice = text.slice(start, end)
  return {
    content: slice,
    nextOffset: offset + slice.length,
    hasMore: end < regionEnd,
    totalChars,
  }
}

/* ============================== 结构归一 ============================== */

const BLOCK_TYPES: readonly string[] = ['h', 'p', 'li', 'table', 'code', 'img']

function isBlockType(v: string): v is SourceBlock['t'] {
  return BLOCK_TYPES.includes(v)
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/**
 * `structure.json` 容错归一（方案 §2.3）。
 *
 * 坏输入（null / 非对象 / pages 不是数组）→ 空结构；坏页 / 坏块 / 坏资源**逐条丢弃**，不抛错。
 * 页码 `n` **一律按位置重排为 1..N**（方案要求；引擎给的原页码只用于 `page` 字段）。
 * 字符区间：保留合法的单调递进区间，非法（非整数、负、start > end、与上一页重叠）
 * 的页重算为零长度区间（`cursor..cursor`），保证 `startChar/endChar` 不倒退、不为负。
 * 资源 `id` 去重（保留第一条），`path` 统一正斜杠。
 */
export function normalizeStructure(raw: unknown): SourceStructure {
  const root = asRecord(raw)
  const pages: SourcePage[] = []
  const rawPages = root && Array.isArray(root.pages) ? root.pages : []
  let cursor = 0

  for (const item of rawPages) {
    const rec = asRecord(item)
    if (!rec) continue
    const blocks: SourceBlock[] = []
    const rawBlocks = Array.isArray(rec.blocks) ? rec.blocks : []
    for (const rawBlock of rawBlocks) {
      const br = asRecord(rawBlock)
      if (!br) continue
      const t = typeof br.t === 'string' ? br.t.trim().toLowerCase() : ''
      if (!isBlockType(t)) continue
      const block: SourceBlock = { t }
      if (typeof br.text === 'string') block.text = br.text
      else if (typeof br.text === 'number' && Number.isFinite(br.text)) block.text = String(br.text)
      const blockPage = toFiniteInt(br.page)
      if (blockPage !== null && blockPage >= 1) block.page = blockPage
      if (typeof br.assetId === 'string' && br.assetId.trim()) block.assetId = br.assetId.trim()
      blocks.push(block)
    }

    const startRaw = toFiniteInt(rec.startChar)
    const endRaw = toFiniteInt(rec.endChar)
    let start = startRaw
    let end = endRaw
    if (start === null || end === null || start < cursor || end < start) {
      start = cursor
      end = cursor
    }
    pages.push({ n: pages.length + 1, startChar: start, endChar: end, blocks })
    cursor = end
  }

  const assets: SourceStructure['assets'] = []
  const seenAssets = new Set<string>()
  const rawAssets = root && Array.isArray(root.assets) ? root.assets : []
  for (const item of rawAssets) {
    const ar = asRecord(item)
    if (!ar) continue
    const id = typeof ar.id === 'string' ? ar.id.trim() : ''
    const rawPath = typeof ar.path === 'string' ? ar.path.trim() : ''
    if (!id || !rawPath || seenAssets.has(id)) continue
    seenAssets.add(id)
    const asset: SourceStructure['assets'][number] = { id, path: toForwardSlash(rawPath) }
    const assetPage = toFiniteInt(ar.page)
    if (assetPage !== null && assetPage >= 1) asset.page = assetPage
    assets.push(asset)
  }

  return { v: 1, pages, assets }
}

/* ============================== 引擎签名 ============================== */

/**
 * 引擎签名（方案 §2.3 缓存键第二段）：`id@version` + 按键名排序的 `params`。
 *
 * 结果只取决于内容，不取决于 `Object.keys` 的枚举顺序 —— 否则同一引擎两次注册
 * 会得到两个缓存目录（重复解析 + 缓存永不命中）。键值都经 `encodeURIComponent`，
 * 避免 `a=b&c` 这类值制造格式歧义。缺 `id` / `version` 直接抛错：静默补默认值
 * 会让不同引擎共用缓存。
 */
export function engineSignature(parts: {
  id: string
  version: string
  params?: Record<string, string | number | boolean>
}): string {
  const id = String(parts?.id ?? '').trim()
  const version = String(parts?.version ?? '').trim()
  if (!id) throw new Error('engineSignature: id 不能为空')
  if (!version) throw new Error('engineSignature: version 不能为空')
  const head = `${id}@${version}`
  const params = parts?.params
  if (!params || typeof params !== 'object') return head
  const rendered: string[] = []
  for (const key of Object.keys(params).sort()) {
    const value = params[key]
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    rendered.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return rendered.length ? `${head}|${rendered.join('&')}` : head
}
