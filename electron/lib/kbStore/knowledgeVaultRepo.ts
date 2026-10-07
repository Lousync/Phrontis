import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'fs'
import { dirname, extname, join, resolve as resolvePath, sep } from 'path'
import { randomUUID } from 'crypto'
import { getCurrentVault, KB_INBOX_DIR } from './vaultContext'
import { getKnowledgeIndex, invalidateKnowledgeIndex, getKnowledgeTextIndex, mdToPlain, removeCategoryEntries, appendCategoryEntry, updateCategoryEntry, renameCategoryCascade, moveCategoryOrderInDict, type KnowledgeCategoryType, type KnowledgePageIndexEntry } from './knowledgeIndex'
import { createLinkResolver, getGraphIndex } from './graphIndex'
import { parseMarkdown, serializeMarkdown } from './mdStore'
import { WELCOME_DOC_FILENAME } from './welcomeDoc'

/**
 * 知识库 vault 读源（读写分工定稿，见 .AGENT/docs/读写分工设计.md）：
 * 知识库模块 = 阅读器（读走 knowledgeIndex），编辑器模块 = 唯一写入方。
 * 本文件只提供「读 + 星标小编辑」两类能力，纯函数可冒烟、不依赖 Electron。
 * payload 形状对齐 knowledgeRepo.mapPage，渲染层无感切换。
 */

export interface VaultTag { id: string; name: string; color: string }

export interface VaultPage {
  id: string
  title: string
  contentMd: string
  contentHtml: string
  annotationMd: string
  categoryId: string | null
  isStarred: boolean
  sortOrder: number
  fileType: string
  attachmentId: string
  createdAt: string
  updatedAt: string
  tags: VaultTag[]
  /** 仓库内相对路径（渲染层跳转编辑器用，绝不含绝对路径） */
  path: string
  /** frontmatter attachments 数组：仓库内相对路径（如 .knowbase/_attachments/knowledge_page/<id>/<file>） */
  attachments: string[]
  /** 条目种类：doc=md/欢迎页；file=仓库内的非 md 文件（缺省按 doc 消费，向后兼容） */
  entryKind?: 'doc' | 'file'
  /** 文件大小（字节；元信息卡展示） */
  sizeBytes?: number
}

/**
 * 身份统一后（2026-09-20，docs/note-identity-unify-design.md §2）**没有「草稿」这个概念**：
 * 文件即条目，`status` 双态退役。此函数保留为直通，只为让下游调用点不必同时改（语义 = 全量）。
 * 它的存在也标注了一处历史：旧口径下这里会滤掉 status=draft 的页。
 */
function publishedOnly(list: KnowledgePageIndexEntry[]): KnowledgePageIndexEntry[] {
  return list
}

function requireRoot(): string {
  const cur = getCurrentVault()
  if (!cur) throw new Error('当前没有打开的仓库')
  return cur.rootPath
}

/**
 * 欢迎页（HTML 导览文件，见 welcomeDoc.ts）不是 md 知识页：凡「重写文件 / 改名」的仓库写通道一律拒绝——
 * frontmatter 注入会毁掉整页 HTML，改名（→ .md）会让它跌出 kbview 白名单、从知识库直接消失。
 * 想改内容：在编辑器/记事本里直接编辑该文件；想移除：删除（进系统回收站）。
 */
function isWelcomeEntry(entry: { path: string; fileType: string }): boolean {
  return entry.fileType === 'html' || entry.path === WELCOME_DOC_FILENAME
}
const WELCOME_WRITE_DENY = '「欢迎」是 HTML 导览页：不支持改名 / 排序 / 收藏，请直接编辑或删除该文件'

function tagsOf(entry: KnowledgePageIndexEntry): VaultTag[] {
  return entry.tags.map((name) => ({ id: name, name, color: '' }))
}

