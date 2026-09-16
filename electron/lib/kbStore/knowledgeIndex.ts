import { existsSync, lstatSync, readFileSync, readdirSync, statSync, type Dirent } from 'fs'
import { join, relative } from 'path'
import { randomUUID } from 'crypto'
import { getCurrentVault, KB_INBOX_DIR } from './vaultContext'
import { readJson, writeJson, deleteFile } from './jsonStore'
import { parseMarkdown } from './mdStore'
import { WELCOME_DOC_FILENAME } from './welcomeDoc'
import { findCoveringDirEntry, gcArchiveEntries, isArchivedByManifest, readManifest, type ArchivedManifest } from './archivedFilesRepo'
import { getVaultIgnore, isDirIgnored, getVaultIgnoreState, auditIgnoreRules, type VaultIgnoreResult, type VaultIgnoreState } from './ignoreFile'
import { clearSemanticsMemo } from './semanticStore'
import type { Ignore } from 'ignore'

/**
 * 欢迎页（HTML）入索引的特殊口径（2026-09-10）：
 * 知识库**只允许渲染这一个 html** —— 扫描器仅收「仓库根 / 欢迎.html」精确同名文件，
 * 其余 .html 一律不入索引（svg/htm 等同样不收）。它没有 frontmatter，索引条目在此合成。
 */
const WELCOME_PAGE_ID = 'kb-welcome-doc'

/** 欢迎页 HTML → 纯文本（供搜索索引）：剥脚本/样式与标签、压空白并截断。
 *  正文里的 `[[...]]` 是**讲解语法用的示例文字**（本页在 iframe 里渲染，双链不可点），
 *  去掉方括号既让搜索命中标题词，也避免 extractWikiOutlinks 在图谱里造出假外链节点。 */
function welcomeHtmlToPlain(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000)
}

export type KnowledgeCategoryType = 'space' | 'notebook' | 'folder'

export interface KnowledgeCategoryIndexEntry {
  id: string
  name: string
  parentId: string | null
  sortOrder: number
  categoryType: KnowledgeCategoryType
  /** 仓库内相对目录路径（如 学习空间/C++教学）；graph 目录 scope 依赖此字段 */
  path?: string
}

export interface KnowledgePageIndexEntry {
  id: string
  title: string
  path: string
  categoryId: string | null
  tags: string[]
  starred: boolean
  sortOrder: number
  fileType: string
  attachmentId: string
  createdAt: string
  updatedAt: string
  mtimeMs: number
  /** 页面状态（草稿/归档双态）：draft=草稿（知识库正式列表隐藏、图谱虚化/双链仍可引用）；published=归档（默认） */
  status: 'draft' | 'published'
  /** 正文 [[出链]] 标题集合（R2：反链面板据此反查，不必全文扫） */
  outgoingTitles: string[]
  /**
   * frontmatter 标量键值快照（A3-1 泛查询用 knowledge-index-design §2/§9）：
   * 仅收 string/number/boolean，键≤32、字符串值≤200 字符；tags/id/title 等结构化字段不重复收
   */
  frontmatter: Record<string, string | number | boolean>
  /**
   * 条目种类（docs/vault-archive-all-files-design.md §5）：
   * doc = md/欢迎页（有正文，全功能：正文搜索/双链/quiz）；file = 清单归档的非 md 文件
   * （元信息卡或 html 沙箱渲染；不进图谱/AI 检索/quiz，不参与正文索引）。undefined = 旧缓存，按 doc 处理
   */
  entryKind?: 'doc' | 'file'
  /** 文件大小（字节，元信息卡展示）；undefined = 旧缓存 */
  sizeBytes?: number
}

