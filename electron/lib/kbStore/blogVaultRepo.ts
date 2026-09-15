import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { getCurrentVault } from './vaultContext'
import { parseMarkdown, serializeMarkdown } from './mdStore'
// 总结文件命名与窗口口径的**单一真相源**在渲染层 `src/lib/summary.ts`（纯函数、无副作用），
// 主进程直接引它而不是各写一份 —— 否则「磁贴点周号算出的窗口」与「落盘文件名」迟早对不上。
// 先例：`electron/main/index.ts` 引 `src/lib/settings`。
import { summaryFileName, summaryLabel, type SummaryKind } from '../../../src/lib/summary'

/**
 * 博客 vault 数据仓库（去库化 P1：博客(.md) + 索引，见 .AGENT/docs/去库化迁移方案.md）
 *
 * 存储形态（D3 定稿 2026-09-06：博客整体收进 .knowbase）：
 *   <Vault>/.knowbase/blog/<年份>/<日期>.md    正文 + frontmatter 元数据（每天一篇）
 *   （旧版曾放仓库根 `blog/`，由 migrateBlogLayoutIntoKnowbase 一次性迁入，幂等）
 * frontmatter 字段：id / title / date / created / updated / pinned / starred /
 *                   wordCount / states / tags(names[])
 *
 * tag 约定：id = name（博客个人 tag，同名即同 tag；color 由 tagRepo 层归一为空）
 * 纯函数模块：不 import electron / sqlite，可 node 冒烟；回收站写入由调用方（entryRepo）完成。
 * 与 entryRepo.rowToEntry 的 DTO 对齐，渲染层无感切换。
 */

export interface VaultBlogTag { id: string; name: string; color: string }
export interface VaultBlogEntry {
  id: string
  title: string
  contentMd: string
  contentHtml: string
  date: string
  createdAt: string
  updatedAt: string
  isPinned: boolean
  isStarred: boolean
  wordCount: number
  states: string
  tags: VaultBlogTag[]
}

export interface BlogListFilter {
  date?: string
  tagId?: string
  pinnedOnly?: boolean
  starredOnly?: boolean
  limit?: number
  offset?: number
}

export interface BlogSaveResult {
  entry: VaultBlogEntry
  /** 原文件被移动（改日期）时给出旧相对路径，供删除 */
  oldPath?: string
}

export interface BlogDeleteInfo {
  id: string
  title: string
  date: string
  data: string // recycle_bin.data 兼容载荷（JSON.stringify 全文）
}

interface BlogDoc {
  path: string
  fm: Record<string, unknown>
  body: string
}

function requireRoot(): string {
  const cur = getCurrentVault()
  if (!cur) throw new Error('当前没有打开的仓库')
  return cur.rootPath
}

/** 博客数据区（D3）：.knowbase/blog/（对其他软件不可见，随仓库走） */
function blogRoot(): string {
  return join(requireRoot(), '.knowbase', 'blog')
}

/**
 * 总结分区目录名（相对 blogRoot）。
 *
 * ⚠️ 日志扫描必须**整个目录跳过**（见 `readAllDocs`）：总结文件同样带 frontmatter.id，
 * 若被日志扫描收走就会混进博客列表 / 标签聚合 / 全文搜索。
 * 这是一条**结构性隔离**，不是靠事后 filter 兜——filter 漏一处就静默出错。
 */
const SUMMARY_DIR = 'summaries'

/** 字数：去空白后的字符数（与 sqlite word_count 维护口径一致） */
function countWords(md: string): number {
  return md.replace(/\s/g, '').length
}

function boolOf(fm: Record<string, unknown>, k: string): boolean {
  const v = fm[k]
  return v === true || v === 'true' || v === 1 || v === '1'
}

function strOf(fm: Record<string, unknown>, k: string, fallback = ''): string {
  const v = fm[k]
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return fallback
}

