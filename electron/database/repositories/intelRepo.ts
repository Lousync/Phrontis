import { ipcMain } from 'electron'
import {
  intelItemsAll, intelReadMeta, intelRefresh, intelToggleFav,
  intelGetArticle, intelSetAiRec, intelClearAiRec, intelSetAiFilter, intelSaveAsNote,
  intelTranslateItems,
} from '../../lib/intel/intelStore'
import { INTEL_SOURCE_KEYS } from '../../../src/lib/intelPure'
import type { IntelAiRec, IntelItem, IntelMeta, IntelSourceKey } from '../../../src/types'

/**
 * 情报模块 IPC（v3.12.0，docs/intel-module-plan.md §5）。
 * 本文件只是转发层：业务全在 lib/intel/intelStore（AI 工具与这里共用同一实现，铁律 2）。
 * 广播（broadcastDataChanged('intel')）也在 store 层做，handler 不重复发。
 */

export function registerIntelHandlers(deps: { getSettingValue: (key: string) => unknown }): void {
  ipcMain.handle('intel:getItems', () => {
    const items = intelItemsAll()
    const meta = intelReadMeta()
    return { items, meta } satisfies { items: IntelItem[]; meta: IntelMeta }
  })

  ipcMain.handle('intel:refresh', async (_e, source?: string) => {
    // 单源刷新（2026-10-25）：source 为源 key 时只抓该源；空/非法值 = 全源
    const only = INTEL_SOURCE_KEYS.includes(source as IntelSourceKey) ? (source as IntelSourceKey) : undefined
    return await intelRefresh(deps.getSettingValue, only)
  })

  // 卡片英文自动翻译（intel-translate-plan §4.2）：await 全流程，译文经广播合并回列表
  ipcMain.handle('intel:translate', async (_e, ids: unknown) => {
    const list = Array.isArray(ids)
      ? ids.filter((x): x is string => typeof x === 'string' && !!x).slice(0, 200)
      : []
    return await intelTranslateItems(deps.getSettingValue, list)
  })

  ipcMain.handle('intel:toggleFav', (_e, id: string) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('条目 id 不能为空')
    return intelToggleFav(id)
  })

  ipcMain.handle('intel:getArticle', (_e, id: string) => {
    if (typeof id !== 'string' || !id.trim()) return { error: '条目 id 不能为空' }
    return intelGetArticle(id)
  })

  ipcMain.handle('intel:setAiRec', (_e, rec: IntelAiRec) => {
    if (!rec || !Array.isArray(rec.ids) || typeof rec.query !== 'string') throw new Error('推荐数据不合法')
    return intelSetAiRec({ ids: rec.ids.filter((x) => typeof x === 'string'), query: rec.query, note: rec.note, updatedAt: rec.updatedAt })
  })

  ipcMain.handle('intel:clearAiRec', () => intelClearAiRec())

  ipcMain.handle('intel:setFilter', (_e, filter: { kind?: string; kw?: string }) => {
    if (!filter || typeof filter !== 'object') throw new Error('筛选数据不合法')
    const kind = filter.kind === 'paper' || filter.kind === 'chinese' ? filter.kind : ''
    return intelSetAiFilter({ kind, kw: String(filter.kw ?? '') })
  })

  ipcMain.handle('intel:saveAsNote', async (_e, id: string) => {
    if (typeof id !== 'string' || !id.trim()) return { ok: false, error: '条目 id 不能为空' }
    return intelSaveAsNote(id)
  })
}