/** 抽取 md 正文中的 [[wiki link]] 出链标题（别名取 | 前段，去重） */
export function extractWikiOutlinks(md: string): string[] {
  const out: string[] = []
  const re = /\[\[([^\]]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(md)) !== null) {
    const t = m[1].split('|')[0].trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

export interface KnowledgeIndex {
  schemaVersion: 5
  generatedAt: string
  source: 'vault'
  categories: KnowledgeCategoryIndexEntry[]
  pages: KnowledgePageIndexEntry[]
  byId: Record<string, KnowledgePageIndexEntry>
  warnings: string[]
  /** 构建 时 .ignore 指纹（undefined = 旧版本缓存）。读缓存时对账，外部改 .ignore 也能自动重建 */
  ignoreState?: VaultIgnoreState | null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

/** frontmatter → 索引快照：仅标量、键≤32、值≤200 字符（防超大 frontmatter 撑爆索引缓存） */
function sanitizeFrontmatterForIndex(raw: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  const keys = Object.keys(raw ?? {}).filter((k) => k && k.length <= 64)
  for (const k of keys.slice(0, 32)) {
    const v = raw[k]
    if (typeof v === 'string') { if (v && v.length <= 200) out[k] = v }
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'boolean') out[k] = v
  }
  return out
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).filter(Boolean)
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

/**
 * 扫描仓库全类型文件（docs/vault-archive-all-files-design.md §5，由 scanMarkdownFiles 放宽）：
 * 全仓库最多一个 `.knowbase`（仓库根直属那个）；深层再出现 `.knowbase` 视为布局违规——
 * 跳过不扫描，并经 warnings 提示（D4/§1 完整性规则）。
 *
 * 非 md 文件**全部收集**，是否入索引由调用方按归档清单判定（md 由 frontmatter 判定）；
 * 唯一非 md 特例：仓库根 `欢迎.html`（见 WELCOME_DOC_FILENAME / WELCOME_PAGE_ID 注释）。
 *
 * .ignore 过滤层（docs/ignore-filter-design.md）：叠加在系统区跳过之后——
 * 系统目录（. 开头 / _inbox / _attachments / 嵌套 .knowbase）先按固有规则跳过，
 * 用户规则对系统区无效（不可被 ! 取反救回）；目录命中 → 整棵剪枝不递归。
 */
function scanVaultFiles(root: string, dir: string, out: string[], warnings?: string[], ign?: Ignore | null, audit?: { files: string[]; dirs: string[] }): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  const atRoot = dir === root
  for (const entry of entries) {
    // D3（P4）：'blog' 不再是内部目录名（博客已收进 .knowbase/blog，由「.」前缀规则跳过）；
    // '_attachments' = 历史遗留根级附件目录，继续跳过
    if (entry.name === '_attachments') continue
    // 收件箱（迁移器草稿区遗留语义）永不入索引：与文件树 APP_INTERNAL_DIRS 同口径
    // （大小写不敏感、任意深度）；.knowbase/_inbox 的显式放行见下方 dot 分支，不受本行影响
    // 注：Web 剪藏草稿已迁至 .knowbase/_draft/clipper（随 . 前缀规则天然跳过，不依赖本行）
    if (entry.isDirectory() && entry.name.toLowerCase() === '_inbox') continue
    const abs = join(dir, entry.name)
    // 规则对账收集（§10.1）：必须在 .ignore 剪枝判定**之前**记录——命中的条目会被剪枝排除，
    // 事后对过滤后清单对账会把「正常命中」误报成「未匹配」。文件收全类型（归档可见性口径）
    if (audit) {
      const relAudit = relative(root, abs).replace(/\\/g, '/')
      if (entry.isDirectory()) audit.dirs.push(relAudit)
      else if (entry.isFile()) audit.files.push(relAudit)
    }
    // .ignore 过滤：目录命中整棵剪枝；文件命中不入扫描结果（rel = 仓库内 posix 相对路径）
    if (ign) {
      const rel = relative(root, abs).replace(/\\/g, '/')
      if (entry.isDirectory()) {
        if (isDirIgnored(ign, rel)) continue
      } else if (entry.isFile() && ign.ignores(rel)) {
        continue
      }
    }
    try {
      if (entry.isSymbolicLink() || lstatSync(abs).isSymbolicLink()) continue
      if (entry.isDirectory()) {
        // P5a：嵌套 .knowbase（非仓库根直属）→ 忽略 + 提示
        if (entry.name === '.knowbase' && !atRoot) {
          warnings?.push(`忽略嵌套仓库目录：${relative(root, abs)}（一个仓库最多一个 .knowbase）`)
          continue
        }
        // . 开头目录 = 系统区（.knowbase 内仅有 _inbox 是知识页收件箱，其余跳过）
        if (entry.name.startsWith('.')) {
          if (entry.name === '.knowbase') {
            const inbox = join(abs, '_inbox')
            if (existsSync(inbox) && lstatSync(inbox).isDirectory()) scanVaultFiles(root, inbox, out, warnings, ign, audit)
          }
          continue
        }
        scanVaultFiles(root, abs, out, warnings, ign, audit)
      } else if (entry.isFile()) {
        out.push(abs)
      }
    } catch {
      // A single unreadable entry must not prevent the rest of the vault indexing.
    }
  }
}

/**
 * 读取分类树。兼容两种落盘格式：
 *  - dict（迁移器产物）: { "<uuid>": { id,name,type,parent,sortOrder,...,path } }
 *  - array（早期/其它写入路径）: [{ id,name,categoryType,parentId,... }]
 * dict 优先——迁移产物是 dict 且带 path（graph 目录 scope 依赖）。
 */
interface ReadCategoriesResult {
  categories: KnowledgeCategoryIndexEntry[]
  warnings: string[]
  /** 原始条目（按 id）：写回时以此为基底，避免丢掉迁移产物自带的 createdAt 等字段 */
  rawById: Map<string, Record<string, unknown>>
  /** 落盘格式：false = dict（迁移器产物），true = array */
  isArray: boolean
}

function readCategories(): ReadCategoriesResult {
  const raw = readJson<unknown>('modules/knowledge', 'categories.json', [])
  const warnings: string[] = []
  const items: Array<Record<string, unknown>> = []
  const rawById = new Map<string, Record<string, unknown>>()
  let isArray = false
  if (Array.isArray(raw)) {
    isArray = true
    for (const it of raw as unknown[]) if (it && typeof it === 'object') items.push(it as Record<string, unknown>)
  } else if (raw && typeof raw === 'object') {
    for (const it of Object.values(raw as Record<string, unknown>)) if (it && typeof it === 'object') items.push(it as Record<string, unknown>)
  }

  const categories: KnowledgeCategoryIndexEntry[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const id = asString(item.id)
    if (!id) {
      warnings.push('发现没有 id 的分类，已跳过')
      continue
    }
    if (!rawById.has(id)) rawById.set(id, item)
    const type = asString(item.categoryType) || asString(item.type) || 'folder'
    categories.push({
      id,
      name: asString(item.name) || id,
      parentId: asString(item.parentId) || asString(item.parent) || null,
      sortOrder: Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : 0,
      categoryType: type === 'space' || type === 'notebook' ? type : 'folder',
      // dict 格式带仓库内相对目录路径；array 无 path 时置空（graph scope 不生效，不崩）
      path: asString(item.path) || undefined,
    })
  }
  return { categories, warnings, rawById, isArray }
}

/** 页面仓库相对路径 → 所在目录（posix，根目录为空串） */
function dirRelOf(relPath: string): string {
  const i = relPath.lastIndexOf('/')
  return i === -1 ? '' : relPath.slice(0, i)
}

/**
 * 目录即分类：为给定目录链逐段确保分类节点存在（按 path 精确匹配，缺失才建）。
 * 已在 categories 上原地补充；返回新建节点数与「原绑定目录已消失」的失效节点 id。
 *
 * 对账规则（目录被移动 / 重命名 / 删除后仍不产生僵尸或重复节点）：
 *  1. 先失效解绑：path 指向的目录已不存在 → 解绑 path，等后续按「父级 + 目录名」认领
 *     注意：.ignore 命中的目录**不走** stale（磁盘还在）——节点保留在 categories.json、
 *     仅在 rebuild 产出层隐藏（2026-09-08 教训：物理删除会让取消忽略后 space/notebook
 *     类型永久丢失、学习空间视图不可见；读层隐藏才能原样恢复）
 *  2. 认领优先：同级同名且已解绑（或历史无 path）的节点 → 复用其 id（保住 notebook/space 类型与排序）
 *  3. 仍无节点才新建，一律 folder（语义升级交给用户在知识库改类型）
 */
function ensureDirCategories(
  dirs: string[],
  categories: KnowledgeCategoryIndexEntry[],
  root: string
): { created: number; claimed: number; staleIds: Set<string> } {
  const isDir = (rel: string): boolean => {
    try { return statSync(join(root, rel)).isDirectory() } catch { return false }
  }
  const staleIds = new Set<string>()
  for (const c of categories) {
    if (c.path && !isDir(c.path)) {
      staleIds.add(c.id)
      c.path = undefined
    }
  }

  let created = 0
  let claimed = 0
  for (const dir of dirs) {
    let parentId: string | null = null
    let prefix = ''
    for (const seg of dir.split('/').filter(Boolean)) {
      prefix = prefix ? `${prefix}/${seg}` : seg
      let node = categories.find((c) => c.path === prefix)
      if (!node) {
        // 认领：同名且尚未绑定目录的节点（同级优先，其次跨父级——目录被移动到别处时保住原节点 id 与类型）
        node = categories.find((c) => (c.parentId ?? null) === parentId && c.name === seg && !c.path)
          ?? categories.find((c) => c.name === seg && !c.path)
        if (node) {
          node.path = prefix
          if ((node.parentId ?? null) !== parentId) node.parentId = parentId
          claimed++
        }
      }
      if (!node) {
        // §10.2 宽松认领（2026-09-08 P4 挂账落码）：目录改名只动空格（连续空格肉眼不可辨，
        // 用户对齐 .ignore 规则时高频发生）时，精确认领失败后按空白归一化认领**唯一**候选，
        // 保住 space/notebook 类型与排序；归一化后仍有歧义（多个候选）不认领，维持新建 folder
        const segNorm = seg.replace(/\s+/g, '')
        const looseAll = categories.filter((c) => !c.path && c.name.replace(/\s+/g, '') === segNorm)
        const looseSame = looseAll.filter((c) => (c.parentId ?? null) === parentId)
        const loose =
          looseSame.length === 1 ? looseSame[0]
          : (looseSame.length === 0 && looseAll.length === 1 ? looseAll[0] : undefined)
        if (loose) {
          loose.path = prefix
          if ((loose.parentId ?? null) !== parentId) loose.parentId = parentId
          claimed++
          node = loose
        }
      }
      if (!node) {
        const maxOrder = categories
          .filter((c) => (c.parentId ?? null) === parentId)
          .reduce((m, c) => Math.max(m, c.sortOrder), -1)
        node = {
          id: randomUUID(),
          name: seg,
          parentId,
          sortOrder: maxOrder + 1,
          categoryType: 'folder',
          path: prefix,
        }
        categories.push(node)
        created++
      }
      parentId = node.id
    }
  }
  return { created, claimed, staleIds }
}

/** 收集分类子树 id（含自身），用于整棵删除已消失的目录分支 */
function collectCategorySubtree(id: string, categories: KnowledgeCategoryIndexEntry[], out: Set<string>): void {
  if (out.has(id)) return
  out.add(id)
  for (const c of categories) if (c.parentId === id) collectCategorySubtree(c.id, categories, out)
}

/** 写回 categories.json：保持原落盘格式（dict/array），以原始条目为基底避免丢字段 */
function writeCategories(
  categories: KnowledgeCategoryIndexEntry[],
  rawById: Map<string, Record<string, unknown>>,
  isArray: boolean
): void {
  if (isArray) {
    const rows = categories.map((c) => {
      const base = rawById.get(c.id) ?? {}
      const row: Record<string, unknown> = {
        ...base,
        id: c.id,
        name: c.name,
        categoryType: c.categoryType,
        parentId: c.parentId,
        sortOrder: c.sortOrder,
      }
      if (c.path) row.path = c.path
      return row
    })
    writeJson('modules/knowledge', 'categories.json', rows)
    return
  }
  const dict: Record<string, unknown> = {}
  for (const c of categories) {
    const base = rawById.get(c.id) ?? {}
    const row: Record<string, unknown> = {
      ...base,
      id: c.id,
      name: c.name,
      type: c.categoryType,
      parent: c.parentId,
      sortOrder: c.sortOrder,
    }
    if (c.path) row.path = c.path
    dict[c.id] = row
  }
  writeJson('modules/knowledge', 'categories.json', dict)
}

/** 删除目录条目（含子孙）并写回 categories.json；磁盘文件夹处置与索引失效由调用方负责（2026-09-07 知识库开放目录删除） */
export function removeCategoryEntries(id: string): void {
  const { categories, rawById, isArray } = readCategories()
  const doomed = new Set<string>()
  collectCategorySubtree(id, categories, doomed)
  writeCategories(categories.filter((c) => !doomed.has(c.id)), rawById, isArray)
}

/** 追加目录条目并写回 categories.json（sortOrder 缺省=同父级末尾）；索引失效由调用方负责（2026-09-07 创建学习空间） */
export function appendCategoryEntry(entry: { id: string; name: string; categoryType: KnowledgeCategoryType; parentId: string | null; sortOrder?: number; path?: string }): void {
  const { categories, rawById, isArray } = readCategories()
  const siblings = categories.filter((c) => (c.parentId ?? null) === (entry.parentId ?? null))
  const sortOrder = entry.sortOrder ?? (siblings.length ? Math.max(...siblings.map((c) => c.sortOrder)) + 1 : 0)
  const node: KnowledgeCategoryIndexEntry = { ...entry, sortOrder }
  rawById.set(entry.id, {})
  writeCategories([...categories, node], rawById, isArray)
}

/** 更新单个目录条目字段并写回（虚拟条目改名等轻量场景）；索引失效由调用方负责 */
export function updateCategoryEntry(id: string, patch: { name?: string; path?: string; sortOrder?: number }): void {
  const { categories, rawById, isArray } = readCategories()
  const c = categories.find((x) => x.id === id)
  if (!c) return
  if (patch.name !== undefined) c.name = patch.name
  if (patch.path !== undefined) c.path = patch.path
  if (patch.sortOrder !== undefined) c.sortOrder = patch.sortOrder
  writeCategories(categories, rawById, isArray)
}

/** 目录改名级联：改条目 name/path，并把子孙条目 path 前缀同步替换；索引失效由调用方负责（2026-09-07 重命名放行） */
export function renameCategoryCascade(id: string, newName: string, oldPath: string, newPath: string): void {
  const { categories, rawById, isArray } = readCategories()
  for (const c of categories) {
    if (c.id === id) { c.name = newName; c.path = newPath }
    else if (oldPath && c.path && c.path.startsWith(oldPath + '/')) c.path = newPath + c.path.slice(oldPath.length)
  }
  writeCategories(categories, rawById, isArray)
}

/** 目录排序（同父级内规范化重编号后与相邻项互换）；索引失效由调用方负责（2026-09-07 排序放行） */
export function moveCategoryOrderInDict(id: string, direction: 'up' | 'down'): void {
  const { categories, rawById, isArray } = readCategories()
  const me = categories.find((c) => c.id === id)
  if (!me) return
  const siblings = categories
    .filter((c) => (c.parentId ?? null) === (me.parentId ?? null))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-Hans'))
  const i = siblings.findIndex((c) => c.id === id)
  const j = direction === 'up' ? i - 1 : i + 1
  if (j < 0 || j >= siblings.length) return
  ;[siblings[i], siblings[j]] = [siblings[j], siblings[i]]
  siblings.forEach((c, order) => { c.sortOrder = order })
  writeCategories(categories, rawById, isArray)
}

/** 目录 → categoryId（path 为准；根目录与未分类收件箱 → null） */
function resolveCategoryIdByPath(relPath: string, categories: KnowledgeCategoryIndexEntry[]): string | null {
  const dir = dirRelOf(relPath)
  if (!dir || dir === KB_INBOX_DIR) return null
  return categories.find((c) => c.path === dir)?.id ?? null
}

/** 全量扫描当前 Vault，生成可供 knowledgeRepo 使用的内存索引。 */
export function rebuildKnowledgeIndex(): KnowledgeIndex {
  const current = getCurrentVault()
  const warnings: string[] = []
  if (!current) {
    return {
      schemaVersion: 5,
      generatedAt: new Date().toISOString(),
      source: 'vault',
      categories: [],
      pages: [],
      byId: {},
      warnings: ['当前没有打开的仓库'],
    }
  }

  const categoryResult = readCategories()
  warnings.push(...categoryResult.warnings)
  const categories = categoryResult.categories
  let categoriesDirty = false
  const files: string[] = []
  // .ignore 过滤层：规则解析警告随索引 warnings 透出；命中文件/目录不参与索引（连带不参与目录派生分类）
  const ignoreResult: VaultIgnoreResult = getVaultIgnore()
  warnings.push(...ignoreResult.warnings)
  // §10.1 规则对账：未命中任何磁盘条目的规则（典型=目录名连续空格肉眼不可对齐）进 warnings 提示，
  // 不再静默不生效——用户能立刻看出是规则写错而非「功能不稳定」
  const ignoreAudit = ignoreResult.ign ? { files: [] as string[], dirs: [] as string[] } : undefined
  scanVaultFiles(current.rootPath, current.rootPath, files, warnings, ignoreResult.ign, ignoreAudit)
  if (ignoreResult.ign && ignoreAudit) {
    warnings.push(...auditIgnoreRules(ignoreResult, ignoreAudit))
  }

  // 第一遍：读入全部条目（目录派生需先知道「所有知识页所在目录」，再统一补建分类）
  // 全类型归档（§5）：先 GC 对账清单，再读清单；md 由 frontmatter 判定、非 md 由清单判定
  const gcRemoved = gcArchiveEntries()
  if (gcRemoved > 0) warnings.push(`归档清单已清理 ${gcRemoved} 个磁盘已消失的条目`)
  const manifest: ArchivedManifest = readManifest()
  const docs: Array<{ abs: string; rel: string; doc: ReturnType<typeof parseMarkdown>; entryKind: 'doc' | 'file' }> = []
  for (const abs of files) {
    try {
      const rel = relative(current.rootPath, abs).replace(/\\/g, '/')
      const mtime = new Date(statSync(abs).mtimeMs).toISOString()
      // 欢迎页（唯一放行的 html）：无 frontmatter，条目字段在此合成；正文取纯文本供搜索
      if (rel === WELCOME_DOC_FILENAME) {
        const raw = readFileSync(abs, 'utf8')
        docs.push({
          abs,
          rel,
          doc: {
            frontmatter: {
              id: WELCOME_PAGE_ID,
              title: '欢迎',
              fileType: 'html',
              status: 'published',
              starred: 'false',
              created: mtime,
              updated: mtime,
            },
            body: welcomeHtmlToPlain(raw),
          },
          entryKind: 'doc',
        })
        continue
      }
      if (/\.md$/i.test(rel)) {
        const doc = parseMarkdown(readFileSync(abs, 'utf8'))
        // B1（目录状态优先）：被目录条目覆盖、且自身无 frontmatter id 的普通 md → 自动 id 收录
        if (!asString(doc.frontmatter.id) && findCoveringDirEntry(rel, manifest)) {
          const fileName = rel.slice(rel.lastIndexOf('/') + 1)
          const dot = fileName.lastIndexOf('.')
          doc.frontmatter.id = `auto:${rel}`
          if (!asString(doc.frontmatter.title)) doc.frontmatter.title = dot > 0 ? fileName.slice(0, dot) : fileName
          doc.frontmatter.fileType = 'md'
          doc.frontmatter.status = 'published'
        }
        docs.push({ abs, rel, doc, entryKind: 'doc' })
        continue
      }
      // 非 md：仅清单归档的文件入索引（元信息卡 / html 沙箱）；不读内容（二进制可能很大）
      if (!isArchivedByManifest(rel, manifest)) continue
      const exact = manifest.entries.find((e) => e.type === 'file' && e.path === rel)
      const fileName = rel.slice(rel.lastIndexOf('/') + 1)
      const dot = fileName.lastIndexOf('.')
      docs.push({
        abs,
        rel,
        doc: {
          frontmatter: {
            id: exact?.id ?? `auto:${rel}`,
            title: dot > 0 ? fileName.slice(0, dot) : fileName,
            fileType: (dot > 0 ? fileName.slice(dot + 1) : '').toLowerCase(),
            status: 'published',
            created: mtime,
            updated: mtime,
          },
          body: '',
        },
        entryKind: 'file',
      })
    } catch {
      warnings.push(`页面读取失败，已跳过：${relative(current.rootPath, abs)}`)
    }
  }

  // 目录即分类（2026-09-04）：为知识页所在目录补建分类节点，随后按 path 定归属。
  // 编辑器是唯一写入方（vault 模式知识库只读），位置变化一律由文件路径表达。
  const dirs = [...new Set(docs.map((d) => dirRelOf(d.rel)).filter((d) => d && d !== KB_INBOX_DIR))].sort()
  const { created, claimed, staleIds } = ensureDirCategories(dirs, categories, current.rootPath)
  if (created > 0) {
    categoriesDirty = true
    warnings.push(`已按仓库目录补建 ${created} 个分类节点（目录即分类）`)
  }
  // 认领同样要落盘：目录被移动/改名后，节点的 path 与 parentId 已变（不写盘则磁盘与内存分叉）
  if (claimed > 0) categoriesDirty = true

  // 对账收尾：目录已被移动/重命名/删除且无人认领的分类节点 → 整棵子树移除（避免僵尸分类堆积）
  const removedIds = new Set<string>()
  for (const id of staleIds) {
    const node = categories.find((c) => c.id === id)
    if (node && !node.path) collectCategorySubtree(id, categories, removedIds)
  }
  if (removedIds.size > 0) {
    for (const id of removedIds) {
      const i = categories.findIndex((c) => c.id === id)
      if (i !== -1) categories.splice(i, 1)
    }
    categoriesDirty = true
    warnings.push(`已清理 ${removedIds.size} 个目录已消失的分类节点`)
  }
  if (categoriesDirty) writeCategories(categories, categoryResult.rawById, categoryResult.isArray)

  // .ignore 读层隐藏（2026-09-08 改版）：path 命中规则的分类节点从**产出**剔除（categories.json
  // 保留全量），取消忽略后节点原样恢复（类型/排序不丢）；子节点由规则前缀语义自然一并命中
  const activeIgn = ignoreResult.ign
  const visibleCategories = activeIgn
    ? categories.filter((c) => !(c.path && isDirIgnored(activeIgn, c.path)))
    : categories

  const pages: KnowledgePageIndexEntry[] = []
  const byId: Record<string, KnowledgePageIndexEntry> = {}

  for (const { abs, rel, doc, entryKind } of docs) {
    try {
      const id = asString(doc.frontmatter.id)
      if (!id) {
        warnings.push(`页面缺少 frontmatter.id，已跳过：${rel}`)
        continue
      }
      if (byId[id]) {
        warnings.push(`页面 id 重复，后者已跳过：${id}`)
        continue
      }
      const stat = statSync(abs)
      // B1（目录状态优先）：路径被目录条目覆盖 → 一律按已归档消费（draft md 放出、图谱不虚化）
      const coveredByDir = findCoveringDirEntry(rel, manifest) !== null
      const entry: KnowledgePageIndexEntry = {
        id,
        title: asString(doc.frontmatter.title) || abs.slice(Math.max(abs.lastIndexOf('\\'), abs.lastIndexOf('/')) + 1).replace(/\.md$/i, ''),
        path: rel,
        // path 为准：分类归属由文件所在目录派生，frontmatter.category 不再参与（历史字段，读取即忽略）
        categoryId: resolveCategoryIdByPath(rel, categories),
        tags: asStringArray(doc.frontmatter.tags),
        starred: asString(doc.frontmatter.starred).toLowerCase() === 'true',
        sortOrder: Number.isFinite(Number(doc.frontmatter.sortOrder)) ? Number(doc.frontmatter.sortOrder) : 0,
        fileType: asString(doc.frontmatter.fileType),
        attachmentId: asString(doc.frontmatter.attachmentId),
        createdAt: asString(doc.frontmatter.created),
        updatedAt: asString(doc.frontmatter.updated),
        status: coveredByDir || asString(doc.frontmatter.status).toLowerCase() !== 'draft' ? 'published' : 'draft',
        mtimeMs: stat.mtimeMs,
        // 欢迎页不入双链图：它是导览页，正文里的 [[...]] 只是语法示例（见 welcomeHtmlToPlain）
        outgoingTitles: rel === WELCOME_DOC_FILENAME ? [] : extractWikiOutlinks(doc.body),
        entryKind,
        sizeBytes: stat.size,
        frontmatter: sanitizeFrontmatterForIndex(doc.frontmatter),
      }
      pages.push(entry)
      byId[id] = entry
    } catch {
      warnings.push(`页面读取失败，已跳过：${relative(current.rootPath, abs)}`)
    }
  }

  pages.sort((a, b) => a.sortOrder - b.sortOrder || b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title, 'zh-Hans'))

  // 搜索用纯文本索引（性能 2026-09-10）：复用本已读入内存的 docs 正文顺手产出并落盘。
  // 放在这里而不是搜索时懒建，是因为此刻正文已在内存 —— 零额外读盘。
  const textById: Record<string, string> = {}
  for (const { doc, entryKind } of docs) {
    // 非 md 归档文件无正文，不进文本索引（搜索层按标题匹配）
    if (entryKind === 'file') continue
    const id = asString(doc.frontmatter.id)
    if (id) textById[id] = mdToPlain(doc.body || '')
  }
  writeJson('cache', KNOWLEDGE_TEXT_KEY, {
    generatedAt: new Date().toISOString(),
    vaultPath: current.rootPath,
    byId: textById,
  })

  return {
    schemaVersion: 5,
    generatedAt: new Date().toISOString(),
    source: 'vault',
    categories: visibleCategories.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-Hans')),
    pages,
    byId,
    warnings,
    ignoreState: getVaultIgnoreState(),
  }
}

