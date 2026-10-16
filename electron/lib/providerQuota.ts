/**
 * 账户额度查询（v3.9.0 用量模块）—— 按供应商适配器拉取**远程余额 / 套餐窗口**。
 *
 * 本文件只做「网络 + 缓存 + 账户编排」；适配器表（匹配 / 地址推导 / 解析）在零依赖的
 * `providerQuotaPure.ts`（契约脚本要 import 它）。
 *
 * 口径（用户拍板，方案 §五）：
 *   ① 额度是**账户级**的（Key 在 accounts[] 上）→ 每一项都带 accountId / accountName / active；
 *   ② 首批只支持 DeepSeek（余额）与 OpenCode Go（套餐窗口）；匹配不上 → unsupported（不猜别人的域名）；
 *   ③ 无接口供应商由渲染层收成「未提供余额接口」汇总行，**不占卡**；
 *   ④ 默认只查**激活账户**；其余账户由渲染层懒查（本模块只负责按 accountId 查）。
 *
 * 边界：Key 只在主进程内存中出现（经 resolveProviderSecret）；错误文案不带 Key；契约脚本不锁上游字段。
 */

import { net } from 'electron'
import { listQuotaProviders, resolveProviderSecret, type ProviderConfig } from './llmService'
import { quotaAdapterFor, type QuotaView, type QuotaFailReason, type QuotaAdapter } from './providerQuotaPure'

export type { QuotaView, QuotaWindow, QuotaMoney, QuotaFailReason } from './providerQuotaPure'

const TIMEOUT_MS = 8000
const CACHE_TTL_MS = 5 * 60 * 1000

type FetchOut = { status: number; json: unknown } | { networkError: true }

async function fetchQuota(adapter: QuotaAdapter, baseUrl: string, secret: string): Promise<FetchOut> {
  try {
    const res = await net.fetch(adapter.url(baseUrl), {
      method: 'GET',
      headers: adapter.headers(secret),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await res.text()
    let json: unknown = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    return { status: res.status, json }
  } catch {
    return { networkError: true }
  }
}

const cache = new Map<string, { view: QuotaView; at: number }>()
const cacheKeyOf = (providerId: string, accountId: string): string => `${providerId}:${accountId}`

function baseView(p: ProviderConfig, accountId: string, accountName: string, active: boolean) {
  return { providerId: p.id, providerName: p.name, accountId, accountName, active }
}

async function queryOne(p: ProviderConfig, accountId: string, accountName: string, active: boolean, force: boolean): Promise<QuotaView> {
  const key = cacheKeyOf(p.id, accountId)
  if (!force) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.view
  }
  const at = new Date().toISOString()

  const resolved = resolveProviderSecret(p.id, accountId)
  if (!resolved.ok) {
    const reason: QuotaFailReason = resolved.code === 'NO_KEY' || resolved.code === 'ACCOUNT_NOT_FOUND' ? 'no-key' : 'unsupported'
    const view: QuotaView = { ...baseView(p, accountId, accountName, active), ok: false, reason, message: resolved.error, at }
    cache.set(key, { view, at: Date.now() })
    return view
  }

  const adapter = quotaAdapterFor(p.baseUrl)
  if (!adapter) {
    const view: QuotaView = { ...baseView(p, accountId, accountName, active), ok: false, reason: 'unsupported', message: '未提供余额接口', at }
    cache.set(key, { view, at: Date.now() })
    return view
  }

  const out = await fetchQuota(adapter, p.baseUrl, resolved.secret)
  let view: QuotaView
  if ('networkError' in out) {
    view = { ...baseView(p, accountId, accountName, active), ok: false, reason: 'network', message: '暂时取不到', at }
  } else if (out.status === 401 || out.status === 403) {
    view = { ...baseView(p, accountId, accountName, active), ok: false, reason: 'unauthorized', message: 'Key 无效或权限不足', at }
  } else if (out.status < 200 || out.status >= 300) {
    view = { ...baseView(p, accountId, accountName, active), ok: false, reason: 'network', message: `上游返回 HTTP ${out.status}`, at }
  } else {
    const parsed = adapter.parse(out.json)
    if (parsed.ok) {
      view = parsed.kind === 'money'
        ? { ...baseView(p, accountId, accountName, active), ok: true, kind: 'money', available: parsed.available, balances: parsed.balances, at }
        : { ...baseView(p, accountId, accountName, active), ok: true, kind: 'windows', windows: parsed.windows, at }
    } else {
      view = { ...baseView(p, accountId, accountName, active), ok: false, reason: parsed.reason, message: parsed.message, at }
    }
  }
  cache.set(key, { view, at: Date.now() })
  return view
}

/**
 * 拉取额度视图。
 *  - 不传 accountIds：每个（已启用）供应商只查**激活账户**（默认入口）；
 *  - 传 accountIds：逐账户查（渲染层懒查非激活账户）；
 *  - providerId：限定单个供应商；force：手动刷新绕过 5 分钟缓存。
 */
export async function getQuotaViews(opts: { providerId?: string; accountIds?: string[]; force?: boolean } = {}): Promise<QuotaView[]> {
  const providers = listQuotaProviders().filter((p) => !opts.providerId || p.id === opts.providerId)
  const out: QuotaView[] = []
  for (const p of providers) {
    const accounts = p.accounts ?? []
    let targets = accounts
    if (opts.accountIds && opts.accountIds.length > 0) {
      const want = new Set(opts.accountIds)
      targets = accounts.filter((a) => want.has(a.id))
    } else {
      targets = accounts.filter((a) => a.id === p.activeAccountId)
      // 兜底：没有任何 activeAccountId 的旧数据 → 取第一个
      if (targets.length === 0 && accounts.length > 0) targets = [accounts[0]]
    }
    for (const a of targets) {
      out.push(await queryOne(p, a.id, a.name, a.id === p.activeAccountId, opts.force === true))
    }
  }
  return out
}
