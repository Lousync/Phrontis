/**
 * 摘录数据 schema（书架阅读器 · 摘录先行批次）。
 *
 * 零依赖纯函数文件 —— 刻意不 import 任何 electron / fs 模块：
 * 契约脚本 `.AGENT/scripts/pdf-reader/verify-excerpts.mjs` 用
 * `node --experimental-strip-types` 直接 import 本文件做用例验证。
 *
 * 存储：vault 级 `.knowbase/modules/excerpts.json`（唯一写方 = excerptVaultRepo.ts）：
 *   { version: 1, books: { "<rootId>/<relPath>": Record<excerptId, VaultExcerpt> } }
 * 书键口径与 pdfBookKey/readerKey 完全一致。
 *
 * 定位口径（双向溯源的「正向跳回」依据）：
 *   pdf  → page（页码，跳页走 KB_PDF_GOTO_PAGE）+ rects（选区矩形，归一化到文本层百分比，zoom 无关）
 *   txt  → paraIndex（段落序号，跳段走 KB_TXT_GOTO_PARA）+ start/end（段内字符偏移，<mark> 渲染依据）
 */

import type { BookKind } from './bookFormats'

/** 归一化选区矩形（相对文本层容器的百分比 0..1，zoom/窗口无关） */
export interface ExcerptRect {
  l: number
  t: number
  w: number
  h: number
}

/**
 * 摘录色板（前后端唯一真相源；CSS 侧色值由契约脚本 verify-excerpts.mjs 断言一致，严禁两处各写一份）。
 * id 用于 data-ehc / class 后缀（`.kb-exc-<id>`），hex 用于持久化与 CSS 变量 `--exc`。
 */
export const EXCERPT_COLORS = [
  { id: 'y', hex: '#efb84c' },
  { id: 'g', hex: '#7fb844' },
  { id: 'b', hex: '#5d9bdc' },
  { id: 'p', hex: '#e0709a' },
  { id: 'v', hex: '#9188e8' },
] as const

/** 合法颜色 id 白名单 */
export type ExcerptColor = (typeof EXCERPT_COLORS)[number]['id']
export const EXCERPT_COLOR_IDS: readonly ExcerptColor[] = EXCERPT_COLORS.map((c) => c.id)

/** 条目类型（注意：不能叫 `kind` —— kind 已被书籍格式 pdf/txt 占用） */
export type ExcerptType = 'highlight' | 'excerpt' | 'idea'

/** 缺省色（首色，存量缺色回落） */
export const DEFAULT_EXCERPT_COLOR: ExcerptColor = EXCERPT_COLORS[0].id
/** 缺省类型（存量缺 type 回落） */
export const DEFAULT_EXCERPT_TYPE: ExcerptType = 'excerpt'

export interface VaultExcerpt {
  id: string
  kind: BookKind
  /** pdf 定位：页码（>=1） */
  page?: number
  /** pdf 高亮：归一化矩形组 */
  rects?: ExcerptRect[]
  /** txt 定位：段落序号（>=0） */
  paraIndex?: number
  /** txt 高亮：段内字符偏移 [start, end) */
  start?: number
  end?: number
  /** 摘文原文（去首尾空白，1..8000 字符） */
  text: string
  /** 一句话备注（可空串 = 无备注；<=500 字符） */
  note: string
  /** 高亮颜色（色板 id 白名单；缺省回落 DEFAULT_EXCERPT_COLOR） */
  color: ExcerptColor
  /** 条目类型：highlight 高亮 / excerpt 摘录 / idea 想法（缺省回落 DEFAULT_EXCERPT_TYPE） */
  type: ExcerptType
  /** 创建时间（ISO；展示排序用，不可从外部注入修改） */
  at: string
  /** 冲突检测基准（铁律 4）；patch 时服务端重新生成 */
  updatedAt: string
}

/** excerpts.json 顶层 */
export interface VaultExcerptStore {
  version: number
  books: Record<string, Record<string, VaultExcerpt>>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 书键归一：posix 分隔、去首尾空白、去开头 ./；空分量拒绝返回空串（同 readerKey 口径） */
export function excerptKey(rootId: string, relPath: string): string {
  const id = String(rootId ?? '').trim()
  let rel = String(relPath ?? '').trim().replace(/\\/g, '/')
  while (rel.startsWith('./')) rel = rel.slice(2)
  if (!id || !rel || rel.startsWith('/')) return ''
  return `${id}/${rel}`
}

/** 从书键反解 relPath */
export function excerptKeyRel(key: string): string {
  const i = key.indexOf('/')
  return i < 0 ? '' : key.slice(i + 1)
}

function sanitizeRect(v: unknown): ExcerptRect | null {
  if (!isRecord(v)) return null
  const l = v['l'], t = v['t'], w = v['w'], h = v['h']
  for (const n of [l, t, w, h]) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) return null
  }
  return { l: l as number, t: t as number, w: w as number, h: h as number }
}