/** 读页面文件：单次读盘同时给出正文与 frontmatter attachments（避免双读） */
function readPageDoc(entry: KnowledgePageIndexEntry): { contentMd: string; attachments: string[] } {
  try {
    const abs = join(requireRoot(), entry.path)
    const doc = parseMarkdown(readFileSync(abs, 'utf-8'))
    const a = doc.frontmatter.attachments
    // 存量兼容：旧相对引用（../.knowbase/_attachments/knowledge_page/<id>/<file>）
    // → 协议引用 attachment://vault/<id>/<file>（页面/仓库移动不断链）
    const body = (doc.body || '').replace(
      /(?:\.\.\/|\.\/)*\.knowbase\/_attachments\/knowledge_page\/([0-9a-f-]{36})\/([^\s)\]"']+)/gi,
      (_all, pid: string, file: string) => `attachment://vault/${pid}/${decodeURIComponent(file)}`
    )
    return {
      contentMd: body,
      attachments: Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [],
    }
  } catch {
    return { contentMd: '', attachments: [] }
  }
}

function entryToPage(entry: KnowledgePageIndexEntry, contentMd = '', attachments: string[] = []): VaultPage {
  return {
    id: entry.id,
    title: entry.title,
    contentMd,
    contentHtml: '',
    annotationMd: '',
    categoryId: entry.categoryId,
    isStarred: entry.starred,
    sortOrder: entry.sortOrder,
    fileType: entry.fileType,
    attachmentId: entry.attachmentId,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    tags: tagsOf(entry),
    path: entry.path,
    attachments,
    entryKind: entry.entryKind ?? 'doc',
    sizeBytes: entry.sizeBytes,
  }
}

/**
 * 非 md 归档文件（entryKind==='file'）：frontmatter 重写通道一律拒绝——
 * 二进制/非 md 文件写入 frontmatter 会毁掉文件（与欢迎页同一铁律）。
 */
const NON_MD_ARCHIVE_DENY = '该文件不是 markdown 知识页：不支持改名 / 排序 / 收藏（可在编辑器中管理它）'
function isNonMdArchiveEntry(entry: { entryKind?: string }): boolean {
  return entry.entryKind === 'file'
}

/** 原子写仓库根内文件（tmp + rename，与 jsonStore 同策略） */
function writeVaultFile(relPath: string, content: string): boolean {
  try {
    const abs = join(requireRoot(), relPath)
    const dir = dirname(abs)
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `.${randomUUID()}.tmp`)
    writeFileSync(tmp, content, 'utf-8')
    try {
      renameSync(tmp, abs)
    } catch {
      if (existsSync(abs)) unlinkSync(abs)
      renameSync(tmp, abs)
    }
    return true
  } catch {
    return false
  }
}

export function vaultGetCategories(): Array<{ id: string; name: string; parentId: string | null; sortOrder: number; categoryType: string; path?: string }> {
  return getKnowledgeIndex().categories.map((c) => ({
    id: c.id, name: c.name, parentId: c.parentId, sortOrder: c.sortOrder, categoryType: c.categoryType,
    // 图谱目录 scope：仓库内相对目录（迁移产物 dict 带 path；array 缺省）
    ...(c.path ? { path: c.path } : {}),
  }))
}

/** 目录的仓库内相对路径（无 path 条目=老格式/虚拟目录，返回 null）；供删除通道 trash 磁盘文件夹用 */
export function vaultGetCategoryRelPath(id: string): string | null {
  return getKnowledgeIndex().categories.find((c) => c.id === id)?.path ?? null
}

/** 目录条目（供创建笔记本等通道校验父级类型）；不存在返回 null */
export function vaultGetCategory(id: string): { id: string; name: string; categoryType: string; parentId: string | null; path?: string } | null {
  const c = getKnowledgeIndex().categories.find((x) => x.id === id)
  if (!c) return null
  return { id: c.id, name: c.name, categoryType: c.categoryType, parentId: c.parentId, ...(c.path ? { path: c.path } : {}) }
}

/** 从 categories.json 移除该目录及子孙条目并失效索引；磁盘文件夹由调用方先行 trash（2026-09-07 知识库开放目录删除） */
export function vaultDeleteCategory(id: string): void {
  removeCategoryEntries(id)
  invalidateKnowledgeIndex()
}

/** 新增目录条目（含 path 与磁盘文件夹由调用方先行创建）并失效索引（2026-09-07 知识库创建学习空间） */
export function vaultCreateCategory(entry: { id: string; name: string; categoryType: KnowledgeCategoryType; parentId: string | null; sortOrder?: number; path: string }): void {
  appendCategoryEntry(entry)
  invalidateKnowledgeIndex()
}

