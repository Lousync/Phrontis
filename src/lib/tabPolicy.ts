/**
 * 页签策略的**纯函数**部分（v3.2.0 条目 18：VS Code 式双态标签 = 预览 + 固定）。
 *
 * 笔记合并 Phase 1（1.3）上移共享层 `src/lib/tabPolicy.ts`：编辑区与知识库页签共用
 * 同一套「该不该消失 / 关闭后落点」判据（docs/notes-merge-phase1-design.md §1.3）；
 * `src/modules/editor/tabPolicy.ts` 保留 re-export，既有 import 与本文件头部所述
 * 契约脚本 `.AGENT/scripts/editor/verify-tab-preview.mjs` 不受影响。
 *
 * 为什么单独成文件：这两条规则是「标签该不该消失」的全部判据，也是最容易在重构中被写歪的地方
 * （旧实现就是「干净就回收」，于是保存一下标签就没了）。放在这里可以被契约脚本
 * `.AGENT/scripts/editor/verify-tab-preview.mjs` **直接 import 真实实现执行** ——
 * 照抄一份算法到脚本里会正好掩盖「候选集自己选错了」这类缺陷。
 *
 * 零 React / 零 DOM 依赖：只做判定，不改任何 state。
 */

/** 固定标签的常驻软上限（预览标签不计数） */
export const TAB_SOFT_CAP = 20

/** 打开新文件时，旧预览标签的处置 */
export type PreviewReplacement = 'drop' | 'keep' | 'none'

/**
 * 转移规则 1 的判定部分：**新文件即将成为新预览**，旧预览怎么办？
 *   · 没有旧预览 / 旧预览就是新文件 → 'none'（什么都不用做）
 *   · 旧预览**脏**（有未保存修改）→ 'keep' —— 自动转固定，留在 openFiles 里，**绝不丢内容**
 *   · 旧预览干净 → 'drop' —— 从 openFiles 移除（无修改，丢弃安全，重开再读盘）
 */
export function previewReplacement(
  previewRel: string | null,
  nextRel: string,
  dirtyRels: readonly string[],
): PreviewReplacement {
  if (!previewRel || previewRel === nextRel) return 'none'
  return dirtyRels.includes(previewRel) ? 'keep' : 'drop'
}

export interface TabCapInput {
  /** 当前 openFiles 的 key（插入序 = 标签栏顺序） */
  rels: readonly string[]
  /** 当前预览标签（至多一个；null = 无预览态） */
  previewRel: string | null
  /** 当前激活标签 */
  activeRel: string | null
  /** 脏标签集合 */
  dirtyRels: readonly string[]
  /** 激活顺序，末尾 = 最近激活（未记账的视为最旧） */
  lru: readonly string[]
  /** 固定标签软上限 */
  cap?: number
}

/**
 * 常驻软上限回收（转移规则 5 之外的静默兜底）：只挑「**干净 + 非激活 + 非预览**」的
 * 固定标签，按 LRU 最旧优先，返回要回收的 rel 列表（可能为空）。
 *
 * 三档保护集永不回收：当前激活（回收了等于把用户正在看的文件关掉）、
 * 预览标签（它本来就不计数）、脏标签（回收即丢内容）。
 */
export function pickTabsToEvict(input: TabCapInput): string[] {
  const { rels, previewRel, activeRel, dirtyRels, lru, cap = TAB_SOFT_CAP } = input
  const fixed = rels.filter((r) => r !== previewRel)
  if (fixed.length <= cap) return []
  const guarded = new Set<string>([activeRel ?? '', previewRel ?? ''])
  const dirty = new Set(dirtyRels)
  const recency = (r: string) => lru.indexOf(r) // -1 = 未记账 → 视为最旧，优先回收
  return fixed
    .filter((r) => !guarded.has(r) && !dirty.has(r))
    .sort((a, b) => recency(a) - recency(b))
    .slice(0, fixed.length - cap)
}

/**
 * 循环切换（Ctrl+Tab / Ctrl+Shift+Tab）的落点：顺序 = 标签栏顺序，正向 +1、反向 -1，首尾相接。
 * 无激活标签时正向取首个、反向取末个；切换列表不足 2 个 → null（调用方直接放过这次按键）。
 */
export function nextTabInCycle(rels: readonly string[], activeRel: string | null, backward = false): string | null {
  if (rels.length < 2) return null
  if (!activeRel) return backward ? rels[rels.length - 1] : rels[0]
  const i = rels.indexOf(activeRel)
  if (i < 0) return backward ? rels[rels.length - 1] : rels[0]
  return rels[(i + (backward ? -1 : 1) + rels.length) % rels.length]
}

/**
 * 关闭标签后的激活落点：**右邻居优先，否则左邻居**，都没有 → null（回到编辑器空态）。
 * 旧实现取「最后一个 key」= 最右标签，关一个标签就跳到最右边，来回编辑时很跳。
 */
export function landingAfterClose(rels: readonly string[], closedRel: string): string | null {
  const i = rels.indexOf(closedRel)
  if (i < 0) return null
  const remaining = rels.filter((r) => r !== closedRel)
  // 被关标签在剩余数组中的「同下标」正好是它的右邻居；下标越界（关的是最后一个）时退回末个 = 左邻居
  return remaining[Math.min(i, remaining.length - 1)] ?? null
}
