import { ipcMain, shell } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync } from 'fs'
import { resolve as resolvePath, sep } from 'path'
import {
  vaultGetCategories, vaultGetPages, vaultGetPageById, vaultToggleStar,
  vaultGetStarredPages, vaultGetTags, vaultSearchPages,
  vaultGetBacklinks, vaultGetBacklinkContext,
  vaultGetCategoryRelPath, vaultDeleteCategory, vaultCreateCategory, vaultGetCategory, vaultCreatePage,
  vaultRenameCategory, vaultRenamePage, vaultMoveCategoryOrder, vaultMovePageOrder,
} from '../../lib/kbStore/knowledgeVaultRepo'
import { getCurrentVault } from '../../lib/kbStore/vaultContext'
import { emitPluginEvent } from '../../lib/pluginEvents'
import { getGraphIndex } from '../../lib/kbStore/graphIndex'
import { getKnowledgeIndex, invalidateKnowledgeIndex } from '../../lib/kbStore/knowledgeIndex'

type CategoryType = 'notebook' | 'folder' | 'space'

function normalizeCategoryType(raw: string): CategoryType {
  if (raw === 'notebook' || raw === 'space' || raw === 'folder') return raw
  return 'folder'
}

// ---- 读写分工（.AGENT/docs/读写分工设计.md）----
// R6 去库化收尾（D9）：知识库已全面切到 vault 读源，sqlite 分支移除。
// 白名单内通道走下方 vault 实现；白名单外的旧 DB-only 通道保留注册并统一拒绝，
// 维持 IPC 通道存在与既有拒绝语义（渲染层仍经 preload 暴露这些通道）。
const VAULT_ALLOWED = new Set([
  'knowledge:getCategories', 'knowledge:getPages', 'knowledge:getPageById', 'knowledge:findByRel',
  'knowledge:searchPages', 'knowledge:toggleStar', 'knowledge:getStarredPages', 'knowledge:getTags',
  'knowledge:getBacklinks', 'knowledge:getBacklinkContext', 'knowledge:getGraph',
  // 2026-09-07 知识库开放目录删除：vault 分支走 trash 磁盘文件夹 + 字典清理（与编辑器删除同语义）
  'knowledge:deleteCategory',
  // 2026-09-07 创建学习空间：vault 分支 = mkdir 磁盘文件夹 + categories.json 追加条目
  'knowledge:createCategory',
  // 2026-09-07 导入放行：vault 分支 = 写 frontmatter md 到目标目录/收件箱
  'knowledge:createPage',
  // 2026-09-09 知识库直接删除页面：vault 分支 = 页面 .md 移入系统回收站（与编辑器 ws:trash / 目录删除同语义）
  'knowledge:deletePage',
  // 2026-09-07 重命名/排序放行：重命名=磁盘改名+字典级联；排序=字典/frontmatter 规范化互换
  'knowledge:updateCategory', 'knowledge:updatePage', 'knowledge:moveCategory', 'knowledge:movePage',
  // 2026-09-08 .ignore 规则对账提示：索引 warnings（坏行/未命中规则）透出给知识库 UI（§10.1）
  'knowledge:getIndexWarnings',
])

const VAULT_REJECT_MSG = '仓库读源模式下该操作暂不支持：请在编辑器模块中编辑内容'

