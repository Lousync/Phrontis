/**
 * AI教学 · 素材注册表（3.14.0 简化）
 *
 * 唯一真相源：`.knowbase/modules/aiTeaching/sources.json`
 *   { v:1, workspaces: { [wsId]: { sources: SourceEntry[], assignments: { [chapterId]: ChapterAssignment[] }, migratedAt? } } }
 *
 * 三分离：
 *   登记 registerSources  —— 只登记文件，不决定给哪章；
 *   章级分配 assignSources —— 本章用哪些素材、各自哪个区间；
 *   段级确认              —— 开段预检把收窄后的 anchor 快照写进 progress.json（本文件不存段）。
 *
 * 旧 `SOURCES/SOURCE.md` 只在迁移时读；原文件不删不改。
 * 本文件不 import aiTeachingCourse（避免循环）；大纲只读 `课程.md` + 纯解析。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, cpSync } from 'fs'
import { dirname, extname, isAbsolute, join, relative } from 'path'
import { createHash, randomUUID } from 'crypto'
import { ipcMain } from 'electron'
import { getCurrentVault } from './kbStore/vaultContext'
import { readJson, writeJson } from './kbStore/jsonStore'
import { workspaceFolderRel } from './aiTeachingWorkspaces'
import { parseSourceMd, type SourceEntry as LegacySourceEntry } from './aiTeachingSources'
import { parseCourseMd, type CourseOutline } from './aiTeachingCoursePure'
import { extractPdfRange, extractPptxPages } from './docsReader'
import { convertToPdf } from './sofficeConvert'
import { uniqueFileName } from './workspaceManager'
import { sanitizeTitle } from './aiTeachingFolders'
import { broadcast, BROADCAST_CHANNEL } from '../main/windowBus'
import { AI_TEXT_CODE_EXTS } from '../../src/lib/aiTextExts'
import {
  anchorLabel,
  isValidAnchor,
  type ChapterAssignment,
  type SourceAnchor,
  type SourceEntry,
  type SourceIndexEntry,
  type SourceType,
  type SourcesFile,
  type WorkspaceSources,
} from '../../src/lib/aiTeachingSourcesPure'

const MODULE = 'modules/aiTeaching'
const KEY = 'sources.json'
const SOURCE_FILE = 'SOURCE.md'
const MAX_INDEX = 200
const MAX_TEXT_BYTES = 2 * 1024 * 1024

type GetSetting = (key: string) => unknown

function nowIso(): string {
  return new Date().toISOString()
}

function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function slash(v: unknown): string {
  return String(v ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function emptyFile(): SourcesFile {
  return { v: 1, workspaces: {} }
}

function readFile(): SourcesFile {
  const raw = readJson<SourcesFile>(MODULE, KEY, emptyFile())
  if (!raw || typeof raw !== 'object') return emptyFile()
  const out: SourcesFile = { v: 1, workspaces: {} }
  const wsRaw = isRecord((raw as SourcesFile).workspaces) ? (raw as SourcesFile).workspaces : {}
  for (const [wsId, wRaw] of Object.entries(wsRaw)) {
    if (!isRecord(wRaw)) continue
    const sources = Array.isArray((wRaw as WorkspaceSources).sources) ? (wRaw as WorkspaceSources).sources.filter((s) => isRecord(s) && s.id) : []
    const assignmentsRaw = isRecord((wRaw as WorkspaceSources).assignments) ? (wRaw as WorkspaceSources).assignments : {}
    const assignments: Record<string, ChapterAssignment[]> = {}
    for (const [cid, list] of Object.entries(assignmentsRaw)) {
      if (!Array.isArray(list)) continue
      assignments[cid] = list.filter((a) => isRecord(a) && a.sourceId)
    }
    out.workspaces[wsId] = {
      sources,
      assignments,
      ...(typeof (wRaw as WorkspaceSources).migratedAt === 'string' ? { migratedAt: (wRaw as WorkspaceSources).migratedAt } : {}),
    }
  }
  return out
}

function writeFile(f: SourcesFile): void {
  writeJson(MODULE, KEY, f)
}

function broadcastSources(wsId: string): void {
  broadcast(BROADCAST_CHANNEL.aiTeachCourseRefresh, { wsId })
}

function workspaceRel(wsId: string, getSetting: GetSetting): string | null {
  const id = String(wsId ?? '').trim()
  if (!id) return null
  return workspaceFolderRel(id, getSetting)
}

function workspaceAbs(wsId: string, getSetting: GetSetting): { rel: string; abs: string; root: string } | null {
  const vault = getCurrentVault()
  const rel = workspaceRel(wsId, getSetting)
  if (!vault || !rel) return null
  return { rel, abs: join(vault.rootPath, rel), root: vault.rootPath }
}

function readOutline(wsId: string, getSetting: GetSetting): CourseOutline | null {
  const w = workspaceAbs(wsId, getSetting)
  if (!w) return null
  const abs = join(w.abs, '课程.md')
  if (!existsSync(abs)) return null
  try { return parseCourseMd(readFileSync(abs, 'utf-8')) } catch { return null }
}

function inferType(p: string): SourceType {
  const raw = String(p ?? '').split('?')[0].split('#')[0]
  const ext = (extname(raw).slice(1) || '').toLowerCase()
  if (!ext) return 'other'
  if (ext === 'md' || ext === 'markdown') return 'md'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'pptx' || ext === 'ppt') return 'pptx'
  if (ext === 'docx' || ext === 'doc') return 'docx'
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic', 'tif', 'tiff'].includes(ext)) return 'image'
  if ((AI_TEXT_CODE_EXTS as readonly string[]).includes(ext)) return 'code'
  return 'other'
}

function isTextType(t: SourceType): boolean {
  return t === 'md' || t === 'code' || t === 'other'
}

function legacyAnchor(range: string, type: SourceType): SourceAnchor {
  const m = /^(?:[Ll]|行)?\s*(\d+)\s*(?:[-–~]\s*(?:[Ll]|行)?\s*(\d+))?$/.exec(String(range ?? '').trim())
  if (!m) return { kind: 'whole' }
  const from = parseInt(m[1], 10)
  const to = m[2] ? parseInt(m[2], 10) : from
  if (!Number.isFinite(from) || from < 1 || to < from) return { kind: 'whole' }
  return type === 'code' ? { kind: 'lines', from, to } : { kind: 'pages', from, to }
}

function legacyKey(name: string, path: string): string {
  return `${String(name ?? '').trim()}\u0000${String(path ?? '').trim()}`
}

function stableId(key: string): string {
  return `s_${createHash('sha1').update(key).digest('hex').slice(0, 16)}`
}

function isInside(root: string, abs: string): boolean {
  const r = slash(relative(root, abs))
  return !!r && !r.startsWith('..') && !isAbsolute(r)
}

function toVaultRel(root: string, abs: string): string | null {
  if (!isInside(root, abs)) return null
  return slash(relative(root, abs))
}

/** 把外部文件/目录复制进 {工作区}/SOURCES/，返回仓库相对路径；失败返回错误串。 */
function copyIntoWorkspace(wsId: string, srcAbs: string, getSetting: GetSetting, title?: string): { rel?: string; error?: string } {
  const w = workspaceAbs(wsId, getSetting)
  if (!w) return { error: '工作区不存在' }
  const dirAbs = join(w.abs, 'SOURCES')
  try {
    mkdirSync(dirAbs, { recursive: true })
    const base = sanitizeTitle(title || srcAbs.split(/[\\/]/).pop() || '素材')
    const isDir = (() => { try { return statSync(srcAbs).isDirectory() } catch { return false } })()
    if (isDir) {
      let name = base
      let n = 1
      while (existsSync(join(dirAbs, name))) name = `${base}-${n++}`
      cpSync(srcAbs, join(dirAbs, name), { recursive: true })
      return { rel: `${w.rel}/SOURCES/${name}` }
    }
    const ext = extname(srcAbs)
    const stem = ext && base.toLowerCase().endsWith(ext.toLowerCase()) ? base.slice(0, -ext.length) : base
    let name = `${stem}${ext}`
    let n = 1
    while (existsSync(join(dirAbs, name))) name = `${stem}-${n++}${ext}`
    copyFileSync(srcAbs, join(dirAbs, name))
    return { rel: `${w.rel}/SOURCES/${name}` }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

/** 解析登记路径 → 仓库相对路径 / URL。 */
function resolveRegisterPath(wsId: string, rawPath: string, getSetting: GetSetting, title?: string): { rel?: string; url?: string; abs?: string; error?: string } {
  const p = String(rawPath ?? '').trim()
  if (!p) return { error: '路径为空' }
  if (/^https?:\/\//i.test(p)) return { url: p }
  const vault = getCurrentVault()
  const w = workspaceAbs(wsId, getSetting)
  if (!vault || !w) return { error: '尚未打开仓库或工作区不存在' }
  const abs = isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)
    ? p
    : (existsSync(join(vault.rootPath, p)) ? join(vault.rootPath, p) : join(w.abs, p))
  if (!existsSync(abs)) return { error: `文件不存在：${p}` }
  const rel = toVaultRel(vault.rootPath, abs)
  if (rel) return { rel, abs }
  return copyIntoWorkspace(wsId, abs, getSetting, title)
}

/** 读文本（utf-8，坏字节回退 GBK）。 */
function readTextSmart(abs: string): string {
  const buf = readFileSync(abs)
  if (buf.length > MAX_TEXT_BYTES) return buf.subarray(0, MAX_TEXT_BYTES).toString('utf-8')
  const utf8 = buf.toString('utf-8')
  if (!utf8.includes('\uFFFD')) return utf8
  try { return new TextDecoder('gbk').decode(buf) } catch { return utf8 }
}

function listFiles(dirAbs: string, out: string[], base = '', depth = 0): void {
  if (depth > 6 || out.length >= MAX_INDEX) return
  let names: import('fs').Dirent[]
  try { names = readdirSync(dirAbs, { withFileTypes: true }) } catch { return }
  for (const d of names) {
    if (out.length >= MAX_INDEX) return
    if (d.name.startsWith('.') || d.name === SOURCE_FILE) continue
    const abs = join(dirAbs, d.name)
    const rel = base ? `${base}/${d.name}` : d.name
    if (d.isDirectory()) listFiles(abs, out, rel, depth + 1)
    else if (d.isFile()) out.push(rel)
  }
}

/** 建轻量索引：md 标题 / 目录文件名 / PDF 提取稿页标题。 */
export function buildSourceIndex(source: SourceEntry): SourceIndexEntry[] {
  const vault = getCurrentVault()
  if (!vault) return []
  const out: SourceIndexEntry[] = []
  try {
    if (source.type === 'md' && source.rel) {
      const abs = join(vault.rootPath, source.rel)
      if (!existsSync(abs)) return []
      const text = readTextSmart(abs)
      for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
        const m = /^(#{1,6})\s+(.+?)\s*$/.exec(raw)
        if (!m) continue
        const label = m[2].replace(/\[[A-Za-z0-9_-]+\]\s*/, '').trim()
        if (!label) continue
        out.push({ label, level: m[1].length, anchor: { kind: 'headings', from: label } })
        if (out.length >= MAX_INDEX) break
      }
      return out
    }
    if ((source.type === 'dir' || source.type === 'url') && (source.extractRel || source.rel)) {
      const dirRel = source.type === 'dir' ? source.rel : source.extractRel
      if (!dirRel) return []
      const abs = join(vault.rootPath, dirRel)
      if (existsSync(abs) && statSync(abs).isDirectory()) {
        const files: string[] = []
        listFiles(abs, files)
        for (const f of files) {
          if (!/\.(md|markdown|txt)$/i.test(f)) continue
          out.push({ label: f, anchor: { kind: 'files', paths: [`${dirRel}/${f}`] } })
          if (out.length >= MAX_INDEX) break
        }
        return out
      }
    }
    if (source.extractRel && /\.(md|markdown)$/i.test(source.extractRel)) {
      const abs = join(vault.rootPath, source.extractRel)
      if (existsSync(abs)) {
        const text = readTextSmart(abs)
        const pages = [...text.matchAll(/^#{2,3}\s*p(\d+)\s*$/gm)]
        for (const m of pages) {
          const n = parseInt(m[1], 10)
          if (Number.isFinite(n)) out.push({ label: `p${n}`, anchor: { kind: 'pages', from: n, to: n } })
          if (out.length >= MAX_INDEX) break
        }
        if (out.length) return out
      }
    }
  } catch { /* 索引失败不阻断登记 */ }
  return out
}

function sourceStatus(type: SourceType, extractRel: string | null | undefined, rel?: string): SourceEntry['status'] {
  if (rel) {
    const vault = getCurrentVault()
    if (vault && !existsSync(join(vault.rootPath, rel))) return 'error'
  }
  if (extractRel) return 'ready'
  if (type === 'pdf' || type === 'pptx' || type === 'docx' || type === 'image' || type === 'url') return 'needs-extract'
  return 'ready'
}

// ===== 迁移：SOURCE.md 三层 → sources.json =====

interface MigrationOut { sources: SourceEntry[]; assignments: Record<string, ChapterAssignment[]> }

function convertLegacyEntry(
  wsId: string,
  e: LegacySourceEntry,
  dirRel: string,
  w: { rel: string; abs: string; root: string },
  chapterId: string | null,
  getSetting: GetSetting,
): { source: SourceEntry; assignment: ChapterAssignment | null } | null {
  if (!e.name || !e.path || e.path === '-') return null
  const rawType = String(e.type || '').toLowerCase()
  const type: SourceType = (['md', 'dir', 'pdf', 'pptx', 'docx', 'image', 'url', 'code', 'other'] as string[]).includes(rawType)
    ? (rawType as SourceType)
    : inferType(e.path)
  let rel: string | undefined
  let url: string | undefined
  let note = e.note === '-' ? '' : (e.note || '')
  if (/^https?:\/\//i.test(e.path)) {
    url = e.path
  } else {
    const p = e.path.trim()
    let abs = ''
    if (p.startsWith('./')) abs = join(w.root, dirRel, p.slice(2))
    else if (isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) abs = p
    else {
      const a = join(w.root, p)
      const b = join(w.root, dirRel, p)
      abs = existsSync(a) ? a : b
    }
    const vr = toVaultRel(w.root, abs)
    if (vr) rel = vr
    else {
      const c = copyIntoWorkspace(wsId, abs, getSetting, e.name)
      if (c.rel) rel = c.rel
      else note = `${note ? `${note}；` : ''}迁移复制失败：${c.error ?? '未知错误'}`
    }
  }
  let extractRel: string | null = null
  const ext = /^✓\s*→\s*(.+)$/.exec(String(e.extracted ?? '').trim())
  if (ext) {
    const x = ext[1].trim()
    if (/^https?:\/\//i.test(x)) extractRel = null
    else if (isAbsolute(x) || /^[a-zA-Z]:[\\/]/.test(x)) extractRel = toVaultRel(w.root, x)
    else extractRel = slash(`${dirRel}/${x}`)
  }
  const anchor = legacyAnchor(e.range, type)
  const key = legacyKey(e.name, url || rel || e.path)
  const source: SourceEntry = {
    id: stableId(`${wsId}\0${key}`),
    title: e.name,
    type,
    ...(rel ? { rel } : {}),
    ...(url ? { url } : {}),
    extractRel,
    anchor,
    status: sourceStatus(type, extractRel, rel),
    ...(note ? { note } : {}),
    createdAt: nowIso(),
  }
  const idx = buildSourceIndex(source)
  if (idx.length) { source.index = idx; source.indexUpdatedAt = nowIso() }
  const assignment: ChapterAssignment | null = chapterId
    ? { sourceId: source.id, label: e.name, anchor, addedAt: nowIso() }
    : null
  return { source, assignment }
}

function migrateLegacy(wsId: string, w: { rel: string; abs: string; root: string }, getSetting: GetSetting): WorkspaceSources {
  const outline = readOutline(wsId, getSetting)
  const dirAbs = join(w.abs, 'SOURCES')
  const sources: SourceEntry[] = []
  const assignments: Record<string, ChapterAssignment[]> = {}
  const seen = new Set<string>()

  const add = (e: LegacySourceEntry, dirRel: string, chapterId: string | null): void => {
    const c = convertLegacyEntry(wsId, e, dirRel, w, chapterId, getSetting)
    if (!c) return
    const key = legacyKey(c.source.title, c.source.url || c.source.rel || '')
    if (seen.has(key)) {
      // 同一素材多处登记：补分配，不重复登记
      if (c.assignment && chapterId) {
        const list = (assignments[chapterId] = assignments[chapterId] ?? [])
        if (!list.some((a) => a.sourceId === c.source.id)) list.push(c.assignment)
      }
      return
    }
    seen.add(key)
    sources.push(c.source)
    if (c.assignment && chapterId) (assignments[chapterId] = assignments[chapterId] ?? []).push(c.assignment)
  }

  // 工作区主库
  const wsSource = join(dirAbs, SOURCE_FILE)
  if (existsSync(wsSource)) {
    try {
      for (const e of parseSourceMd(readFileSync(wsSource, 'utf-8'))) add(e, slash(`${w.rel}/SOURCES`), null)
    } catch { /* 单文件失败不阻断 */ }
  }
  // 知识点 / 旧会话子库：SOURCE.md 同目录的条目
  let entries: import('fs').Dirent[] = []
  try { entries = readdirSync(dirAbs, { withFileTypes: true }) } catch { /* 无 SOURCES 目录 */ }
  for (const d of entries) {
    if (!d.isDirectory()) continue
    const f = join(dirAbs, d.name, SOURCE_FILE)
    if (!existsSync(f)) continue
    const m = /^(\d+)·(.+)$/.exec(d.name)
    let chapterId: string | null = null
    if (m && outline) {
      const idx = parseInt(m[1], 10) - 1
      chapterId = outline.chapters[idx]?.id ?? null
    }
    try {
      for (const e of parseSourceMd(readFileSync(f, 'utf-8'))) add(e, slash(`${w.rel}/SOURCES/${d.name}`), chapterId)
    } catch { /* 单文件失败不阻断 */ }
  }

  return { sources, assignments, ...(sources.length || Object.keys(assignments).length ? { migratedAt: nowIso() } : {}) }
}

/** 确保该工作区有 sources.json 条目（懒迁移一次）。 */
export function ensureSources(wsId: string, getSetting: GetSetting): WorkspaceSources | null {
  const w = workspaceAbs(wsId, getSetting)
  if (!w) return null
  const f = readFile()
  const existing = f.workspaces[wsId]
  const hasData = !!existing && (existing.sources.length > 0 || Object.keys(existing.assignments).length > 0)
  if (existing && hasData) return existing
  const migrated = migrateLegacy(wsId, w, getSetting)
  f.workspaces[wsId] = migrated
  writeFile(f)
  return migrated
}

// ===== 读 / 登记 / 分配 =====

export interface SourcesPayload {
  ok: boolean
  sources: SourceEntry[]
  assignments: Record<string, ChapterAssignment[]>
  error?: string
}

export function getSources(wsId: string, getSetting: GetSetting): SourcesPayload {
  const w = workspaceAbs(wsId, getSetting)
  if (!w) return { ok: false, sources: [], assignments: {}, error: '工作区不存在' }
  const s = ensureSources(wsId, getSetting)
  if (!s) return { ok: false, sources: [], assignments: {}, error: '读取素材失败' }
  return { ok: true, sources: s.sources, assignments: s.assignments }
}

export interface SourceSummary {
  total: number
  assigned: number
  unassigned: number
  byChapter: Record<string, number>
}

export function getSourceSummary(wsId: string, getSetting: GetSetting): SourceSummary {
  const s = ensureSources(wsId, getSetting)
  if (!s) return { total: 0, assigned: 0, unassigned: 0, byChapter: {} }
  const assignedIds = new Set<string>()
  const byChapter: Record<string, number> = {}
  for (const [cid, list] of Object.entries(s.assignments)) {
    byChapter[cid] = 0
    for (const a of list) {
      if (!assignedIds.has(a.sourceId)) assignedIds.add(a.sourceId)
      byChapter[cid] += 1
    }
  }
  return {
    total: s.sources.length,
    assigned: assignedIds.size,
    unassigned: Math.max(0, s.sources.length - assignedIds.size),
    byChapter,
  }
}

export interface RegisterSourceItem {
  path: string
  title?: string
  type?: string
}

export interface RegisterSourcesResult {
  ok: boolean
  sources: Array<Pick<SourceEntry, 'id' | 'title' | 'type' | 'status' | 'rel' | 'url' | 'extractRel'>>
  errors: Array<{ path: string; error: string }>
  error?: string
}

export function registerSources(wsId: string, items: RegisterSourceItem[], getSetting: GetSetting): RegisterSourcesResult {
  const w = workspaceAbs(wsId, getSetting)
  if (!w) return { ok: false, sources: [], errors: [], error: '工作区不存在' }
  const f = readFile()
  const s = f.workspaces[wsId] ?? (f.workspaces[wsId] = { sources: [], assignments: {}, migratedAt: nowIso() })
  const out: RegisterSourcesResult['sources'] = []
  const errors: RegisterSourcesResult['errors'] = []
  for (const item of Array.isArray(items) ? items : []) {
    const raw = String(item?.path ?? '').trim()
    if (!raw) continue
    try {
      const resolved = resolveRegisterPath(wsId, raw, getSetting, item?.title)
      if (!resolved.rel && !resolved.url) { errors.push({ path: raw, error: resolved.error ?? '路径不可用' }); continue }
      const key = resolved.url || resolved.rel || raw
      const existing = s.sources.find((x) => (x.url || x.rel) === key)
      if (existing) {
        out.push(existing)
        continue
      }
      const typeRaw = String(item?.type ?? '').toLowerCase()
      const type: SourceType = (['md', 'dir', 'pdf', 'pptx', 'docx', 'image', 'url', 'code', 'other'] as string[]).includes(typeRaw)
        ? (typeRaw as SourceType)
        : resolved.url
          ? 'url'
          : resolved.rel && existsSync(join(w.root, resolved.rel)) && statSync(join(w.root, resolved.rel)).isDirectory()
            ? 'dir'
            : inferType(resolved.rel || raw)
      const title = String(item?.title ?? '').trim()
        || (resolved.rel ? resolved.rel.split('/').pop()?.replace(/\.[^.]+$/, '') : '')
        || (resolved.url ? new URL(resolved.url).hostname : '')
        || '未命名素材'
      const source: SourceEntry = {
        id: `s_${randomUUID()}`,
        title,
        type,
        ...(resolved.rel ? { rel: resolved.rel } : {}),
        ...(resolved.url ? { url: resolved.url } : {}),
        extractRel: null,
        anchor: { kind: 'whole' },
        status: sourceStatus(type, null, resolved.rel),
        createdAt: nowIso(),
      }
      source.index = buildSourceIndex(source)
      source.indexUpdatedAt = nowIso()
      s.sources.push(source)
      out.push(source)
    } catch (e) {
      errors.push({ path: raw, error: (e as Error).message })
    }
  }
  writeFile(f)
  broadcastSources(wsId)
  return { ok: out.length > 0 || errors.length === 0, sources: out, errors }
}

export interface AssignSourceItem {
  sourceId?: string
  /** 允许按标题/文件名解析 */
  source?: string
  label?: string
  anchor?: SourceAnchor
}

export function assignSources(wsId: string, chapterId: string, items: AssignSourceItem[], getSetting: GetSetting): { ok: boolean; assigned: number; errors: string[]; error?: string } {
  const cid = String(chapterId ?? '').trim()
  if (!cid) return { ok: false, assigned: 0, errors: [], error: '缺少章 id' }
  const w = workspaceAbs(wsId, getSetting)
  if (!w) return { ok: false, assigned: 0, errors: [], error: '工作区不存在' }
  const f = readFile()
  const s = f.workspaces[wsId] ?? (f.workspaces[wsId] = { sources: [], assignments: {}, migratedAt: nowIso() })
  const list = (s.assignments[cid] = s.assignments[cid] ?? [])
  const errors: string[] = []
  let assigned = 0
  for (const item of Array.isArray(items) ? items : []) {
    const ref = String(item?.sourceId ?? item?.source ?? '').trim()
    if (!ref) continue
    const src = s.sources.find((x) => x.id === ref)
      ?? s.sources.find((x) => x.title === ref)
      ?? s.sources.find((x) => x.title.includes(ref))
    if (!src) { errors.push(`找不到素材「${ref}」`); continue }
    const anchor = isValidAnchor(item?.anchor) ? item.anchor : src.anchor
    const label = String(item?.label ?? '').trim() || src.title
    const cur = list.find((a) => a.sourceId === src.id)
    if (cur) {
      cur.label = label
      cur.anchor = anchor
      cur.addedAt = nowIso()
    } else {
      list.push({ sourceId: src.id, label, anchor, addedAt: nowIso() })
    }
    assigned += 1
  }
  writeFile(f)
  broadcastSources(wsId)
  return { ok: assigned > 0, assigned, errors }
}

export function removeAssignment(wsId: string, chapterId: string, sourceId: string, getSetting: GetSetting): { ok: boolean; error?: string } {
  const f = readFile()
  const s = f.workspaces[wsId]
  if (!s) return { ok: false, error: '没有素材注册表' }
  const list = s.assignments[chapterId]
  if (!list) return { ok: true }
  s.assignments[chapterId] = list.filter((a) => a.sourceId !== sourceId)
  if (!s.assignments[chapterId].length) delete s.assignments[chapterId]
  writeFile(f)
  broadcastSources(wsId)
  return { ok: true }
}

export function removeSource(wsId: string, sourceId: string, getSetting: GetSetting): { ok: boolean; error?: string } {
  const f = readFile()
  const s = f.workspaces[wsId]
  if (!s) return { ok: false, error: '没有素材注册表' }
  const id = String(sourceId ?? '').trim()
  s.sources = s.sources.filter((x) => x.id !== id)
  for (const cid of Object.keys(s.assignments)) {
    s.assignments[cid] = s.assignments[cid].filter((a) => a.sourceId !== id)
    if (!s.assignments[cid].length) delete s.assignments[cid]
  }
  writeFile(f)
  broadcastSources(wsId)
  return { ok: true }
}

// ===== 提取 =====

export interface ExtractResult {
  ok: boolean
  relPath?: string
  error?: string
  skipped?: boolean
}

function sourceAbs(source: SourceEntry): string | null {
  const vault = getCurrentVault()
  if (!vault || !source.rel) return null
  return join(vault.rootPath, source.rel)
}

function sourceDirRel(source: SourceEntry): string | null {
  if (!source.rel) return null
  const i = source.rel.lastIndexOf('/')
  return i > 0 ? source.rel.slice(0, i) : null
}

export async function extractSource(wsId: string, sourceId: string, anchor: SourceAnchor, getSetting: GetSetting): Promise<ExtractResult> {
  const vault = getCurrentVault()
  if (!vault) return { ok: false, error: '尚未打开仓库' }
  const f = readFile()
  const s = f.workspaces[wsId]
  if (!s) return { ok: false, error: '没有素材注册表' }
  const src = s.sources.find((x) => x.id === String(sourceId ?? '').trim())
  if (!src) return { ok: false, error: '素材不存在' }
  if (src.extractRel && src.type !== 'pdf' && src.type !== 'pptx' && src.type !== 'docx' && src.type !== 'code') {
    return { ok: true, relPath: src.extractRel, skipped: true }
  }
  if (src.type === 'md' || src.type === 'dir' || src.type === 'url') {
    return src.rel ? { ok: true, relPath: src.rel, skipped: true } : { ok: false, error: '该素材不需要提取' }
  }
  const abs = sourceAbs(src)
  const dir = sourceDirRel(src)
  if (!abs || !dir || !existsSync(abs)) return { ok: false, error: '素材原件不可用' }
  const dirAbs = join(vault.rootPath, dir)
  try {
    if (src.type === 'code') {
      const rg = anchor.kind === 'lines' ? anchor : { from: 1, to: 400 }
      const lines = readTextSmart(abs).replace(/\r\n/g, '\n').split('\n')
      const from = Math.min(rg.from, Math.max(1, lines.length))
      const to = Math.min(rg.to, lines.length)
      const capped = to - from > 2000
      const takeEnd = capped ? from + 2000 : to
      const ext = extname(src.rel || '').slice(1).toLowerCase()
      const name = uniqueFileName(dirAbs, `${sanitizeTitle(src.title)}-L${from}-${takeEnd}.md`)
      const body = [
        `# ${src.title} · 第 ${from}-${takeEnd} 行提取稿`,
        '',
        `> 来源：${src.rel} · 提取于 ${today()} · 按行号区间抽取${capped ? '（超 2000 行已截断）' : ''}`,
        '> 本页可直接编辑修正。',
        '',
        '```' + ext,
        ...lines.slice(from - 1, takeEnd),
        '```',
        '',
      ].join('\n')
      writeFileSync(join(dirAbs, name), body, 'utf-8')
      src.extractRel = `${dir}/${name}`
      src.status = 'ready'
      src.index = buildSourceIndex(src)
      src.indexUpdatedAt = nowIso()
      writeFile(f)
      broadcast(BROADCAST_CHANNEL.aiTeachTreeRefresh, { dirRel: dir })
      broadcastSources(wsId)
      return { ok: true, relPath: src.extractRel }
    }
    if (src.type !== 'pdf' && src.type !== 'pptx' && src.type !== 'docx') {
      return { ok: false, error: '仅 pdf / pptx / docx / code 支持自动提取' }
    }
    const rg = anchor.kind === 'pages' ? anchor : { from: 1, to: 9999 }
    let docAbs = abs
    if (src.type === 'docx') {
      const conv = await convertToPdf(abs, getSetting('sofficePath'))
      if (!conv.ok || !conv.pdfPath) return { ok: false, error: conv.error ?? 'Word 文档转 PDF 失败' }
      docAbs = conv.pdfPath
    }
    const pages = src.type === 'pptx'
      ? extractPptxPages(abs).filter((p) => p.n >= rg.from && p.n <= rg.to)
      : (await extractPdfRange(docAbs, rg.from, rg.to)).pages
    if (!pages.length) return { ok: false, error: '区间内没有可提取的页（扫描件请走视觉转写）' }
    const realFrom = Math.min(...pages.map((p) => p.n))
    const realTo = Math.max(...pages.map((p) => p.n))
    const name = uniqueFileName(dirAbs, `${sanitizeTitle(src.title)}-p${realFrom}-${realTo}.md`)
    const body = [
      `# ${src.title} · 第 ${realFrom}-${realTo} 页提取稿`,
      '',
      `> 来源：${src.rel} · 提取于 ${today()} · 由文本层自动抽取（页码为 PDF/幻灯片物理页序）`,
      '> 本页可直接编辑修正。',
      '',
      ...pages.flatMap((p) => [`## p${p.n}`, '', p.text || '（本页无可提取文本）', '']),
    ].join('\n')
    writeFileSync(join(dirAbs, name), body, 'utf-8')
    src.extractRel = `${dir}/${name}`
    src.status = 'ready'
    src.index = buildSourceIndex(src)
    src.indexUpdatedAt = nowIso()
    writeFile(f)
    broadcast(BROADCAST_CHANNEL.aiTeachTreeRefresh, { dirRel: dir })
    broadcastSources(wsId)
    return { ok: true, relPath: src.extractRel }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ===== 章 ID 重映射（大纲重排/重命名时保住分配） =====

export function remapChapterAssignments(wsId: string, oldOutline: CourseOutline | null, newOutline: CourseOutline, getSetting: GetSetting): void {
  if (!oldOutline) return
  const f = readFile()
  const s = f.workspaces[wsId]
  if (!s) return
  let changed = false
  const byName = new Map(newOutline.chapters.map((c) => [String(c.name ?? '').trim(), c.id] as const))
  for (const oldCh of oldOutline.chapters) {
    const newId = byName.get(String(oldCh.name ?? '').trim())
    if (!newId || newId === oldCh.id) continue
    const list = s.assignments[oldCh.id]
    if (!list?.length) continue
    const target = (s.assignments[newId] = s.assignments[newId] ?? [])
    for (const a of list) if (!target.some((x) => x.sourceId === a.sourceId)) target.push(a)
    delete s.assignments[oldCh.id]
    changed = true
  }
  if (changed) {
    writeFile(f)
    broadcastSources(wsId)
  }
}

// ===== 供注入使用：按段 / 助手 / 复习拼素材串 =====

export interface HintSourceItem {
  title: string
  type: SourceType
  path: string
  anchor: string
  mode?: string
  extractPath?: string
}

export interface SourcesHintInput {
  role: 'assistant' | 'segment' | 'review'
  items?: HintSourceItem[]
  /** 助手：摘要行 */
  summary?: string
  /** 复习：章级素材标题 */
  chapterSources?: string[]
  maxChars?: number
}

/** 纯格式化（主进程 / 契约脚本共用）。 */
export function renderSourcesHint(input: SourcesHintInput): string {
  const max = Math.max(400, Number(input.maxChars) || (input.role === 'assistant' ? 2800 : 4000))
  const lines: string[] = []
  if (input.role === 'assistant') {
    lines.push('【课程素材登记摘要（AI教学·课程助手）】')
    lines.push(input.summary || '（还没有登记素材）')
    lines.push('素材登记走 course.sources.register；分章走 course.sources.assign。这里只给摘要，不要要求用户把整份素材贴进对话。')
  } else if (input.role === 'review') {
    lines.push('【本章素材（章级分配，复习用）】')
    const list = input.chapterSources ?? []
    if (!list.length) lines.push('（本章没有分配素材，按已学知识点与各段交接复习）')
    else for (const t of list) lines.push(`- ${t}`)
    lines.push('复习只围绕本章已学知识点；不要引入新知识点。')
  } else {
    lines.push('【本段确认素材（只读这些，不要扫描 SOURCES 下未确认的文件）】')
    const items = input.items ?? []
    if (!items.length) lines.push('（本段没有确认素材，按大纲讲；需要素材请先让用户在本章分配并开段确认）')
    for (const it of items) {
      const bits = [`- ${it.title}`, `类型 ${it.type}`, `区间 ${it.anchor}`]
      if (it.mode) bits.push(it.mode === 'exact' ? '逐知识点匹配' : it.mode === 'narrow' ? '按标题/文件名缩窄' : '回退本章分配')
      bits.push(`路径 ${it.path}`)
      if (it.extractPath) bits.push(`提取稿 ${it.extractPath}`)
      lines.push(bits.join(' · '))
    }
  }
  let s = lines.join('\n')
  if (s.length > max) s = s.slice(0, max) + '\n…（素材清单过长已截断）'
  return s
}

/** 取段快照的展示项（course.ts 用）。 */
export function resolveSegmentSources(wsId: string, segmentSources: Array<{ sourceId: string; label: string; anchor: SourceAnchor; mode?: string }>, getSetting: GetSetting): HintSourceItem[] {
  const s = ensureSources(wsId, getSetting)
  if (!s) return []
  const out: HintSourceItem[] = []
  for (const seg of segmentSources) {
    const src = s.sources.find((x) => x.id === seg.sourceId)
    if (!src) {
      out.push({ title: seg.label, type: 'other', path: '（素材已移除）', anchor: anchorLabel(seg.anchor), mode: seg.mode })
      continue
    }
    out.push({
      title: src.title,
      type: src.type,
      path: src.rel || src.url || '（无路径）',
      anchor: anchorLabel(seg.anchor),
      mode: seg.mode,
      extractPath: src.extractRel || undefined,
    })
  }
  return out
}

/** 章级素材标题（复习注入用）。 */
export function chapterSourceTitles(wsId: string, chapterId: string, getSetting: GetSetting): string[] {
  const s = ensureSources(wsId, getSetting)
  if (!s) return []
  const list = s.assignments[chapterId] ?? []
  return list.map((a) => {
    const src = s.sources.find((x) => x.id === a.sourceId)
    return src ? `${src.title}（${anchorLabel(a.anchor)}）` : `${a.label}（已移除）`
  })
}

/** 助手摘要：总数 / 未分配 / 各章数量。 */
export function assistantSourcesSummary(wsId: string, getSetting: GetSetting): string {
  const s = ensureSources(wsId, getSetting)
  if (!s) return '（还没有登记素材）'
  const sum = getSourceSummary(wsId, getSetting)
  const outline = readOutline(wsId, getSetting)
  const lines = [`已登记 ${sum.total} 条；已分配 ${sum.assigned} 条；未分配 ${sum.unassigned} 条。`]
  if (outline) {
    for (const c of outline.chapters) {
      const n = s.assignments[c.id]?.length ?? 0
      lines.push(`- ${c.name}：${n} 条`)
    }
  }
  if (sum.unassigned > 0) {
    const assigned = new Set(Object.values(s.assignments).flat().map((a) => a.sourceId))
    const un = s.sources.filter((x) => !assigned.has(x.id)).slice(0, 30).map((x) => `${x.title}（${x.type}）`)
    if (un.length) lines.push(`未分配：${un.join('、')}`)
  }
  return lines.join('\n')
}

// ===== IPC =====

export function registerAiTeachingSourceRegistryHandlers(getSetting: GetSetting): void {
  ipcMain.handle('aiTeachCourse:getSources', (_e, wsId: string) => getSources(String(wsId ?? ''), getSetting))
  ipcMain.handle('aiTeachCourse:registerSources', (_e, wsId: string, items: RegisterSourceItem[]) =>
    registerSources(String(wsId ?? ''), items ?? [], getSetting))
  ipcMain.handle('aiTeachCourse:assignSources', (_e, wsId: string, chapterId: string, items: AssignSourceItem[]) =>
    assignSources(String(wsId ?? ''), String(chapterId ?? ''), items ?? [], getSetting))
  ipcMain.handle('aiTeachCourse:removeSource', (_e, wsId: string, sourceId: string) =>
    removeSource(String(wsId ?? ''), String(sourceId ?? ''), getSetting))
  ipcMain.handle('aiTeachCourse:removeAssignment', (_e, wsId: string, chapterId: string, sourceId: string) =>
    removeAssignment(String(wsId ?? ''), String(chapterId ?? ''), String(sourceId ?? ''), getSetting))
  ipcMain.handle('aiTeachCourse:extractSource', (_e, wsId: string, sourceId: string, anchor: SourceAnchor) =>
    extractSource(String(wsId ?? ''), String(sourceId ?? ''), anchor, getSetting))
}
