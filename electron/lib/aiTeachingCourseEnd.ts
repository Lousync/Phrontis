/**
 * AI教学 · 结课 / 资料沉淀 —— 主进程实现（fs / IPC）。
 *
 * 纯函数在 `aiTeachingCourseEndPure.ts`（分类 / 报告 / 目标路径）与
 * `aiTeachingCourseSummary.ts`（课程摘要）；只读守卫在 `aiTeachingCourseEndGuard.ts`。
 *
 * 数据落点：
 * - 结课状态：`.knowbase/modules/aiTeaching/workspaces.json` 的 `endedAt`
 * - 结课报告：`{工作区}/结课报告.md`（重复结课时旧报告改名归档）
 * - 暂存区：`{工作区}/待整理/` + `.manifest.json`（只存工作区相对路径）
 * - 沉淀清单：`.knowbase/modules/aiTeaching/deposits.json`（按 `relInWs` 幂等）
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { ipcMain } from 'electron'
import { getCurrentVault } from 'phrontis-core/kbStore/vaultContext'
import { readJson, writeJsonOrThrow } from 'phrontis-core/kbStore/jsonStore'
import { parseMarkdown } from 'phrontis-core/kbStore/mdStore'
import { readQuizRecords, readQuizRecordTags, readQuizTags } from 'phrontis-core/kbStore/quizVaultRepo'
import {
  vaultCreateCategory,
  vaultCreatePage,
  vaultGetCategories,
} from 'phrontis-core/kbStore/knowledgeVaultRepo'
import { broadcast, broadcastDataChanged, BROADCAST_CHANNEL } from '../main/windowBus'
import { copyWorkspacePath, trashWorkspacePath, uniqueFileName } from './workspaceManager'
import { getCourseState } from './aiTeachingCourse'
import { getWorkspace, getWorkspaceEndedAt, setWorkspaceEndedAt, workspaceFolderRel } from './aiTeachingWorkspaces'
import { learnedUnitIds, summarizeCourseState, summarizeSegments } from './aiTeachingCourseSummary'
import {
  DEFAULT_SUBFOLDER,
  END_REPORT_FILE,
  STAGING_FOLDER_NAME,
  STAGING_MANIFEST_FILE,
  buildArtifactInventory,
  depositTargetRel,
  extractReportSummary,
  renderCourseEndReport,
  reportArchiveName,
  sanitizeTargetSegment,
  toStagingEntry,
  type DepositFile,
  type DepositWorkspaceRecord,
  type EndArtifact,
  type EndArtifactGroup,
  type EndReportQuizSummary,
  type EndTarget,
  type StagingManifest,
} from './aiTeachingCourseEndPure'

const DEPOSIT_MODULE = 'modules/aiTeaching'
const DEPOSIT_KEY = 'deposits.json'
const STAGING_DIR = STAGING_FOLDER_NAME
const MAX_WALK_DEPTH = 5
const MAX_WALK_FILES = 5000

interface WsCtx {
  rootId: string
  rootPath: string
  wsId: string
  name: string
  folderRel: string
  wsAbs: string
}

function ctxOf(wsId: string, getSetting: (key: string) => unknown): WsCtx | null {
  const vault = getCurrentVault()
  if (!vault) return null
  const ws = getWorkspace(wsId)
  const folderRel = workspaceFolderRel(wsId, getSetting)
  if (!ws || !folderRel) return null
  return { rootId: vault.rootId, rootPath: vault.rootPath, wsId, name: ws.name, folderRel, wsAbs: join(vault.rootPath, folderRel) }
}

function broadcastTree(folderRel: string): void {
  broadcast(BROADCAST_CHANNEL.aiTeachTreeRefresh, { dirRel: folderRel })
}

function broadcastCourse(wsId: string): void {
  broadcast(BROADCAST_CHANNEL.aiTeachCourseRefresh, { wsId })
}

/** 工作区内所有文件（工作区相对路径 + 字节数）；跳过隐藏 / 素材 / 暂存 / 模板目录 */
function walkWorkspace(ctx: WsCtx): Array<{ relInWs: string; sizeBytes: number }> {
  const out: Array<{ relInWs: string; sizeBytes: number }> = []
  const skip = new Set(['SOURCES', '待整理', '_templates', 'node_modules', '教材', '_extracts'])
  const stack: Array<{ abs: string; rel: string; depth: number }> = [{ abs: ctx.wsAbs, rel: '', depth: 0 }]
  let guard = 0
  while (stack.length && out.length < MAX_WALK_FILES && guard++ < 10000) {
    const cur = stack.pop() as { abs: string; rel: string; depth: number }
    let entries: import('fs').Dirent[]
    try { entries = readdirSync(cur.abs, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const rel = cur.rel ? `${cur.rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (cur.depth >= MAX_WALK_DEPTH) continue
        if (skip.has(e.name) || skip.has(e.name.toLowerCase())) continue
        stack.push({ abs: join(cur.abs, e.name), rel, depth: cur.depth + 1 })
        continue
      }
      if (!e.isFile()) continue
      let size = 0
      try { size = statSync(join(cur.abs, e.name)).size } catch { /* 读不到按 0 计 */ }
      out.push({ relInWs: rel, sizeBytes: size })
    }
  }
  return out
}

export function listEndArtifacts(wsId: string, getSetting: (key: string) => unknown): EndArtifact[] {
  const ctx = ctxOf(wsId, getSetting)
  if (!ctx) return []
  return buildArtifactInventory(walkWorkspace(ctx))
}

// ===== 测验摘要（只读 quiz 数据，不修改） =====

function collectQuizSummary(ctx: WsCtx, files?: Array<{ relInWs: string; sizeBytes: number }>): { summary: EndReportQuizSummary | null; quizDocs: number; pageIds: Set<string> } {
  const quizRels = (files ?? walkWorkspace(ctx)).map((f) => f.relInWs).filter((rel) => /(^|\/)测验[·-][^/]*\.md$/i.test(rel))
  const pageIds = new Set<string>()
  for (const rel of quizRels) {
    try {
      const doc = parseMarkdown(readFileSync(join(ctx.wsAbs, rel), 'utf-8'))
      const id = String(doc.frontmatter?.id ?? '').trim()
      pageIds.add(id || `auto:${ctx.folderRel}/${rel}`)
    } catch { /* 读失败跳过该题单 */ }
  }
  if (!pageIds.size) return { summary: null, quizDocs: quizRels.length, pageIds }
  const records = readQuizRecords().filter((r) => pageIds.has(String(r.page_id)))
  if (!records.length) return { summary: null, quizDocs: quizRels.length, pageIds }
  const perPage = new Map<string, { correct: number; wrong: number }>()
  for (const r of records) {
    const k = String(r.page_id)
    const cur = perPage.get(k) ?? { correct: 0, wrong: 0 }
    cur.correct += Number(r.correct_count) || 0
    cur.wrong += Number(r.wrong_count) || 0
    perPage.set(k, cur)
  }
  let scoreSum = 0
  let scorePages = 0
  let wrong = 0
  for (const v of perPage.values()) {
    const total = v.correct + v.wrong
    wrong += v.wrong
    if (total > 0) {
      scoreSum += (v.correct / total) * 100
      scorePages++
    }
  }
  const avgScore = scorePages ? Math.round(scoreSum / scorePages) : 0
  const tagName = new Map(readQuizTags().map((t) => [t.id, t.name] as const))
  const wrongIds = new Set(records.filter((r) => (Number(r.wrong_count) || 0) > 0).map((r) => r.id))
  const tagCounts = new Map<string, number>()
  for (const rt of readQuizRecordTags()) {
    if (!wrongIds.has(rt.record_id)) continue
    const name = tagName.get(rt.tag_id)
    if (!name) continue
    tagCounts.set(name, (tagCounts.get(name) ?? 0) + 1)
  }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3)
    .map(([name]) => name)
  return {
    summary: { quizzes: perPage.size, avgScore, wrong, topTags },
    quizDocs: quizRels.length,
    pageIds,
  }
}

// ===== 暂存区 =====

function stagingDirRel(ctx: WsCtx): string {
  return `${ctx.folderRel}/${STAGING_DIR}`
}

function readStagingManifest(ctx: WsCtx): StagingManifest | null {
  const abs = join(ctx.wsAbs, STAGING_DIR, STAGING_MANIFEST_FILE)
  if (!existsSync(abs)) return null
  try {
    const raw = JSON.parse(readFileSync(abs, 'utf-8')) as StagingManifest
    if (!raw || raw.v !== 1 || !Array.isArray(raw.entries)) return null
    return raw
  } catch { return null }
}

function writeStagingManifest(ctx: WsCtx, manifest: StagingManifest): void {
  const abs = join(ctx.wsAbs, STAGING_DIR, STAGING_MANIFEST_FILE)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, JSON.stringify(manifest, null, 2), 'utf-8')
}

/** 暂存副本 → 渲染层的 artifact 形状（id 仍用课程原件路径，便于回查 / 去重） */
function stagingAsArtifacts(manifest: StagingManifest | null): EndArtifact[] {
  return (manifest?.entries ?? []).map((e) => ({
    id: e.id,
    group: e.group,
    title: e.title,
    relInWs: e.sourceRelInWs,
    chapterRel: e.chapterRel,
    kind: e.kind,
    sizeBytes: e.size,
  }))
}

async function clearStaging(ctx: WsCtx): Promise<void> {
  const abs = join(ctx.wsAbs, STAGING_DIR)
  if (!existsSync(abs)) return
  await trashWorkspacePath(ctx.rootId, stagingDirRel(ctx))
}

/** 收集：校验 → 清空旧暂存 → 逐条复制 → 写清单。原件始终不动。 */
export async function collectEndArtifacts(
  wsId: string,
  relsInWs: string[],
  getSetting: (key: string) => unknown,
): Promise<{ ok: boolean; count: number; error?: string }> {
  const ctx = ctxOf(wsId, getSetting)
  if (!ctx) return { ok: false, count: 0, error: '工作区不存在' }
  const wanted = new Set((relsInWs ?? []).map((r) => String(r ?? '').replace(/\\/g, '/')).filter(Boolean))
  if (!wanted.size) return { ok: false, count: 0, error: '没有选中资料' }
  const inventory = buildArtifactInventory(walkWorkspace(ctx))
  const selected = inventory.filter((a) => wanted.has(a.relInWs))
  if (!selected.length) return { ok: false, count: 0, error: '选中的文件不是可沉淀资料' }
  try {
    await clearStaging(ctx)
    mkdirSync(join(ctx.wsAbs, STAGING_DIR), { recursive: true })
    const entries = []
    const usedRels = new Set<string>()
    for (const a of selected) {
      const planned = toStagingEntry(a)
      let stageRelInWs = planned.stageRelInWs
      if (usedRels.has(stageRelInWs)) {
        const dirRel = dirname(stageRelInWs).replace(/\\/g, '/')
        const base = stageRelInWs.slice(dirRel.length + 1)
        const name = uniqueFileName(join(ctx.wsAbs, dirRel), base)
        stageRelInWs = `${dirRel}/${name}`
      }
      usedRels.add(stageRelInWs)
      copyWorkspacePath(ctx.rootId, `${ctx.folderRel}/${a.relInWs}`, `${ctx.folderRel}/${stageRelInWs}`)
      entries.push({ ...planned, stageRelInWs })
    }
    const manifest: StagingManifest = { v: 1, wsId, createdAt: new Date().toISOString(), entries }
    writeStagingManifest(ctx, manifest)
    // 先复制再写清单：中断时最多留下没有清单的暂存副本，下次收集会整体回收
    broadcastTree(ctx.folderRel)
    return { ok: true, count: entries.length }
  } catch (e) {
    return { ok: false, count: 0, error: (e as Error).message }
  }
}

export function getEndStaging(wsId: string, getSetting: (key: string) => unknown): EndArtifact[] {
  const ctx = ctxOf(wsId, getSetting)
  if (!ctx) return []
  return stagingAsArtifacts(readStagingManifest(ctx))
}

// ===== 沉淀 =====

function readDepositFile(): DepositFile {
  const raw = readJson<DepositFile>(DEPOSIT_MODULE, DEPOSIT_KEY, { v: 1, workspaces: {} })
  if (!raw || typeof raw !== 'object') return { v: 1, workspaces: {} }
  if (!raw.workspaces || typeof raw.workspaces !== 'object') raw.workspaces = {}
  return raw
}

function wsDeposit(file: DepositFile, wsId: string): DepositWorkspaceRecord {
  if (!file.workspaces[wsId]) file.workspaces[wsId] = { lastTarget: null, entries: {} }
  const rec = file.workspaces[wsId]
  if (!rec.entries || typeof rec.entries !== 'object') rec.entries = {}
  return rec
}

export interface DepositResult {
  ok: boolean
  deposited: number
  skipped: number
  failed: number
  targetRel: string | null
  error?: string
}

export interface DepositSpaceNode {
  id: string
  name: string
  path: string
  notebooks: Array<{ id: string; name: string; path: string }>
}

export interface DepositTargets {
  spaces: DepositSpaceNode[]
  lastTarget: EndTarget | null
  defaults: EndTarget
}

/** 目标目录解析 / 惰性创建（space → notebook → subfolder → chapter） */
function ensureCategory(
  name: string,
  type: 'space' | 'notebook' | 'folder',
  parentId: string | null,
  parentRel: string | null,
  rootPath: string,
): { id: string; path: string } {
  const cats = vaultGetCategories()
  const found = cats.find((c) => (c.parentId ?? null) === parentId && c.name === name)
  if (found) return { id: found.id, path: found.path ?? (parentRel ? `${parentRel}/${name}` : name) }
  const path = parentRel ? `${parentRel}/${name}` : name
  const abs = join(rootPath, path)
  if (!existsSync(abs)) mkdirSync(abs, { recursive: true })
  const id = randomUUID()
  vaultCreateCategory({ id, name, categoryType: type, parentId, path })
  return { id, path }
}

export function getDepositTargets(wsId: string, getSetting: (key: string) => unknown): DepositTargets {
  void getSetting
  const spaces = vaultGetCategories()
    .filter((c) => c.categoryType === 'space')
    .map((s) => ({
      id: s.id,
      name: s.name,
      path: s.path ?? s.name,
      notebooks: vaultGetCategories()
        .filter((n) => n.categoryType === 'notebook' && n.parentId === s.id)
        .map((n) => ({ id: n.id, name: n.name, path: n.path ?? `${s.path ?? s.name}/${n.name}` })),
    }))
  const file = readDepositFile()
  const lastTarget = wsId ? (file.workspaces[wsId]?.lastTarget ?? null) : null
  const courseName = wsId ? (getWorkspace(wsId)?.name ?? '') : ''
  const defaultSpace = lastTarget?.space || (spaces.some((s) => s.name === '考研') ? '考研' : spaces[0]?.name ?? '')
  const defaults: EndTarget = {
    space: defaultSpace,
    notebook: lastTarget?.notebook || courseName || '课程复习',
    subfolder: lastTarget?.subfolder ?? DEFAULT_SUBFOLDER,
    keepChapter: lastTarget?.keepChapter ?? true,
  }
  return { spaces, lastTarget, defaults }
}

export async function depositEndArtifacts(
  wsId: string,
  entryIds: string[],
  target: EndTarget,
  getSetting: (key: string) => unknown,
): Promise<DepositResult> {
  const ctx = ctxOf(wsId, getSetting)
  if (!ctx) return { ok: false, deposited: 0, skipped: 0, failed: 0, targetRel: null, error: '工作区不存在' }
  const manifest = readStagingManifest(ctx)
  if (!manifest || !manifest.entries.length) {
    return { ok: false, deposited: 0, skipped: 0, failed: 0, targetRel: null, error: '暂存区没有待整理资料' }
  }
  const wanted = new Set((entryIds ?? []).map(String))
  const entries = manifest.entries.filter((e) => wanted.has(e.id))
  if (!entries.length) return { ok: false, deposited: 0, skipped: 0, failed: 0, targetRel: null, error: '没有选中资料' }

  const space = sanitizeTargetSegment(target.space)
  const notebook = sanitizeTargetSegment(target.notebook)
  const sub = sanitizeTargetSegment(target.subfolder)
  if (!space || !notebook) return { ok: false, deposited: 0, skipped: 0, failed: 0, targetRel: null, error: '目标区域或笔记本名称无效' }
  const cleanTarget: EndTarget = { space, notebook, subfolder: sub, keepChapter: target.keepChapter !== false }

  try {
    const spaceCat = ensureCategory(space, 'space', null, null, ctx.rootPath)
    const bookCat = ensureCategory(notebook, 'notebook', spaceCat.id, spaceCat.path, ctx.rootPath)
    const baseCat = sub ? ensureCategory(sub, 'folder', bookCat.id, bookCat.path, ctx.rootPath) : bookCat
    const file = readDepositFile()
    const rec = wsDeposit(file, wsId)
    const endedAt = getWorkspaceEndedAt(wsId) || new Date().toISOString()
    let deposited = 0
    let skipped = 0
    let failed = 0
    let firstError: string | undefined

    for (const entry of entries) {
      try {
        const stageAbs = join(ctx.wsAbs, entry.stageRelInWs)
        if (!existsSync(stageAbs)) { failed++; continue }
        const chapter = cleanTarget.keepChapter && entry.chapterRel ? sanitizeTargetSegment(entry.chapterRel) : ''
        const chapterCat = chapter ? ensureCategory(chapter, 'folder', baseCat.id, baseCat.path, ctx.rootPath) : baseCat
        if (entry.kind === 'md') {
          const prior = rec.entries[entry.sourceRelInWs]
          if (prior && prior.targetRel && existsSync(join(ctx.rootPath, prior.targetRel))) { skipped++; continue }
          const raw = readFileSync(stageAbs, 'utf-8')
          const doc = parseMarkdown(raw)
          const fmTitle = typeof doc.frontmatter?.title === 'string' ? String(doc.frontmatter.title).trim() : ''
          const page = vaultCreatePage({
            title: fmTitle || entry.title,
            contentMd: doc.body,
            dirRel: chapterCat.path,
            fileType: 'md',
            tags: ['AI教学', ctx.name].filter(Boolean),
            extraFrontmatter: {
              aiTeachCourse: wsId,
              aiTeachSource: entry.sourceRelInWs,
              aiTeachEndedAt: endedAt,
            },
          })
          rec.entries[entry.sourceRelInWs] = {
            pageId: page.id,
            targetRel: page.path,
            kind: entry.kind,
            depositedAt: new Date().toISOString(),
          }
          deposited++
        } else {
          const planned = depositTargetRel(cleanTarget, entry)
          const dirRel = dirname(planned).replace(/\\/g, '/')
          const base = planned.slice(planned.lastIndexOf('/') + 1)
          const dirAbs = join(ctx.rootPath, dirRel)
          mkdirSync(dirAbs, { recursive: true })
          const name = uniqueFileName(dirAbs, base)
          const targetRel = `${dirRel}/${name}`
          const prior = rec.entries[entry.sourceRelInWs]
          if (prior && prior.targetRel && existsSync(join(ctx.rootPath, prior.targetRel))) { skipped++; continue }
          copyWorkspacePath(ctx.rootId, `${ctx.folderRel}/${entry.stageRelInWs}`, targetRel)
          rec.entries[entry.sourceRelInWs] = {
            pageId: '',
            targetRel,
            kind: entry.kind,
            depositedAt: new Date().toISOString(),
          }
          deposited++
        }
      } catch (e) {
        failed++
        if (!firstError) firstError = (e as Error).message
      }
    }

    rec.lastTarget = cleanTarget
    writeJsonOrThrow(DEPOSIT_MODULE, DEPOSIT_KEY, file)
    broadcastDataChanged('knowledge')
    broadcastTree(ctx.folderRel)
    broadcastCourse(wsId)

    if (failed === 0) {
      await clearStaging(ctx)
      broadcastTree(ctx.folderRel)
      if (!getWorkspaceEndedAt(wsId)) endCourse(wsId, getSetting)
      else rewriteReportAfterDeposit(ctx, getSetting, cleanTarget, deposited + skipped)
    }
    return {
      ok: failed === 0,
      deposited,
      skipped,
      failed,
      targetRel: sub ? `${space}/${notebook}/${sub}` : `${space}/${notebook}`,
      ...(failed ? { error: firstError || `${failed} 份资料沉淀失败` } : {}),
    }
  } catch (e) {
    return { ok: false, deposited: 0, skipped: 0, failed: entries.length, targetRel: null, error: (e as Error).message }
  }
}

// ===== 结课报告 =====

function reportRel(ctx: WsCtx): string {
  return `${ctx.folderRel}/${END_REPORT_FILE}`
}

function missingChapterNames(outline: ReturnType<typeof getCourseState>['outline'], learned: Set<string>): string[] {
  const out: string[] = []
  for (const c of outline?.chapters ?? []) {
    if (!c.units.length) continue
    if (c.units.every((u) => learned.has(u.id))) continue
    out.push(c.name)
  }
  return out
}

interface WriteReportOptions {
  archive: boolean
  deposit: { deposited: number; targetRel: string | null; kept: number }
}

function writeEndReport(ctx: WsCtx, getSetting: (key: string) => unknown, opts: WriteReportOptions): { relInWs: string; markdown: string } {
  const state = getCourseState(ctx.wsId, getSetting)
  const outline = state.outline
  const summary = summarizeCourseState(outline, { units: state.progress, lessons: state.lessons, reviews: state.reviews })
  const segments = summarizeSegments(outline, { lessons: state.lessons })
  const quiz = collectQuizSummary(ctx)
  const learned = learnedUnitIds(outline, { units: state.progress, lessons: state.lessons })
  const wsMeta = getWorkspace(ctx.wsId)
  const endedAt = getWorkspaceEndedAt(ctx.wsId) || new Date().toISOString()
  const markdown = renderCourseEndReport({
    courseName: ctx.name,
    startedAt: wsMeta?.createdAt ?? null,
    endedAt,
    chapters: summary?.chapters ?? outline?.chapters.length ?? 0,
    total: summary?.total ?? 0,
    learned: summary?.learned ?? 0,
    segments: segments.segments,
    endedSegments: segments.ended,
    openSegments: segments.open,
    quizzes: quiz.summary,
    missingChapters: missingChapterNames(outline, learned),
    deposit: opts.deposit,
  })
  const relInWs = END_REPORT_FILE
  const abs = join(ctx.wsAbs, relInWs)
  if (opts.archive && existsSync(abs)) {
    const name = uniqueFileName(ctx.wsAbs, reportArchiveName(new Date()))
    renameSync(abs, join(ctx.wsAbs, name))
  }
  writeFileSync(abs, markdown, 'utf-8')
  return { relInWs, markdown }
}

/** 沉淀完成后更新报告「资料处置」段（不重复结课、不再归档） */
function rewriteReportAfterDeposit(ctx: WsCtx, getSetting: (key: string) => unknown, target: EndTarget, depositedCount: number): void {
  try {
    const file = readDepositFile()
    const all = Object.keys(file.workspaces[ctx.wsId]?.entries ?? {}).length
    const kept = collectQuizSummary(ctx).quizDocs
    const targetRel = target.subfolder ? `${target.space}/${target.notebook}/${target.subfolder}` : `${target.space}/${target.notebook}`
    writeEndReport(ctx, getSetting, {
      archive: false,
      deposit: { deposited: all || depositedCount, targetRel, kept },
    })
  } catch { /* 报告更新失败不影响沉淀结果 */ }
}

export function endCourse(
  wsId: string,
  getSetting: (key: string) => unknown,
): { ok: boolean; endedAt?: string; reportRel?: string; error?: string } {
  const ctx = ctxOf(wsId, getSetting)
  if (!ctx) return { ok: false, error: '工作区不存在' }
  const state = getCourseState(wsId, getSetting)
  if (!state.outline) return { ok: false, error: '课程还没有大纲' }
  try {
    const now = new Date().toISOString()
    const file = readDepositFile()
    const rec = wsDeposit(file, wsId)
    const deposited = Object.keys(rec.entries).length
    const target = rec.lastTarget
    const space = target ? sanitizeTargetSegment(target.space) : ''
    const notebook = target ? sanitizeTargetSegment(target.notebook) : ''
    const sub = target ? sanitizeTargetSegment(target.subfolder) : ''
    const targetRel = space && notebook ? (sub ? `${space}/${notebook}/${sub}` : `${space}/${notebook}`) : null
    const report = writeEndReport(ctx, getSetting, {
      archive: true,
      deposit: { deposited, targetRel, kept: collectQuizSummary(ctx).quizDocs },
    })
    setWorkspaceEndedAt(wsId, now)
    broadcastTree(ctx.folderRel)
    broadcastCourse(wsId)
    return { ok: true, endedAt: now, reportRel: report.relInWs }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function reopenCourse(wsId: string): { ok: boolean; error?: string } {
  const r = setWorkspaceEndedAt(wsId, null)
  if (!r.ok) return r
  broadcastCourse(wsId)
  return { ok: true }
}

export function getEndReport(wsId: string, getSetting: (key: string) => unknown): { relInWs: string; markdown: string; summary: string } | null {
  const ctx = ctxOf(wsId, getSetting)
  if (!ctx) return null
  const abs = join(ctx.wsAbs, END_REPORT_FILE)
  if (!existsSync(abs)) return null
  try {
    const raw = readFileSync(abs, 'utf-8')
    const body = parseMarkdown(raw).body
    const file = readDepositFile()
    const deposited = Object.keys(file.workspaces[wsId]?.entries ?? {}).length
    return {
      relInWs: END_REPORT_FILE,
      markdown: body,
      summary: extractReportSummary(body, deposited ? `已沉淀 ${deposited} 份` : ''),
    }
  } catch { return null }
}

export interface CourseEndState {
  wsId: string
  name: string
  endedAt: string | null
  startedAt: string
  completion: ReturnType<typeof summarizeCourseState>
  segments: { segments: number; ended: number; open: number }
  quiz: EndReportQuizSummary | null
  quizDocCount: number
  artifacts: EndArtifact[]
  staging: EndArtifact[]
  deposit: { count: number; target: EndTarget | null }
  targets: DepositTargets
  report: { relInWs: string; summary: string } | null
  assistantSessionId: string | null
  totals: { artifacts: number; kept: number }
}

export function getCourseEndState(wsId: string, getSetting: (key: string) => unknown): CourseEndState | null {
  const ctx = ctxOf(wsId, getSetting)
  if (!ctx) return null
  const state = getCourseState(wsId, getSetting)
  const completion = summarizeCourseState(state.outline, { units: state.progress, lessons: state.lessons, reviews: state.reviews })
  const segments = summarizeSegments(state.outline, { lessons: state.lessons })
  const files = walkWorkspace(ctx)
  const quizInfo = collectQuizSummary(ctx, files)
  const manifest = readStagingManifest(ctx)
  const file = readDepositFile()
  const rec = file.workspaces[wsId]
  const depositTarget = rec?.lastTarget ?? null
  const reportAbs = join(ctx.wsAbs, END_REPORT_FILE)
  let report: { relInWs: string; summary: string } | null = null
  if (existsSync(reportAbs)) {
    try {
      const md = readFileSync(reportAbs, 'utf-8')
      const deposited = Object.keys(rec?.entries ?? {}).length
      report = { relInWs: END_REPORT_FILE, summary: extractReportSummary(md, deposited ? `已沉淀 ${deposited} 份` : '') }
    } catch { report = null }
  }
  const artifacts = buildArtifactInventory(files)
  return {
    wsId,
    name: ctx.name,
    endedAt: getWorkspaceEndedAt(wsId),
    startedAt: getWorkspace(ctx.wsId)?.createdAt ?? '',
    completion,
    segments,
    quiz: quizInfo.summary,
    quizDocCount: quizInfo.quizDocs,
    artifacts,
    staging: stagingAsArtifacts(manifest),
    deposit: { count: Object.keys(rec?.entries ?? {}).length, target: depositTarget },
    targets: getDepositTargets(wsId, getSetting),
    report,
    assistantSessionId: state.assistantSessionId,
    totals: { artifacts: artifacts.length, kept: quizInfo.quizDocs },
  }
}

// ===== IPC =====

export function registerAiTeachingCourseEndHandlers(getSetting: (key: string) => unknown): void {
  ipcMain.handle('aiTeachCourse:getEndState', (_e, wsId: string) => getCourseEndState(String(wsId ?? ''), getSetting))
  ipcMain.handle('aiTeachCourse:listEndArtifacts', (_e, wsId: string) => listEndArtifacts(String(wsId ?? ''), getSetting))
  ipcMain.handle('aiTeachCourse:collectEndArtifacts', (_e, wsId: string, rels: string[]) => collectEndArtifacts(String(wsId ?? ''), Array.isArray(rels) ? rels : [], getSetting))
  ipcMain.handle('aiTeachCourse:getEndStaging', (_e, wsId: string) => getEndStaging(String(wsId ?? ''), getSetting))
  ipcMain.handle('aiTeachCourse:depositEndArtifacts', (_e, wsId: string, ids: string[], target: EndTarget) => depositEndArtifacts(String(wsId ?? ''), Array.isArray(ids) ? ids : [], target as EndTarget, getSetting))
  ipcMain.handle('aiTeachCourse:endCourse', (_e, wsId: string) => endCourse(String(wsId ?? ''), getSetting))
  ipcMain.handle('aiTeachCourse:reopenCourse', (_e, wsId: string) => reopenCourse(String(wsId ?? '')))
  ipcMain.handle('aiTeachCourse:getEndReport', (_e, wsId: string) => getEndReport(String(wsId ?? ''), getSetting))
  ipcMain.handle('aiTeachCourse:getDepositTargets', (_e, wsId: string) => getDepositTargets(String(wsId ?? ''), getSetting))
}
