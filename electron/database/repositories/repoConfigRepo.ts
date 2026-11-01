import { ipcMain } from 'electron'
import { readRepoConfig, updateGraphViewConfig } from 'phrontis-core/kbStore/repoConfig'

/** 仓库级配置 IPC（R4-G3）：图谱参数持久化到 .knowbase/config.json，配置跟仓库走 */
export function registerRepoConfigHandlers(): void {
  ipcMain.handle('repo:getConfig', () => readRepoConfig())
  ipcMain.handle('graphView:getConfig', () => updateGraphViewConfig({}))
  ipcMain.handle('graphView:updateConfig', (_e, patch: unknown) => {
    const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
    // 只收白名单字段（主进程再做一次类型/范围收口：数字转有限数，布尔取真值）
    const clean: Record<string, unknown> = {}
    for (const k of ['linkDistance', 'chargeStrength', 'labelThreshold']) {
      const v = p[k]
      if (typeof v === 'number' && Number.isFinite(v)) clean[k] = v
    }
    for (const k of ['showTags', 'showOrphans', 'colorBySpace', 'clusterForce']) {
      if (typeof p[k] === 'boolean') clean[k] = p[k]
    }
    return updateGraphViewConfig(clean as never)
  })
}
