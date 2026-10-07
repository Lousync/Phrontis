// R6 去库化：博客 = .knowbase/blog/ md（sql.js 路径已移除，D9）
import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { emitPluginEvent } from '../../lib/pluginEvents'
import {
  vaultListEntries, vaultGetEntryById, vaultCreateEntry, vaultUpdateEntry,
  vaultDeleteEntry, vaultSearchEntries,
} from '../../lib/kbStore/blogVaultRepo'
import { recycleBinAdd } from './recycleBinRepo'

export function registerEntryHandlers(): void {
  // 获取博文列表
  ipcMain.handle('db:getEntries', (_event, filter?: {
    date?: string
    tagId?: string
    pinnedOnly?: boolean
    starredOnly?: boolean
    limit?: number
    offset?: number
  }) => {
    return vaultListEntries(filter ?? {})
  })

  // 获取单篇博文
  ipcMain.handle('db:getEntryById', (_event, id: string) => {
    return vaultGetEntryById(id)
  })

  // 创建博文
  ipcMain.handle('db:createEntry', (event, data: {
    title?: string
    contentMd?: string
    contentHtml?: string
    date: string
    tags?: string[]
    states?: string
  }) => {
    const e = vaultCreateEntry({ title: data.title, contentMd: data.contentMd, date: data.date, tags: data.tags, states: data.states })
    emitPluginEvent('blog:postSaved', { postId: e.id, title: e.title })
    return e
  })

  // 更新博文（vaultUpdateEntry 内置日期防撞：目标日期已被其它篇占用 → throw）
  ipcMain.handle('db:updateEntry', (_event, id: string, data: {
    title?: string
    contentMd?: string
    contentHtml?: string
    date?: string
    isPinned?: boolean
    tags?: string[]
    states?: string
  }) => {
    const r = vaultUpdateEntry(id, data)
    emitPluginEvent('blog:postSaved', { postId: r.entry.id, title: r.entry.title })
    return r.entry
  })

  // 删除博文（软删除 → 回收站）
  ipcMain.handle('db:deleteEntry', (_event, id: string) => {
    // 删 md 文件，回收站载荷（全文 JSON）写入回收站（恢复时经 vaultCreate/vaultUpdate 回写文件）
    const info = vaultDeleteEntry(id)
    if (!info) return
    recycleBinAdd({ id: randomUUID(), original_id: id, module: 'blog', title: info.title, data: info.data })
  })

  // 全文搜索
  ipcMain.handle('db:searchEntries', (_event, query: string) => {
    return vaultSearchEntries(query)
  })

  // 切换博文收藏状态
  ipcMain.handle('db:toggleEntryStar', (_event, id: string) => {
    const e = vaultGetEntryById(id)
    if (!e) return null
    return vaultUpdateEntry(id, { isStarred: !e.isStarred }).entry
  })
}
