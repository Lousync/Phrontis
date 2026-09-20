import { readFileSync } from 'fs'
import { join } from 'path'
import { ipcMain } from 'electron'
import { getVaultKbRoot } from './vaultContext'
import { getKnowledgeIndex } from './knowledgeIndex'
import { chunkPageText } from './semanticChunker'
import {
  clearSemanticsMemo, isModelMismatch, loadSemantics, removeSemanticsFiles, writeSemantics,
  type SemanticPageEntry,
} from './semanticStore'
import { llmEmbed, resolveEmbedProvider } from '../llmService'

/**
 * 语义索引构建/增量管线（knowledge-index-design §5-§7）。
 *
 * 触发模型：懒构建 —— searchKnowledge 语义路与设置页「重建」都走 ensureSemanticIndex()，
 * 内部按页 mtime + chunkKey(contentHash) 双层 diff，只对真正变化的块发嵌入请求；
 * 未配置 embeddingModel / 调用失败 → 返回 enabled:false 优雅降级（设计红线：不报错不缺失）。
 * invalidateKnowledgeIndex() 每次写盘都会清 memo，下一次 ensure 重新 diff——
 * 由于 diff 本身廉价（索引/正文已 memo 化），高频保存不会产生多余嵌入调用。
 */

export interface SemanticBuildResult {
  enabled: boolean
  /** 不可用原因：novault / noEmbeddingModel / embedFailed / inprogress 复用 */
  reason?: 'novault' | 'noEmbeddingModel' | 'embedFailed'
  error?: string
  /** 本次落库的页数 / 块数 */
  pages: number
  chunks: number
  /** 复用旧向量（key 未变）的块数——增量健康的指标 */
  reused: number
  /** 本次实际发往嵌入端点的块数 */
  embedded: number
}

/** 并发防抖：搜索与设置页同时触发只跑一次 */
let inFlight: Promise<SemanticBuildResult> | null = null

export function ensureSemanticIndex(opts?: { force?: boolean }): Promise<SemanticBuildResult> {
  if (inFlight) return inFlight
  inFlight = buildSemanticIndex(opts).finally(() => { inFlight = null })
  return inFlight
}

