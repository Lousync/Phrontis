/**
 * AI 助手作用域的「集合语义」纯函数（方案 `docs/ai-assistant-scope-rail-plan.md`）。
 *
 * 存储口径不变：前缀数组，`'A'` 覆盖 `A` 下**一切**（真源是主进程
 * `electron/lib/kbStore/vaultScope.ts` 的 `isWithinVaultScope`，这里只是渲染层的镜像判定，不碰 IPC）。
 * 零依赖，契约脚本可直接 `import` 跑用例表。
 *
 * `kidsOf` 是注入的访问器而不是数组参数：目录子项在 `ScopePane` 里懒加载。
 * 两种返回必须分清 —— `undefined` = **尚未加载**（无从判断部分覆盖），`[]` = 已加载且为空。
 */

/** 落库侧到 500 条**静默截断**（`agentSessionRepo.updateAgentSessionScope`），这里前置留 100 条余量 */
export const SCOPE_ENTRY_SOFT_CAP = 400

export type Coverage = 'all' | 'partial' | 'none'
export type KidsOf = (rel: string) => string[] | undefined

function norm(rel: string): string {
  return String(rel ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

/** 去重 + 删掉被其它条目覆盖的冗余项（幂等；结果顺序 = 首次出现顺序） */
export function prunePrefixes(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of Array.isArray(list) ? list : []) {
    const s = norm(raw)
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out.filter((s) => !out.some((p) => s !== p && s.startsWith(p + '/')))
}

/**
 * 覆盖 `rel` 的最外层前缀（含自身），没有则 undefined。
 * 多个前缀都盖住时取**最短**者：那才是用户实际勾下的一层，「来自 X」要显示它。
 */
export function coveredBy(scope: string[], rel: string): string | undefined {
  const n = norm(rel)
  if (!n) return undefined
  let hit: string | undefined
  for (const raw of Array.isArray(scope) ? scope : []) {
    const p = norm(raw)
    if (!p || (n !== p && !n.startsWith(p + '/'))) continue
    if (!hit || p.length < hit.length) hit = p
  }
  return hit
}

/**
 * 三态：整棵都在作用域内 / 部分在 / 都不在。
 * 自身被前缀覆盖即 all；子项未知退化为 none（方案 §3.2 —— 不为此扫全库）；
 * 已加载子项全 all 才 all，命中任一即 partial。
 */
export function coverageOf(scope: string[], rel: string, kidsOf: KidsOf): Coverage {
  if (coveredBy(scope, rel)) return 'all'
  const kids = kidsOf(rel)
  if (!kids || kids.length === 0) return 'none'
  let all = true
  let any = false
  for (const k of kids) {
    const c = coverageOf(scope, k, kidsOf)
    if (c === 'all') any = true
    else if (c === 'partial') { any = true; all = false }
    else all = false
  }
  if (any && all) return 'all'
  return any ? 'partial' : 'none'
}

/** 批量加入（全选顶层 / 全选可见也走它） */
export function batchAdd(scope: string[], rels: string[]): string[] {
  return prunePrefixes([...(Array.isArray(scope) ? scope : []), ...(Array.isArray(rels) ? rels : [])])
}

/** 加入单个子树 */
export function addToScope(scope: string[], rel: string): string[] {
  return batchAdd(scope, [rel])
}

/**
 * 移出子树。前缀模型**没有「排除项」**，所以要盖住 `rel` 的上层条目必须炸开成它的兄弟，
 * 沿路径逐层往下炸，直到 `rel` 那一支被摘干净。
 *
 * 返回 `null` = 这一下取消做不了，交调用方给提示，**不返回半成品**：
 * ① 通往 `rel` 的某层目录子项还没列出来（`kidsOf` 回 undefined）；
 * ② 炸开后条目数超软上限 —— 宁可拒绝这次点击，也不能让落库在 500 条静默丢数据。
 */
export function removeFromScope(scope: string[], rel: string, kidsOf: KidsOf): string[] | null {
  const n = norm(rel)
  if (!n) return null
  let next = prunePrefixes(scope).filter((s) => s !== n && !s.startsWith(n + '/'))
  for (;;) {
    const idx = next.findIndex((s) => n.startsWith(s + '/'))
    if (idx < 0) break
    const kids = kidsOf(next[idx])
    if (!kids) return null
    const onPath: string[] = []
    const rest: string[] = []
    for (const k of kids) {
      const kk = norm(k)
      if (!kk || kk === n || kk.startsWith(n + '/')) continue
      if (n.startsWith(kk + '/')) onPath.push(kk)
      else rest.push(kk)
    }
    next = [...next.slice(0, idx), ...next.slice(idx + 1), ...rest, ...onPath]
    if (next.length > SCOPE_ENTRY_SOFT_CAP) return null
  }
  return prunePrefixes(next)
}
