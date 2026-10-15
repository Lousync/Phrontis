import { workspaceListDir } from './ipc'
import type { DirCache, TreeNode } from '../components/shared/VaultTree'

export interface TreeSubtreeLoad {
  /** 新加载的目录缓存（rel → 条目），供调用方 merge 进自己的 dirCache */
  cache: DirCache
  /** 应标记为展开的目录集合（含 startRel 自身及其所有子孙） */
  dirs: Set<string>
  /** 是否触到目录数上限被截断 */
  truncated: boolean
}

/**
 * 递归加载某目录子树（含自身）——右键「展开此目录（含子目录）」共用实现。
 *
 * ★ 带上限 `cap`（默认 2000 个目录）：大仓库里无边界递归会把整棵树一次性拉进内存 + 挂进 DOM，
 *   这正是「全部展开」卡顿的根因。超过上限即停并标记 truncated（调用方提示用户），
 *   把「展开多少」的控制权交回给用户点的具体目录。
 */
export async function loadTreeSubtree(rootId: string, startRel: string, cap = 2000): Promise<TreeSubtreeLoad> {
  const cache: DirCache = {}
  const dirs = new Set<string>([startRel])
  const queue: string[] = [startRel]
  let guard = 0
  let truncated = false
  while (queue.length > 0) {
    if (guard >= cap) { truncated = true; break }
    guard += 1
    const rel = queue.shift() as string
    const res = await workspaceListDir(rootId, rel).catch(() => null)
    if (!res || res.error) continue
    const nodes: TreeNode[] = (res.entries ?? []).map((e) => ({ ...e, relPath: rel ? `${rel}/${e.name}` : e.name }))
    cache[rel] = nodes
    for (const e of nodes) if (e.type === 'dir') { dirs.add(e.relPath); queue.push(e.relPath) }
  }
  return { cache, dirs, truncated }
}
