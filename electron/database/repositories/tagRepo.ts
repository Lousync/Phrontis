import { ipcMain } from 'electron'
import { vaultBlogTags, vaultRemoveTagFromAll } from 'phrontis-core/kbStore/blogVaultRepo'

// R6 去库化：真相源 = .knowbase/blog/（tags 记录在各博文 md frontmatter；sql.js 路径已移除，D9）

export function registerTagHandlers(): void {
  // 博客 tag 随读源走仓库。vault 约定 tag.id = name（同名即同 tag）
  // 获取所有标签
  ipcMain.handle('db:getTags', () => vaultBlogTags())

  // 创建标签
  ipcMain.handle('db:createTag', (_event, name: string, color?: string) => {
    const n = name.trim()
    const existing = vaultBlogTags().find((t) => t.name === n)
    return existing ?? { id: n, name: n, color: color || '#6b7280' }
  })

  // 删除标签
  ipcMain.handle('db:deleteTag', (_event, id: string) => {
    // vault 下 id = tag 名：从全部博文 frontmatter 移除该 tag
    vaultRemoveTagFromAll(id)
  })
}
