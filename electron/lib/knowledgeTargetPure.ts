/**
 * AI 工具「知识库目标目录」解析（纯逻辑，v3.15.2）。
 *
 * 背景：`builtin.knowledge.create-page` / `builtin.quiz.gen-paper` 过去只用
 * `categoryName` 在分类索引里找目录，而分类索引只派生自「已有知识页的目录」——
 * 空目录、通过「新建目录」建的普通目录、系统文件管理器里建的目录都不在索引里，
 * 于是模型在作用域 / `vault.list` 里看得到目录，写工具却报「未找到分类」。
 *
 * 本模块把「目录能不能作为写入目标」收敛成一条纯规则，供主进程 handler 与契约脚本共用：
 *   1. 方案应用期已解析好的 `categoryId` / `dirRel` 优先（目录可能已被删，需重新校验）；
 *   2. `categoryPath` = 仓库相对目录，精确匹配分类路径，否则按磁盘目录放行；
 *   3. `categoryName` = 精确分类名（含学习空间根）；同名歧义要求改用 `categoryPath`；
 *   4. 分类索引里没有、但磁盘上存在的同名根目录 → 直接作为 `dirRel` 写入（空目录可建首篇）。
 *
 * 零依赖：契约脚本可 `node --experimental-strip-types` 直接 import。
 */

export interface KnowledgeCategoryLike {
  id: string
  name: string
  parentId: string | null
  categoryType: string
  path?: string
}

export interface KnowledgeTarget {
  /** 命中分类索引时的分类 id（写入走 vaultGetCategoryRelPath） */
  categoryId: string | null
  /** 未进分类索引、但磁盘存在的目录（仓库相对路径，posix） */
  dirRel: string | null
  /** 给用户 / 方案摘要看的落点文案 */
  display: string
}

/** 归一化仓库相对目录：拒绝绝对路径、盘符、`.` / `..`、隐藏目录段 */
export function normalizeDirRel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const input = raw.trim().replace(/\\/g, '/')
  if (!input) return null
  if (input.startsWith('/')) return null
  if (/^[a-zA-Z]:/.test(input)) return null
  const norm = input.replace(/\/+$/g, '')
  if (!norm) return null
  const parts = norm.split('/')
  if (parts.some((p) => !p || p === '.' || p === '..')) return null
  if (parts.some((p) => p.startsWith('.'))) return null
  return norm
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * 解析写入目标。`dirExists` 由调用方注入（主进程用磁盘检查，契约脚本用固定表）。
 * 返回 `{ categoryId: null, dirRel: null }` = 未分类收件箱。
 */
export function resolveKnowledgeTargetPure(
  args: Record<string, unknown>,
  categories: ReadonlyArray<KnowledgeCategoryLike>,
  dirExists: (rel: string) => boolean,
): KnowledgeTarget {
  // 1) 方案应用：暂存期解析结果优先。目录可能已被删除，必须重新校验。
  const stagedId = str(args.categoryId)
  if (stagedId) {
    const c = categories.find((x) => x.id === stagedId)
    if (!c || !c.path) throw new Error('目标分类已不存在或未绑定目录，请重新指定目录')
    return { categoryId: c.id, dirRel: null, display: c.path || c.name }
  }
  const rawStagedDir = str(args.dirRel)
  if (rawStagedDir) {
    const stagedDir = normalizeDirRel(rawStagedDir)
    if (!stagedDir) throw new Error(`方案中的目标目录非法：${rawStagedDir}`)
    if (!dirExists(stagedDir)) throw new Error(`目标目录已不存在：${stagedDir}`)
    return { categoryId: null, dirRel: stagedDir, display: stagedDir }
  }

  // 2) categoryPath：按路径精确落点，可写入空目录 / 学习空间根
  const rawPath = str(args.categoryPath)
  if (rawPath) {
    const path = normalizeDirRel(rawPath)
    if (!path) throw new Error(`目录路径非法：${rawPath}`)
    const byPath = categories.find((c) => c.path === path)
    if (byPath) return { categoryId: byPath.id, dirRel: null, display: path }
    if (dirExists(path)) return { categoryId: null, dirRel: path, display: path }
    throw new Error(`目录不存在：${path}。请先在知识库创建该目录，或省略 categoryPath 存入未分类`)
  }

  // 3) categoryName：精确分类名（含 space / notebook）
  const name = str(args.categoryName)
  if (!name) return { categoryId: null, dirRel: null, display: '未分类' }
  const hits = categories.filter((c) => c.name === name && !!c.path)
  if (hits.length > 1) {
    const top = hits.filter((c) => !c.parentId)
    if (top.length === 1) return { categoryId: top[0].id, dirRel: null, display: top[0].path || top[0].name }
    throw new Error(`存在 ${hits.length} 个同名分类「${name}」，请改用 categoryPath 指定完整目录`)
  }
  if (hits.length === 1) {
    return { categoryId: hits[0].id, dirRel: null, display: hits[0].path || hits[0].name }
  }

  // 4) 磁盘兜底：空目录 / 普通目录尚未进入分类索引（目录即分类只认「有知识页的目录」）
  if (!name.includes('/') && dirExists(name)) return { categoryId: null, dirRel: name, display: name }
  throw new Error(`未找到分类「${name}」。可改用 categoryPath 指定仓库目录，或省略以存入未分类`)
}
