/**
 * 右侧查看器 · 书架页签的纯函数层（零运行时依赖，只允许 `import type`）。
 *
 * 为什么单独一层：书架列表的排序 / 过滤 / 进度换算 / 列数 都是「喂给渲染的判据」，
 * 写进组件就只能靠人肉点击验收；抽到这里后 `.AGENT/scripts/ai-teaching/verify-books-pane.mjs`
 * 能 strip 类型直接 import 真实实现跑用例（与 `electron/lib/viewerTabsPure.ts` 同一套路）。
 *
 * ★ 扩展名表**不得**从 `phrontis-core/kbStore/bookFormats` 引 —— 那是主进程真源、
 *   走 `phrontis-core` 包（node_modules 解析），契约脚本 strip 类型后跑不在 bundler 里。
 *   本文件只负责**展示口径**（格式徽标 / 引擎分类），真正的阅读器分发仍由组件里的
 *   `bookEngineOf(relPath)` 决定（唯一真相源，见 bookshelf/index.tsx 同款用法）。
 *   两张表的一致性由组件侧「徽标引擎 = 分发引擎」的推导保证：组件只用本文件出徽标。
 */

/** 书架支持的阅读引擎（与 bookFormats 的 BOOK_EXTS 对齐，按格式细分以便显示徽标） */
export type BookEngine = 'pdf' | 'epub' | 'fb2' | 'fbz' | 'cbz' | 'txt'

/**
 * 扩展名 → 引擎。顺序 = 匹配优先级，`endsWith` 逐项比（互不为后缀，顺序其实无关，
 * 但保持固定顺序让行为可复现）。全部小写，比较前把入参也降成小写。
 */
const EXT_ENGINE: ReadonlyArray<readonly [string, BookEngine]> = [
  ['.pdf', 'pdf'],
  ['.epub', 'epub'],
  ['.fb2', 'fb2'],
  ['.fbz', 'fbz'],
  ['.cbz', 'cbz'],
  ['.txt', 'txt'],
]

/**
 * 路径 → 阅读引擎；未收录返回 null（调用方跳过 / 不显示徽标）。
 * 大小写不敏感（`.PDF` / `.Epub` 都要命中）；只看末尾扩展名，不做魔数探测。
 */
export function engineOfPath(relPath: string): BookEngine | null {
  const p = String(relPath ?? '').trim().toLowerCase()
  if (!p) return null
  for (const pair of EXT_ENGINE) {
    if (p.endsWith(pair[0])) return pair[1]
  }
  return null
}

/** 有限数字才算有值（IPC 回来的字段可能是 undefined / NaN / null） */
function numOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 夹到 0..1（进度条宽度与百分比都只认这个区间） */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/**
 * 阅读进度 0..1。
 * 口径：PDF 用 `lastPage / totalPages`（清单里的 pdf 分支只填这两个字段）；
 * 非 PDF 用 `pct / 100`（txt / epub / fb2 / fbz / cbz 走 readerState.json 的 pct）。
 * 缺字段 / 分母为 0 → 0；越界夹紧（脏数据 `lastPage > totalPages` 不许把进度条撑爆）。
 */
export function progressOf(book: { lastPage?: number; totalPages?: number; pct?: number }): number {
  const last = numOf(book?.lastPage)
  const total = numOf(book?.totalPages)
  if (last !== null && total !== null && total > 0) return clamp01(last / total)
  const pct = numOf(book?.pct)
  if (pct !== null) return clamp01(pct / 100)
  return 0
}

/**
 * 进度文案："42 / 380"（有总页数）或 "12%"（只有 pct）。
 * 未开始（无总页数且 pct 为 0 / 缺失）返回空串 —— 空进度条本身就是「没读过」，
 * 再补一句 "0%" 只是噪声（铁律 26：让布局自己解释）。
 */
export function progressLabel(book: { lastPage?: number; totalPages?: number; pct?: number }): string {
  const last = numOf(book?.lastPage)
  const total = numOf(book?.totalPages)
  if (total !== null && total > 0) {
    const pages = Math.round(total)
    const raw = last !== null ? Math.round(last) : 1
    const page = Math.max(1, Math.min(raw, pages))
    return `${page} / ${pages}`
  }
  const pct = numOf(book?.pct)
  if (pct !== null && pct > 0) return `${Math.round(clamp01(pct / 100) * 100)}%`
  return ''
}

/**
 * 按书名（displayName，缺则 relPath）过滤；大小写不敏感，查询词去首尾空白。
 * 空查询原样返回（**同一个数组引用**，省一次无意义的拷贝与重渲染），顺序完全不动。
 */
export function filterBooks<T extends { displayName?: string; relPath: string }>(books: T[], query: string): T[] {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return books
  return books.filter((b) => String(b?.displayName ?? b?.relPath ?? '').toLowerCase().includes(q))
}

/**
 * 最近阅读优先（`updatedAt` 倒序）；缺 `updatedAt` / 时间不可解析的排最后。
 * 约束写 `string | null` 而不是 `string | undefined`：`types.BookListItem.updatedAt` 是
 * `string | null`（未读过就是 null），只收 undefined 会让整个书架清单赋值失败。
 *
 * ★ 稳定：时间相同的两项保持入参顺序（JS 的 Array#sort 自 ES2019 起稳定，
 *   这里再加一份原始下标做兜底比较，免得将来有人换成手写冒泡把这层语义丢掉）。
 * ★ 不修改入参（先 map 出带下标的副本再排）。
 */
export function sortBooks<T extends { updatedAt?: string | null }>(books: T[]): T[] {
  const rows = books.map((b, index) => {
    const raw = b?.updatedAt ? Date.parse(String(b.updatedAt)) : NaN
    return { b, index, at: Number.isFinite(raw) ? raw : null }
  })
  rows.sort((x, y) => {
    if (x.at !== null && y.at !== null) {
      if (x.at !== y.at) return y.at - x.at
    } else if (x.at !== null) {
      return -1
    } else if (y.at !== null) {
      return 1
    }
    return x.index - y.index
  })
  return rows.map((r) => r.b)
}

/**
 * 面板宽度 → 列数。阈值 420：默认面板宽 480 → 双列；拖到最窄 360 → 单列。
 * 卡片里书名只有两行、封面 40px，双列在 420（每列约 200）仍然放得下。
 */
export function columnsForWidth(width: number): 1 | 2 {
  const w = numOf(width) ?? 0
  return w < 420 ? 1 : 2
}

/** 格式徽标文案；未知格式返回空串（调用方不渲染徽标，别显示 '?'）。 */
export function formatBadge(engine: BookEngine | null): string {
  return engine ? engine.toUpperCase() : ''
}