export function registerKnowledgeHandlers(): void {
  /** 非白名单通道统一拒绝 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function kHandle(channel: string, fn: (e: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ipcMain.handle(channel, (e: Electron.IpcMainInvokeEvent, ...args: any[]) => {
      if (!VAULT_ALLOWED.has(channel)) throw new Error(VAULT_REJECT_MSG)
      return fn(e, ...args)
    })
  }

  // 获取所有分类
  kHandle('knowledge:getCategories', () => vaultGetCategories())

  // 索引 warnings（.ignore 坏行 / 规则未命中磁盘条目等）：只读，读索引走缓存不触发 rebuild
  kHandle('knowledge:getIndexWarnings', () => getKnowledgeIndex().warnings)

  // 创建分类 — mkdir 仓库文件夹 + categories.json 追加条目（空间/笔记本=顶层，文件夹可挂父目录）
  kHandle('knowledge:createCategory', (_e, data: { name: string; parentId?: string | null; categoryType?: CategoryType }) => {
    const ct = normalizeCategoryType(data.categoryType || 'folder')
    const cur = getCurrentVault()
    if (!cur) throw new Error('当前没有打开的仓库')
    const name = String(data.name ?? '').trim()
    if (!name) throw new Error('名称不能为空')
    if (/[\\/:*?"<>|]/.test(name)) throw new Error('名称不能包含 \\ / : * ? " < > | 等文件名字符')
    const parentId = data.parentId === undefined ? null : data.parentId
    // 空间恒为仓库顶层；笔记本只能创建在学习空间内部（不可嵌套、不可顶层——2026-09-07 规则）
    const parentRel = parentId ? vaultGetCategoryRelPath(parentId) : null
    if (parentId && !parentRel) throw new Error('父目录不存在或未绑定仓库文件夹')
    if (ct === 'space') {
      if (parentId) throw new Error('学习空间只能创建在仓库顶层')
    }
    if (ct === 'notebook') {
      const parent = parentId ? vaultGetCategory(parentId) : null
      if (!parent || parent.categoryType !== 'space') throw new Error('笔记本只能创建在学习空间内部')
    }
    const baseRel = parentRel ? `${parentRel}/${name}` : name
    const abs = resolvePath(resolvePath(cur.rootPath), baseRel)
    if (existsSync(abs)) throw new Error(`同名文件夹「${name}」已存在`)
    mkdirSync(abs, { recursive: true })
    const id = randomUUID()
    vaultCreateCategory({ id, name, categoryType: ct, parentId, path: baseRel })
    return { id, name, parentId, sortOrder: 0, categoryType: ct, path: baseRel }
  })

  // 更新分类（重命名）— 2026-09-07 vault 放行：仅支持目录重命名（磁盘改名+字典级联）；移动/排序走 moveCategory 通道
  kHandle('knowledge:updateCategory', (_e, id: string, data: { name?: string; parentId?: string | null; sortOrder?: number; categoryType?: CategoryType }) => {
    if (!data.name) throw new Error('仓库文件模式下目录仅支持重命名')
    vaultRenameCategory(id, String(data.name))
  })

  // 移动分类（上下排序）— categories.json 同父级排序（规范化重编号）
  kHandle('knowledge:moveCategory', (_e, id: string, direction: 'up' | 'down') => {
    vaultMoveCategoryOrder(id, direction)
  })

  // 删除分类 — 目录对应仓库内真实文件夹 → 移入系统回收站（与编辑器删除同语义）+ 字典条目清理
  kHandle('knowledge:deleteCategory', async (_e, id: string) => {
    const rel = vaultGetCategoryRelPath(id)
    if (rel) {
      const cur = getCurrentVault()
      if (!cur) throw new Error('当前没有打开的仓库')
      // 路径守卫：目录必须落在仓库根内、不得是仓库根本身、不得位于 .knowbase 数据目录下
      const rootAbs = resolvePath(cur.rootPath)
      const abs = resolvePath(rootAbs, rel)
      if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) throw new Error('目录路径越界，已阻止删除')
      if (abs.slice(rootAbs.length + 1).split(sep).includes('.knowbase')) throw new Error('.knowbase 数据目录不可删除')
      await shell.trashItem(abs)
    }
    vaultDeleteCategory(id)
  })

  // ===== Page handlers =====
  // 获取分类下的页面
  kHandle('knowledge:getPages', (_e, categoryId?: string | null) => {
    return vaultGetPages(categoryId)
  })

  // 获取单个页面
  kHandle('knowledge:getPageById', (_e, id: string) => {
    return vaultGetPageById(id)
  })

  // 按仓库相对路径反查页面：题单 store 在只有 relPath（工件栏/auto 页）时解析 pageId。
  // 返回的 id 可能是 auto:<rel>（文件尚无 frontmatter id），由调用方在页面转正后再次解析。
  kHandle('knowledge:findByRel', (_e, relPath: string) => {
    const rel = String(relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
    if (!rel) return null
    const page = getKnowledgeIndex().pages.find((p) => p.path.replace(/\\/g, '/') === rel)
    return page ? { id: page.id, title: page.title, path: page.path } : null
  })

  // 创建页面 — 写 frontmatter md 到目标目录/收件箱（2026-09-07 导入放行）
  kHandle('knowledge:createPage', (_e, data: { title?: string; contentMd?: string; contentHtml?: string; categoryId?: string | null; fileType?: string; tags?: string[] }) => {
    return vaultCreatePage({ title: data.title || '新页面', contentMd: data.contentMd || '', categoryId: data.categoryId ?? null, fileType: data.fileType, tags: data.tags })
  })

  // 更新页面（重命名）— 2026-09-07 vault 放行：仅支持页面重命名（文件改名+frontmatter title）；内容编辑仍收口编辑器模块
  kHandle('knowledge:updatePage', (_e, id: string, data: { title?: string; contentMd?: string; contentHtml?: string; categoryId?: string | null; fileType?: string; tags?: string[] }) => {
    if (!data.title) throw new Error('仓库文件模式下页面仅支持重命名')
    vaultRenamePage(id, String(data.title))
  })

  // 删除页面 — 2026-09-09 放行：页面 = 仓库内真实 .md → 移入系统回收站（与目录删除/编辑器 ws:trash 同语义，绝不 rm）
  kHandle('knowledge:deletePage', async (_e, id: string) => {
    const cur = getCurrentVault()
    if (!cur) throw new Error('当前没有打开的仓库')
    const entry = getKnowledgeIndex().byId[id]
    if (!entry) return
    const rootAbs = resolvePath(cur.rootPath)
    const abs = resolvePath(rootAbs, entry.path)
    if (abs === rootAbs || !abs.startsWith(rootAbs + sep)) throw new Error('页面路径越界，已阻止删除')
    await shell.trashItem(abs)
    invalidateKnowledgeIndex()
    emitPluginEvent('knowledge:pageDeleted', { pageId: entry.id, title: entry.title })
  })

  // 移动页面（上下排序）— 同目录页面 frontmatter.sortOrder 互换
  kHandle('knowledge:movePage', (_e, id: string, direction: 'up' | 'down') => {
    vaultMovePageOrder(id, direction)
  })

  // 搜索页面（多关键词 AND + 命中摘录）
  kHandle('knowledge:searchPages', (_e, q: string) => {
    return vaultSearchPages(q)
  })

  // 收藏/取消收藏页面（读写分工拍板的例外：走 frontmatter 重写）
  kHandle('knowledge:toggleStar', (_e, id: string) => {
    return vaultToggleStar(id)
  })

  // 获取收藏的页面
  kHandle('knowledge:getStarredPages', () => {
    return vaultGetStarredPages()
  })

  // ===== Links =====
  // 获取反向链接（哪些页面链接到了此页面）
  kHandle('knowledge:getBacklinks', (_e, pageId: string) => {
    return vaultGetBacklinks(pageId)
  })

  // 反链上下文摘录：定位源页中 [[标题]] 引用处，取前后各约 60 字符
  kHandle('knowledge:getBacklinkContext', (_e, pageId: string) => {
    return vaultGetBacklinkContext(pageId)
  })

  // ===== Tags =====
  kHandle('knowledge:getTags', () => {
    return vaultGetTags()
  })

  // ===== Graph（R4-G0：GraphIndex graph.json；vault 读源专属） =====
  kHandle('knowledge:getGraph', () => {
    return getGraphIndex()
  })

  // ===== 旧 DB-only 通道：vault 模式下无实现，保留注册由白名单统一拒绝 =====
  // （页面拖拽重排/删除、手动关联、标签写入、深拷贝——删除页面等已收口编辑器模块的 vault 路径）
  const DB_ONLY_CHANNELS = [
    'knowledge:reorderPage',
    'knowledge:getManualLinks', 'knowledge:addManualLink', 'knowledge:removeManualLink', 'knowledge:updateLinks',
    'knowledge:createTag', 'knowledge:deleteTag',
    'knowledge:duplicatePage', 'knowledge:duplicateCategory',
  ]
  for (const ch of DB_ONLY_CHANNELS) {
    kHandle(ch, () => { throw new Error(VAULT_REJECT_MSG) })
  }
}
