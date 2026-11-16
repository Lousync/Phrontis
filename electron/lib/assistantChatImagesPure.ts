/**
 * 对话图片输入（P2 多模态）**纯逻辑**：data URL 校验、大小/数量上限、内容块拼装。
 *
 * 存储与读盘在 `assistantChatImages.ts`；本文件零依赖，契约脚本直接 import。
 * 线格式统一为 OpenAI 多模态 content 数组（text / image_url），
 * Anthropic / Responses 适配器在各自协议层转换。
 */

export const MAX_CHAT_IMAGES = 4
/** 单张图片原始字节上限（渲染层已压到 2048px / JPEG，正常远低于此） */
export const MAX_CHAT_IMAGE_BYTES = 2 * 1024 * 1024
/** 每次请求最多回带几张历史图片（含本轮） */
export const MAX_HISTORY_IMAGES = 8
/** 图片 token 粗估（历史预算裁剪用；远小于真实值也不至于让上下文爆掉） */
export const CHAT_IMAGE_TOKEN_ESTIMATE = 1200

export const ALLOWED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type AllowedImageMime = typeof ALLOWED_IMAGE_MIMES[number]

export interface ChatImageInput {
  name?: string
  mime: string
  /** data:image/...;base64,... */
  dataUrl: string
  w?: number
  h?: number
  bytes?: number
}

export interface ChatImageRef {
  /** 仓库相对路径（.knowbase/agent/images/<sessionId>/<id>.<ext>） */
  relPath: string
  mime: string
  name?: string
  w?: number
  h?: number
  bytes?: number
}

export interface ParsedDataUrl {
  mime: AllowedImageMime
  base64: string
  bytes: number
}

/** 解析图片 data URL；非白名单 mime / 非法 base64 / 超限 → null */
export function parseImageDataUrl(raw: unknown): ParsedDataUrl | null {
  const url = String(raw ?? '').trim()
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(url)
  if (!m) return null
  const mime = m[1] as AllowedImageMime
  if (!(ALLOWED_IMAGE_MIMES as readonly string[]).includes(mime)) return null
  const base64 = m[2].replace(/\s+/g, '')
  if (!base64) return null
  const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)
  if (bytes <= 0 || bytes > MAX_CHAT_IMAGE_BYTES) return null
  return { mime, base64, bytes }
}

export function extForImageMime(mime: string): 'png' | 'jpg' | 'webp' | null {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/webp') return 'webp'
  return null
}

export function dataUrlOfBase64(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`
}

/**
 * 校验一轮图片输入：最多 4 张、每张 ≤2MB、仅允许 PNG/JPEG/WebP。
 * @returns 合法时返回解析后的条目（含 base64），否则 error
 */
export function validateChatImageInputs(raw: unknown): { ok: true; images: Array<ParsedDataUrl & { name?: string; w?: number; h?: number }> } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: '没有图片' }
  if (raw.length > MAX_CHAT_IMAGES) return { ok: false, error: `每条消息最多 ${MAX_CHAT_IMAGES} 张图片` }
  const out: Array<ParsedDataUrl & { name?: string; w?: number; h?: number }> = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Partial<ChatImageInput> | null
    if (!item || typeof item !== 'object') return { ok: false, error: `第 ${i + 1} 张图片格式非法` }
    const parsed = parseImageDataUrl(item.dataUrl)
    if (!parsed) return { ok: false, error: `第 ${i + 1} 张图片无效（仅支持 PNG/JPEG/WebP，且不超过 2MB）` }
    out.push({
      ...parsed,
      name: typeof item.name === 'string' ? item.name.slice(0, 80) : undefined,
      w: typeof item.w === 'number' ? Math.max(0, Math.floor(item.w)) : undefined,
      h: typeof item.h === 'number' ? Math.max(0, Math.floor(item.h)) : undefined,
    })
  }
  return { ok: true, images: out }
}

/** 文本 + 图片 → OpenAI 多模态 content 数组；无图片时返回纯文本 */
export function buildUserContent(text: string, images: Array<{ mime: string; dataUrl: string }>): string | unknown[] {
  const body = String(text ?? '')
  if (images.length === 0) return body
  const parts: unknown[] = [{ type: 'text', text: body.trim() || '请看图片。' }]
  for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } })
  return parts
}

/** 从 content（string 或 OpenAI 多模态数组）里取纯文本（预算统计 / 标题 / 感知检索用） */
export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((p) => (p && typeof p === 'object' && (p as Record<string, unknown>).type === 'text' ? String((p as Record<string, unknown>).text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

/** content 的 token 估算：文本按 2.6 字/token，图片按固定值粗估 */
export function estimateContentTokens(content: unknown): number {
  if (typeof content === 'string') return Math.ceil(content.length / 2.6)
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const p of content) {
    if (!p || typeof p !== 'object') continue
    const part = p as Record<string, unknown>
    if (part.type === 'text') n += Math.ceil(String(part.text ?? '').length / 2.6)
    else if (part.type === 'image_url') n += CHAT_IMAGE_TOKEN_ESTIMATE
  }
  return n
}
