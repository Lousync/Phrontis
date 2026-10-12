/**
 * 文件树排序口径（工作台·文件树模式头部「排序」按钮用；VaultTree 可选消费）。
 *
 * - **目录恒定排在文件前**（与主进程 listDirEntries 同口径）；
 * - 偏好持久化到 localStorage（重启保留）。
 */
export type TreeSortMode = 'name-asc' | 'name-desc' | 'mtime-desc' | 'mtime-asc'

export const TREE_SORT_OPTIONS: ReadonlyArray<{ value: TreeSortMode; label: string }> = [
  { value: 'name-asc', label: '名称 A → Z' },
  { value: 'name-desc', label: '名称 Z → A' },
  { value: 'mtime-desc', label: '修改时间 新 → 旧' },
  { value: 'mtime-asc', label: '修改时间 旧 → 新' },
]

const STORAGE_KEY = 'kb.treeSort'

export function getTreeSortMode(): TreeSortMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v && TREE_SORT_OPTIONS.some((o) => o.value === v)) return v as TreeSortMode
  } catch { /* 隐私模式静默 */ }
  return 'name-asc'
}

export function setTreeSortMode(mode: TreeSortMode): void {
  try { localStorage.setItem(STORAGE_KEY, mode) } catch { /* 隐私模式静默 */ }
}

/** 按 mode 排序（目录恒在前）；不修改入参，返回新数组。 */
export function sortTreeEntries<T extends { type: 'file' | 'dir'; name: string; mtime: number }>(entries: T[], mode: TreeSortMode): T[] {
  const out = [...entries]
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    switch (mode) {
      case 'name-asc': return a.name.localeCompare(b.name, 'zh-Hans-CN')
      case 'name-desc': return b.name.localeCompare(a.name, 'zh-Hans-CN')
      case 'mtime-desc': return b.mtime - a.mtime
      case 'mtime-asc': return a.mtime - b.mtime
    }
  })
  return out
}
