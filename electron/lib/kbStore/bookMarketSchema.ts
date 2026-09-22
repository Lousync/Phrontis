/**
 * 书市 schema（方案 §2.1 / §2.2）—— **零依赖纯函数文件**。
 *
 * 刻意不 import 任何 electron / fs / 相对模块：
 * 契约脚本 `.AGENT/scripts/book-market/verify-book-sources.mjs` 用
 * `node --experimental-strip-types` 直接 import 本文件跑用例。
 * ★ 一旦这里出现运行时 import（哪怕是自己家的零依赖模块），脚本会报 Cannot find module ——
 *   要带 `.ts` 扩展名才解析得到，而 `.ts` 扩展名在 tsc 侧又得开 allowImportingTsExtensions。
 *   所以「纯 schema 文件」的判据就是：**只有类型导出 + 纯函数**。
 *
 * 落盘两处（各有唯一写方）：
 *   `.knowbase/modules/bookSources.json`  书源描述（**永不含凭据**）→ bookSourceVaultRepo.ts
 *   `.books/.meta.json`                    书籍元数据                → vaultBookMetaRepo.ts
 *   `.knowbase/secret/bookSources.json`    凭据密文（复用 secretStore）→ bookSourceVaultRepo.ts
 *
 * ★★ 本文件最重要的不变量：**凭据字段不得出现在书源结构里的任何位置**。
 *    书源只存 `auth: { type, ref }`（ref = 源 id），明文只在加密文件里。
 *    `coerceBookSource` / `sanitizeBookSourcePatch` 都是**白名单拷贝**（不是黑名单剔除），
 *    所以 raw 里塞 `password` / `token` 也进不来 —— 契约脚本有带标记值的负向断言锁。
 *
 * ★ 书籍落盘布局常量（BOOKS_DIR / BOOKS_COVERS_DIR / BOOKS_META_FILE）为什么住在本文件：
 *   它是**唯一一个「零 import 且已被契约脚本直读」的叶子文件**。零依赖文件之间没法互相
 *   import（实测 `node --experimental-strip-types` 解析不了 extensionless 的相对导入，
 *   报 ERR_MODULE_NOT_FOUND），而 knowledgeIndex 的扫描根、元数据落盘位置、封面白名单
 *   三处必须同口径 —— 与其复制字面量，不如把它们放在这个两边都能安全引用的叶子上。
 *   （同理：`BOOK_EXTS` 不能在这里 import —— 格式闸归 bookMarket/ 下能正常 import
 *   bookFormats.ts 的模块，见方案 §4.3。）
 */

// ===== 书源 =====

export type BookSourceKind = 'opds' | 'custom'
export type BookAuthType = 'basic' | 'bearer'

/** 认证引用：只存类型与密钥引用（ref = 源 id），**不存凭据本体** */
export interface BookAuthRef {
  type: BookAuthType
  ref: string
}

/**
 * 自定义源的**声明式取值路径**：只描述「去哪儿取值」，不执行任何脚本。
 * 方案 §三 边界：不做 HTML 抓取、不做整站镜像、映射只是路径。
 */
export interface BookSourceMapping {
  /** 结果数组所在路径（如 `feed.entry`） */
  list: string
  title: string
  author?: string
  cover?: string
  /** 下载直链所在路径 */
  download: string
}

export interface BookSource {
  id: string
  name: string
  kind: BookSourceKind
  url: string
  /** null = 免认证（公版源） */
  auth: BookAuthRef | null
  enabled: boolean
  /** 内置源不提供删除入口（渲染层据此隐藏按钮） */
  builtin: boolean
  /** 仅 custom 用；opds 走标准 Atom 解析，恒 null */
  mapping: BookSourceMapping | null
  createdAt: string
}

export interface BookSourceStore {
  version: number
  sources: BookSource[]
}

export const BOOK_SOURCES_VERSION = 1
export const BOOK_CREDENTIALS_VERSION = 1
export const BOOK_META_VERSION = 1