function tagsOf(fm: Record<string, unknown>): VaultBlogTag[] {
  const raw = fm.tags
  const names = Array.isArray(raw)
    ? raw.map((t) => String(t)).filter(Boolean)
    : typeof raw === 'string'
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : []
  // 去重保序
  return [...new Set(names)].map((name) => ({ id: name, name, color: '' }))
}

/** 全量读取 blog 目录树下所有 .md（幂等小体量：个人博客几十~几百篇，直接扫目录最可靠） */
function readAllDocs(): BlogDoc[] {
  const root = blogRoot()
  if (!existsSync(root)) return []
  const docs: BlogDoc[] = []
  const walk = (dir: string): void => {
    let names: string[] = []
    try { names = readdirSync(dir) } catch { return }
    for (const n of names) {
      const p = join(dir, n)
      let isDir = false
      try { isDir = statSync(p).isDirectory() } catch { continue }
      // 总结分区不进日志（结构性隔离，见 SUMMARY_DIR 注释）；年份目录照常下钻
      if (isDir) { if (n === SUMMARY_DIR) continue; walk(p); continue }
      if (n.toLowerCase().endsWith('.md')) {
        try {
          const raw = readFileSync(p, 'utf-8')
          const doc = parseMarkdown(raw)
          const id = doc.frontmatter?.id
          if (id && typeof id === 'string') docs.push({ path: p, fm: doc.frontmatter ?? {}, body: doc.body })
        } catch { /* 跳过坏文件 */ }
      }
    }
  }
  walk(root)
  return docs
}

function docToEntry(doc: BlogDoc): VaultBlogEntry {
  const date = strOf(doc.fm, 'date')
  const createdAt = strOf(doc.fm, 'created', new Date().toISOString())
  const updatedAt = strOf(doc.fm, 'updated', createdAt)
  return {
    id: strOf(doc.fm, 'id'),
    title: strOf(doc.fm, 'title', date),
    contentMd: doc.body,
    contentHtml: '',
    date,
    createdAt,
    updatedAt,
    isPinned: boolOf(doc.fm, 'pinned'),
    isStarred: boolOf(doc.fm, 'starred'),
    wordCount: countWords(doc.body),
    states: strOf(doc.fm, 'states'),
    tags: tagsOf(doc.fm),
  }
}

/** 文件绝对路径：blog/<年>/<date>.md */
function fileFor(date: string): string {
  const year = (date.slice(0, 4) || 'misc').replace(/[^0-9]/g, '') || 'misc'
  return join(blogRoot(), year, `${date}.md`)
}

/** 原子写文件 */
function atomicWrite(absPath: string, content: string): void {
  mkdirSync(dirname(absPath), { recursive: true })
  const tmp = join(dirname(absPath), `.${randomUUID()}.tmp`)
  writeFileSync(tmp, content, 'utf-8')
  try { renameSync(tmp, absPath) } catch {
    try { if (existsSync(absPath)) unlinkSync(absPath) } catch { /* ignore */ }
    renameSync(tmp, absPath)
  }
}

// ===== 读 =====

export function vaultListEntries(filter: BlogListFilter = {}): VaultBlogEntry[] {
  const docs = readAllDocs().filter((d) => {
    const e = docToEntry(d)
    if (filter.date !== undefined && e.date !== filter.date) return false
    if (filter.tagId !== undefined && !e.tags.some((t) => t.id === filter.tagId)) return false
    if (filter.pinnedOnly && !e.isPinned) return false
    if (filter.starredOnly && !e.isStarred) return false
    return true
  })
  docs.sort((a, b) => {
    const ea = docToEntry(a); const eb = docToEntry(b)
    if (ea.isPinned !== eb.isPinned) return ea.isPinned ? -1 : 1
    if (ea.isStarred !== eb.isStarred) return ea.isStarred ? -1 : 1
    return eb.createdAt.localeCompare(ea.createdAt)
  })
  const start = filter.offset ?? 0
  const end = filter.limit !== undefined ? start + filter.limit : undefined
  return docs.slice(start, end).map(docToEntry)
}