// ===== R6 回收站恢复放行（vault 模式）：恢复=按原 id 重写 md 文件 / mkdir 目录+字典条目 =====

/** R6 回收站恢复页面：frontmatter 带原 id/title/tags/starred/created/updated，body=contentMd；
 *  分类归属按 payload.categoryId 对应字典条目的 path 落位，条目不存在（或为 null）落收件箱；
 *  重复 id 报错（对齐原主键语义）。 */
export function vaultRestorePage(payload: {
  id: string
  title: string
  contentMd: string
  categoryId?: string | null
  tags?: Array<VaultTag | string>
  starred?: boolean
  sortOrder?: number
  fileType?: string
  createdAt?: string
  updatedAt?: string
}): void {
  if (getKnowledgeIndex().byId[payload.id]) throw new Error('页面已存在（可能已被恢复过）')
  const root = requireRoot()
  const dirRel = (payload.categoryId ? vaultGetCategoryRelPath(payload.categoryId) : null) ?? KB_INBOX_DIR
  const stem = sanitizeFileStem(payload.title || '恢复页面')
  const name = uniquePageName(dirRel, stem, root)
  const rel = `${dirRel}/${name}`
  const tagNames = [...new Set((payload.tags ?? []).map((t) => (typeof t === 'string' ? t : t.name)).filter(Boolean))]
  const fm: Record<string, unknown> = {
    id: payload.id,
    title: payload.title || stem,
    tags: tagNames,
    starred: !!payload.starred,
    sortOrder: payload.sortOrder ?? 0,
    status: 'published' as const,
    created: payload.createdAt || new Date().toISOString(),
    updated: payload.updatedAt || payload.createdAt || new Date().toISOString(),
  }
  if (payload.fileType) fm.fileType = payload.fileType
  if (!writeVaultFile(rel, serializeMarkdown(fm, payload.contentMd ?? ''))) throw new Error('页面文件写入失败')
  invalidateKnowledgeIndex()
}

/** R6 回收站恢复目录：mkdir 磁盘文件夹（已存在则复用）+ categories.json 追加条目（父级须在字典内且绑定 path）；
 *  重复 id 报错（对齐原主键语义）。索引失效由本函数负责，恢复批次内后续 path 查询会触发懒重建。 */
