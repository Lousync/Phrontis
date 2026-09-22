import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getCurrentVault } from './vaultContext'
import { scanVaultBooks } from './knowledgeIndex'
import { bookMetaKey, coerceBookMeta, emptyBookMeta, isSafeCoverRel, pruneOrphanMeta, sanitizeBookMetaPatch,
  BOOKS_COVERS_DIR, BOOKS_DIR, BOOKS_META_FILE, MAX_COVER_BYTES,
  type BookMetaEntry, type BookMetaStore,
} from './bookMarketSchema'

/**
 * 书籍元数据 vault 仓库（书市方案 §2.2 / §4.4）—— `.books/.meta.json` **唯一写方**。
 *
 * ★ 为什么不走 jsonStore：jsonStore 的域是 `.knowbase/<module>/<key>`，而书籍与书同在
 *   `.books/`（用户可拷、可整理的地方），元数据必须跟着书走 —— 换电脑只拷 vault 时
 *   两者一起过去，落进 `.knowbase/` 反而会把「书 + 书的说明」拆到两个地方。
 *   所以这里照 secretStore 的做法**直接 fs + 原子写**（临时文件 + rename + 损坏备份）。
 *
 * 键口径 = relPath（相对仓库根、posix 分隔），与 `scanVaultBooks()` 完全一致 ——
 * 书架 join 元数据靠这个键，两边飘一点就是「书在但显示不出书名」。
 * 纯校验逻辑在 bookMarketSchema.ts（零依赖，契约脚本直接 import）。
 */

export interface BookMetaResult {
  ok: boolean
  entry?: BookMetaEntry
  error?: string
}

export function bookMetaFileAbsPath(): string | null {
  const cur = getCurrentVault()
  return cur ? join(cur.rootPath, BOOKS_DIR, BOOKS_META_FILE) : null
}

/** 封面目录绝对路径（懒建，见 ensureBookCoversDir） */
export function bookCoversDirAbs(): string | null {
  const cur = getCurrentVault()
  return cur ? join(cur.rootPath, BOOKS_DIR, '.covers') : null
}

export function ensureBookCoversDir(): string | null {
  const dir = bookCoversDirAbs()
  if (!dir) return null
  try {
    mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return null
  }
}

/**
 * 读全量元数据。文件缺失 → 空库；**损坏 → 备份为 `.meta.json.corrupt-<ts>` 后返回空库**。
 * 与 jsonStore 同一策略：坏数据不该让书市整个打不开。
 */
export function bookMetaReadAll(): BookMetaStore {
  const p = bookMetaFileAbsPath()
  if (!p || !existsSync(p)) return emptyBookMeta()
  try {
    return coerceBookMeta(JSON.parse(readFileSync(p, 'utf-8')))
  } catch {
    try {
      renameSync(p, `${p}.corrupt-${Date.now()}`)
    } catch {
      /* ignore */
    }
    return emptyBookMeta()
  }
}

/** 原子写；失败抛错（调用方会据此向用户汇报成功与否，静默 false 等于把失败伪装成成功） */
function writeMeta(store: BookMetaStore): void {
  const p = bookMetaFileAbsPath()
  if (!p) throw new Error('当前没有打开的仓库')
  const dir = join(p, '..')
  try {
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `.${randomUUID()}.tmp`)
    writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8')
    try {
      renameSync(tmp, p)
    } catch {
      if (existsSync(p)) unlinkSync(p)
      renameSync(tmp, p)
    }
  } catch (e) {
    throw new Error(`书籍元数据写入失败：${(e as Error).message}`)
  }
}

export function bookMetaGet(relPath: unknown): BookMetaEntry | null {
  const key = bookMetaKey(relPath)
  if (!key) return null
  return bookMetaReadAll().books[key] ?? null
}

/**
 * 新建 / 更新一条元数据。
 * - 新建必须给 `title`（没有书名的条目没有意义，schema 层也认不回来）；
 * - 更新时 `title` 缺省即保留原值；
 * - 不传 `downloadedAt` 时新建自动补当前时间（调用方不必自己算）。
 */
