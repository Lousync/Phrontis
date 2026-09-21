/**
 * 摘录导出映射 schema（书架阅读器 · 摘录导出知识库闭环，方案 §C1/C3）。
 *
 * 零依赖纯函数文件 —— 刻意不 import 任何 electron / fs 模块：
 * 契约脚本 `.AGENT/scripts/pdf-reader/verify-excerpt-export.mjs` 用
 * `node --experimental-strip-types` 直接 import 本文件做用例验证。
 *
 * 导出映射 `.knowbase/modules/excerptExports.json`（唯一写方 = excerptExportVaultRepo.ts）：
 *   { version: 1, books: { "<rootId>/<bookRelPath>": { pageId, pagePath, exportedAt, count } } }
 *
 * 书键口径与 excerptSchema.excerptKey 完全一致（同一本书的摘录键 = 导出键）。
 */

import type { ExcerptColor, ExcerptType, VaultExcerpt } from './excerptSchema'

/** 导出条目（一本书 ↔ 一篇知识库「读书笔记」页的映射） */
export interface ExcerptExportEntry {
  /** 知识库页面 frontmatter id（覆盖重写时原样保留，保证页面身份不变） */
  pageId: string
  /** 知识库页面仓库内相对路径（落收件箱） */
  pagePath: string
  /** 最近一次导出时间（ISO） */
  exportedAt: string
  /** 最近一次导出的摘录条数 */
  count: number
}

/** 导出映射顶层 */
export interface ExcerptExportStore {
  version: number
  books: Record<string, ExcerptExportEntry>
}

/** 导出映射空壳 */
export function emptyExportStore(): ExcerptExportStore {
  return { version: 1, books: {} }
}

/**
 * 导出书键归一：posix 分隔、去首尾空白、去开头 ./；空分量拒绝返回空串（同 excerptKey 口径）。
 * 与 excerptKey 共用同一公式，保证「一本书的摘录键 == 导出键」。
 */
export function exportKey(rootId: string, relPath: string): string {
  const id = String(rootId ?? '').trim()
  let rel = String(relPath ?? '').trim().replace(/\\/g, '/')
  while (rel.startsWith('./')) rel = rel.slice(2)
  if (!id || !rel || rel.startsWith('/')) return ''
  return `${id}/${rel}`
}

/** 从导出书键反解 relPath */
export function exportKeyRel(key: string): string {
  const i = key.indexOf('/')
  return i < 0 ? '' : key.slice(i + 1)
}

/** 色板 id → 中文名（导出 md 以纯文本呈现，如「黄」；单一来源，严禁两处各写一份） */
export const EXCERPT_COLOR_NAMES: Record<ExcerptColor, string> = {
  y: '黄',
  g: '绿',
  b: '蓝',
  p: '粉',
  v: '紫',
}

/** 条目类型 → 中文名（摘录 / 想法 / 高亮） */
export const EXCERPT_TYPE_NAMES: Record<ExcerptType, string> = {
  highlight: '高亮',
  excerpt: '摘录',
  idea: '想法',
}

/**
 * 纯函数：把一本书的摘录渲染成「读书笔记」md（方案 C3）。
 * 不依赖任何 I/O，可直接单测。
 *
 * 结构：
 *   # 读书笔记 · 《书名》
 *   > 来源：<relPath> · 共 N 条摘录 · 导出于 <date>
 *   按页（pdf）或按段区间（txt）分 ## 组 → 每组下每条：
 *     引文（markdown 引用块）+ 备注（有则出）+ [回到原文](kbloc:<bookKey>#<excerptId>) 链接
 *     色 / 类型以纯文本呈现（如「摘录 · 黄」）
 *
 * 约束（契约脚本验证）：md 中每条摘录恰好一个 `kbloc:` 链接，且不含 kbloc 之外的异常协议。
 *
 * ⚠️ 本文件**必须零值导入**（只用 `import type`）—— 契约脚本用 `node --experimental-strip-types`
 * 直接 import 本文件，而 Node 的类型剥离**不做 TS 式无扩展名解析**：任何 `import { x } from './y'`
 * 都会 `Cannot find module`。书名因此由调用方（仓库层）算好传入，而不在这里 import bookFormats。
 */