export function vaultGetEntryById(id: string): VaultBlogEntry | null {
  const doc = readAllDocs().find((d) => d.fm.id === id)
  return doc ? docToEntry(doc) : null
}

export function vaultSearchEntries(q: string): VaultBlogEntry[] {
  const s = q.toLowerCase()
  return readAllDocs()
    .filter((d) => strOf(d.fm, 'title').toLowerCase().includes(s) || d.body.toLowerCase().includes(s))
    .sort((a, b) => strOf(b.fm, 'created').localeCompare(strOf(a.fm, 'created')))
    .slice(0, 50)
    .map(docToEntry)
}

/** 聚合全部 tag（id=name 约定） */
export function vaultBlogTags(): VaultBlogTag[] {
  const names = new Set<string>()
  for (const d of readAllDocs()) for (const t of tagsOf(d.fm)) names.add(t.name)
  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ id: name, name, color: '' }))
}

// ===== 写 =====

/**
 * 新建博文：每天一篇。目标日期已有 → 返回既有（与 sqlite createEntry 的防重对齐）。
 */
export function vaultCreateEntry(data: { title?: string; contentMd?: string; date: string; tags?: string[]; states?: string }): VaultBlogEntry {
  const docs = readAllDocs()
  const existing = docs.find((d) => d.fm.date === data.date)
  if (existing) return docToEntry(existing)

  const id = randomUUID()
  const now = new Date().toISOString()
  const body = data.contentMd || ''
  const abs = fileFor(data.date)
  const fm: Record<string, unknown> = {
    id,
    title: data.title || data.date,
    date: data.date,
    created: now,
    updated: now,
    pinned: false,
    starred: false,
    wordCount: countWords(body),
    states: data.states || '',
  }
  if (data.tags && data.tags.length > 0) fm.tags = [...new Set(data.tags.filter(Boolean))]
  atomicWrite(abs, serializeMarkdown(fm, body))
  const doc = { path: abs, fm, body }
  return docToEntry(doc)
}

/**
 * 更新博文。改日期时若目标日期已被其它篇占用 → throw（对齐 sqlite 防撞逻辑）。
 */
export function vaultUpdateEntry(
  id: string,
  data: { title?: string; contentMd?: string; date?: string; isPinned?: boolean; isStarred?: boolean; tags?: string[]; states?: string },
): BlogSaveResult {
  const docs = readAllDocs()
  const doc = docs.find((d) => d.fm.id === id)
  if (!doc) throw new Error('博文不存在')
  const fm = { ...doc.fm }
  const body = data.contentMd !== undefined ? data.contentMd : doc.body

  if (data.date !== undefined && data.date !== fm.date) {
    const dup = docs.find((d) => d.fm.date === data.date && d.fm.id !== id)
    if (dup) throw new Error('该日期已存在日记(每天一篇),请换一个日期')
    fm.date = data.date
  }
  if (data.title !== undefined) fm.title = data.title
  if (data.states !== undefined) fm.states = data.states
  if (data.isPinned !== undefined) fm.pinned = data.isPinned
  if (data.isStarred !== undefined) fm.starred = data.isStarred
  fm.updated = new Date().toISOString()
  fm.wordCount = countWords(body)
  if (data.tags !== undefined) {
    fm.tags = [...new Set(data.tags.filter(Boolean))]
  }

  const newDate = strOf(fm, 'date')
  const newAbs = fileFor(newDate)
  const dateChanged = newAbs !== doc.path
  const finalAbs = dateChanged ? newAbs : doc.path
  atomicWrite(finalAbs, serializeMarkdown(fm, body))
  if (dateChanged && doc.path !== finalAbs) {
    try { if (existsSync(doc.path)) unlinkSync(doc.path) } catch { /* ignore */ }
  }
  return { entry: docToEntry({ path: finalAbs, fm, body }), oldPath: dateChanged ? doc.path.slice(blogRoot().length + 1) : undefined }
}