export function vaultRestoreCategory(payload: {
  id: string
  name: string
  parentId: string | null
  categoryType: KnowledgeCategoryType
  sortOrder?: number
}): void {
  if (getKnowledgeIndex().categories.some((c) => c.id === payload.id)) throw new Error('目录已存在（可能已被恢复过）')
  const name = payload.name.trim()
  if (!name) throw new Error('名称不能为空')
  if (/[\\/:*?"<>|]/.test(name)) throw new Error('名称不能包含 \\ / : * ? " < > | 等文件名字符')
  const parentPath = payload.parentId ? vaultGetCategoryRelPath(payload.parentId) : null
  if (payload.parentId && !parentPath) throw new Error('父目录不存在或未绑定仓库文件夹')
  const rel = parentPath ? `${parentPath}/${name}` : name
  const abs = join(requireRoot(), rel)
  if (!existsSync(abs)) mkdirSync(abs, { recursive: true })
  appendCategoryEntry({ id: payload.id, name, categoryType: payload.categoryType, parentId: payload.parentId, sortOrder: payload.sortOrder, path: rel })
  invalidateKnowledgeIndex()
}

// ===== 2026-09-07 知识库导入放行（vault 模式）：页面=frontmatter md 文件，二进制=附件目录 + 协议引用 =====

/** 与 importRepo.TEXT_EXTS 对齐的文本扩展名 */
const IMPORT_TEXT_EXTS = ['md', 'txt', 'json', 'cpp', 'c', 'h', 'hpp', 'py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'java', 'rs', 'go', 'sh', 'bat', 'xml', 'yaml', 'yml', 'sql', 'r', 'rb', 'php', 'swift', 'kt', 'lua', 'ini', 'cfg', 'toml']

function sanitizeFileStem(title: string): string {
  return title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim() || 'untitled'
}

/** 目录内取不重名的 .md 文件名（重名自动 (1)(2)，与文件夹去重同风格） */
function uniquePageName(dirRel: string, stem: string, root: string): string {
  let name = `${stem}.md`
  let n = 1
  while (existsSync(join(root, dirRel, name))) { name = `${stem}(${n}).md`; n++ }
  return name
}

/** vault 导入式建页：写带 frontmatter 的 .md 到目标目录（categoryId 目录，缺省落收件箱 .knowbase/_inbox）；status=published（导入即可见） */
export function vaultCreatePage(data: { title: string; contentMd: string; categoryId?: string | null; fileType?: string; tags?: string[] }): VaultPage {
  const root = requireRoot()
  const now = new Date().toISOString()
  const id = randomUUID()
  const dirRel = (data.categoryId ? vaultGetCategoryRelPath(data.categoryId) : null) ?? KB_INBOX_DIR
  const stem = sanitizeFileStem(data.title || '导入页面')
  const name = uniquePageName(dirRel, stem, root)
  const rel = `${dirRel}/${name}`
  // ★ fileType 必须真写进 frontmatter（B-4）：该参数此前被静默丢弃，而更新路径
  // （vaultUpdatePage，:210 `if (payload.fileType) fm.fileType = …`）却**会**写 —— 建页时缺、
  // 首次保存后才有，中间这段窗口下游（大纲 / 沉浸阅读 / AI 续写）全按空串处理。
  // 显式给了就用给的，没给一律 'md'（本函数落的文件恒是 .md）。
  const fm = { id, title: data.title || stem, fileType: data.fileType || 'md', tags: data.tags ?? [], starred: false, status: 'published' as const, created: now, updated: now }
  if (!writeVaultFile(rel, serializeMarkdown(fm, data.contentMd ?? ''))) throw new Error('页面文件写入失败')
  invalidateKnowledgeIndex()
  const entry = getKnowledgeIndex().byId[id]
  if (entry) return entryToPage(entry, data.contentMd ?? '')
  return { id, title: data.title || stem, contentMd: data.contentMd ?? '', contentHtml: '', annotationMd: '', categoryId: data.categoryId ?? null, isStarred: false, sortOrder: 0, fileType: 'md', attachmentId: '', createdAt: now, updatedAt: now, tags: (data.tags ?? []).map((t) => ({ id: t, name: t, color: '' })), path: rel, attachments: [] }
}

/** vault 导入文件夹：递归镜像为目录树（categories.json 条目）+ 文本文件转 frontmatter md；PDF/XMind 落附件目录并以协议引用挂入页面 */
export function vaultImportFolder(folderPath: string, parentCategoryId: string | null): { id: string; name: string; fileCount: number; folderCount: number } {  const root = requireRoot()
  const skipDirs = ['node_modules', '.git', '__pycache__', '.vscode', '.idea', 'dist', 'build', 'out', '.claude']
  let totalFolders = 0
  let totalFiles = 0
  /** 本次导入期间新建的目录（path→id）：appendCategoryEntry 只写字典不更新内存索引，去重须查它 */
  const pendingCategories = new Map<string, string>()

  /** 确保目录条目存在（同 path 复用），返回 id 与仓库相对路径 */
  const ensureCategory = (name: string, parentPath: string | null, parentId: string | null): { id: string; path: string } => {
    const path = parentPath ? `${parentPath}/${name}` : name
    const pendingId = pendingCategories.get(path)
    if (pendingId) return { id: pendingId, path }
    const existing = getKnowledgeIndex().categories.find((c) => c.path === path)
    if (existing) return { id: existing.id, path }
    const id = randomUUID()
    appendCategoryEntry({ id, name, categoryType: 'folder', parentId, path })
    pendingCategories.set(path, id)
    return { id, path }
  }

  const walk = (dir: string, catId: string | null, catPath: string | null): void => {
    let folders: string[] = []
    let files: string[] = []
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith('.')) continue
        const full = join(dir, entry)
        try { if (statSync(full).isDirectory()) folders.push(entry); else files.push(entry) } catch { /* skip */ }
      }
    } catch { return }
    for (const f of folders) {
      if (skipDirs.includes(f.toLowerCase())) continue
      const { id: subId, path: subPath } = ensureCategory(f, catPath, catId)
      totalFolders++
      walk(join(dir, f), subId, subPath)
    }
    const dirRel = catPath ?? KB_INBOX_DIR
    for (const f of files) {
      const ext = extname(f).slice(1).toLowerCase()
      const title = f.replace(new RegExp(`\\.${ext}$`, 'i'), '')
      try {
        if (ext === 'pdf' || ext === 'xmind') {
          // 二进制：附件落 .knowbase/_attachments/knowledge_page/<pageId>/，页面 md 挂协议引用（readPageDoc 已兼容）
          const pageId = randomUUID()
          const storeRel = ['.knowbase', '_attachments', 'knowledge_page', pageId, f].join('/')
          mkdirSync(dirname(join(root, storeRel)), { recursive: true })
          copyFileSync(join(dir, f), join(root, storeRel))
          const stem = sanitizeFileStem(title)
          const name = uniquePageName(dirRel, stem, root)
          const now = new Date().toISOString()
          const fm = { id: pageId, title, attachments: [storeRel], starred: false, status: 'published' as const, created: now, updated: now }
          const body = `${ext === 'pdf' ? 'PDF' : 'XMind'} 附件：${f}\n\nattachment://vault/${pageId}/${encodeURIComponent(f)}\n`
          if (writeVaultFile(`${dirRel}/${name}`, serializeMarkdown(fm, body))) totalFiles++
        } else if (IMPORT_TEXT_EXTS.includes(ext)) {
          const content = readFileSync(join(dir, f), 'utf-8')
          vaultCreatePage({ title, contentMd: content, categoryId: catId })
          totalFiles++
        }
      } catch { /* 单文件失败跳过，不中断整批导入 */ }
    }
  }

  const folderName = folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '导入文件夹'
  const parentPath = parentCategoryId ? vaultGetCategoryRelPath(parentCategoryId) : null
  const top = ensureCategory(folderName, parentPath, parentPath ? parentCategoryId : null)
  totalFolders++
  walk(folderPath, top.id, top.path)
  invalidateKnowledgeIndex()
  return { id: top.id, name: folderName, fileCount: totalFiles, folderCount: totalFolders }
}

