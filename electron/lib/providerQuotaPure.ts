/**
 * 账户额度适配器表（**零依赖纯函数**，v3.9.0 用量模块）—— 供 providerQuota 与契约脚本共用。
 *
 * 只做三件事，全都不碰网络 / 不碰 electron：
 *   ① 按 baseUrl 匹配适配器（键含子串，同 modelPricing 的既有做法）；
 *   ② 由 baseUrl 推出额度接口地址（origin + 固定路径）；
 *   ③ 把上游 JSON 解析成归一形状（防御式：结构不符 → shape / not-subscribed，绝不抛）。
 *
 * 口径（用户拍板，方案 §五）：金额一律当**字符串**精确保留（DeepSeek 文档要求别用浮点）；
 * 多币种逐条返回；opencode 三条窗口命名固定（5 小时滚动 / 本周 / 本月），**不给计划名**（上游不上报）。
 */

export type QuotaWindow = {
  key: string
  label: string
  /** 0–100（上游口径，不夹断上界；≥100 由界面与 rate-limited 同档） */
  percent: number
  /** 窗口重置时刻（ISO）；上游未上报则缺省 */
  resetsAt?: string
  status: 'ok' | 'rate-limited'
}

export type QuotaMoney = { currency: string; total: string; granted: string; topped: string }

export type QuotaFailReason =
  | 'unsupported'
  | 'unauthorized'
  | 'not-subscribed'
  | 'network'
  | 'shape'
  | 'no-key'

export type QuotaView =
  | { providerId: string; providerName: string; accountId: string; accountName: string; active: boolean; ok: true; kind: 'money'; available: boolean; balances: QuotaMoney[]; at: string }
  | { providerId: string; providerName: string; accountId: string; accountName: string; active: boolean; ok: true; kind: 'windows'; windows: QuotaWindow[]; at: string }
  | { providerId: string; providerName: string; accountId: string; accountName: string; active: boolean; ok: false; reason: QuotaFailReason; message: string; at: string }

type ParseOk =
  | { ok: true; kind: 'money'; available: boolean; balances: QuotaMoney[] }
  | { ok: true; kind: 'windows'; windows: QuotaWindow[] }
type ParseFail = { ok: false; reason: 'not-subscribed' | 'shape'; message: string }

export interface QuotaAdapter {
  key: string
  match(baseUrl: string): boolean
  url(baseUrl: string): string
  headers(secret: string): Record<string, string>
  parse(json: unknown): ParseOk | ParseFail
}

const str = (v: unknown): string => (v == null ? '' : String(v))

function safeUrl(baseUrl: string): URL | null {
  try { return new URL(baseUrl) } catch { return null }
}
function safeHost(baseUrl: string): string {
  return safeUrl(baseUrl)?.hostname?.toLowerCase() ?? ''
}
function safeOrigin(baseUrl: string): string {
  return safeUrl(baseUrl)?.origin ?? ''
}

/** DeepSeek 官方余额接口：GET {origin}/user/balance */
export const deepseekAdapter: QuotaAdapter = {
  key: 'deepseek',
  match: (baseUrl) => /(^|\.)api\.deepseek\.com$/i.test(safeHost(baseUrl)),
  url: (baseUrl) => `${safeOrigin(baseUrl)}/user/balance`,
  headers: (secret) => ({ Authorization: `Bearer ${secret}`, Accept: 'application/json' }),
  parse: (json) => {
    if (!json || typeof json !== 'object') return { ok: false, reason: 'shape', message: '返回不是对象' }
    const j = json as { is_available?: unknown; balance_infos?: unknown }
    const infos = j.balance_infos
    if (!Array.isArray(infos) || infos.length === 0) return { ok: false, reason: 'shape', message: '返回里没有余额信息' }
    const balances: QuotaMoney[] = infos.map((b) => {
      const o = (b ?? {}) as Record<string, unknown>
      return { currency: str(o.currency), total: str(o.total_balance), granted: str(o.granted_balance), topped: str(o.topped_up_balance) }
    })
    return { ok: true, kind: 'money', available: j.is_available === true, balances }
  },
}

/** OpenCode Go 套餐窗口（无公开文档，2026-10-16 实测）：GET {origin}/zen/go/v1/usage */
export const opencodeAdapter: QuotaAdapter = {
  key: 'opencode',
  match: (baseUrl) => /(^|\.)opencode\.ai$/i.test(safeHost(baseUrl)),
  url: (baseUrl) => `${safeOrigin(baseUrl)}/zen/go/v1/usage`,
  headers: (secret) => ({ Authorization: `Bearer ${secret}`, Accept: 'application/json' }),
  parse: (json) => {
    if (!json || typeof json !== 'object') return { ok: false, reason: 'shape', message: '返回不是对象' }
    const usage = (json as { usage?: unknown }).usage
    if (!usage || typeof usage !== 'object') {
      return { ok: false, reason: 'not-subscribed', message: '该账号没有 Go 套餐；Zen 余额不提供 API' }
    }
    const u = usage as Record<string, unknown>
    const defs: Array<[string, string]> = [['rolling', '5 小时（滚动）'], ['weekly', '本周'], ['monthly', '本月']]
    const windows: QuotaWindow[] = []
    let sawObject = false
    for (const [key, label] of defs) {
      const w = u[key]
      if (!w || typeof w !== 'object') continue
      sawObject = true
      const wo = w as Record<string, unknown>
      if (typeof wo.percent !== 'number' || !Number.isFinite(wo.percent)) {
        return { ok: false, reason: 'shape', message: `窗口「${label}」缺少 percent` }
      }
      windows.push({
        key,
        label,
        percent: Math.max(0, Math.round(wo.percent)),
        status: wo.status === 'rate-limited' ? 'rate-limited' : 'ok',
        ...(typeof wo.resetsAt === 'string' ? { resetsAt: wo.resetsAt } : {}),
      })
    }
    if (!sawObject || windows.length === 0) {
      return { ok: false, reason: 'not-subscribed', message: '该账号没有 Go 套餐；Zen 余额不提供 API' }
    }
    return { ok: true, kind: 'windows', windows }
  },
}

const ADAPTERS: QuotaAdapter[] = [deepseekAdapter, opencodeAdapter]

/** 按 baseUrl 匹配适配器；匹配不上（中转站 / 自定义域名）→ null（界面归 unsupported） */
export function quotaAdapterFor(baseUrl: string): QuotaAdapter | null {
  return ADAPTERS.find((a) => a.match(baseUrl)) ?? null
}