/**
 * 删除博文：删除 md 文件并返回回收站载荷（写入 recycle_bin 由调用方完成）。
 * 找不到返回 null。
 */
export function vaultDeleteEntry(id: string): BlogDeleteInfo | null {
  const doc = readAllDocs().find((d) => d.fm.id === id)
  if (!doc) return null
  const e = docToEntry(doc)
  try { if (existsSync(doc.path)) unlinkSync(doc.path) } catch { /* ignore */ }
  // 空目录清理（顺带删掉空年份目录）
  try {
    const dir = dirname(doc.path)
    if (existsSync(dir) && readdirSync(dir).length === 0) unlinkSync(dir)
  } catch { /* ignore */ }
  const data = JSON.stringify({
    id: e.id,
    title: e.title,
    contentMd: e.contentMd,
    contentHtml: '',
    date: e.date,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    isPinned: e.isPinned,
    wordCount: e.wordCount,
    states: e.states,
    tags: e.tags,
  })
  return { id: e.id, title: e.title, date: e.date, data }
}

/** 从全部博文移除某 tag（tagRepo 删除 tag 用） */
export function vaultRemoveTagFromAll(tagName: string): number {
  const docs = readAllDocs()
  let touched = 0
  for (const d of docs) {
    const cur = tagsOf(d.fm)
    if (!cur.some((t) => t.name === tagName)) continue
    const next = cur.filter((t) => t.name !== tagName).map((t) => t.name)
    const fm = { ...d.fm }
    if (next.length > 0) fm.tags = next
    else delete fm.tags
    fm.updated = new Date().toISOString()
    atomicWrite(d.path, serializeMarkdown(fm, d.body))
    touched++
  }
  return touched
}

// ===== 层级总结（周 / 月 / 年）：.knowbase/blog/summaries/<summary-*.md> =====
//
// 与日志的区别（三处，缺一处就会串）：
//   ① 目录：住在 summaries/ 分区，与 <年份>/ 平级 —— 日志扫描整个目录跳过；
//   ② 字段：frontmatter 用 kind/start/end 定位窗口，**没有 date**（不参与「每天一篇」的防撞）；
//   ③ 内容：正文 = 复盘文字（用户写），统计数字仍实时查询、绝不落库（DP 第 12 项拍板③）。

export interface VaultSummary {
  id: string
  kind: SummaryKind
  start: string
  end: string
  title: string
  contentMd: string
  createdAt: string
  updatedAt: string
}

function summaryRoot(): string {
  return join(blogRoot(), SUMMARY_DIR)
}

/**
 * 读总结分区下所有 .md（**不递归**：分区是扁平的）。
 * 只认 kind/start/end 齐全的文件 —— 缺字段的半成品没有窗口可对上，列出来只会让入口显示错行。
 */
function readSummaryDocs(): BlogDoc[] {
  const root = summaryRoot()
  if (!existsSync(root)) return []
  let names: string[] = []
  try { names = readdirSync(root) } catch { return [] }
  const out: BlogDoc[] = []
  for (const n of names) {
    if (!n.toLowerCase().endsWith('.md')) continue
    const p = join(root, n)
    try {
      const doc = parseMarkdown(readFileSync(p, 'utf-8'))
      const fm = doc.frontmatter ?? {}
      const kind = strOf(fm, 'kind')
      if (kind !== 'week' && kind !== 'month' && kind !== 'year') continue
      if (!strOf(fm, 'start') || !strOf(fm, 'end')) continue
      out.push({ path: p, fm, body: doc.body })
    } catch { /* 跳过坏文件 */ }
  }
  return out
}

