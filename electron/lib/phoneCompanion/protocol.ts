/**
 * 手机伴侣同步协议 v1 —— 纯类型 + 纯函数，零 electron 依赖。
 *
 * 冻结口径：E:\Projects\Phrontis-mobile\docs\design.md §2.1（2026-10-31）。
 * 契约脚本 .AGENT/scripts/phone-companion/verify-companion-protocol.mjs 直接 import 本文件，
 * 改协议先改那边文档、再改这里、再跑脚本。
 */

export const PROTOCOL_VERSION = 1
export const DEFAULT_PORT = 8770
/** 配对码有效期：面板打开时生成，到期后 /api/pair 拒绝 */
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000
/** 配对尝试限频：同一来源 IP 每分钟 */
export const PAIR_ATTEMPTS_PER_MIN = 10
/** 请求体上限（push 批量 + 余量） */
export const MAX_BODY_BYTES = 2 * 1024 * 1024

/** v1.7 长轮询：服务端挂起上限（客户端传再大也按此封顶，避开中间层空闲超时）。方案：主仓 docs/companion-realtime-sync-plan.md §2.3 */
export const PULL_WAIT_CAP_MS = 25_000

/** 同步域清单（v1.2 起 ledger + schedule + notes；v1.6 起 notes 双向——设备文件夹 U 盘语义，见 design.md §2.1 v1.6 节） */
export const SYNC_DOMAINS = ['ledger', 'schedule', 'notes'] as const
export type SyncDomain = (typeof SYNC_DOMAINS)[number]

/** 手机上行的一条变更（push changes[] 的元素） */
export interface SyncChange {
  domain: string
  /** 域内条目 UUID：手机生成、终身不变 */
  id: string
  /** ISO 字符串；合并按字典序比较（同格式 ISO-8601 UTC） */
  updatedAt: string
  data: unknown
}

export interface PushResultItem {
  id: string
  applied: boolean
  /** true = 因「服务端已更新」未应用，手机应以服务端版本回写收敛 */
  conflict?: boolean
  /** unsupported-domain | invalid-data | ... */
  reason?: string
}

/** ledger 条目负载（TransactionRow 子集；转账 / 定期收入 v1 不上行） */
export interface LedgerItemData {
  date: string
  time: string
  type: 'expense' | 'income'
  amount: number
  category: string
  payment: string
  merchant: string
  note: string
}

/** 合并裁决（纯函数）：incoming 是否应当应用。updatedAt 新的赢；相同 → 桌面赢 */
export function shouldApplyIncoming(localUpdatedAt: string, incomingUpdatedAt: string): boolean {
  return String(incomingUpdatedAt) > String(localUpdatedAt)
}

/* ================= v1.1：schedule 域 + 墓碑 ================= */

/**
 * schedule 条目负载（桌面 TodoRow 的同步子集；子任务行同样按条目同步，parentId 指向父条目 UUID）。
 * 桌面行独有字段（description、quadrant、tag、sort_order、recurring 系列、snooze_until、
 * estimate_min、created_at）不在负载里，upsert 时原样保留 —— 口径见 design.md §2.1。
 */
export interface ScheduleItemData {
  /** YYYY-MM-DD */
  date: string
  title: string
  type: 'plan' | 'deadline' | 'daily'
  /** 'HH:MM'（deadline 截止时刻；桌面行存 'YYYY-MM-DD HH:MM'，pull 截回 'HH:MM'）；'' = 无 */
  time: string
  /** ↔ 桌面 status pending/done */
  done: boolean
  /** 父条目 UUID；null = 顶层 */
  parentId: string | null
  /** 当天分钟数 ↔ scheduled_start/end；null = 未排期 */
  schedStart: number | null
  schedEnd: number | null
}

