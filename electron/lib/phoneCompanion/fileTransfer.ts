import {
  constants as fsConstants, closeSync, copyFileSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, readdirSync, realpathSync, statSync, unlinkSync,
} from 'fs'
import { join, sep } from 'path'
import { randomUUID } from 'crypto'
import type { IncomingMessage } from 'http'
import type { KnowledgePageIndexEntry } from 'phrontis-core/kbStore/knowledgeIndex'
import { safePathInside } from '../pathGuard.ts'
import { HttpError, parseMultipartUpload } from '../lanShare/multipart.ts'
import { isMobileNotesRel } from './notesUsb.ts'

/**
 * 手机伴侣 · 文件通道 v1（iPad 交接 / 批注回传）—— 纯函数 + vault 触达层，零 electron 依赖。
 *
 * 协议真相源：Phrontis-mobile/docs/design.md §2.3（2026-11-10 拍板）；
 * 桌面施工图：Phrontis-mobile/docs/handoff-files-ipad-desktop.md。
 *
 * 口径：
 *  - 只列 `.pdf`（知识索引 entryKind:'file'），排除移动端 / 系统目录 / 隐藏段。
 *  - 回传只另存副本到 `<vault>/iPad 批注/`：`<原名>（批注）.pdf`，重名 ` (2)` 起，绝不覆盖。
 *  - 临时文件 + 「不覆盖原子落位」，失败 / 超限 / 中断一律清理，vault 里不留半成品。
 */

export const ANNOTATED_DIR = 'iPad 批注'
/** 文件通道单文件上限（编辑器的 50MB 是阅读限制，不复用） */
export const MAX_PDF_UPLOAD_BYTES = 200 * 1024 * 1024
const ANNOTATED_MARK = '（批注）'

export interface HandoffPdfEntry {
  id: string
  path: string
  title: string
  fileType: 'pdf'
  sizeBytes: number
  mtimeMs: number
}

export interface UploadedPdfInfo {
  name: string
  /** 仓库根相对路径（posix 分隔） */
  path: string
  size: number
  mtimeMs: number
}

/* ================= 纯函数：过滤 / 命名 / 魔数 ================= */

/** 段名是系统区或隐藏项（.knowbase / .attachments / _attachments / _inbox / 任意 . 开头 / ..） */
function hasSystemSegment(relPath: string): boolean {
  return String(relPath ?? '').split('/').some(seg => {
    if (!seg || seg === '..') return true
    if (seg.startsWith('.')) return true
    const lower = seg.toLowerCase()
    return lower === '_attachments' || lower === '_inbox'
  })
}

/** 知识索引条目是否属于文件通道可列范围（防御性过滤：索引本身已跳过系统区） */
export function isHandoffPdfPage(
  page: Pick<KnowledgePageIndexEntry, 'entryKind' | 'fileType' | 'path'>,
): boolean {
  if (page.entryKind !== 'file') return false
  if (String(page.fileType ?? '').toLowerCase() !== 'pdf') return false
  const rel = String(page.path ?? '')
  if (!rel) return false
  if (isMobileNotesRel(rel)) return false
  if (hasSystemSegment(rel)) return false
  return true
}

/** 知识索引 pages → 文件通道清单（v1 一次性全量；上千个 PDF 再谈分页） */
export function listHandoffPdfs(pages: ReadonlyArray<KnowledgePageIndexEntry>): HandoffPdfEntry[] {
  return pages
    .filter(isHandoffPdfPage)
    .map(page => ({
      id: page.id,
      path: page.path,
      title: page.title,
      fileType: 'pdf' as const,
      sizeBytes: page.sizeBytes ?? 0,
      mtimeMs: page.mtimeMs,
    }))
}

/** Windows 保留设备名（CON.pdf 之类在 NTFS 上无法创建） */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * 上传名 → 回传副本文件名：<stem>（批注）.pdf。
 * 已带（批注）/(批注) 后缀不重复追加；强制 .pdf；非法字符换成下划线。
 */
