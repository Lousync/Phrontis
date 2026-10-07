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

/**
 * 书签定位键 = CFI 的三种格式（= 走 foliate 引擎**且有文本层**的那些）。
 * ★ 与「引擎 = foliate」**不是同一个集合**：cbz 也走 foliate 引擎（固定版式，`fixed-layout.js`），
 *   但它整页是图片、没有文字层 ⇒ 不收书签（`sanitizeBookmark` 显式拒绝）。
 * 真源 = bookFormats 的三张表；此处手工镜像（本文件不得值导入），契约脚本断言：
 *   ① 这里每一项的引擎都是 'foliate'；② foliate 引擎里**差集恰好 = ['cbz']** ——
 *   将来多出一种 foliate 格式（或 cbz 突然能存书签）时，这条会红，逼你在两处同时做决定。 */
export const FOLIATE_KINDS: readonly BookKind[] = ['epub', 'fb2', 'fbz']

function isBookKind(v: unknown): v is BookKind {
  return typeof v === 'string' && (BOOK_KINDS as readonly string[]).includes(v)
}

function isFoliateKind(kind: BookKind): boolean {
  return (FOLIATE_KINDS as readonly string[]).includes(kind)
}

/**
 * 书签（A2 起 txt；2026-09-22 起 foliate 系共用）——
 * **一套结构 + 按 kind 分支的定位字段**，照 `VaultExcerpt` 的既有做法，不新开第二个书签字段。
 * 与 PDF 书签（`pdfReader.json` 的 page）仍然**不同源、不混用**，互不迁移。
 *
 * 定位字段谁合法由 `sanitizeBookmark` 按 kind 校验（不是「有哪个就用哪个」）：
 * - `txt`            → 必须 `paraIndex`（与正文 `<p data-p>` 对齐），`start`/`end` 可选；
 * - `epub`/`fb2`/`fbz` → 必须 `cfi`（foliate 定位串），`chapter` 可选；
 * - `pdf`（书签在 pdfReader.json）/ `cbz`（固定版式无文本层）→ **显式拒绝**，不是静默丢弃。
 */
export interface BookBookmark {
  /** 书签 id（uuid） */
  id: string
  /** txt：目标段落序号（与正文 <p data-p> 对齐） */
  paraIndex?: number
  /** txt：段内字符偏移 [start, end)，可选（精确回跳） */
  start?: number
  end?: number
  /** foliate 系：CFI 定位串（口径镜像 `excerptSchema.sanitizeCfi`，契约断言两处一致） */
  cfi?: string
  /** foliate 系：章节标签（与 `VaultExcerpt.chapter` 同名同义），可选 */
  chapter?: string
  /** 书签显示名（txt 默认取段首若干字；foliate 系给「章节 + 进度」） */
  label: string
  /** 创建时间 ISO */
  at: string
}

/** 旧名 `TxtBookmark` 已随本次改造并入 `BookBookmark`（同一份结构不许有两个名字）。
 *  存量数据无需迁移：`{id, paraIndex, label, at}` 在新形状下**原样合法**（超集）。 */

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
  /** 书签（A2 起 txt；2026-09-22 起 foliate 系共用同一字段。PDF 书签仍在 pdfReader.json） */
  bookmarks?: BookBookmark[]
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

/** CFI 长度上限（口径镜像 `excerptSchema.MAX_CFI_LEN`；契约断言两处一致 —— 本文件不得值导入） */
const MAX_CFI_LEN = 2000

/**
 * 单本书的书签条数上限（超限**整单拒绝**，与 pct 越界同款，不做静默截断）。
 * ★ 必须与两个阅读器的写入侧共用（`TxtReaderView` / `EpubReaderView` 都 import 这个常量）：
 *   否则第 501 条会被这里拒掉、而 `patchReader` 的失败是**静默**的 —— 表象就是
 *   「点了加书签，书签出现在列表里、但关书重开就没了」（本地 state 已加、盘上没写）。
 */
export const MAX_BOOKMARKS = 500

/** 合法 CFI：非空字符串、无控制字符、长度受限（与 `excerptSchema.sanitizeCfi` 逐条同款） */
function sanitizeCfi(v: unknown): string | null {
  if (typeof v !== 'string') return null
  if (!v || v.length > MAX_CFI_LEN) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return null
  return v
}

