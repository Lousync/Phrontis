/**
 * 课程大纲 · 章内先修稳定拓扑序（**零依赖纯函数**，渲染层与主进程共用）。
 *
 * 本文件是 `stableTopo` 的**唯一真相源**：`electron/lib/courseOutlinePure.ts` 从这里 import
 * 并 re-export，`src/lib/aiTeachingSourcesPure.ts` 的开段预检选点也直接用它。
 * （渲染层不能 import `electron/lib`，故算法必须落在 `src/lib`。）
 *
 * 口径（与 `topoOrderUnits` 一致，改这里必须同步契约脚本）：
 *   · Kahn 式贪心：每轮取「先修都已就位」的**最靠前**一条 —— 原序优先，已合法的顺序一律不动；
 *   · 先修不在本组（章）内 → 视为已满足（跨章 / 缺失的先修不参与本地排序）；
 *   · 有环（找不到可取条目）→ **原样返回**入参副本，不抛错；
 *   · 无 `requires` → 输出与入参逐元素同序（调用方行为与改造前完全一致）。
 *
 * 契约脚本：`.AGENT/scripts/ai-teaching/verify-outline-topo.mjs`。
 */

/** 参与排序的最小形状：只要 id 与先修 id 列表 */
export interface TopoUnit {
  id: string
  /** 先修知识点 id（跨章 / 缺失都会被忽略，不阻断排序） */
  requires?: string[]
}

/** 章内稳定拓扑排序：每次取「先修都已就位」的最靠前一条（Kahn + 原序优先） */
export function stableTopo<T extends TopoUnit>(units: ReadonlyArray<T>): T[] {
  const local = new Set(units.map((u) => u.id))
  const picked = new Set<string>()
  const pending = units.slice()
  const out: T[] = []
  while (pending.length) {
    const i = pending.findIndex((u) => (u.requires ?? []).every((r) => !local.has(r) || picked.has(r)))
    // 有环：没有任何一条能取，原样返回（不抛错，调用方按行序退化）
    if (i < 0) return units.slice()
    const [u] = pending.splice(i, 1)
    picked.add(u.id)
    out.push(u)
  }
  return out
}
