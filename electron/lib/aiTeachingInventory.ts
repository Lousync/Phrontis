import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { extname, join } from 'path'

/**
 * AI 教学 · 目录素材「清点」（对话驱动建课 Phase 1，方案
 * `.claude/plans/ai-teaching-conversational-rework.md`）。
 *
 * 目的：把「整个目录当一大块、被 20000 字截断」的问题从源头解决——**先清点、不读全文**：
 * 产出 `SOURCES/{素材名}.index.md`（指纹 + 统计 + 已/未分类判定 + 逐文件小标题 + 待转写清单），
 * 供教学助手据此分章、再逐章展开（每章只喂该章文件，避开总量截断）。
 *
 * 关键：清点是**确定性**的，程序做（AI 数会漏/编）。本模块零 AI、零网络。
 * 已/未分类判定：顶层含子文件夹且子文件夹内有文件 → organized（子文件夹=章）；顶层平铺文件 → flat。
 */

const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.tsv', '.html', '.htm', '.xml', '.yaml', '.yml',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.go', '.rs', '.rb', '.php', '.cs', '.kt', '.sql', '.sh', '.tex', '.rst',
])
/** 需先转写为 md 才能用的二进制素材（pdf/ppt/word） */
const NEED_TRANSCRIBE_EXT = new Set(['.pdf', '.pptx', '.ppt', '.docx', '.doc'])
const SKIP_DIRS = new Set(['SOURCES', 'node_modules', '_extracts', '_templates'])

export interface InventoryFile {
  /** 相对被清点目录的路径（/ 分隔） */
  rel: string
  ext: string
  bytes: number
  /** 文本文件的字符数；非文本/不可解码为 0 */
  chars: number
  /** 前若干个标题（#/##/###），供助手分章参考 */
  headings: string[]
  mtimeMs: number
  bin: boolean
}
export interface InventorySubdir { name: string; fileCount: number; chars: number }
export interface InventoryScan {
  files: InventoryFile[]
  subdirs: InventorySubdir[]
  totalFiles: number
  totalChars: number
  classification: 'organized' | 'flat' | 'empty'
  pendingTranscribe: { rel: string; ext: string }[]
}

function headOf(text: string, max = 6): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = /^#{1,4}\s+(.+?)\s*$/.exec(line)
    if (m) { out.push(m[1].slice(0, 60)); if (out.length >= max) break }
  }
  return out
}

/** 递归扫描一个素材目录（确定性、不读非文本内容）。 */
export function scanInventoryDir(dirAbs: string): InventoryScan {
  const files: InventoryFile[] = []
  const pending: { rel: string; ext: string }[] = []
  const walk = (abs: string, rel: string): void => {
    let entries: import('fs').Dirent[]
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const childRel = rel ? `${rel}/${e.name}` : e.name
      const childAbs = join(abs, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(childAbs, childRel)
        continue
      }
      const ext = extname(e.name).toLowerCase()
      let bytes = 0, mtimeMs = 0
      try { const st = statSync(childAbs); bytes = st.size; mtimeMs = st.mtimeMs } catch { /* skip stat */ }
      if (NEED_TRANSCRIBE_EXT.has(ext)) { pending.push({ rel: childRel, ext }); continue }
      if (!TEXT_EXT.has(ext)) { files.push({ rel: childRel, ext, bytes, chars: 0, headings: [], mtimeMs, bin: true }); continue }
      let text = ''
      try { text = readFileSync(childAbs, 'utf-8') } catch { /* decode fail */ }
      const bin = text.includes('\uFFFD')
      files.push({ rel: childRel, ext, bytes, chars: bin ? 0 : text.length, headings: bin ? [] : headOf(text), mtimeMs, bin })
    }
  }
  walk(dirAbs, '')

  const subMap = new Map<string, InventorySubdir>()
  let topFiles = 0
  for (const f of files) {
    const slash = f.rel.indexOf('/')
    if (slash < 0) { topFiles++; continue }
    const top = f.rel.slice(0, slash)
    const s = subMap.get(top) ?? { name: top, fileCount: 0, chars: 0 }
    s.fileCount++; s.chars += f.chars; subMap.set(top, s)
  }
  const subdirs = [...subMap.values()].sort((a, b) => a.name.localeCompare(b.name))
  let classification: InventoryScan['classification'] = 'empty'
  if (files.length) classification = subdirs.length >= 1 && topFiles === 0 ? 'organized' : 'flat'

  return {
    files,
    subdirs,
    totalFiles: files.length,
    totalChars: files.reduce((n, f) => n + f.chars, 0),
    classification,
    pendingTranscribe: pending.sort((a, b) => a.rel.localeCompare(b.rel)),
  }
}

