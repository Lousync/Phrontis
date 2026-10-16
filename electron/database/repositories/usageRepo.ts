import { ipcMain } from 'electron'
import { getQuotaViews } from '../../lib/providerQuota'
import { getAiUsageData } from '../../lib/agentUsage'
import { buildUsageDashboard, type UsageWindow } from '../../lib/usageDashboardPure'

/**
 * 用量模块 IPC handler 注册层（v3.9.0）。
 *
 * 目录名 `database/` 是历史遗留（铁律 22）——本文件与其余 29 个 `registerXxxHandlers()`
 * 同处注册层，一律转发给 `lib/` 的实现层：
 *   - `llm:quota:get` → `providerQuota.getQuotaViews`（账户级远程额度）
 *   - `usage:dashboard` → `usageDashboardPure.buildUsageDashboard`（聚合纯函数）
 */
export function registerUsageHandlers(): void {
  ipcMain.handle('llm:quota:get', (_e, opts: { providerId?: string; accountIds?: string[]; force?: boolean } = {}) =>
    getQuotaViews(opts ?? {}),
  )
  ipcMain.handle('usage:dashboard', (_e, win: UsageWindow = 30) => {
    const w: UsageWindow = win === 'all' || win === 30 || win === 90 || win === 365 ? win : 30
    return buildUsageDashboard(getAiUsageData().days, w)
  })
}

