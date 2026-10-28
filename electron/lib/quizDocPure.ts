import { randomUUID } from 'crypto'

/**
 * 题单文档 frontmatter（零 Electron 依赖，契约脚本可直接 import）。
 *
 * 背景：AI 教学落盘的题单原先没有 id，知识索引先给 `auto:<rel>` 临时身份；
 * 首次保存注入真 UUID 后，答题记录会绑在临时 id 上变孤儿。
 * 新题单在落盘时就写 id，旧题单由 store + quizRecord:migratePageId 兜底。
 */

export interface FrontmatterParts {
  /** 含 ```--- 的整段（带尾随换行） */
  prefix: string
  yaml: string
  body: string
}

export function splitFrontmatter(raw: string): FrontmatterParts | null {
  const text = String(raw ?? '').replace(/\r\n/g, '\n')
  const m = text.match(/^---\n([\s\S]*?)\n---\n*/)
  if (!m) return null
  return { prefix: m[0], yaml: m[1], body: text.slice(m[0].length) }
}

/** 比较/幂等用：剥掉 frontmatter，只看正文（统一 LF） */
export function stripFrontmatter(raw: string): string {
  return splitFrontmatter(raw)?.body ?? String(raw ?? '').replace(/\r\n/g, '\n')
}

export function hasQuizFence(content: string): boolean {
  return /```quiz(?:\s|$)/.test(content)
}

function yamlQuote(s: string): string {
  const oneLine = String(s ?? '').replace(/\r?\n/g, ' ').trim()
  return '"' + oneLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/**
 * 含 ```quiz 的文档若没有 frontmatter id，补一个稳定 id。
 * - 已有 id：原样返回（不重复注入）；
 * - 已有 frontmatter 但无 id：把 id 插到 frontmatter 第一行；
 * - 无 frontmatter：生成 `id/title/type` 头。
 * 非 quiz 文档原样返回（不改讲义/普通笔记）。
 */
export function ensureQuizDocFrontmatter(title: string, content: string, id: string = randomUUID()): string {
  const text = String(content ?? '').replace(/\r\n/g, '\n')
  if (!hasQuizFence(text)) return text
  const fm = splitFrontmatter(text)
  if (fm) {
    if (/^\s*id\s*:/m.test(fm.yaml)) return text
    return `---\nid: ${id}\n${fm.yaml}\n---\n${fm.body}`
  }
  return `---\nid: ${id}\ntitle: ${yamlQuote(title)}\ntype: quiz\n---\n\n${text}`
}

/** organizeDoc 的幂等比较：两边都剥 frontmatter 再比正文 */
export function sameQuizDocBody(a: string, b: string): boolean {
  return stripFrontmatter(a) === stripFrontmatter(b)
}
