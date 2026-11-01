import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join, relative } from 'path'
import { randomUUID } from 'crypto'
import { getCurrentVault, ATTACHMENTS_DIR, KB_ATTACHMENTS_DIR } from 'phrontis-core/kbStore/vaultContext'
import { readJson, writeJson } from 'phrontis-core/kbStore/jsonStore'
import { parseMarkdown, serializeMarkdown } from 'phrontis-core/kbStore/mdStore'

/**
 * 内容型插件（knowledgePages）知识包 → Vault 批量写页引擎（去库化适配）。
 *
 * 背景：知识库默认 vault 读源后，直写 sqlite 的旧导入会"导了但看不到"。
 * 本模块在 storageKnowledge=vault 时替代 importPack 的 sqlite 写入：
 *   - 空间/笔记本/章节 → .knowbase/modules/knowledge/categories.json
 *   - 页面        → 仓库内容目录 空间/笔记本/章节/<标题>.md（frontmatter 挂知识页元数据）
 *   - 图片        → 复制到 .attachments/knowledge_page/<pageId>/ 并改写协议引用（D1 定稿；旧包不搬迁，兼容读取）
 *   - 映射        → .knowbase/modules/knowledge/pack-imports.json（幂等/更新/本地修改保护）
 * 纯函数（不 import electron），可对真实插件包做 node 冒烟。
 */

export interface VaultPackImportResult {
  ok: boolean
  created?: number
  updated?: number
  skipped?: number
  conflicts?: { title: string; reason: string; externalId: string }[]
  spaceId?: string | null
  message?: string
}

export interface VaultPackState {
  ok: boolean
  state?: 'not-imported' | 'imported' | 'update-available'
  version?: string
  chapters?: number
  totalPages?: number
  newPages?: number
  changedPages?: number
  lastImportedAt?: string
  spaceId?: string | null
  spaceName?: string
  message?: string
}

interface KV { id: string; name: string; parentId: string | null; sortOrder: number; categoryType: string }
interface MapRow {
  plugin_id: string; external_id: string; page_id: string; rel_path: string
  content_hash: string; pack_version: string; space_id: string | null; imported_at: string
}
interface PageMeta { externalId: string; title: string; file: string; tags?: string[] }

function requireRoot(): string {
  const cur = getCurrentVault()
  if (!cur) throw new Error('当前没有打开的仓库')
  return cur.rootPath
}
function relOf(abs: string, root: string): string {
  return relative(root, abs).replace(/\\/g, '/')
}
function sanitizeTitle(t: string): string {
  const s = t.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim()
  return s || 'untitled'
}
/** 从 page md 所在目录到仓库根 .knowbase 的相对路径（图片改写用） */
// 已废弃（改为 attachment://vault 协议引用）：保留仅防历史调用编译错，新导入不再使用
function relToAttachments(fileDir: string, root: string, tail: string): string {
  const kbAtt = join(root, KB_ATTACHMENTS_DIR)
  const p = relative(fileDir, join(kbAtt, tail)).replace(/\\/g, '/')
  return p.startsWith('.') ? p : `./${p}`
}
function hashOf(buf: Buffer): string {
  let h = 0x811c9dc5
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i]
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

function readCat(root: string): KV[] {
  return readJson<KV[]>('modules/knowledge', 'categories.json', [])
}
function writeCat(root: string, rows: KV[]): void {
  void root
  writeJson('modules/knowledge', 'categories.json', rows)
}
function readMapping(root: string, pluginId: string): MapRow[] {
  const all = readJson<MapRow[]>('modules/knowledge', 'pack-imports.json', [])
  return all.filter((r) => r.plugin_id === pluginId)
}
function writeMappingRow(root: string, row: MapRow): void {
  void root
  const all = readJson<MapRow[]>('modules/knowledge', 'pack-imports.json', [])
  const rest = all.filter((r) => !(r.plugin_id === row.plugin_id && r.external_id === row.external_id))
  writeJson('modules/knowledge', 'pack-imports.json', [...rest, row])
}
function readPageMd(pluginDir: string, file: string): { buf: Buffer } | { error: string } {
  // manifest page.file 自带 'pages/' 前缀（如 pages/mayuan/xx.md）
  const p = join(pluginDir, file)
  if (!existsSync(p)) return { error: `页面文件缺失: ${file}` }
  const buf = readFileSync(p)
  if (buf.length > 512 * 1024) return { error: `页面超过 512KB 限制: ${file}` }
  return { buf }
}

