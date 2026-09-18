/**
 * 感知模式的**素材预算纯函数区**（v3.4.0 批次 B2）—— 零依赖：
 * 不 import electron、不碰磁盘、不读时钟。
 *
 * 单独成文件的理由与 `refSkeleton.ts` 完全一致（同 `releaseNotes/judge.ts` 的哲学）：
 * ① 契约脚本 `.AGENT/scripts/ai-assistant/verify-perception.mjs` 要**直接 import 这里**；
 * ② 「预算截断」是静默出错高发区 —— 多切一个字符不报错、少切一段不报错，
 *    只有把输入顶到边界才看得见。纯函数 = 边界可穷举。
 *
 * 幂等红线（铁律 17）：同入参必须逐字同出参。**不要在这里读 Date / Math.random /
 * 索引里的实时状态** —— 素材段每轮重算，输出一旦抖动就会打散 prompt cache。
 */

/** 单篇素材字符上限（上游 §4.3 拍板值） */
export const PERCEPTION_ITEM_LIMIT = 800
/** 素材段总字符上限（与 B1 注入段同口径，铁律 16 成本红线） */
export const PERCEPTION_TOTAL_LIMIT = 6000
/** 感知召回篇数上限（上游 §4.2 step 3 拍板值；检索门面 topK 传这个数） */
export const PERCEPTION_TOPK = 5

/** 命中方式（与 `knowledgeSearch.KnowledgeHit.via` 同集合） */
export type PerceptionVia = 'keyword' | 'semantic' | 'hybrid'

/** 编排层交给本模块的原始条目（skeleton 已由调用方 buildRefSkeleton 算好） */
export interface MaterialItem {
  pageId: string
  title: string
  path: string
  via: PerceptionVia
  /** 标题骨架（`buildRefSkeleton(...).text`） */
  skeleton: string
  /** 检索门面按 via 分流算好的摘录（语义路 = 命中块原文 / 关键词路 = excerptAround） */
  excerpt: string
}

export interface MaterialCaps {
  /** 单篇字符上限 */
  itemLimit: number
  /** 总量字符上限 */
  totalLimit: number
}

export interface MaterialBudgetResult {
  /** 预算内保留的条目（原顺序 —— 门面已按相关度降序，这里不重排） */
  items: MaterialItem[]
  /** 因预算被丢掉的篇数（>0 时注入段必须明写，不得静默丢） */
  dropped: number
}

/** 按字符上限截断，超限时尾部补省略号（省略号计入总长）—— 与 refSkeleton.clampTail 同口径 */
function clampTail(s: string, limit: number): string {
  const src = String(s ?? '')
  if (limit <= 0) return ''
  if (src.length <= limit) return src
  if (limit <= 1) return src.slice(0, limit)
  return src.slice(0, limit - 1) + '…'
}

/**
 * 单篇渲染成注入块文本（预算与渲染共用，保证「量的和」就是最终占位）。
 *
 * `itemLimit` 约束的是**整块**（含标题行与命中方式行），不是仅正文 ——
 * 否则前缀固定开销会把实际占位顶出上限（契约 F2b 抓到的正是这个）。
 */
function renderBlock(it: MaterialItem, itemLimit: number): string {
  const viaLabel = it.via === 'semantic' ? '语义' : it.via === 'hybrid' ? '混合' : '关键词'
  const head = `【素材】《${it.title || it.path}》（${it.path}）\n命中方式：${viaLabel}`
  const body = [it.skeleton, it.excerpt ? `摘录：${it.excerpt}` : ''].filter(Boolean).join('\n')
  // 头两行是固定开销（保底保留），余量给正文
  const room = itemLimit - head.length - 1
  if (room <= 0) return clampTail(head, itemLimit)
  return head + '\n' + clampTail(body, room)
}

/**
 * 按排名逐篇累加，破总量预算即停。
 *
 * 口径（刻意与 `buildAttachedRefsInjection` 的「从末篇整篇丢」不同）：
 * 感知素材是**按相关度排序**的，前 N 篇就是最该给的 —— 所以这里是
 * 「保留前缀、丢掉后缀」，而不是「尽量多塞」。单篇先按 `itemLimit` 截，
 * 累计超 `totalLimit` 的那篇**整篇丢**（不切半篇：半篇素材会误导模型，
 * 代价大于收益）。第一篇即使单篇裁完仍超总量，也保底保留（否则「感知到 0 篇」
 * 与「没感知」无法区分，B3 的溯源 chip 会一条不显示）。
 *
 * 幂等：无时间/随机/外部状态依赖。
 */