/** .ignore 指纹对账：双方都为空（无 .ignore）视为一致；有一方为空或指纹不同 = 规则文件被增删改 */
function sameIgnoreState(a: VaultIgnoreState | null | undefined, b: VaultIgnoreState | null | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

/**
 * 进程内索引缓存（2026-09-10 性能优化）。
 *
 * 磁盘缓存虽免了重建，但每次 getKnowledgeIndex 仍要走 readJson 的
 * existsSync + statSync + readFileSync + JSON.parse 全同步链（实测 417 页 ≈ 2.3ms/次）。
 * 而该函数被 knowledgeVaultRepo 多处 + AI 工具 / quiz / 附件 / summary 高频调用，
 * 单次页面加载累积可达数十毫秒且全程阻塞主进程。
 *
 * 失效条件与磁盘缓存保持一致：.ignore 指纹变化（外部改规则、无 watcher 也感知）或显式 invalidate。
 * 仓库切换必须失效，否则会把上一个仓库的索引串给新仓库。
 */
let indexMemo: KnowledgeIndex | null = null
/** 内存缓存归属的仓库根路径（null = 无当前仓库） */
let indexMemoVault: string | null = null

/** 搜索用纯文本索引的缓存文件（与 knowledge-index.json 同生命周期） */
const KNOWLEDGE_TEXT_KEY = 'knowledge-text.json'

interface KnowledgeTextIndexFile {
  generatedAt: string
  vaultPath: string | null
  byId: Record<string, string>
}

let textMemo: KnowledgeTextIndexFile | null = null
let textMemoVault: string | null = null

/** 粗剥 markdown 记号 → 纯文本（搜索索引口径；与原先 vaultSearchPages 内的实现保持一致） */
export function mdToPlain(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[>*`~_|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 搜索用正文索引（性能 2026-09-10）。
 * 命中内存 → 读一次磁盘 cache → 都没有则由当前索引逐页读盘懒重建。
 * 常态路径由 rebuildKnowledgeIndex 顺手产出（那时正文已在内存里，零额外读盘），
 * 从而把 vaultSearchPages 从「每次搜索全盘重读 417 个 md（实测 68ms）」降为一次 JSON 读取。
 */
export function getKnowledgeTextIndex(): Record<string, string> {
  const vaultKey = getCurrentVault()?.rootPath ?? null
  if (textMemo && textMemoVault === vaultKey) return textMemo.byId
  const cached = readJson<KnowledgeTextIndexFile | null>('cache', KNOWLEDGE_TEXT_KEY, null)
  if (cached && cached.byId && cached.vaultPath === vaultKey) {
    textMemo = cached
    textMemoVault = vaultKey
    return cached.byId
  }
  // 懒重建：磁盘 cache 缺失、或仓库已切换
  const root = getCurrentVault()?.rootPath
  const byId: Record<string, string> = {}
  if (root) {
    for (const e of getKnowledgeIndex().pages) {
      // 非 md 归档文件无正文（二进制不读），固定空串
      if (e.entryKind === 'file') { byId[e.id] = ''; continue }
      try { byId[e.id] = mdToPlain(parseMarkdown(readFileSync(join(root, e.path), 'utf-8')).body || '') }
      catch { byId[e.id] = '' }
    }
  }
  const payload: KnowledgeTextIndexFile = { generatedAt: new Date().toISOString(), vaultPath: vaultKey, byId }
  writeJson('cache', KNOWLEDGE_TEXT_KEY, payload)
  textMemo = payload
  textMemoVault = vaultKey
  return byId
}

/** 丢弃进程内正文索引缓存 */
function clearTextMemo(): void {
  textMemo = null
  textMemoVault = null
}

/** 丢弃进程内索引缓存（仓库切换 / 内容写入后调用） */
function clearIndexMemo(): void {
  indexMemo = null
  indexMemoVault = null
}

/** 读取缓存；schema 不匹配或 .ignore 指纹变化（外部增删改规则，无 watcher 也感知）时自动重建并落盘。 */
export function getKnowledgeIndex(forceRebuild = false): KnowledgeIndex {
  const vaultKey = getCurrentVault()?.rootPath ?? null
  if (!forceRebuild) {
    // 一级：进程内缓存（命中即返回，零 IO）
    if (indexMemo && indexMemoVault === vaultKey && sameIgnoreState(indexMemo.ignoreState, getVaultIgnoreState())) {
      return indexMemo
    }
    // 二级：磁盘缓存（进程冷启动后首次调用）
    const cached = readJson<KnowledgeIndex | null>('cache', 'knowledge-index.json', null)
    if (
      cached &&
      cached.schemaVersion === 5 &&
      cached.source === 'vault' &&
      Array.isArray(cached.pages) &&
      cached.byId &&
      sameIgnoreState(cached.ignoreState, getVaultIgnoreState())
    ) {
      indexMemo = cached
      indexMemoVault = vaultKey
      return cached
    }
  }
  const fresh = rebuildKnowledgeIndex()
  writeJson('cache', 'knowledge-index.json', fresh)
  indexMemo = fresh
  indexMemoVault = vaultKey
  return fresh
}

/** Vault 内容发生变化时调用：清进程内 + 磁盘缓存，下一次 getKnowledgeIndex 懒重建（P0 不依赖 watcher）。 */
export function invalidateKnowledgeIndex(): void {
  clearIndexMemo()
  clearTextMemo()
  // 语义向量不删（嵌入成本高）：只清 memo，下次 ensureSemanticIndex 按页 diff 增量（knowledge-index-design §7）
  clearSemanticsMemo()
  if (!getCurrentVault()) return
  deleteFile('cache', 'knowledge-index.json')
  deleteFile('cache', KNOWLEDGE_TEXT_KEY)
}

export function findKnowledgePage(id: string): KnowledgePageIndexEntry | null {
  return getKnowledgeIndex().byId[id] || null
}