/**
 * 书籍落盘布局（相对仓库根）。
 * `.books/` 此前在 knowledgeIndex.scanVaultBooks 里硬编码过一次，这里收成单源 ——
 * 书架扫描、元数据文件、封面目录三处必须同口径，飘了就会「书在但 meta 找不到」。
 */
export const BOOKS_DIR = '.books'
export const BOOKS_COVERS_DIR = '.books/.covers'
export const BOOKS_META_FILE = '.meta.json'

const SOURCE_KINDS: readonly BookSourceKind[] = ['opds', 'custom']
const AUTH_TYPES: readonly BookAuthType[] = ['basic', 'bearer']

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function plainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * URL 白名单：只放 `http` / `https`。
 * 挡的是 `file:` / `kbview:` / `plugin:` / `data:` 这类本地或特权 scheme ——
 * 书源 URL 会进主进程的网络层（S2），自建局域网库是合法的，所以私网地址不拦。
 */
export function isAllowedSourceUrl(url: unknown): boolean {
  const u = str(url)
  if (!u) return false
  try {
    const p = new URL(u)
    return p.protocol === 'http:' || p.protocol === 'https:'
  } catch {
    return false
  }
}

function coerceAuth(raw: unknown): BookAuthRef | null {
  if (!plainObject(raw)) return null
  const type = str(raw.type) as BookAuthType
  const ref = str(raw.ref)
  if (!AUTH_TYPES.includes(type) || !ref) return null
  return { type, ref }
}

function coerceMapping(raw: unknown): BookSourceMapping | null {
  if (!plainObject(raw)) return null
  const list = str(raw.list)
  const title = str(raw.title)
  const download = str(raw.download)
  if (!list || !title || !download) return null
  const out: BookSourceMapping = { list, title, download }
  const author = str(raw.author)
  const cover = str(raw.cover)
  if (author) out.author = author
  if (cover) out.cover = cover
  return out
}

/**
 * 单条书源归一（**白名单拷贝**）：id / name / 合法 url 缺一即丢弃整条（返回 null）。
 * 其余字段脏 → 静默回落默认值；未知键（含凭据类键）**原样丢弃**。
 */
export function coerceBookSource(raw: unknown, now = new Date().toISOString()): BookSource | null {
  if (!plainObject(raw)) return null
  const id = str(raw.id)
  const name = str(raw.name)
  const url = str(raw.url)
  if (!id || !name || !isAllowedSourceUrl(url)) return null
  const kind = str(raw.kind) as BookSourceKind
  const createdAt = str(raw.createdAt)
  return {
    id,
    name,
    kind: SOURCE_KINDS.includes(kind) ? kind : 'custom',
    url,
    auth: coerceAuth(raw.auth),
    // enabled 缺省视为启用（存量数据没这个字段时不该集体静默停用）
    enabled: raw.enabled !== false,
    builtin: raw.builtin === true,
    mapping: coerceMapping(raw.mapping),
    createdAt: createdAt || now,
  }
}

export function emptyBookSources(): BookSourceStore {
  return { version: BOOK_SOURCES_VERSION, sources: [] }
}

/**
 * 整壳归一：raw 不是 `{ sources: [] }` 形状 → 返回空 store（**不抛错**，脏数据不该让书市打不开）。
 * 逐条坏数据丢弃；id 重复只留第一条（后写覆盖靠 repo，不靠这里）。
 */
export function coerceBookSources(raw: unknown, now?: string): BookSourceStore {
  if (!plainObject(raw) || !Array.isArray(raw.sources)) return emptyBookSources()
  const sources: BookSource[] = []
  const seen = new Set<string>()
  for (const item of raw.sources) {
    const s = coerceBookSource(item, now)
    if (!s || seen.has(s.id)) continue
    seen.add(s.id)
    sources.push(s)
  }
  return { version: BOOK_SOURCES_VERSION, sources }
}

