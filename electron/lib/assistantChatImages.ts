/**
 * 对话图片输入（P2 多模态）：落盘 / 读回 / 删除。
 *
 * 存储：`<vault>/.knowbase/agent/images/<sessionId>/<uuid>.<ext>`（随仓库走、不进索引）。
 * 消息行只存 `ChatImageRef`（相对路径 + 元信息），运行时再读成 data URL 发给模型。
 * 这样消息 JSONL 不会被 base64 撑大，图片也能随仓库一起搬走。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getCurrentVault, getVaultKbRoot } from 'phrontis-core/kbStore/vaultContext'
import { resolveSafe } from './workspaceManager'
import {
  MAX_CHAT_IMAGES, MAX_HISTORY_IMAGES, dataUrlOfBase64, extForImageMime, validateChatImageInputs,
  type ChatImageRef,
} from './assistantChatImagesPure'

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/
const IMAGES_SEG = 'agent/images'

function imagesRoot(): string | null {
  const kb = getVaultKbRoot()
  return kb ? join(kb, 'agent', 'images') : null
}

function safeSessionId(raw: unknown): string | null {
  const id = String(raw ?? '').trim()
  return SESSION_ID_RE.test(id) ? id : null
}

/** 判断 relPath 是否本模块管理的图片路径（防消息行被篡改后读任意文件） */
export function isChatImageRel(rel: string): boolean {
  const norm = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  return norm.startsWith(`.knowbase/${IMAGES_SEG}/`) && !norm.split('/').some((s) => s === '..' || s === '.')
}

/**
 * 保存本轮图片。校验失败抛错（调用方在 append 用户消息前调用，失败不应落半条消息）。
 */
export function saveChatImages(sessionId: string, raw: unknown): ChatImageRef[] {
  const sid = safeSessionId(sessionId)
  if (!sid) throw new Error('会话 id 非法')
  const v = validateChatImageInputs(raw)
  if (!v.ok) throw new Error(v.error)
  const root = imagesRoot()
  if (!root) throw new Error('仓库上下文未就绪')
  const dir = join(root, sid)
  mkdirSync(dir, { recursive: true })
  const refs: ChatImageRef[] = []
  for (const img of v.images.slice(0, MAX_CHAT_IMAGES)) {
    const ext = extForImageMime(img.mime)
    if (!ext) throw new Error('图片格式不支持')
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const name = `${id}.${ext}`
    writeFileSync(join(dir, name), Buffer.from(img.base64, 'base64'))
    refs.push({
      relPath: `.knowbase/${IMAGES_SEG}/${sid}/${name}`,
      mime: img.mime,
      name: img.name,
      w: img.w,
      h: img.h,
      bytes: img.bytes,
    })
  }
  return refs
}

/** 读单张图片 → data URL；文件缺失 / 越界 / 非本模块路径 → null */
export function readChatImageDataUrl(ref: ChatImageRef): string | null {
  const cur = getCurrentVault()
  if (!cur?.rootPath || !isChatImageRel(ref.relPath)) return null
  try {
    const abs = resolveSafe(cur.rootPath, ref.relPath)
    if (!abs || !existsSync(abs) || !statSync(abs).isFile()) return null
    return dataUrlOfBase64(ref.mime, readFileSync(abs).toString('base64'))
  } catch { return null }
}

function removeRef(ref: ChatImageRef): void {
  const cur = getCurrentVault()
  if (!cur?.rootPath || !isChatImageRel(ref.relPath)) return
  try {
    const abs = resolveSafe(cur.rootPath, ref.relPath)
    if (abs) rmSync(abs, { force: true })
  } catch { /* 删除失败不影响消息删除 */ }
}

/** 删除一条消息携带的图片（删消息 / 清理时调用） */
export function deleteChatImages(refs: ChatImageRef[] | undefined): void {
  for (const ref of refs ?? []) removeRef(ref)
}

/** 删除一个会话的全部图片（删会话时调用） */
export function deleteSessionChatImages(sessionId: string): void {
  const sid = safeSessionId(sessionId)
  const root = imagesRoot()
  if (!sid || !root) return
  try { rmSync(join(root, sid), { recursive: true, force: true }) } catch { /* ignore */ }
}

/** 带图片的历史行 → 发给模型的 content（历史最多回带 MAX_HISTORY_IMAGES 张，新→旧优先） */
export function buildHistoryWithImages<T extends { role: 'user' | 'assistant'; content: string; images?: ChatImageRef[] }>(
  history: T[],
): Array<{ role: 'user' | 'assistant'; content: string | unknown[] }> {
  return history.map((m) => {
    const refs = m.images ?? []
    if (refs.length === 0) return { role: m.role, content: m.content }
    const parts: unknown[] = []
    for (const ref of refs) {
      const dataUrl = readChatImageDataUrl(ref)
      if (dataUrl) parts.push({ type: 'image_url', image_url: { url: dataUrl } })
    }
    if (parts.length === 0) return { role: m.role, content: m.content }
    return {
      role: m.role,
      content: [{ type: 'text', text: m.content.trim() || '请看图片。' }, ...parts],
    }
  })
}

/** 历史图片总量裁剪：保留最近 MAX_HISTORY_IMAGES 张（在组装 convo 前调用） */
export function capHistoryImages<T extends { role: 'user' | 'assistant'; content: string; images?: ChatImageRef[] }>(history: T[]): T[] {
  const out = history.slice()
  let budget = MAX_HISTORY_IMAGES
  for (let i = out.length - 1; i >= 0; i--) {
    const refs = out[i].images ?? []
    if (refs.length === 0) continue
    if (budget <= 0) { out[i] = { ...out[i], images: undefined }; continue }
    const keep = Math.min(budget, refs.length)
    if (keep < refs.length) out[i] = { ...out[i], images: refs.slice(refs.length - keep) }
    budget -= keep
  }
  return out
}
