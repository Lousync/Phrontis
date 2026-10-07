// R6 去库化：真相源 = .knowbase/modules/recycle-bin.json（恢复目标模块同样只写各模块 vault 真相源，sqlite 路径已移除）
import { ipcMain } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { trashItem, trashAll } from '../../lib/trashFiles'
import { restoreAttachments, parseInlineAttachmentIds } from './attachmentRepo'
import { encryptPassword } from './passwordRepo'
import { vaultPasswordsAll, vaultPasswordsSave } from '../../lib/kbStore/secretVaultRepo'
import { vaultListEntries, vaultCreateEntry, vaultUpdateEntry } from '../../lib/kbStore/blogVaultRepo'
import { vaultPostsAll, vaultPostsSave, vaultAlbumsAll, type MomentsRow } from '../../lib/kbStore/momentsVaultRepo'
import { vaultGetCategory, vaultRestorePage, vaultRestoreCategory } from '../../lib/kbStore/knowledgeVaultRepo'
import { readJson, writeJson } from '../../lib/kbStore/jsonStore'

function getSettingsRetentionDays(): number {
  try {
    const path = join(app.getPath('userData'), 'settings.json')
    if (!existsSync(path)) return 30
    const s = JSON.parse(readFileSync(path, 'utf-8'))
    const raw = typeof s.recycleBinRetentionDays === 'number' ? s.recycleBinRetentionDays : 30
    // NaN/非法值兜底并夹取到合理区间
    if (!Number.isFinite(raw)) return 30
    return Math.min(3650, Math.max(1, Math.round(raw)))
  } catch { return 30 }
}

interface RecycleBinRow {
  id: string
  original_id: string
  module: string
  title: string
  data: string
  deleted_at: string
}

function normalizeCategoryType(raw: unknown): 'notebook' | 'folder' | 'space' {
  if (raw === 'notebook' || raw === 'space') return raw
  return 'folder'
}

/** 分类归属父级解析（vault 字典口径）：空间恒为顶层；父级不在字典内则落到顶层（不再新建默认空间） */
function resolveCategoryParent(categoryType: unknown, parentId: string | null | undefined): string | null {
  const ct = normalizeCategoryType(categoryType)
  if (ct === 'space') return null
  if (parentId && vaultGetCategory(parentId)) return parentId
  return null
}

// ---- 回收站 JSON 存取（.knowbase/modules/recycle-bin.json，原子写） ----
const RB_MODULE = 'modules'
const RB_KEY = 'recycle-bin.json'

function readBin(): RecycleBinRow[] {
  return readJson<RecycleBinRow[]>(RB_MODULE, RB_KEY, [])
}

function writeBin(rows: RecycleBinRow[]): void {
  writeJson(RB_MODULE, RB_KEY, rows)
}

function findBin(rows: RecycleBinRow[], id: string): RecycleBinRow | undefined {
  return rows.find(r => r.id === id)
}

function removeBin(rows: RecycleBinRow[], id: string): RecycleBinRow[] {
  return rows.filter(r => r.id !== id)
}

function sortByDeletedAtDesc(rows: RecycleBinRow[]): void {
  rows.sort((a, b) => (a.deleted_at > b.deleted_at ? -1 : a.deleted_at < b.deleted_at ? 1 : 0))
}

/** 本地时间 'YYYY-MM-DD HH:MM:SS'（与原表 datetime 默认值语义一致） */
function formatLocalDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 过期判断：兼容历史 ISO('...T...Z') 与 'YYYY-MM-DD HH:MM:SS' 两种格式，统一到秒级字符串比较 */
function isExpired(deletedAt: string, cutoff: string): boolean {
  return deletedAt.replace('T', ' ').slice(0, 19) < cutoff
}

/** 清理过期项并返回清理后的列表（有变更才落盘） */
function purgeExpiredRows(): RecycleBinRow[] {
  const retentionDays = getSettingsRetentionDays()
  const cutoff = formatLocalDateTime(new Date(Date.now() - retentionDays * 86400000))
  const rows = readBin()
  const kept = rows.filter(r => !isExpired(r.deleted_at, cutoff))
  if (kept.length !== rows.length) writeBin(kept)
  return kept
}