function sanitizeRects(v: unknown): ExcerptRect[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 200) return null
  const out: ExcerptRect[] = []
  for (const r of v) {
    const rect = sanitizeRect(r)
    if (!rect) return null
    out.push(rect)
  }
  return out
}

/**
 * 创建载荷清洗（服务端生成 id/at/updatedAt，不接受传入）。
 * pdf 必须带 page（rects 可选）；txt 必须带 paraIndex（start/end 可选且成对合法）。
 * 返回 null = 载荷非法（整体拒绝）。
 */
export function sanitizeExcerptCreate(payload: unknown): Omit<VaultExcerpt, 'id' | 'at' | 'updatedAt'> | null {
  if (!isRecord(payload)) return null
  const kind = payload['kind']
  if (kind !== 'pdf' && kind !== 'txt') return null
  const textRaw = payload['text']
  if (typeof textRaw !== 'string') return null
  const text = textRaw.trim()
  if (!text || text.length > 8000) return null
  const noteRaw = payload['note']
  const note = typeof noteRaw === 'string' ? noteRaw.slice(0, 500) : ''
  const out: Omit<VaultExcerpt, 'id' | 'at' | 'updatedAt'> = { kind, text, note, color: DEFAULT_EXCERPT_COLOR, type: DEFAULT_EXCERPT_TYPE }
  if (kind === 'pdf') {
    const page = payload['page']
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 100000) return null
    out.page = page
    if (payload['rects'] !== undefined) {
      const rects = sanitizeRects(payload['rects'])
      if (!rects) return null
      out.rects = rects
    }
  } else {
    const paraIndex = payload['paraIndex']
    if (typeof paraIndex !== 'number' || !Number.isInteger(paraIndex) || paraIndex < 0 || paraIndex > 1000000) return null
    out.paraIndex = paraIndex
    const hasStart = payload['start'] !== undefined
    const hasEnd = payload['end'] !== undefined
    if (hasStart !== hasEnd) return null
    if (hasStart) {
      const start = payload['start'], end = payload['end']
      if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) return null
      if (typeof end !== 'number' || !Number.isInteger(end) || end <= start) return null
      out.start = start
      out.end = end
    }
  }
  // 颜色 / 类型：缺省回落（存量旧数据无此字段时由 coerceExcerpt 透传后在此补默认，不报错不迁移）
  const rawColor = payload['color']
  out.color = EXCERPT_COLOR_IDS.includes(rawColor as ExcerptColor) ? (rawColor as ExcerptColor) : DEFAULT_EXCERPT_COLOR
  const rawType = payload['type']
  out.type = rawType === 'highlight' || rawType === 'excerpt' || rawType === 'idea' ? rawType : DEFAULT_EXCERPT_TYPE
  return out
}

/** patch 白名单：收 note / color / type；每个字段独立校验，任一非法整体拒（touched=false 即无合法字段也返回 null） */
export function sanitizeExcerptPatch(patch: unknown): { note?: string; color?: ExcerptColor; type?: ExcerptType } | null {
  if (!isRecord(patch)) return null
  const out: { note?: string; color?: ExcerptColor; type?: ExcerptType } = {}
  let touched = false
  for (const k of Object.keys(patch)) {
    if (k === 'note') {
      const v = patch[k]
      if (typeof v !== 'string') return null
      out.note = v.slice(0, 500)
      touched = true
    } else if (k === 'color') {
      const v = patch[k]
      if (typeof v !== 'string' || !EXCERPT_COLOR_IDS.includes(v as ExcerptColor)) return null
      out.color = v as ExcerptColor
      touched = true
    } else if (k === 'type') {
      const v = patch[k]
      if (v !== 'highlight' && v !== 'excerpt' && v !== 'idea') return null
      out.type = v
      touched = true
    } else {
      return null
    }
  }
  return touched ? out : null
}

/** 存量数据修补：坏值回落默认不抛错（kind 非法 → 整条丢弃返回 null，由仓库层剔除） */
export function coerceExcerpt(raw: unknown, now: string): VaultExcerpt | null {
  if (!isRecord(raw)) return null
  const base = sanitizeExcerptCreate({ kind: raw['kind'], text: raw['text'], note: raw['note'], page: raw['page'], rects: raw['rects'], paraIndex: raw['paraIndex'], start: raw['start'], end: raw['end'], color: raw['color'], type: raw['type'] })
  if (!base) return null
  const at = typeof raw['at'] === 'string' && raw['at'] ? raw['at'] : now
  const updatedAt = typeof raw['updatedAt'] === 'string' && raw['updatedAt'] ? raw['updatedAt'] : now
  const id = typeof raw['id'] === 'string' && raw['id'] ? raw['id'] : ''
  if (!id) return null
  return { ...base, id, at, updatedAt }
}