/**
 * 语义对齐 knowledge:getPages：truthy=按分类，null=未分类，undefined=全部（均只含正式 published 页）
 *
 * 列表骨架（性能 2026-09-10）：只回元数据，**不回正文**。
 * 原先对每个 published 页调用 readPageDoc（逐页同步 readFileSync）——417 页实测 135ms，
 * 并把约 2MB 正文经 IPC 传给渲染层常驻。正文改由 vaultGetPageById 在打开时单独取。
 * attachments 一并省略：它是正文内的引用清单，列表不渲染。
 */
export function vaultGetPages(categoryId?: string | null): VaultPage[] {
  const idx = getKnowledgeIndex()
  let list = publishedOnly(idx.pages)
  if (categoryId) list = list.filter((e) => e.categoryId === categoryId)
  else if (categoryId === null) list = list.filter((e) => e.categoryId === null)
  return list.map((e) => entryToPage(e))
}

export function vaultGetPageById(id: string): VaultPage | null {
  const entry = getKnowledgeIndex().byId[id]
  if (!entry) return null
  // 非 md 文件：不读正文（二进制/HTML），渲染方式由渲染层按 entryKind 决定
  if (isNonMdArchiveEntry(entry)) return entryToPage(entry)
  const doc = readPageDoc(entry)
  return entryToPage(entry, doc.contentMd, doc.attachments)
}

/** 星标小编辑（读写分工拍板的例外）：frontmatter 重写、正文不动 */
export function vaultToggleStar(id: string): VaultPage | null {
  const entry = getKnowledgeIndex().byId[id]
  if (!entry) return null
  if (isWelcomeEntry(entry)) throw new Error(WELCOME_WRITE_DENY)
  if (isNonMdArchiveEntry(entry)) throw new Error(NON_MD_ARCHIVE_DENY)
  const abs = join(requireRoot(), entry.path)
  const doc = parseMarkdown(readFileSync(abs, 'utf-8'))
  const cur = String(doc.frontmatter.starred ?? '').toLowerCase() === 'true'
  doc.frontmatter.starred = cur ? 'false' : 'true'
  if (!writeVaultFile(entry.path, serializeMarkdown(doc.frontmatter, doc.body))) {
    throw new Error('星标写入失败')
  }
  invalidateKnowledgeIndex()
  const fresh = getKnowledgeIndex().byId[id]
  return fresh ? entryToPage(fresh, doc.body) : null
}