/** 统一写 API：其它模块删除条目入回收站时调用（替代散布的 INSERT INTO recycle_bin 直写 SQL） */
export function recycleBinAdd(entry: { id: string; original_id: string; module: string; title: string; data: string; deleted_at?: string }): void {
  const rows = readBin()
  rows.push({
    id: entry.id,
    original_id: entry.original_id,
    module: entry.module,
    title: entry.title,
    data: entry.data,
    deleted_at: entry.deleted_at ?? formatLocalDateTime(new Date()),
  })
  writeBin(rows)
}


export function registerRecycleBinHandlers(): void {
  // ---- 获取回收站列表（自动清除过期项） ----
  ipcMain.handle('recycleBin:getItems', () => {
    // 清除过期数据
    const rows = purgeExpiredRows()
    sortByDeletedAtDesc(rows)

    // 逐条容错:单条快照损坏只跳过该条,不拖垮整个回收站列表
    const items: unknown[] = []
    for (const r of rows) {
      try {
        items.push({
          id: r.id,
          originalId: r.original_id,
          module: r.module,
          title: r.title,
          data: JSON.parse(r.data),
          deletedAt: r.deleted_at
        })
      } catch { /* 跳过损坏条目 */ }
    }
    return items
  })

  // ---- 恢复回收站项目 ----
  ipcMain.handle('recycleBin:restoreItem', (_e, id: string): { success: boolean; message?: string } | undefined => {
    const item = findBin(readBin(), id)
    if (!item) return

    let record: any
    try { record = JSON.parse(item.data) } catch {
      return { success: false, message: '该条目数据已损坏,无法恢复(可直接删除)' }
    }

    if (item.module === 'blog') {
      // 恢复博文 — 同日期去重:已有该日期日志时不恢复(避免造出重复日期条目);查 vault 真相源
      const dup = vaultListEntries({ date: record.date })
      if (dup.length > 0) {
        return { success: false, message: `恢复失败:${record.date} 已存在日志,请先处理该日的现有日志` }
      }
      // 写 .knowbase/blog/<年>/<date>.md（tags 按 vault 约定 id=name，frontmatter 存名字）
      const tagNames = Array.isArray(record.tags)
        ? (record.tags as Array<{ name?: unknown }>).map((t) => String(t?.name ?? '')).filter(Boolean)
        : []
      const created = vaultCreateEntry({
        title: record.title, contentMd: record.contentMd, date: record.date,
        tags: tagNames, states: record.states,
      })
      // vaultCreateEntry 不收 isPinned，钉住状态补一次小编辑（仅钉住时，避免多余 frontmatter 重写）
      if (record.isPinned) vaultUpdateEntry(created.id, { isPinned: true })
      // 恢复正文内联图片附件
      restoreAttachments(parseInlineAttachmentIds(record.contentMd || ''))
    } else if (item.module === 'knowledge') {
      // 恢复知识页面 — 写 frontmatter md（分类按字典 path 落位，失效落收件箱）；重复 id 报错
      try {
        vaultRestorePage({
          id: record.id, title: record.title, contentMd: record.contentMd || '',
          categoryId: record.categoryId ?? null,
          tags: Array.isArray(record.tags) ? record.tags : [],
          starred: !!record.isStarred, sortOrder: record.sortOrder || 0,
          fileType: record.fileType || '', createdAt: record.createdAt, updatedAt: record.updatedAt,
        })
      } catch (e) {
        return { success: false, message: e instanceof Error ? e.message : '恢复失败' }
      }
      // 恢复正文内联图片附件
      restoreAttachments(parseInlineAttachmentIds(record.contentMd || ''))
      // 注意: knowledge_links 不恢复 — 索引重建时自动从正文提取出链
    } else if (item.module === 'knowledge_category') {
      const cat = record.category
      const categoryType = normalizeCategoryType(cat.categoryType)
      const parentId = resolveCategoryParent(categoryType, cat.parentId)

      // 恢复目录：mkdir 磁盘文件夹 + categories.json 追加条目（重复 id 报错，对齐原主键语义）
      try {
        vaultRestoreCategory({ id: cat.id, name: cat.name, parentId, sortOrder: cat.sortOrder || 0, categoryType })
      } catch (e) {
        return { success: false, message: e instanceof Error ? e.message : '恢复失败' }
      }

      // Recursively restore children
      const restoreChildren = (children: any[], parentId: string) => {
        for (const ch of (children || [])) {
          const c = ch.category
          vaultRestoreCategory({ id: c.id, name: c.name, parentId, sortOrder: c.sortOrder || 0, categoryType: normalizeCategoryType(c.categoryType) })
          // Restore pages under this child（页面已存在/单独恢复过 → 跳过）
          for (const p of (ch.pages || [])) {
            try {
              vaultRestorePage({
                id: p.id, title: p.title, contentMd: p.contentMd || '', categoryId: c.id,
                tags: p.tags || [], starred: !!p.isStarred, sortOrder: p.sortOrder || 0,
                fileType: p.fileType || '', createdAt: p.createdAt, updatedAt: p.updatedAt,
              })
            } catch { /* 页面已存在(可能被单独恢复过),跳过 */ }
          }
          restoreChildren(ch.children, c.id)
        }
      }
      restoreChildren(record.children || [], cat.id)

      // Restore direct pages
      for (const p of (record.pages || [])) {
        try {
          vaultRestorePage({
            id: p.id, title: p.title, contentMd: p.contentMd || '', categoryId: cat.id,
            tags: p.tags || [], starred: !!p.isStarred, sortOrder: p.sortOrder || 0,
            fileType: p.fileType || '', createdAt: p.createdAt, updatedAt: p.updatedAt,
          })
        } catch { /* 页面已存在(可能被单独恢复过),跳过 */ }
      }
    } else if (item.module === 'passwordVault') {
      // 恢复密码条目(新快照中密码为密文,直接插回;旧明文快照插入后由加密清理统一处理)
      // P5b：vault 恢复进 .knowbase/secret/passwords.json（密文原样，明文快照补加密）
      const vrows = vaultPasswordsAll()
      if (vrows.some((r) => r.id === record.id)) return { success: false, message: '仓库中已存在同一条目' }
      const storedPwd = typeof record.password === 'string' && !record.password.startsWith('enc1:') ? encryptPassword(record.password) : record.password
      const nextOrder = vrows.reduce((m, r) => Math.max(m, (r.sort_order ?? 0) + 1), 0)
      vrows.push({
        id: record.id, title: record.title || '', url: record.url || null, username: record.username || null,
        account: record.account || null, password: storedPwd, notes: record.notes || null,
        sort_order: nextOrder, created_at: record.createdAt, updated_at: record.updatedAt,
        favorite: record.favorite === true, group: record.group || '',
      })
      vaultPasswordsSave(vrows)
    } else if (item.module === 'moments') {
      const images = Array.isArray(record.imageDataUrls)
        ? record.imageDataUrls
        : (record.imageDataUrl ? [record.imageDataUrl] : [])
      const tags = Array.isArray(record.tags) ? record.tags.filter((t: unknown) => typeof t === 'string' && t.trim().length > 0) : []
      const attachmentIds = Array.isArray(record.attachmentIds) ? record.attachmentIds : []
      // 重复保护：同 id 已存在则不恢复（对齐原主键语义）
      const rows = vaultPostsAll()
      if (rows.some((r) => r.id === record.id)) {
        return { success: false, message: '仓库中已存在同一条目' }
      }
      // 相册可能已删除:置空避免悬挂引用
      const albumOk = record.albumId
        ? vaultAlbumsAll().some((a) => a.id === record.albumId)
        : false
      // 写 .knowbase/modules/moments/posts.json（行结构与表行一致，列内 JSON 保持字符串）
      const row: MomentsRow = {
        id: record.id,
        content_md: record.contentMd || '',
        content_html: record.contentHtml || '',
        image_data_url: '',
        images_data_urls: JSON.stringify(images),
        attachment_ids: JSON.stringify(attachmentIds),
        tags: JSON.stringify(tags),
        album_id: albumOk ? record.albumId : '',
        is_pinned: record.isPinned ? 1 : 0,
        show_in_timeline: record.showInTimeline === false ? 0 : 1,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      }
      vaultPostsSave([...rows, row])
      if (attachmentIds.length > 0) restoreAttachments(attachmentIds)
    }

    // 从回收站移除
    writeBin(removeBin(readBin(), id))
  })

  // ---- 部分恢复（从知识目录快照中恢复单个页面/子目录） ----
  ipcMain.handle('recycleBin:restorePartial', (_e, binId: string, path: string) => {
    const rows = readBin()
    const item = findBin(rows, binId)
    if (!item) return
    if (item.module !== 'knowledge_category') return
    const record = JSON.parse(item.data)

    // Parse path like "pages.2" or "children.0.pages.1" or "children.1"
    const segments = path.split('.')
    let container: any = record
    let parentContainer: any = null
    let key: string = ''
    let index: number = -1
    for (let i = 0; i < segments.length; i++) {
      parentContainer = container
      key = segments[i]
      index = -1
      if (/^\d+$/.test(segments[i + 1] || '')) {
        key = segments[i]
        index = parseInt(segments[++i], 10)
        container = container[key]?.[index]
      } else if (i === segments.length - 1) {
        // last segment
      } else {
        container = container[segments[i]]
      }
    }

    // container now is the parent of the target
    if (path === 'category') {
      // Restore only the top-level category itself (no children/pages)
      const c = record.category
      const categoryType = normalizeCategoryType(c.categoryType)
      const parentId = resolveCategoryParent(categoryType, c.parentId)
      vaultRestoreCategory({ id: c.id, name: c.name, parentId, sortOrder: c.sortOrder || 0, categoryType })
      // Remove category from snapshot; if nothing left, delete bin entry
      delete record.category
      const hasContent = (record.pages?.length > 0) || (record.children?.length > 0) || record.category
      if (!hasContent) {
        writeBin(removeBin(rows, binId))
      } else {
        item.data = JSON.stringify(record)
        writeBin(rows)
      }
      return
    }

    if (segments[0] === 'pages') {
      // Restore a direct page from record.pages[i]（categoryId=null → 落收件箱，与原未分类语义对齐）
      const pageIdx = parseInt(segments[1], 10)
      const page = record.pages[pageIdx]
      if (page) {
        vaultRestorePage({
          id: page.id, title: page.title, contentMd: page.contentMd || '', categoryId: null,
          tags: page.tags || [], starred: !!page.isStarred, sortOrder: page.sortOrder || 0,
          fileType: page.fileType || '', createdAt: page.createdAt, updatedAt: page.updatedAt,
        })
        record.pages.splice(pageIdx, 1)
      }
    } else if (segments[0] === 'children') {
      const childIdx = parseInt(segments[1], 10)
      const child = record.children[childIdx]
      if (!child) return

      if (segments.length === 2) {
        // Restore entire child category as root
        const c = child.category
        const categoryType = normalizeCategoryType(c.categoryType)
        const parentId = resolveCategoryParent(categoryType, c.parentId)
        vaultRestoreCategory({ id: c.id, name: c.name, parentId, sortOrder: c.sortOrder || 0, categoryType })
        const restorePages = (pages: any[], catId: string) => {
          for (const p of pages) {
            vaultRestorePage({
              id: p.id, title: p.title, contentMd: p.contentMd || '', categoryId: catId,
              tags: p.tags || [], starred: !!p.isStarred, sortOrder: p.sortOrder || 0,
              fileType: p.fileType || '', createdAt: p.createdAt, updatedAt: p.updatedAt,
            })
          }
        }
        const restoreChildren = (children: any[], parentId: string) => {
          for (const ch of children) {
            const cc = ch.category
            vaultRestoreCategory({ id: cc.id, name: cc.name, parentId, sortOrder: cc.sortOrder || 0, categoryType: normalizeCategoryType(cc.categoryType) })
            restorePages(ch.pages || [], cc.id)
            restoreChildren(ch.children || [], cc.id)
          }
        }
        restorePages(child.pages || [], c.id)
        restoreChildren(child.children || [], c.id)
        record.children.splice(childIdx, 1)
      } else if (segments[2] === 'pages') {
        // Restore a page within a child: children.X.pages.Y
        const pageIdx = parseInt(segments[3], 10)
        const page = child.pages[pageIdx]
        if (page) {
          vaultRestorePage({
            id: page.id, title: page.title, contentMd: page.contentMd || '', categoryId: null,
            tags: page.tags || [], starred: !!page.isStarred, sortOrder: page.sortOrder || 0,
            fileType: page.fileType || '', createdAt: page.createdAt, updatedAt: page.updatedAt,
          })
          child.pages.splice(pageIdx, 1)
        }
      }
    }

    // Check if snapshot is now empty (no pages, no children)
    const hasContent = (record.pages?.length > 0) || (record.children?.length > 0)
    if (!hasContent) {
      writeBin(removeBin(rows, binId))
    } else {
      item.data = JSON.stringify(record)
      writeBin(rows)
    }
  })

  // ---- 从快照中永久删除单条（不恢复，直接丢弃） ----
  function spliceFromSnapshot(record: any, path: string): boolean {
    const segs = path.split('.')
    let container: any = record
    for (let i = 0; i < segs.length - 2; i++) {
      if (/^\d+$/.test(segs[i + 1])) {
        container = container[segs[i]][parseInt(segs[++i], 10)]
      } else {
        container = container[segs[i]]
      }
    }
    const arrKey = segs[segs.length - 2]
    const idx = parseInt(segs[segs.length - 1], 10)
    return container[arrKey] ? (container[arrKey].splice(idx, 1), true) : false
  }

  ipcMain.handle('recycleBin:permanentlyDeletePartial', (_e, binId: string, path: string) => {
    const rows = readBin()
    const item = findBin(rows, binId)
    if (!item) return
    if (item.module !== 'knowledge_category') return
    const record = JSON.parse(item.data)

    if (path === 'category') {
      delete record.category
    } else {
      spliceFromSnapshot(record, path)
    }

    const hasContent = (record.pages?.length > 0) || (record.children?.length > 0) || !!record.category
    if (!hasContent) {
      writeBin(removeBin(rows, binId))
    } else {
      item.data = JSON.stringify(record)
      writeBin(rows)
    }
  })

  // ---- 移入系统回收站（单条） ----
  ipcMain.handle('recycleBin:trashToOS', async (_e, id: string) => {
    const item = findBin(readBin(), id)
    if (!item) return
    const record = { module: item.module, title: item.title, data: JSON.parse(item.data) }
    await trashItem(id, record)
    writeBin(removeBin(readBin(), id))
  })

  // ---- 移入系统回收站（全部） ----
  ipcMain.handle('recycleBin:trashAllToOS', async () => {
    const rows = readBin()
    sortByDeletedAtDesc(rows)
    if (rows.length === 0) return
    const items = rows.map(r => ({ binId: r.id, module: r.module, title: r.title, data: JSON.parse(r.data) }))
    await trashAll(items)
    writeBin([])
  })

  // ---- 从快照中局部移入系统回收站 ----
  ipcMain.handle('recycleBin:trashPartialToOS', async (_e, binId: string, path: string) => {
    const rows = readBin()
    const item = findBin(rows, binId)
    if (!item) return
    if (item.module !== 'knowledge_category') return
    const record = JSON.parse(item.data)

    // Extract the target data
    let node: any = record
    const segs = path.split('.')
    for (let i = 0; i < segs.length; i++) {
      if (/^\d+$/.test(segs[i + 1])) {
        node = node[segs[i]][parseInt(segs[++i], 10)]
      } else {
        node = node[segs[i]]
      }
    }

    // Write the partial item to temp + trash
    if (path === 'category') {
      await trashItem(binId, { module: 'knowledge', title: node.name, data: { title: node.name, contentMd: '' } })
    } else if (path.includes('pages.')) {
      await trashItem(binId, { module: 'knowledge', title: node.title, data: node })
    } else {
      // child category
      await trashItem(binId, { module: 'knowledge_category', title: node?.category?.name || '子目录', data: node })
    }

    // Remove from snapshot
    spliceFromSnapshot(record, path)

    const hasContent = (record.pages?.length > 0) || (record.children?.length > 0) || !!record.category
    if (!hasContent) {
      writeBin(removeBin(rows, binId))
    } else {
      item.data = JSON.stringify(record)
      writeBin(rows)
    }
  })

  // ---- 永久删除单条（直接删库，不移入系统回收站） ----
  ipcMain.handle('recycleBin:permanentlyDelete', (_e, id: string) => {
    writeBin(removeBin(readBin(), id))
  })

  // ---- 清空回收站（移入系统回收站） ----
  ipcMain.handle('recycleBin:emptyAll', async () => {
    // 1) Snapshot items before deleting — so we can write them to disk
    const rows = readBin()
    sortByDeletedAtDesc(rows)
    const items = rows.map(r => ({ binId: r.id, module: r.module, title: r.title, data: JSON.parse(r.data) }))

    // 2) Clear bin immediately — the frontend sees instant feedback
    writeBin([])

    // 3) Write files + move to OS recycle bin in background (don't block the response)
    if (items.length > 0) {
      trashAll(items).catch(e => console.error('trashAll failed:', e))
    }
  })

  // ---- 清除过期项（独立调用） ----
  ipcMain.handle('recycleBin:purgeExpired', () => {
    purgeExpiredRows()
  })
}
