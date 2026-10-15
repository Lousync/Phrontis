/**
 * 命令面板的模糊匹配与排序（**纯函数，零依赖**）。
 *
 * 为什么单独成文件：命令面板原先的过滤是 `label/hint/group` 三处 `includes` 的或运算，
 * 结果顺序 = 声明顺序。想改排序就得改组件，而组件里改的东西没有契约能断到。
 * 抽出来之后排序规则可以被 `.AGENT/scripts/commands/verify-palette-fuzzy.mjs` 直接
 * import 做表驱动断言（本仓的既有手法，同 releaseNotes/judge.ts 与 helpRetrieval.ts）。
 *
 * 口径（2026-10-13 从原型 tmp/command-registry-proto/index.html 的 score() 搬来并收紧）：
 *   | 命中位置 | 分数 |
 *   |---|---|
 *   | 标题（label）子串 | 1000 − 位置×8 − 长度差×0.4，命中在**词首**再 +60 |
 *   | 键位（keys）文本 | 620（`ctrl b` 或 `ctrlb` 都能命中「折叠 / 展开侧栏」） |
 *   | 提示（hint）子串 | 480（插件命令的 hint 是插件名 —— 按插件名搜必须找得到） |
 *   | 分组（group）子串 | 320 |
 *   | 标题子序列 | 180（`gzt` 类跳字输入） |
 *   | 分组子序列 | 90 |
 * ★ 两条硬性质（契约锁死）：
 *   ① **不丢召回** —— 旧口径能匹配到的（label / hint / group 任一 include），新口径必然也匹配到，
 *      且分数 > 0。升级排序不许把原本搜得到的东西弄丢。
 *   ② **排序确定** —— 同分保持输入顺序（稳定排序），否则同一个查询两次打开面板结果会跳。
 */

export interface FuzzyItem {
  /** 命令标题（面板上显示的那一行） */
  label: string
  /** 右侧灰字：插件名 / 备注 / 模块用途 */
  hint?: string
  /** 分组名（面板里的小节标题） */
  group?: string
  /** 键位（多组同效），来自真源 —— 面板此前根本不知道快捷键，故搜不到 */
  keys?: string[][]
}

/** 单个词元的分数。0 = 未命中。 */
export function scoreToken(item: FuzzyItem, token: string): number {
  const q = token.toLowerCase()
  if (!q) return 0
  const label = item.label.toLowerCase()
  const hint = (item.hint ?? '').toLowerCase()
  const group = (item.group ?? '').toLowerCase()

  // 键位：`ctrl b`（带空格）与 `ctrlb`（拍平）两种写法都认；查询里的 `+` 也当分隔符拍掉，
  // 于是 `ctrl+b` / `ctrl b` / `ctrlb` 都能命中。`-` **不**拍掉 —— 它是真键位（`Ctrl` `-` 界面缩小），
  // 拍掉会让「界面缩小」和一大票 `ctrl *` 混在一起。
  const keySpaced = (item.keys ?? []).map((k) => k.join(' ').toLowerCase()).join(' ')
  const keyFlat = (item.keys ?? []).map((k) => k.join('').toLowerCase()).join(' ')
  const qFlat = q.replace(/[\s+]/g, '')

  const i = label.indexOf(q)
  if (i >= 0) {
    // 命中越靠前、覆盖标题越满，分越高；命中在词首（开头或空格后）再给一点加成
    const atWordStart = i === 0 || /[\s·/|-]/.test(label[i - 1] ?? '')
    return 1000 - i * 8 - (label.length - q.length) * 0.4 + (atWordStart ? 60 : 0)
  }
  if (keySpaced.includes(q) || (qFlat.length > 0 && keyFlat.includes(qFlat))) return 620
  if (hint.includes(q)) return 480
  if (group.includes(q)) return 320
  if (subsequence(label, q)) return 180
  if (subsequence(group, q)) return 90
  return 0
}

/** 子序列判定：needle 的字符按序出现即可（跳字输入） */
export function subsequence(hay: string, needle: string): boolean {
  if (needle.length === 0) return true
  let p = 0
  for (const ch of hay) {
    if (ch === needle[p]) p++
    if (p === needle.length) return true
  }
  return false
}

/**
 * 一条命令对整串查询的分数。查询按空白切词，**每个词都必须命中**（AND），
 * 总分 = 各词分数之和 —— 这样「打开 设置」不会把只含「打开」的十一条一起排到前面。
 * 返回 0 表示不匹配。
 */
export function scoreItem(item: FuzzyItem, query: string): number {
  const q = query.trim()
  if (!q) return 0
  const tokens = q.split(/\s+/).filter(Boolean)
  let total = 0
  for (const t of tokens) {
    const s = scoreToken(item, t)
    if (s <= 0) return 0
    total += s
  }
  return total
}

/**
 * 过滤 + 排序。空查询原样返回（顺序不变，面板自己决定要不要插「最近使用」）。
 * 稳定排序：同分保持输入顺序。
 */
export function filterAndRank<T extends FuzzyItem>(items: T[], query: string): T[] {
  const q = query.trim()
  if (!q) return items.slice()
  const scored: { item: T; score: number; at: number }[] = []
  items.forEach((item, at) => {
    const score = scoreItem(item, q)
    if (score > 0) scored.push({ item, score, at })
  })
  scored.sort((a, b) => (b.score - a.score) || (a.at - b.at))
  return scored.map((s) => s.item)
}