export function annotatedPdfName(originalName: string): string {
  const raw = String(originalName ?? '').split(/[\\/]/).pop() ?? ''
  const cleaned = raw
    .replace(/[\x00-\x1f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  // 去掉最后一个扩展名（.pdf / .PDF / 其他类型都按 stem 处理），再摘「已带批注后缀」
  let stem = cleaned.replace(/\.[^.]*$/, '').replace(/[. ]+$/g, '').trim()
  if (!stem) stem = '未命名'
  const marked = /([（(]批注[）)])$/.exec(stem)
  const mark = marked ? marked[1] : ANNOTATED_MARK
  if (marked) stem = stem.slice(0, -marked[1].length)
  stem = stem.slice(0, 116).replace(/[. ]+$/g, '').trim() || '未命名'
  if (WINDOWS_RESERVED.test(stem)) stem = `_${stem}`
  stem += mark
  return `${stem}.pdf`
}

/**
 * 在目标目录已有文件名集合里挑一个不重名的回传名：`（批注）.pdf` → ` (2).pdf` → …
 * 100 次仍冲突返回 null（调用方回 409）。
 */
export function pickAnnotatedPdfName(
  existing: ReadonlySet<string>,
  originalName: string,
  maxTries = 100,
): string | null {
  const base = annotatedPdfName(originalName)
  if (!existing.has(base)) return base
  const stem = base.slice(0, -'.pdf'.length)
  for (let i = 2; i <= maxTries; i++) {
    const candidate = `${stem} (${i}).pdf`
    if (!existing.has(candidate)) return candidate
  }
  return null
}

/** PDF 魔数：`%PDF-`（前 5 字节） */
export function isPdfMagic(head: Uint8Array | null | undefined): boolean {
  if (!head || head.length < 5) return false
  return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d
}

/* ================= vault 触达 ================= */

function isInsideReal(base: string, target: string): boolean {
  const norm = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
  const b = norm(base.endsWith(sep) ? base : base + sep)
  return norm(target).startsWith(b)
}

/**
 * id 对应的仓库相对路径 → 可读绝对路径。
 * 越界 / 符号链接 / 不是文件 → null（调用方按 403 处理）。
 */
export function resolvePdfAbs(root: string, relPath: string): string | null {
  const abs = safePathInside(root, relPath)
  if (!abs) return null
  try {
    if (lstatSync(abs).isSymbolicLink()) return null
    if (!statSync(abs).isFile()) return null
    // 中间目录也可能是链接：realpath 后再校验一次仍在仓库内
    const realRoot = realpathSync(root)
    const real = realpathSync(abs)
    return isInsideReal(realRoot, real) ? real : null
  } catch {
    return null
  }
}

/** 不覆盖落位：硬链接优先（同目录零拷贝 + 原子性），不支持链接的文件系统回落到 COPYFILE_EXCL */
function moveNoOverwrite(src: string, dest: string): boolean {
  try {
    linkSync(src, dest)
    try { unlinkSync(src) } catch { /* 临时名残留由调用方兜底清理 */ }
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
  }
  try {
    copyFileSync(src, dest, fsConstants.COPYFILE_EXCL)
    try { unlinkSync(src) } catch { /* 同上 */ }
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  }
}

function safeUnlink(p: string | null): void {
  if (!p) return
  try { unlinkSync(p) } catch { /* 已不存在 */ }
}

function readMagic(absPath: string): Uint8Array | null {
  let fd: number | null = null
  try {
    fd = openSync(absPath, 'r')
    const head = Buffer.alloc(5)
    const n = readSync(fd, head, 0, 5, 0)
    return n === 5 ? head : head.subarray(0, n)
  } catch {
    return null
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* 忽略 */ }
  }
}

/** 把临时文件落位到 `iPad 批注/` 的不重名目标；100 次仍冲突返回 null */
function placeAnnotatedPdf(tempPath: string, dirAbs: string, originalName: string): string | null {
  const existing = new Set(readdirSync(dirAbs))
  for (let attempt = 0; attempt < 100; attempt++) {
    const name = pickAnnotatedPdfName(existing, originalName)
    if (!name) return null
    if (moveNoOverwrite(tempPath, join(dirAbs, name))) return name
    existing.add(name) // 并发下目标被抢占：继续下一个后缀
  }
  return null
}

/**
 * 流式接收一个 multipart 上传并落成回传副本。
 *
 * 抛出 HttpError：400（缺文件 / 空文件 / 格式错误）、413（超 200MB）、415（非 PDF）、409（重名 100 次）。
 * 任何失败路径都已清理临时文件。
 */
export async function saveAnnotatedPdfUpload(
  root: string,
  req: IncomingMessage,
  opts?: { maxBytes?: number },
): Promise<UploadedPdfInfo> {
  const maxBytes = opts?.maxBytes ?? MAX_PDF_UPLOAD_BYTES
  const dirAbs = join(root, ANNOTATED_DIR)
  mkdirSync(dirAbs, { recursive: true })

  // Content-Length 预检（multipart 头尾开销留 2MB 余量）；流式计数在解析器里兜底
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes + 2 * 1024 * 1024) {
    throw new HttpError(413, '文件超过 200MB 上限')
  }

  const files = await parseMultipartUpload(req, {
    targetDir: dirAbs,
    maxBytes,
    // `.kb-tmp-` 是 fsWatcher 已忽略的原子写临时前缀；扩展名保持 .pdf 方便排障
    fileNameFor: () => `.kb-tmp-${randomUUID()}.pdf`,
  })
  if (files.length === 0) throw new HttpError(400, '缺少文件或文件为空')
  if (files.length > 1) {
    for (const f of files) safeUnlink(f.path)
    throw new HttpError(400, '一次只能回传一个文件')
  }
  const temp = files[0]
  if (!temp.size) {
    safeUnlink(temp.path)
    throw new HttpError(400, '文件为空')
  }

  if (!isPdfMagic(readMagic(temp.path))) {
    safeUnlink(temp.path)
    throw new HttpError(415, '只接受 PDF 文件')
  }

  let finalName: string | null = null
  try {
    finalName = placeAnnotatedPdf(temp.path, dirAbs, temp.originalName)
    if (!finalName) throw new HttpError(409, '同名文件过多，请先整理 iPad 批注 目录')
    safeUnlink(temp.path) // link 已删；copy 路径 / unlink 失败的兜底
    const destAbs = join(dirAbs, finalName)
    const st = statSync(destAbs)
    return {
      name: finalName,
      path: `${ANNOTATED_DIR}/${finalName}`,
      size: st.size,
      mtimeMs: st.mtimeMs,
    }
  } catch (e) {
    safeUnlink(temp.path)
    if (e instanceof HttpError) throw e
    console.error('[companion] annotated pdf write failed', e)
    throw new HttpError(500, '写盘失败')
  }
}
