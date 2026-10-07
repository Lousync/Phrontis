#!/usr/bin/env node
/**
 * Import an old Knowbase backup package into a Vault.
 *
 * The package is produced by the existing "export:backupToZip" feature:
 *   export.json
 *   attachments/<original attachment file_path>
 *
 * This script never opens SQLite and never mutates the source package.
 * Default mode is dry-run. Add --apply to write the Vault.
 *
 * Usage:
 *   node scripts/import-backup-to-vault.mjs --input old-backup.zip --vault E:\\knowledge
 *   node scripts/import-backup-to-vault.mjs --input old-backup.zip --vault E:\\knowledge --apply
 *   node scripts/import-backup-to-vault.mjs --input old-backup.zip --vault E:\\knowledge --apply --include-secrets
 *
 * --include-secrets stages plaintext password entries under
 * .knowbase/import-staging/password-vault.pending.json. The running Electron app
 * must encrypt that file with secretStore before it becomes usable; this script
 * intentionally cannot call Electron safeStorage/Windows DPAPI.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { basename, dirname, extname, join, relative, resolve } from 'path'
import { inflateRawSync } from 'zlib'

const args = process.argv.slice(2)
const has = (name) => args.includes(`--${name}`)
const value = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`)
  const v = i >= 0 ? args[i + 1] : ''
  return v && !v.startsWith('--') ? v : fallback
}

const inputPath = resolve(value('input'))
const vaultPath = resolve(value('vault', 'E:\\knowledge'))
const apply = has('apply')
const overwrite = has('overwrite')
const includeSecrets = has('include-secrets')
const reportPath = resolve(value('report', join(vaultPath, '.knowbase', 'import-report.json')))
const maxFileBytes = Number(value('max-file-bytes', '2147483648'))

if (!value('input')) fail('必须提供 --input <旧版导出 zip 或包含 export.json 的文件夹>')

const invalidName = /[\\/:*?"<>|\x00-\x1f]/g
const reservedName = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i
const pathLimit = 235

function fail(message) {
  console.error(`[import] ${message}`)
  process.exit(1)
}

function safeName(raw, fallback = 'untitled') {
  let name = String(raw ?? '').replace(/\r?\n/g, ' ').replace(invalidName, '_').replace(/\s+/g, ' ').trim()
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (!name) name = fallback
  if (reservedName.test(name)) name = `_${name}`
  return name
}

function allocate() {
  const used = new Set()
  return (dir, base, extension = '') => {
    const key = String(dir).toLowerCase()
    const budget = Math.max(16, pathLimit - String(dir).length - 1)
    let stem = String(base)
    const maxStem = Math.max(1, budget - extension.length)
    stem = stem.slice(0, maxStem)
    let candidate = stem + extension
    let n = 1
    while (used.has(`${key}/${candidate.toLowerCase()}`)) {
      n += 1
      const suffix = ` (${n})`
      candidate = stem.slice(0, Math.max(1, maxStem - suffix.length)) + suffix + extension
    }
    used.add(`${key}/${candidate.toLowerCase()}`)
    return candidate
  }
}

function posix(p) {
  return p.replace(/\\/g, '/')
}

function relVault(p) {
  return posix(relative(vaultPath, p))
}

function writeJson(path, data, plan, mode = 'json') {
  plan.files.push({ path, content: JSON.stringify(data, null, 2) + '\n', mode })
  plan.dirs.add(dirname(path))
}

function writeText(path, content, plan, mode = 'text') {
  plan.files.push({ path, content, mode })
  plan.dirs.add(dirname(path))
}

function serializeFrontmatter(frontmatter, body) {
  const lines = []
  for (const [key, raw] of Object.entries(frontmatter)) {
    if (raw === undefined || raw === null || raw === '') continue
    if (Array.isArray(raw)) {
      if (raw.length === 0) continue
      if (raw.every((v) => typeof v === 'string' && !/[:,]/.test(v) && !v.includes("'"))) {
        lines.push(`${key}: [${raw.join(', ')}]`)
      } else {
        lines.push(`${key}:`)
        for (const item of raw) lines.push(`  - ${String(item).replace(/\n/g, ' ')}`)
      }
    } else if (typeof raw === 'string') {
      lines.push(`${key}: ${/^[\w\u4e00-\u9fa5\s.\-]+$/.test(raw) ? raw : JSON.stringify(raw)}`)
    } else {
      lines.push(`${key}: ${JSON.stringify(raw)}`)
    }
  }
  return lines.length ? `---\n${lines.join('\n')}\n---\n\n${body}` : body
}

function parseZip(buffer) {
  let eocd = -1
  const start = Math.max(0, buffer.length - 65557)
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer[i] === 0x50 && buffer[i + 1] === 0x4b && buffer[i + 2] === 0x05 && buffer[i + 3] === 0x06) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件')
  const count = buffer.readUInt16LE(eocd + 10)
  let centralOffset = buffer.readUInt32LE(eocd + 16)
  const files = new Map()
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error('ZIP 中央目录损坏')
    const method = buffer.readUInt16LE(centralOffset + 10)
    const compressedSize = buffer.readUInt32LE(centralOffset + 20)
    const uncompressedSize = buffer.readUInt32LE(centralOffset + 24)
    const nameLength = buffer.readUInt16LE(centralOffset + 28)
    const extraLength = buffer.readUInt16LE(centralOffset + 30)
    const commentLength = buffer.readUInt16LE(centralOffset + 32)
    const localOffset = buffer.readUInt32LE(centralOffset + 42)
    const name = posix(buffer.toString('utf8', centralOffset + 46, centralOffset + 46 + nameLength))
    centralOffset += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) {
      throw new Error(`ZIP 路径越界，已拒绝：${name}`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null
    if (!data) throw new Error(`不支持 ZIP 压缩方式：${method}`)
    if (data.length !== uncompressedSize) throw new Error(`ZIP 条目大小校验失败：${name}`)
    if (data.length > maxFileBytes) throw new Error(`ZIP 条目过大：${name}`)
    files.set(name, data)
  }
  return files
}

function readPackage(input) {
  const stat = statSync(input)
  if (stat.isDirectory()) {
    const exportFile = join(input, 'export.json')
    if (!existsSync(exportFile)) throw new Error('文件夹中没有 export.json')
    const files = new Map()
    const walk = (dir) => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, item.name)
        if (item.isDirectory()) walk(abs)
        else files.set(posix(relative(input, abs)), readFileSync(abs))
      }
    }
    walk(input)
    return files
  }
  if (stat.size > maxFileBytes * 2) throw new Error('备份包过大，拒绝读取')
  return parseZip(readFileSync(input))
}

function findExportJson(files) {
  if (files.has('export.json')) return 'export.json'
  const candidates = [...files.keys()].filter((p) => p.endsWith('/export.json'))
  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) throw new Error('ZIP 中存在多个 export.json，无法判断来源')
  throw new Error('备份包中缺少 export.json')
}

function validateData(data) {
  if (!data || typeof data !== 'object') throw new Error('export.json 不是对象')
  if (String(data.exportVersion || '') !== '2.0') throw new Error(`不支持的导出版本：${data.exportVersion || '未知'}`)
  for (const key of ['knowledge', 'blog', 'schedule', 'moments', 'checkin', 'bookmarkNav', 'toolbox', 'recycleBin']) {
    if (!data[key] || typeof data[key] !== 'object') throw new Error(`导出包缺少模块：${key}`)
  }
  if (!Array.isArray(data.knowledge.pages) || !Array.isArray(data.knowledge.categories)) throw new Error('knowledge 数据格式不完整')
  if (!Array.isArray(data._attachments || [])) throw new Error('_attachments 数据格式不完整')
}

const files = readPackage(inputPath)
const exportName = findExportJson(files)
const packagePrefix = exportName.slice(0, -'export.json'.length)
let data
try {
  data = JSON.parse(files.get(exportName).toString('utf8'))
} catch {
  fail('export.json 不是合法 JSON')
}
validateData(data)

if (!existsSync(vaultPath)) {
  if (!apply) fail(`目标仓库不存在（预演也要求先指定真实仓库）：${vaultPath}`)
  mkdirSync(vaultPath, { recursive: true })
}

const plan = { files: [], copies: [], dirs: new Set() }
const warnings = []
const conflicts = []
const categoryDirs = new Map()
const categoryById = new Map((data.knowledge.categories || []).map((c) => [c.id, c]))
const allocDir = allocate()
const allocFile = allocate()

for (const category of [...data.knowledge.categories].sort((a, b) => {
  const depth = (c) => {
    let d = 0
    let id = c.id
    while (id && categoryById.has(id) && d < 64) {
      id = categoryById.get(id).parentId
      d += 1
    }
    return d
  }
  return depth(a) - depth(b)
})) {
  const parent = category.parentId && categoryDirs.has(category.parentId) ? categoryDirs.get(category.parentId) : vaultPath
  const dirName = allocDir(parent, safeName(category.name, category.id))
  categoryDirs.set(category.id, join(parent, dirName))
}

const attachmentById = new Map()
const attachmentByOwner = new Map()
const attachmentDest = new Map()
const attachmentMissing = []
const allocAttachment = allocate()

for (const attachment of data._attachments || []) {
  attachmentById.set(attachment.id, attachment)
  const ownerKey = `${attachment.owner_type}:${attachment.owner_id}`
  if (!attachmentByOwner.has(ownerKey)) attachmentByOwner.set(ownerKey, [])
  attachmentByOwner.get(ownerKey).push(attachment)

  const sourceRel = posix(`${packagePrefix}attachments/${attachment.file_path || ''}`).replace(/^\/+/, '')
  const source = files.get(sourceRel)
  if (!source) {
    attachmentMissing.push({ id: attachment.id, filePath: attachment.file_path })
    continue
  }
  const ownerDir = join(vaultPath, '_attachments', safeName(attachment.owner_type, 'misc'), safeName(attachment.owner_id, 'unknown'))
  const extension = extname(attachment.file_name || '')
  const stem = extension ? String(attachment.file_name).slice(0, -extension.length) : String(attachment.file_name || attachment.id)
  const fileName = allocAttachment(ownerDir, safeName(stem, attachment.id), extension)
  const destination = join(ownerDir, fileName)
  attachmentDest.set(attachment.id, destination)
  plan.copies.push({ source, destination, size: source.length })
  plan.dirs.add(ownerDir)

  if (attachment.thumb_path) {
    const thumbRel = posix(`${packagePrefix}attachments/${attachment.thumb_path}`).replace(/^\/+/, '')
    const thumb = files.get(thumbRel)
    if (thumb) {
      const thumbDir = join(ownerDir, 'thumbs')
      const thumbExt = extname(attachment.thumb_path)
      const thumbName = allocAttachment(thumbDir, safeName(basename(attachment.thumb_path, thumbExt), attachment.id), thumbExt)
      plan.copies.push({ source: thumb, destination: join(thumbDir, thumbName), size: thumb.length })
      plan.dirs.add(thumbDir)
    }
  }
}

function relativeAttachment(from, id) {
  const target = attachmentDest.get(id)
  return target ? posix(relative(from, target)) : ''
}

const pageIndex = {}
for (const page of data.knowledge.pages) {
  const dir = page.categoryId && categoryDirs.has(page.categoryId) ? categoryDirs.get(page.categoryId) : join(vaultPath, '_inbox')
  const fileName = allocFile(dir, safeName(page.title, page.id), '.md')
  const destination = join(dir, fileName)
  let body = String(page.contentMd || '').replace(/\r\n/g, '\n')
  body = body.replace(/attachment:\/\/([0-9a-fA-F-]{36})\/?/g, (_match, id) => relativeAttachment(dir, id) || _match)
  const ownerAttachments = attachmentByOwner.get(`knowledge_page:${page.id}`) || []
  const fm = {
    id: page.id,
    title: page.title,
    category: page.categoryId || '',
    tags: (page.tags || []).map((t) => t.name || t).filter(Boolean),
    starred: page.isStarred ? 'true' : '',
    sortOrder: String(page.sortOrder ?? 0),
    fileType: page.fileType || '',
    attachmentId: page.attachmentId || '',
    created: page.createdAt || '',
    updated: page.updatedAt || '',
    attachments: ownerAttachments.map((a) => attachmentDest.has(a.id) ? relVault(attachmentDest.get(a.id)) : '').filter(Boolean),
  }
  writeText(destination, serializeFrontmatter(fm, body), plan)
  pageIndex[page.id] = { id: page.id, title: page.title, path: relVault(destination), categoryId: page.categoryId || null, tags: fm.tags, starred: !!page.isStarred, updatedAt: page.updatedAt || '' }
}

const blogIndex = {}
const blogAlloc = allocate()
for (const entry of data.blog.entries || []) {
  const date = String(entry.date || entry.createdAt || '1970-01-01').slice(0, 10)
  const dir = join(vaultPath, 'blog', date.slice(0, 4))
  const fileName = blogAlloc(dir, `${date}-${safeName(entry.title, entry.id)}`, '.md')
  const destination = join(dir, fileName)
  const fm = {
    id: entry.id,
    title: entry.title,
    date,
    tags: (entry.tags || []).map((t) => t.name || t).filter(Boolean),
    pinned: entry.isPinned ? 'true' : '',
    starred: entry.isStarred ? 'true' : '',
    states: entry.states || '',
    wordCount: String(entry.wordCount ?? 0),
    created: entry.createdAt || '',
    updated: entry.updatedAt || '',
  }
  writeText(destination, serializeFrontmatter(fm, String(entry.contentMd || '').replace(/\r\n/g, '\n')), plan)
  blogIndex[entry.id] = { id: entry.id, title: entry.title, date, path: relVault(destination) }
}

const moduleRoot = join(vaultPath, '.knowbase', 'modules')
writeJson(join(moduleRoot, 'knowledge', 'categories.json'), data.knowledge.categories, plan)
writeJson(join(moduleRoot, 'knowledge', 'pages.json'), pageIndex, plan)
writeJson(join(moduleRoot, 'knowledge', 'tags.json'), data.knowledge.tags || [], plan)
writeJson(join(moduleRoot, 'knowledge', 'page-tags.json'), (data.knowledge.pages || []).flatMap((p) => (p.tags || []).map((t) => ({ pageId: p.id, tagId: t.id || t.name || '' }))), plan)
writeJson(join(moduleRoot, 'knowledge', 'pack-imports.json'), data.knowledgePackImports || [], plan)
writeJson(join(moduleRoot, 'blog', 'entries.json'), blogIndex, plan)
writeJson(join(moduleRoot, 'blog', 'tags.json'), data.blog.tags || [], plan)
writeJson(join(moduleRoot, 'schedule', 'todos.json'), data.schedule.todos || [], plan)
writeJson(join(moduleRoot, 'schedule', 'tags.json'), data.schedule.tags || [], plan)
writeJson(join(moduleRoot, 'moments', 'posts.json'), data.moments.posts || [], plan)
writeJson(join(moduleRoot, 'moments', 'albums.json'), data.moments.albums || [], plan)
writeJson(join(moduleRoot, 'checkin', 'habits.json'), data.checkin.habits || [], plan)
writeJson(join(moduleRoot, 'checkin', 'records.json'), data.checkin.records || [], plan)
// 习惯联动打卡（links.json）已随 v3.2.0 条目 14 整条拔线，导入时不再产出该文件
writeJson(join(moduleRoot, 'bookmarks', 'categories.json'), data.bookmarkNav.categories || [], plan)
writeJson(join(moduleRoot, 'bookmarks', 'bookmarks.json'), data.bookmarkNav.bookmarks || [], plan)
writeJson(join(moduleRoot, 'toolbox', 'scripts.json'), data.toolbox.scripts || [], plan)
writeJson(join(moduleRoot, 'toolbox', 'weight.json'), data.toolbox.weightRecords || [], plan)
writeJson(join(moduleRoot, 'recycle-bin.json'), data.recycleBin.items || [], plan)
writeJson(join(moduleRoot, 'user.json'), data.user || null, plan)

const secretStage = join(vaultPath, '.knowbase', 'import-staging', 'password-vault.pending.json')
if (includeSecrets) {
  writeJson(secretStage, {
    sourceExportVersion: data.exportVersion,
    importedAt: new Date().toISOString(),
    warning: 'This file contains plaintext passwords. Electron must encrypt and delete it before use.',
    entries: data.passwordVault.entries || [],
  }, plan, 'secret-stage')
} else if ((data.passwordVault.entries || []).length > 0) {
  warnings.push(`密码箱有 ${data.passwordVault.entries.length} 条，默认未写入；需要在 Electron safeStorage 中加密后导入。可显式加 --include-secrets 暂存。`)
}

const report = {
  schema: 'knowbase-vault-import/1',
  generatedAt: new Date().toISOString(),
  mode: apply ? 'apply' : 'dry-run',
  input: inputPath,
  vault: vaultPath,
  sourceExportVersion: data.exportVersion,
  exportedAt: data.exportedAt,
  includeSecrets,
  counts: {
    categories: data.knowledge.categories.length,
    pages: data.knowledge.pages.length,
    blogEntries: (data.blog.entries || []).length,
    scheduleTodos: (data.schedule.todos || []).length,
    momentsPosts: (data.moments.posts || []).length,
    bookmarks: (data.bookmarkNav.bookmarks || []).length,
    attachments: (data._attachments || []).length,
    plannedFiles: plan.files.length,
    plannedCopies: plan.copies.length,
  },
  attachmentBytes: plan.copies.reduce((n, item) => n + item.size, 0),
  attachmentMissing,
  warnings,
  conflicts,
  secretStage: includeSecrets ? relVault(secretStage) : null,
}

const targetPaths = [...plan.files.map((f) => f.path), ...plan.copies.map((c) => c.destination)]
for (const target of targetPaths) {
  if (existsSync(target) && !overwrite) conflicts.push(relVault(target))
}
report.conflicts = conflicts.slice(0, 200)
report.counts.conflicts = conflicts.length

if (!apply) {
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
  console.log(`\n导入预演完成（未写盘）`)
  console.log(`  来源：${inputPath}`)
  console.log(`  目标：${vaultPath}`)
  console.log(`  知识库：${report.counts.pages} 篇 / ${report.counts.categories} 个分类`)
  console.log(`  博客：${report.counts.blogEntries} 篇`)
  console.log(`  附件：${report.counts.attachments} 个 / ${(report.attachmentBytes / 1024 / 1024).toFixed(1)} MB`)
  console.log(`  计划写入：${report.counts.plannedFiles} 个文件，复制 ${report.counts.plannedCopies} 个附件文件`)
  console.log(`  冲突：${report.counts.conflicts}（加 --overwrite 覆盖）`)
  if (warnings.length) for (const warning of warnings) console.log(`  警告：${warning}`)
  console.log(`  报告：${reportPath}`)
  process.exit(0)
}

for (const dir of [...plan.dirs].sort((a, b) => a.length - b.length)) mkdirSync(dir, { recursive: true })
for (const file of plan.files) {
  if (existsSync(file.path) && !overwrite) continue
  writeFileSync(file.path, file.content, 'utf8')
}
for (const copy of plan.copies) {
  if (existsSync(copy.destination) && !overwrite) continue
  mkdirSync(dirname(copy.destination), { recursive: true })
  writeFileSync(copy.destination, copy.source)
}

const metaPath = join(vaultPath, '.knowbase', 'meta.json')
let meta = {}
if (existsSync(metaPath)) {
  try { meta = JSON.parse(readFileSync(metaPath, 'utf8')) } catch { warnings.push('原 meta.json 损坏，已重建') }
}
writeFileSync(metaPath, JSON.stringify({
  ...meta,
  schemaVersion: meta.schemaVersion ?? 1,
  importedFrom: { exportVersion: data.exportVersion, exportedAt: data.exportedAt, importedAt: report.generatedAt },
}, null, 2) + '\n', 'utf8')
mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')

console.log(`\n导入完成：${vaultPath}`)
console.log(`  知识库：${report.counts.pages} 篇，博客：${report.counts.blogEntries} 篇`)
console.log(`  附件：${report.counts.attachments} 个 / ${(report.attachmentBytes / 1024 / 1024).toFixed(1)} MB`)
console.log(`  密码箱：${includeSecrets ? `已暂存到 ${relVault(secretStage)}，尚未加密` : '未导入'}`)
console.log(`  报告：${reportPath}`)
