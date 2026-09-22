/**
 * readerState 数据 schema（书架升级全格式阅读器一期，方案 §S2.1）。
 *
 * 零依赖纯函数文件 —— 刻意不 import 任何 electron / fs 模块，且**不得出现值导入**
 * （`bookFormats` 只能 `import type`）：契约脚本 `.AGENT/scripts/pdf-reader/verify-reader-formats.mjs`
 * 与 `verify-epub-formats.mjs` 用 `node --experimental-strip-types` 直接 import 本文件做用例验证，
 * 而 node 的 TS 擦除**不做 TS 式无扩展名解析**（值导入 `./bookFormats` 会当场炸）。
 * → 故 `BOOK_KINDS` 是手工镜像，由契约脚本断言与 `bookFormats.BOOK_EXTS` 双向一致。
 *
 * 存储：vault 级 `.knowbase/modules/readerState.json`（唯一写方 = readerStateVaultRepo.ts）：
 *   { version: 1, books: { "<rootId>/<relPath>": VaultReaderState } }
 * 书键口径与 pdfBookKey 完全一致（`{rootId}/{relPath}`，posix 化 / 拒空 / 拒绝对路径）。
 *
 * ★ kind 是「relPath 的纯函数」（bookKindOf），故**不在 patch 白名单里** —— 客户端报什么都不算，
 *   由 repo 侧按 relPath 推导后覆盖写入（见 readerStateVaultRepo）。这样新格式首写不会再落成
 *   'txt' 被 TXT 阅读器永久误认，也顺带自愈历史脏值。
 */

import type { BookKind } from './bookFormats'

/** 合法 kind 集合（真源 = bookFormats 的 `BookKind`；此处手工镜像，契约脚本断言双向一致） */
export const BOOK_KINDS: readonly BookKind[] = ['pdf', 'txt', 'epub', 'fb2', 'fbz', 'cbz']

function isBookKind(v: unknown): v is BookKind {
  return typeof v === 'string' && (BOOK_KINDS as readonly string[]).includes(v)
}

/** TXT 书签（段落级定位；与 PDF 书签的 page 不同源、不同结构，互不混用） */
export interface TxtBookmark {
  /** 书签 id（uuid） */
  id: string
  /** 目标段落序号（与正文 <p data-p> 对齐） */
  paraIndex: number
  /** 段内字符偏移 [start, end)，可选（精确回跳） */
  start?: number
  end?: number
  /** 书签显示名（默认取段首若干字） */
  label: string
  /** 创建时间 ISO */
  at: string
}

/** 纸色（书级记忆；档位与色值对齐 PDF 的 eyeCare，避免两套观感） */
export type ReaderPaper = 'default' | 'sepia' | 'green' | 'dark'

export interface VaultReaderState {
  kind: BookKind
  /** 阅读进度 0..100 整数（A1 起改为「已加载字节 / 文件总字节」；epub 走 foliate 的 fraction） */
  pct: number
  /** 冲突检测基准（铁律 4 三件事之一）；patch 时服务端重新生成，客户端只读 */
  updatedAt: string
  /** ★ 精确回跳载体（B 段引入）：epub 系存 foliate 的 CFI 串。
   *  与 `pct` 是**双轨**关系、刻意不合并：pct 只够画进度条（书架/右栏的 hasProgress 与分母），
   *  回到原位要 CFI。PDF 仍用 pdfReader.json 的 lastPage、TXT 仍用书签的 paraIndex，
   *  两者保持原载体不迁移（迁移面大于收益，方案 §1.3 允许「保留双轨并注明」）。 */
  locator?: string
  /** TXT 书签（A2；仅 txt 使用，PDF 书签在 pdfReader.json） */
  bookmarks?: TxtBookmark[]
  /** 字号缩放（A4 书级；1 = 基准，0.5..3） */
  fontScale?: number
  /** 纸色（A4 书级；default/sepia/green/dark） */
  paper?: ReaderPaper
}

/** readerState.json 顶层（version + books） */
export interface VaultReaderStateStore {
  version: number
  books: Record<string, VaultReaderState>
}

/** locator 长度上限（foliate CFI 实测几百字符；留足富余但拒超长串） */
const MAX_LOCATOR_LEN = 2000

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 书键归一：posix 分隔、去首尾空白、去开头 ./；空分量拒绝返回空串（同 pdfBookKey 口径） */
export function readerKey(rootId: string, relPath: string): string {
  const id = String(rootId ?? '').trim()
  let rel = String(relPath ?? '').trim().replace(/\\/g, '/')
  while (rel.startsWith('./')) rel = rel.slice(2)
  if (!id || !rel || rel.startsWith('/')) return ''
  return `${id}/${rel}`
}