/**
 * 摘录导出覆盖重写（方案 C2 硬约束）：**只替换正文 body，frontmatter 原样保留**——
 * 尤其不能丢 `id`，否则页面变「无 id 的草稿」，知识库直接不显示（不变量 2）。
 * 风格照 vaultToggleStar：parseMarkdown → 替换 doc.body → serializeMarkdown → writeVaultFile → 失效索引。
 * 广播交给调用方（IPC 层统一广播，同其余 vault 写函数）。
 * 返回更新后的页面（含新正文）；页面不存在（被删）返回 null，由调用方走自愈新建分支。
 */
export function vaultExportExcerptsNote(pageId: string, contentMd: string): VaultPage | null {
  const entry = getKnowledgeIndex().byId[pageId]
  if (!entry) return null
  if (isWelcomeEntry(entry)) throw new Error(WELCOME_WRITE_DENY)
  if (isNonMdArchiveEntry(entry)) throw new Error(NON_MD_ARCHIVE_DENY)
  const abs = join(requireRoot(), entry.path)
  // 索引说在、盘上已不在（文件被应用外删掉 / 同步工具挪走，索引尚未失效）→ 视同「页不存在」。
  // 返回 null 走调用方的自愈分支（重建 + 回写新 id），否则 readFileSync 抛 ENOENT 把导出整个打断。
  if (!existsSync(abs)) {
    invalidateKnowledgeIndex()
    return null
  }
  const doc = parseMarkdown(readFileSync(abs, 'utf-8'))
  doc.body = contentMd
  if (!writeVaultFile(entry.path, serializeMarkdown(doc.frontmatter, doc.body))) {
    throw new Error('导出笔记写入失败')
  }
  invalidateKnowledgeIndex()
  const fresh = getKnowledgeIndex().byId[pageId]
  return fresh ? entryToPage(fresh, doc.body) : null
}

export function vaultGetStarredPages(): VaultPage[] {
  return publishedOnly(getKnowledgeIndex().pages)
    .filter((e) => e.starred)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((e) => entryToPage(e))
}