/** 指纹：文件集 (相对路径 + 大小 + mtime) 的 sha1——素材变动即变，用于"索引是否过期"。 */
export function inventoryFingerprint(scan: InventoryScan): string {
  const lines = scan.files
    .map((f) => `${f.rel}\u0000${f.bytes}\u0000${Math.round(f.mtimeMs)}`)
    .sort()
  for (const p of scan.pendingTranscribe) lines.push(`${p.rel}\u0000pending`)
  return createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 16)
}

/** 生成索引 markdown（纯函数，确定性输出——同输入同输出，便于契约/幂等）。 */
export function buildInventoryMarkdown(
  name: string, sourcePath: string, scan: InventoryScan, fingerprint: string, today: string,
): string {
  const cls = scan.classification === 'organized'
    ? `已分类（顶层 ${scan.subdirs.length} 个子文件夹可作章）`
    : scan.classification === 'flat'
      ? '未分类（顶层平铺文件，需 AI 归纳分章）'
      : '空目录'
  const head = [
    '---',
    `素材: ${name}`,
    `路径: ${sourcePath || '-'}`,
    `生成: ${today}`,
    `指纹: ${fingerprint}`,
    `分类: ${cls}`,
    `统计: ${scan.totalFiles} 个文件 · ${scan.totalChars} 字 · ${scan.subdirs.length} 个子文件夹`,
    `待转写: ${scan.pendingTranscribe.length ? scan.pendingTranscribe.map((p) => p.rel).join('、') : '无'}`,
    '---',
    '',
    `# 目录索引 · ${name}`,
    '',
  ]
  const fmt = (f: InventoryFile): string => {
    const h = f.bin ? '（非文本）' : f.chars ? `${f.chars} 字` : '（空）'
    const hs = f.headings.length ? ` — 标题：${f.headings.join(' / ')}` : ''
    return `- ${f.rel} — ${h}${hs}`
  }
  const groups = new Map<string, InventoryFile[]>()
  for (const f of scan.files) {
    const slash = f.rel.indexOf('/')
    const g = scan.classification === 'organized' && slash >= 0 ? f.rel.slice(0, slash) : '（根目录）'
    const arr = groups.get(g) ?? []
    arr.push(f); groups.set(g, arr)
  }
  const body: string[] = []
  for (const [g, arr] of groups) {
    body.push(`## ${g}`, ...arr.map(fmt), '')
  }
  if (!scan.files.length) body.push('（目录内没有可读文本文件）', '')
  return head.concat(body).join('\n')
}

export interface InventoryWriteResult {
  ok: boolean
  relPath?: string
  scan?: InventoryScan
  fingerprint?: string
  error?: string
}

function safeName(name: string): string {
  return String(name ?? '').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).replace(/[. ]+$/, '') || '素材'
}

/**
 * 清点并写索引：`{工作区夹}/SOURCES/{素材名}.index.md`。
 * 幂等：内容（含指纹）不变则不重写；素材变动 → 指纹变 → 覆盖重写。
 */
export function writeInventoryIndex(
  wsFolderAbs: string, sourceName: string, sourcePath: string, dirAbs: string, today: string,
): InventoryWriteResult {
  try {
    if (!existsSync(dirAbs)) return { ok: false, error: `素材目录不存在：${sourcePath || dirAbs}` }
    const scan = scanInventoryDir(dirAbs)
    const fingerprint = inventoryFingerprint(scan)
    const md = buildInventoryMarkdown(sourceName, sourcePath, scan, fingerprint, today)
    const srcDir = join(wsFolderAbs, 'SOURCES')
    if (!existsSync(srcDir)) mkdirSync(srcDir, { recursive: true })
    const fileAbs = join(srcDir, `${safeName(sourceName)}.index.md`)
    let cur = ''
    try { cur = readFileSync(fileAbs, 'utf-8') } catch { /* 首次 */ }
    if (cur !== md) writeFileSync(fileAbs, md, 'utf-8')
    return { ok: true, relPath: `SOURCES/${safeName(sourceName)}.index.md`, scan, fingerprint }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function todayLocal(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