function docToSummary(doc: BlogDoc): VaultSummary {
  const createdAt = strOf(doc.fm, 'created', new Date().toISOString())
  return {
    id: strOf(doc.fm, 'id'),
    kind: strOf(doc.fm, 'kind') as SummaryKind,
    start: strOf(doc.fm, 'start'),
    end: strOf(doc.fm, 'end'),
    title: strOf(doc.fm, 'title'),
    contentMd: doc.body,
    createdAt,
    updatedAt: strOf(doc.fm, 'updated', createdAt),
  }
}

/** 全部总结（窗口起点倒序，新的在前） */
export function vaultListSummaries(): VaultSummary[] {
  return readSummaryDocs().map(docToSummary).sort((a, b) => b.start.localeCompare(a.start))
}

export function vaultGetSummaryById(id: string): VaultSummary | null {
  const doc = readSummaryDocs().find((d) => d.fm.id === id)
  return doc ? docToSummary(doc) : null
}

/**
 * 按需生成：**同窗口幂等**（同窗口必同文件，不产生第二份）。三种落点都要对：
 *   ① 已有同窗口总结（哪怕用户手改过文件名）→ 按 kind/start/end 三元组命中，直接返回；
 *   ② 目标文件已存在但 frontmatter 缺 id → **补 id 写回**（保住用户已写下的正文），不另建；
 *   ③ 都没有 → 新建空壳（只写 frontmatter、正文留空）。
 * 不预填模板、不做总结日空壳 —— 「按需生成，不堆空文件」（DP 第 12 项拍板②）。
 */
export function vaultEnsureSummary(kind: SummaryKind, start: string, end: string): VaultSummary {
  const hit = readSummaryDocs().find(
    (d) => strOf(d.fm, 'kind') === kind && strOf(d.fm, 'start') === start && strOf(d.fm, 'end') === end,
  )
  if (hit) return docToSummary(hit)

  const now = new Date().toISOString()
  const title = summaryLabel(kind, start, end)
  const abs = join(summaryRoot(), summaryFileName(kind, start, end))

  if (existsSync(abs)) {
    try {
      const doc = parseMarkdown(readFileSync(abs, 'utf-8'))
      const fm = { ...(doc.frontmatter ?? {}) }
      if (!fm.id) {
        fm.id = randomUUID()
        fm.kind = kind
        fm.start = start
        fm.end = end
        if (!fm.title) fm.title = title
        fm.created = strOf(fm, 'created', now)
        fm.updated = now
        fm.wordCount = countWords(doc.body)
        atomicWrite(abs, serializeMarkdown(fm, doc.body))
        return docToSummary({ path: abs, fm, body: doc.body })
      }
    } catch { /* 读坏了 → 走下面重建 */ }
  }

  const fm: Record<string, unknown> = {
    id: randomUUID(), kind, start, end, title, created: now, updated: now, wordCount: 0,
  }
  atomicWrite(abs, serializeMarkdown(fm, ''))
  return docToSummary({ path: abs, fm, body: '' })
}

/** 保存总结正文（按 id 定位；窗口字段 kind/start/end 不可改 —— 改了就等于换了文件） */
export function vaultUpdateSummary(id: string, data: { contentMd?: string; title?: string }): VaultSummary {
  const doc = readSummaryDocs().find((d) => d.fm.id === id)
  if (!doc) throw new Error('总结不存在')
  const fm = { ...doc.fm }
  const body = data.contentMd !== undefined ? data.contentMd : doc.body
  if (data.title !== undefined) fm.title = data.title
  fm.updated = new Date().toISOString()
  fm.wordCount = countWords(body)
  atomicWrite(doc.path, serializeMarkdown(fm, body))
  return docToSummary({ path: doc.path, fm, body })
}

/** 便于冒烟/测试定位数据目录 */
export const __blogRoot = blogRoot
/** 便于冒烟/测试定位总结分区 */
export const __summaryRoot = summaryRoot
