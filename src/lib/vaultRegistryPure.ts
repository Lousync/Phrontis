/**
 * 仓库登记表（`data/vaults.json`）的纯函数：按 **id** 去重 / upsert。
 *
 * 背景（2026-10-20 实测）：仓库被复制或移动到新路径后，`.knowbase/meta.json` 里的 id 不变，
 * 但登记表按 **path** 去重 → 旧的 U 盘路径行会留下来，和新路径行**同 id 两行**。
 * 表象：仓库切换器里同一个仓库出现两次（React 报 duplicate key），启动时也选错路径。
 *
 * 口径：id 是仓库身份（跨设备/跨路径的唯一真相源）；path 只是「本机上次打开的位置」。
 */

export interface VaultRegistryRowLike {
  id: string
  name: string
  path: string
  created_at?: string
  updated_at?: string
}

/**
 * 同一 id 只保留一行：
 * 1) 优先保留**磁盘上还存在**的路径（仓库被移动后，旧路径行是死链）；
 * 2) 都存在时保留 `updated_at` 更新的那行；
 * 3) 其余（created_at 等）原样保留。
 */
export function dedupeVaultRows<T extends VaultRegistryRowLike>(
  rows: T[],
  pathExists: (path: string) => boolean,
): T[] {
  const byId = new Map<string, T>()
  for (const row of rows) {
    const prev = byId.get(row.id)
    if (!prev) {
      byId.set(row.id, row)
      continue
    }
    const rowOk = pathExists(row.path)
    const prevOk = pathExists(prev.path)
    if (rowOk !== prevOk) {
      if (rowOk) byId.set(row.id, row)
      continue
    }
    if (String(row.updated_at ?? '') > String(prev.updated_at ?? '')) byId.set(row.id, row)
  }
  return [...byId.values()]
}

/**
 * upsert 一行：**同 id 或同 path 的旧行都删掉**，再追加新行。
 * 只按 path 去重会漏掉「仓库被移动」这一种（id 相同、path 不同）。
 */
export function upsertVaultRow<T extends VaultRegistryRowLike>(rows: T[], row: T): T[] {
  return rows.filter((r) => r.id !== row.id && r.path !== row.path).concat(row)
}
