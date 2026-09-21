/**
 * pdfReader 数据 schema（v3.4.0 PDF 阅读体验整包，方案 §3）。
 *
 * 零依赖纯函数文件 —— 刻意不 import 任何 electron / fs 模块：
 * 契约脚本 `.AGENT/scripts/pdf-reader/verify-pdf-reader.mjs` 用
 * `node --experimental-strip-types` 直接 import 本文件做用例验证，
 * 引入副作用依赖会让「import 即崩」。
 *
 * 存储：vault 级 `.knowbase/modules/pdfReader.json`（唯一写方 = pdfReaderVaultRepo.ts）：
 *   { version: 1, books: { "<rootId>/<relPath>": VaultBookState } }
 * 书键 = `{rootId}/{relPath}`（文件改名/移动丢进度——方案 §11.5 已拍板接受）。
 * 封面缓存索引 = `.knowbase/cache/covers/index.json`（cache 可删可再生，索引随目录同生共死）。
 */

import type { ScanMode } from './scanDetect'

/** scan 白名单值集（与 scanDetect.SCAN_MODES 保持同步，契约断言一致性；
 *  此处不用运行时导入——strip-types 直跑的零依赖文件里扩展名省略会 ERR_MODULE_NOT_FOUND） */
const SCAN_MODE_SET: readonly string[] = ['full', 'partial', 'no']

export type PdfViewMode = 'scroll' | 'single' | 'duo'

export interface VaultPdfBookmark {
  page: number
  note: string
  at: string
}

export interface VaultBookState {
  /** 冲突检测基准（铁律 4 三件事之一）；patch 时服务端重新生成，客户端只读 */
  updatedAt: string
  /** 续读页（竖滚时配 scrollRatio） */
  lastPage: number
  /** 总页数（0 = 未知）：阅读器首次打开该书时登记，书架侧栏进度条分母 */
  totalPages: number
  /** 竖滚模式页内滚动比例 0..1；翻页模式忽略 */
  scrollRatio: number
  mode: PdfViewMode
  /** 非适宽时的缩放 */
  zoom: number
  /** 护眼开关（书级记忆） */
  eyeCare: boolean
  bookmarks: VaultPdfBookmark[]
  /** 扫描版探测结论（缺省 = full 有文本层，不落盘）：full / partial / no */
  scan?: ScanMode
  /** 页级降级（A5）：逐页 scanned 布尔（true = 该页为扫描页/无文本层）。仅 scanMode !== 'full' 时落盘 */
  scanPages?: boolean[]
}

/** pdfReader.json 顶层（version + books） */
export interface VaultPdfReaderStore {
  version: number
  books: Record<string, VaultBookState>
}

/** patch 白名单：调用方只能改这些键；updatedAt 由服务端生成，不在白名单 */
const PATCH_KEYS: readonly string[] = ['lastPage', 'scrollRatio', 'mode', 'zoom', 'eyeCare', 'bookmarks', 'totalPages', 'scan', 'scanPages']

export const PDF_MODES: readonly PdfViewMode[] = ['scroll', 'single', 'duo']

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 书键归一：posix 分隔、去首尾空白、去开头 ./；空分量拒绝返回空串 */
export function pdfBookKey(rootId: string, relPath: string): string {
  const id = String(rootId ?? '').trim()
  let rel = String(relPath ?? '').trim().replace(/\\/g, '/')
  while (rel.startsWith('./')) rel = rel.slice(2)
  if (!id || !rel || rel.startsWith('/')) return ''
  return `${id}/${rel}`
}

/** 从书键反解 relPath（rootId 之后的全部内容，可含目录分隔） */
export function pdfKeyRel(key: string): string {
  const i = key.indexOf('/')
  return i < 0 ? '' : key.slice(i + 1)
}

function sanitizeBookmark(v: unknown): VaultPdfBookmark | null {
  if (!isRecord(v)) return null
  const page = v['page']
  const note = v['note']
  const at = v['at']
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return null
  if (typeof note !== 'string' || note.length > 2000) return null
  if (typeof at !== 'string' || !at) return null
  return { page, note, at }
}

/**
 * patch 清洗：只收白名单键、逐字段类型校验（范围越界直接拒，不静默夹取 ——
 * 静默改写会让「写进去的」和「调用方以为写进去的」不一致）。
 * 返回 null = patch 非法（整个拒绝，不做部分写入）。
 */