/** 复制 md 内相对图片到 .attachments/knowledge_page/<pageId>，返回改写后的正文（旧 `/_attachments/` 引用跳过不改写，兼容读取） */
function stageImages(body: string, pluginDir: string, pageFile: string, pageId: string, fileDir: string, root: string, staged: string[]): string {
  const srcDir = join(pluginDir, dirname(pageFile))
  const attTail = `knowledge_page/${pageId}`
  let out = body
  const re = /!\[[^\]]*\]\(([^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const ref = m[1].trim().replace(/^<|>$/g, '')
    if (/^(https?:)?\/\//i.test(ref) || /^(attachment|file):/i.test(ref) || ref.includes('/_attachments/') || ref.startsWith('.knowbase')) continue
    const base = ref.split(/[\\/]/).pop()!
    if (!base) continue
    const src = join(srcDir, ref.replace(/\\/g, '/').replace(/^\//, ''))
    if (!existsSync(src)) continue
    const attDir = join(root, ATTACHMENTS_DIR, attTail)
    mkdirSync(attDir, { recursive: true })
    const dst = join(attDir, base)
    // copy 而非 move：插件包源文件必须保留（可重复导入）
    if (!existsSync(dst)) { copyFileSync(src, dst) }
    staged.push(dst)
    // 协议引用（非相对路径）：attachment://vault/<pageId>/<file> —— 页面/仓库移动不断链
    out = out.split(ref).join(`attachment://vault/${pageId}/${base}`)
  }
  return out
}

function spaceDirName(root: string, name: string): string {
  return join(root, sanitizeTitle(name))
}
function findOrCreateNode(root: string, cats: KV[], parentId: string | null, name: string, type: string): { id: string; cats: KV[] } {
  const hit = cats.find((c) => c.parentId === parentId && c.name === name && c.categoryType === type)
  if (hit) return { id: hit.id, cats }
  const order = cats.filter((c) => c.parentId === parentId).reduce((mx, c) => Math.max(mx, c.sortOrder), -1) + 1
  const node: KV = { id: randomUUID(), name, parentId, sortOrder: order, categoryType: type }
  return { id: node.id, cats: [...cats, node] }
}

/** 幂等建空间（同名存在复用；否则新建空间） */
function ensureSpace(cats: KV[], baseName: string): { id: string; cats: KV[]; created: boolean } {
  const exist = cats.find((c) => c.parentId === null && c.categoryType === 'space' && c.name === baseName)
  if (exist) return { id: exist.id, cats, created: false }
  const order = cats.filter((c) => c.parentId === null).reduce((mx, c) => Math.max(mx, c.sortOrder), -1) + 1
  const id = randomUUID()
  return { id, cats: [...cats, { id, name: baseName, parentId: null, sortOrder: order, categoryType: 'space' }], created: true }
}

export function importPackToVault(pluginId: string, pack: { spaceBase: string; notebooks: Array<{ name: string; chapters: Array<{ name: string; pages: PageMeta[] }> }> }, packVersion: string, pluginDir: string, overwriteModified: boolean, forceExternalIds?: string[]): VaultPackImportResult {
  const root = requireRoot()
  const now = new Date().toISOString()
  const force = new Set(forceExternalIds ?? [])
  const conflicts: { title: string; reason: string; externalId: string }[] = []
  const staged: string[] = []
  const writtenFiles: string[] = []

  try {
    let cats = readCat(root)
    const mapping = readMapping(root, pluginId)
    const rowOf = (externalId: string): MapRow | undefined => mapping.find((r) => r.external_id === externalId)
    let spaceId: string | null = null
    let created = 0
    let updated = 0
    let skipped = 0
    const flat: { ch: string; pg: PageMeta }[] = []
    for (const nb of pack.notebooks) for (const ch of nb.chapters) for (const pg of ch.pages) flat.push({ ch: ch.name, pg })
    if (flat.length === 0) return { ok: true, created: 0, updated: 0, skipped: 0, conflicts, spaceId: null }

    // 1) 空间
    const sp = ensureSpace(cats, pack.spaceBase)
    cats = sp.cats
    spaceId = sp.id
    const spaceAbs = spaceDirName(root, pack.spaceBase)

    for (const nb of pack.notebooks) {
      const nbRes = findOrCreateNode(root, cats, spaceId, nb.name, 'notebook')
      cats = nbRes.cats
      const nbAbs = join(spaceAbs, sanitizeTitle(nb.name))
      for (const chapter of nb.chapters) {
        const chRes = findOrCreateNode(root, cats, nbRes.id, chapter.name, 'folder')
        cats = chRes.cats
        const chAbs = join(nbAbs, sanitizeTitle(chapter.name))
        let used = new Set<string>()
        try { used = new Set(readdirSyncSafe(chAbs).map((x) => x.toLowerCase())) } catch { /* 目录不存在 */ }
        for (const pg of chapter.pages) {
          const mdRes = readPageMd(pluginDir, pg.file)
          if ('error' in mdRes) { conflicts.push({ title: pg.title, reason: mdRes.error, externalId: pg.externalId }); skipped++; continue }
          const hash = hashOf(mdRes.buf)
          const row = rowOf(pg.externalId)
          if (row && existsSync(join(root, row.rel_path))) {
            if (row.content_hash === hash) { skipped++; continue }
            // 本地修改保护
            let userModified = false
            try {
              const existing = parseMarkdown(readFileSync(join(root, row.rel_path), 'utf-8'))
              if (String(existing.frontmatter?.updated || '') > row.imported_at) userModified = true
            } catch { /* ignore */ }
            if (userModified && !overwriteModified && !force.has(pg.externalId)) {
              conflicts.push({ title: pg.title, reason: '本地已修改', externalId: pg.externalId })
              skipped++
              continue
            }
            // 覆盖更新：重写正文，保留原 id
            const abs = join(root, row.rel_path)
            const fileDir = dirname(abs)
            const fmOld = parseMarkdown(readFileSync(abs, 'utf-8')).frontmatter ?? {}
            const body = stageImages(mdRes.buf.toString('utf-8'), pluginDir, pg.file, row.page_id, fileDir, root, staged)
            const fm = { ...fmOld, updated: now }
            atomicWrite(abs, serializeMarkdown(fm, body))
            writeMappingRow(root, { ...row, content_hash: hash, pack_version: packVersion, imported_at: now })
            updated++
            continue
          }
          // 新页
          const pageId = row?.page_id ?? randomUUID()
          const stem = sanitizeTitle(pg.title)
          let base = stem
          let n = 2
          while (used.has(`${base.toLowerCase()}.md`)) { base = `${stem}-${n}`; n++ }
          const relPath = relOf(join(chAbs, `${base}.md`), root)
          const abs = join(root, relPath)
          mkdirSync(dirname(abs), { recursive: true })
          const body = stageImages(mdRes.buf.toString('utf-8'), pluginDir, pg.file, pageId, dirname(abs), root, staged)
          const fm = {
            id: pageId,
            title: pg.title,
            category: chRes.id,
            tags: (pg.tags ?? []).filter(Boolean),
            starred: false,
            sortOrder: chapter.pages.indexOf(pg),
            created: now,
            updated: now,
          }
          atomicWrite(abs, serializeMarkdown(fm, body))
          writtenFiles.push(abs)
          used.add(`${base.toLowerCase()}.md`)
          writeMappingRow(root, {
            plugin_id: pluginId, external_id: pg.externalId, page_id: pageId, rel_path: relPath,
            content_hash: hash, pack_version: packVersion, space_id: spaceId, imported_at: now,
          })
          created++
        }
      }
    }
    writeCat(root, cats)
    return { ok: true, created, updated, skipped, conflicts, spaceId }
  } catch (e) {
    // 回滚：删除本次写入的页面与复制的附件
    for (const f of writtenFiles) { try { if (existsSync(f)) unlinkSync(f) } catch { /* ignore */ } }
    for (const f of staged) { try { if (existsSync(f)) unlinkSync(f) } catch { /* ignore */ } }
    return { ok: false, message: `导入失败(已回滚): ${(e as Error)?.message || String(e)}`, conflicts }
  }
}

function readdirSyncSafe(dir: string): string[] {
  const fs = require('fs') as typeof import('fs')
  try { return fs.readdirSync(dir) } catch { return [] }
}

function atomicWrite(abs: string, content: string): void {
  mkdirSync(dirname(abs), { recursive: true })
  const tmp = join(dirname(abs), `.${randomUUID()}.tmp`)
  writeFileSync(tmp, content, 'utf-8')
  try { renameSync(tmp, abs) } catch { if (existsSync(abs)) unlinkSync(abs); renameSync(tmp, abs) }
}

export function packStateVault(pluginId: string, pack: { spaceBase: string; notebooks: Array<{ name: string; chapters: Array<{ name: string; pages: PageMeta[] }> }> }, version: string, pluginDir: string): VaultPackState {
  try {
    const root = requireRoot()
    const mapping = readMapping(root, pluginId)
    const totalPages = pack.notebooks.reduce((n, nb) => n + nb.chapters.reduce((m, c) => m + c.pages.length, 0), 0)
    const chapters = pack.notebooks.reduce((n, nb) => n + nb.chapters.length, 0)
    if (mapping.length === 0) return { ok: true, state: 'not-imported', version, chapters, totalPages, spaceName: pack.spaceBase }
    let newPages = 0
    let changedPages = 0
    let lastImportedAt = ''
    let spaceId: string | null = null
    for (const nb of pack.notebooks) for (const ch of nb.chapters) for (const pg of ch.pages) {
      const mdRes = readPageMd(pluginDir, pg.file)
      const hash = 'buf' in mdRes ? hashOf(mdRes.buf) : ''
      const row = mapping.find((r) => r.external_id === pg.externalId)
      if (!row || !existsSync(join(root, row.rel_path))) { newPages++; continue }
      if (row.content_hash !== hash) changedPages++
      if (row.imported_at > lastImportedAt) lastImportedAt = row.imported_at
      spaceId = row.space_id || spaceId
    }
    const state = newPages > 0 || changedPages > 0 ? 'update-available' : 'imported'
    return { ok: true, state, version, chapters, totalPages, newPages, changedPages, lastImportedAt, spaceId, spaceName: pack.spaceBase }
  } catch (e) {
    return { ok: false, message: (e as Error)?.message || String(e) }
  }
}