/** 从书键反解 relPath（rootId 之后的全部内容，可含目录分隔） */
export function readerKeyRel(key: string): string {
  const i = key.indexOf('/')
  return i < 0 ? '' : key.slice(i + 1)
}

function sanitizeTxtBookmark(v: unknown): TxtBookmark | null {
  if (!isRecord(v)) return null
  const id = v['id']
  const paraIndex = v['paraIndex']
  const label = v['label']
  const at = v['at']
  if (typeof id !== 'string' || !id) return null
  if (typeof paraIndex !== 'number' || !Number.isInteger(paraIndex) || paraIndex < 0) return null
  if (typeof label !== 'string' || label.length > 2000) return null
  if (typeof at !== 'string' || !at) return null
  const start = v['start']
  const end = v['end']
  let s: number | undefined
  let e: number | undefined
  if (start !== undefined) {
    if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) return null
    s = start
  }
  if (end !== undefined) {
    if (typeof end !== 'number' || !Number.isFinite(end) || end < 0) return null
    e = end
  }
  return { id, paraIndex, label, at, ...(s !== undefined ? { start: s } : {}), ...(e !== undefined ? { end: e } : {}) }
}

/** 合法 locator：非空字符串、无控制字符、长度受限（CFI 里只有可打印字符） */
function sanitizeLocator(v: unknown): string | null {
  if (typeof v !== 'string') return null
  if (!v || v.length > MAX_LOCATOR_LEN) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return null
  return v
}

/** patch 白名单：pct / bookmarks / fontScale / paper / locator（范围越界直接拒，不静默夹取） */
export function sanitizeReaderPatch(patch: unknown): Partial<VaultReaderState> | null {
  if (!isRecord(patch)) return null
  const out: Partial<VaultReaderState> = {}
  let touched = false
  for (const k of Object.keys(patch)) {
    const v = patch[k]
    if (k === 'pct') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100) return null
      out.pct = v
    } else if (k === 'bookmarks') {
      if (!Array.isArray(v) || v.length > 500) return null
      const list: TxtBookmark[] = []
      for (const b of v) {
        const bm = sanitizeTxtBookmark(b)
        if (!bm) return null
        list.push(bm)
      }
      out.bookmarks = list
    } else if (k === 'fontScale') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0.5 || v > 3) return null
      out.fontScale = v
    } else if (k === 'paper') {
      if (typeof v !== 'string' || !['default', 'sepia', 'green', 'dark'].includes(v)) return null
      out.paper = v as ReaderPaper
    } else if (k === 'locator') {
      const loc = sanitizeLocator(v)
      if (loc === null) return null
      out.locator = loc
    } else {
      continue // 未知键忽略（不整单拒绝；kind 走此路 —— 它不是客户端可写的字段）
    }
    touched = true
  }
  return touched ? out : null
}

/**
 * 存量/新键的完整书状态：pct 夹取 0..100、坏 locator 丢弃。
 * `deriveKind` = 由 relPath 推导出的 kind（repo 侧传入），传了就**以它为准**（自愈历史脏值）；
 * 不传则读存量 kind、非法回落 'txt'。
 */
export function coerceReaderState(raw: unknown, now: string, deriveKind?: BookKind): VaultReaderState {
  if (!isRecord(raw)) return { kind: deriveKind ?? 'txt', pct: 0, updatedAt: now }
  const kind = deriveKind ?? (isBookKind(raw['kind']) ? raw['kind'] : 'txt')
  const pct = typeof raw['pct'] === 'number' && Number.isFinite(raw['pct']) ? Math.min(100, Math.max(0, Math.round(raw['pct']))) : 0
  const updatedAt = typeof raw['updatedAt'] === 'string' && raw['updatedAt'] ? raw['updatedAt'] : now
  const locator = sanitizeLocator(raw['locator'])
  const bookmarks = Array.isArray(raw['bookmarks'])
    ? (raw['bookmarks'].map(sanitizeTxtBookmark).filter((b): b is TxtBookmark => !!b))
    : []
  const fontScale = typeof raw['fontScale'] === 'number' && Number.isFinite(raw['fontScale']) ? Math.min(3, Math.max(0.5, raw['fontScale'])) : 1
  const paper = (raw['paper'] === 'sepia' || raw['paper'] === 'green' || raw['paper'] === 'dark') ? (raw['paper'] as ReaderPaper) : 'default'
  return { kind, pct, updatedAt, ...(locator !== null ? { locator } : {}), bookmarks, fontScale, paper }
}

/** 新键默认状态；kind 由调用方传入（repo 侧按 relPath 推导）—— 缺省 'txt' 兼容一期调用 */
export function defaultReaderState(now: string, kind: BookKind = 'txt'): VaultReaderState {
  return { kind, pct: 0, updatedAt: now, bookmarks: [], fontScale: 1, paper: 'default' }
}
