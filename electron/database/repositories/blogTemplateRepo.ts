import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { readJson, writeJson } from 'phrontis-core/kbStore/jsonStore'

/**
 * 博客模板 —— 用户自编辑的日记模板，写博客时可一键套用。
 * R6 去库化：真相源 = .knowbase/blog/templates.json（sql.js 路径已移除，D9）
 */

export interface BlogTemplateDto {
  id: string
  name: string
  contentMd: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}

// ===== vault 实现（.knowbase/blog/templates.json）=====
type Tpl = Omit<BlogTemplateDto, 'createdAt'> & { createdAt?: string }

function vaultRead(): BlogTemplateDto[] {
  const arr = readJson<Tpl[]>('blog', 'templates.json', [])
  const now = new Date().toISOString()
  return arr.map((t) => ({ ...t, createdAt: t.createdAt || now }))
}

function vaultWrite(list: BlogTemplateDto[]): void {
  writeJson('blog', 'templates.json', list)
}

export function registerBlogTemplateHandlers(): void {
  ipcMain.handle('blogTpl:list', () => {
    return vaultRead().sort((a, b) => a.sortOrder - b.sortOrder || b.updatedAt.localeCompare(a.updatedAt))
  })

  ipcMain.handle('blogTpl:create', (_e, data: { name: string; contentMd?: string }) => {
    const name = (data.name || '').trim()
    if (!name) return null
    const list = vaultRead()
    const now = new Date().toISOString()
    const tpl: BlogTemplateDto = {
      id: randomUUID(), name, contentMd: data.contentMd || '', sortOrder: list.length, createdAt: now, updatedAt: now,
    }
    vaultWrite([...list, tpl])
    return tpl
  })

  ipcMain.handle('blogTpl:update', (_e, id: string, data: { name?: string; contentMd?: string }) => {
    const list = vaultRead()
    const idx = list.findIndex((t) => t.id === id)
    if (idx < 0) return null
    const cur = list[idx]
    const next = {
      ...cur,
      name: data.name !== undefined && data.name.trim() ? data.name.trim() : cur.name,
      contentMd: data.contentMd !== undefined ? data.contentMd : cur.contentMd,
      updatedAt: new Date().toISOString(),
    }
    vaultWrite(list.map((t, i) => (i === idx ? next : t)))
    return next
  })

  ipcMain.handle('blogTpl:delete', (_e, id: string) => {
    vaultWrite(vaultRead().filter((t) => t.id !== id))
  })
}