/** 可 patch 的字段（白名单的形状本身就是契约：凭据类字段**不在其中**） */
export interface BookSourcePatch {
  name?: string
  kind?: BookSourceKind
  url?: string
  auth?: BookAuthRef | null
  enabled?: boolean
  mapping?: BookSourceMapping | null
}

/**
 * 只收**非凭据**字段。凭据类键（username / password / token / secret / credential…）
 * **一律丢弃**，不在返回值里留任何痕迹 —— 凭据只有 `bookSourceSaveCredential` 一条路。
 *
 * 返回 null = patch 压根不是对象；返回 `{}` = 是对象但没有任何合法字段（调用方判定）。
 * ★ url 非法在这里是**静默丢弃**，因为「用户输了个坏 URL」需要给人看的错误信息 ——
 *   那条判断由调用方用 `isAllowedSourceUrl(rawPatch.url)` 单独做并回报。
 */
export function sanitizeBookSourcePatch(patch: unknown): BookSourcePatch | null {
  if (!plainObject(patch)) return null
  const out: BookSourcePatch = {}
  const name = str(patch.name)
  if (name) out.name = name
  if (patch.kind !== undefined) {
    const k = str(patch.kind) as BookSourceKind
    if (SOURCE_KINDS.includes(k)) out.kind = k
  }
  if (patch.url !== undefined && isAllowedSourceUrl(patch.url)) out.url = str(patch.url)
  if (patch.auth !== undefined) out.auth = patch.auth === null ? null : coerceAuth(patch.auth)
  if (patch.enabled !== undefined) out.enabled = patch.enabled !== false
  if (patch.mapping !== undefined) out.mapping = patch.mapping === null ? null : coerceMapping(patch.mapping)
  return out
}

// ===== 凭据（密文文件里的形状；明文只在这一处定义） =====

export interface BookSourceCredential {
  type: BookAuthType
  /** basic */
  username?: string
  password?: string
  /** bearer */
  token?: string
}

export interface BookCredentialStore {
  version: number
  /** 键 = 源 id（与 BookAuthRef.ref 同口径） */
  creds: Record<string, BookSourceCredential>
}

export function emptyCredentials(): BookCredentialStore {
  return { version: BOOK_CREDENTIALS_VERSION, creds: {} }
}

/** 单条凭据归一：类型不认识或必需字段为空 → null（当作「没存凭据」） */
export function coerceCredential(raw: unknown): BookSourceCredential | null {
  if (!plainObject(raw)) return null
  const type = str(raw.type) as BookAuthType
  if (!AUTH_TYPES.includes(type)) return null
  if (type === 'basic') {
    const username = str(raw.username)
    const password = str(raw.password)
    if (!username || !password) return null
    return { type, username, password }
  }
  const token = str(raw.token)
  if (!token) return null
  return { type, token }
}

export function coerceCredentials(raw: unknown): BookCredentialStore {
  if (!plainObject(raw) || !plainObject(raw.creds)) return emptyCredentials()
  const creds: Record<string, BookSourceCredential> = {}
  for (const [id, value] of Object.entries(raw.creds)) {
    const c = coerceCredential(value)
    if (id && c) creds[id] = c
  }
  return { version: BOOK_CREDENTIALS_VERSION, creds }
}

/**
 * 三态连通性的判定核心（方案 §三）：凭据**够不够**这次认证。
 * basic 要用户名 + 密码，bearer 要 token —— 缺了应当是「需要凭据」而不是「连接失败」。
 */
export function credentialSatisfies(type: BookAuthType, cred: BookSourceCredential | null | undefined): boolean {
  if (!cred || cred.type !== type) return false
  if (type === 'basic') return !!(cred.username && cred.password)
  return !!cred.token
}

// ===== 书籍元数据 =====

export interface BookMetaEntry {
  title: string
  author: string
  /** 封面相对仓库根路径（`.books/.covers/<hash>.jpg`）；无封面为 '' */
  coverRel: string
  sourceId: string
  /** 冗余存源名：源被删掉后书卡仍能显示「来自哪儿」 */
  sourceName: string
  downloadedAt: string
  /** 落盘字节数（int；未知为 0） */
  size: number
}

