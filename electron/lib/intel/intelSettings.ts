/**
 * 主进程侧 intel 设置读取（docs/intel-module-plan.md §8）。
 * settingsCache 不做默认值合并（仓规：消费方在代码里兜默认），这里统一兜齐，
 * 避免抓取器 / scheduler 各写一份 fallback。
 */
import type { IntelSourceKey } from '../../../src/types'
import { INTEL_SOURCE_KEYS } from '../../../src/lib/intelPure'

export type IntelGetSetting = (key: string) => unknown

const INTERVAL_MS: Record<string, number> = { '1h': 3600000, '3h': 3 * 3600000, '1d': 24 * 3600000 }

/** 'off' | '1h' | '3h' | '1d'（坏值兜 3h）；'off' 返回 0 */
export function intelIntervalMs(get: IntelGetSetting): number {
  const v = String(get('intel.interval') ?? '3h')
  if (v === 'off') return 0
  return INTERVAL_MS[v] ?? INTERVAL_MS['3h']
}

export function intelSourceEnabled(get: IntelGetSetting, key: IntelSourceKey): boolean {
  const v = get(`intel.source.${key}`)
  return v === undefined ? true : v === true || v === 'true'
}

/** 每源每轮上限（1~50，默认 20） */
export function intelLimit(get: IntelGetSetting): number {
  const n = Math.floor(Number(get('intel.limit') ?? 20))
  return Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : 20
}

export function intelSpamFilterOn(get: IntelGetSetting): boolean {
  const v = get('intel.filter')
  return v === undefined ? true : v === true || v === 'true'
}

/** 条目保留天数（1~365，默认 14） */
export function intelKeepDays(get: IntelGetSetting): number {
  const n = Math.floor(Number(get('intel.keep') ?? 14))
  return Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 14
}

export function intelHfBase(get: IntelGetSetting): string {
  const v = String(get('intel.hfBase') ?? '').trim()
  return /^https?:\/\//.test(v) ? v : 'https://huggingface.co'
}

/** 全量快照（fetchAll 用） */
export function intelFetchOpts(get: IntelGetSetting): {
  limit: number
  spamFilter: boolean
  hfBase: string
  enabled: Set<IntelSourceKey>
} {
  return {
    limit: intelLimit(get),
    spamFilter: intelSpamFilterOn(get),
    hfBase: intelHfBase(get),
    enabled: new Set(INTEL_SOURCE_KEYS.filter((k) => intelSourceEnabled(get, k))),
  }
}
