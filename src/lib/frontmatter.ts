/**
 * frontmatter 拆装（共享层）：编辑器模块与知识库就地编辑共用的唯一实现。
 * 从 `src/modules/editor/types.ts` 上移而来（笔记合并 Phase 1，docs/notes-merge-phase1-design.md §1.2）；
 * editor/types.ts 保留 re-export，既有消费方与契约脚本不受影响。
 */

/** 拆分 frontmatter：文本以 `---` 行开头且存在闭合 `---` 行时返回前缀与正文。
 * 前缀原样保留（含换行），正文从闭合行后开始——保存 = prefix + body，roundtrip 无损。 */
export function splitFrontmatter(raw: string): { prefix: string; body: string } | null {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(raw)
  if (!m) return null
  const prefix = m[0]
  return { prefix, body: raw.slice(prefix.length) }
}

/** 拼回完整文件内容（保存用）：有前缀则拼，无则原样 */
export function joinFrontmatter(doc: { frontmatterPrefix?: string; content: string }): string {
  return doc.frontmatterPrefix ? doc.frontmatterPrefix + doc.content : doc.content
}