/**
 * 书签净化 —— **按 kind 分支**决定哪个定位字段合法（同 `sanitizeExcerptCreate` 的形状）。
 * kind 未知（未收录扩展名）时按 **txt 口径**校验：历史上唯一的书签写方就是 txt，
 * 这条兜底只为保住既有调用行为，不为新格式开口子。
 */
function sanitizeBookmark(v: unknown, kind: BookKind | undefined): BookBookmark | null {
  if (!isRecord(v)) return null
  const id = v['id']
  const label = v['label']
  const at = v['at']
  if (typeof id !== 'string' || !id) return null
  if (typeof label !== 'string' || label.length > 2000) return null
  if (typeof at !== 'string' || !at) return null
  const k: BookKind = kind ?? 'txt'
  if (k === 'txt') {
    const paraIndex = v['paraIndex']
    if (typeof paraIndex !== 'number' || !Number.isInteger(paraIndex) || paraIndex < 0) return null
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
  if (isFoliateKind(k)) {
    const cfi = sanitizeCfi(v['cfi'])
    if (!cfi) return null
    const chapter = v['chapter']
    const ch = typeof chapter === 'string' && chapter.trim() ? chapter.trim().slice(0, 200) : undefined
    return { id, cfi, label, at, ...(ch !== undefined ? { chapter: ch } : {}) }
  }
  // pdf（书签在 pdfReader.json）/ cbz（固定版式无文本层）与任何未列 kind：**显式拒绝**，
  // 与 excerptSchema 同款 —— 宁可这单失败，也不要静默收下一条无定位的书签。
  return null
}

/** 合法 locator：非空字符串、无控制字符、长度受限（CFI 里只有可打印字符） */
function sanitizeLocator(v: unknown): string | null {
  if (typeof v !== 'string') return null
  if (!v || v.length > MAX_LOCATOR_LEN) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return null
  return v
}

/**
 * patch 白名单：pct / bookmarks / fontScale / paper / locator（范围越界直接拒，不静默夹取）。
 * `kind` = 该书由 relPath 推出的 kind（repo 侧传入，与 kind 字段同源）——
 * 书签的定位字段合法性**依赖它**（txt 要 paraIndex、foliate 系要 cfi），故它是第二个入参；
 * 不传（kind 未知）时书签按 txt 口径校验（见 `sanitizeBookmark`）。
 */
export function sanitizeReaderPatch(patch: unknown, kind?: BookKind): Partial<VaultReaderState> | null {
  if (!isRecord(patch)) return null
  const out: Partial<VaultReaderState> = {}
  let touched = false
  for (const k of Object.keys(patch)) {
    const v = patch[k]
    if (k === 'pct') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100) return null
      out.pct = v
    } else if (k === 'bookmarks') {
      // 空数组**合法**（删掉最后一条书签就是写空数组）；超过 MAX_BOOKMARKS 整单拒
      if (!Array.isArray(v) || v.length > MAX_BOOKMARKS) return null
      const list: BookBookmark[] = []
      for (const b of v) {
        const bm = sanitizeBookmark(b, kind)
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
  // 书签按**解析出的 kind** 校验：换扩展名/被误判过的条目在这里就自然分到正确分支（无需迁移）
  const bookmarks = Array.isArray(raw['bookmarks'])
    ? (raw['bookmarks'].map((b) => sanitizeBookmark(b, kind)).filter((b): b is BookBookmark => !!b))
    : []
  const fontScale = typeof raw['fontScale'] === 'number' && Number.isFinite(raw['fontScale']) ? Math.min(3, Math.max(0.5, raw['fontScale'])) : 1
  const paper = (raw['paper'] === 'sepia' || raw['paper'] === 'green' || raw['paper'] === 'dark') ? (raw['paper'] as ReaderPaper) : 'default'
  return { kind, pct, updatedAt, ...(locator !== null ? { locator } : {}), bookmarks, fontScale, paper }
}

/** 新键默认状态；kind 由调用方传入（repo 侧按 relPath 推导）—— 缺省 'txt' 兼容一期调用 */
export function defaultReaderState(now: string, kind: BookKind = 'txt'): VaultReaderState {
  return { kind, pct: 0, updatedAt: now, bookmarks: [], fontScale: 1, paper: 'default' }
}