export function vaultGetTags(): VaultTag[] {
  const seen = new Map<string, VaultTag>()
  for (const p of publishedOnly(getKnowledgeIndex().pages)) {
    for (const name of p.tags) {
      if (!seen.has(name)) seen.set(name, { id: name, name, color: '#6b7280' })
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans'))
}

function buildExcerpt(plain: string, terms: string[], radius = 60): string {
  if (!plain) return ''
  const lower = plain.toLowerCase()
  let idx = -1
  for (const t of terms) {
    if (!t) continue
    idx = lower.indexOf(t.toLowerCase())
    if (idx >= 0) break
  }
  if (idx < 0) return ''
  const start = Math.max(0, idx - radius)
  const end = Math.min(plain.length, idx + radius)
  return (start > 0 ? '…' : '') + plain.slice(start, end).trim() + (end < plain.length ? '…' : '')
}

/** 全文搜索：每个词都须命中（标题/标签/正文），最多 50 条，摘录不回传大字段 */
export function vaultSearchPages(q: string): Array<VaultPage & { excerpt: string }> {
  const terms = q.trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  const idx = getKnowledgeIndex()
  // 性能 2026-09-10：正文取自预建的纯文本索引，不再逐页 readFileSync
  // （417 页实测：68ms 全盘读 → 一次 JSON 读取 + 内存检索）
  const textById = getKnowledgeTextIndex()
  const out: Array<VaultPage & { excerpt: string }> = []
  for (const entry of publishedOnly(idx.pages)) {
    const plain = textById[entry.id] ?? ''
    const lower = plain.toLowerCase()
    const titleHit = terms.every((t) => entry.title.toLowerCase().includes(t.toLowerCase()))
    const tagHit = terms.every((t) => entry.tags.some((tag) => tag.toLowerCase().includes(t.toLowerCase())))
    const bodyHit = terms.every((t) => lower.includes(t.toLowerCase()))
    if (!titleHit && !tagHit && !bodyHit) continue
    const { path: _p, ...slim } = entryToPage(entry, '')
    void _p
    out.push({ ...slim, path: entry.path, excerpt: buildExcerpt(plain, terms) || entry.title })
    if (out.length >= 50) break
  }
  return out
}

// ===== R2/R4 反链：GraphIndex 统一链接解析（resolved incoming，不再按标题字符串匹配） =====

export interface VaultBacklinkContextItem {
  id: string
  title: string
  fileType: string
  updatedAt: string
  excerpt: string
}

/** 反链源页列表（knowledge:getBacklinks vault 分支，DTO 对齐 sqlite 版 mapPage 的骨架字段） */
export function vaultGetBacklinks(pageId: string): VaultPage[] {
  const idx = getKnowledgeIndex()
  const page = idx.byId[pageId]
  if (!page) return []
  const srcIds = getGraphIndex().incoming[pageId] || []
  const rows = srcIds
    .map((id) => idx.byId[id])
    .filter((p): p is KnowledgePageIndexEntry => !!p && p.id !== pageId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return rows.map((e) => entryToPage(e, ''))
}

/** 反链上下文摘录：定位源页正文中 resolve 到本页的 [[引用]] 处，取前后约 60 字符（与图谱同一解析口径） */
export function vaultGetBacklinkContext(pageId: string): VaultBacklinkContextItem[] {
  const idx = getKnowledgeIndex()
  const root = requireRoot()
  const page = idx.byId[pageId]
  if (!page) return []
  const srcIds = getGraphIndex().incoming[pageId] || []
  if (srcIds.length === 0) return []
  const resolver = createLinkResolver(idx)
  const out: VaultBacklinkContextItem[] = []
  const sources = srcIds
    .map((id) => idx.byId[id])
    .filter((p): p is KnowledgePageIndexEntry => !!p && p.id !== pageId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  for (const src of sources) {
    let excerpt = ''
    try {
      const raw = readFileSync(join(root, src.path), 'utf-8')
      const re = /\[\[([^\]]+)\]\]/g
      let m: RegExpExecArray | null
      let hitIdx = -1
      while ((m = re.exec(raw)) !== null) {
        if (resolver.resolve(m[1].split('|')[0]) === pageId) {
          hitIdx = m.index
          break
        }
      }
      if (hitIdx >= 0) {
        const start = Math.max(0, hitIdx - 60)
        const end = Math.min(raw.length, hitIdx + 70)
        excerpt = ((start > 0 ? '…' : '') + raw.slice(start, end) + (end < raw.length ? '…' : '')).replace(/\s+/g, ' ').trim()
      }
    } catch {
      /* 文件读失败时只给条目不带摘录 */
    }
    out.push({
      id: src.id,
      title: src.title,
      fileType: src.fileType.replace(/^\./, '').toLowerCase(),
      updatedAt: src.updatedAt,
      excerpt,
    })
  }
  return out
}

// ===== 2026-09-07 重命名/排序放行（vault 模式）：目录=磁盘改名+字典级联；页面=文件改名+frontmatter =====

/** vault 目录重命名：磁盘文件夹改名 + 字典条目 name/path 及子孙 path 级联更新 */
export function vaultRenameCategory(id: string, newName: string): void {
  const c = vaultGetCategory(id)
  if (!c) throw new Error('目录不存在')
  const clean = newName.trim()
  if (!clean) throw new Error('名称不能为空')
  if (/[\\/:*?"<>|]/.test(clean)) throw new Error('名称不能包含 \\ / : * ? " < > | 等文件名字符')
  if (clean === c.name) return
  if (!c.path) { updateCategoryEntry(id, { name: clean }); invalidateKnowledgeIndex(); return }
  const root = requireRoot()
  const rootAbs = resolvePath(root)
  const oldAbs = resolvePath(join(root, c.path))
  if (oldAbs !== rootAbs && !oldAbs.startsWith(rootAbs + sep)) throw new Error('目录路径越界')
  const newAbs = join(c.path.includes('/') ? rootAbs + sep + c.path.slice(0, c.path.lastIndexOf('/')).replace(/\//g, sep) : rootAbs, clean)
  if (existsSync(newAbs)) throw new Error(`同名文件夹「${clean}」已存在`)
  renameSync(oldAbs, newAbs)
  const parentRel = c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : null
  const newPath = parentRel ? `${parentRel}/${clean}` : clean
  renameCategoryCascade(id, clean, c.path, newPath)
  invalidateKnowledgeIndex()
}

/** vault 页面重命名：md 文件随标题改名（同目录冲突报错）+ frontmatter title 更新 */
export function vaultRenamePage(id: string, newTitle: string): void {
  const idx = getKnowledgeIndex()
  const entry = idx.byId[id]
  if (!entry) throw new Error('页面不存在')
  if (isWelcomeEntry(entry)) throw new Error(WELCOME_WRITE_DENY) // 欢迎页拒绝改名（会连带改成 .md）
  if (isNonMdArchiveEntry(entry)) throw new Error(NON_MD_ARCHIVE_DENY)
  const clean = newTitle.trim()
  if (!clean) throw new Error('名称不能为空')
  const root = requireRoot()
  const oldAbs = join(root, entry.path)
  const slash = entry.path.lastIndexOf('/')
  const dirRel = slash >= 0 ? entry.path.slice(0, slash) : ''
  const oldName = entry.path.slice(slash + 1)
  const stem = sanitizeFileStem(clean)
  let finalStem = stem
  if (`${stem}.md` !== oldName && existsSync(join(root, dirRel, `${stem}.md`))) {
    throw new Error(`同名文件「${stem}.md」已存在`)
  }
  if (`${stem}.md` !== oldName) {
    renameSync(oldAbs, join(root, dirRel, `${stem}.md`))
    finalStem = stem
  }
  const targetPath = dirRel ? `${dirRel}/${finalStem}.md` : `${finalStem}.md`
  const doc = parseMarkdown(readFileSync(join(root, targetPath), 'utf-8'))
  doc.frontmatter.title = clean
  if (!writeVaultFile(targetPath, serializeMarkdown(doc.frontmatter, doc.body))) throw new Error('重命名写入失败')
  invalidateKnowledgeIndex()
}

/** vault 目录排序：categories.json 同父级规范化重编号后与相邻项互换 */
export function vaultMoveCategoryOrder(id: string, direction: 'up' | 'down'): void {
  moveCategoryOrderInDict(id, direction)
  invalidateKnowledgeIndex()
}

/** vault 页面排序：同目录页面按现行排序规则排定后与相邻项互换，重写 frontmatter.sortOrder（仅写变化者） */
export function vaultMovePageOrder(id: string, direction: 'up' | 'down'): void {
  const idx = getKnowledgeIndex()
  const me = idx.byId[id]
  if (!me) throw new Error('页面不存在')
  if (isWelcomeEntry(me)) throw new Error(WELCOME_WRITE_DENY)
  if (isNonMdArchiveEntry(me)) throw new Error(NON_MD_ARCHIVE_DENY)
  const root = requireRoot()
  const dirOf = (p: string): string => { const s = p.lastIndexOf('/'); return s >= 0 ? p.slice(0, s) : '' }
  const dirRel = dirOf(me.path)
  // 欢迎页与非 md 归档文件不参与同目录排序（没有 frontmatter，写 sortOrder 会毁掉文件）
  const siblings = idx.pages.filter((p) => dirOf(p.path) === dirRel && !isWelcomeEntry(p) && !isNonMdArchiveEntry(p))
  siblings.sort((a, b) => a.sortOrder - b.sortOrder || b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title, 'zh-Hans'))
  const i = siblings.findIndex((p) => p.id === id)
  if (i < 0) return
  const j = direction === 'up' ? i - 1 : i + 1
  if (j < 0 || j >= siblings.length) return // 已在顶部/底部
  const arr = [...siblings]
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
  arr.forEach((p, order) => {
    if (p.sortOrder === order) return
    try {
      const abs = join(root, p.path)
      const doc = parseMarkdown(readFileSync(abs, 'utf-8'))
      doc.frontmatter.sortOrder = order
      writeVaultFile(p.path, serializeMarkdown(doc.frontmatter, doc.body))
    } catch { /* 单文件失败跳过 */ }
  })
  invalidateKnowledgeIndex()
}