async function buildSemanticIndex(opts?: { force?: boolean }): Promise<SemanticBuildResult> {
  const empty = { pages: 0, chunks: 0, reused: 0, embedded: 0 }
  const root = getVaultKbRoot()
  if (!root) return { enabled: false, reason: 'novault', ...empty }
  const resolved = resolveEmbedProvider()
  if (!resolved) return { enabled: false, reason: 'noEmbeddingModel', ...empty }
  const model = resolved.model

  const idx = getKnowledgeIndex()
  // 与 vaultSearchPages 同口径：草稿不索引；二进制归档文件无正文不索引
  const mdPages = idx.pages.filter((p) => p.entryKind !== 'file')

  // 模型/维度不匹配或 force = 旧库整体作废（ADR：不混维度）
  const stale = !!opts?.force || isModelMismatch(root, model, loadSemantics(root).file.dim || 0)
  const prevPages: Record<string, SemanticPageEntry> = stale ? {} : loadSemantics(root).file.pages

  // ---- 第一遍：按页 diff，收集需嵌入的新块 ----
  interface PendingPage { pageId: string; mtimeMs: number; chunks: { key: string; idx: number; text: string; hash: string; reuseOffset: number }[] }
  const pending: PendingPage[] = []
  const embedTexts: string[] = []
  const embedIndex = new Map<string, number>()
  let reused = 0

  for (const page of mdPages) {
    const prev = prevPages[page.id]
    // mtime 未变 = 页面内容未变，整页复用
    if (prev && prev.mtimeMs === page.mtimeMs && prev.chunks.length > 0) {
      pending.push({
        pageId: page.id, mtimeMs: page.mtimeMs,
        chunks: prev.chunks.map((c) => ({ key: c.key, idx: c.idx, text: '', hash: c.hash, reuseOffset: c.offset })),
      })
      reused += prev.chunks.length
      continue
    }
    let rawMd = ''
    try {
      rawMd = readFileSync(join(root, page.path), 'utf-8')
    } catch { continue } // 页面被并发删除等：本轮跳过，下轮 diff 自然收敛
    const chunks = chunkPageText(page.id, page.title, rawMd)
    const prevByKey = new Map((prev?.chunks ?? []).map((c) => [c.key, c]))
    const metas = chunks.map((c) => {
      const old = prevByKey.get(c.key)
      if (old) {
        reused++
        return { key: c.key, idx: c.idx, text: c.text, hash: c.hash, reuseOffset: old.offset }
      }
      if (!embedIndex.has(c.key)) {
        embedIndex.set(c.key, embedTexts.length)
        embedTexts.push(c.text)
      }
      return { key: c.key, idx: c.idx, text: c.text, hash: c.hash, reuseOffset: -1 }
    })
    pending.push({ pageId: page.id, mtimeMs: page.mtimeMs, chunks: metas })
  }

  // ---- 嵌入新块（失败即整轮放弃，下次重试；设计 §6 失败策略） ----
  let vectors: number[][] = []
  if (embedTexts.length > 0) {
    const r = await llmEmbed(embedTexts)
    if (!r.ok) return { enabled: false, reason: 'embedFailed', error: r.error, ...empty }
    vectors = r.vectors
    if (vectors.length !== embedTexts.length) {
      return { enabled: false, reason: 'embedFailed', error: '嵌入返回数与请求不符', ...empty }
    }
  }
  const dim = vectors[0]?.length ?? loadSemantics(root).file.dim
  if (!dim || !Number.isFinite(dim)) {
    // 库为空且无新块：无需写入（首次且页面全空）
    return { enabled: true, pages: mdPages.length, chunks: 0, reused, embedded: 0 }
  }

  // ---- 第二遍：装配向量数组（复用块从旧 bin 拷贝，新块填嵌入结果） ----
  const titleById = new Map(mdPages.map((p) => [p.id, p.title]))
  const old = stale ? { data: null, file: { pages: {} as Record<string, SemanticPageEntry>, dim: 0 } } : loadSemantics(root)
  const total = pending.reduce((n, p) => n + p.chunks.length, 0)
  const out = new Float32Array(total * dim)
  const newPages: Record<string, SemanticPageEntry> = {}
  let offset = 0
  for (const p of pending) {
    const title = titleById.get(p.pageId) ?? ''
    const metas = p.chunks.map((c) => {
      const rec = offset++
      if (c.reuseOffset >= 0 && old.data) {
        out.set(new Float32Array(old.data.buffer, old.data.byteOffset + c.reuseOffset * dim * 4, dim), rec * dim)
      } else {
        const v = vectors[embedIndex.get(c.key) ?? -1]
        if (v && v.length === dim) out.set(v, rec * dim)
      }
      return { key: c.key, idx: c.idx, title, offset: rec, hash: c.hash }
    })
    newPages[p.pageId] = { mtimeMs: p.mtimeMs, chunks: metas }
  }

  if (stale) removeSemanticsFiles(root)
  writeSemantics(root, { model, dim, vaultPath: root, pages: newPages }, out)
  clearSemanticsMemo()
  return { enabled: true, pages: Object.keys(newPages).length, chunks: total, reused, embedded: embedTexts.length }
}

/** 设置页状态展示用 */
export function semanticStatus(): { configured: boolean; model: string; pages: number; chunks: number; generatedAt: string } {
  const resolved = resolveEmbedProvider()
  const root = getVaultKbRoot()
  if (!root || !resolved) {
    return { configured: false, model: resolved?.model ?? '', pages: 0, chunks: 0, generatedAt: '' }
  }
  const { file } = loadSemantics(root)
  const chunks = Object.values(file.pages).reduce((n, p) => n + p.chunks.length, 0)
  return {
    configured: true,
    model: file.model || resolved.model,
    pages: Object.keys(file.pages).length,
    chunks,
    generatedAt: file.generatedAt,
  }
}

// ===== 设置页 IPC（AiToolsView 语义索引状态卡）=====

export function registerSemanticIndexHandlers(): void {
  ipcMain.handle('knowledge:semanticStatus', () => semanticStatus())
  ipcMain.handle('knowledge:semanticRebuild', async (_e, force: unknown) => {
    const r = await ensureSemanticIndex({ force: force === true })
    return { ok: r.enabled || r.reason === 'noEmbeddingModel', ...r }
  })
}