export function sanitizeBookPatch(patch: unknown): Partial<VaultBookState> | null {
  if (!isRecord(patch)) return null
  const out: Partial<VaultBookState> = {}
  let touched = false
  for (const k of Object.keys(patch)) {
    if (!PATCH_KEYS.includes(k)) continue
    const v = patch[k]
    if (k === 'lastPage') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100000) return null
      out.lastPage = v
    } else if (k === 'totalPages') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100000) return null
      out.totalPages = v
    } else if (k === 'scrollRatio') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return null
      out.scrollRatio = v
    } else if (k === 'mode') {
      if (typeof v !== 'string' || !PDF_MODES.includes(v as PdfViewMode)) return null
      out.mode = v as PdfViewMode
    } else if (k === 'zoom') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0.25 || v > 5) return null
      out.zoom = v
    } else if (k === 'eyeCare') {
      if (typeof v !== 'boolean') return null
      out.eyeCare = v
    } else if (k === 'scan') {
      if (typeof v !== 'string' || !SCAN_MODE_SET.includes(v)) return null
      out.scan = v as ScanMode
    } else if (k === 'scanPages') {
      if (!Array.isArray(v) || v.length > 2000) return null
      if (!v.every((b) => typeof b === 'boolean')) return null
      out.scanPages = v as boolean[]
    } else if (k === 'bookmarks') {
      if (!Array.isArray(v) || v.length > 500) return null
      const list: VaultPdfBookmark[] = []
      for (const b of v) {
        const bm = sanitizeBookmark(b)
        if (!bm) return null
        list.push(bm)
      }
      out.bookmarks = list
    }
    touched = true
  }
  return touched ? out : null
}

/** 存量/新键的完整书状态（新键用默认值：竖滚 + 适宽 + 无书签） */
export function defaultBookState(now: string): VaultBookState {
  return { updatedAt: now, lastPage: 1, totalPages: 0, scrollRatio: 0, mode: 'scroll', zoom: 1, eyeCare: false, bookmarks: [] }
}

/** 存量数据修补：缺键补默认（老版本 / 半写容错），非法值回落默认不抛错 */
export function coerceBookState(raw: unknown, now: string): VaultBookState {
  const base = defaultBookState(now)
  if (!isRecord(raw)) return base
  const mode = typeof raw['mode'] === 'string' && PDF_MODES.includes(raw['mode'] as PdfViewMode) ? (raw['mode'] as PdfViewMode) : 'scroll'
  const lastPage = typeof raw['lastPage'] === 'number' && Number.isInteger(raw['lastPage']) && raw['lastPage'] >= 1 ? raw['lastPage'] : 1
  const totalPages = typeof raw['totalPages'] === 'number' && Number.isInteger(raw['totalPages']) && raw['totalPages'] >= 1 ? raw['totalPages'] : 0
  const scrollRatio = typeof raw['scrollRatio'] === 'number' && Number.isFinite(raw['scrollRatio']) ? Math.min(1, Math.max(0, raw['scrollRatio'])) : 0
  const zoom = typeof raw['zoom'] === 'number' && Number.isFinite(raw['zoom']) ? Math.min(5, Math.max(0.25, raw['zoom'])) : 1
  const bookmarks = Array.isArray(raw['bookmarks'])
    ? (raw['bookmarks'].map(sanitizeBookmark).filter((b): b is VaultPdfBookmark => !!b))
    : []
  const updatedAt = typeof raw['updatedAt'] === 'string' && raw['updatedAt'] ? raw['updatedAt'] : now
  const scan = typeof raw['scan'] === 'string' && SCAN_MODE_SET.includes(raw['scan']) ? (raw['scan'] as ScanMode) : undefined
  const scanPages = Array.isArray(raw['scanPages']) && raw['scanPages'].every((b) => typeof b === 'boolean')
    ? (raw['scanPages'] as boolean[])
    : undefined
  return { updatedAt, lastPage, totalPages, scrollRatio, mode, zoom, eyeCare: raw['eyeCare'] === true, bookmarks, ...(scan ? { scan } : {}), ...(scanPages ? { scanPages } : {}) }
}

/** 封面索引单条 */
export interface VaultCoverIndexEntry {
  /** 渲染封面时 PDF 文件的 mtimeMs —— 失效判据（方案 §3） */
  mtimeMs: number
  /** 缓存文件名（<sha1>.png），位于 .knowbase/cache/covers/ 下 */
  file: string
}