export interface BookMetaStore {
  version: number
  /** 键 = relPath（相对仓库根、posix 分隔）——与 scanVaultBooks 同口径 */
  books: Record<string, BookMetaEntry>
}

export function emptyBookMeta(): BookMetaStore {
  return { version: BOOK_META_VERSION, books: {} }
}

/**
 * 元数据书键归一（posix、去 `./`、去首尾空白）。
 * 拒绝：空串 / 绝对路径 / 含 `..` 或空路径段。
 * ★ 按**路径段**判 `..`，不用 `includes('..')` —— 后者会把合法的 `a..b.epub` 一起误杀。
 */
export function bookMetaKey(relPath: unknown): string {
  let p = str(relPath).replace(/\\/g, '/')
  while (p.startsWith('./')) p = p.slice(2)
  if (!p || p.startsWith('/')) return ''
  if (p.split('/').some((seg) => seg === '' || seg === '..' || seg === '.')) return ''
  return p
}

/** 封面路径白名单：只认 `.books/.covers/` 下的单层文件名（防越权引用 / 嵌套） */
export function isSafeCoverRel(v: unknown): boolean {
  const p = str(v).replace(/\\/g, '/')
  if (!p.startsWith(`${BOOKS_COVERS_DIR}/`)) return false
  const name = p.slice(BOOKS_COVERS_DIR.length + 1)
  if (!name || name.includes('/')) return false
  return name !== '.' && name !== '..'
}

/** 封面文件名：`.books/.covers/<hash>.jpg`。hash 只收 `[a-z0-9]`，其余字符换掉（防路径注入） */
export function bookCoverRelFor(hash: unknown, ext = '.jpg'): string {
  const h = str(hash).toLowerCase().replace(/[^a-z0-9]/g, '')
  const e = /^\.[a-z0-9]{1,5}$/.test(str(ext).toLowerCase()) ? str(ext).toLowerCase() : '.jpg'
  return h ? `${BOOKS_COVERS_DIR}/${h}${e}` : ''
}

/** 单条元数据归一：title 空即丢弃整条（没有书名 = 没有意义） */
export function coerceBookMetaEntry(raw: unknown): BookMetaEntry | null {
  if (!plainObject(raw)) return null
  const title = str(raw.title)
  if (!title) return null
  const cover = str(raw.coverRel)
  const size = Number(raw.size)
  return {
    title,
    author: str(raw.author),
    coverRel: isSafeCoverRel(cover) ? cover.replace(/\\/g, '/') : '',
    sourceId: str(raw.sourceId),
    sourceName: str(raw.sourceName),
    downloadedAt: str(raw.downloadedAt),
    size: Number.isFinite(size) && size > 0 ? Math.floor(size) : 0,
  }
}

export function coerceBookMeta(raw: unknown): BookMetaStore {
  if (!plainObject(raw) || !plainObject(raw.books)) return emptyBookMeta()
  const books: Record<string, BookMetaEntry> = {}
  for (const [key, value] of Object.entries(raw.books)) {
    const k = bookMetaKey(key)
    const entry = coerceBookMetaEntry(value)
    if (k && entry) books[k] = entry
  }
  return { version: BOOK_META_VERSION, books }
}

/** 可 patch 的元数据字段（title 不在列 —— 它是条目的存在条件，缺了就该整条不成立） */
export interface BookMetaPatch {
  author?: string
  coverRel?: string
  sourceId?: string
  sourceName?: string
  downloadedAt?: string
  size?: number
}