export function budgetMaterial(
  items: readonly MaterialItem[],
  caps?: Partial<MaterialCaps>,
): MaterialBudgetResult {
  const list = Array.isArray(items) ? items : []
  const itemLimit = Math.max(1, Math.floor(caps?.itemLimit ?? PERCEPTION_ITEM_LIMIT))
  const totalLimit = Math.max(1, Math.floor(caps?.totalLimit ?? PERCEPTION_TOTAL_LIMIT))
  if (list.length === 0) return { items: [], dropped: 0 }

  const kept: MaterialItem[] = []
  let used = 0
  for (const it of list) {
    const size = renderBlock(it, itemLimit).length
    // 首篇保底：即使自己就超总量也不能丢，否则无法与「零命中」区分
    if (kept.length > 0 && used + size > totalLimit) break
    kept.push(it)
    used += size
  }
  return { items: kept, dropped: list.length - kept.length }
}

/** 渲染预算内的条目块（外部要单块文本时用；注入段装配走 buildPerceptionInjection） */
export function renderMaterialBlocks(items: readonly MaterialItem[], itemLimit = PERCEPTION_ITEM_LIMIT): string[] {
  return (Array.isArray(items) ? items : []).map((it) => renderBlock(it, itemLimit))
}

/**
 * 组装感知素材注入段（含**脚注映射表**——B3 溯源 UI 的兑现处）。
 *
 * 协议（上游 §4.3，两处按代码事实修正）：
 * ① 标题里若含 `[` / `]` / `|` 等会破坏 markdown 脚注或链接语法的字符，映射表里
 *    **替换成全角同形字**（不是删掉——删掉会让模型看到与真实标题不同的名字，
 *    而脚注定义行 `[^N]: [[笔记标题]]` 是要被双链渲染打开的，标题必须原样可解析）。
 *    `[[ ]]` 双链本身允许绝大多数字符，真正危险的是**换行**与**未闭合方括号**，
 *    故实际替换：`[`→`【`、`]`→`】`、换行→空格。
 * ② 编号连续 1..N，与保留条目一一对应；`dropped > 0` 时尾部明写丢了几篇。
 *
 * 零篇返回空串（调用方据此**不注入**，请求照常发出——上游 §4.2 step 4）。
 */
export function buildPerceptionInjection(
  result: MaterialBudgetResult,
  itemLimit = PERCEPTION_ITEM_LIMIT,
): string {
  const items = Array.isArray(result?.items) ? result.items : []
  if (items.length === 0) return ''
  const dropped = Math.max(0, Math.floor(result?.dropped ?? 0))

  const header =
    '【知识库素材】以下是知识库中与本次请求匹配度最高的笔记（已按相关度排序，' +
    '正文未全量注入；需要全文时用文件读取工具按 path 读取）：'
  const blocks = items.map((it, i) => `${i + 1}. ${renderBlock(it, itemLimit)}`)

  // 脚注映射表：编号与上面 blocks 的下标严格一一对应
  const map = items
    .map((it, i) => `[^${i + 1}]=${footnoteSafe(it.title || it.path)}`)
    .join('；')
  const rules =
    `若产出参考了上述某篇笔记，须在文末以脚注标注。映射表：${map}。` +
    '脚注定义行格式固定为 `[^N]: [[笔记标题]]`（N 为上面素材的编号）。'
  const tail = dropped > 0 ? `（另 ${dropped} 篇因预算上限未展开，可按需用文件读取工具读取）` : ''

  return [header, ...blocks, ...(tail ? [tail] : []), rules].join('\n\n')
}

/**
 * 脚注映射表里的标题安全化。
 *
 * 为什么不是「删除」而是「替换成全角」：映射表是给**模型**看的提示，
 * 模型要照着它写 `[^1]: [[笔记标题]]`。删掉字符会让模型写出与真实笔记标题
 * 不同的名字 → 双链解析失败 → 脚注点不开（B3 的直接症状）。
 * 全角替换保持视觉可辨、同时不破坏 markdown 语法。
 */
export function footnoteSafe(title: string): string {
  return String(title ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\[/g, '【')
    .replace(/\]/g, '】')
    .trim()
}
