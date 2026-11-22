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
 * 两个导出各管一段流程：
 *   · `stableTopo` —— 全量排序（大纲落盘 `topoOrderUnits`、默认选点 `defaultUnitSelection`）；
 *   · `orderSelectedUnits` —— **只排「选中集合」**（开段确认后的段内讲解顺序，2026-11-22）。
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

/**
 * 选中集合的段内讲解顺序：先按**大纲行序**取选中项（与改造前同一基准，不按点击顺序），
 * 再套章内先修拓扑序。
 *
 * 为什么要这一步：开段预检的 `orderedUnits` 原先是大纲行序，而段内讲解顺序就是
 * `lesson.unitIds` 的顺序（注入的「本段知识点清单」、`当前聚焦第 X/N`、`activeUnitId` 全跟着它）——
 * 选了 u2/u3 而 u3 依赖 u2 时，行序可能在拓扑上倒着讲。
 *
 * 口径（与 `stableTopo` 完全一致，不新增规则）：
 *   · 无 `requires` / 有环 / 缺先修 → 输出 = 大纲行序的选中项（与改造前逐字一致）；
 *   · 先修不在**本次选中集合**内 → 视为已满足（它要么已在别段学过，要么这段不覆盖它）；
 *   · 只重排、不增删：输出集合恒等于选中集合（跨章 / 不存在的 id 直接忽略）。
 */
export function orderSelectedUnits<T extends TopoUnit>(units: ReadonlyArray<T>, selectedIds: ReadonlyArray<string>): T[] {
  const pick = new Set((selectedIds ?? []).map((x) => String(x ?? '').trim()).filter(Boolean))
  if (!pick.size) return []
  return stableTopo(units.filter((u) => pick.has(u.id)))
}