/** schedule 负载校验与规范化：非法返回 null（响应 reason: invalid-data） */
export function normalizeScheduleData(raw: unknown): ScheduleItemData | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const type = o.type === 'plan' || o.type === 'deadline' || o.type === 'daily' ? o.type : ''
  if (!type) return null
  const date = typeof o.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : ''
  const title = typeof o.title === 'string' ? o.title.trim().slice(0, 120) : ''
  if (!date || !title) return null
  const time = typeof o.time === 'string' && /^\d{1,2}:\d{2}/.test(o.time) ? o.time.slice(0, 5) : ''
  const min = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null
    const n = Math.round(Number(v))
    return Number.isFinite(n) && n >= 0 && n <= 1440 ? n : null
  }
  const parent = typeof o.parentId === 'string' && o.parentId.trim() ? o.parentId.trim() : null
  return {
    date, title, type, time,
    done: o.done === true,
    parentId: parent,
    schedStart: min(o.schedStart),
    schedEnd: min(o.schedEnd),
  }
}

/** 删除同步（墓碑）上行负载：`{ deleted: true }`（domain/id/updatedAt 照常，updatedAt = 删除时刻） */
export interface TombstoneData {
  deleted: true
}

export function isTombstoneData(data: unknown): data is TombstoneData {
  return !!data && typeof data === 'object' && !Array.isArray(data) && (data as Record<string, unknown>).deleted === true
}

/* ================= v1.2：notes 域（手机闪念上行） + 内容 API ================= */

/** notes 域负载：落 vault 成带 frontmatter 的 .md（title 可空 → 桌面侧回落文件名） */
export interface NoteItemData {
  title: string
  body: string
}

/** notes 负载校验与规范化：标题与正文都为空视为非法；正文上限 10 万字符 */
export function normalizeNoteData(raw: unknown): NoteItemData | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const title = typeof o.title === 'string' ? o.title.trim().slice(0, 120) : ''
  const body = typeof o.body === 'string' ? o.body.slice(0, 100_000) : ''
  if (!title && !body.trim()) return null
  return { title, body }
}

/** ledger 负载校验与规范化：非法返回 null（响应 reason: invalid-data） */
export function normalizeLedgerData(raw: unknown): LedgerItemData | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const type = o.type === 'income' ? 'income' : o.type === 'expense' ? 'expense' : ''
  if (!type) return null
  const amount = Number(o.amount)
  if (!Number.isFinite(amount) || amount <= 0) return null
  const date = typeof o.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : ''
  if (!date) return null
  const time = typeof o.time === 'string' && /^\d{1,2}:\d{2}/.test(o.time) ? o.time.slice(0, 5) : ''
  const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max)
  return {
    date,
    time,
    type,
    amount: Math.round(Math.abs(amount) * 100) / 100,
    category: str(o.category, 60) || '其他',
    payment: str(o.payment, 60),
    merchant: str(o.merchant, 200),
    note: str(o.note, 200),
  }
}

/** 配对链接（桌面端展示 / 二维码内容）：http://<ip>:<port>/pair#<code> */
export function buildPairUrl(ip: string, port: number, code: string): string {
  return `http://${ip}:${port}/pair#${code}`
}

/**
 * 手机端解析配对输入（纯函数，手机仓 scripts/verify-sync.mjs 同测）。
 * 接受两种形态：
 *   ① 粘贴桌面端完整配对链接  http://192.168.1.5:8770/pair#12345678
 *   ② 地址 + 配对码分开填     host 字段 192.168.1.5:8770（协议头 / 路径可带可不带）
 * codeFallback = 配对码输入框的值；链接里 #code 优先。解析不出 host 或 code 返回 null。
 */
export function parsePairInput(text: string, codeFallback: string): { host: string; code: string } | null {
  const t = String(text || '').trim()
  if (!t) return null
  const hashAt = t.indexOf('#')
  const codeFromHash = hashAt >= 0 ? t.slice(hashAt + 1).trim() : ''
  let host = hashAt >= 0 ? t.slice(0, hashAt) : t
  host = host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim()
  if (!/^[a-zA-Z0-9.\-]+:\d{2,5}$/.test(host)) return null
  const code = (codeFromHash || String(codeFallback || '').trim())
  return /^\d{6,10}$/.test(code) ? { host, code } : null
}