export function buildExcerptExportMarkdown(opts: {
  rootId: string
  relPath: string
  /** 书名（由调用方用 bookDisplayName(relPath) 算好传入，见上方「零值导入」约束） */
  bookName: string
  excerpts: VaultExcerpt[]
  exportedAt?: string
}): string {
  const { rootId, relPath, bookName, excerpts } = opts
  const name = bookName
  const date = (opts.exportedAt || new Date().toISOString()).slice(0, 10)
  const bookKey = exportKey(rootId, relPath)

  const header = [
    `# 读书笔记 · 《${name}》`,
    '',
    `> 来源：${relPath} · 共 ${excerpts.length} 条摘录 · 导出于 ${date}`,
    '',
  ].join('\n')

  if (excerpts.length === 0) return header.trimEnd() + '\n'

  // 分组：pdf 按 page；txt 按连续段区间
  const groups = groupExcerpts(excerpts)
  const blocks: string[] = []
  for (const g of groups) {
    const heading = g.kind === 'pdf' ? `## 第 ${g.label} 页` : `## 第 ${g.label} 段`
    const items: string[] = []
    for (const e of g.items) {
      const lines: string[] = []
      // 引文（markdown 引用块，逐行加 >）
      for (const ln of e.text.split('\n')) lines.push(`> ${ln}`)
      // 备注（有则出）
      if (e.note && e.note.trim()) lines.push('', `备注：${e.note.trim()}`)
      // 回到原文链接 + 类型·颜色（纯文本）
      const typeName = EXCERPT_TYPE_NAMES[e.type]
      const colorName = EXCERPT_COLOR_NAMES[e.color] || ''
      lines.push('', `[回到原文](kbloc:${bookKey}#${e.id}) · ${typeName}${colorName ? ' · ' + colorName : ''}`)
      items.push(lines.join('\n'))
    }
    blocks.push(`${heading}\n\n${items.join('\n\n')}`)
  }

  return header + blocks.join('\n\n') + '\n'
}

interface ExcerptGroup {
  label: string
  kind: 'pdf' | 'txt'
  items: VaultExcerpt[]
}

/** 分组（纯函数）：pdf 按 page 升序；txt 按段落序号连续区间合并 */
export function groupExcerpts(excerpts: VaultExcerpt[]): ExcerptGroup[] {
  if (excerpts.length === 0) return []
  const kind = excerpts[0].kind
  if (kind === 'pdf') {
    const byPage = new Map<number, VaultExcerpt[]>()
    for (const e of excerpts) {
      const p = e.page ?? 0
      if (!byPage.has(p)) byPage.set(p, [])
      byPage.get(p)!.push(e)
    }
    return [...byPage.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([p, items]) => ({ label: String(p), kind, items }))
  }
  // txt：按 paraIndex 升序后合并连续区间（相邻差 1 视为同区间）
  const sorted = [...excerpts].sort((a, b) => (a.paraIndex ?? 0) - (b.paraIndex ?? 0))
  const groups: ExcerptGroup[] = []
  let cur: VaultExcerpt[] = []
  let curStart = sorted[0].paraIndex ?? 0
  let curPrev = curStart
  for (const e of sorted) {
    const pi = e.paraIndex ?? 0
    if (cur.length > 0 && pi !== curPrev + 1) {
      groups.push(makeTxtGroup(curStart, curPrev, cur))
      cur = []
    }
    cur.push(e)
    if (cur.length === 1) curStart = pi
    curPrev = pi
  }
  if (cur.length > 0) groups.push(makeTxtGroup(curStart, curPrev, cur))
  return groups
}

function makeTxtGroup(start: number, end: number, items: VaultExcerpt[]): ExcerptGroup {
  // label 只给序号（标题模板负责补「段」字）：单段「3」、区间「3–4」——避免出现「段 第 3–4 段」这类重复
  const label = start === end ? String(start + 1) : `${start + 1}–${end + 1}`
  return { label, kind: 'txt', items }
}

/**
 * 纯函数：幂等映射 upsert（方案 C1/C2）——同一个 bookKey 永远只对应一条映射、
 * 重复导出只更新 count/exportedAt/pagePath，**绝不新建条目**（页面也不新建）。
 * 返回新 store（不 mutate 入参），供契约脚本断言「重复导出不产生新页」之用。
 */
export function applyExportEntry(
  store: ExcerptExportStore,
  bookKey: string,
  entry: ExcerptExportEntry,
): ExcerptExportStore {
  return {
    version: 1,
    books: { ...store.books, [bookKey]: entry },
  }
}