/** 只收白名单字段；非对象 → null。非法 coverRel 静默清空（越权引用不该让整条入不了库） */
export function sanitizeBookMetaPatch(patch: unknown): BookMetaPatch | null {
  if (!plainObject(patch)) return null
  const out: BookMetaPatch = {}
  if (patch.author !== undefined) out.author = str(patch.author)
  if (patch.coverRel !== undefined) {
    const c = str(patch.coverRel).replace(/\\/g, '/')
    out.coverRel = isSafeCoverRel(c) ? c : ''
  }
  if (patch.sourceId !== undefined) out.sourceId = str(patch.sourceId)
  if (patch.sourceName !== undefined) out.sourceName = str(patch.sourceName)
  if (patch.downloadedAt !== undefined) out.downloadedAt = str(patch.downloadedAt)
  if (patch.size !== undefined) {
    const n = Number(patch.size)
    out.size = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }
  return out
}

export interface PruneOrphanResult {
  store: BookMetaStore
  /** 被丢弃的条目（按 relPath），调用方据此顺手删封面文件 */
  removed: Record<string, BookMetaEntry>
}

/**
 * 自愈式回收（方案 §4.4）：用**现存书籍清单**过滤元数据，丢弃孤儿条目。
 * 用户在文件管理器里删书（当前唯一路径）后，残留 meta / 封面会被自动清掉。
 * `existing` 传 scanVaultBooks() 的 relPath 集合 —— 这里只做集合运算，不碰磁盘。
 */
export function pruneOrphanMeta(store: BookMetaStore, existing: Iterable<string>): PruneOrphanResult {
  const alive = new Set<string>()
  for (const rel of existing) {
    const k = bookMetaKey(rel)
    if (k) alive.add(k)
  }
  const books: Record<string, BookMetaEntry> = {}
  const removed: Record<string, BookMetaEntry> = {}
  for (const [key, entry] of Object.entries(store.books)) {
    if (alive.has(key)) books[key] = entry
    else removed[key] = entry
  }
  return { store: { version: BOOK_META_VERSION, books }, removed }
}

/** 书卡显示名：元数据书名优先，缺了才回落文件名（去扩展名）—— 上游解析、下游只收（方案 §五） */
export function bookMetaDisplayName(relPath: string, meta: BookMetaEntry | null | undefined): string {
  const base = String(relPath ?? '').split('/').pop() ?? ''
  const fallback = base.replace(/\.[^.]+$/, '')
  return (meta?.title && meta.title.trim()) || fallback || base
}

// ===== 落盘文件名（拍板 ⑩：`{作者} - {书名}.{ext}`，非法字符替换） =====

/** Windows 非法文件名字符 + 控制字符；全角冒号不在列（它是合法文件名字符，别误伤中文书名） */
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g
/** 名字太长在部分文件系统上会截断/失败；按 60 字符封顶（中文按字符算，够用且安全） */
const MAX_NAME_PART = 60

/** 单段文件名净化：非法字符换 `_`、去首尾空白与结尾的点（Windows 不允许尾点）、限长并兜底 */
export function safeFileNamePart(v: unknown, fallback = '未命名'): string {
  let s = str(v).replace(ILLEGAL_FILENAME_CHARS, '_').replace(/\s+/g, ' ')
  // 结尾的点和空格在 Windows 上会被静默吞掉 → 变成「文件名和 meta 不一致」
  s = s.replace(/[. ]+$/, '')
  if (s.length > MAX_NAME_PART) s = s.slice(0, MAX_NAME_PART).trim()
  return s || fallback
}

/**
 * 书籍落盘文件名：`{作者} - {书名}.{ext}`；作者为空时只留书名。
 * `ext` 应当是 `bookExtOf()` 的产物（带点小写）；这里只做形状校验，不认格式表
 * （格式白名单的唯一真相源是 bookFormats.ts，schema 不能引它 —— 见文件头注）。
 */
export function safeBookFileName(author: unknown, title: unknown, ext: unknown): string {
  const e = str(ext).toLowerCase()
  const suffix = /^\.[a-z0-9]{1,8}$/.test(e) ? e : ''
  const t = safeFileNamePart(title, '未命名书籍')
  const a = safeFileNamePart(author, '')
  return a ? `${a} - ${t}${suffix}` : `${t}${suffix}`
}