export function bookMetaUpsert(relPath: unknown, patch: unknown, title?: unknown): BookMetaResult {
  const key = bookMetaKey(relPath)
  if (!key) return { ok: false, error: '非法的书籍相对路径' }
  const clean = sanitizeBookMetaPatch(patch)
  if (!clean) return { ok: false, error: 'patch 必须是对象' }
  const store = bookMetaReadAll()
  const prev = store.books[key]
  const nextTitle = typeof title === 'string' && title.trim() ? title.trim() : prev?.title ?? ''
  if (!nextTitle) return { ok: false, error: '书名不能为空' }
  const now = new Date().toISOString()
  const entry: BookMetaEntry = {
    title: nextTitle,
    author: clean.author ?? prev?.author ?? '',
    coverRel: clean.coverRel ?? prev?.coverRel ?? '',
    sourceId: clean.sourceId ?? prev?.sourceId ?? '',
    sourceName: clean.sourceName ?? prev?.sourceName ?? '',
    downloadedAt: clean.downloadedAt ?? prev?.downloadedAt ?? now,
    size: clean.size ?? prev?.size ?? 0,
  }
  const books = { ...store.books, [key]: entry }
  try {
    writeMeta({ version: store.version, books })
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  return { ok: true, entry }
}

/** 删一条元数据（**不删书文件**；书文件的删法见方案 §4.4：用户在文件管理器里删，元数据自愈回收） */
export function bookMetaRemove(relPath: unknown): BookMetaResult {
  const key = bookMetaKey(relPath)
  if (!key) return { ok: false, error: '非法的书籍相对路径' }
  const store = bookMetaReadAll()
  const prev = store.books[key]
  if (!prev) return { ok: true }
  const books = { ...store.books }
  delete books[key]
  try {
    writeMeta({ version: store.version, books })
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  return { ok: true, entry: prev }
}

/**
 * 自愈式回收（方案 §4.4）：拿 `scanVaultBooks()` 的现存书籍清单过滤元数据，
 * 丢弃孤儿条目**并顺手删掉它们引用的封面**。
 * 用户在文件管理器里删书（当前唯一路径）后，残留 meta / 封面会被自动清掉 ——
 * 零新 UI、零新 IPC（所以书架不需要「删除书籍」入口）。
 */
export function bookMetaPruneOrphans(): { ok: boolean; removed: Record<string, BookMetaEntry>; error?: string } {
  const store = bookMetaReadAll()
  const existing = scanVaultBooks().map((b) => b.relPath)
  const { store: next, removed } = pruneOrphanMeta(store, existing)
  const removedCount = Object.keys(removed).length
  if (removedCount === 0) return { ok: true, removed }
  try {
    writeMeta(next)
  } catch (e) {
    return { ok: false, removed: {}, error: (e as Error).message }
  }
  // 封面文件删除失败不影响已完成的元数据回收（下次再扫时还会被清）
  for (const entry of Object.values(removed)) {
    if (entry.coverRel) bookCoverDelete(entry.coverRel)
  }
  bookCoverDeleteUnreferenced(next)
  return { ok: true, removed }
}

/** 封面绝对路径；越权引用（`..` / 不在 .covers 下）一律 null */
export function bookCoverAbsPath(coverRel: unknown): string | null {
  if (!isSafeCoverRel(coverRel)) return null
  const dir = bookCoversDirAbs()
  if (!dir) return null
  const name = String(coverRel).replace(/\\/g, '/').slice(BOOKS_COVERS_DIR.length + 1)
  if (!name || name.includes('/')) return null
  return join(dir, name)
}

/** 删一个封面文件（幂等；越权引用直接拒绝） */
export function bookCoverDelete(coverRel: unknown): boolean {
  const p = bookCoverAbsPath(coverRel)
  if (!p || !existsSync(p)) return false
  try {
    unlinkSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * 读封面字节给渲染层（`bookMarket:coverGet` 的实现，S4 拍板 ①）。
 *
 * 为什么必须新开这一条：`.books/.covers/` 里的书市封面**没有任何既有通道能读到** ——
 * PDF 封面走的是另一套（`.knowbase/covers/` 模块目录 + `coverIndex` 索引 + `pdfReader:coverGet`），
 * 两者只是长得像。路径一律经 `bookCoverAbsPath`（内含 `isSafeCoverRel`：只认 `.covers` 下
 * **单层**文件名、拒 `..` 与嵌套），**这里不另写一份路径拼接**。
 *
 * 越权引用 / 文件不存在 / 读失败 / 空文件 / 超过 `MAX_COVER_BYTES` 一律返回 `null`（不抛）——
 * 封面是**增益**，拿不到就回落纯色书卡，不该让书架整页报错。
 *
 * `rootId` 是渲染层带来的（铁律 3：渲染层不碰绝对路径，只传 `{ rootId, relPath }`）：
 * 与当前仓库不一致时同样返回 `null` —— 口径同 `pdfReaderVaultRepo` 的「rootId 与当前仓库不一致」，
 * 只是那边抛错、这边降级（理由同上：封面不该让整页报错）。
 */
export function bookCoverReadDataUrl(coverRel: unknown, rootId?: unknown): string | null {
  const cur = getCurrentVault()
  if (cur && typeof rootId === 'string' && rootId && rootId !== cur.rootId) return null
  const p = bookCoverAbsPath(coverRel)
  if (!p || !existsSync(p)) return null
  try {
    const buf = readFileSync(p)
    if (buf.length === 0 || buf.length > MAX_COVER_BYTES) return null
    // mime 由扩展名定（下载器只写 .jpg；白名单已保证扩展名形状），其余一律按 jpeg 兜底
    const ext = p.toLowerCase().endsWith('.png') ? 'png' : p.toLowerCase().endsWith('.webp') ? 'webp' : 'jpeg'
    return `data:image/${ext};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

/**
 * 删掉 `.covers/` 下**没有任何元数据引用**的封面文件，返回删除个数。
 * 目录是应用自管的，所以这里是「白名单在外、这个目录整体可清」的语义；
 * 仍然只删普通文件（symlink / 目录一律跳过）。
 */
export function bookCoverDeleteUnreferenced(store: BookMetaStore): number {
  const dir = bookCoversDirAbs()
  if (!dir || !existsSync(dir)) return 0
  const referenced = new Set<string>()
  for (const entry of Object.values(store.books)) {
    if (isSafeCoverRel(entry.coverRel)) referenced.add(String(entry.coverRel).replace(/\\/g, '/'))
  }
  let deleted = 0
  try {
    for (const name of readdirSync(dir)) {
      const rel = `${BOOKS_COVERS_DIR}/${name}`
      if (referenced.has(rel)) continue
      const full = join(dir, name)
      try {
        if (!lstatSync(full).isFile()) continue
        unlinkSync(full)
        deleted++
      } catch {
        /* 单个文件删不掉不影响其余 */
      }
    }
  } catch {
    /* 目录读不了就当没有可清的 */
  }
  return deleted
}
