import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { getVaultTrashRoot } from './attachmentStore'

function getTrashExportDir(): string {
  const settingsPath = join(app.getPath('userData'), 'settings.json')
  let configured = ''
  try {
    if (existsSync(settingsPath)) {
      const s = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      configured = s.trashExportDir || ''
    }
  } catch { /* ignore malformed settings */ }

  if (configured && existsSync(configured)) return configured

  const fallback = join(app.getPath('documents'), 'Knowbase', '回收站')
  mkdirSync(fallback, { recursive: true })
  return fallback
}

async function getTrash() {
  return (await import('trash')).default
}

// ---- helpers ----
function safeName(s: string): string {
  return s.replace(/[<>:"/\\|?*]/g, '_').replace(/\.+$/, '').trim() || '未命名'
}

function uniqueDir(baseDir: string, name: string): string {
  let candidate = join(baseDir, safeName(name))
  let n = 1
  while (existsSync(candidate)) {
    candidate = join(baseDir, `${safeName(name)} (${n})`)
    n++
  }
  return candidate
}

// ---- write file with YAML frontmatter ----
function writeMarkdownFile(dir: string, entry: any): string[] {
  const files: string[] = []
  const fileName = safeName(entry.title || '未命名') + '.md'
  let n = 1
  let filePath = join(dir, fileName)
  while (existsSync(filePath)) {
    filePath = join(dir, `${safeName(entry.title || '未命名')} (${n}).md`)
    n++
  }

  let frontmatter = ''
  if (entry.tags && entry.tags.length > 0) {
    frontmatter = '---\n'
    frontmatter += `title: "${entry.title}"\n`
    frontmatter += `date: ${entry.date || entry.createdAt || ''}\n`
    frontmatter += 'tags:\n'
    for (const t of entry.tags) {
      frontmatter += `  - ${t.name}\n`
    }
    frontmatter += '---\n\n'
  }

  const content = frontmatter + (entry.contentMd || '')
  writeFileSync(filePath, content, 'utf-8')
  files.push(filePath)
  return files
}

// ---- moments snapshot (post + attachment folder) ----
function momentTitleOf(entry: any): string {
  const text = String(entry?.contentMd ?? '').replace(/\s+/g, ' ').trim()
  return text.slice(0, 24) || '说说'
}

/**
 * 说说没有独立正文文件（正文在 posts.json），移入系统回收站时写一份可读摘要；
 * 图片/附件本体在 `<vault>/.knowbase/attachments_trash/<binId>/`，由调用方一起移入系统回收站。
 */
function writeMomentSummary(dir: string, entry: any): string[] {
  const files: string[] = []
  const base = safeName(momentTitleOf(entry))
  let filePath = join(dir, base + '.md')
  let n = 1
  while (existsSync(filePath)) { filePath = join(dir, `${base} (${n}).md`); n++ }
  const tags = Array.isArray(entry?.tags) ? entry.tags.filter((t: unknown) => typeof t === 'string' && t.trim()) : []
  const images = Array.isArray(entry?.imageDataUrls)
    ? entry.imageDataUrls
    : (entry?.imageDataUrl ? [entry.imageDataUrl] : [])
  const attachmentIds = Array.isArray(entry?.attachmentIds) ? entry.attachmentIds : []
  let md = `# 说说\n\n${entry?.contentMd || ''}\n\n`
  md += `- 创建时间：${entry?.createdAt || '-'}\n`
  if (tags.length > 0) md += `- 标签：${tags.join('、')}\n`
  if (images.length > 0) md += `- 图片：${images.length} 张（原图随本条目一起移入系统回收站）\n`
  if (attachmentIds.length > 0) md += `- 附件：${attachmentIds.length} 个（原文件随本条目一起移入系统回收站）\n`
  writeFileSync(filePath, md, 'utf-8')
  files.push(filePath)
  return files
}

// ---- recursively write a category tree snapshot ----
function writeCategoryTree(dir: string, data: any): string[] {
  const files: string[] = []
  mkdirSync(dir, { recursive: true })

  // Write direct pages
  for (const page of (data.pages || [])) {
    files.push(...writeMarkdownFile(dir, page))
  }

  // Write children (sub-categories + their pages)
  for (const child of (data.children || [])) {
    const childDir = uniqueDir(dir, child.category?.name || '子目录')
    writeCategoryTree(childDir, child)
  }

  return files
}

// ---- main export: write snapshot, then trash to OS recycle bin ----
export async function trashItem(binId: string, item: { module: string; title: string; data: any }): Promise<string[]> {
  const rootDir = uniqueDir(getTrashExportDir(), `knowbase-trash-${Date.now()}`)
  mkdirSync(rootDir, { recursive: true })

  try {
    const files: string[] = []
    const extraTrash: string[] = []

    if (item.module === 'blog' || item.module === 'knowledge') {
      // Single page / blog entry → write directly
      const data = item.data
      files.push(...writeMarkdownFile(rootDir, data))
    } else if (item.module === 'passwordVault') {
      // Password entry → write as markdown table
      const e = item.data
      const fileName = safeName(e.title || '密码条目') + '.md'
      const filePath = join(rootDir, fileName)
      let md = `# ${e.title || '密码条目'}\n\n`
      md += `| 名称 | 账号 | 用户名 | 密码 | 网址 | 备注 |\n`
      md += `|------|------|--------|------|------|------|\n`
      const esc = (s: string) => (s || '-').replace(/\|/g, '\\|').replace(/\n/g, ' ')
      md += `| ${esc(e.title)} | ${esc(e.account)} | ${esc(e.username)} | ${esc(e.password ? '••••••（已隐藏）' : '-')} | ${esc(e.url)} | ${esc(e.notes)} |\n`
      writeFileSync(filePath, md, 'utf-8')
      files.push(filePath)
    } else if (item.module === 'moments') {
      // 说说：正文写摘要，图片/附件目录一起移入系统回收站（否则永远留在 attachments_trash 成孤儿）
      files.push(...writeMomentSummary(rootDir, item.data))
      const trashRoot = getVaultTrashRoot(binId)
      if (trashRoot && existsSync(trashRoot)) extraTrash.push(trashRoot)
    } else if (item.module === 'knowledge_category') {
      // Category tree → label with category name, write structure
      const catName = item.data?.category?.name || item.title || '知识目录'
      const catDir = uniqueDir(rootDir, catName)
      mkdirSync(catDir, { recursive: true })
      writeCategoryTree(catDir, item.data)
    }

    // Move to OS recycle bin（说说附件是独立目录，一起移走）
    await (await getTrash())([rootDir, ...extraTrash])

    return []
  } catch (e) {
    // If trash fails, files remain in temp
    throw e
  }
}

export async function trashAll(items: Array<{ binId: string; module: string; title: string; data: any }>): Promise<void> {
  const rootDir = uniqueDir(getTrashExportDir(), `knowbase-trash-${Date.now()}`)
  mkdirSync(rootDir, { recursive: true })
  const extraTrash: string[] = []
  let failed = 0

  for (const item of items) {
    try {
      if (item.module === 'blog' || item.module === 'knowledge') {
        writeMarkdownFile(rootDir, item.data)
      } else if (item.module === 'passwordVault') {
        const e = item.data
        const fileName = safeName(e.title || '密码条目') + '.md'
        const filePath = join(rootDir, fileName)
        let md = `# ${e.title || '密码条目'}\n\n`
        md += `| 名称 | 账号 | 用户名 | 密码 | 网址 | 备注 |\n`
        md += `|------|------|--------|------|------|------|\n`
        const esc = (s: string) => (s || '-').replace(/\|/g, '\\|').replace(/\n/g, ' ')
        md += `| ${esc(e.title)} | ${esc(e.account)} | ${esc(e.username)} | ${esc(e.password ? '••••••（已隐藏）' : '-')} | ${esc(e.url)} | ${esc(e.notes)} |\n`
        writeFileSync(filePath, md, 'utf-8')
      } else if (item.module === 'moments') {
        const itemDir = uniqueDir(rootDir, momentTitleOf(item.data))
        mkdirSync(itemDir, { recursive: true })
        writeMomentSummary(itemDir, item.data)
        const trashRoot = getVaultTrashRoot(item.binId)
        if (trashRoot && existsSync(trashRoot)) extraTrash.push(trashRoot)
      } else if (item.module === 'knowledge_category') {
        const catName = item.data?.category?.name || item.title || '知识目录'
        const catDir = uniqueDir(rootDir, catName)
        mkdirSync(catDir, { recursive: true })
        writeCategoryTree(catDir, item.data)
      }
    } catch (e) {
      failed++
      console.error(`Failed to export item ${item.binId}:`, e)
    }
  }

  // 有任何一条没写成就不要移：让调用方保留回收站索引，避免「清空了但没进系统回收站」
  if (failed > 0) throw new Error(`${failed} 个条目写入失败，未移入系统回收站`)

  // Move entire temp dir + moments attachment folders to OS recycle bin
  await (await getTrash())([rootDir, ...extraTrash])
}
